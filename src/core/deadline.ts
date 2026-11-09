/**
 * 异步调用的硬时限 —— 全仓唯一实现（设计稿 v1.1 §6.3.1 纪律①）。
 *
 * 为什么要有它：一次不返回的宿主调用可以让整条后台队列永久停摆，而且**静默** ——
 * 它不是「失败」，是「没回来」，连失败明细都不会有。所以「有上限」不是优化项，
 * 是活性前提。
 *
 * 两条语义（必须同时成立，少一条都不够）：
 *  1. **到时限即 reject** —— 不管被调方理不理 `signal`。被调方不配合时，
 *     调用方也必须能继续往下走（否则上限形同虚设）；
 *  2. **到时限先 abort 传进去的 signal** —— 能取消就取消，别留悬挂连接。
 *     这一条是「不给别人添麻烦」，第 1 条才是「自己不被打死」。
 *
 * 为什么不做成「调用方自己 Promise.race」：每个调用点各写一遍，
 * 必然出现「某处忘了 abort」「某处忘了 clearTimeout」。收敛到一处，
 * 语义只有一份。
 */

/** 时限参数。 */
export interface DeadlineOptions {
  /**
   * 外部取消信号（可选）—— 例如上层已经有一个更早的截止时刻。
   *
   * 它 abort 时本调用同样中止（不额外计时）；这样「超时」与「上级取消」
   * 走同一条退出路径，调用方不用分两种情况处理。
   */
  readonly signal?: AbortSignal | undefined;
  /** 到时限时构造的错误（由调用方决定错误类型与文案，本模块不认识业务语义）。 */
  readonly timeoutError: () => Error;
}

/**
 * 在 `timeoutMs` 内执行 `run`，超时即失败。
 *
 * @param timeoutMs 时限（毫秒）。必须为正数；非正数视为「不可能的超时」直接失败。
 * @param run 被调方；收到可 abort 的 signal，**应当**透传给底层传输层。
 * @param options 外部 signal 与超时错误构造器。
 *
 * @throws 超时 → `options.timeoutError()`；外部 signal 中止 → 同一条路径；
 *         `run` 自己抛错 → 原样上抛（不包装，调用方本来就要区分自己的错）。
 */
export async function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  const controller = new AbortController();
  const external = options.signal;
  const onExternalAbort = (): void => controller.abort();
  if (external !== undefined) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 到点或被上级取消 → 用这个 promise 抢在（可能永不返回的）run 前面 reject。 */
  const abortGuard = new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      reject(options.timeoutError());
    };
    // 上级 signal 一开始就是 aborted：abort 事件已经过去了，不能靠监听补上，
    // 否则又变成「无限等」（这正是本模块要消灭的形态）。
    if (controller.signal.aborted) {
      fail();
      return;
    }
    controller.signal.addEventListener('abort', fail, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      // 绝不能 unref：这个计时器是「等一个可能不来的结果」时**唯一**的活物，
      // unref 之后一旦没有别的句柄，事件循环会直接空掉 —— 时限就永远不会到
      // （表现为「明明设了超时，却还是永久挂住」）。它在 finally 里被清掉，
      // 不会把进程拖着不放。
      timer = setTimeout(() => controller.abort(), timeoutMs);
    } else {
      // 非法时限：立刻按超时处理，不静默变成「无限等」。
      controller.abort();
    }
  });

  try {
    return await Promise.race([run(controller.signal), abortGuard]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    external?.removeEventListener('abort', onExternalAbort);
  }
}
