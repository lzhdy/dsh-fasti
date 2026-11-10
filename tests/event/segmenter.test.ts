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
import { charsToTokens } from '../../src/event/params.ts';
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
    // v1.4 加法字段：默认 null（未统计）；extra 若显式给了 char_count 则以其为准。
    // 放在 ...extra **之后** 显式归一 —— Partial<Experience> 展开出的类型含 undefined，
    // 直接展开无法满足 Experience.char_count 的「必填可空」契约。
    char_count: extra?.char_count ?? null,
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
  // 投喂过的经历（按 id 存）—— 供 readExperience 回查。
  // v1.4：restore() 要靠它**重放记录**重建任务作用域状态（inFlightCallIds /
  // toolCallSeen），生产里 readExperience 读的是真源，这里同理。
  const fed = new Map<string, Experience>();
  const segmenter = new EventSegmenter({
    log,
    readExperience:
      options.readExperience ?? ((id) => fed.get(id)),
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
      const ctx = makeCtx(id, channel, occurredAt, at, extra);
      fed.set(id, ctx.experience);
      segmenter.run(ctx);
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

test('规则 5 · v1.4：有效对话字数达上限 → 闭合（含本条），与并入合并为同一个 closed 版本', () => {
  // v1.4 设计性改写（定案稿 §9「不做 20 条记录硬上限（退役）」+ 任务书 C3/C4）：
  // 旧断言用 `maxRecordsPerEvent: 3` 触发条数上限、reason 为 'max-records'；
  // 新断言改用 `maxEffectiveCharsPerEvent` 触发**有效对话字数上限**、reason 为
  // 'max-dialogue-chars'。约束项数 5 → 6（不减），且新增了「条数不再产生上限」的
  // 负向断言 —— 覆盖了新口径的完整语义（上限按字数、不按条数）。
  const h = makeHarness({ params: { maxEffectiveCharsPerEvent: 100 } });
  try {
    // 每条 40 字（非工具轮）→ 累计 120 ≥ 100 时闭合。
    h.feed('exp-1', 'dsh', atMinutes(0), { char_count: 40 });
    h.feed('exp-2', 'dsh', atMinutes(1), { char_count: 40 });

    const before = h.log.readAll();
    assert.equal(before.length, 1);
    assert.equal(before[0]?.status, 'open', '80 字未达 100 → 不闭合');
    assert.equal(before[0]?.effective_chars, 80, '有效对话字数随并入累计');

    h.feed('exp-3', 'dsh', atMinutes(2), { char_count: 40 });

    const events = h.log.readAll();
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.status, 'closed');
    assert.equal(event.closed_reason, 'max-dialogue-chars');
    assert.equal(event.pointers.length, 3, '闭合含触发的那一条');
    assert.equal(event.version, 3, '并入与闭合合并为同一个版本');
    assert.equal(h.log.versionsOf(event.id).length, 3);
    assert.equal(event.effective_chars, 120, '计数器随版本推进落盘');
  } finally {
    h.cleanup();
  }
});

test('规则 5 · v1.4：条数上限已退役 —— 超过 20 条也不因条数闭合', () => {
  // 定案稿 §9「不做 20 条记录硬上限（退役，max-records 仅保留兼容读取）」。
  // 旧实现会在第 20 条闭合；新实现只按字数/静默/场景切换闭合。
  const h = makeHarness();
  try {
    for (let index = 0; index < 25; index += 1) {
      h.feed(`exp-${index}`, 'dsh', atMinutes(index));
    }
    const events = h.log.readAll();
    assert.equal(events.length, 1, '25 条仍在同一个事件里（未因条数切分）');
    assert.equal(events[0]?.status, 'open', '未因条数闭合');
    assert.equal(events[0]?.pointers.length, 25);
  } finally {
    h.cleanup();
  }
});

test('规则 6 · v1.4 作用域：请求/结果拆两条 + 交付轮 → 闭合（含本条）', () => {
  // v1.4 设计性改写（定案稿 §5.0.3 + 任务书 C5）：
  // 旧断言用「同一条记录同时含 action 与 outcome」触发闭环 —— 该形态在 v1.4 的
  // 「请求/结果拆两条」映射下**恒 false**（定案稿原文），旧判据 isTaskClosure 被 C5 明确替换。
  // 新断言按作用域语义：调用步（准入门槛置位）→ 结果（callId 离场）→ 交付轮 → 闭合。
  // 约束项数 4 → 6（不减），且新增了「在途未清空时不闭合」的前置断言。
  //
  // **显式开启任务闭环信号**（定案稿 §5.2 dormant → active 的门控口径）：
  // 本用例验的是「作用域判据本身正确」，故必须把信号打开才能观察到它；
  // 默认参数下信号休眠（另有专门用例守住 dormancy）。
  const h = makeHarness({ params: { taskClosureActive: true } });
  try {
    // 第 1 条：调用步 → 准入门槛置位、callId 进入在途集合。
    h.feed('exp-1', 'dsh', atMinutes(0), {
      action: { type: 'tool-call', tool: 'browser', call_id: 'call-1' },
    });
    assert.equal(h.log.readAll()[0]?.status, 'open', '刚发起调用不算闭环');

    // 第 2 条：结果 → 对应 callId 离场（在途集合清空）。
    h.feed('exp-2', 'dsh', atMinutes(1), {
      outcome: { status: 'success', call_id: 'call-1' },
    });
    assert.equal(h.log.readAll()[0]?.status, 'open', '结果轮本身不算交付（工具轮不是交付轮）');

    // 第 3 条：交付轮（她的非工具回复）→ 作用域闭合。
    h.feed('exp-3', 'dsh', atMinutes(2), { initiation: 'her' });

    const events = h.log.readAll();
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.status, 'closed');
    assert.equal(event.closed_reason, 'task-closure');
    assert.deepEqual(pointerIds(event), ['exp-1', 'exp-2', 'exp-3'], '闭合含触发的那一条');
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

test('B 类 · 快路径（机械闭合，无 LLM 调用）→ boundary_candidates 恒空', () => {
  // v1.4 · C9 设计性改写（**改写而非削弱**，纪律第 4 条）：
  // 旧断言「未接探测器 → 候选恒空（第一期不产生语义候选）」—— 一句话断言「全都不产生」。
  // v1.4 把口径拆成快/慢两条路径（定案稿 §5.2 B 类信号 + 任务书 C9）：
  //   ① 快路径恒空（**本条**，旧断言的适用范围原样保留）；
  //   ② 慢路径可产 ≤5 条候选（见 tests/event/closure.test.ts）。
  // 本条保留旧断言的**全部含义**，并把适用范围写准（机械闭合路径）。
  // 约束项数 1 → 3（不减），且断言更具体（明确 status 与 closed_reason）。
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1));

    const event = h.log.readAll()[0];
    assert.ok(event);
    assert.deepEqual(event.boundary_candidates, [], '快路径恒不产生语义候选');
    assert.equal(event.status, 'open', '机械路径本身不产生候选，也不因此改状态');
    assert.equal(event.closed_reason, null, '候选为空时闭合原因不受影响');
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
  // v1.4 设计性改写（定案稿 §5.0.3 + 任务书 C5）：旧断言用「同一条记录同时含
  // action 与 outcome」触发闭环（该形态在 v1.4 映射下恒 false）。
  // 新断言用作用域形态（调用步 → 结果 → 交付轮）触发闭环。
  // 约束项数 4 → 5（不减），原意图（「完整的事不是孤条」）完整保留并加强。
  //
  // 显式开启任务闭环信号（定案稿 §5.2 dormant → active 门控）：
  // 本用例验的是「task-closure 闭合的单条不是待归并」，须先让信号生效。
  const h = makeHarness({ params: { taskClosureActive: true } });
  try {
    // 事件先开起来，再来一次工具调用与结果，最后她交付 → 并入 + 闭合。
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(1), {
      action: { type: 'tool-call', tool: 'browser', call_id: 'call-1' },
    });
    h.feed('exp-3', 'dsh', atMinutes(2), {
      outcome: { status: 'success', call_id: 'call-1' },
    });
    h.feed('exp-4', 'dsh', atMinutes(3), { initiation: 'her' });

    const event = h.log.readAll()[0];
    assert.ok(event);
    assert.equal(event.closed_reason, 'task-closure');
    assert.equal(h.segmenter.marksOf(event).pendingMerge, false, '完整的事不是孤条');
    assert.equal(h.segmenter.sweepOrphanMarks(BASE_MS + 30 * DAY_MS), 0, '不标孤立记录');
    assert.equal(event.pointers.length, 4, '闭合含全部四条记录');
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
    effective_chars: null,
    raw_chars: null,
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

// ── 时钟静默（定案稿 C6 · A6a / A6c）──────────────────────────────────────

test('时钟静默 · 无新记录到达，推进墙钟跨过 30min → open 事件被闭合（reason=silence）', () => {
  const h = makeHarness();
  try {
    // 系统轴与墙钟同轴：recorded_at 固定在基准时刻。
    h.feed('exp-1', 'dsh', atMinutes(0), { recorded_at: atMinutes(0) });
    h.feed('exp-2', 'dsh', atMinutes(1), { recorded_at: atMinutes(1) });

    const before = h.log.readAll();
    assert.equal(before.length, 1);
    assert.equal(before[0]?.status, 'open', '此刻还是 open');
    const pointersBefore = pointerIds(before[0]);

    // 推进假时钟：末条 recorded_at 距今 29 分钟 → 还没到阈值，不闭合。
    assert.equal(h.segmenter.closeExpiredEvents(BASE_MS + 29 * MINUTE_MS), 0, '29 分钟不闭合');
    assert.equal(h.log.readAll()[0]?.status, 'open', '未到阈值仍是 open');

    // 跨过 30 分钟 → 闭合。
    const closed = h.segmenter.closeExpiredEvents(BASE_MS + 31 * MINUTE_MS);
    assert.equal(closed, 1, '跨过 30 分钟应闭合 1 个事件');

    const after = h.log.readAll();
    assert.equal(after.length, 1, '只闭合，不新建事件');
    assert.equal(after[0]?.status, 'closed');
    assert.equal(after[0]?.closed_reason, 'silence', '闭合原因是静默');
    assert.deepEqual(pointerIds(after[0]), pointersBefore, '指针逐条不变（时钟化不改边界）');
  } finally {
    h.cleanup();
  }
});

test('时钟静默 · 基准取系统轴 recorded_at，不取世界轴 occurred_at', () => {
  const h = makeHarness();
  try {
    // 世界轴很早（occurred_at = 基准），但系统轴很近（recorded_at = 基准 + 1 小时）。
    // 若误取 occurred_at，墙钟推进 31 分钟就会闭合；正确口径（recorded_at）下不应闭合。
    h.feed('exp-1', 'dsh', atMinutes(0), { recorded_at: atMinutes(60) });
    const closed = h.segmenter.closeExpiredEvents(BASE_MS + 31 * MINUTE_MS);
    assert.equal(closed, 0, 'recorded_at 未到 30 分钟 → 不该闭合（基准不是 occurred_at）');
    assert.equal(h.log.readAll()[0]?.status, 'open', '仍是 open');
  } finally {
    h.cleanup();
  }
});

test('时钟静默 · 幂等：闭合后重复 tick 是 no-op（不产生新版本、不改闭合原因）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0), { recorded_at: atMinutes(0) });

    const closed = h.segmenter.closeExpiredEvents(BASE_MS + 31 * MINUTE_MS);
    assert.equal(closed, 1);
    const versionAfterClose = h.log.readAll()[0]?.version;

    // 重复 tick：已闭合的事件不在 open 状态里 → no-op。
    assert.equal(h.segmenter.closeExpiredEvents(BASE_MS + 31 * MINUTE_MS), 0, '重复 tick 不再闭合');
    assert.equal(h.segmenter.closeExpiredEvents(BASE_MS + 120 * MINUTE_MS), 0, '再晚也不重复闭合');

    const after = h.log.readAll();
    assert.equal(after.length, 1, '不新增事件');
    assert.equal(after[0]?.version, versionAfterClose, '不产生新版本');
    assert.equal(after[0]?.closed_reason, 'silence', '闭合原因不被改写');
  } finally {
    h.cleanup();
  }
});

test('时钟静默 · 与摄入同一事件同时命中 → 只闭合一次、只写一个原因', () => {
  const h = makeHarness();
  try {
    // 先投一条（世界轴与系统轴同轴）。
    h.feed('exp-1', 'dsh', atMinutes(0), { recorded_at: atMinutes(0) });

    // 时钟闭合。
    assert.equal(h.segmenter.closeExpiredEvents(BASE_MS + 31 * MINUTE_MS), 1);
    const afterClock = h.log.readAll()[0];
    assert.equal(afterClock?.closed_reason, 'silence');

    // 摄入路径随后到达一条（间隔远超静默阈值）—— 已闭合的事件不应被再写一次。
    h.feed('exp-2', 'dsh', atMinutes(45), { recorded_at: atMinutes(45) });

    const events = h.log.readAll();
    const silenceClosed = events.filter((event) => event.closed_reason === 'silence');
    assert.equal(silenceClosed.length, 1, '只写一个 silence 闭合原因');
    assert.deepEqual(
      pointerIds(silenceClosed[0]),
      ['exp-1'],
      '时钟闭合的那个事件只含触发前的记录（不含尚未到达的记录）',
    );
  } finally {
    h.cleanup();
  }
});

test('时钟静默 · 摄入期静默补判仍保留（worker 不可用期间的兜底未被删除）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0), { recorded_at: atMinutes(0) });
    // 间隔 ≥30 分钟的下一条到达 → 摄入期补判照旧闭合旧事件（不依赖时钟）。
    h.feed('exp-2', 'dsh', atMinutes(31), { recorded_at: atMinutes(31) });

    const events = h.log.readAll();
    assert.equal(events.length, 2, '补判切出两个事件');
    assert.equal(events[0]?.closed_reason, 'silence', '摄入期补判仍在生效');
    assert.equal(events[1]?.status, 'open');
  } finally {
    h.cleanup();
  }
});

