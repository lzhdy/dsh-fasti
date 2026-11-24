/**
 * P-a（task178）红测：rules-v2 门控路径的排序改为确定性证据序。
 *
 * 要钉死的三件事：
 *  1. 证据三元组（命中字段总码点 → 命中字段数 → 最长字段）决定先后，其余键都只是兜底；
 *  2. 门控路径不再有随机：同 atMs 逐字节同序，换 atMs 也不改序（探索位从精确检索里退场）；
 *  3. v1 冻结路径零漂移：applyGateV1 的行为与输出形状不受本改造影响。
 *
 * 纪律：纯函数直调、atMs 注入、零系统时钟。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GATE_POLICY_V2, applyGateV1, applyGateV2 } from '../../src/memory/gate.ts';
import { rankCards } from '../../src/memory/rank.ts';
import type { ExplainedRankedCard, MemoryCard } from '../../src/memory/types.ts';

const NOW = Date.UTC(2026, 10, 24);
const DAY = 24 * 3600 * 1000;

interface CandSpec {
  cardId: string;
  fields: string[];
  occurredMs: number;
  weight?: number;
  hitCount?: number;
  exactAlias?: boolean;
}

function mkCand(spec: CandSpec): ExplainedRankedCard {
  const card: MemoryCard = {
    cardId: spec.cardId,
    eventId: `ev-${spec.cardId}`,
    anchorJson: '["exp-1"]',
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: spec.weight ?? 0,
    displayCuesJson: JSON.stringify(spec.fields),
    aliasesJson: '[]',
    discriminator: '',
    entityHintJson: null,
    occurredMs: spec.occurredMs,
    endedMs: spec.occurredMs,
    validMs: NOW - DAY,
    invalidMs: null,
    createdMs: NOW - DAY,
    expiredMs: null,
    status: 'active',
    contentHash: `h-${spec.cardId}`,
    hitCount: spec.hitCount ?? 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  return {
    card,
    scoreParts: { bm25: 0, recency: 0 },
    matchedTerms: [],
    matchKinds: spec.exactAlias ? ['exact-alias'] : ['fts-overlap'],
    ...(spec.exactAlias ? {} : { cueText: spec.fields.join(' '), lexicalFields: spec.fields }),
  };
}

const ids = (out: ReturnType<typeof applyGateV2>): string[] => out.accepted.map((x) => x.card.cardId);

/** 证据三元组（与门内实现口径一致）：sum 命中字段总码点、hits 命中字段数、max 最长字段码点。 */
function tripleOf(fields: readonly string[], qNorm: string) {
  const lens = fields.filter((f) => f.length >= GATE_POLICY_V2.minContainCodepoints && qNorm.includes(f)).map((f) => [...f].length);
  return { sum: lens.reduce((a, b) => a + b, 0), hits: lens.length, max: lens.length ? Math.max(...lens) : 0 };
}

test('PA1 回总码点优先：命中字段总长更大者在前，哪怕它更旧', () => {
  const q = '甲组词乙组词丙丁戊';
  const thick = mkCand({ cardId: 'mc_thick', fields: ['甲组词', '乙组词'], occurredMs: NOW - 100 * DAY });
  const thin = mkCand({ cardId: 'mc_thin', fields: ['丙丁戊'], occurredMs: NOW - DAY });
  assert.notDeepEqual(tripleOf(thick.lexicalFields!, q), tripleOf(thin.lexicalFields!, q));
  const out = applyGateV2({ qNorm: q, candidates: [thin, thick], atMs: NOW, limit: 10 });
  assert.deepEqual(ids(out), ['mc_thick', 'mc_thin'], '总码点大者必须置前');
});

test('PA11 总码点压过字段数：单条长字段胜过两条短字段（三元组次序不可交换）', () => {
  const q = '甲乙丙丁戊己庚';
  // 单条 7 码点：sum=7 / hits=1 / max=7；两条各 3 码点：sum=6 / hits=2 / max=3。
  const oneLong = mkCand({ cardId: 'mc_one_long', fields: ['甲乙丙丁戊己庚'], occurredMs: NOW - DAY });
  const twoShort = mkCand({ cardId: 'mc_two_short', fields: ['乙丙丁', '戊己庚'], occurredMs: NOW - DAY });
  const out = applyGateV2({ qNorm: q, candidates: [twoShort, oneLong], atMs: NOW, limit: 10 });
  assert.deepEqual(ids(out), ['mc_one_long', 'mc_two_short'], '总码点是第一键，字段数只在打平时才介入');
});

