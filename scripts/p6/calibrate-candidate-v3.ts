/**
 * 候选门 v3 · A 卷五档标定回放（#228，218 蓝图 §8）。
 *
 * 定位：调参卷只标定候选谓词、永不产 PASSED。本脚本在同一次检索得到的 candidates 上
 * 先跑 applyGateV2、再对 bMin=0..4 五张正式冻结表分别跑 applyGateV3，逐题留痕并做
 * 配对指标/硬闸门/机械定档/McNemar 与 Wilson 区间（分析侧算术，不进任何门）。
 *
 * 纪律：
 *  - 只读开库（readOnly:true），不写根不落仓库；--out 给了才写读数 JSON；
 *  - 注入的冻结表必须通过 manifest sha256 逐 artifact 对账，篡改/缺档/schema 不符 fail-loud；
 *  - 不接生产分派壳、不读生产版本常量，v2/v3 一律走具名函数；
 *  - 定档纯机械：硬闸门先灭、合规档净收益最大、同构并列取更紧档；两个 S2 异常
 *    （硬闸门全灭、净收益并列但回收/冲突分量分歧）只上报不拍板。
 *
 * 用法：
 *   node --experimental-strip-types scripts/p6/calibrate-candidate-v3.ts \
 *     --tuning <四件套目录> --world-root <v3 合成根> --null-model <冻结表目录> \
 *     [--now-ms <ms>] [--limit <n>] [--out <目录>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { applyGateV3 } from '../../src/memory/gate-v3.ts';
import { applyGateV2, normalizeLexicalText } from '../../src/memory/gate.ts';
import { searchCardsExplainedV2 } from '../../src/memory/bm25.ts';
import { buildWorldV3 } from '../../src/memory/audit/corpus/world-plan-v3.ts';
import type { CorpusPartitionV3 } from '../../src/memory/audit/corpus/world-plan-v3.ts';
import {
  validateTuningV3File,
} from '../../src/memory/audit/tuning-fixtures-v3.ts';
import type {
  TuningAbstainDocV3,
  TuningClarifyDocV3,
  TuningDecoyDocV3,
  TuningGoldDocV3,
} from '../../src/memory/audit/tuning-fixtures-v3.ts';
import type { FrozenKMinTable, FrozenRaritySnapshot } from '../../src/memory/bigram-null-model.ts';
import { NULL_MODEL_SCHEMA, RARITY_SNAPSHOT_SCHEMA } from '../../src/memory/bigram-null-model.ts';
import type { FrozenLocalityGeometryTable } from '../../src/memory/locality-null-model.ts';
import { GEOMETRY_NULL_MODEL_SCHEMA } from '../../src/memory/locality-null-model.ts';
import type { FrozenLocalityWitness } from '../../src/memory/locality-frozen.ts';
import { frozenLocalityDecision } from '../../src/memory/locality-frozen.ts';
import type { ExplainedRankedCard, GatedSearchOutcome } from '../../src/memory/types.ts';
import {
  KMIN_B_MIN_VALUES,
  MANIFEST_SCHEMA,
  GEOMETRY_FILE_NAME,
  RARITY_FILE_NAME,
  kminFileName,
  sha256Hex,
  type NullModelManifest,
} from './build-null-model-v3.ts';
import {
  summarizeTuningRows,
  type TuningCalibrationRowV3,
  type TuningLayerV3,
} from './calibrate-tuning-v3.ts';

/** 经 manifest 哈希核验后的三系冻结表束。 */
export interface NullModelBundle {
  readonly manifest: NullModelManifest;
  readonly kminByBMin: ReadonlyMap<number, FrozenKMinTable>;
  readonly geometry: FrozenLocalityGeometryTable;
  readonly rarity: FrozenRaritySnapshot;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

/**
 * 装载冻结表并逐 artifact 重算 sha256 与 manifest 对账。
 * 任何字节篡改、文件缺失、schema 不符或档位不齐都直接 throw（fail-loud，绝无静默回退）。
 */
export function loadVerifiedNullModel(tableDir: string): NullModelBundle {
  const manifestPath = path.join(tableDir, 'null-model-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`冻结表 manifest 缺失：${manifestPath}`);
  const manifest = readJson(manifestPath) as NullModelManifest;
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new Error(`manifest schema 不符：期望 ${MANIFEST_SCHEMA}，实得 ${String(manifest.schema)}`);
  }
  const declaredBmins = [...manifest.bMinValues].sort((x, y) => x - y).join(',');
  const expectedBmins = [...KMIN_B_MIN_VALUES].sort((x, y) => x - y).join(',');
  if (declaredBmins !== expectedBmins) {
    throw new Error(`manifest bMinValues 档位不齐：期望 ${expectedBmins}，实得 ${declaredBmins}`);
  }

  const kminByBMin = new Map<number, FrozenKMinTable>();
  let geometry: FrozenLocalityGeometryTable | null = null;
  let rarity: FrozenRaritySnapshot | null = null;

  for (const artifact of manifest.artifacts) {
    const file = path.join(tableDir, artifact.file);
    if (!fs.existsSync(file)) throw new Error(`manifest 登记的 artifact 缺失：${artifact.file}`);
    // 权威口径对齐 build-null-model-v3.ts:299-327：manifest 哈希锚定 JSON.stringify 规范正文，
    // 落盘仅追加一个尾换行。故对账先 parse 再规范序列化，尾空白差异不影响语义体哈希。
    const rawBody = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(rawBody) as { schema?: unknown };
    const actualHash = sha256Hex(JSON.stringify(parsed));
    if (actualHash !== artifact.sha256) {
      throw new Error(`冻结表 sha256 哈希对账失败（文件可能被篡改）：${artifact.file} manifest=${artifact.sha256} actual=${actualHash}`);
    }
    if (parsed.schema !== artifact.schema) {
      throw new Error(`冻结表 schema 不符：${artifact.file} 登记=${artifact.schema} 实得=${String(parsed.schema)}`);
    }
    if (artifact.schema === NULL_MODEL_SCHEMA) {
      const table = parsed as FrozenKMinTable;
      const bMin = Number(table.bMin);
      if (artifact.file !== kminFileName(bMin)) {
        throw new Error(`kmin 档名与 bMin 不一致：${artifact.file} bMin=${bMin}`);
      }
      kminByBMin.set(bMin, table);
    } else if (artifact.schema === GEOMETRY_NULL_MODEL_SCHEMA) {
      geometry = parsed as FrozenLocalityGeometryTable;
    } else if (artifact.schema === RARITY_SNAPSHOT_SCHEMA) {
      rarity = parsed as FrozenRaritySnapshot;
    } else {
      throw new Error(`未知冻结表 schema：${artifact.schema}`);
    }
  }

  for (const bMin of KMIN_B_MIN_VALUES) {
    if (!kminByBMin.has(bMin)) throw new Error(`kmin 档位缺失：bMin=${bMin}`);
  }
  if (geometry === null) throw new Error('几何冻结表缺失');
  if (rarity === null) throw new Error('稀有桶快照缺失');
  return { manifest, kminByBMin, geometry, rarity };
}

/** 组级裁决归一标签（透传四态＋frozen 三态）。 */
export type LocalityVerdictLabel =
  | 'passthrough-hit'
  | 'passthrough-empty-query'
  | 'passthrough-zero-lexical-hit'
  | 'passthrough-no-lexical'
  | 'no-witness'
  | 'pass'
  | 'exact-equal'
  | 'no-strict-leader';

/** 单档读数：v3 信封字段＋frozen 标签＋金标/对手位次＋见证五元组。 */
export interface CandidateV3BMinReading {
  readonly bMin: number;
  readonly v3Status: string;
  readonly v3Reason?: string;
  readonly v3AcceptedCount: number;
  readonly v3GoldRanks: readonly number[];
  readonly v3RivalRanks: readonly number[];
  readonly localityVerdict: LocalityVerdictLabel;
  readonly witness: FrozenLocalityWitness | null;
  /** 同题 v2 基线事实，供配对算术直接消费，避免回表。 */
  readonly v2Top1Gold: boolean;
  readonly v2AcceptedCount: number;
  /** 逐档冗余同一份表哈希，单档读数脱离父行也可独立对账。 */
  readonly tableHashes: CandidateCalibrationRowV3['tableHashes'];
}

/** v2 标定行扩展：追加三系表哈希与五档 v3 读数。 */
export interface CandidateCalibrationRowV3 extends TuningCalibrationRowV3 {
  readonly tableHashes: {
    readonly manifest: string;
    readonly kmin: string;
    readonly geometry: string;
    readonly rarity: string;
  };
  readonly v3: readonly CandidateV3BMinReading[];
}

interface BuildRowInput {
  readonly row2: TuningCalibrationRowV3;
  readonly qNorm: string;
  readonly candidates: readonly ExplainedRankedCard[];
  readonly atMs: number;
  readonly limit?: number;
  readonly goldEventIds: readonly string[];
  readonly rivalEventIds: readonly string[];
  readonly bundle: NullModelBundle;
}

function hashOf(manifest: NullModelManifest, fileName: string): string {
  const hit = manifest.artifacts.find((a) => a.file === fileName);
  if (hit === undefined) throw new Error(`manifest 未登记文件：${fileName}`);
  return hit.sha256;
}

/**
 * 单题五档读数纯函数。frozen 原语标签与 gate-v3 信封做双向不变量互校，
 * 任一不符说明双轨接线漂移，直接 throw 而不是产出可疑行。
 */
export function buildCandidateRow(input: BuildRowInput): CandidateCalibrationRowV3 {
  const { row2, qNorm, candidates, atMs, limit, goldEventIds, rivalEventIds, bundle } = input;
  const outcome2 = applyGateV2({ qNorm, candidates, atMs, limit });

  const lexicalCandidateCount = candidates.filter(
    (c) => Array.isArray(c.lexicalFields) && c.lexicalFields.length > 0,
  ).length;

  const frozenCandidates = candidates
    .filter((c) => Array.isArray(c.lexicalFields) && c.lexicalFields.length > 0)
    .map((c) => ({ cardId: c.card.cardId, lexicalFields: c.lexicalFields as readonly string[] }));

  const tableHashes = {
    manifest: sha256Hex(JSON.stringify(bundle.manifest)),
    kmin: hashOf(bundle.manifest, kminFileName(KMIN_B_MIN_VALUES[0]!)),
    geometry: hashOf(bundle.manifest, GEOMETRY_FILE_NAME),
    rarity: hashOf(bundle.manifest, RARITY_FILE_NAME),
  };

  const v3: CandidateV3BMinReading[] = [];
  for (const bMin of KMIN_B_MIN_VALUES) {
    const kminTable = bundle.kminByBMin.get(bMin);
    if (kminTable === undefined) throw new Error(`束内缺档 bMin=${bMin}`);
    const outcome3 = applyGateV3({
      qNorm,
      candidates,
      atMs,
      limit,
      kminTable,
      geometryTable: bundle.geometry,
      raritySnapshot: bundle.rarity,
    });

    let label: LocalityVerdictLabel;
    if (outcome2.status === 'hit') {
      label = 'passthrough-hit';
    } else if (outcome2.reason === 'empty-query') {
      label = 'passthrough-empty-query';
    } else if (outcome2.reason === 'zero-lexical-hit') {
      label = 'passthrough-zero-lexical-hit';
    } else if (lexicalCandidateCount === 0) {
      label = 'passthrough-no-lexical';
    } else {
      const frozen = frozenLocalityDecision({
        queryNorm: qNorm,
        candidates: frozenCandidates,
        kminTable,
        geometryTable: bundle.geometry,
        raritySnapshot: bundle.rarity,
      });
      if (frozen.outcome === 'pass') {
        label = 'pass';
      } else if (frozen.reason === 'no-witness') {
        label = 'no-witness';
      } else {
        label = frozen.reason; // exact-equal | no-strict-leader
      }
      // 双向不变量：frozen 与 gate-v3 信封必须讲同一件事。
      if (label === 'pass' && outcome3.status !== 'hit') {
        throw new Error(`v3 接线不变量破坏：frozen pass 但信封非 hit（${row2.probeId} b${bMin}）`);
      }
      if ((label === 'exact-equal' || label === 'no-strict-leader') && outcome3.reason !== 'locality-conflict') {
        throw new Error(`v3 接线不变量破坏：frozen ${label} 但信封非 locality-conflict（${row2.probeId} b${bMin}）`);
      }
      if (label === 'no-witness' && !(outcome3.status === 'no-match' && outcome3.reason === 'all-rejected')) {
        throw new Error(`v3 接线不变量破坏：no-witness 未透传 all-rejected（${row2.probeId} b${bMin}）`);
      }
    }
    if (label === 'passthrough-hit' && outcome3.status !== 'hit') {
      throw new Error(`v3 接线不变量破坏：v2 hit 未透传（${row2.probeId} b${bMin}）`);
    }

    const rankOf = (eventId: string, list: readonly { card: { eventId: string } }[]): number =>
      list.findIndex((entry) => entry.card.eventId === eventId);
    const leader = outcome3.accepted[0] ?? null;

    v3.push({
      bMin,
      v3Status: outcome3.status,
      v3Reason: outcome3.reason,
      v3AcceptedCount: outcome3.accepted.length,
      v3GoldRanks: goldEventIds.map((id) => rankOf(id, outcome3.accepted)),
      v3RivalRanks: rivalEventIds.map((id) => rankOf(id, outcome3.accepted)),
      localityVerdict: label,
      witness: leader?.localityDetail ? { ...leader.localityDetail } : null,
      v2Top1Gold: row2.goldRanks.some((rank) => rank === 0),
      v2AcceptedCount: row2.acceptedCount,
      tableHashes,
    });
  }

  return {
    ...row2,
    tableHashes,
    v3,
  };
}

// ------------------------------------------------------------ 配对指标与机械定档

function bestGoldRank(reading: CandidateV3BMinReading): number {
  const positives = reading.v3GoldRanks.filter((rank) => rank >= 0);
  return positives.length === 0 ? -1 : Math.min(...positives);
}

/** 单题单档配对事实。 */
function pairFacts(row: CandidateCalibrationRowV3, bMin: number): {
  v3Hit: boolean;
  goldTop1: boolean;
  recovered: boolean;
  newWrongCommit: boolean;
  conflictCost: boolean;
  decoyFalseAccept: boolean;
  abstainFalseAccept: boolean;
  highRiskWrong: boolean;
} {
  const reading = row.v3.find((r) => r.bMin === bMin);
  if (reading === undefined) throw new Error(`行 ${row.probeId} 缺 bMin=${bMin} 读数`);
  const goldRank = bestGoldRank(reading);
  const v3Hit = reading.v3Status === 'hit';
  const goldTop1 = goldRank === 0;
  const rivalIn = reading.v3RivalRanks.some((rank) => rank >= 0);
  return {
    v3Hit,
    goldTop1,
    // 回收：v2 零合格卡，v3 救回且 top1 正是金标。
    recovered: reading.v2AcceptedCount === 0 && v3Hit && goldTop1,
    // 新增 wc（蓝图「wc 零新增」增量口径）：仅当 v2 本就零合格卡，v3 分叉把非金标顶到第一。
    // v2 自己已错误放行的存量 wc 经透传原样保留，开关 v3 边际错误为零，记 inheritedWrongCommit 披露而非灭档。
    newWrongCommit: reading.v2AcceptedCount === 0 && v3Hit && !goldTop1,
    // 冲突弃权成本：v2 本已金标 top1，v3 反而不给合格卡。
    conflictCost: reading.v2Top1Gold && !v3Hit,
    // 诱饵误收（增量）：v2 零合格卡的 decoy 题，被 v3 放进对手或未让金标守住第一。
    decoyFalseAccept:
      row.layer === 'tuning-decoy' && reading.v2AcceptedCount === 0 && v3Hit && (!goldTop1 || rivalIn),
    // 弃权题误收（增量）：v2 零合格卡的 abstain 题出现任何 v3 合格卡即破闸。
    abstainFalseAccept:
      row.layer === 'tuning-abstain' && reading.v2AcceptedCount === 0 && reading.v3AcceptedCount > 0,
    // 高危 wc 按蓝图硬闸门第一条保持绝对口径（v3 输出面高危题错误命中即灭，不分存量/增量）；
    // A/B 调参卷 highRiskLabel 样本为 0，该门当前空转，终考卷高危层背书。
    highRiskWrong: row.highRiskLabel !== undefined && v3Hit && !goldTop1,
  };
}

export interface HardGateReport {
  readonly bMin: number;
  readonly passed: boolean;
  readonly highRiskWrong: number;
  readonly newWrongCommit: number;
  readonly decoyFalseAccept: number;
  readonly abstainFalseAccept: number;
}

/** 硬闸门（200 §9 五条在本卷的可观测投影）：四类错误计数必须全 0。 */
export function hardGateForBMin(rows: readonly CandidateCalibrationRowV3[], bMin: number): HardGateReport {
  const report = {
    bMin,
    passed: true,
    highRiskWrong: 0,
    newWrongCommit: 0,
    decoyFalseAccept: 0,
    abstainFalseAccept: 0,
  };
  for (const row of rows) {
    const f = pairFacts(row, bMin);
    if (f.highRiskWrong) report.highRiskWrong += 1;
    if (f.newWrongCommit) report.newWrongCommit += 1;
    if (f.decoyFalseAccept) report.decoyFalseAccept += 1;
    if (f.abstainFalseAccept) report.abstainFalseAccept += 1;
  }
  report.passed =
    report.highRiskWrong === 0 &&
    report.newWrongCommit === 0 &&
    report.decoyFalseAccept === 0 &&
    report.abstainFalseAccept === 0;
  return report;
}

export interface NetBenefitReport {
  readonly bMin: number;
  readonly recovered: number;
  readonly conflictCost: number;
  readonly net: number;
}

/** 净收益＝新增正确回收 − 新增冲突弃权（蓝图 §8.2）。 */
export function netBenefit(rows: readonly CandidateCalibrationRowV3[], bMin: number): NetBenefitReport {
  let recovered = 0;
  let conflictCost = 0;
  for (const row of rows) {
    const f = pairFacts(row, bMin);
    if (f.recovered) recovered += 1;
    if (f.conflictCost) conflictCost += 1;
  }
  return { bMin, recovered, conflictCost, net: recovered - conflictCost };
}

export interface BMinStat extends HardGateReport, NetBenefitReport {}

/** selectBMin 逐档明细的序列化形状：硬闸门结论同时给 passed/hardGatePassed 两个别名。 */
type BMinStatSerializable = BMinStat & { readonly hardGatePassed: boolean };

export type BMinDecision =
  | { readonly status: 'selected'; readonly selectedBMin: number; readonly perBMin: readonly BMinStatSerializable[] }
  | {
      readonly status: 'anomaly-all-eliminated' | 'anomaly-tie-affects-judgment';
      readonly selectedBMin: null;
      readonly perBMin: readonly BMinStatSerializable[];
    };

/**
 * 机械定档（蓝图 §8.3，零临场裁量）：
 *  1. 硬闸门灭掉任何带误伤的档；全灭 → S2 anomaly-all-eliminated；
 *  2. 合规档内净收益最大；唯一最大者选定；
 *  3. 净收益并列且（recovered, conflictCost）分量同构 → 取更紧档（bMin 更大）；
 *     分量分歧（同分不同质，松紧取舍改变终判解释）→ S2 anomaly-tie-affects-judgment。
 */
export function selectBMin(rows: readonly CandidateCalibrationRowV3[]): BMinDecision {
  const perBMin: BMinStatSerializable[] = KMIN_B_MIN_VALUES.map((bMin) => {
    const gate = hardGateForBMin(rows, bMin);
    const benefit = netBenefit(rows, bMin);
    return { ...gate, ...benefit, hardGatePassed: gate.passed };
  });
  const eligible = perBMin.filter((s) => s.passed);
  if (eligible.length === 0) {
    return { status: 'anomaly-all-eliminated', selectedBMin: null, perBMin };
  }
  const bestNet = Math.max(...eligible.map((s) => s.net));
  const leaders = eligible.filter((s) => s.net === bestNet);
  if (leaders.length === 1) {
    return { status: 'selected', selectedBMin: leaders[0]!.bMin, perBMin };
  }
  const signature = (s: BMinStat): string => `${s.recovered}/${s.conflictCost}`;
  const sameShape = leaders.every((s) => signature(s) === signature(leaders[0]!));
  if (!sameShape) {
    return { status: 'anomaly-tie-affects-judgment', selectedBMin: null, perBMin };
  }
  // 同构并列：机械取更紧档（bMin 更大）。
  const tightest = leaders.reduce((acc, s) => (s.bMin > acc.bMin ? s : acc));
  return { status: 'selected', selectedBMin: tightest.bMin, perBMin };
}

// ------------------------------------------------------------ 分析侧统计（不进门）

/**
 * McNemar 配对精确双侧检验：b=v2 错而 v3 对、c=v2 对而 v3 错，零假设 p=0.5。
 * 用 BigInt 精确二项计数（n≤1086 无精度问题），不引第三方统计库；n=0 无分歧返 p=1。
 */
export function mcnemarExact(b: number, c: number): { readonly b: number; readonly c: number; readonly n: number; readonly twoSidedP: number } {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) {
    throw new Error('McNemar 输入须为非负整数');
  }
  const n = b + c;
  if (n === 0) return { b, c, n, twoSidedP: 1 };
  const binom = (total: number, k: number): bigint => {
    if (k < 0 || k > total) return 0n;
    let num = 1n;
    let den = 1n;
    for (let i = 1; i <= k; i += 1) {
      num *= BigInt(total - k + i);
      den *= BigInt(i);
    }
    return num / den;
  };
  const k = Math.max(b, c);
  let tail = 0n;
  for (let i = k; i <= n; i += 1) tail += binom(n, i);
  const denom = 2n ** BigInt(n);
  const twoSided = Math.min(1, Number(2n * tail * 1_000_000_000_000n / denom) / 1_000_000_000_000);
  return { b, c, n, twoSidedP: twoSided };
}

