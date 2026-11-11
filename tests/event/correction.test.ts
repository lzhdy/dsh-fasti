/**
 * 事件修正测试（技术基线 §7.3 · 任务卡 T10 / T11 / T12）。
 *
 * 覆盖：
 *  - T10 五种操作（合并 / 拆分 / 改边界 / 重开 / 重写摘要）+ 退役态留痕（不删行）；
 *  - T11 派生字段重跑五条规则逐条；
 *  - T12 上层接力（合并唯一目标 / 拆分四种情形）。
 *
 * 全部用临时目录（makeTempRoot），绝不触碰真实数据目录。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ConflictError, NotFoundError, SchemaError } from '../../src/core/errors.ts';
import { EVENT_FIELDS, EVENT_SCHEMA_VERSION, EventOpenConflictError } from '../../src/contract/event.ts';
import type { EventPointer, EventRecord } from '../../src/contract/event.ts';
import type { Experience } from '../../src/contract/experience.ts';
import { EventCorrector, resolveMemoryPointer } from '../../src/event/correction.ts';
import type { CorrectionRerunner } from '../../src/event/correction.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { cleanupTempRoot, countLines, makeTempRoot } from '../helpers.ts';

/** 固定基准时刻（世界轴）。 */
const BASE_MS = Date.parse('2026-11-08T10:00:00.000Z');
/** 修正动作发生的时刻（固定，保证可重放）。 */
const FIXED_NOW_MS = Date.parse('2026-11-09T09:00:00.000Z');

/** 相对基准偏移若干分钟后的 ISO 串。 */
function at(minutes: number): string {
  return new Date(BASE_MS + minutes * 60_000).toISOString();
}

/** 构造一条指针（id 权威，channel 冗余）。 */
function pointer(id: string): EventPointer {
  return { id, channel: 'dsh' };
}

/** 构造一条经历（时间轴来源）。 */
function makeExperience(id: string, occurredAt: string): Experience {
  return {
    id,
    schema_version: 1,
    kind: 'dialogue',
    scene: { channel: 'dsh', ref: 'session-1' },
    initiation: 'user',
    observation: { cue: `记录 ${id}` },
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    tick: 0,
    char_count: null,
  };
}

/** 构造一条事件记录（版本 1）。 */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const base: EventRecord = {
    id: 'evt-a',
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'closed',
    closed_reason: 'silence',
    pointers: [pointer('r1')],
    time_range: { started_at: at(0), ended_at: at(10) },
    assembled_at: at(10),
    summary: '旧的客观摘要',
    key_points: ['旧关键点'],
    anchors: ['旧锚点'],
    topic_lines: [],
    summary_quality: 'ready',
    summary_source: 'llm',
    // 非空才有意义：作废摘要时必须**清空**它们（否则用例恒绿、查不出漏清）。
    summary_prompt_version: 'v1',
    summary_model: 'dsh-default',
    created_by: 'system',
    created_at: at(10),
    channel: 'dsh',
    boundary_candidates: [],
    effective_chars: null,
    raw_chars: null,
  };
  return { ...base, ...overrides };
}

/** 修正测试台：临时目录 + 事件真源 + 修正器（固定时钟 + 假重跑器）。 */
interface Harness {
  readonly root: string;
  readonly log: EventLog;
  readonly corrector: EventCorrector;
  /** 收到重跑请求的事件 id（按到达顺序）。 */
  readonly reruns: string[];
  /** 记录时刻表（readExperience 的数据源）。 */
  readonly texts: Map<string, Experience>;
  /** 往真源里放一条事件。 */
  seed(overrides: Partial<EventRecord>): EventRecord;
  cleanup(): void;
}

function makeHarness(): Harness {
  const root = makeTempRoot('fasti-correction-');
  const log = new EventLog(layoutOf(root).events);
  const texts = new Map<string, Experience>();
  const reruns: string[] = [];

  const rerunner: CorrectionRerunner = {
    requestRerun: (eventId) => {
      reruns.push(eventId);
    },
  };

  const corrector = new EventCorrector({
    log,
    readExperience: (id) => texts.get(id),
    // 归属判定直接用真源层的实现 —— 测试要证的是「这道闸真的接上了」，
    // 换成假 map 就只能证「假 map 会拒绝」，那不是这个用例的目的。
    ownerOf: (id) => log.ownerOf(id),
    rerunner,
    now: () => FIXED_NOW_MS,
  });

  return {
    root,
    log,
    corrector,
    reruns,
    texts,
    seed: (overrides) => {
      const record = makeEvent(overrides);
      // 记录时刻表默认覆盖指针里的每条记录（可被调用方覆盖）。
      for (const p of record.pointers) {
        if (!texts.has(p.id)) {
          texts.set(p.id, makeExperience(p.id, record.time_range.started_at));
        }
      }
      return log.appendVersion(record).record;
    },
    cleanup: () => cleanupTempRoot(root),
  };
}

/** 事件真源里当前分片的行数（append-only 的直接证据）。 */
function rowCount(h: Harness): number {
  return countLines(h.log.shardFile('2026-11'));
}

