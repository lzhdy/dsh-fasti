/**
 * #117 批 1 红测：留存裁剪纯函数（computeMissRetention）。
 *
 * 口径来源：docs/task117-external-review-response.md §8「红测最小集」。
 * 纪律：纯函数零 IO、不读墙钟（asOfMs 注入）、不改入参；常数位为段一临时值。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IntegrityError } from '../../src/core/errors.ts';
import {
  MISS_RETENTION_POLICY_PROVISIONAL,
  MISS_RETENTION_TMP_POLICY,
  computeKeptContentHash,
  computeMissRetention,
  floorToUtcDay,
  type MissRetentionRow,
} from '../../src/memory/miss-retention.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 86_400_000;

/** ULID 形状的稳定 id（时间有序前缀 + 去重尾），用于同毫秒决胜断言。 */
function rid(n: number): string {
  return `01K${String(n).padStart(5, '0')}0000000000000000`;
}

function rows(observed: Array<[number, number]>, extra: Record<string, unknown> = {}): MissRetentionRow[] {
  return observed.map(([index, ms]) => ({
    id: rid(index),
    observedMs: ms,
    ...extra,
  }));
}

function policy(overrides: Partial<Parameters<typeof computeMissRetention>[1]> = {}) {
  return {
    asOfMs: T0,
    windowDays: 30,
    hardCapK: 10,
    policyVersion: 'test-v',
    ...overrides,
  };
}

test('computeMissRetention：0 行 → 全空、账目归零、cutoff 仍算出', () => {
  const result = computeMissRetention([], policy());
  assert.deepEqual(result.survivors, []);
  assert.equal(result.droppedAgeOut, 0);
  assert.equal(result.droppedOverflow, 0);
  assert.equal(result.totalBefore, 0);
  assert.equal(result.kept, 0);
  assert.equal(result.windowCompressed, false);
  assert.equal(result.cutoffMs, floorToUtcDay(T0) - 30 * DAY);
});

test('computeMissRetention：窗口内恰满 K → 零溢出、未压缩', () => {
  const input = rows(Array.from({ length: 10 }, (_, i) => [i, T0 - i * DAY] as [number, number]));
  const result = computeMissRetention(input, policy({ hardCapK: 10 }));
  assert.equal(result.kept, 10);
  assert.equal(result.droppedOverflow, 0);
  assert.equal(result.droppedAgeOut, 0);
  assert.equal(result.windowCompressed, false);
});

test('computeMissRetention：越界一行 → 溢出 1、windowCompressed 显影', () => {
  const input = rows(Array.from({ length: 11 }, (_, i) => [i, T0 - i * DAY] as [number, number]));
  const result = computeMissRetention(input, policy({ hardCapK: 10 }));
  assert.equal(result.kept, 10);
  assert.equal(result.droppedOverflow, 1);
  assert.equal(result.windowCompressed, true);
});

test('computeMissRetention：硬顶只在窗口内生效——最旧行先被裁（K 侧）', () => {
  const input = rows(Array.from({ length: 12 }, (_, i) => [i, T0 - i * DAY] as [number, number]));
  const result = computeMissRetention(input, policy({ hardCapK: 5 }));
  const keptIds = result.survivors.map((row) => row.id);
  assert.deepEqual(
    keptIds,
    input.slice(0, 5).map((row) => row.id),
    '保留的是最近 5 行；最旧的 7 行被溢出裁掉',
  );
  const dropped = input.filter((row) => !keptIds.includes(row.id)).map((row) => row.id);
  assert.ok(dropped.every((id) => input.find((row) => row.id === id)!.observedMs < T0 - 4 * DAY));
});

test('computeMissRetention：窗口软闸生效——超龄行归 droppedAgeOut（第一顺位）', () => {
  const input = rows([
    [0, T0],                        // 窗口内
    [1, T0 - 29 * DAY],             // 窗口内（边界附近）
    [2, T0 - 31 * DAY],             // 窗口外
    [3, T0 - 200 * DAY],            // 窗口外
  ]);
  const result = computeMissRetention(input, policy({ windowDays: 30, hardCapK: 10 }));
  assert.equal(result.kept, 2);
  assert.equal(result.droppedAgeOut, 2);
  assert.equal(result.droppedOverflow, 0, '超龄行不得重复计入溢出');
});

test('computeMissRetention：窗口边界含端点（observed_ms === cutoffMs 保留）', () => {
  const cutoff = floorToUtcDay(T0) - 30 * DAY;
  const input = rows([
    [0, cutoff],
    [1, cutoff - 1],
  ]);
  const result = computeMissRetention(input, policy({ windowDays: 30, hardCapK: 10 }));
  assert.equal(result.kept, 1);
  assert.equal(result.survivors[0]!.observedMs, cutoff);
  assert.equal(result.droppedAgeOut, 1);
});

