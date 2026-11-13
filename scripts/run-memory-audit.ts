/**
 * 记忆层离线审计 CLI —— 方案 §4.10/§4.11/§6（裁决 I1-A/I2/I5/I11/I12/I13/I15/I16，记录见 §11.8）。
 *
 * 继承 build CLI 纪律：
 *  - --data-root 必填（缺省用法 + 退出码 2）；--out 必填（缺省 exit2）且不得等于/位于 dataRoot 之内（exit2）；
 *  - --json/--help 同 build CLI；--holdout 显式才解封 L2；--dry-run 只校验/打印不落 audit 库；
 *  - 对 --data-root 恒 openMemoryRead 只读（读真值 JSONL/卡/检索），**永不在该库取写柄**；
 *    写柄只开在 --out（同一 MEMORY_SCHEMA，卡/miss 表空、仅审计两表落行）；生产索引零字节写、真值从不写；
 *  - 默认即可写独立 --out 库（不触生产索引/真值），无需 --apply 二次确认；
 *  - 退出码：provenance 硬失败/悬空锚点非零；三红线观测项无论是否越线均 exit0。
 *
 * I5 编排层职责：foldCurrentEvents 折叠当前态、merge/split 接力映射、anchor 折叠→缓存漂移 Map、
 * 冷启动判定、引发方分层（system→environment 归并）一律在本脚本算成标量/Map 注入 audit 纯函数；
 * audit 六文件不读事件锚点字段。门面 Fasti.open 仅在此装配 resolver（I2）。
 *
 * 运行（Node ≥ 22，类型剥离直跑）：
 *   node scripts/run-memory-audit.ts --data-root <tmp> --out <tmp>/audit --json
 *   node scripts/run-memory-audit.ts --data-root <tmp> --out <tmp>/audit --dry-run
 *   node scripts/run-memory-audit.ts --data-root <tmp> --out <tmp>/audit --holdout
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Fasti } from '../src/api/index.ts';
import { parseEvent } from '../src/contract/event.ts';
import type { EventRecord } from '../src/contract/event.ts';
import type { Experience } from '../src/contract/experience.ts';
import { parseExperience } from '../src/contract/validate-experience.ts';
import { NotFoundError } from '../src/core/errors.ts';
import { listFiles } from '../src/core/fsx.ts';
import { readJsonlFile } from '../src/core/jsonl.ts';
import { ulid } from '../src/core/ulid.ts';
import { aggregateMetrics, mulberry32, DEFAULT_RNG_SEED, P95_REPEATS } from '../src/memory/audit/metrics.ts';
import type { AggregateInput, MetricsJson, Rng } from '../src/memory/audit/metrics.ts';
import { loadFixtures } from '../src/memory/audit/fixtures.ts';
import type { LoadedFixtures } from '../src/memory/audit/fixtures.ts';
import { replayGold } from '../src/memory/audit/gold.ts';
import type { GoldQuestion, GoldQuestionResult, SearchFn } from '../src/memory/audit/gold.ts';
import { buildDecoyPairs, scoreDecoy } from '../src/memory/audit/decoy.ts';
import type { DecoyQuestionResult } from '../src/memory/audit/decoy.ts';
import { evaluateConsistency, consistencyPairKey } from '../src/memory/audit/consistency.ts';
import type { ConsistencyResult, ReflectionPair } from '../src/memory/audit/consistency.ts';
import { auditProvenance } from '../src/memory/audit/provenance.ts';
import type { PointerResolver, ProvenanceResult } from '../src/memory/audit/provenance.ts';
import { assembleWindow } from '../src/memory/window.ts';
import { openMemoryRead, openMemoryWrite } from '../src/memory/store.ts';
import type { MemoryReadHandle } from '../src/memory/store.ts';
import type { AuditItemRecord, AuditRunRecord, MemoryCard, RankedCard, AssembledWindow } from '../src/memory/types.ts';
import { foldCurrentEvents } from '../src/projection/event-row.ts';
import type { EventProjection } from '../src/projection/types.ts';
import { layoutOf, resolveDataRoot } from '../src/source/paths.ts';

const DAY_MS = 24 * 3600 * 1000;
const COLD_START_GAP_MS = 7 * DAY_MS;
const MIN_CALENDAR_WEEKS = 5;

// ── 参数 ──────────────────────────────────────────────────────────────────

interface CliOptions {
  dataRoot: string | undefined;
  out: string | undefined;
  holdout: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dataRoot: undefined,
    out: undefined,
    holdout: false,
    dryRun: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--data-root':
      case '--out': {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error(`参数 ${arg} 缺少取值`);
        }
        i += 1;
        if (arg === '--data-root') {
          options.dataRoot = value;
        } else {
          options.out = value;
        }
        break;
      }
      case '--holdout':
        options.holdout = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数 ${arg}`);
    }
  }
  return options;
}

function usage(): string {
  return [
    '用法：node scripts/run-memory-audit.ts --data-root <目录> --out <目录> [选项]',
    '',
    '  --data-root <目录>  数据根（**必填**，只读：真值 JSONL/卡/检索；永不在该库取写柄）',
    '  --out <目录>        审计输出库目录（**必填**，独立于 dataRoot；等于/位于其内一律拒绝 exit2）',
    '  --holdout           显式解封 L2 holdout 跑一次（缺省不跑）',
    '  --dry-run           只校验夹具/打印报告，不落 audit 库（CI 预检）',
    '  --json              输出 JSON 报告（机器可读）',
    '  --help              本帮助',
    '',
    '纪律：生产 memory-index.sqlite 零字节写入；真值 JSONL 从不写；审计写独立 --out 库（卡/miss 表空）；',
    '      hit_count 仅报告模拟、绝不回写生产卡；三红线只观测不卡退出码；',
    '      provenance 成功率<100%/悬空锚点 → 硬失败退出码非零。',
    '',
  ].join('\n');
}

/** --out 落根内守卫：等于 dataRoot 或位于其内 → 拒绝。 */
function isInsideOutGuard(dataRoot: string, out: string): boolean {
  const root = path.resolve(dataRoot);
  const target = path.resolve(out);
  return target === root || target.startsWith(root + path.sep);
}

