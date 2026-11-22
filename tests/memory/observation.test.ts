/**
 * 网页控制台 #157 记忆卡观测窄面红测（先红后绿）。
 *
 * 威胁模型与 N14 模型可见白名单不同：这是**她本人**在本机 loopback 页面看自己的索引，
 * 可以看卡主表全字段与非敏感别名；但 sensitive=1 的别名原文仍不回显（termNorm 置 null，
 * 只保留计数/状态），漏召台账只给聚合计数。观测面纯读、零写方法、不进模型工具信封。
 *
 * 覆盖：①纯映射 toObservationCardView（JSON 解析/敏感脱敏）；②窄柄三方法 list/get/counts
 * （分页、未知 id 返 null、计数口径）；③观测面不携带任何写柄方法名。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { computeContentHash } from '../../src/memory/builder.ts';
import { toObservationCardView } from '../../src/memory/observation.ts';
import { openMemoryRuntime } from '../../src/memory/runtime.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../src/memory/store.ts';
import type { AliasRow, MemoryCard, RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;

function mkCard(cardId: string, aliases: Array<{ term: string; sensitive: 0 | 1 }>): {
  card: MemoryCard;
  aliasRows: AliasRow[];
} {
  const anchorJson = JSON.stringify([`01ANCHOR${cardId}`]);
  const displayCuesJson = JSON.stringify(['线索甲', '线索乙']);
  const aliasesJson = JSON.stringify(
    aliases.map((a) => ({ term: a.term, source: 'miss', sensitive: a.sensitive })),
  );
  const card: MemoryCard = {
    cardId,
    eventId: `evt-${cardId}`,
    anchorJson,
    channel: 'webdemo',
    cardType: 'event',
    selection: 'selected',
    weight: 0.42,
    displayCuesJson,
    aliasesJson,
    discriminator: '消歧短句',
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, '消歧短句'),
    hitCount: 7,
    lastHitMs: T0 + DAY,
    schemaVersion: 1,
  };
  const aliasRows: AliasRow[] = aliases.map((a) => ({
    termNorm: a.term,
    cardId,
    source: 'miss',
    sensitive: a.sensitive,
    status: 'active',
    createdMs: T0,
    hitCount: 0,
    lastHitMs: null,
  }));
  return { card, aliasRows };
}

test('toObservationCardView：解析 JSON 字段，敏感别名原文脱敏但保留状态', () => {
  const { card } = mkCard('mc_x', [
    { term: '普通别名', sensitive: 0 },
    { term: '私密别名', sensitive: 1 },
  ]);
  const view = toObservationCardView(card);

  assert.deepEqual(view.anchorIds, ['01ANCHORmc_x']);
  assert.deepEqual(view.displayCues, ['线索甲', '线索乙']);
  assert.equal(view.weight, 0.42);
  assert.equal(view.hitCount, 7);
  assert.equal(view.aliases.length, 2);
  const plain = view.aliases.find((a) => a.sensitive === false);
  assert.equal(plain?.termNorm, '普通别名', '非敏感别名原样可见');
  const secret = view.aliases.find((a) => a.sensitive === true);
  assert.ok(secret !== undefined);
  assert.equal(secret.termNorm, null, '敏感别名原文绝不进观测视图');
  assert.equal(secret.status, 'active');
});

async function seedIndex(): Promise<{ root: string; indexDir: string }> {
  const root = makeTempRoot('mem-observation-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const specs = [
    mkCard('mc_a', [{ term: '别名a', sensitive: 0 }]),
    mkCard('mc_b', [{ term: '别名b', sensitive: 0 }]),
    mkCard('mc_c', [{ term: '私密词', sensitive: 1 }]),
  ];
  const cards = specs.map((s) => s.card);
  const aliases = specs.flatMap((s) => s.aliasRows);
  const writer = openMemoryWrite({ indexDir });
  const revision: RevisionRecord = {
    revision: 1,
    slug: 'build',
    at_ms: T0,
    schema_version: 3,
    truth_fingerprint: 'fp-observation-test',
    prior_revision: null,
    card_count: cards.length,
    alias_count: aliases.length,
    row_hash_sum: 'rh',
    shadow_diff: { added: cards.length, removed: 0, changed: 0 },
    reason: 'test',
    operator: 'offline-cli',
  };
  writer.transactionApply({ cards, aliases }, revision, []);
  await writer.close();
  return { root, indexDir };
}

test('窄柄观测三方法：分页列表、单卡详情、聚合计数，且不含任何写方法', async () => {
  const { root, indexDir } = await seedIndex();
  const handle = openMemoryRuntime({ indexDir });
  try {
    const page1 = handle.listCardsForObservation({ limit: 2, offset: 0 });
    assert.equal(page1.length, 2);
    const page2 = handle.listCardsForObservation({ limit: 2, offset: 2 });
    assert.equal(page2.length, 1);
    const all = handle.listCardsForObservation();
    assert.equal(all.length, 3, '缺省分页返回全部卡');
    for (const bad of [0, -1, 101, 1.5]) {
      assert.throws(
        () => handle.listCardsForObservation({ limit: bad }),
        /limit/,
        `非法 limit=${String(bad)} 必须拒绝`,
      );
    }

    const one = handle.getCardForObservation('mc_a');
    assert.equal(one?.cardId, 'mc_a');
    assert.equal(handle.getCardForObservation('no-such-card'), null);

    const counts = handle.getObservationCounts();
    assert.equal(counts.cards, 3);
    assert.equal(counts.activeCards, 3);
    assert.equal(counts.aliases, 3);
    assert.equal(counts.sensitiveAliases, 1);
    assert.equal(counts.misses, 0);

    // 观测面是只读窄面：写柄专属方法名一个都不可达（recordMiss 是合法窄方法，不在此列）。
    for (const forbidden of ['transactionApply', 'stampRevision', 'writeAuditRun', 'pruneMisses']) {
      assert.equal(typeof (handle as unknown as Record<string, unknown>)[forbidden], 'undefined');
    }
  } finally {
    await handle.close();
    cleanupTempRoot(root);
  }
});

void MEMORY_INDEX_FILE;
