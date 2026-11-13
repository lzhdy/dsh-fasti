/**
 * 槽位制窗口 —— 方案 §4.8（冻结接口；吸收 LlamaIndex waterfall；裁决 G3–G6）。
 *
 * 纪律：
 *  - 无 I/O 纯函数：只给 card_id 与预算占用，不含正文；摘要由未来运行时凭只读柄现取；
 *  - 不读 event.anchors、不写 topic_lines；identity 资格经第三入参注入（G3 方案 A），
 *    缺省空集 → identity 槽恒空；资格数据源（anchor_json 经历回查 initiation='her'）
 *    由未来调用方提供，C3 不实现该回查；
 *  - 预算口径（G4）：[...displayCues, discriminator].join(' ') 的码点数，别名不计；
 *  - 卡为原子单位、卡内线索整组进退，turnsWhole 恒 true；
 *  - 函数自身绝不二次检索：needRefetch 只是给调用方的标记（至多一次）。
 */

import type { AssembledWindow, MemoryCard, RankedCard, WindowSpec } from './types.ts';

/** 摘要位 v1：具名空常量留痕，不占槽不占预算（G5）。 */
export const EMPTY_SUMMARY_V1 = '';

/** D2 结构常量（非观测值）：窗口码点硬顶。 */
const DEFAULT_HARD_CAP_CHARS = 700;

type SlotName = 'guaranteed' | 'recency' | 'identity' | 'relevance' | 'obligation';

/** 输出槽序（恒五槽，guaranteed/obligation v1 恒空）。 */
const SLOT_ORDER: readonly SlotName[] = ['guaranteed', 'recency', 'identity', 'relevance', 'obligation'];

/** 裁撤槽序（G6）：装入降序的逆序。 */
const TRIM_ORDER: readonly SlotName[] = ['obligation', 'relevance', 'identity', 'recency', 'guaranteed'];

/** 每卡预算文本码点数（G4）：cues + discriminator 拼接，活跃别名属检索词表不计入。 */
function cardChars(card: MemoryCard): number {
  const cues = JSON.parse(card.displayCuesJson) as string[];
  return [...[...cues, card.discriminator].join(' ')].length;
}

/**
 * 装配槽位制窗口（§4.8 / G5 / G6）。
 *
 * 归槽：recency = occurredMs 最大 1 张；identity = 资格集内 occurredMs 最大 1 张
 * 且不与 recency 重复；relevance = 其余候选按入参检索名次装入。
 * 裁撤：totalChars 超硬顶时按 obligation→relevance→identity→recency→guaranteed、
 * 槽内装入逆序逐卡移出，直到 ≤ 硬顶。
 * 标记：单卡自身超预算被移出 → needRefetch=false、refetchReason='oversized-card'；
 * 相关槽空且无身份/近因卡 → needRefetch=true、refetchReason='empty-relevance'；
 * 两者同时成立时 oversized-card 优先。
 */
export function assembleWindow(
  candidates: readonly RankedCard[],
  spec?: Partial<WindowSpec>,
  identityEligible?: ReadonlySet<string>,
): AssembledWindow {
  const hardCap = spec?.hardCapChars ?? DEFAULT_HARD_CAP_CHARS;
  const eligible = identityEligible ?? new Set<string>();

  const slots: Record<SlotName, string[]> = {
    guaranteed: [],
    recency: [],
    identity: [],
    relevance: [],
    obligation: [],
  };

  if (candidates.length > 0) {
    let recencyIdx = 0;
    for (let i = 1; i < candidates.length; i += 1) {
      const current = candidates[i];
      const best = candidates[recencyIdx];
      if (current !== undefined && best !== undefined && current.card.occurredMs > best.card.occurredMs) {
        recencyIdx = i;
      }
    }
    const recencyCard = candidates[recencyIdx];
    if (recencyCard !== undefined) {
      slots.recency.push(recencyCard.card.cardId);
    }

    let identityIdx = -1;
    for (let i = 0; i < candidates.length; i += 1) {
      const current = candidates[i];
      if (current === undefined || i === recencyIdx || !eligible.has(current.card.cardId)) {
        continue;
      }
      const best = identityIdx === -1 ? undefined : candidates[identityIdx];
      if (best === undefined || current.card.occurredMs > best.card.occurredMs) {
        identityIdx = i;
      }
    }
    const identityCard = identityIdx === -1 ? undefined : candidates[identityIdx];
    if (identityCard !== undefined) {
      slots.identity.push(identityCard.card.cardId);
    }

    for (let i = 0; i < candidates.length; i += 1) {
      const current = candidates[i];
      if (current === undefined || i === recencyIdx || i === identityIdx) {
        continue;
      }
      slots.relevance.push(current.card.cardId);
    }
  }

  const charsById = new Map<string, number>();
  for (const ranked of candidates) {
    charsById.set(ranked.card.cardId, cardChars(ranked.card));
  }
  const totalOf = (): number => {
    let total = 0;
    for (const name of SLOT_ORDER) {
      for (const cardId of slots[name]) {
        total += charsById.get(cardId) ?? 0;
      }
    }
    return total;
  };

  let oversized = false;
  while (totalOf() > hardCap) {
    let removed = false;
    for (const name of TRIM_ORDER) {
      const slot = slots[name];
      if (slot.length > 0) {
        const cardId = slot.pop() as string;
        if ((charsById.get(cardId) ?? 0) > hardCap) {
          oversized = true;
        }
        removed = true;
        break;
      }
    }
    if (!removed) {
      break;
    }
  }

  const emptyRelevance =
    slots.relevance.length === 0 && slots.identity.length === 0 && slots.recency.length === 0;

  let needRefetch = false;
  let refetchReason: string | undefined;
  if (oversized) {
    refetchReason = 'oversized-card';
  } else if (emptyRelevance) {
    needRefetch = true;
    refetchReason = 'empty-relevance';
  }

  return {
    slots: SLOT_ORDER.map((name) => ({ slot: name, cardIds: slots[name] })),
    totalChars: totalOf(),
    turnsWhole: true,
    needRefetch,
    ...(refetchReason === undefined ? {} : { refetchReason }),
  };
}