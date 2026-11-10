/**
 * 宿主 LLM 胶水工厂测试。
 *
 * 纪律：不连真实宿主、不需要凭据 —— ctx.llm 用桩实现，流块用宿主真实的
 * StreamChunk 形状手工构造，BlockAssembler 走真实装配逻辑。
 * 覆盖：默认跟随 / 固定路由 / 部分固定 / 内核 model 优先 / 空文本报错 /
 * 上游错误原样透出 / signal 透传 / reasoning 块不进正文。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableError } from '../../../src/core/errors.ts';
import { createDshHostModelRoute } from '../../../src/adapters/dsh/host-model-route.ts';
import type {
  DshHostModelContext,
  DshHostRouteOptions,
  HostModelSelection,
} from '../../../src/adapters/dsh/host-model-route.ts';

/** 一次 prepareCall 的观测记录。 */
interface ObservedCall {
  route: Record<string, unknown>;
  prepareSignal: AbortSignal | undefined;
  streamOptions: Record<string, unknown>;
}

/** 桩宿主：记录入参，按预设块序列产出流，可强制 prepareCall 失败。 */
class StubHost {
  readonly calls: ObservedCall[] = [];
  selection: HostModelSelection = { provider: 'cloud-acct', model: 'flash', reasoningEffort: 'off' };
  chunks: unknown[] = [];
  prepareError: Error | null = null;

  asCtx(): DshHostModelContext {
    const self = this;
    return {
      agentDefaultModel: {
        currentSelection: () => ({ ...self.selection }),
      },
      llm: {
        async prepareCall(route: Record<string, unknown>, signal: AbortSignal | undefined) {
          if (self.prepareError !== null) {
            throw self.prepareError;
          }
          const observed: ObservedCall = { route: { ...route }, prepareSignal: signal, streamOptions: {} };
          self.calls.push(observed);
          return {
            config: { ...route },
            stream(options: Record<string, unknown>) {
              observed.streamOptions = options;
              const chunks = self.chunks;
              return (async function* () {
                for (const chunk of chunks) {
                  yield chunk;
                }
              })();
            },
          };
        },
      },
      // 桩只实现工厂用到的两个方法，其余宿主面与本测试无关。
    } as unknown as DshHostModelContext;
  }
}

/** 构造一个文本块的完整流片段。 */
function textBlock(index: number, text: string): unknown[] {
  return [
    { type: 'block-start', index, blockType: 'text' },
    { type: 'text-delta', index, text },
    { type: 'block-end', index, block: { type: 'text', text } },
  ];
}

/** 构造一个 reasoning 块（不应进入返回正文）。 */
function reasoningBlock(index: number, text: string): unknown[] {
  return [
    { type: 'block-start', index, blockType: 'reasoning' },
    { type: 'reasoning-delta', index, text },
    { type: 'block-end', index, block: { type: 'reasoning', text } },
  ];
}

const finish = { type: 'finish', reason: { kind: 'stop' } };

const SYSTEM = '你是事件摘要器，输出 JSON。';
const USER = '事件原文：……';

/** 工厂实现恒返回对象形态，测试内做一次窄化。 */
function asObject(result: unknown): { text: string; model?: string } {
  assert.equal(typeof result, 'object');
  return result as { text: string; model?: string };
}

test('无固定路由：跟随 currentSelection，只拼 text 块并回报模型名', async () => {
  const stub = new StubHost();
  stub.chunks = [
    ...reasoningBlock(0, '隐式思考过程'),
    ...textBlock(1, '{"summary":"'),
    ...textBlock(2, '一段描述"}'),
    finish,
  ];
  const route = createDshHostModelRoute(stub.asCtx());

  const result = await route.complete({ system: SYSTEM, user: USER });

  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0]!.route, { provider: 'cloud-acct', model: 'flash', reasoningEffort: 'off' });
  const obj = asObject(result);
  assert.equal(obj.model, 'flash');
  assert.equal(obj.text, '{"summary":"一段描述"}');
  // stream 入参带 system 与单条 user 消息，不携带 sessionId/purpose。
  const opts = stub.calls[0]!.streamOptions;
  assert.equal(opts['system'], SYSTEM);
  assert.ok(Array.isArray(opts['messages']) && opts['messages']!.length === 1);
  assert.equal(opts['sessionId'], undefined);
  assert.equal(opts['purpose'], undefined);
});

