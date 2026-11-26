/**
 * 记忆层离线审计 CLI —— 方案 §4.10/§4.11/§6（裁决 I1-A/I2/I5/I11/I12/I13/I15/I16，记录见 §11.8）。
 *
 * 继承 build CLI 纪律：
 *  - --data-root 必填（缺省用法 + 退出码 2）；--out 必填（缺省 exit2）且不得等于/位于 dataRoot 之内（exit2）；
 *  - --json/--help 同 build CLI；--holdout 显式才解封 L2；--dry-run 只校验/打印不落 audit 库；
 *  - 对 --data-root 恒 openMemoryRead 只读（读真值 JSONL/卡/检索），**永不在该库取写柄**；
 *    写柄只开在 --out（同一 MEMORY_SCHEMA，卡/miss 表空、仅审计两表落行）；
 *    **零字节承诺仅限记忆索引 memory-index.sqlite**（store.ts 只读打开）；真值 JSONL 从不写。
 *    注意 dataRoot 并非整体零字节：Fasti.open 启动对账会原子写 state/checkpoint.json
 *    （checkpoint.ts save → writeFileAtomic），事件版本追加写 events/*.jsonl（event-log appendVersion）；
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
import { NotFoundError, IntegrityError } from '../src/core/errors.ts';
import { listFiles } from '../src/core/fsx.ts';
import { readJsonlFile } from '../src/core/jsonl.ts';
import { ulid } from '../src/core/ulid.ts';
import { aggregateMetrics, mulberry32, DEFAULT_RNG_SEED, P95_REPEATS } from '../src/memory/audit/metrics.ts';
import type { AggregateInput, MetricsJson, NaEstimate, Rng } from '../src/memory/audit/metrics.ts';
import { loadFixtures } from '../src/memory/audit/fixtures.ts';
import type { LoadedFixtures } from '../src/memory/audit/fixtures.ts';
import { loadAbstainFixtures, abstainHasGold, PROBES_V2_PATTERN, loadClarifyFixtures } from '../src/memory/audit/fixtures.ts';
import type { LoadedAbstainFixtures, LoadedClarifyFixtures } from '../src/memory/audit/fixtures.ts';
import { judgeV2 } from '../src/memory/audit/judgment-v2.ts';
import type { JudgmentV2, LayerProbeV2, DecoyProbeV2, AbstainProbeV2, ClarifyProbeV2 } from '../src/memory/audit/judgment-v2.ts';
import { buildLayerProbesV2, collectTop1Records } from '../src/memory/audit/top1-alignment.ts';
import { gatedVerdictCaveat } from '../src/memory/audit/gated-caveat.ts';
import { gradedLexicalSignals } from '../src/memory/lexical-signals.ts';
import { decideClarify } from '../src/memory/clarify-policy.ts';
import type { ClarifyAction, ClarifyCandidate, ClarifyReason } from '../src/memory/clarify-policy.ts';
import type { GatedSearchOutcome, GradedSignals } from '../src/memory/types.ts';
import type { Top1Record } from '../src/memory/audit/top1-alignment.ts';
import { applyGateV1, applyGateV2, normalizeLexicalText } from '../src/memory/gate.ts';
import type { ApplyGateInput } from '../src/memory/gate.ts';
import { applyGateV3 } from '../src/memory/gate-v3.ts';
import { loadVerifiedNullModel } from './p6/calibrate-candidate-v3.ts';
import type { FrozenKMinTable } from '../src/memory/bigram-null-model.ts';
import type { FrozenLocalityGeometryTable } from '../src/memory/locality-null-model.ts';
import type { FrozenRaritySnapshot } from '../src/memory/bigram-null-model.ts';
import { summarizeFourState } from '../src/memory/audit/four-state.ts';
import type { FourStateProbeInput, FourStateSummary } from '../src/memory/audit/four-state.ts';
import { assertMissAliasesSensitive, assertP6GoldItem } from '../src/memory/audit/fixture-guard.ts';
import type { GuardCardRef } from '../src/memory/audit/fixture-guard.ts';
import { replayGold } from '../src/memory/audit/gold.ts';
import type { GoldQuestion, GoldQuestionResult, SearchFn } from '../src/memory/audit/gold.ts';
import { buildDecoyPairs, scoreDecoy } from '../src/memory/audit/decoy.ts';
import type { DecoyQuestionResult } from '../src/memory/audit/decoy.ts';
import { evaluateConsistency, consistencyPairKey } from '../src/memory/audit/consistency.ts';
import { runLoeo } from '../src/memory/audit/loeo.ts';
import type { LoeoResult } from '../src/memory/audit/loeo.ts';
import { verifySeal, appendUnsealRecord } from '../src/memory/audit/sealing.ts';
import type { ConsistencyResult, ReflectionPair } from '../src/memory/audit/consistency.ts';
import { auditProvenance } from '../src/memory/audit/provenance.ts';
import type { PointerResolver, ProvenanceResult } from '../src/memory/audit/provenance.ts';
import { assembleWindow } from '../src/memory/window.ts';
import { openMemoryRead, openMemoryWrite } from '../src/memory/store.ts';
import type { MemoryReadHandle, MemoryInternalReadHandle } from '../src/memory/store.ts';
import type { AuditItemRecord, AuditRunRecord, MemoryCard, RankedCard, AssembledWindow } from '../src/memory/types.ts';
import { CURRENT_RULES_VERSION } from '../src/memory/types.ts';
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
  rulesVersion: string | undefined;
  nullModelDir: string | undefined;
  sealDir: string | undefined;
  unsealReason: string | undefined;
  operator: string | undefined;
  nowMs: number | undefined;
  holdout: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

export function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    dataRoot: undefined,
    out: undefined,
    rulesVersion: undefined,
    nullModelDir: undefined,
    sealDir: undefined,
    unsealReason: undefined,
    operator: undefined,
    nowMs: undefined,
    holdout: false,
    dryRun: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--data-root':
      case '--out':
      case '--rules-version':
      case '--null-model':
      case '--seal-dir':
      case '--unseal-reason':
      case '--operator':
      case '--now-ms': {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error(`参数 ${arg} 缺少取值`);
        }
        i += 1;
        if (arg === '--data-root') {
          options.dataRoot = value;
        } else if (arg === '--out') {
          options.out = value;
        } else if (arg === '--rules-version') {
          options.rulesVersion = value;
        } else if (arg === '--null-model') {
          options.nullModelDir = value;
        } else if (arg === '--seal-dir') {
          options.sealDir = value;
        } else if (arg === '--unseal-reason') {
          options.unsealReason = value;
        } else if (arg === '--now-ms') {
          const ms = Number(value);
          if (!Number.isInteger(ms) || ms <= 0) {
            throw new Error(`--now-ms 须为正整数毫秒（收到「${value}」）`);
          }
          options.nowMs = ms;
        } else {
          options.operator = value;
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
    '  --rules-version <v> 受测规则版本（rules-v1/rules-v2/rules-v3），缺省当前生产版本；信封如实记录',
    '  --null-model <目录> rules-v3 专用：已冻结空模型表目录（manifest＋五档 kmin＋几何＋稀有桶）。',
    '                      传入即逐 artifact 重算 sha256 对账，任一不符 fail-loud；v1/v2 路径忽略。',
    '                      审计侧固定按 bMin=3 档回放（W5 确认档，不得自选档）。',
    '  --holdout           显式解封封存层跑一次（必须同时给 --seal-dir 与 --unseal-reason）',
    '  --seal-dir <目录>   已封存夹具目录（G6：先哈希核验，读取即追加解封留痕）',
    '  --unseal-reason <t> 本次解封理由（必填，写入封存目录 unseal-log.jsonl）',
    '  --operator <名>     解封操作人（缺省 offline-cli）',
    '  --now-ms <毫秒>     审计时钟（缺省墙钟 Date.now()）。终判须钉死到受测世界的参考时钟',
    '                      （world-plan 的 WORLD_REFERENCE_NOW_MS），否则卡片在其 valid_ms 之前不算生效、',
    '                      金标会被判「悬空」；报封信封 createdMs 如实记录该值',
    '  --dry-run           只校验夹具/打印报告，不落 audit 库（CI 预检）',
    '  --json              输出 JSON 报告（机器可读）',
    '  --help              本帮助',
    '',
    '纪律：记忆索引 memory-index.sqlite 零字节写入（只读打开；承诺范围仅此文件）；真值 JSONL 从不写；',
    '      dataRoot 内 state/checkpoint.json 与 events/*.jsonl 的既有写通路不在本承诺内；审计写独立 --out 库（卡/miss 表空）；',
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
        highRisk: item.highRiskLabel !== undefined,
        constructionLayer: item.constructionLayer,
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
      highRisk: item.highRiskLabel !== undefined,
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
  /**
   * 受测规则版本（G7 信封去硬编码）。缺省 CURRENT_RULES_VERSION；仅允许登记过的版本，
   * 未知标签 fail-closed——run 信封必须如实记录「本次审计测的是哪套规则」。
   */
  rulesVersion?: string;
  /**
   * rules-v3 专用：已冻结空模型表目录（#230 蓝图 218 §10.2）。v3 通道**必须**给，
   * 缺表时 fail-loud 拒绝回放——审计不得以「近似门」冒充受测门。
   */
  nullModelDir?: string;
  /**
   * 已封存夹具目录（v4 §8/序9 G6）。--holdout 终判必须走封存集：
   * 传入即先重算哈希核验，再在解封时追加留痕；裸 --holdout 旗标已废止。
   */
  sealedDir?: string;
  /** 解封理由（使用封存集时必填，写入 unseal-log）。 */
  unsealReason?: string;
  /** 解封操作人（缺省 offline-cli）。 */
  operator?: string;
}

