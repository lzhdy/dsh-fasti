/**
 * 调度端口 —— 内核只认这个接口（平台化宿主中立 H1 切片 2）。
 *
 * 把"延迟一段时间再执行一个回调、且在它实际运行前可以撤销"从具体运行时（Node 的
 * setTimeout、浏览器定时器、测试用虚拟时钟）里抽象出来。内核不直接触碰全局定时器，
 * 同一段循环逻辑于是能在真实时钟与确定性假时钟下原样运行。
 *
 * 只提供一次性任务、不提供周期定时器：周期由调用方在上一轮结束后再次 schedule 自管，
 * 避免"上一轮还没跑完、下一轮又被时钟拉起"造成的任务堆积（与原 dsh worker 纪律一致）。
 */

/** 一次待执行任务的可撤销句柄。 */
export interface ScheduledTask {
  /**
   * 撤销这次待执行任务。若任务已经执行或已经撤销，调用应当无副作用（幂等）。
   */
  cancel(): void;
}

export interface SchedulerPort {
  /**
   * 安排 callback 在 delayMs 毫秒后执行一次，返回可撤销句柄。
   *
   * @param callback 到点执行的无参回调。
   * @param delayMs 延迟毫秒数；语义由后端时钟解释（真实时钟即墙钟时间）。
   */
  schedule(callback: () => void, delayMs: number): ScheduledTask;
}
