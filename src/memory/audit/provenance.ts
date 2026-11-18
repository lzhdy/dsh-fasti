/**
 * 记忆层离线审计 —— 溯源审计（方案 §4.10/§6.7，裁决 I2/I5/I8，硬失败；C5 起默认全量）。
 *
 * 纪律：
 *  - 沿门面只读 resolvePointer 核验，但**不 import 门面**：resolver 由编排层（scripts/tests）注入（I2/M6）；
 *  - 只持 card.anchorJson 解析出的 anchor id（命名 anchorJson/anchorId，不读事件投影锚点字段，I5）；
 *  - 缓存漂移（cacheDrift）与 FTS 文本（ftsTextByCard）由编排层预计算注入；
 *  - **C5 起默认全量核验（sampleRatio=1，v4 §9 序 11：20% 抽样默认已停用）**；
 *    抽样函数保留供专项调查显式传 ratio 使用，终判链路不得再走抽样；
 *  - 成功率<100% 或悬空锚点 → failed（硬失败，区别于观测红线）；纯离线、无网络；顶层零求值。
 */

import { emitUnits } from '../bigram.ts';
import type { Pointer } from '../../contract/experience.ts';
import type { ResolvedPointer } from '../../contract/primitives.ts';
import type { MemoryCard } from '../types.ts';
import type { Rng } from './metrics.ts';

/** 指针解析回调（编排层装配 (p)=>fasti.resolvePointer(p)；必填、无缺省）。 */
export type PointerResolver = (pointer: Pointer) => Promise<ResolvedPointer>;

export interface ProvenanceOptions {
  rng: Rng;
  /** 缺省 1（C5 全量核验）；仅专项调查可显式传 <1 抽样，终判链路禁止。 */
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

/**
 * FTS 溯源③（#124 bigram 几何）：cue_text 中每个单元都必须能由本卡 display_cues 与
 * 非敏感别名经同一 emitUnits 重算产出，杜绝正文/敏感别名泄露。单向“列单元 ⊆ 可推导单元集”，
 * #124 后 trigram 词项口径已退役，bigram 单元按“列单元 ⊆ 可推导单元集”同强度核验；敏感别名先剔除再重算，故其 bigram 单元必然缺席。
 */
function ftsTraceable(card: MemoryCard, ftsText: string | undefined): boolean {
  if (ftsText === undefined) {
    return false;
  }
  const cues = JSON.parse(card.displayCuesJson) as string[];
  const safeAliasTerms = (JSON.parse(card.aliasesJson) as Array<{ term: string; sensitive: 0 | 1 }>)
    .filter((alias) => alias.sensitive === 0)
    .map((alias) => alias.term);
  const allowed = new Set(emitUnits([...cues, ...safeAliasTerms].join(' ')));
  for (const raw of ftsText.split(/\s+/)) {
    if (raw === '') {
      continue;
    }
    if (!allowed.has(raw)) {
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
  const ratio = options.sampleRatio ?? 1;
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