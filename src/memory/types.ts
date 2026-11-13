/**
 * 记忆层类型 —— 方案 §4.2 冻结的接口全集。
 *
 * 行类型字段与 §3.2 列一一对应（camelCase 映射 snake_case 列名）；
 * 账本类型（RevisionRecord / DecisionRecord）按 §3.4 / §3.5 原样 snake_case。
 * 时间一律毫秒（ms）；可空性以 `| null` 显式标注。
 */

/** v1 轻卡类型域（CHECK 约束取值域，方案 §3.2）。 */
export type CardType = 'event';

/** 审计探针类型域（方案 §3.2 mem_audit_item.probe_type）。 */
export type ProbeType = 'gold' | 'decoy' | 'consistency' | 'provenance';

/**
 * 轻卡行 —— 零正文（方案 §3.2 mem_card）。
 *
 * anchor_json 是权威锚点（真源经历 id 列表的 JSON 字符串数组）；
 * event_id 仅作解析缓存（D.3）。任何文本列不得含事件摘要/正文/情绪/会话字段。
 */
export interface MemoryCard {
  /** 确定性派生 id：'mc_'+sha256(规范化串).slice(0,32)（§4.6）。 */
  cardId: string;
  /** 解析缓存：事件 UID（真锚点看 anchorJson）。 */
  eventId: string;
  /** JSON 字符串数组：event.anchors 快照（真源经历 id 列表），权威锚点。 */
  anchorJson: string;
  channel: string;
  cardType: CardType;
  /** v1 仅 selected；预留 excluded 不建流程。 */
  selection: 'selected' | 'excluded';
  /** 观测列，初值中性 0；取值 [0,1]。 */
  weight: number;
  /** JSON 数组：1..3 个规范化短线索。 */
  displayCuesJson: string;
  /** JSON 数组 [{term, source, sensitive}]，与 mem_alias 同源快照。 */
  aliasesJson: string;
  /** 消歧短句，码点长度 <=40，只写区别性信息不写叙事。 */
  discriminator: string;
  /** v1 恒 NULL；实体倒排演进项预留，不允许填值。 */
  entityHintJson: null;
  /** 事件 time_range 起点（ms）。 */
  occurredMs: number;
  /** 事件 time_range 终点（ms）。 */
  endedMs: number;
  /** 双时间：选择索引内部失效管理（§3.3），不回写 edge 表（ms）。 */
  validMs: number;
  /** NULL=仍有效（ms）。 */
  invalidMs: number | null;
  /** 行创建时刻（ms）。 */
  createdMs: number;
  /** 行作废时刻（tombstone 记账用），NULL=未作废（ms）。 */
  expiredMs: number | null;
  status: 'active' | 'invalid' | 'superseded';
  /** 锚点+线索字段规范化后的 sha256，幂等与账本核对用。 */
  contentHash: string;
  /** 写侧 ROI 观测列，v1 仅离线回放更新。 */
  hitCount: number;
  /** 最近命中时刻（ms），NULL=从未命中。 */
  lastHitMs: number | null;
  schemaVersion: number;
}

/** 别名词表行（方案 §3.2 mem_alias）。 */
export interface AliasRow {
  /** 规范化词（小写/全半角/空白折叠），不存原始问句。 */
  termNorm: string;
  cardId: string;
  source: 'miss';
  /** 隐私标记：1 则不进 FTS 文本、仅精确匹配可用。 */
  sensitive: 0 | 1;
  status: 'active' | 'tombstoned';
  /** 创建时刻（ms）。 */
  createdMs: number;
  hitCount: number;
  /** 最近命中时刻（ms），NULL=从未命中。 */
  lastHitMs: number | null;
}

/**
 * 事务变更集（方案 §4.3 transactionApply 入参，最小形状）。
 *
 * 卡与别名按主键 upsert；FTS 文本由卡内 cues + 活跃非敏感别名派生（同源快照）。
 */
export interface CardChangeSet {
  cards: readonly MemoryCard[];
  aliases: readonly AliasRow[];
}

/**
 * 漏召观测入参 —— 白名单字段（方案 §4.9）。
 *
 * 类型里不存在任何原始查询文本字段；term_hash 由函数内部计算。
 */
