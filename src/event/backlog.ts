/**
 * 后台队列 —— 闭合摘要的待办队列（技术基线 §6.4）。
 *
 * 队列**不落盘**：持久真相是事件真源里的 `summary_quality='pending'`
 * （进程被杀 → 启动清道夫重扫即可）。这是「事件层是二级真源、后台队列只是加速」
 * 的直接体现 —— 队列丢了不丢事实，只丢一点时机。
 *
 * 退避常量放在本文件而不在 params.ts：params.ts 的可调参数名有「只此一处」的
 * 静态断言约束，且退避参数不在任务书点名的参数清单里（技术基线 §6.4）。
 */

/** 队列中的一项（= 一个待出摘要的事件）。 */
export interface BacklogTask {
  /** 幂等键：事件 id。同一事件在队列中至多一份。 */
  readonly eventId: string;
  /** 已尝试次数（0 = 尚未尝试）。 */
  readonly attempts: number;
  /** 下次可执行时刻（epoch ms）。 */
  readonly nextAttemptAtMs: number;
}

/** 后台任务队列（进程内）。持久真相是事件真源的 summary_quality='pending'。 */
export interface Backlog {
  /** 入队（幂等：已在队列则不重复入队，返回 false）。 */
  enqueue(eventId: string): boolean;
  /** 出队：取一个到期任务（未到期返回 undefined）。 */
  dequeue(nowMs: number): BacklogTask | undefined;
  /** 完成：从队列移除。 */
  complete(eventId: string): void;
  /** 失败重试：退避后重新入队（attempts+1）。 */
  retry(task: BacklogTask, nowMs: number): void;
  /** 队列长度。 */
  size(): number;
  /** 当前全部任务（诊断用）。 */
  snapshot(): BacklogTask[];
}

/** 重试初始退避（毫秒）。 */
export const RETRY_BASE_DELAY_MS = 30_000;
/**
 * 重试退避上限（毫秒）—— 十分钟。
 *
 * 写成乘法而非字面量：仓库有一条静态断言「摘要上限字面量只允许出现在契约层」
 * （tests/event/params.test.ts），裸字面量会误伤；值与基线一致。
 */
export const RETRY_MAX_DELAY_MS = 60_000 * 10;
/**
 * 连续失败上限（次）—— 达到即标记失败，不再自动重试。
 *
 * 达到上限**不写任何占位内容**：事件保持 pending + summary=null，
 * 如实表达「摘要未生成」；失败明细由调用方留痕（不静默丢弃）。
 */
export const RETRY_MAX_ATTEMPTS = 8;

/** 退避时长：base * 2^(attempts-1)，封顶 max（attempts ≤ 1 视作首次尝试）。 */
export function backoffDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
}

/**
 * 进程内后台队列 —— 闭合摘要的待办。
 *
 * 幂等：同一事件 id 至多一份任务（重放安全 —— 重复入队不产生第二份）。
 * 失败任务不丢：退避到下次可执行时刻，仍在队列里；只是**不出队**而已。
 */
export class InMemoryBacklog implements Backlog {
  /** eventId → 任务。Map 保证遍历顺序 = 入队顺序（诊断可读）。 */
  private readonly tasks = new Map<string, BacklogTask>();

  /** 入队（幂等：已在队列则不重复入队，返回 false）。 */
  enqueue(eventId: string): boolean {
    if (this.tasks.has(eventId)) {
      return false;
    }
    // nextAttemptAtMs = 0 → 立即到期（dequeue 取 nowMs >= 0 的都算到期）。
    this.tasks.set(eventId, { eventId, attempts: 0, nextAttemptAtMs: 0 });
    return true;
  }

  /**
   * 出队：取一个到期任务（未到期返回 undefined）。
   *
   * **不移除** —— 移除由 complete（成功）或 retry（失败重排）负责，
   * 这样「取出」与「结算」之间不会丢任务。
   */
  dequeue(nowMs: number): BacklogTask | undefined {
    let picked: BacklogTask | undefined;
    for (const task of this.tasks.values()) {
      if (task.nextAttemptAtMs > nowMs) {
        continue;
      }
      if (picked === undefined || task.nextAttemptAtMs < picked.nextAttemptAtMs) {
        picked = task;
      }
    }
    return picked;
  }

  /** 完成：从队列移除。 */
  complete(eventId: string): void {
    this.tasks.delete(eventId);
  }

  /** 失败重试：退避后重新入队（attempts+1）。 */
  retry(task: BacklogTask, nowMs: number): void {
    const attempts = task.attempts + 1;
    this.tasks.set(task.eventId, {
      eventId: task.eventId,
      attempts,
      nextAttemptAtMs: nowMs + backoffDelayMs(attempts),
    });
  }

  /** 队列长度。 */
  size(): number {
    return this.tasks.size;
  }

  /** 当前全部任务（诊断用）。 */
  snapshot(): BacklogTask[] {
    return [...this.tasks.values()];
  }
}
