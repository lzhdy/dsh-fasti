/**
 * dsh 工具宿主插头测试（平台化 H1 切片 4）。
 *
 * 不依赖真实 cordis：用同形假 inject sink 手动掌控"服务就绪回调"，验证：
 *  1. withTools 同步声明的依赖恰为 ['tools']，且服务未就绪前 handler 不触发；
 *  2. 子上下文带合规 tools.register 时拿到非空注册表，注册/注销链路原样透传；
 *  3. tools 残形/缺失时 registry 为 null（fail-safe 阶梯）；
 *  4. onDispose 经子上下文 effect 同步登记，effect 体返回同一个清理函数；
 *  5. 端口可被非 dsh 的内存实现满足（双实现准入）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
  createDshToolHost,
  type DshInjectSink,
  type DshToolChildContext,
} from '../../../src/adapters/dsh/tool-host.ts';
import type { ToolHostPort, ToolRegistry } from '../../../src/ports/tool-host-port.ts';

/** 记录 inject 声明并持有回调，由测试手动触发，模拟宿主服务就绪。 */
function makeInjectSink(child: DshToolChildContext): {
  sink: DshInjectSink;
  deps: Array<readonly string[]>;
  run: () => void;
} {
  const deps: Array<readonly string[]> = [];
  let callback: ((c: DshToolChildContext) => void) | undefined;
  const sink: DshInjectSink = {
    inject(nextDeps, cb) {
      deps.push(nextDeps);
      callback = cb;
      return undefined;
    },
  };
  return {
    sink,
    deps,
    run() {
      callback?.(child);
    },
  };
}

test('withTools：同步声明依赖 [tools]，服务就绪回调前 handler 不触发', () => {
  const child: DshToolChildContext = { tools: undefined, effect: () => undefined };
  const { sink, deps, run } = makeInjectSink(child);
  const host = createDshToolHost(sink);
  let invocations = 0;

  host.withTools(() => {
    invocations += 1;
  });

  assert.deepEqual(deps, [['tools']], '必须经 inject 声明 tools 授权');
  assert.equal(invocations, 0, '依赖回调尚未发生，handler 不应触发');
  run();
  assert.equal(invocations, 1, '宿主服务就绪回调后 handler 触发一次');
});

test('withTools：子上下文带合规 tools 时给出非空注册表，注册/注销原样透传', () => {
  const registered: unknown[] = [];
  const unregistered: unknown[] = [];
  const child: DshToolChildContext = {
    tools: {
      register: (def: unknown) => {
        registered.push(def);
        return () => {
          unregistered.push(def);
        };
      },
    },
    effect: () => undefined,
  };
  const { sink, run } = makeInjectSink(child);
  const host = createDshToolHost(sink);

  const box: { registry: ToolRegistry<ToolDefinition> | null } = { registry: null };
  host.withTools(({ registry }) => {
    box.registry = registry;
  });
  run();

  assert.ok(box.registry !== null, '合规 tools 服务应解析出注册表');
  const def = { name: 'fasti_memory_search' } as ToolDefinition;
  const unregister = box.registry.register(def);
  assert.deepEqual(registered, [def]);
  unregister();
  assert.deepEqual(unregistered, [def], 'register 返回的注销函数原样可达');
});

test('withTools：tools 残形或缺失时 registry 为 null（fail-safe，不抛错）', () => {
  for (const malformed of [undefined, null, {}, { register: 'not-a-function' }]) {
    const child: DshToolChildContext = { tools: malformed, effect: () => undefined };
    const { sink, run } = makeInjectSink(child);
    const host = createDshToolHost(sink);
    let seen: ToolRegistry<ToolDefinition> | null = null;
    host.withTools(({ registry }) => {
      seen = registry;
    });
    assert.doesNotThrow(run);
    assert.equal(seen, null, `残形 tools 必须解析为 null：${JSON.stringify(malformed)}`);
  }
});

test('withTools：onDispose 经子上下文 effect 同步登记，返回同一个清理函数', () => {
  const effects: Array<() => unknown> = [];
  const child: DshToolChildContext = {
    tools: undefined,
    effect: (execute) => {
      effects.push(execute);
      return undefined;
    },
  };
  const { sink, run } = makeInjectSink(child);
  const host = createDshToolHost(sink);
  const cleanup = (): void => {};

  host.withTools(({ onDispose }) => {
    onDispose(cleanup);
  });
  run();

  assert.equal(effects.length, 1);
  const effect = effects[0];
  assert.ok(effect);
  assert.equal(effect(), cleanup, 'effect 体同步返回登记的 cleanup 本身');
});

test('ToolHostPort 可被非 dsh 的内存实现满足（双实现准入，端口不绑宿主）', () => {
  const memoryHost: ToolHostPort<ToolDefinition> = {
    withTools(handler) {
      const registry: ToolRegistry<ToolDefinition> = {
        register: () => () => undefined,
      };
      handler({ registry, onDispose: () => undefined });
    },
  };
  let invoked = 0;
  let gotRegistry: ToolRegistry<ToolDefinition> | null = null;
  memoryHost.withTools(({ registry }) => {
    invoked += 1;
    gotRegistry = registry;
  });
  assert.equal(invoked, 1);
  assert.ok(gotRegistry !== null);
});
