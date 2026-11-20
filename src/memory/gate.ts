/**
 * 确定性布尔通道门（#44 核心，采纳 S2，闭合 D1/D2/D3/D9）。
 *
 * 立场“正确性优先、宁空勿错”：不使用连续证据分与需标定的 cutoff，改以确定性布尔规则裁决，
 * 因此不存在会退化的 coverage 公式，也无需在小样本上标定常数。
 *
 * 无环纪律：本模块为接收候选数组的纯函数，**不 import bm25/store/builder**（避免未来
 * store→gate→bm25→store 环）；查询规范化由编排层经 bm25.normalizeQuery 预算为 qNorm 后传入
 * （与 miss.ts/alias-write 同款“收已规范化入参”纪律，N5）；haystack 归一仅复用无环底层
 * asciiLower，并由 gate.test 的同构锁定测试保证与 bm25.normalizeQuery 逐字同构（N3）。
 *
 * 纯函数、无 I/O、无 Date.now()；时钟与数据均由入参注入。
 *
 * #126 rules-v2 双轨（applyGateV2，与 V1 并存、CURRENT 仍冻结 rules-v1）：
 *  - 召回侧 OR 宽召回只负责把候选捞齐，本门以反向包含谓词 reverseContainment 逐卡裁定
 *    （线索字段规范化后完整出现于问句、码点 ≥ GATE_POLICY_V2.minContainCodepoints）；
 *  - #129 排序化改造：词面门只判合格性，合格卡一张不删，全体交 rankCards 字典序排序
 *    （weight→strength→occurred→cardId）；旧严格优超/tie 弃权已废，
 *    tie-no-strict-leader/not-strict-leader 枚举保留备查但 V2 不再产出；
 *    布尔家法（无连续分/无 cutoff/宁空勿错）与无环纪律原样保留。
 *
 * #127 阶段 1.5 时间槽（仅 applyGateV2 消费可选 timeConstraint；v1 函数体不读该字段，T7 静态锁）：
 *  - NONE/缺省槽位休眠输出零漂移；UNCERTAIN 留痕放行（time-uncertain-ignored）；
 *  - #131（P4）起 WINDOW/CANDIDATES 不再有否决权：时间窗摘出热路径、降为诊断留痕，
 *    词面合格卡一张不删，统一盖 time-window-ignored 交排序。窗几何（半开/相交/OR 并集）
 *    谓词保留在 time-resolve 供离线与单测直调，本模块不再 import 或调用任何时间裁决谓词。
 */

import { asciiLower } from '../projection/types.ts';
import { RANK_POLICY, composeView, mulberry32, rankCards } from './rank.ts';
import { buildSerialMap } from './serial.ts';
import { CURRENT_RULES_VERSION } from './types.ts';
import type {
  ExplainedRankedCard,
  GateReasonCode,
  GatedRankedCard,
  GatedSearchOutcome,
  MatchKind,
  TimeConstraint,
} from './types.ts';

/**
 * 门策略具名常量（观测策略，可经评审演进）：不是逐请求入参、不进冻结的 SearchQuery。
 * 本对象为 **rules-v1 冻结策略**（#126 起不得修改；v2 策略另立 GATE_POLICY_V2）。
 */
export const GATE_POLICY = Object.freeze({
  version: 1,
  /** 强通道：exact 恒过；fts 子串需再过 ASCII 词边界。 */
  strongKinds: Object.freeze(['exact-alias', 'fts-substring'] as MatchKind[]),
  /** 弱通道：LIKE 宽松子串，构造性拒绝。 */
  weakKinds: Object.freeze(['like-fallback'] as MatchKind[]),
  /** 纯 ASCII 查询启用词边界；CJK 等非 ASCII 查询边界 N/A 直通。 */
  asciiWordBoundary: true,
  cjkBoundaryNotApplicable: true,
});

/** token 内字符类（R-2）：小写字母、数字、下划线算 token 内字符。 */
const TOKEN = /[a-z0-9_]/;

