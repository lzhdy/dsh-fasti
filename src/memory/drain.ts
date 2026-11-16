/**
 * drain 轮编排门 + 轮报告形状 + 一轮纯规划 + 真链编排（#42 正本 §3.1 模块清单、§3.2 轮报告、
 * §2.5 无状态对账、R-10 离线持锁、F-A/F-B/F-C 三级）。
 *
 * 边界：
 *  - 短路纯判定、规则版本比对、连续失败计数与一轮纯规划；
 *  - 真链编排：事务外只读读真源 → fold → derive → diff/plan → 单事务 apply；
 *    观测 append-only 落投影内 `drain-observations.jsonl`，绝不进 decisions 台账；
 *  - 无定时器、零常驻、零新表；不 import api/assembly/event/adapters；
 *  - 短路 / rules 不符 / 空轮时事务未开始、派生集不推进、零写入
 *    （卡/决策/revision/观测/miss 行与目录树不变）。
 */

import path from 'node:path';

import { listFiles } from '../core/fsx.ts';
import { readJsonlFile } from '../core/jsonl.ts';
import { isoToMs } from '../core/time.ts';
import { parseEvent, type EventRecord } from '../contract/event.ts';
import { parseExperience } from '../contract/validate-experience.ts';
import { layoutOf, resolveDataRoot } from '../source/paths.ts';
import {
  computeRowHashSum,
  computeTruthFingerprint,
  materializeDrainCardRow,
  normalizeDisplayCues,
} from './builder.ts';
import { sha256Hex } from './content-hash.ts';
import { castDrainDecision } from './decision.ts';
import { deriveExpectedProjection, structuralHash } from './derive.ts';
import { cuesHashOf, isCueDerivationEnabled } from './cue-derive.ts';
import type { AbstainEntry, ExpectedCard, QuarantineEntry } from './derive.ts';
import { readRevisions } from './ledger.ts';
import { openDrainObservationStore } from './drain-observations.ts';
import type { DrainObservation, ObservationReasonCode } from './observations.ts';
import { observationId } from './observations.ts';
import { planProjection, type PlanCardRef } from './planner.ts';
import type { MissRetentionPolicy } from './miss-retention.ts';
import { MEMORY_SCHEMA_VERSION } from './schema.ts';
import type { MemoryInternalReadHandle, MemoryWriteHandle } from './store.ts';
import type { CardChangeSet, DecisionRecord, MemoryCard, RevisionRecord } from './types.ts';
import { CURRENT_RULES_VERSION } from './types.ts';

/** 短路码表；null = 正常跑完一轮（可能是空轮，但不是短路）。 */
export type DrainSkipped = 'writer-lock-held' | 'closed' | 'budget' | 'not-wired' | null;

/** 短路判定上下文（由运行期窄柄/端口层填充）。 */
export interface DrainSkipContext {
  /** 窄柄/门面是否已关停。 */
  readonly closed: boolean;
  /** 写单例是否可取得（后端 writer 非空）。 */
  readonly writable: boolean;
  /** 事件真源/派生读取器是否已接线。 */
  readonly sourceWired: boolean;
  /** 本轮预算是否耗尽（0 预算或时长/条数到限）。 */
  readonly budgetExhausted: boolean;
}

/** §3.2 轮报告十字段。 */
export interface DrainRoundReport {
  readonly scannedVersions: number;
  readonly cardUpserts: number;
  readonly invalidations: number;
  /** F-B 本轮新增隔离条数。 */
  readonly quarantined: number;
  /** 合法 abstain 本轮新增条数。 */
  readonly emptyAnchored: number;
  /** 是否发生事务提交。 */
  readonly applied: boolean;
  readonly skipped: DrainSkipped;
  readonly consecutiveFailures: number;
  readonly rulesVersionMismatch: boolean;
  readonly durationMs: number;
}

/**
 * 短路优先级（§3.1 F-A 自愈类）：
 * `closed` > `writer-lock-held` > `not-wired` > `budget` > `null`。
 * 命中任一短路即不开始事务、不推进派生集。
 */