test('PA2 总码点打平时命中字段多者在前（哪怕对方单字段更长）', () => {
  const q = '短词甲短词乙六个码点词组';
  const many = mkCand({ cardId: 'mc_many', fields: ['短词甲', '短词乙'], occurredMs: NOW - 100 * DAY }); // sum 6 hits 2 max 3
  const few = mkCand({ cardId: 'mc_few', fields: ['六个码点词组'], occurredMs: NOW - DAY }); // sum 6 hits 1 max 6
  assert.equal(tripleOf(many.lexicalFields!, q).sum, tripleOf(few.lexicalFields!, q).sum);
  assert.ok(tripleOf(few.lexicalFields!, q).max > tripleOf(many.lexicalFields!, q).max, '前提：对方单字段更长');
  const out = applyGateV2({ qNorm: q, candidates: [few, many], atMs: NOW, limit: 10 });
  assert.deepEqual(ids(out), ['mc_many', 'mc_few'], '字段数多者必须置前');
});

test('PA3 总码点与字段数都打平时最长字段长者在前', () => {
  const q = '甲乙丙丁戊己庚辛壬';
  // 两卡都是 hits=2、sum=8（3+5 与 4+4），只有字段长度分布不同 → max 5 vs max 4
  const longMax = mkCand({ cardId: 'mc_longmax', fields: ['甲乙丙', '丁戊己庚辛'], occurredMs: NOW - 100 * DAY });
  const shortMax = mkCand({ cardId: 'mc_shortmax', fields: ['甲乙丙丁', '戊己庚辛'], occurredMs: NOW - DAY });
  const t1 = tripleOf(longMax.lexicalFields!, q);
  const t2 = tripleOf(shortMax.lexicalFields!, q);
  assert.deepEqual([t1.sum, t1.hits], [t2.sum, t2.hits], '前提：sum 与 hits 都打平');
  assert.ok(t1.max > t2.max, '前提：前者最长字段更长');
  const out = applyGateV2({ qNorm: q, candidates: [shortMax, longMax], atMs: NOW, limit: 10 });
  assert.deepEqual(ids(out), ['mc_longmax', 'mc_shortmax'], '最长字段长者必须置前');
});

test('PA4 三元组完全打平 → 回落记忆序（weight → 采用 → 时间 → id），绝不抽签', () => {
  const q = '同一线索词';
  const marked = mkCand({ cardId: 'mc_marked', fields: ['同一线索词'], occurredMs: NOW - 100 * DAY, weight: 3 });
  const used = mkCand({ cardId: 'mc_used', fields: ['同一线索词'], occurredMs: NOW - 90 * DAY, hitCount: 4 });
  const freshNew = mkCand({ cardId: 'mc_fresh_new', fields: ['同一线索词'], occurredMs: NOW - DAY });
  const freshOld = mkCand({ cardId: 'mc_fresh_old', fields: ['同一线索词'], occurredMs: NOW - 200 * DAY });
  const input = [freshOld, freshNew, used, marked];
  const out = applyGateV2({ qNorm: q, candidates: input, atMs: NOW, limit: 10 });
  // 期望值不靠人猜档位，直接与排序器的记忆序对拍：打平时必须完全一致。
  const memOrder = rankCards(input.map((c) => c.card), { nowMs: NOW, limit: null }).entries.map((e) => e.cardId);
  assert.deepEqual(ids(out), memOrder, '三点证据全打平时必须与 rankCards 记忆序逐项一致');
});

test('PA5 同 atMs 逐字节同序；换 atMs 也不改序（门控路径已无随机）', () => {
  const q = '甲组词乙组词';
  const cands = [
    mkCand({ cardId: 'mc_a', fields: ['甲组词'], occurredMs: NOW - 10 * DAY }),
    mkCand({ cardId: 'mc_b', fields: ['乙组词'], occurredMs: NOW - 20 * DAY }),
    mkCand({ cardId: 'mc_c', fields: ['甲组词', '乙组词'], occurredMs: NOW - 30 * DAY }),
  ];
  const base = ids(applyGateV2({ qNorm: q, candidates: cands, atMs: NOW, limit: 10 }));
  for (let i = 0; i < 6; i += 1) {
    assert.deepEqual(
      ids(applyGateV2({ qNorm: q, candidates: cands, atMs: NOW + i * 1000, limit: 10 })),
      base,
      `atMs+${i}s 顺序漂移：门控路径不得含随机`,
    );
  }
  assert.equal(base[0], 'mc_c', '总码点最大者必须稳定置前');
});

