/**
 * 观测行契约（#42 正本 §3.3 / §3.5）：`drain-observations.jsonl` 行形状、受控码表、
 * 内容键派生 id、三元组幂等合并。
 *
 * 边界：
 *  - 文件落点在投影目录内（与 memory-index 同级口径）；append-only，永不进 decisions 台账、
 *    永不进真源、不新增表；可整体删除后由 foldCurrentEvents＋确定性校验重放重建；
 *  - 本模块为纯函数层：不碰 fs、不开 DB、不读墙钟；at_ms 由编排层取事件版本 ULID 时间注入；
 *  - id 非随机 ULID，而是内容键 `sha256(event_id|version_token|reason_code)` 切片（§3.5）；
 *    versionToken = `${event_id}#v${version}` 版本身份复合键（EventRecord 无逐版本 ULID）。
 */

import { SchemaError } from '../core/errors.ts';
import { sha256Hex } from './content-hash.ts';

/** 受控 reason_code 码表（§3.3 五条；其余码值一律拒绝）。 */
export const OBSERVATION_REASON_CODES = [
  'anchor-form-invalid',
  'anchor-not-found',
  'empty-anchors',
  'judgment-unapplicable',
  'drain-permanent-tx',
] as const;

/** 受控 reason_code 字面量联合。 */
export type ObservationReasonCode = (typeof OBSERVATION_REASON_CODES)[number];

/** 观测行（投影内 append-only 文件一行）。 */
export interface DrainObservation {
  /** 内容键派生 id（sha256 切片，非随机）。 */
  readonly id: string;
  readonly event_id: string;
  readonly version_token: string;
  readonly reason_code: ObservationReasonCode;
  /** 该版本全派生输入快照，隔离可重算的凭据。 */
  readonly snapshot_hash: string;
  /** 取事件版本 ULID 时间，非墙钟。 */
  readonly at_ms: number;
}

/** 内容键分隔符；与 §3.5 固定向量口径一致。 */
const ID_KEY_SEPARATOR = '|';

/**
 * 观测行 id：内容键 `(event_id, version_token, reason_code)` 的 sha256 前 32 位切片。
 * 同键同 id、异键异 id；双跑逐行相等（幂等去重键即此 id）。
 */
export function observationId(eventId: string, versionToken: string, reasonCode: string): string {
  const key = [eventId, versionToken, reasonCode].join(ID_KEY_SEPARATOR);
  return sha256Hex(key).slice(0, 32);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 校验一行观测记录的形状与码表；非法行抛 `SchemaError`，合法行原样返回。
 *
 * 拒绝：缺字段 / 空串事件 id / 空串快照哈希 / 未知 reason_code / version_token 非字符串 /
 * at_ms 非有限数。不裁剪未知字段之外的内容（行原样回传）。
 */
export function validateObservation(row: unknown): DrainObservation {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new SchemaError('观测行必须是对象');
  }
  const record = row as Record<string, unknown>;

  if (!isNonEmptyString(record.id)) {
    throw new SchemaError('观测行 id 必须是非空字符串');
  }
  if (!isNonEmptyString(record.event_id)) {
    throw new SchemaError('观测行 event_id 必须是非空字符串');
  }
  if (typeof record.version_token !== 'string' || record.version_token.trim() === '') {
    throw new SchemaError('观测行 version_token 必须是非空字符串');
  }
  if (typeof record.reason_code !== 'string' || !(OBSERVATION_REASON_CODES as readonly string[]).includes(record.reason_code)) {
    throw new SchemaError(`观测行 reason_code 越界：${String(record.reason_code)}`);
  }
  if (!isNonEmptyString(record.snapshot_hash)) {
    throw new SchemaError('观测行 snapshot_hash 必须是非空字符串');
  }
  if (typeof record.at_ms !== 'number' || !Number.isFinite(record.at_ms)) {
    throw new SchemaError('观测行 at_ms 必须是有限数');
  }

  return record as unknown as DrainObservation;
}

/** 三元组去重键。 */
function observationKey(row: Pick<DrainObservation, 'event_id' | 'version_token' | 'reason_code'>): string {
  return [row.event_id, row.version_token, row.reason_code].join(ID_KEY_SEPARATOR);
}

/**
 * 幂等合并：同 `(event_id, version_token, reason_code)` 三元组只留一条，首条优先
 * （后到重复写不倍增、不覆盖既有快照哈希）；不同 reason_code 视为不同观测。
 * 顺序：既有行在前、新到行在后。
 */
export function mergeObservations(
  existing: readonly DrainObservation[],
  incoming: readonly DrainObservation[],
): DrainObservation[] {
  const seen = new Set<string>();
  const merged: DrainObservation[] = [];
  for (const row of [...existing, ...incoming]) {
    const key = observationKey(row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(row);
  }
  return merged;
}