export function classifyDrainSkip(context: DrainSkipContext): DrainSkipped {
  if (context.closed) {
    return 'closed';
  }
  if (!context.writable) {
    return 'writer-lock-held';
  }
  if (!context.sourceWired) {
    return 'not-wired';
  }
  if (context.budgetExhausted) {
    return 'budget';
  }
  return null;
}

/** 短路轮报告：计数全 0、`applied=false`、零写入。 */
export function buildSkippedDrainReport(
  skipped: NonNullable<DrainSkipped>,
  durationMs: number,
): DrainRoundReport {
  return {
    scannedVersions: 0,
    cardUpserts: 0,
    invalidations: 0,
    quarantined: 0,
    emptyAnchored: 0,
    applied: false,
    skipped,
    consecutiveFailures: 0,
    rulesVersionMismatch: false,
    durationMs,
  };
}

/** 正常轮报告组装（计数/提交标志由编排链填入；本批空轮为全 0、未提交）。 */
export function buildDrainReport(
  fields: Omit<DrainRoundReport, 'skipped' | 'durationMs'>,
  durationMs: number,
): DrainRoundReport {
  return { ...fields, skipped: null, durationMs };
}

// ── 规则版本协议（§2.5：投影标记规则版本不符 → rebuild-required，不静默巨变）────

/**
 * 空白投影（null）不视为版本冲突；非空标记与当前规则版本不符才判冲突。
 */
export function isRulesVersionMismatch(
  projectionRulesVersion: string | null,
  rulesVersion: string,
): boolean {
  if (projectionRulesVersion === null) {
    return false;
  }
  return projectionRulesVersion !== rulesVersion;
}

// ── F-C 系统级退避：连续失败计数（成功清零，失败累加；不落持久队列）────────────

/** 上一轮连续失败计数；本轮事务/IO 失败累加 1，成功归零。 */
export function consecutiveFailuresAfter(prev: number, txFailed: boolean): number {
  return txFailed ? prev + 1 : 0;
}

// ── 一轮纯规划：前后态求差 + 计数 + 提交标志（零 IO，事务应用在编排层单事务执行）─

/** 一轮纯规划入参（前后态卡引用 + 隔离/弃权集 + 规则版本 + 失败计数）。 */
export interface DrainPlanInput {
  readonly previousCards: readonly ExpectedCard[];
  readonly currentCards: readonly ExpectedCard[];
  readonly quarantined: readonly QuarantineEntry[];
  readonly emptyAnchored: readonly AbstainEntry[];
  readonly rulesVersion: string;
  readonly projectionRulesVersion: string | null;
  readonly consecutiveFailures: number;
  readonly txFailed: boolean;
}

/** 一轮纯规划结果：`ok` 可执行单事务；`rebuild-required` 规则不符、动作全空、零写入。 */
export interface DrainPlanResult {
  readonly status: 'ok' | 'rebuild-required';
  readonly report: DrainRoundReport;
}

function zeroPlanReport(overrides: Partial<DrainRoundReport>): DrainRoundReport {
  return {
    scannedVersions: 0,
    cardUpserts: 0,
    invalidations: 0,
    quarantined: 0,
    emptyAnchored: 0,
    applied: false,
    skipped: null,
    consecutiveFailures: 0,
    rulesVersionMismatch: false,
    durationMs: 0,
    ...overrides,
  };
}

/**
 * 一轮纯规划：按 cardId 比对前后态得出新建/失效计数，叠加隔离与弃权计数，
 * 规则不符或事务失败时动作计数归零、不提交。本函数不触碰文件系统与数据库。
 */
export function planDrainRound(input: DrainPlanInput): DrainPlanResult {
  const mismatch = isRulesVersionMismatch(input.projectionRulesVersion, input.rulesVersion);
  if (mismatch) {
    return {
      status: 'rebuild-required',
      report: zeroPlanReport({ rulesVersionMismatch: true }),
    };
  }

  const previousIds = new Set(input.previousCards.map((card) => card.cardId));
  const currentIds = new Set(input.currentCards.map((card) => card.cardId));
  const cardUpserts = input.currentCards.filter((card) => !previousIds.has(card.cardId)).length;
  const invalidations = input.previousCards.filter((card) => !currentIds.has(card.cardId)).length;
  const quarantined = input.quarantined.length;
  const emptyAnchored = input.emptyAnchored.length;
  const txFailed = input.txFailed;
  const consecutiveFailures = consecutiveFailuresAfter(input.consecutiveFailures, txFailed);
  // 系统级失败不提交；仅当确有卡动作且本轮未失败时才标记事务提交。
  const applied = !txFailed && cardUpserts + invalidations > 0;
  const scannedVersions = cardUpserts + invalidations + quarantined + emptyAnchored;

  return {
    status: 'ok',
    report: {
      scannedVersions,
      cardUpserts: txFailed ? 0 : cardUpserts,
      invalidations: txFailed ? 0 : invalidations,
      quarantined,
      emptyAnchored,
      applied,
      skipped: null,
      consecutiveFailures,
      rulesVersionMismatch: false,
      durationMs: 0,
    },
  };
}