/** 真源分片里的原始行（按落盘顺序）—— 用于断言「谁先落盘」。 */
function rawRows(h: Harness): EventRecord[] {
  return fs
    .readFileSync(h.log.shardFile('2026-11'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as EventRecord);
}

/**
 * 字段继承断言 —— 除本次操作**显式变更**的字段外，其余字段必须原样带过。
 *
 * 逐字段比对 EVENT_FIELDS 全集：将来契约层新增字段时，这条用例会当场变红
 * → 漏带字段不会被默默放过。
 */
function assertInheritedExcept(
  before: EventRecord,
  after: EventRecord,
  changed: readonly string[],
): void {
  const old = before as unknown as Record<string, unknown>;
  const now = after as unknown as Record<string, unknown>;
  for (const field of EVENT_FIELDS) {
    if (changed.includes(field)) {
      continue;
    }
    assert.deepEqual(now[field], old[field], `字段 ${field} 必须原样带过`);
  }
}

// ── T10 · 五种修正 ────────────────────────────────────────────────────────

test('T10 合并：A + B → 新事件 C；A、B 置 merged 且带 merged_into=C；旧事件不删', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')], time_range: { started_at: at(0), ended_at: at(10) } });
    h.seed({ id: 'evt-b', pointers: [pointer('r2')], time_range: { started_at: at(20), ended_at: at(30) } });

    const before = rowCount(h);
    const result = h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });

    // C：并集指针 + 并集时间区间 + closed + 新事件 version=1
    assert.equal(result.target.status, 'closed');
    assert.equal(result.target.version, 1);
    assert.deepEqual(result.target.pointers.map((p) => p.id), ['r1', 'r2']);
    assert.equal(result.target.time_range.started_at, at(0));
    assert.equal(result.target.time_range.ended_at, at(30));
    assert.equal(result.target.created_by, 'her', '修正只由她发起');

    // A、B：退役态带退役指针，各推进一个版本
    const a = h.log.currentOf('evt-a');
    const b = h.log.currentOf('evt-b');
    assert.equal(a.status, 'merged');
    assert.equal(a.merged_into, result.target.id);
    assert.equal(b.status, 'merged');
    assert.equal(b.merged_into, result.target.id);
    assert.equal(a.version, 2);
    assert.equal(b.version, 2);

    // 旧事件不删：退役前行仍在版本历史里，真源只增行
    assert.equal(h.log.versionsOf('evt-a').length, 2);
    assert.equal(h.log.versionsOf('evt-a')[0]?.status, 'closed');
    assert.equal(h.log.versionsOf('evt-a')[0]?.summary, '旧的客观摘要');
    // 退役行是同一个事件的新版本：内容不丢，只改状态与退役指针
    assert.equal(a.summary, '旧的客观摘要');
    assert.deepEqual(a.anchors, ['旧锚点']);
    assert.deepEqual(a.pointers.map((p) => p.id), ['r1']);
    assert.equal(rowCount(h), before + 3, '真源只追加行，不删行');
    assert.equal(h.log.readAll().length, 3, 'A、B、C 三个当前态');
  } finally {
    h.cleanup();
  }
});

test('T10 合并 · 落盘顺序：先建目标 C 再落退役行 —— 退役指针不前向引用', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')] });
    h.seed({ id: 'evt-b', pointers: [pointer('r2')] });

    const merged = h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });

    // 合并完立刻读 A → 顺 merged_into 追下去，必须追得到真实存在的 C（不得抛 NotFoundError）
    const retired = h.log.currentOf('evt-a');
    const mergedInto = retired.merged_into;
    assert.ok(mergedInto !== undefined, '退役行必须带 merged_into');
    const target = h.log.currentOf(mergedInto);
    assert.equal(target.id, merged.target.id);
    assert.equal(target.status, 'closed');
    assert.equal(target.version, 1);

    // 落盘顺序：C 的那一行必须排在 A 的退役行之前（顺序不可颠倒）
    const rows = rawRows(h);
    const cIndex = rows.findIndex((row) => row.id === merged.target.id);
    const aIndex = rows.findIndex((row) => row.id === 'evt-a' && row.version === 2);
    assert.ok(cIndex >= 0 && aIndex >= 0, '两行都必须已落盘');
    assert.ok(cIndex < aIndex, '目标 C 必须先于退役行落盘');
  } finally {
    h.cleanup();
  }
});

test('T10 拆分 · 落盘顺序：先建子事件再落退役行 —— 退役指针不前向引用', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });
    const split = h.corrector.split({ sourceId: 'evt-a', groups: [['r1'], ['r2']] });

    // 拆分完立刻读 A → 顺 split_into 追下去，两个子事件都必须已存在
    const retired = h.log.currentOf('evt-a');
    const childIds = retired.split_into;
    assert.ok(childIds !== undefined && childIds.length === 2, '退役行必须带两个 split_into');
    for (const childId of childIds) {
      const child = h.log.currentOf(childId);
      assert.equal(child.status, 'closed');
      assert.equal(child.version, 1);
    }

    // 落盘顺序：两个子事件都必须排在 A 的退役行之前
    const rows = rawRows(h);
    const aIndex = rows.findIndex((row) => row.id === 'evt-a' && row.version === 2);
    for (const child of split.children) {
      const childIndex = rows.findIndex((row) => row.id === child.id);
      assert.ok(childIndex >= 0 && aIndex >= 0, '两行都必须已落盘');
      assert.ok(childIndex < aIndex, '子事件必须先于退役行落盘');
    }
  } finally {
    h.cleanup();
  }
});

test('T10 退役口径：退役事件 pointers 原样保留；目标事件 pointers 取并集去重', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });
    h.seed({ id: 'evt-b', pointers: [pointer('r2'), pointer('r3')] });

    const merged = h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });

    // 退役事件的 pointers 一字不动 —— 退役态的意义是「这段事曾经是这样」，清掉等于毁证
    assert.deepEqual(h.log.currentOf('evt-a').pointers.map((p) => p.id), ['r1', 'r2']);
    assert.deepEqual(h.log.currentOf('evt-b').pointers.map((p) => p.id), ['r2', 'r3']);

    // 目标事件的 pointers 取并集去重（指向记录本条目，不是事件）
    assert.deepEqual(merged.target.pointers.map((p) => p.id), ['r1', 'r2', 'r3']);
    for (const pointer of merged.target.pointers) {
      assert.ok(!pointer.id.startsWith('evt-'), '目标事件的 pointers 指向记录本条目，不是事件');
    }
  } finally {
    h.cleanup();
  }
});

