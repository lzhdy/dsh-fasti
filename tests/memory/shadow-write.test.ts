/**
 * N16 步骤2 · memory 侧影子观测窄写原语测试（裁决备忘录 §2 硬条件 a/b/d）。
 *
 * 闭合的安全属性：
 *  - 封闭窄写：入参恰六字段、无任何目录/路径形参，影子目录由工厂按 indexDir 内部固定推导；
 *  - 运行时键白名单 + 受控状态/原因码枚举，额外键与杜撰码当场 IntegrityError（miss.ts 同款 fail-closed）；
 *  - term_hash 内部 sha256 计算，termNorm 与原始查询永不落盘；append-only 固定 JSONL、无更新/删除；
 *  - 构造期不建目录（off 零副作用），首次写才 mkdir；写失败隔离为 ok:false，绝不向上抛阻断主检索；
 *  - 输出确定性：无随机 id/时钟，同输入落盘行逐字一致。
 *
 * 纪律：全部临时根，真实数据根与三份真源 jsonl 零接触；observedMs 注入，无 Date.now()。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { sha256Hex } from '../../src/core/hash.ts';
import { IntegrityError } from '../../src/core/errors.ts';
import {
  SHADOW_DIRNAME,
  SHADOW_LOG_FILE,
  openShadowObservationSink,
  shadowDirFromIndex,
  validateShadowInput,
} from '../../src/memory/shadow-write.ts';
import type { ShadowObservationInput } from '../../src/memory/shadow-write.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const AT = Date.parse('2026-11-13T03:00:00.000Z');

function validInput(overrides: Partial<ShadowObservationInput> = {}): ShadowObservationInput {
  return {
    termNorm: 'cat',
    gatedStatus: 'abstain',
    legacyCount: 3,
    acceptedCount: 1,
    rejectedReasonCodes: ['like-only-weak-match', 'ascii-no-word-boundary'],
    observedMs: AT,
    ...overrides,
  };
}

function layout(root: string): { indexDir: string; shadowDir: string; logFile: string } {
  const indexDir = path.join(root, 'projection', 'memory-index');
  const shadowDir = path.join(root, 'projection', SHADOW_DIRNAME);
  return { indexDir, shadowDir, logFile: path.join(shadowDir, SHADOW_LOG_FILE) };
}

test('构造期零副作用：open sink 不创建影子目录；首次 record 才在 projection/memory-shadow 落固定 jsonl', () => {
  const root = makeTempRoot('mem-shadow-open-');
  try {
    const { indexDir, shadowDir, logFile } = layout(root);
    const sink = openShadowObservationSink(indexDir);
    assert.equal(fs.existsSync(shadowDir), false, '构造不得提前 mkdir（off 态零副作用）');

    const outcome = sink.record(validInput());
    assert.equal(outcome.ok, true);
    assert.equal(fs.existsSync(logFile), true);
    // 目录必须与 memory-index 同处 projection 之下、名字固定。
    assert.equal(shadowDirFromIndex(indexDir), shadowDir);
    assert.equal(path.basename(logFile), SHADOW_LOG_FILE);
  } finally {
    cleanupTempRoot(root);
  }
});

test('落盘行仅六字段且含 termHash 无 termNorm/原文，term_hash=sha256(termNorm)', () => {
  const root = makeTempRoot('mem-shadow-row-');
  try {
    const { indexDir, logFile } = layout(root);
    const sink = openShadowObservationSink(indexDir);
    const input = validInput();
    const outcome = sink.record(input);
    assert.ok(outcome.ok);

    const line = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(line.length, 1);
    const row = JSON.parse(line[0] as string) as Record<string, unknown>;
    assert.deepEqual(Object.keys(row).sort(), [
      'acceptedCount',
      'gatedStatus',
      'legacyCount',
      'observedMs',
      'rejectedReasonCodes',
      'termHash',
    ]);
    assert.equal(row.termHash, sha256Hex('cat'));
    assert.equal(row.gatedStatus, 'abstain');
    assert.equal(row.legacyCount, 3);
    assert.equal(row.acceptedCount, 1);
    assert.deepEqual(row.rejectedReasonCodes, ['like-only-weak-match', 'ascii-no-word-boundary']);
    assert.equal(row.observedMs, AT);

    const raw = fs.readFileSync(logFile, 'utf8');
    for (const leaked of ['termNorm', 'rawQuery', '"text"', 'cat']) {
      assert.ok(!raw.includes(leaked), `影子落盘泄漏禁词：${leaked}`);
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('append-only 不去重不覆盖：同输入重放得两行逐字一致，无随机 id/时间戳', () => {
  const root = makeTempRoot('mem-shadow-append-');
  try {
    const { indexDir, logFile } = layout(root);
    const sink = openShadowObservationSink(indexDir);
    const input = validInput();
    sink.record(input);
    sink.record(input);
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], lines[1], '确定性：注入时钟下两行逐字一致，不含随机字段');
  } finally {
    cleanupTempRoot(root);
  }
});

test('封闭窄写：入参恰六白名单字段，无任何目录/路径形参（塞 path/dir 键当场拒绝）', () => {
  const keys = Object.keys(validInput()).sort();
  assert.deepEqual(keys, [
    'acceptedCount',
    'gatedStatus',
    'legacyCount',
    'observedMs',
    'rejectedReasonCodes',
    'termNorm',
  ]);
  for (const smuggled of ['dir', 'path', 'filePath', 'shadowDir', 'target']) {
    assert.throws(
      () => validateShadowInput({ ...validInput(), [smuggled]: '/etc/passwd' }),
      IntegrityError,
      `路径形参 ${smuggled} 必须被白名单挡下，防止退化为通用文件写`,
    );
  }
  assert.throws(
    () => validateShadowInput({ ...validInput(), rawQuery: '原文' } as unknown as ShadowObservationInput),
    IntegrityError,
  );
});

test('受控枚举/类型 fail-closed：非法 status、杜撰原因码、坏计数、空 termNorm 均拒绝', () => {
  assert.throws(
    () => validateShadowInput(validInput({ gatedStatus: 'bogus' as never })),
    IntegrityError,
  );
  assert.throws(
    () => validateShadowInput(validInput({ rejectedReasonCodes: ['made-up-reason'] as never })),
    IntegrityError,
  );
  assert.throws(
    () => validateShadowInput(validInput({ rejectedReasonCodes: ['exact-alias-pass', 'bogus'] as never })),
    IntegrityError,
  );
  assert.throws(() => validateShadowInput(validInput({ legacyCount: -1 })), IntegrityError);
  assert.throws(() => validateShadowInput(validInput({ acceptedCount: 1.5 })), IntegrityError);
  assert.throws(() => validateShadowInput(validInput({ observedMs: -2 })), IntegrityError);
  assert.throws(() => validateShadowInput(validInput({ termNorm: '  ' })), IntegrityError);
  // 八个受控原因码均可放行（运行时常量与类型联合保持一致）。
  for (const code of [
    'empty-query',
    'zero-lexical-hit',
    'all-rejected',
    'exact-alias-pass',
    'fts-word-boundary-pass',
    'ascii-no-word-boundary',
    'like-only-weak-match',
    'missing-cue-text',
  ] as const) {
    assert.doesNotThrow(() => validateShadowInput(validInput({ rejectedReasonCodes: [code] })));
  }
});

test('失败隔离：影子目录被占位为普通文件导致写失败时，record 返回 ok:false 而非抛错', () => {
  const root = makeTempRoot('mem-shadow-fail-');
  try {
    const { indexDir, shadowDir } = layout(root);
    fs.mkdirSync(path.dirname(shadowDir), { recursive: true });
    fs.writeFileSync(shadowDir, '我是一个占位文件，不是目录');
    const sink = openShadowObservationSink(indexDir);
    const outcome = sink.record(validInput());
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(typeof outcome.reason, 'string');
  } finally {
    cleanupTempRoot(root);
  }
});

test('只读降级形态也能写影子：sink 不依赖 sqlite 写柄，物理面独立', () => {
  const root = makeTempRoot('mem-shadow-independent-');
  try {
    const { indexDir, logFile } = layout(root);
    // 即便 indexDir 下没有 sqlite 库，影子 sink 只认 projection 路径，不打开任何数据库。
    const sink = openShadowObservationSink(indexDir);
    const outcome = sink.record(validInput({ gatedStatus: 'hit', acceptedCount: 2, rejectedReasonCodes: [] }));
    assert.equal(outcome.ok, true);
    assert.ok(fs.existsSync(logFile));
    assert.ok(!fs.existsSync(path.join(indexDir, 'memory-index.sqlite')), 'sink 不得顺手创建 sqlite 库');
  } finally {
    cleanupTempRoot(root);
  }
});