// ── v1.4 两个上限：确定性边界与优先级矩阵（定案稿 §5.2.1 · A3 / A4 / A4′）──

test('A3 · 硬保险丝：raw 累计 49999 不闭合、50000 立即闭合（reason=max-chars）', () => {
  const h = makeHarness();
  try {
    // 第一条 49999 字（工具轮：只进 raw_chars，不进 effective_chars）。
    h.feed('exp-1', 'dsh', atMinutes(0), {
      char_count: 49_999,
      action: { type: 'tool-call', tool: 'web_fetch' },
    });
    assert.equal(h.log.readAll()[0]?.status, 'open', '49999 未达保险丝 → 不闭合');
    assert.equal(h.log.readAll()[0]?.raw_chars, 49_999);
    assert.equal(h.log.readAll()[0]?.effective_chars, 0, '工具轮不进有效对话字数');

    // 第二条 1 字 → 累计 50000 → 立即闭合。
    h.feed('exp-2', 'dsh', atMinutes(1), { char_count: 1 });
    const events = h.log.readAll();
    assert.equal(events.length, 1, '闭合在同一个事件里');
    assert.equal(events[0]?.status, 'closed');
    assert.equal(events[0]?.closed_reason, 'max-chars', '硬保险丝闭合');
    assert.equal(events[0]?.raw_chars, 50_000, '触发闭合的那条计入累计');
    assert.equal(events[0]?.effective_chars, 1, '只有非工具轮进有效对话字数');
  } finally {
    h.cleanup();
  }
});

