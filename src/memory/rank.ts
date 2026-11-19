/**
 * #129 P1/#130 P2 记忆排序器：合格全召回之后的纯函数字典序排序，不做任何删卡；
 * 截窗组合 composeView 负责 marked/ranked/explore 三块与探索位运气抽取。
 *
 * 排序键（主控 2026-11-19 拍板，见仓库外《#129…评估》《#130…P2施工评估》）：
 *   1. weight 档：她的复盘标记，weight>0 恒在最前（第一层永不遗忘）；档内分高在前，同分按 occurred；
 *   2. strength：离散步进整数遗忘强度（读时计算，库内只存 hitCount/lastHitMs 客观计数）；
 *   3. occurredMs：事件发生时间，新者在前；
 *   4. cardId：字典序兜底，保证同入参逐字节可重放。
 *
 * 纪律：零依赖纯函数、无 I/O、无 Date.now/Math.random，时钟经 nowMs 注入、探索随机经 rng 注入；
 * 不 import gate/bm25/store（无环）；强度只用于同档内的全序比较，不设任何布尔 cutoff。
 * #130 主控拍板：半衰期 29 天；强度走离散档 k=floor(idle/halfLife)、floor(hitCount/2^k) 整数化，
 * 不足一整次有效采用即归 0；探索位只承诺可审计的运气、不承诺覆盖轮转。
 */

import type { MemoryCard } from './types.ts';