/**
 * 词面规范化（N3）：NFKC → ASCII 小写（不动中文）→ 空白折叠。
 * 与 bm25.normalizeQuery 逐字同构（gate 不 import bm25 以保无环）；同构性由 gate.test 锁定，
 * 任一处调整必须同步另一处并让该测试失败暴露漂移。
 */
export function normalizeLexicalText(text: string): string {
  return asciiLower(text.normalize('NFKC')).replace(/\s+/g, ' ').trim();
}

/**
 * ASCII 词边界判定（提案 §5.2.1，入参约定均为已规范化串）：
 *  1. 查询含任意非 ASCII 字符（CJK 等）→ true（边界 N/A，不惩罚中文）；
 *  2. 纯 ASCII 查询：枚举 qNorm 在 haystackNorm 中的每次出现，某次出现的前后邻都不是 token 内字符
 *     （或抵达串端）即边界成立；非 ASCII 邻居天然不是 TOKEN，故“用git提交”判边界；
 *  3. 多次出现取任一；exact 严格等值命中不经本函数（恒过）。
 * 已知残余：标点/连字符非 TOKEN，挡不住 v1.2、cat.log、git-flow、a-git-b 等标点分隔后缀，
 * 已登记反例、不在第一层强行收口（宁空勿错但拒绝过度工程）。
 */
export function hasAsciiWordBoundary(qNorm: string, haystackNorm: string): boolean {
  if (qNorm === '') {
    return false;
  }
  if ([...qNorm].some((ch) => (ch.codePointAt(0) ?? 0) > 127)) {
    return true;
  }
  const isTokenChar = (ch: string | undefined): boolean => ch !== undefined && TOKEN.test(ch);
  let searchFrom = 0;
  let index = haystackNorm.indexOf(qNorm, searchFrom);
  while (index !== -1) {
    const end = index + qNorm.length;
    const before = index === 0 ? undefined : haystackNorm[index - 1];
    const after = end >= haystackNorm.length ? undefined : haystackNorm[end];
    const leftBoundary = before === undefined || !isTokenChar(before);
    const rightBoundary = after === undefined || !isTokenChar(after);
    if (leftBoundary && rightBoundary) {
      return true;
    }
    searchFrom = index + 1;
    index = haystackNorm.indexOf(qNorm, searchFrom);
  }
  return false;
}

/** applyGate 入参：qNorm 为编排层已规范化查询；candidates 为检索 limit=undefined 的完整排序全集。 */
export interface ApplyGateInput {
  qNorm: string;
  candidates: readonly ExplainedRankedCard[];
  /**
   * 注入时钟（ms，#129）：仅 applyGateV2 的排序器消费（strength 衰减/人话时间标签）。
   * v1 函数体刻意不读（与 timeConstraint 同款静态锁），门内禁止 Date.now。
   */
  atMs: number;
  /** 动态 top-k：排序完成后才截断，不用弱尾凑数；缺省回落 RANK_POLICY.defaultLimit。 */
  limit?: number;
  /**
   * #127 时间约束四态信封（仅 applyGateV2 消费；v1 函数体刻意不读本字段，T7 静态锁）。
   * 缺省或 NONE：时间槽休眠，裁决与无信封逐字节一致；UNCERTAIN：留痕放行；
   * #131 起 WINDOW/CANDIDATES 只产 time-window-ignored 留痕、不再否决删卡，词面合格卡一张不删。
   */
  timeConstraint?: TimeConstraint;
}

function toGated(candidate: ExplainedRankedCard, gateReasons: GateReasonCode[]): GatedRankedCard {
  return { ...candidate, gateReasons };
}

