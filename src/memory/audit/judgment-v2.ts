/**
 * 终判判据 v2（预注册 v5 §5.1–§5.4、§6.2、§6.3）——纯函数，不读文件、不触库。
 *
 * 与 v1 指标层的关系：`metrics.ts` 的旧口径一字不动（v1 封存卷必须逐字复现）；
 * 本模块只服务 `fasti-p6-probes/v2` 卷，按预注册把口径拆开：
 *  - R1 宏 **只取 S0+S1**（n=300，簇 bootstrap 半宽 ≤0.05）；
 *  - R1_S0 单列副条件（点估计 ≥0.85）；
 *  - S2/S3/S4/S5 不考召回，只判 `L_S*`（`wc=0` 且高危错认 0）；S5 的 `wrong-abstain` 只登记；
 *  - R2 整体 200 对作门（≤0.05 且半宽 ≤0.05、高危错认 0），三类比率作必报明细；
 *  - 弃权：unanswerable `correct-abstain` 须 100%；noise 三态只登记（预注册未设数值门）；
 *  - 澄清 18 条：逐条披露「澄清/低置信」vs「自信给卡（含诱饵置顶）」，不进任何分母。
 * 精度未闭环（半宽 >0.05 或单元簇数 <30）判 `INCONCLUSIVE`，不得「有条件通过」。
 */

import { clusterRatioEstimate, ratioEstimate, mulberry32 } from './metrics.ts';
import type { ClusterRatioEstimate, NaEstimate, RatioEstimate, Rng, ClusterObservation } from './metrics.ts';
import type { ConstructionLayer, DecoyKind } from './fixtures.ts';

/** 单条金标探针（层、簇、top-k 命中、top1 提交与是否命中金标）。 */
export interface LayerProbeV2 {
  layer: ConstructionLayer;
  eventId: string;
  /** R1 top-k=3 命中（只对 S0/S1 有意义）。 */
  hit: boolean;
  highRisk: boolean;
  /** top1 是否有卡（提交）。 */
  committed: boolean;
  /** top1 是否为金标卡。 */
  top1IsGold: boolean;
}

/** 单条诱饵结果（三分类 + 是否正确 + 是否高危错认）。 */
export interface DecoyProbeV2 {
  kind: DecoyKind;
  correct: boolean;
  highRiskError: boolean;
}

/** 单条弃权探针（unanswerable 期望不提交；noise 有三态）。 */
export interface AbstainProbeV2 {
  kind: 'unanswerable' | 'noise';
  committed: boolean;
  top1IsGold: boolean;
}

/** 单条澄清探针的实测行为。 */
export interface ClarifyProbeV2 {
  query: string;
  committed: boolean;
  top1IsGold: boolean;
  /** top1 是否为该条配对诱饵卡之一（F6 要求登记「诱饵置顶」）。 */
  top1IsDecoy: boolean;
}

export interface ClarifyDisclosureRow {
  query: string;
  behavior: 'clarify-or-low-confidence' | 'confident-card';
  decoyTop1: boolean;
}

export interface LayerGateV2 {
  n: number;
  committed: number;
  wrongCommit: number;
  highRiskWrongCommit: number;
  /** S5 专用：只登记、不进任何门。其它层为 undefined。 */
  wrongAbstain?: number;
  pass: boolean;
}

export type EstimateV2 = RatioEstimate | NaEstimate;

export interface JudgmentV2 {
  r1Macro: EstimateV2 & { clusterCount?: number };
  r1S0: EstimateV2 & { clusterCount?: number };
  r2: EstimateV2;
  r2ByKind: Record<DecoyKind, EstimateV2>;
  decoyHighRiskErrors: number;
  layers: Partial<Record<'S2' | 'S3' | 'S4' | 'S5', LayerGateV2>>;
  abstain: {
    unanswerable: { n: number; correctAbstain: number; rate: EstimateV2 };
    noise: { n: number; correctCommit: number; wrongCommit: number; wrongAbstain: number };
  };
  clarify: { rows: readonly ClarifyDisclosureRow[]; clarified: number; confidentCard: number; decoyTop1: number };
  gates: {
    r1Macro: boolean;
    r1S0: boolean;
    L_S2: boolean;
    L_S3: boolean;
    L_S4: boolean;
    L_S5: boolean;
    r2: boolean;
    abstain: boolean;
    precision: boolean;
  };
  verdict: 'PASSED' | 'NOT-PASSED' | 'INCONCLUSIVE';
  notes: readonly string[];
}

/** R1 宏合格线（预注册 §5.1/:168、§6.2/:203）。 */
export const R1_MACRO_POINT_FLOOR = 0.85;
export const R1_MACRO_HALF_WIDTH_CEIL = 0.05;
/** R2 合格线（预注册 §6.2/:214）。 */
export const R2_POINT_CEIL = 0.05;
export const R2_HALF_WIDTH_CEIL = 0.05;
/** 各考核单元最小事件簇（预注册 §5.3/:190）。 */
export const MIN_UNIT_CLUSTERS = 30;