// ── 真链编排：事务外只读读真源 → fold → derive → plan → 单事务 apply（§2.5 第 1–5 步）─

/** 一轮编排入参（窄柄闭包注入后端柄与路径；编排层不另开连接）。 */
export interface DrainRoundDeps {
  readonly indexDir: string;
  /** 事件真源数据根；null = 未接线（not-wired 短路在入口判定）。 */
  readonly dataRoot: string | null;
  readonly closed: boolean;
  readonly reader: MemoryInternalReadHandle;
  readonly writer: MemoryWriteHandle | null;
  readonly budgetMs: number;
  readonly consecutiveFailures: number;
  /**
   * 漏召观测留存策略（#117 3.2 第 1 件）。null/缺省＝本轮不裁剪（既有调用点零行为变化）；
   * 接线层（fasti.drainMemoryProjection）传入 miss-retention 的段一临时策略。
   */
  readonly missRetention?: MissRetentionPolicy | null;
}

/** 真源只读快照：折叠后的当前态事件 + 经历 cue 映射（事务外读取，不回写真源）。 */
interface SourceRead {
  readonly events: EventRecord[];
  readonly cueByExperience: ReadonlyMap<string, string | undefined>;
}

function readSource(dataRoot: string | null): SourceRead {
  const cueByExperience = new Map<string, string | undefined>();
  const folded = new Map<string, EventRecord>();
  if (dataRoot === null) {
    return { events: [], cueByExperience };
  }
  const layout = layoutOf(resolveDataRoot({ dataRoot }));
  for (const name of listFiles(layout.experiences, '.jsonl')) {
    for (const raw of readJsonlFile<unknown>(path.join(layout.experiences, name))) {
      const experience = parseExperience(raw, 'read');
      cueByExperience.set(experience.id, experience.observation?.cue);
    }
  }
  for (const name of listFiles(layout.events, '.jsonl')) {
    for (const raw of readJsonlFile<unknown>(path.join(layout.events, name))) {
      const event = parseEvent(raw, 'read');
      const previous = folded.get(event.id);
      if (previous === undefined || event.version > previous.version) {
        folded.set(event.id, event);
      }
    }
  }
  return { events: [...folded.values()], cueByExperience };
}

function parseAnchorJson(card: MemoryCard | null): string[] {
  if (card === null) {
    return [];
  }
  try {
    return JSON.parse(card.anchorJson) as string[];
  } catch {
    return [];
  }
}

function cardToPlanRef(card: MemoryCard, cueEnabled: boolean): PlanCardRef {
  return {
    eventId: card.eventId,
    cardId: card.cardId,
    anchors: parseAnchorJson(card),
    channel: card.channel,
    startedMs: card.occurredMs,
    endedMs: card.endedMs,
    // #123 P2：未启用 cue 派生时不传（两侧恒 undefined ⇒ sameShape 与接入前一致）。
    ...(cueEnabled ? { cuesHash: displayCuesHash(card.displayCuesJson) } : {}),
  };
}

/** 库内 `display_cues_json` → 与期望侧同口径的 cue 哈希（空占位 `[""]` 参与比较）。 */
function displayCuesHash(displayCuesJson: string): string {
  let parsed: string[] = [''];
  try {
    const value: unknown = JSON.parse(displayCuesJson);
    if (Array.isArray(value)) {
      parsed = value.map((item) => String(item));
    }
  } catch {
    // 非法 JSON 一律按空线索占位参与比较，宁可多跑一次 update 也不静默漂移。
    parsed = [''];
  }
  return cuesHashOf(parsed.length > 0 ? parsed : ['']);
}

