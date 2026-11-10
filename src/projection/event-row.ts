/**
 * 事件投影行的**唯一**折叠与过滤实现（三档共用）。
 *
 * 为什么必须只有一处（基线 §7.1 / §8-4 的 G06 教训）：
 * 批次 0 的 as-of 语义在三档各写了一遍，改一处漏两处 → 结果集漂移。
 * 事件投影若再分三份实现，必然重演。故此处收敛为**一份**共享实现：
 *  - `toEventProjection`：事件记录 → 投影行（L1 写入 / L2 写入 / L3 直读共用）；
 *  - `foldCurrentEvents`：版本行 → 当前态（按 id 取最大 version）；
 *  - `eventQueryConditions`：查询条件 → SQL 片段与 JS 判定（**同一份条件表**）；
 *  - `matchesEventQuery`：查询过滤的权威口径。
 *
 * 存储形态也统一：数组类字段一律以 **JSON 文本**落盘（L1 列 / L2 行 / L3 不落盘），
 * 编解码走同一对函数 → 三档读出的行逐字段一致（含 null 与 [] 的区别）。
 */

import { isoToMs } from '../core/time.ts';
import type { BoundaryCandidate, EventRecord } from '../contract/event.ts';
import type { EventProjection, EventQuery } from './types.ts';

/**
 * 落盘行 —— 数组类字段以 JSON 文本存。
 *
 * L1（sqlite 列）与 L2（jsonl 行）用同一形态 → 同一个解码函数 → 行内容必然一致。
 */
export interface StoredEventRow {
  id: string;
  version: number;
  status: string;
  channel: string;
  started_ms: number;
  ended_ms: number;
  assembled_ms: number;
  summary: string | null;
  summary_quality: string;
  summary_source: string | null;
  summary_prompt_version: string | null;
  summary_model: string | null;
  key_points: string;
  anchors: string;
  topic_lines: string;
  boundary_candidates: string;
  pointer_count: number;
  merged_into: string | null;
  split_into: string;
  created_by: string;
  created_at_ms: number;
  /** v1.4 双计数器（可空）：老行读出为 null = 未统计。 */
  effective_chars: number | null;
  raw_chars: number | null;
}

/** 事件记录 → 投影行（三档唯一实现，保证逐字段一致）。 */
export function toEventProjection(event: EventRecord): EventProjection {
  return {
    id: event.id,
    version: event.version,
    status: event.status,
    channel: event.channel,
    started_ms: isoToMs(event.time_range.started_at),
    ended_ms: isoToMs(event.time_range.ended_at),
    assembled_ms: isoToMs(event.assembled_at),
    summary: event.summary,
    summary_quality: event.summary_quality,
    summary_source: event.summary_source,
    summary_prompt_version: event.summary_prompt_version,
    summary_model: event.summary_model,
    key_points: [...event.key_points],
    anchors: [...event.anchors],
    topic_lines: [...event.topic_lines],
    boundary_candidates: event.boundary_candidates.map((candidate) => ({ ...candidate })),
    pointer_count: event.pointers.length,
    merged_into: event.merged_into ?? null,
    split_into: [...(event.split_into ?? [])],
    created_by: event.created_by,
    created_at_ms: isoToMs(event.created_at),
    // v1.4 双计数器：直接取事件行的值（不从 pointers 重算 —— 定案稿 §3.2）。
    effective_chars: event.effective_chars,
    raw_chars: event.raw_chars,
  };
}

/**
 * 版本行 → 当前态（按 id 取最大 version）。
 *
 * 「当前态 = 同 id 最大 version」是事件投影的唯一折叠规则（基线 §7.1）。
 * 版本历史留在 `events/` 真源，投影层不提供读历史版本的能力。
 */
export function foldCurrentEvents(rows: readonly EventRecord[]): EventProjection[] {
  return foldCurrentEventRows(rows.map((record) => toEventProjection(record)));
}

/**
 * 投影行 → 当前态（按 id 取最大 version）。
 *
 * L2 从 `event.jsonl` 载入时用：文件里可能残留同 id 的旧版本行，
 * 载入必须与重建同规则 → 两个折叠入口共用同一个折叠核心。
 */
export function foldCurrentEventRows(rows: readonly EventProjection[]): EventProjection[] {
  const latest = new Map<string, EventProjection>();
  for (const row of rows) {
    const previous = latest.get(row.id);
    if (previous === undefined || row.version > previous.version) {
      latest.set(row.id, row);
    }
  }
  return sortEventRows([...latest.values()]);
}

/**
 * 一条查询条件 —— SQL 片段与 JS 判定**成对**给出。
 *
 * 这是「三档不会漂移」的结构性保证：L1 的 SQL 预筛与 L2/L3 的 JS 过滤
 * 读的是同一张条件表，不是两份实现。
 */
export interface EventQueryCondition {
  /** SQL 片段（含 `?` 占位）。 */
  readonly sql: string;
  /** SQL 绑定参数（顺序与 sql 中的 `?` 一致）。 */
  readonly params: readonly unknown[];
  /** JS 判定（L2 / L3 用；L1 也用它收口，保证 SQL 与 JS 同口径）。 */
  readonly test: (row: EventProjection) => boolean;
}

/**
 * 查询条件表 —— 过滤语义的**唯一**定义处。
 *
 * 时间口径：按 `started_ms` 过滤，`from_ms` / `to_ms` **含端点**。
 */
