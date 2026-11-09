/**
 * QA 独立验证用例 · 第三组（B 块第一期 · 事件层）
 *
 * 本组专门盯**「模块有绿测试 ≠ 端到端跑通」**这一类假通过：
 * 逐条验证任务书/基线要求「必须接线」的环节，是否真的接在运行路径上。
 *
 * 原为特征化断言（断言当时的缺口）。接线补上后**按 QA 自己的约定改写为正向断言**：
 * 不再扫描源码里有没有某个字符串，而是直接验证行为 —— 用假端口把「闭合 → 摘要」
 * 走完整条链路，用真实 checkpoint 文件验证清道夫与对账，用门面读出口验证派生标注。
 * 这样将来若有人把接线拆掉，用例会**行为性**变红，而不是靠字符串匹配变红。
 *
 * 纪律：临时 dataRoot；不碰真实数据根。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { layoutOf } from '../../src/source/paths.ts';
import type { LLMPort, LLMSummarizeRequest, LLMSummarizeResponse } from '../../src/event/llm-port.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const TIMES = [
  '2026-11-08T10:00:00.000Z',
  '2026-11-08T10:01:00.000Z',
  '2026-11-08T10:02:00.000Z',
];

function turn(eventId: string, at: string) {
  return {
    event_id: eventId,
    session_id: 'session-1',
    speaker: 'user' as const,
    raw_text: `内容 ${eventId}`,
    asserted_at: at,
    occurred_at: at,
  };
}

/** 假端口：记录调用次数，返回固定摘要（不联网、不依赖宿主）。 */
class FakePort implements LLMPort {
  readonly requests: LLMSummarizeRequest[] = [];
  response: LLMSummarizeResponse = {
    summary: '她打开了一个网页，看了一份排期表。',
    keyPoints: ['看排期表'],
    anchors: ['打开网页'],
  };

  async summarize(request: LLMSummarizeRequest): Promise<LLMSummarizeResponse> {
    this.requests.push(request);
    return this.response;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Q-B16 · 端到端：摄入 → 机械闭合 → 后台摘要，摘要真的产出
// 任务书 T5「闭合事件入后台队列」、T8/T9、DoD 3
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B16 · 端到端：闭合事件进队列并被摘 → summary_quality 变 ready、来源为 llm', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');
  const port = new FakePort();
  const fasti = await Fasti.open({ dataRoot: root, llmPort: port });
  try {
    for (const [i, at] of TIMES.entries()) {
      await fasti.ingestRawTurn('dsh', turn(`evt-${i}`, at));
    }
    // 静默阈值之外的一条 → 前一个事件机械闭合，并被交给后台队列。
    await fasti.ingestRawTurn('dsh', turn('evt-late', '2026-11-08T11:00:00.000Z'));

    const closed = (await fasti.queryEvents()).find((e) => e.status === 'closed');
    assert.ok(closed, '应有机械闭合的事件');

    // 闭合后事件确实进了队列（而不是像修复前那样被 drain 掉丢弃）。
    assert.ok(
      port.requests.length === 0,
      '入队是纯内存操作 —— 摄入热路径不等待模型（DoD 3）',
    );

    const processed = await fasti.drainClosure();
    assert.ok(processed >= 1, '后台一轮应摘到这条闭合事件');
    assert.equal(port.requests.length, 1, '模型被调用恰一次');

    const after = await fasti.getEvent(closed.id);
    assert.equal(after.summary_quality, 'ready', '摘要已就绪');
    assert.equal(after.summary_source, 'llm', '来源是模型');
    assert.equal(after.summary, port.response.summary);
    assert.deepEqual(after.anchors, port.response.anchors, 'anchors 顺带生成（不消费）');
    assert.ok(after.version > closed.version, '写回是新版本（append-only，不覆盖历史行）');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B17 · 降级：没有端口时事件如实停在 pending，绝不伪造
// §6.5 降级口径
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B17 · 降级：未配置模型时闭合事件停在 pending、summary 为 null，且不入队空转', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    for (const [i, at] of TIMES.entries()) {
      await fasti.ingestRawTurn('dsh', turn(`evt-${i}`, at));
    }
    await fasti.ingestRawTurn('dsh', turn('evt-late', '2026-11-08T11:00:00.000Z'));

    const closed = (await fasti.queryEvents()).find((e) => e.status === 'closed');
    assert.ok(closed, '应有闭合事件');
    assert.equal(closed.summary, null, '不写占位文案');
    assert.equal(closed.summary_quality, 'pending', '如实标注「摘要未生成」');
    assert.equal(closed.summary_source, null);