/** 单卡 cue 取值口径：经历快照优先（#93 解冻后仍以叙事线索为准）；无快照才用 key_points 派生。 */
function resolveCardCues(
  expected: ExpectedCard,
  cueByExperience: ReadonlyMap<string, string | undefined>,
): string[] {
  const fromObservation = expected.anchors
    .map((anchor) => cueByExperience.get(anchor))
    .filter((cue): cue is string => typeof cue === 'string' && cue.trim() !== '');
  return fromObservation.length > 0 ? fromObservation : [...expected.cues];
}

/** 期望态卡行落库构造：cue 取 resolveCardCues；行物化与摘要哈希计算在 builder 助手内完成。 */
function materializeCard(
  expected: ExpectedCard,
  event: EventRecord,
  cueByExperience: ReadonlyMap<string, string | undefined>,
): MemoryCard {
  return materializeDrainCardRow({
    cardId: expected.cardId,
    eventId: event.id,
    anchors: [...expected.anchors],
    channel: expected.channel,
    startedMs: expected.startedMs,
    endedMs: expected.endedMs,
    cues: resolveCardCues(expected, cueByExperience),
  });
}

/** 隔离/弃权观测落投影内 append-only 观测仓；三元组幂等去重，绝不进 decisions 台账。 */
function appendDrainObservations(
  indexDir: string,
  expected: ReturnType<typeof deriveExpectedProjection>,
  eventById: ReadonlyMap<string, EventRecord>,
): void {
  const store = openDrainObservationStore(indexDir);
  const existing = store.read();
  const seen = new Set(existing.map((row) => `${row.event_id}|${row.version_token}|${row.reason_code}`));

  const observe = (eventId: string, anchors: readonly string[], reasonCode: ObservationReasonCode): void => {
    const event = eventById.get(eventId);
    if (event === undefined) {
      return;
    }
    const versionToken = `${event.id}#v${event.version}`;
    const key = `${event.id}|${versionToken}|${reasonCode}`;
    if (seen.has(key)) {
      return;
    }
    const snapshotHash = structuralHash({
      anchors: [...anchors],
      channel: event.channel,
      startedMs: isoToMs(event.time_range.started_at),
      endedMs: isoToMs(event.time_range.ended_at),
      eligibility: event.summary_quality,
      rulesVersion: CURRENT_RULES_VERSION,
    });
    const row: DrainObservation = {
      id: observationId(event.id, versionToken, reasonCode),
      event_id: event.id,
      version_token: versionToken,
      reason_code: reasonCode,
      snapshot_hash: snapshotHash,
      at_ms: isoToMs(event.created_at),
    };
    store.append(row);
    seen.add(key);
  };

  for (const entry of expected.quarantined) {
    observe(entry.eventId, entry.anchors, entry.reasonCode);
  }
  for (const entry of expected.emptyAnchored) {
    observe(entry.eventId, entry.anchors, 'empty-anchors');
  }
}

