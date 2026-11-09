/**
 * 切分器 —— 零 LLM、纯机械（技术基线 §5.2–§5.5）。
 *
 * 纪律：
 *  - **A 类机械信号命中即闭合**（不等 LLM、不需要语义判断）；
 *  - **B 类语义信号只标候选、绝不自动切**（打在当前 open 事件上，闭合与否留给她）；
 *  - **每通道各自维护一个 open 事件**（不存在全局 open）；
 *  - 场景切换时闭合「**被离开通道**」的 open 事件 —— dsh→browser→dsh 得三个事件，
 *    回到旧通道是**新事件**，不并回已闭合的旧事件；
 *  - **孤立记录永不自动并入**任何内容无关的事件；
 *  - **同一条记录只归一个事件**（重放防重，见 `knownPointerIds`）—— 重放不得重复挂指针；
 *  - 参数全部取自 `src/event/params.ts`（本文件不出现任何阈值字面量）。
 */

import { CorruptedError } from '../core/errors.ts';
import { isoToMs, msToIso } from '../core/time.ts';
import { defaultUlid } from '../core/ulid.ts';
import { EVENT_FIELDS, EVENT_SCHEMA_VERSION, parseEvent } from '../contract/event.ts';
import type {
  BoundaryCandidate,
  EventClosedReason,
  EventDerivedMarks,
  EventPointer,
  EventRecord,
} from '../contract/event.ts';
import type { Experience } from '../contract/experience.ts';
import type { EventLog } from '../source/event-log.ts';
import type { IngestStage, IngestStageContext } from './ingest-stage.ts';
import type { SemanticCandidateDetector } from './detector.ts';
import { maxRecordsOf, orphanWindowMsOf, resolveEventParams, silenceGapMsOf } from './params.ts';
import type { EventParams } from './params.ts';

/** 孤立记录标注的候选类型（落盘在 boundary_candidates 里，§5.5）。 */
export const ORPHAN_MARK_KIND = '孤立记录';

/**
 * 「待归并」判定（§5.5 行 1）—— 单指针**且因静默闭合**。
 *
 * 任务闭环 / 场景切换闭合的单条不是孤条（那是一件完整的事）→ 不标。
 */
export function isPendingMergeOf(event: EventRecord): boolean {
  return event.closed_reason === 'silence' && event.pointers.length === 1;
}

/**
 * 读时派生的标注（§5.6）—— 定义在契约层（`contract/event.ts`），此处只做复用。
 *
 * 单一来源：门面读出口、投影读面、本模块的 `marksOf` 必须认同一份形状，
 * 各写一遍必然漂移。
 */
export type { EventDerivedMarks } from '../contract/event.ts';

/** 切分器依赖（显式注入，便于测试）。 */
export interface SegmenterDeps {
  /** 事件真源（同步直调，不排队）。 */
  readonly log: EventLog;
  /** 读一条经历（用于派生「带附件」；重启后仍可精确重算）。 */
  readonly readExperience: (id: string) => Experience | undefined;
  readonly params?: EventParams;
  /** 可注入时钟（测试用）。缺省 Date.now。 */
  readonly now?: () => number;
  /**
   * B 类语义候选探测器（可选）—— 端口定义见 `src/event/detector.ts`。
   *
   * 缺省即没有语义信号 → `boundary_candidates` 恒空（§5.3：第一期不产生语义候选）。
   * 探测器只标候选、永不闭合。
   */
  readonly detectSemanticBoundary?: SemanticCandidateDetector;
}

/** 每通道的 open 事件状态（只存判定必需的最小信息）。 */
interface OpenEventState {
  /** 事件 id（当前态从事件真源读）。 */
  eventId: string;
  /** 末条记录的世界轴时刻（毫秒）—— 静默判据的基准。 */
  lastAtMs: number;
}

/**
 * 切分器 —— 零 LLM、纯机械。
 *
 * 状态：每通道一个 open 事件（`Map<channel, OpenEvent>`）+ 一个「当前活动通道」。
 */
export class EventSegmenter implements IngestStage {
  readonly name = 'segmenter';

  private readonly log: EventLog;
  private readonly readExperience: (id: string) => Experience | undefined;
  private readonly params: EventParams;
  private readonly now: () => number;
  private readonly detectSemanticBoundary: SemanticCandidateDetector | undefined;

