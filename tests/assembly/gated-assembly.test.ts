/**
 * 第二层 WP3 · 装配层门控召回接线测试（提纲 v0.3 §6/§9 类别 2）。
 *
 * 端到端走真实链路：openMemoryRuntime 窄柄 → runGatedSearch（窄柄取全集 + applyGate 裁决），
 * 验证装配编排把“未截断全集”交给门、top-k 仅在门后生效，且 N9 弱尾强卡反例在接线层成立：
 *  - ASCII 非词边界子串（cat∈concatenate）仅 fts-substring 弱命中，被 ascii-no-word-boundary 拒绝；
 *  - exact-alias 强通道卡即使与弱卡同处候选全集，门后 accepted 只取强卡，limit=1 不拿弱尾凑数；
 *  - 多卡同别名（multi-accept）时门后截断数量随 limit 正确变化，装配层不预切片；
 *  - 空查询归一为 no-match/empty-query。
 *
 * 静态白名单合规由 schema.test.ts 对真实 src/assembly 目录的 M6 扫描另线保证；本文件只验证行为。
 * 纪律：tests/helpers 临时根、atMs 注入、无 Date.now/Math.random、真实数据根零接触。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { ulid } from '../../src/core/ulid.ts';
import { runGatedSearch } from '../../src/assembly/index.ts';
import { computeContentHash } from '../../src/memory/builder.ts';
import { openMemoryRuntime } from '../../src/memory/runtime.ts';
import { openMemoryWrite } from '../../src/memory/store.ts';
import type { AliasRow, MemoryCard, RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const AT = T0 + 30 * DAY;

interface SeedSpec {
  cardId: string;
  cues: string[];
  aliases: Array<{ term: string; sensitive: 0 | 1 }>;
}

function mkCard(spec: SeedSpec): { card: MemoryCard; aliasRows: AliasRow[] } {
  const anchorJson = JSON.stringify([ulid()]);
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
    discriminator: '',
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, ''),
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

async function seed(specs: SeedSpec[]): Promise<{ root: string; indexDir: string }> {
  const root = makeTempRoot('mem-assembly-wp3-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const entries = specs.map(mkCard);
  const cards = entries.map((e) => e.card);
  const aliases = entries.flatMap((e) => e.aliasRows);
  const handle = openMemoryWrite({ indexDir });
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 1,
      truth_fingerprint: 'fp-assembly-wp3',
      prior_revision: null,
      card_count: cards.length,
      alias_count: aliases.length,
      row_hash_sum: 'rh-assembly-wp3',
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    handle.transactionApply({ cards, aliases }, revision, []);
  } finally {
    await handle.close();
  }
  return { root, indexDir };
}

test('N9 接线反例：弱子串卡被门拒，limit=1 的 accepted 只取 exact-alias 强卡', async () => {
  // W 无别名，cue 含非词边界子串 cat（trigram 命中 → fts-substring → 词边界复核失败）；
  // S 初始无别名，运行期经窄柄补一条 sensitive=1 的精确别名 cat（exact-alias 强通道）。
  const { root, indexDir } = await seed([
    { cardId: 'mc_weak', cues: ['concatenate plan notes'], aliases: [] },
    { cardId: 'mc_strong', cues: ['weekly review'], aliases: [] },
  ]);
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      const outcomeAlias = handle.addMissAlias({ term: 'cat', cardId: 'mc_strong', atMs: AT });
      assert.equal(outcomeAlias.ok, true);
      if (outcomeAlias.ok) assert.equal(outcomeAlias.changed, true);

      const outcome = await runGatedSearch(handle, { text: 'cat', atMs: AT }, 1);

      assert.equal(outcome.status, 'hit');
      assert.deepEqual(
        outcome.accepted.map((c) => c.card.cardId),
        ['mc_strong'],
        '门后唯一席位必须给强通道卡，绝不用弱尾凑数',
      );
      const strong = outcome.accepted[0];
      assert.ok(strong);
      assert.ok(strong.gateReasons.includes('exact-alias-pass'));

      const weak = outcome.rejected.find((c) => c.card.cardId === 'mc_weak');
      assert.ok(weak, '弱子串卡必须出现在 rejected 而非被截断丢弃');
      assert.ok(weak.gateReasons.includes('ascii-no-word-boundary'));
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('multi-accept：同别名两卡均过门，limit 在门后截断，缺省返回全集', async () => {
  const { root, indexDir } = await seed([
    { cardId: 'mc_x', cues: ['unrelated alpha'], aliases: [] },
    { cardId: 'mc_y', cues: ['unrelated beta'], aliases: [] },
  ]);
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      handle.addMissAlias({ term: 'cat', cardId: 'mc_x', atMs: AT });
      handle.addMissAlias({ term: 'cat', cardId: 'mc_y', atMs: AT });

      const capped = await runGatedSearch(handle, { text: 'cat', atMs: AT }, 1);
      assert.equal(capped.status, 'hit');
      assert.equal(capped.accepted.length, 1, '门后截断到 1 席');
      assert.equal(capped.rejected.length, 0, '过门卡不进 rejected，仅被 top-k 截断');

      const full = await runGatedSearch(handle, { text: 'cat', atMs: AT });
      assert.equal(full.status, 'hit');
      assert.deepEqual(
        full.accepted.map((c) => c.card.cardId).sort(),
        ['mc_x', 'mc_y'],
        '缺省 limit 返回全部过门卡（窄柄全集不预切片）',
      );
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('空查询：规范化后为空 → no-match/empty-query，不触库检索', async () => {
  const { root, indexDir } = await seed([{ cardId: 'mc_z', cues: ['whatever'], aliases: [] }]);
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      const outcome = await runGatedSearch(handle, { text: '   ', atMs: AT }, 5);
      assert.equal(outcome.status, 'no-match');
      assert.equal(outcome.reason, 'empty-query');
      assert.deepEqual(outcome.accepted, []);
      assert.deepEqual(outcome.rejected, []);
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});
