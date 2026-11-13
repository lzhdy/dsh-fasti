/**
 * 记忆层选择索引表定义 —— 方案 §3.2 照施工粒度 DDL。
 *
 * 风格对齐 src/projection/schema.ts：一表一常量 + 期望列数组供测试核对。
 * schema 版本从 1 起，迁移机制走 revisions 账本（§3.4），禁止 ALTER 原地改历史行。
 *
 * 禁列纪律（M6 守门）：mem_card 不得出现 summary/body/raw_text/emotion/mood/
 * importance/session 等列；零正文，锚点锚真源经历 id（anchor_json 权威）。
 */

/** 库内元信息（单行演进为键值表，stamp 与 revisions 账本对应）。 */
export const SQL_SCHEMA_META = `
CREATE TABLE IF NOT EXISTS schema_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL);
`;

/**
 * 轻卡主表：零正文。
 * weight 与 display_cues 数量的 CHECK 按 §3.2 列注释口径落为显式约束。
 */
export const SQL_MEM_CARD = `
CREATE TABLE IF NOT EXISTS mem_card(
  card_id            TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL,
  anchor_json        TEXT NOT NULL,
  channel            TEXT NOT NULL,
  card_type          TEXT NOT NULL DEFAULT 'event',
  selection          TEXT NOT NULL DEFAULT 'selected',
  weight             REAL NOT NULL DEFAULT 0,
  display_cues_json  TEXT NOT NULL,
  aliases_json       TEXT NOT NULL DEFAULT '[]',
  discriminator      TEXT NOT NULL,
  entity_hint_json   TEXT,
  occurred_ms        INTEGER NOT NULL,
  ended_ms           INTEGER NOT NULL,
  valid_ms           INTEGER NOT NULL,
  invalid_ms         INTEGER,
  created_ms         INTEGER NOT NULL,
  expired_ms         INTEGER,
  status             TEXT NOT NULL DEFAULT 'active',
  content_hash       TEXT NOT NULL,
  hit_count          INTEGER NOT NULL DEFAULT 0,
  last_hit_ms        INTEGER,
  schema_version     INTEGER NOT NULL DEFAULT 1,
  CHECK (card_type IN ('event')),
  CHECK (selection IN ('selected','excluded')),
  CHECK (status IN ('active','invalid','superseded')),
  CHECK (entity_hint_json IS NULL),
  CHECK (weight BETWEEN 0 AND 1),
  CHECK (json_array_length(display_cues_json) BETWEEN 1 AND 3),
  CHECK (length(discriminator) <= 40));
CREATE INDEX IF NOT EXISTS idx_memcard_event ON mem_card(event_id);
CREATE INDEX IF NOT EXISTS idx_memcard_time ON mem_card(occurred_ms);
CREATE INDEX IF NOT EXISTS idx_memcard_status ON mem_card(status, invalid_ms);
`;

/** 卡的 FTS：索引文本仅由 display_cues + 活跃 aliases 拼成，绝无正文/摘要。 */
export const SQL_MEM_CARD_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS mem_card_fts USING fts5(
  card_id UNINDEXED,
  cue_text,
  tokenize='trigram');
`;

/** 别名词表（词级命中统计与漏召回填用；与卡内 aliases_json 保持同一数据源）。 */
export const SQL_MEM_ALIAS = `
CREATE TABLE IF NOT EXISTS mem_alias(
  term_norm   TEXT NOT NULL,
  card_id     TEXT NOT NULL,
  source      TEXT NOT NULL,
  sensitive   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active',
  created_ms  INTEGER NOT NULL,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_ms INTEGER,
  PRIMARY KEY (term_norm, card_id),
  CHECK (source IN ('miss')),
  CHECK (sensitive IN (0,1)));
CREATE INDEX IF NOT EXISTS idx_alias_card ON mem_alias(card_id);
`;

/** 漏召观测（D4/D.7：只存规范化词/哈希+锚点+时间+统计，永远不存原始查询全文）。 */
export const SQL_MEM_MISS = `
CREATE TABLE IF NOT EXISTS mem_miss(
  id                 TEXT PRIMARY KEY,
  term_norm          TEXT NOT NULL,
  term_hash          TEXT NOT NULL,
  channel            TEXT NOT NULL,
  anchor_event_id    TEXT,
  anchor_json        TEXT,
  returned_count     INTEGER NOT NULL,
  observed_ms        INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_miss_time ON mem_miss(observed_ms);
CREATE INDEX IF NOT EXISTS idx_miss_hash ON mem_miss(term_hash);
`;

/** 离线审计运行（harness 产出，观测-only）。 */
export const SQL_MEM_AUDIT_RUN = `
CREATE TABLE IF NOT EXISTS mem_audit_run(
  run_id TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  sample_n INTEGER NOT NULL,
  probe_set_version TEXT NOT NULL,
  model_tag TEXT,
  metrics_json TEXT NOT NULL,
  notes_json TEXT NOT NULL DEFAULT '{}');
`;

/** 离线审计条目（N/A 项不写本行、只在 run.notes 计数）。 */
export const SQL_MEM_AUDIT_ITEM = `
CREATE TABLE IF NOT EXISTS mem_audit_item(
  run_id TEXT NOT NULL,
  item_no INTEGER NOT NULL,
  probe_type TEXT NOT NULL,
  expected_ref TEXT,
  returned_refs_json TEXT NOT NULL,
  passed INTEGER NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, item_no),
  CHECK (probe_type IN ('gold','decoy','consistency','provenance')),
  CHECK (passed IN (0,1)));