  /** 每通道各自的 open 事件（不存在全局 open）。 */
  private openByChannel = new Map<string, OpenEventState>();
  /** 当前活动通道（最近一条经历的通道）。 */
  private activeChannel: string | null = null;
  /** 本次闭合的事件 —— 后台队列的接入点。 */
  private readonly closedEvents: EventRecord[] = [];
  /**
   * 已归入某事件的记录 id —— **重放防重**。
   *
   * 为什么需要：一条记录只能属于一件事。重放（回填重跑、补切入口、宿主重投）
   * 若被当成新记录再挂一次，指针会重复、时间范围不变但「事件含 N 条」失真，
   * 且摘要会把同一段原文写两遍。门面的幂等早退只挡得住**经过门面**的路径，
   * 挡不住任何直接驱动 stage 的新入口 —— 防线应当长在 stage 里。
   *
   * 由 `restore()` 从事件真源重建（不是新真源，纯派生）。
   */
  private knownPointerIds = new Set<string>();

  constructor(deps: SegmenterDeps) {
    this.log = deps.log;
    this.readExperience = deps.readExperience;
    this.params = resolveEventParams(deps.params);
    this.now = deps.now ?? Date.now;
    this.detectSemanticBoundary = deps.detectSemanticBoundary;
  }

  // ── IngestStage ────────────────────────────────────────────────────────

  /** 处理一条刚落盘的经历（§5.3 判定表，逐条对齐）。 */
  run(ctx: IngestStageContext): void {
    const record = ctx.experience;
    const channel = ctx.channel;

    // 规则 0 · 重放防重：这条记录已归入某个事件 → 什么都不做（幂等，不重复挂指针）。
    // 放在最前面：既不改 open 状态，也不产生新版本行。
    if (this.knownPointerIds.has(record.id)) {
      return;
    }

    const candidates =
      this.detectSemanticBoundary?.({
        experience: record,
        channel,
        atPointerId: record.id,
        markedAt: msToIso(this.now()),
      }) ?? [];

    // 规则 1 · 场景切换：活动通道与本条不同 → 闭合「被离开通道」的 open 事件（不含本条）。
    if (this.activeChannel !== null && this.activeChannel !== channel) {
      const leaving = this.openByChannel.get(this.activeChannel);
      if (leaving !== undefined) {
        this.closeEvent(leaving.eventId, 'channel-switch');
        this.openByChannel.delete(this.activeChannel);
      }
    }
    this.activeChannel = channel;

    const state = this.openByChannel.get(channel);
    if (state === undefined) {
      // 规则 2 · 该通道无 open 事件 → 新建事件（含本条）。
      this.openEvent(channel, record, ctx, candidates);
      return;
    }

    // 规则 3 · 静默：间隔 ≥ 阈值 → 闭合旧事件（不含本条）→ 新建事件（含本条）。
    if (isoToMs(record.occurred_at) - state.lastAtMs >= silenceGapMsOf(this.params)) {
      this.closeEvent(state.eventId, 'silence');
      this.openByChannel.delete(channel);
      this.openEvent(channel, record, ctx, candidates);
      return;
    }

    // 规则 4 · 并入当前 open 事件（规则 5 / 6 在同一个版本里判）。
    this.mergeInto(channel, state, record, ctx, candidates);
  }

  // ── 开放状态的恢复 ─────────────────────────────────────────────────────

  /**
   * 从事件真源恢复每通道的 open 状态（进程重启后调用，幂等）。
   *
   * 恢复不出（真源损坏 / 同通道两个 open 事件）→ 抛 CorruptedError：
   * **不静默从零开始** —— 静默从零会把已有记录重切一遍，破坏「事件不可由算法批量重建」。
   */
  restore(): void {
    this.log.reindex();

    const restored = new Map<string, OpenEventState>();
    let activeChannel: string | null = null;
    let activeLastAtMs = Number.NEGATIVE_INFINITY;
    const known = new Set<string>();

    for (const event of this.log.readAll()) {
      // 重放防重表：从**当前态**的指针重建（历史版本里的指针已被后续版本覆盖）。
      for (const pointer of event.pointers) {
        known.add(pointer.id);
      }
      if (event.status !== 'open') {
        continue;
      }
      if (restored.has(event.channel)) {
        throw new CorruptedError(`同一通道出现两个 open 事件（数据不自洽）：${event.channel}`);
      }
      const lastAtMs = isoToMs(event.time_range.ended_at);
      restored.set(event.channel, { eventId: event.id, lastAtMs });
      // 活动通道 = 恢复出的 open 事件中 ended_at 最大者所在通道。
      if (lastAtMs > activeLastAtMs) {
        activeChannel = event.channel;
        activeLastAtMs = lastAtMs;
      }
    }

    this.openByChannel = restored;
    this.activeChannel = activeChannel;
    this.knownPointerIds = known;
  }

