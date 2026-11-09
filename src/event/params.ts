/**
 * 事件层全部可调参数 —— 魔法数字只此一处（技术基线 §5.1）。
 *
 * 纪律：
 *  - 参数是**注入点**，不是自动调参对象 —— 调整只影响以后新事件，不回改历史；
 *  - 每个可调参数的可读名称只出现在本文件（其他模块不得自带同义常量）；
 *  - 摘要硬上限的字面量在契约层（SUMMARY_MAX_CHARS），本文件引用同一常量，
 *    避免同一个上限在两处各写一遍后走偏。
 */

import { SUMMARY_MAX_CHARS } from '../contract/event.ts';

/**
 * 摘要提示词版本号（设计稿 v1.1 §3.2）—— 落进 `summary_prompt_version`。
 *
 * 改了 `closure.ts` 里两段提示词就**必须**改这个值：它是「这条摘要是哪版提示词
 * 生成的」的唯一标识。散落成字面量的话，改 prompt 时必然漏改某一处，
 * 溯源就成了假信息。
 */
export const SUMMARY_PROMPT_VERSION = 'v1';

/**
 * 单次模型调用的硬超时默认值（毫秒）—— 设计稿 v1.1 §6.3.1 纪律①。
 *
 * 没有它，一次不返回的调用会永久停掉整条摘要队列（而且是静默的：
 * 它不是「失败」，是「没回来」，连失败明细都不会有）。
 */
export const DEFAULT_CLOSURE_CALL_TIMEOUT_MS = 60_000;

/**
 * 闭合管线**单轮**处理的总时长上限默认值（毫秒）—— §6.3.1 纪律②。
 *
 * 条数上限（`drainClosure` 的 maxPerRound）挡不住「每条都很慢」：
 * 10 条 × 60 秒 = 一轮十分钟。加上时长上限，到限即返回，
 * 让调度照常排下一轮（队列不丢任务，只是分多轮做）。
 *
 * 取 2 分钟 = 两个调用超时：慢但正常的调用仍能做完，卡死的调用不会把整轮拖住。
 */
export const DEFAULT_CLOSURE_ROUND_BUDGET_MS = 120_000;

/** 事件层全部可调参数。 */
export interface EventParams {
  /** A 类 · 静默闭合分钟数（≥ 则闭合）。默认 30。 */
  silenceGapMinutes: number;
  /** A 类 · 单事件记录数上限（达到则闭合）。默认 20。 */
  maxRecordsPerEvent: number;
  /** 摘要硬上限字数。默认 600。 */
  summaryMaxChars: number;
  /** 孤立记录观察窗（天）。默认 7。 */
  orphanWindowDays: number;
  /** 话题线上下文窗口（最近 N 个事件的锚点）。默认 10（第二期才消费）。 */
  recentWindow: number;
  /** embedding 相似度下限（第二期才消费）。默认 0.7。 */
  minSimilarity: number;
  /** 单次模型调用硬超时（毫秒）。默认 60000。 */
  closureCallTimeoutMs: number;
}

/** 默认参数。 */
export const DEFAULT_EVENT_PARAMS: EventParams = {
  silenceGapMinutes: 30,
  maxRecordsPerEvent: 20,
  summaryMaxChars: SUMMARY_MAX_CHARS,
  orphanWindowDays: 7,
  recentWindow: 10,
  minSimilarity: 0.7,
  closureCallTimeoutMs: DEFAULT_CLOSURE_CALL_TIMEOUT_MS,
};

/**
 * 解析生效参数（可注入，便于测试用小阈值构造边界样例）。
 *
 * 未给出的项一律取默认值；显式传 undefined 也视为未给出。
 */
export function resolveEventParams(overrides?: Partial<EventParams>): EventParams {
  const merged: EventParams = { ...DEFAULT_EVENT_PARAMS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

// ── T4 追加：换算函数 ────────────────────────────────────────────────────
// 纪律：切分器 / 闭合管线**不得**直接读可调参数字段（字段名只允许出现在本文件），
// 一律经下面的换算函数取值 —— 换算口径也只此一处。

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** 静默闭合阈值（毫秒）。 */
export function silenceGapMsOf(params: EventParams): number {
  return params.silenceGapMinutes * MS_PER_MINUTE;
}

/** 单事件记录数上限。 */
export function maxRecordsOf(params: EventParams): number {
  return params.maxRecordsPerEvent;
}

/** 孤立记录观察窗（毫秒）。 */
export function orphanWindowMsOf(params: EventParams): number {
  return params.orphanWindowDays * MS_PER_DAY;
}

// ── T8 追加：闭合管线用的换算函数 ────────────────────────────────────────

/** 摘要硬上限字数（供闭合管线校验模型输出）。 */
export function summaryLimitOf(params: EventParams): number {
  return params.summaryMaxChars;
}

/** 单次模型调用硬超时（毫秒）—— 闭合管线调端口时的上限。 */
export function closureCallTimeoutMsOf(params: EventParams): number {
  return params.closureCallTimeoutMs;
}