test('固定路由：provider/model/effort 全部以配置为准，与默认选择无关', async () => {
  const stub = new StubHost();
  stub.chunks = [...textBlock(0, 'ok'), finish];
  const pinned: DshHostRouteOptions = { provider: 'local-vllm', model: 'qwen-local', reasoningEffort: 'low' };
  const route = createDshHostModelRoute(stub.asCtx(), pinned);

  await route.complete({ system: SYSTEM, user: USER });

  assert.deepEqual(stub.calls[0]!.route, {
    provider: 'local-vllm',
    model: 'qwen-local',
    reasoningEffort: 'low',
  });
});

test('部分固定：只钉 provider 时 model/effort 回退当前默认选择', async () => {
  const stub = new StubHost();
  stub.chunks = [...textBlock(0, 'ok'), finish];
  const route = createDshHostModelRoute(stub.asCtx(), { provider: 'local-vllm' });

  await route.complete({ system: SYSTEM, user: USER });

  assert.deepEqual(stub.calls[0]!.route, { provider: 'local-vllm', model: 'flash', reasoningEffort: 'off' });
});

test('内核显式 model 优先级最高，覆盖固定路由的 model', async () => {
  const stub = new StubHost();
  stub.chunks = [...textBlock(0, 'ok'), finish];
  const route = createDshHostModelRoute(stub.asCtx(), { provider: 'cloud-acct', model: 'pinned-model' });

  await route.complete({ system: SYSTEM, user: USER, model: 'kernel-model' });

  assert.equal(stub.calls[0]!.route['model'], 'kernel-model');
  assert.equal(stub.calls[0]!.route['provider'], 'cloud-acct');
});

test('默认选择没有 effort 时路由不带 reasoningEffort 键', async () => {
  const stub = new StubHost();
  stub.selection = { provider: 'keyless-local', model: 'base' };
  stub.chunks = [...textBlock(0, 'ok'), finish];
  const route = createDshHostModelRoute(stub.asCtx());

  await route.complete({ system: SYSTEM, user: USER });

  assert.deepEqual(stub.calls[0]!.route, { provider: 'keyless-local', model: 'base' });
  assert.equal('reasoningEffort' in stub.calls[0]!.route, false);
});

test('流结束但只有 reasoning/零文本：抛 UnavailableError', async () => {
  const stub = new StubHost();
  stub.chunks = [...reasoningBlock(0, '想了很多但没说话'), finish];
  const route = createDshHostModelRoute(stub.asCtx());

  await assert.rejects(
    () => route.complete({ system: SYSTEM, user: USER }),
    (error: unknown) => error instanceof UnavailableError && /未产出任何文本块/.test(error.message),
  );
});

test('prepareCall 上游错误原样透出，工厂不吞不改', async () => {
  const stub = new StubHost();
  stub.prepareError = new Error('ACCOUNT_QUOTA');
  const route = createDshHostModelRoute(stub.asCtx());

  await assert.rejects(
    () => route.complete({ system: SYSTEM, user: USER }),
    (error: unknown) => error instanceof Error && !(error instanceof UnavailableError) && error.message === 'ACCOUNT_QUOTA',
  );
});

test('signal 同时透给 prepareCall 与 stream 入参', async () => {
  const stub = new StubHost();
  stub.chunks = [...textBlock(0, 'ok'), finish];
  const route = createDshHostModelRoute(stub.asCtx());
  const controller = new AbortController();

  await route.complete({ system: SYSTEM, user: USER, signal: controller.signal });

  assert.equal(stub.calls[0]!.prepareSignal, controller.signal);
  assert.equal(stub.calls[0]!.streamOptions['signal'], controller.signal);
});
