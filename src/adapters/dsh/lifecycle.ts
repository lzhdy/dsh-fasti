/**
 * dsh 生命周期插头 —— 把中立 LifecyclePort 薄落到 cordis 的 ctx.effect（H1 切片 2）。
 *
 * cordis 的 Fiber.effect 允许 effect 体**同步**返回一个 disposer（SyncEffect 形态），
 * fiber 卸载时逆序调用、重复释放 no-op。因此这里用同步包装即可完整表达 onDispose，
 * 与原 worker 注册的卸载语义一致，不引入 async 外壳。
 *
 * 依赖纪律：不直接 import `@deepseek-ai/cordis`，只声明用到的 effect 最小结构化面，
 * 离线测试可传同形假对象，无需真实 cordis Context。
 */

import type { LifecyclePort } from '../../ports/lifecycle-port.ts';

/** ctx.effect 的最小结构化面：同步 effect 体返回清理函数，可选诊断 label。 */
export interface DshEffectSink {
  effect(execute: () => unknown, label?: string): unknown;
}

/** 用宿主作用域构造一个中立 LifecyclePort。 */
export function createDshLifecycle(ctx: DshEffectSink): LifecyclePort {
  return {
    onDispose(cleanup, label) {
      // effect 体同步返回 cleanup：cordis 据此在卸载时回收，label 原样透传给诊断。
      ctx.effect(() => cleanup, label);
    },
  };
}
