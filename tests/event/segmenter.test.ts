/**
 * 切分器测试（技术基线 §5.2–§5.5 · 任务卡 T4 / T6）。
 *
 * 覆盖：§5.3 判定表 6 行逐条、B 类候选只标不切、每通道各自 open、
 * 场景切换闭合「被离开通道」、open 状态从真源恢复、孤立记录（待归并 / 7 天标注 / 永不自动并入）。
 *
 * 时间样例一律由**固定基准时刻 + 固定偏移**构造（不依赖真实当前时间 → 结果确定）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CorruptedError } from '../../src/core/errors.ts';
import type { Experience } from '../../src/contract/experience.ts';
import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import { EventSegmenter, ORPHAN_MARK_KIND } from '../../src/event/segmenter.ts';
import { noSemanticCandidates } from '../../src/event/detector.ts';
import type { SemanticCandidateDetector } from '../../src/event/detector.ts';
import type { IngestStageContext } from '../../src/event/ingest-stage.ts';
import { resolveEventParams } from '../../src/event/params.ts';
import type { EventParams } from '../../src/event/params.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

/** 固定基准时刻（世界轴）。 */
const BASE_MS = Date.parse('2026-11-08T10:00:00.000Z');
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** 相对基准时刻偏移若干分钟后的 ISO 串。 */
function atMinutes(minutes: number): string {
  return new Date(BASE_MS + minutes * MINUTE_MS).toISOString();
}

/** 构造一条经历 + stage 上下文（模拟摄入后置 stage 的入参）。 */
function makeCtx(
  id: string,
  channel: string,
  occurredAt: string,
  seq: number,
  extra?: Partial<Experience>,
): IngestStageContext {
  const experience: Experience = {
    id,
    schema_version: 1,
    kind: 'dialogue',
    scene: { channel, ref: 'session-1' },
    initiation: 'user',
    observation: { cue: `记录 ${id}` },
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    tick: seq,
    ...extra,
  };
  return { experience, location: { shard: '2026-11', seq }, channel, tick: seq };
}

/** 切分器测试台：临时目录 + 事件真源 + 切分器（固定时钟）。 */
interface Harness {
  readonly root: string;
  readonly log: EventLog;
  readonly segmenter: EventSegmenter;
  /** 投喂一条记录。 */
  feed(id: string, channel: string, occurredAt: string, extra?: Partial<Experience>): void;
  cleanup(): void;
}

function makeHarness(
  options: {
    params?: Partial<EventParams>;
    detectSemanticBoundary?: SemanticCandidateDetector;
    readExperience?: (id: string) => Experience | undefined;
  } = {},
): Harness {
  const root = makeTempRoot('fasti-segmenter-');
  const log = new EventLog(layoutOf(root).events);
  const segmenter = new EventSegmenter({
    log,
    readExperience: options.readExperience ?? (() => undefined),
    params: resolveEventParams(options.params),
    // 固定时钟 → assembled_at / created_at 确定，测试不依赖真实当前时间。
    now: () => BASE_MS,
    detectSemanticBoundary: options.detectSemanticBoundary,
  });

  let seq = 0;
  return {
    root,
    log,
    segmenter,
    feed(id, channel, occurredAt, extra) {
      const at = seq;
      seq += 1;
      segmenter.run(makeCtx(id, channel, occurredAt, at, extra));
    },
    cleanup() {
      cleanupTempRoot(root);
    },
  };
}

/** 事件的指针 id 列表。 */
function pointerIds(event: EventRecord | undefined): string[] {
  return (event?.pointers ?? []).map((pointer) => pointer.id);
}

// ── §5.3 判定表 6 行 ─────────────────────────────────────────────────────

test('规则 1 · 场景切换：闭合被离开通道的 open 事件（dsh→browser→dsh 得三个事件）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'browser', atMinutes(1));
    h.feed('exp-3', 'dsh', atMinutes(2));

    const events = h.log.readAll();
    assert.equal(events.length, 3, 'dsh→browser→dsh 应得三个事件');

    const [first, second, third] = events;
    assert.equal(first?.channel, 'dsh');
    assert.equal(first?.status, 'closed', '被离开通道的 open 事件必须闭合');
    assert.equal(first?.closed_reason, 'channel-switch', '闭合原因落在事件上，不靠派生');
    assert.deepEqual(pointerIds(first), ['exp-1'], '闭合不含触发切换的那一条');

    assert.equal(second?.channel, 'browser');
    assert.equal(second?.status, 'closed');
    assert.deepEqual(pointerIds(second), ['exp-2']);

    assert.equal(third?.channel, 'dsh');
    assert.equal(third?.status, 'open');
    assert.equal(third?.closed_reason, null, 'open 事件的闭合原因为 null');
    assert.deepEqual(
      pointerIds(third),
      ['exp-3'],
      '回到旧通道是**新事件**，不并回已闭合的旧事件',
    );
  } finally {
    h.cleanup();
  }
});