/** 单卡裁决：返回是否过门与原因码；按“最强通道”优先，弱通道不能挽救被强通道否决的卡。 */
function judge(
  candidate: ExplainedRankedCard,
  qNorm: string,
): { accept: boolean; reasons: GateReasonCode[] } {
  const kinds = candidate.matchKinds;
  if (kinds.includes('exact-alias')) {
    return { accept: true, reasons: ['exact-alias-pass'] };
  }
  if (kinds.includes('fts-substring')) {
    if (candidate.cueText === undefined) {
      // 防御：fts 命中理应携带复核用 cue_text；缺失时保守拒绝，宁空勿错。
      return { accept: false, reasons: ['missing-cue-text'] };
    }
    const haystackNorm = normalizeLexicalText(candidate.cueText);
    if (GATE_POLICY.asciiWordBoundary && hasAsciiWordBoundary(qNorm, haystackNorm)) {
      return { accept: true, reasons: ['fts-word-boundary-pass'] };
    }
    return { accept: false, reasons: ['ascii-no-word-boundary'] };
  }
  // 仅剩 like-fallback（bm25=0 的 %q% 宽松子串）：构造性拒绝，与任何数值阈值无关。
  return { accept: false, reasons: ['like-only-weak-match'] };
}

/**
 * rules-v1 布尔门（#44 冻结几何，#126 起显式保留供终判重放）：
 * 对完整排序全集逐卡裁决并分流。
 * 状态：空查询 no-match/empty-query；零词面候选 no-match/zero-lexical-hit；
 * 有候选但全被拒 abstain/all-rejected；至少一卡过强通道 hit（accepted 保序后按 limit 截断）。
 */
export function applyGateV1(input: ApplyGateInput): GatedSearchOutcome {
  const { qNorm, candidates, limit } = input;
  // 门过滤前全集条数：在任何分支返回前固定，截断与拒绝都不改写它（#114 candidateCount）。
  const candidateCount = candidates.length;

  if (qNorm === '') {
    return { status: 'no-match', candidateCount, accepted: [], rejected: [], reason: 'empty-query', serialMap: buildSerialMap([]) };
  }
  if (candidates.length === 0) {
    return {
      status: 'no-match',
      candidateCount,
      accepted: [],
      rejected: [],
      reason: 'zero-lexical-hit',
      serialMap: buildSerialMap([]),
    };
  }

  const accepted: GatedRankedCard[] = [];
  const rejected: GatedRankedCard[] = [];
  for (const candidate of candidates) {
    const decision = judge(candidate, qNorm);
    const gated = toGated(candidate, decision.reasons);
    if (decision.accept) {
      accepted.push(gated);
    } else {
      rejected.push(gated);
    }
  }

  if (accepted.length === 0) {
    return { status: 'abstain', candidateCount, accepted: [], rejected, reason: 'all-rejected', serialMap: buildSerialMap([]) };
  }

  // 全集过滤后再截断（D9）：candidates 已按 score 排序，filter 保序；弱尾不补位。
  const truncated = limit === undefined ? accepted : accepted.slice(0, limit);
  return {
    status: 'hit',
    candidateCount,
    accepted: truncated,
    rejected,
    serialMap: buildSerialMap(truncated),
  };
}

/**
 * rules-v2 门策略（#126 词法结构解）：布尔家法不变（无连续分、无 cutoff），
 * 以反向包含码点门槛取代 v1 的整句词边界判定。
 */
export const GATE_POLICY_V2 = Object.freeze({
  version: 2,
  /** 反向包含最小证据码点数：线索字段至少这么长且完整出现于问句，才算结构证据。 */
  minContainCodepoints: 3,
  /** 精确别名证据长度（仅门内比较用，不写入输出对象）。 */
  exactEvidenceInfinity: Number.POSITIVE_INFINITY,
});

/**
 * 反向包含证据（纯函数，#126）：在结构化词面字段中找“规范化后完整出现于 qNorm”的最长字段，
 * 返回其码点数；无字段满足长度门槛或包含关系返 0。方向与 v1 相反：field ⊆ qNorm（线索藏在问句里）。
 * 仅做原生字符串运算，不 import 任何索引模块（守无环静态门）。
 */
