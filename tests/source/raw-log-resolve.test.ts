/**
 * resolve 快路径的 id 比对（审计 M8 / 阶段 0 · G02）。
 *
 * 双定位口径：id 权威，shard + seq 冗余加速。
 * 冗余坐标一旦陈旧（命中行的 event_id 与 pointer.id 不符），
 * 不得静默返回错行 —— 必须回退到 id 扫描（权威路径）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { Fasti } from '../../src/api/index.ts';
import { RawLog } from '../../src/source/raw-log.ts';
import { NotFoundError } from '../../src/core/errors.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

/** 建一个只含两行原文的日志（同一分片，seq 0/1）。 */
function seedLog(root: string): RawLog {
  const log = new RawLog('dsh', path.join(root, 'raw-turns'));
  log.append({
    event_id: 'raw-1',
    speaker: 'user',
    raw_text: '第一行',
    ingested_at: '2026-11-15T12:00:00.000Z',
  });
  log.append({
    event_id: 'raw-2',
    speaker: 'user',
    raw_text: '第二行',
    ingested_at: '2026-11-15T12:00:00.000Z',
  });
  return log;
}

test('G02：给了 id 且 (shard,seq) 命中行 id 相符 → 快路径直接返回', () => {
  const root = makeTempRoot();
  try {
    const log = seedLog(root);
    const rows = log.resolve({ id: 'raw-2', shard: '2026-11', seq: 1 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event_id, 'raw-2');
    assert.equal(rows[0]?.raw_text, '第二行');
  } finally {
    cleanupTempRoot(root);
  }
});

test('G02：给了 id 但 (shard,seq) 命中行 id 不符 → 回退 id 扫描，返回 id 真正所在的那行', () => {
  const root = makeTempRoot();
  try {
    const log = seedLog(root);
    // seq=0 命中的是 raw-1，而权威 id 指向 raw-2 → 冗余坐标已陈旧。
    const rows = log.resolve({ id: 'raw-2', shard: '2026-11', seq: 0 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event_id, 'raw-2', '不得静默返回 seq 命中的那一行');
    assert.equal(rows[0]?.raw_text, '第二行');
  } finally {
    cleanupTempRoot(root);
  }
});

test('G02：冗余坐标指向别处分片时同样回退 id 扫描', () => {
  const root = makeTempRoot();
  try {
    const log = new RawLog('dsh', path.join(root, 'raw-turns'));
    log.append({
      event_id: 'raw-1',
      speaker: 'user',
      raw_text: '第一行',
      ingested_at: '2026-10-15T12:00:00.000Z',
    });
    log.append({
      event_id: 'raw-2',
      speaker: 'user',
      raw_text: '第二行',
      ingested_at: '2026-11-15T12:00:00.000Z',
    });

    // 指针说 raw-2 在 2026-10 分片 seq=0 —— 那里实际是 raw-1。
    const rows = log.resolve({ id: 'raw-2', shard: '2026-10', seq: 0 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event_id, 'raw-2');
  } finally {
    cleanupTempRoot(root);
  }
});

test('G02：id 与冗余坐标都不命中 → 抛 NotFoundError（不返回陈旧行、不返回空）', () => {
  const root = makeTempRoot();
  try {
    const log = seedLog(root);
    assert.throws(
      () => log.resolve({ id: 'raw-missing', shard: '2026-11', seq: 0 }),
      NotFoundError,
    );
  } finally {
    cleanupTempRoot(root);
  }
});

test('G02：未提供 id → 快路径行为不变（只按 (shard,seq) 定位）', () => {
  const root = makeTempRoot();
  try {
    const log = seedLog(root);
    const rows = log.resolve({ shard: '2026-11', seq: 0 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event_id, 'raw-1');
  } finally {
    cleanupTempRoot(root);
  }
});

test('G02：区间指针命中行与 id 不符 → 回退 id 扫描（不返回区间里的错行）', () => {
  const root = makeTempRoot();
  try {
    const log = seedLog(root);
    log.append({
      event_id: 'raw-3',
      speaker: 'user',
      raw_text: '第三行',
      ingested_at: '2026-11-15T12:00:00.000Z',
    });

    // 区间 [0,1] 命中 raw-1/raw-2，而权威 id 指向 seq=2 的 raw-3。
    const rows = log.resolve({ id: 'raw-3', shard: '2026-11', seq: [0, 1] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event_id, 'raw-3');
  } finally {
    cleanupTempRoot(root);
  }
});

test('G02：区间指针命中行里含 id → 快路径返回整个区间（既有语义不变）', () => {
  const root = makeTempRoot();
  try {
    const log = seedLog(root);
    const rows = log.resolve({ id: 'raw-2', shard: '2026-11', seq: [0, 1] });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.event_id), ['raw-1', 'raw-2']);
  } finally {
    cleanupTempRoot(root);
  }
});

test('G02：门面对陈旧冗余坐标也以 id 为准（resolvePointer）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    seedLog(root);
    const resolved = await fasti.resolvePointer({
      id: 'raw-2',
      channel: 'dsh',
      shard: '2026-11',
      seq: 0,
    });
    assert.equal(resolved.turns.length, 1);
    assert.equal(resolved.turns[0]?.event_id, 'raw-2');
    assert.equal(resolved.turns[0]?.raw_text, '第二行');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