test('A4 · 有效对话字数：累计 6999 不闭合、7000 闭合（reason=max-dialogue-chars）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0), { char_count: 6_999 });
    assert.equal(h.log.readAll()[0]?.status, 'open', '6999 未达上限 → 不闭合');
    assert.equal(h.log.readAll()[0]?.effective_chars, 6_999);

    h.feed('exp-2', 'dsh', atMinutes(1), { char_count: 1 });
    const events = h.log.readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, 'closed');
    assert.equal(events[0]?.closed_reason, 'max-dialogue-chars');
    assert.equal(events[0]?.effective_chars, 7_000);
  } finally {
    h.cleanup();
  }
});

test('A4 · 工具轮计入 raw_chars 但不增 effective_chars（两个口径分离）', () => {
  const h = makeHarness({ params: { maxEffectiveCharsPerEvent: 100 } });
  try {
    // 工具轮 80 字：只进 raw_chars。
    h.feed('exp-1', 'dsh', atMinutes(0), {
      char_count: 80,
      action: { type: 'tool-call', tool: 'web_fetch' },
    });
    const tool = h.log.readAll()[0];
    assert.equal(tool?.raw_chars, 80, '工具轮进 raw_chars');
    assert.equal(tool?.effective_chars, 0, '工具轮不进 effective_chars');
    assert.equal(tool?.status, 'open', '工具字不算有效对话字数 → 不触发上限');

    // 再来 80 字工具轮：raw 160，有效对话仍是 0。
    h.feed('exp-2', 'dsh', atMinutes(1), {
      char_count: 80,
      outcome: { status: 'success' },
    });
    const after = h.log.readAll()[0];
    assert.equal(after?.raw_chars, 160);
    assert.equal(after?.effective_chars, 0);
    assert.equal(after?.status, 'open', '200 字工具载荷仍未达有效对话上限');
  } finally {
    h.cleanup();
  }
});