    assert.equal(await fasti.drainClosure(), 0, '没有模型 → 队列空转没有意义');
    // 处置如实可查：permanent（再试也是白试），不是 retry。
    const failures = fasti.closureFailures().filter((item) => item.eventId === closed.id);
    assert.equal(failures.length, 1, '未配置模型被如实记一条');
    assert.equal(failures[0]?.state, 'permanent');
    assert.equal(await fasti.pendingSummaryCount(), 1, '真源里确实还有 1 条待补');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B18 · G07 启动清道夫：进程重启后 pending 事件被重新入队并补齐
// DoD 3：进程被杀后清道夫不丢任务
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B18 · G07 清道夫：重启（无模型时开机扫描）落 pending_events，重开（有模型）重扫补齐', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');

  // 第一次开机：没有模型 → 产出闭合事件，但摘要出不来。
  const first = await Fasti.open({ dataRoot: root });
  let closedId: string;
  try {
    for (const [i, at] of TIMES.entries()) {
      await first.ingestRawTurn('dsh', turn(`evt-${i}`, at));
    }
    await first.ingestRawTurn('dsh', turn('evt-late', '2026-11-08T11:00:00.000Z'));
    const closed = (await first.queryEvents()).find((e) => e.status === 'closed');
    assert.ok(closed, '应有闭合事件');
    closedId = closed.id;
    assert.equal(closed.summary_quality, 'pending');
  } finally {
    await first.close();
  }

  // 检查点里应有「待补摘要数」—— 这个数来自真源，不是队列长度。
  const ckPath = path.join(layoutOf(root).state, 'checkpoint.json');
  const ck = JSON.parse(fs.readFileSync(ckPath, 'utf8')) as Record<string, unknown>;
  assert.equal(typeof ck['pending_events'], 'number', '检查点记录了待补摘要数');
  assert.equal(ck['pending_events'], 1, '恰好一条待补');

  // 第二次开机：这次有模型 → 启动清道夫把上次遗留的 pending 重新入队。
  const port = new FakePort();
  const second = await Fasti.open({ dataRoot: root, llmPort: port });
  try {
    const processed = await second.drainClosure();
    assert.ok(processed >= 1, '重开门面时 pending 事件已被重新入队（清道夫生效）');
    const healed = await second.getEvent(closedId);
    assert.equal(healed.summary_quality, 'ready', '上次没出的摘要这次补齐了');
    assert.equal(healed.summary_source, 'llm');
  } finally {
    await second.close();
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B19 · G04 启动对账：last_projected_tick 被读写，尾差补折
// 任务书 G04：checkpoint 增 last-projected tick；启动比对真源 max tick 与投影
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B19 · G04 启动对账：last_projected_tick 随写入推进，落后时开机补折尾差', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');

  const first = await Fasti.open({ dataRoot: root });
  try {
    await first.ingestRawTurn('dsh', turn('evt-1', '2026-11-08T10:00:00.000Z'));
    await first.ingestRawTurn('dsh', turn('evt-2', '2026-11-08T10:01:00.000Z'));
    assert.equal(await first.tick(), 1, '真源已分配 tick 0、1');
  } finally {
    await first.close();
  }

  const ckPath = path.join(layoutOf(root).state, 'checkpoint.json');
  const ck = JSON.parse(fs.readFileSync(ckPath, 'utf8')) as Record<string, unknown>;
  assert.equal(ck['last_projected_tick'], 1, '已投影 tick 跟着写入推进到真源 max');

  // 模拟「上次进程在折投影前被杀」：把检查点拨回 0，投影条目删掉一条。
  ck['last_projected_tick'] = 0;
  fs.writeFileSync(ckPath, `${JSON.stringify(ck, null, 2)}\n`);

  const second = await Fasti.open({ dataRoot: root });
  try {
    const report = second.startupReconciliation();
    assert.equal(report.sourceMaxTick, 1, '真源 max tick = 1');
    assert.equal(report.folded, 1, '只补折落后的那一条（tick 1）');
    assert.equal(report.lastProjectedTick, 1);

    // 补折是幂等的：经历集合不会因此多出或少掉。
    const all = await second.query({});
    assert.equal(all.length, 2, '两条经历都在');
  } finally {
    await second.close();
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B20 · 派生标注的读出口（基线 §5.6）
// 待归并 / 跨通道 / 带附件 / 孤立记录 / 摘要待更新 —— 四项都要求「读时计算」
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B20 · 派生标注：queryEventViews 读得出「待归并」与「摘要待更新」', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');

  const port = new FakePort();
  const fasti = await Fasti.open({ dataRoot: root, llmPort: port });
  try {
    // 三条挨着 → 一个 open 事件；第六条跳开 1 小时 → 前一个事件因静默闭合。
    await fasti.ingestRawTurn('dsh', turn('evt-1', '2026-11-08T10:00:00.000Z'));
    await fasti.ingestRawTurn('dsh', turn('evt-2', '2026-11-08T11:00:00.000Z'));

    const single = (await fasti.queryEventViews()).find((e) => e.status === 'closed');
    assert.ok(single, '应有静默闭合的单条事件');
    assert.equal(single.marks.pendingMerge, true, '单指针 + 静默闭合 → 待归并');
    assert.equal(single.marks.crossChannel, false);
    assert.equal(single.marks.hasMedia, false);
    assert.equal(single.marks.orphan, false, '观察窗未到期 → 还不标孤立');

    // 她手写摘要 → 改边界 → 摘要保留但 quality 置 pending = 「摘要待更新（基于旧边界）」。
    await fasti.drainClosure();
    await fasti.rewriteEventSummary({ eventId: single.id, summary: '她自己写的一句话。' });
    await fasti.reviseEventBoundary({ eventId: single.id, addPointerIds: [] });

    const stale = await fasti.getEventView(single.id);
    assert.equal(stale.summary, '她自己写的一句话。', '她的摘要没被覆盖');
    assert.equal(stale.summary_source, 'her');
    assert.equal(stale.marks.summaryStale, true, '派生标注读得出「摘要待更新」');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
