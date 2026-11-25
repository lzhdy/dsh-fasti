/**
 * 统一调参新卷 · v3 标定读数（W2-6）。
 *
 * 定位：调参卷的职责是**标定候选谓词、不判 PASSED**。本文件提供「读数」，
 * 供 A 卷 ≤3 轮标定与 B 卷一次性确认使用；不写任何阈值、不下判决、不切生产常量。
 *
 * 几何口径（关键，别按错版本读）：
 *  - 生产壳 `searchCardsExplained` 的版本只由冻结常量 `CURRENT_RULES_VERSION`（=rules-v1）决定，
 *    且 `ReadHandle.searchExplained` 会先 `assertGeometryCurrent` —— 因此**无法经读柄跑 v2 几何**；
 *  - 故本脚本直连索引库，调**具名** `searchCardsExplainedV2` + `applyGateV2`
 *    （`src/memory/bm25.ts:440` 明确允许「测试可直接调用具名 V1/V2 函数做双轨断言」）。
 *
 * 两条正本口径（不在本文件自造）：
 *  - V2 门已退役 abstain 语义（`src/memory/gate.ts:377`），弃权题只能记「零合格卡（no-match）」；
 *  - V2 排序是证据三元组（总码点→命中字段数→最长字段）字典序，打平才回落记忆序（`gate.ts:343-360`），
 *    故 tie 的口径是「top1 与 top2 三元组完全相等」。
 *
 * 用法：
 *   node --experimental-strip-types scripts/p6/calibrate-tuning-v3.ts \
 *     --tuning <装配好的四件套目录> --world-root <v3 合成根> [--now-ms <ms>] [--out <目录>]
 * 只读：只以 readOnly 打开索引库，不写根、不落仓库；`--out` 给了才写读数 JSON。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
  applyGateV2,
  normalizeLexicalText,
  reverseContainmentDetail,
  GATE_POLICY_V2,
} from '../../src/memory/gate.ts';
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

/** 参与聚合的题目层。 */
export type TuningLayerV3 = 'tuning-gold' | 'tuning-decoy' | 'tuning-abstain' | 'tuning-clarify';

/** 单题单问句的读数行（纯数据，可序列化、可单测）。 */
export interface TuningCalibrationRowV3 {
  probeId: string;
  layer: TuningLayerV3;
  bucket: string;
  partition: CorpusPartitionV3;
  queryText: string;
  hardness?: 'hard' | 'soft';
  negativeSignature?: number;
  highRiskLabel?: string;
  constructionLayer?: string;
  candidateCount: number;
  acceptedCount: number;
  status: string;
  /** 每个参照事件在合格集中的位次；-1 = 未进合格集。 */
  goldRanks: number[];
  /** decoy 对手事件位次；非 decoy 层为空数组。 */
  rivalRanks: number[];
  topTie: boolean;
  topEvidenceSum: number | null;
  secondEvidenceSum: number | null;
}

export interface TuningStatsBucket {
  n: number;
  goldAcceptedCount: number;
  goldAcceptedRate: number;
  goldTop1Count: number;
  goldTop1Rate: number;
  rivalBeatenCount: number;
  rivalBeatenRate: number;
  noMatchCount: number;
  noMatchRate: number;
  tieCount: number;
  tieRate: number;
}

export interface TuningSummaryV3 {
  totals: TuningStatsBucket;
  byBucket: Record<string, TuningStatsBucket>;
  byPartition: Record<string, TuningStatsBucket>;
  byHardness: Record<string, TuningStatsBucket>;
  bySignature: Record<string, TuningStatsBucket>;
}

function emptyStats(): TuningStatsBucket {
  return {
    n: 0,
    goldAcceptedCount: 0,
    goldAcceptedRate: 0,
    goldTop1Count: 0,
    goldTop1Rate: 0,
    rivalBeatenCount: 0,
    rivalBeatenRate: 0,
    noMatchCount: 0,
    noMatchRate: 0,
    tieCount: 0,
    tieRate: 0,
  };
}

