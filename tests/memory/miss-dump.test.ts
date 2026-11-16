/**
 * #117 批 5 红测：dry-run 留存高亮 + --dump-miss 裁剪前取证出口。
 *
 * 口径：裁定定稿 §3.2 第 5 件与 PF-1（"已删即毁"，取证必须发生在裁剪之前）。
 * 纪律：dump 只读打开库、输出不得落数据根内、零跑构建流。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { EventRecord } from '../../src/contract/event.ts';
import { appendJsonl } from '../../src/core/jsonl.ts';
import { ulid } from '../../src/core/ulid.ts';
import { buildMemoryIndex } from '../../src/memory/builder.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../src/memory/store.ts';
import { cleanupTempRoot, makeExperience, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliScript = path.join(repoRoot, 'scripts', 'build-memory-index.ts');

function makeTruth(): string {
  const root = makeTempRoot('miss-dump-');
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

async function seedMisses(root: string, n: number): Promise<void> {
  const handle = openMemoryWrite({ indexDir: path.join(root, 'projection', 'memory-index') });
  try {
    for (let i = 0; i < n; i += 1) {
      handle.recordMiss({
        termNorm: `取证词-${i}`,
        channel: 'dsh',
        anchorEventId: null,
        anchorIds: null,
        returnedCount: 0,
        observedMs: T0 + DAY + i * 3_600_000,
        gateStatus: i % 3 === 0 ? 'abstain' : 'no-match',
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
  policyVersion: 'test-dump-v1',
});

test('dry-run 报告：窗内超顶时高亮字段按事实填充，且库里零删除', async () => {
  const root = makeTruth();
  try {
    await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + DAY });
    await seedMisses(root, 6);

    const report = await buildMemoryIndex({
      dataRoot: root,
      dryRun: true,
      nowMs: T0 + 6 * DAY,
      missRetention: POLICY(T0 + 6 * DAY, 3),
    });
    assert.equal(report.misses, 3);
    const block = report.missRetention;
    assert.ok(block !== undefined, '有观测行就必须带留存对账块');
    assert.equal(block.totalBefore, 6);
    assert.equal(block.kept, 3);
    assert.equal(block.droppedOverflow, 3);
    assert.equal(block.droppedAgeOut, 0);
    assert.equal(block.rowsDeletedWithinValidationPeriod, 3, '高亮口径 = 窗内超顶被裁');
    assert.equal(block.windowCompressed, true);
    assert.equal(block.hardCapK, 3);
    assert.equal(block.windowDays, 180);
    assert.equal(block.policyVersion, 'test-dump-v1');

    // dry-run 只报告不落刀。
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'projection', 'memory-index', MEMORY_INDEX_FILE), {
      readOnly: true,
    });
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM mem_miss').get() as { n: number };
      assert.equal(count.n, 6);
    } finally {
      db.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('dry-run 报告：未越顶时高亮为 0/false（不虚报风险）', async () => {
  const root = makeTruth();
  try {
    await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + DAY });
    await seedMisses(root, 3);
    const report = await buildMemoryIndex({
      dataRoot: root,
      dryRun: true,
      nowMs: T0 + 6 * DAY,
      missRetention: POLICY(T0 + 6 * DAY, 10),
    });
    assert.equal(report.missRetention?.rowsDeletedWithinValidationPeriod, 0);
    assert.equal(report.missRetention?.windowCompressed, false);
    assert.equal(report.missRetention?.kept, 3);
  } finally {
    cleanupTempRoot(root);
  }
});

test('--dump-miss：只读导出全表 JSONL（含 gate_status），库零变化', async () => {
  const root = makeTruth();
  const outFile = path.join(makeTempRoot('miss-dump-out-'), 'miss.jsonl');
  try {
    await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + DAY });
    await seedMisses(root, 5);
    const dbFile = path.join(root, 'projection', 'memory-index', MEMORY_INDEX_FILE);
    const before = fs.statSync(dbFile).mtimeMs;

    const result = spawnSync(
      process.execPath,
      [cliScript, '--data-root', root, '--dump-miss', outFile, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `CLI 应成功：${result.stderr}`);
    const report = JSON.parse(result.stdout) as { rows: number; columnCount: number };
    assert.equal(report.rows, 5);
    assert.equal(report.columnCount, 9, '导出必须带上 schema v2 的九列（含 gate_status）');

    const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    for (const column of ['id', 'term_norm', 'gate_status', 'observed_ms', 'channel']) {
      assert.ok(column in first, `导出缺列 ${column}`);
    }
    assert.ok(['no-match', 'abstain'].includes(String(first['gate_status'])));
    // 顺序口径：按 observed_ms 升序，最早的在最前。
    const observedAsc = lines.map((line) => (JSON.parse(line) as { observed_ms: number }).observed_ms);
    assert.deepEqual(observedAsc, [...observedAsc].sort((a, b) => a - b));

    const after = fs.statSync(dbFile).mtimeMs;
    assert.equal(after, before, '取证不得触碰库（mtime 不变）');
  } finally {
    cleanupTempRoot(root);
    fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
  }
});

test('--dump-miss：拒绝把输出写进数据根（防污染真源目录）', async () => {
  const root = makeTruth();
  try {
    await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + DAY });
    const result = spawnSync(
      process.execPath,
      [cliScript, '--data-root', root, '--dump-miss', path.join(root, 'miss-export.jsonl')],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不得落在数据根内/);
    assert.ok(!fs.existsSync(path.join(root, 'miss-export.jsonl')));
  } finally {
    cleanupTempRoot(root);
  }
});

test('--dump-miss：库不存在时退出码 1 且不建任何文件', async () => {
  const root = makeTempRoot('miss-dump-empty-');
  const outFile = path.join(makeTempRoot('miss-dump-out2-'), 'miss.jsonl');
  try {
    appendJsonl(
      path.join(root, 'experiences', '2026-11.jsonl'),
      makeExperience({ id: ulid(), tick: 0, occurred_at: iso(T0), recorded_at: iso(T0) }),
    );
    const result = spawnSync(
      process.execPath,
      [cliScript, '--data-root', root, '--dump-miss', outFile],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /记忆索引库不存在/);
    assert.ok(!fs.existsSync(outFile));
  } finally {
    cleanupTempRoot(root);
    fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
  }
});