// ── 真值只读 + 编排层预计算（I5/I16）──────────────────────────────────────

interface Truth {
  experiences: Experience[];
  experienceById: Map<string, Experience>;
  events: EventProjection[];
  eventById: Map<string, EventProjection>;
}

function readTruth(dataRoot: string): Truth {
  const layout = layoutOf(resolveDataRoot({ dataRoot }));
  const experiences: Experience[] = [];
  for (const name of listFiles(layout.experiences, '.jsonl')) {
    for (const raw of readJsonlFile<unknown>(path.join(layout.experiences, name))) {
      experiences.push(parseExperience(raw, 'read'));
    }
  }
  const eventRows: EventRecord[] = [];
  for (const name of listFiles(layout.events, '.jsonl')) {
    for (const raw of readJsonlFile<unknown>(path.join(layout.events, name))) {
      eventRows.push(parseEvent(raw, 'read'));
    }
  }
  const events = foldCurrentEvents(eventRows);
  return {
    experiences,
    experienceById: new Map(experiences.map((e) => [e.id, e])),
    events,
    eventById: new Map(events.map((e) => [e.id, e])),
  };
}

/** 接力映射：merge/split 当前态 → successor（复用 foldCurrentEvents 当前态 + merged_into/split_into）。 */
function buildRelay(events: readonly EventProjection[]): {
  relayMap: Map<string, string>;
  relayChains: Map<string, readonly string[]>;
} {
  const relayMap = new Map<string, string>();
  const relayChains = new Map<string, readonly string[]>();
  for (const event of events) {
    if (event.merged_into !== null) {
      relayMap.set(event.id, event.merged_into);
      relayChains.set(event.id, [event.id, event.merged_into]);
    } else if (event.split_into.length > 0) {
      const successor = event.split_into[0]!;
      relayMap.set(event.id, successor);
      relayChains.set(event.id, [event.id, successor]);
    }
  }
  return { relayMap, relayChains };
}

