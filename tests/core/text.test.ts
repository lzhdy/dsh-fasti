/**
 * 字符计数/切片原语测试（C10 统一口径拍板 L0-1 验收项：码点口径全仓唯一实现）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codePointLengthOf, codePointSlice } from '../../src/core/text.ts';

test('码点计数：ASCII/中文 BMP/astral/空串', () => {
  assert.equal(codePointLengthOf('abc'), 3);
  assert.equal(codePointLengthOf('原文三字'), 4);
  assert.equal(codePointLengthOf('😀'), 1, 'astral 计 1（UTF-16 .length 是 2，此处钉死口径差）');
  assert.equal(codePointLengthOf('a😀b'), 3);
  assert.equal(codePointLengthOf(''), 0);
});

test('码点切片：按码点下标取子串，永不劈开代理对', () => {
  assert.equal(codePointSlice('a😀b', 0, 1), 'a');
  assert.equal(codePointSlice('a😀b', 1, 2), '😀');
  assert.equal(codePointSlice('a😀b', 2, 3), 'b');
});

test('码点切片：end 缺省到尾', () => {
  assert.equal(codePointSlice('a😀b', 1), '😀b');
  assert.equal(codePointSlice('a😀b', 0), 'a😀b');
});

test('码点切片：钳制到边界不抛，start ≥ end 返回空串（不做 substring 的换序）', () => {
  assert.equal(codePointSlice('a😀b', -5, 99), 'a😀b');
  assert.equal(codePointSlice('a😀b', 99), '');
  assert.equal(codePointSlice('a😀b', 2, 2), '');
  assert.equal(codePointSlice('a😀b', 3, 1), '', 'start > end 不交换，返回空串');
});

test('码点切片与旧口径对照：含 astral 串切 n 个码点恰得 n 个码点', () => {
  const s = '😀x😀y😀';
  for (let n = 0; n <= codePointLengthOf(s); n += 1) {
    assert.equal(codePointLengthOf(codePointSlice(s, 0, n)), n);
  }
});
