/**
 * 记忆层离线审计 —— 叙事自我一致性探针（方案 §4.10/§6.4，裁决 I6/I9，v1 空置规则）。
 *
 * 纪律：
 *  - 样本为空 → {status:'n-a', reason:'no-reflection-pair', pairs:0}（逐字），严禁填零或造样；
 *  - 规则判定（v1 无叙事线/实体投影）：两窗口卡经 evaluateInvalidation 无未决 alias-conflict
 *    且 identity 槽卡一致 → consistent；否则 contradictory；
 *  - 禁止把普通对话轮冒充 reflection 对凑指标（§6.4）；
 *  - atMs 必填、禁 Date.now；纯离线、无网络；不读事件锚点字段、不 import 门面/store；顶层零求值。
 */

import { evaluateInvalidation } from '../invalidate.ts';
import type { AliasRow, AssembledWindow, MemoryCard } from '../types.ts';

/** 跨时间同主题提问对（reflection 对；v1 预期极少甚至 0）。 */
export interface ReflectionPair {
  questionARef: string;
  questionBRef: string;
}

export interface ConsistencyResult {
  status: 'n-a' | 'evaluated';
  reason?: string;
  pairs: number;
  consistent?: number;
  contradictory?: number;
}

export interface ConsistencyOptions {
  atMs: number;
  aliasTable: readonly AliasRow[];
  cardsById: ReadonlyMap<string, MemoryCard>;
}

/** windowsByPair 键约定（编排层与测试据此组装）。 */
export function consistencyPairKey(pair: ReflectionPair): string {
  return `${pair.questionARef}|${pair.questionBRef}`;
}

function identityCardIds(window: AssembledWindow): string[] {
  const slot = window.slots.find((s) => s.slot === 'identity');
  return slot === undefined ? [] : [...slot.cardIds];
}

function allCardIds(window: AssembledWindow): string[] {
  return window.slots.flatMap((s) => s.cardIds);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * 自我一致性判定。空样本走 N/A（不填数、不参与达标）；有样本则逐对规则判定。
 * 缺窗口/缺卡视为不可核验 → contradictory（保守，不伪造 consistent）。
 */
export function evaluateConsistency(
  pairs: readonly ReflectionPair[],
  windowsByPair: ReadonlyMap<string, readonly [AssembledWindow, AssembledWindow]>,
  options: ConsistencyOptions,
): ConsistencyResult {
  if (pairs.length === 0) {
    return { status: 'n-a', reason: 'no-reflection-pair', pairs: 0 };
  }
  let consistent = 0;
  let contradictory = 0;
  for (const pair of pairs) {
    const windows = windowsByPair.get(consistencyPairKey(pair));
    if (windows === undefined) {
      contradictory += 1;
      continue;
    }
    const [windowA, windowB] = windows;
    const identityMatch = sameIds(identityCardIds(windowA), identityCardIds(windowB));
    const cardIds = new Set([...allCardIds(windowA), ...allCardIds(windowB)]);
    let noConflict = true;
    for (const cardId of cardIds) {
      const card = options.cardsById.get(cardId);
      if (card === undefined) {
        noConflict = false;
        break;
      }
      const result = evaluateInvalidation({ card, atMs: options.atMs, aliasTable: options.aliasTable });
      if (result.reason === 'alias-conflict') {
        noConflict = false;
        break;
      }
    }
    if (identityMatch && noConflict) {
      consistent += 1;
    } else {
      contradictory += 1;
    }
  }
  return { status: 'evaluated', pairs: pairs.length, consistent, contradictory };
}