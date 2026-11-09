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

// ── 闭合链路（T7/T8/T9）：端口注入 + 后台 worker ────────────────────────

test('parseAdapterConfig：modelRoute 必须是实现了 complete() 的对象（坏路由当场拒）', () => {
  assert.throws(() => parseAdapterConfig({ modelRoute: 'nope' }), /modelRoute 必须实现 complete/);
  assert.throws(() => parseAdapterConfig({ modelRoute: { complete: 1 } }), /modelRoute 必须实现 complete/);
  assert.throws(() => parseAdapterConfig({ closureIntervalMs: 0 }), /closureIntervalMs 必须是正数/);

  const route = { complete: async () => '{}' };
  const parsed = parseAdapterConfig({ dataRoot: '/tmp/x', modelRoute: route, closureIntervalMs: 50 });
  assert.equal(parsed.modelRoute, route, '路由原样透传（不做结构化改造）');
  assert.equal(parsed.closureIntervalMs, 50);
});

/** 读事件真源里的全部版本行。 */
function readEventRows(root: string): Array<Record<string, unknown>> {
  const dir = path.join(root, 'events');
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

test('插件：注入模型路由 → 闭合事件由后台 worker 补上摘要（端到端，不等摄入）', async () => {
  const root = makeTempRoot();
  const ctx = new Context();

  let calls = 0;
  const route = {
    complete: async (): Promise<string> => {
      calls += 1;
      return JSON.stringify({
        summary: '她问了一句在不在，随后继续处理排期。',
        key_points: ['问在不在'],
        anchors: ['发消息'],
      });
    },
  };

  const fiber = ctx.plugin({ apply }, { dataRoot: root, modelRoute: route, closureIntervalMs: 50 });
  await fiber;

  // 两条消息相隔一小时 → 第一条被静默闭合（机械信号），第二条开新事件。
  ctx.emit('session/event', SESSION, userEvent('evt-1', '在吗'));
  await settle();
  const later = {
    type: 'user/message',
    time: Date.parse('2026-11-08T11:00:00.000Z'),
    data: { id: 'evt-2', content: [{ type: 'text', text: '看下排期' }], source: { kind: 'user' } },
  };
  ctx.emit('session/event', SESSION, later);

  // 后台 worker 的间隔是 50ms —— 等到摘要落盘（最多约 2 秒）。
  let ready: Record<string, unknown> | undefined;
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    ready = readEventRows(root).find(
      (row) => row['status'] === 'closed' && row['summary_quality'] === 'ready',
    );
    if (ready !== undefined) {
      break;
    }
  }

  assert.ok(ready, '闭合事件应被后台 worker 摘到并写出 ready 版本');
  assert.equal(ready['summary_source'], 'llm');
  assert.equal(ready['summary'], '她问了一句在不在，随后继续处理排期。');
  assert.ok(calls >= 1, '宿主路由真的被调用过');

  await fiber.dispose();
  cleanupTempRoot(root);
});

// ── 闭合超时配置（设计稿 v1.1 §6.3.1 纪律①）────────────────────────────

test('parseAdapterConfig：closureTimeoutMs 必须是正数（坏值当场拒，不静默降级成无限等）', () => {
  assert.throws(() => parseAdapterConfig({ closureTimeoutMs: 0 }), /closureTimeoutMs 必须是正数/);
  assert.throws(() => parseAdapterConfig({ closureTimeoutMs: -1 }), /closureTimeoutMs 必须是正数/);
  assert.throws(() => parseAdapterConfig({ closureTimeoutMs: '60s' }), /closureTimeoutMs 必须是正数/);
  assert.equal(parseAdapterConfig({}).closureTimeoutMs, undefined, '缺省不占位（走管线默认 60s）');
  assert.equal(parseAdapterConfig({ closureTimeoutMs: 250 }).closureTimeoutMs, 250);
});
