/**
 * 记忆层漏召观测写入 —— 方案 §4.9（裁决 H1/H2/H11，记录见 §11.7）。
 *
 * 纪律：
 *  - 只导出纯函数/校验与接收库柄的 insertMissRow，**不自开连接**（唯一持库柄在 store）；
 *  - store→miss 单向 import：本模块只依赖 core/errors、core/ulid、types，不反引 store；
 *  - 模块顶层仅字面量常量、零求值（不触发循环初始化）；
 *  - 运行时严格白名单：六字段外的键当场拒绝，原始查询全文永不落盘（M11）；
 *  - term_hash 函数内部计算（sha256 hex）、id=ulid()、append-only 不去重（§6.5③）。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { IntegrityError } from '../core/errors.ts';
import { ulid } from '../core/ulid.ts';
import type { MissObservationInput } from './types.ts';

/** 入参白名单六字段（方案 §4.9；运行时键集超出即拒）。 */
const MISS_INPUT_KEYS: readonly string[] = [
  'termNorm',
  'channel',
  'anchorEventId',
  'anchorIds',
  'returnedCount',
  'observedMs',
];

const INSERT_MISS_SQL =
  'INSERT INTO mem_miss(id, term_norm, term_hash, channel, anchor_event_id, anchor_json, returned_count, observed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

/** term_hash = sha256(termNorm) 的 hex（全仓统一哈希口径，H11）。 */
export function computeMissTermHash(termNorm: string): string {
  return createHash('sha256').update(termNorm).digest('hex');
}

/**
 * 运行时严格白名单 + 字段校验（纯函数，H11）。
 *
 * Object.keys 出现六字段外的键（如 rawQuery/text）即抛 IntegrityError；
 * insertMissRow 内部复用本函数，dry-run 回放亦复用 —— 单一口径，不得两套。
 */
export function validateMissInput(input: MissObservationInput): void {
  if (input === null || typeof input !== 'object') {
    throw new IntegrityError('漏召观测入参必须是对象');
  }
  for (const key of Object.keys(input)) {
    if (!MISS_INPUT_KEYS.includes(key)) {
      throw new IntegrityError(`漏召观测入参含白名单外键：${key}（原始查询文本永不落盘）`);
    }
  }
  if (typeof input.termNorm !== 'string' || input.termNorm.length === 0) {
    throw new IntegrityError('漏召观测 termNorm 必须是非空字符串');
  }
  if (typeof input.channel !== 'string' || input.channel.length === 0) {
    throw new IntegrityError('漏召观测 channel 必须是非空字符串');
  }
  if (input.anchorEventId !== null && typeof input.anchorEventId !== 'string') {
    throw new IntegrityError('漏召观测 anchorEventId 必须是 string|null');
  }
  if (
    input.anchorIds !== null &&
    (!Array.isArray(input.anchorIds) || input.anchorIds.some((id) => typeof id !== 'string'))
  ) {
    throw new IntegrityError('漏召观测 anchorIds 必须是 readonly string[]|null');
  }
  if (!Number.isInteger(input.returnedCount) || input.returnedCount < 0) {
    throw new IntegrityError('漏召观测 returnedCount 必须是非负整数');
  }
  if (
    typeof input.observedMs !== 'number' ||
    !Number.isFinite(input.observedMs) ||
    input.observedMs < 0
  ) {
    throw new IntegrityError('漏召观测 observedMs 必须是非负有限数');
  }
}

/**
 * 低层写入（H1）：接收调用方库柄，校验后追加一行 mem_miss，返回新行 id。
 *
 * 每行新 ulid、append-only、不去重 —— 同输入重放行数倍增而 term_hash 集合一致（§6.5③）。
 * 写柄 recordMiss 委托本函数；命名刻意区别于类方法，避免同名遮蔽自递归。
 */
export function insertMissRow(db: DatabaseSync, input: MissObservationInput): string {
  validateMissInput(input);
  const id = ulid();
  const anchorJson = input.anchorIds === null ? null : JSON.stringify(input.anchorIds);
  db.prepare(INSERT_MISS_SQL).run(
    id,
    input.termNorm,
    computeMissTermHash(input.termNorm),
    input.channel,
    input.anchorEventId,
    anchorJson,
    input.returnedCount,
    input.observedMs,
  );
  return id;
}