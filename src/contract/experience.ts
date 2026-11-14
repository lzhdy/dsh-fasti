/**
 * Experience schema —— 定案稿 §4.2 的逐字段落定（阶段 0 契约）。
 *
 * 红线自检：
 *  ① 数据结构不把「聊天 / 对话」写成前提 —— kind 是开放枚举只描述形状，dialogue 只是六种之一；
 *     session 降级为 scene.ref（P10），本 schema 无 session_id / chat_id 之类前提字段。
 *  ② 不预设「什么重要」 —— 本 schema 无 importance / salience / score 一类字段；
 *     marks 只是规则层的机械标记，永不表示重要性。
 *
 * 开放枚举（定案稿 §10.2）：kind / scene.channel / initiation / action.type / edge.type
 * 全部为「已知值 + 任意 string」，旧读取器遇未知值必须原样保留、不得丢弃。
 *
 * 演进（定案稿 §10.4）：schema_version 只增不改；写入时记录当前版本号；
 * 读取器对未知字段原样保留（C2），不丢弃、不报错。
 */

export const CURRENT_SCHEMA_VERSION = 1;

/** 已知形状（开放枚举的已知子集；任何其它字符串同样合法）。 */
export const KNOWN_KINDS = ['dialogue', 'perception', 'action', 'reflection', 'dream', 'import'] as const;
export type KnownKind = (typeof KNOWN_KINDS)[number];

/** 已知发起方（开放枚举的已知子集）。 */
export const KNOWN_INITIATIONS = ['user', 'her', 'system', 'environment'] as const;
export type KnownInitiation = (typeof KNOWN_INITIATIONS)[number];

/** 已知动作类型（开放枚举的已知子集）。 */
export const KNOWN_ACTION_TYPES = ['reply', 'browse-step', 'tool-call', 'preserve-media', 'organize'] as const;

/** 已知关系类型（开放枚举的已知子集）。 */
export const KNOWN_EDGE_TYPES = ['continues', 'references', 'about'] as const;

/** 已知结果状态。 */
export const KNOWN_OUTCOME_STATUS = ['success', 'failure', 'partial', 'unknown'] as const;
export type KnownOutcomeStatus = (typeof KNOWN_OUTCOME_STATUS)[number];

/**
 * 指针 —— 定位真源中的目标（原文行区间等）。
 *
 * 双定位（定案稿 §4.5，冻结面第 2 条）：id 权威，channel + shard + seq 为冗余加速。
 * seq 从 0 起算；区间 [a, b] 为闭区间（含两端）；单 number 表示该行。
 */
export interface Pointer {
  /** 权威定位：目标条目 id。 */
  id?: string;
  /** 原文所在通道命名空间（缺省按 id 索引解析）。 */
  channel?: string;
  /** 冗余加速：'YYYY-MM'。 */
  shard?: string;
  /** 行号或行区间（含端点）。 */
  seq?: number | [number, number];
}

/** 摄入期结构关系。 */
export interface Edge {
  type: string;
  target: string;
  note?: string;
}

/** 媒体引用 —— 真源只存引用，字节进资产层（定案稿 §6）。 */
export interface MediaRef {
  /** ULID，全局稳定。 */
  ref_id: string;
  /** 内容类型无关的开放枚举。 */
  kind: string;
  mime: string;
  /** reference-only 通道可无字节信息。 */
  bytes?: number;
  /** 有字节时必填；完整性校验。 */
  sha256?: string;
  /** 原始引用：核心只透传不解释。 */
  origin: {
    channel: string;
    host_ref: string;
    captured_at: string;
  };
}

/**
 * 规则层机械标记 —— 只贴标签、不否决。
 * 永不含「重要性」；marks 的存在不改变一条经历是否被记录。
 */
export interface Mark {
  type: string;
  by: 'rule-layer';
  note?: string;
}

/** 场景 —— 通道内标识；会话只是 scene.ref 的一种取值。 */
export interface Scene {
  /** 通道注册表 id：'dsh' | 'qq' | 'browser' | 'camera' | …（开放）。 */
  channel: string;
  /** 通道内场景标识：会话 id / 聊天 id / 页面 url+visit / 流 id / 复盘批 id。 */
  ref: string;
  /** 通道自定义键值（开放；如 QQ 群号、站点名）。 */
  detail?: Record<string, string>;
}

