/**
 * 记忆投影节拍器（平台化 #72 对话第二刀补件）。
 *
 * dsh 侧除闭合 worker 外另有一个独立的 dsh-fasti-memory-projection-worker
 * （src/adapters/dsh/mount.ts），周期把第七法 `drainMemoryProjection` 拉一轮：
 * 从 append-only 真源折叠新卡/别名/台账进 memory-index 投影，预算化、失败隔离。
 * node 启动器第一刀只接了闭合节拍，投影没人驱动——门工具即便注册了也永远检索不到
 * 闭合后新长出来的卡。本文件补上同一职责的第二个节拍。
 *
 * 与 loop.ts 的闭合节拍同构：unref 定时器不钉进程、同一拨不重入、stop 幂等；
 * 两个节拍轮次与预算独立，投影失败绝不阻断闭合管线（门面内还有一层 try/catch 双保险）。
 */

/** 默认轮询间隔（毫秒），与 assembly 周期 worker 缺省值同量级。 */
const DEFAULT_PROJECTION_INTERVAL_MS = 5_000;

/** 单轮投影预算（毫秒）：与 dsh 侧 DEFAULT_MEMORY_PROJECTION_BUDGET_MS 同值，节点内本地定义。 */
export const DEFAULT_PROJECTION_BUDGET_MS = 60_000;

/** 节拍器只依赖的内核面。 */
export interface ProjectionLoopTarget {
  drainMemoryProjection(budgetMs: number): Promise<unknown>;
}

export interface ProjectionLoopOptions {
  readonly intervalMs?: number;
  readonly budgetMs?: number;
  readonly onError?: (error: unknown) => void;
  /**
   * 每轮 drain 成功后的观测上报（#157 活动总线挂点）：原样透传 drain 轮报告。
   * 失败轮不触发；报告形状由记忆内核定义，节拍器只透传不解读。
   */
  readonly onReport?: (report: unknown) => void;
}

export interface ProjectionLoopHandle {
  stop(): void;
}

/**
 * 启动记忆投影节拍。上一轮 drain 还在飞时跳过本轮，避免慢 drain 堆叠。
 */
export function startProjectionLoop(
  target: ProjectionLoopTarget,
  options: ProjectionLoopOptions = {},
): ProjectionLoopHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_PROJECTION_INTERVAL_MS;
  const budgetMs = options.budgetMs ?? DEFAULT_PROJECTION_BUDGET_MS;
  let inFlight = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    void target
      .drainMemoryProjection(budgetMs)
      .then((report) => {
        try {
          options.onReport?.(report);
        } catch {
          // 观测回调故障不反噬节拍。
        }
      })
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
    },
  };
}
