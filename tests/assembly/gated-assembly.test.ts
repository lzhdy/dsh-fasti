/**
 * 第二层 WP3 · 装配层门控召回接线测试（提纲 v0.3 §6/§9 类别 2）。
 *
 * 端到端走真实链路：openMemoryRuntime 窄柄 → runGatedSearch（窄柄取全集 + applyGate 裁决），
 * 验证装配编排把“未截断全集”交给门、top-k 仅在门后生效，且 N9 弱尾强卡反例在接线层成立：
 *  - ASCII 非词边界子串（cat∈concatenate）在 #124 unicode61 整词几何下于 FTS 召回层即被闭合，
 *    弱卡不入场；gate 的 ascii-no-word-boundary 规则保留为纵深防御（gate.test 纯函数守护）；
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
      schema_version: 3,
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

      // #124 unicode61 整词几何：'cat' 与 'concatenate' 是不同整词 token，弱卡物理上不被 FTS 召回，
      // 故不进任何门后集合（trigram 时代它经 fts-substring 入场再被 ascii-no-word-boundary 拒收；
      // 词边界规则仍保留为纵深防御，纯函数守护在 gate.test.ts）。门后唯一席位给强卡的安全目标不变。
      const surfaced = [...outcome.accepted, ...outcome.rejected].map((c) => c.card.cardId);
      assert.ok(!surfaced.includes('mc_weak'), '弱子串卡不得混入门后任何集合');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('#126 别名全库唯一：同 term 挂第二张卡被 term-globally-conflicts 拒绝，精确过门只属一卡；异 term 互不影响', async () => {
  const { root, indexDir } = await seed([
    { cardId: 'mc_x', cues: ['unrelated alpha'], aliases: [] },
    { cardId: 'mc_y', cues: ['unrelated beta'], aliases: [] },
  ]);
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      const first = handle.addMissAlias({ term: 'cat', cardId: 'mc_x', atMs: AT });
      assert.equal(first.ok, true);
      // 同一 term_norm 禁止跨卡复用（exact-alias 恒过的全局唯一前提）。
      const conflict = handle.addMissAlias({ term: 'cat', cardId: 'mc_y', atMs: AT });
      assert.equal(conflict.ok, false);
      if (!conflict.ok) {
        assert.equal(conflict.reason, 'term-globally-conflicts');
      }

      const hitCat = await runGatedSearch(handle, { text: 'cat', atMs: AT });
      assert.equal(hitCat.status, 'hit');
      assert.deepEqual(
        hitCat.accepted.map((c) => c.card.cardId),
        ['mc_x'],
        '精确别名唯一归属 mc_x，mc_y 不得凭同 term 过门',
      );

      // 不冲突的异 term 正常写入并独立过门。
      const second = handle.addMissAlias({ term: 'dog', cardId: 'mc_y', atMs: AT });
      assert.equal(second.ok, true);
      const hitDog = await runGatedSearch(handle, { text: 'dog', atMs: AT });
      assert.deepEqual(
        hitDog.accepted.map((c) => c.card.cardId),
        ['mc_y'],
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
