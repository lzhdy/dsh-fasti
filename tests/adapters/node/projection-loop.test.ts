/**
 * 记忆投影节拍器红测（对话第二刀）：node 身体自驱第七法 drain，
 * 对齐 dsh 的 dsh-fasti-memory-projection-worker（5s 轮询、60s 预算、失败隔离不炸节拍）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROJECTION_BUDGET_MS, startProjectionLoop } from '../../../src/adapters/node/projection-loop.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('投影节拍：按间隔周期调 drainMemoryProjection 并透传预算，stop 后静默且幂等', async () => {
  assert.equal(DEFAULT_PROJECTION_BUDGET_MS, 60_000, '投影预算与 dsh 侧常量同量级（60s），节点内本地定义');
  const budgets: number[] = [];
  let calls = 0;
  const handle = startProjectionLoop(
    {
      async drainMemoryProjection(budgetMs: number) {
        budgets.push(budgetMs);
        calls += 1;
        return { skipped: null, applied: 0 };
      },
    },
    { intervalMs: 20 },
  );

  await sleep(95);
  handle.stop();
  const callsBefore = calls;
  assert.ok(callsBefore >= 3, `20ms 间隔应至少触发 3 次，实际 ${callsBefore}`);
  assert.ok(budgets.every((b) => b === DEFAULT_PROJECTION_BUDGET_MS), '预算必须取节点内固定常量');
  await sleep(60);
  assert.equal(calls, callsBefore, 'stop 后不得再有新轮次');
  assert.doesNotThrow(() => handle.stop(), 'stop 幂等');
});

test('投影节拍：单轮抛错被隔离，下一轮照常触发', async () => {
  let calls = 0;
  let failures = 0;
  const handle = startProjectionLoop(
    {
      async drainMemoryProjection() {
        calls += 1;
        if (calls === 1) {
          throw new Error('drain boom');
        }
        return { skipped: null };
      },
    },
    {
      intervalMs: 20,
      onError: () => {
        failures += 1;
      },
    },
  );

  await sleep(95);
  handle.stop();
  assert.ok(calls >= 2, '失败后节拍必须继续');
  assert.equal(failures, 1, '错误恰好上报一次');
});

test('投影节拍：onReport 成功轮透传 drain 报告，失败轮不触发（#157 观测挂点）', async () => {
  const reports: unknown[] = [];
  let calls = 0;
  const handle = startProjectionLoop(
    {
      async drainMemoryProjection() {
        calls += 1;
        if (calls === 1) {
          throw new Error('first boom');
        }
        return { skipped: null, applied: calls, cardUpserts: calls };
      },
    },
    { intervalMs: 20, onReport: (report) => reports.push(report) },
  );
  await sleep(90);
  handle.stop();
  assert.ok(reports.length >= 2, `成功轮至少两次上报，实际 ${reports.length}`);
  for (const report of reports) {
    assert.equal((report as { skipped: null }).skipped, null);
  }
});
