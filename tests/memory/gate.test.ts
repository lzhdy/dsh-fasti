/**
 * gate.ts 确定性布尔通道门测试（#44，TDD）。
 * 覆盖：词边界表驱动反例（含登记的标点残余）、强/弱通道裁决、三态原因码、全集过滤后截断不凑数、
 * 序号映射、纯函数不突变输入，以及 N3 规范化与 bm25.normalizeQuery 的同构锁定。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeBigramText } from '../../src/memory/bigram.ts';
import { normalizeQuery } from '../../src/memory/bm25.ts';
import {
  GATE_POLICY,
  GATE_POLICY_V2,
  applyGate,
  applyGateV1,
  applyGateV2,
  hasAsciiWordBoundary,
  normalizeLexicalText,
} from '../../src/memory/gate.ts';
import { CURRENT_RULES_VERSION } from '../../src/memory/types.ts';
import type { ExplainedRankedCard, GatedRankedCard, MatchKind, MemoryCard } from '../../src/memory/types.ts';

/** #129 门入参注入时钟（固定值，禁系统时钟，保证可重放）。 */
const TEST_NOW_MS = 1_700_000_000_000;

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
// #126 rules-v2 宽召回候选：携带结构化词面字段供反向包含逐字段裁决。
const overlap = (lexicalFields: string[]): ExplainedRankedCard =>
  makeRanked({ matchKinds: ['fts-overlap'], cueText: lexicalFields.join(' '), lexicalFields });

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

test('N3 同构锁定：gate / bm25 / bigram 三方归一化在各类输入下逐字相等（#124 红测11）', () => {
  const samples = ['Git', '  GIT ', 'ＧＩＴ', 'Ｇｉｔ hub', '记账 Book', 'a　b', 'mixedCase123_', ''];
  for (const sample of samples) {
    assert.equal(normalizeLexicalText(sample), normalizeQuery(sample), `同构失败：${JSON.stringify(sample)}`);
    assert.equal(normalizeLexicalText(sample), normalizeBigramText(sample), `bigram 同构失败：${JSON.stringify(sample)}`);
  }
  assert.ok(GATE_POLICY.asciiWordBoundary === true);
});

test('#124 红测11 静态扫描：gate/rules 不引用任何索引几何常量或 bigram/bm25 模块（B8 依赖方向）', () => {
  const gateSource = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/memory/gate.ts'),
    'utf8',
  );
  assert.ok(!/MIN_FTS_CODEPOINTS|MIN_TRIGRAM_LENGTH/.test(gateSource), 'gate 不得出现几何阈值常量');
  assert.ok(!/from '\.\/bigram\.ts'/.test(gateSource), 'gate 不得 import bigram 纯函数模块');
  assert.ok(!/from '\.\/bm25\.ts'/.test(gateSource), 'gate 不得 import bm25（无环纪律，裁决独立于索引几何）');
  // #126 R-07：v2 裁决不得反向依赖任何 FTS 短语构造，门只做字符串级反向包含。
  assert.ok(!/ftsPhraseOf|ftsOrExprOf/.test(gateSource), 'gate 不得引用索引 MATCH 表达式构造函数');
});

// ── 三态与原因码 ──────────────────────────────────────────────────────────

test('applyGate：规范化空查询 → no-match/empty-query', () => {
  const out = applyGate({ atMs: TEST_NOW_MS, qNorm: '', candidates: [exact('git')] });
  assert.equal(out.status, 'no-match');
  assert.equal(out.reason, 'empty-query');
  assert.deepEqual(out.accepted, []);
  assert.equal(out.serialMap.size, 0);
});

test('applyGate：有查询零词面候选 → no-match/zero-lexical-hit', () => {
  const out = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: [] });
  assert.equal(out.status, 'no-match');
  assert.equal(out.reason, 'zero-lexical-hit');
});

test('applyGate：候选全落弱通道/非边界 → abstain/all-rejected，候选保留在 rejected 不静默丢弃', () => {
  const candidates = [like('github'), like('gitlab'), fts('github')];
  const out = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates });
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
  const out = applyGate({ atMs: TEST_NOW_MS, qNorm: '秘密代号', candidates: [sensitive] });
  assert.equal(out.status, 'hit');
  assert.equal(out.accepted[0]?.gateReasons[0], 'exact-alias-pass');
});

