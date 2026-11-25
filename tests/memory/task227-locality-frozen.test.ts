/**
 * task227 红测（b）：正式冻结表适配 frozenLocalityDecision（218 蓝图 §4）。
 *
 * 与 locality.ts 占位表路径的本质区别在 L1：占位表比「总命中 m ≥ n-1-deficit」，
 * 正式门必须比「稀有 bigram 命中种类数 rareCount ≥ lookupKMin(...)」；未建模格与
 * GEOMETRY_DENY 一律 fail-closed；L4 安全锁复用 compareGradedSignals 同口径，不另写比较器。
 * 本文件只测纯函数裁决；applyGateV3 信封分叉在 task227-gate-v3 红测。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  buildKMinTable,
  buildRaritySnapshot,
  rarityBucketMapOf,
  rareBigramHitCount,
  NULL_MODEL_SCHEMA,
  type FrozenKMinTable,
  type FrozenRaritySnapshot,
  RARITY_SNAPSHOT_SCHEMA,
  RARITY_BUCKET_COUNT,
} from '../../src/memory/bigram-null-model.ts';
import {
  buildLocalityGeometryTable,
  GEOMETRY_DENY,
  GEOMETRY_NULL_MODEL_SCHEMA,
  type FrozenLocalityGeometryTable,
} from '../../src/memory/locality-null-model.ts';
import { reverseContainmentDetail, GATE_POLICY_V2 } from '../../src/memory/gate.ts';
import { localityDetail } from '../../src/memory/locality.ts';
import { emitUnits, normalizeBigramText } from '../../src/memory/bigram.ts';
import type { GradedSignals } from '../../src/memory/types.ts';

// ---- 小语料真实冻结表（数值经仓外探针实测，行为关系为本红测断言对象）----
const docs = [
  '甲乙丙丁', '甲乙丙子', '乙丁子丑', '甲子乙丑', '丙子丁卯',
  '丁丑甲乙', '更换电梯按钮', '更换电梯按甲', '预约催办工单', '门锁锁芯更换',
];
const N = docs.length;
const QMAX = 32;
const QCODE = 33;
const snap = buildRaritySnapshot(docs);
const geo = buildLocalityGeometryTable({ fieldDocuments: docs, cardCount: N, maxQueryCodeLength: QCODE });
const kminOf = (bMin: number): FrozenKMinTable =>
  buildKMinTable({ fieldDocuments: docs, cardCount: N, bMin, maxQueryBigrams: QMAX });

const decide = (
  queryNorm: string,
  candidates: ReadonlyArray<{ cardId: string; lexicalFields: readonly string[] }>,
  bMin = 2,
) => {
  // 延迟 import 避免与下方静态纪律扫描的文件读取相互干扰。
  return frozenDecision(queryNorm, candidates, bMin);
};
import { frozenLocalityDecision } from '../../src/memory/locality-frozen.ts';
function frozenDecision(
  queryNorm: string,
  candidates: ReadonlyArray<{ cardId: string; lexicalFields: readonly string[] }>,
  bMin: number,
) {
  return frozenLocalityDecision({
    queryNorm,
    candidates,
    kminTable: kminOf(bMin),
    geometryTable: geo,
    raritySnapshot: snap,
  });
}

test('LF-1 满命中自查询过 L1-L3 成见证：五元组整数留痕，rareCount 为稀有命中种类数', () => {
  const verdict = decide('甲乙丙丁', [{ cardId: 'mc_gold', lexicalFields: ['甲乙丙丁'] }]);
  assert.equal(verdict.outcome, 'pass');
  if (verdict.outcome !== 'pass') throw new Error('应当 pass');
  assert.equal(verdict.cardId, 'mc_gold');
  assert.deepEqual(verdict.witness, { fieldIndex: 0, m: 3, rareCount: 3, span: 4, gap: 0 });
  const expectedSignals: GradedSignals = {
    lcs: 4, unitCovered: 3, unitTotal: 3, hitFields: 1, strongFields: 1, minHitFieldLength: 4, maxHitFieldLength: 4,
  };
  assert.deepEqual(verdict.signals, expectedSignals);
});

test('LF-2 L1 稀有口径（核心）：总命中高但稀有命中不足必拒，占位 deficit 口径不得回潮', () => {
  // 手工构造：字段三 bigram 全部落在高频桶 0，bMin=2 时 rareCount=0；k_min 格要求 1。
  // 占位表此时会按 m=3≥n-2=2 放行——正式门必须拒，证明两条 L1 口径不可互换。
  const kmin: FrozenKMinTable = {
    schema: NULL_MODEL_SCHEMA, cardCount: 100, rarityBuckets: RARITY_BUCKET_COUNT, bMin: 2,
    dfCutpoints: [1, 2, 3, 4, 5, 6, 7],
    grid: [{ m: 3, qLen: 3, kMin: 1 }],
  };
  const rarity: FrozenRaritySnapshot = {
    schema: RARITY_SNAPSHOT_SCHEMA, rarityBuckets: RARITY_BUCKET_COUNT,
    dfCutpoints: [1, 2, 3, 4, 5, 6, 7],
    entries: ['甲乙', '乙丙', '丙丁'].map((gram) => ({ gram, bucket: 0 })),
  };
  const verdict = frozenLocalityDecision({
    queryNorm: '甲乙丙丁',
    candidates: [{ cardId: 'mc_common', lexicalFields: ['甲乙丙丁'] }],
    kminTable: kmin,
    geometryTable: geo,
    raritySnapshot: rarity,
  });
  assert.equal(verdict.outcome, 'conflict-abstain');
  if (verdict.outcome !== 'conflict-abstain') throw new Error('高频撞脸字段不得凭总命中数放行');
  assert.equal(verdict.reason, 'no-witness');
  // 对照：同一字段在真实 b2 表上稀有命中=3≥kMin2，应当见证（口径差只在 rareCount）。
  assert.equal(rareBigramHitCount('甲乙丙丁', ['甲乙丙丁'], rarityBucketMapOf(snap), 2), 3);
});

test('LF-3 安全锁 pass：双幸存卡中七维严格支配者唯一放行，领袖外卡不上浮', () => {
  const verdict = decide('甲乙丙丁', [
    { cardId: 'mc_gold', lexicalFields: ['甲乙丙丁'] },
    { cardId: 'mc_rival', lexicalFields: ['甲乙丙子'] },
  ]);
  assert.equal(verdict.outcome, 'pass');
  if (verdict.outcome !== 'pass') throw new Error('gold 应严格支配 rival');
  assert.equal(verdict.cardId, 'mc_gold');
});

test('LF-4 安全锁 exact-equal：七维全等双卡整组弃权，绝不挑一张', () => {
  const verdict = decide('甲乙丙丁', [
    { cardId: 'mc_a', lexicalFields: ['甲乙丙丁'] },
    { cardId: 'mc_b', lexicalFields: ['甲乙丙丁'] },
  ]);
  assert.equal(verdict.outcome, 'conflict-abstain');
  if (verdict.outcome !== 'conflict-abstain') throw new Error('全等必须弃权');
  assert.equal(verdict.reason, 'exact-equal');
});

test('LF-5 安全锁 no-strict-leader：互有高低（mixed）且无唯一支配者 → 弃权', () => {
  // 小语料真实表偏紧、拆短字段卡难幸存，故用手工宽松表专测 L4（L1-L3 全放行后只看安全锁）：
  // A 单长字段 lcs 更高，B 拆三字段 hitFields 更高，七维互有高低，不得出现唯一领袖。
  const query = '更换电梯按钮 续费 归档';
  const fieldsA = ['更换电梯按钮', '续费归档'];
  const fieldsB = ['更换电梯', '续费', '归档'];
  const allGrams = new Set([...fieldsA, ...fieldsB].flatMap((f) => emitUnits(normalizeBigramText(f))));
  const qCode = [...normalizeBigramText(query)].length;
  const fieldLengths = [...new Set([...fieldsA, ...fieldsB].map((f) => [...normalizeBigramText(f)].length))];
  const relaxedKmin: FrozenKMinTable = {
    schema: NULL_MODEL_SCHEMA, cardCount: 100, rarityBuckets: RARITY_BUCKET_COUNT, bMin: 0,
    dfCutpoints: [1, 2, 3, 4, 5, 6, 7],
    grid: fieldLengths.flatMap((n) =>
      Array.from({ length: QMAX }, (_, i) => ({ m: n - 1, qLen: i + 1, kMin: 1 }))),
  };
  const relaxedGeo: FrozenLocalityGeometryTable = {
    schema: GEOMETRY_NULL_MODEL_SCHEMA, cardCount: 100, maxQueryCodeLength: QCODE,
    paddingSearchMax: 4, gapSearchMax: 4,
    grid: fieldLengths.map((n) => ({ n, qCodeLength: qCode, authorized: true, maxGap: 0, maxSpanPadding: 0 })),
  };
  const relaxedRarity: FrozenRaritySnapshot = {
    schema: RARITY_SNAPSHOT_SCHEMA, rarityBuckets: RARITY_BUCKET_COUNT,
    dfCutpoints: [1, 2, 3, 4, 5, 6, 7],
    entries: [...allGrams].sort().map((gram) => ({ gram, bucket: RARITY_BUCKET_COUNT - 1 })),
  };
  const verdict = frozenLocalityDecision({
    queryNorm: query,
    candidates: [
      { cardId: 'mc_a', lexicalFields: fieldsA },
      { cardId: 'mc_b', lexicalFields: fieldsB },
    ],
    kminTable: relaxedKmin,
    geometryTable: relaxedGeo,
    raritySnapshot: relaxedRarity,
  });
  assert.equal(verdict.outcome, 'conflict-abstain');
  if (verdict.outcome !== 'conflict-abstain') throw new Error('mixed 双卡不得出现唯一领袖');
  assert.equal(verdict.reason, 'no-strict-leader');
});

test('LF-6 fail-closed 两路径：未建模格哨兵 m+1 与格内 kMin>m 都不得放行', () => {
  // 真实 b2 表：(m=3,qLen=33) 未建模返哨兵 4；(m=3,qLen=32) 格内 kMin=10>m=3。
  const longQuery = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥'; // qLen=21
  const withinGrid = frozenLocalityDecision({
    queryNorm: longQuery,
    candidates: [{ cardId: 'mc_x', lexicalFields: ['甲乙丙丁'] }],
    kminTable: kminOf(2), geometryTable: geo, raritySnapshot: snap,
  });
  assert.equal(withinGrid.outcome, 'conflict-abstain');
  if (withinGrid.outcome !== 'conflict-abstain') throw new Error();
  assert.equal(withinGrid.reason, 'no-witness');

  const overGrid = frozenLocalityDecision({
    queryNorm: `${longQuery}追加两字甲乙`, // 撑过 qLen=32 网格上界
    candidates: [{ cardId: 'mc_x', lexicalFields: ['甲乙丙丁'] }],
    kminTable: kminOf(2), geometryTable: geo, raritySnapshot: snap,
  });
  assert.equal(overGrid.outcome, 'conflict-abstain');
  if (overGrid.outcome !== 'conflict-abstain') throw new Error();
  assert.equal(overGrid.reason, 'no-witness');
});

test('LF-7 几何不授权格（authorized=false/DENY）fail-closed，哪怕 L1 已过', () => {
  const denyGeo: FrozenLocalityGeometryTable = {
    schema: GEOMETRY_NULL_MODEL_SCHEMA, cardCount: N, maxQueryCodeLength: QCODE,
    paddingSearchMax: 4, gapSearchMax: 4,
    grid: [{ n: 4, qCodeLength: 4, authorized: false, maxGap: GEOMETRY_DENY, maxSpanPadding: GEOMETRY_DENY }],
  };
  const verdict = frozenLocalityDecision({
    queryNorm: '甲乙丙丁',
    candidates: [{ cardId: 'mc_x', lexicalFields: ['甲乙丙丁'] }],
    kminTable: kminOf(2), geometryTable: denyGeo, raritySnapshot: snap,
  });
  assert.equal(verdict.outcome, 'conflict-abstain');
  if (verdict.outcome !== 'conflict-abstain') throw new Error();
  assert.equal(verdict.reason, 'no-witness');
});

test('LF-8 无任何 bigram 命中（triple=null）→ no-witness；短于 2 码点字段跳过', () => {
  const v1 = decide('毫不相干的问句内容', [{ cardId: 'mc_x', lexicalFields: ['甲乙丙丁'] }]);
  assert.equal(v1.outcome, 'conflict-abstain');
  if (v1.outcome !== 'conflict-abstain') throw new Error();
  assert.equal(v1.reason, 'no-witness');
  const v2 = decide('甲', [{ cardId: 'mc_x', lexicalFields: ['甲'] }]);
  assert.equal(v2.outcome, 'conflict-abstain');
  if (v2.outcome !== 'conflict-abstain') throw new Error();
  assert.equal(v2.reason, 'no-witness');
});

test('LF-9 gap=0 回归（外审清单）：满命中见证与 reverseContainmentDetail 结论一致', () => {
  const field = '甲乙丙丁';
  const query = '甲乙丙丁';
  const triple = localityDetail(query, field)!;
  assert.equal(triple.gap, 0);
  assert.equal(triple.span, triple.n);
  const contain = reverseContainmentDetail(query, [field], GATE_POLICY_V2.minContainCodepoints);
  assert.ok(contain.max > 0);
  const verdict = decide(query, [{ cardId: 'mc_gold', lexicalFields: [field] }]);
  assert.equal(verdict.outcome, 'pass');
});

test('LF-10 确定性：同输入两次裁决 JSON 逐字节一致', () => {
  const input = {
    queryNorm: '甲乙丙丁',
    candidates: [
      { cardId: 'mc_gold', lexicalFields: ['甲乙丙丁'] },
      { cardId: 'mc_rival', lexicalFields: ['甲乙丙子'] },
    ],
    kminTable: kminOf(2), geometryTable: geo, raritySnapshot: snap,
  };
  assert.deepEqual(JSON.stringify(frozenLocalityDecision(input)), JSON.stringify(frozenLocalityDecision({ ...input })));
});

test('LF-11 源码纪律：不引用 PLACEHOLDER，无墙钟/随机/浮点运算', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = fs.readFileSync(path.join(repoRoot, 'src/memory/locality-frozen.ts'), 'utf8');
  assert.equal(src.includes('PLACEHOLDER'), false);
  for (const banned of ['Date.now', 'new Date(', 'Math.random', 'Math.log', 'Math.exp', 'Math.pow']) {
    assert.equal(src.includes(banned), false, `热路径不得出现 ${banned}`);
  }
  // 裸扫 ** 会误伤 JSDoc 注释开头，这里只认指数运算符上下文（标识符/括号紧邻）。
  assert.equal(/[A-Za-z0-9_)\]]\*\*[A-Za-z0-9_(]/.test(src), false, '热路径不得出现指数运算符');
});

test('LF-12 L1 等号边界（变异抓手表）：rareCount 恰好等于 kMin 时必须按 ≥ 放行，退化为 > 即拒', () => {
  // 手工造数：字段「甲乙丙丁」3 个 bigram，其中恰 2 个落稀有桶（bucket=2≥bMin=2），
  // 「丙丁」落 bucket=0 不计稀有；kmin 格手定 kMin=2，使 rareCount===kMin 等号成立。
  const query = '甲乙丙丁';
  const field = '甲乙丙丁';
  const qCode = [...normalizeBigramText(query)].length;
  const n = [...normalizeBigramText(field)].length; // 4
  const boundaryKmin: FrozenKMinTable = {
    schema: NULL_MODEL_SCHEMA, cardCount: 100, rarityBuckets: RARITY_BUCKET_COUNT, bMin: 2,
    dfCutpoints: [1, 2, 3, 4, 5, 6, 7],
    grid: [{ m: n - 1, qLen: 3, kMin: 2 }],
  };
  const boundaryGeo: FrozenLocalityGeometryTable = {
    schema: GEOMETRY_NULL_MODEL_SCHEMA, cardCount: 100, maxQueryCodeLength: QCODE,
    paddingSearchMax: 0, gapSearchMax: 0,
    grid: [{ n, qCodeLength: qCode, authorized: true, maxGap: 0, maxSpanPadding: 0 }],
  };
  const boundaryRarity: FrozenRaritySnapshot = {
    schema: RARITY_SNAPSHOT_SCHEMA, rarityBuckets: RARITY_BUCKET_COUNT,
    dfCutpoints: [1, 2, 3, 4, 5, 6, 7],
    entries: [
      { gram: '甲乙', bucket: 2 },
      { gram: '乙丙', bucket: 2 },
      { gram: '丙丁', bucket: 0 },
    ],
  };
  const verdict = frozenLocalityDecision({
    queryNorm: query,
    candidates: [{ cardId: 'mc_eq', lexicalFields: [field] }],
    kminTable: boundaryKmin,
    geometryTable: boundaryGeo,
    raritySnapshot: boundaryRarity,
  });
  assert.equal(verdict.outcome, 'pass');
  if (verdict.outcome !== 'pass') throw new Error('等号边界必须按 rareCount ≥ kMin 放行');
  assert.equal(verdict.witness.rareCount, 2);
});

test('LF-13 L2/L3 几何列读取静态守卫：gap 只可比 maxGap、span-n 只可比 maxSpanPadding，互换即报红', () => {
  // 等价变异说明（经探针与代数核对）：localityDetail 按最小 span 选 best，数学上保证
  // best.gap=0（任一含洞候选都末位 bigram 单独命中的 span=2 候选击败）且 span-n≤0，
  // 真机冻结表 maxGap/maxSpanPadding 取值集合实测均为 [0]，故两列互换在当前谓词形状下
  // 属等价变异、行为用例不可区分。按 A1 规格保留两道防御检查，并用字面文本守卫钉死列读取，
  // 防止将来几何分布变化或重构时把容忍量读错列。
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const lines = fs.readFileSync(path.join(repoRoot, 'src/memory/locality-frozen.ts'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(
    lines.some((line) => line.startsWith('if (triple.gap > geometry.maxGap)')),
    'L2 必须是 triple.gap 与 maxGap 比较（有效代码行）',
  );
  assert.ok(
    lines.some((line) => line.startsWith('if (triple.span - n > geometry.maxSpanPadding)')),
    'L3 必须是 triple.span - n 与 maxSpanPadding 比较（有效代码行）',
  );
});

test('LF-14 哨兵 fail-closed 静态守卫：kMin>m 早退行不得删除或反转为放行', () => {
  // 等价变异说明：rareCount 上界为字段 bigram 种类数 fieldUnitCount(m)，未建模哨兵 m+1
  // 与格内 kMin>m 在数学上都会被后续 L1（rareCount<kMin）兜底拒识，故删除本行的行为变异
  // 被 LF-6 间接覆盖、结果不变。但哨兵行把「空模型未授权」显式 fail-closed 在 L1 之前，
  // 是读数语义的自文档化防线；这里以文本守卫钉死，防重构时被静默删除或反转。
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = fs.readFileSync(path.join(repoRoot, 'src/memory/locality-frozen.ts'), 'utf8');
  const hasLiveSentinel = src
    .split('\n')
    .some((line) => line.trim().startsWith('if (kMin > fieldUnitCount) return null;'));
  assert.ok(hasLiveSentinel, 'kMin>m 哨兵早退行必须作为有效代码存在（注释掉等同删除）');
});

test('LF-15 φ 全等判定七维枚举守卫：signalsEqual 缺一维即报红，禁止静默降维', () => {
  // 蓝图 §6.8 变异六则之「φ 降维删一维」。黑盒侧 LF-3/LF-4/LF-5 已锁严格支配/全等/
  // 无领袖三类语义，但七维信号间存在构造耦合（单字段链上 lcs 与 unitCovered 联动），
  // 难以低成本构造「仅某一维不同」的真机对撞；故以函数体枚举守卫补齐：七个维度名必须
  // 逐一出现在 signalsEqual 实现中，删掉任意一维的降维变异立即报红。
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = fs.readFileSync(path.join(repoRoot, 'src/memory/locality-frozen.ts'), 'utf8');
  const body = src.slice(src.indexOf('function signalsEqual'), src.indexOf('/**', src.indexOf('function signalsEqual')));
  for (const dim of ['lcs', 'unitCovered', 'unitTotal', 'hitFields', 'strongFields', 'minHitFieldLength', 'maxHitFieldLength']) {
    assert.ok(body.includes(`a.${dim} === b.${dim}`), `signalsEqual 必须逐维比较 ${dim}，缺失即降维`);
  }
});
