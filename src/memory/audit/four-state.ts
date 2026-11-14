/**
 * 记忆层离线审计 —— 门后四态度量（#44 第一层，#54；提案 §5.7/§8.4）。
 *
 * 纪律：
 *  - 纯函数：只收探针判定布尔，不触库、不调 search、无 Date.now/Math.random、无网络；
 *  - 每条探针显式暴露 hasGold，构成 hasGold × committed 2×2（N2 分母自证）；
 *  - wc 按 hasGold 拆分 wc_G/wc_NG，杜绝双计：G = cc+wc_G+wa、NG = ca+wc_NG、恒等 N = G+NG；
 *  - 各率分母钉死、零分母显式 N/A（不填 0、不参与达标判定，防造假）；
 *  - 粗召回基线 r2（**错误率**：top1≠金标即计错、含正确弃权，与 decoy/metrics 的 r2 同向）逐字并列，
 *    并标注与 falseCommitRate 的口径差（后者不计弃权）；"旧路检索质量"仅作参照，不参与门控验收；
 *  - 第一层只做机制烟测，不报 R1/R2 达标（D4）；不 import 门面/store。
 */

import type { NaEstimate } from './metrics.ts';

/** 单条探针的门后判定输入（由 gold/decoy/abstain 结果在编排层映射而来）。 */
export interface FourStateProbeInput {
  /** 探针标识（仅用于确定性排序/诊断，不参与统计）。 */
  probeRef: string;
  /** 探针是否存在金标目标；无金标 = 期望弃权（不可答/噪声诱饵）。 */
  hasGold: boolean;
  /** 门是否认定（返回了至少一张 accepted 卡）。 */
  committed: boolean;
  /** 认定时 top1 是否即金标卡；未认定时该字段被忽略。 */
  top1IsGold: boolean;
  /** 是否高危五类探针（强断言/承诺/日期/原话/否定）；仅用于高危硬约束计数。 */
  highRisk: boolean;
}

/** 四态归类。 */
export type FourStateClass = 'correct-commit' | 'wrong-commit' | 'wrong-abstain' | 'correct-abstain';

/** 单条探针归类：有金标三分支 + 无金标二分支。 */
export function classifyProbe(input: FourStateProbeInput): FourStateClass {
  if (input.hasGold) {
    if (!input.committed) {
      return 'wrong-abstain';
    }
    return input.top1IsGold ? 'correct-commit' : 'wrong-commit';
  }
  return input.committed ? 'wrong-commit' : 'correct-abstain';
}

/** 比率或 N/A（零分母不填 0）。 */
export type NaOrNumber = number | NaEstimate;

const na = (reason: string): NaEstimate => ({ status: 'n-a', reason });

/** N/A 判定类型谓词（供调用方安全窄化 coarseR2 等联合类型）。 */
export function isNaEstimate(
  value: NaOrNumber | { point: number; n: number },
): value is NaEstimate {
  return typeof value === 'object' && value !== null && (value as { status?: string }).status === 'n-a';
}

export interface FourStateCounts {
  /** 有金标题认对。 */
  cc: number;
  /** 有金标题返回错卡。 */
  wcG: number;
  /** 无金标题无中生有返回卡。 */
  wcNG: number;
  /** wrong-commit 合计 = wcG + wcNG。 */
  wc: number;
  /** 有金标题弃权（漏召回）。 */
  wa: number;
  /** 无金标题正确弃权。 */
  ca: number;
  /** 有金标题总数 = cc + wcG + wa。 */
  G: number;
  /** 无金标题总数 = ca + wcNG。 */
  NG: number;
  /** 探针总数 = G + NG。 */
  N: number;
}

export interface FourStateRates {
  /** 主动认定中的错认比例 = wc/committed。 */
  falseCommitRate: NaOrNumber;
  /** 门槛后召回 = cc/G。 */
  recallAfterGate: NaOrNumber;
  /** 弃权漏召回率 = wa/G。 */
  wrongAbstainRate: NaOrNumber;
  /** 无金标题上的正确拒绝比例 = ca/NG。 */
  correctRejectRate: NaOrNumber;
  /** 总弃权比例 = (ca+wa)/N。 */
  abstainRate: NaOrNumber;
}

export interface FourStateSummary {
  counts: FourStateCounts;
  /** 高危五类探针中的 wrong-commit 数（硬约束须为 0；弃权不计）。 */
  highRiskWrongCommits: number;
  rates: FourStateRates;
  /**
   * 粗召回基线 r2（错误率：有金标题上 top1≠金标即计错，含弃权），与 falseCommitRate 并列报告。
   * 该基线口径与旧路检索同义、与门控口径不同源，是"未过门之前的检索质量"参照，不参与门控验收判定。
   */
  coarseR2: { point: number; n: number } | NaEstimate;
}

/**
 * 聚合四态计数与各率。归类的幂等性与 wc 拆分保证 G+NG=N 恒成立，此处 fail-loud 自检。
 */
export function summarizeFourState(probes: readonly FourStateProbeInput[]): FourStateSummary {
  let cc = 0;
  let wcG = 0;
  let wcNG = 0;
  let wa = 0;
  let ca = 0;
  let highRiskWrongCommits = 0;
  let coarseError = 0;
  let coarseN = 0;

  for (const item of probes) {
    const cls = classifyProbe(item);
    if (item.hasGold) {
      coarseN += 1;
      // 粗召回基线 r2 是错误率：非 correct-commit（含 wrong-commit 与弃权）一律计错（对齐 decoy/metrics 口径）。
      if (cls !== 'correct-commit') {
        coarseError += 1;
      }
    }
    if (cls === 'correct-commit') {
      cc += 1;
    } else if (cls === 'wrong-commit') {
      if (item.hasGold) {
        wcG += 1;
      } else {
        wcNG += 1;
      }
      if (item.highRisk) {
        highRiskWrongCommits += 1;
      }
    } else if (cls === 'wrong-abstain') {
      wa += 1;
    } else {
      ca += 1;
    }
  }

  const wc = wcG + wcNG;
  const G = cc + wcG + wa;
  const NG = ca + wcNG;
  const N = G + NG;
  if (G + NG !== cc + wc + wa + ca) {
    throw new Error('四态计数不自洽：G+NG 与逐项合计不一致（wc 双计）');
  }
  if (N !== probes.length) {
    throw new Error(`四态计数不自洽：N=${N} 与探针数 ${probes.length} 不一致`);
  }

  const committed = cc + wc;
  return {
    counts: { cc, wcG, wcNG, wc, wa, ca, G, NG, N },
    highRiskWrongCommits,
    rates: {
      falseCommitRate: committed > 0 ? wc / committed : na('no-commit'),
      recallAfterGate: G > 0 ? cc / G : na('no-gold-probe'),
      wrongAbstainRate: G > 0 ? wa / G : na('no-gold-probe'),
      correctRejectRate: NG > 0 ? ca / NG : na('no-no-gold-probe'),
      abstainRate: N > 0 ? (ca + wa) / N : na('no-probe'),
    },
    coarseR2: coarseN > 0 ? { point: coarseError / coarseN, n: coarseN } : na('no-gold-probe'),
  };
}
