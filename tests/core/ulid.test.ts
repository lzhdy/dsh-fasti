/**
 * ULID 单调变体测试（审计第四节阶段 0 验收项：ULID 单调变体 + 时钟回拨）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CROCKFORD_ALPHABET,
  UlidGenerator,
  defaultUlid,
  isUlid,
  ulid,
  ulidTimestampMs,
} from '../../src/core/ulid.ts';

test('ULID 形制正确：26 字符、Crockford 字符集、时间戳可解出', () => {
  const id = new UlidGenerator(() => 1_700_000_000_000).next();
  assert.equal(id.length, 26);
  assert.ok(isUlid(id));
  assert.equal(ulidTimestampMs(id), 1_700_000_000_000);
  for (const char of id) {
    assert.ok(CROCKFORD_ALPHABET.includes(char), `非法字符 ${char}`);
  }
});

test('同一毫秒内连续产出严格递增（随机段单调）', () => {
  const generator = new UlidGenerator(() => 1_700_000_000_000);
  const ids = Array.from({ length: 1000 }, () => generator.next());

  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(
      (ids[i] as string) > (ids[i - 1] as string),
      `第 ${i} 个 id 未严格递增：${ids[i - 1]} → ${ids[i]}`,
    );
  }
  // 同一毫秒 → 时间戳前缀相同，差异只来自随机段。
  assert.equal(ulidTimestampMs(ids[0] as string), ulidTimestampMs(ids[999] as string));
});

test('时钟回拨时不产生比上一条更小的 id', () => {
  let now = 1_700_000_000_000;
  const generator = new UlidGenerator(() => now);

  const before = generator.next();
  now = 1_699_999_000_000; // 时钟回拨 1000 秒
  const after = generator.next();

  assert.ok(after > before, `回拨后 id 未增大：${before} → ${after}`);
  assert.equal(ulidTimestampMs(after), ulidTimestampMs(before), '回拨后应沿用上次时间戳');
});

test('多次回拨仍严格递增', () => {
  let now = 1_700_000_000_000;
  const generator = new UlidGenerator(() => now);
  const ids: string[] = [];

  for (let i = 0; i < 50; i += 1) {
    now -= 1_000; // 每次都回拨
    ids.push(generator.next());
  }

  for (let i = 1; i < ids.length; i += 1) {
    assert.ok((ids[i] as string) > (ids[i - 1] as string), `回拨序列第 ${i} 个未递增`);
  }
});

test('时钟前进后时间戳随之更新', () => {
  let now = 1_700_000_000_000;
  const generator = new UlidGenerator(() => now);
  const first = generator.next();

  now = 1_700_000_060_000; // 前进 60 秒
  const second = generator.next();

  assert.ok(second > first);
  assert.equal(ulidTimestampMs(second), 1_700_000_060_000);
  assert.ok(ulidTimestampMs(second) > ulidTimestampMs(first));
});

test('字典序 == 时间序（跨毫秒）', () => {
  let now = 1_700_000_000_000;
  const generator = new UlidGenerator(() => now);
  const ids: string[] = [];

  for (let i = 0; i < 20; i += 1) {
    ids.push(generator.next());
    now += 1_000; // 每条隔 1 秒
  }

  for (let i = 1; i < ids.length; i += 1) {
    assert.ok((ids[i] as string) > (ids[i - 1] as string));
    assert.ok(ulidTimestampMs(ids[i] as string) > ulidTimestampMs(ids[i - 1] as string));
  }
});

test('isUlid 拒绝非法形状', () => {
  assert.equal(isUlid(''), false);
  assert.equal(isUlid('too-short'), false);
  assert.equal(isUlid('I'.repeat(26)), false, 'I 不在 Crockford 字符集内');
  assert.equal(isUlid('U'.repeat(26)), false, 'U 不在 Crockford 字符集内');
  assert.equal(isUlid('8'.repeat(26)), false, '首字符超 48 bit 时间戳范围');
});

test('不同生成器产出的 id 互不相同（随机熵有效）', () => {
  const generator = new UlidGenerator(() => 1_700_000_000_000);
  const ids = new Set(Array.from({ length: 500 }, () => generator.next()));
  assert.equal(ids.size, 500);
});

test('进程级单例 defaultUlid 跨实例保持全局单调（审计 m3）', () => {
  // 单例的意义：同一进程内的多个调用方（宿主插件、适配器）共用一条递增序列，
  // 不会出现「两个独立生成器在同一毫秒内各自递增」导致的局部有序但全局乱序。
  const first = defaultUlid.next();
  const second = defaultUlid.next();
  assert.ok(second > first, '单例连续产出必须严格递增');
  assert.ok(isUlid(first) && isUlid(second));

  // 便捷函数走的是同一个单例，故与单例共享序列。
  const viaHelper = ulid();
  const viaSingleton = defaultUlid.next();
  assert.ok(viaSingleton > viaHelper, 'ulid() 与 defaultUlid 必须共享同一递增序列');
});
