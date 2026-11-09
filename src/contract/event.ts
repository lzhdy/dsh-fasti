/**
 * 事件契约 —— 事件记录的类型与校验器（技术基线 §2）。
 *
 * 红线自检（由 tests/contract/event.test.ts 覆盖）：
 *  - 无「重要性」类字段（importance / salience / score …）；
 *  - 无「聊天/对话」前提字段（session_id / chat_id …）；
 *  - topic_lines 第一期恒为空数组（schema 建全、逻辑不消费）；
 *  - anchors 第一期生成但不消费（任何逻辑不得读它做判断）；
 *  - 开放枚举（boundary_candidates[].kind）未知值原样保留、不丢弃。
 *
 * 摘要校验口径（§2.3）：硬上限 600 字、只查非空、不设字数下限、
 * 不写三要素规则检查器 —— 「谁 / 做了什么 / 结果如何」只进 prompt 指引，由 LLM 自检。
 */

import { SchemaError } from '../core/errors.ts';
import { findForbiddenFieldKeys } from './experience.ts';

/** 事件 schema 版本（本期 = 1）。 */
export const EVENT_SCHEMA_VERSION = 1;

/**
 * 摘要硬上限字数 —— 超过就是转录不是摘要，拒收（§2.3）。
 *
 * 字面量只此一处：事件层参数模块引用本常量（src/event/params.ts），
 * 避免同一上限在两处各写一遍后走偏。
 */
export const SUMMARY_MAX_CHARS = 600;

/**
 * 码点长度 —— 摘要长度的**唯一口径**。
 *
 * UTF-16 码元 ≠ 码点：emoji 等代理对字符的码元数是码点数的两倍。
 * 「600 字」指人读的字 → 按码点算；否则一个含 emoji 的 600 字摘要，
 * 闭合管线按码点放行、落盘按码元被拒 → 假故障 + 无限重试。
 *
 * 全仓唯一实现：闭合管线等调用方一律 import 本函数，不得另写
 * `text.length` 或 `[...text].length`（两处各写一遍就会漂移）。
 */
export function summaryLengthOf(text: string): number {
  return [...text].length;
}

