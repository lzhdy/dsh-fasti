/**
 * 接口原语契约 —— 定案稿 §9 的全部原语（阶段 0 交付物之一）。
 *
 * 纪律（审计口径 3）：每个原语的入参、返回、同步/异步、抛错约定在此定死。
 * 缺指针、越界、坏哈希一律抛错，不返回空。
 *
 * 阶段 0–2 的实现范围：
 *  - 已实现：registerChannel / appendExperience / query / search / queryEdges /
 *            resolvePointer / tick / rebuildProjections / verifyIntegrity / verifyChannel
 *  - 阶段 3+ 才实现：ingestMedia / preserveMedia / getMedia / queryEntity
 *    （资产层与实体表属完整投影集，不在阶段 0–2 最小集内）
 */

import type { ChannelDescriptor } from './channel.ts';
import type { Experience, Pointer } from './experience.ts';

/**
 * appendExperience 的入参。
 *
 *  - `recorded_at` 可省略：省略时由 A 分配当前时刻（定案稿 §9「appendExperience 分配
 *    recorded_at/tick」）；显式提供时予以保留 —— 定案稿 §12 的转写要求
 *    recorded_at=ingested_at（原文进入真源的时刻），一律覆盖会让系统轴失真。
 *    落盘后永不改写（定案稿 §5：系统轴「永不」）。
 *  - `tick` 始终由 A 分配（摄入序号），调用方不得指定 —— 否则会破坏单调性。
 */
export type AppendExperienceInput = Omit<Experience, 'recorded_at' | 'tick'> & {
  recorded_at?: string;
};

/** 原语名全集 —— 测试据此核对 §9 是否齐备。 */
export const PRIMITIVE_NAMES = [
  'registerChannel',
  'appendExperience',
  'ingestMedia',
  'preserveMedia',
  'query',
  'search',
  'queryEntity',
  'queryEdges',
  'resolvePointer',
  'getMedia',
  'tick',
  'rebuildProjections',
  'verifyIntegrity',
  'verifyChannel',
] as const;

export type PrimitiveName = (typeof PRIMITIVE_NAMES)[number];

/** 阶段 0–2 内不实现、调用时抛 NotImplementedError 的原语。 */
export const DEFERRED_PRIMITIVES = ['ingestMedia', 'preserveMedia', 'getMedia', 'queryEntity'] as const;

/** 时间过滤区间（毫秒口径，投影层统一毫秒）。 */
export interface TimeRange {
  /** 含。 */
  from?: number;
  /** 含。 */
  to?: number;
}

/** 多维查询条件（定案稿 §9 query 原语）。 */
export interface QueryFilter {
  time?: TimeRange;
  kind?: string;
  channel?: string;
  scene?: string;
  initiation?: string;
  status?: string;
  limit?: number;
}

/** 边查询条件（bi-temporal 邻接表）。 */
export interface EdgeQuery {
  src?: string;
  predicate?: string;
  dst?: string;
  /** as-of：查询「在 T 时刻有效」的边。 */
  asOf?: number;
}

/**
 * 边 —— 投影边表的一行（定案稿 §7.1 P4 edge 表）。
 *
 * queryEdges 返回**边本身**而非边的源经历：as-of「她在 T 时刻相信什么」
 * 依赖的是边的 valid_ms / invalid_ms / confidence / reason —— 这些属性只在边行上。
 */
export interface EdgeView {
  /** 边的确定性内部 id —— 只由 (src, predicate, dst) 决定，重建前后恒定。 */
  id: string;
  /** 源经历 id（指向真源中的经历）。 */
  src: string;
  /** 关系类型（开放枚举）。 */
  predicate: string;
  /** 目标（经历 id / 实体 id / 外部引用）。 */
  dst: string;
  /** 关系开始有效的时刻；null = 未知。 */
  valid_ms: number | null;
  /** 关系失效的时刻；null = 仍然有效。 */
  invalid_ms: number | null;
  /** 该行进入投影的时刻。 */
  created_ms: number;
  /** 该行作废的时刻；null = 未作废。 */
  expired_ms: number | null;
  /** 置信度；null = 未给出。 */
  confidence: number | null;
  /** 成因 / 依据说明。 */
  reason: string | null;
  /** 该行的来源标记。 */
  provenance: string | null;
}

/** 解析结果：原文行。 */
export interface ResolvedPointer {
  /** 命中的原文行（可能多于一条，指针含区间时）。 */
  turns: Array<{
    channel: string;
    shard: string;
    seq: number;
    event_id: string;
    raw_text: string;
  }>;
}

/** 全文检索命中。 */
export interface SearchHit {
  id: string;
  kind: string;
  channel: string;
  /** 命中片段（原文片段，非摘要）。 */
  snippet: string;
}

