/**
 * 投影事务与增量一致性测试（审计口径 13：
 * 「写者队列内 append 真源后同步增量更新投影（L1 用事务，失败回滚并标记需重建）」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Fasti } from '../../src/api/index.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const ID = '01J0000000000000000000000A';

test('L1 事务：中途失败时整体回滚，不留半截数据', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const db = new DatabaseSync(path.join(root, 'projection', 'fasti.sqlite'));

    // 在事务内制造一次失败：插入一条 experience 后让后续步骤抛错。
    await assert.rejects(
      () =>
        fasti.projectionEngine.transaction(async () => {
          await fasti.projectionEngine.upsertExperience({
            id: 'partial-row',
            kind: 'dialogue',
            channel: 'dsh',
            scene_ref: null,
            initiation: null,
            occurred_ms: 1,
            recorded_ms: 2,
            tick: 999,
            status: 'active',
            shard: '',
            seq: 0,
          });
          throw new Error('故意失败');
        }),
      /故意失败/,
    );

    const rows = db.prepare('SELECT id FROM experience').all();
    assert.equal(rows.length, 0, '事务失败后不得残留半截数据');

    db.close();
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('增量更新后投影与真源一致：经历、边、文档三者齐备', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience({
      id: ID,
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 's-1' },
      initiation: 'user',
      observation: { cue: '可检索线索' },
      occurred_at: '2026-11-15T12:00:00.000Z',
      pointers: [{ type: 'continues', target: 'target-x' }],
    });

    const db = new DatabaseSync(path.join(root, 'projection', 'fasti.sqlite'));
    try {
      assert.equal((db.prepare('SELECT id FROM experience').all() as unknown[]).length, 1);
      assert.equal((db.prepare('SELECT id FROM edge').all() as unknown[]).length, 1);
      assert.equal((db.prepare('SELECT rowid FROM experience_fts').all() as unknown[]).length, 1);
    } finally {
      db.close();
    }

    // 真源同样只有一条。
    const file = path.join(root, 'experiences', '2026-11.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    assert.equal(lines.length, 1);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('投影失败时真源不回滚、且标记需重建（审计口径 13）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const db = new DatabaseSync(path.join(root, 'projection', 'fasti.sqlite'));
    db.exec('ALTER TABLE experience RENAME TO experience_broken');
    db.close();

    // append 不应抛错 —— 真源是唯一权威，写入成立。
    await fasti.appendExperience({
      id: ID,
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 's-1' },
      initiation: 'user',
      observation: { cue: '线索' },
      occurred_at: '2026-11-15T12:00:00.000Z',
    });

    const file = path.join(root, 'experiences', '2026-11.jsonl');
    assert.ok(fs.readFileSync(file, 'utf8').includes(ID), '真源写入应成立');

    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(root, 'state', 'checkpoint.json'), 'utf8'),
    ) as { needs_rebuild: boolean };
    assert.equal(checkpoint.needs_rebuild, true);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('标记需重建后，下次打开会自动从真源重建投影', async () => {
  const root = makeTempRoot();
  let fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience({
      id: ID,
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 's-1' },
      initiation: 'user',
      observation: { cue: '可检索线索' },
      occurred_at: '2026-11-15T12:00:00.000Z',
    });
  } finally {
    await fasti.close();
  }

  // 破坏投影库 → 重开时应自动重建，恢复可查。
  const dbFile = path.join(root, 'projection', 'fasti.sqlite');
  fs.writeFileSync(dbFile, '这不是一个合法的 sqlite 文件', 'utf8');

  fasti = await Fasti.open({ dataRoot: root });
  try {
    const rows = await fasti.query({});
    assert.equal(rows.length, 1, '重开后应从真源恢复投影');
    const hits = await fasti.search('可检索');
    assert.equal(hits.length, 1, '全文索引应一并恢复');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
