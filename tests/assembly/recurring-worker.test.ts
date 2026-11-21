/**
 * 宿主无关自管理循环 worker 测试（平台化 H1 切片 2）。
 *
 * 用手写虚拟时钟（假 SchedulerPort）＋假 LifecyclePort／收集型 LoggerPort 驱动
 * startRecurringWorker，全程不依赖真实墙钟、不 import 任何宿主包，确定性验证：
 *  1. 启动先排首轮（不立即跑）、到点执行、跑完自动排下一轮（自链而非周期定时器）；
 *  2. 间隔缺省 5000、自定义间隔原样透传；
 *  3. 单轮 drain 抛错只经 logger 记账、不抛出且照常续排；
 *  4. label 透传给生命周期口；
 *  5. 卸载撤销等待中的句柄且不再轮询；卸载发生在一轮 await 期间时，本轮结束也不续排。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RECURRING_WORKER_INTERVAL_MS,
  startRecurringWorker,
} from '../../src/assembly/recurring-worker.ts';
import type { LifecyclePort } from '../../src/ports/lifecycle-port.ts';
import type { LoggerPort } from '../../src/ports/logger-port.ts';
import type { SchedulerPort } from '../../src/ports/scheduler-port.ts';

interface Pending {
  readonly cb: () => void;
  readonly delay: number;
  cancelled: boolean;
  fired: boolean;
}

/** 虚拟时钟：所有 schedule 进队列，由测试手动 tick 推进，绝不碰真实时间。 */
function makeVirtualScheduler(): {
  scheduler: SchedulerPort;
  scheduled: Pending[];
  pending: () => Pending[];
  tick: () => Promise<void>;
} {
  const scheduled: Pending[] = [];
  const scheduler: SchedulerPort = {
    schedule(cb, delayMs) {
      const item: Pending = { cb, delay: delayMs, cancelled: false, fired: false };
      scheduled.push(item);
      return {
        cancel() {
          item.cancelled = true;
        },
      };
    },
  };
  // 等待中 = 既没取消也没执行。
  const pending = (): Pending[] => scheduled.filter((p) => !p.cancelled && !p.fired);
  const tick = async (): Promise<void> => {
    const due = pending();
    for (const item of due) {
      item.fired = true;
      item.cb();
    }
    // 排空微任务：drain 的 Promise 兑现后，续排那一步才会发生。
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { scheduler, scheduled, pending, tick };
}

/** 假生命周期口：把 cleanup 存进稳定容器（holder 引用不变，属性实时可读），并收集 label。 */
function makeLifecycle(): {
  lifecycle: LifecyclePort;
  holder: { cleanup?: () => void };
  labels: Array<string | undefined>;
} {
  const holder: { cleanup?: () => void } = {};
  const labels: Array<string | undefined> = [];
  const lifecycle: LifecyclePort = {
    onDispose(cleanupFn, label) {
      holder.cleanup = cleanupFn;
      labels.push(label);
    },
  };
  return { lifecycle, holder, labels };
}

/** 只收集 error 档的假日志口。 */
function makeLogger(): { logger: LoggerPort; errors: unknown[][] } {
  const errors: unknown[][] = [];
  const logger: LoggerPort = {
    debug() {},
    info() {},
    warn() {},
    error: (format, ...args) => errors.push([format, ...args]),
  };
  return { logger, errors };
}

test('启动先排首轮且不立即跑；到点执行并自动续排，缺省间隔 5000', async () => {
  const { scheduler, scheduled, pending, tick } = makeVirtualScheduler();
  const { lifecycle } = makeLifecycle();
  const { logger } = makeLogger();
  let drains = 0;

  startRecurringWorker(
    { lifecycle, scheduler, logger },
    async () => {
      drains += 1;
    },
    { label: 'wk', failureLogFormat: 'fail %s' },
  );

  assert.equal(drains, 0, '启动只排队，不立即执行');
  assert.equal(pending().length, 1, '已排一个首轮任务');
  assert.equal(scheduled[0]?.delay, DEFAULT_RECURRING_WORKER_INTERVAL_MS);
  assert.equal(DEFAULT_RECURRING_WORKER_INTERVAL_MS, 5_000);

  await tick();
  assert.equal(drains, 1, '首轮到点执行');
  assert.equal(pending().length, 1, '首轮跑完自动排下一轮（自链）');

  await tick();
  assert.equal(drains, 2, '第二轮到点执行');
  assert.equal(pending().length, 1, '继续保持一个等待中的下一轮');
});

test('自定义 intervalMs 原样透传给每次 schedule', async () => {
  const { scheduler, scheduled, tick } = makeVirtualScheduler();
  const { lifecycle } = makeLifecycle();
  const { logger } = makeLogger();

  startRecurringWorker(
    { lifecycle, scheduler, logger },
    async () => {},
    { label: 'wk', failureLogFormat: 'fail %s', intervalMs: 1234 },
  );
  assert.equal(scheduled[0]?.delay, 1234);
  await tick();
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1]?.delay, 1234, '续排沿用同一间隔');
});

