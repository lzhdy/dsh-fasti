/**
 * 结构层 / tick / 通道注册表 / 单写者队列测试（审计第四节阶段 1 验收项）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ExperienceLog } from '../../src/source/experience-log.ts';
import { TickAllocator } from '../../src/source/tick.ts';
import { ChannelRegistry } from '../../src/source/channels.ts';
import { WriterQueue } from '../../src/source/writer-queue.ts';
import { DEFAULT_DSH_DESCRIPTOR } from '../../src/contract/channel.ts';
import { ConflictError, NotFoundError } from '../../src/core/errors.ts';
import { cleanupTempRoot, makeTempRoot, makeExperience } from '../helpers.ts';

test('结构层：按月分片 + manifest', () => {
  const root = makeTempRoot();
  try {
    const log = new ExperienceLog(path.join(root, 'experiences'));
    log.append(makeExperience({ id: 'a', recorded_at: '2026-11-15T12:00:00.000Z' }));
    log.append(makeExperience({ id: 'b', recorded_at: '2026-12-15T12:00:00.000Z' }));

    assert.equal(log.shards().length, 2);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'experiences', 'manifest.json'), 'utf8'),
    ) as { version: number; months: string[] };
    assert.equal(manifest.version, 1);
    assert.equal(manifest.months.length, 2);
  } finally {
    cleanupTempRoot(root);
  }
});

test('结构层：append 以 id 为幂等键（重复 id 不二次写入、返回既有条目）', () => {
  const root = makeTempRoot();
  try {
    const log = new ExperienceLog(path.join(root, 'experiences'));
    const first = log.append(makeExperience({ id: 'same', recorded_at: '2026-11-15T12:00:00.000Z' }));
    assert.equal(first.created, true);

    const second = log.append(makeExperience({ id: 'same', recorded_at: '2026-11-15T12:00:00.000Z' }));
    assert.equal(second.created, false, '重复 id 不应二次写入');
    assert.equal(log.count(), 1);
    assert.equal(second.experience.id, 'same');
  } finally {
    cleanupTempRoot(root);
  }
});

test('结构层：真源 max(tick) 是 tick 的权威来源', () => {
  const root = makeTempRoot();
  try {
    const log = new ExperienceLog(path.join(root, 'experiences'));
    log.append(makeExperience({ id: 'a', tick: 5 }));
    log.append(makeExperience({ id: 'b', tick: 9 }));
    log.append(makeExperience({ id: 'c', tick: 2 }));

    assert.equal(log.maxTick(), 9, '乱序到达时 max 仍取最大');
    assert.equal(TickAllocator.fromSource(log.maxTick()).peek(), 10);
  } finally {
    cleanupTempRoot(root);
  }
});

test('tick 分配器：单调递增、同毫秒也不重复', () => {
  const allocator = new TickAllocator(0);
  const ticks = Array.from({ length: 100 }, () => allocator.next());
  for (let i = 1; i < ticks.length; i += 1) {
    assert.equal(ticks[i], (ticks[i - 1] as number) + 1);
  }
});

test('tick：乱序到达时 tick 与 occurred_at 允许不一致（§5 语义）', () => {
  const root = makeTempRoot();
  try {
    const log = new ExperienceLog(path.join(root, 'experiences'));
    const allocator = TickAllocator.fromSource(log.maxTick());

    const later = makeExperience({
      id: 'later',
      occurred_at: '2026-11-08T12:00:00.000Z',
      recorded_at: '2026-11-15T12:00:00.000Z',
      tick: allocator.next(),
    });
    const earlier = makeExperience({
      id: 'earlier',
      occurred_at: '2026-11-08T08:00:00.000Z',
      recorded_at: '2026-11-15T12:00:01.000Z',
      tick: allocator.next(),
    });

    log.append(later);
    log.append(earlier);

    assert.ok((later.tick as number) < (earlier.tick as number), 'tick 按摄入顺序递增');
    assert.ok(
      Date.parse(earlier.occurred_at) < Date.parse(later.occurred_at),
      'occurred_at 顺序与 tick 顺序相反 —— 这是允许的',
    );
  } finally {
    cleanupTempRoot(root);
  }
});

test('channels.json：首次初始化预置 dsh 描述符', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'channels.json');
    const registry = new ChannelRegistry(file);
    registry.load();

    assert.ok(fs.existsSync(file));
    const dsh = registry.get('dsh');
    assert.equal(dsh.id, 'dsh');
    assert.equal(dsh.capture, 'full');
    assert.deepEqual(dsh.modalities, DEFAULT_DSH_DESCRIPTOR.modalities);
  } finally {
    cleanupTempRoot(root);
  }
});

test('channels.json：注册新通道不破坏既有条目', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'channels.json');
    const registry = new ChannelRegistry(file);
    registry.load();

    const before = registry.get('dsh');
    registry.register({
      id: 'qq',
      label: 'QQ',
      modalities: ['text', 'image'],
      capture: 'full',
      counterpart: 'person',
      adapter_version: '0.1.0',
    });

    const after = registry.get('dsh');
    assert.deepEqual(after, before, 'dsh 条目必须逐字不变');
    assert.equal(registry.list().length, 2);
    assert.ok(registry.has('qq'));
  } finally {
    cleanupTempRoot(root);
  }
});

test('channels.json：同 id 重复注册 —— 等价幂等、不等价抛 ConflictError', () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'channels.json');
    const registry = new ChannelRegistry(file);
    registry.load();

    const same = registry.get('dsh');
    assert.deepEqual(registry.register(same), same, '等价重复注册应幂等返回');

    assert.throws(
      () => registry.register({ ...same, label: '改过的名字' }),
      ConflictError,
      '不等价重复注册必须抛冲突',
    );
  } finally {
    cleanupTempRoot(root);
  }
});

test('channels.json：未注册通道抛 NotFoundError', () => {
  const root = makeTempRoot();
  try {
    const registry = new ChannelRegistry(path.join(root, 'channels.json'));
    registry.load();
    assert.throws(() => registry.get('nonexistent'), NotFoundError);
  } finally {
    cleanupTempRoot(root);
  }
});

test('单写者队列：并发任务严格串行，无交叉写入', async () => {
  const queue = new WriterQueue();
  const order: number[] = [];
  let active = 0;
  let maxConcurrent = 0;

  const tasks = Array.from({ length: 50 }, (_, index) =>
    queue.run(async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push(index);
      active -= 1;
    }),
  );

  await Promise.all(tasks);

  assert.equal(maxConcurrent, 1, '队列内不得并发执行');
  assert.deepEqual(order, Array.from({ length: 50 }, (_, i) => i), '执行顺序必须与入队顺序一致');
});

test('单写者队列：某个任务失败不影响后续任务', async () => {
  const queue = new WriterQueue();
  const results: string[] = [];

  const failing = queue.run(() => {
    throw new Error('boom');
  });
  const following = queue.run(() => {
    results.push('after');
    return 'ok';
  });

  await assert.rejects(() => failing, /boom/);
  assert.equal(await following, 'ok');
  assert.deepEqual(results, ['after']);
});

test('单写者队列：并发 append 到同一分片无交叉写入、无分片损坏', async () => {
  const root = makeTempRoot();
  try {
    const log = new ExperienceLog(path.join(root, 'experiences'));
    const queue = new WriterQueue();

    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        queue.run(() =>
          log.append(
            makeExperience({ id: `e${index}`, recorded_at: '2026-11-15T12:00:00.000Z' }),
          ),
        ),
      ),
    );

    assert.equal(log.count(), 100);
    // 逐行可解析 = 分片未损坏。
    const shardFile = path.join(root, 'experiences', log.shards()[0] as string + '.jsonl');
    const lines = fs.readFileSync(shardFile, 'utf8').split('\n').filter((line) => line.trim() !== '');
    assert.equal(lines.length, 100);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line) as unknown);
    }
  } finally {
    cleanupTempRoot(root);
  }
});