test('T10 字段继承：版本推进时除显式变更的字段外，全部字段原样带过（含 closed_reason）', () => {
  const h = makeHarness();
  try {
    const rich = {
      id: 'evt-a',
      pointers: [pointer('r1'), pointer('r2')],
      closed_reason: 'silence' as const,
      status: 'closed' as const,
      assembled_at: at(10),
      channel: 'dsh',
      boundary_candidates: [{ kind: '话题跳转', at_pointer_id: 'r2', marked_at: at(5) }],
      key_points: ['关键点'],
      anchors: ['锚点'],
      topic_lines: [],
      summary: '旧摘要',
      summary_source: 'llm' as const,
      summary_quality: 'ready' as const,
    };
    h.seed(rich);
    const before = h.log.currentOf('evt-a');

    // 改边界：只改 pointers / time_range / 派生字段 / 版本与落款，其余带过
    const revised = h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: ['r2'] }).event;
    assertInheritedExcept(before, revised, [
      'version',
      'pointers',
      'time_range',
      'summary',
      'summary_quality',
      'summary_source',
      'summary_prompt_version',
      'summary_model',
      'key_points',
      'created_by',
      'created_at',
    ]);
    assert.equal(revised.closed_reason, 'silence', '闭合原因必须原样带过（不得丢）');

    // 重开：只改 status / closed_reason / 版本与落款
    const reopened = h.corrector.reopen({ eventId: 'evt-a' });
    assertInheritedExcept(revised, reopened, [
      'version',
      'status',
      'closed_reason',
      'created_by',
      'created_at',
    ]);
    assert.equal(reopened.closed_reason, null, '重开是明确退回 open → 闭合原因置 null');

    // 重写摘要：只改摘要三项 / 版本与落款
    const rewritten = h.corrector.rewriteSummary({ eventId: 'evt-a', summary: '她写的摘要' });
    assertInheritedExcept(reopened, rewritten, [
      'version',
      'summary',
      'summary_quality',
      'summary_source',
      'summary_prompt_version',
      'summary_model',
      'created_by',
      'created_at',
    ]);
  } finally {
    h.cleanup();
  }
});

test('T10 字段继承：退役行同样只改状态与退役指针，其余带过', () => {
  const h = makeHarness();
  try {
    h.seed({
      id: 'evt-a',
      pointers: [pointer('r1')],
      closed_reason: 'silence',
      boundary_candidates: [{ kind: '话题跳转', at_pointer_id: 'r1', marked_at: at(5) }],
      key_points: ['关键点'],
      anchors: ['锚点'],
      summary: '旧摘要',
    });
    const before = h.log.currentOf('evt-a');

    h.seed({ id: 'evt-b', pointers: [pointer('r2')] });
    const merged = h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });

    const retired = merged.retired[0];
    assert.ok(retired !== undefined, '退役事件必须存在');
    assertInheritedExcept(before, retired, [
      'version',
      'status',
      'merged_into',
      'split_into',
      'created_by',
      'created_at',
    ]);
    assert.equal(retired.closed_reason, 'silence', '退役不改变「它当初怎么闭合的」这个事实');
    assert.deepEqual(retired.boundary_candidates, before.boundary_candidates);
  } finally {
    h.cleanup();
  }
});

test('T10 合并：来源必须是当前态且非退役态', () => {  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')] });
    h.seed({ id: 'evt-b', pointers: [pointer('r2')] });

    assert.throws(() => h.corrector.merge({ sourceIds: ['evt-a'] }), SchemaError, '合并至少两个来源');
    assert.throws(() => h.corrector.merge({ sourceIds: ['evt-a', 'evt-a'] }), SchemaError, '来源不得重复');
    assert.throws(() => h.corrector.merge({ sourceIds: ['evt-a', 'evt-zzz'] }), NotFoundError, '来源必须存在');

    h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });
    assert.throws(
      () => h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] }),
      ConflictError,
      '退役态不可再被修正',
    );
  } finally {
    h.cleanup();
  }
});

test('T10 拆分：A → B1 + B2；A 置 split 且带 split_into；子事件指针与时间范围按组重算', () => {
  const h = makeHarness();
  try {
    h.seed({
      id: 'evt-a',
      pointers: [pointer('r1'), pointer('r2')],
      time_range: { started_at: at(0), ended_at: at(30) },
    });
    h.texts.set('r1', makeExperience('r1', at(0)));
    h.texts.set('r2', makeExperience('r2', at(30)));

    const before = rowCount(h);
    const result = h.corrector.split({ sourceId: 'evt-a', groups: [['r1'], ['r2']] });

    assert.equal(result.retired.status, 'split');
    assert.deepEqual(result.retired.split_into, result.children.map((c) => c.id));
    assert.equal(result.children.length, 2);

    const [b1, b2] = result.children;
    assert.deepEqual(b1?.pointers.map((p) => p.id), ['r1']);
    assert.deepEqual(b2?.pointers.map((p) => p.id), ['r2']);
    assert.equal(b1?.time_range.started_at, at(0));
    assert.equal(b1?.time_range.ended_at, at(0), '单记录事件的时间区间按该记录的时刻');
    assert.equal(b2?.time_range.started_at, at(30));
    assert.equal(b2?.time_range.ended_at, at(30));

    // 旧事件不删
    assert.equal(h.log.versionsOf('evt-a').length, 2);
    assert.equal(h.log.versionsOf('evt-a')[0]?.status, 'closed');
    assert.equal(rowCount(h), before + 3);
  } finally {
    h.cleanup();
  }
});

