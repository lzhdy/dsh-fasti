/**
 * mem_miss 留存裁剪 —— 唯一语义权威（#117 外审裁定 P-1/N-3/N-4/P99.9 废止）。
 *
 * 纪律：
 *  - 纯函数：零 IO、不读墙钟（时间只来自注入的 asOfMs）、不改入参、不查库；
 *    drain 维护事务与 builder 对账两路必须复用它，禁止各写一套口径（N-3）。
 *  - 双闸口径：窗口 W 天为软闸（先按 observed_ms 裁掉窗口外），硬顶 K 为硬闸
 *    （窗口内取最近 K 行）；交集即 survivor。归因第一顺位＝超龄，第二顺位＝溢出。
 *  - 稳定序：observed_ms 降序，同毫秒按 id（ULID 时间有序）降序决胜 → 同输入同输出。
 *  - 日界取整：cutoffMs 以 UTC 日为单位取整，日内任意时刻调用结果一致（日内幂等）。
 *  - 表内删除量只由本函数决定；调用方负责"未越界则零写事务"（见 drain 侧红测）。
 *
 * 本文件不 import node:fs/node:sqlite/Date：可离线逐行复核。
 */

import { IntegrityError } from '../core/errors.ts';
import { sha256Hex } from './content-hash.ts';

/** 台账里登记的裁剪行最小形状：其余列原样透传，不参与语义。 */
export interface MissRetentionRow {
  readonly id: string;
  readonly observedMs: number;
  readonly [key: string]: unknown;
}

export interface MissRetentionPolicy {
  /** 观测时刻（ms，注入；函数内不出现 Date.now）。 */
  readonly asOfMs: number;
  /** 窗口天数 W（软闸；>0）。 */
  readonly windowDays: number;
  /** 硬顶 K（硬闸；≥0，0 表示不留任何行）。 */
  readonly hardCapK: number;
  /** 策略版本（落台账，段二标定后固化；此处只透传不解释）。 */
  readonly policyVersion: string;
}

export interface MissRetentionResult {
  /** 保留行（已按稳定序排列）。 */
  readonly survivors: readonly MissRetentionRow[];
  /** 归因第一顺位：窗口外被裁掉的行数。 */
  readonly droppedAgeOut: number;
  /** 归因第二顺位：窗口内因超硬顶被裁掉的行数。 */
  readonly droppedOverflow: number;
  /** 窗口下界（含），UTC 日界取整的毫秒数。 */
  readonly cutoffMs: number;
  /** 显影字段：窗口内行数超过硬顶（即"窗口被压缩"，语义不再等于 W 天）。 */
  readonly windowCompressed: boolean;
  readonly totalBefore: number;
  readonly kept: number;
  /** kept 集合的内容哈希（N-4：台账先记它，rename 后据此校验"删除有账"）。 */
  readonly keptContentHash: string;
}

const DAY_MS = 86_400_000;

/** 日界取整（UTC；只依赖算术，无时区库依赖）。 */
export function floorToUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function assertPolicy(policy: MissRetentionPolicy): void {
  if (policy === null || typeof policy !== 'object') {
    throw new IntegrityError('留存策略必须是对象');
  }
  if (!Number.isFinite(policy.asOfMs) || policy.asOfMs < 0) {
    throw new IntegrityError('留存策略 asOfMs 必须是非负有限数');
  }
  if (!Number.isInteger(policy.windowDays) || policy.windowDays <= 0) {
    throw new IntegrityError('留存策略 windowDays 必须是正整数');
  }
  if (!Number.isInteger(policy.hardCapK) || policy.hardCapK < 0) {
    throw new IntegrityError('留存策略 hardCapK 必须是非负整数');
  }
  if (typeof policy.policyVersion !== 'string' || policy.policyVersion.length === 0) {
    throw new IntegrityError('留存策略 policyVersion 必须是非空字符串');
  }
}

/** 键序无关的规范化序列化（同集合 → 同串，不受属性插入顺序影响）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** kept 集合内容哈希：对保留行做键序无关规范化后整体 sha256（内容一变即变）。 */
export function computeKeptContentHash(rows: readonly MissRetentionRow[]): string {
  return sha256Hex(stableStringify(rows));
}

/** observed_ms DESC，同毫秒 id DESC（ULID 时间有序 → 新行胜出）。 */
function compareForRetention(a: MissRetentionRow, b: MissRetentionRow): number {
  if (b.observedMs !== a.observedMs) {
    return b.observedMs - a.observedMs;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * 交集裁决：窗口（软闸）× 硬顶（硬闸）→ survivor 集合。
 *
 * 归因：先判超龄（窗口外），再判溢出（窗口内超 K），两者互不重叠。
 */
export function computeMissRetention(
  rows: readonly MissRetentionRow[],
  policy: MissRetentionPolicy,
): MissRetentionResult {
  assertPolicy(policy);
  const cutoffMs = floorToUtcDay(policy.asOfMs) - policy.windowDays * DAY_MS;

  const within: MissRetentionRow[] = [];
  for (const row of rows) {
    if (row.observedMs >= cutoffMs) {
      within.push(row);
    }
  }
  const ordered = [...within].sort(compareForRetention);
  const survivors = ordered.slice(0, policy.hardCapK);

  return {
    survivors,
    droppedAgeOut: rows.length - within.length,
    droppedOverflow: within.length - survivors.length,
    cutoffMs,
    windowCompressed: within.length > policy.hardCapK,
    totalBefore: rows.length,
    kept: survivors.length,
    keptContentHash: computeKeptContentHash(survivors),
  };
}

/**
 * 段一（现在～#91 验收）的常数位：**偏大临时值，不是定稿、不进任何 SLA**。
 *
 * 段二（转 on 后满一个观测窗）用真实数据一次性工程复核并固化 policyVersion，
 * 口径为 K ≥ 观测期 max 日增量 × 安全系数(≥2) × W（P99.9 分位估法已废止）。
 */
export const MISS_RETENTION_TMP_POLICY = {
  windowDays: 180,
  /** 偏大临时值：评审粗估 100 行/天 × 180 天 ≈ 1.8 万行，此处留约 11 倍余量。 */
  hardCapK: 200_000,
  policyVersion: 'v1-tmp-unc-tuned',
} as const;

/** 临时身份的显式标签（红测锁死：不得被悄悄改成定稿口径）。 */
export const MISS_RETENTION_POLICY_PROVISIONAL = true;
