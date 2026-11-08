/**
 * tick 分配 —— 她的节拍序号。
 *
 * 口径：
 *  - tick 是**摄入序号**，按 append 顺序由 A 分配（定案稿 §5）；
 *  - 不保证与 occurred_at 顺序一致 —— 乱序到达时二者允许不一致；
 *  - 权威来源是真源 experiences 的 max(tick)（决策 D-6）；检查点丢失后可自愈；
 *  - 单调递增：同一毫秒内连续分配也不会重复。
 */

import { UlidGenerator } from '../core/ulid.ts';

/** tick 分配器。 */
export class TickAllocator {
  private current: number;

  constructor(start: number) {
    if (!Number.isInteger(start) || start < 0) {
      throw new TypeError(`tick 起点必须是非负整数，收到 ${start}`);
    }
    this.current = start;
  }

  /**
   * 由真源 max(tick) 构造分配器（下一步 = max + 1）。
   */
  static fromSource(maxTick: number): TickAllocator {
    return new TickAllocator(maxTick + 1);
  }

  /** 分配下一个 tick。 */
  next(): number {
    const value = this.current;
    this.current += 1;
    return value;
  }

  /** 当前下一个将被分配的 tick（不消耗）。 */
  peek(): number {
    return this.current;
  }
}

/** 供测试注入时钟用的 ULID 生成器（与 core/ulid 同源）。 */
export { UlidGenerator };
