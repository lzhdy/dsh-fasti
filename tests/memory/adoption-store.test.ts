/**
 * #130 批4 红测：store 写柄 recordAnchorAdoption 与 adoptions.jsonl 物理面。
 *
 * 口径：
 *  - DB 窄写事务提交成功后才追加账本行（只记已提交事实）；拒绝路径零 DB churn、零账本；
 *  - 账本落在 indexDir 内（与 decisions.jsonl 同目录族），append-only 前缀不破坏；
 *  - 读取尾行容忍、中间坏行硬失败；物理重复行不在写侧去重，折叠幂等在纯函数层；
 *  - 读柄结构上无此写方法；真实数据根零接触，全部临时根。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { foldAdoptions, validateAdoption } from '../../src/memory/adoption.ts';
import { openAdoptionStore, ADOPTIONS_FILE } from '../../src/memory/adoption-store.ts';
import { CorruptedError, SchemaError } from '../../src/core/errors.ts';
import { computeContentHash } from '../../src/memory/content-hash.ts';
import { MEMORY_INDEX_FILE, openMemoryRead, openMemoryWrite } from '../../src/memory/store.ts';
import type { MemoryCard } from '../../src/memory/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 86400000;
const CARD_ID = 'mc_adopt_handle_card';
const EVENT_ID = 'evt-adopt-handle';

function indexDirOf(rootPath: string): string {
  return path.join(rootPath, 'projection', 'memory-index');
}

function mkCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  const anchorJson = JSON.stringify(['exp-anchor-1']);
  const displayCuesJson = JSON.stringify(['线索甲']);
  const aliasesJson = JSON.stringify([]);
  return {
    cardId: CARD_ID,
    eventId: EVENT_ID,
    anchorJson,
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator: 'disc-adopt',
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, 'disc-adopt'),
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
    ...overrides,
  };
}

async function seedOneCard(indexDir: string, card: MemoryCard = mkCard()): Promise<void> {
  const handle = openMemoryWrite({ indexDir });
  try {
    handle.transactionApply(
      { cards: [card], aliases: [] },
      {
        revision: 1, slug: 'build', at_ms: T0, schema_version: 1, truth_fingerprint: 'fp-adopt',
        prior_revision: null, card_count: 1, alias_count: 0, row_hash_sum: 'rh',
        shadow_diff: { added: 1, removed: 0, changed: 0 }, reason: 'fixture', operator: 'offline-cli',
      },
      [],
    );
  } finally {
    await handle.close();
  }
}

test('H1 写柄采用：DB 两列更新且 indexDir 内追加一行四字段账本，content_hash 与卡面一致', async () => {
  const root = makeTempRoot('adoption-handle-');
  const indexDir = indexDirOf(root);
  try {
    await seedOneCard(indexDir);
    const atMs = T0 + 3 * DAY;
    const handle = openMemoryWrite({ indexDir });
    try {
      const outcome = handle.recordAnchorAdoption({ cardId: CARD_ID, atMs });
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return assert.fail('应成功');
      assert.equal(outcome.hitCount, 1);
      assert.equal(outcome.record.at_ms, atMs);
      assert.equal(outcome.record.card_id, CARD_ID);
      assert.equal(outcome.record.content_hash, mkCard().contentHash);
    } finally {
      await handle.close();
    }

    const ro = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
    try {
      const row = ro.prepare('SELECT hit_count, last_hit_ms FROM mem_card WHERE card_id=?').get(CARD_ID) as
        | { hit_count: number; last_hit_ms: number }
        | undefined;
      assert.equal(row?.hit_count, 1);
      assert.equal(row?.last_hit_ms, atMs);
    } finally {
      ro.close();
    }

    const ledgerFile = path.join(indexDir, ADOPTIONS_FILE);
    assert.ok(fs.existsSync(ledgerFile), '账本文件应落在 indexDir 内');
    const rows = openAdoptionStore(indexDir).read();
    assert.equal(rows.length, 1);
    assert.doesNotThrow(() => validateAdoption(rows[0]));
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['at_ms', 'card_id', 'content_hash', 'id']);
  } finally {
    cleanupTempRoot(root);
  }
});

test('H2 连续三次采用：账本三行、DB 计数 3/lastHitMs 最大，折叠结果与卡面两源自洽', async () => {
  const root = makeTempRoot('adoption-handle-multi-');
  const indexDir = indexDirOf(root);
  try {
    await seedOneCard(indexDir);
    const handle = openMemoryWrite({ indexDir });
    try {
      handle.recordAnchorAdoption({ cardId: CARD_ID, atMs: T0 + DAY });
      handle.recordAnchorAdoption({ cardId: CARD_ID, atMs: T0 + 2 * DAY });
      handle.recordAnchorAdoption({ cardId: CARD_ID, atMs: T0 + 3 * DAY });
    } finally {
      await handle.close();
    }
    const store = openAdoptionStore(indexDir);
    const rows = store.read();
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((r) => r.id)).size, 3, '三个不同事件 id 各异');
    assert.deepEqual(foldAdoptions(rows).get(CARD_ID), { hitCount: 3, lastHitMs: T0 + 3 * DAY });

    const ro = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
    try {
      const row = ro.prepare('SELECT hit_count, last_hit_ms FROM mem_card WHERE card_id=?').get(CARD_ID) as
        | { hit_count: number; last_hit_ms: number }
        | undefined;
      assert.equal(row?.hit_count, 3);
      assert.equal(row?.last_hit_ms, T0 + 3 * DAY);
    } finally {
      ro.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('H3 缺卡/非 active 拒绝：零 DB churn 且账本文件根本不诞生', async () => {
  const root = makeTempRoot('adoption-handle-reject-');
  const indexDir = indexDirOf(root);
  try {
    await seedOneCard(indexDir, mkCard({ status: 'invalid', invalidMs: T0 + DAY }));
    const handle = openMemoryWrite({ indexDir });
    try {
      const ghost = handle.recordAnchorAdoption({ cardId: 'mc_ghost', atMs: T0 });
      assert.equal(ghost.ok, false);
      const inactive = handle.recordAnchorAdoption({ cardId: CARD_ID, atMs: T0 });
      assert.equal(inactive.ok, false);
      if (ghost.ok || inactive.ok) return assert.fail('两者都应拒绝');
      assert.equal(ghost.reason, 'card-not-found');
      assert.equal(inactive.reason, 'card-not-active');
    } finally {
      await handle.close();
    }
    assert.equal(fs.existsSync(path.join(indexDir, ADOPTIONS_FILE)), false, '拒绝路径不建账本');
    const ro = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
    try {
      const row = ro.prepare('SELECT hit_count, last_hit_ms FROM mem_card WHERE card_id=?').get(CARD_ID) as
        | { hit_count: number; last_hit_ms: number | null }
        | undefined;
      assert.equal(row?.hit_count, 0);
      assert.equal(row?.last_hit_ms, null);
    } finally {
      ro.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('H4 append-only 前缀：二次追加后首次文件内容仍是第二次的严格前缀', async () => {
  const root = makeTempRoot('adoption-handle-prefix-');
  const indexDir = indexDirOf(root);
  try {
    await seedOneCard(indexDir);
    const ledgerFile = path.join(indexDir, ADOPTIONS_FILE);
    const handle = openMemoryWrite({ indexDir });
    try {
      handle.recordAnchorAdoption({ cardId: CARD_ID, atMs: T0 });
      const first = fs.readFileSync(ledgerFile, 'utf8');
      handle.recordAnchorAdoption({ cardId: CARD_ID, atMs: T0 + DAY });
      const second = fs.readFileSync(ledgerFile, 'utf8');
      assert.ok(second.startsWith(first), 'append-only：历史行逐字节不改');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('H5 账本读取：缺文件返回空数组；末行半截容忍；中间坏行 CorruptedError 硬失败', () => {
  const root = makeTempRoot('adoption-ledger-io-');
  const indexDir = indexDirOf(root);
  try {
    const store = openAdoptionStore(indexDir);
    assert.deepEqual(store.read(), []);
    const ledgerFile = path.join(indexDir, ADOPTIONS_FILE);
    fs.mkdirSync(indexDir, { recursive: true });
    const good = JSON.stringify({
      id: 'a'.repeat(32), card_id: CARD_ID, at_ms: T0, content_hash: 'h1',
    });
    fs.writeFileSync(ledgerFile, `${good}\n{"id":"broken-partial`);
    assert.equal(store.read().length, 1, '末行半截残行不消费');

    // 中间行 JSON 语法坏：解析层 CorruptedError 硬失败（尾行容忍不覆盖中间行）。
    fs.writeFileSync(ledgerFile, `${good}\n{broken-json}\n{"id":"tail"}\n`);
    assert.throws(() => store.read(), CorruptedError);
    // 中间行能解析但形状越界：校验层 SchemaError 同样硬失败，绝不静默跳过。
    fs.writeFileSync(ledgerFile, `${good}\n{"id":"middle-bad"}\n{"id":"tail"}\n`);
    assert.throws(() => store.read(), SchemaError);
  } finally {
    cleanupTempRoot(root);
  }
});

test('H6 物理重复行写侧不去重，折叠层按内容键幂等计数一次', async () => {
  const root = makeTempRoot('adoption-ledger-dup-');
  const indexDir = indexDirOf(root);
  try {
    await seedOneCard(indexDir);
    const handle = openMemoryWrite({ indexDir });
    try {
      handle.recordAnchorAdoption({ cardId: CARD_ID, atMs: T0 });
      handle.recordAnchorAdoption({ cardId: CARD_ID, atMs: T0 }); // 同内容键重试形态
    } finally {
      await handle.close();
    }
    const rows = openAdoptionStore(indexDir).read();
    assert.equal(rows.length, 2, '写侧只追加不裁决');
    assert.deepEqual(foldAdoptions(rows).get(CARD_ID), { hitCount: 1, lastHitMs: T0 });
  } finally {
    cleanupTempRoot(root);
  }
});

test('H7 读柄结构上没有 recordAnchorAdoption 写方法', async () => {
  const root = makeTempRoot('adoption-readonly-');
  const indexDir = indexDirOf(root);
  try {
    await seedOneCard(indexDir);
    const readHandle = openMemoryRead({ indexDir });
    try {
      assert.equal(typeof (readHandle as { recordAnchorAdoption?: unknown }).recordAnchorAdoption, 'undefined');
    } finally {
      await readHandle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});