/** 单行派生：位次 → 是否召回 / 是否 top1 / 是否被对手反超 / 是否零合格卡。 */
function deriveRow(row: TuningCalibrationRowV3): {
  goldAccepted: boolean;
  goldTop1: boolean;
  rivalBeaten: boolean | null;
  noMatch: boolean;
  tie: boolean;
} {
  const negRanks = row.goldRanks.filter((rank) => rank >= 0);
  const bestGold = negRanks.length > 0 ? Math.min(...negRanks) : -1;
  const goldAccepted = bestGold >= 0;
  const goldTop1 = bestGold === 0;
  // 只有带对手的 decoy 行才有「反超」分母；对手全未进也算赢。
  const rivalBeaten =
    row.rivalRanks.length === 0
      ? null
      : goldAccepted && row.rivalRanks.every((rank) => rank < 0 || rank > bestGold);
  const noMatch = row.acceptedCount === 0;
  return { goldAccepted, goldTop1, rivalBeaten, noMatch, tie: row.topTie };
}

function accumulate(target: TuningStatsBucket, row: TuningCalibrationRowV3): void {
  const d = deriveRow(row);
  target.n += 1;
  if (d.goldAccepted) target.goldAcceptedCount += 1;
  if (d.goldTop1) target.goldTop1Count += 1;
  if (d.rivalBeaten === true) target.rivalBeatenCount += 1;
  if (d.noMatch) target.noMatchCount += 1;
  if (d.tie) target.tieCount += 1;
}

/** 比率收口：分母为零一律 0（绝不产出 NaN / Infinity）。 */
function finalize(stats: TuningStatsBucket, rivalN: number): TuningStatsBucket {
  const ratio = (num: number, den: number): number => (den === 0 ? 0 : num / den);
  return {
    ...stats,
    goldAcceptedRate: ratio(stats.goldAcceptedCount, stats.n),
    goldTop1Rate: ratio(stats.goldTop1Count, stats.n),
    rivalBeatenRate: ratio(stats.rivalBeatenCount, rivalN),
    noMatchRate: ratio(stats.noMatchCount, stats.n),
    tieRate: ratio(stats.tieCount, stats.n),
  };
}

/**
 * 纯聚合：输入读数行，输出「总表 / 按桶 / 按分区 / 按硬度 / 按负样本型」五张表。
 * 桶与型别是调参卷的主要读数维度（201 §4：标定脚本按型聚合统计）。
 */
export function summarizeTuningRows(rows: readonly TuningCalibrationRowV3[]): TuningSummaryV3 {
  const totals = emptyStats();
  const byBucket = new Map<string, TuningStatsBucket>();
  const byPartition = new Map<string, TuningStatsBucket>();
  const byHardness = new Map<string, TuningStatsBucket>();
  const bySignature = new Map<string, TuningStatsBucket>();
  // rivalBeaten 的分母与 n 不同，单独按分组计数。
  const rivalDen = new Map<string, number>();
  let rivalDenTotal = 0;

  const bump = (map: Map<string, TuningStatsBucket>, key: string): TuningStatsBucket => {
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    const created = emptyStats();
    map.set(key, created);
    return created;
  };

  for (const row of rows) {
    accumulate(totals, row);
    accumulate(bump(byBucket, row.bucket), row);
    accumulate(bump(byPartition, row.partition), row);
    if (row.hardness !== undefined) accumulate(bump(byHardness, row.hardness), row);
    if (row.negativeSignature !== undefined) accumulate(bump(bySignature, String(row.negativeSignature)), row);

    if (row.rivalRanks.length > 0) {
      rivalDenTotal += 1;
      rivalDen.set(row.bucket, (rivalDen.get(row.bucket) ?? 0) + 1);
      rivalDen.set(row.partition, (rivalDen.get(row.partition) ?? 0) + 1);
      if (row.hardness !== undefined) rivalDen.set(`h:${row.hardness}`, (rivalDen.get(`h:${row.hardness}`) ?? 0) + 1);
      if (row.negativeSignature !== undefined) {
        rivalDen.set(`s:${row.negativeSignature}`, (rivalDen.get(`s:${row.negativeSignature}`) ?? 0) + 1);
      }
    }
  }

  const finalMap = (map: Map<string, TuningStatsBucket>, denOf: (key: string) => number): Record<string, TuningStatsBucket> => {
    const out: Record<string, TuningStatsBucket> = {};
    for (const [key, stats] of map) out[key] = finalize(stats, denOf(key));
    return out;
  };

  return {
    totals: finalize(totals, rivalDenTotal),
    byBucket: finalMap(byBucket, (key) => rivalDen.get(key) ?? 0),
    byPartition: finalMap(byPartition, (key) => rivalDen.get(key) ?? 0),
    byHardness: finalMap(byHardness, (key) => rivalDen.get(`h:${key}`) ?? 0),
    bySignature: finalMap(bySignature, (key) => rivalDen.get(`s:${key}`) ?? 0),
  };
}

