/**
 * 事件投影表定义 —— 技术基线 §7.1（B 块事件投影）。
 *
 * 与 experience / edge 同风格：一表 + 三个索引。
 * 事件投影**只存当前态**（每个 event id 一行 + version 列）；
 * 版本历史留在 `events/` 真源（append-only），投影层不提供读历史版本的能力。
 *
 * 数组类字段（key_points / anchors / topic_lines / boundary_candidates / split_into）
 * 以 **JSON 文本**存 —— SQLite 无原生数组类型；编解码走 `projection/event-row.ts`
 * 的同一对函数 → 三档读出的行逐字段一致。
 */

/** 事件索引（记事本当前态）。 */
export const SQL_EVENT = `
CREATE TABLE IF NOT EXISTS event(
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  channel TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER NOT NULL,
  assembled_ms INTEGER NOT NULL,
  summary TEXT,
  summary_quality TEXT NOT NULL,
  summary_source TEXT,
  summary_prompt_version TEXT,
  summary_model TEXT,
  key_points TEXT,
  anchors TEXT,
  topic_lines TEXT,
  boundary_candidates TEXT,
  pointer_count INTEGER NOT NULL,
  merged_into TEXT,
  split_into TEXT,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  effective_chars INTEGER,
  raw_chars INTEGER);
CREATE INDEX IF NOT EXISTS idx_event_time ON event(started_ms);
CREATE INDEX IF NOT EXISTS idx_event_status ON event(status);
CREATE INDEX IF NOT EXISTS idx_event_channel ON event(channel, started_ms);
`;

/** event 表期望列（顺序即 DDL 顺序）。 */
export const EXPECTED_EVENT_COLUMNS = [
  ['id', 'TEXT'],
  ['version', 'INTEGER'],
  ['status', 'TEXT'],
  ['channel', 'TEXT'],
  ['started_ms', 'INTEGER'],
  ['ended_ms', 'INTEGER'],
  ['assembled_ms', 'INTEGER'],
  ['summary', 'TEXT'],
  ['summary_quality', 'TEXT'],
  ['summary_source', 'TEXT'],
  ['summary_prompt_version', 'TEXT'],
  ['summary_model', 'TEXT'],
  ['key_points', 'TEXT'],
  ['anchors', 'TEXT'],
  ['topic_lines', 'TEXT'],
  ['boundary_candidates', 'TEXT'],
  ['pointer_count', 'INTEGER'],
  ['merged_into', 'TEXT'],
  ['split_into', 'TEXT'],
  ['created_by', 'TEXT'],
  ['created_at_ms', 'INTEGER'],
  // v1.4 双计数器（纯加法、可空）：老行读出为 NULL = 未统计，不强制回填。
  ['effective_chars', 'INTEGER'],
  ['raw_chars', 'INTEGER'],
] as const;

/** event 表期望索引名。 */
export const EXPECTED_EVENT_INDEXES = [
  'idx_event_time',
  'idx_event_status',
  'idx_event_channel',
] as const;
