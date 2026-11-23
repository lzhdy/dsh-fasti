/**
 * 闭合永久失败台账 —— `state/closure-failures.jsonl`（append-only，#171）。
 *
 * 为什么需要它：闭合摘要连续失败达 `RETRY_MAX_ATTEMPTS` 即判定 exhausted、出队、
 * 事件保持 pending（`closure.ts` failTask）；失败明细只进**进程内**环形缓冲与宿主日志，
 * 进程一重启就清零，`sweepPending` 又会把这些「已判定永久失败」的事件从头再撞一遍上限。
 * 台账把终结态结算落盘，使「失败过几次、最后一次错什么」跨进程可见。
 *
 * 定位纪律：
 *  - 台账是**运行态观测**，不是事实源（真源仍是事件层）；文件丢了不丢事实，只丢历史；
 *  - **只记终结态**（exhausted / permanent），retry 态一律不写 —— 否则日志被刷屏；
 *  - append-only：只追加、绝不改写历史行；
 *  - 读时容忍末行截断残行（进程被 kill 时可能留半行），中间行坏仍抛 `CorruptedError`；
 *  - 本版**只记录不拦截**：`sweepPending` 仍按 pending 重新入队，重试行为零变化。
 */

import path from 'node:path';

import { CorruptedError } from '../core/errors.ts';
import { appendJsonl, readJsonlFile } from '../core/jsonl.ts';

/** 台账文件名（落在数据根 `state/` 下，与 checkpoint.json 并列）。 */
export const CLOSURE_FAILURES_FILE = 'closure-failures.jsonl';

/** 单条错误文本上限（码点）—— 台账是摘要级观测，不复制整段长错误。 */
export const FAILURE_LEDGER_ERROR_MAX_CHARS = 300;

/** 终结态：耗尽（连续失败达上限）/ 永久（模型未配置）。 */
export type ClosureFailureSettlementState = 'exhausted' | 'permanent';

/** 追加一条结算的入参。 */
export interface ClosureFailureSettlementInput {
  readonly event_id: string;
  /** 结算时刻（ISO）。 */
  readonly at: string;
  /** 本轮结算时的累计尝试次数（permanent = 0）。 */
  readonly attempts: number;
  readonly state: ClosureFailureSettlementState;
  readonly error: string;
  /** 结构化分桶原因（`detail.reason`，有则带出）。 */
  readonly reason?: string;
}

/** 台账里的一行（append 后的最终形状）。 */
export interface ClosureFailureLedgerRow extends ClosureFailureSettlementInput {
  /** 该事件第几次终结结算（1 起，跨进程延续）。 */
  readonly settlement_index: number;
}

/** 单个事件的历史汇总（读口）。 */
export interface ClosureFailureHistory {
  readonly event_id: string;
  /** 终结结算次数。 */
  readonly settlements: number;
  /** 累计尝试次数（各次结算 attempts 之和）。 */
  readonly total_attempts: number;
  readonly last_at: string;
  readonly last_state: ClosureFailureSettlementState;
  readonly last_error: string;
}

/** 台账窄口：管线只依赖 append，读口由装配方按需调用。 */
export interface ClosureFailureLedger {
  append(input: ClosureFailureSettlementInput): ClosureFailureLedgerRow;
  lookup(eventId: string): ClosureFailureHistory | undefined;
  snapshot(): readonly ClosureFailureHistory[];
}

/** 按码点截断（emoji 安全）；超限不抛，只截。 */
export function truncateFailureText(
  text: string,
  max: number = FAILURE_LEDGER_ERROR_MAX_CHARS,
): string {
  const codePoints = Array.from(text);
  return codePoints.length <= max ? text : `${codePoints.slice(0, max).join('')}…`;
}