test('T10 拆分：分组必须覆盖且仅覆盖源事件的指针', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });

    assert.throws(() => h.corrector.split({ sourceId: 'evt-a', groups: [['r1']] }), SchemaError, '少于两组');
    assert.throws(
      () => h.corrector.split({ sourceId: 'evt-a', groups: [['r1'], ['r2', 'r1']] }),
      SchemaError,
      '同一记录不得出现在两组',
    );
    assert.throws(
      () => h.corrector.split({ sourceId: 'evt-a', groups: [['r1'], ['r2', 'r-x']] }),
      SchemaError,
      '不得含源事件之外的记录',
    );
    assert.throws(
      () => h.corrector.split({ sourceId: 'evt-a', groups: [['r1'], []] }),
      SchemaError,
      '空组无意义',
    );
  } finally {
    h.cleanup();
  }
});

test('T10 拆分：指针悬空（记录本里没有这条记录）→ 抛错，不编造时间范围', () => {
  const h = makeHarness();
  try {
    // 事件指针指向 exp-x / exp-y，但记录本里没有它们 —— 悬空指针。
    h.seed({
      id: 'evt-a',
      pointers: [
        { id: 'exp-x', channel: 'dsh' },
        { id: 'exp-y', channel: 'dsh' },
      ],
    });
    // `seed` 默认会为指针里的每条记录补一条时刻（方便其他用例）——
    // 本用例要的恰是「取不到时刻」，故把这两条从记录表里摘掉，让夹具与用例名一致。
    h.texts.delete('exp-x');
    h.texts.delete('exp-y');

    assert.throws(
      () => h.corrector.split({ sourceId: 'evt-a', groups: [['exp-x'], ['exp-y']] }),
      NotFoundError,
      '取不到记录时刻就不给时间范围（不静默降级、不编造）',
    );
    // 失败不得留下半截写入：源事件仍是原样
    assert.equal(h.log.currentOf('evt-a').status, 'closed');
    assert.equal(h.log.versionsOf('evt-a').length, 1);
  } finally {
    h.cleanup();
  }
});

test('T10 改边界：换 pointers → 同一 id 写新版本，时间范围重算', () => {
  const h = makeHarness();
  try {
    h.seed({
      id: 'evt-a',
      pointers: [pointer('r1'), pointer('r2')],
      time_range: { started_at: at(0), ended_at: at(30) },
    });
    h.texts.set('r1', makeExperience('r1', at(0)));
    h.texts.set('r2', makeExperience('r2', at(30)));

    const before = rowCount(h);
    const result = h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: ['r2'] });

    assert.equal(result.event.id, 'evt-a');
    assert.equal(result.event.version, 2, '同一 id 推进版本');
    assert.deepEqual(result.event.pointers.map((p) => p.id), ['r1']);
    assert.equal(result.event.time_range.started_at, at(0));
    assert.equal(result.event.time_range.ended_at, at(0), '时间范围按新指针重算');

    // 旧版本完整留在历史里（可回退）
    assert.equal(h.log.versionsOf('evt-a').length, 2);
    assert.equal(h.log.versionsOf('evt-a')[0]?.summary, '旧的客观摘要');
    assert.equal(rowCount(h), before + 1);
  } finally {
    h.cleanup();
  }
});

test('T10 改边界：移入的记录必须存在于记录本（缺指针一律抛错）', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')] });
    assert.throws(
      () => h.corrector.reviseBoundary({ eventId: 'evt-a', addPointerIds: ['r-x'] }),
      NotFoundError,
      '移入的记录不存在 → 抛错，不静默降级',
    );
  } finally {
    h.cleanup();
  }
});

test('T10 重开：closed → open 写新版本；摘要仍覆盖原指针，不触发重跑', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', status: 'closed', closed_reason: 'silence' });

    const result = h.corrector.reopen({ eventId: 'evt-a' });

    assert.equal(result.status, 'open');
    assert.equal(result.version, 2);
    assert.equal(result.closed_reason, null, 'open 事件没有机械闭合原因');
    assert.equal(result.summary, '旧的客观摘要', '重开不重跑 → 摘要仍覆盖原指针');
    assert.deepEqual(h.reruns, [], '重开不触发派生字段重跑');
    assert.equal(h.log.versionsOf('evt-a')[0]?.status, 'closed', '旧版本留痕');
  } finally {
    h.cleanup();
  }
});

test('T10 重开：只对 closed 事件有效', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', status: 'open', closed_reason: null });
    assert.throws(() => h.corrector.reopen({ eventId: 'evt-a' }), ConflictError);
    assert.throws(() => h.corrector.reopen({ eventId: 'evt-zzz' }), NotFoundError);
  } finally {
    h.cleanup();
  }
});

test('T10 重写摘要：她手写摘要 → 新版本、summary_source=her；旧摘要留版本', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a' });

    const result = h.corrector.rewriteSummary({ eventId: 'evt-a', summary: '她亲手写的摘要' });

    assert.equal(result.summary, '她亲手写的摘要');
    assert.equal(result.summary_source, 'her');
    assert.equal(result.summary_quality, 'ready');
    assert.equal(result.version, 2);
    assert.equal(h.log.versionsOf('evt-a')[0]?.summary, '旧的客观摘要', '旧摘要留版本，可回退');
    assert.deepEqual(h.reruns, [], '重写摘要不触发重跑');
  } finally {
    h.cleanup();
  }
});