test('A4′ · 优先级矩阵：两个上限同时命中 → 写 max-chars（只写一个原因）', () => {
  const h = makeHarness({
    params: { maxEffectiveCharsPerEvent: 100, fuseRawChars: 100 },
  });
  try {
    // 一条 100 字非工具轮：有效对话 100 ≥ 100，raw 100 ≥ 100 —— 两个同时命中。
    h.feed('exp-1', 'dsh', atMinutes(0), { char_count: 100 });
    const event = h.log.readAll()[0];
    assert.equal(event?.status, 'closed');
    assert.equal(
      event?.closed_reason,
      'max-chars',
      '两个上限同时命中时写优先级更高者（硬保险丝 > 有效对话字数）',
    );
    assert.equal(event?.pointers.length, 1, '一次只写一个原因、闭合含触发的那一条');
  } finally {
    h.cleanup();
  }
});

test('A4′ · 优先级矩阵：静默与有效对话字数上限同时成立 → 写静默（静默优先）', () => {
  const h = makeHarness({ params: { maxEffectiveCharsPerEvent: 100 } });
  try {
    h.feed('exp-1', 'dsh', atMinutes(0), { char_count: 60 });
    // 间隔 31 分钟（≥30）且累计 120 ≥ 100 —— 静默与上限同时成立。
    h.feed('exp-2', 'dsh', atMinutes(31), { char_count: 60 });
    const events = h.log.readAll();
    assert.equal(events.length, 2, '静默先命中 → 旧事件闭合、新事件另开');
    assert.equal(events[0]?.closed_reason, 'silence', '静默优先于有效对话字数上限');
    assert.equal(events[0]?.effective_chars, 60, '静默闭合的那段只含触发前的记录');
  } finally {
    h.cleanup();
  }
});