test('drain 抛错不拖死循环：记一条 error 后照常续排', async () => {
  const { scheduler, pending, tick } = makeVirtualScheduler();
  const { lifecycle } = makeLifecycle();
  const { logger, errors } = makeLogger();
  let drains = 0;

  startRecurringWorker(
    { lifecycle, scheduler, logger },
    async () => {
      drains += 1;
      throw new Error('本轮失败');
    },
    { label: 'wk', failureLogFormat: 'worker 失败：%s' },
  );

  await tick();
  assert.equal(drains, 1);
  assert.deepEqual(errors[0], ['worker 失败：%s', 'Error: 本轮失败'], '错误经 logger.error 原样记账');
  assert.equal(pending().length, 1, '失败后仍续排，不向上抛、不中断循环');

  await tick();
  assert.equal(drains, 2, '下一轮照常运行');
  assert.equal(errors.length, 2);
});

test('label 原样传给生命周期口的 onDispose', () => {
  const { scheduler } = makeVirtualScheduler();
  const { lifecycle, labels } = makeLifecycle();
  const { logger } = makeLogger();

  startRecurringWorker(
    { lifecycle, scheduler, logger },
    async () => {},
    { label: 'dsh-fasti-closure-worker', failureLogFormat: 'fail %s' },
  );
  assert.deepEqual(labels, ['dsh-fasti-closure-worker']);
});

test('卸载：撤销等待中的下一轮句柄，之后不再触发', async () => {
  const { scheduler, pending, tick } = makeVirtualScheduler();
  const { lifecycle, holder } = makeLifecycle();
  const { logger } = makeLogger();
  let drains = 0;

  startRecurringWorker(
    { lifecycle, scheduler, logger },
    async () => {
      drains += 1;
    },
    { label: 'wk', failureLogFormat: 'fail %s' },
  );

  await tick();
  assert.equal(drains, 1);
  assert.equal(pending().length, 1, '已有一个等待中的下一轮');

  assert.equal(typeof holder.cleanup, 'function');
  holder.cleanup?.();
  assert.equal(pending().length, 0, '等待中的下一轮被撤销');

  await tick();
  assert.equal(drains, 1, '卸载后再多推进时间也不再轮询');
});

test('卸载发生在一轮 await 期间：本轮结束后不再续排（不留悬挂回调）', async () => {
  const { scheduler, scheduled, pending } = makeVirtualScheduler();
  const { lifecycle, holder } = makeLifecycle();
  const { logger } = makeLogger();
  let drains = 0;
  let releaseCurrent: (() => void) | undefined;

  const drain = (): Promise<void> =>
    new Promise<void>((resolve) => {
      drains += 1;
      releaseCurrent = resolve;
    });

  startRecurringWorker(
    { lifecycle, scheduler, logger },
    drain,
    { label: 'wk', failureLogFormat: 'fail %s' },
  );

  // 手动拉起首轮，但不让 drain 完成（不调用 tick，避免提前排空）。
  const first = scheduled[0];
  assert.ok(first);
  first.fired = true;
  first.cb();
  await Promise.resolve();
  assert.equal(drains, 1, '首轮已进入执行并挂起在 await drain');
  assert.equal(pending().length, 0, '本轮未结束前不会预排下一轮');

  assert.equal(typeof holder.cleanup, 'function');
  holder.cleanup?.(); // 此刻卸载：stopped 置位。
  assert.equal(typeof releaseCurrent, 'function');
  releaseCurrent?.();
  await new Promise((resolve) => setTimeout(resolve, 0)); // 排空，走到续排判断。

  assert.equal(pending().length, 0, 'await 期间卸载，本轮结束也不续排');
  assert.equal(drains, 1);
});