// ---------------------------------------------------------------- I/O 壳

/** 三元组复算（与 gate.judgeV2 同口径，exact 通道取 Infinity）。 */
function evidenceTriple(
  qNorm: string,
  card: { matchKinds: readonly string[]; lexicalFields?: readonly string[] },
): { sum: number; hits: number; max: number } {
  if (card.matchKinds.includes('exact-alias')) {
    return {
      sum: GATE_POLICY_V2.exactEvidenceInfinity,
      hits: 1,
      max: GATE_POLICY_V2.exactEvidenceInfinity,
    };
  }
  if (card.lexicalFields !== undefined) {
    const detail = reverseContainmentDetail(qNorm, card.lexicalFields, GATE_POLICY_V2.minContainCodepoints);
    return { sum: detail.sum, hits: detail.hits, max: detail.max };
  }
  return { sum: 0, hits: 0, max: 0 };
}

interface EvaluateInput {
  readonly indexFile: string;
  readonly gold: TuningGoldDocV3;
  readonly decoy: TuningDecoyDocV3;
  readonly abstain: TuningAbstainDocV3;
  readonly clarify: TuningClarifyDocV3;
  readonly atMs: number;
  readonly limit?: number;
}

/** 对一份装配好的调参卷逐题检索，产出读数行。只读打开索引库。 */
export async function evaluateTuningVolume(input: EvaluateInput): Promise<TuningCalibrationRowV3[]> {
  const db = new DatabaseSync(input.indexFile, { readOnly: true });
  const rows: TuningCalibrationRowV3[] = [];
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
      const candidates = searchCardsExplainedV2(db, {
        text: params.queryText,
        atMs: input.atMs,
        limit: undefined,
      });
      const gated = applyGateV2({
        qNorm,
        candidates,
        atMs: input.atMs,
        limit: input.limit,
      });
      const accepted = gated.accepted;
      const rankOf = (eventId: string): number => accepted.findIndex((entry) => entry.card.eventId === eventId);
      const tripleOf = (index: number): { sum: number; hits: number; max: number } | null => {
        const entry = accepted[index];
        if (entry === undefined) return null;
        return evidenceTriple(qNorm, entry);
      };
      const top = tripleOf(0);
      const second = tripleOf(1);
      const topTie =
        top !== null &&
        second !== null &&
        top.sum === second.sum &&
        top.hits === second.hits &&
        top.max === second.max;
      rows.push({
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
        acceptedCount: accepted.length,
        status: gated.status,
        goldRanks: params.goldEventIds.map(rankOf),
        rivalRanks: params.rivalEventIds.map(rankOf),
        topTie,
        topEvidenceSum: top === null ? null : top.sum,
        secondEvidenceSum: second === null ? null : second.sum,
      });
    };

    for (const item of input.gold.items) {
      for (const queryText of item.queries) {
        runOne({
          probeId: item.probeId,
          layer: 'tuning-gold',
          bucket: item.bucket,
          partition: item.partitionTag,
          queryText,
          goldEventIds: item.goldEventIds,
          rivalEventIds: [],
          negativeSignature: item.negativeSignature,
          highRiskLabel: item.highRiskLabel,
          constructionLayer: item.constructionLayer,
        });
      }
    }
    for (const item of input.decoy.items) {
      runOne({
        probeId: item.probeId,
        layer: 'tuning-decoy',
        bucket: item.bucket,
        partition: item.partitionTag,
        queryText: item.discriminatorQuery,
        goldEventIds: [item.goldEventId],
        rivalEventIds: item.rivalEventIds,
        negativeSignature: item.negativeSignature,
        highRiskLabel: item.highRiskLabel,
      });
    }
    for (const item of input.abstain.items) {
      runOne({
        probeId: item.probeId,
        layer: 'tuning-abstain',
        bucket: item.bucket,
        partition: item.partitionTag,
        queryText: item.query,
        // 弃权题的「金标」若存在，仅作观测：v2 门没有 abstain 状态，只记是否零合格卡。
        goldEventIds: item.goldEventId === null ? [] : [item.goldEventId],
        rivalEventIds: [],
        hardness: item.hardness,
        negativeSignature: item.negativeSignature,
        highRiskLabel: item.highRiskLabel,
      });
    }
    for (const item of input.clarify.items) {
      runOne({
        probeId: item.probeId,
        layer: 'tuning-clarify',
        bucket: item.bucket,
        partition: item.partitionTag,
        queryText: item.query,
        goldEventIds: item.pairEventIds,
        rivalEventIds: [],
        negativeSignature: item.negativeSignature,
        highRiskLabel: item.highRiskLabel,
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
  nowMs: number | undefined;
  out: string | undefined;
  limit: number | undefined;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { tuning: undefined, worldRoot: undefined, nowMs: undefined, out: undefined, limit: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`参数 ${flag} 缺少取值`);
    i += 1;
    if (flag === '--tuning') args.tuning = value;
    else if (flag === '--world-root') args.worldRoot = value;
    else if (flag === '--now-ms') args.nowMs = Number(value);
    else if (flag === '--out') args.out = value;
    else if (flag === '--limit') args.limit = Number(value);
    else throw new Error(`未知参数 ${flag}`);
  }
  return args;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tuning || !args.worldRoot) {
    process.stderr.write(
      '用法：calibrate-tuning-v3.ts --tuning <四件套目录> --world-root <v3 合成根> [--now-ms <ms>] [--limit <n>] [--out <目录>]\n',
    );
    process.exitCode = 2;
    return;
  }
  const goldRaw = readJson(path.join(args.tuning, 'tuning-gold.json'));
  const decoyRaw = readJson(path.join(args.tuning, 'tuning-decoy.json'));
  const abstainRaw = readJson(path.join(args.tuning, 'tuning-abstain.json'));
  const clarifyRaw = readJson(path.join(args.tuning, 'tuning-clarify.json'));
  // 前端再校验一遍：标定读数建立在合法卷之上，非法卷不出数字。
  validateTuningV3File(goldRaw, 'tuning-gold');
  validateTuningV3File(decoyRaw, 'tuning-decoy');
  validateTuningV3File(abstainRaw, 'tuning-abstain');
  validateTuningV3File(clarifyRaw, 'tuning-clarify');

  const indexFile = path.join(args.worldRoot, 'projection', 'memory-index', 'memory-index.sqlite');
  if (!fs.existsSync(indexFile)) throw new Error(`索引库不存在：${indexFile}`);

  const atMs = args.nowMs ?? buildWorldV3().referenceNowMs;
  const rows = await evaluateTuningVolume({
    indexFile,
    gold: goldRaw as TuningGoldDocV3,
    decoy: decoyRaw as TuningDecoyDocV3,
    abstain: abstainRaw as TuningAbstainDocV3,
    clarify: clarifyRaw as TuningClarifyDocV3,
    atMs,
    limit: args.limit,
  });
  const summary = summarizeTuningRows(rows);

  process.stdout.write(
    `标定读数：行=${rows.length} 金标top1=${summary.totals.goldTop1Count}/${summary.totals.n}` +
      ` 零合格卡=${summary.totals.noMatchCount} 平局=${summary.totals.tieCount}\n`,
  );
  for (const [bucket, stats] of Object.entries(summary.byBucket).sort((x, y) => x[0].localeCompare(y[0]))) {
    process.stdout.write(
      `  ${bucket}: n=${stats.n} top1=${(stats.goldTop1Rate * 100).toFixed(1)}%` +
        ` 召回=${(stats.goldAcceptedRate * 100).toFixed(1)}%` +
        ` 反超胜=${(stats.rivalBeatenRate * 100).toFixed(1)}%` +
        ` 零合格=${(stats.noMatchRate * 100).toFixed(1)}%\n`,
    );
  }

  if (args.out !== undefined) {
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, 'tuning-rows.json'), `${JSON.stringify({ atMs, rows }, null, 2)}\n`);
    fs.writeFileSync(path.join(args.out, 'tuning-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`读数已落盘：${args.out}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