/** 她当时的载体。 */
export interface AgentMeta {
  model?: string;
  persona_version?: string;
}

/** 发生了什么。 */
export interface Observation {
  /** 原文指针 → 原文层行区间（正文一律不内联）。 */
  text?: Pointer;
  /** 媒体引用（照片/语音/视频/文件/留意帧）。 */
  media?: MediaRef[];
  /** 短触发线索内联（反思/做梦用；硬上限 200 字符）。 */
  cue?: string;
}

/** 做了什么。 */
export interface Action {
  type: string;
  tool?: string;
  args?: Pointer | string;
  thought?: Pointer | string;
  /**
   * 工具调用标识（v1.4 新增，可空）—— 请求与结果靠它配对。
   *
   * 取自**载荷 JSON**（调用步载荷的 `callId`），**不是 RawTurn 顶层字段**
   * （定案稿 §5.0.2 约束 2：RawTurn 八字段是冻结面，callId 不提升上去）。
   *
   * 存在的理由：定案稿 §5.0.3 的任务作用域判据要求「见到 `action.type='tool-call'`
   * 加入其 callId，见到对应 callId 的 `outcome` 移除」—— 没有这个字段就无从配对。
   */
  call_id?: string;
}

/** 结果如何。 */
export interface Outcome {
  text?: Pointer | string;
  status?: KnownOutcomeStatus | string;
  error_type?: string;
  duration_ms?: number;
  tokens?: { input?: number; output?: number };
  /**
   * 工具调用标识（v1.4 新增，可空）—— 与对应请求的 `action.call_id` 配对。
   *
   * 取自**结果载荷**的 `message.toolCallId`（定案稿 §5.0.2 约束 2）。
   * 无 callId 的结果（无结果正文 / 未知形态）→ 不设置此字段。
   */
  call_id?: string;
}

/** 经历条目 —— 定案稿 §4.2 全字段。 */
export interface Experience {
  /** ULID：全局稳定、按时间有序、跨设备不变。 */
  id: string;
  /** 真源格式版本；只增不改，未知字段原样保留。 */
  schema_version: number;

  /** 形状：交互 / 单向感知 / 对外行动 / 内省 / 做梦 / 回填（开放枚举）。 */
  kind: string;
  /** 场景：通道 + 通道内标识。 */
  scene: Scene;
  /** 谁发起（三态 + environment；继续开放）。 */
  initiation: string;
  /** 她当时的载体。 */
  agent_meta?: AgentMeta;

  /** 三段槽位（冻结形状）：发生了什么 / 做了什么 / 结果如何。 */
  observation: Observation;
  action?: Action;
  outcome?: Outcome;

  /** 世界轴：事情发生/被感知/被留意的时刻。 */
  occurred_at: string;
  /** 系统轴：进入真源的时刻，系统维护，永不回改。 */
  recorded_at: string;
  /** 节拍轴：她的主观节拍序号，单调递增。 */
  tick: number;

  /**
   * 全量原文码点长度（v1.4 新增，**可空加法字段**）。
   *
   * 记该条 raw_text 的全量码点长度 —— **所有轮含工具轮都记实际字符数**（定案稿 §3.2 注）；
   * `null`/缺失 = 旧数据/未统计/原文端口读不到（不猜、不补算）。
   * 事件层经 `is_tool` 分离后：`effective_chars` 只加非工具轮、`raw_chars` 加全部。
   */
  char_count: number | null;

  /** 规则层机械标记（只贴标签不否决）。 */
  marks?: Mark[];
  /** 摄入期结构关系。 */
  pointers?: Edge[];
}

/**
 * 允许出现「重要性」类语义的字段名 —— 真源层禁止。
 * 定案稿红线 ② + §4.2「marks 永远不含重要性」。
 */
export const FORBIDDEN_SEMANTIC_FIELDS = [
  'importance',
  'salience',
  'significance',
  'weight',
  'score',
  'importance_score',
  'priority',
  'confidence',
  'rating',
  'notable',
] as const;