/** 事件状态机（封闭枚举，写模式校验）。 */
export const EVENT_STATUSES = ['open', 'closed', 'merged', 'split', 'archived'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * 闭合原因 —— 边界的机械事实（不是重要性，无分数/权重/置信度）。
 *
 * `null` = 未被 A 类机械信号闭合（事件仍 open，或由她的修正产生/重开）。
 */
export const EVENT_CLOSED_REASONS = [
  'silence', // 静默 ≥ 阈值
  'max-records', // 记录数达上限
  'task-closure', // 任务闭环
  'channel-switch', // 场景切换（通道变了）
] as const;
export type EventClosedReason = (typeof EVENT_CLOSED_REASONS)[number];

/** 摘要是否就绪（封闭枚举，写模式校验）。 */
export const SUMMARY_QUALITIES = ['pending', 'ready'] as const;
export type SummaryQuality = (typeof SUMMARY_QUALITIES)[number];

/** 摘要由谁写 —— 决定重跑时能不能覆盖（封闭枚举，写模式校验）。 */
export const SUMMARY_SOURCES = ['llm', 'her'] as const;
export type SummarySource = (typeof SUMMARY_SOURCES)[number];

/** 谁创建了这行（封闭枚举，写模式校验）。 */
export const EVENT_CREATED_BY = ['system', 'her'] as const;
export type EventCreatedBy = (typeof EVENT_CREATED_BY)[number];

/**
 * 事件指针 —— 指向记录本（experiences）的一条目。
 *
 * id 权威（experience.id），channel/shard/seq 冗余加速（对齐 Pointer 双定位口径）。
 */
export interface EventPointer {
  /** 权威：记录本条目的 experience id。 */
  id: string;
  /** 冗余：该经历所属通道。 */
  channel?: string;
  /** 冗余：experiences/ 分片（'YYYY-MM'）。 */
  shard?: string;
  /** 冗余：experiences/ 行号。 */
  seq?: number;
}

/** 事件时间范围 —— 双轴不混（事何时开始 / 结束）。 */
export interface EventTimeRange {
  /** 事何时开始。 */
  started_at: string;
  /** 事何时结束。允许与 started_at 相等（瞬时事件）。 */
  ended_at: string;
}

/**
 * 语义候选标记 —— 机械打点，信号本身是语义的（定案稿 §10）。
 *
 * kind 是**开放枚举**：未知值原样保留，不丢弃、不报错。
 */
export interface BoundaryCandidate {
  /** 候选类型；第一期只落 '话题跳转'。 */
  kind: string;
  /** 打点位置：该候选边界所在的记录本条目 id。 */
  at_pointer_id: string;
  /** 打点时刻。 */
  marked_at: string;
}

/** 事件记录 —— 每次状态/版本推进追加一行（append-only）。 */
export interface EventRecord {
  /** ULID：多版本共享同一个 id。 */
  id: string;
  /** 事件 schema 版本。 */
  schema_version: number;
  /** 版本号，从 1 递增；当前态 = 同 id 的最大 version。 */
  version: number;

  /** 状态机。 */
  status: EventStatus;
  /**
   * 闭合原因 —— 边界的机械事实。
   *
   * `null` = 未被 A 类机械信号闭合（事件仍 open，或由她的修正产生/重开）。
   * 「待归并」判定靠它：单指针且因静默闭合才算孤立（§5.5）。
   */
  closed_reason: EventClosedReason | null;
  /** 指向记录本条目的指针组。 */
  pointers: EventPointer[];
  /** 时间范围（双轴之一）。 */
  time_range: EventTimeRange;
  /** 被切成事件的时刻（双轴之二，与 time_range 不混）。 */
  assembled_at: string;

  /** 客观摘要；后台未完成时为 null。 */
  summary: string | null;
  /** 关键点 / 关键数据。 */
  key_points: string[];
  /** 事件锚点（第一期生成但不消费，第二期话题线用）。 */
  anchors: string[];
  /** 话题线 id 列表（第一期恒空）。 */
  topic_lines: string[];
  /** 摘要是否就绪。 */
  summary_quality: SummaryQuality;
  /** 摘要由谁写。 */
  summary_source: SummarySource | null;
  /**
   * 生成该摘要时的提示词版本号（**可空**：她手写或未生成时为 null）。
   *
   * 只做溯源，不做评分：换模型 / 改 prompt 后重跑同一事件时，用来分辨
   * 「这条摘要是在哪个版本下产生的」。不参与任何排序或判断。
   */
  summary_prompt_version: string | null;
  /**
   * 生成该摘要的模型标识（**可空**：她手写或未生成时为 null）。
   *
   * 与 `summary_prompt_version` 同一用途（溯源）。值由适配器按**实际使用的**
   * 模型填 —— 宿主没报出来就填 null，不猜、不编。
   */
  summary_model: string | null;

  /** 合并退役指针（status='merged' 时有值）。 */
  merged_into?: string;
  /** 拆分退役指针（status='split' 时有值）。 */
  split_into?: string[];

  /** 谁创建的。 */
  created_by: EventCreatedBy;
  /** 该行写入时刻。 */
  created_at: string;

  /** 所属通道 —— 通道隔离 open 事件、切分器按通道维护状态。 */
  channel: string;
  /** 语义候选标记（B 类信号：只标候选，绝不自动切）。 */
  boundary_candidates: BoundaryCandidate[];
}

/**
 * 事件的**读时派生**标注（§5.6）—— 能派生就不落盘。
 *
 * 四项全部由真源现算，不进事件记录、也不进投影表：
 * 落盘的话，记录本或事件一旦被修正，标注就成了第二份会漂移的「事实」。
 */
export interface EventDerivedMarks {
  /** 带附件：覆盖的记录里有带媒体的。 */
  hasMedia: boolean;
  /** 跨通道：覆盖的记录跨了 ≥2 个通道。 */
  crossChannel: boolean;
  /** 待归并：单指针的闭合事件 —— 等她手动归并，系统永不自动并入。 */
  pendingMerge: boolean;
  /** 孤立记录：观察窗到期后已落盘的标注。 */
  orphan: boolean;
  /** 摘要待更新（基于旧边界）。 */
  summaryStale: boolean;
}

/**
 * 事件读出口 —— 当前态 + 派生标注。
 *
 * 是 `EventRecord` 的超集（多一个 `marks`）：既有只读 `status` / `summary` 的
 * 调用方照常工作，需要标注的调用方走 `queryEventViews`。
 */
export interface EventView extends EventRecord {
  /** 读时派生的标注（不落盘）。 */
  readonly marks: EventDerivedMarks;
}

/** 事件记录顶层字段名全集 —— 校验器据此判定「未知字段」。 */
export const EVENT_FIELDS = [
  'id',
  'schema_version',
  'version',
  'status',
  'closed_reason',
  'pointers',
  'time_range',
  'assembled_at',
  'summary',
  'key_points',
  'anchors',
  'topic_lines',
  'summary_quality',
  'summary_source',
  'summary_prompt_version',
  'summary_model',
  'merged_into',
  'split_into',
  'created_by',
  'created_at',
  'channel',
  'boundary_candidates',
] as const;

/** 事件指针字段名全集。 */
export const EVENT_POINTER_FIELDS = ['id', 'channel', 'shard', 'seq'] as const;

/** 事件时间范围字段名全集。 */
export const EVENT_TIME_RANGE_FIELDS = ['started_at', 'ended_at'] as const;

/** 语义候选标记字段名全集。 */
export const EVENT_BOUNDARY_CANDIDATE_FIELDS = ['kind', 'at_pointer_id', 'marked_at'] as const;

/** 校验模式：写入边界收紧，读路径宽容。 */
export type EventParseMode = 'read' | 'write';

function fail(message: string): never {
  throw new SchemaError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, at: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(`${at} 必须是对象`);
  }
  return value;
}

