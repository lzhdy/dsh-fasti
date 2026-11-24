/**
 * P0 分级词面信号留痕底座红测（194 号设计稿第四节 P0）。
 * 纯整数信号：LCS 码点、单元覆盖 c/m、字段分布。不参与任何裁决或排序。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gradedLexicalSignals } from '../../src/memory/lexical-signals.ts';
import { applyGateV2 } from '../../src/memory/gate.ts';
import type { ExplainedRankedCard, MemoryCard } from '../../src/memory/types.ts';

const EMPTY = { lcs: 0, unitCovered: 0, unitTotal: 0, hitFields: 0, strongFields: 0, minHitFieldLength: 0, maxHitFieldLength: 0 };

test('CJK 字段差一两个字：LCS 记整段连续码点，覆盖率按单元分子分母留痕', () => {
  // q 四单元：除锈/锈冰/冰箱/箱抽；字段「除锈冰箱抽屉」中「箱」「抽」恰好相邻，故 4/4 全覆盖——
  // 这正是 194 实测 S1 截断面「覆盖率满、LCS 差一两个字」的形态。
  const s = gradedLexicalSignals('除锈冰箱抽', ['除锈冰箱抽屉']);
  assert.equal(s.lcs, 5);
  assert.equal(s.unitTotal, 4);
  assert.equal(s.unitCovered, 4);
  assert.equal(s.hitFields, 1);
  assert.equal(s.strongFields, 1);
  assert.equal(s.minHitFieldLength, 6);
  assert.equal(s.maxHitFieldLength, 6);

  // 换成「除锈冰箱门」：单元「箱抽」不再存在，覆盖率留下 3/4 的缺口。
  const partial = gradedLexicalSignals('除锈冰箱抽', ['除锈冰箱门']);
  assert.equal(partial.unitTotal, 4);
  assert.equal(partial.unitCovered, 3);
});

test('拉丁整词：单元为整词，LCS 含词间空格仍按码点计', () => {
  const s = gradedLexicalSignals('Replace Faucet', ['replace faucet']);
  assert.equal(s.unitTotal, 2);
  assert.equal(s.unitCovered, 2);
  assert.equal(s.lcs, 14);
  assert.equal(s.hitFields, 1);
});

test('空格变体：空白折叠但不吞空格，跨空格连续片段断开', () => {
  const s = gradedLexicalSignals('除锈 冰箱', ['除锈冰箱']);
  assert.equal(s.unitTotal, 2);
  assert.equal(s.unitCovered, 2);
  assert.equal(s.lcs, 2);
});

test('空字段集与空查询：空查询全零；无字段时单元总数仍如实留痕、其余为零', () => {
  assert.deepEqual(gradedLexicalSignals('除锈冰箱', []), { ...EMPTY, unitTotal: 3 });
  assert.deepEqual(gradedLexicalSignals('', ['除锈冰箱']), EMPTY);
  assert.deepEqual(gradedLexicalSignals('   ', ['除锈冰箱']), EMPTY);
});

test('单字 CJK 边界：孤立单字发 unigram，LCS=1 不计强字段', () => {
  const s = gradedLexicalSignals('阀', ['阀']);
  assert.equal(s.unitTotal, 1);
  assert.equal(s.unitCovered, 1);
  assert.equal(s.lcs, 1);
  assert.equal(s.strongFields, 0);
});

test('字段分布：强字段计数与最短最长命中字段分开留痕', () => {
  const s = gradedLexicalSignals('更换水管接头', ['更换水管接头', '水管接头', '无关字段']);
  assert.equal(s.lcs, 6);
  assert.equal(s.hitFields, 2);
  assert.equal(s.strongFields, 2);
  assert.equal(s.minHitFieldLength, 4);
  assert.equal(s.maxHitFieldLength, 6);
});

test('确定性：同输入同输出，字段顺序不影响最优值', () => {
  const a = gradedLexicalSignals('除锈冰箱抽', ['无关', '除锈冰箱抽屉', '冰箱抽屉']);
  const b = gradedLexicalSignals('除锈冰箱抽', ['冰箱抽屉', '除锈冰箱抽屉', '无关']);
  assert.deepEqual(a, b);
});

// ── 不耦合门锁（P0 纪律：留痕只读，不得接进裁决）────────────────────────

const TEST_NOW_MS = 1_700_000_000_000;

function makeCard(n: number, displayCue: string): MemoryCard {
  return {
    cardId: `mc_p0_${n}`,
    eventId: `ev_p0_${n}`,
    anchorJson: JSON.stringify([`exp_p0_${n}`]),
    channel: 'main',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson: JSON.stringify([displayCue]),
    aliasesJson: JSON.stringify([]),
    discriminator: '',
    entityHintJson: null,
    occurredMs: 1000,
    endedMs: 1000,
    validMs: 1000,
    invalidMs: null,
    createdMs: 1000,
    expiredMs: null,
    status: 'active',
    contentHash: `hash_p0_${n}`,
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
}

function overlapCandidate(n: number, field: string): ExplainedRankedCard {
  const card = makeCard(n, field);
  const lexicalFields = [field];
  return { card, scoreParts: { bm25: 0, recency: 0 }, matchedTerms: [], matchKinds: ['fts-overlap'], cueText: field, lexicalFields };
}

test('不耦合门锁：applyGateV2 不读 gradedSignals，且生产输出恒不填该字段', () => {
  const candidates = [overlapCandidate(1, '除锈冰箱抽屉'), overlapCandidate(2, '无关卡片')];
  const plain = applyGateV2({ qNorm: '除锈冰箱抽', candidates, atMs: TEST_NOW_MS, limit: 1 });

  // 人为在候选上塞伪造留痕值：若判决读它，结果就会漂移。
  const injected = candidates.map((candidate) => ({
    ...candidate,
    gradedSignals: { lcs: 999, unitCovered: 0, unitTotal: 0, hitFields: 0, strongFields: 0, minHitFieldLength: 0, maxHitFieldLength: 0 },
  })) as unknown as ExplainedRankedCard[];
  const withFake = applyGateV2({ qNorm: '除锈冰箱抽', candidates: injected, atMs: TEST_NOW_MS, limit: 1 });

  assert.equal(withFake.status, plain.status);
  assert.deepEqual(withFake.accepted.map((c) => c.card.cardId), plain.accepted.map((c) => c.card.cardId));
  assert.deepEqual(withFake.rejected.map((c) => c.card.cardId), plain.rejected.map((c) => c.card.cardId));
  assert.deepEqual(withFake.rejected.map((c) => c.gateReasons), plain.rejected.map((c) => c.gateReasons));

  // 生产门路径不产生留痕字段（零热路径开销）：留痕只能由审计侧自行附加。
  assert.equal(plain.accepted.every((c) => c.gradedSignals === undefined), true);
  assert.equal(plain.rejected.every((c) => c.gradedSignals === undefined), true);
});
