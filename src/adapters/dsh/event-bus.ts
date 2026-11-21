/**
 * dsh 事件总线插头 —— 把中立 EventBusPort 薄落到 cordis 的 ctx.on（H1 切片 3）。
 *
 * 只做同步薄转发：不包异步、不缓存、不改载荷。cordis 的 ctx.on 本身就是同步登记、
 * 监听器随当前 fiber 卸载自动移除（返回的 disposer 这里用不到，与改造前行为一致）。
 *
 * 依赖纪律：不直接 import `@deepseek-ai/cordis`，只声明用到的 on 最小结构化面，
 * 离线测试可传同形假 sink，无需真实 cordis Context。
 */

import type { EventBusPort } from '../../ports/event-bus-port.ts';

/** ctx.on 的最小结构化面：按名同步登记一个监听器。 */
export interface DshEventSink {
  on(name: string, listener: (...args: unknown[]) => void): unknown;
}

/** 用宿主事件服务构造一个中立 EventBusPort。 */
export function createDshEventBus(sink: DshEventSink): EventBusPort {
  return {
    on(eventName, listener) {
      // 必须保持同步：这一行在插件 apply 的同步栈内执行，等价改造前直接写 ctx.on。
      sink.on(eventName, listener);
    },
  };
}