/*
 * 【封存标记 · 2026-11-26 主控拍板，正本 §11.13.21】rules-v3 候选门上线线已终止并整体封存。
 * 下方 v3 具名回放通道（白名单/版本分派/--null-model/缺表 fail-loud）作为休眠件保留：
 * 生产常量 CURRENT_RULES_VERSION 恒 rules-v1、默认审计路径零行为变化，v3 仅在显式
 * --rules-version rules-v3 且带冻结表时可达。复工必须先读正本 §11.13.21 与蓝图 218 §10/§11，
 * 走新卡＋主控新授权，禁止在此直接续线。
 */
/** 允许出现在审计信封里的规则版本（与 cue-derive 白名单同源管理，未知值拒收）。 */
export const KNOWN_RULES_VERSIONS: ReadonlySet<string> = new Set(['rules-v1', 'rules-v2', 'rules-v3']);

/** 版本→具名门实现（#230 蓝图 218 §10.2）。未知版本 fail-closed，绝不回落生产常量门。 */
export type RulesGateMode = 'v1' | 'v2' | 'v3';

/**
 * rules v3 候选门固定使用的 bMin 档：3。
 * 法定出处：W5 一次性确认档（#229 留档，`calibrate-candidate-v3` 机械定档 selected=b3）。
 * 审计侧不得自选档，否则等价于事后调档，W5「不再调档」条款即失效。
 */
export const FROZEN_B_MIN_V3 = 3;

/**
 * v3 通道的表目录前置守卫：v3 必须有 --null-model，v1/v2 一律忽略该参数。
 * 独立成纯函数以便红测钉住「缺表即拒跑」这条，而不是只靠文本守卫。
 */
export function requireNullModelDirForV3(mode: RulesGateMode, nullModelDir: string | undefined): string | undefined {
  if (mode !== 'v3') {
    return nullModelDir;
  }
  if (nullModelDir === undefined) {
    throw new Error('rules-v3 必须指定 --null-model：拒绝以缺表状态跑 rules-v3');
  }
  return nullModelDir;
}

