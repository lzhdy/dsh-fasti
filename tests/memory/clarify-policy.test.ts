/**
 * 乙机制澄清决策器纯函数内核红测（#194，195 号评估文书 3.2）。
 * 第一版只做零阈值的结构性可裁决性判定：
 *  - 零过门卡 → ABSTAIN；恰好一张 → COMMIT（弱证据提名档未启用，不拍常数）；
 *  - ≥2 张且与第一名 GradedSignals 七字段精确全等 → ASK_MULTI（结构性打平，
 *    对应封存卷 S0 4 wc 与澄清 18/18 信号向量全等的实测形态）；
 *  - 否则严格序成立 → COMMIT（尊重生产排序，决策器不重排）。
 * NOMINATE_SINGLE 枚举预留待 P1 标定，本版任何输入都不可达。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideClarify } from '../../src/memory/clarify-policy.ts';
import type { ClarifyCandidate } from '../../src/memory/clarify-policy.ts';
import { applyGateV2 } from '../../src/memory/gate.ts';
import type { ExplainedRankedCard, GradedSignals, MemoryCard } from '../../src/memory/types.ts';

function sig(over: Partial<GradedSignals> = {}): GradedSignals {
  return { lcs: 5, unitCovered: 4, unitTotal: 4, hitFields: 1, strongFields: 1, minHitFieldLength: 6, maxHitFieldLength: 6, ...over };
}

function cand(cardId: string, signals: GradedSignals): ClarifyCandidate {
  return { cardId, signals };
}

test('零候选：ABSTAIN/no-candidate，编号数组为空且为新数组', () => {
  const verdict = decideClarify([]);
  assert.equal(verdict.action, 'ABSTAIN');
  assert.equal(verdict.reason, 'no-candidate');
  assert.deepEqual(verdict.candidateIds, []);
  assert.deepEqual(verdict.tiedCardIds, []);
});

test('单候选：COMMIT/single-candidate', () => {
  const verdict = decideClarify([cand('c1', sig())]);
  assert.equal(verdict.action, 'COMMIT');
  assert.equal(verdict.reason, 'single-candidate');
  assert.deepEqual(verdict.candidateIds, ['c1']);
  assert.deepEqual(verdict.tiedCardIds, []);
});

test('单候选即使信号全零也 COMMIT：弱证据 NOMINATE_SINGLE 档未启用，锁死零判据变化', () => {
  const zero = sig({ lcs: 0, unitCovered: 0, hitFields: 0, strongFields: 0, minHitFieldLength: 0, maxHitFieldLength: 0 });
  const verdict = decideClarify([cand('c1', zero)]);
  assert.equal(verdict.action, 'COMMIT');
  assert.equal(verdict.reason, 'single-candidate');
});

test('多候选信号有严格序：COMMIT/strict-order，决策器不重排、不造打平组', () => {
  const verdict = decideClarify([cand('c1', sig({ lcs: 6 })), cand('c2', sig({ lcs: 5 }))]);
  assert.equal(verdict.action, 'COMMIT');
  assert.equal(verdict.reason, 'strict-order');
  assert.deepEqual(verdict.candidateIds, ['c1', 'c2']);
  assert.deepEqual(verdict.tiedCardIds, []);
});

test('两候选七字段精确全等：ASK_MULTI/exact-signal-tie，两张皆入打平组并保持传入序', () => {
  const verdict = decideClarify([cand('c1', sig()), cand('c2', sig())]);
  assert.equal(verdict.action, 'ASK_MULTI');
  assert.equal(verdict.reason, 'exact-signal-tie');
  assert.deepEqual(verdict.tiedCardIds, ['c1', 'c2']);
  assert.deepEqual(verdict.candidateIds, ['c1', 'c2']);
});

test('打平组只收与第一名全等的卡：三候选前两张全等第三张不同，tie 恰为前两张', () => {
  const verdict = decideClarify([cand('c1', sig()), cand('c2', sig()), cand('c3', sig({ lcs: 4 }))]);
  assert.equal(verdict.action, 'ASK_MULTI');
  assert.deepEqual(verdict.tiedCardIds, ['c1', 'c2']);
});

test('七字段任一不同即不打平：逐字段扰动全部落 strict-order', () => {
  const fields = ['lcs', 'unitCovered', 'unitTotal', 'hitFields', 'strongFields', 'minHitFieldLength', 'maxHitFieldLength'] as const;
  for (const field of fields) {
    const verdict = decideClarify([cand('c1', sig()), cand('c2', sig({ [field]: (sig()[field] ?? 0) + 1 }))]);
    assert.equal(verdict.action, 'COMMIT', `${field} 扰动后不应判打平`);
    assert.equal(verdict.reason, 'strict-order');
  }
});

test('确定性与无突变：同输入同输出，不改输入数组，输出编号数组是独立副本', () => {
  const input = [cand('c1', sig()), cand('c2', sig())];
  const snapshot = JSON.parse(JSON.stringify(input)) as ClarifyCandidate[];
  const a = decideClarify(input);
  const b = decideClarify(input);
  assert.deepEqual(a, b);
  assert.deepEqual(input, snapshot);
  assert.notEqual(a.candidateIds, input);
  assert.notEqual(a.tiedCardIds, input);
});

// ── 不耦合门锁（纪律：决策器离线模拟用，生产门不得 import/携带其产物）──────────

const TEST_NOW_MS = 1_700_000_000_000;

function makeCard(n: number, displayCue: string): MemoryCard {
  return {
    cardId: `mc_cp_${n}`,
    eventId: `ev_cp_${n}`,
    anchorJson: JSON.stringify([`exp_cp_${n}`]),
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
    contentHash: `hash_cp_${n}`,
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
}

function overlapCandidate(n: number, field: string): ExplainedRankedCard {
  const card = makeCard(n, field);
  return { card, scoreParts: { bm25: 0, recency: 0 }, matchedTerms: [], matchKinds: ['fts-overlap'], cueText: field, lexicalFields: [field] };
}

test('不耦合门锁：applyGateV2 不读澄清决策，生产输出恒不携带澄清字段', () => {
  const candidates = [overlapCandidate(1, '除锈冰箱抽屉'), overlapCandidate(2, '除锈冰箱抽屉板')];
  const plain = applyGateV2({ qNorm: '除锈冰箱抽', candidates, atMs: TEST_NOW_MS, limit: 2 });

  const injected = candidates.map((candidate) => ({ ...candidate, clarifyAction: 'ASK_MULTI' })) as unknown as ExplainedRankedCard[];
  const withFake = applyGateV2({ qNorm: '除锈冰箱抽', candidates: injected, atMs: TEST_NOW_MS, limit: 2 });

  assert.equal(withFake.status, plain.status);
  assert.deepEqual(withFake.accepted.map((c) => c.card.cardId), plain.accepted.map((c) => c.card.cardId));
  assert.deepEqual(withFake.rejected.map((c) => c.gateReasons), plain.rejected.map((c) => c.gateReasons));
  for (const card of [...plain.accepted, ...plain.rejected]) {
    assert.equal('clarifyAction' in card, false);
  }
});
