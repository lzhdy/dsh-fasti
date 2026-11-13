/**
 * 门后烟测 —— 只读、确定性、弃权/噪声探针与四态归类（#44 第一层，#54；提案 §5.7/§8.4，D4/D12）。
 *
 * 纪律：
 *  - 临时根 + 只读库打开（readOnly: true）；**绝不调用任何别名写入/写库方法**（D12）；
 *  - 库文件 sha256 前后必须逐字节一致；同输入两次 outcome 逐字节一致；
 *  - 只报机制行为与四态计数，不报 R1/R2 统计达标（D4）。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { normalizeQuery, searchCardsExplained } from '../../src/memory/bm25.ts';
import { computeContentHash } from '../../src/memory/content-hash.ts';
import { applyGate } from '../../src/memory/gate.ts';
import { isNaEstimate, summarizeFourState } from '../../src/memory/audit/four-state.ts';
import type { FourStateProbeInput } from '../../src/memory/audit/four-state.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../src/memory/store.ts';
import type { AliasRow, MemoryCard, RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;

interface Spec {
  cardId: string;
  cues: string[];
  aliases: Array<{ term: string; sensitive: 0 | 1 }>;
  discriminator: string;
}

function mkCard(spec: Spec): { card: MemoryCard; aliasRows: AliasRow[] } {
  const anchorJson = '["exp-1"]';
  const displayCuesJson = JSON.stringify(spec.cues);
  const aliasesJson = JSON.stringify(
    spec.aliases.map((a) => ({ term: a.term, source: 'miss', sensitive: a.sensitive })),
  );
  const contentHash = computeContentHash(anchorJson, displayCuesJson, aliasesJson, spec.discriminator);
  const card: MemoryCard = {
    cardId: spec.cardId,
    eventId: `evt-${spec.cardId}`,
    anchorJson,
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator: spec.discriminator,
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash,
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  const aliasRows: AliasRow[] = spec.aliases.map((a) => ({
    termNorm: a.term,
    cardId: spec.cardId,
    source: 'miss',
    sensitive: a.sensitive,
    status: 'active',
    createdMs: T0,
    hitCount: 0,
    lastHitMs: null,
  }));
  return { card, aliasRows };
}

/** 一真卡 + 两张 ASCII 宽泛诱饵（github 若真卡为 git）。 */
const CORPUS: Spec[] = [
  { cardId: 'mc_git', cues: ['合成真卡：版本库协作'], aliases: [{ term: 'git', sensitive: 0 }], discriminator: '真卡' },
  { cardId: 'mc_github', cues: ['github 仓库浏览'], aliases: [], discriminator: '诱饵一' },
  { cardId: 'mc_other', cues: ['合成其它话题'], aliases: [], discriminator: '诱饵二' },
];

interface Seeded {
  root: string;
  file: string;
}

async function seedCorpus(): Promise<Seeded> {
  const root = makeTempRoot('gate-smoke-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const entries = CORPUS.map(mkCard);
  const cards = entries.map((e) => e.card);
  const aliases = entries.flatMap((e) => e.aliasRows);
  const handle = openMemoryWrite({ indexDir });
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 1,
      truth_fingerprint: 'fp-gate-smoke',
      prior_revision: null,
      card_count: cards.length,
      alias_count: aliases.length,
      row_hash_sum: 'rh-gate-smoke',
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    handle.transactionApply({ cards, aliases }, revision, []);
  } finally {
    await handle.close();
  }
  return { root, file: path.join(indexDir, MEMORY_INDEX_FILE) };
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 只读打开 → explained 检索 → 布尔门（一次完整门后裁决）。 */
function gatedQuery(file: string, text: string, atMs: number, limit?: number) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const candidates = searchCardsExplained(db, { text, atMs, limit });
    return applyGate({ qNorm: normalizeQuery(text), candidates, limit });
  } finally {
    db.close();
  }
}

test('烟测只读：门后裁决前后库文件 sha256 逐字节一致（D12 零写）', async () => {
  const seeded = await seedCorpus();
  try {
    const before = sha256File(seeded.file);
    gatedQuery(seeded.file, 'git', T0 + 10 * DAY, 3);
    gatedQuery(seeded.file, 'zzzq_无此经历', T0 + 10 * DAY, 3);
    const after = sha256File(seeded.file);
    assert.equal(after, before, '烟测只读：库文件必须零字节变化');
  } finally {
    cleanupTempRoot(seeded.root);
  }
});