/** 审计侧 v3 门所需三张正式冻结表（#226 落盘、哈希已对账）。 */
interface FrozenGateTables {
  readonly kminTable: FrozenKMinTable;
  readonly geometryTable: FrozenLocalityGeometryTable;
  readonly raritySnapshot: FrozenRaritySnapshot;
}

/**
 * 装载并校验 v3 冻结表。任一 artifact 哈希/schema/档位不符即抛错（复用 calibrate-candidate-v3
 * 的 fail-loud 对账口径，不另造一套校验）。固定取 bMin=3 档：审计侧不自选档。
 */
function loadFrozenGateTablesForAudit(nullModelDir: string | undefined): FrozenGateTables {
  const dir = requireNullModelDirForV3('v3', nullModelDir);
  if (dir === undefined) throw new Error('rules-v3 必须指定 --null-model：拒绝以缺表状态跑 rules-v3');
  const bundle = loadVerifiedNullModel(dir);
  const kminTable = bundle.kminByBMin.get(FROZEN_B_MIN_V3);
  if (kminTable === undefined) {
    throw new Error(`冻结表缺 bMin=${FROZEN_B_MIN_V3} 档：拒绝以缺表状态跑 rules-v3`);
  }
  return { kminTable, geometryTable: bundle.geometry, raritySnapshot: bundle.rarity };
}

/** 把受测版本标签解析为具名门选择；白名单之外的标签一律拒绝。 */
export function resolveRulesGateMode(rulesVersion: string): RulesGateMode {
  if (!KNOWN_RULES_VERSIONS.has(rulesVersion)) {
    throw new Error(`未知规则版本「${rulesVersion}」：审计信封只接受 ${[...KNOWN_RULES_VERSIONS].join('/')}`);
  }
  switch (rulesVersion) {
    case 'rules-v1':
      return 'v1';
    case 'rules-v2':
      return 'v2';
    case 'rules-v3':
      return 'v3';
    default:
      throw new Error(`未知规则版本「${rulesVersion}」：审计信封只接受 ${[...KNOWN_RULES_VERSIONS].join('/')}`);
  }
}

/**
 * P0 分级词面信号留痕行（#193/194 §四 P0）：每题一条，仅披露不判分。
 * top1Signals 取门后第一名卡（accepted[0] 优先，否则 rejected[0]）；goldSignals 取金标事件卡
 * 若在本次候选集内，否则 null（未召回）。两者均为 null 表示该题零候选。
 */
export interface GatedSignalRow {
  probeRef: string;
  layer?: string;
  committed: boolean;
  top1Signals: GradedSignals | null;
  goldSignals: GradedSignals | null;
}

/** 卡的词面字段集：v2 优先结构化 lexicalFields，回退 cueText 单字段（v1 卷无门后栈，不影响）。 */
function lexicalFieldsOf(card: { lexicalFields?: string[]; cueText?: string }): string[] {
  if (card.lexicalFields !== undefined && card.lexicalFields.length > 0) return card.lexicalFields;
  return card.cueText !== undefined ? [card.cueText] : [];
}

/**
 * 乙机制澄清决策器离线模拟行（#194）：每题一条，只在审计侧产出，生产门零消费。
 * cohort 区分金标题/弃权题/澄清题三个队列；goldInTieGroup 仅金标题有语义
 * （金标未入候选为 null），pairLocked 仅澄清题有语义（配对双卡是否同在打平组）。
 */
export interface ClarifyPolicyRow {
  probeRef: string;
  layer?: string;
  cohort: 'gold' | 'abstain' | 'clarify';
  action: ClarifyAction;
  reason: ClarifyReason;
  candidateCount: number;
  tiedCardIds: readonly string[];
  goldInTieGroup: boolean | null;
  pairLocked: boolean | null;
}

/** 全过门卡 → 决策器输入：同一趟回放内顺手算信号，不额外检索。 */
function clarifyCandidatesOf(qNorm: string, outcome: GatedSearchOutcome): ClarifyCandidate[] {
  return outcome.accepted.map((gated) => ({
    cardId: gated.card.cardId,
    signals: gradedLexicalSignals(qNorm, lexicalFieldsOf(gated)),
  }));
}

export interface AuditReport {
  run: AuditRunRecord;
  items: AuditItemRecord[];
  metrics: MetricsJson;
  /** 门后四态汇总（金标题 top1 + 弃权/噪声探针）；无任何探针时 N/A。 */
  fourState: FourStateSummary | NaEstimate;
  /** abstain.json 是否实际加载（缺失只标注，不硬失败，金标题四态仍可算）。 */
  abstainFixturePresent: boolean;
  /** clarify.json 是否实际加载（v2 卷 F6 披露节；缺失须显式标注）。 */
  clarifyFixturePresent: boolean;
  /** v2 卷判决（PASSED/NOT-PASSED/INCONCLUSIVE）；v1 卷为 undefined。 */
  judgmentV2?: JudgmentV2;
  /** v2 卷生产门后栈判决（runGatedSearch 等价口径，192-H1）；v1 卷为 undefined。 */
  judgmentV2Gated?: JudgmentV2;
  /** 生产门后栈四态汇总（192-H1）；未跑 v2 终判时为 undefined。 */
  fourStateGated?: FourStateSummary;
  /** C2-甲：门后栈机械 PASSED 的弃权警告（null＝无警告；v1 卷为 undefined）。 */
  gatedVerdictCaveat?: string | null;
  /** P0 分级词面信号逐题留痕（#193）：仅 v2 门后栈路径产出，只披露不判分。 */
  gatedSignalRows?: readonly GatedSignalRow[];
  /** 乙机制澄清决策器离线模拟逐题行（#194）：仅 v2 门后栈路径产出，不接生产裁决。 */
  clarifyPolicyRows?: readonly ClarifyPolicyRow[];
  provenanceFailed: boolean;
  holdout: { mode: 'holdout' | 'loeo' | 'not-run'; folds: number; loeo?: LoeoResult };
  redLines: { r1: number | null; r2: number | null; r3: number | null };
  written: boolean;
}

