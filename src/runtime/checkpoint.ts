/**
 * 运行态检查点 —— tick 计数器、引擎档位、降级标注。
 *
 * 定案稿 §8.1：
 *  | 状态 | 持久化 | 丢失后果（可接受性） |
 *  |  tick 计数器 | 检查点 | 无害：max(投影 tick)+1 自愈 |
 *  |  复盘游标等 | 检查点（write-through） | 代价 = 重复复盘一段窗口，幂等可承受 |
 *  |  当下状态容器 | 检查点 | 降级为「从零被唤醒」——比带错误状态好 |
 *
 * 纪律：检查点是**加速与标注**，不是权威 —— 真源才是权威（决策 D-6）。
 * 检查点丢失或损坏时，从真源重算（§8 运行循环「检查点损坏则从真源重算」）。
 */

import path from 'node:path';

import { CorruptedError } from '../core/errors.ts';
import { ensureDir, exists, writeFileAtomic } from '../core/fsx.ts';
import { parseJsonStrict } from '../core/fsx.ts';
import fs from 'node:fs';
import type { ProjectionLevel } from '../projection/types.ts';
import type { StageFailure } from '../event/ingest-stage.ts';

/** 最近失败明细的保留条数（环形缓冲上限；无界数组会撑大检查点）。 */
const MAX_STAGE_FAILURE_RECENT = 10;

/** 检查点内容。 */
export interface Checkpoint {
  version: 1;
  /** 上次分配的 tick（下一个 = tick + 1）。 */
  tick: number;
  /** 当前投影引擎档位。 */
  engine: ProjectionLevel;
  /** 是否处于降级运行。 */
  degraded: boolean;
  /** 降级原因。 */
  degraded_reason: string;
  /** 是否需要全量重建投影。 */
  needs_rebuild: boolean;
  /** 事件层：上次投影到的 tick（启动对账用）。 */
  last_projected_tick?: number;
  /** 事件层：最近一次启动清道夫扫到的 pending 数。 */
  pending_events?: number;
  /** 摄入 stage 失败**累计计数**（可观测：既知发生过多少，也知不知道还在持续）。 */
  stage_failures?: number;
  /** 摄入 stage 最近若干次失败的明细（环形缓冲，只留最近 MAX_STAGE_FAILURE_RECENT 条）。 */
  stage_failure_recent?: StageFailure[];
}

/** 检查点存储。 */
export class CheckpointStore {
  private readonly file: string;
  private state: Checkpoint;

  constructor(file: string) {
    this.file = file;
    this.state = {
      version: 1,
      tick: 0,
      engine: 'L1',
      degraded: false,
      degraded_reason: '',
      needs_rebuild: false,
    };
  }

  /**
   * 载入检查点。
   * 文件不存在 → 用默认值；损坏 → 抛 CorruptedError（由调用方决定从真源重算）。
   */
  load(): Checkpoint {
    if (!exists(this.file)) {
      this.state = {
        version: 1,
        tick: 0,
        engine: 'L1',
        degraded: false,
        degraded_reason: '',
        needs_rebuild: false,
      };
      return { ...this.state };
    }

    const text = fs.readFileSync(this.file, 'utf8');
    const parsed = parseJsonStrict<Checkpoint>(text, this.file);
    if (parsed.version !== 1) {
      throw new CorruptedError(`检查点版本不支持：${parsed.version}`);
    }
    this.state = {
      version: 1,
      tick: parsed.tick,
      engine: parsed.engine,
      degraded: parsed.degraded,
      degraded_reason: parsed.degraded_reason ?? '',
      needs_rebuild: parsed.needs_rebuild ?? false,
    };
    // 事件层字段是后加的可选项：旧检查点文件没有这些键 → 保持缺省，
    // 不报错、不改写既有字段语义（version 仍为 1）。
    if (typeof parsed.last_projected_tick === 'number') {
      this.state.last_projected_tick = parsed.last_projected_tick;
    }
    if (typeof parsed.pending_events === 'number') {
      this.state.pending_events = parsed.pending_events;
    }
    if (typeof parsed.stage_failures === 'number') {
      this.state.stage_failures = parsed.stage_failures;
    }
    if (Array.isArray(parsed.stage_failure_recent)) {
      this.state.stage_failure_recent = parsed.stage_failure_recent.slice(-MAX_STAGE_FAILURE_RECENT);
    }
    return { ...this.state };
  }

  /** 当前状态副本。 */
  get(): Checkpoint {
    return { ...this.state };
  }

  /** 写入检查点（原子写，write-through）。 */
  save(): void {
    ensureDir(path.dirname(this.file));
    writeFileAtomic(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  /** 设置 tick（已分配的最后一个 tick）。 */
  setTick(tick: number): void {
    this.state.tick = tick;
  }

  /** 记录引擎档位与降级状态。 */
  setEngine(engine: ProjectionLevel, degraded: boolean, reason: string): void {
    this.state.engine = engine;
    this.state.degraded = degraded;
    this.state.degraded_reason = reason;
  }

  /** 标记需要全量重建。 */
  setNeedsRebuild(needsRebuild: boolean): void {
    this.state.needs_rebuild = needsRebuild;
  }

  /** 记录事件层上次投影到的 tick（启动对账用）。 */
  setLastProjectedTick(tick: number): void {
    this.state.last_projected_tick = tick;
  }

  /** 记录待补摘要的事件数（启动清道夫扫到的 pending 数）。 */
  setPendingEvents(count: number): void {
    this.state.pending_events = count;
  }

  /**
   * 记录摄入 stage 失败：累计计数 + 最近若干条明细。
   *
   * 两者都要：单个累计数**既不能定位问题、也看不出是否在持续发生**；
   * 但无界数组会撑大检查点 → 明细只留最近 MAX_STAGE_FAILURE_RECENT 条。
   */
  setStageFailures(count: number, recent?: readonly StageFailure[]): void {
    this.state.stage_failures = count;
    if (recent !== undefined) {
      this.state.stage_failure_recent = recent.slice(-MAX_STAGE_FAILURE_RECENT);
    }
  }
}
