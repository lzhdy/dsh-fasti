/**
 * 原文层测试（审计第四节阶段 1 验收项：
 * 「原文层：raw-turns 与 raw/<channel>/ 同构（8 字段），append-only、无去重」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { RawLog } from '../../src/source/raw-log.ts';
import { RAW_TURN_FIELDS } from '../../src/contract/raw-turn.ts';
import { contentHashOf } from '../../src/core/hash.ts';
import { CorruptedError, NotFoundError, OutOfRangeError } from '../../src/core/errors.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

test('raw-turns 与 raw/<channel>/ 同构：8 字段完全一致', () => {
  const root = makeTempRoot();
  try {
    const dsh = new RawLog('dsh', path.join(root, 'raw-turns'));
    const qq = new RawLog('qq', path.join(root, 'raw', 'qq'));

    dsh.append({ event_id: 'e1', speaker: 'user', raw_text: '你好' });
    qq.append({ event_id: 'e1', speaker: 'user', raw_text: '你好' });

    const dshRow = JSON.parse(
      fs.readFileSync(path.join(root, 'raw-turns', '2026-11.jsonl'), 'utf8').trim(),
    ) as Record<string, unknown>;
    const qqRow = JSON.parse(
      fs.readFileSync(path.join(root, 'raw', 'qq', '2026-11.jsonl'), 'utf8').trim(),
    ) as Record<string, unknown>;

    assert.deepEqual(Object.keys(dshRow).sort(), [...RAW_TURN_FIELDS].sort());
    assert.deepEqual(Object.keys(qqRow).sort(), [...RAW_TURN_FIELDS].sort());
    assert.equal(Object.keys(dshRow).length, 8);
  } finally {
    cleanupTempRoot(root);
  }
});

test('append-only：无去重（同 event_id 两次追加 → 两行都在）', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    log.append({ event_id: 'dup', speaker: 'user', raw_text: '同一事件' });
    log.append({ event_id: 'dup', speaker: 'user', raw_text: '同一事件' });

    const rows = log.readAll();
    assert.equal(rows.length, 2, '原文层不得去重（旧行为契约 1.1：原文层必须全量）');
    assert.equal(rows[0]?.event_id, 'dup');
    assert.equal(rows[1]?.event_id, 'dup');
  } finally {
    cleanupTempRoot(root);
  }
});

test('seq 从 0 起算、逐条递增', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    assert.equal(log.append({ event_id: 'a', speaker: 'user', raw_text: 'x' }).seq, 0);
    assert.equal(log.append({ event_id: 'b', speaker: 'user', raw_text: 'x' }).seq, 1);
    assert.equal(log.append({ event_id: 'c', speaker: 'user', raw_text: 'x' }).seq, 2);
  } finally {
    cleanupTempRoot(root);
  }
});

test('分片按摄入月（ingested_at 所在月），清单原子写', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    log.append({ event_id: 'a', speaker: 'user', raw_text: 'x', ingested_at: '2026-11-15T12:00:00.000Z' });
    log.append({ event_id: 'b', speaker: 'user', raw_text: 'x', ingested_at: '2026-12-15T12:00:00.000Z' });

    const shards = log.shards();
    assert.equal(shards.length, 2);
    assert.ok((shards[0] as string) < (shards[1] as string), '分片按时间升序');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'raw-turns', 'manifest.json'), 'utf8'),
    ) as { version: number; months: string[] };
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.months, shards);
  } finally {
    cleanupTempRoot(root);
  }
});

test('缺失 session_id 留空串、缺失 asserted_at 留空（不报错、不伪造当前时间）', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    log.append({ event_id: 'a', speaker: 'user', raw_text: 'x' });

    const row = log.readAll()[0];
    assert.equal(row?.session_id, '');
    assert.equal(row?.asserted_at, '');
    assert.equal(row?.turn_id, '');
    assert.notEqual(row?.ingested_at, '', 'ingested_at 由系统维护，必有值');
  } finally {
    cleanupTempRoot(root);
  }
});

test('content_hash = sha256(raw_text)', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    log.append({ event_id: 'a', speaker: 'user', raw_text: '你好，世界' });
    assert.equal(log.readAll()[0]?.content_hash, contentHashOf('你好，世界'));
  } finally {
    cleanupTempRoot(root);
  }
});

test('坏行必须抛出（绝不用空串覆盖既有数据）', () => {
  const root = makeTempRoot();
  try {
    const dir = path.join(root, 'raw-turns');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-11.jsonl'), '{"event_id":"a"}\n{ 坏行 }\n', 'utf8');

    const log = new RawLog('dsh', dir);
    assert.throws(() => log.readShard('2026-11'), CorruptedError);
  } finally {
    cleanupTempRoot(root);
  }
});

test('双定位指针：按 id 与按 (shard, seq) 解析到同一行', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    log.append({ event_id: 'e1', speaker: 'user', raw_text: '第一行' });
    log.append({ event_id: 'e2', speaker: 'user', raw_text: '第二行' });

    const byId = log.resolve({ id: 'e2' });
    const bySeq = log.resolve({ shard: '2026-11', seq: 1 });

    assert.equal(byId.length, 1);
    assert.equal(byId[0]?.event_id, 'e2');
    assert.equal(bySeq[0]?.event_id, 'e2');
    assert.equal(byId[0]?.raw_text, bySeq[0]?.raw_text);
  } finally {
    cleanupTempRoot(root);
  }
});

test('指针区间为闭区间（含两端）', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    for (const id of ['a', 'b', 'c', 'd']) {
      log.append({ event_id: id, speaker: 'user', raw_text: id });
    }

    const rows = log.resolve({ shard: '2026-11', seq: [1, 3] });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.event_id), ['b', 'c', 'd']);
  } finally {
    cleanupTempRoot(root);
  }
});

test('指针越界抛 OutOfRangeError；目标不存在抛 NotFoundError', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    log.append({ event_id: 'a', speaker: 'user', raw_text: 'x' });

    assert.throws(() => log.resolve({ shard: '2026-11', seq: 5 }), OutOfRangeError);
    assert.throws(() => log.resolve({ id: 'missing' }), NotFoundError);
    assert.throws(() => log.resolve({}), NotFoundError);
  } finally {
    cleanupTempRoot(root);
  }
});

test('空消息 / 纯空白 / 超长消息 / 极短消息 / 纯 emoji 全部原样落盘（不裁剪不丢弃）', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    const payloads = ['', '   \n\t ', 'x'.repeat(100_000), '短', '😀🎉', '！！！'];

    payloads.forEach((text, index) => {
      log.append({ event_id: `e${index}`, speaker: 'user', raw_text: text });
    });

    const rows = log.readAll();
    assert.equal(rows.length, payloads.length);
    payloads.forEach((text, index) => {
      assert.equal(rows[index]?.raw_text, text);
    });
  } finally {
    cleanupTempRoot(root);
  }
});

test('跨月分片：不同摄入月落到不同文件', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    // 用月中时刻，避免跨时区时落在月末/月初边界。
    log.append({ event_id: 'a', speaker: 'user', raw_text: 'x', ingested_at: '2026-10-15T12:00:00.000Z' });
    log.append({ event_id: 'b', speaker: 'user', raw_text: 'x', ingested_at: '2026-11-15T12:00:00.000Z' });

    assert.equal(log.shards().length, 2, '两个摄入月应落到两个分片');
    assert.equal(log.readShard(log.shards()[0] as string).length, 1);
    assert.equal(log.readShard(log.shards()[1] as string).length, 1);
    assert.equal(log.count(), 2);
  } finally {
    cleanupTempRoot(root);
  }
});

test('分片键取摄入月（本地日期口径，沿用旧项目 localDateString）', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    const ingested = '2026-03-15T12:00:00.000Z';
    log.append({ event_id: 'a', speaker: 'user', raw_text: 'x', ingested_at: ingested });

    // 分片键与同一时刻的本地月份一致（旧行为契约 1.4：本地日期口径）。
    const local = new Date(ingested);
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}`;
    assert.deepEqual(log.shards(), [expected]);
  } finally {
    cleanupTempRoot(root);
  }
});
