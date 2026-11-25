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
 * 当前投影规则版本（决策行 model_tag / schema_meta.rules_version 比对口径）。
 * 投影盖过期版本戳 → drain 判 rebuild-required，零写入（§2.5 R-18）。
 */
export const CURRENT_RULES_VERSION = 'rules-v1';

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
  /** 卡片内容摘要哈希：同输入面自比/幂等核对，不承担失效判定（结构变化见 structuralHash）。 */
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
 * 漏召观测入参 —— 白名单字段（方案 §4.9 + #117 外审 N-1）。
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
  /** 当次检索返回数（0=纯漏召；v1 保留位，恒 0）。 */
  returnedCount: number;
  /** 观测时刻（ms）。 */
  observedMs: number;
  /**
   * 门裁决状态（#117 N-1 分拣位）：
   * - no-match：零词法命中（词表根本没有相关词 → 可能是新领域词）；
   * - abstain：粗召回有候选但被门全拒（有词但不够可信 → 多为别名缺口）。
   * 两类缺口的补词动作不同，故落库时分开记账，供 #120 建议器按类出清单。
   */
  gateStatus: MissGateStatus;
}

/** 门裁决状态枚举（与 mem_miss.gate_status CHECK 约束一一对应）。 */
export type MissGateStatus = 'no-match' | 'abstain';

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
  /**
   * 动作码。前五者是卡/别名决策（D4 契约）；`miss-retention` 是 #117 引入的
   * **维护动作行**（系统裁剪 mem_miss，非卡决策）：event_id/anchor_json 占位空串，
   * content_hash 承载 kept 集合内容哈希，聚合量见 missRetention 字段。
   */
  action: 'create-card' | 'update-cues' | 'tombstone-card' | 'add-alias' | 'invalidate' | 'miss-retention';
  card_id: string | null;
  event_id: string;
  /** 经历 id 列表（JSON 字符串数组）。 */
  anchor_json: string;
  /** 决策时卡片内容摘要快照（同输入面自比，不做失效判定）。 */
  content_hash: string;
  /**
   * 结构快照哈希（six 输入面：anchors/channel/时间窗/eligibility/rules_version），
   * applied 集回放键 `event_id:structural_hash` 据此派生。历史行缺该字段按未 applied 处理；
   * 非建卡决策（add-alias/invalidate）可置空串。
   */
  structural_hash?: string;
  /** 决策规则/模型标识 + prompt 版本。 */
  model_tag: string;
  /** 简短理由码+一句话，不复制原文。 */
  reason: string;
  /** 行为主体：`her`＝她的决策；`system`＝系统维护动作（#117 裁剪）。 */
  created_by: 'her' | 'system';
  /**
   * 维护动作聚合量（#117 裁定：台账只放聚合量，严禁词面/term_hash/anchor 明细）。
   * 仅 action='miss-retention' 行携带。
   */
  missRetention?: {
    readonly asOfMs: number;
    readonly cutoffMs: number;
    readonly windowDays: number;
    readonly hardCapK: number;
    readonly totalBefore: number;
    readonly droppedAgeOut: number;
    readonly droppedOverflow: number;
    readonly kept: number;
    readonly windowCompressed: boolean;
    readonly keptContentHash: string;
  };
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
 *  - fts-substring（rules-v1）：unicode61 bigram FTS MATCH 后经 matchesSubstring 精确复核的子串命中；
 *  - fts-overlap（rules-v2，#126）：bigram 单元 OR MATCH 的宽召回重叠命中，不含裁决意味，
 *    是否过门交由 gate v2 反向包含谓词裁定；
 *  - like-fallback：短查询/FTS 失败时的 `%q%` 宽松 LIKE 回退（弱通道）。
 * 同卡多通道命中取并集，门判定按“最强通道”裁决。
 */
export type MatchKind = 'exact-alias' | 'fts-substring' | 'fts-overlap' | 'like-fallback';

