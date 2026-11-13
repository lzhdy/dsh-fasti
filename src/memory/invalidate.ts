/**
 * 记忆层失效纯函数 —— 方案 §3.3（冻结接口，照图施工；裁决 G7–G11、G13）。
 *
 * 纪律：
 *  - 无 LLM、无 I/O：只计算结果，写库由构建器离线统一执行并写 decisions.jsonl；
 *  - 不自动迁卡：eventChange 只给 successor 提示，等下次离线种子流程人工确认；
 *  - edge.invalid_ms 本期恒 NULL，本模块没有任何代码路径写它；
 *  - duplicate-selection 本期不在纯函数内判定（G8 采 B，恒不触发该 reason）：
 *    由 builder 确定性幂等（deriveCardId）保证同 anchor 集合不产生第二张 selected 卡。
 *
 * 优先级（G11）：manual-tombstone > anchor-superseded > alias-conflict。
 * alias-conflict 前置条件（G10）：aliasTable 由调用方保证只含 active 别名；
 * 函数内仍按 status='active' 保守复核，「discriminator 无法区分」本期按恒成立处理。
 */

import type { AliasRow, MemoryCard } from './types.ts';

export type InvalidationReason =
  | 'anchor-superseded'
  | 'duplicate-selection'
  | 'alias-conflict'
  | 'manual-tombstone';

export interface InvalidationInput {
  card: MemoryCard;
  atMs: number;
  eventChange?: { kind: 'merged' | 'split' | 'reopened'; successorEventIds: string[] };
  aliasTable: readonly AliasRow[];
}

export interface InvalidationResult {
  status: 'active' | 'invalid' | 'superseded';
  invalidMs: number | null;
  reason: InvalidationReason | null;
  /** 仅给事件 id 提示，不自动迁卡。 */
  successorCardHints: string[];
}

/**
 * 规则表驱动失效判定（§3.3）。
 *
 * - manual-tombstone：card.expiredMs 非空即判，invalidMs 取 expiredMs（不取 atMs，G9）；
 * - anchor-superseded：merged/split/reopened 同判（G7），invalidMs=atMs；
 * - alias-conflict：aliasTable 存在 active、同 termNorm（取自卡内别名集）、不同 cardId
 *   的行即冲突（G10 保守判据），invalidMs=atMs；
 * - successorCardHints 仅在 eventChange 场景原样输出 successorEventIds（G11）。
 */
export function evaluateInvalidation(input: InvalidationInput): InvalidationResult {
  const { card, atMs, eventChange, aliasTable } = input;
  const hints = eventChange === undefined ? [] : [...eventChange.successorEventIds];

  if (card.expiredMs !== null) {
    return {
      status: 'invalid',
      invalidMs: card.expiredMs,
      reason: 'manual-tombstone',
      successorCardHints: hints,
    };
  }

  if (eventChange !== undefined) {
    return {
      status: 'superseded',
      invalidMs: atMs,
      reason: 'anchor-superseded',
      successorCardHints: hints,
    };
  }

  const terms = new Set(
    (JSON.parse(card.aliasesJson) as Array<{ term: string }>).map((alias) => alias.term),
  );
  const conflict = aliasTable.some(
    (row) => row.status === 'active' && row.cardId !== card.cardId && terms.has(row.termNorm),
  );
  if (conflict) {
    return {
      status: 'invalid',
      invalidMs: atMs,
      reason: 'alias-conflict',
      successorCardHints: hints,
    };
  }

  return { status: 'active', invalidMs: null, reason: null, successorCardHints: [] };
}

/**
 * as-of 谓词（G13）：与 store.listEffective 的 SQL 谓词同构 ——
 * `valid_ms <= T AND (invalid_ms IS NULL OR invalid_ms > T) AND created_ms <= T`。
 * 检索候选过滤直接复用本函数，禁止另写可能漂移的判定。
 */
export function isEffectiveAt(card: MemoryCard, atMs: number): boolean {
  return (
    card.validMs <= atMs &&
    (card.invalidMs === null || card.invalidMs > atMs) &&
    card.createdMs <= atMs
  );
}