test('PA6 槽位语义：门控路径恒 ranked，探索位名额为 0', () => {
  const q = '甲组词乙组词';
  const cands = [
    mkCand({ cardId: 'mc_f1', fields: ['甲组词'], occurredMs: NOW - 10 * DAY, weight: 2 }),
    mkCand({ cardId: 'mc_f2', fields: ['乙组词'], occurredMs: NOW - 20 * DAY }),
  ];
  const out = applyGateV2({ qNorm: q, candidates: cands, atMs: NOW, limit: 10 });
  // 她的复盘标记（mc_f1 weight=2）保留 marked 并置顶；其余为 ranked；探索位恒 0。
  assert.deepEqual(out.accepted.map((x) => x.slot), ['marked', 'ranked']);
  assert.deepEqual(out.slots, { marked: 1, ranked: 1, explore: 0, exploreWanted: 0, exploreFilled: 0 });
});

test('PA7 exact-alias 证据恒最前（∞）', () => {
  const q = '甲组词乙组词丙丁戊';
  const thick = mkCand({ cardId: 'mc_thick', fields: ['甲组词', '乙组词'], occurredMs: NOW - DAY });
  const exact = mkCand({ cardId: 'mc_exact', fields: [], occurredMs: NOW - 100 * DAY, exactAlias: true });
  const out = applyGateV2({ qNorm: q, candidates: [thick, exact], atMs: NOW, limit: 10 });
  assert.deepEqual(ids(out), ['mc_exact', 'mc_thick']);
});

test('PA8 limit 按证据序截断，取前 N 不跳卡', () => {
  const q = '甲组词乙组词丙组词';
  const c1 = mkCand({ cardId: 'mc_1', fields: ['甲组词'], occurredMs: NOW - DAY });
  const c2 = mkCand({ cardId: 'mc_2', fields: ['甲组词', '乙组词'], occurredMs: NOW - 2 * DAY });
  const c3 = mkCand({ cardId: 'mc_3', fields: ['甲组词', '乙组词', '丙组词'], occurredMs: NOW - 3 * DAY });
  const out = applyGateV2({ qNorm: q, candidates: [c1, c2, c3], atMs: NOW, limit: 2 });
  assert.deepEqual(ids(out), ['mc_3', 'mc_2']);
  assert.equal(out.candidateCount, 3);
});

test('PA10 她的复盘标记恒置顶：证据更薄的 marked 卡仍压过证据更厚的 fresh 卡', () => {
  const q = '甲组词乙组词丙组词丁组词';
  // marked：她标记过（weight>0），但只有 3 码点证据；fresh：未标记，两字段共 6 码点。
  const markedThin = mkCand({ cardId: 'mc_marked_thin', fields: ['甲组词'], occurredMs: NOW - DAY, weight: 0.5 });
  const freshThick = mkCand({ cardId: 'mc_fresh_thick', fields: ['乙组词', '丙组词'], occurredMs: NOW - DAY });
  const out = applyGateV2({ qNorm: q, candidates: [freshThick, markedThin], atMs: NOW, limit: 10 });
  assert.equal(out.status, 'hit');
  assert.deepEqual(ids(out), ['mc_marked_thin', 'mc_fresh_thick'], '她的显式标记优先于证据厚薄');
  assert.deepEqual(out.accepted.map((x) => x.slot), ['marked', 'ranked']);
});

test('PA9 v1 冻结路径零漂移：applyGateV1 结果不含 slot，且对同一输入稳定', () => {
  const q = '甲组词乙组词';
  const cands = [
    mkCand({ cardId: 'mc_v1a', fields: ['甲组词'], occurredMs: NOW - DAY }),
    mkCand({ cardId: 'mc_v1b', fields: ['乙组词'], occurredMs: NOW - 2 * DAY }),
  ];
  const a = applyGateV1({ qNorm: q, candidates: cands, atMs: NOW, limit: 10 });
  const b = applyGateV1({ qNorm: q, candidates: cands, atMs: NOW, limit: 10 });
  assert.deepEqual(ids(a), ids(b));
  for (const x of a.accepted) assert.equal(x.slot, undefined, 'v1 的 slot 必须恒 undefined');
  assert.equal(a.slots, undefined, 'v1 不产出 slots');
});