/** 可解释检索结果：在 RankedCard 上附加命中通道与 FTS 复核所用的 cue_text（供布尔门做词边界判定）。 */
export interface ExplainedRankedCard extends RankedCard {
  /** 该卡命中的全部通道，按固定优先级排序（exact → fts → like），确定性输出。 */
  matchKinds: MatchKind[];
  /**
   * FTS 复核时读取的 cue_text 库内形（fts 类命中时非空）；门函数入口统一再规范化。
   * exact/like 路径为 undefined。纯函数门不持库柄，所需文本由检索层在此携带。
   */
  cueText?: string;
  /**
   * rules-v2 反向包含证据长度（#126）：被查询完整包含的最长线索字段的规范化码点数。
   * 仅 v2 路径 fts-overlap 命中携带；v1 路径恒 undefined（加字段不删字段，v1 形状零漂移）。
   */
  containmentLength?: number;
  /**
   * rules-v2 裁决用结构化词面字段（#126）：原文 display_cues＋非敏感活跃别名的未拼接数组，
   * 供 gate v2 逐字段做反向包含（拼接 cueText 无法可靠还原含空格字段）。仅 v2 路径填充，v1 恒缺省。
   */
  lexicalFields?: string[];
}

/**
 * 布尔门裁决状态（#44；#129 起 V2 语义调整）：
 * hit=至少一卡合格；abstain=有候选但全被拒（仅 rules-v1 路径产出，V2 已并入 no-match）；
 * no-match=无词面候选/空查询/合格集为空。
 */
export type GatedStatus = 'hit' | 'abstain' | 'no-match';

/**
 * 影子观测口径标记（#114 附录 E.4.2）：
 *  - gated-full：更名后新写样本，candidateCount 是门过滤前全集长度，可用于全集统计；
 *  - legacy-limited：历史旧行读时标注（旧计数经 limit 截断），candidateCount 不可重建为 null，
 *    Q4 只取同口径段，两段禁止加总。
 * observing 是对外信封状态、不是门裁决结果，严禁并入本联合或 GatedStatus。
 */
export type CountScope = 'gated-full' | 'legacy-limited';

/** 受控原因码（客观、稳定、可观测；不写原始查询、无情绪措辞）。 */
export type GateReasonCode =
  | 'empty-query'
  | 'zero-lexical-hit'
  | 'all-rejected'
  | 'exact-alias-pass'
  | 'fts-word-boundary-pass'
  | 'ascii-no-word-boundary'
  | 'like-only-weak-match'
  | 'missing-cue-text'
  // #126 rules-v2 反向包含裁决原因码（v1 路径不产出）。
  | 'reverse-containment-pass'
  | 'no-containment'
  // #129 排序化后严格优超/tie 弃权已废：两枚举保留备查（冻结词表不删码），V2 不再产出。
  | 'tie-no-strict-leader'
  | 'not-strict-leader'
  // #127 阶段1.5 时间槽原因码（仅 V2 路径产出；v1 不读取 TimeConstraint）。
  // #131 起时间窗摘出热路径、不再否决删卡：time-conflict 枚举冻结保留备查但 V2 永久不可达；
  // WINDOW/CANDIDATES 词面合格卡一律留痕放行（time-window-ignored），UNCERTAIN 仍 time-uncertain-ignored。
  | 'time-conflict'
  | 'time-uncertain-ignored'
  | 'time-window-ignored'
  // W3-1（#213）P2 局部聚集度谓词原因码：locality.ts 纯函数已就位但默认不接线，
  // applyGateV2 当前不产出这两个码；待随机空模型冻结表与预注册 §9 放行后方可上热路径。
  | 'locality-pass'
  | 'conflict-abstain';

/**
 * #130 截窗槽位标记（与 rank.ts SlotTag 同字面量联合，结构同形不互引：types 是无环纯类型基座，
 * rank 单向依赖 types，故此处独立声明联合，靠结构兼容与 gate/rank 测试锁同步）。
 *  - marked：weight>0 的置顶卡；ranked：其余过门卡；explore：8:2 探索位（零采用新卡随机抽出）。
 *
 * #178（P-a）语义收窄：门控路径 `applyGateV2` 已废掉随机探索位，只产出 marked（她的复盘标记，恒置顶）
 * 与 ranked（证据三元组定序），explore 恒 0；`explore` 字面量保留给浏览端口（rank.composeView），
 * 不再出现在精确检索信封里。v1 冻结路径仍恒 undefined。
 */
export type GatedSlotTag = 'marked' | 'ranked' | 'explore';

/** #130 槽位汇总（结构同形 rank.ts ViewSlots，随 V2 hit 信封产出；v1 不产出该字段）。 */
export interface GatedViewSlots {
  readonly marked: number;
  readonly ranked: number;
  readonly explore: number;
  /** 探索位名义名额（ceil 规则）与实际填充（池不足时如实暴露缺口，绝不造卡）。 */
  readonly exploreWanted: number;
  readonly exploreFilled: number;
}

