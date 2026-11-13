/**
 * 漏召回填别名窄写（#44，提案 §5.5；闭合 D5 INSERT-or-guard、D6 同源快照、D7 上限、D8/N1/N5 无环）。
 *
 * 无环纪律（终审修法 a）：本模块只 import node:sqlite 类型、core/errors 与两个无环共享低层
 * content-hash.ts / fts.ts 以及纯类型 types.ts，**不 import store、builder、bm25**（及任何传递到达
 * store 的模块）。store 写柄单向 import 本模块。tests/memory/layer-imports.test.ts 静态断言该约束。
 *
 * N5 规范化归属：与 miss.ts 同款“只收已规范化入参”——本模块不自行 normalize、不 import bm25，
 * termNorm 由 store 写柄薄封装在委托前经 bm25.normalizeQuery 完成（store→bm25 为既有合法方向）。
 *
 * 写面严格收窄：单事务内仅 ①专用 INSERT mem_alias（非整行 upsert）②UPDATE mem_card 且赋值位只出现
 * aliases_json、content_hash 两列 ③调共享 fts.syncFts；不碰任何其它列，不重置统计、不降级 sensitive。
 * 库柄由调用方传入，本模块不自开连接、不直接写 revisions/decisions 账本（账本由写柄提交后追加）。
 */

import type { DatabaseSync } from 'node:sqlite';

import { IntegrityError } from '../core/errors.ts';
import { computeContentHash } from './content-hash.ts';
import { aliasFromRow, syncFts } from './fts.ts';
import type { AliasRow, MemoryCard } from './types.ts';

/**
 * 每卡 miss 别名上限（结构工程护栏，非统计观测值；不进 DB CHECK，schema 不动）。
 * 防别名表与 FTS 无界膨胀、防单卡线索污染；后续随真实使用经评审调整。
 */
export const MAX_MISS_ALIASES_PER_CARD = 5;

/** 业务可观测的拒绝原因码（受控，不携带原始查询文本）。 */
export type MissAliasRejectReason =
  | 'card-not-found'
  | 'card-not-active'
  | 'empty-term'
  | 'bad-sensitive'
  | 'alias-cap-exceeded';

/** 低层入参：termNorm 已由写柄规范化（N5）；时钟 createdMs 注入，函数内无 Date.now()。 */
export interface BuildMissAliasInput {
  termNorm: string;
  cardId: string;
  sensitive: 0 | 1;
  createdMs: number;
}

/**
 * 窄写所需的最小卡片视图（结构化子集：完整 MemoryCard 天然满足，可直接传入）。
 * 只读这 5 个字段，避免为取标量而 import store 的完整行映射 cardFromRow（保无环），
 * 也确保窄写逻辑只看得见它被允许触碰/读取的列。
 */
export interface MissAliasCardView {
  cardId: string;
  status: MemoryCard['status'];
  anchorJson: string;
  displayCuesJson: string;
  aliasesJson: string;
  discriminator: string;
}

/** 从 mem_card 行取窄写视图（snake_case → camelCase，仅 5 列，口径与 store.cardFromRow 一致）。 */
function rowToCardView(raw: Record<string, unknown>): MissAliasCardView {
  return {
    cardId: String(raw['card_id']),
    status: String(raw['status']) as MemoryCard['status'],
    anchorJson: String(raw['anchor_json']),
    displayCuesJson: String(raw['display_cues_json']),
    aliasesJson: String(raw['aliases_json']),
    discriminator: String(raw['discriminator']),
  };
}

/** 卡内 aliasesJson 元素形状（与既有种子/迁移口径逐字一致：term/source/sensitive 三键）。 */
export interface CardAliasObject {
  term: string;
  source: 'miss';
  sensitive: 0 | 1;
}

/** 待执行的窄写计划：mem_alias 新行 + 待并入卡 JSON 的同源对象。 */
export interface MissAliasPlan {
  alias: AliasRow;
  cardAliasObject: CardAliasObject;
}

export type BuildMissAliasResult =
  | { ok: true; changed: false; reason: 'already-active' }
  | { ok: true; changed: true; plan: MissAliasPlan }
  | { ok: false; reason: MissAliasRejectReason };

export type ApplyMissAliasOutcome =
  | { ok: true; changed: false; reason: 'already-active'; cardId: string; termNorm: string }
  | {
      ok: true;
      changed: true;
      cardId: string;
      termNorm: string;
      aliasesJson: string;
      contentHash: string;
    }
  | { ok: false; reason: MissAliasRejectReason; cardId: string; termNorm: string };

const INSERT_ALIAS_SQL = `INSERT INTO mem_alias(term_norm, card_id, source, sensitive, status, created_ms, hit_count, last_hit_ms)
  VALUES (?, ?, 'miss', ?, 'active', ?, 0, NULL)`;

const UPDATE_CARD_TWO_COLUMNS_SQL =
  'UPDATE mem_card SET aliases_json = ?, content_hash = ? WHERE card_id = ?';

/** 确定性序：term 码点升序，次按 source、sensitive 兜底（与 builder 字典比较同款，零 locale 依赖）。 */
function compareCardAlias(a: CardAliasObject, b: CardAliasObject): number {
  if (a.term !== b.term) {
    return a.term < b.term ? -1 : 1;
  }
  if (a.source !== b.source) {
    return a.source < b.source ? -1 : 1;
  }
  return a.sensitive - b.sensitive;
}