/** 空轮零增量、rules 不符零写入；有卡动作才在单事务内恰一次 apply。 */
export function runDrainRound(deps: DrainRoundDeps): DrainRoundReport {
  const startedMs = Date.now();
  const elapsed = (): number => Date.now() - startedMs;

  const context: DrainSkipContext = {
    closed: deps.closed,
    writable: deps.writer !== null,
    // memory 编排层恒按已接线处理：dataRoot 缺省时折叠集为空 → 真实空轮；
    // not-wired 由门面端口层在未注入端口时判定。
    sourceWired: true,
    budgetExhausted: !Number.isFinite(deps.budgetMs) || deps.budgetMs <= 0,
  };
  const skipped = classifyDrainSkip(context);
  if (skipped !== null) {
    return buildSkippedDrainReport(skipped, elapsed());
  }

  // 规则版本比对：事务外只读 schema_meta；不符 → rebuild-required，动作全空、零写入。
  const projectionRulesVersion = deps.reader.getMeta('rules_version');
  if (isRulesVersionMismatch(projectionRulesVersion, CURRENT_RULES_VERSION)) {
    return buildDrainReport(
      {
        scannedVersions: 0,
        cardUpserts: 0,
        invalidations: 0,
        quarantined: 0,
        emptyAnchored: 0,
        applied: false,
        consecutiveFailures: 0,
        rulesVersionMismatch: true,
      },
      elapsed(),
    );
  }

  // 事务外只读读真源；折叠当前态（同 id 取最大 version）。
  const source = readSource(deps.dataRoot);
  const experienceExists = (id: string): boolean => source.cueByExperience.has(id);
  const expected = deriveExpectedProjection({ events: source.events, experienceExists });
  const eventById = new Map(source.events.map((event) => [event.id, event]));

  const cueEnabled = isCueDerivationEnabled(CURRENT_RULES_VERSION);
  const previousRefs = deps.reader
    .listEffective(Number.MAX_SAFE_INTEGER)
    .map((card) => cardToPlanRef(card, cueEnabled));
  const currentRefs: PlanCardRef[] = expected.cards.map((card) => ({
    eventId: card.eventId,
    cardId: card.cardId,
    anchors: [...card.anchors],
    channel: card.channel,
    startedMs: card.startedMs,
    endedMs: card.endedMs,
    // 期望侧哈希与落库值同口径（normalizeDisplayCues 单点收口），避免每轮抖动。
    ...(cueEnabled
      ? {
          cuesHash: cuesHashOf(
            normalizeDisplayCues(resolveCardCues(card, source.cueByExperience)),
          ),
        }
      : {}),
  }));
  const plan = planProjection({
    previous: previousRefs,
    current: currentRefs,
    aliases: [],
    rulesVersion: CURRENT_RULES_VERSION,
    projectionRulesVersion,
  });
  if (plan.status === 'rebuild-required') {
    return buildDrainReport(
      {
        scannedVersions: 0,
        cardUpserts: 0,
        invalidations: 0,
        quarantined: 0,
        emptyAnchored: 0,
        applied: false,
        consecutiveFailures: 0,
        rulesVersionMismatch: true,
      },
      elapsed(),
    );
  }

  // 写盘决策一律由 DB 前后态 diff / plan 决定；台账行不得抑制 DB 缺失卡的自愈重建
  // （裁决 9：台账抑制自愈会造成单卡永久留洞；applied 回放符号已按裁决 10 删除，不留观测死码）。

  const changeCards: MemoryCard[] = [];
  const planDecisions: DecisionRecord[] = [];
  let invalidationCount = 0;

  for (const action of plan.actions) {
    if (action.type === 'create-card') {
      const event = eventById.get(action.eventId);
      const expectedCard = expected.byEvent.get(action.eventId);
      if (event === undefined || expectedCard === undefined) {
        continue;
      }
      const expectedHash = structuralHash({
        anchors: [...expectedCard.anchors],
        channel: expectedCard.channel,
        startedMs: expectedCard.startedMs,
        endedMs: expectedCard.endedMs,
        eligibility: event.summary_quality,
        rulesVersion: CURRENT_RULES_VERSION,
      });
      const row = materializeCard(expectedCard, event, source.cueByExperience);
      changeCards.push(row);
      planDecisions.push(
        castDrainDecision({
          card: row,
          eventId: event.id,
          version: event.version,
          createdAtIso: event.created_at,
          action: 'create-card',
          cardId: row.cardId,
          anchors: [...action.anchors],
          structuralHash: expectedHash,
          modelTag: CURRENT_RULES_VERSION,
          reason: 'create-card:drain-projection',
          dedupKey: `create-card|${event.id}|${row.cardId}|${action.anchors.join(',')}`,
        }),
      );
    } else if (action.type === 'invalidate-card') {
      invalidationCount += 1;
      const old = deps.reader.getCard(action.cardId);
      const event = eventById.get(action.eventId);
      if (old !== null) {
        changeCards.push({
          ...old,
          status: 'invalid',
          invalidMs: event !== undefined ? isoToMs(event.created_at) : old.invalidMs,
        });
      }
      if (event !== undefined) {
        planDecisions.push(
          castDrainDecision({
            card: old,
            eventId: event.id,
            version: event.version,
            createdAtIso: event.created_at,
            action: 'invalidate',
            cardId: action.cardId,
            anchors: parseAnchorJson(old),
            structuralHash: '',
            modelTag: CURRENT_RULES_VERSION,
            reason: 'invalidate-card:drain-projection',
            dedupKey: `invalidate-card|${event.id}|${action.cardId}`,
          }),
        );
      }
    } else if (action.type === 'update-card') {
      const event = eventById.get(action.eventId);
      const expectedCard = expected.byEvent.get(action.eventId);
      if (event !== undefined && expectedCard !== undefined) {
        const row = materializeCard(expectedCard, event, source.cueByExperience);
        changeCards.push(row);
        // #123 P3：cue 派生启用时，内容更新必须留决策行（此前该分支只换卡不记账）。
        if (cueEnabled) {
          planDecisions.push(
            castDrainDecision({
              card: row,
              eventId: event.id,
              version: event.version,
              createdAtIso: event.created_at,
              action: 'update-cues',
              cardId: row.cardId,
              anchors: [...expectedCard.anchors],
              structuralHash: '',
              modelTag: CURRENT_RULES_VERSION,
              reason: 'update-cues:drain-projection',
              // 结构判定路径不得引用 contentHash（护栏铁律），去重键改用事件版本。
              dedupKey: `update-cues|${event.id}|${row.cardId}|v${event.version}`,
            }),
          );
        }
      }
    }
    // migrate-aliases：别名随 event_id 重绑；本轮无既有别名快照接入，changes.aliases 为空。
  }

  // 观测物理写入（投影内 append-only；事务外，按三元组去重；绝不进 decisions）。
  appendDrainObservations(deps.indexDir, expected, eventById);

  const changes: CardChangeSet = { cards: changeCards, aliases: [] };
  const hasChanges = changeCards.length > 0;
  const applied = hasChanges && deps.writer !== null;

  if (applied) {
    const priorRevisions = readRevisions(deps.indexDir);
    const last = priorRevisions[priorRevisions.length - 1];
    const decisionAtMs = planDecisions.length > 0 ? Math.max(...planDecisions.map((decision) => decision.at_ms)) : 0;
    const eventAtMs = source.events.length > 0 ? Math.max(...source.events.map((event) => isoToMs(event.created_at))) : 0;
    const fingerprint =
      deps.dataRoot !== null ? computeTruthFingerprint(deps.dataRoot).aggregate : sha256Hex('empty-projection');
    const revision: RevisionRecord = {
      revision: (last?.revision ?? 0) + 1,
      slug: 'rebuild',
      at_ms: Math.max(decisionAtMs, eventAtMs, last?.at_ms ?? 0),
      schema_version: MEMORY_SCHEMA_VERSION,
      truth_fingerprint: fingerprint,
      prior_revision: last?.revision ?? null,
      card_count: changeCards.length,
      alias_count: 0,
      row_hash_sum: computeRowHashSum(changeCards),
      shadow_diff: { added: changeCards.length, removed: invalidationCount, changed: 0 },
      reason: 'drain-projection',
      operator: 'offline-cli',
    };
    // 一轮恰一次事务应用点（静态守卫：本文件事务应用调用点 ≤1 处）。
    deps.writer.transactionApply(changes, revision, planDecisions);
  }

  const report = buildDrainReport(
    {
      scannedVersions: source.events.length,
      cardUpserts: changeCards.filter((card) => card.status === 'active').length,
      invalidations: invalidationCount,
      quarantined: expected.quarantined.length,
      emptyAnchored: expected.emptyAnchored.length,
      applied,
      consecutiveFailures: consecutiveFailuresAfter(deps.consecutiveFailures, false),
      rulesVersionMismatch: false,
    },
    elapsed(),
  );

  // #117 3.2 第 1 件：drain 主触发留存维护（独立判定、独立事务，不搭 apply 便车）。
  // 放在 report 计时之后：裁剪耗时不得污染本轮预算判定口径。
  if (deps.writer !== null && deps.missRetention !== null && deps.missRetention !== undefined) {
    try {
      deps.writer.pruneMisses(deps.missRetention);
    } catch {
      // 留存维护是旁路维护动作：失败只入案底，绝不阻断投影轮次（下一轮 level-triggered 重试）。
    }
  }

  return report;
}
