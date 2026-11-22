/**
 * 闭合节拍器（平台化 #72 第一刀补件）。
 *
 * 内核把「事件闭合 + 摘要 drain」的**驱动权**交给装配方：`src/api/index.ts`
 * 里 `checkSilenceClock()` 只做"安静够久就闭合并入队"，`drainClosure()` 只做
 * "从队列取任务调模型"；谁按周期触发它们，是适配方的责任。dsh 用宿主 scheduler
 * 起常驻 worker（`src/adapters/dsh/mount.ts:151`）干这件事。
 *
 * node 启动器若只装配端口而不驱动，就会出现"模型接上了却永远不会被叫到、
 * 摘要永远 pending"的静默失效。本文件补上这个节拍：与 dsh worker 同序——
 * **先闭合（切的事），后摘要（写的事）**，且同一拨不重入。
 *
 * 目标面用最小结构化接口（`ClosureLoopTarget`），不绑 `Fasti` 具体类型：
 * 既便于测试用纯桩验证节拍契约，也表明节拍器只依赖这两个内核方法，不窥探别的东西。
 */

/** 节拍器只依赖的内核面（两个方法，都是 `Fasti` 的公开方法）。 */
export interface ClosureLoopTarget {
  /** 闭合"安静够久"的 open 事件并入队；返回本轮闭合条数。 */
  checkSilenceClock(nowMs?: number): number;
  /** 取队列任务调模型摘；返回本轮处理条数。 */
  drainClosure(): Promise<number>;
}

/** 节拍器选项。 */
export interface ClosureLoopOptions {
  /** 轮询间隔（毫秒），缺省 5000（与 dsh worker 同量级）。 */
  readonly intervalMs?: number;
  /** 失败上报；缺省静默（节拍是周期性的，不该每次失败都刷屏）。 */
  readonly onError?: (error: unknown, phase: 'silence' | 'drain') => void;
  /**
   * 每轮成功后的观测上报（#157 活动总线挂点）：闭合条数与摘要处理条数。
   * 失败轮不触发；回调异常必须被吞在节拍器内，绝不反噬内核节拍。
   */
  readonly onReport?: (report: { closed: number; summaries: number }) => void;
}

/** 节拍器句柄。 */
export interface ClosureLoopHandle {
  /** 停止节拍并清理定时器（幂等）。 */
  stop(): void;
}

/** 默认轮询间隔。 */
const DEFAULT_INTERVAL_MS = 5000;

/**
 * 启动闭合节拍器。
 *
 * 同一拨不重入：上一轮 `drainClosure` 还在飞时跳过本轮，避免慢模型下任务堆叠
 * （与 dsh worker 的"时长闸只在任务之间检查"同一考虑）。
 */
export function startClosureLoop(target: ClosureLoopTarget, options: ClosureLoopOptions = {}): ClosureLoopHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let inFlight = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    let closed = 0;
    try {
      closed = target.checkSilenceClock();
    } catch (error) {
      options.onError?.(error, 'silence');
      inFlight = false;
      return;
    }
    void target
      .drainClosure()
      .then((summaries) => {
        try {
          options.onReport?.({ closed, summaries });
        } catch {
          // 观测回调故障不反噬节拍。
        }
      })
      .catch((error: unknown) => {
        options.onError?.(error, 'drain');
      })
      .finally(() => {
        inFlight = false;
      });
  };

  // unref：节拍器不该单独把进程钉住；主服务关掉后进程要能自然退出。
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