export async function runAudit(options: AuditOptions): Promise<AuditReport> {
  const seed = options.rngSeed ?? DEFAULT_RNG_SEED;
  const rulesVersion = options.rulesVersion ?? CURRENT_RULES_VERSION;
  const gateMode = resolveRulesGateMode(rulesVersion);
  // #230：v3 具名通道必须带正式冻结表，缺表即 fail-loud——绝不以近似门冒充受测门。
  const v3Tables = gateMode === 'v3' ? loadFrozenGateTablesForAudit(options.nullModelDir) : null;
  /** 受测门唯一入口：六处回放一律经此分派，源码内不得再出现裸 applyGate 调用。 */
  const gate = (input: ApplyGateInput): GatedSearchOutcome => {
    switch (gateMode) {
      case 'v1':
        return applyGateV1(input);
      case 'v2':
        return applyGateV2(input);
      case 'v3':
        if (v3Tables === null) throw new Error('rules-v3 门表未装载：拒绝以缺表状态跑 rules-v3');
        return applyGateV3({
          ...input,
          kminTable: v3Tables.kminTable,
          geometryTable: v3Tables.geometryTable,
          raritySnapshot: v3Tables.raritySnapshot,
        });
    }
  };
  // 序9/G6：holdout 终判只能读封存集，先哈希核验；普通 dry-run 仍可用施工夹具目录。
  let fixturesDir = options.fixturesDir;
  if (options.holdout) {
    if (options.sealedDir === undefined) {
      throw new IntegrityError('--holdout 必须配合 --seal-dir 指向已封存夹具（裸解封旗标已废止，v4 §8）');
    }
    if (!options.unsealReason || options.unsealReason.trim() === '') {
      throw new IntegrityError('解封封存集必须提供 --unseal-reason（留痕不可空）');
    }
    const verification = verifySeal(options.sealedDir);
    if (!verification.ok) {
      throw new IntegrityError(`封存核验失败，终判无效：${verification.errors.join('；')}`);
    }
    fixturesDir = options.sealedDir;
  }
  const fixtures = loadFixtures(fixturesDir);
  const truth = readTruth(options.dataRoot);
  const indexDir = path.join(resolveDataRoot({ dataRoot: options.dataRoot }), 'projection', 'memory-index');

  const readHandle: MemoryReadHandle = openMemoryRead({ indexDir });
  // 192-H1：审计是离线内部工具（非装配层），需要 explained 全集以等价回放生产门，
  // ReadHandle 本身即实现 MemoryInternalReadHandle（store.ts 类声明），此处仅类型窄化、无运行时转换。
  const explainedHandle = readHandle as MemoryInternalReadHandle;
  const fasti = await Fasti.open({ dataRoot: options.dataRoot });
  try {
    const cards = readHandle.listEffective(options.nowMs);
    const cardsById = new Map(cards.map((c) => [c.cardId, c]));
    // G3/G4（v4 §6）：夹具纪律 fail-closed。B 路线 miss 别名恒 sensitive=1；带构造层标的
    // P6 条目逐条过连续子串/key_points 重合/源定位守卫。无层标的旧骨架条目跳过 G4。
    assertMissAliasesSensitive(fixtures.l0);
    const guardCards = new Map<string, GuardCardRef>(
      cards.map((c) => [
        c.eventId,
        {
          eventId: c.eventId,
          cues: JSON.parse(c.displayCuesJson) as string[],
          aliases: JSON.parse(c.aliasesJson) as GuardCardRef['aliases'],
        },
      ]),
    );
    const eventsById = new Map(truth.events.map((e) => [e.id, e]));
    for (const item of fixtures.l0) {
      if (item.constructionLayer === undefined) {
        continue;
      }
      assertP6GoldItem(item, guardCards.get(item.eventId), eventsById.get(item.eventId)?.key_points ?? []);
    }
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

    // ── 四态/弃权（v4 §5.0、§9 序3）：top1 门后判定，三分母与 R1(top-k)/R2 隔离 ──
    // abstain.json 缺失不硬失败：金标题四态照算，仅在 notes 标注缺探针文件。
    let abstainFixturePresent = true;
    let abstainItems: LoadedAbstainFixtures['items'] = [];
    try {
      abstainItems = loadAbstainFixtures(fixturesDir).items;
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
      abstainFixturePresent = false;
    }
    const fourStateProbes: FourStateProbeInput[] = [];
    /**
     * 逐题对齐的粗召回 top1（192-H2）：键是题目索引而非 eventId。
     * 同事件跨层供题（预注册 v5 §5.3）时旧 Map 口径会被后写层顶包，层探针改由
     * buildLayerProbesV2 按索引组装；四态主计数仍在下方循环里当场落账，行为不变。
     */
    const ungatedTop1: Top1Record[] = [];
    for (const question of questions) {
      const top1 = await readHandle.search({ text: question.queryText, atMs: options.nowMs, limit: 1 });
      const resolvedEventId = relayMap.get(question.targetEventId) ?? question.targetEventId;
      const committed = top1.length > 0;
      const top1IsGold = top1[0]?.card.eventId === resolvedEventId;
      ungatedTop1.push({ committed, top1IsGold });
      fourStateProbes.push({
        probeRef: question.questionRef,
        hasGold: true,
        committed,
        top1IsGold,
        highRisk: question.highRisk ?? false,
      });
    }
    for (const item of abstainItems) {
      const top1 = await readHandle.search({ text: item.query, atMs: options.nowMs, limit: 1 });
      fourStateProbes.push({
        probeRef: `abstain:${item.kind}`,
        hasGold: abstainHasGold(item),
        committed: top1.length > 0,
        top1IsGold: item.goldCardId !== null && top1[0]?.card.cardId === item.goldCardId,
        highRisk: false,
        probeKind: item.kind,
      });
    }
    const fourState: FourStateSummary | NaEstimate =
      fourStateProbes.length === 0
        ? { status: 'n-a', reason: 'no-probe' }
        : summarizeFourState(fourStateProbes);

    // ── v2 判据（预注册 v5 §6.2/§6.3）：仅 fasti-p6-probes/v2 卷启用 ──
    // v1 卷走旧口径（metrics.recallAtK 全量），此处零副作用，保证 v1 成绩单逐字可复现。
    const isV2Probes = PROBES_V2_PATTERN.test(fixtures.probeSetVersion);
    let clarifyFixturePresent = true;
    let clarifyItems: LoadedClarifyFixtures['items'] = [];
    let judgmentV2: JudgmentV2 | undefined;
    let judgmentV2Gated: JudgmentV2 | undefined;
    let fourStateGated: FourStateSummary | undefined;
    let gatedCaveat: string | null = null;
    const gatedSignalRows: GatedSignalRow[] = [];
    const clarifyPolicyRows: ClarifyPolicyRow[] = [];
    if (isV2Probes && options.holdout) {
      // 澄清档只在终判（封存集）路径结算，施工 dry-run 不消化探针。
      try {
        clarifyItems = loadClarifyFixtures(fixturesDir).items;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        clarifyFixturePresent = false;
      }
      // 192-H2：层探针按题目索引逐题对齐，同事件跨层题（v5 §5.3）不再以后写层顶包先写层。
      const layerProbes = buildLayerProbesV2(gold, questions, ungatedTop1);

      // 192-H1：生产门后栈等价回放。与 src/assembly/index.ts 的 runGatedSearch 同构——
      // searchExplained 取未截断全集 → normalizeLexicalText 规范化 → applyGate 逐卡裁决，
      // 门后再截 limit=1。审计不构造时间信封；#131 起时间窗只留痕不删卡，提交集合与生产一致。
      // 不经 runGatedSearch 直调是因为只读柄不满足 RuntimeMemoryHandle 的写窄能力形状。
      const gatedTop1 = await collectTop1Records(questions, async (question) => {
        const qNorm = normalizeLexicalText(question.queryText);
        const candidates = await explainedHandle.searchExplained({ text: question.queryText, atMs: options.nowMs, limit: undefined });
        const outcome = gate({ qNorm, candidates, atMs: options.nowMs, limit: 1 });
        const resolvedEventId = relayMap.get(question.targetEventId) ?? question.targetEventId;
        const topCard = outcome.accepted[0]?.card ?? null;
        // P0 留痕（#193）：同一趟回放顺手取信号向量，不额外检索、不改任何裁决。
        const firstGated = outcome.accepted[0] ?? outcome.rejected[0] ?? null;
        const goldCard = candidates.find((candidate) => candidate.card.eventId === resolvedEventId) ?? null;
        gatedSignalRows.push({
          probeRef: question.questionRef,
          ...(question.constructionLayer !== undefined ? { layer: question.constructionLayer } : {}),
          committed: topCard !== null,
          top1Signals: firstGated !== null ? gradedLexicalSignals(qNorm, lexicalFieldsOf(firstGated)) : null,
          goldSignals: goldCard !== null ? gradedLexicalSignals(qNorm, lexicalFieldsOf(goldCard)) : null,
        });
        // #194 澄清决策器离线模拟：对同一候选全集重跑一次纯函数门（无 IO）取全过门卡，
        // 只记录「若当时有澄清机制会如何分」，不改上方生产等价回放的任何结果。
        const fullOutcome = gate({ qNorm, candidates, atMs: options.nowMs, limit: candidates.length });
        const clarifyVerdict = decideClarify(clarifyCandidatesOf(qNorm, fullOutcome));
        const goldInTieGroup = goldCard === null
          ? null
          : clarifyVerdict.tiedCardIds.some((cardId) => {
              const tied = fullOutcome.accepted.find((gated) => gated.card.cardId === cardId);
              return tied?.card.eventId === resolvedEventId;
            });
        clarifyPolicyRows.push({
          probeRef: question.questionRef,
          ...(question.constructionLayer !== undefined ? { layer: question.constructionLayer } : {}),
          cohort: 'gold',
          action: clarifyVerdict.action,
          reason: clarifyVerdict.reason,
          candidateCount: fullOutcome.accepted.length,
          tiedCardIds: [...clarifyVerdict.tiedCardIds],
          goldInTieGroup,
          pairLocked: null,
        });
        return { committed: topCard !== null, top1IsGold: topCard !== null && topCard.eventId === resolvedEventId };
      });
      const gatedLayerProbes = buildLayerProbesV2(gold, questions, gatedTop1);

      const decoyProbes: DecoyProbeV2[] = [];
      for (let i = 0; i < decoy.length; i += 1) {
        const result = decoy[i]!;
        const item = fixtures.decoy[i];
        if (item === undefined) throw new IntegrityError('v2 判据：诱饵结果与夹具条数不齐，拒绝结算');
        const kind = item.decoyKind;
        if (kind === undefined) throw new IntegrityError('v2 判据：诱饵条目缺 decoyKind，无法按三类结算');
        // 注意：R2 诱饵对仍沿用 scoreDecoy 的粗召回排序口径；门后栈下"双拒/单过门"如何计正确
        // 属另立语义，192 号文书挂账后续，不在本次 harness 修复里静默改口径。
        decoyProbes.push({ kind, correct: result.correct, highRiskError: result.highRiskError });
      }
      const abstainV2: AbstainProbeV2[] = abstainItems.map((item, index) => {
        const probe = fourStateProbes[questions.length + index];
        if (probe === undefined) throw new IntegrityError('v2 判据：弃权探针与四态探针序列不齐，拒绝结算');
        return { kind: item.kind, committed: probe.committed, top1IsGold: probe.top1IsGold };
      });
      const clarifyProbes: ClarifyProbeV2[] = [];
      // 门后栈弃权/澄清探针：与金标题同几何，逐题独立回放、不共享任何 Map。
      const gatedAbstainV2: AbstainProbeV2[] = [];
      const gatedAbstainFourState: FourStateProbeInput[] = [];
      for (const item of abstainItems) {
        const qNorm = normalizeLexicalText(item.query);
        const candidates = await explainedHandle.searchExplained({ text: item.query, atMs: options.nowMs, limit: undefined });
        const outcome = gate({ qNorm, candidates, atMs: options.nowMs, limit: 1 });
        const topCard = outcome.accepted[0]?.card ?? null;
        const committed = topCard !== null;
        const top1IsGold = item.goldCardId !== null && topCard?.cardId === item.goldCardId;
        gatedAbstainV2.push({ kind: item.kind, committed, top1IsGold });
        gatedAbstainFourState.push({
          probeRef: `abstain:${item.kind}`,
          hasGold: abstainHasGold(item),
          committed,
          top1IsGold,
          highRisk: false,
          probeKind: item.kind,
        });
        // #194：弃权队列离线模拟，看点是 ASK_MULTI 误触发数（期望 0，不该反问时不打扰）。
        const abstainFull = gate({ qNorm, candidates, atMs: options.nowMs, limit: candidates.length });
        const abstainVerdict = decideClarify(clarifyCandidatesOf(qNorm, abstainFull));
        clarifyPolicyRows.push({
          probeRef: `abstain:${item.kind}:${clarifyPolicyRows.length}`,
          cohort: 'abstain',
          action: abstainVerdict.action,
          reason: abstainVerdict.reason,
          candidateCount: abstainFull.accepted.length,
          tiedCardIds: [...abstainVerdict.tiedCardIds],
          goldInTieGroup: null,
          pairLocked: null,
        });
      }
      const gatedClarifyProbes: ClarifyProbeV2[] = [];
      for (const item of clarifyItems) {
        const top1 = await readHandle.search({ text: item.query, atMs: options.nowMs, limit: 1 });
        const top1CardId = top1[0]?.card.cardId ?? null;
        clarifyProbes.push({
          query: item.query,
          committed: top1CardId !== null,
          top1IsGold: false,
          top1IsDecoy: top1CardId !== null && item.pairCardIds.includes(top1CardId),
        });
        const qNorm = normalizeLexicalText(item.query);
        const candidates = await explainedHandle.searchExplained({ text: item.query, atMs: options.nowMs, limit: undefined });
        const outcome = gate({ qNorm, candidates, atMs: options.nowMs, limit: 1 });
        const gatedCardId = outcome.accepted[0]?.card.cardId ?? null;
        gatedClarifyProbes.push({
          query: item.query,
          committed: gatedCardId !== null,
          top1IsGold: false,
          top1IsDecoy: gatedCardId !== null && item.pairCardIds.includes(gatedCardId),
        });
        // #194：澄清题主战场——配对双卡信号全等时应落 ASK_MULTI 且 pairLocked=true。
        const clarifyFull = gate({ qNorm, candidates, atMs: options.nowMs, limit: candidates.length });
        const clarifyVerdict = decideClarify(clarifyCandidatesOf(qNorm, clarifyFull));
        clarifyPolicyRows.push({
          probeRef: `clarify:${clarifyPolicyRows.length}`,
          cohort: 'clarify',
          action: clarifyVerdict.action,
          reason: clarifyVerdict.reason,
          candidateCount: clarifyFull.accepted.length,
          tiedCardIds: [...clarifyVerdict.tiedCardIds],
          goldInTieGroup: null,
          pairLocked:
            item.pairCardIds.length >= 2 &&
            item.pairCardIds.every((cardId) => clarifyVerdict.tiedCardIds.includes(cardId)),
        });
      }
      // 门后四态汇总（金标题＋弃权题），供报告与 notes 留档；粗召回四态仍以前文 fourState 为准。
      const gatedFourStateProbes: FourStateProbeInput[] = questions.map((question, index) => {
        const observation = gatedTop1[index]!;
        return {
          probeRef: question.questionRef,
          hasGold: true,
          committed: observation.committed,
          top1IsGold: observation.top1IsGold,
          highRisk: question.highRisk ?? false,
        };
      });
      fourStateGated = summarizeFourState([...gatedFourStateProbes, ...gatedAbstainFourState]);
      judgmentV2 = judgeV2({ gold: layerProbes, decoy: decoyProbes, abstain: abstainV2, clarify: clarifyProbes }, { seed });
      judgmentV2Gated = judgeV2(
        { gold: gatedLayerProbes, decoy: decoyProbes, abstain: gatedAbstainV2, clarify: gatedClarifyProbes },
        { seed },
      );
      // C2-甲：判决机对 wa 不设门，PASSED 伴随错弃权时强制留警告印（只渲染/留档，不改判决）。
      gatedCaveat = gatedVerdictCaveat({
        verdict: judgmentV2Gated.verdict,
        wrongAbstain: fourStateGated.counts.wa,
        answerableGold: fourStateGated.counts.G,
        correctCommit: fourStateGated.counts.cc,
      });
    }

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
      // 序11：C5 全量核验（G1 锚点解析率必须 100%），20% 抽样默认已停用。
      sampleRatio: 1,
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
    // 序6：LOEO 必须真做留一事件逐折回算；折数取参与提问的去重目标事件，不再贴标签。
    let lOeo: LoeoResult | undefined;
    if (holdoutMode === 'loeo') {
      lOeo = await runLoeo(questions, search, { atMs: options.nowMs, k: 3, relayMap, relayChains });
    }
    const folds = lOeo?.folds ?? truth.events.length;
    if (options.holdout && options.sealedDir !== undefined) {
      // 序9：每次读取封存集都只追加一行解封留痕（模式/折数定稿后写，保证与报告一致）。
      appendUnsealRecord(options.sealedDir, {
        atMs: options.nowMs,
        operator: options.operator ?? 'offline-cli',
        reason: options.unsealReason!,
        mode: holdoutMode === 'holdout' ? 'holdout' : 'loeo',
        folds,
      });
    }

    const runId = ulid();
    const items: AuditItemRecord[] = [
      ...goldItems(runId, 1, gold),
      ...decoyItems(runId, 1 + gold.length, decoy),
      ...provenanceItems(runId, 1 + gold.length + decoy.length, provenance),
    ];
    const notes = {
      consistency: { status: consistency.status, pairs: consistency.pairs },
      holdout: { mode: holdoutMode, folds, ...(options.holdout ? { unsealedAt: options.nowMs } : {}), ...(lOeo ? { loeo: lOeo } : {}) },
      rngSeed: seed,
      rulesVersion,
      sampleN: items.length,
      abstainFixturePresent,
      fourState,
      ...(fourStateGated ? { fourStateGated } : {}),
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
      modelTag: rulesVersion,
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
      fourState,
      abstainFixturePresent,
      clarifyFixturePresent,
      ...(judgmentV2 ? { judgmentV2 } : {}),
      ...(judgmentV2Gated ? { judgmentV2Gated } : {}),
      ...(fourStateGated ? { fourStateGated } : {}),
      ...(judgmentV2Gated ? { gatedVerdictCaveat: gatedCaveat } : {}),
      ...(judgmentV2Gated ? { gatedSignalRows } : {}),
      ...(judgmentV2Gated ? { clarifyPolicyRows } : {}),
      provenanceFailed: provenance.failed,
      holdout: { mode: holdoutMode, folds, ...(lOeo ? { loeo: lOeo } : {}) },
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
  lines.push(`审计时钟    ：${report.run.createdMs}（${new Date(report.run.createdMs).toISOString()}）`);
  lines.push('');
  lines.push('── 三红线（只观测，不卡退出码）─────────────────────────────────');
  lines.push(`R1 召回@3   ：${report.redLines.r1 ?? 'N/A'}`);
  lines.push(`R2 错误认定 ：${report.redLines.r2 ?? 'N/A'}`);
  lines.push(`R3 一致性   ：${report.redLines.r3 ?? 'N/A'}`);
  lines.push('');
  lines.push(`provenance  ：${report.provenanceFailed ? 'FAILED（硬失败）' : '通过'}`);
  if (!('rates' in report.fourState)) {
    lines.push(`四态        ：N/A（${report.fourState.reason}）`);
  } else {
    const fs = report.fourState;
    const pct = (v: number | { status: 'n-a' }): string => (typeof v === 'number' ? v.toFixed(4) : 'N/A');
    lines.push('── 门后四态（top1 口径，与 R1 top-k 禁互替）────────────────────');
    lines.push(`计数        ：cc=${fs.counts.cc} wcG=${fs.counts.wcG} wcNG=${fs.counts.wcNG} wa=${fs.counts.wa} ca=${fs.counts.ca}（G=${fs.counts.G} NG=${fs.counts.NG}）`);
    lines.push(`错认率/召回 ：falseCommit=${pct(fs.rates.falseCommitRate)} recallAfterGate=${pct(fs.rates.recallAfterGate)} 高危错认=${fs.highRiskWrongCommits}`);
    lines.push(`弃权探针文件：${report.abstainFixturePresent ? '已加载' : '缺失（金标题四态照算）'}`);
  }
  const renderV2Judgment = (j: JudgmentV2, title: string, gatedSummary?: FourStateSummary): void => {
    const fmt = (e: { status?: 'n-a' } | { point: number; ciLower: number; ciUpper: number; n: number }): string =>
      'point' in e ? `${e.point.toFixed(4)} [${e.ciLower.toFixed(4)}, ${e.ciUpper.toFixed(4)}] n=${e.n}` : 'N/A';
    lines.push(title);
    lines.push(`R1 宏(S0+S1)：${fmt(j.r1Macro as never)} 簇=${('clusterCount' in j.r1Macro ? j.r1Macro.clusterCount : 0) ?? 0} 门=${j.gates.r1Macro ? '过' : '未过'}`);
    lines.push(`R1_S0 副条件：${fmt(j.r1S0 as never)} 门=${j.gates.r1S0 ? '过' : '未过'}`);
    lines.push(`R2 整体200对：${fmt(j.r2 as never)} 高危错认=${j.decoyHighRiskErrors} 门=${j.gates.r2 ? '过' : '未过'}（R2 仍为粗召回排序口径，见 192 挂账）`);
    for (const kind of ['same-family', 'cross-family-collision', 'cross-family-detail-reuse'] as const) {
      lines.push(`R2 ${kind}：${fmt(j.r2ByKind[kind] as never)}（明细必报，整体作门）`);
    }
    for (const layer of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const) {
      const gate = j.layers[layer];
      lines.push(
        `L_${layer}：n=${gate?.n ?? 0} wc=${gate?.wrongCommit ?? 0} 高危wc=${gate?.highRiskWrongCommit ?? 0}` +
          `${layer === 'S5' ? ` wa(仅登记)=${gate?.wrongAbstain ?? 0}` : ''} 门=${j.gates[`L_${layer}`] ? '过' : '未过'}`,
      );
    }
    lines.push(
      `弃权：unanswerable ca=${j.abstain.unanswerable.correctAbstain}/${j.abstain.unanswerable.n} 门=${j.gates.abstain ? '过' : '未过'}` +
        `；noise cc=${j.abstain.noise.correctCommit} wc=${j.abstain.noise.wrongCommit} wa=${j.abstain.noise.wrongAbstain}（三态只登记）`,
    );
    if (gatedSummary !== undefined) {
      lines.push(
        `门后四态合计：cc=${gatedSummary.counts.cc} wc=${gatedSummary.counts.wc} wa=${gatedSummary.counts.wa} ca=${gatedSummary.counts.ca} 高危wc=${gatedSummary.highRiskWrongCommits}（N=${gatedSummary.counts.N}）`,
      );
      // P0 分级词面信号留痕（#193）：仅门后栈披露整数分布，明细逐题在 JSON，不参与任何判据。
      const rows = report.gatedSignalRows;
      if (rows !== undefined) {
        const bucketize = (pick: (row: GatedSignalRow) => GradedSignals | null): string => {
          const b = { none: 0, lcs0: 0, lcs1: 0, lcs2: 0, lcs3: 0 };
          for (const row of rows) {
            const s = pick(row);
            if (s === null) b.none += 1;
            else if (s.lcs === 0) b.lcs0 += 1;
            else if (s.lcs === 1) b.lcs1 += 1;
            else if (s.lcs === 2) b.lcs2 += 1;
            else b.lcs3 += 1;
          }
          return `无卡=${b.none} 0=${b.lcs0} 1=${b.lcs1} 2=${b.lcs2} 3+=${b.lcs3}`;
        };
        lines.push('── 分级词面信号留痕（P0，仅披露不判分；逐题明细见 JSON）────────');
        lines.push(`行数        ：${rows.length}（门后提交=${rows.filter((row) => row.committed).length}）`);
        lines.push(`金标卡 LCS  ：${bucketize((row) => row.goldSignals)}`);
        lines.push(`门后第一名  ：${bucketize((row) => row.top1Signals)}`);
      }
      // #194 乙机制澄清决策器离线模拟：只报告结构性打平判定的分流分布，不接生产裁决；
      // NOMINATE_SINGLE 弱证据档未启用（枚举不可达），近邻非全等档等待 P1 梯度卷标定。
      const policyRows = report.clarifyPolicyRows;
      if (policyRows !== undefined) {
        const countBy = (cohort: ClarifyPolicyRow['cohort'], action: ClarifyAction): number =>
          policyRows.filter((row) => row.cohort === cohort && row.action === action).length;
        const goldRows = policyRows.filter((row) => row.cohort === 'gold');
        const goldTie = goldRows.filter((row) => row.action === 'ASK_MULTI').length;
        const goldInTie = goldRows.filter((row) => row.goldInTieGroup === true).length;
        const goldMissing = goldRows.filter((row) => row.goldInTieGroup === null).length;
        const clarifyRows = policyRows.filter((row) => row.cohort === 'clarify');
        const pairLocked = clarifyRows.filter((row) => row.pairLocked === true).length;
        const abstainRows = policyRows.filter((row) => row.cohort === 'abstain');
        const abstainFalseAsk = abstainRows.filter((row) => row.action === 'ASK_MULTI').length;
        lines.push('── 澄清决策器离线模拟（#194，结构性打平判定，仅审计模拟不生效；NOMINATE_SINGLE 未启用）──');
        lines.push(
          `金标题 N=${goldRows.length}：COMMIT=${countBy('gold', 'COMMIT')} ` +
            `ASK_MULTI=${goldTie}（金标在打平组=${goldInTie}，金标未入候选=${goldMissing}）ABSTAIN=${countBy('gold', 'ABSTAIN')}`,
        );
        lines.push(
          `澄清题 N=${clarifyRows.length}：ASK_MULTI=${countBy('clarify', 'ASK_MULTI')}（配对双卡同组=${pairLocked}） ` +
            `COMMIT=${countBy('clarify', 'COMMIT')} ABSTAIN=${countBy('clarify', 'ABSTAIN')}`,
        );
        lines.push(
          `弃权题 N=${abstainRows.length}：ABSTAIN=${countBy('abstain', 'ABSTAIN')} COMMIT=${countBy('abstain', 'COMMIT')} ` +
            `ASK_MULTI=${abstainFalseAsk}（非零即误触发反问，期望 0）`,
        );
      }
    }
    lines.push('── 澄清档披露（F6，只作描述性统计，不进 R1/R2 分母）────────────');
    lines.push(`汇总：澄清/低置信=${j.clarify.clarified} 自信给卡=${j.clarify.confidentCard} 其中诱饵置顶=${j.clarify.decoyTop1}（文件${report.clarifyFixturePresent ? '已加载' : '缺失'}）`);
    for (const row of j.clarify.rows) {
      lines.push(`  · ${row.query} → ${row.behavior === 'clarify-or-low-confidence' ? '澄清/低置信' : '自信给卡'}${row.decoyTop1 ? '（诱饵置顶）' : ''}`);
    }
    lines.push(`精度闭环：${j.gates.precision ? '通过' : '未通过'}`);
    lines.push(`判决      ：${j.verdict}`);
    if (gatedSummary !== undefined) {
      const caveat = gatedVerdictCaveat({
        verdict: j.verdict,
        wrongAbstain: gatedSummary.counts.wa,
        answerableGold: gatedSummary.counts.G,
        correctCommit: gatedSummary.counts.cc,
      });
      if (caveat !== null) lines.push(`  · ${caveat}`);
    }
    for (const note of j.notes) lines.push(`  · ${note}`);
  };
  if (report.judgmentV2 !== undefined) {
    renderV2Judgment(
      report.judgmentV2,
      '── v2 判决·粗召回基线（无门宽召回 top1，192-H2 已修撞键；仅诊断对照，不代表生产栈）──',
    );
  }
  if (report.judgmentV2Gated !== undefined) {
    renderV2Judgment(
      report.judgmentV2Gated,
      '── v2 判决·生产门后栈（runGatedSearch 等价口径，192-H1；线上工具同几何）──────────',
      report.fourStateGated,
    );
  }
  lines.push('══════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseOptions(process.argv.slice(2));
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
      nowMs: options.nowMs ?? Date.now(),
      ...(options.rulesVersion === undefined ? {} : { rulesVersion: options.rulesVersion }),
      ...(options.nullModelDir === undefined ? {} : { nullModelDir: options.nullModelDir }),
      ...(options.sealDir === undefined ? {} : { sealedDir: options.sealDir }),
      ...(options.unsealReason === undefined ? {} : { unsealReason: options.unsealReason }),
      ...(options.operator === undefined ? {} : { operator: options.operator }),
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