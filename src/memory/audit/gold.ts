/**
 * 记忆层离线审计 —— R1 证据召回回放（方案 §4.10/§6.2，裁决 I6/I16）。
 *
 * 纪律：
 *  - search 以注入回调传入（兼容 Promise，读柄 search 为 async）；atMs 必填、函数内禁 Date.now；
 *  - 接力映射（relayMap/relayChains）由编排层 foldCurrentEvents + successorCardHints 算得后注入（I5/I16），
 *    本模块不读事件锚点字段、不 import 门面/store；
 *  - 纯离线、无网络；模块顶层仅字面量、零求值。
 */

import type { RankedCard, SearchQuery } from '../types.ts';

/** 检索回调（读柄 search 为 async；测试可注入同步假检索）。 */
export type SearchFn = (query: SearchQuery) => RankedCard[] | Promise<RankedCard[]>;

/** 一条金标提问（编排层从夹具 + 真值组装；queryText 原始问句，规范化在 search 内）。 */
export interface GoldQuestion {
  queryText: string;
  targetEventId: string;
  questionRef: string;
  source: 'l0' | 'l1' | 'l2';
  initiation: 'her' | 'user' | 'environment';
  coldStart: boolean;
}

/** 单问回放结果（hit/rank/scoreParts + 接力链 + 分层透传）。 */
export interface GoldQuestionResult {
  questionRef: string;
  targetEventId: string;
  resolvedEventId: string;
  hit: boolean;
  rank: number | null;
  scoreParts: { bm25: number; recency: number } | null;
  relayChain: readonly string[];
  initiation: 'her' | 'user' | 'environment';
  coldStart: boolean;
  source: 'l0' | 'l1' | 'l2';
}

export interface GoldReplayOptions {
  atMs: number;
  /** 缺省 3；敏感性 k=1/5 由调用方再跑。 */
  k?: number;
  /** goldEventId → 当前 eventId（编排层注入；缺省映射到自身）。 */
  relayMap: ReadonlyMap<string, string>;
  relayChains?: ReadonlyMap<string, readonly string[]>;
}

/**
 * 金标回放：对每条提问用注入 search 取 top-k，判定接力后的目标事件是否命中、记录位次与 scoreParts。
 * 目标以金标 event_id 经 relayMap 映射到当前态后判定（§6.2）；未命中 rank=null。
 */
export async function replayGold(
  questions: readonly GoldQuestion[],
  search: SearchFn,
  options: GoldReplayOptions,
): Promise<GoldQuestionResult[]> {
  const k = options.k ?? 3;
  const results: GoldQuestionResult[] = [];
  for (const question of questions) {
    const resolvedEventId = options.relayMap.get(question.targetEventId) ?? question.targetEventId;
    const relayChain = options.relayChains?.get(question.targetEventId) ?? [question.targetEventId];
    const ranked = await search({ text: question.queryText, atMs: options.atMs, limit: k });
    let rank: number | null = null;
    let scoreParts: { bm25: number; recency: number } | null = null;
    for (let i = 0; i < ranked.length; i += 1) {
      const entry = ranked[i];
      if (entry !== undefined && entry.card.eventId === resolvedEventId) {
        rank = i + 1;
        scoreParts = entry.scoreParts;
        break;
      }
    }
    results.push({
      questionRef: question.questionRef,
      targetEventId: question.targetEventId,
      resolvedEventId,
      hit: rank !== null,
      rank,
      scoreParts,
      relayChain,
      initiation: question.initiation,
      coldStart: question.coldStart,
      source: question.source,
    });
  }
  return results;
}