export function reverseContainment(qNorm: string, fields: readonly string[] | undefined, minLen: number): number {
  if (fields === undefined) {
    return 0;
  }
  let best = 0;
  for (const raw of fields) {
    const field = normalizeLexicalText(raw);
    const length = [...field].length;
    if (field !== '' && length >= minLen && qNorm.includes(field) && length > best) {
      best = length;
    }
  }
  return best;
}

interface V2Judgement {
  accept: boolean;
  reasons: GateReasonCode[];
  evidence: number;
}

/** rules-v2 单卡裁决：exact 恒过；fts-overlap 须过反向包含；like 构造性拒绝。 */
function judgeV2(candidate: ExplainedRankedCard, qNorm: string): V2Judgement {
  const kinds = candidate.matchKinds;
  if (kinds.includes('exact-alias')) {
    return { accept: true, reasons: ['exact-alias-pass'], evidence: GATE_POLICY_V2.exactEvidenceInfinity };
  }
  if (kinds.includes('fts-overlap')) {
    if (candidate.lexicalFields === undefined) {
      // 防御：v2 FTS 候选理应携带结构化字段；缺失即保守拒绝，宁空勿错。
      return { accept: false, reasons: ['missing-cue-text'], evidence: 0 };
    }
    const evidence = reverseContainment(qNorm, candidate.lexicalFields, GATE_POLICY_V2.minContainCodepoints);
    if (evidence > 0) {
      return { accept: true, reasons: ['reverse-containment-pass'], evidence };
    }
    return { accept: false, reasons: ['no-containment'], evidence: 0 };
  }
  return { accept: false, reasons: ['like-only-weak-match'], evidence: 0 };
}

/**
 * #131（P4）时间槽留痕标签（仅 v2 调用；门内不做任何日历算术、不调用时间谓词）：
 *  - 无信封/NONE：槽位休眠，返回 null、不加标记（T7 零漂移的结构保证）；
 *  - UNCERTAIN：宁空勿错，盖 time-uncertain-ignored 留痕；
 *  - WINDOW/CANDIDATES：时间窗摘出热路径后无否决权，词面合格卡统一盖 time-window-ignored
 *    留痕交排序；窗内窗外一张不删，窗几何谓词留在 time-resolve 离线直调。
 */
function decideTimeTag(constraint: TimeConstraint | undefined): GateReasonCode | null {
  if (constraint === undefined || constraint.kind === 'NONE') {
    return null;
  }
  if (constraint.kind === 'UNCERTAIN') {
    return 'time-uncertain-ignored';
  }
  // WINDOW/CANDIDATES：#131 起只留痕不裁决。
  return 'time-window-ignored';
}

/** 词面原因之后附加时间槽留痕码（无留痕时原数组不动）。 */
function withTimeTag(reasons: GateReasonCode[], tag: GateReasonCode | null): GateReasonCode[] {
  return tag === null ? reasons : [...reasons, tag];
}

/**
 * rules-v2 门（#126 合格性裁决；#129 起排序化改造，严格优超/tie 弃权已废）：
 * - 逐卡反向包含判"词面合格不合格"，词面不合格落 rejected 留痕；
 * - #131 起时间槽只加留痕标签、不参与合格性，词面合格卡一张不删，全体交 rank 排序器
 *   字典序定先后（weight→strength→occurred→cardId），证据长度只留痕不删卡；平局不弃权，澄清权归她；
 * - 无合格卡 → no-match/all-rejected（V2 不再产出 abstain；abstain 仅 v1 保留）；
 * - 空查询/零候选/candidateCount 语义与 v1 同构；limit 缺省回落 RANK_POLICY.defaultLimit。
 */