function requireString(value: unknown, at: string): string {
  if (typeof value !== 'string') {
    fail(`${at} 必须是字符串`);
  }
  return value;
}

function optionalString(value: unknown, at: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, at);
}

/**
 * 可空字符串取值 —— `null` 与「字段缺失」都归一为 `null`。
 *
 * 为什么缺失也算 null：这两个溯源字段是后加的（v1.1），历史行里根本没有这两个键。
 * read 模式必须把「没有」读成「不知道」，而不是报错或伪造一个版本号。
 */
function nullableString(value: unknown, at: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireString(value, at);
}

function requirePositiveInteger(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(`${at} 必须是正整数`);
  }
  return value;
}

function requireStringArray(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) {
    fail(`${at} 必须是数组`);
  }
  return (value as unknown[]).map((item, index) => requireString(item, `${at}[${index}]`));
}

function assertKnownFields(
  obj: Record<string, unknown>,
  known: readonly string[],
  at: string,
  mode: EventParseMode,
): void {
  // read 模式宽容：未知字段多半是未来版本写进来的，不是脏数据。
  if (mode !== 'write') {
    return;
  }
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      fail(`${at} 含有未知字段 ${key}`);
    }
  }
}

/**
 * read 模式：把输入里未被消费的键原样拷进结果 —— 不裁剪。
 *
 * 判据用「结果对象已有的键」：已知字段都已归一进结果，结果里没有的键即未知字段。
 */
function carryUnknownFields(
  obj: Record<string, unknown>,
  target: object,
  mode: EventParseMode,
): void {
  if (mode !== 'read') {
    return;
  }
  const sink = target as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && !(key in sink)) {
      sink[key] = value;
    }
  }
}

/**
 * 封闭枚举取值。
 *
 * write 模式：越界即契约违约（写入边界要拦住脏枚举）。
 * read 模式：未知取值原样保留 —— 未来版本新增枚举值时旧读取器不得丢弃数据。
 */
