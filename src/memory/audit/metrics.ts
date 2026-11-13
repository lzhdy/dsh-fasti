/**
 * 记忆层离线审计 —— 指标聚合 / 随机源 / bootstrap / 审计落库低层（方案 §4.10，裁决 I1-A/I8/I9/I12）。
 *
 * 纪律：
 *  - 纯离线、无网络、不调 LLM；随机源以 rng 入参注入、禁 Math.random；atMs/时钟由编排层注入；
 *  - 落库低层 insertAuditRun/insertAuditItem 收库柄、不自开连接（store.ts 写柄委托，I1-A 单向 store→audit）；
 *  - 不反引 store、不 import 门面；模块顶层仅字面量常量、零求值；
 *  - 审计两表 DDL 与 AuditRunRecord/AuditItemRecord/ProbeType 冻结零改动，约束由 schema CHECK 承担；
 *  - hit_count 仅在 roi 模拟口径出现，绝不回写生产卡（I10）。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { AssembledWindow, AuditItemRecord, AuditRunRecord } from '../types.ts';
import type { ConsistencyResult } from './consistency.ts';
import type { DecoyQuestionResult } from './decoy.ts';
import type { GoldQuestionResult } from './gold.ts';
import type { ProvenanceResult } from './provenance.ts';

// ── 随机源 / bootstrap（I8）────────────────────────────────────────────────

/** 确定性随机源（mulberry32 实例，返回 [0,1)）。 */
export type Rng = () => number;

/** 具名常量种子（观测初值，写入 notesJson.rngSeed；harness 校准后凭数据修订）。 */
export const DEFAULT_RNG_SEED = 20261111;
/** §6.1 bootstrap 重采样次数（结构常量）。 */
export const BOOTSTRAP_RESAMPLES = 1000;
/** I12 装配 P95 固定重复次数（编排层用）。 */
export const P95_REPEATS = 1000;

/** mulberry32：零依赖确定性 PRNG，同种子同输入逐字节一致。 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 比率类指标统一形状（点估计 + bootstrap 95% 区间 + 样本数）。 */
export interface RatioEstimate {
  point: number;
  ciLower: number;
  ciUpper: number;
  n: number;
}

/** N/A 项统一形状（不填 0、不参与达标判定）。 */
export interface NaEstimate {
  status: 'n-a';
  reason: string;
}

function percentileOf(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/** percentile 法 bootstrap：有放回重采样 resamples 次取均值分布的 2.5%/97.5% 分位（v1 不做 BCa）；空数组→{0,0}。 */
export function percentileCI(
  values: readonly number[],
  rng: Rng,
  resamples: number = BOOTSTRAP_RESAMPLES,
): { ciLower: number; ciUpper: number } {
  if (values.length === 0) {
    return { ciLower: 0, ciUpper: 0 };
  }
  const means: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[Math.floor(rng() * values.length)]!;
    }
    means.push(sum / values.length);
  }
  means.sort((x, y) => x - y);
  return { ciLower: percentileOf(means, 0.025), ciUpper: percentileOf(means, 0.975) };
}

/** 比率估计：point=均值，CI 走 percentileCI；空样本 point=0/n=0（N/A 由聚合层判定）。 */
export function ratioEstimate(indicators: readonly (0 | 1)[], rng: Rng): RatioEstimate {
  const n = indicators.length;
  const point = n === 0 ? 0 : indicators.reduce<number>((sum, value) => sum + value, 0) / n;
  const { ciLower, ciUpper } = percentileCI(indicators, rng);
  return { point, ciLower, ciUpper, n };
}

// ── 指标聚合（I9，§2.3 四组）──────────────────────────────────────────────

export interface MetricsJson {
  retrieval: {
    recallAtK: RatioEstimate | NaEstimate;
    recallAtK1: RatioEstimate | NaEstimate;
    recallAtK5: RatioEstimate | NaEstimate;
    recallColdStart: RatioEstimate | NaEstimate;
    recallHer: RatioEstimate | NaEstimate;
    recallUser: RatioEstimate | NaEstimate;
    recallEnvironment: RatioEstimate | NaEstimate;
    mrr: number;
  };
  assembly: {
    avgWindowChars: number;
    guaranteedSlotRate: number;
    refetchRoundRate: number;
    turnsWholeRate: number;
    p95Ms: number;
  };
  quality: {
    r2: RatioEstimate | NaEstimate;
    r2HighRiskErrors: number;
    r3: RatioEstimate | NaEstimate;
    provenanceSuccess: RatioEstimate | NaEstimate;
  };
  roi: {
    perCardCost: number;
    expectedHitsPerThousand: number;
    costPerEffectiveRecall: number;
  };
}

export interface AggregateInput {
  gold: readonly GoldQuestionResult[];
  goldK1: readonly GoldQuestionResult[];
  goldK5: readonly GoldQuestionResult[];
  decoy: readonly DecoyQuestionResult[];
  consistency: ConsistencyResult;
  provenance: ProvenanceResult;
  windows: readonly AssembledWindow[];
  p95Ms: number;
  roi: { writeCostMinutes: number; simulatedHits: number; cards: number };
}

