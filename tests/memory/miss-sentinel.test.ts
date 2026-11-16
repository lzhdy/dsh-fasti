/**
 * #117 批 4 红测：进程内哨兵（miss-sentinel）+ 写柄接线。
 *
 * 口径：裁定定稿 §3.2 第 3 件「打开播种一次 + 写入递增 + 硬顶 70% 一次告警」。
 * 纪律：零 IO、零定时器；告警不得反向污染写入；裁剪后必须重校准。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';
import { openMemoryWrite } from '../../src/memory/store.ts';
import {
  MISS_SENTINEL_WARN_RATIO,
  createMissSentinel,
  missSentinelMessage,
} from '../../src/memory/miss-sentinel.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');

test('哨兵纯逻辑：阈值 = ceil(K*0.7)，跨阈值告警一次且只一次', () => {
  const warnings: number[] = [];
  const sentinel = createMissSentinel({
    hardCapK: 10,
    onWarn: (warning) => warnings.push(warning.rowCount),
  });
  assert.equal(sentinel.snapshot().warnAt, 7);
  for (let i = 0; i < 20; i += 1) {
    sentinel.onAppend();
  }
  assert.deepEqual(warnings, [7], '跨阈值只告警一次，之后不再刷屏');
  assert.equal(sentinel.snapshot().rowCount, 20);
});

test('哨兵纯逻辑：播种在阈值之上也不补告警（只在跨阈值那一刻报）', () => {
  const warnings: number[] = [];
  const sentinel = createMissSentinel({ hardCapK: 10, onWarn: (w) => warnings.push(w.rowCount) });
  sentinel.reseed(9);
  assert.equal(warnings.length, 0, '打开时已在阈值上：本轮不补报，由 drain 裁剪或运维观察接管');
  sentinel.onAppend();
  assert.equal(warnings.length, 1, '再写一行即跨阈值，此时报');
});

test('哨兵纯逻辑：回调抛错不得污染写入路径', () => {
  const sentinel = createMissSentinel({
    hardCapK: 2,
    onWarn: () => {
      throw new Error('logger down');
    },
  });
  sentinel.onAppend();
  assert.doesNotThrow(() => sentinel.onAppend());
  assert.equal(sentinel.snapshot().rowCount, 2);
});

test('哨兵纯逻辑：非法入参即拒（硬顶非正、比例越界、种子负数）', () => {
  assert.throws(() => createMissSentinel({ hardCapK: 0 }), /hardCapK/);
  assert.throws(() => createMissSentinel({ hardCapK: 10, warnRatio: 0 }), /warnRatio/);
  assert.throws(() => createMissSentinel({ hardCapK: 10, warnRatio: 1.5 }), /warnRatio/);
  const sentinel = createMissSentinel({ hardCapK: 10 });
  assert.throws(() => sentinel.reseed(-1), /rowCount/);
  assert.equal(MISS_SENTINEL_WARN_RATIO, 0.7);
});

test('哨兵文案：含行数/上限与"日级节拍"可操作提示', () => {
  const message = missSentinelMessage({ rowCount: 140, warnAt: 140, hardCapK: 200 });
  assert.match(message, /140/);
  assert.match(message, /200/);
  assert.match(message, /日级|裁剪/);
});

test('写柄接线：打开即播种真实行数，写入递增，跨阈值告警一次', async () => {
  const root = makeTempRoot('miss-sentinel-');
  try {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const warnings: string[] = [];
    const handle = openMemoryWrite(
      { indexDir },
      {
        missSentinel: { hardCapK: 10, onWarn: (warning) => warnings.push(missSentinelMessage(warning)) },
      },
    );
    try {
      assert.equal(handle.missSentinelSnapshot().rowCount, 0, '空库播种 0');
      for (let i = 0; i < 7; i += 1) {
        handle.recordMiss({
          termNorm: `哨兵词-${i}`,
          channel: 'dsh',
          anchorEventId: null,
          anchorIds: null,
          returnedCount: 0,
          observedMs: T0 + i * 60_000,
          gateStatus: 'no-match',
        });
      }
      assert.equal(handle.missSentinelSnapshot().rowCount, 7);
      assert.equal(warnings.length, 1, '第 7 行跨阈值即报');
      for (let i = 7; i < 12; i += 1) {
        handle.recordMiss({
          termNorm: `哨兵词-${i}`,
          channel: 'dsh',
          anchorEventId: null,
          anchorIds: null,
          returnedCount: 0,
          observedMs: T0 + i * 60_000,
          gateStatus: 'abstain',
        });
      }
      assert.equal(warnings.length, 1, '继续写不再重复告警');
      assert.equal(handle.missSentinelSnapshot().warned, true);
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('写柄接线：重开时播种既有行数；裁剪后重校准（不永久闭麦）', async () => {
  const root = makeTempRoot('miss-sentinel-');
  try {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const first = openMemoryWrite({ indexDir });
    try {
      for (let i = 0; i < 4; i += 1) {
        first.recordMiss({
          termNorm: `重开词-${i}`,
          channel: 'dsh',
          anchorEventId: null,
          anchorIds: null,
          returnedCount: 0,
          observedMs: T0 + i * 60_000,
          gateStatus: 'no-match',
        });
      }
    } finally {
      await first.close();
    }

    const warnings: number[] = [];
    const second = openMemoryWrite(
      { indexDir },
      { missSentinel: { hardCapK: 5, onWarn: (warning) => warnings.push(warning.rowCount) } },
    );
    try {
      assert.equal(second.missSentinelSnapshot().rowCount, 4, '重开播种既有 4 行');
      const outcome = second.pruneMisses({
        asOfMs: T0,
        windowDays: 180,
        hardCapK: 2,
        policyVersion: 'test-sentinel-v1',
      });
      assert.equal(outcome.applied, true);
      assert.equal(second.missSentinelSnapshot().rowCount, 2, '裁剪后重校准到 kept');
      // 重校准后继续写：越过 ceil(5*0.7)=4 时应能再次告警（不是永久闭麦）。
      for (let i = 0; i < 3; i += 1) {
        second.recordMiss({
          termNorm: `重校准词-${i}`,
          channel: 'dsh',
          anchorEventId: null,
          anchorIds: null,
          returnedCount: 0,
          observedMs: T0 + 100 * 60_000 + i * 60_000,
          gateStatus: 'no-match',
        });
      }
      assert.equal(warnings.length, 1, '重校准后跨阈值有且仅有一次告警');
    } finally {
      await second.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('静态纪律：哨兵模块零 IO / 零定时器 / 零墙钟', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(
      new URL('../../src/memory/miss-sentinel.ts', import.meta.url),
      'utf8',
    ),
  );
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/'))
    .join('\n');
  for (const forbidden of [
    'setInterval',
    'setTimeout',
    'Date.now',
    'node:fs',
    "from 'node:fs'",
    'process.hrtime',
  ]) {
    assert.ok(!code.includes(forbidden), `哨兵不得包含 ${forbidden}`);
  }
});