export interface MissObservationInput {
  termNorm: string;
  channel: string;
  /** 当时窗口上下文事件，可空。 */
  anchorEventId: string | null;
  /** 上下文经历 id 快照，可空。 */
  anchorIds: readonly string[] | null;
  /** 当次检索返回数（0=纯漏召）。 */
  returnedCount: number;
  /** 观测时刻（ms）。 */
  observedMs: number;
}

/** 离线审计运行（方案 §3.2 mem_audit_run）。 */
export interface AuditRunRecord {
  runId: string;
  /** 运行时刻（ms）。 */
  createdMs: number;
  sampleN: number;
  /** 金标夹具版本。 */
  probeSetVersion: string;
  /** 回放所用判定规则版本标识；可空。 */
  modelTag: string | null;
  /** §2.3 全量指标快照（JSON 文本）。 */
  metricsJson: string;
  /** 备注（JSON 文本），N/A 项计数在此。 */
  notesJson: string;
}

/** 离线审计条目（方案 §3.2 mem_audit_item）。N/A 项不写行、只在 run.notes 计数。 */
export interface AuditItemRecord {
  runId: string;
  itemNo: number;
  probeType: ProbeType;
  expectedRef: string | null;
  /** 返回引用列表（JSON 文本）。 */
  returnedRefsJson: string;
  passed: 0 | 1;
  /** 明细（JSON 文本）。 */
  detailJson: string;
}

/** 迁移/构建账本行（方案 §3.4，append-only revisions.jsonl）。 */
export interface RevisionRecord {
  /** 单调递增，1 起。 */
  revision: number;
  /** 动作标识。 */
  slug: 'schema-init' | 'build' | 'rebuild' | 'stamp';
  /** 记账时刻（ms）。 */
  at_ms: number;
  schema_version: number;
  /** 真值分片 sha256 的有序聚合哈希（experiences+events，含文件名）。 */
  truth_fingerprint: string;
  prior_revision: number | null;
  /** 本次落盘后 active 卡数。 */
  card_count: number;
  alias_count: number;
  /** 全量 mem_card 规范化行哈希的聚合，幂等性核对用。 */
  row_hash_sum: string;
  /** 影子库比对结果。 */
  shadow_diff: { added: number; removed: number; changed: number };
  /** 触发原因（cli 参数/决策行 id）。 */
  reason: string;
  operator: 'offline-cli';
}

/** 决策台账行（方案 §3.5，append-only decisions.jsonl，D4 格式预对齐，不是 P8）。 */
export interface DecisionRecord {
  /** ULID。 */
  decision_id: string;
  /** 决策时刻（ms）。 */
  at_ms: number;
  action: 'create-card' | 'update-cues' | 'tombstone-card' | 'add-alias' | 'invalidate';
  card_id: string | null;
  event_id: string;
  /** 经历 id 列表（JSON 字符串数组）。 */
  anchor_json: string;
  /** 决策时锚点快照哈希。 */
  content_hash: string;
  /** 决策规则/模型标识 + prompt 版本。 */
  model_tag: string;
  /** 简短理由码+一句话，不复制原文。 */
  reason: string;
  created_by: 'her';
}

/**
 * 检索排序结果（方案 §4.4）—— 分数构成可解释，provenance 审计直接消费 scoreParts。
 */
export interface RankedCard {
  card: MemoryCard;
  scoreParts: { bm25: number; recency: number };
  matchedTerms: string[];
}

/** SearchResultCard —— RankedCard 的契约别名（§4.2 清单名）。 */
export type SearchResultCard = RankedCard;

/**
 * 召回命中通道（#44 布尔门，S1 联合类型）：
 *  - exact-alias：规范化后与某 active 别名 term_norm 严格等值（sensitive=1 仅此路可达）；
 *  - fts-substring：trigram FTS MATCH 后经 matchesSubstring 精确复核的子串命中；
 *  - like-fallback：短查询/FTS 失败时的 `%q%` 宽松 LIKE 回退（弱通道）。
 * 同卡多通道命中取并集，门判定按“最强通道”裁决。
 */
export type MatchKind = 'exact-alias' | 'fts-substring' | 'like-fallback';

