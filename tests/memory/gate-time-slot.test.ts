/**
 * #131（P4）gate V2 时间槽红测：查询时间窗摘出热路径、降诊断留痕。
 *
 * #127 时代时间槽对 WINDOW/CANDIDATES 持有布尔否决权（窗外卡落 rejected/time-conflict）。
 * e10 封存卷实证该否决在口语查询上误杀合格卡（时间词是事件内容而非检索约束），#131 定稿：
 *  - 时间解析器/证明门/`timeConstraintAdmits` 谓词全部保留在 time-resolve，门层不再调用；
 *  - WINDOW/CANDIDATES 信封下，**词面合格卡一张不删**，统一盖留痕码 `time-window-ignored` 后交排序；
 *  - `time-conflict` 枚举在 types 保留（冻结先例），但 V2 产出路径永久不可达；
 *  - 半开边界 t∈[s,t)、区间相交、CANDIDATES OR 并集等谓词几何，下沉 time-resolve.test.ts 直测。
 *
 * 纪律：
 *  - 信封只能经 resolveTimeConstraint 真实产出（WINDOW 构造器模块私有，测试也拼不出假窗）；
 *  - 锚点固定注入，测试内可用 Date.UTC 做民用日换算，生产模块不碰宿主日期对象；
 *  - v1 门函数体静态不得出现 TimeConstraint 字样，带不带信封结果必须逐字节深相等（T7 冻结维持）。
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
  return resolveTimeConstraint(text, anchor);
}

/** 收集一次门裁决里所有卡（过门＋拒绝）的原因码。 */
function allReasonCodes(out: ReturnType<typeof applyGateV2>): string[] {
  return [...out.accepted, ...out.rejected].flatMap((g) => g.gateReasons);
}

// ── #131 WINDOW：时间窗无否决权，词面合格卡一张不删 ─────────────────────────

test('T6 WINDOW：窗内与窗外 exact 卡全部过门，各盖 time-window-ignored，rejected 清空', () => {
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
  assert.equal(out.accepted.length, 2);
  assert.equal(out.rejected.length, 0, '时间窗不再拥有删卡权，窗外卡不得落 rejected');
  assert.ok(
    out.accepted.every((g) => g.gateReasons.includes('time-window-ignored')),
    `两张词面过门卡都应携带时间窗留痕码，实际 ${JSON.stringify(out.accepted.map((g) => g.gateReasons))}`,
  );
  assert.ok(
    out.accepted.every((g) => g.gateReasons.includes('exact-alias-pass')),
    '留痕码追加在词面原因之后，不替代词面合格证据',
  );
});

test('T6 WINDOW：门层不再区分窗起点/终点，两张点事件卡都过门（半开几何下沉谓词直测）', () => {
  const c = constraintOf('周六的野餐');
  if (c.kind !== 'WINDOW') throw new Error('前置失效：应为 WINDOW');
  const s = c.window.startMs;
  const t = c.window.endMs;
  const atStart = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(s)], timeConstraint: c });
  const atEnd = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(t)], timeConstraint: c });
  assert.equal(atStart.accepted.length, 1, '窗起点卡过门');
  assert.equal(atEnd.accepted.length, 1, '窗终点卡（属下一窗）门层也不再删，留痕交排序');
  assert.ok(atStart.accepted[0]?.gateReasons.includes('time-window-ignored'));
  assert.ok(atEnd.accepted[0]?.gateReasons.includes('time-window-ignored'));
  assert.equal(atStart.rejected.length + atEnd.rejected.length, 0);
});

test('T6 WINDOW：跨窗相交卡与完全窗外卡都过门（相交裁决已下沉 time-resolve 谓词直测）', () => {
  const c = constraintOf('周六的野餐');
  if (c.kind !== 'WINDOW') throw new Error('前置失效');
  const s = c.window.startMs;
  const straddle = exactCard(s - DAY_MS + 3600_000, s + 3600_000);
  const before = exactCard(s - 2 * DAY_MS, s - DAY_MS);
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [straddle, before], timeConstraint: c });
  assert.equal(out.accepted.length, 2);
  assert.equal(out.rejected.length, 0);
  assert.ok(out.accepted.every((g) => g.gateReasons.includes('time-window-ignored')));
});

// ── #131 CANDIDATES：多候选不再删卡，OR 并集几何下沉谓词直测 ─────────────────

test('T6 CANDIDATES：三个候选日词面合格卡全部过门（OR 并集/禁直取首项由 time-resolve T4 直测）', () => {
  const c = constraintOf('周六和周日的安排');
  assert.equal(c.kind, 'CANDIDATES');
  if (c.kind !== 'CANDIDATES') throw new Error('前置失效');
  assert.equal(c.windows.length, 2);
  const friday = localDayStart(2026, 11, 20) + 12 * 3600_000;
  const saturday = localDayStart(2026, 11, 21) + 12 * 3600_000;
  const sunday = localDayStart(2026, 11, 22) + 12 * 3600_000;
  // #131：周五卡即便不在任何候选窗内也不再被时间槽否决，三张词面合格卡一张不删。
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
  assert.equal(out.accepted.length, 3);
  assert.equal(out.rejected.length, 0);
  assert.deepEqual(
    [...out.accepted.map((g) => g.card.occurredMs)].sort((a, b) => a - b),
    [friday, saturday, sunday],
  );
  assert.ok(out.accepted.every((g) => g.gateReasons.includes('time-window-ignored')));
  assert.ok(out.accepted.every((g) => g.slot === 'explore'));
});

