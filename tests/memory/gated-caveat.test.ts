/**
 * C2-甲 红测：门后栈机械 PASSED 的弃权警告印（193/194 号文书）。
 * 判决机对 wrong-abstain 不设门（预注册 v5 §6.2），全哑系统也可能打印 PASSED；
 * 本纯函数只生成警告文案、不参与任何判决，防的是人和下游误读。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gatedVerdictCaveat } from '../../src/memory/audit/gated-caveat.ts';

test('PASSED 且存在 wrong-abstain：返回含 wa 数与门后召回分数的警告', () => {
  const caveat = gatedVerdictCaveat({ verdict: 'PASSED', wrongAbstain: 345, answerableGold: 650, correctCommit: 201 });
  assert.ok(caveat !== null);
  assert.match(caveat, /wrong-abstain=345/);
  assert.match(caveat, /201\/650/);
});

test('PASSED 且 wa=0：无警告（真全对不噪音）', () => {
  assert.equal(gatedVerdictCaveat({ verdict: 'PASSED', wrongAbstain: 0, answerableGold: 650, correctCommit: 650 }), null);
});

test('NOT-PASSED/INCONCLUSIVE：不出本警告（失败本身已防误读）', () => {
  assert.equal(gatedVerdictCaveat({ verdict: 'NOT-PASSED', wrongAbstain: 10, answerableGold: 650, correctCommit: 300 }), null);
  assert.equal(gatedVerdictCaveat({ verdict: 'INCONCLUSIVE', wrongAbstain: 10, answerableGold: 0, correctCommit: 0 }), null);
});

test('零金标分母：不伪造召回分数，文案显式 N/A', () => {
  const caveat = gatedVerdictCaveat({ verdict: 'PASSED', wrongAbstain: 1, answerableGold: 0, correctCommit: 0 });
  assert.ok(caveat !== null);
  assert.match(caveat, /召回=N\/A/);
});