/**
 * 缓存漂移：卡的 anchor id 折叠出的当前事件须与 card.eventId 一致（编排层读事件锚点字段，I5）。
 * 真值事件锚点映射以折叠后继语义为准。
 */
function buildCacheDrift(
  cards: readonly MemoryCard[],
  events: readonly EventProjection[],
): Map<string, boolean> {
  const anchorToEvent = new Map<string, string>();
  for (const event of events) {
    for (const anchorId of event.anchors) {
      anchorToEvent.set(anchorId, event.id);
    }
  }
  const drift = new Map<string, boolean>();
  for (const card of cards) {
    const anchorIds = JSON.parse(card.anchorJson) as string[];
    const expected = anchorIds.length > 0 ? anchorToEvent.get(anchorIds[0]!) : undefined;
    drift.set(card.cardId, expected === undefined || expected !== card.eventId);
  }
  return drift;
}

function isoMs(iso: string): number {
  return Date.parse(iso);
}

/** 引发方归并：system → environment（I16，KNOWN_INITIATIONS 四值不增设第四分层）。 */
function stratumOf(initiation: string): 'her' | 'user' | 'environment' {
  if (initiation === 'her') {
    return 'her';
  }
  if (initiation === 'user') {
    return 'user';
  }
  return 'environment';
}

/** 冷启动：提问轮与目标事件 occurred 差 >7 天且其间无指向同一 event_id 的经历（只读真值计算，I16）。 */
function isColdStart(question: Experience, target: EventProjection | undefined, truth: Truth): boolean {
  if (target === undefined) {
    return false;
  }
  const questionMs = isoMs(question.occurred_at);
  const gap = questionMs - target.started_ms;
  if (gap <= COLD_START_GAP_MS) {
    return false;
  }
  const anchorSet = new Set(target.anchors);
  const intermediateMention = truth.experiences.some((e) => {
    const ms = isoMs(e.occurred_at);
    return ms > target.ended_ms && ms < questionMs && anchorSet.has(e.id);
  });
  return !intermediateMention;
}

/** 从夹具 + 真值组装金标提问（queryText 取提问经历 cue；initiation/coldStart 由真值计算）。 */
function buildGoldQuestions(fixtures: LoadedFixtures, truth: Truth, includeHoldout: boolean): GoldQuestion[] {
  const questions: GoldQuestion[] = [];
  for (const item of fixtures.l0) {
    for (const queryText of item.queries) {
      questions.push({
        queryText,
        targetEventId: item.eventId,
        questionRef: item.eventId,
        source: 'l0',
        initiation: 'user',
        coldStart: false,
      });
    }
  }
  const l1Items = includeHoldout ? [...fixtures.l1, ...fixtures.l2] : fixtures.l1;
  for (const item of l1Items) {
    const question = truth.experienceById.get(item.questionExperienceId);
    const target = truth.eventById.get(item.targetEventId);
    const queryText = question?.observation.cue ?? '';
    questions.push({
      queryText,
      targetEventId: item.targetEventId,
      questionRef: item.questionExperienceId,
      source: fixtures.l2.includes(item) ? 'l2' : 'l1',
      initiation: question === undefined ? item.initiation : stratumOf(question.initiation),
      coldStart: question === undefined ? item.coldStart : isColdStart(question, target, truth),
    });
  }
  return questions;
}

/** 可覆盖日历周数（提问轮 occurred 的 ISO 周去重）；<5 → LOEO 降级（I15）。 */
function calendarWeeks(questions: readonly GoldQuestion[], truth: Truth): number {
  const weeks = new Set<string>();
  for (const q of questions) {
    const experience = truth.experienceById.get(q.questionRef);
    if (experience !== undefined) {
      const date = new Date(isoMs(experience.occurred_at));
      weeks.add(`${date.getUTCFullYear()}-W${Math.floor(date.getUTCMonth() * 4.34 + date.getUTCDate() / 7)}`);
    }
  }
  return weeks.size;
}

