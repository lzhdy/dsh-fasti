/**
 * #127 批 4（P3）gate V2 时间槽红测：T6 多候选 OR 并集/去重/留痕，T7 v1 零漂移静态＋深相等锁。
 *
 * 纪律：
 *  - 信封只能经 resolveTimeConstraint 真实产出（WINDOW 构造器模块私有，测试也拼不出假窗）；
 *  - 锚点固定注入，测试内可用 Date.UTC 做民用日换算，生产模块不碰宿主日期对象；
 *  - v1 门函数体静态不得出现 TimeConstraint 字样，带不带信封结果必须逐字节深相等。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyGateV1, applyGateV2 } from '../../src/memory/gate.ts';
import { resolveTimeConstraint } from '../../src/memory/time-resolve.ts';
import { TIME_ASSET_VERSIONS } from '../../src/memory/time-lexicon.ts';
import type {
  ExplainedRankedCard,
  MemoryCard,
  TimeAnchor,
  TimeConstraint,
} from '../../src/memory/types.ts';

// 固定锚点：2026-11-19（周四）12:00 Asia/Shanghai。
const ANCHOR_MS = Date.UTC(2026, 10, 19, 4, 0, 0);
/** #129 门入参注入时钟：与固定锚点同一时刻，禁系统时钟，保证可重放。 */
const TEST_NOW_MS = ANCHOR_MS;
const anchor: TimeAnchor = {
  epochMs: ANCHOR_MS,
  zoneId: 'Asia/Shanghai',
  weekStartsOn: 1,
  assets: TIME_ASSET_VERSIONS,
};
const ZONE_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 本地民用日零点毫秒（测试夹具换算用）。 */
function localDayStart(year: number, month1Based: number, day: number): number {
  return Date.UTC(year, month1Based - 1, day) - ZONE_OFFSET_MS;
}

let seq = 0;
function makeCard(occurredMs: number, endedMs: number = occurredMs): MemoryCard {
  seq += 1;
  const n = seq;
  return {
    cardId: `mc_ts_${String(n).padStart(3, '0')}`,
    eventId: `ev_${n}`,
    anchorJson: JSON.stringify([`exp_${n}`]),
    channel: 'main',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson: JSON.stringify(['合成线索']),
    aliasesJson: JSON.stringify([]),
    discriminator: '',
    entityHintJson: null,
    occurredMs,
    endedMs,
    validMs: occurredMs,
    invalidMs: null,
    createdMs: ANCHOR_MS,
    expiredMs: null,
    status: 'active',
    contentHash: `hash_ts_${n}`,
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
}

function exactCard(occurredMs: number, endedMs: number = occurredMs): ExplainedRankedCard {
  return {
    card: makeCard(occurredMs, endedMs),
    scoreParts: { bm25: 0, recency: 0 },
    matchedTerms: ['合成别名'],
    matchKinds: ['exact-alias'],
  };
}

function overlapCard(field: string, occurredMs: number, endedMs: number = occurredMs): ExplainedRankedCard {
  return {
    card: makeCard(occurredMs, endedMs),
    scoreParts: { bm25: 0, recency: 0 },
    matchedTerms: [field],
    matchKinds: ['fts-overlap'],
    cueText: field,
    lexicalFields: [field],
  };
}

function likeCard(occurredMs: number): ExplainedRankedCard {
  return {
    card: makeCard(occurredMs),
    scoreParts: { bm25: 0, recency: 0 },
    matchedTerms: ['弱匹配'],
    matchKinds: ['like-fallback'],
  };
}

function constraintOf(text: string): TimeConstraint {
  const c = resolveTimeConstraint(text, anchor);
  return c;
}

// ── T6 WINDOW 单日窗裁决 ──────────────────────────────────────────────────

test('T6 WINDOW：窗内 exact 卡过门，窗外卡落 rejected/time-conflict', () => {
  const c = constraintOf('周六的野餐');
  assert.equal(c.kind, 'WINDOW');
  const saturday = localDayStart(2026, 11, 21);
  const monday = localDayStart(2026, 11, 23);
  const out = applyGateV2({
    atMs: TEST_NOW_MS,
    qNorm: '任意词面',
    candidates: [exactCard(saturday + 3600_000), exactCard(monday + 3600_000)],
    timeConstraint: c,
  });
  assert.equal(out.status, 'hit');
  assert.equal(out.accepted.length, 1);
  assert.deepEqual(out.accepted[0]?.gateReasons, ['exact-alias-pass']);
  assert.equal(out.rejected.length, 1);
  assert.deepEqual(out.rejected[0]?.gateReasons, ['time-conflict']);
});

test('T6 WINDOW 半开边界：点事件 t∈[s,t)，起点命中、终点不命中', () => {
  const c = constraintOf('周六的野餐');
  if (c.kind !== 'WINDOW') throw new Error('前置失效：应为 WINDOW');
  const s = c.window.startMs;
  const t = c.window.endMs;
  const atStart = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(s)], timeConstraint: c });
  const atEnd = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(t)], timeConstraint: c });
  assert.equal(atStart.accepted.length, 1, '窗起点毫秒应命中');
  assert.equal(atEnd.accepted.length, 0, '窗终点毫秒属下一窗，不命中');
  assert.deepEqual(atEnd.rejected[0]?.gateReasons, ['time-conflict']);
});