test('弃权探针：库中无词面命中 → no-match/zero-lexical-hit（不编造、不返回卡）', async () => {
  const seeded = await seedCorpus();
  try {
    const outcome = gatedQuery(seeded.file, 'zzzq_无此经历', T0 + 10 * DAY, 3);
    assert.equal(outcome.status, 'no-match');
    assert.equal(outcome.reason, 'zero-lexical-hit');
    assert.deepEqual(outcome.accepted, []);
    assert.deepEqual(outcome.rejected, []);
  } finally {
    cleanupTempRoot(seeded.root);
  }
});

test('噪声探针：真卡精确命中，ASCII 无边界诱饵 github 被门拒（留 rejected 原因）', async () => {
  const seeded = await seedCorpus();
  try {
    const outcome = gatedQuery(seeded.file, 'git', T0 + 10 * DAY, 3);
    assert.equal(outcome.status, 'hit');
    assert.deepEqual(
      outcome.accepted.map((c) => c.card.cardId),
      ['mc_git'],
      '只应保留真卡 git',
    );
    assert.ok(
      outcome.rejected.some((c) => c.card.cardId === 'mc_github'),
      'github 应作为弱匹配被拒，且不静默丢弃',
    );
    for (const rejected of outcome.rejected) {
      assert.ok(rejected.gateReasons.includes('ascii-no-word-boundary'), '拒绝原因须可观测');
    }
  } finally {
    cleanupTempRoot(seeded.root);
  }
});

test('确定性：同输入两次 outcome 逐字节一致（同种子同结果）', async () => {
  const seeded = await seedCorpus();
  try {
    const first = gatedQuery(seeded.file, 'git', T0 + 10 * DAY, 3);
    const second = gatedQuery(seeded.file, 'git', T0 + 10 * DAY, 3);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(JSON.stringify(first.serialMap), JSON.stringify(second.serialMap));
  } finally {
    cleanupTempRoot(seeded.root);
  }
});

test('四态归类：弃权 + 噪声混合 → G+NG=N，计数与各率分母正确', async () => {
  const seeded = await seedCorpus();
  try {
    const abstain = gatedQuery(seeded.file, 'zzzq_无此经历', T0 + 10 * DAY, 3);
    const hit = gatedQuery(seeded.file, 'git', T0 + 10 * DAY, 3);

    const probes: FourStateProbeInput[] = [
      // 无金标题、门弃权 → correct-abstain
      {
        probeRef: 'abstain-1',
        hasGold: false,
        committed: abstain.status === 'hit',
        top1IsGold: false,
        highRisk: false,
      },
      // 有金标题（mc_git）、门在 top1 认对 → correct-commit
      {
        probeRef: 'noise-1',
        hasGold: true,
        committed: hit.status === 'hit',
        top1IsGold: hit.accepted[0]?.card.cardId === 'mc_git',
        highRisk: false,
      },
    ];

    const summary = summarizeFourState(probes);
    assert.deepEqual([summary.counts.cc, summary.counts.ca], [1, 1]);
    assert.equal(summary.counts.G, 1);
    assert.equal(summary.counts.NG, 1);
    assert.equal(summary.counts.N, 2);
    assert.equal(summary.counts.G + summary.counts.NG, summary.counts.N, 'G+NG=N');
    assert.equal(summary.rates.falseCommitRate, 0);
    assert.equal(summary.rates.recallAfterGate, 1);
    assert.equal(summary.rates.correctRejectRate, 1);
    assert.equal(summary.rates.abstainRate, 1 / 2);
    assert.ok(!isNaEstimate(summary.legacyR2), '旧口径应有样本');
    assert.equal(summary.legacyR2.point, 0, '此例全认对，旧 r2（错误率）应为 0');
  } finally {
    cleanupTempRoot(seeded.root);
  }
});

test('静态自证：查证区不含任何写柄/写库调用（D12；建库事务仅出现一次）', () => {
  const selfPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate-smoke.test.ts');
  const source = fs.readFileSync(selfPath, 'utf8');
  for (const forbidden of ['apply' + 'MissAlias', 'add' + 'MissAlias']) {
    assert.ok(!source.includes(forbidden), `烟测不得出现写别名方法 ${forbidden}`);
  }
  const writes = source.split('transaction' + 'Apply').length - 1;
  assert.equal(writes, 1, '建库事务只允许在 seedCorpus 出现一次');
  // 门后查证只允许只读打开。
  assert.ok(source.includes('readOnly: true'));
});
