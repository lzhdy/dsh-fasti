/**
 * #130 P2 采用计数窄写事务（I10 重裁后实时采用回写的唯一 DB 写面）。
 *
 * 无环纪律（与 alias-write.ts 同款）：本模块只 import node:sqlite 类型、core/errors 与 types 纯类型，
 * **不 import store、builder、bm25、ledger 及任何传递到达 store 的模块**；store 写柄单向 import 本模块。
 * tests/memory/layer-imports.test.ts 对该约束做静态断言与投毒自证。
 *
 * 写面严格收窄：单 BEGIN IMMEDIATE 事务内仅一条 UPDATE mem_card，赋值位只出现 hit_count、last_hit_ms
 * 两列（hit_count 行内 +1、last_hit_ms 置本次注入时刻）；不整行 upsert、不重置 weight/content_hash/
 * sensitive 等任何其它列、不 sync FTS（两列不在 FTS 面）、不碰 mem_alias、不直接写账本 jsonl
 * （账本由 store 写柄在事务提交成功后追加，同生共死口径见批4 recordAnchorAdoption）。
 * 库柄由调用方传入，本模块不自开连接。
 *
 * 守卫：active 卡身份在事务内权威再核验（上游锚点映射不作数），缺卡/非 active 结构化拒绝零 churn；
 * atMs 必须是非负整数，非法输入 fail-loud 抛 IntegrityError。
 */

import type { DatabaseSync } from 'node:sqlite';

import { IntegrityError } from '../core/errors.ts';

/** 结构化拒绝原因码（受控，不携带查询词/原文）。 */
export type AdoptionWriteRejectReason = 'card-not-found' | 'card-not-active';

/** 低层入参：atMs 为编排层注入时钟，函数内无 Date.now()。 */
export interface RecordAdoptionInput {
  readonly cardId: string;
  readonly atMs: number;
}

/** 窄写所需的最小卡片视图：只读计数/状态/内容摘要，避免 import store 的完整行映射（保无环）。 */
interface AdoptionCardView {
  readonly cardId: string;
  readonly status: string;
  readonly hitCount: number;
  readonly contentHash: string;
}

export type RecordAdoptionOutcome =
  | {
      readonly ok: true;
      readonly applied: true;
      readonly cardId: string;
      readonly atMs: number;
      /** 提交后新计数值（旧值 +1），供写柄派生账本行与回信封，禁止调用方自行猜算。 */
      readonly hitCount: number;
      readonly lastHitMs: number;
      /** 采用瞬间卡面内容摘要，账本 content_hash 字段以此为准。 */
      readonly contentHash: string;
    }
  | {
      readonly ok: false;
      readonly reason: AdoptionWriteRejectReason;
      readonly cardId: string;
    };

/** 仅两列出现在赋值位的窄 UPDATE（SQL 文本本身即评审对象，禁止扩列）。 */
const INCREMENT_ADOPTION_SQL = `
  UPDATE mem_card
     SET hit_count = hit_count + 1,
         last_hit_ms = ?
   WHERE card_id = ?`;

function rowToCardView(raw: Record<string, unknown>): AdoptionCardView {
  return {
    cardId: String(raw['card_id']),
    status: String(raw['status']),
    hitCount: Number(raw['hit_count']),
    contentHash: String(raw['content_hash']),
  };
}

function assertFiniteMs(atMs: number): void {
  if (!Number.isInteger(atMs) || atMs < 0) {
    throw new IntegrityError('采用 atMs 必须是非负整数（注入时钟）');
  }
}

/**
 * 权威窄写事务（收库柄、不自开连接）。active 守卫与仅两列 UPDATE 同一事务，
 * 失败回滚零半状态；拒绝路径不开事务、零 churn。
 */
export function applyAdoption(db: DatabaseSync, input: RecordAdoptionInput): RecordAdoptionOutcome {
  assertFiniteMs(input.atMs);

  const cardRow = db.prepare('SELECT * FROM mem_card WHERE card_id = ?').get(input.cardId) as
    | Record<string, unknown>
    | undefined;
  if (cardRow === undefined) {
    return { ok: false, reason: 'card-not-found', cardId: input.cardId };
  }
  const card = rowToCardView(cardRow);
  if (card.status !== 'active') {
    return { ok: false, reason: 'card-not-active', cardId: input.cardId };
  }
  if (!Number.isInteger(card.hitCount) || card.hitCount < 0) {
    throw new IntegrityError(`mem_card.hit_count 现状非法，拒绝窄写：${input.cardId}`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(INCREMENT_ADOPTION_SQL).run(input.atMs, input.cardId);
    if (result.changes !== 1) {
      // 单主键 UPDATE 必命中恰好一行；其它结果说明不变量被破坏，fail-loud 而非静默成功。
      throw new IntegrityError(`采用窄写预期改动 1 行，实际 ${String(result.changes)} 行：${input.cardId}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败不掩盖原始错误。
    }
    throw error;
  }

  return {
    ok: true,
    applied: true,
    cardId: input.cardId,
    atMs: input.atMs,
    hitCount: card.hitCount + 1,
    lastHitMs: input.atMs,
    contentHash: card.contentHash,
  };
}
