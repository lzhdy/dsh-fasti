/**
 * #124 几何版本窗口红测（charter §3.6 红测 9）。
 *
 * 双向矩阵硬拒：
 *  - v2 戳记库 × v3 代码 → MemoryIndexStaleError（版本分支）；
 *  - v3 戳记但实际 trigram 表 × v3 代码 → MemoryIndexStaleError（tokenizer 分支）；
 *  - 戳记缺失 → MemoryIndexStaleError；
 *  - 健康 v3 库 → 校验通过、检索可用。
 * 冻结语义：卡片读取（getCard/listEffective）在旧几何库上仍然可用，仅检索入口与 drain 硬拒；
 * 错误消息必须显式提示离线重建，禁静默返空。全部夹具在临时根，真实数据根零接触。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { MemoryIndexStaleError } from '../../src/memory/memory-errors.ts';
import {
  MEMORY_INDEX_FILE,
  assertMemoryGeometryCurrent,
  openMemoryInternalRead,
  openMemoryRead,
  openMemoryWrite,
} from '../../src/memory/store.ts';
import { MEMORY_SCHEMA_VERSION } from '../../src/memory/schema.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');

/** 建一个健康的当前版空库并关闭，返回库文件路径（schema_meta 已戳 v3、FTS 为 unicode61）。 */
async function freshHealthyIndex(): Promise<{ root: string; indexDir: string; file: string }> {
  const root = makeTempRoot('geometry-window-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const handle = openMemoryWrite({ indexDir });
  await handle.close();
  return { root, indexDir, file: path.join(indexDir, MEMORY_INDEX_FILE) };
}

test('健康 v3 库：几何校验通过、只读柄检索不抛错', async () => {
  const { root, file } = await freshHealthyIndex();
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.doesNotThrow(() => assertMemoryGeometryCurrent(db, file));
    } finally {
      db.close();
    }
    const read = openMemoryRead({ indexDir: path.dirname(file) });
    try {
      assert.doesNotThrow(() => read.assertGeometryCurrent());
      assert.deepEqual(read.listEffective(T0), [], '卡片读取面不受几何窗口影响');
      const ranked = await read.search({ text: '任意检索', atMs: T0 });
      assert.deepEqual(ranked, [], '健康库检索入口可用（空库零行）');
    } finally {
      await read.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('v2 戳记库 × v3 代码：检索硬拒 MemoryIndexStaleError，但卡片仍可读', async () => {
  const { root, file } = await freshHealthyIndex();
  try {
  const mutator = new DatabaseSync(file);
  try {
    mutator.prepare("UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'").run();
  } finally {
    mutator.close();
  }

  const read = openMemoryRead({ indexDir: path.dirname(file) });
  const internal = openMemoryInternalRead({ indexDir: path.dirname(file) });
  try {
    assert.throws(() => read.assertGeometryCurrent(), (error: unknown) => {
      assert.ok(error instanceof MemoryIndexStaleError);
      assert.match((error as Error).message, /离线影子库整库重建/);
      assert.match((error as Error).message, /v2/);
      return true;
    });
    // 卡片可读：读取面不挂几何断言。
    assert.doesNotThrow(() => read.listEffective(T0));
    assert.doesNotThrow(() => read.getCard('nonexistent'));
    // 两个检索入口都硬拒，不静默返空。
    await assert.rejects(read.search({ text: '王工', atMs: T0 }), MemoryIndexStaleError);
    await assert.rejects(internal.searchExplained({ text: '王工', atMs: T0 }), MemoryIndexStaleError);
  } finally {
    await read.close();
    await internal.close();
  }
  } finally {
    cleanupTempRoot(root);
  }
});

test('v3 戳记但 trigram 实际几何：tokenizer 分支硬拒（戳记正确也不放行）', async () => {
  const { root, file } = await freshHealthyIndex();
  try {
  const mutator = new DatabaseSync(file);
  try {
    mutator.exec('DROP TABLE mem_card_fts');
    mutator.exec(
      "CREATE VIRTUAL TABLE mem_card_fts USING fts5(card_id UNINDEXED, cue_text, tokenize='trigram')",
    );
    const stamped = mutator
      .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
      .get() as { value: string };
    assert.equal(stamped.value, String(MEMORY_SCHEMA_VERSION), '前提：戳记确实是 v3，仅几何被篡改');
  } finally {
    mutator.close();
  }

  const read = openMemoryRead({ indexDir: path.dirname(file) });
  try {
    assert.throws(() => read.assertGeometryCurrent(), (error: unknown) => {
      assert.ok(error instanceof MemoryIndexStaleError);
      assert.match((error as Error).message, /unicode61/);
      return true;
    });
    await assert.rejects(read.search({ text: '王工', atMs: T0 }), MemoryIndexStaleError);
  } finally {
    await read.close();
  }
  } finally {
    cleanupTempRoot(root);
  }
});

test('schema_version 戳记缺失：同样硬拒（null 不当作隐式兼容）', async () => {
  const { root, file } = await freshHealthyIndex();
  try {
  const mutator = new DatabaseSync(file);
  try {
    mutator.prepare("DELETE FROM schema_meta WHERE key = 'schema_version'").run();
  } finally {
    mutator.close();
  }
  const read = openMemoryRead({ indexDir: path.dirname(file) });
  const internal = openMemoryInternalRead({ indexDir: path.dirname(file) });
  try {
    assert.throws(() => read.assertGeometryCurrent(), MemoryIndexStaleError);
    await assert.rejects(internal.searchExplained({ text: '冰', atMs: T0 }), MemoryIndexStaleError);
  } finally {
    await read.close();
    await internal.close();
  }
  } finally {
    cleanupTempRoot(root);
  }
});
