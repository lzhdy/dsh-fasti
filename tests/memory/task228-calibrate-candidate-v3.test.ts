/**
 * task228 红测：候选门 v3 A 卷标定回放（218 蓝图 §8）。
 *
 * 钉死五件事：
 *  1. 冻结表装载必须逐 artifact 重算 sha256 与 manifest 对账，篡改/缺档/schema 不符一律 fail-loud；
 *  2. 单题五档读数完整留痕（v3 信封、localityVerdict 归一标签、金标/对手位次、五元组、表哈希）；
 *  3. 配对指标口径：回收/误伤/冲突成本/诱饵与弃权题误收，硬闸门五条零容忍；
 *  4. B_min 机械定档：硬闸门先灭、合规档净收益最大、安全计数相同的并列取更紧档，
 *     全灭与安全结构分歧并列两异常显式上报（S2），脚本绝不自行拍板；
 *  5. McNemar 精确双侧 p 与 Wilson 区间为分析侧确定性算术，手工小例可复算。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildKMinTable,
  buildRaritySnapshot,
  NULL_MODEL_SCHEMA,
  RARITY_SNAPSHOT_SCHEMA,
  type FrozenKMinTable,
  type FrozenRaritySnapshot,
} from '../../src/memory/bigram-null-model.ts';
import {
  buildLocalityGeometryTable,
  GEOMETRY_NULL_MODEL_SCHEMA,
  type FrozenLocalityGeometryTable,
} from '../../src/memory/locality-null-model.ts';
import { applyGateV2 } from '../../src/memory/gate.ts';
import type { ExplainedRankedCard, GatedSearchOutcome, MemoryCard } from '../../src/memory/types.ts';
import {
  MANIFEST_SCHEMA,
  buildNullModelManifest,
  sha256Hex,
} from '../../scripts/p6/build-null-model-v3.ts';
import {
  loadVerifiedNullModel,
  buildCandidateRow,
  hardGateForBMin,
  netBenefit,
  selectBMin,
  mcnemarExact,
  wilsonInterval,
  toV3CalibrationRow,
  buildCandidateStats,
  type CandidateCalibrationRowV3,
} from '../../scripts/p6/calibrate-candidate-v3.ts';
import type { TuningCalibrationRowV3 } from '../../scripts/p6/calibrate-tuning-v3.ts';

const NOW = Date.UTC(2026, 10, 25);
const DAY = 24 * 3600 * 1000;
const corpusDocs = [
  '甲乙丙丁', '甲乙丙子', '乙丁子丑', '甲子乙丑', '丙子丁卯',
  '丁丑甲乙', '更换电梯按钮', '更换电梯按甲', '预约催办工单', '门锁锁芯更换',
];

function writeNullModelDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const bodies: Array<{ file: string; schema: string; body: string }> = [];
  for (let b = 0; b <= 4; b += 1) {
    const table = buildKMinTable({ fieldDocuments: corpusDocs, cardCount: 10, bMin: b, maxQueryBigrams: 32 });
    const file = `kmin-b${b}.json`;
    // 与 build-null-model-v3.ts CLI 同构：manifest 锚定无尾换行规范正文，落盘追加一个 \n。
    const body = JSON.stringify(table);
    fs.writeFileSync(path.join(dir, file), `${body}\n`);
    bodies.push({ file, schema: NULL_MODEL_SCHEMA, body });
  }
  const geo = buildLocalityGeometryTable({ fieldDocuments: corpusDocs, cardCount: 10, maxQueryCodeLength: 33 });
  const geoBody = JSON.stringify(geo);
  fs.writeFileSync(path.join(dir, 'locality-geometry.json'), `${geoBody}\n`);
  bodies.push({ file: 'locality-geometry.json', schema: GEOMETRY_NULL_MODEL_SCHEMA, body: geoBody });

  const rarity = buildRaritySnapshot(corpusDocs);
  const rarityBody = JSON.stringify(rarity);
  fs.writeFileSync(path.join(dir, 'rarity-buckets.json'), `${rarityBody}\n`);
  bodies.push({ file: 'rarity-buckets.json', schema: RARITY_SNAPSHOT_SCHEMA, body: rarityBody });

  const manifest = buildNullModelManifest({
    meta: {
      indexHint: '/home/user/fasti-v3-root-tmp/root/projection/memory-index/memory-index.sqlite',
      activeCardCount: 10,
      stats: { fieldDocumentCount: 10, totalBigramTokens: 30, distinctBigramCount: 20 },
      maxQueryBigrams: 32,
      maxQueryCodeLength: 33,
      bMinValues: [0, 1, 2, 3, 4],
    },
    entries: bodies,
  });
  fs.writeFileSync(path.join(dir, 'null-model-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-cv3-'));
}

function mkCand(spec: {
  cardId: string;
  fields?: string[];
  kind?: 'fts' | 'like' | 'exact';
  eventId?: string;
}): ExplainedRankedCard {
  const fields = spec.fields ?? ['占位线索'];
  const kind = spec.kind ?? 'fts';
  const card: MemoryCard = {
    cardId: spec.cardId,
    eventId: spec.eventId ?? `ev-${spec.cardId}`,
    anchorJson: '["exp-1"]',
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson: JSON.stringify(fields),
    aliasesJson: '[]',
    discriminator: '',
    entityHintJson: null,
    occurredMs: NOW - DAY,
    endedMs: NOW - DAY,
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

function v2RowOf(outcome2: GatedSearchOutcome, extra: Partial<TuningCalibrationRowV3>): TuningCalibrationRowV3 {
  return {
    probeId: extra.probeId ?? 'p',
    layer: extra.layer ?? 'tuning-gold',
    bucket: extra.bucket ?? 'B11',
    partition: extra.partition ?? ('tuning-a' as const),
    queryText: extra.queryText ?? 'q',
    candidateCount: outcome2.candidateCount,
    acceptedCount: outcome2.accepted.length,
    status: outcome2.status,
    goldRanks: extra.goldRanks ?? [],
    rivalRanks: extra.rivalRanks ?? [],
    topTie: false,
    topEvidenceSum: null,
    secondEvidenceSum: null,
    ...extra,
  };
}

test('CV3-1 冻结表装载：manifest 哈希对账通过；篡改字节/缺档/schema 不符/manifest 伪造一律 fail-loud', () => {
  const dir = mkTmpDir();
  writeNullModelDir(dir);
  const bundle = loadVerifiedNullModel(dir);
  assert.equal(bundle.manifest.schema, MANIFEST_SCHEMA);
  assert.equal(bundle.kminByBMin.size, 5);
  assert.equal(bundle.geometry.schema, GEOMETRY_NULL_MODEL_SCHEMA);
  assert.equal(bundle.rarity.schema, RARITY_SNAPSHOT_SCHEMA);
  for (const b of [0, 1, 2, 3, 4]) assert.ok(bundle.kminByBMin.has(b));

  // 语义篡改 kmin-b2（改一个表体字段再写回），规范正文哈希对不上。
  const tamperDir = mkTmpDir();
  writeNullModelDir(tamperDir);
  const k2 = path.join(tamperDir, 'kmin-b2.json');
  const k2obj = JSON.parse(fs.readFileSync(k2, 'utf8')) as { bMin: number };
  k2obj.bMin = 9;
  fs.writeFileSync(k2, JSON.stringify(k2obj));
  assert.throws(() => loadVerifiedNullModel(tamperDir), /sha256|哈希/);

  // 缺档。
  const missingDir = mkTmpDir();
  writeNullModelDir(missingDir);
  fs.unlinkSync(path.join(missingDir, 'rarity-buckets.json'));
  assert.throws(() => loadVerifiedNullModel(missingDir), /manifest|缺|artifact/);

  // 表体 schema 不符。
  const badSchemaDir = mkTmpDir();
  writeNullModelDir(badSchemaDir);
  const geoPath = path.join(badSchemaDir, 'locality-geometry.json');
  const badGeo = JSON.parse(fs.readFileSync(geoPath, 'utf8')) as { schema: string };
  badGeo.schema = 'fasti-null-model-locity/v9';
  fs.writeFileSync(geoPath, JSON.stringify(badGeo));
  assert.throws(() => loadVerifiedNullModel(badSchemaDir), /sha256|schema/);

  // 连 manifest 一起重签的伪造表（schema 仍须与登记一致，否则 schema 闸拦截）。
  const forgedDir = mkTmpDir();
  writeNullModelDir(forgedDir);
  const gp = path.join(forgedDir, 'locality-geometry.json');
  const forged = JSON.parse(fs.readFileSync(gp, 'utf8')) as FrozenLocalityGeometryTable;
  const forgedBody = JSON.stringify({ ...forged, schema: 'fasti-forged/v1' });
  fs.writeFileSync(gp, forgedBody);
  const manifestPath = path.join(forgedDir, 'null-model-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    artifacts: Array<{ file: string; schema: string; sha256: string }>;
  };
  for (const art of manifest.artifacts) {
    if (art.file === 'locality-geometry.json') {
      art.schema = 'fasti-forged/v1';
      art.sha256 = sha256Hex(forgedBody);
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => loadVerifiedNullModel(forgedDir), /schema/);

  // manifest 被裁档（artifact 文件未动、哈希仍对），bMinValues 档位闸必须 fail-loud。
  const cutDir = mkTmpDir();
  writeNullModelDir(cutDir);
  const cutManifestPath = path.join(cutDir, 'null-model-manifest.json');
  const cutManifest = JSON.parse(fs.readFileSync(cutManifestPath, 'utf8')) as { bMinValues: number[] };
  cutManifest.bMinValues = [0, 1, 2, 3];
  fs.writeFileSync(cutManifestPath, JSON.stringify(cutManifest));
  assert.throws(() => loadVerifiedNullModel(cutDir), /bMinValues|档位/);
});

test('CV3-2 透传读数：v2 hit 五档均 passthrough-hit 且与 v2 信封同构，表哈希逐题留痕', () => {
  const dir = mkTmpDir();
  writeNullModelDir(dir);
  const bundle = loadVerifiedNullModel(dir);
  const candidates = [mkCand({ cardId: 'mc_hit', fields: ['甲乙丙丁'], eventId: 'g1' }), mkCand({ cardId: 'mc_rej', fields: ['毫不相干'], eventId: 'x1' })];
  const qNorm = '甲乙丙丁';
  const outcome2 = applyGateV2({ qNorm, candidates, atMs: NOW });
  const row2 = v2RowOf(outcome2, { probeId: 'p-hit', queryText: qNorm, goldRanks: [0] });
  const row = buildCandidateRow({ row2, qNorm, candidates, atMs: NOW, goldEventIds: ['g1'], rivalEventIds: [], bundle });
  assert.equal(row.v3.length, 5);
  for (const reading of row.v3) {
    assert.equal(reading.localityVerdict, 'passthrough-hit');
    assert.equal(reading.v3Status, 'hit');
    assert.deepEqual(reading.v3GoldRanks, [0]);
    assert.equal(reading.witness, null);
    assert.equal(reading.tableHashes.kmin.length, 64);
    assert.equal(reading.tableHashes.geometry.length, 64);
    assert.equal(reading.tableHashes.rarity.length, 64);
  }
});

test('CV3-3 pass 分叉读数：尾替场景记录 pass＋五元组，金标位次 0，bMin 档位逐档可追溯', () => {
  const dir = mkTmpDir();
  writeNullModelDir(dir);
  const bundle = loadVerifiedNullModel(dir);
  const candidates = [mkCand({ cardId: 'mc_gold', fields: ['更换电梯按钮'], eventId: 'g1' }), mkCand({ cardId: 'mc_rival', fields: ['预约催办工单'], eventId: 'r1' })];
  const qNorm = '更换电梯按甲';
  const outcome2 = applyGateV2({ qNorm, candidates, atMs: NOW });
  assert.equal(outcome2.status, 'no-match');
  const row2 = v2RowOf(outcome2, { probeId: 'p-pass', queryText: qNorm, goldRanks: [-1] });
  const row = buildCandidateRow({ row2, qNorm, candidates, atMs: NOW, goldEventIds: ['g1'], rivalEventIds: [], bundle });
  const passReadings = row.v3.filter((r) => r.localityVerdict === 'pass');
  assert.ok(passReadings.length > 0, '小语料五档中应有 pass 档（探针实测五档皆 pass）');
  for (const reading of passReadings) {
    assert.equal(reading.v3Status, 'hit');
    assert.equal(reading.v3AcceptedCount, 1);
    assert.deepEqual(reading.v3GoldRanks, [0]);
    assert.deepEqual(reading.witness, { fieldIndex: 0, m: 4, rareCount: reading.bMin <= 2 ? 4 : 3, span: 5, gap: 0 });
  }
  // no-match 透传档（若有）必须保持零合格卡。
  for (const reading of row.v3.filter((r) => r.localityVerdict === 'no-witness')) {
    assert.equal(reading.v3AcceptedCount, 0);
  }
});

test('CV3-4 conflict 读数：七维全等双卡 exact-equal，v3Reason=locality-conflict 且 accepted=0', () => {
  const dir = mkTmpDir();
  writeNullModelDir(dir);
  const bundle = loadVerifiedNullModel(dir);
  const candidates = [
    mkCand({ cardId: 'mc_a', fields: ['更换电梯按钮'], eventId: 'g1' }),
    mkCand({ cardId: 'mc_b', fields: ['更换电梯按钮'], eventId: 'g2' }),
  ];
  const qNorm = '更换电梯按甲';
  const outcome2 = applyGateV2({ qNorm, candidates, atMs: NOW });
  const row2 = v2RowOf(outcome2, { probeId: 'p-conflict', queryText: qNorm });
  const row = buildCandidateRow({ row2, qNorm, candidates, atMs: NOW, goldEventIds: ['g1'], rivalEventIds: [], bundle });
  const conflictReadings = row.v3.filter((r) => r.localityVerdict === 'exact-equal');
  assert.ok(conflictReadings.length > 0);
  for (const reading of conflictReadings) {
    assert.equal(reading.v3Status, 'no-match');
    assert.equal(reading.v3Reason, 'locality-conflict');
    assert.equal(reading.v3AcceptedCount, 0);
    assert.equal(reading.witness, null);
  }
});

test('CV3-5 硬闸门：高危误伤/新增 wc/诱饵误收/弃权题误收任一非零即灭档', () => {
  const rows = [
    fakeRow({ layer: 'tuning-gold', highRiskLabel: 'high', b: (r) => {
      r.set(2, { v3Status: 'hit', goldTop1: false, v2Top1: false, v2Accepted: 0 });
    } }),
    fakeRow({ layer: 'tuning-decoy', b: (r) => {
      r.set(2, { v3Status: 'hit', goldTop1: false, v2Top1: false, v2Accepted: 0 });
    } }),
    fakeRow({ layer: 'tuning-abstain', b: (r) => {
      r.set(2, { v3Status: 'hit', goldTop1: false, v2Top1: false, v2Accepted: 0 });
    } }),
  ];
  const gate = hardGateForBMin(rows, 2);
  assert.equal(gate.passed, false);
  assert.ok(gate.highRiskWrong >= 1);
  assert.ok(gate.decoyFalseAccept >= 1);
  assert.ok(gate.abstainFalseAccept >= 1);
  // 干净行集过门。
  const clean = [
    fakeRow({ layer: 'tuning-gold', b: (r) => r.set(2, { v3Status: 'no-match', goldTop1: false, v2Top1: false, v2Accepted: 0 }) }),
    fakeRow({ layer: 'tuning-decoy', b: (r) => r.set(2, { v3Status: 'no-match', goldTop1: false, v2Top1: false, v2Accepted: 0 }) }),
  ];
  assert.equal(hardGateForBMin(clean, 2).passed, true);
});

test('CV3-6 机械定档：误伤档先灭；合规档净收益最大；安全计数相同的净收益并列取更紧档；全灭走 S2', () => {
  // b0/b1 干净但回收 2；b2 干净回收 5；b3 出现误伤被灭；b4 干净回收 5（与 b2 并列、安全同构取 b4）。
  const rows: CandidateCalibrationRowV3[] = [];
  const addRecovered = (bMins: number[], id: string, layer: 'tuning-gold' | 'tuning-decoy' | 'tuning-abstain' = 'tuning-gold'): void => {
    const m = new Map<number, { v3Status: string; goldTop1: boolean; v2Top1: boolean; v2Accepted: number }>();
    for (const b of bMins) m.set(b, { v3Status: 'hit', goldTop1: true, v2Top1: false, v2Accepted: 0 });
    for (const b of [0, 1, 2, 3, 4].filter((x) => !bMins.includes(x))) {
      m.set(b, { v3Status: 'no-match', goldTop1: false, v2Top1: false, v2Accepted: 0 });
    }
    rows.push(fakeRow({ probeId: id, layer, b: (mm) => { for (const [k, v] of m) mm.set(k, v); } }));
  };
  addRecovered([0, 1, 2, 4], 'g1');
  addRecovered([2, 4], 'g2');
  addRecovered([2, 4], 'g3');
  addRecovered([2, 4], 'g4');
  addRecovered([2, 4], 'g5');
  // b3 误伤：一条 gold 题被错误救回。
  rows.push(fakeRow({
    probeId: 'bad', layer: 'tuning-gold',
    b: (m) => {
      for (const b of [0, 1, 2, 4]) m.set(b, { v3Status: 'no-match', goldTop1: false, v2Top1: false, v2Accepted: 0 });
      m.set(3, { v3Status: 'hit', goldTop1: false, v2Top1: false, v2Accepted: 0 });
    },
  }));

  const decision = selectBMin(rows);
  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedBMin, 4, 'b2/b4 净收益并列且安全计数同构，机械取更紧档 b4');
  assert.equal(decision.perBMin.find((s) => s.bMin === 3)?.hardGatePassed, false);
  assert.equal(netBenefit(rows, 4).recovered, 5);

  // 全灭异常。
  const allBad = [fakeRow({ layer: 'tuning-gold', highRiskLabel: 'high', b: (m) => {
    for (const b of [0, 1, 2, 3, 4]) m.set(b, { v3Status: 'hit', goldTop1: false, v2Top1: false, v2Accepted: 0 });
  } })];
  const doom = selectBMin(allBad);
  assert.equal(doom.status, 'anomaly-all-eliminated');
  assert.equal(doom.selectedBMin, null);
});

test('CV3-7 安全结构分歧并列走 S2：净收益相同但误伤结构不同的两档不得自动取紧', () => {
  const rows: CandidateCalibrationRowV3[] = [];
  // b2 与 b4 净收益同为 1：b2 靠真回收，b4 同时带一条高危误伤（硬闸门会先灭 b4 → 不构成并列）。
  // 构造合规面内的结构分歧：两档硬闸门都过（无 wc/误收），但弃权成本分布不同由冲突计数字段区分。
  rows.push(fakeRow({
    probeId: 'g1', layer: 'tuning-gold',
    b: (m) => {
      for (const b of [0, 1, 2, 3, 4]) m.set(b, { v3Status: 'no-match', goldTop1: false, v2Top1: false, v2Accepted: 0 });
      m.set(2, { v3Status: 'hit', goldTop1: true, v2Top1: false, v2Accepted: 0 });
      m.set(4, { v3Status: 'hit', goldTop1: true, v2Top1: false, v2Accepted: 0 });
    },
  }));
  // b4 另产生一例冲突弃权（v2 本已正确命中的题在 b4 变 conflict），净收益被冲突成本拉平但安全语义不同。
  rows.push(fakeRow({
    probeId: 'g2', layer: 'tuning-gold',
    b: (m) => {
      for (const b of [0, 1, 2, 3]) m.set(b, { v3Status: 'hit', goldTop1: true, v2Top1: true, v2Accepted: 1 });
      m.set(4, { v3Status: 'no-match', goldTop1: false, v2Top1: true, v2Accepted: 1, v3Reason: 'locality-conflict' });
    },
  }));
  const decision = selectBMin(rows);
  // b2 净收益=1、b4 净收益=1-1=0，故二者净收益其实不并列；b2 唯一最优直接选定。
  assert.equal(decision.status, 'selected');
  assert.equal(decision.selectedBMin, 2);
  assert.equal(netBenefit(rows, 4).conflictCost, 1);
});

test('CV3-8 McNemar 精确双侧 p 与 Wilson 区间：手工小例确定性复算', () => {
  // n=9、b=8、c=1：p = 2*(C9,8+C9,9)/2^9 = 20/512 = 0.0390625。
  const m = mcnemarExact(8, 1);
  assert.equal(m.n, 9);
  assert.ok(Math.abs(m.twoSidedP - 20 / 512) < 1e-12);
  // b=c=0 时无分歧不可检验，返 p=1 且不抛错。
  assert.equal(mcnemarExact(0, 0).twoSidedP, 1);
  // Wilson 95%：8/10 区间约 [0.4902, 0.9433]（四位小数对照）。
  const w = wilsonInterval(8, 10);
  assert.ok(Math.abs(w.low - 0.4902) < 5e-4, `low=${w.low}`);
  assert.ok(Math.abs(w.high - 0.9433) < 5e-4, `high=${w.high}`);
  assert.equal(w.point, 0.8);
  // 零样本不产 NaN。
  const w0 = wilsonInterval(0, 0);
  assert.ok(Number.isFinite(w0.low) && Number.isFinite(w0.high));
});

test('CV3-9 确定性：同输入五档读数 JSON 逐字节一致', () => {
  const dir = mkTmpDir();
  writeNullModelDir(dir);
  const bundle = loadVerifiedNullModel(dir);
  const candidates = [mkCand({ cardId: 'mc_gold', fields: ['更换电梯按钮'], eventId: 'g1' })];
  const qNorm = '更换电梯按甲';
  const outcome2 = applyGateV2({ qNorm, candidates, atMs: NOW });
  const row2 = v2RowOf(outcome2, { queryText: qNorm });
  const mk = (): CandidateCalibrationRowV3 =>
    buildCandidateRow({ row2, qNorm, candidates, atMs: NOW, goldEventIds: ['g1'], rivalEventIds: [], bundle });
  assert.equal(JSON.stringify(mk()), JSON.stringify(mk()));
});

test('CV3-10 同分异质并列必须停车：净收益相等但回收/冲突分量分歧时返 anomaly-tie-affects-judgment', () => {
  const rows: CandidateCalibrationRowV3[] = [];
  // g1：b2、b4 各回收 1。
  rows.push(fakeRow({
    probeId: 'g1', layer: 'tuning-gold',
    b: (m) => {
      for (const b of [0, 1, 3]) m.set(b, { v3Status: 'no-match', goldTop1: false, v2Top1: false, v2Accepted: 0 });
      for (const b of [2, 4]) m.set(b, { v3Status: 'hit', goldTop1: true, v2Top1: false, v2Accepted: 0 });
    },
  }));
  // g2：仅 b4 多回收 1。
  rows.push(fakeRow({
    probeId: 'g2', layer: 'tuning-gold',
    b: (m) => {
      for (const b of [0, 1, 2, 3]) m.set(b, { v3Status: 'no-match', goldTop1: false, v2Top1: false, v2Accepted: 0 });
      m.set(4, { v3Status: 'hit', goldTop1: true, v2Top1: false, v2Accepted: 0 });
    },
  }));
  // g3：b4 冲突弃权成本 1（v2 本已金标 top1）。
  rows.push(fakeRow({
    probeId: 'g3', layer: 'tuning-gold',
    b: (m) => {
      for (const b of [0, 1, 2, 3]) m.set(b, { v3Status: 'hit', goldTop1: true, v2Top1: true, v2Accepted: 1 });
      m.set(4, { v3Status: 'no-match', goldTop1: false, v2Top1: true, v2Accepted: 1, v3Reason: 'locality-conflict' });
    },
  }));
  const benefit2 = netBenefit(rows, 2);
  const benefit4 = netBenefit(rows, 4);
  assert.equal(benefit2.net, 1);
  assert.equal(benefit4.net, 1);
  assert.notDeepEqual(
    { recovered: benefit2.recovered, conflictCost: benefit2.conflictCost },
    { recovered: benefit4.recovered, conflictCost: benefit4.conflictCost },
  );
  const decision = selectBMin(rows);
  assert.equal(decision.status, 'anomaly-tie-affects-judgment');
  assert.equal(decision.selectedBMin, null);
});

test('CV3-11 脚本纪律：只读开库、零生产接线（不碰分派壳/版本常量），CLI 参数解析 fail-loud', async () => {
  const { parseArgs } = await import('../../scripts/p6/calibrate-candidate-v3.ts');
  const parsed = parseArgs(['--tuning', 't', '--world-root', 'w', '--null-model', 'n', '--limit', '12']);
  assert.deepEqual(parsed, { tuning: 't', worldRoot: 'w', nullModel: 'n', nowMs: undefined, out: undefined, limit: 12 });
  assert.throws(() => parseArgs(['--bogus', 'x']), /未知参数/);
  assert.throws(() => parseArgs(['--tuning']), /缺少取值/);

  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts/p6/calibrate-candidate-v3.ts'),
    'utf8',
  );
  const effectiveLines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('*') && !line.startsWith('//'));
  assert.ok(effectiveLines.some((line) => line.includes("readOnly: true")), '必须以只读方式打开 sqlite');
  for (const banned of ['INSERT ', 'UPDATE ', 'DELETE ', 'CREATE TABLE', 'DROP ']) {
    assert.ok(!effectiveLines.some((line) => line.includes(banned)), `分析脚本禁止写库动词：${banned}`);
  }
  assert.ok(!source.includes('CURRENT_RULES_VERSION'), '禁止读取生产版本常量');
  // 深度防御行的文本守卫（行为面被相邻分支等价覆盖，防静默删除）：
  //  - manifest 登记 schema 与表体实得的显式比较（未知 schema 兜底之外的第二道闸）；
  //  - 四处 frozen/信封双向不变量 throw，双轨接线漂移时必须 fail-loud。
  assert.ok(source.includes('parsed.schema !== artifact.schema'), 'schema 显式对账行不得静默删除');
  const invariantCount = (source.match(/v3 接线不变量破坏/g) ?? []).length;
  assert.equal(invariantCount, 4, '四处双轨不变量守卫必须齐备');
  // 具名双轨：只许 applyGateV2/applyGateV3，不许 import 生产分派壳 applyGate。
  const importLines = effectiveLines.filter((line) => line.startsWith('import') || source.includes(`import {`));
  assert.ok(!importLines.some((line) => /\bapplyGate\b/.test(line)), '禁止 import 生产分派壳 applyGate');
  assert.ok(source.includes('applyGateV2') && source.includes('applyGateV3'));
});

test('CV3-12 五表投影与配对统计：v3 读数可无损投影复用 summarizeTuningRows，McNemar/区间组装正确', () => {
  const rows: CandidateCalibrationRowV3[] = [
    // 第一题：b2 回收（v2 零合格卡，v3 金标 top1）。
    fakeRow({
      probeId: 'rec-1', layer: 'tuning-gold',
      b: (m) => {
        for (const b of [0, 1, 3, 4]) m.set(b, { v3Status: 'no-match', goldTop1: false, v2Top1: false, v2Accepted: 0 });
        m.set(2, { v3Status: 'hit', goldTop1: true, v2Top1: false, v2Accepted: 0 });
      },
    }),
    // 第二题：五档全 no-match。
    fakeRow({
      probeId: 'miss-1', layer: 'tuning-gold',
      b: (m) => {
        for (const b of [0, 1, 2, 3, 4]) m.set(b, { v3Status: 'no-match', goldTop1: false, v2Top1: false, v2Accepted: 0 });
      },
    }),
  ];
  const projected = toV3CalibrationRow(rows[0]!, 2);
  assert.equal(projected.status, 'hit');
  assert.equal(projected.acceptedCount, 1);
  assert.deepEqual(projected.goldRanks, [0]);
  assert.throws(() => toV3CalibrationRow(rows[0]!, 9), /bMin=9/);

  const stats = buildCandidateStats(rows, 2);
  assert.equal(stats.bMin, 2);
  assert.equal(stats.benefit.recovered, 1);
  assert.equal(stats.mcnemar.b, 1);
  assert.equal(stats.mcnemar.c, 0);
  assert.equal(stats.mcnemar.n, 1);
  assert.equal(stats.v2NoMatchCount, 2);
  assert.equal(stats.v3Summary.totals.n, 2);
  assert.equal(stats.goldTop1Interval.point, 0.5);
  assert.equal(stats.recoveredInterval.point, 0.5);
  assert.ok(Number.isFinite(stats.recoveredInterval.low) && Number.isFinite(stats.recoveredInterval.high));
  // 硬闸门结论随附且与独立函数一致。
  assert.equal(stats.hardGate.passed, hardGateForBMin(rows, 2).passed);
});

// ---- 手造行夹具：直接按档位填 v3 读数，绕开检索库，专测定档纯算术 ----
interface FakeReading {
  v3Status: string;
  goldTop1: boolean;
  v2Top1: boolean;
  v2Accepted: number;
  v3Reason?: string;
}
function fakeRow(opts: {
  probeId?: string;
  layer?: CandidateCalibrationRowV3['layer'];
  highRiskLabel?: string;
  bucket?: string;
  b: (m: Map<number, FakeReading>) => void;
}): CandidateCalibrationRowV3 {
  const m = new Map<number, FakeReading>();
  opts.b(m);
  const anyHit = [...m.values()].some((r) => r.v2Accepted > 0);
  return {
    probeId: opts.probeId ?? `p-${Math.random().toString(36).slice(2)}`,
    layer: opts.layer ?? 'tuning-gold',
    bucket: opts.bucket ?? 'B11',
    partition: 'tuning-a' as const,
    queryText: 'q',
    highRiskLabel: opts.highRiskLabel,
    candidateCount: 2,
    acceptedCount: anyHit ? 1 : 0,
    status: anyHit ? 'hit' : 'no-match',
    goldRanks: [],
    rivalRanks: [],
    topTie: false,
    topEvidenceSum: null,
    secondEvidenceSum: null,
    tableHashes: { manifest: 'm', kmin: 'k', geometry: 'g', rarity: 'r' },
    v3: [0, 1, 2, 3, 4].map((bMin) => {
      const r = m.get(bMin) ?? { v3Status: 'no-match', goldTop1: false, v2Top1: false, v2Accepted: 0 };
      return {
        bMin,
        v3Status: r.v3Status,
        v3Reason: r.v3Reason,
        v3AcceptedCount: r.v3Status === 'hit' ? 1 : 0,
        v3GoldRanks: [r.goldTop1 ? 0 : -1],
        v3RivalRanks: [],
        localityVerdict: r.v3Status === 'hit' ? (r.v2Accepted > 0 ? 'passthrough-hit' : 'pass') : r.v3Reason === 'locality-conflict' ? 'exact-equal' : 'no-witness',
        witness: null,
        v2Top1Gold: r.v2Top1,
        v2AcceptedCount: r.v2Accepted,
        tableHashes: { manifest: 'm', kmin: 'k', geometry: 'g', rarity: 'r' },
      };
    }),
  } as CandidateCalibrationRowV3;
}