test('A4′ · 优先级矩阵：通道切换与上限同时成立 → 写 channel-switch', () => {
  const h = makeHarness({ params: { maxEffectiveCharsPerEvent: 100 } });
  try {
    h.feed('exp-1', 'dsh', atMinutes(0), { char_count: 60 });
    // 换通道 → 场景切换优先；同时该通道的累计也已达上限。
    h.feed('exp-2', 'browser', atMinutes(1), { char_count: 60 });
    const events = h.log.readAll();
    assert.equal(events.length, 2);
    assert.equal(events[0]?.closed_reason, 'channel-switch', '场景切换优先于字数上限');
  } finally {
    h.cleanup();
  }
});

test('A3 · charsToTokens 是恒等纯函数，常量只在 params.ts 单点存在', () => {
  assert.equal(charsToTokens(0), 0);
  assert.equal(charsToTokens(1), 1);
  assert.equal(charsToTokens(50_000), 50_000, '1 raw 字符 ≈ 1 token（恒等换算）');
  assert.equal(charsToTokens(-1), -1, '纯函数：不校验、不改写、无副作用');
});

// ── A2′ · 升级在途 open 事件迁移（定案稿 §7.4 / C4）─────────────────────

test('A2′ · 升级在途 open 事件（两字段 null）→ restore 后按 0 起算、只计新记录', () => {
  const h = makeHarness();
  try {
    // 造一个「v1.3 时代写入的」open 事件：两个计数器字段为 null。
    const legacy = {
      id: '01J0000000000000000000000Z',
      schema_version: EVENT_SCHEMA_VERSION,
      version: 1,
      status: 'open' as const,
      closed_reason: null,
      pointers: [{ id: 'exp-legacy', channel: 'dsh', shard: '2026-11', seq: 0 }],
      time_range: { started_at: atMinutes(0), ended_at: atMinutes(0) },
      assembled_at: atMinutes(0),
      summary: null,
      key_points: [],
      anchors: [],
      topic_lines: [],
      summary_quality: 'pending' as const,
      summary_source: null,
      summary_prompt_version: null,
      summary_model: null,
      created_by: 'system' as const,
      created_at: atMinutes(0),
      channel: 'dsh',
      boundary_candidates: [],
      effective_chars: null,
      raw_chars: null,
    };
    h.log.appendVersion(legacy);

    // 重启：restore 从事件真源重建 open 状态。
    h.segmenter.restore();
    const restored = h.log.currentOf(legacy.id);
    assert.equal(restored.effective_chars, null, '真源里的 null 不被改写（不回填历史）');

    // 新记录并入 → 计数器从 0 起算，只计这条新记录。
    h.segmenter.run(makeCtx('exp-new', 'dsh', atMinutes(1), 1, { char_count: 42 }));
    const after = h.log.currentOf(legacy.id);
    assert.equal(after.effective_chars, 42, 'null 视为 0，只累计切换后的新记录');
    assert.equal(after.raw_chars, 42);
    assert.equal(after.pointers.length, 2, '新记录并入同一个事件');
  } finally {
    h.cleanup();
  }
});

