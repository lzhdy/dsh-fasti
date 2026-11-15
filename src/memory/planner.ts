/**
 * 纯规划层（#42 正本 §3.4 残差铁律、§3.5 R-06 别名重绑、§2.5 rules 版本协议）。
 *
 * 边界：
 *  - 零 IO、零 `node:fs`、不 import store/ledger/builder，不接 worker，不新增 drain/第七法；
 *    plan 只产出「要做什么动作」，落库由 B2 编排执行；
 *  - 残差铁律：动作顶层键集合结构上不存在 `hit_count/hitCount/weight/last_hit_ms/lastHitMs`，
 *    也不存在 miss/observation/audit 字段；新建卡与更新卡是两种不同动作类型；
 *  - 残差（hitCount/lastHitMs）只在 `migrate-aliases` 的别名条目内随 event_id 重绑，
 *    不出现在卡动作顶层。
 */

/** 动作类型封闭集合（结构断言用，不得扩项）。 */
export const PLANNER_ACTION_TYPES = [
  'create-card',
  'update-card',
  'invalidate-card',
  'migrate-aliases',
] as const;

export type PlannerActionType = (typeof PLANNER_ACTION_TYPES)[number];

/** 规划输入：前态/现态卡引用 + 现有别名 + 规则版本口径。 */
export interface PlanCardRef {
  readonly eventId: string;
  readonly cardId: string;
  readonly anchors: readonly string[];
  readonly channel: string;
  readonly startedMs: number;
  readonly endedMs: number;
}

export interface PlanAliasRef {
  readonly eventId: string;
  readonly cardId: string;
  readonly termNorm: string;
  readonly sensitive: 0 | 1;
  readonly hitCount: number;
  readonly lastHitMs: number | null;
}

export interface PlanInput {
  readonly previous: readonly PlanCardRef[];
  readonly current: readonly PlanCardRef[];
  readonly aliases: readonly PlanAliasRef[];
  /** 本批派生规则版本（决策行 model_tag 固化口径）。 */
  readonly rulesVersion: string;
  /** 投影上一次 stamp 的规则版本；null = 空白投影。 */
  readonly projectionRulesVersion: string | null;
}

/** 随迁移带走的别名条目（残差按 event_id 重绑，不重置）。 */
export interface MigratedAlias {
  readonly termNorm: string;
  readonly sensitive: 0 | 1;
  readonly hitCount: number;
  readonly lastHitMs: number | null;
}

export type PlanAction =
  | {
      readonly type: 'create-card';
      readonly eventId: string;
      readonly cardId: string;
      readonly anchors: readonly string[];
      readonly channel: string;
      readonly startedMs: number;
      readonly endedMs: number;
    }
  | {
      readonly type: 'update-card';
      readonly eventId: string;
      readonly cardId: string;
      readonly anchors: readonly string[];
      readonly channel: string;
      readonly startedMs: number;
      readonly endedMs: number;
    }
  | { readonly type: 'invalidate-card'; readonly eventId: string; readonly cardId: string }
  | {
      readonly type: 'migrate-aliases';
      readonly eventId: string;
      readonly fromCardId: string;
      readonly toCardId: string;
      readonly aliases: readonly MigratedAlias[];
    };

export interface PlanResult {
  readonly status: 'ok' | 'rebuild-required';
  readonly actions: readonly PlanAction[];
  /** 本轮需落 revision 账本的动作（空轮为 0，不追加账本行）。 */
  readonly revisionActions: readonly PlanAction[];
}

function sameShape(prev: PlanCardRef, cur: PlanCardRef): boolean {
  return (
    prev.channel === cur.channel &&
    prev.startedMs === cur.startedMs &&
    prev.endedMs === cur.endedMs &&
    prev.anchors.length === cur.anchors.length &&
    prev.anchors.every((anchor, index) => anchor === cur.anchors[index])
  );
}

/**
 * 前后态 diff → 动作清单。
 * R-18：投影规则版本与本批不符 → `rebuild-required`，动作全空、零写入。
 */
export function planProjection(input: PlanInput): PlanResult {
  // 空白投影（projectionRulesVersion === null）不视为版本冲突；已 stamp 的投影版本不符才重建。
  if (
    input.projectionRulesVersion !== null &&
    input.projectionRulesVersion !== input.rulesVersion
  ) {
    return { status: 'rebuild-required', actions: [], revisionActions: [] };
  }

  const prevByEvent = new Map<string, PlanCardRef>(input.previous.map((card) => [card.eventId, card]));
  const curByEvent = new Map<string, PlanCardRef>(input.current.map((card) => [card.eventId, card]));

  const actions: PlanAction[] = [];
  /** 锚点变化换卡：eventId → { fromCardId, toCardId }，供别名按 event_id 重绑。 */
  const replaced = new Map<string, { from: string; to: string }>();

  for (const cur of input.current) {
    const prev = prevByEvent.get(cur.eventId);
    if (prev === undefined) {
      actions.push({
        type: 'create-card',
        eventId: cur.eventId,
        cardId: cur.cardId,
        anchors: cur.anchors,
        channel: cur.channel,
        startedMs: cur.startedMs,
        endedMs: cur.endedMs,
      });
      continue;
    }

    if (prev.cardId !== cur.cardId) {
      // 锚点变化 → card_id 变：旧卡作废 + 新卡建立，别名随后按 event_id 迁移。
      actions.push({ type: 'invalidate-card', eventId: prev.eventId, cardId: prev.cardId });
      actions.push({
        type: 'create-card',
        eventId: cur.eventId,
        cardId: cur.cardId,
        anchors: cur.anchors,
        channel: cur.channel,
        startedMs: cur.startedMs,
        endedMs: cur.endedMs,
      });
      replaced.set(cur.eventId, { from: prev.cardId, to: cur.cardId });
    } else if (!sameShape(prev, cur)) {
      actions.push({
        type: 'update-card',
        eventId: cur.eventId,
        cardId: cur.cardId,
        anchors: cur.anchors,
        channel: cur.channel,
        startedMs: cur.startedMs,
        endedMs: cur.endedMs,
      });
    }
  }

  // 前态有、现态无：旧卡作废。
  for (const prev of input.previous) {
    if (!curByEvent.has(prev.eventId)) {
      actions.push({ type: 'invalidate-card', eventId: prev.eventId, cardId: prev.cardId });
    }
  }

  // R-06：同一 eventId 名下旧卡别名随迁移带到新卡，hitCount/lastHitMs 不重置。
  for (const [eventId, pair] of replaced) {
    const moved: MigratedAlias[] = input.aliases
      .filter((alias) => alias.eventId === eventId && alias.cardId === pair.from)
      .map((alias) => ({
        termNorm: alias.termNorm,
        sensitive: alias.sensitive,
        hitCount: alias.hitCount,
        lastHitMs: alias.lastHitMs,
      }));
    if (moved.length > 0) {
      actions.push({
        type: 'migrate-aliases',
        eventId,
        fromCardId: pair.from,
        toCardId: pair.to,
        aliases: moved,
      });
    }
  }

  return { status: 'ok', actions, revisionActions: actions };
}
