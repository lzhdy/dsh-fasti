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
// dsh-session 对 cordis Events 的模块增强把 'session/event' 载荷收严为完整 Session class；
// 本测试只需要一个带 id 的最小桩，显式断言为 Session 测试双重（test double），不实现其全部私有面。
import type { Session } from '@deepseek-ai/dsh-session';

import { apply, parseAdapterConfig } from '../../../src/adapters/dsh/plugin.ts';
import { MEMORY_TOOL_NAMES } from '../../../src/adapters/dsh/memory-tool-bridge.ts';
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

const SESSION = { id: 'session-plugin-1' } as unknown as Session;

/** 测试收口：事件样例是 unknown 测试桩，在此单点断言为增强后的 SessionEvent 载荷。 */
function emitSessionEvent(ctx: Context, session: Session, event: unknown): void {
  ctx.emit('session/event', session, event as never);
}

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

test('parseAdapterConfig：memoryGateMode 仅接受 off/shadow/on，缺省不占位', () => {
  assert.deepEqual(parseAdapterConfig({ memoryGateMode: 'off' }), { memoryGateMode: 'off' });
  assert.deepEqual(parseAdapterConfig({ memoryGateMode: 'shadow' }), { memoryGateMode: 'shadow' });
  assert.deepEqual(parseAdapterConfig({ memoryGateMode: 'on' }), { memoryGateMode: 'on' });
  assert.throws(() => parseAdapterConfig({ memoryGateMode: 'ON' }), /memoryGateMode/);
  assert.throws(() => parseAdapterConfig({ memoryGateMode: 1 }), /memoryGateMode/);
  assert.deepEqual(parseAdapterConfig({}), {});
});

/** 在 cordis Context 上挂一个假的 tools 服务，捕获记忆工具注册/注销。 */
function installFakeTools(ctx: Context): { registered: string[]; unregistered: string[] } {
  const registered: string[] = [];
  const unregistered: string[] = [];
  ctx.provide('tools');
  ctx.set(
    'tools',
    {
      register(def: { name: string }) {
        registered.push(def.name);
        return () => {
          unregistered.push(def.name);
        };
      },
    } as never,
  );
  return { registered, unregistered };
}

// ── 端到端 ────────────────────────────────────────────────────────────────

test('插件：默认 off 即使宿主有 tools 也不注册记忆工具、不侧建 memory-index', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const tools = installFakeTools(ctx);
  const fiber = ctx.plugin({ apply }, { dataRoot: root });
  try {
    await fiber;
    await settle();

    assert.equal(tools.registered.length, 0);
    assert.ok(!fs.existsSync(path.join(root, 'projection', 'memory-index')));
  } finally {
    await fiber.dispose();
    cleanupTempRoot(root);
  }
});

test('插件：shadow 但宿主无 tools 服务时安全跳过，插件仍正常装载/卸载', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const fiber = ctx.plugin({ apply }, { dataRoot: root, memoryGateMode: 'shadow' });
  try {
    await fiber;
    await settle();
  } finally {
    await fiber.dispose();
    cleanupTempRoot(root);
  }
});

test('插件：memoryGateMode=shadow 时注册恰四个记忆工具，卸载时逐个注销', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const tools = installFakeTools(ctx);
  const fiber = ctx.plugin({ apply }, { dataRoot: root, memoryGateMode: 'shadow' });
  try {
    await fiber;
    await settle();

    assert.deepEqual([...tools.registered].sort(), Object.values(MEMORY_TOOL_NAMES).sort());
  } finally {
    await fiber.dispose();
    assert.deepEqual([...tools.unregistered].sort(), Object.values(MEMORY_TOOL_NAMES).sort());
    cleanupTempRoot(root);
  }
});

/** 包裹 ctx.inject 记录声明的服务依赖（复刻真机：tools 只能经 inject 授权访问）。 */
function spyInjectDeps(ctx: Context): Array<ReadonlyArray<string>> {
  const deps: Array<ReadonlyArray<string>> = [];
  const originalInject = ctx.inject.bind(ctx);
  ctx.inject = ((nextDeps: ReadonlyArray<string>, callback: (child: Context) => void) => {
    deps.push([...nextDeps]);
    return originalInject(nextDeps as never, callback as never);
  }) as typeof ctx.inject;
  return deps;
}

test('插件：shadow 经动态 inject(["tools"]) 授权后才注册四工具（真机 without-inject 防护）', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const tools = installFakeTools(ctx);
  const injectDeps = spyInjectDeps(ctx);
  const fiber = ctx.plugin({ apply }, { dataRoot: root, memoryGateMode: 'shadow' });
  try {
    await fiber;
    await settle();

    assert.ok(
      injectDeps.some((entry) => entry.includes('tools')),
      '真机 cordis 未 inject 时读 ctx.tools 会抛 "cannot get property tools without inject"，必须经 ctx.inject 授权',
    );
    assert.deepEqual([...tools.registered].sort(), Object.values(MEMORY_TOOL_NAMES).sort());
  } finally {
    await fiber.dispose();
    assert.deepEqual([...tools.unregistered].sort(), Object.values(MEMORY_TOOL_NAMES).sort());
    cleanupTempRoot(root);
  }
});

test('插件：默认 off 不发起 tools 注入、不注册（零服务依赖、零挂载）', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const tools = installFakeTools(ctx);
  const injectDeps = spyInjectDeps(ctx);
  const fiber = ctx.plugin({ apply }, { dataRoot: root });
  try {
    await fiber;
    await settle();

    assert.equal(injectDeps.length, 0);
    assert.equal(tools.registered.length, 0);
    assert.ok(!fs.existsSync(path.join(root, 'projection', 'memory-index')));
  } finally {
    await fiber.dispose();
    cleanupTempRoot(root);
  }
});

test('插件：emit session/event 后原文与经历各写入一条', async () => {
  const root = makeTempRoot();
  const ctx = new Context();
  const fiber = ctx.plugin({ apply }, { dataRoot: root });
  await fiber;

  emitSessionEvent(ctx, SESSION, userEvent('evt-1', '在吗'));
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

  emitSessionEvent(ctx, SESSION, userEvent('evt-1', '在吗'));
  emitSessionEvent(ctx, SESSION, assistantEvent('evt-2', '在呢'));
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

  emitSessionEvent(ctx, SESSION, userEvent('evt-1', '系统注入', 'runtime-context'));
  emitSessionEvent(ctx, SESSION, { type: 'turn/start', data: {} });
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

  emitSessionEvent(ctx, SESSION, userEvent('evt-1', '在吗'));
  await settle();
  const afterFirst = experienceCount(root);

  emitSessionEvent(ctx, SESSION, userEvent('evt-1', '在吗'));
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

  emitSessionEvent(ctx, SESSION, userEvent('evt-1', '在吗'));
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

  emitSessionEvent(ctx, SESSION, userEvent('evt-after', '卸载后'));
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

  emitSessionEvent(ctx, SESSION, userEvent('evt-1', '在吗'));
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
  emitSessionEvent(ctx, SESSION, userEvent('evt-1', '在吗'));
  await settle();
  const later = {
    type: 'user/message',
    time: Date.parse('2026-11-08T11:00:00.000Z'),
    data: { id: 'evt-2', content: [{ type: 'text', text: '看下排期' }], source: { kind: 'user' } },
  };
  emitSessionEvent(ctx, SESSION, later);

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