/**
 * 允许出现「聊天/对话」前提的字段名 —— 真源层禁止。
 * 定案稿红线 ①：会话降级为 dsh 通道的 scene.ref（P10）。
 */
export const FORBIDDEN_CONVERSATION_FIELDS = [
  'chat_id',
  'conversation_id',
  'dialogue_id',
  'session_id',
  'is_chat',
  'is_dialogue',
  'messages',
] as const;

/** 检查一个字段名是否命中禁止清单。 */
export function isForbiddenFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    (FORBIDDEN_SEMANTIC_FIELDS as readonly string[]).some((f) => lower === f) ||
    (FORBIDDEN_CONVERSATION_FIELDS as readonly string[]).some((f) => lower === f)
  );
}

/**
 * **递归**收集命中的禁字段名（含嵌套，返回 `路径=字段名` 形式的清单）。
 *
 * 为什么要递归：只查顶层等于给嵌套开了后门 —— `marks: { score: 0.8 }`、
 * `pointers: [{ importance: 3 }]` 都能从顶层检查底下溜过去，而红线是「不得预设重要性」，
 * 它不关心你把它藏在第几层。
 *
 * 有环保护：手写对象可能带环（真源 JSON 不会），撞上环就跳过该分支，不抛栈溢出。
 */
export function findForbiddenFieldKeys(value: unknown, path = ''): string[] {
  const hits: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, at: string): void => {
    if (typeof node !== 'object' || node === null) {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = at === '' ? key : `${at}.${key}`;
      if (isForbiddenFieldName(key)) {
        hits.push(childPath);
      }
      walk(child, childPath);
    }
  };

  walk(value, path);
  return hits;
}

/**
 * 顶层字段名全集 —— 校验器据此判定「未知字段」。
 * 按模式分流：read 原样保留不报错（前向兼容未来版本字段），write 命中未知字段即抛 SchemaError。
 */
export const EXPERIENCE_FIELDS = [
  'id',
  'schema_version',
  'kind',
  'scene',
  'initiation',
  'agent_meta',
  'observation',
  'action',
  'outcome',
  'occurred_at',
  'recorded_at',
  'tick',
  'char_count',
  'marks',
  'pointers',
] as const;

/** 场景字段名全集。 */
export const SCENE_FIELDS = ['channel', 'ref', 'detail'] as const;

/** 观察槽位字段名全集。 */
export const OBSERVATION_FIELDS = ['text', 'media', 'cue'] as const;

/** 动作槽位字段名全集。 */
export const ACTION_FIELDS = ['type', 'tool', 'args', 'thought', 'call_id'] as const;

/** 结果槽位字段名全集。 */
export const OUTCOME_FIELDS = ['text', 'status', 'error_type', 'duration_ms', 'tokens', 'call_id'] as const;

/** 指针字段名全集。 */
export const POINTER_FIELDS = ['id', 'channel', 'shard', 'seq'] as const;

/** cue 硬上限（定案稿 §4.2）。 */
export const CUE_MAX_LENGTH = 200;

/**
 * 经历摘要窄 DTO（#114 附录 E.4.1，sourceLookupPort 第②跳）。
 *
 * 键集定死、只白名单投影：身份/场景/发起方/时间三轴/节拍 + 短线索（cue 缺失恒为 null）。
 * 绝不内联原文、observation/text 指针、contentHash 或任何内部列——原文只能经第③跳
 * resolveRawText（Pointer → RawTurnView）获取；结构上与注入候选 GatedCardView 双向不可赋值。
 */
export interface ExperienceSummaryView {
  readonly id: string;
  readonly kind: string;
  readonly scene: Scene;
  readonly initiation: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly tick: number;
  /** 短触发线索；经历无 cue 时为 null（不用 undefined，保证 DTO 形状稳定）。 */
  readonly cue: string | null;
}

/**
 * 原文行窄 DTO（#114 附录 E.4.1，sourceLookupPort 第③跳）。
 * 由门面既有 ResolvedPointer.turns 行 camelCase 投影而来，只承载单条原文行的最小定位与正文。
 */
export interface RawTurnView {
  readonly channel: string;
  readonly shard: string;
  readonly seq: number;
  readonly eventId: string;
  readonly rawText: string;
}
