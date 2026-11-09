/**
 * 投影表定义 —— 定案稿 §7.1 最小投影集（3 张核心表 + FTS）。
 *
 * 严格照抄定案稿 DDL：
 *  - P1 experience（结构层全量折叠；channel 为一等查询维度）
 *  - P2 experience_fts（FTS5 trigram）
 *  - P4 edge（邻接表 = ADR-1 落地；bi-temporal）
 *
 * 完整投影集（P3 entity / P5 episode / P6 asset / P7 bla / P8 judgment_ledger /
 * P9 channel）属「随能力需要逐步加，不预先建」——阶段 0–2 不建。
 *
 * B 块事件投影表（event）见 `event-schema.ts` —— 独立文件，避免与 A 块既有
 * DDL 混在一处；建表语句并入下面的 MINIMAL_SCHEMA 一同执行。
 */

import { SQL_EVENT } from './event-schema.ts';

/** P1 经历索引。 */
export const SQL_EXPERIENCE = `
CREATE TABLE IF NOT EXISTS experience(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  channel TEXT NOT NULL, scene_ref TEXT, initiation TEXT,
  occurred_ms INTEGER NOT NULL, recorded_ms INTEGER NOT NULL,
  tick INTEGER NOT NULL UNIQUE,
  status TEXT DEFAULT 'active',
  shard TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_exp_time ON experience(occurred_ms);
CREATE INDEX IF NOT EXISTS idx_exp_kind ON experience(kind);
CREATE INDEX IF NOT EXISTS idx_exp_channel ON experience(channel, scene_ref);
`;

/** P2 全文（FTS5 trigram）。 */
export const SQL_EXPERIENCE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS experience_fts USING fts5(text, tokenize='trigram');
`;

/** P4 边表。 */
export const SQL_EDGE = `
CREATE TABLE IF NOT EXISTS edge(
  id TEXT PRIMARY KEY,
  src TEXT NOT NULL, predicate TEXT NOT NULL, dst TEXT NOT NULL,
  valid_ms INTEGER, invalid_ms INTEGER,
  created_ms INTEGER NOT NULL, expired_ms INTEGER,
  confidence REAL, reason TEXT,
  provenance TEXT);
CREATE INDEX IF NOT EXISTS idx_edge_src ON edge(src, predicate);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst, predicate);
`;

/** 最小集全部建表语句。 */
export const MINIMAL_SCHEMA = [SQL_EXPERIENCE, SQL_EXPERIENCE_FTS, SQL_EDGE, SQL_EVENT] as const;

/** 期望存在的表名（测试据此核对 §7.1）。 */
export const EXPECTED_TABLES = ['experience', 'experience_fts', 'edge', 'event'] as const;

/** 期望存在的索引名（测试据此核对 §7.1）。 */
export const EXPECTED_INDEXES = [
  'idx_exp_time',
  'idx_exp_kind',
  'idx_exp_channel',
  'idx_edge_src',
  'idx_edge_dst',
  'idx_event_time',
  'idx_event_status',
  'idx_event_channel',
] as const;

/** experience 表期望列（顺序即 DDL 顺序）。 */
export const EXPECTED_EXPERIENCE_COLUMNS = [
  ['id', 'TEXT'],
  ['kind', 'TEXT'],
  ['channel', 'TEXT'],
  ['scene_ref', 'TEXT'],
  ['initiation', 'TEXT'],
  ['occurred_ms', 'INTEGER'],
  ['recorded_ms', 'INTEGER'],
  ['tick', 'INTEGER'],
  ['status', 'TEXT'],
  ['shard', 'TEXT'],
  ['seq', 'INTEGER'],
] as const;

/** edge 表期望列。 */
export const EXPECTED_EDGE_COLUMNS = [
  ['id', 'TEXT'],
  ['src', 'TEXT'],
  ['predicate', 'TEXT'],
  ['dst', 'TEXT'],
  ['valid_ms', 'INTEGER'],
  ['invalid_ms', 'INTEGER'],
  ['created_ms', 'INTEGER'],
  ['expired_ms', 'INTEGER'],
  ['confidence', 'REAL'],
  ['reason', 'TEXT'],
  ['provenance', 'TEXT'],
] as const;