function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  at: string,
  mode: EventParseMode,
): T {
  const text = requireString(value, at);
  if ((allowed as readonly string[]).includes(text)) {
    return text as T;
  }
  if (mode === 'read') {
    return text as T;
  }
  fail(`${at} 必须是 ${allowed.join(' / ')} 之一`);
}

/** 校验事件指针。 */
function parseEventPointer(raw: unknown, at: string, mode: EventParseMode): EventPointer {
  const obj = requireObject(raw, at);
  assertKnownFields(obj, EVENT_POINTER_FIELDS, at, mode);

  const pointer: EventPointer = { id: requireString(obj['id'], `${at}.id`) };
  const channel = optionalString(obj['channel'], `${at}.channel`);
  if (channel !== undefined) {
    pointer.channel = channel;
  }
  const shard = optionalString(obj['shard'], `${at}.shard`);
  if (shard !== undefined) {
    pointer.shard = shard;
  }
  if (obj['seq'] !== undefined) {
    const seq = obj['seq'];
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      fail(`${at}.seq 必须是非负整数`);
    }
    pointer.seq = seq;
  }

  carryUnknownFields(obj, pointer, mode);
  return pointer;
}

/** 校验事件时间范围。 */
function parseEventTimeRange(raw: unknown, at: string, mode: EventParseMode): EventTimeRange {
  const obj = requireObject(raw, at);
  assertKnownFields(obj, EVENT_TIME_RANGE_FIELDS, at, mode);

  const range: EventTimeRange = {
    started_at: requireString(obj['started_at'], `${at}.started_at`),
    ended_at: requireString(obj['ended_at'], `${at}.ended_at`),
  };

  carryUnknownFields(obj, range, mode);
  return range;
}

/** 校验语义候选标记（kind 为开放枚举，未知值原样保留）。 */
function parseBoundaryCandidate(raw: unknown, at: string, mode: EventParseMode): BoundaryCandidate {
  const obj = requireObject(raw, at);
  assertKnownFields(obj, EVENT_BOUNDARY_CANDIDATE_FIELDS, at, mode);

  const candidate: BoundaryCandidate = {
    kind: requireString(obj['kind'], `${at}.kind`),
    at_pointer_id: requireString(obj['at_pointer_id'], `${at}.at_pointer_id`),
    marked_at: requireString(obj['marked_at'], `${at}.marked_at`),
  };

  carryUnknownFields(obj, candidate, mode);
  return candidate;
}

/**
 * 校验一条事件记录。
 *
 * @param mode 'write' —— 写入路径：拦截禁字段名 + 未知顶层字段 + 必填缺失 + 封闭枚举越界
 * @param mode 'read'  —— 读取路径：未知字段（含嵌套）原样保留，不报错
 */