test('T10 重写摘要：超长摘要被契约层拒收（不截断、不落盘）', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a' });
    const before = rowCount(h);
    assert.throws(() => h.corrector.rewriteSummary({ eventId: 'evt-a', summary: '事'.repeat(601) }), SchemaError);
    assert.equal(rowCount(h), before, '被拒的摘要不落盘');
  } finally {
    h.cleanup();
  }
});

// ── T11 · 派生字段重跑（五条规则逐条） ─────────────────────────────────────

test('T11 规则 1 · 派生字段必须重跑：换了指针不得留旧摘要', () => {
  const h = makeHarness();
  try {
    h.seed({
      id: 'evt-a',
      pointers: [pointer('r1'), pointer('r2')],
      summary: '按旧边界写的摘要',
      summary_source: 'llm',
      summary_quality: 'ready',
    });

    const result = h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: ['r2'] });

    assert.equal(result.event.summary, null, '旧摘要不得跟着新指针一起留着');
    assert.equal(result.event.summary_quality, 'pending');
    assert.equal(result.event.summary_source, null);
    assert.deepEqual(h.reruns, ['evt-a'], '重跑已触发');
  } finally {
    h.cleanup();
  }
});

test('T11 规则 2 · 她手写的摘要不被重跑覆盖（保留 + 标待更新）', () => {
  const h = makeHarness();
  try {
    h.seed({
      id: 'evt-a',
      pointers: [pointer('r1'), pointer('r2')],
      summary: '她写的摘要',
      summary_source: 'her',
      summary_quality: 'ready',
    });

    const result = h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: ['r2'] });

    assert.equal(result.event.summary, '她写的摘要', '她的摘要原样保留');
    assert.equal(result.event.summary_source, 'her');
    assert.equal(result.event.summary_quality, 'pending');
    // 「摘要待更新（基于旧边界）」的派生口径：source='her' 且 quality='pending'
    assert.equal(result.event.summary_source === 'her' && result.event.summary_quality === 'pending', true);
    assert.deepEqual(h.reruns, ['evt-a'], '锚点/话题线仍要重跑');

    // 闭环自证：闭合管线的「她手写摘要不覆盖」路径跑完后，她的摘要仍在。
    const current = h.log.currentOf('evt-a');
    h.log.appendVersion({
      ...current,
      version: current.version + 1,
      anchors: ['新锚点'],
      summary_quality: 'pending',
      summary_source: 'her',
      created_at: at(200),
    });
    const after = h.log.currentOf('evt-a');
    assert.equal(after.summary, '她写的摘要', '重跑跑完也不能覆盖她的摘要');
    assert.equal(after.summary_source, 'her');
    assert.deepEqual(after.anchors, ['新锚点'], '锚点被重跑更新');
  } finally {
    h.cleanup();
  }
});

test('T11 规则 3 · 重跑走完整闭合管线：重跑期间 quality=pending，新摘要写进新版本', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });

    const pending = h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: ['r2'] });
    assert.equal(pending.event.summary_quality, 'pending', '重跑期间 pending');

    // 假想的闭合管线：重跑完成后写一个新版本（摘要 + 锚点都是新的）
    const current = h.log.currentOf('evt-a');
    h.log.appendVersion({
      ...current,
      version: current.version + 1,
      summary: '按新边界重生成的摘要',
      summary_quality: 'ready',
      summary_source: 'llm',
      created_at: at(200),
    });

    const after = h.log.currentOf('evt-a');
    assert.equal(after.summary, '按新边界重生成的摘要');
    assert.equal(after.summary_quality, 'ready');
    assert.equal(h.log.versionsOf('evt-a').length, 3, '每次推进都留一版');
  } finally {
    h.cleanup();
  }
});

test('T11 规则 4 · 新旧内容同时保留：旧版本的摘要/锚点完整留在版本历史里', () => {
  const h = makeHarness();
  try {
    h.seed({
      id: 'evt-a',
      pointers: [pointer('r1'), pointer('r2')],
      summary: '旧摘要',
      anchors: ['旧锚点'],
      key_points: ['旧关键点'],
    });

    h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: ['r2'] });

    const [v1, v2] = h.log.versionsOf('evt-a');
    assert.equal(v1?.summary, '旧摘要');
    assert.deepEqual(v1?.anchors, ['旧锚点']);
    assert.deepEqual(v1?.key_points, ['旧关键点']);
    assert.equal(v2?.summary, null, '新版本不冒充旧内容');
    assert.deepEqual(v2?.key_points, [], '按旧边界生成的关键点一并作废');
  } finally {
    h.cleanup();
  }
});

test('T11 规则 5 · 合并/拆分的新事件走完整闭合管线：摘要重新生成，不拼接旧摘要', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')], summary: 'A 的摘要' });
    h.seed({ id: 'evt-b', pointers: [pointer('r2')], summary: 'B 的摘要' });

    const merged = h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });
    assert.equal(merged.target.summary, null, 'C 的摘要不是 A、B 旧摘要的拼接');
    assert.equal(merged.target.summary_quality, 'pending');
    assert.equal(merged.target.summary_source, null);
    assert.deepEqual(merged.target.topic_lines, [], '挂线重新判定，不继承并集');
    assert.deepEqual(h.reruns, [merged.target.id], 'C 走完整闭合管线');

    // 拆分同理：子事件的摘要重新生成，不拼接源事件的旧摘要。
    h.seed({ id: 'evt-c', pointers: [pointer('r3'), pointer('r4')], summary: 'C 的摘要' });
    const split = h.corrector.split({ sourceId: 'evt-c', groups: [['r3'], ['r4']] });
    assert.equal(split.children.length, 2);
    for (const child of split.children) {
      assert.equal(child.summary, null);
      assert.equal(child.summary_quality, 'pending');
    }
  } finally {
    h.cleanup();
  }
});

