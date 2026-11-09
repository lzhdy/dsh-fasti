/**
 * 事件层参数 + 检查点扩展测试（技术基线 §5.1 / §5.6 · 任务卡 T3）。
 *
 * 覆盖：默认参数、参数解析与注入、参数只此一处、摘要上限常量单一来源、
 * 检查点事件层字段的读写与旧检查点文件兼容。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUMMARY_MAX_CHARS } from '../../src/contract/event.ts';
import { DEFAULT_EVENT_PARAMS, resolveEventParams } from '../../src/event/params.ts';
import { CheckpointStore } from '../../src/runtime/checkpoint.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/** 剥掉注释与字符串，只留代码（用于「字面量只此一处」的静态断言）。 */
function codeOf(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** src/ 下的全部 .ts 文件。 */
function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  walk(path.join(repoRoot, 'src'));
  return out;
}

test('参数：默认值与基线一致', () => {
  assert.equal(DEFAULT_EVENT_PARAMS.silenceGapMinutes, 30);
  assert.equal(DEFAULT_EVENT_PARAMS.maxRecordsPerEvent, 20);
  assert.equal(DEFAULT_EVENT_PARAMS.summaryMaxChars, 600);
  assert.equal(DEFAULT_EVENT_PARAMS.orphanWindowDays, 7);
  assert.equal(DEFAULT_EVENT_PARAMS.recentWindow, 10);
  assert.equal(DEFAULT_EVENT_PARAMS.minSimilarity, 0.7);
});

test('参数：resolveEventParams 无注入时返回默认值副本', () => {
  const resolved = resolveEventParams();
  assert.deepEqual(resolved, DEFAULT_EVENT_PARAMS);

  resolved.silenceGapMinutes = 1;
  assert.equal(DEFAULT_EVENT_PARAMS.silenceGapMinutes, 30, '默认值不得被调用方改掉');
});

test('参数：resolveEventParams 只覆盖给定的项', () => {
  const resolved = resolveEventParams({ silenceGapMinutes: 5, maxRecordsPerEvent: 3 });
  assert.equal(resolved.silenceGapMinutes, 5);
  assert.equal(resolved.maxRecordsPerEvent, 3);
  assert.equal(resolved.orphanWindowDays, DEFAULT_EVENT_PARAMS.orphanWindowDays);
  assert.equal(resolved.minSimilarity, DEFAULT_EVENT_PARAMS.minSimilarity);
});

test('参数：显式传 undefined 视为未给出（取默认值）', () => {
  const resolved = resolveEventParams({ silenceGapMinutes: undefined });
  assert.equal(resolved.silenceGapMinutes, DEFAULT_EVENT_PARAMS.silenceGapMinutes);
});

