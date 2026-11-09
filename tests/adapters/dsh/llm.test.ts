/**
 * dsh 适配器的 LLM 端口与后台 worker 测试（技术基线 §6.6 · 任务卡 T7）。
 *
 * 覆盖：端口走注入的模型路由、JSON 解析与围栏剥离、坏输出抛 UnavailableError、
 * 自管理 setTimeout worker 的轮询与卸载清理。
 *
 * 纪律：路由是注入的假实现 —— 测试不碰真实模型，也不需要 OAuth 凭据。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableError } from '../../../src/core/errors.ts';
import { createDshLLMPort, startClosureWorker } from '../../../src/adapters/dsh/llm.ts';
import type { DshModelRoute } from '../../../src/adapters/dsh/llm.ts';

/** 假路由：记录请求，按预设返回正文或抛错。 */
class FakeRoute implements DshModelRoute {
  readonly calls: Array<{ system: string; user: string; model?: string }> = [];
  reply = '{"summary":"她打开了一个网页。","key_points":[],"anchors":[]}';
  error: Error | null = null;

  async complete(req: { system: string; user: string; model?: string }): Promise<string> {
    this.calls.push(req);
    if (this.error !== null) {
      throw this.error;
    }
    return this.reply;
  }
}

/** 最小请求（端口只关心 system/user/model/maxChars）。 */
const REQUEST = {
  system: '你是事件摘要器。',
  user: '事件时间范围：2026-11-08T10:00:00.000Z ~ 2026-11-08T10:05:00.000Z\n1. 原文',
  maxChars: 600,
};

test('端口：走注入的模型路由，透传 system / user', async () => {
  const route = new FakeRoute();
  const port = createDshLLMPort(route);

  const response = await port.summarize(REQUEST);

  assert.equal(route.calls.length, 1);
  assert.equal(route.calls[0]?.system, REQUEST.system);
  assert.equal(route.calls[0]?.user, REQUEST.user);
  assert.equal(response.summary, '她打开了一个网页。');
  assert.deepEqual(response.keyPoints, []);
  assert.deepEqual(response.anchors, []);
});

test('端口：解析 key_points 与 anchors', async () => {
  const route = new FakeRoute();
  route.reply = JSON.stringify({
    summary: '摘要',
    key_points: ['要点一', '要点二'],
    anchors: ['锚点一'],
  });
  const port = createDshLLMPort(route);

  const response = await port.summarize(REQUEST);
  assert.deepEqual(response.keyPoints, ['要点一', '要点二']);
  assert.deepEqual(response.anchors, ['锚点一']);
});

test('端口：剥掉模型常见的 ```json 围栏', async () => {
  const route = new FakeRoute();
  route.reply = '```json\n{"summary":"围栏里的摘要","key_points":[],"anchors":[]}\n```';
  const port = createDshLLMPort(route);

  const response = await port.summarize(REQUEST);
  assert.equal(response.summary, '围栏里的摘要');
});

test('端口：模型返回坏 JSON → 抛 UnavailableError（不返回半截内容）', async () => {
  const route = new FakeRoute();
  route.reply = '这不是 JSON';
  const port = createDshLLMPort(route);

  await assert.rejects(() => port.summarize(REQUEST), UnavailableError);
});

test('端口：模型返回缺 summary → 抛 UnavailableError', async () => {
  const route = new FakeRoute();
  route.reply = '{"key_points":[],"anchors":[]}';
  const port = createDshLLMPort(route);

  await assert.rejects(() => port.summarize(REQUEST), UnavailableError);
});

test('端口：路由调用失败 → 抛 UnavailableError（沿用既有错误码，不新增）', async () => {
  const route = new FakeRoute();
  route.error = new Error('MISSING_CREDENTIAL');
  const port = createDshLLMPort(route);

  await assert.rejects(() => port.summarize(REQUEST), UnavailableError);
});

test('端口：模型名可由 options 指定，也接受请求里的覆盖', async () => {
  const route = new FakeRoute();
  const port = createDshLLMPort(route, { model: '摘要专用模型' });

  await port.summarize(REQUEST);
  assert.equal(route.calls[0]?.model, '摘要专用模型');

  await port.summarize({ ...REQUEST, model: '临时模型' });
  assert.equal(route.calls[1]?.model, '临时模型', '请求里的模型名优先');
});

// ── 后台 worker ──────────────────────────────────────────────────────────

/** 最小 ctx（只需 effect 与 logger）。effect 的 disposer 记在 out.disposer 里。 */
function makeCtx(): { ctx: unknown; out: { disposer: (() => void) | undefined; errors: string[] } } {
  const out: { disposer: (() => void) | undefined; errors: string[] } = {
    disposer: undefined,
    errors: [],
  };
  const ctx = {
    effect: (run: () => Promise<unknown>) => {
      void run().then((result) => {
        out.disposer = result as () => void;
      });
    },
    logger: {
      error: (format: string, ...args: unknown[]) => {
        out.errors.push(args.map(String).join(' '));
      },
    },
  };
  return { ctx, out };
}

/**
 * 冲刷微任务队列。
 *
 * worker 的链是「定时器 → await drain() → 再排下一次」：定时器回调只把 drain 拉起来，
 * 下一次定时器是在 drain 的 Promise 兑现之后才排的 —— 故排下一次之前要先把微任务放完。
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

test('worker：自管理 setTimeout 轮询 —— 按间隔反复调 drain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let drains = 0;
  const { ctx } = makeCtx();

  startClosureWorker(ctx as never, async () => {
    drains += 1;
    return 1;
  }, { intervalMs: 5 });

  await t.mock.timers.tick(5);
  await flush();
  assert.equal(drains, 1, '第一轮跑过');

  await t.mock.timers.tick(5);
  await flush();
  assert.equal(drains, 2, '第二轮跑过（自管理定时器续排，不是 setInterval）');

  await t.mock.timers.tick(5);
  await flush();
  assert.equal(drains, 3, '第三轮继续');
});

test('worker：drain 抛错不拖死 worker —— 记日志后照常排下一轮', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let drains = 0;
  const { ctx, out } = makeCtx();

  startClosureWorker(ctx as never, async () => {
    drains += 1;
    throw new Error('本轮失败');
  }, { intervalMs: 5 });

  await t.mock.timers.tick(5);
  await flush();
  assert.equal(drains, 1);
  assert.equal(out.errors.length, 1, '失败被记录（不静默吞）');

  await t.mock.timers.tick(5);
  await flush();
  assert.equal(drains, 2, '失败后仍继续轮询');
  assert.equal(out.errors.length, 2);
});

test('worker：卸载时清掉待执行的定时器（不留悬挂回调）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let drains = 0;
  const { ctx, out } = makeCtx();

  startClosureWorker(ctx as never, async () => {
    drains += 1;
    return 1;
  }, { intervalMs: 5 });

  await t.mock.timers.tick(5);
  await flush();
  assert.equal(drains, 1);

  await flush();
  assert.ok(out.disposer, 'effect 的 disposer 已就位');
  out.disposer?.();
  await t.mock.timers.tick(50);
  await flush();
  assert.equal(drains, 1, '卸载后不再轮询（定时器已清）');
});