/** Wilson 得分区间（默认 95%，z=Φ⁻¹(0.975)）；分母为零返零区间不产 NaN。 */
export function wilsonInterval(
  success: number,
  total: number,
  z = 1.959963984540054,
): { readonly point: number; readonly low: number; readonly high: number } {
  if (total === 0) return { point: 0, low: 0, high: 0 };
  const phat = success / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / total + z2 / (4 * total * total))) / denom;
  return { point: phat, low: center - margin, high: center + margin };
}

/**
 * 把单题 v3 某档读数投影成 v2 同构标定行，使五表聚合 summarizeTuningRows 可零改造复用
 * （蓝图 §8.2：分桶/分区/硬度/负样本型全套维度复用同一套五表结构）。
 */
export function toV3CalibrationRow(
  row: CandidateCalibrationRowV3,
  bMin: number,
): TuningCalibrationRowV3 {
  const reading = row.v3.find((r) => r.bMin === bMin);
  if (reading === undefined) throw new Error(`行 ${row.probeId} 缺 bMin=${bMin} 读数`);
  return {
    probeId: row.probeId,
    layer: row.layer,
    bucket: row.bucket,
    partition: row.partition,
    queryText: row.queryText,
    hardness: row.hardness,
    negativeSignature: row.negativeSignature,
    highRiskLabel: row.highRiskLabel,
    constructionLayer: row.constructionLayer,
    candidateCount: row.candidateCount,
    acceptedCount: reading.v3AcceptedCount,
    status: reading.v3Status,
    goldRanks: [...reading.v3GoldRanks],
    rivalRanks: [...reading.v3RivalRanks],
    // 三元组平局属 v2 排序层观测，v3 行不重算（v2 权威读数以 calibrate-tuning-v3 产物为准）。
    topTie: false,
    topEvidenceSum: null,
    secondEvidenceSum: null,
  };
}