export function parseEvent(raw: unknown, mode: EventParseMode = 'read'): EventRecord {
  const obj = requireObject(raw, 'event');

  if (mode === 'write') {
    // 禁字段清单直接复用 experience 口径，不另造一份 —— 但必须**递归**查：
    // 只查顶层等于给嵌套开后台（`boundary_candidates[0].score` 照样能溜过去），
    // 而红线是「不得预设重要性 / 不得把聊天写成前提」，它不关心藏在第几层。
    const hits = findForbiddenFieldKeys(obj);
    if (hits.length > 0) {
      fail(
        `event 含有被禁止的字段名 ${hits.join('、')}（红线①/②：不得预设重要性、不得把聊天写成前提）`,
      );
    }
  }
  assertKnownFields(obj, EVENT_FIELDS, 'event', mode);

  const pointersRaw = obj['pointers'];
  if (!Array.isArray(pointersRaw)) {
    fail('event.pointers 必须是数组');
  }
  const pointerList = pointersRaw as unknown[];

  const candidatesRaw = obj['boundary_candidates'];
  if (!Array.isArray(candidatesRaw)) {
    fail('event.boundary_candidates 必须是数组');
  }
  const candidateList = candidatesRaw as unknown[];

  const record: EventRecord = {
    id: requireString(obj['id'], 'event.id'),
    schema_version: requirePositiveInteger(obj['schema_version'], 'event.schema_version'),
    version: requirePositiveInteger(obj['version'], 'event.version'),
    status: requireEnum(obj['status'], EVENT_STATUSES, 'event.status', mode),
    closed_reason: parseClosedReason(obj['closed_reason'], mode),
    pointers: pointerList.map((item, index) => parseEventPointer(item, `event.pointers[${index}]`, mode)),
    time_range: parseEventTimeRange(obj['time_range'], 'event.time_range', mode),
    assembled_at: requireString(obj['assembled_at'], 'event.assembled_at'),
    summary: parseSummary(obj['summary']),
    key_points: requireStringArray(obj['key_points'], 'event.key_points'),
    anchors: requireStringArray(obj['anchors'], 'event.anchors'),
    topic_lines: requireStringArray(obj['topic_lines'], 'event.topic_lines'),
    summary_quality: requireEnum(obj['summary_quality'], SUMMARY_QUALITIES, 'event.summary_quality', mode),
    summary_source: parseSummarySource(obj['summary_source'], mode),
    // 溯源两字段：可空，**不**当必填非空校验（她手写 / 未生成时就是 null）。
    summary_prompt_version: nullableString(
      obj['summary_prompt_version'],
      'event.summary_prompt_version',
    ),
    summary_model: nullableString(obj['summary_model'], 'event.summary_model'),
    created_by: requireEnum(obj['created_by'], EVENT_CREATED_BY, 'event.created_by', mode),
    created_at: requireString(obj['created_at'], 'event.created_at'),
    channel: requireString(obj['channel'], 'event.channel'),
    boundary_candidates: candidateList.map((item, index) =>
      parseBoundaryCandidate(item, `event.boundary_candidates[${index}]`, mode),
    ),
  };

  const mergedInto = optionalString(obj['merged_into'], 'event.merged_into');
  if (mergedInto !== undefined) {
    record.merged_into = mergedInto;
  }
  if (obj['split_into'] !== undefined) {
    record.split_into = requireStringArray(obj['split_into'], 'event.split_into');
  }

  carryUnknownFields(obj, record, mode);
  return record;
}

/**
 * 摘要取值校验 —— 硬上限 + 只查非空。
 *
 * 不设字数下限（「她打开了一个网页」8 字合法），也不写三要素规则检查器：
 * 「谁 / 做了什么 / 结果如何」是 prompt 指引，由 LLM 自检，不写成硬规则。
 */
function parseSummary(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  const text = requireString(value, 'event.summary');
  // 只查非空：后台未生成时是 null，空串不能冒充已生成。
  if (text.trim() === '') {
    fail('event.summary 不得是空字符串或纯空白');
  }
  // 长度按**码点**算（人读的「字」）：UTF-16 码元会把 emoji 算成两个字。
  if (summaryLengthOf(text) > SUMMARY_MAX_CHARS) {
    fail(`event.summary 超过硬上限 ${SUMMARY_MAX_CHARS} 字`);
  }
  return text;
}

/** 摘要来源取值（可为 null：尚无摘要时）。 */
function parseSummarySource(value: unknown, mode: EventParseMode): SummarySource | null {
  if (value === null) {
    return null;
  }
  return requireEnum(value, SUMMARY_SOURCES, 'event.summary_source', mode);
}

/**
 * 闭合原因取值 —— 封闭枚举 + 可空。
 *
 * `null` = 未被机械信号闭合（open 事件 / 她的修正产生或重开）。
 * write 模式：越界即契约违约；read 模式：未知值原样保留（未来版本新增枚举值时，
 * 旧读取器不得丢弃数据）。
 */
function parseClosedReason(value: unknown, mode: EventParseMode): EventClosedReason | null {
  if (value === null) {
    return null;
  }
  const text = requireString(value, 'event.closed_reason');
  if ((EVENT_CLOSED_REASONS as readonly string[]).includes(text)) {
    return text as EventClosedReason;
  }
  if (mode === 'read') {
    return text as EventClosedReason;
  }
  fail(`event.closed_reason 必须是 ${EVENT_CLOSED_REASONS.join(' / ')} 之一或 null`);
}