test('applyGate：同卡 exact+弱通道并存，exact 优先恒过、弱通道不影响', () => {
  const both = makeRanked({ matchKinds: ['exact-alias', 'like-fallback'], matchedTerms: ['git'] });
  const out = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: [both] });
  assert.equal(out.accepted.length, 1);
  assert.equal(out.accepted[0]?.gateReasons[0], 'exact-alias-pass');
});

test('applyGate：fts-substring 过词边界 → accept；不过 → 拒并给原因码', () => {
  const pass = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: [fts('用 git 提交')] });
  assert.equal(pass.status, 'hit');
  assert.equal(pass.accepted[0]?.gateReasons[0], 'fts-word-boundary-pass');

  const blocked = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: [fts('github')] });
  assert.equal(blocked.status, 'abstain');
  assert.equal(blocked.rejected[0]?.gateReasons[0], 'ascii-no-word-boundary');
});

test('applyGate：fts 候选却缺 cueText → 保守拒绝（宁空勿错），原因 missing-cue-text', () => {
  const broken = makeRanked({ matchKinds: ['fts-substring'], cueText: undefined });
  const out = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: [broken] });
  assert.equal(out.status, 'abstain');
  assert.equal(out.rejected[0]?.gateReasons[0], 'missing-cue-text');
});

test('applyGate：N3 全角/混大小写查询经规范化后与小写 haystack 同口径判定', () => {
  // 编排层先用 normalizeQuery 把全角查询规范成 git；门只收 qNorm。
  const qNorm = normalizeQuery('ＧＩＴ');
  assert.equal(qNorm, 'git');
  const out = applyGate({ atMs: TEST_NOW_MS, qNorm, candidates: [fts('Git 流程')] });
  assert.equal(out.status, 'hit');
});

// ── 全集过滤后再截断、动态 top-k 不凑数、序号 ─────────────────────────────

test('applyGate：先在全集上过滤，再按 limit 截断；弱尾不补位，rejected 不截断，序号对截断后 accepted 1..n', () => {
  // 两张强通道（保序排在前），三张弱通道；limit=2 时 accepted 恰为 2，不用弱卡凑数。
  const strong1 = exact('git');
  const strong2 = fts('用 git 提交');
  const weak = [like('github'), like('gitlab'), fts('github')];
  const candidates: ExplainedRankedCard[] = [strong1, strong2, ...weak];
  const out = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates, limit: 2 });

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
  const out = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: [exact('git'), fts('git 工具'), like('github')] });
  assert.equal(out.accepted.length, 2);
  assert.deepEqual([...out.serialMap.keys()], [1, 2]);
});

test('applyGate：纯函数确定性且不突变输入（深冻结候选，两次结果独立且相等）', () => {  const candidates = Object.freeze([Object.freeze(exact('git')), Object.freeze(like('github'))]);
  const first = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: candidates as readonly ExplainedRankedCard[] });
  const second = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: candidates as readonly ExplainedRankedCard[] });
  assert.equal(first.status, second.status);
  assert.deepEqual(first.accepted.map((c) => c.card.cardId), second.accepted.map((c) => c.card.cardId));
  // 返回数组是新构建的，不复用输入引用。
  assert.notEqual(first.accepted, second.accepted);
  const gated: GatedRankedCard = first.accepted[0] as GatedRankedCard;
  assert.equal(gated.evidence, undefined, '第一层 evidence 占位恒 undefined');
});

test('applyGate（#114）：candidateCount 恒为门过滤前入参全集长度，四个分支与 limit 均不改写', () => {
  // 空查询分支：即便带候选，计数仍如实反映入参全集。
  assert.equal(applyGate({ atMs: TEST_NOW_MS, qNorm: '', candidates: [exact('git')] }).candidateCount, 1);
  // 零候选分支：0 表示真实无候选（区别于读取器侧无法重建的 null）。
  assert.equal(applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: [] }).candidateCount, 0);
  // 全拒分支：accepted 为空不影响全集计数。
  const blocked = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: [like('github'), like('gitlab')] });
  assert.equal(blocked.status, 'abstain');
  assert.equal(blocked.candidateCount, 2);

  // 同一夹具：两张强通道过门，limit 只切 accepted，计数恒为 3。
  const fixture = [exact('git'), fts('git 工具'), like('github')];
  const unlimited = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: fixture });
  const limited = applyGate({ atMs: TEST_NOW_MS, qNorm: 'git', candidates: fixture, limit: 1 });
  assert.equal(unlimited.accepted.length, 2);
  assert.equal(limited.accepted.length, 1, 'limit=1 仅截断 accepted');
  assert.equal(unlimited.candidateCount, 3);
  assert.equal(limited.candidateCount, 3, 'candidateCount 不受 limit 影响');
});