export const RANK_POLICY = Object.freeze({
  dayMs: 24 * 60 * 60 * 1000,
  /** 东八区民用日偏移（与 time-resolve 同构，纯整数常量）。 */
  zoneOffsetMs: 8 * 60 * 60 * 1000,
  /** 记忆强度遗忘档时长：每满一个 29 天档，有效采用次数整除 2。#130 主控拍板 29 天。 */
  halfLifeMs: 29 * 24 * 60 * 60 * 1000,
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
  /** 离散步进有效采用次数 floor(hitCount/2^k)，恒为非负整数；零采用恒为 0。 */
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
 * 读时记忆强度（#130 离散步进整数版，主控 2026-11-19 拍板）。
 * k=满几个 29 天遗忘档（idle≤0 为 k=0），strength=floor(hitCount/2^k)：
 * 全程整数运算、跨平台逐字节一致，不足 1 次有效采用即归 0，不产生小数/浮点噪声。
 * 纯函数：给定卡面计数与同一 nowMs 结果逐字节同形；不写库、不衰减 weight。
 */
export function memoryStrength(card: Pick<MemoryCard, 'hitCount' | 'lastHitMs'>, nowMs: number): number {
  if (card.lastHitMs === null || card.hitCount <= 0) return 0;
  const idleMs = nowMs - card.lastHitMs;
  const k = idleMs <= 0 ? 0 : Math.floor(idleMs / RANK_POLICY.halfLifeMs);
  return Math.floor(card.hitCount / 2 ** k);
}

/** 确定性随机源（mulberry32，返回 [0,1)）；探索位运气只经入参注入，模块内禁 Math.random。 */
export type Rng = () => number;

/** mulberry32：零依赖确定性 PRNG，同种子同输入逐字节一致（与 audit/metrics 同款算法、各自自持守无环）。 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  opts: { readonly nowMs: number; readonly limit?: number | null },
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

  // limit=null 显式不截断（composeView 需要完整有序名单）；缺省回落默认上限 10。
  const cap = opts.limit === null ? cards.length : (opts.limit ?? RANK_POLICY.defaultLimit);
  return {
    entries: entries.slice(0, cap),
    candidateTotal: cards.length,
  };
}

/** 截窗槽位身份：marked=她的复盘标记；ranked=采用过的老卡序位；explore=零采用新卡探索位。 */
export type SlotTag = 'marked' | 'ranked' | 'explore';

export interface SlottedEntry extends RankedEntry {
  readonly slot: SlotTag;
}

/** 截窗汇总：三块实际张数＋探索位名义名额与实际填充（池不足时如实暴露缺口，绝不造卡）。 */
export interface ViewSlots {
  readonly marked: number;
  readonly ranked: number;
  readonly explore: number;
  readonly exploreWanted: number;
  readonly exploreFilled: number;
}

export interface ViewResult {
  readonly entries: readonly SlottedEntry[];
  readonly candidateTotal: number;
  readonly slots: ViewSlots;
}

/** 探索位占剩余槽位比例（主控拍板 20%，向上取整）。 */
const EXPLORE_RATIO = 0.2;

/**
 * #130 截窗组合（纯函数）：消费 rankCards 的**完整**有序名单（调用方传 limit:null 的 RankResult），
 * 按 marked→ranked→explore 三块产出截窗，不删卡、不改序、不修改入参。
 *
 * 名额（主控拍板）：重要卡先摆；剩余 N 槽，N≥2 时 exploreWanted=ceil(0.2N)（2..5 保 1、6..10 给 2），
 * N=1 无探索保底、独苗给老卡。老卡块沿用名单的强度→时间→cardId 全序；新卡块由注入 RNG 独立均匀
 * 抽取（允许长期落空、无轮转覆盖保证），同窗去重，RNG 手气不足时按名单序确定性补齐但不造卡；
 * 池子总量不足时跨块回填，slots 如实记录名义名额与实际张数。
 */
export function composeView(
  ranked: RankResult,
  opts: { readonly limit?: number; readonly rng: Rng },
): ViewResult {
  if (typeof opts.rng !== 'function') {
    throw new TypeError('composeView 需要注入 RNG 函数：纯内核禁止 Math.random 后门');
  }
  const cap = opts.limit ?? RANK_POLICY.defaultLimit;
  const all = ranked.entries;

  const markedPool = all.filter((entry) => entry.weight > 0);
  const oldPool = all.filter((entry) => entry.weight === 0 && entry.hitCount > 0);
  const freshPool = all.filter((entry) => entry.weight === 0 && entry.hitCount === 0);

  const markedBlock = markedPool.slice(0, cap);
  const remaining = cap - markedBlock.length;
  const exploreWanted = remaining >= 2 ? Math.ceil(remaining * EXPLORE_RATIO) : 0;
  const rankedQuota = remaining - exploreWanted;

  const oldBlock = oldPool.slice(0, rankedQuota);

  // 探索位：独立有放回抽取＋同窗去重；设守卫防手气恒定造成死循环，缺口随后确定性补。
  const exploreBlock: RankedEntry[] = [];
  const chosenIdx = new Set<number>();
  if (exploreWanted > 0 && freshPool.length > 0) {
    let guard = 0;
    const guardMax = exploreWanted * freshPool.length + freshPool.length;
    while (exploreBlock.length < exploreWanted && guard < guardMax) {
      guard += 1;
      const idx = Math.floor(opts.rng() * freshPool.length);
      if (!chosenIdx.has(idx)) {
        chosenIdx.add(idx);
        const picked = freshPool[idx];
        if (picked !== undefined) exploreBlock.push(picked);
      }
    }
    for (const entry of freshPool) {
      if (exploreBlock.length >= exploreWanted) break;
      const idx = freshPool.indexOf(entry);
      if (!chosenIdx.has(idx)) {
        chosenIdx.add(idx);
        exploreBlock.push(entry);
      }
    }
  }

  // 跨块回填：先老卡后新卡，保持 marked→ranked→explore 块顺序，总量不超 cap 与候选总数。
  const usedIds = new Set(
    [...markedBlock, ...oldBlock, ...exploreBlock].map((entry) => entry.cardId),
  );
  const fill = (pool: readonly RankedEntry[], block: RankedEntry[]): void => {
    for (const entry of pool) {
      if (markedBlock.length + oldBlock.length + exploreBlock.length >= cap) return;
      if (usedIds.has(entry.cardId)) continue;
      usedIds.add(entry.cardId);
      block.push(entry);
    }
  };
  fill(oldPool, oldBlock);
  fill(freshPool, exploreBlock);

  const tag = (entry: RankedEntry, slot: SlotTag): SlottedEntry => ({ ...entry, slot });
  const entries = [
    ...markedBlock.map((entry) => tag(entry, 'marked')),
    ...oldBlock.map((entry) => tag(entry, 'ranked')),
    ...exploreBlock.map((entry) => tag(entry, 'explore')),
  ].slice(0, cap);

  return {
    entries,
    candidateTotal: ranked.candidateTotal,
    slots: {
      marked: markedBlock.length,
      ranked: oldBlock.length,
      explore: exploreBlock.length,
      exploreWanted,
      exploreFilled: exploreBlock.length,
    },
  };
}