/** 通过布尔门后的候选：在可解释候选上附加门原因。evidence 第一层恒 undefined（连续分演进项占位）。 */
/**
 * P0 分级词面信号向量（#193）：纯整数留痕，不参与任何裁决/排序。
 * 算法在 lexical-signals.ts；此处只声明 DTO 形状，供门后卡与审计报告携带。
 */
export interface GradedSignals {
  /** 与任一字段的最长公共连续码点数。 */
  lcs: number;
  /** 被至少一个字段包含的查询单元数 c。 */
  unitCovered: number;
  /** 查询单元总数 m（emitUnits 口径）。 */
  unitTotal: number;
  /** 含至少一个查询单元的字段数。 */
  hitFields: number;
  /** LCS≥3 的字段数。 */
  strongFields: number;
  /** 命中字段中最短者码点数（无命中为 0）。 */
  minHitFieldLength: number;
  /** 命中字段中最长者码点数（无命中为 0）。 */
  maxHitFieldLength: number;
}

export interface GatedRankedCard extends ExplainedRankedCard {
  gateReasons: GateReasonCode[];
  /** 演进项占位：未来连续有界证据分承载位，第一层不填（恒 undefined），预留以避免未来破 API。 */
  evidence?: number;
  /** #130 截窗槽位：仅 applyGateV2 产出；v1 冻结路径恒 undefined（零漂移）。#178 起只会是 'marked' 或 'ranked'。 */
  slot?: GatedSlotTag;
  /**
   * P0 分级词面信号（#193）：只在审计侧按需填充，生产门路径恒 undefined（零热路径开销、零判据影响）。
   * 任何把它接进 accept/reject 或排序键的用法都属判据变更，必须另走预注册 §9。
   */
  gradedSignals?: GradedSignals;
  /**
   * rules-v3 局部聚集度见证五元组（#227，仅 applyGateV3 的 locality-pass 路径填充）：
   * 全整数、可逐题手算复核；v1/v2 路径恒缺省，加字段不删字段保证旧信封零漂移。
   */
  localityDetail?: {
    readonly fieldIndex: number;
    readonly m: number;
    readonly rareCount: number;
    readonly span: number;
    readonly gap: number;
  };
}

