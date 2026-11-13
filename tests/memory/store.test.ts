/**
 * C1 · store 测试（方案 §4.3 / §11.2）。
 *
 * 覆盖：
 *  - 开库/建表只在 indexDir 内发生（listTree 快照证明索引目录外零写入）；
 *  - 重开幂等（IF NOT EXISTS）；写柄进程内单例（二次打开抛 ConflictError）；
 *  - 只读柄：缺库抛错、不创建文件、可并发多开；
 *  - meta stamp：stampRevision 后 verifyStampedFingerprint 通过；
 *    指纹不符 / 未 stamp 抛 MemoryIndexStaleError（M3 的读侧拒绝服务）；
 *  - getCard / getCardByEvent / listEffective 的 as-of 三条件边界。
 *
 * 纪律：全部在 tests/helpers 同款临时根运行；夹具行由测试直接用 node:sqlite
 * 写入（C1 的写柄范围是开库/建表/meta stamp，卡写入事务随 C2 落地）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ConflictError, CorruptedError, IntegrityError, NotFoundError } from '../../src/core/errors.ts';
import {
  MemoryAnchorDanglingError,
  MemoryIndexStaleError,
  MemorySerialReferenceError,
} from '../../src/memory/memory-errors.ts';
import { openMemoryRead, openMemoryWrite } from '../../src/memory/store.ts';
import type { MemoryCard, RevisionRecord, TruthFingerprint } from '../../src/memory/types.ts';
import { cleanupTempRoot, listTree, makeTempRoot, withTempRoot } from '../helpers.ts';

const DB_FILE = 'memory-index.sqlite';

function fingerprint(aggregate: string): TruthFingerprint {
  return {
    files: [{ path: 'experiences/2026-11.jsonl', sha256: 'a'.repeat(64) }],
    aggregate,
  };
}

function revision(overrides: Partial<RevisionRecord> = {}): RevisionRecord {
  return {
    revision: 1,
    slug: 'build',
    at_ms: 1_000,
    schema_version: 1,
    truth_fingerprint: 'f'.repeat(64),
    prior_revision: null,
    card_count: 0,
    alias_count: 0,
    row_hash_sum: '0'.repeat(64),
    shadow_diff: { added: 0, removed: 0, changed: 0 },
    reason: 'test',
    operator: 'offline-cli',
    ...overrides,
  };
}

/** 与 mem_card 列一一对应的夹具行（测试直写库用）。 */
function cardRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    card_id: 'mc_fixture',
    event_id: 'ev1',
    anchor_json: '["exp1"]',
    channel: 'dsh',
    card_type: 'event',
    selection: 'selected',
    weight: 0,
    display_cues_json: '["线索"]',
    aliases_json: '[]',
    discriminator: '判别',
    entity_hint_json: null,
    occurred_ms: 100,
    ended_ms: 200,
    valid_ms: 100,
    invalid_ms: null,
    created_ms: 100,
    expired_ms: null,
    status: 'active',
    content_hash: 'hash',
    hit_count: 0,
    last_hit_ms: null,
    schema_version: 1,
    ...overrides,
  };
}

function insertCard(dbFile: string, overrides: Record<string, unknown> = {}): void {
  const db = new DatabaseSync(dbFile);
  try {
    const row = cardRow(overrides);
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO mem_card(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    ).run(...columns.map((c) => row[c] as string | number | null));
  } finally {
    db.close();
  }
}

test('openMemoryWrite 只在 indexDir 内落文件，重开幂等', async () => {
  const root = makeTempRoot('mem-store-');
  try {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const before = listTree(root);
    assert.deepEqual(before, []);

    const handle = openMemoryWrite({ indexDir });
    await handle.close();

    // 索引目录外零写入：树快照只多出 memory-index/ 内的文件。
    const after = listTree(root);
    assert.ok(after.every((rel) => rel.startsWith('projection/memory-index/')));
    assert.ok(after.includes(`projection/memory-index/${DB_FILE}`));
    assert.ok(!after.some((rel) => rel.includes('fasti.sqlite')));
    assert.ok(!after.some((rel) => rel.startsWith('state/')));

    // 重开幂等：同目录再次开库不报错、表不重复。
    const again = openMemoryWrite({ indexDir });
    try {
      const db = new DatabaseSync(path.join(indexDir, DB_FILE), { readOnly: true });
      try {
        const n = db
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='mem_card'")
          .get() as { n: number };
        assert.equal(n.n, 1);
        const meta = db
          .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
          .get() as { value: string } | undefined;
        assert.equal(meta?.value, '1');
      } finally {
        db.close();
      }
    } finally {
      await again.close();
    }
    assert.deepEqual(listTree(root), after);
  } finally {
    cleanupTempRoot(root);
  }
});

test('写柄进程内单例：同目录二次 openMemoryWrite 抛 ConflictError，close 后可再开', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const first = openMemoryWrite({ indexDir });
    try {
      assert.throws(() => openMemoryWrite({ indexDir }), ConflictError);
      // 不同目录不受影响。
      const otherDir = path.join(root, 'projection', 'other-index');
      const other = openMemoryWrite({ indexDir: otherDir });
      await other.close();
    } finally {
      await first.close();
    }
    const reopened = openMemoryWrite({ indexDir });
    await reopened.close();
  });
});

test('openMemoryRead：缺库抛 NotFoundError 且不创建任何文件', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    assert.throws(() => openMemoryRead({ indexDir }), NotFoundError);
    assert.deepEqual(listTree(root), []);
  });
});

