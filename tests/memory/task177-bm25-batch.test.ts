/**
 * P-b（批量查询取代逐卡 N+1）的两条守卫红测。
 *
 * 为什么必须单独立测：仓外 550 条基线快照只在「合成卷」上比对，而合成卷零别名
 * （build-synthetic-world.ts:178 `aliasesJson = '[]'`），敏感别名过滤、别名组内次序、
 * 跨批次丢卡这三条分支在快照里根本没有数据，变异不会被抓红。本测试用带敏感别名与
 * 超批量的自建语料把这三条钉死。
 *
 * 纪律：临时根建库、atMs 注入、零系统时钟、结束清理。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { searchCardsExplainedV1, searchCardsExplainedV2 } from '../../src/memory/bm25.ts';
import { computeContentHash } from '../../src/memory/builder.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../src/memory/store.ts';
import type { AliasRow, MemoryCard, RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const AT = T0 + 30 * DAY;

interface Spec {
  cardId: string;
  cues: string[];
  aliases: Array<{ term: string; sensitive: 0 | 1 }>;
  occurredMs: number;
}

function toRows(spec: Spec): { card: MemoryCard; aliasRows: AliasRow[] } {
  const anchorJson = '["exp-1"]';
  const displayCuesJson = JSON.stringify(spec.cues);
  const aliasesJson = JSON.stringify(
    spec.aliases.map((a) => ({ term: a.term, source: 'miss', sensitive: a.sensitive })),
  );
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
    discriminator: `disc-${spec.cardId}`,
    entityHintJson: null,
    occurredMs: spec.occurredMs,
    endedMs: spec.occurredMs + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, `disc-${spec.cardId}`),
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

async function seed(specs: readonly Spec[]): Promise<{ indexDir: string; root: string }> {
  const root = makeTempRoot('bm25-batch-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const entries = specs.map(toRows);
  const cards = entries.map((e) => e.card);
  const aliases = entries.flatMap((e) => e.aliasRows);
  const handle = openMemoryWrite({ indexDir });
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 3,
      truth_fingerprint: 'fp-batch-test',
      prior_revision: null,
      card_count: cards.length,
      alias_count: aliases.length,
      row_hash_sum: 'rh-batch-test',
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    handle.transactionApply({ cards, aliases }, revision, []);
  } finally {
    await handle.close();
  }
  return { indexDir, root };
}

/** 敏感别名语料：同一张卡同时挂敏感与公开别名，公开线索故意与敏感词无关。 */
const SENSITIVE_SPECS: Spec[] = [
  {
    cardId: 'mc_sens',
    cues: ['牙科复诊'],
    aliases: [
      { term: '私密词', sensitive: 1 },
      { term: '公开别名', sensitive: 0 },
    ],
    occurredMs: T0,
  },
  { cardId: 'mc_plain', cues: ['牙科复诊'], aliases: [{ term: '公开别名', sensitive: 0 }], occurredMs: T0 + DAY },
];

test('PB1 敏感别名绝不进入 v1/v2 的 cueText 与 lexicalFields（批量取行不得放宽过滤）', async () => {
  const { indexDir, root } = await seed(SENSITIVE_SPECS);
  const db = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
  try {
    for (const [name, fn] of [
      ['V1', searchCardsExplainedV1],
      ['V2', searchCardsExplainedV2],
    ] as const) {
      // 直接以敏感词检索：FTS 不可见，命中只可能来自非敏感公开别名或线索。
      const rows = fn(db, { text: '私密词', atMs: AT, limit: undefined });
      for (const row of rows) {
        assert.ok(
          !(row.cueText ?? '').includes('私密词'),
          `${name} cueText 泄漏敏感别名：${row.card.cardId}`,
        );
        for (const field of row.lexicalFields ?? []) {
          assert.ok(!field.includes('私密词'), `${name} lexicalFields 泄漏敏感别名：${field}`);
        }
      }
      // 以公开别名检索：命中的卡其线索字段同样不得含敏感词。
      const pub = fn(db, { text: '公开别名', atMs: AT, limit: undefined });
      assert.ok(pub.length > 0, `${name} 公开别名应可召回`);
      for (const row of pub) {
        for (const field of row.lexicalFields ?? []) {
          assert.ok(!field.includes('私密词'), `${name} lexicalFields 混入敏感别名：${field}`);
        }
      }
    }
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

test('PB2 候选数超过单批上限时一张不漏（跨批次批量取行）', async () => {
  const total = 450; // > IN_QUERY_BATCH(400)，必跨两批
  const specs: Spec[] = [];
  for (let i = 0; i < total; i += 1) {
    specs.push({
      cardId: `mc_batch_${String(i).padStart(3, '0')}`,
      cues: [`批次线索${String(i % 7)}`],
      aliases: [{ term: `别名${String(i).padStart(3, '0')}`, sensitive: 0 }],
      occurredMs: T0 + i * 1000,
    });
  }
  const { indexDir, root } = await seed(specs);
  const db = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
  try {
    // “批次”为 2 码点，命中全部 450 张卡；v2 宽召回不设子串收口，是纯跨批次用例。
    const rows = searchCardsExplainedV2(db, { text: '批次', atMs: AT, limit: undefined });
    assert.equal(rows.length, total, `跨批次丢了卡：期望 ${total}，实得 ${rows.length}`);
    const ids = new Set(rows.map((r) => r.card.cardId));
    assert.equal(ids.size, total);
    // 每张卡都必须取到整卡行与别名（否则 cueText/lexicalFields 会为空或残缺）。
    for (const row of rows) {
      assert.ok(Array.isArray(row.lexicalFields) && row.lexicalFields.length >= 1, `卡 ${row.card.cardId} 字段缺失`);
      assert.ok((row.cueText ?? '').length > 0, `卡 ${row.card.cardId} cueText 缺失`);
    }
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});