test('T11 拆分至少两组（新事件走闭合管线）', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });
    const split = h.corrector.split({ sourceId: 'evt-a', groups: [['r1'], ['r2']] });
    assert.deepEqual(h.reruns, split.children.map((c) => c.id), '两个子事件都走完整闭合管线');
    for (const child of split.children) {
      assert.equal(child.summary_quality, 'pending');
      assert.equal(child.summary_source, null);
    }
  } finally {
    h.cleanup();
  }
});

// ── T12 · 上层接力 ────────────────────────────────────────────────────────

test('T12 合并接力：记忆指向已合并的事件 → 顺 merged_into 追到唯一目标', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')] });
    h.seed({ id: 'evt-b', pointers: [pointer('r2')] });
    const merged = h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });

    const before = rowCount(h);
    const resolution = resolveMemoryPointer(h.log, { eventId: 'evt-a' });

    assert.equal(resolution.kind, 'merged');
    assert.equal(resolution.target?.id, merged.target.id);
    assert.match(resolution.note ?? '', /后来被合并的事/, '如实呈现「来自一件后来被合并的事」');
    assert.equal(rowCount(h), before, '解析只读不写：不改写她的上层指针');
  } finally {
    h.cleanup();
  }
});

test('T12 合并接力：merged_into 追到唯一终点（多对一）', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')] });
    h.seed({ id: 'evt-b', pointers: [pointer('r2')] });
    h.seed({ id: 'evt-c', pointers: [pointer('r3')] });

    const first = h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });
    const second = h.corrector.merge({ sourceIds: [first.target.id, 'evt-c'] });

    const resolution = resolveMemoryPointer(h.log, { eventId: 'evt-a' });
    assert.equal(resolution.target?.id, second.target.id, '一路追到唯一终点');
    assert.equal(resolution.candidates.length, 0, '合并是多对一 → 唯一目标');
  } finally {
    h.cleanup();
  }
});

test('T12 拆分接力 · 默认情形：记忆无记录级引用 → 标「已拆分」、两个候选、待她定', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });
    const split = h.corrector.split({ sourceId: 'evt-a', groups: [['r1'], ['r2']] });

    const before = rowCount(h);
    const resolution = resolveMemoryPointer(h.log, { eventId: 'evt-a' });

    assert.equal(resolution.kind, 'split-pending');
    assert.equal(resolution.target, undefined, '不替她猜落点');
    assert.deepEqual(resolution.candidates.map((c) => c.id), split.children.map((c) => c.id));
    assert.equal(resolution.pendingDecision, true, '待她定');
    assert.match(resolution.note ?? '', /已拆分/);
    assert.equal(rowCount(h), before, '解析只读不写');
  } finally {
    h.cleanup();
  }
});

test('T12 拆分接力 · 记录级引用落在 B1 → 解析到 B1', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });
    const split = h.corrector.split({ sourceId: 'evt-a', groups: [['r1'], ['r2']] });

    const resolution = resolveMemoryPointer(h.log, { eventId: 'evt-a', recordIds: ['r1'] });

    assert.equal(resolution.kind, 'split-resolved');
    assert.equal(resolution.target?.id, split.children[0]?.id);
    assert.equal(resolution.pendingDecision, false);
  } finally {
    h.cleanup();
  }
});

test('T12 拆分接力 · 记录级引用落在 B2 → 解析到 B2', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });
    const split = h.corrector.split({ sourceId: 'evt-a', groups: [['r1'], ['r2']] });

    const resolution = resolveMemoryPointer(h.log, { eventId: 'evt-a', recordIds: ['r2'] });

    assert.equal(resolution.kind, 'split-resolved');
    assert.equal(resolution.target?.id, split.children[1]?.id);
  } finally {
    h.cleanup();
  }
});

test('T12 拆分接力 · 引用横跨两者 → 两个都呈现并标注', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });
    const split = h.corrector.split({ sourceId: 'evt-a', groups: [['r1'], ['r2']] });

    const resolution = resolveMemoryPointer(h.log, { eventId: 'evt-a', recordIds: ['r1', 'r2'] });

    assert.equal(resolution.kind, 'split-both');
    assert.equal(resolution.target, undefined);
    assert.deepEqual(resolution.candidates.map((c) => c.id), split.children.map((c) => c.id));
    assert.match(resolution.note ?? '', /后来被拆分的事/);
  } finally {
    h.cleanup();
  }
});

test('T12 未修正的事件：直接解析，不加任何标注', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a' });
    const resolution = resolveMemoryPointer(h.log, { eventId: 'evt-a' });
    assert.equal(resolution.kind, 'direct');
    assert.equal(resolution.target?.id, 'evt-a');
    assert.equal(resolution.note, undefined);
    assert.equal(resolution.pendingDecision, false);
  } finally {
    h.cleanup();
  }
});

// ── Major-2：记录唯一归属（设计稿 v1.1 §7.1.1）──────────────────────────
//
// 复现过的故障：`reviseBoundary` 只判「是否已在本事件内」，不判「是否已属于别的事件」
// → evt-A=[exp-1,exp-2]、evt-B=[exp-2]，同一段原文被两个摘要各覆盖一次，
// 而重建白名单会忠实保留这份污染（事件不可由算法批量重建，修不回来）。