test('只读柄可并发多开，读取夹具行；getCard 缺失返回 null', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const writer = openMemoryWrite({ indexDir });
    await writer.close();
    insertCard(path.join(indexDir, DB_FILE));

    const a = openMemoryRead({ indexDir });
    const b = openMemoryRead({ indexDir });
    try {
      const card = a.getCard('mc_fixture');
      assert.ok(card !== null);
      assert.equal(card.cardId, 'mc_fixture');
      assert.equal(card.eventId, 'ev1');
      assert.equal(card.anchorJson, '["exp1"]');
      assert.equal(card.occurredMs, 100);
      assert.equal(card.invalidMs, null);
      assert.equal(card.weight, 0);
      assert.equal(card.schemaVersion, 1);
      assert.deepEqual(b.getCard('mc_fixture'), card);
      assert.equal(a.getCard('mc_missing'), null);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test('getCardByEvent：命中 active 卡；无卡返回 null', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const writer = openMemoryWrite({ indexDir });
    await writer.close();
    const dbFile = path.join(indexDir, DB_FILE);
    insertCard(dbFile);
    insertCard(dbFile, { card_id: 'mc_invalid', event_id: 'ev2', status: 'invalid', invalid_ms: 150 });

    const reader = openMemoryRead({ indexDir });
    try {
      assert.equal(reader.getCardByEvent('ev1')?.cardId, 'mc_fixture');
      assert.equal(reader.getCardByEvent('ev2'), null);
      assert.equal(reader.getCardByEvent('ev_none'), null);
    } finally {
      await reader.close();
    }
  });
});

test('listEffective：as-of 三条件边界（valid<=T、invalid 空或>T、created<=T）', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const writer = openMemoryWrite({ indexDir });
    await writer.close();
    const dbFile = path.join(indexDir, DB_FILE);
    // T=100 时：A 有效（valid=100, created=100, invalid=null）；
    // B 已失效（invalid=100，不满足 invalid>T）；C 尚未生效（valid=101）；
    // D 尚未创建（created=101）。
    insertCard(dbFile, { card_id: 'A', valid_ms: 100, created_ms: 100, invalid_ms: null });
    insertCard(dbFile, { card_id: 'B', valid_ms: 90, created_ms: 90, invalid_ms: 100 });
    insertCard(dbFile, { card_id: 'C', valid_ms: 101, created_ms: 100, invalid_ms: null });
    insertCard(dbFile, { card_id: 'D', valid_ms: 90, created_ms: 101, invalid_ms: null });

    const reader = openMemoryRead({ indexDir });
    try {
      assert.deepEqual(reader.listEffective(100).map((c) => c.cardId), ['A']);
      assert.deepEqual(reader.listEffective(101).map((c) => c.cardId).sort(), ['A', 'C', 'D']);
      // T=99：B 尚未失效（invalid=100 > 99）；T=89：全部未生效。
      assert.deepEqual(reader.listEffective(99).map((c) => c.cardId), ['B']);
      assert.deepEqual(reader.listEffective(89).map((c) => c.cardId), []);
    } finally {
      await reader.close();
    }
  });
});

test('meta stamp：stampRevision 后指纹核验通过；不符或未 stamp 抛 MemoryIndexStaleError', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const writer = openMemoryWrite({ indexDir });
    try {
      // 未 stamp：拒绝服务。
      assert.throws(() => writer.verifyStampedFingerprint(fingerprint('f'.repeat(64))), MemoryIndexStaleError);

      writer.stampRevision(revision());
      // stamp 与 revisions 账本字段对应。
      writer.verifyStampedFingerprint(fingerprint('f'.repeat(64)));
      assert.throws(
        () => writer.verifyStampedFingerprint(fingerprint('e'.repeat(64))),
        MemoryIndexStaleError,
      );

      // stamp 落 schema_meta，重开只读柄后仍可核验。
      const db = new DatabaseSync(path.join(indexDir, DB_FILE), { readOnly: true });
      try {
        const stamped = db
          .prepare("SELECT value FROM schema_meta WHERE key='stamped_revision'")
          .get() as { value: string } | undefined;
        assert.equal(stamped?.value, '1');
      } finally {
        db.close();
      }
    } finally {
      await writer.close();
    }

    const reader = openMemoryRead({ indexDir });
    try {
      reader.verifyStampedFingerprint(fingerprint('f'.repeat(64)));
      assert.throws(() => reader.verifyStampedFingerprint(fingerprint('0'.repeat(64))), MemoryIndexStaleError);
    } finally {
      await reader.close();
    }
  });
});

test('错误类继承既有基类（不自造错误码体系）', () => {
  assert.ok(new MemoryIndexStaleError('x') instanceof CorruptedError);
  assert.ok(new MemoryAnchorDanglingError('x') instanceof IntegrityError);
  assert.ok(new MemorySerialReferenceError('x') instanceof NotFoundError);
  assert.equal(new MemoryIndexStaleError('x').code, 'CORRUPTED');
  assert.equal(new MemoryAnchorDanglingError('x').code, 'INTEGRITY');
  assert.equal(new MemorySerialReferenceError('x').code, 'NOT_FOUND');
});

test('MemoryCard 类型与列一一对应（编译期口径的运行期抽查）', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const writer = openMemoryWrite({ indexDir });
    await writer.close();
    insertCard(path.join(indexDir, DB_FILE), { hit_count: 3, last_hit_ms: 999 });
    const reader = openMemoryRead({ indexDir });
    try {
      const card: MemoryCard | null = reader.getCard('mc_fixture');
      assert.ok(card !== null);
      assert.equal(card.hitCount, 3);
      assert.equal(card.lastHitMs, 999);
      assert.equal(card.expiredMs, null);
      assert.equal(card.entityHintJson, null);
      assert.equal(card.cardType, 'event');
      assert.equal(card.selection, 'selected');
      assert.equal(card.status, 'active');
    } finally {
      await reader.close();
    }
  });
});