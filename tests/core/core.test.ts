/**
 * 核心原语测试 —— 哈希、时间、JSONL、原子写、错误层级。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { contentHashOf, isSha256Hex, sha256Hex } from '../../src/core/hash.ts';
import { isoToMs, localDateString, localMonthKey, msToIso, nowIso, shardKeyOf } from '../../src/core/time.ts';
import { appendJsonl, countJsonlLines, parseJsonl, readJsonlFile } from '../../src/core/jsonl.ts';
import { readFileStrict, writeFileAtomic } from '../../src/core/fsx.ts';
import { CorruptedError, FastiError, NotFoundError, SchemaError } from '../../src/core/errors.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

test('sha256 与 content_hash 一致（旧行为契约 1.1）', () => {
  const text = '你好，世界';
  assert.equal(contentHashOf(text), sha256Hex(text));
  assert.equal(contentHashOf(text).length, 64);
  assert.ok(isSha256Hex(contentHashOf(text)));
  assert.equal(isSha256Hex('不是哈希'), false);
  assert.equal(isSha256Hex(undefined), false);
});

test('ISO ↔ 毫秒往返一致', () => {
  const iso = '2026-11-08T12:34:56.789Z';
  const ms = isoToMs(iso);
  assert.equal(msToIso(ms), iso);
  assert.throws(() => isoToMs('不是时间'), /非法 ISO 8601 时间/);
});

test('本地日期口径沿用旧项目 localDateString（本地而非 UTC）', () => {
  const ms = isoToMs('2026-11-08T12:00:00.000Z');
  const expected = new Date(ms);
  const expectedDate = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`;
  assert.equal(localDateString(ms), expectedDate);
  assert.equal(localMonthKey(ms), expectedDate.slice(0, 7));
  assert.equal(shardKeyOf('2026-11-15T12:00:00.000Z'), localMonthKey(isoToMs('2026-11-15T12:00:00.000Z')));
});

test('nowIso 产出合法 ISO 8601', () => {
  const iso = nowIso();
  assert.ok(iso.endsWith('Z'));
  assert.doesNotThrow(() => isoToMs(iso));
});

test('JSONL：坏行抛 CorruptedError（绝不静默跳过）', () => {
  assert.throws(() => parseJsonl('{"a":1}\n{坏行}\n', 'test'), CorruptedError);
  assert.throws(() => parseJsonl('{坏行}', 'test'), (error: unknown) => {
    assert.ok(error instanceof CorruptedError);
    assert.ok((error as Error).message.includes('第 1 行'));
    return true;
  });
});

test('JSONL：空行不算坏行（文件末尾换行）', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n\n{"b":2}\n', 'test'), [{ a: 1 }, { b: 2 }]);
});

test('JSONL：append 与行数统计', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'nested', 'data.jsonl');
    assert.equal(countJsonlLines(file), 0, '文件不存在时行数为 0');
    appendJsonl(file, { a: 1 });
    appendJsonl(file, { b: 2 });
    assert.equal(countJsonlLines(file), 2);
    assert.deepEqual(readJsonlFile(file), [{ a: 1 }, { b: 2 }]);
  } finally {
    cleanupTempRoot(root);
  }
});

test('原子写：内容完整落盘，且不留临时文件', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'sub', 'out.json');
    writeFileAtomic(file, '{"hello":"world"}\n');
    assert.equal(readFileStrict(file), '{"hello":"world"}\n');

    writeFileAtomic(file, '{"hello":"again"}\n');
    assert.equal(readFileStrict(file), '{"hello":"again"}\n', '重复写应覆盖而非追加');

    const leftovers = fs.readdirSync(path.join(root, 'sub')).filter((name) => name.includes('.tmp'));
    assert.deepEqual(leftovers, [], '不应残留临时文件');
  } finally {
    cleanupTempRoot(root);
  }
});

test('读文件失败必须抛出，绝不用空串覆盖', () => {
  const root = makeTempRoot();
  try {
    assert.throws(() => readFileStrict(path.join(root, 'missing.txt')), NotFoundError);
  } finally {
    cleanupTempRoot(root);
  }
});

test('错误层级：全部继承 FastiError 并携带稳定 code', () => {
  const errors = [
    new SchemaError('s'),
    new NotFoundError('n'),
    new CorruptedError('c'),
  ];
  for (const error of errors) {
    assert.ok(error instanceof FastiError);
    assert.ok(error instanceof Error);
    assert.ok(error.code.length > 0);
    assert.equal(error.name, error.constructor.name);
  }
});