export function applyGateV2(input: ApplyGateInput): GatedSearchOutcome {
  const { qNorm, candidates, atMs, limit, timeConstraint } = input;
  const candidateCount = candidates.length;

  if (qNorm === '') {
    return { status: 'no-match', candidateCount, accepted: [], rejected: [], reason: 'empty-query', serialMap: buildSerialMap([]) };
  }
  if (candidates.length === 0) {
    return {
      status: 'no-match',
      candidateCount,
      accepted: [],
      rejected: [],
      reason: 'zero-lexical-hit',
      serialMap: buildSerialMap([]),
    };
  }

  const passed: Array<{ candidate: ExplainedRankedCard; judgement: V2Judgement; timeTag: GateReasonCode | null }> = [];
  const rejected: GatedRankedCard[] = [];
  for (const candidate of candidates) {
    const judgement = judgeV2(candidate, qNorm);
    if (!judgement.accept) {
      rejected.push(toGated(candidate, judgement.reasons));
      continue;
    }
    // 词面过门后再贴 #131 时间槽留痕：时间只留痕不否决，词面合格卡一张不删。
    const timeTag = decideTimeTag(timeConstraint);
    passed.push({ candidate, judgement, timeTag });
  }

  // #129：合格集为空属 no-match（abstain 语义在 V2 退役；v1 路径保留 abstain 不动）。
  if (passed.length === 0) {
    return { status: 'no-match', candidateCount, accepted: [], rejected, reason: 'all-rejected', serialMap: buildSerialMap([]) };
  }

  // #129：废严格优超/tie 弃权——词面合格卡一张不删，全体交 rank 排序器按
  // weight→strength（遗忘）→occurred→cardId 字典序定先后，澄清权归她。
  // 证据长度仅随门原因留痕（containmentLength），不再承担删卡职责。
  // #130：排序显式不截断（limit:null 拿完整名单），再交 composeView 做 8:2 截窗与槽位标记；
  // 探索随机性由注入 atMs 派生种子的 mulberry32 驱动，门内禁 Math.random，同 atMs 可逐字节重放。
  const ranked = rankCards(
    passed.map((entry) => entry.candidate.card),
    { nowMs: atMs, limit: null },
  );
  const view = composeView(ranked, {
    limit: limit ?? RANK_POLICY.defaultLimit,
    rng: mulberry32(atMs >>> 0),
  });
  const passedById = new Map(passed.map((entry) => [entry.candidate.card.cardId, entry]));
  const accepted: GatedRankedCard[] = view.entries.map((slottedEntry) => {
    const entry = passedById.get(slottedEntry.cardId);
    if (entry === undefined) throw new Error(`rank 排序返回了未过门卡：${slottedEntry.cardId}`);
    const reasons = withTimeTag(entry.judgement.reasons, entry.timeTag);
    const gated = Number.isFinite(entry.judgement.evidence)
      ? { ...toGated(entry.candidate, reasons), containmentLength: entry.judgement.evidence }
      : toGated(entry.candidate, reasons);
    return { ...gated, slot: slottedEntry.slot };
  });

  return {
    status: 'hit',
    candidateCount,
    accepted,
    rejected,
    serialMap: buildSerialMap(accepted),
    slots: view.slots,
  };
}

/**
 * 版本分派门入口（#126）：装配层接线零改动，按 CURRENT_RULES_VERSION 选择裁决几何。
 * - rules-v1：冻结的词边界布尔门（applyGateV1）；
 * - rules-v2：反向包含＋最长证据严格优超门（批次 3 落地前显式 fail-loud）。
 * 双轨红测直接调用具名 applyGateV1/applyGateV2，禁止经本壳传版本参数。
 */
export function applyGate(input: ApplyGateInput): GatedSearchOutcome {
  const rulesVersion: string = CURRENT_RULES_VERSION;
  switch (rulesVersion) {
    case 'rules-v1':
      return applyGateV1(input);
    case 'rules-v2':
      return applyGateV2(input);
    default:
      throw new Error(`未知 rules 版本：${CURRENT_RULES_VERSION}`);
  }
}