// #126 R-06 版本分派：CURRENT 冻结 rules-v1 时，门分派壳与具名 applyGateV1 逐字节等价 ──────────

test('R-06 版本分派：CURRENT_RULES_VERSION 冻结为 rules-v1，门分派壳与 applyGateV1 深相等', () => {
  assert.equal(CURRENT_RULES_VERSION, 'rules-v1');
  const fixtures: Array<{ atMs: number; qNorm: string; candidates: ExplainedRankedCard[] }> = [
    { atMs: TEST_NOW_MS, qNorm: '', candidates: [exact('git')] },
    { atMs: TEST_NOW_MS, qNorm: 'git', candidates: [] },
    { atMs: TEST_NOW_MS, qNorm: 'git', candidates: [like('github'), like('gitlab')] },
    { atMs: TEST_NOW_MS, qNorm: 'git', candidates: [exact('git'), fts('git 工具'), like('github')] },
    { atMs: TEST_NOW_MS, qNorm: '咖啡馆', candidates: [fts('周末咖啡馆约会')] },
  ];
  for (const fixture of fixtures) {
    assert.deepEqual(applyGate(fixture), applyGateV1(fixture), '分派壳必须委托 V1 冻结门几何');
  }
});

// #126 C-9 v1 冻结锁：双 exact-alias 同 term 形态（纯门构造，不经写入守卫）────────────────────
// 背景：#126 写入守卫已禁止新数据产生跨卡同别名，但 v1 门是冻结几何、不含平局概念——
// 对存量/重建库里可能残留的这种候选，历史行为是强通道卡全部 accepted 并按 score 保序截断。
// 本测试不经写柄、直接构造候选，把该行为钉死，防止后续重构顺手“修正”v1。
test('C-9 v1 冻结：双卡同 exact-alias 词项时 v1 门两张全收（无平局弃权），limit 保序截断', () => {
  const candidates = [exact('同一个别名'), exact('同一个别名')];
  assert.equal(candidates[0]!.card.cardId !== candidates[1]!.card.cardId, true, '前置：确为两张不同卡');

  const unlimited = applyGateV1({ atMs: TEST_NOW_MS, qNorm: '同一个别名', candidates });
  assert.equal(unlimited.status, 'hit');
  assert.equal(unlimited.accepted.length, 2, 'v1 几何：exact-alias 强通道不互相否决，两张都过门');
  assert.ok(unlimited.accepted.every((c) => c.gateReasons.includes('exact-alias-pass')));
  assert.equal(unlimited.rejected.length, 0);

  const limited = applyGateV1({ atMs: TEST_NOW_MS, qNorm: '同一个别名', candidates, limit: 1 });
  assert.equal(limited.accepted.length, 1, 'limit 仅在门后保序截断，不改变候选数与裁决');
  assert.equal(limited.candidateCount, 2);
  assert.equal(limited.accepted[0]!.card.cardId, unlimited.accepted[0]!.card.cardId);
});

// #126 批次3 rules-v2 反向包含＋严格优超门红测（先红后绿）────────────────────────────────────