export interface CandidateBMinStats {
  readonly bMin: number;
  readonly hardGate: HardGateReport;
  readonly benefit: NetBenefitReport;
  /** McNemar 不一致对：b=v2 不合格而 v3 正确回收，c=v2 正确命中而 v3 冲突弃权。 */
  readonly mcnemar: { readonly b: number; readonly c: number; readonly n: number; readonly twoSidedP: number };
  /** v3 金标 top1 率的 Wilson 区间（全集分母）。 */
  readonly goldTop1Interval: { readonly point: number; readonly low: number; readonly high: number };
  /** 回收率区间：分母为 v2 零合格卡题数（调参卷主战场）。 */
  readonly recoveredInterval: { readonly point: number; readonly low: number; readonly high: number };
  readonly v2NoMatchCount: number;
  readonly v3Summary: ReturnType<typeof summarizeTuningRows>;
}

/** 单档配对统计组装（纯函数；显著性只如实报 p 与区间，不产 PASSED）。 */
export function buildCandidateStats(
  rows: readonly CandidateCalibrationRowV3[],
  bMin: number,
): CandidateBMinStats {
  const hardGate = hardGateForBMin(rows, bMin);
  const benefit = netBenefit(rows, bMin);
  let conflictCost = 0;
  let v2NoMatchCount = 0;
  let goldTop1 = 0;
  for (const row of rows) {
    const f = pairFacts(row, bMin);
    if (f.conflictCost) conflictCost += 1;
    if (row.acceptedCount === 0) v2NoMatchCount += 1;
    if (bestGoldRank(row.v3.find((r) => r.bMin === bMin)!) === 0) goldTop1 += 1;
  }
  const projected = rows.map((row) => toV3CalibrationRow(row, bMin));
  return {
    bMin,
    hardGate,
    benefit,
    mcnemar: mcnemarExact(benefit.recovered, conflictCost),
    goldTop1Interval: wilsonInterval(goldTop1, rows.length),
    recoveredInterval: wilsonInterval(benefit.recovered, v2NoMatchCount),
    v2NoMatchCount,
    v3Summary: summarizeTuningRows(projected),
  };
}

