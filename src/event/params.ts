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
 *
 * **v1 → v2（v1.4 · C7）**：提示词扩展了「话题跳转候选」的输出指引，
 * 摘要正文的口径未变，但产出结构变了 → 版本号同次 bump（任务书 C7 明列）。
 * 新摘要写 `summary_prompt_version='v2'`；旧事件的 'v1' 原样保留（溯源是历史事实）。
 */
export const SUMMARY_PROMPT_VERSION = 'v2';

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
  /** A 类 · 单事件有效对话字数上限（非工具轮 char_count 累计，达到则闭合）。默认 7000。（v1.4 新增） */
  maxEffectiveCharsPerEvent: number;
  /** A 类 · 硬保险丝：单事件 raw 全量字符按 1 字符 ≈ 1 token 换算达到则强制闭合。默认 50000。（v1.4 新增） */
  fuseRawChars: number;
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
  /**
   * 任务闭环信号是否**激活**。默认 false（dormant）。
   *
   * 定案稿 §5.2 机械信号表把任务闭环标为 `dormant`，并写明唤醒路径是
   * 「阶段 0 类型化 + 作用域级判据落地并经用例验证后，**才把该信号从
   * `dormant` 改为 `active`**」；原文强调「**休眠是显式状态，不是一句注释**」。
   *
   * 因此本字段是这条信号**唯一的开关**：作用域级判据（inFlightCallIds +
   * 准入门槛 + 交付轮）始终照常维护，但只有本字段为 true 时它才参与闭合判定。
   * 关闭时（默认值）任务闭环**恒不产生** `task-closure` 闭合原因。
   *
   * 激活与否由**设计口径变更**决定，不由实现方自行打开 —— 实现方只负责把
   * 门控修好，让「dormant」成为可执行的状态而非注释。
   */
  taskClosureActive: boolean;
}

/**
 * 默认参数。
 *
 * v1.4：**`maxRecordsPerEvent`（20 条硬上限）已退役** —— 从本接口移除。
 * 条数上限是在对机器载荷计数（工具轮占全库 67.1% 字符却只占 14% 条数），
 * 于是「20 条 7 分钟攒满、边界总落在 JSON 中间」。定案稿 §9 明确
 * 「不做 20 条记录硬上限（退役，`max-records` 仅保留兼容读取）」。
 */
export const DEFAULT_EVENT_PARAMS: EventParams = {
  silenceGapMinutes: 30,
  maxEffectiveCharsPerEvent: 7000,
  fuseRawChars: 50000,
  summaryMaxChars: SUMMARY_MAX_CHARS,
  orphanWindowDays: 7,
  recentWindow: 10,
  minSimilarity: 0.7,
  closureCallTimeoutMs: DEFAULT_CLOSURE_CALL_TIMEOUT_MS,
  // 任务闭环信号休眠（定案稿 §5.2）—— 默认不激活。
  // 激活需经显式口径变更（dormant → active），实现方不得自行打开。
  taskClosureActive: false,
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

/**
 * 硬保险丝阈值 —— raw 全量字符换算成 token 后的闭合线（v1.4 新增）。
 *
 * 与 `maxEffectiveCharsOf` 量纲不同（全量含工具 JSON vs 非工具轮正文），不可合并；
 * 判定顺序钉死为**先保险丝、再有效对话字数**（定案稿 §5.2.1）。
 */
export function fuseLimitOf(params: EventParams): number {
  return params.fuseRawChars;
}

/** 单事件有效对话字数上限（v1.4 新增）。 */
export function maxEffectiveCharsOf(params: EventParams): number {
  return params.maxEffectiveCharsPerEvent;
}

/**
 * 任务闭环信号是否激活（定案稿 §5.2 的 `dormant` / `active` 开关）。
 *
 * 函数名刻意避开字段名（纪律 6：字段名只允许出现在本文件，
 * 其他模块一律经换算函数取值）。
 */
export function taskScopeActiveOf(params: EventParams): boolean {
  return params.taskClosureActive;
}

/**
 * 字符 → token 换算（v1.4 钉死：**1 raw 字符 ≈ 1 token**，定案稿 §5.2）。
 *
 * 恒等换算的纯函数：无副作用、无外部依赖、不引 tokenizer（纪律 5）。
 * 该取值对 CJK 近似准确，对 ASCII/JSON 高估令牌（实际 token 更少）→ 只会更早触发，
 * 属保守侧。常量只在本文件出现（纪律 6）。
 */
export function charsToTokens(rawChars: number): number {
  return rawChars;
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
