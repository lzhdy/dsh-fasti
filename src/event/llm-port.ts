/**
 * LLM 端口 —— 内核只认这个接口（技术基线 §6.1）。
 *
 * 内核（contract / source / event / core / projection）**零生产依赖**：
 * 本文件只有接口与类型，不 import 任何宿主包或 SDK。
 * 真正调模型的代码只在 src/adapters/dsh/llm.ts。
 *
 * 失败语义：抛错即失败（用 core/errors.ts 已有的 UnavailableError）——
 * 调用方负责退避重试，**不得**用占位文案糊过去（定案稿 §6.3）。
 */

import type { BoundaryCandidate } from '../contract/event.ts';

/** 摘要请求。 */
export interface LLMSummarizeRequest {
  /** 系统提示（内核生成：口径 + 写法指引 + 自检要求）。 */
  readonly system: string;
  /** 用户提示（内核生成：事件时间范围 + 原文文本）。 */
  readonly user: string;
  /** 模型提示（D8：摘要模型是配置项，可与做梦模型分开、可用更便宜的模型）。 */
  readonly model?: string;
  /** 摘要硬上限（字数）。适配器可据此提示/自检；内核侧还会独立校验。 */
  readonly maxChars: number;
}

/** 摘要结果。 */
export interface LLMSummarizeResponse {
  /** 客观摘要正文。 */
  readonly summary: string;
  /** 关键点 / 关键数据。 */
  readonly keyPoints: readonly string[];
  /** 事件锚点（第一期生成但不消费）。 */
  readonly anchors: readonly string[];
  /**
   * **实际使用**的模型标识（溯源用，可空）。
   *
   * 由适配器填 —— 只有它知道本次调用真正落到哪个模型上（宿主可能做了
   * 模型别名解析或降级）。宿主报不出来就是空，不填、不猜。
   */
  readonly model?: string | undefined;
  /**
   * 话题跳转候选（v1.4 · C7 慢路径）—— 摘要调用的**附带输出**。
   *
   * 唯一来源 = 摘要调用本身（不接 embedding 探测器，§5.2 B 类信号）。
   *
   * 硬约束：
   *  - **非权威**：候选只写 `boundary_candidates`，**绝不改** `pointers`/`time_range`/`status`；
   *  - **无分数、无置信度**：`kind` 是开放字符串，取值 '话题跳转'；没有 score 字段；
   *  - **最多 5 条**（超出由调用方截断）；
   *  - 解析失败则**丢弃候选、摘要照常落盘**（失败降级表第 4 行：不写半成品）。
   */
  readonly boundary_candidates?: readonly BoundaryCandidate[] | undefined;
}

/** 单次调用选项（由调用方给，不是模型参数）。 */
export interface LLMSummarizeOptions {
  /**
   * 取消信号 —— 调用方超时后据此中断底层请求。
   *
   * 端口**应当**透传给底层（能取消就取消，别留悬挂连接）；
   * 不透传也不影响正确性：调用方自己有超时闸，超时即按失败处理。
   */
  readonly signal?: AbortSignal | undefined;
}

/** 摘要端口。 */
export interface LLMPort {
  /**
   * 调一次模型产出摘要 + 关键点 + 锚点。
   *
   * 失败即抛错：调用方负责退避重试，不得用占位文案糊过去。
   *
   * **不得无限期挂住**：调用方有硬超时（设计稿 v1.1 §6.3.1 纪律①），
   * 超时按一次失败处理。实现方拿到 `signal` 时应当中断底层请求。
   */
  summarize(request: LLMSummarizeRequest, options?: LLMSummarizeOptions): Promise<LLMSummarizeResponse>;
}

/**
 * 别名：任务卡口径的「输入 / 结果 / 记录」三件套，与上面同一组类型。
 *
 * 保留别名是为了让按任务卡命名取用的调用方不必改写；类型本身完全同形。
 */
export type SummarizeInput = LLMSummarizeRequest;
export type SummarizeResult = LLMSummarizeResponse;
/** 一次摘要产出的记录（摘要 + 关键点 + 锚点）。 */
export type SummarizeRecord = LLMSummarizeResponse;
