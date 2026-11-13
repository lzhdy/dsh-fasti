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
 */

import { asciiLower } from '../projection/types.ts';
import { buildSerialMap } from './serial.ts';
import type {
  ExplainedRankedCard,
  GateReasonCode,
  GatedRankedCard,
  GatedSearchOutcome,
  MatchKind,
} from './types.ts';

/**
 * 门策略具名常量（观测策略，可经评审演进）：不是逐请求入参、不进冻结的 SearchQuery。
 * 第一层值固定；连续证据分/阈值等演进项未来另立，不改本常量形状的消费约定。
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
  /** 动态 top-k：过滤完成后才截断，不用弱尾凑数；缺省保留全部过门卡。 */
  limit?: number;
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
 * 对完整排序全集逐卡裁决并分流。
 * 状态：空查询 no-match/empty-query；零词面候选 no-match/zero-lexical-hit；
 * 有候选但全被拒 abstain/all-rejected；至少一卡过强通道 hit（accepted 保序后按 limit 截断）。
 */
export function applyGate(input: ApplyGateInput): GatedSearchOutcome {
  const { qNorm, candidates, limit } = input;

  if (qNorm === '') {
    return { status: 'no-match', accepted: [], rejected: [], reason: 'empty-query', serialMap: buildSerialMap([]) };
  }
  if (candidates.length === 0) {
    return {
      status: 'no-match',
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
    return { status: 'abstain', accepted: [], rejected, reason: 'all-rejected', serialMap: buildSerialMap([]) };
  }

  // 全集过滤后再截断（D9）：candidates 已按 score 排序，filter 保序；弱尾不补位。
  const truncated = limit === undefined ? accepted : accepted.slice(0, limit);
  return {
    status: 'hit',
    accepted: truncated,
    rejected,
    serialMap: buildSerialMap(truncated),
  };
}