/** FTS cue_text 只读快照（编排层读 mem_card_fts 注入 provenance，I5）。 */
function readFtsText(indexDir: string, cards: readonly MemoryCard[]): Map<string, string> {
  const map = new Map<string, string>();
  const file = path.join(indexDir, 'memory-index.sqlite');
  if (!fs.existsSync(file)) {
    return map;
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const stmt = db.prepare('SELECT cue_text FROM mem_card_fts WHERE card_id = ?');
    for (const card of cards) {
      const row = stmt.get(card.cardId) as { cue_text: string } | undefined;
      if (row !== undefined) {
        map.set(card.cardId, row.cue_text);
      }
    }
  } finally {
    db.close();
  }
  return map;
}

/** P95：只测 assembleWindow 纯函数路径，performance.now 编排层计时，固定 N=1000（I12）。 */
function measureP95(cards: readonly MemoryCard[]): number {
  const candidates: RankedCard[] = cards.map((card) => ({
    card,
    scoreParts: { bm25: 0, recency: 0 },
    matchedTerms: [],
  }));
  const times: number[] = [];
  for (let i = 0; i < P95_REPEATS; i += 1) {
    const start = performance.now();
    assembleWindow(candidates);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const idx = Math.min(times.length - 1, Math.floor(0.95 * (times.length - 1)));
  return times[idx]!;
}

// ── 审计条目组装 ──────────────────────────────────────────────────────────

function goldItems(runId: string, startNo: number, results: readonly GoldQuestionResult[]): AuditItemRecord[] {
  return results.map((r, i) => ({
    runId,
    itemNo: startNo + i,
    probeType: 'gold',
    expectedRef: r.targetEventId,
    returnedRefsJson: JSON.stringify([r.resolvedEventId]),
    passed: r.hit ? 1 : 0,
    detailJson: JSON.stringify({ rank: r.rank, rank0: r.rank === null ? null : r.rank - 1, relayChain: r.relayChain, source: r.source, initiation: r.initiation, coldStart: r.coldStart, scoreParts: r.scoreParts }),
  }));
}

function decoyItems(runId: string, startNo: number, results: readonly DecoyQuestionResult[]): AuditItemRecord[] {
  return results.map((r, i) => ({
    runId,
    itemNo: startNo + i,
    probeType: 'decoy',
    expectedRef: r.goldCardId,
    returnedRefsJson: JSON.stringify(r.topCardId === null ? [] : [r.topCardId]),
    passed: r.correct ? 1 : 0,
    detailJson: JSON.stringify({ highRiskLabel: r.highRiskLabel ?? null, highRiskError: r.highRiskError }),
  }));
}

function provenanceItems(runId: string, startNo: number, result: ProvenanceResult): AuditItemRecord[] {
  return result.results.map((r, i) => ({
    runId,
    itemNo: startNo + i,
    probeType: 'provenance',
    expectedRef: r.cardId,
    returnedRefsJson: JSON.stringify(r.anchorIds),
    passed: r.ok ? 1 : 0,
    detailJson: JSON.stringify({ resolved: r.resolved, dangling: r.dangling, cacheDrift: r.cacheDrift, ftsTraceable: r.ftsTraceable }),
  }));
}

// ── 编排主入口（导出供 qa 程序化驱动；CLI main 调用）──────────────────────

export interface AuditOptions {
  dataRoot: string;
  outDir: string;
  fixturesDir: string;
  holdout: boolean;
  dryRun: boolean;
  nowMs: number;
  rngSeed?: number;
}

export interface AuditReport {
  run: AuditRunRecord;
  items: AuditItemRecord[];
  metrics: MetricsJson;
  provenanceFailed: boolean;
  holdout: { mode: 'holdout' | 'loeo' | 'not-run'; folds: number };
  redLines: { r1: number | null; r2: number | null; r3: number | null };
  written: boolean;
}

export async function runAudit(options: AuditOptions): Promise<AuditReport> {
  const seed = options.rngSeed ?? DEFAULT_RNG_SEED;
  const fixtures = loadFixtures(options.fixturesDir);
  const truth = readTruth(options.dataRoot);
  const indexDir = path.join(resolveDataRoot({ dataRoot: options.dataRoot }), 'projection', 'memory-index');

  const readHandle: MemoryReadHandle = openMemoryRead({ indexDir });
  const fasti = await Fasti.open({ dataRoot: options.dataRoot });
  try {
    const cards = readHandle.listEffective(options.nowMs);
    const cardsById = new Map(cards.map((c) => [c.cardId, c]));
    const { relayMap, relayChains } = buildRelay(truth.events);
    const cacheDrift = buildCacheDrift(cards, truth.events);
    const ftsTextByCard = readFtsText(indexDir, cards);
    const questions = buildGoldQuestions(fixtures, truth, options.holdout);

    const search: SearchFn = (q) => readHandle.search(q);
    const captured: RankedCard[][] = [];
    const recordingSearch: SearchFn = async (q) => {
      const ranked = await readHandle.search(q);
      captured.push(ranked);
      return ranked;
    };
    const gold = await replayGold(questions, recordingSearch, { atMs: options.nowMs, k: 3, relayMap, relayChains });
    const goldK1 = await replayGold(questions, search, { atMs: options.nowMs, k: 1, relayMap, relayChains });
    const goldK5 = await replayGold(questions, search, { atMs: options.nowMs, k: 5, relayMap, relayChains });
    const windows: AssembledWindow[] = captured.map((candidates) => assembleWindow(candidates));

    const decoyPairs = buildDecoyPairs(cards);
    const decoy = await scoreDecoy(fixtures.decoy, search, { atMs: options.nowMs });

    // consistency：v1 无叙事线，reflection 对来自夹具组织（合成期为空）→ N/A。
    const pairs: ReflectionPair[] = [];
    const windowsByPair = new Map<string, readonly [AssembledWindow, AssembledWindow]>();
    const consistency: ConsistencyResult = evaluateConsistency(pairs, windowsByPair, {
      atMs: options.nowMs,
      aliasTable: [],
      cardsById,
    });

    // I2 resolver：card.anchorJson 存的是经历 id，门面 resolvePointer 按原文指针解析；
    // 编排层把经历 id 翻译为其 observation.text 原文指针再调门面（经历/指针均只读真值）。
    const resolver: PointerResolver = async (pointer) => {
      const experience = truth.experienceById.get(pointer.id ?? '');
      if (experience === undefined) {
        throw new NotFoundError(`经历不存在：${pointer.id ?? ''}`);
      }
      const textPointer = experience.observation.text;
      if (textPointer === undefined) {
        throw new NotFoundError(`经历无原文指针：${experience.id}`);
      }
      return fasti.resolvePointer(textPointer);
    };
    const provenance: ProvenanceResult = await auditProvenance(cards, resolver, {
      rng: mulberry32(seed),
      sampleRatio: 0.2,
      cacheDrift,
      ftsTextByCard,
    });

    const p95Ms = measureP95(cards);
    const simulatedHits = gold.filter((g) => g.hit).length;
    const aggregateInput: AggregateInput = {
      gold,
      goldK1,
      goldK5,
      decoy,
      consistency,
      provenance,
      windows,
      p95Ms,
      roi: { writeCostMinutes: 0, simulatedHits, cards: cards.length },
    };
    const metrics = aggregateMetrics(aggregateInput, { rng: mulberry32(seed) });

    const weeks = calendarWeeks(questions, truth);
    const holdoutMode: 'holdout' | 'loeo' | 'not-run' = !options.holdout
      ? 'not-run'
      : weeks < MIN_CALENDAR_WEEKS
        ? 'loeo'
        : 'holdout';
    const folds = truth.events.length;

    const runId = ulid();
    const items: AuditItemRecord[] = [
      ...goldItems(runId, 1, gold),
      ...decoyItems(runId, 1 + gold.length, decoy),
      ...provenanceItems(runId, 1 + gold.length + decoy.length, provenance),
    ];
    const notes = {
      consistency: { status: consistency.status, pairs: consistency.pairs },
      holdout: { mode: holdoutMode, folds, ...(options.holdout ? { unsealedAt: options.nowMs } : {}) },
      rngSeed: seed,
      sampleN: items.length,
      initiationMerge: 'system->environment',
      decoyPairs: decoyPairs.length,
      nodeVersion: process.version,
      platform: process.platform,
    };
    const run: AuditRunRecord = {
      runId,
      createdMs: options.nowMs,
      sampleN: items.length,
      probeSetVersion: fixtures.probeSetVersion,
      modelTag: 'rules-v1',
      metricsJson: JSON.stringify(metrics),
      notesJson: JSON.stringify(notes),
    };

    let written = false;
    if (!options.dryRun) {
      const writeHandle = openMemoryWrite({ indexDir: options.outDir });
      try {
        writeHandle.writeAuditRun(run, items);
        written = true;
      } finally {
        await writeHandle.close();
      }
    }

    const r1 = 'point' in metrics.retrieval.recallAtK ? metrics.retrieval.recallAtK.point : null;
    const r2 = 'point' in metrics.quality.r2 ? metrics.quality.r2.point : null;
    const r3 = 'point' in metrics.quality.r3 ? metrics.quality.r3.point : null;
    return {
      run,
      items,
      metrics,
      provenanceFailed: provenance.failed,
      holdout: { mode: holdoutMode, folds },
      redLines: { r1, r2, r3 },
      written,
    };
  } finally {
    await readHandle.close();
    await fasti.close();
  }
}

// ── CLI main ──────────────────────────────────────────────────────────────

function defaultFixturesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'memory');
}

function formatReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('  记忆层 v1 · 离线审计报告（C5）');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push(`模式        ：${report.written ? '写独立 audit 库' : 'dry-run（零落库）'}`);
  lines.push(`runId       ：${report.run.runId}`);
  lines.push(`夹具版本    ：${report.run.probeSetVersion}`);
  lines.push(`条目数      ：${report.run.sampleN}`);
  lines.push(`holdout     ：${report.holdout.mode}（folds=${report.holdout.folds}）`);
  lines.push('');
  lines.push('── 三红线（只观测，不卡退出码）─────────────────────────────────');
  lines.push(`R1 召回@3   ：${report.redLines.r1 ?? 'N/A'}`);
  lines.push(`R2 错误认定 ：${report.redLines.r2 ?? 'N/A'}`);
  lines.push(`R3 一致性   ：${report.redLines.r3 ?? 'N/A'}`);
  lines.push('');
  lines.push(`provenance  ：${report.provenanceFailed ? 'FAILED（硬失败）' : '通过'}`);
  lines.push('══════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`错误：${(error as Error).message}\n${usage()}`);
    process.exit(2);
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.dataRoot === undefined) {
    process.stderr.write(`错误：必须显式指定 --data-root\n${usage()}`);
    process.exit(2);
    return;
  }
  if (options.out === undefined) {
    process.stderr.write(`错误：必须显式指定 --out（独立审计输出目录）\n${usage()}`);
    process.exit(2);
    return;
  }
  if (isInsideOutGuard(options.dataRoot, options.out)) {
    process.stderr.write(`错误：--out 不得等于或位于 --data-root 之内（杜绝误写生产索引）\n${usage()}`);
    process.exit(2);
    return;
  }

  let report: AuditReport;
  try {
    report = await runAudit({
      dataRoot: options.dataRoot,
      outDir: options.out,
      fixturesDir: defaultFixturesDir(),
      holdout: options.holdout,
      dryRun: options.dryRun,
      nowMs: Date.now(),
    });
  } catch (error) {
    process.stderr.write(`错误：${(error as Error).message}\n`);
    process.exit(1);
    return;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
  // 硬失败通路（I13）：provenance 成功率<100%/悬空锚点 → 非零；红线观测项不卡退出码。
  if (report.provenanceFailed) {
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}