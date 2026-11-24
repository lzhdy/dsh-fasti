/**
 * 终判判据 v2 红测（预注册 v5 §5.1–§5.4、§6.2、§6.3）。
 * 锁死四条最容易被接错的口径：S5 不进 R1、R2 三类明细、L_S* 只判 wc=0、澄清 18 条只披露不设门。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeV2 } from '../../src/memory/audit/judgment-v2.ts';
import type { LayerProbeV2, DecoyProbeV2, AbstainProbeV2, ClarifyProbeV2 } from '../../src/memory/audit/judgment-v2.ts';

function goldProbes(layer: 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5', count: number, mode: 'hit' | 'abstain' | 'wrong'): LayerProbeV2[] {
  const out: LayerProbeV2[] = [];
  for (let i = 0; i < count; i += 1) {
    const eventId = `ev-${layer}-${i}`;
    out.push({
      layer,
      eventId,
      hit: mode === 'hit',
      highRisk: false,
      committed: mode !== 'abstain',
      top1IsGold: mode === 'hit',
    });
  }
  return out;
}

function decoyProbes(kind: DecoyProbeV2['kind'], count: number, wrong: number): DecoyProbeV2[] {
  return Array.from({ length: count }, (_, i) => ({ kind, correct: i >= wrong, highRiskError: false }));
}

function abstainProbes(kind: 'unanswerable' | 'noise', count: number, wrongCommit: number): AbstainProbeV2[] {
  return Array.from({ length: count }, (_, i) =>
    kind === 'unanswerable'
      ? { kind, committed: i < wrongCommit, top1IsGold: false }
      : { kind, committed: i >= wrongCommit, top1IsGold: i >= wrongCommit },
  );
}

const CLARIFY: ClarifyProbeV2[] = Array.from({ length: 18 }, (_, i) => ({
  query: `q-${i}`,
  committed: i >= 10,
  top1IsGold: false,
  top1IsDecoy: i >= 13,
}));

/** 全绿基线：300 题 R1 宏全中、四层 wc=0、R2 全对、弃权 100%、澄清 18 条。 */
function greenV2() {
  return {
    gold: [
      ...goldProbes('S0', 150, 'hit'),
      ...goldProbes('S1', 150, 'hit'),
      ...goldProbes('S2', 50, 'hit'),
      ...goldProbes('S3', 50, 'hit'),
      ...goldProbes('S4', 50, 'hit'),
      ...goldProbes('S5', 100, 'hit'),
    ],
    decoy: [
      ...decoyProbes('same-family', 114, 0),
      ...decoyProbes('cross-family-collision', 50, 0),
      ...decoyProbes('cross-family-detail-reuse', 36, 0),
    ],
    abstain: [...abstainProbes('unanswerable', 100, 0), ...abstainProbes('noise', 100, 0)],
    clarify: CLARIFY,
  };
}

test('R1 宏只取 S0+S1：S5 全 miss 也不动 R1 宏与 R1_S0', {
  skip: false,
}, (t) => {
  const base = greenV2();
  const judgment = judgeV2(base, { seed: 20261111 });
  const withS5Miss = judgeV2({ ...base, gold: [...base.gold.filter((p) => p.layer !== 'S5'), ...goldProbes('S5', 100, 'abstain')] }, { seed: 20261111 });
  assert.ok('point' in judgment.r1Macro && judgment.r1Macro.point === 1);
  assert.ok('point' in withS5Miss.r1Macro && withS5Miss.r1Macro.point === 1);
  assert.equal(withS5Miss.verdict, 'PASSED');
  t.diagnostic(`R1宏 point=${'point' in judgment.r1Macro ? judgment.r1Macro.point : 'N/A'}`);
});

test('S5 只判 wc=0：wrong-abstain 只登记；wrong-commit 使 L_S5 假', () => {
  const base = greenV2();
  const allAbstain = judgeV2({ ...base, gold: [...base.gold.filter((p) => p.layer !== 'S5'), ...goldProbes('S5', 100, 'abstain')] }, { seed: 1 });
  assert.equal(allAbstain.gates.L_S5, true);
  assert.equal(allAbstain.layers.S5?.wrongAbstain, 100);

  const oneWrong = judgeV2({ ...base, gold: [...base.gold.filter((p) => p.layer !== 'S5'), ...goldProbes('S5', 100, 'hit').slice(1), { layer: 'S5', eventId: 'ev-s5-bad', hit: false, highRisk: false, committed: true, top1IsGold: false }] }, { seed: 1 });
  assert.equal(oneWrong.gates.L_S5, false);
  assert.equal(oneWrong.verdict, 'NOT-PASSED');
});

