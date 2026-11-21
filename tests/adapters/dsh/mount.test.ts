/**
 * 平台化步骤3 · 宿主无关挂载面 mountDshAdapter 的离线契约测试。
 *
 * 与 plugin.test.ts 的分工：
 *  - plugin.test.ts 用**真实 cordis Context** 走 apply，验证薄胶水在真机宿主下的端到端；
 *  - 本文件**完全不 import 任何 @deepseek-ai/* 宿主包**，手搓五个内存假中性端口，
 *    直接驱动 mountDshAdapter —— 证明 dsh 适配器的装配编排已与具体宿主框架脱钩：
 *    换一个宿主只需提供同形端口，不必重写 open/登记/订阅/worker/关闭这套编排。
 *
 * 纪律：全部用临时数据根，绝不读写真实数据目录；mock 调度器不碰真定时器，
 * 作用域清理经假 LifecyclePort 显式回收，不留悬挂句柄。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { EventBusPort } from '../../../src/ports/event-bus-port.ts';
import type { LifecyclePort } from '../../../src/ports/lifecycle-port.ts';
import type { LoggerPort } from '../../../src/ports/logger-port.ts';
import type { SchedulerPort, ScheduledTask } from '../../../src/ports/scheduler-port.ts';
import type { ToolHostPort } from '../../../src/ports/tool-host-port.ts';
import {
  mountDshAdapter,
  type DshAdapterHandle,
  type MountDshAdapterPorts,
} from '../../../src/adapters/dsh/mount.ts';
import { cleanupTempRoot, makeTempRoot } from '../../helpers.ts';

/** 收集日志的内存 LoggerPort（四档全留痕，测试可据此核对可观测性）。 */
function makeFakeLogger(): LoggerPort & { entries: Array<{ level: string; message: string }> } {
  const entries: Array<{ level: string; message: string }> = [];
  const sink = (level: string) => (format: string, ...args: unknown[]): void => {
    entries.push({ level, message: [format, ...args.map(String)].join(' ') });
  };
  return {
    entries,
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
  };
}

/** 记录清理函数的内存 LifecyclePort；disposeAll 逆序回收，模拟宿主作用域卸载。 */
function makeFakeLifecycle(): LifecyclePort & { disposeAll(): Promise<void>; cleanupCount(): number } {
  const cleanups: Array<() => void> = [];
  return {
    onDispose(cleanup: () => void): void {
      cleanups.push(cleanup);
    },
    cleanupCount(): number {
      return cleanups.length;
    },
    async disposeAll(): Promise<void> {
      // 宿主普遍按注册逆序调用清理：后注册的适配器关闭先于先注册的 worker 撤销。
      for (const cleanup of [...cleanups].reverse()) {
        cleanup();
      }
      cleanups.length = 0;
    },
  };
}

/** 不碰真定时器的假 SchedulerPort：只记录待执行任务，cancel 置标记，供无悬挂断言。 */
function makeFakeScheduler(): SchedulerPort & { pending(): number; cancelled(): number } {
  const tasks: Array<{ cancelled: boolean }> = [];
  const scheduler: SchedulerPort = {
    schedule(callback: () => void, _delayMs: number): ScheduledTask {
      const record = { cancelled: false };
      tasks.push(record);
      return {
        cancel(): void {
          record.cancelled = true;
        },
      };
    },
  };
  return {
    ...scheduler,
    pending(): number {
      return tasks.filter((task) => !task.cancelled).length;
    },
    cancelled(): number {
      return tasks.filter((task) => task.cancelled).length;
    },
  };
}

/** 内存 EventBusPort：同步登记、手动 emit；listenerCount 用于自证同步注册红线。 */
function makeFakeEventBus(): EventBusPort & {
  listenerCount(eventName: string): number;
  emit(eventName: string, ...args: unknown[]): void;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(eventName: string, listener: (...args: unknown[]) => void): void {
      const bucket = listeners.get(eventName) ?? [];
      bucket.push(listener);
      listeners.set(eventName, bucket);
    },
    listenerCount(eventName: string): number {
      return listeners.get(eventName)?.length ?? 0;
    },
    emit(eventName: string, ...args: unknown[]): void {
      listeners.get(eventName)?.forEach((listener) => listener(...args));
    },
  };
}

