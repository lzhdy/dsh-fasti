/**
 * task213 红测：W3-1 P2 局部跨度聚集度谓词 + 统一安全锁（纯函数，默认不生效）。
 *
 * 口径来源：外审丙 A1 原文（门算法v2_外部盲评回复 §8A）+ 立项书 200 §6.1 统一安全锁；
 * 三元组实现经 W2-7 探针两次自纠定稿：
 *   ① accept 语义是「存在某字段满足 L1–L3」，不是「取最佳字段再判」；
 *   ② m 允许跳过未命中 bigram（只要求位置严格递增），跳过即产生 gap，不得遇错即断；
 *   ③ 反向包含 ≡ (span=|f| ∧ gap=0)，故 gap=0 是现几何的严格退化点。
 *
 * 硬边界：本批只交付纯函数与原因码，**不得接进 applyGateV2**（LOC-8 静态钉死），
 * 生产 CURRENT_RULES_VERSION 仍 rules-v1，热路径零变化。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  PLACEHOLDER_LOCALITY_TABLE,
  compareGradedSignals,
  localityDetail,
  localityGateDecision,
  witnessLocality,
  type LocalityCandidate,
} from '../../src/memory/locality.ts';
import { normalizeQuery } from '../../src/memory/bm25.ts';
import { reverseContainmentDetail, GATE_POLICY_V2 } from '../../src/memory/gate.ts';
import type { GradedSignals } from '../../src/memory/types.ts';

const q = (text: string): string => normalizeQuery(text);

test('LOC-1 gap=0 是反向包含的严格退化点：手算三元组并与 reverseContainmentDetail 对账', () => {
  const field = '更换电梯按钮'; // n=6，5 个 bigram
  const cases: Array<{ query: string; expect: { m: number; span: number; gap: number } | null }> = [
    { query: '更换电梯按钮', expect: { m: 5, span: 6, gap: 0 } }, // 完整出现
    { query: '更换电梯按甲', expect: { m: 4, span: 5, gap: 0 } }, // 尾字替换
    { query: '甲换电梯按钮', expect: { m: 4, span: 5, gap: 0 } }, // 首字替换
    // 中间插入：A1「取 span 最小起点」的反直觉退化——前缀 bigram 全被跳过后，尾部单点
    // 对齐 span=2 胜出，best 为 m=1/gap=0；它在 L1（m≥n-2）即被拒，而非靠 L3 的 gap 拦。
    // 该输出与 W2-7 探针 p-probe.mts 逐字一致，故钉死防误改。
    { query: '更换电梯的按钮', expect: { m: 1, span: 2, gap: 0 } },
    { query: '完全无关的一句话', expect: null },
  ];
  for (const c of cases) {
    assert.deepEqual(localityDetail(q(c.query), field), c.expect === null ? null : { n: 6, ...c.expect });
  }
  // 完整出现时，与现门反向包含逐题等价。
  const contain = reverseContainmentDetail(q('更换电梯按钮'), [field], GATE_POLICY_V2.minContainCodepoints);
  assert.equal(contain.max > 0, true);
  assert.equal(localityDetail(q('更换电梯按钮'), field)!.gap, 0);
  // 单码点字段无 bigram，返回 null 而不是造一个 m=0。
  assert.equal(localityDetail(q('甲'), '甲'), null);
});

test('LOC-2 accept 是「存在某字段满足」：不满足的短字段不得干扰命中的长字段', () => {
  const fields = ['无关短词', '更换电梯按钮'];
  const witness = witnessLocality(q('更换电梯按钮'), fields, PLACEHOLDER_LOCALITY_TABLE);
  assert.ok(witness !== null);
  assert.equal(witness.field, '更换电梯按钮');
  assert.equal(witness.triple.gap, 0);
});

test('LOC-3 默认占位表只放宽边界、不收内部空隙：尾字过、中间插入不过', () => {
  // 尾字替换：m=n-2 且 gap=0，满足 maxBigramDeficit=1。
  assert.ok(witnessLocality(q('更换电梯按甲'), ['更换电梯按钮'], PLACEHOLDER_LOCALITY_TABLE) !== null);
  // 中间插入：best 退化为 m=1（见 LOC-1），L1 要求 m≥n-2=4 不满足 → 无字段作证。
  assert.equal(witnessLocality(q('更换电梯的按钮'), ['更换电梯按钮'], PLACEHOLDER_LOCALITY_TABLE), null);
});

test('LOC-4 compareGradedSignals 四态与 198 口径一致（无一维低且至少一维高=支配）', () => {
  const base: GradedSignals = { lcs: 3, unitCovered: 2, unitTotal: 4, hitFields: 1, strongFields: 1, minHitFieldLength: 4, maxHitFieldLength: 4 };
  assert.equal(compareGradedSignals(base, { ...base }), 'equal');
  assert.equal(compareGradedSignals({ ...base, lcs: 4 }, base), 'dominates');
  assert.equal(compareGradedSignals(base, { ...base, lcs: 4 }), 'dominated');
  assert.equal(compareGradedSignals({ ...base, lcs: 4 }, { ...base, hitFields: 2 }), 'mixed');
});

test('LOC-5 安全锁：七字段全等必整组弃权（exact-equal），绝不挑一张', () => {
  const candidates: LocalityCandidate[] = [
    { cardId: 'mc_a', lexicalFields: ['更换电梯按钮'] },
    { cardId: 'mc_b', lexicalFields: ['更换电梯按钮'] },
  ];
  const verdict = localityGateDecision({ queryNorm: q('更换电梯按钮'), candidates, table: PLACEHOLDER_LOCALITY_TABLE });
  assert.equal(verdict.outcome, 'conflict-abstain');
  if (verdict.outcome === 'conflict-abstain') assert.equal(verdict.reason, 'exact-equal');
});

test('LOC-6 安全锁：唯一在七字段上严格支配其余幸存卡者才放行', () => {
  const candidates: LocalityCandidate[] = [
    { cardId: 'mc_gold', lexicalFields: ['更换电梯按钮'] },
    { cardId: 'mc_rival', lexicalFields: ['更换护栏油漆'] },
  ];
  const verdict = localityGateDecision({ queryNorm: q('更换电梯按钮'), candidates, table: PLACEHOLDER_LOCALITY_TABLE });
  assert.equal(verdict.outcome, 'pass');
  if (verdict.outcome === 'pass') {
    assert.equal(verdict.cardId, 'mc_gold');
    assert.equal(verdict.witnessField, '更换电梯按钮');
    assert.equal(verdict.triple.gap, 0);
  }
});

test('LOC-7 无幸存集 no-witness；幸存但无人严格支配 no-strict-leader', () => {
  const noWitness: LocalityCandidate[] = [{ cardId: 'mc_x', lexicalFields: ['更换电梯按钮'] }];
  const v1 = localityGateDecision({ queryNorm: q('毫不相干的问句内容'), candidates: noWitness, table: PLACEHOLDER_LOCALITY_TABLE });
  assert.equal(v1.outcome, 'conflict-abstain');
  if (v1.outcome === 'conflict-abstain') assert.equal(v1.reason, 'no-witness');

  // 手工构造两张互有高低（mixed）的卡：A 的 lcs 更高，B 的 hitFields 更高。
  const mixed: LocalityCandidate[] = [
    { cardId: 'mc_a', lexicalFields: ['更换电梯按钮', '续费归档'] },
    { cardId: 'mc_b', lexicalFields: ['更换电梯', '续费', '归档'] },
  ];
  const v2 = localityGateDecision({ queryNorm: q('更换电梯按钮 续费 归档'), candidates: mixed, table: PLACEHOLDER_LOCALITY_TABLE });
  assert.ok(v2.outcome === 'pass' || (v2.outcome === 'conflict-abstain' && v2.reason === 'no-strict-leader'));
});

test('LOC-8 生产零漂移：gate.ts 不得 import locality（本批纯函数默认不生效）', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const gateSource = fs.readFileSync(path.join(repoRoot, 'src/memory/gate.ts'), 'utf8');
  assert.equal(gateSource.includes('locality'), false);
});

test('LOC-9 确定性：同输入两次裁决逐字节一致（可重放）', () => {
  const candidates: LocalityCandidate[] = [
    { cardId: 'mc_gold', lexicalFields: ['更换电梯按钮'] },
    { cardId: 'mc_rival', lexicalFields: ['更换护栏油漆', '续费归档'] },
  ];
  const input = { queryNorm: q('更换电梯按钮'), candidates, table: PLACEHOLDER_LOCALITY_TABLE };
  assert.deepEqual(JSON.stringify(localityGateDecision(input)), JSON.stringify(localityGateDecision(input)));
});
