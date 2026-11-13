/**
 * 候选序号化 —— 方案 §4.7（冻结接口；吸收 Mem0 反幻觉教训）。
 *
 * 纪律：
 *  - 请求级私有映射：1..n -> card_id，不落库、不跨请求复用；
 *  - 未知/越界/失效序号一律抛 MemorySerialReferenceError，禁止猜序号、
 *    禁止用相近 id 顶替；上层捕获后允许重新检索一次，再败则本轮放弃引用；
 *  - 纯函数、无 I/O：降级判定只认错误类（instanceof），不靠 message 文案。
 */

import { MemorySerialReferenceError } from './memory-errors.ts';
import type { RankedCard, SerialMap } from './types.ts';

/** 按入参检索名次建 1..n 私有序号映射（每次检索新建，不缓存）。 */
export function buildSerialMap(cards: readonly RankedCard[]): SerialMap {
  const map = new Map<number, string>();
  for (const [index, ranked] of cards.entries()) {
    map.set(index + 1, ranked.card.cardId);
  }
  return map;
}

/** 按 picked 顺序解析序号；任一序号未知/非整数即抛错，不返回半截结果。 */
export function resolveSerials(map: SerialMap, picked: readonly number[]): string[] {
  return picked.map((serial) => {
    const cardId = Number.isInteger(serial) ? map.get(serial) : undefined;
    if (cardId === undefined) {
      throw new MemorySerialReferenceError(`候选序号未知或已失效：${serial}（拒绝引用，禁止猜测）`);
    }
    return cardId;
  });
}

/** 供上层降级判定：仅本错误类可触发「重取一次」纪律。 */
export function isSerialRefusable(e: unknown): boolean {
  return e instanceof MemorySerialReferenceError;
}