/**
 * 弱工具宿主：默认门模式 off 下装配面根本不得申请工具接入，
 * 一旦 withTools 被调用即 fail（把"零工具接触"变成可断言事实）。
 * 参数刻意省略、返回 never：结构化上仍兼容 ToolHostPort<T>，且无需 import 宿主工具类型。
 */
function makeUntouchableToolHost(): ToolHostPort<unknown> {
  return {
    withTools(): never {
      throw new Error('默认 off 态不得申请宿主工具接入');
    },
  };
}

/** 组装一套全内存假端口；llmPort 固定 null（无模型环境如实降级，本文件不验证闭合摘要）。 */
function makeFakePorts(): MountDshAdapterPorts {
  return {
    logger: makeFakeLogger(),
    lifecycle: makeFakeLifecycle(),
    scheduler: makeFakeScheduler(),
    eventBus: makeFakeEventBus(),
    toolHost: makeUntouchableToolHost(),
  };
}

/** 造一条 user 消息事件（形状与 plugin.test.ts 同源）。 */
function userEvent(id: string, text: string): unknown {
  return {
    type: 'user/message',
    time: Date.parse('2026-11-08T10:00:00.000Z'),
    data: {
      id,
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  };
}

/** 数某通道原文行数（dsh 走扁平 raw-turns/）。 */
function rawLineCount(root: string): number {
  const dir = path.join(root, 'raw-turns');
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    total += fs
      .readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '').length;
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
    total += fs
      .readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '').length;
  }
  return total;
}

/** 轮询等待断言成立（后台 open/登记/摄入是异步的）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), '等待条件超时未成立');
}

/** 额外排空若干个微任务/IO 周期，确保旁路写入落盘。 */
async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 轮询等待 dsh 通道显式登记落盘。
 * 不能只等 channels.json 存在：空白注册表在 open 阶段就会先 persist 一份空表，
 * registerChannel 是其后的异步动作，必须等到里面真的出现目标通道 id 才算就绪。
 */
async function waitForChannelRegistered(root: string, channel = 'dsh'): Promise<void> {
  await waitFor(() => {
    const file = path.join(root, 'channels.json');
    if (!fs.existsSync(file)) {
      return false;
    }
    const registry = JSON.parse(fs.readFileSync(file, 'utf8')) as { channels?: Array<{ id?: string }> };
    return registry.channels?.some((entry) => entry.id === channel) === true;
  });
}

const SESSION = { id: 'session-mount-1' };

test('mount：同步返回即已登记 session/event 监听器（不丢首事件红线，无异步间隙）', () => {
  const root = makeTempRoot();
  const ports = makeFakePorts();
  try {
    const handle = mountDshAdapter(ports, { channel: 'dsh', llmPort: null, dataRoot: root });
    // mount 是同步函数：这一行断言时全程未 await，监听器必须已在同步栈内登记完成。
    assert.equal(
      (ports.eventBus as ReturnType<typeof makeFakeEventBus>).listenerCount('session/event'),
      1,
      'eventBus.on 必须在 mount 同步调用栈内完成注册，否则装载与首事件之间丢事件',
    );
    assert.equal(typeof handle.dispose, 'function');
  } finally {
    void (ports.lifecycle as ReturnType<typeof makeFakeLifecycle>).disposeAll();
    cleanupTempRoot(root);
  }
});