`;

/** 全部建表语句（store 打开时事务执行）。 */
export const MEMORY_SCHEMA = [
  SQL_SCHEMA_META,
  SQL_MEM_CARD,
  SQL_MEM_CARD_FTS,
  SQL_MEM_ALIAS,
  SQL_MEM_MISS,
  SQL_MEM_AUDIT_RUN,
  SQL_MEM_AUDIT_ITEM,
] as const;

/** schema 版本（从 1 起，§3.2）。 */
export const MEMORY_SCHEMA_VERSION = 1;

/** 期望存在的表名（测试据此核对 §3.2；FTS5 内部影子表不在其列）。 */
export const MEMORY_EXPECTED_TABLES = [
  'schema_meta',
  'mem_card',
  'mem_card_fts',
  'mem_alias',
  'mem_miss',
  'mem_audit_run',
  'mem_audit_item',
] as const;

/** 期望存在的索引名。 */
export const MEMORY_EXPECTED_INDEXES = [
  'idx_memcard_event',
  'idx_memcard_time',
  'idx_memcard_status',
  'idx_alias_card',
  'idx_miss_time',
  'idx_miss_hash',
] as const;

/**
 * 各表期望列（顺序即 DDL 顺序，[列名, 声明类型]）。
 * FTS5 虚拟列的 PRAGMA 类型为空串。
 */
export const MEMORY_EXPECTED_COLUMNS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  schema_meta: [
    ['key', 'TEXT'],
    ['value', 'TEXT'],
  ],
  mem_card: [
    ['card_id', 'TEXT'],
    ['event_id', 'TEXT'],
    ['anchor_json', 'TEXT'],
    ['channel', 'TEXT'],
    ['card_type', 'TEXT'],
    ['selection', 'TEXT'],
    ['weight', 'REAL'],
    ['display_cues_json', 'TEXT'],
    ['aliases_json', 'TEXT'],
    ['discriminator', 'TEXT'],
    ['entity_hint_json', 'TEXT'],
    ['occurred_ms', 'INTEGER'],
    ['ended_ms', 'INTEGER'],
    ['valid_ms', 'INTEGER'],
    ['invalid_ms', 'INTEGER'],
    ['created_ms', 'INTEGER'],
    ['expired_ms', 'INTEGER'],
    ['status', 'TEXT'],
    ['content_hash', 'TEXT'],
    ['hit_count', 'INTEGER'],
    ['last_hit_ms', 'INTEGER'],
    ['schema_version', 'INTEGER'],
  ],
  mem_card_fts: [
    ['card_id', ''],
    ['cue_text', ''],
  ],
  mem_alias: [
    ['term_norm', 'TEXT'],
    ['card_id', 'TEXT'],
    ['source', 'TEXT'],
    ['sensitive', 'INTEGER'],
    ['status', 'TEXT'],
    ['created_ms', 'INTEGER'],
    ['hit_count', 'INTEGER'],
    ['last_hit_ms', 'INTEGER'],
  ],
  mem_miss: [
    ['id', 'TEXT'],
    ['term_norm', 'TEXT'],
    ['term_hash', 'TEXT'],
    ['channel', 'TEXT'],
    ['anchor_event_id', 'TEXT'],
    ['anchor_json', 'TEXT'],
    ['returned_count', 'INTEGER'],
    ['observed_ms', 'INTEGER'],
  ],
  mem_audit_run: [
    ['run_id', 'TEXT'],
    ['created_ms', 'INTEGER'],
    ['sample_n', 'INTEGER'],
    ['probe_set_version', 'TEXT'],
    ['model_tag', 'TEXT'],
    ['metrics_json', 'TEXT'],
    ['notes_json', 'TEXT'],
  ],
  mem_audit_item: [
    ['run_id', 'TEXT'],
    ['item_no', 'INTEGER'],
    ['probe_type', 'TEXT'],
    ['expected_ref', 'TEXT'],
    ['returned_refs_json', 'TEXT'],
    ['passed', 'INTEGER'],
    ['detail_json', 'TEXT'],
  ],
};