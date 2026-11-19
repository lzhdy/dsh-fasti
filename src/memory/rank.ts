/**
 * #129 P1 记忆排序器：合格全召回之后的纯函数字典序排序，不做任何删卡。
 *
 * 排序键（主控 2026-11-19 拍板，见仓库外《#129记忆排序化-P1红测与施工评估》）：
 *   1. weight 档：她的复盘标记，weight>0 恒在最前（第一层永不遗忘）；档内分高在前，同分按 occurred；
 *   2. strength：带指数遗忘的记忆强度（读时计算，库内只存 hitCount/lastHitMs 客观计数）；
 *   3. occurredMs：事件发生时间，新者在前；
 *   4. cardId：字典序兜底，保证同入参逐字节可重放。
 *
 * 纪律：零依赖纯函数、无 I/O、无 Date.now/Math.random，时钟经 nowMs 注入；
 * 不 import gate/bm25/store（无环）；连续强度只用于同档内的全序比较，不设任何 cutoff。
 * halfLifeMs 是具名可评审策略常量（P2 复评 7 天/29 天两档），不进冻结查询、不逐请求传参。
 */

import type { MemoryCard } from './types.ts';

export const RANK_POLICY = Object.freeze({
  dayMs: 24 * 60 * 60 * 1000,
  /** 东八区民用日偏移（与 time-resolve 同构，纯整数常量）。 */
  zoneOffsetMs: 8 * 60 * 60 * 1000,
  /** 记忆强度半衰期：隔一个半衰期未被采用，强度衰减一半。P2 立项复评。 */
  halfLifeMs: 7 * 24 * 60 * 60 * 1000,
  /** 单次返回的默认上限；candidateTotal 始终返回全集大小，截断可见。 */
  defaultLimit: 10,
  /** 相对时间标签窗口：30 天内说"N天前"，更早给绝对日期。 */
  relativeLabelMaxDays: 30,
});

export interface RankedEntry {
  readonly cardId: string;
  readonly weight: number;
  readonly hitCount: number;
  readonly lastHitMs: number | null;
  /** hitCount × 0.5^(闲置时长/半衰期)；零采用恒为 0。 */
  readonly strength: number;
  readonly occurredMs: number;
  /** 注入锚点下生成的人话时间标签（今天/昨天/N天前/YYYY-MM-DD）。 */
  readonly timeLabel: string;
}

export interface RankResult {
  readonly entries: readonly RankedEntry[];
  readonly candidateTotal: number;
}

/**
 * 读时记忆强度（艾宾浩斯指数遗忘，外部依据见评估文档第九节）。
 * 纯函数：给定卡面计数与同一 nowMs，结果逐字节同形；不写库、不衰减 weight。
 */
export function memoryStrength(card: Pick<MemoryCard, 'hitCount' | 'lastHitMs'>, nowMs: number): number {
  if (card.lastHitMs === null || card.hitCount <= 0) return 0;
  const idleMs = nowMs - card.lastHitMs;
  if (idleMs <= 0) return card.hitCount; // 采用时刻即查询时刻：无衰减
  return card.hitCount * Math.pow(0.5, idleMs / RANK_POLICY.halfLifeMs);
}

/** 东八区民用日序号（整日地板），与 time-resolve.localDayIndexOf 同构，本模块自持以守无环。 */
function localDayIndex(ms: number): number {
  return Math.floor((ms + RANK_POLICY.zoneOffsetMs) / RANK_POLICY.dayMs);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 人话时间标签：纯函数，锚点注入；只做整日粒度，不碰钟点。 */
export function humanTimeLabel(occurredMs: number, nowMs: number): string {
  const dayDiff = localDayIndex(nowMs) - localDayIndex(occurredMs);
  if (dayDiff === 0) return '今天';
  if (dayDiff === 1) return '昨天';
  if (dayDiff >= 2 && dayDiff <= RANK_POLICY.relativeLabelMaxDays) return `${dayDiff}天前`;
  const d = new Date(occurredMs + RANK_POLICY.zoneOffsetMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * 字典序排序：返回有序条目与全集总数。不修改入参数组；limit 只截断投影，不改变 candidateTotal。
 */
export function rankCards(
  cards: readonly MemoryCard[],
  opts: { readonly nowMs: number; readonly limit?: number },
): RankResult {
  const nowMs = opts.nowMs;
  const entries: RankedEntry[] = cards.map((card) => ({
    cardId: card.cardId,
    weight: card.weight,
    hitCount: card.hitCount,
    lastHitMs: card.lastHitMs,
    strength: memoryStrength(card, nowMs),
    occurredMs: card.occurredMs,
    timeLabel: humanTimeLabel(card.occurredMs, nowMs),
  }));

  entries.sort((a, b) => {
    // 第 1 键：复盘标记档（有标记恒在前），档内分高在前、同分落到后续键
    const tierA = a.weight > 0 ? 1 : 0;
    const tierB = b.weight > 0 ? 1 : 0;
    if (tierA !== tierB) return tierB - tierA;
    if (tierA === 1 && a.weight !== b.weight) return b.weight - a.weight;
    // 第 2 键：记忆强度（遗忘后的采用分量）
    if (a.strength !== b.strength) return b.strength - a.strength;
    // 第 3 键：发生时间新者在前
    if (a.occurredMs !== b.occurredMs) return b.occurredMs - a.occurredMs;
    // 第 4 键：cardId 字典序兜底
    return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
  });

  const cap = opts.limit ?? RANK_POLICY.defaultLimit;
  return {
    entries: entries.slice(0, cap),
    candidateTotal: cards.length,
  };
}