function ratioOrNa(indicators: readonly (0 | 1)[], rng: Rng): RatioEstimate | NaEstimate {
  if (indicators.length === 0) {
    return { status: 'n-a', reason: 'no-sample' };
  }
  return ratioEstimate(indicators, rng);
}

function hitIndicators(results: readonly GoldQuestionResult[]): (0 | 1)[] {
  return results.map((r): 0 | 1 => (r.hit ? 1 : 0));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function slotRate(windows: readonly AssembledWindow[], predicate: (w: AssembledWindow) => boolean): number {
  return windows.length === 0 ? 0 : windows.filter(predicate).length / windows.length;
}

/** §2.3 全量指标聚合 + bootstrap 区间；N/A 不填零；同输入同种子逐字节一致。 */
export function aggregateMetrics(input: AggregateInput, options: { rng: Rng }): MetricsJson {
  const rng = options.rng;
  const gold = input.gold;

  let r3: RatioEstimate | NaEstimate;
  if (input.consistency.status === 'n-a') {
    r3 = { status: 'n-a', reason: input.consistency.reason ?? 'no-reflection-pair' };
  } else {
    const consistent = input.consistency.consistent ?? 0;
    const indicators: (0 | 1)[] = Array.from({ length: input.consistency.pairs }, (_, i): 0 | 1 =>
      i < consistent ? 1 : 0,
    );
    r3 = ratioOrNa(indicators, rng);
  }

  const { writeCostMinutes, simulatedHits, cards } = input.roi;
  return {
    retrieval: {
      recallAtK: ratioOrNa(hitIndicators(gold), rng),
      recallAtK1: ratioOrNa(hitIndicators(input.goldK1), rng),
      recallAtK5: ratioOrNa(hitIndicators(input.goldK5), rng),
      recallColdStart: ratioOrNa(hitIndicators(gold.filter((g) => g.coldStart)), rng),
      recallHer: ratioOrNa(hitIndicators(gold.filter((g) => g.initiation === 'her')), rng),
      recallUser: ratioOrNa(hitIndicators(gold.filter((g) => g.initiation === 'user')), rng),
      recallEnvironment: ratioOrNa(hitIndicators(gold.filter((g) => g.initiation === 'environment')), rng),
      mrr: mean(gold.map((g) => (g.rank !== null ? 1 / g.rank : 0))),
    },
    assembly: {
      avgWindowChars: mean(input.windows.map((w) => w.totalChars)),
      guaranteedSlotRate: slotRate(
        input.windows,
        (w) => (w.slots.find((s) => s.slot === 'guaranteed')?.cardIds.length ?? 0) > 0,
      ),
      refetchRoundRate: slotRate(input.windows, (w) => w.needRefetch),
      turnsWholeRate: slotRate(input.windows, (w) => w.turnsWhole),
      p95Ms: input.p95Ms,
    },
    quality: {
      r2: ratioOrNa(input.decoy.map((d): 0 | 1 => (d.correct ? 0 : 1)), rng),
      r2HighRiskErrors: input.decoy.filter((d) => d.highRiskError).length,
      r3,
      provenanceSuccess: ratioOrNa(input.provenance.results.map((r): 0 | 1 => (r.ok ? 1 : 0)), rng),
    },
    roi: {
      perCardCost: cards === 0 ? 0 : writeCostMinutes / cards,
      expectedHitsPerThousand: cards === 0 ? 0 : (simulatedHits / cards) * 1000,
      costPerEffectiveRecall: simulatedHits === 0 ? 0 : writeCostMinutes / simulatedHits,
    },
  };
}

// ── 落库低层（I1-A：收库柄、不自开连接；store.ts 写柄 writeAuditRun 单事务委托）──

const INSERT_AUDIT_RUN_SQL =
  'INSERT INTO mem_audit_run(run_id, created_ms, sample_n, probe_set_version, model_tag, metrics_json, notes_json) VALUES (?, ?, ?, ?, ?, ?, ?)';

const INSERT_AUDIT_ITEM_SQL =
  'INSERT INTO mem_audit_item(run_id, item_no, probe_type, expected_ref, returned_refs_json, passed, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)';

/** 落 1 条审计运行（收库柄；调用方负责事务边界）。 */
export function insertAuditRun(db: DatabaseSync, run: AuditRunRecord): void {
  db.prepare(INSERT_AUDIT_RUN_SQL).run(
    run.runId,
    run.createdMs,
    run.sampleN,
    run.probeSetVersion,
    run.modelTag,
    run.metricsJson,
    run.notesJson,
  );
}

/** 落 1 条审计条目（收库柄；probe_type/passed 越域由 schema CHECK 拒收）。 */
export function insertAuditItem(db: DatabaseSync, item: AuditItemRecord): void {
  db.prepare(INSERT_AUDIT_ITEM_SQL).run(
    item.runId,
    item.itemNo,
    item.probeType,
    item.expectedRef,
    item.returnedRefsJson,
    item.passed,
    item.detailJson,
  );
}