/**
 * 摄入后置 stage 契约 + 执行器（技术基线 §4）。
 *
 * 纪律：
 *  - stage 在**同一写队列任务内**、真源 append 成功之后同步执行；
 *  - **stage 失败不阻断真源落盘**，但必须可观测（失败明细 + 检查点计数）；
 *  - **队列内不得再排队**：`WriterQueue` 是 Promise 串行队列，队内再排队会永久挂起
 *    → stage 内部写事件真源必须同步直调 `EventLog.appendVersion`，绝不可 `queue.run`；
 *  - stage 不得阻塞：内部禁止 await 长耗时 IO（尤其是 LLM）——
 *    闭合只做「入队」，摘要由后台 worker 做（§6）。
 */

import { nowIso } from '../core/time.ts';
import type { Experience } from '../contract/experience.ts';
import type { ExperienceLocation } from '../source/experience-log.ts';

/** stage 拿到的上下文（全部只读）。 */
export interface IngestStageContext {
  /** 刚落盘的真源经历（append 成功后的实体）。 */
  readonly experience: Experience;
  /** 该经历在 experiences/ 里的落点（双定位冗余侧）—— segmenter 用它拼 EventPointer。 */
  readonly location: ExperienceLocation;
  /** 通道 id（= experience.scene.channel）。 */
  readonly channel: string;
  /** 摄入序号。 */
  readonly tick: number;
}

/** 摄入后置 stage。切分员是第一个注册的 stage。 */
export interface IngestStage {
  /** 稳定名（用于失败归因与日志）。 */
  readonly name: string;
  /** 处理一条刚落盘的经历。抛错 = 本 stage 失败。 */
  run(ctx: IngestStageContext): void | Promise<void>;
}

/** stage 失败的观测记录（可观测性的载体）。 */
export interface IngestStageFailure {
  /** 失败的 stage 名。 */
  readonly stage: string;
  /** 出问题的经历 id。 */
  readonly experience_id: string;
  /** 通道 id。 */
  readonly channel: string;
  /** 失败时刻（ISO）。 */
  readonly at: string;
  /** 错误 message（非 Error 对象也转成字符串，不丢信息）。 */
  readonly error: string;
}

/** 简称别名（同一份契约，别处按 `StageFailure` 称呼时用）。 */
export type StageFailure = IngestStageFailure;

/** 失败明细环形缓冲上限：只留最近这些条。 */
const MAX_FAILURES = 100;

/**
 * 摄入后置 stage 注册表 —— 顺序执行、失败隔离、失败可观测。
 *
 * 失败语义（§4.3）：真源已落盘是事实，stage 失败**不回滚**（回滚 append-only 日志
 * 等于删行，违反冻结面第 1 条）；但失败必须看得见 → 记明细 + 返回给调用方。
 */
export class IngestStageRegistry {
  private readonly stages: IngestStage[] = [];
  private readonly failureLog: IngestStageFailure[] = [];
  /** 失败累计计数（环形缓冲会滚掉旧明细，累计数不会）。 */
  private failureTotal = 0;

  /** 注册一个 stage（按注册顺序执行；切分员是第一个注册的）。 */
  register(stage: IngestStage): void {
    this.stages.push(stage);
  }

  /** 已注册的 stage（只读副本）。 */
  list(): readonly IngestStage[] {
    return this.stages.slice();
  }

  /** 最近的失败明细（只读副本，环形：最多最近 MAX_FAILURES 条）。 */
  failures(): readonly IngestStageFailure[] {
    return this.failureLog.slice();
  }

  /** 失败累计次数（跨重启靠检查点持久化）。 */
  failureCount(): number {
    return this.failureTotal;
  }

  /**
   * 依次执行所有 stage。
   *
   * 某个 stage 抛错 → 只记失败明细，继续跑后面的 stage；**不抛给调用方**
   * （真源已落盘，stage 失败不阻断摄入）。
   *
   * @returns 本次执行产生的失败明细（空数组 = 全部成功）
   */
  async runAll(ctx: IngestStageContext): Promise<IngestStageFailure[]> {
    const failed: IngestStageFailure[] = [];
    for (const stage of this.stages) {
      try {
        await stage.run(ctx);
      } catch (error) {
        const failure: IngestStageFailure = {
          stage: stage.name,
          experience_id: ctx.experience.id,
          channel: ctx.channel,
          at: nowIso(),
          error: error instanceof Error ? error.message : String(error),
        };
        this.failureTotal += 1;
        this.failureLog.push(failure);
        if (this.failureLog.length > MAX_FAILURES) {
          this.failureLog.shift();
        }
        failed.push(failure);
      }
    }
    return failed;
  }
}
