/**
 * #130 批3 红测：adoption-write.ts 采用计数窄写事务。
 *
 * 纪律（对齐 alias-write 窄写家法）：
 *  - 单事务 BEGIN IMMEDIATE 内只 UPDATE mem_card 的 hit_count/last_hit_ms 两列，
 *    不整行 upsert、不碰其它 20 列、不写 FTS、不碰 mem_alias、不自开连接、不追加账本；
 *  - active 卡守卫权威再做一遍：缺卡/非 active 结构化拒绝且零 churn；atMs 非法 fail-loud；
 *  - 时钟注入、无 Date.now；真库 :memory:，真实数据根零接触。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { applyAdoption } from '../../src/memory/adoption-write.ts';
import { computeContentHash } from '../../src/memory/content-hash.ts';
import { syncFts } from '../../src/memory/fts.ts';
import { MEMORY_SCHEMA } from '../../src/memory/schema.ts';
import { writeAliases, writeCards } from '../../src/memory/store.ts';
import type { AliasRow, MemoryCard } from '../../src/memory/types.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 86400000;
const CARD_ID = 'mc_adopt_under_test';
const OTHER_ID = 'mc_adopt_neighbour';
const EVENT_ID = 'evt-adopt-under-test';

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const statement of MEMORY_SCHEMA) {
    db.exec(statement);
  }
  return db;
}

function mkCard(cardId: string, overrides: Partial<MemoryCard> = {}): MemoryCard {
  const anchorJson = JSON.stringify([`exp-${cardId}-1`]);
  const displayCuesJson = JSON.stringify(['线索甲']);
  const aliasesJson = JSON.stringify([]);
  return {
    cardId,
    eventId: EVENT_ID,
    anchorJson,
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator: `disc-${cardId}`,
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, `disc-${cardId}`),
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
    ...overrides,
  };
}

function seedCard(overrides: Partial<MemoryCard> = {}): { db: DatabaseSync; card: MemoryCard } {
  const db = memoryDb();
  const card = mkCard(CARD_ID, overrides);
  writeCards(db, [card]);
  syncFts(db, [CARD_ID]);
  return { db, card };
}

function cardRow(db: DatabaseSync, cardId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM mem_card WHERE card_id=?').get(cardId) as Record<string, unknown>;
}

function cardColumnsExcept(db: DatabaseSync, cardId: string, cols: readonly string[]): Record<string, unknown> {
  const raw = cardRow(db, cardId);
  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!cols.includes(k)) clone[k] = v;
  }
  return clone;
}

test('W1 首次采用：仅 hit_count/last_hit_ms 两列变化，其余列逐字不动，回信封带新计数与内容哈希', () => {
  const { db, card } = seedCard();
  try {
    const before = cardColumnsExcept(db, CARD_ID, ['hit_count', 'last_hit_ms']);
    const ftsBefore = db.prepare('SELECT * FROM mem_card_fts WHERE card_id=?').all(CARD_ID);
    const atMs = T0 + 3 * DAY;

    const outcome = applyAdoption(db, { cardId: CARD_ID, atMs });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return assert.fail('应成功');

    const after = cardRow(db, CARD_ID);
    assert.equal(after['hit_count'], 1);
    assert.equal(after['last_hit_ms'], atMs);
    assert.deepEqual(cardColumnsExcept(db, CARD_ID, ['hit_count', 'last_hit_ms']), before);
    assert.deepEqual(db.prepare('SELECT * FROM mem_card_fts WHERE card_id=?').all(CARD_ID), ftsBefore, 'FTS 零 churn');

    assert.deepEqual(
      { hitCount: outcome.hitCount, lastHitMs: outcome.lastHitMs, contentHash: outcome.contentHash },
      { hitCount: 1, lastHitMs: atMs, contentHash: card.contentHash },
    );
  } finally {
    db.close();
  }
});

test('W2 连续采用：既有 7 次→8 次，lastHitMs 推进到本次时刻', () => {
  const { db } = seedCard({ hitCount: 7, lastHitMs: T0 + DAY });
  try {
    const atMs = T0 + 6 * DAY;
    const outcome = applyAdoption(db, { cardId: CARD_ID, atMs });
    if (!outcome.ok) return assert.fail('应成功');
    const after = cardRow(db, CARD_ID);
    assert.equal(after['hit_count'], 8);
    assert.equal(after['last_hit_ms'], atMs);
    assert.equal(outcome.hitCount, 8);
    assert.equal(outcome.lastHitMs, atMs);
  } finally {
    db.close();
  }
});

test('W3 缺卡：结构化拒绝 card-not-found，库内零写入', () => {
  const { db } = seedCard();
  try {
    const snapshot = db.prepare('SELECT * FROM mem_card').all();
    const outcome = applyAdoption(db, { cardId: 'mc_ghost', atMs: T0 });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return assert.fail('应拒绝');
    assert.equal(outcome.reason, 'card-not-found');
    assert.deepEqual(db.prepare('SELECT * FROM mem_card').all(), snapshot);
    assert.equal(cardRow(db, CARD_ID)['hit_count'], 0);
  } finally {
    db.close();
  }
});

test('W4 非 active 卡（invalid/tombstone）：card-not-active 拒绝且零 churn', () => {
  const { db } = seedCard({ status: 'invalid', invalidMs: T0 + 2 * DAY });
  try {
    const before = cardRow(db, CARD_ID);
    const outcome = applyAdoption(db, { cardId: CARD_ID, atMs: T0 + 3 * DAY });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return assert.fail('应拒绝');
    assert.equal(outcome.reason, 'card-not-active');
    assert.deepEqual(cardRow(db, CARD_ID), before);
  } finally {
    db.close();
  }
});

test('W5 atMs 非法（负数/小数/NaN）：fail-loud 抛错且库零变化', () => {
  const { db } = seedCard();
  try {
    for (const bad of [-1, 1.5, Number.NaN]) {
      assert.throws(() => applyAdoption(db, { cardId: CARD_ID, atMs: bad }));
    }
    assert.equal(cardRow(db, CARD_ID)['hit_count'], 0);
    assert.equal(cardRow(db, CARD_ID)['last_hit_ms'], null);
  } finally {
    db.close();
  }
});

test('W6 窄写不波及邻卡与别名表：只目标卡两列变化', () => {
  const db = memoryDb();
  try {
    const target = mkCard(CARD_ID);
    const neighbour = mkCard(OTHER_ID, { hitCount: 3, lastHitMs: T0 });
    const alias: AliasRow = {
      termNorm: '邻居别名',
      cardId: OTHER_ID,
      source: 'miss',
      sensitive: 0,
      status: 'active',
      createdMs: T0,
      hitCount: 2,
      lastHitMs: T0,
    };
    writeCards(db, [target, neighbour]);
    writeAliases(db, [alias]);
    syncFts(db, [CARD_ID, OTHER_ID]);

    const neighbourBefore = cardRow(db, OTHER_ID);
    const aliasBefore = db.prepare('SELECT * FROM mem_alias').all();

    const outcome = applyAdoption(db, { cardId: CARD_ID, atMs: T0 + DAY });
    assert.equal(outcome.ok, true);
    assert.deepEqual(cardRow(db, OTHER_ID), neighbourBefore, '邻卡逐字不变');
    assert.deepEqual(db.prepare('SELECT * FROM mem_alias').all(), aliasBefore, '别名表零 churn');
    assert.equal(cardRow(db, CARD_ID)['hit_count'], 1);
  } finally {
    db.close();
  }
});