/** 可解释检索结果：在 RankedCard 上附加命中通道与 FTS 复核所用的 cue_text（供布尔门做词边界判定）。 */
export interface ExplainedRankedCard extends RankedCard {
  /** 该卡命中的全部通道，按固定优先级排序（exact → fts → like），确定性输出。 */
  matchKinds: MatchKind[];
  /**
   * FTS 复核时读取的 cue_text 库内形（仅 fts-substring 命中时非空）；门函数入口统一再规范化。
   * exact/like 路径为 undefined。纯函数门不持库柄，所需文本由检索层在此携带。
   */
  cueText?: string;
}

/** 布尔门裁决状态（#44）：hit=至少一卡过强通道；abstain=有候选但全被拒；no-match=无词面候选/空查询。 */
export type GatedStatus = 'hit' | 'abstain' | 'no-match';

/** 受控原因码（客观、稳定、可观测；不写原始查询、无情绪措辞）。 */
export type GateReasonCode =
  | 'empty-query'
  | 'zero-lexical-hit'
  | 'all-rejected'
  | 'exact-alias-pass'
  | 'fts-word-boundary-pass'
  | 'ascii-no-word-boundary'
  | 'like-only-weak-match'
  | 'missing-cue-text';

/** 通过布尔门后的候选：在可解释候选上附加门原因。evidence 第一层恒 undefined（连续分演进项占位）。 */
export interface GatedRankedCard extends ExplainedRankedCard {
  gateReasons: GateReasonCode[];
  /** 演进项占位：未来连续有界证据分承载位，第一层不填（恒 undefined），预留以避免未来破 API。 */
  evidence?: number;
}

/** 布尔门一次检索的完整裁决结果（含被拒候选，不静默丢弃，供可解释与漏召统计）。 */
export interface GatedSearchOutcome {
  status: GatedStatus;
  /** 过门候选，保持检索 score 排序并已按调用方 limit 截断。 */
  accepted: GatedRankedCard[];
  /** 被拒候选全集（不截断），每张附原因码。 */
  rejected: GatedRankedCard[];
  /** 仅 no-match/abstain 携带的汇总原因；hit 时为 undefined。 */
  reason?: 'empty-query' | 'zero-lexical-hit' | 'all-rejected';
  /** 对截断后 accepted 建的请求级 1..n 私有序号（复用 serial.ts，不落库）。 */
  serialMap: SerialMap;
}

/**
 * 检索入参（C3 裁决 G1 增补，形状冻结见方案 §4.2 / §11.6；既有类型零改动）。
 *
 * text 为原始查询文本，规范化在检索函数内做（§4.4）；
 * atMs 必填，是候选过滤与近因衰减的唯一注入时钟，检索函数内禁止 Date.now()；
 * limit 可选、缺省不截断：top-k 是上层/harness 策略（§6.2 k=3 由调用方传入）。
 */
export interface SearchQuery {
  text: string;
  atMs: number;
  limit?: number;
}

/** 请求级私有序号映射（方案 §4.7）：1..n -> card_id，不落库、不跨请求复用。 */
export type SerialMap = ReadonlyMap<number, string>;

/** 槽位制窗口规格（方案 §4.8）。700 字与一轮补取是结构常量，非观测值。 */
export interface WindowSpec {
  /** 不传默认 700（D2 结构常量）。 */
  hardCapChars: number;
  /** 字面量 1，类型层面固定。 */
  maxRefetchRounds: 1;
  /** 起点 3 卡 + 1 摘要位（摘要位 v1 留空常量）。 */
  startingCards: 3;
}

/** 装配结果（方案 §4.8）—— 只给 card_id 与预算占用，不含正文。 */
export interface AssembledWindow {
  slots: ReadonlyArray<{
    slot: 'guaranteed' | 'recency' | 'identity' | 'relevance' | 'obligation';
    cardIds: string[];
  }>;
  /** 码点口径，与真源 char_count 计数一致。 */
  totalChars: number;
  /** 完整回合保持标记。 */
  turnsWhole: boolean;
  /** 至多一次；true 时带 reasonCode。 */
  needRefetch: boolean;
  refetchReason?: string;
}

/**
 * 真值指纹（方案 §4.6④）：真值分片相对路径排序后逐文件 sha256(字节) 再聚合。
 */
export interface TruthFingerprint {
  /** 相对数据根的分片路径（已排序）+ 各文件字节 sha256。 */
  files: ReadonlyArray<{ path: string; sha256: string }>;
  /** 有序聚合哈希（含文件名）。 */
  aggregate: string;
}