/**
 * dsh 事件总线插头测试（平台化 H1 切片 3）。
 *
 * 不依赖真实 cordis Context：用同形假 sink 验证 EventBusPort 的接线契约，重点钉死
 * "同步注册"这条丢首事件红线——on() 返回前监听器必须已可用，注册同步栈内派发的
 * 事件就要能送达，且事件名与多个载荷原样透传。另含一个非 dsh 的内存实现作双实现准入。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDshEventBus, type DshEventSink } from '../../../src/adapters/dsh/event-bus.ts';
import type { EventBusPort } from '../../../src/ports/event-bus-port.ts';

test('createDshEventBus：on 同步原样登记，事件名与监听器函数同引用透传（不包不换）', () => {
  const registered: Array<{ name: string; listener: (...args: unknown[]) => void }> = [];
  const sink: DshEventSink = {
    on(name, listener) {
      registered.push({ name, listener });
      return undefined;
    },
  };
  const bus = createDshEventBus(sink);
  const listener = (): void => {};

  bus.on('session/event', listener);

  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.name, 'session/event');
  assert.equal(registered[0]?.listener, listener, '监听器必须是同一个函数引用');
});

test('同步注册红线：on() 同步栈内派发的首事件不丢，两个载荷原样到达', () => {
  const received: unknown[][] = [];
  // 假 sink 在 on() 执行期间立即派发事件，模拟"注册与首事件之间不允许有异步间隙"。
  const sink: DshEventSink = {
    on(_name, listener) {
      listener('session-object', { kind: 'user/message', seq: 7 });
    },
  };
  const bus = createDshEventBus(sink);

  bus.on('session/event', (...args) => {
    received.push(args);
  });

  assert.deepEqual(received, [['session-object', { kind: 'user/message', seq: 7 }]]);
});

test('EventBusPort 可被非 dsh 的内存事件总线满足（双实现准入，端口不绑宿主）', () => {
  const hooks: Record<string, Array<(...args: unknown[]) => void>> = {};
  const headlessBus: EventBusPort = {
    on(name, listener) {
      (hooks[name] ??= []).push(listener);
    },
  };

  let hits = 0;
  headlessBus.on('session/event', () => {
    hits += 1;
  });
  hooks['session/event']?.[0]?.('a', 'b');

  assert.equal(hits, 1);
});
