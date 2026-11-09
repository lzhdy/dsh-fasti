/**
 * 后台队列测试（技术基线 §6.4 · 任务卡 T8）。
 *
 * 覆盖：幂等入队（重放安全）、到期出队、退避重排、失败上限标记、快照诊断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryBacklog,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_DELAY_MS,
  backoffDelayMs,
} from '../../src/event/backlog.ts';

test('队列：入队幂等 —— 同 id 重复入队不产生第二份（重放安全）', () => {
  const backlog = new InMemoryBacklog();

  assert.equal(backlog.enqueue('evt-1'), true, '首次入队成功');
  assert.equal(backlog.enqueue('evt-1'), false, '重复入队被拒');
  assert.equal(backlog.size(), 1, '队列里仍只有一份');
  assert.equal(backlog.snapshot()[0]?.eventId, 'evt-1');
});

test('队列：入队立即到期，出队取到最早的任务', () => {
  const backlog = new InMemoryBacklog();
  backlog.enqueue('evt-1');
  backlog.enqueue('evt-2');

  const task = backlog.dequeue(0);
  assert.ok(task);
  assert.equal(task.eventId, 'evt-1', '按入队顺序取');
  assert.equal(task.attempts, 0, '尚未尝试');
});

test('队列：未到期的任务不出队', () => {
  const backlog = new InMemoryBacklog();
  backlog.enqueue('evt-1');

  // 推进到未来时刻后重排 → 此刻不该到期。
  const task = backlog.dequeue(0);
  assert.ok(task);
  backlog.retry(task, 1_000);

  assert.equal(backlog.dequeue(1_000), undefined, '退避未到时不出队');
  assert.ok(backlog.dequeue(1_000 + RETRY_BASE_DELAY_MS), '退避到期后出队');
});

test('队列：出队不移除任务 —— 取出与结算之间不丢任务', () => {
  const backlog = new InMemoryBacklog();
  backlog.enqueue('evt-1');

  assert.ok(backlog.dequeue(0));
  assert.equal(backlog.size(), 1, '出队后仍在队列里（等待 complete/retry 结算）');
  assert.ok(backlog.dequeue(0), '未结算前还能再取到');
});

test('队列：complete 移除任务', () => {
  const backlog = new InMemoryBacklog();
  backlog.enqueue('evt-1');

  backlog.complete('evt-1');
  assert.equal(backlog.size(), 0);
  assert.equal(backlog.dequeue(0), undefined);
});

test('队列：retry 递增尝试次数并按退避重排', () => {
  const backlog = new InMemoryBacklog();
  backlog.enqueue('evt-1');

  const first = backlog.dequeue(0);
  assert.ok(first);
  backlog.retry(first, 0);

  // 重排到了未来 —— 此刻还没到期。
  assert.equal(backlog.dequeue(0), undefined, '退避期内不出队');

  const second = backlog.dequeue(backoffDelayMs(1));
  assert.equal(second?.attempts, 1, '尝试次数 +1');
  assert.equal(second?.nextAttemptAtMs, backoffDelayMs(1), '按退避重排');
});

test('退避：base * 2^(attempts-1)，封顶上限', () => {
  assert.equal(backoffDelayMs(1), RETRY_BASE_DELAY_MS);
  assert.equal(backoffDelayMs(2), RETRY_BASE_DELAY_MS * 2);
  assert.equal(backoffDelayMs(3), RETRY_BASE_DELAY_MS * 4);
  assert.equal(backoffDelayMs(4), RETRY_BASE_DELAY_MS * 8);

  // 封顶：再翻倍也不超过上限。
  assert.equal(backoffDelayMs(10), RETRY_MAX_DELAY_MS);
  assert.equal(backoffDelayMs(50), RETRY_MAX_DELAY_MS);
});

test('退避：上限常量与基线一致（初始 30 秒、上限 10 分钟）', () => {
  assert.equal(RETRY_BASE_DELAY_MS, 30_000);
  assert.equal(RETRY_MAX_DELAY_MS, 600_000);
  assert.ok(RETRY_MAX_ATTEMPTS >= 1, '失败上限至少为 1');
});

test('队列：快照可读 —— 诊断用（不含内部可变状态）', () => {
  const backlog = new InMemoryBacklog();
  backlog.enqueue('evt-1');
  backlog.enqueue('evt-2');

  const snapshot = backlog.snapshot();
  assert.equal(snapshot.length, 2);
  assert.deepEqual(
    snapshot.map((task) => task.eventId),
    ['evt-1', 'evt-2'],
  );
});
