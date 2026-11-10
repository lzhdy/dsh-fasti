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
import type { RawTurnTextReader } from './raw-text-port.ts';
import {
  charsToTokens,
  fuseLimitOf,
  maxEffectiveCharsOf,
  orphanWindowMsOf,
  resolveEventParams,
  silenceGapMsOf,
  taskScopeActiveOf,
} from './params.ts';
import type { EventParams } from './params.ts';

/** 孤立记录标注的候选类型（落盘在 boundary_candidates 里，§5.5）。 */
export const ORPHAN_MARK_KIND = '孤立记录';

/**
 * 「待归并」判定（§5.5 行 1）—— 单指针**且因上限/静默闭合**。
 *
 * v1.4：闭合原因集合取 `{silence, max-dialogue-chars, max-chars}`
 * （定案稿 §5.2.1 第 6 条）—— `max-records` 退役移出；
 * `task-closure` / `channel-switch` 的单条不是孤条（那是一件完整的事）→ 不标。
 */
const PENDING_MERGE_REASONS: readonly EventClosedReason[] = [
  'silence',
  'max-dialogue-chars',
  'max-chars',
];

export function isPendingMergeOf(event: EventRecord): boolean {
  return (
    event.closed_reason !== null &&
    PENDING_MERGE_REASONS.includes(event.closed_reason) &&
    event.pointers.length === 1
  );
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
  /** 末条记录的世界轴时刻（毫秒）—— 摄入期静默判据的基准。 */
  lastAtMs: number;
  /**
   * 末条记录的**系统轴**时刻（毫秒）—— 时钟静默判据的基准（定案稿 C6）。
   *
   * 为什么与 `lastAtMs` 分开存：摄入期的静默补判走**世界轴**（`occurred_at`，
   * 「事情之间隔了多久」），时钟化的静默走**系统轴**（`recorded_at`，与墙钟同轴，
   * 「距离现在多久没动静了」）。两者口径不同、不可互换 —— 系统轴才是墙钟能直接比的量。
   */
  lastRecordedAtMs: number;
  /**
   * 有效对话字数累计（v1.4）—— 只累加**非工具轮**的 `char_count`。
   *
   * 工具/非工具的判定**直接读 C2c 的类型化产物**（带 `action.type='tool-call'`
   * 或 `outcome` 的记录为工具轮），不在累计时二次解析载荷（任务书 C2b）。
   */
  effectiveChars: number;
  /**
   * 原文全量字符累计（v1.4）—— 对**所有**记录累加 `char_count`（含工具 JSON）。
   *
   * 硬保险丝（`max-chars`）的唯一数据源。
   */
  rawChars: number;
  /**
   * 本段是否**有过**带 `char_count` 的记录（v1.4）。
   *
   * 用来区分「累计了 0 字」与「从未统计」：
   * 一条记录都没有 `char_count`（旧数据 / 原文端口读不到）→ 计数器的语义是
   * **未统计**，事件行写 `null`；有过带计数的记录 → 写数字（哪怕是 0）。
   *
   * 对齐定案稿 §3.2：`null` = 旧数据/未统计（不是「零字」）。
   */
  counted: boolean;
  /**
   * 在途工具调用标识集合（v1.4 · C5 任务作用域）。
   *
   * 见到 `action.type='tool-call'` 加入其 callId；见到对应 callId 的 `outcome` 移除。
   * 空集 = 没有未完成的工具调用。
   *
   * **不单独持久化**：跨重启靠重放该 open 事件的记录确定性重建（§5.0.3）。
   */
  inFlightCallIds: Set<string>;
  /**
   * 在途但**无从配对**的工具调用数（v1.4 · C5）。
   *
   * 载荷缺 callId 的调用步无法与结果对应，也就无法证明它已完成 ——
   * 计入本数，作用域在它离场前不算闭合（不猜、不编）。
   */
  unpairedToolCalls: number;
  /**
   * 工具调用准入门槛（v1.4 · C5）。
   *
   * 作用域内出现过**任意一次** tool-call 即置 true；**作用域内不复位**，
   * 事件闭合或新建事件时随作用域状态一起清零。
   *
   * 没有它就无法区分「纯对话」（永远不触发任务闭环）与「有工具调用的作用域」。
   */
  toolCallSeen: boolean;
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
      // 系统轴基准（时钟静默用）：取**末条指针**对应经历的 recorded_at。
      // 取不到（经历已不在真源 / 指针悬空）→ 退回世界轴 ended_at 作为近似，
      // **不编造**一个时刻；退化只影响判定的严格度，不会伪造闭合时刻。
      const lastPointer = event.pointers[event.pointers.length - 1];
      const lastExperience = lastPointer === undefined ? undefined : this.readExperience(lastPointer.id);
      const lastRecordedAtMs =
        lastExperience === undefined ? lastAtMs : isoToMs(lastExperience.recorded_at);
      // 双计数器：**直接从事件行读**，不从 pointers 重算（定案稿 §3.2 / C4）。
      // 升级在途 open 事件（两字段为 null）→ **null 视为 0**，只对切换后新记录累计
      // （定案稿 §7.4 迁移口径：不重算、不回改历史、不读原文补数）。
      const effectiveChars = event.effective_chars ?? 0;
      const rawChars = event.raw_chars ?? 0;
      // 事件行的计数器为 null → 语义是「未统计」→ counted=false（继续按 0 起算）。
      const counted = event.effective_chars !== null && event.raw_chars !== null;
      const state: OpenEventState = newScopeState({
        eventId: event.id,
        lastAtMs,
        lastRecordedAtMs,
        effectiveChars,
        rawChars,
        counted,
      });
      // 作用域状态：**重放该 open 事件的记录**确定性重建（定案稿 §5.0.3：
      // 不单独持久化，action 入、outcome 出）。读不到的经历跳过 ——
      // 缺一条不影响「哪些 callId 在途」的其余部分，不编造。
      for (const pointer of event.pointers) {
        const experience = this.readExperience(pointer.id);
        if (experience !== undefined) {
          applyToScope(state, experience);
        }
      }
      restored.set(event.channel, state);
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

  /**
   * 时钟静默检查 —— 把「已经安静够久」的 open 事件闭合掉（定案稿 C6）。
   *
   * **为什么要有这条路径**：摄入期的静默补判只在「下一条记录到达」时求值，
   * 用户离开后再无记录 → 最后那个事件会一直 open 着（曾实测延迟一天才闭合）。
   * 时钟化让闭合不再依赖「有人说话」。
   *
   * 判定口径（逐条钉死）：
   *  - 基准 = **系统轴** `recorded_at`（与墙钟同轴），**不取** `occurred_at`/`asserted_at`；
   *  - `now - lastRecordedAt ≥ silenceGapMs(30min)` → 闭合，reason `silence`，
   *    **不含尚未到达的记录**；
   *  - 幂等：闭合后该事件移出 open 状态 → 对已闭合/不存在的 open 事件重复检查是 no-op，
   *    不产生新版本；
   *  - 与摄入期补判共用同一张优先级表（§5.2.1），同一事件只闭合一次、只写一个原因。
   *
   * **独立于 LLM 端口**：本方法只管闭合与入队，不碰摘要 —— 没有端口时事件照常闭合，
   * 摘要保持 pending。
   *
   * @returns 本次因静默而闭合的事件数
   */
  closeExpiredEvents(nowMs: number = this.now()): number {
    const gapMs = silenceGapMsOf(this.params);
    let closed = 0;

    // 遍历副本：闭合会删 openByChannel 的条目，不能边遍历边改。
    for (const [channel, state] of [...this.openByChannel]) {
      if (nowMs - state.lastRecordedAtMs < gapMs) {
        continue;
      }
      this.closeEvent(state.eventId, 'silence');
      this.openByChannel.delete(channel);
      closed += 1;
    }

    return closed;
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
    // 首条记录也要计入计数器（事件从零开始，这一条就是它的第一笔）。
    const counted = countOf(record);
    const event = newEventRecord({
      channel,
      pointer: pointerOf(record, ctx),
      occurredAt: record.occurred_at,
      assembledAt: msToIso(nowMs),
      candidates: [...candidates],
      // 没有 char_count → 计数器的语义是「未统计」→ 写 null（不是 0）。
      effectiveChars: counted.counted ? counted.effective : null,
      rawChars: counted.counted ? counted.raw : null,
    });

    this.log.appendVersion(event);
    this.knownPointerIds.add(event.pointers[0]?.id ?? record.id);

    // 首条就撞上限 → 立即闭合（新建事件本身也可能超限）。
    // 顺序与并入路径完全一致：先硬保险丝、再有效对话字数（§5.2.1 第 3 条）。
    const capReason = capReasonOf(counted.effective, counted.raw, this.params);
    if (capReason !== null) {
      const closed: EventRecord = {
        ...event,
        version: event.version + 1,
        status: 'closed',
        closed_reason: capReason,
        created_at: msToIso(nowMs),
      };
      this.log.appendVersion(closed);
      this.closedEvents.push(closed);
      return;
    }
    this.openByChannel.set(
      channel,
      newScopeState({
        eventId: event.id,
        lastAtMs: isoToMs(record.occurred_at),
        lastRecordedAtMs: isoToMs(record.recorded_at),
        effectiveChars: counted.effective,
        rawChars: counted.raw,
        counted: counted.counted,
      }),
    );
    // 首条也参与作用域：它可能就是一次 tool-call（准入门槛的第一次置位）。
    const state = this.openByChannel.get(channel);
    if (state !== undefined) {
      applyToScope(state, record);
    }
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

    // 规则 5（v1.4 两个上限）/ 规则 6（任务闭环）：与并入合并为同一个 closed 版本。
    //
    // 判定顺序 = 定案稿 §5.2.1 第 3 条的优先级表：
    //   通道切换 / 静默 / 任务闭环 > 硬保险丝(max-chars) > 有效对话字数上限(max-dialogue-chars)
    // 一次只写一个原因，命中即 return。
    //
    // 计数器先累加**再判定** —— 触发上限的那条记录本身属于本段（与冻结夹具生成器
    // `make-fixture.py` 的口径逐条对齐：先 append pointer、再累加、最后判上限）。
    const counted = countOf(record);
    const nextEffectiveChars = state.effectiveChars + counted.effective;
    const nextRawChars = state.rawChars + counted.raw;
    // 本段是否有过带计数的记录 —— 决定事件行写数字还是 null（未统计）。
    const nextCounted = state.counted || counted.counted;

    // 作用域状态先更新（加入/移除在途 callId），再判闭环 ——
    // 「末条是结果」这条记录本身要让它的 callId 离场，判据才准。
    applyToScope(state, record);

    // 「新 user 意图轮到达」：user 轮且**不是**工具轮
    // （工具轮由 initiation='environment' 标识，判据只看「谁在说」）。
    //
    // **dormant 门控（定案稿 §5.2）**：任务闭环信号默认休眠（dormant），
    // 作用域判据照常维护，但**不参与闭合判定** —— 关闭时恒不产生 task-closure。
    // 激活与否由设计口径变更决定（dormant → active），不由实现方自行打开。
    const hitTaskClosure =
      taskScopeActiveOf(this.params) &&
      isTaskScopeClosed(state, record, record.initiation === 'user' && !isToolTurn(record));
    // 两个上限的判定复用唯一实现（新建路径同源，顺序一致：先保险丝、再有效对话字数）。
    const capReason = capReasonOf(nextEffectiveChars, nextRawChars, this.params);

    const closed = hitTaskClosure || capReason !== null;
    const closedReason: EventClosedReason | null = hitTaskClosure
      ? 'task-closure'
      : capReason;

    const nowMs = this.now();
    const next: EventRecord = {
      ...current,
      version: current.version + 1,
      status: closed ? 'closed' : 'open',
      closed_reason: closedReason,
      pointers,
      time_range: { started_at: startedAt, ended_at: endedAt },
      // 双计数器随版本推进落盘（restore 直接读本字段，不从 pointers 重算）。
      // 从未有过带计数的记录 → 写 null（语义 = 未统计，不是「零字」）。
      effective_chars: nextCounted ? nextEffectiveChars : null,
      raw_chars: nextCounted ? nextRawChars : null,
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
    // 系统轴基准随并入推进 —— 时钟静默看的是「距今多久没动静」。
    state.lastRecordedAtMs = isoToMs(record.recorded_at);
    state.effectiveChars = nextEffectiveChars;
    state.rawChars = nextRawChars;
    state.counted = nextCounted;
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
 * 两个上限的判定 —— **唯一实现**（新建事件路径与并入路径共用）。
 *
 * 顺序钉死（定案稿 §5.2.1 第 3 条）：**先硬保险丝、再有效对话字数**。
 * 命中即只写一个原因（`'max-chars'` 优先于 `'max-dialogue-chars'`）。
 *
 * 保险丝的量纲是 token（`charsToTokens`：1 raw 字符 ≈ 1 token），
 * 有效对话字数是码点 —— 两个量纲不同、不可合并（§5.2 硬保险丝条）。
 *
 * @returns 命中的闭合原因；两个上限都没命中 → null
 */
function capReasonOf(
  effectiveChars: number,
  rawChars: number,
  params: EventParams,
): 'max-chars' | 'max-dialogue-chars' | null {
  if (charsToTokens(rawChars) >= fuseLimitOf(params)) {
    return 'max-chars';
  }
  if (effectiveChars >= maxEffectiveCharsOf(params)) {
    return 'max-dialogue-chars';
  }
  return null;
}

/**
 * 工具轮判定 —— **直接读 C2c 的类型化产物**（任务书 C2b）。
 *
 * 判据：带 `action.type='tool-call'` 或带 `outcome` 的记录为工具轮。
 *
 * 纪律：
 *  - **不在累计时二次解析载荷** —— 类型化已在阶段 0 做完，这里只认产物；
 *  - **不引用宿主 `speaker`** —— 契约层没有 speaker 字段，speaker 不是契约事实。
 */
function isToolTurn(record: Experience): boolean {
  return record.action?.type === 'tool-call' || record.outcome !== undefined;
}

/**
 * 把一条记录并入作用域状态（v1.4 · C5 任务作用域）。
 *
 * 定案稿 §5.0.3 钉死的两条：
 *  - 见到 `action.type='tool-call'` → **加入**其 callId，并置 `toolCallSeen = true`；
 *  - 见到对应 callId 的 `outcome` → **移除**该 callId。
 *
 * `toolCallSeen` **作用域内不复位**（只在事件闭合/新建时随作用域清零）。
 *
 * **无 callId 的情形**（载荷缺 callId 的调用步）：callId 无从提取 →
 * 这条调用**无法与任何结果配对**，也就**无法证明它已完成** → 记入
 * `unpairedToolCalls` 计数，作用域在它离场前不算闭合。
 * 不猜、不编：宁可不算完成，也不误判闭环。
 */
function applyToScope(state: OpenEventState, record: Experience): void {
  const action = record.action;
  if (action?.type === 'tool-call') {
    const callId = action.call_id;
    if (callId !== undefined && callId !== '') {
      state.inFlightCallIds.add(callId);
    } else {
      // 无从配对的调用步：计入「在途但无法确认完成」。
      state.unpairedToolCalls += 1;
    }
    // 准入门槛：出现过 tool-call 就置位（无论有没有 callId 可配对）。
    state.toolCallSeen = true;
  }

  const outcome = record.outcome;
  if (outcome !== undefined) {
    const callId = outcome.call_id;
    if (callId !== undefined && callId !== '') {
      state.inFlightCallIds.delete(callId);
    } else if (state.unpairedToolCalls > 0) {
      // 无 callId 的结果：配掉最早那条无从配对的调用步（先进先出）。
      state.unpairedToolCalls -= 1;
    }
  }
}

/**
 * 任务作用域闭合判据（v1.4 · C5 · 定案稿 §5.0.3）。
 *
 * 仅当**三者同时成立**为真：
 *  1. `toolCallSeen === true` —— 作用域内出现过至少一次 tool-call（准入门槛）；
 *  2. 没有未完成的工具调用 —— `inFlightCallIds` 为空**且** `unpairedToolCalls` 为 0；
 *  3. 末条为**交付轮**（非工具的 her 轮），或**新 user 意图轮到达**。
 *
 * 纯对话（从未出现 tool-call）恒为假 —— 没有工具调用就没有「任务」，
 * 纯对话由静默与有效对话字数上限负责。
 *
 * 工具轮既不是交付轮也不是新意图轮：它既不是「她把结果说出来」，
 * 也不是「用户提了新要求」。
 */
function isTaskScopeClosed(
  state: OpenEventState,
  lastRecord: Experience,
  newUserIntent: boolean,
): boolean {
  if (!state.toolCallSeen) {
    return false;
  }
  if (state.inFlightCallIds.size > 0 || state.unpairedToolCalls > 0) {
    return false;
  }
  // 末条是工具轮 → 既不是交付轮、也不是新意图轮（工具在中间，不在两端）。
  if (isToolTurn(lastRecord)) {
    return false;
  }
  // 交付轮 = 非工具的 her 轮（她把结果说出来了）；或新的 user 意图轮到达。
  const isDeliveryTurn = lastRecord.initiation === 'her';
  return isDeliveryTurn || newUserIntent;
}
/**
 * 一条记录对两个计数器的贡献（任务书 C2b）。
 *
 * - `raw_chars`：对**所有**记录累加 `char_count`（含工具 JSON）；
 * - `effective_chars`：只累加**非工具轮**的 `char_count`。
 *
 * `char_count` 为 null（旧数据/未统计/原文端口读不到）→ 两个计数器都**跳过这条**
 * （失败降级表第 1 行：本次字数/保险丝判定跳过，不猜不编、不阻断摄入）。
 */
function countOf(record: Experience): { effective: number; raw: number; counted: boolean } {
  const charCount = record.char_count;
  if (charCount === null || charCount === undefined) {
    return { effective: 0, raw: 0, counted: false };
  }
  if (isToolTurn(record)) {
    return { effective: 0, raw: charCount, counted: true };
  }
  return { effective: charCount, raw: charCount, counted: true };
}

/**
 * 新建一个作用域状态（v1.4 · C5 任务作用域）。
 *
 * 为什么用工厂函数而不是对象字面量：`inFlightCallIds` 必须**在本文件里声明成
 * `new Set(...)`** —— 冻结面守卫（`tests/contract/frozen-surface.test.ts`）据此
 * 推导出「内存集合自身的 delete」白名单：只有在本文件被声明成 Map/Set 的变量，
 * 它的 `.delete()` 才被放行（`Set.delete` 是集合自身的方法，与「删真源记录」是两件事）。
 * 真源对象（log / record / shard）永远不在白名单里。
 */
function newScopeState(input: {
  eventId: string;
  lastAtMs: number;
  lastRecordedAtMs: number;
  effectiveChars: number;
  rawChars: number;
  counted: boolean;
}): OpenEventState {
  const inFlightCallIds = new Set<string>();
  return {
    ...input,
    inFlightCallIds,
    unpairedToolCalls: 0,
    toolCallSeen: false,
  };
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
  /** 首条记录计入后的有效对话字数（v1.4）；null = 未统计。 */
  effectiveChars: number | null;
  /** 首条记录计入后的原文全量字符（v1.4）；null = 未统计。 */
  rawChars: number | null;
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
    // v1.4 双计数器：新建事件已含首条记录的计数（必须显式写值：
    // 下面的补位循环只服务**数组类**字段，把它们补成 [] 会被契约层当场拒收）。
    effective_chars: input.effectiveChars,
    raw_chars: input.rawChars,
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