/** 并入新别名对象后确定性排序并序列化（纯函数）；重复 term 由调用方先以幂等判定排除。 */
export function mergeAndSerializeAliases(
  currentAliasesJson: string,
  added: CardAliasObject,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(currentAliasesJson);
  } catch {
    throw new IntegrityError('mem_card.aliases_json 损坏，无法安全合入别名');
  }
  if (!Array.isArray(parsed) || parsed.some((item) => item === null || typeof item !== 'object')) {
    throw new IntegrityError('mem_card.aliases_json 必须是别名对象数组');
  }
  const objects = parsed as CardAliasObject[];
  const merged = [...objects, added];
  merged.sort(compareCardAlias);
  return JSON.stringify(merged);
}

function assertFiniteMs(createdMs: number): void {
  if (!Number.isInteger(createdMs) || createdMs < 0) {
    throw new IntegrityError('别名 createdMs 必须是非负整数');
  }
}

/**
 * 纯校验/构造（应用层友好错误，不触库）：目标卡存在且 active、termNorm 非空、sensitive 显式 0|1、
 * 名额只数 active（tombstone 不占额）、重复 active 词幂等跳过。权威强制在 applyMissAlias 内再做一遍。
 */
export function buildMissAlias(
  input: BuildMissAliasInput,
  card: MissAliasCardView | null,
  activeAliases: readonly AliasRow[],
): BuildMissAliasResult {
  if (card === null) {
    return { ok: false, reason: 'card-not-found' };
  }
  if (card.status !== 'active') {
    return { ok: false, reason: 'card-not-active' };
  }
  if (typeof input.termNorm !== 'string' || input.termNorm.length === 0) {
    return { ok: false, reason: 'empty-term' };
  }
  if (input.sensitive !== 0 && input.sensitive !== 1) {
    return { ok: false, reason: 'bad-sensitive' };
  }
  assertFiniteMs(input.createdMs);

  if (activeAliases.some((alias) => alias.termNorm === input.termNorm)) {
    return { ok: true, changed: false, reason: 'already-active' };
  }
  if (activeAliases.length >= MAX_MISS_ALIASES_PER_CARD) {
    return { ok: false, reason: 'alias-cap-exceeded' };
  }

  const alias: AliasRow = {
    termNorm: input.termNorm,
    cardId: input.cardId,
    source: 'miss',
    sensitive: input.sensitive,
    status: 'active',
    createdMs: input.createdMs,
    hitCount: 0,
    lastHitMs: null,
  };
  return {
    ok: true,
    changed: true,
    plan: { alias, cardAliasObject: { term: input.termNorm, source: 'miss', sensitive: input.sensitive } },
  };
}

/**
 * 权威窄写事务（收库柄、不自开连接）。INSERT-or-guard + 仅两列 UPDATE + syncFts 同一事务，
 * 失败回滚零半状态；幂等/拒绝路径不开事务、零 churn。
 */
export function applyMissAlias(db: DatabaseSync, input: BuildMissAliasInput): ApplyMissAliasOutcome {
  const cardRow = db.prepare('SELECT * FROM mem_card WHERE card_id = ?').get(input.cardId) as
    | Record<string, unknown>
    | undefined;
  const card = cardRow === undefined ? null : rowToCardView(cardRow);

  const allAliases = (
    db.prepare('SELECT * FROM mem_alias WHERE card_id = ?').all(input.cardId) as Array<Record<string, unknown>>
  ).map(aliasFromRow);

  // v1 不存在别名级 tombstone 写入路径；同主键却非 active 属未定义不变量，fail-loud，绝不静默复活。
  const sameKeyInactive = allAliases.find(
    (alias) => alias.termNorm === input.termNorm && alias.status !== 'active',
  );
  if (sameKeyInactive !== undefined) {
    throw new IntegrityError(`别名已存在但非 active（不自动复活）：${input.cardId}/${input.termNorm}`);
  }

  const activeAliases = allAliases.filter((alias) => alias.status === 'active');
  const decision = buildMissAlias(input, card, activeAliases);

  if (!decision.ok) {
    return { ok: false, reason: decision.reason, cardId: input.cardId, termNorm: input.termNorm };
  }
  if (!decision.changed) {
    return { ok: true, changed: false, reason: 'already-active', cardId: input.cardId, termNorm: input.termNorm };
  }

  const existingCard = card as MissAliasCardView;
  const newAliasesJson = mergeAndSerializeAliases(
    existingCard.aliasesJson,
    decision.plan.cardAliasObject,
  );
  const newContentHash = computeContentHash(
    existingCard.anchorJson,
    existingCard.displayCuesJson,
    newAliasesJson,
    existingCard.discriminator,
  );

  db.exec('BEGIN');
  try {
    db.prepare(INSERT_ALIAS_SQL).run(
      decision.plan.alias.termNorm,
      decision.plan.alias.cardId,
      decision.plan.alias.sensitive,
      decision.plan.alias.createdMs,
    );
    db.prepare(UPDATE_CARD_TWO_COLUMNS_SQL).run(newAliasesJson, newContentHash, input.cardId);
    syncFts(db, [input.cardId]);
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
    changed: true,
    cardId: input.cardId,
    termNorm: input.termNorm,
    aliasesJson: newAliasesJson,
    contentHash: newContentHash,
  };
}
