/**
 * dsh/Node 调度插头 —— 用运行时全局定时器实现中立 SchedulerPort（H1 切片 2）。
 *
 * 时钟语义与原 dsh worker 严格保持一致：不 unref、不抖动、不合并；cancel 即
 * clearTimeout，而 Node 的 clearTimeout 对已触发/已清理的句柄本身幂等。
 *
 * 无运行时状态，工厂不接收参数；换浏览器/移动端时由各自适配器提供同形实现。
 */

import type { SchedulerPort } from '../../ports/scheduler-port.ts';

/** 构造基于宿主全局定时器的 SchedulerPort。 */
export function createDshScheduler(): SchedulerPort {
  return {
    schedule(callback, delayMs) {
      const handle = setTimeout(callback, delayMs);
      return {
        cancel() {
          clearTimeout(handle);
        },
      };
    },
  };
}