// ------------------------------------------------------------ I/O 回放壳

interface EvaluateVolumeInput {
  readonly indexFile: string;
  readonly gold: TuningGoldDocV3;
  readonly decoy: TuningDecoyDocV3;
  readonly abstain: TuningAbstainDocV3;
  readonly clarify: TuningClarifyDocV3;
  readonly atMs: number;
  readonly limit?: number;
  readonly bundle: NullModelBundle;
}

/** 整卷只读回放：每题一次检索、v2＋五档 v3 同窗完成，产出扩展标定行。 */
export async function evaluateCandidateVolume(input: EvaluateVolumeInput): Promise<CandidateCalibrationRowV3[]> {
  const db = new DatabaseSync(input.indexFile, { readOnly: true });
  const rows: CandidateCalibrationRowV3[] = [];
  try {
    const runOne = (params: {
      probeId: string;
      layer: TuningLayerV3;
      bucket: string;
      partition: CorpusPartitionV3;
      queryText: string;
      goldEventIds: readonly string[];
      rivalEventIds: readonly string[];
      hardness?: 'hard' | 'soft';
      negativeSignature?: number;
      highRiskLabel?: string;
      constructionLayer?: string;
    }): void => {
      const qNorm = normalizeLexicalText(params.queryText);
      const candidates = searchCardsExplainedV2(db, { text: params.queryText, atMs: input.atMs, limit: undefined });
      const outcome2: GatedSearchOutcome = applyGateV2({ qNorm, candidates, atMs: input.atMs, limit: input.limit });
      const rankOf = (eventId: string): number =>
        outcome2.accepted.findIndex((entry) => entry.card.eventId === eventId);
      const row2: TuningCalibrationRowV3 = {
        probeId: params.probeId,
        layer: params.layer,
        bucket: params.bucket,
        partition: params.partition,
        queryText: params.queryText,
        hardness: params.hardness,
        negativeSignature: params.negativeSignature,
        highRiskLabel: params.highRiskLabel,
        constructionLayer: params.constructionLayer,
        candidateCount: candidates.length,
        acceptedCount: outcome2.accepted.length,
        status: outcome2.status,
        goldRanks: params.goldEventIds.map(rankOf),
        rivalRanks: params.rivalEventIds.map(rankOf),
        topTie: false,
        topEvidenceSum: null,
        secondEvidenceSum: null,
      };
      rows.push(buildCandidateRow({
        row2,
        qNorm,
        candidates,
        atMs: input.atMs,
        limit: input.limit,
        goldEventIds: params.goldEventIds,
        rivalEventIds: params.rivalEventIds,
        bundle: input.bundle,
      }));
    };

    for (const item of input.gold.items) {
      for (const queryText of item.queries) {
        runOne({
          probeId: item.probeId, layer: 'tuning-gold', bucket: item.bucket, partition: item.partitionTag,
          queryText, goldEventIds: item.goldEventIds, rivalEventIds: [],
          negativeSignature: item.negativeSignature, highRiskLabel: item.highRiskLabel,
          constructionLayer: item.constructionLayer,
        });
      }
    }
    for (const item of input.decoy.items) {
      runOne({
        probeId: item.probeId, layer: 'tuning-decoy', bucket: item.bucket, partition: item.partitionTag,
        queryText: item.discriminatorQuery, goldEventIds: [item.goldEventId], rivalEventIds: item.rivalEventIds,
        negativeSignature: item.negativeSignature, highRiskLabel: item.highRiskLabel,
      });
    }
    for (const item of input.abstain.items) {
      runOne({
        probeId: item.probeId, layer: 'tuning-abstain', bucket: item.bucket, partition: item.partitionTag,
        queryText: item.query,
        goldEventIds: item.goldEventId === null ? [] : [item.goldEventId], rivalEventIds: [],
        hardness: item.hardness, negativeSignature: item.negativeSignature, highRiskLabel: item.highRiskLabel,
      });
    }
    for (const item of input.clarify.items) {
      runOne({
        probeId: item.probeId, layer: 'tuning-clarify', bucket: item.bucket, partition: item.partitionTag,
        queryText: item.query, goldEventIds: item.pairEventIds, rivalEventIds: [],
        negativeSignature: item.negativeSignature, highRiskLabel: item.highRiskLabel,
      });
    }
  } finally {
    db.close();
  }
  return rows;
}