test('规则 2 · 该通道无 open 事件 → 新建事件（含本条，version=1）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));

    const events = h.log.readAll();
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.version, 1);
    assert.equal(event.status, 'open');
    assert.equal(event.closed_reason, null);
    assert.deepEqual(pointerIds(event), ['exp-1']);
    assert.equal(event.channel, 'dsh');
    assert.equal(event.time_range.started_at, atMinutes(0));
    assert.equal(event.time_range.ended_at, atMinutes(0));
    assert.equal(event.summary, null, '摘要由后台生成，闭合前为 null');
    assert.equal(event.summary_quality, 'pending');
    assert.deepEqual(event.topic_lines, [], '第一期话题线恒空');
  } finally {
    h.cleanup();
  }
});

test('规则 3 · 静默 ≥ 阈值 → 闭合旧事件（不含本条）+ 新建新事件', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(31));

    const events = h.log.readAll();
    assert.equal(events.length, 2);
    assert.equal(events[0]?.status, 'closed');
    assert.equal(events[0]?.closed_reason, 'silence', '静默闭合的原因要落在事件上');
    assert.deepEqual(pointerIds(events[0]), ['exp-1'], '闭合不含触发静默的那一条');
    assert.equal(events[1]?.status, 'open');
    assert.equal(events[1]?.closed_reason, null);
    assert.deepEqual(pointerIds(events[1]), ['exp-2']);
  } finally {
    h.cleanup();
  }
});

test('规则 3 · 静默 < 阈值 → 不切（并入同一事件）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(29));

    const events = h.log.readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, 'open');
    assert.deepEqual(pointerIds(events[0]), ['exp-1', 'exp-2']);
  } finally {
    h.cleanup();
  }
});

test('规则 4 · 并入：指针递增、时间范围取 min/max、每次并入都写一个版本', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1));
    h.feed('exp-3', 'dsh', atMinutes(2));

    const events = h.log.readAll();
    assert.equal(events.length, 1, '静默未达标 → 不切');
    const event = events[0];
    assert.ok(event);
    assert.equal(event.status, 'open');
    assert.equal(event.closed_reason, null);
    assert.deepEqual(pointerIds(event), ['exp-1', 'exp-2', 'exp-3']);
    assert.equal(event.time_range.started_at, atMinutes(0));
    assert.equal(event.time_range.ended_at, atMinutes(2));
    assert.equal(event.version, 3, '新建 1 版 + 两次并入各 1 版');
    assert.equal(
      h.log.versionsOf(event.id).length,
      3,
      '并入这一步也留痕（写进去就不许算法重算）',
    );
  } finally {
    h.cleanup();
  }
});

test('规则 4 · 乱序到达：时间范围取 min/max，不因乱序误切', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(5));
    h.feed('exp-3', 'dsh', atMinutes(1));

    const events = h.log.readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.time_range.started_at, atMinutes(0));
    assert.equal(events[0]?.time_range.ended_at, atMinutes(5));
  } finally {
    h.cleanup();
  }
});

test('规则 5 · 并入后记录数达上限 → 闭合（含本条），与并入合并为同一个 closed 版本', () => {
  const h = makeHarness({ params: { maxRecordsPerEvent: 3 } });
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1));
    h.feed('exp-3', 'dsh', atMinutes(2));

    const events = h.log.readAll();
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.status, 'closed');
    assert.equal(event.closed_reason, 'max-records');
    assert.equal(event.pointers.length, 3, '闭合含触发的那一条');
    assert.equal(event.version, 3, '并入与闭合合并为同一个版本');
    assert.equal(h.log.versionsOf(event.id).length, 3);
  } finally {
    h.cleanup();
  }
});

test('规则 6 · 任务闭环信号（工具调用有结果）→ 闭合（含本条）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1), {
      action: { type: 'tool-call', tool: 'browser' },
      outcome: { status: 'success' },
    });

    const events = h.log.readAll();
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.status, 'closed');
    assert.equal(event.closed_reason, 'task-closure');
    assert.deepEqual(pointerIds(event), ['exp-1', 'exp-2'], '闭合含触发的那一条');
  } finally {
    h.cleanup();
  }
});