test('computeMissRetention：同毫秒稳定序——id DESC 决胜、重跑同结果', () => {
  const input: MissRetentionRow[] = [
    { id: rid(1), observedMs: T0 },
    { id: rid(3), observedMs: T0 },
    { id: rid(2), observedMs: T0 },
  ];
  const once = computeMissRetention(input, policy({ hardCapK: 2 }));
  const twice = computeMissRetention([...input].reverse(), policy({ hardCapK: 2 }));
  assert.deepEqual(once.survivors.map((row) => row.id), [rid(3), rid(2)], '同毫秒按 id 降序取新');
  assert.deepEqual(twice.survivors.map((row) => row.id), [rid(3), rid(2)], '入参顺序不影响结果');
});

test('computeMissRetention：日界取整——同日不同时刻调用结果全同（日内幂等）', () => {
  const input = rows([
    [0, T0],
    [1, T0 - 5 * DAY],
  ]);
  const early = computeMissRetention(input, policy({ asOfMs: T0 + 1000 }));
  const late = computeMissRetention(input, policy({ asOfMs: T0 + DAY - 1000 }));
  assert.equal(early.cutoffMs, late.cutoffMs, 'cutoff 以 UTC 日为单位');
  assert.deepEqual(early.survivors, late.survivors);
  assert.equal(early.keptContentHash, late.keptContentHash);
});

test('computeMissRetention：策略越界即整份拒绝（windowDays/K/asOfMs/policyVersion）', () => {
  const input = rows([[0, T0]]);
  assert.throws(() => computeMissRetention(input, policy({ windowDays: 0 })), IntegrityError);
  assert.throws(() => computeMissRetention(input, policy({ windowDays: 1.5 })), IntegrityError);
  assert.throws(() => computeMissRetention(input, policy({ hardCapK: -1 })), IntegrityError);
  assert.throws(() => computeMissRetention(input, policy({ asOfMs: -1 })), IntegrityError);
  assert.throws(() => computeMissRetention(input, policy({ policyVersion: '' })), IntegrityError);
});

test('computeMissRetention：不修改入参（纯函数）', () => {
  const input = rows([[0, T0], [1, T0 - 40 * DAY], [2, T0 - DAY]]);
  const snapshot = JSON.stringify(input);
  computeMissRetention(input, policy({ hardCapK: 1 }));
  assert.equal(JSON.stringify(input), snapshot, '输入行序列与字段原样保留');
});

test('keptContentHash：内容变化即变、键序无关、幸存集合口径一致', () => {
  const a: MissRetentionRow = { id: rid(1), observedMs: T0, termNorm: '甲' };
  const b: MissRetentionRow = { observedMs: T0, termNorm: '甲', id: rid(1) };
  assert.equal(computeKeptContentHash([a]), computeKeptContentHash([b]), '键序不影响哈希');
  assert.notEqual(
    computeKeptContentHash([a]),
    computeKeptContentHash([{ ...a, termNorm: '乙' }]),
    '内容变化必须显影',
  );
  const result = computeMissRetention(rows([[0, T0]]), policy());
  assert.equal(result.keptContentHash, computeKeptContentHash(result.survivors));
});

test('台账口径：结果对象不含词面/哈希类明细键（只留聚合量）', () => {
  const result = computeMissRetention(rows([[0, T0]]), policy());
  const keys = Object.keys(result).sort();
  assert.deepEqual(keys, [
    'cutoffMs',
    'droppedAgeOut',
    'droppedOverflow',
    'kept',
    'keptContentHash',
    'survivors',
    'totalBefore',
    'windowCompressed',
  ]);
});

test('临时身份：段一常数位显式标注 provisional，且不得与定稿口径混淆', () => {
  assert.equal(MISS_RETENTION_POLICY_PROVISIONAL, true);
  assert.match(String(MISS_RETENTION_TMP_POLICY.policyVersion), /tmp/, 'policyVersion 必须自带临时标记');
  assert.ok(MISS_RETENTION_TMP_POLICY.hardCapK >= 10_000, '段一取偏大值（宁大勿小）');
});

test('静态纪律：本模块不读墙钟、不碰文件系统/数据库', () => {
  const source = readFileSync(
    path.join(import.meta.dirname, '..', '..', 'src', 'memory', 'miss-retention.ts'),
    'utf8',
  );
  // 只核对代码行（注释里允许出现这些词的说明性提及）。
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
  assert.ok(!/Date\.now/.test(code), '不得出现 Date.now');
  assert.ok(!/new Date\(/.test(code), '不得出现 new Date');
  assert.ok(!/node:fs|node:sqlite/.test(code), '不得触碰 fs/sqlite');
});