test('Major-2 · 跨事件移入被拒：指出归属事件 id，不自动换主、不留痕', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')] });
    h.seed({ id: 'evt-b', pointers: [pointer('r2')] });

    assert.throws(
      () => h.corrector.reviseBoundary({ eventId: 'evt-a', addPointerIds: ['r2'] }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError, '必须是冲突（不是参数错、不是静默忽略）');
        assert.match(error.message, /evt-b/, '错误信息必须指出归属事件 id');
        assert.match(error.message, /移出/, '并告诉她下一步该怎么做');
        return true;
      },
    );

    // 拒绝必须**不留痕**：没写半截版本、指针没变。
    const after = h.log.currentOf('evt-a');
    assert.equal(after.version, 1, '被拒的修正不得写版本');
    assert.deepEqual(after.pointers.map((p) => p.id), ['r1']);
    // 归属没被换走（不自动换主）。
    assert.equal(h.log.ownerOf('r2'), 'evt-b');
  } finally {
    h.cleanup();
  }
});

test('Major-2 · 唯一归属的正规路径：先在原事件移出，才能移入另一事件', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')] });
    // evt-b 留一条记录：事件不许被移空（rangeOf 的既有约束），
    // 这也正是真实形态 —— 移出某条，不是解散整个事件。
    h.seed({ id: 'evt-b', pointers: [pointer('r2'), pointer('r3')] });

    h.corrector.reviseBoundary({ eventId: 'evt-b', removePointerIds: ['r2'] });
    assert.equal(h.log.ownerOf('r2'), undefined, '移出后不属于任何当前态事件');

    const moved = h.corrector.reviseBoundary({ eventId: 'evt-a', addPointerIds: ['r2'] });
    assert.deepEqual(moved.event.pointers.map((p) => p.id), ['r1', 'r2'], '移入成功');
    assert.equal(h.log.ownerOf('r2'), 'evt-a', '归属随之转到现在的事件');
    assert.equal(h.log.ownerOf('r1'), 'evt-a', '原指针归属不变');
  } finally {
    h.cleanup();
  }
});

test('Major-2 · 移出后回归孤儿候选池：不自动补切、不自动并回', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });
    const removed = h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: ['r2'] }).event;

    assert.deepEqual(removed.pointers.map((p) => p.id), ['r1']);
    assert.equal(h.log.ownerOf('r2'), undefined, '被移出的记录不属于任何事件');
    assert.equal(h.log.readAll().length, 1, '不许自动补切出新事件（补切是切分算法的活）');

    // 也不许「偷偷」在下一轮修正里被并回。
    const again = h.corrector.reviseBoundary({ eventId: 'evt-a', addPointerIds: [] }).event;
    assert.deepEqual(again.pointers.map((p) => p.id), ['r1'], '她没要求就不动');
  } finally {
    h.cleanup();
  }
});

test('Major-2 · 合并的并集去重仍保留（防御：即使归属闸漏了也不会写出重复指针）', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });
    h.seed({ id: 'evt-b', pointers: [pointer('r3')] });

    const merged = h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });
    assert.deepEqual(
      merged.target.pointers.map((p) => p.id),
      ['r1', 'r2', 'r3'],
      '并集且无重复',
    );
    // 退役事件的指针仍留在历史里，但**不算归属**（否则移入永远被拒 = 假冲突）。
    assert.equal(h.log.ownerOf('r1'), merged.target.id, '归属跟到合并目标');
    assert.equal(h.log.currentOf('evt-a').status, 'merged');
  } finally {
    h.cleanup();
  }
});

// ── 溯源两字段：作废时清空（设计稿 v1.1 §3.2）────────────────────────────

test('溯源：改边界 / 她重写摘要 / 新建事件 都清空（或置空）summary_prompt_version 与 summary_model', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')] });
    assert.equal(h.log.currentOf('evt-a').summary_prompt_version, 'v1', '样本基线：模型摘要带版本');

    const revised = h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: ['r2'] }).event;
    assert.equal(revised.summary_prompt_version, null, '摘要作废 → 溯源信息随之消失');
    assert.equal(revised.summary_model, null);

    const rewritten = h.corrector.rewriteSummary({ eventId: 'evt-a', summary: '她写的摘要' });
    assert.equal(rewritten.summary_prompt_version, null, '她写的摘要不是任何提示词的产物');
    assert.equal(rewritten.summary_model, null);

    // 合并出来的新事件：从没生成过摘要 → 两字段为 null（不是 []、不是空串）。
    h.seed({ id: 'evt-b', pointers: [pointer('r3')] });
    const merged = h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });
    assert.equal(merged.target.summary_prompt_version, null);
    assert.equal(merged.target.summary_model, null);
  } finally {
    h.cleanup();
  }
});

// ── #36 重开同通道冲突：带选项的拒绝 + 显式组合原语 ────────────────────────

test('#36 reopen：同通道已有 open 事件 → 抛 EventOpenConflictError（结构化载荷）且零写入', () => {
  const h = makeHarness();
  try {
    h.seed({
      id: 'evt-a',
      status: 'open',
      closed_reason: null,
      pointers: [pointer('r1'), pointer('r2')],
      summary: null,
      summary_quality: 'pending',
      summary_source: null,
      summary_prompt_version: null,
      summary_model: null,
    });
    h.seed({ id: 'evt-b', status: 'closed', closed_reason: 'silence', pointers: [pointer('r3')] });
    const before = rowCount(h);

    assert.throws(
      () => h.corrector.reopen({ eventId: 'evt-b' }),
      (err: unknown) => {
        assert.ok(err instanceof EventOpenConflictError, '专用子类，承载结构化选项');
        assert.ok(err instanceof ConflictError, '错误码路由仍属 CONFLICT（不新增错误码）');
        assert.equal(err.reopenId, 'evt-b');
        assert.equal(err.blocking.eventId, 'evt-a');
        assert.equal(err.blocking.channel, 'dsh');
        assert.equal(err.blocking.pointerCount, 2, '阻塞事件条数来自其指针长度');
        assert.equal(err.blocking.summary, null, '后台摘要未生成 → null（UI 显示「摘要未生成」）');
        assert.equal(err.blocking.summaryReady, false);
        assert.deepEqual([...err.actions], ['close-then-reopen', 'merge']);
        return true;
      },
    );
    assert.equal(rowCount(h), before, '带选项的拒绝不写任何版本（行数不变）');
    assert.equal(h.log.currentOf('evt-a').status, 'open', '系统绝不在重开时自动闭合 A');
    assert.equal(h.log.currentOf('evt-b').status, 'closed', 'B 维持闭合、未被改动');
  } finally {
    h.cleanup();
  }
});

