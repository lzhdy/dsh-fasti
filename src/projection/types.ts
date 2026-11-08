/**
 * 投影层公共类型 —— 三档引擎（L1 sqlite / L2 JSONL / L3 真源直读）共用同一套语义。
 *
 * 语义统一（用户拍板 Q1）：检索一律为「子串匹配，ASCII 大小写不敏感」。
 *  - L1：FTS5 trigram 主路径 + LIKE 回退（trigram 对 <3 字符查询不命中）；
 *  - L2：自建词法倒排 + 子串回退；
 *  - L3：真源直读，线性扫描 + 子串匹配。
 *
 * 三档结果集必须一致 —— 这正是「每级功能不丢、仅性能/丰富度下降」的机器可验形式。
 */

/** 投影行 —— 结构层全量折叠（对应 §7.1 的 experience 表）。 */
export interface ExperienceProjection {
  id: string;
  kind: string;
  channel: string;
  scene_ref: string | null;
  initiation: string | null;
  occurred_ms: number;
  recorded_ms: number;
  tick: number;
  status: string;
  /** 落点：结构层分片与行号。 */
  shard: string;
  seq: number;
}

/** 边行 —— bi-temporal 邻接表（对应 §7.1 的 edge 表）。 */
export interface EdgeProjection {
  id: string;
  src: string;
  predicate: string;
  dst: string;
  valid_ms: number | null;
  invalid_ms: number | null;
  created_ms: number;
  expired_ms: number | null;
  confidence: number | null;
  reason: string | null;
  provenance: string | null;
}

/** 投影查询条件。 */
export interface ProjectionQuery {
  kind?: string | undefined;
  channel?: string | undefined;
  scene_ref?: string | undefined;
  initiation?: string | undefined;
  status?: string | undefined;
  /** 发生时间下界（含）。 */
  occurred_from_ms?: number | undefined;
  /** 发生时间上界（含）。 */
  occurred_to_ms?: number | undefined;
  limit?: number | undefined;
}

/** 边查询条件。 */
export interface ProjectionEdgeQuery {
  src?: string | undefined;
  predicate?: string | undefined;
  dst?: string | undefined;
  /** as-of：只返回在 T 时刻有效的边。 */
  as_of_ms?: number | undefined;
}

/** 全文检索命中。 */
export interface ProjectionSearchHit {
  id: string;
  kind: string;
  channel: string;
  snippet: string;
}

/** 投影引擎档位。 */
export type ProjectionLevel = 'L1' | 'L2' | 'L3';

/**
 * 投影引擎统一接口。
 *
 * 写入侧（upsert*）在 L3 无意义 —— L3 是真源直读，投影不存在；
 * 实现方应把 L3 的 upsert 当作 no-op。
 */
export interface ProjectionEngine {
  readonly level: ProjectionLevel;

  /** 打开引擎（建表 / 读索引 / 校验可用性）。 */
  open(): Promise<void>;

  /** 关闭引擎，释放资源。 */
  close(): Promise<void>;

  /** 幂等写入一条经历投影。 */
  upsertExperience(row: ExperienceProjection): Promise<void>;

  /** 幂等写入一条边投影。 */
  upsertEdge(row: EdgeProjection): Promise<void>;

  /** 幂等写入一条全文索引（id → 可检索文本）。 */
  upsertDocument(id: string, text: string): Promise<void>;

  /** 多维查询。 */
  query(query: ProjectionQuery): Promise<ExperienceProjection[]>;

  /** 全文检索。 */
  search(keyword: string, limit?: number): Promise<ProjectionSearchHit[]>;

  /** 边查询。 */
  queryEdges(query: ProjectionEdgeQuery): Promise<EdgeProjection[]>;

  /** 全部经历投影（重建与对账用）。 */
  allExperiences(): Promise<ExperienceProjection[]>;

  /** 全部边投影。 */
  allEdges(): Promise<EdgeProjection[]>;

  /** 全部全文文档（id → 文本）。 */
  allDocuments(): Promise<Map<string, string>>;

  /**
   * 在一个事务里执行一批写入。
   *
   * L1（SQLite）：真事务 —— 失败整体回滚，不留半截数据。
   * L2（JSONL）：文件追加无法回滚，故只保证「不抛错中断」，半截状态由
   *             「需重建」标记兜底（重建会先 clear 再整体折叠）。
   * L3（真源直读）：无投影存储，事务为 no-op。
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** 清空投影内容（重建协议第 2 步：新建投影库）。 */
  clear(): Promise<void>;
}

/** 子串匹配（ASCII 大小写不敏感）—— 三档统一的检索语义。 */
export function matchesSubstring(haystack: string, needle: string): boolean {
  if (needle === '') {
    return true;
  }
  return asciiLower(haystack).includes(asciiLower(needle));
}

/** ASCII 小写化（不动非 ASCII 字符，避免改变中文原文）。 */
export function asciiLower(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[i];
  }
  return out;
}

/**
 * 生成检索片段 —— 取命中位置前后的一小段原文。
 * 只截取原文，不做摘要（定案稿 §7.1 P2 注释：索引的是原文+线索，不是摘要）。
 */
export function makeSnippet(text: string, keyword: string, radius = 40): string {
  if (keyword === '') {
    return text.slice(0, radius * 2);
  }
  const lower = asciiLower(text);
  const needle = asciiLower(keyword);
  const index = lower.indexOf(needle);
  if (index < 0) {
    return text.slice(0, radius * 2);
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + keyword.length + radius);
  return text.slice(start, end);
}