test('规则 6 · 工具调用但没有结果 → 不算闭环（事件仍可继续并入）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0), { action: { type: 'tool-call' } });
    h.feed('exp-2', 'dsh', atMinutes(1));

    const events = h.log.readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, 'open');
    assert.equal(events[0]?.pointers.length, 2);
  } finally {
    h.cleanup();
  }
});

// ── B 类语义信号 ─────────────────────────────────────────────────────────

test('B 类 · 语义信号只标候选、绝不自动切（候选打在当前 open 事件上）', () => {
  const h = makeHarness({
    // 只在第二条记录上给出语义候选（语义探测器在第二期由适配层提供）。
    detectSemanticBoundary: (input) =>
      input.atPointerId === 'exp-2'
        ? [{ kind: '话题跳转', at_pointer_id: input.atPointerId, marked_at: input.markedAt }]
        : [],
  });
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1));

    const events = h.log.readAll();
    assert.equal(events.length, 1, '语义信号不切');
    const event = events[0];
    assert.ok(event);
    assert.equal(event.status, 'open', '语义信号绝不自动闭合');
    assert.equal(event.pointers.length, 2);
    assert.equal(event.boundary_candidates.length, 1);
    assert.equal(event.boundary_candidates[0]?.kind, '话题跳转');
    assert.equal(event.boundary_candidates[0]?.at_pointer_id, 'exp-2');
  } finally {
    h.cleanup();
  }
});

test('B 类 · 未接探测器 → boundary_candidates 恒空（第一期不产生语义候选）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1));

    const event = h.log.readAll()[0];
    assert.ok(event);
    assert.deepEqual(event.boundary_candidates, []);
  } finally {
    h.cleanup();
  }
});

// ── 通道隔离 ─────────────────────────────────────────────────────────────

test('每通道各自维护 open 事件（不存在全局 open，通道之间不互相并入）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'browser', atMinutes(1));
    h.feed('exp-3', 'browser', atMinutes(2));

    const events = h.log.readAll();
    assert.equal(events.length, 2);
    const browser = events.find((event) => event.channel === 'browser');
    assert.ok(browser);
    assert.equal(browser.status, 'open');
    assert.deepEqual(pointerIds(browser), ['exp-2', 'exp-3'], '只并入本通道的 open 事件');
  } finally {
    h.cleanup();
  }
});

// ── 开放状态的恢复 ───────────────────────────────────────────────────────

test('恢复 · 重启后 open 状态从事件真源恢复（不静默从零开始、不重切一遍）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1));

    // 模拟进程重启：旧实例释放（单写者纪律）→ 新的日志实例 + 新的切分器，
    // 状态只能来自事件真源。
    h.log.dispose();
    const log = new EventLog(layoutOf(h.root).events);
    const segmenter = new EventSegmenter({
      log,
      readExperience: () => undefined,
      now: () => BASE_MS,
    });
    segmenter.restore();
    segmenter.run(makeCtx('exp-3', 'dsh', atMinutes(2), 2));

    const events = log.readAll();
    assert.equal(events.length, 1, '恢复后应并入同一个事件，而不是从头切一遍');
    assert.equal(events[0]?.pointers.length, 3);
  } finally {
    h.cleanup();
  }
});

