/**
 * LOEO（Leave-One-Event-Out）真逐折重放（v4 §7、§9 序 6）。
 *
 * 背景：日历周 <5 无法做周级 holdout，旧实现只贴 `mode=loeo` 标签不回算（外审 B4）。
 * 本模块把 LOEO 做成可机械复核的逐折重放：
 *  - 折单位＝金标提问的目标事件 id（同事件多题整折留出）；
 *  - 每折用除该事件外的全部提问重新走一遍检索回放（search 注入，纯离线）；
 *  - 逐折记录题数/命中数/命中率，并给 pooled 命中率（跨折命中合计/题数合计）；
 *  - 任一折零样本或总折数 <2 → conclusive=false，终判层只能 INCONCLUSIVE。
 *
 * 纪律：不读库不读时钟，search/atMs 由编排层注入；无随机、同输入逐字节一致。
 */

import { replayGold } from './gold.ts';
import type { GoldQuestion, SearchFn } from './gold.ts';
import type { GoldReplayOptions } from './gold.ts';

export interface LoeoFold {
  readonly heldEventId: string;
  readonly n: number;
  readonly hits: number;
  readonly rate: number;
}

export interface LoeoResult {
  readonly folds: number;
  readonly conclusive: boolean;
  readonly reason?: string;
  readonly pooledRate: number | null;
  readonly perFold: readonly LoeoFold[];
}

/** 取提问去重后的目标事件 id（保序，确定性）。 */
export function targetEventIds(questions: readonly GoldQuestion[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const question of questions) {
    if (!seen.has(question.targetEventId)) {
      seen.add(question.targetEventId);
      ids.push(question.targetEventId);
    }
  }
  return ids;
}

/**
 * 逐折留一重放。k 透传金标回放口径（终判 R1 用 3）；relayMap/relayChains 同主回放注入。
 */
export async function runLoeo(
  questions: readonly GoldQuestion[],
  search: SearchFn,
  options: GoldReplayOptions,
): Promise<LoeoResult> {
  const eventIds = targetEventIds(questions);
  if (eventIds.length < 2) {
    return { folds: eventIds.length, conclusive: false, reason: 'loeo-folds-lt-2', pooledRate: null, perFold: [] };
  }

  const perFold: LoeoFold[] = [];
  let anyEmptyFold = false;
  let totalHits = 0;
  let totalN = 0;

  for (const heldEventId of eventIds) {
    const foldQuestions = questions.filter((q) => q.targetEventId !== heldEventId);
    if (foldQuestions.length === 0) {
      anyEmptyFold = true;
      perFold.push({ heldEventId, n: 0, hits: 0, rate: 0 });
      continue;
    }
    const results = await replayGold(foldQuestions, search, options);
    const hits = results.filter((r) => r.hit).length;
    totalHits += hits;
    totalN += results.length;
    perFold.push({ heldEventId, n: results.length, hits, rate: hits / results.length });
  }

  if (anyEmptyFold) {
    return { folds: eventIds.length, conclusive: false, reason: 'loeo-empty-fold', pooledRate: null, perFold };
  }
  return {
    folds: eventIds.length,
    conclusive: true,
    pooledRate: totalN === 0 ? null : totalHits / totalN,
    perFold,
  };
}