test('T6 WINDOW：跨窗区间 o<t 且 e>s 相交即命中，完全在窗外才否决', () => {
  const c = constraintOf('周六的野餐');
  if (c.kind !== 'WINDOW') throw new Error('前置失效');
  const s = c.window.startMs;
  // 区间从周五伸入周六（相交）。
  const straddle = exactCard(s - DAY_MS + 3600_000, s + 3600_000);
  // 区间完全落在周五（不相交）。
  const before = exactCard(s - 2 * DAY_MS, s - DAY_MS);
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [straddle, before], timeConstraint: c });
  assert.equal(out.accepted.length, 1);
  assert.equal(out.rejected[0]?.gateReasons[0], 'time-conflict');
});

// ── T6 CANDIDATES 多候选 OR 并集 ──────────────────────────────────────────

test('T6 CANDIDATES：两个日子 OR 并集，第二个窗内的卡必须命中（禁直取首项）', () => {
  const c = constraintOf('周六和周日的安排');
  assert.equal(c.kind, 'CANDIDATES');
  if (c.kind !== 'CANDIDATES') throw new Error('前置失效');
  assert.equal(c.windows.length, 2);
  const friday = localDayStart(2026, 11, 20) + 12 * 3600_000;
  const saturday = localDayStart(2026, 11, 21) + 12 * 3600_000;
  const sunday = localDayStart(2026, 11, 22) + 12 * 3600_000;
  // #129：词面合格卡不再因证据长短互删；周五卡被时间槽否决，周六/周日两张都过门，
  // 排序器按 occurredMs 新→旧，周日卡排第一（第二候选窗不被直取首项吞掉）。
  const qNorm = '周五的安排 周六安排 周日的安排啊';
  const out = applyGateV2({
    atMs: TEST_NOW_MS,
    qNorm,
    candidates: [
      overlapCard('周五的安排', friday),
      overlapCard('周六安排', saturday),
      overlapCard('周日的安排啊', sunday),
    ],
    timeConstraint: c,
  });
  assert.equal(out.status, 'hit');
  assert.equal(out.accepted.length, 2);
  // #130：两张零采用卡都在探索池，截窗内次序归 atMs 派生 RNG（不再保证 occurred 序）；
  // 本测职责是 OR 并集不吞候选——集合口径核验两张窗内卡一张不丢，排序职责归 rank.test。
  assert.deepEqual(
    [...out.accepted.map((g) => g.card.occurredMs)].sort((a, b) => a - b),
    [saturday, sunday],
    '周六/周日两个候选窗的卡都命中，第二窗不被直取首项吞掉',
  );
  assert.ok(out.accepted.every((g) => g.slot === 'explore'));
  const rejectedByTime = out.rejected.filter((g) => g.gateReasons.includes('time-conflict'));
  assert.equal(rejectedByTime.length, 1, '周五卡应被时间槽否决');
  assert.equal(rejectedByTime[0]?.card.occurredMs, friday);
  assert.ok(
    out.rejected.every((g) => !g.gateReasons.includes('not-strict-leader')),
    '#129 起 not-strict-leader 在 V2 不再产出',
  );
});

test('T6 CANDIDATES：同一卡横跨两个候选窗只提交一次（按卡去重不重复）', () => {
  const c = constraintOf('周六和周日的安排');
  if (c.kind !== 'CANDIDATES') throw new Error('前置失效');
  const saturday = localDayStart(2026, 11, 21);
  // 区间从周六中午到周日中午，与两个窗都相交。
  const spanning = exactCard(saturday + 12 * 3600_000, saturday + DAY_MS + 12 * 3600_000);
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [spanning], timeConstraint: c });
  assert.equal(out.accepted.length, 1);
  assert.equal(out.rejected.length, 0);
});

// ── 不确定与无时间：留痕放行 / 不参与 ─────────────────────────────────────

test('T6 UNCERTAIN：时间不可闭合一律放行，过门卡盖 time-uncertain-ignored 留痕', () => {
  const c = constraintOf('最近聚餐的事情');
  assert.equal(c.kind, 'UNCERTAIN');
  const old = localDayStart(2020, 1, 1) + 3600_000;
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(old)], timeConstraint: c });
  assert.equal(out.status, 'hit');
  assert.ok(
    out.accepted[0]?.gateReasons.includes('time-uncertain-ignored'),
    `应携带留痕码，实际 ${JSON.stringify(out.accepted[0]?.gateReasons)}`,
  );
});

