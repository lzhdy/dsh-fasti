/**
 * #117 批 3 红测：重建对账（builder 用同一个 miss-retention 纯函数）+ N-4 台账先行。
 *
 * 口径：裁定定稿 §3.2 第 2 件（重建与 drain 同口径）与 §3.3 N-4（台账先 append → fsync → rename）。
 * 关键不变式：rename 失败时数据不得消失（旧库原样），台账允许"多记未遂"。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import type { EventRecord } from '../../src/contract/event.ts';
import { appendJsonl } from '../../src/core/jsonl.ts';
import { ulid } from '../../src/core/ulid.ts';
import { buildMemoryIndex } from '../../src/memory/builder.ts';
import { readDecisions } from '../../src/memory/ledger.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../src/memory/store.ts';
import { cleanupTempRoot, makeExperience, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

function makeTruth(): string {
  const root = makeTempRoot('builder-retention-');
  const exp = ulid();
  appendJsonl(
    path.join(root, 'experiences', '2026-11.jsonl'),
    makeExperience({ id: exp, tick: 0, occurred_at: iso(T0), recorded_at: iso(T0) }),
  );
  const event: EventRecord = {
    id: ulid(),
    schema_version: 1,
    version: 1,
    status: 'closed',
    closed_reason: 'silence',
    pointers: [{ id: exp }],
    time_range: { started_at: iso(T0), ended_at: iso(T0 + DAY) },
    assembled_at: iso(T0 + DAY),
    summary: '客观摘要',
    key_points: ['关键点一'],
    anchors: [exp],
    topic_lines: [],
    summary_quality: 'ready',
    summary_source: 'llm',
    summary_prompt_version: null,
    summary_model: null,
    effective_chars: null,
    raw_chars: null,
    created_by: 'system',
    created_at: iso(T0 + DAY),
    channel: 'dsh',
    boundary_candidates: [],
  };
  appendJsonl(path.join(root, 'events', '2026-11.jsonl'), event);
  return root;
}

function indexDirOf(root: string): string {
  return path.join(root, 'projection', 'memory-index');
}

function countMiss(root: string): number {
  const db = new DatabaseSync(path.join(indexDirOf(root), MEMORY_INDEX_FILE), { readOnly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM mem_miss').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

async function seedMisses(root: string, n: number): Promise<void> {
  const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
  try {
    for (let i = 0; i < n; i += 1) {
      handle.recordMiss({
        termNorm: `重建漏召-${i}`,
        channel: 'dsh',
        anchorEventId: null,
        anchorIds: null,
        returnedCount: 0,
        observedMs: T0 + DAY + i * 3_600_000,
        gateStatus: 'no-match',
      });
    }
  } finally {
    await handle.close();
  }
}

const POLICY = (asOfMs: number, hardCapK: number) => ({
  asOfMs,
  windowDays: 180,
  hardCapK,
  policyVersion: 'test-rebuild-v1',
});

test('重建对账：mem_miss 超顶按同一纯函数裁剪，报告与库行一致，台账一条', async () => {
  const root = makeTruth();
  try {
    await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + DAY });
    await seedMisses(root, 6);
    assert.equal(countMiss(root), 6);

    const report = await buildMemoryIndex({
      dataRoot: root,
      dryRun: false,
      nowMs: T0 + 6 * DAY,
      missRetention: POLICY(T0 + 6 * DAY, 3),
    });
    assert.equal(report.misses, 3, '报告口径必须是裁剪后的行数');
    assert.equal(countMiss(root), 3);

    const retentionLines = readDecisions(indexDirOf(root)).filter(
      (record) => record.action === 'miss-retention',
    );
    assert.equal(retentionLines.length, 1, '重建裁剪必须留一条同形台账');
    assert.equal(retentionLines[0]!.created_by, 'system');
    assert.equal(retentionLines[0]!.missRetention?.kept, 3);
    assert.equal(retentionLines[0]!.missRetention?.hardCapK, 3);
    assert.equal(retentionLines[0]!.missRetention?.droppedOverflow, 3);
    assert.equal(retentionLines[0]!.model_tag, 'test-rebuild-v1');
  } finally {
    cleanupTempRoot(root);
  }
});

test('重建对账：已收敛后再次重建零写台账（对账幂等）', async () => {
  const root = makeTruth();
  try {
    await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + DAY });
    await seedMisses(root, 5);
    const policy = POLICY(T0 + 6 * DAY, 2);
    await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + 6 * DAY, missRetention: policy });
    const before = readDecisions(indexDirOf(root)).length;
    await buildMemoryIndex({
      dataRoot: root,
      dryRun: false,
      nowMs: T0 + 12 * DAY,
      missRetention: POLICY(T0 + 12 * DAY, 2),
    });
    assert.equal(readDecisions(indexDirOf(root)).length, before, '未越顶不得再写台账');
    assert.equal(countMiss(root), 2);
  } finally {
    cleanupTempRoot(root);
  }
});

test('N-4 台账先行：rename 失败时旧库原样（数据不消失），台账允许"多记未遂"', async () => {
  const root = makeTruth();
  const realRename = fs.renameSync;
  try {
    await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + DAY });
    await seedMisses(root, 4);

    fs.renameSync = (() => {
      throw new Error('injected rename failure');
    }) as typeof fs.renameSync;
    try {
      await assert.rejects(
        buildMemoryIndex({
          dataRoot: root,
          dryRun: false,
          nowMs: T0 + 6 * DAY,
          missRetention: POLICY(T0 + 6 * DAY, 2),
        }),
        /injected rename failure/,
      );
    } finally {
      fs.renameSync = realRename;
    }

    // 旧库完好：4 行一行没少（"已删"只可能随库文件一起生效）。
    assert.equal(countMiss(root), 4, 'rename 失败时绝不允许已删');
    const retentionLines = readDecisions(indexDirOf(root)).filter(
      (record) => record.action === 'miss-retention',
    );
    assert.equal(retentionLines.length, 1, '台账先行：失败前已落盘，属可容忍的多记未遂');
  } finally {
    fs.renameSync = realRename;
    cleanupTempRoot(root);
  }
});

test('重建对账：dry-run 报告裁剪后行数但零写入（不放宽只读纪律）', async () => {
  const root = makeTruth();
  try {
    await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + DAY });
    await seedMisses(root, 4);
    const decisionsBefore = readDecisions(indexDirOf(root)).length;
    const report = await buildMemoryIndex({
      dataRoot: root,
      dryRun: true,
      nowMs: T0 + 6 * DAY,
      missRetention: POLICY(T0 + 6 * DAY, 2),
    });
    assert.equal(report.misses, 2, 'dry-run 也要展示裁剪后台账口径');
    assert.equal(countMiss(root), 4, 'dry-run 零写：真实库不动');
    assert.equal(readDecisions(indexDirOf(root)).length, decisionsBefore, 'dry-run 不写台账');
  } finally {
    cleanupTempRoot(root);
  }
});