/** 重建结果。 */
export interface RebuildResult {
  /** 重建后的经历条数。 */
  experiences: number;
  /** 重建后的边条数。 */
  edges: number;
  /** 重建后的 FTS 文档数。 */
  documents: number;
  /** 对账报告。 */
  reconciliation: ReconciliationReport;
}

/** 对账报告（定案稿 §7.3 第 3 步）。 */
export interface ReconciliationReport {
  /** 真源原文行总数。 */
  rawTurns: number;
  /** kind='dialogue' 的经历数。 */
  dialogueExperiences: number;
  /** 原文行数与 dialogue 经历数是否相等。 */
  rawVsDialogueMatch: boolean;
  /** 各通道经历数。 */
  perChannel: Record<string, number>;
  /** 各通道经验数与 channels.json 声明是否一致（通道未注册即视为不一致）。 */
  channelsMatch: boolean;
  /** 媒体引用数与资产数（阶段 0–2 未实现资产层 → 显式标注 N/A）。 */
  mediaVsAsset: { applicable: boolean; reason: string; mediaRefs: number; assets: number | null };
}

/** 完整性校验结果。 */
export interface IntegrityReport {
  /** 校验的条目数。 */
  checked: number;
  /** 哈希不匹配的行。 */
  mismatched: Array<{ location: string; expected: string; actual: string }>;
  ok: boolean;
}

/** 通道校验结果。 */
export interface ChannelVerification {
  id: string;
  registered: boolean;
  experiences: number;
  rawTurns: number;
  ok: boolean;
  notes: string;
}

/**
 * A 块对外的全部原语。
 *
 * 全部为异步：真源写入涉及文件 I/O 与单写者队列。
 */
export interface FastiPrimitives {
  /**
   * 注册通道（写入数据文件 + 投影同步）。
   * 重复注册同 id：内容等价 → 幂等返回；不等价 → 抛 ConflictError。
   */
  registerChannel(descriptor: ChannelDescriptor): Promise<ChannelDescriptor>;

  /**
   * 追加真源（通道无关）。分配 recorded_at 与 tick，校验 schema_version。
   * 以 id 为幂等键：重复 append 同 id 视为重试，返回既有条目、不重复写、不报错。
   */
  appendExperience(experience: AppendExperienceInput): Promise<Experience>;

  /** 摄入媒体（full/notice：字节进 staging；reference-only：仅登记 origin）。阶段 3+。 */
  ingestMedia(bytes: Uint8Array | undefined, meta: Record<string, unknown>): Promise<never>;

  /** staging → assets，留一条 action 经历；只有她可调。阶段 3+。 */
  preserveMedia(refId: string): Promise<never>;

  /** 经历流多维查询（channel 是一等维度）。 */
  query(filter: QueryFilter): Promise<Experience[]>;

  /** 全文检索（降级时走词法）。 */
  search(keyword: string, limit?: number): Promise<SearchHit[]>;

  /** 实体查询。阶段 3+（实体表属完整投影集）。 */
  queryEntity(id: string): Promise<never>;

  /**
   * 边查询；as-of 支持「她在 T 时刻相信什么」。
   *
   * 返回**边行**（含 valid_ms / invalid_ms / confidence / reason）——
   * as-of 语义依赖边的有效期窗，故不能只返回边的源经历。
   * 需要源经历内容时，用返回行里的 `src`（经历 id）再调 `query`。
   */
  queryEdges(query: EdgeQuery): Promise<EdgeView[]>;

  /** 指针解析 → 原文行。缺指针或越界一律抛错。 */
  resolvePointer(pointer: Pointer): Promise<ResolvedPointer>;

  /** 取媒体字节 + 元数据。阶段 3+。 */
  getMedia(refId: string): Promise<never>;

  /**
   * 她的节拍序号 —— **已分配的最大 tick**（即最后一条经历所用的 tick）。
   *
   * 口径澄清（审计 Q2）：返回值是「当前已分配的最大 tick」，不是「下一个将分配的序号」。
   * 空真源时返回 -1（尚未分配过任何 tick）；写入一条（tick=0）后返回 0。
   *
   * 下一个将分配的序号 = 返回值 + 1；它只在 A 内部有意义，不对外暴露。
   */
  tick(): Promise<number>;

  /** 重建投影（可指定范围）。 */
  rebuildProjections(scope?: { channels?: string[] }): Promise<RebuildResult>;

  /** 哈希校验。 */
  verifyIntegrity(refId?: string): Promise<IntegrityReport>;

  /** 通道校验。 */
  verifyChannel(channelId?: string): Promise<ChannelVerification[]>;
}