test('A2′ · 在线路径不回算历史 char_count（不读原文补数、不写回历史）', () => {
  const h = makeHarness();
  try {
    // 一条没有 char_count 的历史记录（旧数据）→ 计数跳过，不猜不编。
    h.feed('exp-1', 'dsh', atMinutes(0), { char_count: null });
    const event = h.log.readAll()[0];
    // 该段从未有过带计数的记录 → 语义是「未统计」→ 写 null（不是「零字」）。
    assert.equal(event?.effective_chars, null, 'char_count 为 null → 该条跳过，不猜值');
    assert.equal(event?.raw_chars, null);

    // 后续新记录照常累计（有 char_count → 计数器转为数字）。
    h.feed('exp-2', 'dsh', atMinutes(1), { char_count: 10 });
    const after = h.log.currentOf(event?.id ?? '');
    assert.equal(after.effective_chars, 10, '只累计有 char_count 的记录');
    assert.equal(after.raw_chars, 10);
  } finally {
    h.cleanup();
  }
});

// ── 任务作用域（定案稿 §5.0.3 · 任务书 C5 · A5 / A5b / A5c）──────────────
// 信号保持 dormant：判据落地、用例验证通过后，经显式口径变更才转 active。

test('A5 · 在途 callId 未齐 → 不闭合（两个调用只回一个不算完）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0), {
      action: { type: 'tool-call', tool: 'browser', call_id: 'call-1' },
    });
    h.feed('exp-2', 'dsh', atMinutes(1), {
      action: { type: 'tool-call', tool: 'browser', call_id: 'call-2' },
    });
    // 只回 call-1 → call-2 仍在途。
    h.feed('exp-3', 'dsh', atMinutes(2), {
      outcome: { status: 'success', call_id: 'call-1' },
    });
    // 交付轮：在途未清空 → 不闭合。
    h.feed('exp-4', 'dsh', atMinutes(3), { initiation: 'her' });

    assert.equal(h.log.readAll()[0]?.status, 'open', '还有在途调用 → 不闭合');
  } finally {
    h.cleanup();
  }
});

test('A5 · 末个 outcome 到达且交付轮出现 → 闭合（reason=task-closure）', () => {
  // 显式开启任务闭环信号（定案稿 §5.2 dormant → active 门控）：
  // A5 验的是作用域判据的**正向**行为，须先让信号生效。
  const h = makeHarness({ params: { taskClosureActive: true } });
  try {
    h.feed('exp-1', 'dsh', atMinutes(0), {
      action: { type: 'tool-call', tool: 'browser', call_id: 'call-1' },
    });
    h.feed('exp-2', 'dsh', atMinutes(1), {
      action: { type: 'tool-call', tool: 'browser', call_id: 'call-2' },
    });
    h.feed('exp-3', 'dsh', atMinutes(2), {
      outcome: { status: 'success', call_id: 'call-1' },
    });
    h.feed('exp-4', 'dsh', atMinutes(3), {
      outcome: { status: 'success', call_id: 'call-2' },
    });
    // 两个都在途集合外了，但末条是工具结果 → 仍不是交付轮。
    assert.equal(h.log.readAll()[0]?.status, 'open', '结果轮不是交付轮 → 不闭合');

    h.feed('exp-5', 'dsh', atMinutes(4), { initiation: 'her' });
    const event = h.log.readAll()[0];
    assert.equal(event?.status, 'closed', '交付轮出现 → 作用域闭合');
    assert.equal(event?.closed_reason, 'task-closure');
    assert.equal(event?.pointers.length, 5);
  } finally {
    h.cleanup();
  }
});