/** 布尔门一次检索的完整裁决结果（含被拒候选，不静默丢弃，供可解释与漏召统计）。 */
export interface GatedSearchOutcome {
  status: GatedStatus;
  /**
   * 门过滤前的词面候选全集条数（applyGate 入参 candidates.length，#114）。
   * 与 accepted 不同：accepted 已过门裁决且按 limit 截断；本字段不受 limit 影响，
   * 供影子观测在不二次检索的前提下记录门控口径（gated-full）全集规模。加字段不删字段。
   */
  candidateCount: number;
  /**
   * 过门候选。v1 保持检索 score 排序；#129 起 V2 为 rankCards 字典序
   * （weight→strength→occurred→cardId），均已按 limit（V2 缺省 10）截断。
   */
  accepted: GatedRankedCard[];
  /** 被拒候选全集（不截断），每张附原因码。 */
  rejected: GatedRankedCard[];
  /** 仅 no-match/abstain 携带的汇总原因；hit 时为 undefined。tie-no-strict-leader 仅历史 v2 严格优超期产出，#129 起 V2 不可达。locality-conflict 仅 rules-v3 组级冲突弃权产出（#227）。 */
  reason?: 'empty-query' | 'zero-lexical-hit' | 'all-rejected' | 'tie-no-strict-leader' | 'locality-conflict';
  /** 对截断后 accepted 建的请求级 1..n 私有序号（复用 serial.ts，不落库）。 */
  serialMap: SerialMap;
  /** #130 截窗槽位汇总：仅 applyGateV2 hit 时产出；v1 与非 hit 分支恒 undefined。 */
  slots?: GatedViewSlots;
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

// ===========================================================================
// #127 阶段 1.5 时间表达式硬约束 —— P0 冻结契约（2026-11-19，只加不删）。
//
// 四层结构：time-lexicon（L0 数据词表）→ time-expr（L1 词法 + L2 文法产 TIR，
// 不读时钟、不含毫秒）→ time-resolve（L3 整数日历求解 + L4 proveClosure 证明门，
// 全栈唯一读取 TimeAnchor 处）→ gate V2 时间槽布尔裁决。
// 本块类型在批 1 一次性冻结；批 2-4 只允许新增不允许改形，改形须主控重拍。
// ===========================================================================

/**
 * 时间资产版本三元组：词表（说法增删）、文法（规则增删）、策略（硬编码 policy）
 * 各自独立版本号。三者全部进 replayKey；任一 bump，历史 golden 必须可重放对账。
 */
export interface TimeAssetVersions {
  /** 词表资产版本（time-lexicon 数据面）。 */
  readonly lexicon: string;
  /** 文法资产版本（time-expr 规则面）。 */
  readonly grammar: string;
  /** 策略资产版本（时区/日界/周开篇等冻结 policy）。 */
  readonly policy: string;
}

/**
 * 时间零件唯一允许读取的外部环境（#127 闭合证明的输入端）。
 *
 * - 零件内禁止读系统时钟、宿主 TZ、`new Date(字符串)`、Intl.*；
 * - zoneId/weekStartsOn 首期为字面量唯一值（中国大陆 UTC+8 无 DST、周一开篇），
 *   跨时区 civilDateTime 已挂账，放开前联合域不得扩口；
 * - tzdata/农历等重资产首期不建，assets 只留版本位。
 */
export interface TimeAnchor {
  /** 装配层 deps.now() 注入的当前时刻（ms），零件内不得自取时钟。 */
  readonly epochMs: number;
  /** 固定 IANA 时区；首期唯一合法值。 */
  readonly zoneId: 'Asia/Shanghai';
  /** 周一为一周首日（ISO 口径 1=周一…7=周日）；首期字面量固定为 1。 */
  readonly weekStartsOn: 1;
  /** 资产版本快照，随每次解析落 provenance。 */
  readonly assets: TimeAssetVersions;
}

/** 原文切片：UTF-16 码元半开区间 [start,end)，与 String.slice 同口径。 */
export type TextSpan = readonly [start: number, end: number];

/**
 * 时间表达在句中的言语角色（G 类内容型时间处置依据）。
 *
 * - FILTER：检索过滤诉求（"周六的野餐"）；
 * - CONTENT：叙事内容（"她提醒我周五交表"），仲裁不对称——只降级不升级；
 * - QUESTION_FOCUS：疑问焦点（"几点/什么时候"），问的是答案不是过滤窗；
 * - UNKNOWN：角色证据不足，与 CONTENT 同权处置（宁空勿错，错杀率=0）。
 */
export type TimeRole = 'FILTER' | 'CONTENT' | 'QUESTION_FOCUS' | 'UNKNOWN';

/** 星期序（ISO：1=周一 … 7=周日）。 */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * 符号化日期原子（TIR 的载荷）：刻意只含 civil 整数，不含任何毫秒。
 *
 * - REL_DAY：相对今天的天偏移（0=今天，-1=昨天，+1=明天）；
 * - WEEKDAY_OF_WEEK：周偏移 + 星期序（weekOffset 0=本周，-1=上周，+1=下周）；
 * - WEEK_OF：裸周偏移整周（主控 2026-11-19 拍板增补；"上周"默认周一到周日一整周，
 *   L3 产 7 日半开窗，粒度 WEEK）；
 * - YEAR_MONTH_DAY：完整四位年份的年月日（非法日历日期不 clamp；两位年份不闭合，
 *   主控同日拍板只认四位，两位年回落 MONTH_DAY 走 MISSING_YEAR）；
 * - MONTH_DAY：无年份（或年份不完整）的月日，必落 MISSING_YEAR，不补今年、不产候选；
 * - RELATIVE_SPAN（#132）：相对锚点的有限跨度（"前三天/后两周/三天之内/三天前"），
 *   不含毫秒、只载形态 mode＋正整数 amount＋封闭单位 unit；L3 按整数日历折成半开 DAY 窗，
 *   周单位滚动折 7N 天且不对齐周一；无界方位/月年/指代不产此原子（只产 flag 留痕）。
 */
/** 相对跨度形态（#132，对应调研公式 F1–F6；端点含不含 D0 由 mode 唯一确定）。 */
export type RelativeSpanMode = 'BACK' | 'FORWARD' | 'WITHIN' | 'BEFORE_POINT' | 'AFTER_POINT';

export type TimeDateExpr =
  | { readonly kind: 'REL_DAY'; readonly delta: number }
  | { readonly kind: 'WEEKDAY_OF_WEEK'; readonly weekOffset: number; readonly weekday: IsoWeekday }
  | { readonly kind: 'WEEK_OF'; readonly weekOffset: number }
  | { readonly kind: 'YEAR_MONTH_DAY'; readonly year: number; readonly month: number; readonly day: number }
  | { readonly kind: 'MONTH_DAY'; readonly month: number; readonly day: number }
  | {
      readonly kind: 'RELATIVE_SPAN';
      readonly mode: RelativeSpanMode;
      readonly amount: number;
      readonly unit: 'DAY' | 'WEEK';
    };

/** 时间粒度：DAY/WEEK 首期可产窗；CLOCK/DURATION/RECURRING 契约冻结但无生产产出者。 */
export type TimeGranularity =
  | 'DAY'
  | 'WEEK'
  | 'CLOCK'
  | 'DURATION'
  | 'RECURRING';

/**
 * 文法层标记位（与 UncertainReason 一一对应但语义不同：flag 是 TIR 事实，
 * reason 是四态信封的裁决出口；同一 flag 在不同 role 下可能走不同 reason）。
 */
export type TimeFlag =
  | 'VAGUE'
  | 'CONTENT_SUSPECT'
  | 'QUESTION_FOCUS'
  | 'INVALID_CALENDAR'
  | 'DURATION'
  | 'RECURRING'
  | 'OUT_OF_ASSET_RANGE'
  | 'NOISE'
  // #132 扩面三枚：flag 是 TIR 事实，与末端 reason 同构但分属两层。
  | 'OPEN_DIRECTIONAL'
  | 'GRAIN_NOT_SUPPORTED'
  | 'DEICTIC_REFERENCE';

/** 单条符号证据：哪条规则、来自哪类资产、命中的原文片段。 */
export interface TimeEvidence {
  /** 词表条目 id 或文法规则 id（稳定标识，不写自由文本解释）。 */
  readonly ruleId: string;
  /** 证据来源资产面。 */
  readonly source: 'LEXICON' | 'NUMERAL' | 'GRAMMAR';
  /** 命中原样子串（审计可读，不参与判定）。 */
  readonly matchedText: string;
}

/**
 * L2 文法产出的时间中间表示（Time IR）。
 *
 * 无毫秒、不持有 TimeAnchor、不可读时钟；同输入 + 同资产版本必逐字节同形。
 * 一条原句可产出多条 TIR（多候选在信封层 OR 并集，不在此结构内嵌数组排序）。
 */
export interface TimeIR {
  /** 命中原句切片。 */
  readonly span: TextSpan;
  /** 言语角色（G 类处置依据）。 */
  readonly role: TimeRole;
  /** 符号日期原子；被 flag 短路时可为 null。 */
  readonly date: TimeDateExpr | null;
  readonly granularity: TimeGranularity;
  readonly flags: readonly TimeFlag[];
  /** 证据只增不删（模型提议路径同此约束）。 */
  readonly evidence: readonly TimeEvidence[];
}

/**
 * 显式不确定原因封闭枚举（UNCERTAIN 态 reason 字段唯一合法取值域）。
 * 新增原因禁止临时字符串并须同步补 golden 夹具；版本纪律（#132 订正）：reason 是词法/文法
 * 识别结果的裁决标签，扩枚随识别能力 bump lexicon/grammar；仅当时区/日界/周开篇等闭合策略
 * 本身变更才 bump policy（#132 三枚新 reason 对应 lexicon 2.1.0/grammar 4.1.0、policy 1.0.0 不动）。
 */
export type TimeUncertainReason =
  | 'VAGUE_EXPRESSION'
  | 'MISSING_YEAR'
  | 'CONTENT_TIME_SUSPECTED'
  | 'QUESTION_FOCUS'
  | 'DURATION_NOT_FILTER'
  | 'RECURRING_NOT_SINGLETON'
  | 'INVALID_CALENDAR_DATE'
  | 'OUT_OF_ASSET_RANGE'
  | 'UNPARSEABLE_NOISE'
  // #132 扩面：只在联合末尾追加，旧九枚不删不改、排序语义冻结（见 time-resolve.REASON_PRIORITY）。
  | 'OPEN_DIRECTIONAL_UNBOUNDED'
  | 'GRAIN_NOT_SUPPORTED'
  | 'DEICTIC_REFERENCE';

/**
 * 闭合证明的维度状态（盲审收敛铁律：不存在 INFERRED 态）。
 *
 * - EXPLICIT：原句显式证据（"2026 年 11 月 19 日"）；
 * - POLICY：冻结策略补全（日界/时区/周开篇，策略版本可追溯）。
 */
export type ClosureState = 'EXPLICIT' | 'POLICY';

/** 证明门逐维度核验项。 */
export type ClosureDimension =
  | 'YEAR'
  | 'MONTH'
  | 'DAY'
  | 'ZONE'
  | 'WEEK_START'
  | 'DAY_BOUNDARY';

/** 单个维度的闭合证据：状态 + 经由的规则/策略 id。 */
export interface ClosureDimProof {
  readonly dim: ClosureDimension;
  readonly state: ClosureState;
  /** 证据规则 id（EXPLICIT）或策略键（POLICY）。 */
  readonly via: string;
  /** state=POLICY 时携带策略资产版本；EXPLICIT 时缺省。 */
  readonly policyVersion?: string;
}

/**
 * 闭合证明：WINDOW 构造器（proveClosure，批 3）模块私有，
 * 任一维度缺失或出现非 EXPLICIT/POLICY 状态则类型上构造不出 WINDOW。
 */
export interface ClosednessProof {
  /** 覆盖全部必需维度；构造器内部断言完整性，外部只读取不拼装。 */
  readonly dimensions: readonly ClosureDimProof[];
}

/**
 * 半开整数毫秒窗 [startMs, endMs)。
 *
 * - endMs 严格大于 startMs（点事件不靠零长度窗表达，点命中用 t∈[s,t) 谓词）；
 * - 仅 DAY/WEEK 粒度首期有生产产出者；CLOCK 窗口挂账，类型冻结不接线。
 */
export interface TimeWindow {
  readonly startMs: number;
  readonly endMs: number;
  /** 半开区间标记，类型层面固定为 true。 */
  readonly halfOpen: true;
  readonly granularity: 'DAY' | 'WEEK';
}

/** 解析 provenance：重放对账键的全部输入面。 */
export interface TimeProvenance {
  /** 解析所用锚点时刻快照。 */
  readonly anchorEpochMs: number;
  /** 解析所用资产版本快照。 */
  readonly assets: TimeAssetVersions;
  /**
   * 重放键：hash(规范化查询, anchorEpochMs, assets)。
   * 同键必逐字节同输出；生成函数批 3 落地，批 1 仅冻结字段形状。
   */
  readonly replayKey: string;
}

/**
 * 时间约束四态信封（gate V2 时间槽唯一接收形状，判别联合禁止混形）。
 *
 * - NONE：无时间表达，不参与时间槽裁决；
 * - UNCERTAIN：识别到时间但不可闭合，留痕放行（time-uncertain-ignored），绝不猜；
 * - CANDIDATES：多义多窗，类型上**没有** preferred/score/rank/confidence 字段，
 *   禁止 windows[0] 直取，gate 按 OR 并集裁决，澄清反问在阶段 2 新卷；
 * - WINDOW：唯一闭合窗，必带 ClosednessProof，构造器模块私有。
 */
export type TimeConstraint =
  | { readonly kind: 'NONE'; readonly provenance: TimeProvenance }
  | {
      readonly kind: 'UNCERTAIN';
      readonly reason: TimeUncertainReason;
      /** 触发不确定的原文切片（可多条，审计用）。 */
      readonly spans: readonly TextSpan[];
      readonly provenance: TimeProvenance;
    }
  | {
      readonly kind: 'CANDIDATES';
      /** 无序同位候选；消费方不得按数组下标取首选。 */
      readonly windows: readonly TimeWindow[];
      /** 各候选歧义来源的规则 id（与 windows 同位对应，不含排序语义）。 */
      readonly ambiguity: readonly string[];
      readonly provenance: TimeProvenance;
    }
  | {
      readonly kind: 'WINDOW';
      readonly window: TimeWindow;
      /** 闭合证明为必填，缺证明在类型层面构造不出本态。 */
      readonly closure: ClosednessProof;
      readonly provenance: TimeProvenance;
    };