  // ── 孤立记录（T6）──────────────────────────────────────────────────────

  /**
   * 孤立记录标注扫描（启动时调用，幂等）：
   *  - 达到孤立观察窗的单记录闭合事件 → 追加一个版本，追加「孤立记录」候选标注；
   *  - **只加标注，不自动归并**（归并只有她手动，§7.3）；
   *  - 孤立记录**不删**（append-only）。
   *
   * @returns 本次标注的事件数
   */
  sweepOrphanMarks(nowMs: number): number {
    const windowMs = orphanWindowMsOf(this.params);
    const markedAt = msToIso(nowMs);
    let marked = 0;

    for (const event of this.log.readAll()) {
      // 判据：仍只有 1 条记录、且因静默闭合的闭合事件（与「待归并」同一集合），
      // 并且观察窗已到期。
      if (!isPendingMergeOf(event)) {
        continue;
      }
      const pointer = event.pointers[0];
      if (pointer === undefined) {
        continue;
      }
      // 幂等：已标过的不再重复标。
      if (event.boundary_candidates.some((item) => item.kind === ORPHAN_MARK_KIND)) {
        continue;
      }
      if (nowMs - isoToMs(event.assembled_at) < windowMs) {
        continue;
      }

      const next: EventRecord = {
        ...event,
        version: event.version + 1,
        boundary_candidates: [
          ...event.boundary_candidates,
          { kind: ORPHAN_MARK_KIND, at_pointer_id: pointer.id, marked_at: markedAt },
        ],
        created_at: markedAt,
      };
      this.log.appendVersion(next);
      marked += 1;
    }

    return marked;
  }

  // ── 读出口径（§5.6）────────────────────────────────────────────────────

  /**
   * 事件的派生标注 —— 读时计算，不落盘。
   *
   * 「待归并」的判据：单指针**且因静默闭合**（`closed_reason === 'silence'`）——
   * 任务闭环 / 场景切换闭合的单条不是「无处可并的孤条」，而是**一件完整的事**
   * （如「她打开了一个网页」），不能标成待归并。
   * 系统**永不**自动把它并进别的事件。
   */
  marksOf(event: EventRecord): EventDerivedMarks {
    const channels = new Set<string>();
    let hasMedia = false;

    for (const pointer of event.pointers) {
      const experience = this.readExperience(pointer.id);
      const channel = pointer.channel ?? experience?.scene.channel;
      if (channel !== undefined) {
        channels.add(channel);
      }
      if ((experience?.observation.media?.length ?? 0) > 0) {
        hasMedia = true;
      }
    }

    return {
      hasMedia,
      crossChannel: channels.size > 1,
      pendingMerge: isPendingMergeOf(event),
      orphan: event.boundary_candidates.some((item) => item.kind === ORPHAN_MARK_KIND),
      summaryStale: event.summary_source === 'her' && event.summary_quality === 'pending',
    };
  }