test('R-02 v2 反向包含：线索字段完整出现于问句才过门，挂最长证据码点数', () => {
  const q = '周末一起去咖啡馆约会怎么样';
  // 正向：cue“咖啡馆约会”（5 码点）是问句子串 → 过门且证据长度 5。
  const pass = applyGateV2({ atMs: TEST_NOW_MS, qNorm: normalizeLexicalText(q), candidates: [overlap(['咖啡馆约会'])] });
  assert.equal(pass.status, 'hit');
  assert.equal(pass.accepted.length, 1);
  assert.ok(pass.accepted[0]!.gateReasons.includes('reverse-containment-pass'));
  assert.equal(pass.accepted[0]!.containmentLength, 5);

  // 反向：仅可能共享 bigram（“咖啡”）但完整字段“猫咪咖啡”不在问句里 → no-containment 拒绝。
  // #129：V2 全拒状态由 abstain 改名为 no-match/all-rejected（abstain 仅 v1 保留）。
  const block = applyGateV2({ atMs: TEST_NOW_MS, qNorm: normalizeLexicalText(q), candidates: [overlap(['猫咪咖啡'])] });
  assert.equal(block.status, 'no-match');
  assert.equal(block.reason, 'all-rejected');
  assert.ok(block.rejected[0]!.gateReasons.includes('no-containment'));

  // 最小证据长度：2 码点字段低于 GATE_POLICY_V2 门槛（观测初值 3）→ 拒，不放水短串。
  assert.equal(GATE_POLICY_V2.minContainCodepoints, 3);
  const tooShort = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'ab', candidates: [overlap(['ab'])] });
  assert.equal(tooShort.status, 'no-match');
  assert.ok(tooShort.rejected[0]!.gateReasons.includes('no-containment'));

  // 防御：fts-overlap 候选却缺结构化字段 → 保守拒绝（missing-cue-text），绝不静默放行。
  const missing = applyGateV2({
    atMs: TEST_NOW_MS,
    qNorm: normalizeLexicalText(q),
    candidates: [makeRanked({ matchKinds: ['fts-overlap'] })],
  });
  assert.equal(missing.status, 'no-match');
  assert.ok(missing.rejected[0]!.gateReasons.includes('missing-cue-text'));

  // 弱通道依旧构造性拒绝。
  const weak = applyGateV2({ atMs: TEST_NOW_MS, qNorm: '猫', candidates: [like('猫咪咖啡')] });
  assert.equal(weak.status, 'no-match');
  assert.ok(weak.rejected[0]!.gateReasons.includes('like-only-weak-match'));
});

test('R-03 #129 v2 严格优超/tie 弃权已废：合格卡一张不删，按 occurredMs 排序，证据长度只留痕', () => {
  const q = '周末一起去咖啡馆约会怎么样';
  // 直接走 makeCard(partial) 造完整卡（makeRanked 的 card 键会整体覆盖，不能只给残片）。
  const overlapAt = (fields: string[], occurredMs: number): ExplainedRankedCard => ({
    card: makeCard({ occurredMs }),
    scoreParts: { bm25: 0, recency: 0 },
    matchedTerms: fields,
    matchKinds: ['fts-overlap'],
    cueText: fields.join(' '),
    lexicalFields: fields,
  });
  const exactAt = (termNorm: string, occurredMs: number): ExplainedRankedCard => ({
    card: makeCard({ occurredMs }),
    scoreParts: { bm25: 0, recency: 0 },
    matchedTerms: [termNorm],
    matchKinds: ['exact-alias'],
  });
  const noLeaderCodes = (out: { accepted: readonly GatedRankedCard[]; rejected: readonly GatedRankedCard[] }) =>
    [...out.accepted, ...out.rejected].every(
      (c) => !c.gateReasons.includes('tie-no-strict-leader') && !c.gateReasons.includes('not-strict-leader'),
    );

  // 旧平局场景：等长证据两张卡都过门，按 occurredMs 新→旧排序，rejected 为 0。
  const tie = applyGateV2({
    atMs: TEST_NOW_MS,
    qNorm: normalizeLexicalText(q),
    candidates: [overlapAt(['咖啡馆约会'], 2_000), overlapAt(['咖啡馆约会'], 9_000)],
  });
  assert.equal(tie.status, 'hit');
  assert.equal(tie.candidateCount, 2);
  assert.equal(tie.accepted.length, 2);
  assert.equal(tie.rejected.length, 0);
  assert.deepEqual(tie.accepted.map((c) => c.card.occurredMs), [9_000, 2_000]);
  assert.ok(noLeaderCodes(tie));

  // 三张证据长短不一：词面都合格就全部保留（旧 C-10 场景整体不再弃权）。
  const allThree = applyGateV2({
    atMs: TEST_NOW_MS,
    qNorm: normalizeLexicalText(q),
    candidates: [overlapAt(['咖啡馆约会'], 3_000), overlapAt(['咖啡馆约会'], 2_000), overlapAt(['咖啡馆'], 1_000)],
  });
  assert.equal(allThree.status, 'hit');
  assert.equal(allThree.accepted.length, 3);
  assert.equal(allThree.rejected.length, 0);
  assert.deepEqual(allThree.accepted.map((c) => c.card.occurredMs), [3_000, 2_000, 1_000]);
  assert.ok(noLeaderCodes(allThree));

  // 一长一短：短证据卡更新，排序必须由 occurredMs 决定而非证据长度；containmentLength 仍逐卡留痕。
  const lead = applyGateV2({
    atMs: TEST_NOW_MS,
    qNorm: normalizeLexicalText(q),
    candidates: [overlapAt(['咖啡馆'], 9_000), overlapAt(['咖啡馆约会'], 1_000)],
  });
  assert.equal(lead.status, 'hit');
  assert.equal(lead.accepted.length, 2);
  assert.equal(lead.rejected.length, 0);
  assert.equal(lead.accepted[0]!.card.occurredMs, 9_000, '更新的短证据卡排首，证据长短不再决定先后');
  assert.equal(lead.accepted[0]!.containmentLength, 3);
  assert.equal(lead.accepted[1]!.containmentLength, 5);

  // exact-alias 与 fts 卡并存：两张都过门；exact 不再天然独占首位，排序只认四键，原因码各自保留。
  const exactWin = applyGateV2({
    atMs: TEST_NOW_MS,
    qNorm: normalizeLexicalText(q),
    candidates: [overlapAt(['咖啡馆约会'], 9_000), exactAt('咖啡馆约会', 1_000)],
  });
  assert.equal(exactWin.status, 'hit');
  assert.equal(exactWin.accepted.length, 2);
  assert.equal(exactWin.rejected.length, 0);
  assert.ok(exactWin.accepted.some((c) => c.gateReasons.includes('exact-alias-pass')));
  assert.ok(noLeaderCodes(exactWin));
});

