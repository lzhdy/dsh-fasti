/**
 * mem_miss 留存维护动作（#117 3.2 五件套第 1 件）——drain worker 主触发的落点。
 *
 * 纪律：
 *  - **不搭 transactionApply 的便车**（R2 收口②）：投影无变化轮不进 apply，裁剪独立判定、
 *    独立事务；未越界时**不开任何写事务**（5s 节拍下绝大多数轮次零写成本）。
 *  - 交集口径只认 `miss-retention.ts` 的纯函数；本文件只做 IO（前置只读闸、台账、DELETE）。
 *  - 提交序（N-4）：**台账先 append（含 keptContentHash）→ fsync → 再开删除事务**。
 *    崩在台账后、删除前，只会出现"台账多记未遂"（可容忍、下次对账可见），
 *    不会出现"已删无账"。
 *  - 台账行只放聚合量：无词面（term_norm）、无 term_hash、无 anchor 明细。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { ulid } from '../core/ulid.ts';
import { appendDecision } from './ledger.ts';
import { DECISIONS_FILE } from './ledger.ts';
import {
  computeMissRetention,
  floorToUtcDay,
  type MissRetentionPolicy,
  type MissRetentionRow,
} from './miss-retention.ts';

const DAY_MS = 86_400_000;

/** 维护动作结果（用于红测与日志；不进入 drain 的第 57 行报告形状）。 */
export interface MissPruneOutcome {
  /** 是否真的开事务删了行。 */
  readonly applied: boolean;
  /** 未开事务的原因（pruned 时为 null）。 */
  readonly reason: 'empty' | 'within-limit' | null;
  readonly kept: number;
  readonly droppedAgeOut: number;
  readonly droppedOverflow: number;
  readonly windowCompressed: boolean;
  readonly cutoffMs: number;
  readonly durationMs: number;
}

function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 台账号：只含聚合量。event_id/anchor_json/content_hash 是 D4 卡决策的必填位，
 * 维护动作沿空串/[] 语义占位（content_hash 复用为 keptContentHash 的承载位，
 * 避免再扩一个与「内容摘要」语义冲突的字段）。
 *
 * 导出给 builder 复用：重建对账与 drain 裁剪必须写同形台账（单一口径，可交叉核对）。
 */
export function appendMissRetentionDecision(
  indexDir: string,
  policy: MissRetentionPolicy,
  result: {
    readonly kept: number;
    readonly droppedAgeOut: number;
    readonly droppedOverflow: number;
    readonly cutoffMs: number;
    readonly windowCompressed: boolean;
    readonly totalBefore: number;
    readonly keptContentHash: string;
  },
): void {
  appendDecision(indexDir, {
    decision_id: ulid(),
    at_ms: policy.asOfMs,
    action: 'miss-retention',
    card_id: null,
    event_id: '',
    anchor_json: '[]',
    content_hash: result.keptContentHash,
    model_tag: policy.policyVersion,
    reason: 'miss-retention:drain',
    created_by: 'system',
    missRetention: {
      asOfMs: policy.asOfMs,
      cutoffMs: result.cutoffMs,
      windowDays: policy.windowDays,
      hardCapK: policy.hardCapK,
      totalBefore: result.totalBefore,
      droppedAgeOut: result.droppedAgeOut,
      droppedOverflow: result.droppedOverflow,
      kept: result.kept,
      windowCompressed: result.windowCompressed,
      keptContentHash: result.keptContentHash,
    },
  });
  // 台账先落盘：删除事务开启前保证账在磁盘上（N-4 顺序）。
  fsyncFile(path.join(indexDir, DECISIONS_FILE));
}

/**
 * 一轮维护：只读闸 → 纯函数 → 台账 → 删除事务。
 *
 * @param db 写柄持有的同一连接（同连接同步执行，事务期间占事件循环；故天级至多一次）。
 * @param indexDir 索引目录（台账落在这里）。
 */
export function pruneMissRows(
  db: DatabaseSync,
  indexDir: string,
  policy: MissRetentionPolicy,
): MissPruneOutcome {
  const startedMs = Date.now();
  const elapsed = (): number => Date.now() - startedMs;

  // ① 只读闸：一次索引 seek 判断是否需要动刀（零写）。
  const stat = db
    .prepare('SELECT COUNT(*) AS n, MIN(observed_ms) AS oldest FROM mem_miss')
    .get() as { n: number; oldest: number | null };
  const total = Number(stat.n);
  if (total === 0) {
    return {
      applied: false,
      reason: 'empty',
      kept: 0,
      droppedAgeOut: 0,
      droppedOverflow: 0,
      windowCompressed: false,
      cutoffMs: floorToUtcDay(policy.asOfMs) - policy.windowDays * DAY_MS,
      durationMs: elapsed(),
    };
  }

  const cutoffMs = floorToUtcDay(policy.asOfMs) - policy.windowDays * DAY_MS;
  const oldest = stat.oldest === null ? null : Number(stat.oldest);
  if (total <= policy.hardCapK && oldest !== null && oldest >= cutoffMs) {
    return {
      applied: false,
      reason: 'within-limit',
      kept: total,
      droppedAgeOut: 0,
      droppedOverflow: 0,
      windowCompressed: false,
      cutoffMs,
      durationMs: elapsed(),
    };
  }

  // ② 纯函数裁决：全量行读出后交由唯一语义权威计算 survivor。
  const rawRows = db.prepare('SELECT * FROM mem_miss').all() as Array<Record<string, unknown>>;
  const rows: MissRetentionRow[] = rawRows.map((row) => ({
    ...row,
    id: String(row['id']),
    observedMs: Number(row['observed_ms']),
  }));
  const result = computeMissRetention(rows, policy);

  if (result.droppedAgeOut + result.droppedOverflow === 0) {
    // 防御性：闸与纯函数口径若出现偏差，宁可不删（绝不静默多删）。
    return {
      applied: false,
      reason: 'within-limit',
      kept: result.kept,
      droppedAgeOut: 0,
      droppedOverflow: 0,
      windowCompressed: result.windowCompressed,
      cutoffMs: result.cutoffMs,
      durationMs: elapsed(),
    };
  }

  // ③ 台账先写 + fsync（崩溃窗只可能"多记未遂"，不会"已删无账"）。
  appendMissRetentionDecision(indexDir, policy, result);

  // ④ 单事务范围 DELETE：先落保留集到临时表，再按差集删。
  const keepTable = `miss_keep_${ulid().toLowerCase()}`;
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TEMP TABLE ${keepTable}(id TEXT PRIMARY KEY)`);
    const insertKeep = db.prepare(`INSERT INTO ${keepTable}(id) VALUES (?)`);
    for (const row of result.survivors) {
      insertKeep.run(row.id);
    }
    db.prepare(`DELETE FROM mem_miss WHERE id NOT IN (SELECT id FROM ${keepTable})`).run();
    db.exec(`DROP TABLE ${keepTable}`);
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
    applied: true,
    reason: null,
    kept: result.kept,
    droppedAgeOut: result.droppedAgeOut,
    droppedOverflow: result.droppedOverflow,
    windowCompressed: result.windowCompressed,
    cutoffMs: result.cutoffMs,
    durationMs: elapsed(),
  };
}
