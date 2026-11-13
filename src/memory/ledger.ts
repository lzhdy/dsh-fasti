/**
 * 记忆层账本 —— revisions.jsonl / decisions.jsonl（方案 §3.4 / §3.5）。
 *
 * 纪律：
 *  - append-only：只追加、绝不改写历史行（前缀关系由测试自证）；
 *  - revisions 单调递增 1 起、prior_revision 相接；断链/跳号即 IntegrityError；
 *  - 坏行抛 CorruptedError（parseJsonl 严格解析，不静默跳过）；
 *  - 账本文件只落在 indexDir 内，构建器不借此触碰真源。
 */

import path from 'node:path';

import { IntegrityError } from '../core/errors.ts';
import { appendJsonl, readJsonlFile } from '../core/jsonl.ts';
import { isUlid } from '../core/ulid.ts';
import type { DecisionRecord, RevisionRecord } from './types.ts';

/** 迁移/构建账本文件名（方案 §3.1）。 */
export const REVISIONS_FILE = 'revisions.jsonl';
/** 决策台账文件名（方案 §3.1，D4 格式预对齐）。 */
export const DECISIONS_FILE = 'decisions.jsonl';

const REVISION_SLUGS: readonly string[] = ['schema-init', 'build', 'rebuild', 'stamp'];
const REVISION_OPERATORS: readonly string[] = ['offline-cli'];
const DECISION_ACTIONS: readonly string[] = [
  'create-card',
  'update-cues',
  'tombstone-card',
  'add-alias',
  'invalidate',
];
const DECISION_CREATORS: readonly string[] = ['her'];

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assertRevisionShape(record: RevisionRecord): void {
  const at = `revisions 行 ${record.revision}`;
  if (!Number.isInteger(record.revision) || record.revision < 1) {
    throw new IntegrityError(`${at}：revision 必须是 >=1 的整数`);
  }
  if (!REVISION_SLUGS.includes(record.slug)) {
    throw new IntegrityError(`${at}：slug 越界（${record.slug}）`);
  }
  if (!REVISION_OPERATORS.includes(record.operator)) {
    throw new IntegrityError(`${at}：operator 越界（${record.operator}）`);
  }
  if (typeof record.at_ms !== 'number' || !Number.isFinite(record.at_ms) || record.at_ms < 0) {
    throw new IntegrityError(`${at}：at_ms 必须是非负有限数`);
  }
  if (!Number.isInteger(record.schema_version) || record.schema_version < 1) {
    throw new IntegrityError(`${at}：schema_version 必须是 >=1 的整数`);
  }
  if (typeof record.truth_fingerprint !== 'string' || record.truth_fingerprint === '') {
    throw new IntegrityError(`${at}：truth_fingerprint 必须是非空字符串`);
  }
  if (record.prior_revision !== null && (!Number.isInteger(record.prior_revision) || record.prior_revision < 1)) {
    throw new IntegrityError(`${at}：prior_revision 必须是 null 或 >=1 的整数`);
  }
  if (!isNonNegativeInteger(record.card_count) || !isNonNegativeInteger(record.alias_count)) {
    throw new IntegrityError(`${at}：card_count / alias_count 必须是非负整数`);
  }
  if (typeof record.row_hash_sum !== 'string') {
    throw new IntegrityError(`${at}：row_hash_sum 必须是字符串`);
  }
  const diff = record.shadow_diff;
  if (
    diff === null ||
    typeof diff !== 'object' ||
    !isNonNegativeInteger(diff.added) ||
    !isNonNegativeInteger(diff.removed) ||
    !isNonNegativeInteger(diff.changed)
  ) {
    throw new IntegrityError(`${at}：shadow_diff 必须含非负整数 added/removed/changed`);
  }
  if (typeof record.reason !== 'string') {
    throw new IntegrityError(`${at}：reason 必须是字符串`);
  }
}

/** 链校验：首行 revision=1/prior=null；后续 revision=前行+1、prior=前行 revision。 */
export function validateRevisionChain(
  existing: readonly RevisionRecord[],
  next: RevisionRecord,
): void {
  assertRevisionShape(next);
  const last = existing[existing.length - 1];
  if (last === undefined) {
    if (next.revision !== 1 || next.prior_revision !== null) {
      throw new IntegrityError('revisions 首行必须 revision=1 且 prior_revision=null');
    }
    return;
  }
  if (next.revision !== last.revision + 1) {
    throw new IntegrityError(
      `revisions 跳号：已有 ${last.revision}，下一行必须是 ${last.revision + 1}（收到 ${next.revision}）`,
    );
  }
  if (next.prior_revision !== last.revision) {
    throw new IntegrityError(
      `revisions 断链：prior_revision 必须是 ${last.revision}（收到 ${String(next.prior_revision)}）`,
    );
  }
}

function assertDecisionShape(record: DecisionRecord): void {
  const at = `decisions 行 ${record.decision_id}`;
  if (!isUlid(record.decision_id)) {
    throw new IntegrityError(`${at}：decision_id 必须是 ULID`);
  }
  if (typeof record.at_ms !== 'number' || !Number.isFinite(record.at_ms) || record.at_ms < 0) {
    throw new IntegrityError(`${at}：at_ms 必须是非负有限数`);
  }
  if (!DECISION_ACTIONS.includes(record.action)) {
    throw new IntegrityError(`${at}：action 越界（${record.action}）`);
  }
  if (record.card_id !== null && typeof record.card_id !== 'string') {
    throw new IntegrityError(`${at}：card_id 必须是字符串或 null`);
  }
  for (const key of ['event_id', 'anchor_json', 'content_hash', 'model_tag', 'reason'] as const) {
    if (typeof record[key] !== 'string') {
      throw new IntegrityError(`${at}：${key} 必须是字符串`);
    }
  }
  if (!DECISION_CREATORS.includes(record.created_by)) {
    throw new IntegrityError(`${at}：created_by 越界（${record.created_by}）`);
  }
}

/** 读 revisions（严格解析 + 形状/链校验；缺文件返回 []，不创建文件）。 */
export function readRevisions(indexDir: string): RevisionRecord[] {
  const rows = readJsonlFile<RevisionRecord>(path.join(indexDir, REVISIONS_FILE));
  const chain: RevisionRecord[] = [];
  for (const row of rows) {
    validateRevisionChain(chain, row);
    chain.push(row);
  }
  return rows;
}

/** 读 decisions（严格解析 + 形状校验；缺文件返回 []，不创建文件）。 */
export function readDecisions(indexDir: string): DecisionRecord[] {
  const rows = readJsonlFile<DecisionRecord>(path.join(indexDir, DECISIONS_FILE));
  for (const row of rows) {
    assertDecisionShape(row);
  }
  return rows;
}

/** 追加一行 revision（先验链再追加；append-only，绝不改写历史）。 */
export function appendRevision(indexDir: string, record: RevisionRecord): void {
  validateRevisionChain(readRevisions(indexDir), record);
  appendJsonl(path.join(indexDir, REVISIONS_FILE), record);
}

/** 追加一行 decision（形状校验后追加；append-only）。 */
export function appendDecision(indexDir: string, record: DecisionRecord): void {
  assertDecisionShape(record);
  appendJsonl(path.join(indexDir, DECISIONS_FILE), record);
}