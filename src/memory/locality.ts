/**
 * W3-1 P2 局部跨度聚集度谓词 + 统一安全锁（纯函数模块，默认不接生产门）。
 *
 * 设计出处：外审丙 A1（门算法v2_外部盲评回复 §8A）的 (m, span, gap) 三元组与 L1–L4，
 * 以及统一调参新卷立项书（200）§6.1 的「七字段严格支配 + 全等必弃权」安全锁。
 *
 * 纪律（见 task213 LOC-8 静态守卫）：
 *  - 本模块不被 gate.ts import，applyGateV2 热路径零变化；
 *  - 阈值表 PLACEHOLDER_LOCALITY_TABLE 是**占位整数**，仅表达「只放宽边界、不收内部空隙」
 *    的最紧自洽档，正式 k_min/G/G_gap 须在索引构建期由全库 bigram 随机空模型（A1 C6）
 *    冻结后替换，任何接进 accept/reject 的动作都另走预注册 §9；
 *  - 安全锁只做整组裁决：找不到唯一严格支配者就整组弃权，绝不替调用方挑一张卡。
 */

import { normalizeBigramText } from './bigram.ts';
import { gradedLexicalSignals } from './lexical-signals.ts';
import type { GradedSignals } from './types.ts';

/** A1 三元组：n=字段码点数，m=命中 bigram 数，span=命中区码点数，gap=内部空隙码点数。 */
export interface LocalityTriple {
  readonly n: number;
  readonly m: number;
  readonly span: number;
  readonly gap: number;
}

/**
 * L1–L3 整数阈值表（占位，待随机空模型冻结）。
 * - minFieldLength：短字段不参与聚集度作证（P1 minLen=4）；
 * - maxBigramDeficit：允许相对满命中（n-1 个 bigram）少命中的个数，m ≥ n-1-deficit；
 * - maxGap：字段内部允许的空隙码点数上界（0 = 不允许跳过）；
 * - maxSpanPadding：span 相对 n 的外扩上界，span ≤ n+padding。
 */
export interface LocalityThresholdTable {
  readonly minFieldLength: number;
  readonly maxBigramDeficit: number;
  readonly maxGap: number;
  readonly maxSpanPadding: number;
}

/**
 * 占位最紧档：deficit=1（尾字/首字位各丢一个 bigram 可过）、gap=0（内部插字一律不过）、
 * padding=0（命中区不得超出字段长度）。反向包含 m=n-1/gap=0 是其自然特例。
 * 非生产终值，冻结前禁止接线。
 */
export const PLACEHOLDER_LOCALITY_TABLE: LocalityThresholdTable = {
  minFieldLength: 4,
  maxBigramDeficit: 1,
  maxGap: 0,
  maxSpanPadding: 0,
};

interface CandidateHit {
  readonly m: number;
  readonly span: number;
  readonly first: number;
  readonly last: number;
}

/**
 * A1 严格公式（纯函数）：对字段 f 的每个起点 s，贪心取各 bigram 在查询中不早于 s+i 的
 * 最早出现位置（位置严格递增；单个 bigram 找不到则跳过，不中断），再在所有起点里取
 * span 最小、其次 m 最大者。代理对安全：全程按码点数组索引，不按 UTF-16 偏移。
 *
 * @param queryNorm 已规范化（或原文，内部幂等再规范化）查询
 * @param fieldText 候选卡单字段原文
 * @returns 三元组；字段不足两个码点或没有任何 bigram 命中时为 null
 */
export function localityDetail(queryNorm: string, fieldText: string): LocalityTriple | null {
  const qChars = [...normalizeBigramText(queryNorm)];
  const fChars = [...normalizeBigramText(fieldText)];
  const n = fChars.length;
  if (n < 2) return null;

  let best: CandidateHit | null = null;
  for (let start = 0; start <= n - 2; start += 1) {
    let searchFrom = start;
    let m = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i <= n - 2; i += 1) {
      const gramHead = fChars[i]!;
      const gramTail = fChars[i + 1]!;
      let idx = -1;
      for (let p = Math.max(searchFrom, start + i); p <= qChars.length - 2; p += 1) {
        if (qChars[p] === gramHead && qChars[p + 1] === gramTail) {
          idx = p;
          break;
        }
      }
      if (idx === -1) continue; // 允许跳过未命中 bigram：跳过即产生 gap
      if (first === -1) first = idx;
      last = idx;
      m += 1;
      searchFrom = idx + 1;
    }
    if (m === 0) continue;
    const span = last - first + 2;
    const candidate: CandidateHit = { m, span, first, last };
    if (
      best === null ||
      candidate.span < best.span ||
      (candidate.span === best.span && candidate.m > best.m)
    ) {
      best = candidate;
    }
  }

  if (best === null) return null;
  return { n, m: best.m, span: best.span, gap: best.span - best.m - 1 };
}

