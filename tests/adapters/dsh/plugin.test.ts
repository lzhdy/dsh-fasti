/**
 * cordis 插件入口的集成测试 —— 用 dev 依赖的真实 cordis 构造 Context。
 *
 * 覆盖：端到端写入、顺序、排除注入、生命周期（卸载即关闭）、失败可观测。
 *
 * 纪律：全部用临时数据根，**绝不读写真实数据目录**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { apply, parseAdapterConfig } from '../../../src/adapters/dsh/plugin.ts';
import { cleanupTempRoot, makeTempRoot } from '../../helpers.ts';

/** 数某通道的原文行数。 */
function rawLineCount(root: string, channel: string): number {
  const dir = channel === 'dsh' ? path.join(root, 'raw-turns') : path.join(root, 'raw', channel);
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    total += text.split('\n').filter((line) => line.trim() !== '').length;
  }
  return total;
}

/** 数经历条数。 */
function experienceCount(root: string): number {
  const dir = path.join(root, 'experiences');
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    total += text.split('\n').filter((line) => line.trim() !== '').length;
  }
  return total;
}

/** 读经历文件里的全部经历（按摄入顺序）。 */
function readExperiences(root: string): Array<Record<string, unknown>> {
  const dir = path.join(root, 'experiences');
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (line.trim() !== '') {
        out.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return out;
}

/** 造一条 user 消息事件。 */
function userEvent(id: string, text: string, sourceKind = 'user'): unknown {
  return {
    type: 'user/message',
    time: Date.parse('2026-11-08T10:00:00.000Z'),
    data: {
      id,
      content: [{ type: 'text', text }],
      source: { kind: sourceKind },
    },
  };
}

/** 造一条 assistant 消息事件。 */
function assistantEvent(id: string, text: string): unknown {
  return {
    type: 'assistant/message',
    time: Date.parse('2026-11-08T10:00:01.000Z'),
    data: { message: { id, content: [{ type: 'text', text }] } },
  };
}

const SESSION = { id: 'session-plugin-1' };

/** 等到队列排空（旁路捕获是异步的，测试需等待其落盘）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ── 配置校验 ──────────────────────────────────────────────────────────────

test('parseAdapterConfig：接受 undefined 与空对象', () => {
  assert.deepEqual(parseAdapterConfig(undefined), {});
  assert.deepEqual(parseAdapterConfig(null), {});
  assert.deepEqual(parseAdapterConfig({}), {});
});

test('parseAdapterConfig：坏配置抛错（不带着半截配置跑起来）', () => {
  assert.throws(() => parseAdapterConfig('nope'), /必须是对象/);
  assert.throws(() => parseAdapterConfig([]), /必须是对象/);
  assert.throws(() => parseAdapterConfig({ dataRoot: 123 }), /dataRoot 必须是字符串/);
  assert.throws(() => parseAdapterConfig({ channel: '' }), /channel 必须是非空字符串/);
});

// ── 端到端 ────────────────────────────────────────────────────────────────

test('插件：emit session/event 后原文与经历各写入一条', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const fiber = ctx.plugin({ apply }, { dataRoot: root });
  await fiber;

  ctx.emit('session/event', SESSION, userEvent('evt-1', '在吗'));
  await settle();

  assert.equal(rawLineCount(root, 'dsh'), 1);
  assert.equal(experienceCount(root), 1);

  const experiences = readExperiences(root);
  assert.equal(experiences[0]?.['initiation'], 'user');
  const pointer = (experiences[0]?.['observation'] as { text?: { id?: string } }).text;
  assert.equal(pointer?.id, 'evt-1');

  await fiber.dispose();
  cleanupTempRoot(root);
});

test('插件：user + assistant 顺序写入，initiation 分别为 user / her', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const fiber = ctx.plugin({ apply }, { dataRoot: root });
  await fiber;

  ctx.emit('session/event', SESSION, userEvent('evt-1', '在吗'));
  ctx.emit('session/event', SESSION, assistantEvent('evt-2', '在呢'));
  await settle();

  assert.equal(experienceCount(root), 2);
  const experiences = readExperiences(root);
  assert.equal(experiences[0]?.['initiation'], 'user');
  assert.equal(experiences[1]?.['initiation'], 'her');

  await fiber.dispose();
  cleanupTempRoot(root);
});

test('插件：系统注入事件被排除，零新增', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const fiber = ctx.plugin({ apply }, { dataRoot: root });
  await fiber;

  ctx.emit('session/event', SESSION, userEvent('evt-1', '系统注入', 'runtime-context'));
  ctx.emit('session/event', SESSION, { type: 'turn/start', data: {} });
  await settle();

  assert.equal(rawLineCount(root, 'dsh'), 0);
  assert.equal(experienceCount(root), 0);

  await fiber.dispose();
  cleanupTempRoot(root);
});

test('插件：重放同一事件不产生重复行（幂等）', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const fiber = ctx.plugin({ apply }, { dataRoot: root });
  await fiber;

  ctx.emit('session/event', SESSION, userEvent('evt-1', '在吗'));
  await settle();
  const afterFirst = experienceCount(root);

  ctx.emit('session/event', SESSION, userEvent('evt-1', '在吗'));
  await settle();

  assert.equal(experienceCount(root), afterFirst, '重放不得新增经历');
  assert.equal(rawLineCount(root, 'dsh'), afterFirst);

  await fiber.dispose();
  cleanupTempRoot(root);
});

// ── 生命周期 ──────────────────────────────────────────────────────────────

test('插件：卸载后关闭数据根（Windows 上不残留文件占用）', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const fiber = ctx.plugin({ apply }, { dataRoot: root });
  await fiber;

  ctx.emit('session/event', SESSION, userEvent('evt-1', '在吗'));
  await settle();

  await fiber.dispose();

  // 卸载后数据根可被完整删除 —— 若 close() 没跑，Windows 上会因占用而失败。
  cleanupTempRoot(root);
});

test('插件：卸载后不再写入新事件', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const fiber = ctx.plugin({ apply }, { dataRoot: root });
  await fiber;

  await fiber.dispose();

  ctx.emit('session/event', SESSION, userEvent('evt-after', '卸载后'));
  await settle();

  assert.equal(experienceCount(root), 0);

  cleanupTempRoot(root);
});

// ── 通道核对 ──────────────────────────────────────────────────────────────

test('插件：通道未注册时不写入（只核对、不自动注册）', async () => {
  const root = makeTempRoot();

  // 造一个 channels.json 里**没有** dsh 的数据根。
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'channels.json'),
    JSON.stringify({ version: 1, channels: [] }, null, 2),
    'utf8',
  );

  const ctx = new Context();
  const fiber = ctx.plugin({ apply }, { dataRoot: root });
  await fiber;

  ctx.emit('session/event', SESSION, userEvent('evt-1', '在吗'));
  await settle();

  assert.equal(experienceCount(root), 0, '通道未注册时不得写入');

  // 注册表不得被适配器擅自改动。
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'channels.json'), 'utf8')) as {
    channels: unknown[];
  };
  assert.equal(registry.channels.length, 0, '适配器不得自动注册通道');

  await fiber.dispose();
  cleanupTempRoot(root);
});