interface CliArgs {
  tuning: string | undefined;
  worldRoot: string | undefined;
  nullModel: string | undefined;
  nowMs: number | undefined;
  out: string | undefined;
  limit: number | undefined;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { tuning: undefined, worldRoot: undefined, nullModel: undefined, nowMs: undefined, out: undefined, limit: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`参数 ${flag} 缺少取值`);
    i += 1;
    if (flag === '--tuning') args.tuning = value;
    else if (flag === '--world-root') args.worldRoot = value;
    else if (flag === '--null-model') args.nullModel = value;
    else if (flag === '--now-ms') args.nowMs = Number(value);
    else if (flag === '--out') args.out = value;
    else if (flag === '--limit') args.limit = Number(value);
    else throw new Error(`未知参数 ${flag}`);
  }
  return args;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tuning || !args.worldRoot || !args.nullModel) {
    process.stderr.write(
      '用法：calibrate-candidate-v3.ts --tuning <四件套目录> --world-root <v3 合成根> --null-model <冻结表目录> [--now-ms <ms>] [--limit <n>] [--out <目录>]\n',
    );
    process.exitCode = 2;
    return;
  }

  const bundle = loadVerifiedNullModel(args.nullModel);
  const goldRaw = readJson(path.join(args.tuning, 'tuning-gold.json'));
  const decoyRaw = readJson(path.join(args.tuning, 'tuning-decoy.json'));
  const abstainRaw = readJson(path.join(args.tuning, 'tuning-abstain.json'));
  const clarifyRaw = readJson(path.join(args.tuning, 'tuning-clarify.json'));
  validateTuningV3File(goldRaw, 'tuning-gold');
  validateTuningV3File(decoyRaw, 'tuning-decoy');
  validateTuningV3File(abstainRaw, 'tuning-abstain');
  validateTuningV3File(clarifyRaw, 'tuning-clarify');

  const indexFile = path.join(args.worldRoot, 'projection', 'memory-index', 'memory-index.sqlite');
  if (!fs.existsSync(indexFile)) throw new Error(`索引库不存在：${indexFile}`);

  const atMs = args.nowMs ?? buildWorldV3().referenceNowMs;
  const rows = await evaluateCandidateVolume({
    indexFile,
    gold: goldRaw as TuningGoldDocV3,
    decoy: decoyRaw as TuningDecoyDocV3,
    abstain: abstainRaw as TuningAbstainDocV3,
    clarify: clarifyRaw as TuningClarifyDocV3,
    atMs,
    limit: args.limit,
    bundle,
  });
  const v2Summary = summarizeTuningRows(rows);
  const decision = selectBMin(rows);

  process.stdout.write(`候选门标定：行=${rows.length} v2金标top1=${v2Summary.totals.goldTop1Count}/${v2Summary.totals.n}\n`);
  for (const stat of decision.perBMin) {
    process.stdout.write(
      `  b${stat.bMin}: 硬闸门=${stat.passed ? '过' : '灭'} 回收=${stat.recovered} 冲突成本=${stat.conflictCost}` +
        ` 净收益=${stat.net} 高危错=${stat.highRiskWrong} 新wc=${stat.newWrongCommit} 诱饵误收=${stat.decoyFalseAccept} 弃权误收=${stat.abstainFalseAccept}\n`,
    );
  }
  process.stdout.write(`定档：${decision.status}${decision.selectedBMin !== null ? ` b${decision.selectedBMin}` : '（S2 停点上报主控）'}\n`);
  const stats = KMIN_B_MIN_VALUES.map((bMin) => buildCandidateStats(rows, bMin));
  for (const stat of stats) {
    process.stdout.write(
      `  b${stat.bMin} 配对：McNemar(b=${stat.mcnemar.b},c=${stat.mcnemar.c},p=${stat.mcnemar.twoSidedP.toFixed(4)})` +
        ` 金标top1率=${(stat.goldTop1Interval.point * 100).toFixed(2)}%` +
        `[${(stat.goldTop1Interval.low * 100).toFixed(2)}%,${(stat.goldTop1Interval.high * 100).toFixed(2)}%]` +
        ` 回收率(v2零合格卡分母=${stat.v2NoMatchCount})=${(stat.recoveredInterval.point * 100).toFixed(2)}%` +
        `[${(stat.recoveredInterval.low * 100).toFixed(2)}%,${(stat.recoveredInterval.high * 100).toFixed(2)}%]\n`,
    );
  }

  if (args.out !== undefined) {
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, 'candidate-rows.json'), `${JSON.stringify({ atMs, rows }, null, 2)}\n`);
    fs.writeFileSync(path.join(args.out, 'candidate-decision.json'), `${JSON.stringify(decision, null, 2)}\n`);
    fs.writeFileSync(path.join(args.out, 'candidate-stats.json'), `${JSON.stringify(stats, null, 2)}\n`);
    fs.writeFileSync(path.join(args.out, 'v2-summary.json'), `${JSON.stringify(v2Summary, null, 2)}\n`);
    process.stdout.write(`读数已落盘：${args.out}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