test('#36 reopen：他通道的 open 事件不构成冲突，本通道重开正常、他通道不受影响', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', status: 'open', closed_reason: null, channel: 'browser', pointers: [pointer('r1')] });
    h.seed({ id: 'evt-b', status: 'closed', closed_reason: 'silence', channel: 'dsh', pointers: [pointer('r2')] });

    const reopened = h.corrector.reopen({ eventId: 'evt-b' });
    assert.equal(reopened.status, 'open');
    assert.equal(h.log.currentOf('evt-a').status, 'open', '他通道 A 原样保持 open');
  } finally {
    h.cleanup();
  }
});

test('#36 closeOpen（内部能力）：open → closed/manual/her 并请求重跑；非 open 拒绝', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', status: 'open', closed_reason: null });

    const closed = h.corrector.closeOpen('evt-a');
    assert.equal(closed.status, 'closed');
    assert.equal(closed.closed_reason, 'manual', '人工闭合原因落 manual');
    assert.equal(closed.created_by, 'her', '显式操作落款为她');
    assert.equal(closed.version, 2);
    assert.deepEqual(h.reruns, ['evt-a'], '手动闭合后请求派生字段重跑兜底摘要');

    assert.throws(() => h.corrector.closeOpen('evt-a'), ConflictError, '已闭合不能重复手动闭合');
  } finally {
    h.cleanup();
  }
});

test('#36 closeAndReopen：先手动闭合 A 再重开 B（同通道、两条 her 版本、仅 A 进重跑）', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', status: 'open', closed_reason: null, pointers: [pointer('r1')] });
    h.seed({ id: 'evt-b', status: 'closed', closed_reason: 'silence', pointers: [pointer('r2')] });

    const result = h.corrector.closeAndReopen({ closeId: 'evt-a', reopenId: 'evt-b' });
    assert.equal(result.closed.id, 'evt-a');
    assert.equal(result.closed.status, 'closed');
    assert.equal(result.closed.closed_reason, 'manual');
    assert.equal(result.closed.created_by, 'her');
    assert.equal(result.reopened.id, 'evt-b');
    assert.equal(result.reopened.status, 'open');
    assert.equal(result.reopened.closed_reason, null, '重开退回 open、无机械闭合原因');
    assert.equal(result.reopened.created_by, 'her');
    assert.deepEqual(h.reruns, ['evt-a'], '只有手动闭合的 A 进重跑，重开 B 不重跑');

    const openIds = h.log
      .listByStatus('open')
      .map((e) => e.id)
      .sort();
    assert.deepEqual(openIds, ['evt-b'], '组合完成后该通道唯一进行中的事件是 B');
  } finally {
    h.cleanup();
  }
});

test('#36 closeAndReopen：前提不满足即拒绝且零写入（先全量校验、杜绝半程态）', () => {
  // 同一 id
  {
    const h = makeHarness();
    try {
      h.seed({ id: 'evt-a', status: 'open', closed_reason: null });
      const before = rowCount(h);
      assert.throws(
        () => h.corrector.closeAndReopen({ closeId: 'evt-a', reopenId: 'evt-a' }),
        SchemaError,
      );
      assert.equal(rowCount(h), before);
    } finally {
      h.cleanup();
    }
  }
  // 待闭合的 A 不是 open
  {
    const h = makeHarness();
    try {
      h.seed({ id: 'evt-a', status: 'closed', closed_reason: 'silence' });
      h.seed({ id: 'evt-b', status: 'closed', closed_reason: 'silence', pointers: [pointer('r2')] });
      const before = rowCount(h);
      assert.throws(
        () => h.corrector.closeAndReopen({ closeId: 'evt-a', reopenId: 'evt-b' }),
        ConflictError,
      );
      assert.equal(rowCount(h), before);
    } finally {
      h.cleanup();
    }
  }
  // 待重开的 B 不是 closed
  {
    const h = makeHarness();
    try {
      h.seed({ id: 'evt-a', status: 'open', closed_reason: null });
      h.seed({ id: 'evt-b', status: 'open', closed_reason: null, pointers: [pointer('r2')] });
      const before = rowCount(h);
      assert.throws(
        () => h.corrector.closeAndReopen({ closeId: 'evt-a', reopenId: 'evt-b' }),
        ConflictError,
      );
      assert.equal(rowCount(h), before);
    } finally {
      h.cleanup();
    }
  }
  // 跨通道
  {
    const h = makeHarness();
    try {
      h.seed({ id: 'evt-a', status: 'open', closed_reason: null, channel: 'dsh' });
      h.seed({
        id: 'evt-b',
        status: 'closed',
        closed_reason: 'silence',
        channel: 'browser',
        pointers: [pointer('r2')],
      });
      const before = rowCount(h);
      assert.throws(
        () => h.corrector.closeAndReopen({ closeId: 'evt-a', reopenId: 'evt-b' }),
        ConflictError,
      );
      assert.equal(rowCount(h), before);
    } finally {
      h.cleanup();
    }
  }
});