test('#129 静态锁：applyGateV1 刻意不读 atMs，注入时钟漂移结果逐字节深相等', () => {
  const fixture = [exact('git'), fts('git 流程'), like('github')];
  const a = applyGateV1({ atMs: 1_700_000_000_000, qNorm: 'git', candidates: fixture });
  const b = applyGateV1({ atMs: 1_700_000_000_000 + 365 * 24 * 3600 * 1000, qNorm: 'git', candidates: fixture });
  assert.deepEqual(a, b, 'v1 几何冻结：atMs 仅 V2 排序器消费，v1 不读不漂移');
});

test('#129 门级接线：atMs 真传入排序器，遗忘强度（非裸 hitCount）决定同 weight 档先后', () => {
  const DAY = 24 * 3600 * 1000;
  // 两卡同 weight、同 occurredMs（隔离强度键），都走 exact 强通道过门。
  // A：裸次数 10 但 30 天没被采用 → 衰减后约 0.51；B：次数 2、1 天前采用 → 约 1.81，B 应在前。
  const exactCardWithHits = (cardId: string, hitCount: number, lastHitMs: number): ExplainedRankedCard => ({
    card: makeCard({ cardId, occurredMs: 1_000, hitCount, lastHitMs }),
    scoreParts: { bm25: 0, recency: 0 },
    matchedTerms: [cardId],
    matchKinds: ['exact-alias'],
  });
  const decayed = exactCardWithHits('mc_decayed', 10, TEST_NOW_MS - 30 * DAY);
  const fresh = exactCardWithHits('mc_fresh', 2, TEST_NOW_MS - 1 * DAY);
  const out = applyGateV2({ atMs: TEST_NOW_MS, qNorm: 'q', candidates: [decayed, fresh] });
  assert.equal(out.status, 'hit');
  assert.deepEqual(
    out.accepted.map((c) => c.card.cardId),
    ['mc_fresh', 'mc_decayed'],
    '若门未把 atMs 传入排序器（idle 算错/退化成裸 hitCount），10 次老卡会错误排首',
  );
});

test('R-08 v2 纯函数确定性：同输入两次深相等，空查询/零候选三态原因码与 v1 同构', () => {
  const q = '周末一起去咖啡馆约会怎么样';
  const fixture = [overlap(['咖啡馆约会']), like('x')];
  const first = applyGateV2({ atMs: TEST_NOW_MS, qNorm: normalizeLexicalText(q), candidates: fixture });
  const second = applyGateV2({ atMs: TEST_NOW_MS, qNorm: normalizeLexicalText(q), candidates: fixture });
  assert.deepEqual(first, second);
  assert.equal(applyGateV2({ atMs: TEST_NOW_MS, qNorm: '', candidates: fixture }).reason, 'empty-query');
  assert.equal(applyGateV2({ atMs: TEST_NOW_MS, qNorm: '无人提及', candidates: [] }).reason, 'zero-lexical-hit');
});