test('A5 · 重启重放后在途集合与 toolCallSeen 与重启前一致', () => {
  // 显式开启任务闭环信号（定案稿 §5.2 dormant → active 门控）。
  const h = makeHarness({ params: { taskClosureActive: true } });
  try {
    h.feed('exp-1', 'dsh', atMinutes(0), {
      action: { type: 'tool-call', tool: 'browser', call_id: 'call-1' },
    });
    h.feed('exp-2', 'dsh', atMinutes(1), {
      action: { type: 'tool-call', tool: 'browser', call_id: 'call-2' },
    });
    h.feed('exp-3', 'dsh', atMinutes(2), {
      outcome: { status: 'success', call_id: 'call-1' },
    });

    // 重启：restore 从事件真源重放记录、重建作用域状态。
    h.segmenter.restore();

    // 重放后：再投末个结果 + 交付轮 → 仍应闭合（说明 call-1 已离场、call-2 仍在途）。
    h.segmenter.run(
      makeCtx('exp-4', 'dsh', atMinutes(3), 3, {
        outcome: { status: 'success', call_id: 'call-2' },
      }),
    );
    assert.equal(h.log.readAll()[0]?.status, 'open', 'call-2 仍在途 → 不闭合');

    h.segmenter.run(makeCtx('exp-5', 'dsh', atMinutes(4), 4, { initiation: 'her' }));
    const event = h.log.readAll()[0];
    assert.equal(event?.status, 'closed', '重放重建的 inFlightCallIds 正确 → 交付后闭合');
    assert.equal(event?.closed_reason, 'task-closure');
  } finally {
    h.cleanup();
  }
});

test('A5b · 纯对话反向：连续 50 轮无 tool-call → 恒不产生 task-closure', () => {
  const h = makeHarness();
  try {
    for (let index = 0; index < 50; index += 1) {
      h.feed(`exp-${index}`, 'dsh', atMinutes(index));
    }
    const events = h.log.readAll();
    assert.equal(events.length, 1, '50 轮纯对话在同一个事件里');
    assert.equal(events[0]?.status, 'open', '纯对话不触发任务闭环');
    assert.equal(events[0]?.closed_reason, null);
    assert.equal(
      events.filter((event) => event.closed_reason === 'task-closure').length,
      0,
      '纯对话从不产生 task-closure',
    );
  } finally {
    h.cleanup();
  }
});

test('A5c · 工具作用域闭合后紧接 50 轮纯对话 → toolCallSeen 已清零、恒不触发', () => {
  // 显式开启任务闭环信号（定案稿 §5.2 dormant → active 门控）。
  const h = makeHarness({ params: { taskClosureActive: true } });
  try {
    // 先完成一次工具作用域（调用步 → 结果 → 交付轮）→ 事件闭合。
    h.feed('exp-0', 'dsh', atMinutes(0), {
      action: { type: 'tool-call', tool: 'browser', call_id: 'call-1' },
    });
    h.feed('exp-1', 'dsh', atMinutes(1), {
      outcome: { status: 'success', call_id: 'call-1' },
    });
    h.feed('exp-2', 'dsh', atMinutes(2), { initiation: 'her' });
    assert.equal(h.log.readAll()[0]?.closed_reason, 'task-closure', '第一个作用域闭合');

    // 紧接 50 轮纯对话 → 新事件里 toolCallSeen 必须已清零。
    for (let index = 0; index < 50; index += 1) {
      h.feed(`exp-pure-${index}`, 'dsh', atMinutes(3 + index));
    }
    const events = h.log.readAll();
    assert.equal(events.length, 2, '纯对话另开一个事件');
    assert.equal(events[1]?.status, 'open', '新作用域不触发任务闭环');
    assert.equal(
      events.filter((event) => event.closed_reason === 'task-closure').length,
      1,
      '只有第一个作用域是 task-closure（toolCallSeen 随作用域清零）',
    );
  } finally {
    h.cleanup();
  }
});