test('T6 CANDIDATES：同一卡横跨两个候选窗只提交一次（按卡去重不重复）', () => {
  const c = constraintOf('周六和周日的安排');
  if (c.kind !== 'CANDIDATES') throw new Error('前置失效');
  const saturday = localDayStart(2026, 11, 21);
  const spanning = exactCard(saturday + 12 * 3600_000, saturday + DAY_MS + 12 * 3600_000);
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [spanning], timeConstraint: c });
  assert.equal(out.accepted.length, 1);
  assert.equal(out.rejected.length, 0);
  assert.ok(out.accepted[0]?.gateReasons.includes('time-window-ignored'));
});

// ── 不确定与无时间：留痕放行 / 不参与（语义维持） ────────────────────────────

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
  assert.ok(
    !out.accepted.some((g) => g.gateReasons.includes('time-window-ignored')),
    'UNCERTAIN 走 uncertain 留痕，不盖 window 留痕',
  );
});

test('T6 NONE：无时间原子不参与裁决，过门卡不带任何时间原因码', () => {
  const c = constraintOf('聚餐');
  assert.equal(c.kind, 'NONE');
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(localDayStart(2020, 1, 1))], timeConstraint: c });
  assert.deepEqual(out.accepted[0]?.gateReasons, ['exact-alias-pass']);
});

test('T6 词面本就拒绝的弱卡：保留词面原因，不盖时间窗留痕（留痕只盖过门卡）', () => {
  const c = constraintOf('周六的野餐');
  const saturday = localDayStart(2026, 11, 21) + 3600_000;
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [likeCard(saturday)], timeConstraint: c });
  assert.equal(out.status, 'no-match');
  assert.equal(out.reason, 'all-rejected');
  assert.deepEqual(out.rejected[0]?.gateReasons, ['like-only-weak-match']);
  assert.ok(
    !out.rejected.some((g) => g.gateReasons.some((r) => r.startsWith('time-'))),
    '词面拒绝卡不得追加任何时间原因码',
  );
});

test('T6 #131 核心反转：词面合格卡即便全在窗外也不再 no-match，全部 hit 并盖 time-window-ignored', () => {
  const c = constraintOf('周六的野餐');
  const monday = localDayStart(2026, 11, 23) + 3600_000;
  const tuesday = localDayStart(2026, 11, 24) + 3600_000;
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(monday), exactCard(tuesday)], timeConstraint: c });
  assert.equal(out.status, 'hit', '#127 时代此处是 no-match/all-rejected，#131 起时间无权清空合格集');
  assert.equal(out.accepted.length, 2);
  assert.equal(out.rejected.length, 0);
  assert.ok(out.accepted.every((g) => g.gateReasons.includes('time-window-ignored')));
});

test('T6 #129 双 exact 平局不放权：两张都过门，WINDOW 信封下各带 time-window-ignored（探索池次序归 RNG）', () => {
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
  assert.ok(out.accepted.every((g) => g.gateReasons.includes('time-window-ignored')));
  assert.ok(out.accepted.every((g) => g.slot === 'explore'));
});

// ── #131 V2 可达原因码锁：time-conflict 永久不可达 ───────────────────────────

test('T6 V2 原因码可达集锁：WINDOW/CANDIDATES 混合场景全扫描，任何卡都不得出现 time-conflict', () => {
  const windowC = constraintOf('周六的野餐');
  const candC = constraintOf('周六和周日的安排');
  const saturday = localDayStart(2026, 11, 21) + 3600_000;
  const monday = localDayStart(2026, 11, 23) + 3600_000;
  const friday = localDayStart(2026, 11, 20) + 12 * 3600_000;
  const battery = [
    applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(saturday), exactCard(monday), likeCard(monday)], timeConstraint: windowC }),
    applyGateV2({
      atMs: TEST_NOW_MS,
      qNorm: '周五的安排 周六安排',
      candidates: [overlapCard('周五的安排', friday), overlapCard('周六安排', saturday)],
      timeConstraint: candC,
    }),
  ];
  for (const out of battery) {
    const codes = allReasonCodes(out);
    assert.ok(!codes.includes('time-conflict'), `V2 产出路径不得可达 time-conflict，实际 ${JSON.stringify(codes)}`);
  }
});

// ── T7 零漂移锁（v1 冻结维持） ───────────────────────────────────────────────

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

test('T7 v2 无信封＝时间槽休眠：窗外卡仍按纯词面几何过门且无任何时间原因码', () => {
  const monday = localDayStart(2026, 11, 23) + 3600_000;
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [exactCard(monday)] });
  assert.equal(out.status, 'hit');
  assert.deepEqual(out.accepted[0]?.gateReasons, ['exact-alias-pass']);
});

test('T7 静态锁：v1 函数体不含 TimeConstraint；gate 模块整体摘除否决谓词调用与 time-conflict 产出', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const gateSrc = fs.readFileSync(path.join(here, '../../src/memory/gate.ts'), 'utf8');
  const v1Start = gateSrc.indexOf('export function applyGateV1');
  const v2PolicyStart = gateSrc.indexOf('export const GATE_POLICY_V2');
  assert.ok(v1Start > 0 && v2PolicyStart > v1Start);
  const v1Body = gateSrc.slice(v1Start, v2PolicyStart);
  assert.equal(v1Body.includes('TimeConstraint'), false, 'v1 函数体不得出现 TimeConstraint');
  assert.equal(v1Body.includes('timeConstraint'), false, 'v1 函数体不得出现 timeConstraint 入参');
  // #131：否决谓词保留在 time-resolve 供离线/单测直调，gate 不再 import 或调用。
  assert.equal(gateSrc.includes('timeConstraintAdmits'), false, 'gate 模块不得再引用否决谓词（调用与 import 都应摘除）');
  assert.equal(gateSrc.includes("'time-conflict'"), false, 'gate 模块不得再产出 time-conflict 原因码');
});
