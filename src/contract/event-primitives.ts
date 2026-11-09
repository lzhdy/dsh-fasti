/**
 * B 块事件开放面契约 —— `EventPrimitives`（技术基线 §7.4）。
 *
 * 为什么不并入 `FastiPrimitives`（A 块 §9 原语契约）：
 *  1. `FastiPrimitives` 是 A 块**冻结面**，既有测试断言 `PRIMITIVE_NAMES` 恰好 15 项；
 *     往里加原语就要改那个断言 → 触碰 A 块验收线；
 *  2. 事件原语是 B 块的新开放面，独立接口可独立演进（第二期话题线原语直接加在同一个接口里，
 *     不污染 A 块）；
 *  3. `Fasti` 仍是唯一门面类 —— 消费者拿到的还是一个对象，不出现"两个门面"。
 *
 * 读 / 写边界：**写原语必须经单写者队列**（与 `appendExperience` 同纪律）。
 * 读原语直接走真源 / 投影，不入队。
 */

import type { EventRecord, EventStatus, EventView } from './event.ts';

/** 事件查询条件。 */
export interface EventQueryFilter {
  readonly status?: EventStatus | undefined;
  readonly channel?: string | undefined;
  /** epoch ms，按 started_ms 过滤（含端点）。 */
  readonly time?: { readonly from?: number | undefined; readonly to?: number | undefined } | undefined;
  readonly limit?: number | undefined;
}

/** 合并入参：A + B → C。 */
export interface MergeEventsInput {
  /** ≥2 个，必须都是当前态且非退役态。 */
  readonly sourceIds: readonly string[];
  /** 新事件 id；缺省由系统分配 ULID。 */
  readonly targetId?: string | undefined;
}

/** 合并结果。 */
export interface MergeEventsResult {
  /** 新事件 C（当前态）。 */
  readonly target: EventRecord;
  /** 被退役的 A、B 的当前态。 */
  readonly retired: readonly EventRecord[];
}

/** 拆分入参：A → B1 + B2。 */
export interface SplitEventInput {
  readonly sourceId: string;
  /** 每个子事件的指针分组（按 experience id 给出；≥2 组；必须覆盖且仅覆盖 A 的指针）。 */
  readonly groups: readonly (readonly string[])[];
}

/** 拆分结果。 */
export interface SplitEventsResult {
  /** 被退役的 A（status='split'、split_into=[B1,B2]）。 */
  readonly retired: EventRecord;
  /** 子事件 B1、B2。 */
  readonly children: readonly EventRecord[];
}

/** 改边界入参：把记录挪出或挪入（即换 pointers）。 */
export interface ReviseBoundaryInput {
  readonly eventId: string;
  readonly removePointerIds?: readonly string[] | undefined;
  readonly addPointerIds?: readonly string[] | undefined;
}

/** 改边界结果。 */
export interface ReviseBoundaryResult {
  readonly event: EventRecord;
}

/** 重开入参：closed → open。 */
export interface ReopenEventInput {
  readonly eventId: string;
}

/** 重写摘要入参：她手写摘要（summary_source 置 'her'）。 */
export interface RewriteSummaryInput {
  readonly eventId: string;
  readonly summary: string;
}

/**
 * B 块事件开放面（Fasti 同时实现 `FastiPrimitives` 与本接口）。
 */
export interface EventPrimitives {
  /** 查事件当前态。 */
  queryEvents(filter?: EventQueryFilter): Promise<EventRecord[]>;
  /**
   * 查事件当前态，并**带出读时派生的标注**（§5.6：待归并 / 跨通道 / 带附件 /
   * 孤立记录 / 摘要待更新）。
   *
   * 与 `queryEvents` 分开而不合并：标注要逐条回读记录本现算，是有成本的一档；
   * 只要事实、不要标注的调用方不该替这档成本买单。
   */
  queryEventViews(filter?: EventQueryFilter): Promise<EventView[]>;
  /** 取单个事件当前态；不存在抛 NotFoundError。 */
  getEvent(id: string): Promise<EventRecord>;
  /** 取单个事件当前态 + 派生标注；不存在抛 NotFoundError。 */
  getEventView(id: string): Promise<EventView>;
  /** 取某事件的全部版本（历史留痕）；未知 id 返回空数组。 */
  listEventVersions(id: string): Promise<EventRecord[]>;

  /** 合并：A + B → C；A、B 置 merged 并带 merged_into=C。 */
  mergeEvents(input: MergeEventsInput): Promise<MergeEventsResult>;
  /** 拆分：A → B1 + B2；A 置 split 并带 split_into=[B1,B2]。 */
  splitEvent(input: SplitEventInput): Promise<SplitEventsResult>;
  /** 改边界：换 pointers，写新版本，并触发派生字段重跑。 */
  reviseEventBoundary(input: ReviseBoundaryInput): Promise<ReviseBoundaryResult>;
  /** 重开：closed → open，写新版本。 */
  reopenEvent(input: ReopenEventInput): Promise<EventRecord>;
  /** 重写摘要：summary_source='her'，写新版本。 */
  rewriteEventSummary(input: RewriteSummaryInput): Promise<EventRecord>;
}
