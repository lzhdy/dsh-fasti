/**
 * #172 · 门控检索 limit 归一与硬顶红测。
 *
 * 问题事实（本文件先红）：
 *  - `applyGate` 对 limit 直做 `accepted.slice(0, limit)`（gate.ts）；
 *  - 负值 → `slice(0, -1)` 反向裁掉末尾，本该「少给」却多给（三卡时给 2 张）；
 *  - 0 → 空结果，模型传 0 一条都拿不到；
 *  - 超大值 / Infinity 无护栏。
 *
 * 纪律：只在装配边界（`runGatedSearch`）归一，不改 gate 纯函数既有语义；
 * `undefined` 必须保持原样（v1 缺省保留全部过门卡，禁漂移）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { runGatedSearch, MAX_GATED_SEARCH_LIMIT, normalizeGatedSearchLimit } from '../../src/assembly/index.ts';
import { computeContentHash } from '../../src/memory/builder.ts';
import { openMemoryRuntime } from '../../src/memory/runtime.ts';
import { openMemoryWrite } from '../../src/memory/store.ts';
import { ulid } from '../../src/core/ulid.ts';
import type { AliasRow, MemoryCard, RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const AT = T0 + 30 * 24 * 3600 * 1000;

/** 造 3 张同 cue 的卡：同一查询三张都过门（探针已证 accepted=3）。 */
async function seedThree(): Promise<{ root: string; indexDir: string }> {
  const root = makeTempRoot('task172-limit-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const cards: MemoryCard[] = ['mc_a', 'mc_b', 'mc_c'].map((id) => {
    const anchorJson = JSON.stringify([ulid()]);
    const displayCuesJson = JSON.stringify(['port check']);
    const aliasesJson = JSON.stringify([]);
    return {
      cardId: id,
      eventId: `evt-${id}`,
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
      endedMs: T0 + 24 * 3600 * 1000,
      validMs: T0,
      invalidMs: null,
      createdMs: T0,
      expiredMs: null,
      status: 'active',
      contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, ''),
      hitCount: 0,
      lastHitMs: null,
      schemaVersion: 1,
    } satisfies MemoryCard;
  });
  const aliases: AliasRow[] = [];
  const revision: RevisionRecord = {
    revision: 1,
    slug: 'build',
    at_ms: T0,
    schema_version: 3,
    truth_fingerprint: 'fp-task172',
    prior_revision: null,
    card_count: cards.length,
    alias_count: aliases.length,
    row_hash_sum: 'rh-task172',
    shadow_diff: { added: cards.length, removed: 0, changed: 0 },
    reason: 'test fixture',
    operator: 'offline-cli',
  };
  const writer = openMemoryWrite({ indexDir });
  try {
    writer.transactionApply({ cards, aliases }, revision, []);
  } finally {
    await writer.close();
  }
  return { root, indexDir };
}

test('#172-1 归一矩阵：undefined/非法数/负数/小数/超大值', () => {
  assert.equal(normalizeGatedSearchLimit(undefined), undefined, 'undefind 原样保留（v1 缺省全部过门卡）');
  assert.equal(normalizeGatedSearchLimit(Number.NaN), undefined, 'NaN 归一为缺省语义');
  assert.equal(normalizeGatedSearchLimit(Number.POSITIVE_INFINITY), undefined, 'Infinity 归一为缺省语义');
  assert.equal(normalizeGatedSearchLimit(Number.NEGATIVE_INFINITY), undefined);
  assert.equal(normalizeGatedSearchLimit(0), 1, '0 抬到 1（绝不返回空结果）');
  assert.equal(normalizeGatedSearchLimit(-1), 1, '负值不再穿透 slice');
  assert.equal(normalizeGatedSearchLimit(-100), 1);
  assert.equal(normalizeGatedSearchLimit(3.9), 3, '小数向下取整');
  assert.equal(normalizeGatedSearchLimit(1), 1);
  assert.equal(normalizeGatedSearchLimit(MAX_GATED_SEARCH_LIMIT), MAX_GATED_SEARCH_LIMIT);
  assert.equal(normalizeGatedSearchLimit(MAX_GATED_SEARCH_LIMIT + 1), MAX_GATED_SEARCH_LIMIT, '硬顶生效');
  assert.equal(normalizeGatedSearchLimit(1_000_000_000), MAX_GATED_SEARCH_LIMIT);
  assert.equal(MAX_GATED_SEARCH_LIMIT, 20, '硬顶常量 = 20（轻量 DTO 单次上限）');
});

test('#172-2 行为：limit=-1 不再反向裁尾（三卡给 1 张而不是 2 张）', async () => {
  const { root, indexDir } = await seedThree();
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      const baseline = await runGatedSearch(handle, { text: 'port check', atMs: AT });
      assert.equal(baseline.status, 'hit');
      assert.equal(baseline.accepted.length, 3, '前置：三张都过门');

      const negative = await runGatedSearch(handle, { text: 'port check', atMs: AT }, -1);
      assert.equal(negative.status, 'hit');
      assert.equal(negative.accepted.length, 1, '负值归一为 1，绝不按 slice(0,-1) 给 2 张');
      assert.equal(negative.accepted[0]!.card.cardId, 'mc_a', '保留第一名（排序不变）');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('#172-3 行为：limit=0 抬到 1；正常值与缺省语义零漂移', async () => {
  const { root, indexDir } = await seedThree();
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      const zero = await runGatedSearch(handle, { text: 'port check', atMs: AT }, 0);
      assert.equal(zero.accepted.length, 1, '0 抬到 1，不让模型拿到空结果');

      const two = await runGatedSearch(handle, { text: 'port check', atMs: AT }, 2);
      assert.equal(two.accepted.length, 2, '正数 limit 既有语义不变');

      const all = await runGatedSearch(handle, { text: 'port check', atMs: AT });
      assert.equal(all.accepted.length, 3, '缺省仍保留全部过门卡（零漂移）');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('#172-4 依赖面守卫已存在（复核既有双守卫，不重复立测试）', () => {
  const pkg = JSON.parse(fs.readFileSync('/home/user/dsh-fasti-fresh/package.json', 'utf8')) as {
    dependencies?: Record<string, unknown>;
  };
  assert.deepEqual(pkg.dependencies ?? {}, {}, '生产 dependencies 恒为空（由 plugin-independence 与 schema M6 双线锁定）');
});