test('参数：可调参数只此一处 —— 其他模块不得自带同义常量', () => {
  const names = [
    'silenceGapMinutes',
    'maxRecordsPerEvent',
    'summaryMaxChars',
    'orphanWindowDays',
    'recentWindow',
    'minSimilarity',
  ];
  const hits: string[] = [];
  for (const file of srcFiles()) {
    if (file === path.join(repoRoot, 'src', 'event', 'params.ts')) {
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    for (const name of names) {
      if (text.includes(name)) {
        hits.push(`${path.relative(repoRoot, file)}:${name}`);
      }
    }
  }
  assert.deepEqual(hits, [], `可调参数只允许出现在 src/event/params.ts：${hits.join('、')}`);
});

/**
 * 数「独立的数值 600」在一段代码里出现几次。
 *
 * 判据要认**数字边界**：`600_000`（退避上限，用数字分节符写的另一个数）、`1600`、
 * `6000`、`x600`（标识符的一部分）、`600ms`（带单位）—— 这些都**不是**摘要上限，
 * 裸 `split('600')` 会把它们误判成第二处字面量。
 */
function countLiteral600(code: string): number {
  return (code.match(/(?<![0-9A-Za-z_$])600(?![0-9A-Za-z_$])/g) ?? []).length;
}

test('参数：字面量判据本身可判（数字边界 —— 判据失效会让门禁变哑，必须自证）', () => {
  // 独立数值 → 命中
  assert.equal(countLiteral600('const limit = 600;'), 1);
  assert.equal(countLiteral600('f(600)'), 1);

  // 数字分节符形式的不同数值 → 不命中
  assert.equal(countLiteral600('const RETRY_MAX_DELAY_MS = 600_000;'), 0);

  // 含 600 但不是独立数值 → 不命中
  assert.equal(countLiteral600('const x = 1600;'), 0);
  assert.equal(countLiteral600('const x = 6000;'), 0);
  assert.equal(countLiteral600('const x600 = 1;'), 0);
  assert.equal(countLiteral600('const x = 600ms;'), 0);
});

test('参数：摘要上限字面量只有一处（契约层定义，参数层引用同一常量）', () => {
  assert.equal(SUMMARY_MAX_CHARS, 600);
  assert.equal(DEFAULT_EVENT_PARAMS.summaryMaxChars, SUMMARY_MAX_CHARS);

  const occurrences: string[] = [];
  for (const file of srcFiles()) {
    const code = codeOf(file);
    const count = countLiteral600(code);
    if (count > 0) {
      occurrences.push(path.relative(repoRoot, file).split(path.sep).join('/') + `:${count}`);
    }
  }
  assert.deepEqual(occurrences, ['src/contract/event.ts:1'], '摘要上限字面量 600 只允许出现一次');
});

test('检查点：旧检查点文件（无事件层字段）可正常载入，既有字段语义不变', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'state', 'checkpoint.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          version: 1,
          tick: 42,
          engine: 'L1',
          degraded: false,
          degraded_reason: '',
          needs_rebuild: false,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const store = new CheckpointStore(file);
    const loaded = store.load();
    assert.equal(loaded.version, 1);
    assert.equal(loaded.tick, 42);
    assert.equal(loaded.engine, 'L1');
    assert.equal(loaded.degraded, false);
    assert.equal(loaded.needs_rebuild, false);
    assert.equal(loaded.last_projected_tick, undefined);
    assert.equal(loaded.pending_events, undefined);
    assert.equal(loaded.stage_failures, undefined);
  } finally {
    cleanupTempRoot(root);
  }
});

test('检查点：事件层字段可写可存可读回', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'state', 'checkpoint.json');
    const store = new CheckpointStore(file);
    store.load();
    store.setLastProjectedTick(128);
    store.setPendingEvents(7);
    store.setStageFailures(2);
    store.save();

    const reloaded = new CheckpointStore(file).load();
    assert.equal(reloaded.last_projected_tick, 128);
    assert.equal(reloaded.pending_events, 7);
    assert.equal(reloaded.stage_failures, 2);
    assert.equal(reloaded.version, 1, '既有字段与 version 语义不变');
  } finally {
    cleanupTempRoot(root);
  }
});

test('检查点：文件不存在时用默认值，既有字段不受影响', () => {
  const root = makeTempRoot();
  try {
    const store = new CheckpointStore(path.join(root, 'state', 'checkpoint.json'));
    const loaded = store.load();
    assert.equal(loaded.version, 1);
    assert.equal(loaded.tick, 0);
    assert.equal(loaded.engine, 'L1');
    assert.equal(loaded.last_projected_tick, undefined);
  } finally {
    cleanupTempRoot(root);
  }
});

test('检查点：stage 失败 = 累计计数 + 最近 10 条明细（环形缓冲）', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'state', 'checkpoint.json');
    const store = new CheckpointStore(file);
    store.load();

    const recent = Array.from({ length: 15 }, (_, index) => ({
      stage: 'segmenter',
      experience_id: `exp-${index}`,
      channel: 'dsh',
      at: '2026-11-08T10:00:00.000Z',
      error: 'boom',
    }));
    store.setStageFailures(42, recent);
    store.save();

    const reloaded = new CheckpointStore(file).load();
    assert.equal(reloaded.stage_failures, 42, '累计计数：既知发生过多少');
    assert.equal(reloaded.stage_failure_recent?.length, 10, '明细只留最近 10 条（无界数组会撑大检查点）');
    assert.equal(reloaded.stage_failure_recent?.[0]?.experience_id, 'exp-5', '留的是最近 10 条');
  } finally {
    cleanupTempRoot(root);
  }
});
