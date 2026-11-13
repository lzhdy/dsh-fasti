/**
 * gate.ts 确定性布尔通道门测试（#44，TDD）。
 * 覆盖：词边界表驱动反例（含登记的标点残余）、强/弱通道裁决、三态原因码、全集过滤后截断不凑数、
 * 序号映射、纯函数不突变输入，以及 N3 规范化与 bm25.normalizeQuery 的同构锁定。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeQuery } from '../../src/memory/bm25.ts';
import {
  GATE_POLICY,
  applyGate,
  hasAsciiWordBoundary,
  normalizeLexicalText,
} from '../../src/memory/gate.ts';
import type { ExplainedRankedCard, GatedRankedCard, MatchKind, MemoryCard } from '../../src/memory/types.ts';

let seq = 0;

function makeCard(partial: Partial<MemoryCard> = {}): MemoryCard {
  seq += 1;
  const n = seq;
  return {
    cardId: `mc_test_${String(n).padStart(3, '0')}`,
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
    occurredMs: 1000,
    endedMs: 1000,
    validMs: 1000,
    invalidMs: null,
    createdMs: 1000,
    expiredMs: null,
    status: 'active',
    contentHash: `hash_${n}`,
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
    ...partial,
  };
}

function makeRanked(
  partial: Partial<ExplainedRankedCard> & Pick<ExplainedRankedCard, 'matchKinds'>,
): ExplainedRankedCard {
  return {
    card: makeCard(partial.card),
    scoreParts: { bm25: 0, recency: 0 },
    matchedTerms: [],
    cueText: undefined,
    ...partial,
  };
}

const exact = (termNorm: string): ExplainedRankedCard =>
  makeRanked({ matchKinds: ['exact-alias'], matchedTerms: [termNorm] });
const fts = (cueText: string): ExplainedRankedCard =>
  makeRanked({ matchKinds: ['fts-substring'], cueText });
const like = (termNorm: string): ExplainedRankedCard =>
  makeRanked({ matchKinds: ['like-fallback'], matchedTerms: [termNorm] });

// ── 词边界纯函数（提案 §5.2.1 反例表，入参均为已规范化小写串）──────────────

test('hasAsciiWordBoundary：表驱动反例（含已知标点残余，逐行对齐提案）', () => {
  const cases: Array<[string, string, boolean, string]> = [
    ['git', 'github', false, '后邻 h 属 TOKEN，非边界 → 拒'],
    ['git', '用git提交', true, '前后邻中文非 TOKEN → 过'],
    ['github', '用github提交', true, '中文邻居为边界 → 过'],
    ['git', 'git hub', true, '串首 + 空格邻居 → 过'],
    ['git', 'a-git-b', true, '残余：连字符非 TOKEN，登记不过度收口'],
    ['v1', 'v1.2', true, '残余：点号非 TOKEN'],
    ['cat', 'cat.log', true, '残余：点号非 TOKEN'],
  ];
  for (const [q, hay, expected, note] of cases) {
    assert.equal(hasAsciiWordBoundary(q, hay), expected, `${q} ⊂ ${hay}：${note}`);
  }
});

test('hasAsciiWordBoundary：查询含非 ASCII（CJK）→ 边界 N/A 直通', () => {
  assert.equal(hasAsciiWordBoundary('记账', '随手记账本'), true);
  assert.equal(hasAsciiWordBoundary('メモ', 'メモ帳'), true);
});

test('hasAsciiWordBoundary：多次出现任一成立即过；全部非边界才拒', () => {
  assert.equal(hasAsciiWordBoundary('git', 'github 用 git 提交'), true, '第二处是边界');
  assert.equal(hasAsciiWordBoundary('git', 'github gitlab'), false, '两处后邻都是 TOKEN');
  assert.equal(hasAsciiWordBoundary('git', 'git'), true, '整串严格相等，首尾皆边界');
});

test('N3 同构锁定：normalizeLexicalText 与 bm25.normalizeQuery 在各类输入下逐字相等', () => {
  const samples = ['Git', '  GIT ', 'ＧＩＴ', 'Ｇｉｔ hub', '记账 Book', 'a　b', 'mixedCase123_', ''];
  for (const sample of samples) {
    assert.equal(normalizeLexicalText(sample), normalizeQuery(sample), `同构失败：${JSON.stringify(sample)}`);
  }
  assert.ok(GATE_POLICY.asciiWordBoundary === true);
});

// ── 三态与原因码 ──────────────────────────────────────────────────────────

test('applyGate：规范化空查询 → no-match/empty-query', () => {
  const out = applyGate({ qNorm: '', candidates: [exact('git')] });
  assert.equal(out.status, 'no-match');
  assert.equal(out.reason, 'empty-query');
  assert.deepEqual(out.accepted, []);
  assert.equal(out.serialMap.size, 0);
});

test('applyGate：有查询零词面候选 → no-match/zero-lexical-hit', () => {
  const out = applyGate({ qNorm: 'git', candidates: [] });
  assert.equal(out.status, 'no-match');
  assert.equal(out.reason, 'zero-lexical-hit');
});

test('applyGate：候选全落弱通道/非边界 → abstain/all-rejected，候选保留在 rejected 不静默丢弃', () => {
  const candidates = [like('github'), like('gitlab'), fts('github')];
  const out = applyGate({ qNorm: 'git', candidates });
  assert.equal(out.status, 'abstain');
  assert.equal(out.reason, 'all-rejected');
  assert.equal(out.accepted.length, 0);
  assert.equal(out.rejected.length, 3);
  assert.deepEqual(
    out.rejected.map((r) => r.gateReasons[0]),
    ['like-only-weak-match', 'like-only-weak-match', 'ascii-no-word-boundary'],
  );
});

// ── 强通道裁决 ────────────────────────────────────────────────────────────

test('applyGate：exact-alias 规范化后严格等值恒过（含 sensitive=1 仅精确路可达）', () => {
  const sensitive = makeRanked({ matchKinds: ['exact-alias'], matchedTerms: ['秘密代号'] });
  const out = applyGate({ qNorm: '秘密代号', candidates: [sensitive] });
  assert.equal(out.status, 'hit');
  assert.equal(out.accepted[0]?.gateReasons[0], 'exact-alias-pass');
});

test('applyGate：同卡 exact+弱通道并存，exact 优先恒过、弱通道不影响', () => {
  const both = makeRanked({ matchKinds: ['exact-alias', 'like-fallback'], matchedTerms: ['git'] });
  const out = applyGate({ qNorm: 'git', candidates: [both] });
  assert.equal(out.accepted.length, 1);
  assert.equal(out.accepted[0]?.gateReasons[0], 'exact-alias-pass');
});

test('applyGate：fts-substring 过词边界 → accept；不过 → 拒并给原因码', () => {
  const pass = applyGate({ qNorm: 'git', candidates: [fts('用 git 提交')] });
  assert.equal(pass.status, 'hit');
  assert.equal(pass.accepted[0]?.gateReasons[0], 'fts-word-boundary-pass');

  const blocked = applyGate({ qNorm: 'git', candidates: [fts('github')] });
  assert.equal(blocked.status, 'abstain');
  assert.equal(blocked.rejected[0]?.gateReasons[0], 'ascii-no-word-boundary');
});

test('applyGate：fts 候选却缺 cueText → 保守拒绝（宁空勿错），原因 missing-cue-text', () => {
  const broken = makeRanked({ matchKinds: ['fts-substring'], cueText: undefined });
  const out = applyGate({ qNorm: 'git', candidates: [broken] });
  assert.equal(out.status, 'abstain');
  assert.equal(out.rejected[0]?.gateReasons[0], 'missing-cue-text');
});

test('applyGate：N3 全角/混大小写查询经规范化后与小写 haystack 同口径判定', () => {
  // 编排层先用 normalizeQuery 把全角查询规范成 git；门只收 qNorm。
  const qNorm = normalizeQuery('ＧＩＴ');
  assert.equal(qNorm, 'git');
  const out = applyGate({ qNorm, candidates: [fts('Git 流程')] });
  assert.equal(out.status, 'hit');
});

// ── 全集过滤后再截断、动态 top-k 不凑数、序号 ─────────────────────────────

test('applyGate：先在全集上过滤，再按 limit 截断；弱尾不补位，rejected 不截断，序号对截断后 accepted 1..n', () => {
  // 两张强通道（保序排在前），三张弱通道；limit=2 时 accepted 恰为 2，不用弱卡凑数。
  const strong1 = exact('git');
  const strong2 = fts('用 git 提交');
  const weak = [like('github'), like('gitlab'), fts('github')];
  const candidates: ExplainedRankedCard[] = [strong1, strong2, ...weak];
  const out = applyGate({ qNorm: 'git', candidates, limit: 2 });

  assert.equal(out.status, 'hit');
  assert.equal(out.accepted.length, 2, 'limit 截断到 2 张强卡');
  assert.equal(out.rejected.length, 3, '被拒全集保留，不截断');
  assert.deepEqual(
    out.accepted.map((c) => c.card.cardId),
    [strong1.card.cardId, strong2.card.cardId],
  );
  assert.deepEqual([...out.serialMap.keys()], [1, 2]);
  assert.equal(out.serialMap.get(1), strong1.card.cardId);
  assert.equal(out.serialMap.get(2), strong2.card.cardId);
});

test('applyGate：不传 limit 时 accepted 保留全部过门卡，序号连续', () => {
  const out = applyGate({ qNorm: 'git', candidates: [exact('git'), fts('git 工具'), like('github')] });
  assert.equal(out.accepted.length, 2);
  assert.deepEqual([...out.serialMap.keys()], [1, 2]);
});

test('applyGate：纯函数确定性且不突变输入（深冻结候选，两次结果独立且相等）', () => {
  const candidates = Object.freeze([Object.freeze(exact('git')), Object.freeze(like('github'))]);
  const first = applyGate({ qNorm: 'git', candidates: candidates as readonly ExplainedRankedCard[] });
  const second = applyGate({ qNorm: 'git', candidates: candidates as readonly ExplainedRankedCard[] });
  assert.equal(first.status, second.status);
  assert.deepEqual(first.accepted.map((c) => c.card.cardId), second.accepted.map((c) => c.card.cardId));
  // 返回数组是新构建的，不复用输入引用。
  assert.notEqual(first.accepted, second.accepted);
  const gated: GatedRankedCard = first.accepted[0] as GatedRankedCard;
  assert.equal(gated.evidence, undefined, '第一层 evidence 占位恒 undefined');
});