test('恢复 · 同通道出现两个 open 事件 → CorruptedError（不静默从零开始）', () => {
  const root = makeTempRoot('fasti-segmenter-');
  try {
    const log = new EventLog(layoutOf(root).events);
    log.appendVersion(makeEvent({ id: 'evt-a', channel: 'dsh', status: 'open' }));
    log.appendVersion(makeEvent({ id: 'evt-b', channel: 'dsh', status: 'open' }));

    const segmenter = new EventSegmenter({
      log,
      readExperience: () => undefined,
      now: () => BASE_MS,
    });
    assert.throws(() => segmenter.restore(), CorruptedError);
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 孤立记录（T6）────────────────────────────────────────────────────────

test('孤立记录 · 观察窗到期只加「孤立记录」标注，不自动归并、不删行', () => {
  const h = makeHarness();
  try {
    // 第一条记录随后被**静默**闭合 → 单指针 + 因静默闭合 = 待归并（前后无可并）。
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(40));

    const before = h.log.readAll();
    assert.equal(before.length, 2);
    const lonely = before.find((event) => event.channel === 'dsh' && event.status === 'closed');
    assert.ok(lonely);
    assert.equal(lonely.closed_reason, 'silence');
    assert.equal(lonely.pointers.length, 1, '前后无可并 → 单指针事件');

    // 窗口未到期 → 不标。
    assert.equal(h.segmenter.sweepOrphanMarks(BASE_MS + 6 * DAY_MS), 0);

    // 窗口到期 → 只加标注。
    assert.equal(h.segmenter.sweepOrphanMarks(BASE_MS + 8 * DAY_MS), 1);

    const after = h.log.readAll();
    const orphan = after.find((event) => event.id === lonely.id);
    assert.ok(orphan);
    assert.equal(orphan.boundary_candidates.length, 1);
    assert.equal(orphan.boundary_candidates[0]?.kind, ORPHAN_MARK_KIND);
    assert.equal(orphan.boundary_candidates[0]?.at_pointer_id, 'exp-1');
    assert.equal(orphan.pointers.length, 1, '绝不自动并入任何内容无关的事件');
    assert.equal(orphan.closed_reason, 'silence', '回写新版本必须原样带过闭合原因');

    const other = after.find((event) => event.id !== lonely.id);
    assert.ok(other);
    assert.equal(other.pointers.length, 1, '别的事件也不受影响');

    // 不删行：历史版本仍在（v1 建、v2 闭合、v3 标注）。
    assert.equal(h.log.versionsOf(orphan.id).length, 3);
  } finally {
    h.cleanup();
  }
});

test('孤立记录 · 标注幂等（重复扫描不重复加、不重复写行）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(40));

    assert.equal(h.segmenter.sweepOrphanMarks(BASE_MS + 8 * DAY_MS), 1);
    const lonely = h.log.readAll().find((event) => event.status === 'closed');
    assert.ok(lonely);
    const versions = h.log.versionsOf(lonely.id).length;

    assert.equal(h.segmenter.sweepOrphanMarks(BASE_MS + 9 * DAY_MS), 0, '已标过的不再标');
    assert.equal(h.log.versionsOf(lonely.id).length, versions, '不重复写行');
  } finally {
    h.cleanup();
  }
});

test('孤立记录 · 多条记录的事件不标（不是孤立记录）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1));
    h.feed('exp-3', 'dsh', atMinutes(40));

    assert.equal(h.segmenter.sweepOrphanMarks(BASE_MS + 30 * DAY_MS), 0);
  } finally {
    h.cleanup();
  }
});

// ── 读时派生的标注（§5.6）────────────────────────────────────────────────

test('派生标注 · 待归并 / 带附件 / 跨通道 / 孤立记录（读时计算，不落盘）', () => {
  const withMedia = makeCtx('exp-1', 'dsh', atMinutes(0), 0).experience;
  withMedia.observation.media = [
    {
      ref_id: '01J0000000000000000000000M',
      kind: 'image',
      mime: 'image/png',
      origin: { channel: 'dsh', host_ref: 'x', captured_at: atMinutes(0) },
    },
  ];

  const h = makeHarness({
    readExperience: (id) => (id === 'exp-1' ? withMedia : undefined),
  });
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(40));

    const lonely = h.log.readAll().find((event) => event.status === 'closed');
    assert.ok(lonely);
    const marks = h.segmenter.marksOf(lonely);
    assert.equal(marks.pendingMerge, true, '单指针且因静默闭合 → 待归并');
    assert.equal(marks.hasMedia, true, '带附件由读到的经历派生');
    assert.equal(marks.crossChannel, false);
    assert.equal(marks.orphan, false, '尚未到期 → 未标孤立记录');

    h.segmenter.sweepOrphanMarks(BASE_MS + 8 * DAY_MS);
    const orphan = h.log.readAll().find((event) => event.id === lonely.id);
    assert.ok(orphan);
    assert.equal(h.segmenter.marksOf(orphan).orphan, true);
  } finally {
    h.cleanup();
  }
});

test('派生标注 · 任务闭环闭合的单条不是待归并（那是一件完整的事）', () => {
  const h = makeHarness();
  try {
    // 事件先开起来，再来一条任务闭环的记录 → 并入 + 闭合（规则 4 + 规则 6）。
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1), {
      action: { type: 'tool-call', tool: 'browser' },
      outcome: { status: 'success' },
    });

    const event = h.log.readAll()[0];
    assert.ok(event);
    assert.equal(event.closed_reason, 'task-closure');
    assert.equal(h.segmenter.marksOf(event).pendingMerge, false, '完整的事不是孤条');
    assert.equal(h.segmenter.sweepOrphanMarks(BASE_MS + 30 * DAY_MS), 0, '不标孤立记录');
  } finally {
    h.cleanup();
  }
});