  /**
   * 取走本次闭合的事件 —— **Batch 3 接入点**（后台队列在此接）。
   *
   * 闭合事件的真源状态已是 closed + pending，队列落地后由启动清道夫重扫补齐，
   * 故这里取走即可，不会丢。
   */
  drainClosedEvents(): EventRecord[] {
    return this.closedEvents.splice(0);
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /** 规则 2 / 3 · 新建事件（含本条），并登记为该通道的 open 事件。 */
  private openEvent(
    channel: string,
    record: Experience,
    ctx: IngestStageContext,
    candidates: readonly BoundaryCandidate[],
  ): void {
    const nowMs = this.now();
    const event = newEventRecord({
      channel,
      pointer: pointerOf(record, ctx),
      occurredAt: record.occurred_at,
      assembledAt: msToIso(nowMs),
      candidates: [...candidates],
    });

    this.log.appendVersion(event);
    this.knownPointerIds.add(event.pointers[0]?.id ?? record.id);
    this.openByChannel.set(channel, { eventId: event.id, lastAtMs: isoToMs(record.occurred_at) });
  }

  /** 规则 4 / 5 / 6 · 并入当前 open 事件；命中上限或任务闭环则同一个版本闭合。 */
  private mergeInto(
    channel: string,
    state: OpenEventState,
    record: Experience,
    ctx: IngestStageContext,
    candidates: readonly BoundaryCandidate[],
  ): void {
    const current = this.log.currentOf(state.eventId);
    const pointer = pointerOf(record, ctx);
    const pointers = [...current.pointers, pointer];

    // 静默与世界轴同轴：乱序到达时 started 取 min、ended 取 max。
    const startedAt =
      isoToMs(record.occurred_at) < isoToMs(current.time_range.started_at)
        ? record.occurred_at
        : current.time_range.started_at;
    const endedAt =
      isoToMs(record.occurred_at) > isoToMs(current.time_range.ended_at)
        ? record.occurred_at
        : current.time_range.ended_at;

    // 规则 5（条数上限）/ 规则 6（任务闭环）：与并入合并为同一个 closed 版本。
    // 两者同时命中时按判定表顺序取「条数上限」（表格行序即判定顺序）。
    const hitMaxRecords = pointers.length >= maxRecordsOf(this.params);
    const hitTaskClosure = isTaskClosure(record);
    const closed = hitMaxRecords || hitTaskClosure;
    const closedReason: EventClosedReason | null = hitMaxRecords
      ? 'max-records'
      : hitTaskClosure
        ? 'task-closure'
        : null;

    const nowMs = this.now();
    const next: EventRecord = {
      ...current,
      version: current.version + 1,
      status: closed ? 'closed' : 'open',
      closed_reason: closedReason,
      pointers,
      time_range: { started_at: startedAt, ended_at: endedAt },
      boundary_candidates:
        candidates.length === 0
          ? current.boundary_candidates
          : [...current.boundary_candidates, ...candidates],
      created_at: msToIso(nowMs),
    };

    this.log.appendVersion(next);
    this.knownPointerIds.add(pointer.id);

    if (closed) {
      this.openByChannel.delete(channel);
      this.closedEvents.push(next);
      return;
    }
    state.lastAtMs = isoToMs(endedAt);
  }

  /** 规则 1 / 3 · 闭合一个 open 事件（不含触发闭合的那一条）。 */
  private closeEvent(eventId: string, reason: EventClosedReason): void {
    const current = this.log.currentOf(eventId);
    const next: EventRecord = {
      ...current,
      version: current.version + 1,
      status: 'closed',
      closed_reason: reason,
      created_at: msToIso(this.now()),
    };
    this.log.appendVersion(next);
    this.closedEvents.push(next);
  }
}

/** 指针 —— id 权威，channel / shard / seq 冗余加速（对齐 Pointer 双定位口径）。 */
function pointerOf(record: Experience, ctx: IngestStageContext): EventPointer {
  return {
    id: record.id,
    channel: record.scene.channel,
    shard: ctx.location.shard,
    seq: ctx.location.seq,
  };
}

/**
 * 任务闭环信号（机械判据）：工具调用有结果 = 事办完了。
 *
 * 注：当前 dsh 摄入只产出 kind='dialogue' 的经历（无 action / outcome），
 * 故该信号在真机尚未触发 —— 规则先落地，不为「现在用不上」而删。
 */
function isTaskClosure(record: Experience): boolean {
  return record.action?.type === 'tool-call' && record.outcome?.status !== undefined;
}

/**
 * 构造一条新事件记录（version=1、status='open'）。
 *
 * 两个「第一期恒空」的必填数组字段**不在本文件写死字段名**：
 * 契约层独占这两个字段名（红线：src/ 内除契约层外不得出现它们）→ 这里按契约层
 * 导出的字段表把没给出的字段补成空数组，再交给契约层的 `parseEvent` 逐字段校验
 * （填错类型会当场报错，不会静默通过）。
 */
function newEventRecord(input: {
  channel: string;
  pointer: EventPointer;
  occurredAt: string;
  assembledAt: string;
  candidates: BoundaryCandidate[];
}): EventRecord {
  const raw: Record<string, unknown> = {
    id: defaultUlid.next(),
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'open',
    closed_reason: null,
    pointers: [input.pointer],
    time_range: { started_at: input.occurredAt, ended_at: input.occurredAt },
    assembled_at: input.assembledAt,
    summary: null,
    key_points: [],
    summary_quality: 'pending',
    summary_source: null,
    // 溯源字段：新事件还没有摘要 → null（不能靠下面的补位循环补成 []）。
    summary_prompt_version: null,
    summary_model: null,
    created_by: 'system',
    created_at: input.assembledAt,
    channel: input.channel,
    boundary_candidates: input.candidates,
    // 退役指针：本次不写（置 undefined = 该字段不存在）。
    merged_into: undefined,
    split_into: undefined,
  };

  // 只为**数组类**字段兜底；可空字符串字段必须在上面的字面量里显式写 null
  // （补成 [] 会被契约层当场拒收）。
  for (const field of EVENT_FIELDS) {
    if (!(field in raw)) {
      raw[field] = [];
    }
  }

  return parseEvent(raw, 'write');
}
