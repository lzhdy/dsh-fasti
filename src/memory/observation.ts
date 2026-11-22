/**
 * 记忆卡人类观测视图（#157 网页控制台）。
 *
 * 与装配层 `projectCardForHost`（N14，给模型看的最小白名单）刻意分开：
 * 本视图面向**她本人**在本机 loopback 观测台阅读，保留卡主表全字段与锚点/线索，
 * 但隐私红线不退——`sensitive=1` 的别名原文（termNorm）一律脱敏为 null，
 * 只保留其状态与计数；本模块零 SQL、零 IO，是可单测的纯映射。
 */

import type { AliasRow, MemoryCard } from './types.ts';

/** 别名观测项：敏感词的 termNorm 恒为 null。 */
export interface ObservationAliasView {
  /** 非敏感别名为规范化词；敏感别名恒 null（原文不离开索引层）。 */
  readonly termNorm: string | null;
  readonly source: 'miss';
  readonly sensitive: boolean;
  readonly status: 'active' | 'tombstoned';
  readonly hitCount: number;
}

/** 卡片观测视图：主表全字段（JSON 列解析为结构化值），零正文纪律不变。 */
export interface ObservationCardView {
  readonly cardId: string;
  readonly eventId: string;
  /** 权威锚点：解析后的真源经历 id 列表。 */
  readonly anchorIds: string[];
  readonly channel: string;
  readonly cardType: MemoryCard['cardType'];
  readonly selection: MemoryCard['selection'];
  readonly weight: number;
  readonly displayCues: string[];
  readonly aliases: ObservationAliasView[];
  readonly discriminator: string;
  readonly occurredMs: number;
  readonly endedMs: number;
  readonly validMs: number;
  readonly invalidMs: number | null;
  readonly createdMs: number;
  readonly expiredMs: number | null;
  readonly status: MemoryCard['status'];
  readonly contentHash: string;
  readonly hitCount: number;
  readonly lastHitMs: number | null;
  readonly schemaVersion: number;
}

/** 记忆索引观测聚合计数。 */
export interface MemoryObservationCounts {
  readonly cards: number;
  readonly activeCards: number;
  readonly invalidCards: number;
  readonly supersededCards: number;
  readonly aliases: number;
  readonly sensitiveAliases: number;
  readonly misses: number;
}

/** 安全解析 JSON 字符串数组；损坏数据返回空数组而非抛错（观测页不能被坏行整页拖崩）。 */
function toStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/**
 * 把内部 MemoryCard 行＋权威别名行投影为观测视图。
 *
 * 别名以 mem_alias 表行（第二参数）为准；未提供时退回卡内 aliasesJson 快照，
 * 快照没有 status/hitCount，按 active/0 显式标注，绝不臆造其它值。
 */
export function toObservationCardView(
  card: MemoryCard,
  aliasRows?: readonly AliasRow[],
): ObservationCardView {
  const aliases: ObservationAliasView[] =
    aliasRows === undefined
      ? parseSnapshotAliases(card.aliasesJson)
      : aliasRows.map((row) => ({
          termNorm: row.sensitive === 1 ? null : row.termNorm,
          source: row.source,
          sensitive: row.sensitive === 1,
          status: row.status,
          hitCount: row.hitCount,
        }));

  return {
    cardId: card.cardId,
    eventId: card.eventId,
    anchorIds: toStringArray(card.anchorJson),
    channel: card.channel,
    cardType: card.cardType,
    selection: card.selection,
    weight: card.weight,
    displayCues: toStringArray(card.displayCuesJson),
    aliases,
    discriminator: card.discriminator,
    occurredMs: card.occurredMs,
    endedMs: card.endedMs,
    validMs: card.validMs,
    invalidMs: card.invalidMs,
    createdMs: card.createdMs,
    expiredMs: card.expiredMs,
    status: card.status,
    contentHash: card.contentHash,
    hitCount: card.hitCount,
    lastHitMs: card.lastHitMs,
    schemaVersion: card.schemaVersion,
  };
}

/** 卡内别名快照解析（无表行时的兜底路径，敏感词同样脱敏）。 */
function parseSnapshotAliases(json: string): ObservationAliasView[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry): ObservationAliasView[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const term = typeof record['term'] === 'string' ? record['term'] : '';
    const sensitive = record['sensitive'] === 1;
    return [
      {
        termNorm: sensitive ? null : term,
        source: 'miss',
        sensitive,
        status: 'active',
        hitCount: 0,
      },
    ];
  });
}
