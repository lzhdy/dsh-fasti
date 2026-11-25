/**
 * task227 红测（c）：applyGateV3 双轨信封（218 蓝图 §3/§5/§6）。
 *
 * 钉死四件事：
 *  1. 四类透传与 applyGateV2 深相等（hit/empty/zero-hit/无词面候选或 no-witness）；
 *  2. 唯二分叉：locality pass 只放唯一领袖（locality-pass＋五元组），冲突整组弃权
 *     （no-match/locality-conflict，每卡 conflict-abstain，绝不挑卡）；
 *  3. exact-alias 与 like-fallback 通道行为不变，无 lexicalFields 卡不入幸存集；
 *  4. 零接线：gate.ts/bm25.ts/分派壳/types:19 对 v3 零感知，新门不引用占位表。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { applyGateV2 } from '../../src/memory/gate.ts';
import { applyGateV3 } from '../../src/memory/gate-v3.ts';
import { buildKMinTable, buildRaritySnapshot, type FrozenKMinTable, type FrozenRaritySnapshot } from '../../src/memory/bigram-null-model.ts';
import { buildLocalityGeometryTable, type FrozenLocalityGeometryTable } from '../../src/memory/locality-null-model.ts';
import type { ExplainedRankedCard, MemoryCard } from '../../src/memory/types.ts';

const NOW = Date.UTC(2026, 10, 25);
const DAY = 24 * 3600 * 1000;

const corpusDocs = [
  '甲乙丙丁', '甲乙丙子', '乙丁子丑', '甲子乙丑', '丙子丁卯',
  '丁丑甲乙', '更换电梯按钮', '更换电梯按甲', '预约催办工单', '门锁锁芯更换',
];
const snap: FrozenRaritySnapshot = buildRaritySnapshot(corpusDocs);
const geo: FrozenLocalityGeometryTable = buildLocalityGeometryTable({
  fieldDocuments: corpusDocs, cardCount: 10, maxQueryCodeLength: 33,
});
const kmin: FrozenKMinTable = buildKMinTable({
  fieldDocuments: corpusDocs, cardCount: 10, bMin: 2, maxQueryBigrams: 32,
});
const tables = { kminTable: kmin, geometryTable: geo, raritySnapshot: snap };

interface CandSpec {
  cardId: string;
  fields?: string[];
  occurredMs?: number;
  weight?: number;
  kind?: 'fts' | 'like' | 'exact';
}

function mkCand(spec: CandSpec): ExplainedRankedCard {
  const fields = spec.fields ?? ['占位线索'];
  const kind = spec.kind ?? 'fts';
  const card: MemoryCard = {
    cardId: spec.cardId,
    eventId: `ev-${spec.cardId}`,
    anchorJson: '["exp-1"]',
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: spec.weight ?? 0,
    displayCuesJson: JSON.stringify(fields),
    aliasesJson: '[]',
    discriminator: '',
    entityHintJson: null,
    occurredMs: spec.occurredMs ?? NOW - DAY,
    endedMs: spec.occurredMs ?? NOW - DAY,
    validMs: NOW - 2 * DAY,
    invalidMs: null,
    createdMs: NOW - 2 * DAY,
    expiredMs: null,
    status: 'active',
    contentHash: `h-${spec.cardId}`,
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  const base = { card, scoreParts: { bm25: 0, recency: 0 }, matchedTerms: [] as string[] };
  if (kind === 'exact') return { ...base, matchKinds: ['exact-alias'] };
  if (kind === 'like') return { ...base, matchKinds: ['like-fallback'] };
  return { ...base, matchKinds: ['fts-overlap'], cueText: fields.join(' '), lexicalFields: fields };
}

const runV3 = (qNorm: string, candidates: readonly ExplainedRankedCard[], limit?: number) =>
  applyGateV3({ qNorm, candidates, atMs: NOW, ...(limit !== undefined ? { limit } : {}), ...tables });

test('GV3-1 透传：v2 已 hit 时 v3 输出与 applyGateV2 深相等（含 rejected 与原因码序列）', () => {
  const candidates = [mkCand({ cardId: 'mc_hit', fields: ['甲乙丙丁'] }), mkCand({ cardId: 'mc_rej', fields: ['毫不相干'] })];
  const out2 = applyGateV2({ qNorm: '甲乙丙丁', candidates, atMs: NOW });
  const out3 = runV3('甲乙丙丁', candidates);
  assert.equal(out2.status, 'hit');
  assert.deepEqual(out3, out2);
});

test('GV3-2 透传：空查询 empty-query 深相等', () => {
  const candidates = [mkCand({ cardId: 'mc_a' })];
  assert.deepEqual(runV3('', candidates), applyGateV2({ qNorm: '', candidates, atMs: NOW }));
});

test('GV3-3 透传：零词面候选 zero-lexical-hit 深相等', () => {
  assert.deepEqual(runV3('任意问句', []), applyGateV2({ qNorm: '任意问句', candidates: [], atMs: NOW }));
});

test('GV3-4 透传：all-rejected 且全是无 lexicalFields 的 like 卡，绝不进幸存集', () => {
  const candidates = [mkCand({ cardId: 'mc_like', kind: 'like' })];
  const out2 = applyGateV2({ qNorm: '更换电梯按甲', candidates, atMs: NOW });
  assert.equal(out2.reason, 'all-rejected');
  const out3 = runV3('更换电梯按甲', candidates);
  assert.deepEqual(out3, out2);
  assert.equal(out3.accepted.length, 0);
});

test('GV3-5 透传：all-rejected 且 frozen 裁决 no-witness，信封保持 all-rejected/no-match', () => {
  const candidates = [mkCand({ cardId: 'mc_a', fields: ['甲乙丙丁'] }), mkCand({ cardId: 'mc_b', fields: ['乙丁子丑'] })];
  const out2 = applyGateV2({ qNorm: '毫不相干的问句内容', candidates, atMs: NOW });
  assert.equal(out2.reason, 'all-rejected');
  assert.deepEqual(runV3('毫不相干的问句内容', candidates), out2);
});

test('GV3-6 分叉 pass：v2 全拒的尾替场景，唯一领袖带 locality-pass 与五元组放行', () => {
  const gold = mkCand({ cardId: 'mc_gold', fields: ['更换电梯按钮'] });
  const rival = mkCand({ cardId: 'mc_rival', fields: ['预约催办工单'] });
  const candidates = [gold, rival];
  const out2 = applyGateV2({ qNorm: '更换电梯按甲', candidates, atMs: NOW });
  assert.equal(out2.status, 'no-match'); // 前置：v2 确实全拒
  const out3 = runV3('更换电梯按甲', candidates);
  assert.equal(out3.status, 'hit');
  assert.equal(out3.reason, undefined);
  assert.equal(out3.accepted.length, 1);
  const leader = out3.accepted[0]!;
  assert.equal(leader.card.cardId, 'mc_gold');
  assert.deepEqual(leader.gateReasons, ['no-containment', 'locality-pass']);
  assert.deepEqual(leader.localityDetail, { fieldIndex: 0, m: 4, rareCount: 4, span: 5, gap: 0 });
  assert.equal(leader.slot, 'ranked');
  // 未过门卡保留原 v2 原因码落 rejected，不静默丢弃；领袖已从 rejected 移出。
  assert.deepEqual(out3.rejected.map((c) => c.card.cardId), ['mc_rival']);
  assert.deepEqual(out3.rejected[0]!.gateReasons, ['no-containment']);
  assert.equal(out3.candidateCount, 2);
  assert.deepEqual(out3.slots, { marked: 0, ranked: 1, explore: 0, exploreWanted: 0, exploreFilled: 0 });
});

test('GV3-7 分叉 conflict：七维全等双卡整组弃权，accepted 空且每卡挂 conflict-abstain', () => {
  const candidates = [
    mkCand({ cardId: 'mc_a', fields: ['更换电梯按钮'] }),
    mkCand({ cardId: 'mc_b', fields: ['更换电梯按钮'] }),
  ];
  const out3 = runV3('更换电梯按甲', candidates);
  assert.equal(out3.status, 'no-match');
  assert.equal(out3.reason, 'locality-conflict');
  assert.equal(out3.accepted.length, 0);
  assert.deepEqual(out3.rejected.map((c) => c.card.cardId), ['mc_a', 'mc_b']);
  for (const rejected of out3.rejected) {
    assert.deepEqual(rejected.gateReasons, ['no-containment', 'conflict-abstain']);
    assert.equal(rejected.localityDetail, undefined);
  }
});

test('GV3-8 混组：like 卡不污染幸存集，fts 卡 pass 时 like 卡原样留 rejected', () => {
  const candidates = [
    mkCand({ cardId: 'mc_gold', fields: ['更换电梯按钮'] }),
    mkCand({ cardId: 'mc_like', kind: 'like' }),
  ];
  const out3 = runV3('更换电梯按甲', candidates);
  assert.equal(out3.status, 'hit');
  assert.equal(out3.accepted[0]!.card.cardId, 'mc_gold');
  assert.deepEqual(out3.rejected.map((c) => c.card.cardId), ['mc_like']);
  assert.deepEqual(out3.rejected[0]!.gateReasons, ['like-only-weak-match']);
});

test('GV3-9 exact-alias 通道零变化：精确别名恒随 v2 hit 透传，绝不进 locality 分支', () => {
  const candidates = [mkCand({ cardId: 'mc_exact', kind: 'exact' }), mkCand({ cardId: 'mc_fts', fields: ['更换电梯按钮'] })];
  const out2 = applyGateV2({ qNorm: '更换电梯按甲', candidates, atMs: NOW });
  assert.equal(out2.status, 'hit');
  assert.deepEqual(runV3('更换电梯按甲', candidates), out2);
});

test('GV3-10 零接线守卫：gate.ts/bm25.ts/分派壳与 types:19 对 v3 零感知；gate-v3 不引用占位表', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  for (const rel of ['src/memory/gate.ts', 'src/memory/bm25.ts']) {
    const src = read(rel);
    for (const banned of ['gate-v3', 'locality-frozen', 'null-model', 'locality-conflict']) {
      assert.equal(src.includes(banned), false, `${rel} 不得出现 ${banned}`);
    }
  }
  const typesSrc = read('src/memory/types.ts');
  assert.ok(typesSrc.includes("export const CURRENT_RULES_VERSION = 'rules-v1';"));
  const v3Src = read('src/memory/gate-v3.ts');
  assert.equal(v3Src.includes('PLACEHOLDER'), false);
  // 分派壳仍只识别 v1/v2：gate.ts 的 applyGate switch 中不得出现 rules-v3 字面量。
  assert.equal(read('src/memory/gate.ts').includes('rules-v3'), false);
});

test('GV3-11 纯纪律与确定性：v3 新模块无墙钟/随机；同输入逐字节一致', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  for (const rel of ['src/memory/gate-v3.ts']) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const banned of ['Date.now', 'new Date(', 'Math.random']) {
      assert.equal(src.includes(banned), false, `${rel} 不得出现 ${banned}`);
    }
  }
  const candidates = [mkCand({ cardId: 'mc_gold', fields: ['更换电梯按钮'] })];
  const input = { qNorm: '更换电梯按甲', candidates, atMs: NOW, ...tables };
  assert.deepEqual(JSON.stringify(applyGateV3(input)), JSON.stringify(applyGateV3({ ...input })));
});