/** 行形状校验：台账是自产自读，形状错了说明被外力改过 —— 显式报错，不静默跳过。 */
function assertLedgerRow(row: unknown, source: string): ClosureFailureLedgerRow {
  if (row === null || typeof row !== 'object') {
    throw new CorruptedError(`闭合失败台账行必须是对象（${source}）`);
  }
  const candidate = row as Record<string, unknown>;
  const eventId = candidate.event_id;
  const at = candidate.at;
  const attempts = candidate.attempts;
  const state = candidate.state;
  const error = candidate.error;
  const settlementIndex = candidate.settlement_index;
  if (typeof eventId !== 'string' || eventId === '') {
    throw new CorruptedError(`闭合失败台账行缺 event_id（${source}）`);
  }
  if (typeof at !== 'string' || at === '') {
    throw new CorruptedError(`闭合失败台账行缺 at（${source}）`);
  }
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) {
    throw new CorruptedError(`闭合失败台账行 attempts 必须是非负整数（${source}）`);
  }
  if (state !== 'exhausted' && state !== 'permanent') {
    throw new CorruptedError(`闭合失败台账行 state 越界（${source}）`);
  }
  if (typeof error !== 'string') {
    throw new CorruptedError(`闭合失败台账行 error 必须是字符串（${source}）`);
  }
  if (typeof settlementIndex !== 'number' || !Number.isInteger(settlementIndex) || settlementIndex < 1) {
    throw new CorruptedError(`闭合失败台账行 settlement_index 必须是 >=1 的整数（${source}）`);
  }
  const reason = candidate.reason;
  if (reason !== undefined && typeof reason !== 'string') {
    throw new CorruptedError(`闭合失败台账行 reason 必须是字符串（${source}）`);
  }
  return {
    event_id: eventId,
    at,
    attempts,
    state,
    error,
    settlement_index: settlementIndex,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** 台账文件路径。 */
export function closureFailuresPathOf(dir: string): string {
  return path.join(dir, CLOSURE_FAILURES_FILE);
}

/**
 * 读取整本台账（末行截断容忍；文件不存在返回空数组）。
 *
 * 为什么容忍末行：进程可能在 append 中途被 kill，留下半行 JSON；把整本台账读崩
 * 会让「重启后看见历史」这件唯一的价值也失效。
 */
export function readClosureFailures(dir: string): ClosureFailureLedgerRow[] {
  const filePath = closureFailuresPathOf(dir);
  const rows = readJsonlFile<unknown>(filePath, { tolerant: true });
  return rows.map((row) => assertLedgerRow(row, filePath));
}

/** 由已读行聚合为按事件的汇总（后写覆盖前写的「最近一次」字段）。 */
function aggregate(rows: Iterable<ClosureFailureLedgerRow>): Map<string, ClosureFailureHistory> {
  const byEvent = new Map<string, ClosureFailureHistory>();
  for (const row of rows) {
    const prior = byEvent.get(row.event_id);
    byEvent.set(row.event_id, {
      event_id: row.event_id,
      settlements: (prior?.settlements ?? 0) + 1,
      total_attempts: (prior?.total_attempts ?? 0) + row.attempts,
      last_at: row.at,
      last_state: row.state,
      last_error: row.error,
    });
  }
  return byEvent;
}

/**
 * 文件台账：构造时载入历史（一次读全量，本地单用户文件很小），append 即追加并更新内存汇总。
 *
 * 并发纪律：进程内同步 append（`appendFileSync`），不做跨进程锁 —— 当前只有一个写入者；
 * 多写入者属 #72 跨进程冻结项，届时需版本号乐观锁（不在本版范围）。
 */
export class FileClosureFailureLedger implements ClosureFailureLedger {
  readonly dir: string;
  private readonly byEvent: Map<string, ClosureFailureHistory>;

  constructor(dir: string) {
    this.dir = dir;
    this.byEvent = aggregate(readClosureFailures(dir));
  }

  append(input: ClosureFailureSettlementInput): ClosureFailureLedgerRow {
    const prior = this.byEvent.get(input.event_id);
    const row: ClosureFailureLedgerRow = {
      event_id: input.event_id,
      at: input.at,
      attempts: input.attempts,
      state: input.state,
      error: truncateFailureText(input.error),
      settlement_index: (prior?.settlements ?? 0) + 1,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };
    appendJsonl(closureFailuresPathOf(this.dir), row);
    this.byEvent.set(input.event_id, {
      event_id: row.event_id,
      settlements: row.settlement_index,
      total_attempts: (prior?.total_attempts ?? 0) + row.attempts,
      last_at: row.at,
      last_state: row.state,
      last_error: row.error,
    });
    return row;
  }

  lookup(eventId: string): ClosureFailureHistory | undefined {
    return this.byEvent.get(eventId);
  }

  snapshot(): readonly ClosureFailureHistory[] {
    return [...this.byEvent.values()];
  }
}
