/**
 * task227 红测（a）：稀有桶冻结快照。
 *
 * 背景（218 蓝图 §4.1 的落地弥合）：门热路径算 rareCount 调 rareBigramHitCount 需要
 * bigram→稀有桶号映射，而 FrozenKMinTable 只冻结 dfCutpoints、不含逐 bigram 桶号；
 * 门是不持库的纯函数，无法现场重算 df，故桶映射必须作为随根冻结资产的一件独立快照注入。
 * 本快照与五档 kMin 解耦（桶号与 bMin 无关，全根只此一件），概率浮点仍封闭在建表器内。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RARITY_BUCKET_COUNT,
  RARITY_SNAPSHOT_SCHEMA,
  buildRarityBuckets,
  buildRaritySnapshot,
  collectBigramStats,
  rareBigramHitCount,
  rarityBucketMapOf,
} from '../../src/memory/bigram-null-model.ts';

const docs = ['甲乙丙丁', '甲乙丙子', '乙丁子丑', '甲子乙丑', '丙子丁卯', '丁丑甲乙'];

test('RS-1 快照 schema/桶数/cutpoints 形状与建表器口径一致，entries 按 gram 字典序', () => {
  const snap = buildRaritySnapshot(docs);
  assert.equal(snap.schema, RARITY_SNAPSHOT_SCHEMA);
  assert.equal(snap.rarityBuckets, RARITY_BUCKET_COUNT);
  assert.equal(snap.dfCutpoints.length, RARITY_BUCKET_COUNT - 1);
  const grams = snap.entries.map((e) => e.gram);
  assert.deepEqual(grams, [...grams].sort((a, b) => a.localeCompare(b)));
  for (const entry of snap.entries) {
    assert.ok(entry.bucket >= 0 && entry.bucket < RARITY_BUCKET_COUNT);
  }
});

test('RS-2 桶映射与快照逐 bigram 同值；未登录 gram 查不到（fail-closed 原料）', () => {
  const snap = buildRaritySnapshot(docs);
  const map = rarityBucketMapOf(snap);
  for (const entry of snap.entries) {
    assert.equal(map.get(entry.gram), entry.bucket);
  }
  assert.equal(map.has('不存在的gram'), false);
});

test('RS-3 同语料快照 JSON 逐字节确定（无墙钟无随机）', () => {
  assert.equal(JSON.stringify(buildRaritySnapshot(docs)), JSON.stringify(buildRaritySnapshot([...docs])));
});

test('RS-4 空语料 fail-loud：不在空语料上伪造空快照', () => {
  assert.throws(() => buildRaritySnapshot([]));
});

test('RS-5 快照可直接喂 rareBigramHitCount，稀有命中口径与内存建桶逐字一致', () => {
  const live = buildRarityBuckets(collectBigramStats(docs).documentFrequency).bucketOf;
  const frozen = rarityBucketMapOf(buildRaritySnapshot(docs));
  const cases: Array<{ q: string; fields: string[]; bMin: number }> = [
    { q: '甲乙丙', fields: ['甲乙丙丁'], bMin: 0 },
    { q: '甲子乙丑', fields: ['甲子乙丑', '丙子丁卯'], bMin: 3 },
    { q: '丁子丑', fields: ['乙丁子丑'], bMin: 7 },
  ];
  for (const c of cases) {
    assert.equal(
      rareBigramHitCount(c.q, c.fields, frozen, c.bMin),
      rareBigramHitCount(c.q, c.fields, live, c.bMin),
    );
  }
});
