/**
 * ORD-γ 有序连续命中 0/1 排序特征（215 §3.3；外审 196 :267 对 SDM 顺序依赖的收窄态）。
 *
 * 定位：只产出「候选卡是否有字段在查询中有序连续整段命中」的二值排序特征与逐字段整数
 * 留痕，**本模块默认不接任何排序键/裁决门**；任何把它接进 gate/rank 热路径的动作都属
 * 判据变更，必须另走预注册 §9（见 tests/memory/ordered-proximity.test.ts OP-9 静态守卫）。
 *
 * 数学口径（外审 §8A :413-426）：localityDetail 给每字段 (n,m,span,gap)。bigram 满命中
 * （m=n-1）且内部无空隙（gap=0）时，n-1 个 bigram 首尾相接覆盖 n 个码点，等价于该字段
 * 规范化后在查询中连续出现——即现行反向包含几何（reverseContainmentDetail）的严格同集；
 * 其余有 bigram 命中但不满命中或有 gap 的字段即「散落命中」对照态，特征记 0。
 *
 * 无环纪律：仅依赖同为 leaf 的 locality.ts（复用其贪心取位，不重写 bigram 几何）与全局
 * 字符串，不 import gate/bm25/store/rank，不持库柄；纯整数、无时钟、无随机、无浮点，
 * 逐题可手算。码点口径全程 [...str]，代理对安全由 localityDetail 统一保证。
 */

import { localityDetail } from './locality.ts';

/**
 * 参与特征判定的最小字段码点数。与 `GATE_POLICY_V2.minContainCodepoints`（=3）同值但不
 * 互相 import（本模块不得依赖 gate.ts）；OP-3 红测锁定两值相等，保证二值特征与反向包含
 * 计入字段集合严格同集。短于该长度的字段不参与特征、不进留痕。
 */
export const ORDERED_PROXIMITY_MIN_FIELD_CODEPOINTS = 3;

/** 单字段有序连续命中留痕（全整数，按输入字段序产出）。 */
export interface OrderedProximityFieldTrace {
  /** 字段在入参 lexicalFields 中的原始下标。 */
  readonly fieldIndex: number;
  /** 字段规范化码点数 n。 */
  readonly n: number;
  /** 命中的 bigram 数 m。 */
  readonly m: number;
  /** 命中区内部空隙码点数 gap。 */
  readonly gap: number;
  /** 1＝gap=0 且 bigram 满命中（m=n-1）的有序连续整段命中；否则 0（散落/差字对照态）。 */
  readonly orderedContiguous: 0 | 1;
}

/** 卡级 0/1 特征与逐字段留痕。 */
export interface OrderedProximityFeature {
  /** 任一参与字段 orderedContiguous=1 即为 1，否则 0。 */
  readonly value: 0 | 1;
  /** 逐字段留痕：仅纳入长度达标且至少一个 bigram 命中的字段，保输入序。 */
  readonly fieldTraces: readonly OrderedProximityFieldTrace[];
}

/**
 * 计算一张候选卡的 ORD-γ 特征。
 *
 * @param queryNorm 已规范化查询（传入原文亦可，localityDetail 内部幂等再规范化）
 * @param lexicalFields 候选卡的结构化词面字段（display_cues＋非敏感活跃别名，与 V2 召回同形）
 */
export function orderedProximityFeature(
  queryNorm: string,
  lexicalFields: readonly string[],
): OrderedProximityFeature {
  const fieldTraces: OrderedProximityFieldTrace[] = [];
  let value: 0 | 1 = 0;

  lexicalFields.forEach((fieldText, fieldIndex) => {
    const triple = localityDetail(queryNorm, fieldText);
    // 无 bigram 命中（triple=null）或短于最小码点的字段：不计入、不抬卡级值。
    if (triple === null || triple.n < ORDERED_PROXIMITY_MIN_FIELD_CODEPOINTS) return;
    const orderedContiguous: 0 | 1 =
      triple.gap === 0 && triple.m === triple.n - 1 ? 1 : 0;
    if (orderedContiguous === 1) value = 1;
    fieldTraces.push({
      fieldIndex,
      n: triple.n,
      m: triple.m,
      gap: triple.gap,
      orderedContiguous,
    });
  });

  return { value, fieldTraces };
}
