/**
 * 单写者队列 —— 阶段 0–2 的单进程 Promise 串行队列（审计口径 10）。
 *
 * 纪律：
 *  - 所有真源 append 经同一队列（多通道并发安全，定案稿 §7.2「单写者」）；
 *  - 跨进程锁预留不实现，归 E 块（定案稿 §15-6）；
 *  - 队列本身不吞错误：某次写入失败会reject，但不影响后续任务继续排队。
 */

export type QueueTask<T> = () => Promise<T> | T;

/** Promise 串行队列。 */
export class WriterQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  /** 排队执行一个任务，返回其结果。 */
  run<T>(task: QueueTask<T>): Promise<T> {
    this.depth += 1;
    const result = this.tail.then(() => task());
    // 无论成败，链条都继续推进；失败信息由调用方自己的 Promise 承载。
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 当前是否有任务在执行或排队。 */
  get busy(): boolean {
    return this.depth > 0;
  }

  /** 等待队列排空。 */
  async drain(): Promise<void> {
    await this.tail;
    this.depth = 0;
  }
}