/** 单字段 L1–L3 判定：满足全部阈值则返回三元组作证，否则 null。 */
export function fieldSatisfiesLocality(
  queryNorm: string,
  fieldText: string,
  table: LocalityThresholdTable,
): LocalityTriple | null {
  const triple = localityDetail(queryNorm, fieldText);
  if (triple === null) return null;
  if (triple.n < table.minFieldLength) return null;
  if (triple.m < triple.n - 1 - table.maxBigramDeficit) return null; // L1
  if (triple.span > triple.n + table.maxSpanPadding) return null; // L2
  if (triple.gap > table.maxGap) return null; // L3
  return triple;
}

/** ∃f 谓词：任一字段过 L1–L3 即整卡可作证，返回首个满足字段（字段顺序确定）。 */
export function witnessLocality(
  queryNorm: string,
  fields: readonly string[],
  table: LocalityThresholdTable,
): { readonly field: string; readonly triple: LocalityTriple } | null {
  for (const field of fields) {
    const triple = fieldSatisfiesLocality(queryNorm, field, table);
    if (triple !== null) return { field, triple };
  }
  return null;
}

/** 七字段比较顺序，与 clarify-policy.ts 私有 SIGNAL_FIELDS 同序；本模块自带副本避免横向依赖。 */
const SIGNAL_FIELDS = [
  'lcs',
  'unitCovered',
  'unitTotal',
  'hitFields',
  'strongFields',
  'minHitFieldLength',
  'maxHitFieldLength',
] as const satisfies readonly (keyof GradedSignals)[];

export type SignalComparison = 'dominates' | 'equal' | 'dominated' | 'mixed';

/** 七整数维逐维比较：有高无低=dominates，有低无高=dominated，高低并存=mixed，全等=equal。 */
export function compareGradedSignals(a: GradedSignals, b: GradedSignals): SignalComparison {
  let anyGreater = false;
  let anyLess = false;
  for (const field of SIGNAL_FIELDS) {
    if (a[field] > b[field]) anyGreater = true;
    if (a[field] < b[field]) anyLess = true;
  }
  if (anyGreater && anyLess) return 'mixed';
  if (anyGreater) return 'dominates';
  if (anyLess) return 'dominated';
  return 'equal';
}

function signalsEqual(a: GradedSignals, b: GradedSignals): boolean {
  return SIGNAL_FIELDS.every((field) => a[field] === b[field]);
}

export interface LocalityCandidate {
  readonly cardId: string;
  readonly lexicalFields: readonly string[];
}

export type LocalityGateVerdict =
  | {
      readonly outcome: 'pass';
      readonly cardId: string;
      readonly witnessField: string;
      readonly triple: LocalityTriple;
    }
  | {
      readonly outcome: 'conflict-abstain';
      readonly reason: 'no-witness' | 'exact-equal' | 'no-strict-leader';
    };

/**
 * 统一安全锁（200 §6.1 / A1 L4），只做整组裁决：
 *  1. 幸存集 = 存在字段过 L1–L3 的候选；空集 → conflict-abstain/no-witness；
 *  2. 幸存集中任意两张七字段全等 → conflict-abstain/exact-equal（不赌，不挑卡）；
 *  3. 存在唯一一张在七字段上严格支配其余每张的卡 → pass 并附作证字段与三元组；
 *  4. 否则 → conflict-abstain/no-strict-leader。
 * 纯函数、不改输入、不产生排序以外的副作用；调用方负责决定如何消费弃权结果。
 */
export function localityGateDecision(input: {
  readonly queryNorm: string;
  readonly candidates: readonly LocalityCandidate[];
  readonly table: LocalityThresholdTable;
}): LocalityGateVerdict {
  const { queryNorm, candidates, table } = input;

  const survivors = candidates
    .map((candidate) => {
      const witness = witnessLocality(queryNorm, candidate.lexicalFields, table);
      if (witness === null) return null;
      return {
        candidate,
        witnessField: witness.field,
        triple: witness.triple,
        signals: gradedLexicalSignals(queryNorm, candidate.lexicalFields),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (survivors.length === 0) {
    return { outcome: 'conflict-abstain', reason: 'no-witness' };
  }

  for (let i = 0; i < survivors.length; i += 1) {
    for (let j = i + 1; j < survivors.length; j += 1) {
      if (signalsEqual(survivors[i]!.signals, survivors[j]!.signals)) {
        return { outcome: 'conflict-abstain', reason: 'exact-equal' };
      }
    }
  }

  const leaders = survivors.filter((entry) =>
    survivors.every(
      (other) =>
        other === entry || compareGradedSignals(entry.signals, other.signals) === 'dominates',
    ),
  );

  if (leaders.length === 1) {
    const leader = leaders[0]!;
    return {
      outcome: 'pass',
      cardId: leader.candidate.cardId,
      witnessField: leader.witnessField,
      triple: leader.triple,
    };
  }
  return { outcome: 'conflict-abstain', reason: 'no-strict-leader' };
}
