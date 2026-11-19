/**
 * #130 P2 采用账本行契约（投影内 append-only `adoptions.jsonl`，I10 重裁后的实时唯一写口凭据）。
 *
 * 她钻真源原文（第③跳 rawText 成功）即一次"采用"：本模块只承载该事件的最小客观凭据，
 * 行形状封闭为四字段——id/card_id/at_ms/content_hash——**没有任何查询词、原文片段或会话字段位**，
 * 类型层面即堵死隐私走私。
 *
 * 边界（与 observations.ts 同范式）：
 *  - 本模块为纯函数层：不碰 fs、不开 DB、不读墙钟；at_ms 由编排层注入；
 *  - id 非随机 ULID，而是内容键 `sha256(card_id|at_ms|content_hash)` 前 32 位切片，
 *    同键同 id、双跑逐行相等；折叠以此为幂等去重键，物理重试不倍增计数；
 *  - content_hash 是采用瞬间卡片四输入面内容摘要（MemoryCard.contentHash），
 *    只回答"她取的是哪一版记忆"，不承担失效判定；
 *  - 折叠结果只产出 hitCount（总次数，只增不减）与 lastHitMs（最大 at_ms），
 *    离散步进有效强度是读时排序器的事，本模块不做衰减、不删行；
 *  - 坏行抛 SchemaError，绝不静默跳过。
 */

import { SchemaError } from '../core/errors.ts';
import { sha256Hex } from './content-hash.ts';

/** 采用账本行（投影内 append-only 文件一行，snake_case 与既有账本口径一致）。 */
export interface AdoptionRecord {
  /** 内容键派生 id（sha256 切片，非随机；同键同 id 供幂等折叠）。 */
  readonly id: string;
  /** 被采用记忆的卡 id（mc_ 前缀）；锚点映不回 active 卡的事件在上游就不落行。 */
  readonly card_id: string;
  /** 采用时刻（ms，注入时钟；非负整数）。 */
  readonly at_ms: number;
  /** 采用瞬间卡片内容摘要快照（四输入面 contentHash，非结构哈希、非原文）。 */
  readonly content_hash: string;
}

/** 构造采用行的入参（camelCase 内存态；行落盘统一 snake_case）。 */
export interface AdoptionInput {
  readonly cardId: string;
  readonly atMs: number;
  readonly contentHash: string;
}

/** 折叠后单卡账本态：hitCount 恒等于去重后行数，lastHitMs 恒等于最大 at_ms。 */
export interface AdoptionFold {
  readonly hitCount: number;
  readonly lastHitMs: number;
}

/** 内容键分隔符；与 observations.ts 固定向量口径一致。 */
const ID_KEY_SEPARATOR = '|';

/**
 * 采用行 id：内容键 `(card_id, at_ms, content_hash)` 的 sha256 前 32 位切片。
 * 同键同 id、异键异 id；重放/重试产生的逐字同形行在折叠时自然幂等。
 */
export function adoptionId(cardId: string, atMs: number, contentHash: string): string {
  const key = [cardId, String(atMs), contentHash].join(ID_KEY_SEPARATOR);
  return sha256Hex(key).slice(0, 32);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function assertAdoptionInput(input: AdoptionInput): void {
  if (!isNonEmptyString(input.cardId)) {
    throw new SchemaError('采用行 cardId 必须是非空字符串');
  }
  if (!isNonEmptyString(input.contentHash)) {
    throw new SchemaError('采用行 contentHash 必须是非空字符串');
  }
  if (!Number.isInteger(input.atMs) || input.atMs < 0) {
    throw new SchemaError('采用行 atMs 必须是非负整数（注入时钟）');
  }
}

/**
 * 构造并自检一行采用记录（纯函数）：id 由内容键派生，调用方无需也无法自行指定 id。
 * 入参越界抛 SchemaError，不返回半成品。
 */
export function buildAdoptionRecord(input: AdoptionInput): AdoptionRecord {
  assertAdoptionInput(input);
  return {
    id: adoptionId(input.cardId, input.atMs, input.contentHash),
    card_id: input.cardId,
    at_ms: input.atMs,
    content_hash: input.contentHash,
  };
}

/**
 * 校验一行采用记录的形状；非法行抛 `SchemaError`，合法行原样返回。
 * 拒绝：非对象/数组、缺字段、空串 id/card_id/content_hash、at_ms 非非负整数。
 */
export function validateAdoption(row: unknown): AdoptionRecord {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new SchemaError('采用行必须是对象');
  }
  const record = row as Record<string, unknown>;
  if (!isNonEmptyString(record.id)) {
    throw new SchemaError('采用行 id 必须是非空字符串');
  }
  if (!isNonEmptyString(record.card_id)) {
    throw new SchemaError('采用行 card_id 必须是非空字符串');
  }
  if (!isNonEmptyString(record.content_hash)) {
    throw new SchemaError('采用行 content_hash 必须是非空字符串');
  }
  if (!Number.isInteger(record.at_ms) || (record.at_ms as number) < 0) {
    throw new SchemaError('采用行 at_ms 必须是非负整数');
  }
  return record as unknown as AdoptionRecord;
}

/**
 * 折叠采用账本：逐行校验后按卡聚合出去重总次数与最近采用时刻。
 *
 * 幂等：以行 id（内容键）去重，同键重复行首条有效、不倍增；这给物理追加的 at-least-once
 * 重试提供安全垫。结果与输入行序无关（计数/最大值皆交换律），从零重建逐字节可复现。
 * 坏行当场抛 SchemaError，绝不静默跳过造成账实不符。
 */
export function foldAdoptions(rows: readonly AdoptionRecord[]): Map<string, AdoptionFold> {
  const seenIds = new Set<string>();
  const folded = new Map<string, AdoptionFold>();

  for (const rawRow of rows) {
    const row = validateAdoption(rawRow);
    if (seenIds.has(row.id)) {
      continue;
    }
    seenIds.add(row.id);

    const prev = folded.get(row.card_id);
    if (prev === undefined) {
      folded.set(row.card_id, { hitCount: 1, lastHitMs: row.at_ms });
    } else {
      folded.set(row.card_id, {
        hitCount: prev.hitCount + 1,
        lastHitMs: Math.max(prev.lastHitMs, row.at_ms),
      });
    }
  }

  return folded;
}
