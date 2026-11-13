/**
 * 记忆层离线审计 —— 抽样溯源审计（方案 §4.10/§6.7，裁决 I2/I5/I8，硬失败）。
 *
 * 纪律：
 *  - 沿门面只读 resolvePointer 核验，但**不 import 门面**：resolver 由编排层（scripts/tests）注入（I2/M6）；
 *  - 只持 card.anchorJson 解析出的 anchor id（命名 anchorJson/anchorId，不读事件投影锚点字段，I5）；
 *  - 缓存漂移（cacheDrift）与 FTS 文本（ftsTextByCard）由编排层预计算注入；
 *  - 20% 按卡（通道）分层抽样，共用注入 rng、同种子可复算（I8）；
 *  - 成功率<100% 或悬空锚点 → failed（硬失败，区别于观测红线）；纯离线、无网络；顶层零求值。
 */

import { normalizeQuery } from '../bm25.ts';
import type { Pointer } from '../../contract/experience.ts';
import type { ResolvedPointer } from '../../contract/primitives.ts';
import type { MemoryCard } from '../types.ts';
import { cardTermSet } from './decoy.ts';
import type { Rng } from './metrics.ts';

/** 指针解析回调（编排层装配 (p)=>fasti.resolvePointer(p)；必填、无缺省）。 */
export type PointerResolver = (pointer: Pointer) => Promise<ResolvedPointer>;

export interface ProvenanceOptions {
  rng: Rng;
  /** 缺省 0.2，按卡（通道）分层抽样。 */
  sampleRatio?: number;
  /** cardId → 缓存漂移（编排层 anchor 折叠当前态预计算）。 */
  cacheDrift: ReadonlyMap<string, boolean>;
  /** cardId → FTS cue_text（编排层只读 mem_card_fts 注入，溯源③）。 */
  ftsTextByCard: ReadonlyMap<string, string>;
}

export interface ProvenanceCardResult {
  cardId: string;
  anchorIds: readonly string[];
  resolved: number;
  dangling: number;
  cacheDrift: boolean;
  ftsTraceable: boolean;
  ok: boolean;
}

export interface ProvenanceResult {
  total: number;
  sampled: number;
  results: readonly ProvenanceCardResult[];
  successRate: number;
  danglingCount: number;
  failed: boolean;
}

/** 按通道分层、层内注入 rng 做部分 Fisher–Yates 抽样取 round(size*ratio)；确定性、可复算。 */
function stratifiedSample(cards: readonly MemoryCard[], ratio: number, rng: Rng): MemoryCard[] {
  if (cards.length === 0) {
    return [];
  }
  const byChannel = new Map<string, MemoryCard[]>();
  for (const card of cards) {
    const group = byChannel.get(card.channel);
    if (group === undefined) {
      byChannel.set(card.channel, [card]);
    } else {
      group.push(card);
    }
  }
  const sampled: MemoryCard[] = [];
  for (const channel of [...byChannel.keys()].sort()) {
    const group = byChannel.get(channel)!;
    const n = Math.min(group.length, Math.round(group.length * ratio));
    const indices = group.map((_, i) => i);
    for (let i = 0; i < n; i += 1) {
      const j = i + Math.floor(rng() * (indices.length - i));
      const tmp = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = tmp;
    }
    for (let i = 0; i < n; i += 1) {
      sampled.push(group[indices[i]!]!);
    }
  }
  if (sampled.length === 0) {
    sampled.push(cards[0]!);
  }
  return sampled;
}

/** FTS 溯源③：cue_text 每个词项（规范化后）须来自卡的 cue/alias，杜绝正文泄露。 */
function ftsTraceable(card: MemoryCard, ftsText: string | undefined): boolean {
  if (ftsText === undefined) {
    return false;
  }
  const terms = cardTermSet(card);
  for (const raw of ftsText.split(/\s+/)) {
    if (raw === '') {
      continue;
    }
    const norm = normalizeQuery(raw);
    if (norm !== '' && !terms.has(norm)) {
      return false;
    }
  }
  return true;
}

/**
 * 抽样溯源：对抽中卡逐 anchor id 经注入 resolver 解析（悬空计 dangling），
 * 核对缓存漂移与 FTS 溯源；任一不达标该卡 ok=false。成功率<1 或悬空>0 → failed。
 */
export async function auditProvenance(
  cards: readonly MemoryCard[],
  resolver: PointerResolver,
  options: ProvenanceOptions,
): Promise<ProvenanceResult> {
  const ratio = options.sampleRatio ?? 0.2;
  const sampled = stratifiedSample(cards, ratio, options.rng);
  const results: ProvenanceCardResult[] = [];
  let danglingCount = 0;
  for (const card of sampled) {
    const anchorIds = JSON.parse(card.anchorJson) as string[];
    let resolved = 0;
    let dangling = 0;
    for (const anchorId of anchorIds) {
      try {
        const resolvedPointer = await resolver({ id: anchorId });
        if (resolvedPointer.turns.length > 0) {
          resolved += 1;
        } else {
          dangling += 1;
        }
      } catch {
        dangling += 1;
      }
    }
    const drift = options.cacheDrift.get(card.cardId) ?? false;
    const traceable = ftsTraceable(card, options.ftsTextByCard.get(card.cardId));
    const ok = dangling === 0 && !drift && traceable;
    danglingCount += dangling;
    results.push({ cardId: card.cardId, anchorIds, resolved, dangling, cacheDrift: drift, ftsTraceable: traceable, ok });
  }
  const okCount = results.filter((r) => r.ok).length;
  const successRate = sampled.length === 0 ? 1 : okCount / sampled.length;
  return {
    total: cards.length,
    sampled: sampled.length,
    results,
    successRate,
    danglingCount,
    failed: successRate < 1 || danglingCount > 0,
  };
}