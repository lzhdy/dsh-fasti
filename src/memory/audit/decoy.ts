/**
 * 记忆层离线审计 —— DRM 诱饵对生成与 R2 错误认定（方案 §4.10/§6.3，裁决 I6/I14）。
 *
 * 纪律：
 *  - 近邻相似度采用统一 Jaccard 口径（规范化 cue+alias term、|交|/|并|）；
 *  - 本模块对 MemoryCard 的 term 集合自包含实现，不依赖外部模块；
 *  - search 注入兼容 Promise；atMs 必填、禁 Date.now；纯离线、无网络；
 *  - 不读事件锚点字段、不 import 门面/store；模块顶层仅字面量、零求值。
 *
 * 「DRM 诱饵」只测选择与判别，不生成任何用户可见文本（§6.3）。
 */

import { normalizeQuery } from '../bm25.ts';
import type { MemoryCard } from '../types.ts';
import type { DecoyItem } from './fixtures.ts';
import type { SearchFn } from './gold.ts';

/** 每卡近邻对（top2，不足取实际可用数）。 */
export interface DecoyPair {
  cardId: string;
  neighborCardIds: readonly string[];
}

/** 单条判别提问结果（top1 必须金标卡；高危错认单独计）。 */
export interface DecoyQuestionResult {
  goldCardId: string;
  topCardId: string | null;
  correct: boolean;
  highRiskLabel?: 'strong' | 'promise' | 'date' | 'verbatim' | 'negation';
  highRiskError: boolean;
}

/** 卡的检索词集合：规范化 cue + 规范化 alias term（空词剔除），统一 Jaccard 口径。 */
export function cardTermSet(card: MemoryCard): Set<string> {
  const terms = new Set<string>();
  const cues = JSON.parse(card.displayCuesJson) as string[];
  for (const cue of cues) {
    const norm = normalizeQuery(cue);
    if (norm !== '') {
      terms.add(norm);
    }
  }
  const aliases = JSON.parse(card.aliasesJson) as Array<{ term: string }>;
  for (const alias of aliases) {
    const norm = normalizeQuery(alias.term);
    if (norm !== '') {
      terms.add(norm);
    }
  }
  return terms;
}

/** Jaccard = |交|/|并|；空集对 = 0（纯函数）。 */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const term of a) {
    if (b.has(term)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 每卡取相似度最高的 top2 近邻（仅 >0；相似度降序→cardId 升序；不足取实际数）。
 * 输出按 cardId 升序，纯确定性。
 */
export function buildDecoyPairs(cards: readonly MemoryCard[]): DecoyPair[] {
  const sets = cards.map((card) => ({ cardId: card.cardId, terms: cardTermSet(card) }));
  const pairs: DecoyPair[] = [];
  for (const self of sets) {
    const neighbors: Array<{ cardId: string; similarity: number }> = [];
    for (const other of sets) {
      if (other.cardId === self.cardId) {
        continue;
      }
      const similarity = jaccardSimilarity(self.terms, other.terms);
      if (similarity > 0) {
        neighbors.push({ cardId: other.cardId, similarity });
      }
    }
    neighbors.sort((x, y) => {
      if (x.similarity !== y.similarity) {
        return y.similarity - x.similarity;
      }
      return x.cardId < y.cardId ? -1 : x.cardId > y.cardId ? 1 : 0;
    });
    pairs.push({ cardId: self.cardId, neighborCardIds: neighbors.slice(0, 2).map((n) => n.cardId) });
  }
  pairs.sort((x, y) => (x.cardId < y.cardId ? -1 : x.cardId > y.cardId ? 1 : 0));
  return pairs;
}

/**
 * R2 判别：对每条诱饵提问取检索 top1，必须是金标卡，否则记一次错误认定；
 * 高危五类（强断言/承诺/日期/原话/否定）错认单独计 highRiskError（§6.3）。
 */
export async function scoreDecoy(
  items: readonly DecoyItem[],
  search: SearchFn,
  options: { atMs: number },
): Promise<DecoyQuestionResult[]> {
  const results: DecoyQuestionResult[] = [];
  for (const item of items) {
    const ranked = await search({ text: item.discriminatorQuery, atMs: options.atMs, limit: 1 });
    const top = ranked[0];
    const topCardId = top === undefined ? null : top.card.cardId;
    const correct = topCardId === item.goldCardId;
    results.push({
      goldCardId: item.goldCardId,
      topCardId,
      correct,
      highRiskLabel: item.highRiskLabel,
      highRiskError: !correct && item.highRiskLabel !== undefined,
    });
  }
  return results;
}