export function eventQueryConditions(query: EventQuery): EventQueryCondition[] {
  const conditions: EventQueryCondition[] = [];

  if (query.status !== undefined) {
    const status = query.status;
    conditions.push({
      sql: 'status = ?',
      params: [status],
      test: (row) => row.status === status,
    });
  }
  if (query.channel !== undefined) {
    const channel = query.channel;
    conditions.push({
      sql: 'channel = ?',
      params: [channel],
      test: (row) => row.channel === channel,
    });
  }
  if (query.from_ms !== undefined) {
    const fromMs = query.from_ms;
    conditions.push({
      sql: 'started_ms >= ?',
      params: [fromMs],
      test: (row) => row.started_ms >= fromMs,
    });
  }
  if (query.to_ms !== undefined) {
    const toMs = query.to_ms;
    conditions.push({
      sql: 'started_ms <= ?',
      params: [toMs],
      test: (row) => row.started_ms <= toMs,
    });
  }

  return conditions;
}

/**
 * 查询过滤 —— 三档的权威口径。
 *
 * L1 的 SQL 只是**预筛**（走索引），最终判定仍以本函数为准 → 三档结果集必然一致。
 */
export function matchesEventQuery(row: EventProjection, query: EventQuery): boolean {
  return eventQueryConditions(query).every((condition) => condition.test(row));
}

/**
 * 排序 —— 三档同一顺序（时间升序 → id 升序）。
 *
 * L1 在 SQL 里 ORDER BY 同样两列；L2/L3 用本函数。
 */
export function sortEventRows(rows: EventProjection[]): EventProjection[] {
  return rows.sort((a, b) => {
    if (a.started_ms !== b.started_ms) {
      return a.started_ms - b.started_ms;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 投影行 → 落盘行（数组字段转 JSON 文本）。 */
export function encodeEventRow(row: EventProjection): StoredEventRow {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    channel: row.channel,
    started_ms: row.started_ms,
    ended_ms: row.ended_ms,
    assembled_ms: row.assembled_ms,
    summary: row.summary,
    summary_quality: row.summary_quality,
    summary_source: row.summary_source,
    summary_prompt_version: row.summary_prompt_version,
    summary_model: row.summary_model,
    key_points: JSON.stringify(row.key_points),
    anchors: JSON.stringify(row.anchors),
    topic_lines: JSON.stringify(row.topic_lines),
    boundary_candidates: JSON.stringify(row.boundary_candidates),
    pointer_count: row.pointer_count,
    merged_into: row.merged_into,
    split_into: JSON.stringify(row.split_into),
    created_by: row.created_by,
    created_at_ms: row.created_at_ms,
    effective_chars: row.effective_chars,
    raw_chars: row.raw_chars,
  };
}

/** 落盘行 → 投影行（L1 的 sqlite 行与 L2 的 jsonl 行共用同一解码口径）。 */
export function decodeEventRow(raw: unknown): EventProjection {
  const obj = raw as Record<string, unknown>;
  return {
    id: String(obj['id']),
    version: Number(obj['version']),
    status: String(obj['status']),
    channel: String(obj['channel']),
    started_ms: Number(obj['started_ms']),
    ended_ms: Number(obj['ended_ms']),
    assembled_ms: Number(obj['assembled_ms']),
    summary: obj['summary'] === null || obj['summary'] === undefined ? null : String(obj['summary']),
    summary_quality: String(obj['summary_quality']),
    summary_source:
      obj['summary_source'] === null || obj['summary_source'] === undefined
        ? null
        : String(obj['summary_source']),
    summary_prompt_version: decodeNullableString(obj['summary_prompt_version']),
    summary_model: decodeNullableString(obj['summary_model']),
    key_points: decodeStringArray(obj['key_points']),
    anchors: decodeStringArray(obj['anchors']),
    topic_lines: decodeStringArray(obj['topic_lines']),
    boundary_candidates: decodeCandidates(obj['boundary_candidates']),
    pointer_count: Number(obj['pointer_count']),
    merged_into:
      obj['merged_into'] === null || obj['merged_into'] === undefined ? null : String(obj['merged_into']),
    split_into: decodeStringArray(obj['split_into']),
    created_by: String(obj['created_by']),
    created_at_ms: Number(obj['created_at_ms']),
    // v1.4 双计数器：老库补列后为 NULL、缺失也归一为 null（= 未统计）。
    effective_chars: decodeNullableInteger(obj['effective_chars']),
    raw_chars: decodeNullableInteger(obj['raw_chars']),
  };
}

/**
 * 可空整数列解码 —— 缺失 / null 归一为 null（非负计数，不做猜测性补值）。
 *
 * 与 `decodeNullableString` 同构：老行读出必须是 null，不能读成 0 ——
 * 0 与 null 语义不同（0 = 确实零字，null = 没统计）。
 */
function decodeNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return Number(value);
}

/** JSON 文本 → 字符串数组（缺失/空值归一为 []，避免三档出现 undefined 与 [] 的差异）。 */
function decodeStringArray(value: unknown): string[] {
  const parsed = parseJsonArray(value);
  return parsed.map((item) => String(item));
}

/**
 * 可空字符串列解码 —— 缺失 / null / 空串一律归一为 null。
 *
 * 为什么空串也算 null：老库迁移后新列是 NULL，但 L2 的 jsonl 里可能是 `""`；
 * 两者语义都是「不知道」，不能一档读成 null、另一档读成 ''。
 */
function decodeNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

/** JSON 文本 → 候选标记数组（未知 kind 原样保留，不丢弃）。 */
function decodeCandidates(value: unknown): BoundaryCandidate[] {
  const parsed = parseJsonArray(value);
  return parsed.map((item) => {
    const obj = item as Record<string, unknown>;
    return {
      kind: String(obj['kind']),
      at_pointer_id: String(obj['at_pointer_id']),
      marked_at: String(obj['marked_at']),
    };
  });
}

/** JSON 文本 → 数组（非数组一律归一为空数组）。 */
function parseJsonArray(value: unknown): unknown[] {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  const parsed = JSON.parse(String(value)) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}