test('R2：整体 200 对作门，三类比率必报；某类越线只告警不改门', () => {
  const base = greenV2();
  // 整体恰好 10/200=0.05，其中细节复用档 5/36≈0.139 越线
  const decoy = [
    ...decoyProbes('same-family', 114, 5),
    ...decoyProbes('cross-family-collision', 50, 0),
    ...decoyProbes('cross-family-detail-reuse', 36, 5),
  ];
  const judgment = judgeV2({ ...base, decoy }, { seed: 2 });
  const overall = 'point' in judgment.r2 ? judgment.r2.point : -1;
  assert.ok(Math.abs(overall - 0.05) < 1e-9, `整体应为 0.05，实际 ${overall}`);
  assert.equal(judgment.gates.r2, true, '整体门按 200 对判定');
  assert.ok(judgment.r2ByKind['cross-family-detail-reuse'] && 'point' in judgment.r2ByKind['cross-family-detail-reuse']);
  assert.ok(judgment.notes.some((n) => n.includes('cross-family-detail-reuse')), '三类明细越线须告警');
});

test('R2 高危错认 >0 直接否门', () => {
  const base = greenV2();
  const decoy = [...base.decoy.slice(1), { ...base.decoy[0]!, highRiskError: true }];
  const judgment = judgeV2({ ...base, decoy }, { seed: 3 });
  assert.equal(judgment.decoyHighRiskErrors, 1);
  assert.equal(judgment.gates.r2, false);
});

test('弃权：unanswerable 须 100%；noise 三态只登记', () => {
  const base = greenV2();
  const bad = judgeV2({ ...base, abstain: abstainProbes('unanswerable', 100, 1).concat(abstainProbes('noise', 100, 0)) }, { seed: 4 });
  assert.equal(bad.gates.abstain, false);
  const good = judgeV2(base, { seed: 4 });
  assert.equal(good.abstain.unanswerable.correctAbstain, 100);
  assert.equal(good.abstain.noise.correctCommit, 100);
  assert.equal(good.gates.abstain, true);
  // noise 三态计数（错误提交须单列）
  const noisy = judgeV2({ ...base, abstain: abstainProbes('unanswerable', 100, 0).concat(abstainProbes('noise', 100, 40)) }, { seed: 4 });
  assert.equal(noisy.abstain.noise.wrongAbstain, 40);
});

test('澄清 18 条：只披露不进分母，统计「澄清/低置信」与「自信给卡（含诱饵置顶）」', () => {
  const base = greenV2();
  const judgment = judgeV2(base, { seed: 5 });
  assert.equal(judgment.clarify.rows.length, 18);
  assert.equal(judgment.clarify.clarified, 10);
  assert.equal(judgment.clarify.confidentCard, 8);
  assert.equal(judgment.clarify.decoyTop1, 5);
  // 澄清档不参与任何门：把它全换成「自信给卡」不影响判决
  const allConfident = judgeV2({ ...base, clarify: CLARIFY.map((c) => ({ ...c, committed: true, top1IsDecoy: true })) }, { seed: 5 });
  assert.equal(allConfident.verdict, judgment.verdict);
  assert.equal(allConfident.gates.r2, judgment.gates.r2);
});

test('精度未闭环 → INCONCLUSIVE（样本簇不足或半宽越线），不得有条件通过', () => {
  const base = greenV2();
  // 只给 10 个簇的 S0/S1
  const thin = {
    ...base,
    gold: [
      ...Array.from({ length: 10 }, (_, i): LayerProbeV2 => ({ layer: 'S0', eventId: `ev-thin-${i}`, hit: true, highRisk: false, committed: true, top1IsGold: true })),
      ...Array.from({ length: 10 }, (_, i): LayerProbeV2 => ({ layer: 'S1', eventId: `ev-thin1-${i}`, hit: true, highRisk: false, committed: true, top1IsGold: true })),
      ...base.gold.filter((p) => !['S0', 'S1'].includes(p.layer)),
    ],
  };
  const judgment = judgeV2(thin, { seed: 6 });
  assert.equal(judgment.verdict, 'INCONCLUSIVE');
  assert.ok(judgment.notes.some((n) => n.includes('簇数')));
});

test('合取式：全绿 PASSED；任一层失败即 NOT-PASSED；同种子逐字可复现', () => {
  const base = greenV2();
  const pass = judgeV2(base, { seed: 7 });
  assert.equal(pass.verdict, 'PASSED');
  assert.deepEqual(judgeV2(base, { seed: 7 }), pass);

  const s4Wrong = judgeV2(
    {
      ...base,
      gold: [...base.gold.filter((p) => p.layer !== 'S4'), ...goldProbes('S4', 49, 'hit'), { layer: 'S4', eventId: 'ev-s4-bad', hit: false, highRisk: true, committed: true, top1IsGold: false }],
    },
    { seed: 7 },
  );
  assert.equal(s4Wrong.gates.L_S4, false);
  assert.equal(s4Wrong.layers.S4?.highRiskWrongCommit, 1);
  assert.equal(s4Wrong.verdict, 'NOT-PASSED');
});