test('T6 NONE：无时间原子不参与裁决，过门卡不带任何时间原因码', () => {
  const c = constraintOf('聚餐');
  assert.equal(c.kind, 'NONE');
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(localDayStart(2020, 1, 1))], timeConstraint: c });
  assert.deepEqual(out.accepted[0]?.gateReasons, ['exact-alias-pass']);
});

test('T6 词面本就拒绝的弱卡：保留词面原因，不盖时间码（#129 全拒归 no-match）', () => {
  const c = constraintOf('周六的野餐');
  const saturday = localDayStart(2026, 11, 21) + 3600_000;
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [likeCard(saturday)], timeConstraint: c });
  assert.equal(out.status, 'no-match');
  assert.equal(out.reason, 'all-rejected');
  assert.deepEqual(out.rejected[0]?.gateReasons, ['like-only-weak-match']);
});

test('T6 词面过门卡被时间槽全部否决 → no-match/all-rejected 且逐卡 time-conflict', () => {
  const c = constraintOf('周六的野餐');
  const monday = localDayStart(2026, 11, 23) + 3600_000;
  const tuesday = localDayStart(2026, 11, 24) + 3600_000;
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(monday), exactCard(tuesday)], timeConstraint: c });
  assert.equal(out.status, 'no-match');
  assert.equal(out.reason, 'all-rejected');
  assert.equal(out.accepted.length, 0);
  assert.ok(out.rejected.every((g) => g.gateReasons.includes('time-conflict')));
});

test('T6 #129 时间槽放行的双 exact 平局不再弃权：两张都过门、一张不删（#130 探索池次序归 RNG，集合核验）', () => {
  const c = constraintOf('周六的野餐');
  const saturday = localDayStart(2026, 11, 21);
  const out = applyGateV2({
    atMs: TEST_NOW_MS,
    qNorm: 'q',
    candidates: [exactCard(saturday + 3600_000), exactCard(saturday + 2 * 3600_000)],
    timeConstraint: c,
  });
  assert.equal(out.status, 'hit');
  assert.equal(out.accepted.length, 2);
  assert.equal(out.rejected.length, 0);
  assert.deepEqual(
    [...out.accepted.map((g) => g.card.occurredMs)].sort((a, b) => a - b),
    [saturday + 3600_000, saturday + 2 * 3600_000],
  );
  assert.ok(out.accepted.every((g) => !g.gateReasons.includes('tie-no-strict-leader')));
  assert.ok(out.accepted.every((g) => g.slot === 'explore'));
});

// ── T7 零漂移锁 ───────────────────────────────────────────────────────────

test('T7 v1 带不带时间信封逐字节深相等（v1 几何冻结，不读 TimeConstraint）', () => {
  const envelope = constraintOf('周六的野餐');
  const saturday = localDayStart(2026, 11, 21) + 3600_000;
  const monday = localDayStart(2026, 11, 23) + 3600_000;
  const battery: Array<{ atMs: number; qNorm: string; candidates: ExplainedRankedCard[] }> = [
    { atMs: TEST_NOW_MS, qNorm: '', candidates: [exactCard(saturday)] },
    { atMs: TEST_NOW_MS, qNorm: 'q', candidates: [] },
    { atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(saturday), exactCard(monday)] },
    { atMs: TEST_NOW_MS, qNorm: 'q', candidates: [likeCard(saturday)] },
  ];
  for (const input of battery) {
    const without = applyGateV1(input);
    const withEnvelope = applyGateV1({ ...input, timeConstraint: envelope });
    assert.deepEqual(withEnvelope, without);
  }
});

test('T7 v2 无信封＝时间槽休眠：窗外卡仍按纯词面几何过门', () => {
  const monday = localDayStart(2026, 11, 23) + 3600_000;
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(monday)] });
  assert.equal(out.status, 'hit');
  assert.deepEqual(out.accepted[0]?.gateReasons, ['exact-alias-pass']);
});

test('T7 静态锁：applyGateV1 函数体不含 TimeConstraint 字样，时间槽只在 v2 落地', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const gateSrc = fs.readFileSync(path.join(here, '../../src/memory/gate.ts'), 'utf8');
  const v1Start = gateSrc.indexOf('export function applyGateV1');
  const v2PolicyStart = gateSrc.indexOf('export const GATE_POLICY_V2');
  assert.ok(v1Start > 0 && v2PolicyStart > v1Start);
  const v1Body = gateSrc.slice(v1Start, v2PolicyStart);
  assert.equal(v1Body.includes('TimeConstraint'), false, 'v1 函数体不得出现 TimeConstraint');
  assert.equal(v1Body.includes('timeConstraint'), false, 'v1 函数体不得出现 timeConstraint 入参');
  assert.equal(gateSrc.includes('timeConstraintAdmits'), true, 'v2 应经预注册谓词裁决');
});