test('边界 · 通道第一条记录即任务闭环信号 → 按判定表行序只新建事件（信号未生效，已上报裁定）', () => {
  const h = makeHarness();
  try {
    // 判定表行序：行 2（无 open → 新建）先于行 6；行 5/6 是「与行 4 合并成同一个版本」。
    // 故通道的第一条记录即使带任务闭环信号，也只新建事件、不立刻闭合。
    // ⚠️ 这个缺口已上报 team-lead / solution-architect 裁定（见交付报告冲突清单第 8 条）。
    h.feed('exp-1', 'dsh', atMinutes(0), {
      action: { type: 'tool-call', tool: 'browser' },
      outcome: { status: 'success' },
    });

    const event = h.log.readAll()[0];
    assert.ok(event);
    assert.equal(event.status, 'open');
    assert.equal(event.closed_reason, null);
    assert.equal(event.pointers.length, 1);
  } finally {
    h.cleanup();
  }
});

test('派生标注 · 跨通道：指针跨了 ≥2 个通道才算', () => {
  const h = makeHarness();
  try {
    const event = makeEvent({
      id: 'evt-cross',
      channel: 'dsh',
      status: 'closed',
      pointers: [
        { id: 'exp-1', channel: 'dsh' },
        { id: 'exp-2', channel: 'browser' },
      ],
    });
    const marks = h.segmenter.marksOf(event);
    assert.equal(marks.crossChannel, true);
    assert.equal(marks.pendingMerge, false, '多指针 → 不是待归并');
  } finally {
    h.cleanup();
  }
});

// ── 参数集中 ─────────────────────────────────────────────────────────────

test('参数集中 · 阈值取自 params（注入小阈值后行为随之改变 → 代码里不硬编码）', () => {
  const loose = makeHarness();
  try {
    loose.feed('exp-1', 'dsh', atMinutes(0));
    loose.feed('exp-2', 'dsh', atMinutes(6));
    assert.equal(loose.log.readAll().length, 1, '默认静默阈值下 6 分钟不切');
  } finally {
    loose.cleanup();
  }

  const tight = makeHarness({ params: { silenceGapMinutes: 5 } });
  try {
    tight.feed('exp-1', 'dsh', atMinutes(0));
    tight.feed('exp-2', 'dsh', atMinutes(6));
    assert.equal(tight.log.readAll().length, 2, '静默阈值改为 5 分钟后 6 分钟即切');
  } finally {
    tight.cleanup();
  }
});

/** 构造一条事件记录（用于手工布置真源）。 */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const base: EventRecord = {
    id: 'evt-1',
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'open',
    closed_reason: null,
    pointers: [{ id: 'exp-1', channel: 'dsh', shard: '2026-11', seq: 0 }],
    time_range: { started_at: atMinutes(0), ended_at: atMinutes(0) },
    assembled_at: atMinutes(0),
    summary: null,
    key_points: [],
    anchors: [],
    topic_lines: [],
    summary_quality: 'pending',
    summary_source: null,
    summary_prompt_version: null,
    summary_model: null,
    created_by: 'system',
    created_at: atMinutes(0),
    channel: 'dsh',
    boundary_candidates: [],
  };
  return { ...base, ...overrides };
}

test('B 类端口 · 假实现恒无候选（第一期不产生语义候选，检测在第二期由适配层提供）', () => {
  const input = {
    experience: makeCtx('exp-1', 'dsh', atMinutes(0), 0).experience,
    channel: 'dsh',
    atPointerId: 'exp-1',
    markedAt: atMinutes(0),
  };
  assert.deepEqual(noSemanticCandidates(input), [], '假实现恒无候选');
});

// ── 重放防重（记录级去重）────────────────────────────────────────────────

test('重放防重：同一记录重复投喂 → 只归一个事件、只挂一次指针、不产生新版本', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-1', 'dsh', atMinutes(0));

    const events = h.log.readAll();
    assert.equal(events.length, 1, '不得产生第二个事件');
    assert.deepEqual(pointerIds(events[0]), ['exp-1'], '指针不重复');
    assert.equal(events[0]?.version, 1, '重放不追加版本行');
  } finally {
    h.cleanup();
  }
});

test('重放防重：重启后 restore() 从真源重建去重表 → 重投同一记录仍是空操作', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1));

    // 模拟进程重启：同一个切分器实例重新从真源恢复（生产里是新实例 + restore()）。
    h.segmenter.restore();
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1));

    const events = h.log.readAll();
    assert.equal(events.length, 1, '重启后重投不新增事件');
    assert.deepEqual(pointerIds(events[0]), ['exp-1', 'exp-2'], '指针不重复、顺序不变');
    assert.equal(events[0]?.version, 2, '两次并入 = 版本 2，重投没有多写');
  } finally {
    h.cleanup();
  }
});
