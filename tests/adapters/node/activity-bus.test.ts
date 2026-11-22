/**
 * #157 进程内活动总线红测（先红后绿）。
 *
 * 总线只活在 node 进程内存里（不持久化、不跨进程），职责是把写入链/读出链各挂点的
 * 脉冲汇成带单调序号的环形缓冲，并给 HTTP 长轮询提供「等下一条」原语：
 *  - seq 从 1 起单调递增、环形缓冲有界、旧事件自动淘汰；
 *  - waitForNext 新事件即时唤醒、超时返 null、dispose 释放全部等待者（防悬挂连接）；
 *  - since 只返回现存且序号大于游标的事件，淘汰窗口外的旧序号不报错（前端靠快照兜底）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ActivityBus } from '../../../src/adapters/node/activity-bus.ts';

function fakeClock(start = 1_000): { now(): number; tick(ms: number): void } {
  let value = start;
  return {
    now: () => value,
    tick(ms: number) {
      value += ms;
    },
  };
}

test('ActivityBus：seq 单调递增，since 按游标增量返回，环形容量有界', () => {
  const clock = fakeClock();
  const bus = new ActivityBus({ capacity: 3, now: clock.now });
  assert.equal(bus.currentSeq(), 0);

  const e1 = bus.emit('ingest.turn', 'info', '第一条', { tick: 0 });
  const e2 = bus.emit('closure.drain', 'ok', '第二条');
  const e3 = bus.emit('memory.drain', 'ok', '第三条');
  assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3]);
  assert.equal(e1.at, 1000);
  assert.deepEqual(
    bus.since(0).map((e) => e.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    bus.since(2).map((e) => e.seq),
    [3],
  );
  assert.deepEqual(bus.since(3), []);

  clock.tick(50);
  const e4 = bus.emit('tool.call', 'info', '第四条挤掉最旧一条');
  assert.equal(e4.at, 1050);
  assert.equal(bus.currentSeq(), 4, '当前序号继续推进，不受淘汰影响');
  assert.deepEqual(
    bus.since(0).map((e) => e.seq),
    [2, 3, 4],
    '环形缓冲只留最近 3 条，seq=1 已淘汰',
  );
  assert.deepEqual(
    bus.since(1).map((e) => e.seq),
    [2, 3, 4],
    '游标落在淘汰窗口内不报错，给出现存全部增量',
  );
});

test('ActivityBus：waitForNext 被新事件即时唤醒，超时返回 null', async () => {
  const bus = new ActivityBus({ now: fakeClock().now, unrefTimers: false });
  const waiting = bus.waitForNext(50);
  queueMicrotask(() => {
    bus.emit('ingest.turn', 'info', '微任务里来的脉冲');
  });
  const event = await waiting;
  assert.equal(event?.kind, 'ingest.turn');

  const timedOut = await bus.waitForNext(20);
  assert.equal(timedOut, null, '无新事件时干净超时，不挂起');
});

test('ActivityBus：多个等待者同收一条；dispose 全部唤醒为 null', async () => {
  const bus = new ActivityBus({ now: fakeClock().now, unrefTimers: false });
  const waiters = [bus.waitForNext(1_000), bus.waitForNext(1_000)];
  queueMicrotask(() => {
    bus.emit('loop.error', 'error', '节拍故障');
  });
  const got = await Promise.all(waiters);
  assert.equal(got[0]?.seq, got[1]?.seq);
  assert.equal(got[0]?.level, 'error');

  const drained = [bus.waitForNext(1_000), bus.waitForNext(1_000)];
  bus.dispose();
  const results = await Promise.all(drained);
  assert.deepEqual(results, [null, null], 'dispose 后等待者全部释放，连接可正常收尾');
});