const DECOY_KIND_ORDER: readonly DecoyKind[] = ['same-family', 'cross-family-collision', 'cross-family-detail-reuse'];

function halfWidth(estimate: EstimateV2): number {
  return 'point' in estimate ? (estimate.ciUpper - estimate.ciLower) / 2 : Number.POSITIVE_INFINITY;
}

function isNa(estimate: EstimateV2): estimate is NaEstimate {
  return !('point' in estimate);
}

function clusterOf(probes: readonly LayerProbeV2[], rng: Rng): EstimateV2 & { clusterCount?: number } {
  if (probes.length === 0) {
    return { status: 'n-a', reason: 'no-sample' };
  }
  const observations = probes.map((p): ClusterObservation => ({ clusterId: p.eventId, outcome: p.hit ? 1 : 0 }));
  const estimate: ClusterRatioEstimate = clusterRatioEstimate(observations, rng);
  return { ...estimate, clusterCount: estimate.clusterCount };
}

function layerGate(probes: readonly LayerProbeV2[], withWrongAbstain: boolean): LayerGateV2 {
  const wrongCommit = probes.filter((p) => p.committed && !p.top1IsGold);
  const gate: LayerGateV2 = {
    n: probes.length,
    committed: probes.filter((p) => p.committed).length,
    wrongCommit: wrongCommit.length,
    highRiskWrongCommit: wrongCommit.filter((p) => p.highRisk).length,
    pass: probes.length > 0 && wrongCommit.length === 0 && wrongCommit.filter((p) => p.highRisk).length === 0,
  };
  if (withWrongAbstain) {
    gate.wrongAbstain = probes.filter((p) => !p.committed).length;
  }
  return gate;
}

/**
 * 计算 v2 判决。`seed` 必须由调用方注入（同输入同种子逐字节一致）。
 */
