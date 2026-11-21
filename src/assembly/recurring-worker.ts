/**
 * 宿主无关的自管理循环 worker（平台化宿主中立 H1 切片 2）。
 *
 * 从 dsh 适配器两个后台 worker（闭合 / 记忆投影）抽出的同构骨架。只依赖三个中立端口，
 * 不 import 任何宿主包，也不直接碰全局定时器：
 *  - SchedulerPort：排"下一轮"。一次性 schedule、本轮跑完再排下一轮，绝不用固定周期
 *    定时器，防止上一轮没跑完就堆积；
 *  - LifecyclePort：登记卸载清理（置停标志 + 撤销待执行句柄）；
 *  - LoggerPort：单轮失败在此记账，错误不向上抛、不阻断后续轮次。
 *
 * 时序严格保持原 dsh worker 的行为：
 *  1. 启动后先等一个 intervalMs 才跑首轮（不是启动即跑）；
 *  2. 每轮 await drain；drain 抛错只经 logger 记账，随后照常进入续排判断；
 *  3. 卸载若发生在一轮 await 期间，本轮结束后不再续排；等待中的句柄同时被撤销，
 *     不留悬挂回调。
 */

import type { LifecyclePort } from '../ports/lifecycle-port.ts';
import type { LoggerPort } from '../ports/logger-port.ts';
import type { SchedulerPort, ScheduledTask } from '../ports/scheduler-port.ts';

/** 驱动一个循环 worker 所需的端口集合。 */
export interface RecurringWorkerPorts {
  readonly lifecycle: LifecyclePort;
  readonly scheduler: SchedulerPort;
  readonly logger: LoggerPort;
}

export interface RecurringWorkerOptions {
  /** 两轮之间的等待毫秒；缺省取 DEFAULT_RECURRING_WORKER_INTERVAL_MS。 */
  readonly intervalMs?: number | undefined;
  /** 注册到生命周期端口的诊断名（dsh 侧即 effect label）。 */
  readonly label: string;
  /** 单轮失败的日志格式串，需含一个 %s 占位以承接错误文本；原样交给 logger.error。 */
  readonly failureLogFormat: string;
}

/** 缺省轮询间隔（毫秒），与原两个 dsh worker 的默认值一致。 */
export const DEFAULT_RECURRING_WORKER_INTERVAL_MS = 5_000;

/**
 * 启动一个随作用域生命周期自管理的循环任务。
 *
 * 立即返回；实际工作都在 scheduler 回调里发生，卸载由 lifecycle 登记的清理负责。
 *
 * @param ports 生命周期 / 调度 / 日志三个中立端口。
 * @param drain 单轮逻辑，返回 Promise；抛错会被捕获并记账，不影响下一轮。
 * @param options 间隔、诊断名与失败日志格式。
 */
export function startRecurringWorker(
  ports: RecurringWorkerPorts,
  drain: () => Promise<unknown>,
  options: RecurringWorkerOptions,
): void {
  const { lifecycle, scheduler, logger } = ports;
  const intervalMs = options.intervalMs ?? DEFAULT_RECURRING_WORKER_INTERVAL_MS;

  let task: ScheduledTask | undefined;
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    try {
      await drain();
    } catch (error) {
      // 一轮失败不能拖死循环或宿主：记账后照常进入下面的续排判断。
      logger.error(options.failureLogFormat, String(error));
    }
    // 卸载可能发生在 await 期间 → 本轮结束也不再续排。
    if (stopped) {
      return;
    }
    task = scheduler.schedule(
      () => {
        void runOnce();
      },
      intervalMs,
    );
  };

  // 首轮同样是"等一个间隔"再跑，与原实现一致。
  task = scheduler.schedule(
    () => {
      void runOnce();
    },
    intervalMs,
  );

  lifecycle.onDispose(
    () => {
      stopped = true;
      task?.cancel();
      task = undefined;
    },
    options.label,
  );
}
