/**
 * 进程内活动总线（#157 网页控制台实时脉冲）。
 *
 * 定位：node 身体进程内存里的有界环形缓冲＋等待者通知原语，**不持久化、不跨进程、
 * 不参与任何内核写决策**——挂点只允许报告事实，总线失败/缺失不得影响写入链与读出链本身。
 * 长轮询 HTTP 端点在其上实现：序号游标增量拉取＋waitForNext 挂等，避开 SSE 无法携带
 * Authorization 头的问题，继续复用 Bearer token 鉴权纪律。
 *
 * 零依赖：仅 node 全局类型与标准 Promise/setTimeout。
 */

/** 活动种类封闭枚举（前端流水线高亮与图标按此契约分支，挂点不得自造词表）。 */
export const ACTIVITY_KINDS = [
  /** 一次原文摄入走完写队列（观测 stage 挂点；带 channel/tick/eventId）。 */
  'ingest.turn',
  /** 静默闭合轮跑完（带处理条数/失败数）。 */
  'closure.drain',
  /** 摘要产出轮跑完（带 ready/失败条数）。 */
  'summary.drain',
  /** 记忆投影 worker 一轮 pull 完成（带卡增/失效/隔离计数）。 */
  'memory.drain',
  /** 节拍/投影/闭合循环报错。 */
  'loop.error',
  /** 聊天回合内一次六工具调用（读出链；带工具名与成败/候选数元数据，不含正文）。 */
  'tool.call',
  /** 一次聊天回合结束（带轮次/成败）。 */
  'chat.turn',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_LEVELS = ['info', 'ok', 'warn', 'error'] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

/** 单条脉冲：seq 进程内单调递增（从 1 起），data 为可选结构化附加，事件整体冻结。 */
export interface ActivityEvent {
  readonly seq: number;
  readonly at: number;
  readonly kind: ActivityKind;
  readonly level: ActivityLevel;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface ActivityBusOptions {
  /** 环形缓冲容量，缺省 500；超出自动淘汰最旧事件。 */
  readonly capacity?: number;
  /** 时钟注入（测试固定时间用），缺省 Date.now。 */
  readonly now?: () => number;
  /**
   * 挂等定时器是否 unref（缺省 true）：生产长驻服务里避免空转轮询句柄拖住进程退出；
   * 测试事件循环没有其它 ref 句柄，需传 false 保持挂等可被等到。
   */
  readonly unrefTimers?: boolean;
}

const DEFAULT_CAPACITY = 500;

export class ActivityBus {
  private seq = 0;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly unrefTimers: boolean;
  private readonly ring: ActivityEvent[] = [];
  private readonly waiters = new Set<(event: ActivityEvent | null) => void>();
  private disposed = false;

  constructor(options: ActivityBusOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`ActivityBus capacity 必须是正整数，实际收到：${String(capacity)}`);
    }
    this.capacity = capacity;
    this.now = options.now ?? (() => Date.now());
    this.unrefTimers = options.unrefTimers ?? true;
  }

  /** 报告一条脉冲；kind/level/message 形状非法即抛（编程错误，不静默吞契约漂移）。 */
  emit(
    kind: ActivityKind,
    level: ActivityLevel,
    message: string,
    data?: Record<string, unknown>,
  ): ActivityEvent {
    if (this.disposed) {
      throw new Error('ActivityBus 已 dispose，不能再上报活动');
    }
    if (!ACTIVITY_KINDS.includes(kind)) {
      throw new Error(`未知活动 kind：${String(kind)}`);
    }
    if (!ACTIVITY_LEVELS.includes(level)) {
      throw new Error(`未知活动 level：${String(level)}`);
    }
    if (typeof message !== 'string' || message.trim() === '') {
      throw new Error('活动 message 必须是非空字符串');
    }
    this.seq += 1;
    const event: ActivityEvent = Object.freeze({
      seq: this.seq,
      at: this.now(),
      kind,
      level,
      message,
      ...(data === undefined ? {} : { data: Object.freeze({ ...data }) }),
    });
    this.ring.push(event);
    if (this.ring.length > this.capacity) {
      this.ring.shift();
    }
    for (const resolve of this.waiters) {
      resolve(event);
    }
    this.waiters.clear();
    return event;
  }

  /** 当前最新序号（无事件为 0）。 */
  currentSeq(): number {
    return this.seq;
  }

  /** 返回缓冲区内序号严格大于 after 的现存事件；游标落在淘汰窗口内不报错。 */
  since(after: number): ActivityEvent[] {
    if (!Number.isInteger(after) || after < 0) {
      throw new Error(`ActivityBus.since 的游标必须是非负整数，实际收到：${String(after)}`);
    }
    return this.ring.filter((event) => event.seq > after);
  }

  /**
   * 挂等下一条脉冲：新事件到达即 resolve；timeoutMs 内无事件 resolve null；
   * dispose 时所有挂等立即以 null 释放（HTTP 连接关闭路径据此防悬挂）。
   */
  waitForNext(timeoutMs: number): Promise<ActivityEvent | null> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error(`waitForNext 超时必须是正整数毫秒，实际收到：${String(timeoutMs)}`);
    }
    if (this.disposed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      // 生产态不阻止进程退出（本机服务关停时不被空转轮询句柄拖住）；测试显式关掉该行为。
      if (this.unrefTimers) {
        timer.unref?.();
      }
      const waiter = (event: ActivityEvent | null): void => {
        clearTimeout(timer);
        resolve(event);
      };
      this.waiters.add(waiter);
    });
  }

  /** 释放全部等待者；之后 emit 会抛、waitForNext 立即 null。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resolve of this.waiters) {
      resolve(null);
    }
    this.waiters.clear();
  }
}