export function judgeV2(
  input: {
    gold: readonly LayerProbeV2[];
    decoy: readonly DecoyProbeV2[];
    abstain: readonly AbstainProbeV2[];
    clarify: readonly ClarifyProbeV2[];
  },
  options: { seed: number },
): JudgmentV2 {
  const rng = mulberry32(options.seed);
  const notes: string[] = [];

  const s0 = input.gold.filter((p) => p.layer === 'S0');
  const s1 = input.gold.filter((p) => p.layer === 'S1');
  const macroProbes = [...s0, ...s1];
  const r1Macro = clusterOf(macroProbes, rng);
  const r1S0 = clusterOf(s0, rng);

  const r2 = input.decoy.length === 0 ? { status: 'n-a' as const, reason: 'no-sample' } : ratioEstimate(input.decoy.map((d) => (d.correct ? 0 : 1)), rng);
  const r2ByKind = {} as Record<DecoyKind, EstimateV2>;
  for (const kind of DECOY_KIND_ORDER) {
    const rows = input.decoy.filter((d) => d.kind === kind);
    r2ByKind[kind] = rows.length === 0 ? { status: 'n-a', reason: 'no-sample' } : ratioEstimate(rows.map((d) => (d.correct ? 0 : 1)), rng);
  }
  const decoyHighRiskErrors = input.decoy.filter((d) => d.highRiskError).length;

  const layers: JudgmentV2['layers'] = {};
  for (const layer of ['S2', 'S3', 'S4', 'S5'] as const) {
    const probes = input.gold.filter((p) => p.layer === layer);
    if (probes.length > 0 || layer !== 'S5') {
      layers[layer] = layerGate(probes, layer === 'S5');
    }
  }

  const unanswerable = input.abstain.filter((p) => p.kind === 'unanswerable');
  const correctAbstain = unanswerable.filter((p) => !p.committed).length;
  const abstainRate: EstimateV2 =
    unanswerable.length === 0
      ? { status: 'n-a', reason: 'no-sample' }
      : ratioEstimate(unanswerable.map((p) => (!p.committed ? 1 : 0)), rng);
  const noise = input.abstain.filter((p) => p.kind === 'noise');
  const noiseCounts = {
    n: noise.length,
    correctCommit: noise.filter((p) => p.committed && p.top1IsGold).length,
    wrongCommit: noise.filter((p) => p.committed && !p.top1IsGold).length,
    wrongAbstain: noise.filter((p) => !p.committed).length,
  };

  const clarifyRows: ClarifyDisclosureRow[] = input.clarify.map((p) => ({
    query: p.query,
    behavior: p.committed ? 'confident-card' : 'clarify-or-low-confidence',
    decoyTop1: p.top1IsDecoy,
  }));
  const clarified = clarifyRows.filter((r) => r.behavior === 'clarify-or-low-confidence').length;
  const confidentCard = clarifyRows.filter((r) => r.behavior === 'confident-card').length;
  const decoyTop1 = clarifyRows.filter((r) => r.decoyTop1).length;

  // ── 门判定（N/A 不填 0、不参与达标，直接判未过）──
  const r1MacroPoint = 'point' in r1Macro ? r1Macro.point : null;
  const r1MacroHalf = 'point' in r1Macro ? halfWidth(r1Macro) : Number.POSITIVE_INFINITY;
  const r1S0Point = 'point' in r1S0 ? r1S0.point : null;
  const r2Point = 'point' in r2 ? r2.point : null;
  const r2Half = 'point' in r2 ? halfWidth(r2) : Number.POSITIVE_INFINITY;
  const r2N = 'point' in r2 ? r2.n : 0;
  const abstainPoint = 'point' in abstainRate ? abstainRate.point : null;
  const r1MacroPass = r1MacroPoint !== null && r1MacroPoint >= R1_MACRO_POINT_FLOOR && r1MacroHalf <= R1_MACRO_HALF_WIDTH_CEIL;
  const r1S0Pass = r1S0Point !== null && r1S0Point >= R1_MACRO_POINT_FLOOR;
  const r2Pass = r2Point !== null && r2Point <= R2_POINT_CEIL && r2Half <= R2_HALF_WIDTH_CEIL && decoyHighRiskErrors === 0;
  const abstainPass = abstainPoint !== null && abstainPoint >= 1;
  const layerGates: Record<'S2' | 'S3' | 'S4' | 'S5', boolean> = {
    S2: layers.S2?.pass ?? false,
    S3: layers.S3?.pass ?? false,
    S4: layers.S4?.pass ?? false,
    S5: layers.S5?.pass ?? false,
  };

  // ── 精度闭环（v4 §5.3 承继）：只认预注册写明的两个半宽 + 最小簇数 ──
  const precisionIssues: string[] = [];
  if (r1MacroPoint === null || r1MacroHalf > R1_MACRO_HALF_WIDTH_CEIL) precisionIssues.push('R1 宏簇半宽 >0.05 或无样本');
  if (r2Point === null || r2Half > R2_HALF_WIDTH_CEIL) precisionIssues.push('R2 半宽 >0.05 或无样本');
  const macroClusters = r1Macro.clusterCount ?? 0;
  if (macroClusters < MIN_UNIT_CLUSTERS) precisionIssues.push(`R1 宏簇数 ${macroClusters} < ${MIN_UNIT_CLUSTERS}`);
  if (r2N < MIN_UNIT_CLUSTERS) precisionIssues.push(`R2 样本 ${r2N} < ${MIN_UNIT_CLUSTERS}`);
  const precision = precisionIssues.length === 0;
  for (const issue of precisionIssues) notes.push(`精度未闭环：${issue}`);
  // 各层样本量只登记：层配额由装配机硬校，不在此重复设门。
  for (const layer of ['S2', 'S3', 'S4', 'S5'] as const) {
    const gate = layers[layer];
    if (gate !== undefined && gate.n < MIN_UNIT_CLUSTERS) notes.push(`登记：${layer} 样本 ${gate.n} 条（<${MIN_UNIT_CLUSTERS}，召回应只作描述）`);
  }

  // ── R2 分类告警（整体作门、明细必报；某类明显高于整体且越线即告警）──
  for (const kind of DECOY_KIND_ORDER) {
    const estimate = r2ByKind[kind];
    if ('point' in estimate && r2Point !== null && estimate.point > r2Point && estimate.point > R2_POINT_CEIL) {
      notes.push(`告警：诱饵「${kind}」错误率 ${estimate.point.toFixed(4)} 高于整体 ${r2Point.toFixed(4)} 且越线（整体门仍按 200 对计）`);
    }
  }
  notes.push('noise 三态为登记项：预注册未设数值门，只报 correct-commit／wrong-commit／wrong-abstain 分布');
  if (input.clarify.length === 0) notes.push('澄清档未加载：F6 披露节为空（缺 clarify.json 时应显式标注，不得静默省略）');

  const allGateFields: Array<[string, boolean]> = [
    ['R1 宏', r1MacroPass],
    ['R1_S0', r1S0Pass],
    ['L_S2', layerGates.S2],
    ['L_S3', layerGates.S3],
    ['L_S4', layerGates.S4],
    ['L_S5', layerGates.S5],
    ['R2', r2Pass],
    ['ABSTAIN', abstainPass],
  ];
  const gatesPass = allGateFields.every(([, pass]) => pass);
  const verdict: JudgmentV2['verdict'] = !precision ? 'INCONCLUSIVE' : gatesPass ? 'PASSED' : 'NOT-PASSED';

  return {
    r1Macro,
    r1S0,
    r2,
    r2ByKind,
    decoyHighRiskErrors,
    layers,
    abstain: {
      unanswerable: { n: unanswerable.length, correctAbstain, rate: abstainRate },
      noise: noiseCounts,
    },
    clarify: { rows: clarifyRows, clarified, confidentCard, decoyTop1 },
    gates: {
      r1Macro: r1MacroPass,
      r1S0: r1S0Pass,
      L_S2: layerGates.S2,
      L_S3: layerGates.S3,
      L_S4: layerGates.S4,
      L_S5: layerGates.S5,
      r2: r2Pass,
      abstain: abstainPass,
      precision,
    },
    verdict,
    notes,
  };
}