test('mount：不靠 cordis，空白根挂载后显式登记 dsh 通道并把 session/event 写进原文与经历', async () => {
  const root = makeTempRoot();
  const ports = makeFakePorts();
  const lifecycle = ports.lifecycle as ReturnType<typeof makeFakeLifecycle>;
  const eventBus = ports.eventBus as ReturnType<typeof makeFakeEventBus>;
  let handle: DshAdapterHandle | null = null;
  try {
    handle = mountDshAdapter(ports, { channel: 'dsh', llmPort: null, dataRoot: root });
    // 模拟 plugin 薄胶水：把适配器关闭挂到同一作用域生命周期（worker 清理已在 mount 内先登记）。
    ports.lifecycle.onDispose(() => {
      void handle?.dispose();
    }, 'dsh-fasti-adapter');

    // 后台 open + 显式登记通道完成（轮询到 dsh 真正落盘，而非空白表刚建）。
    await waitForChannelRegistered(root);
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'channels.json'), 'utf8')) as {
      channels: Array<{ id: string }>;
    };
    assert.deepEqual(
      registry.channels.map((channel) => channel.id),
      ['dsh'],
      '空白注册表挂载后应只登记一个 dsh 通道',
    );

    eventBus.emit('session/event', SESSION, userEvent('evt-1', '在吗'));
    await settle();

    assert.equal(rawLineCount(root), 1);
    assert.equal(experienceCount(root), 1);
  } finally {
    await lifecycle.disposeAll();
    if (handle !== null) {
      await handle.dispose();
    }
    cleanupTempRoot(root);
  }
});

test('mount：dispose 关闭数据根后不再写入新事件，且 worker 待执行句柄随作用域全部撤销', async () => {
  const root = makeTempRoot();
  const ports = makeFakePorts();
  const lifecycle = ports.lifecycle as ReturnType<typeof makeFakeLifecycle>;
  const scheduler = ports.scheduler as ReturnType<typeof makeFakeScheduler>;
  const eventBus = ports.eventBus as ReturnType<typeof makeFakeEventBus>;
  const handle = mountDshAdapter(ports, { channel: 'dsh', llmPort: null, dataRoot: root });
  try {
    await waitForChannelRegistered(root);
    eventBus.emit('session/event', SESSION, userEvent('evt-1', '在吗'));
    await settle();
    assert.equal(experienceCount(root), 1);

    // 显式关闭门面（对应宿主卸载时的适配器 dispose）。
    await handle.dispose();

    eventBus.emit('session/event', SESSION, userEvent('evt-after', '卸载后'));
    await settle();
    assert.equal(experienceCount(root), 0 + 1, 'dispose 后新事件必须被停写，经历数不变');

    // 作用域卸载逆序回收：两个后台 worker 的待执行句柄全部撤销，无悬挂定时器。
    await lifecycle.disposeAll();
    assert.equal(scheduler.pending(), 0, '卸载后不得残留待执行的 worker 任务');
    assert.ok(scheduler.cancelled() >= 2, '两个 worker 至少各登记过一个可撤销句柄');

    // close 已跑：数据根可被完整删除（句柄释放）。
    cleanupTempRoot(root);
  } finally {
    cleanupTempRoot(root);
  }
});

test('mount：默认 off 全程不触碰工具宿主（弱工具口 withTools 被调即抛错）', async () => {
  const root = makeTempRoot();
  const ports = makeFakePorts();
  const lifecycle = ports.lifecycle as ReturnType<typeof makeFakeLifecycle>;
  const eventBus = ports.eventBus as ReturnType<typeof makeFakeEventBus>;
  const handle = mountDshAdapter(ports, { channel: 'dsh', llmPort: null, dataRoot: root });
  try {
    await waitForChannelRegistered(root);
    // 来一条事件走完整摄入路径；假 toolHost 若被触碰会在装配阶段直接抛错使本用例失败。
    eventBus.emit('session/event', SESSION, userEvent('evt-1', '在吗'));
    await settle();
    assert.ok(!fs.existsSync(path.join(root, 'projection', 'memory-index')), 'off 态不得侧建记忆索引');
    assert.equal(experienceCount(root), 1);
    await handle.dispose();
  } finally {
    await lifecycle.disposeAll();
    cleanupTempRoot(root);
  }
});
