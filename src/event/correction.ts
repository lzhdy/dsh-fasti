/**
 * 事件修正 —— 五种修正 + 派生字段重跑 + 上层接力（技术基线 §7.3）。
 *
 * 纪律：
 *  - **修正只由她发起**：写出的版本行 created_by='her'（机器可判「谁改的」）；
 *  - **退役态不删行**（append-only）：合并/拆分只追加新版本，旧行原样留在版本历史里；
 *  - **版本推进只走 EventLog.appendVersion**：读当前态 → 算 +1 → 追加，
 *    整个操作在调用方的同一个写队列任务内完成（§3.3）；
 *  - **派生字段必须重跑**：换了 pointers 就不许留旧摘要（§7.2 规则 1）；
 *  - **她手写的摘要不被覆盖**：只保留她的摘要并标 pending，锚点/话题线照常重跑（§7.2 规则 2）；
 *  - **上层接力只读不写**：不自动改写她的记忆指针（那是她的东西）。
 *
 * 与闭合管线解耦：重跑走窄接口 `CorrectionRerunner`，本模块不 import
 * `src/event/closure.ts`、也不直接调模型（LLM 只在适配器层、只在后台 —— D-2）。
 */

import { ConflictError, CorruptedError, NotFoundError, SchemaError } from '../core/errors.ts';
import { isoToMs, msToIso } from '../core/time.ts';
import { defaultUlid } from '../core/ulid.ts';
import { EVENT_FIELDS, EVENT_SCHEMA_VERSION, EventOpenConflictError, parseEvent } from '../contract/event.ts';
import type { EventOpenConflictBlocking, EventPointer, EventRecord, EventTimeRange } from '../contract/event.ts';
import type { Experience } from '../contract/experience.ts';
import type { EventLog } from '../source/event-log.ts';

// ── 入参 / 出参 ────────────────────────────────────────────────────────────

/** 合并入参：A + B → C（可多到一，§7.3）。 */
export interface MergeInput {
  /** 被合并的事件 id（≥2 个，必须都是当前态且非退役态）。 */
  readonly sourceIds: readonly string[];
  /** 新事件 id；缺省由系统分配。 */
  readonly targetId?: string | undefined;
}

/** 合并结果。 */
export interface MergeResult {
  /** 新事件 C（当前态）。 */
  readonly target: EventRecord;
  /** 被退役的来源事件当前态（status='merged'、带 merged_into）。 */
  readonly retired: readonly EventRecord[];
}

/** 拆拆分入参：A → B1 + B2。 */
export interface SplitInput {
  /** 被拆分的事件 id。 */
  readonly sourceId: string;
  /** 每个子事件的指针分组（按记录 id 给出；≥2 组；必须覆盖且仅覆盖源事件的指针）。 */
  readonly groups: readonly (readonly string[])[];
}

/** 拆分结果。 */
export interface SplitResult {
  /** 被退役的源事件当前态（status='split'、带 split_into）。 */
  readonly retired: EventRecord;
  /** 拆出的子事件（各自是新事件）。 */
  readonly children: readonly EventRecord[];
}

/** 改边界入参：换 pointers（移出/移入）。 */
export interface ReviseBoundaryInput {
  /** 事件 id。 */
  readonly eventId: string;
  /** 移出的记录 id。 */
  readonly removePointerIds?: readonly string[] | undefined;
  /** 移入的记录 id。 */
  readonly addPointerIds?: readonly string[] | undefined;
}

/** 改边界结果。 */
export interface ReviseBoundaryResult {
  /** 修正后的当前态。 */
  readonly event: EventRecord;
}

/** 重开入参：closed → open。 */
export interface ReopenInput {
  /** 事件 id。 */
  readonly eventId: string;
}

/**
 * 组合入参：先手动闭合进行中的 `closeId`（A），再重开同通道已闭合的 `reopenId`（B）。
 * 两个 id 不得相同，且必须落在同一通道。
 */
export interface CloseAndReopenInput {
  readonly closeId: string;
  readonly reopenId: string;
}

/** 组合结果：被她手动闭合的 A 与被重开的 B 的新版本当前态。 */
export interface CloseAndReopenResult {
  readonly closed: EventRecord;
  readonly reopened: EventRecord;
}

/** 重写摘要入参：她手写摘要。 */
export interface RewriteSummaryInput {
  /** 事件 id。 */
  readonly eventId: string;
  /** 她写的摘要（长度与非空由契约层拒收，不截断）。 */
  readonly summary: string;
}

// ── 重跑窄接口 ────────────────────────────────────────────────────────────

/**
 * 派生字段重跑 —— 由闭合管线实现（§6.5 requestRerun 同签名，可直接传管线实例）。
 *
 * 实现方须遵守：**summary_source='her' 的事件只更新锚点/话题线，不覆盖她的摘要**。
 */
export interface CorrectionRerunner {
  /** 请求后台重跑该事件的派生字段。 */
  requestRerun(eventId: string): void;
}

/** 修正器依赖（显式注入，便于测试）。 */
export interface CorrectionDeps {
  /** 事件真源（版本推进的唯一写入口）。 */
  readonly log: EventLog;
  /** 读一条记录（重算时间范围用；取不到即抛错，不静默降级）。 */
  readonly readExperience: (id: string) => Experience | undefined;
  /**
   * 记录当前归哪个事件（设计稿 v1.1 §7.1.1 唯一归属的判定口）。
   *
   * 由真源层提供（`EventLog.ownerOf`）—— **不允许**在本文件里 `log.readAll()` 扫一遍：
   * 那样每个调用点各扫一次，既是 O(n) 重复劳动，也必有人漏扫。
   */
  readonly ownerOf: (experienceId: string) => string | undefined;
  /** 派生字段重跑；缺省 = 不重跑（事件保持 pending，由启动清道夫兜底）。 */
  readonly rerunner?: CorrectionRerunner | undefined;
  /** 可注入时钟（测试用）。缺省 Date.now。 */
  readonly now?: () => number;
}

// ── 上层接力（T12） ───────────────────────────────────────────────────────

/** 记忆条目对事件的指代（纯链式：只指事件；带记录级引用时多给记录 id）。 */
export interface MemoryPointer {
  /** 记忆指向的事件 id。 */
  readonly eventId: string;
  /** 记忆带的记录级引用（记录本条目 id）；缺省 = 纯链式指代。 */
  readonly recordIds?: readonly string[] | undefined;
}

/** 解析口径（机器可判）。 */
export type ResolutionKind =
  /** 直接命中当前事件（未被修正）。 */
  | 'direct'
  /** 顺 merged_into 追到唯一终点（合并是多对一）。 */
  | 'merged'
  /** 已拆分、无法判断落点 → 两个候选，待她定。 */
  | 'split-pending'
  /** 已拆分、记录级引用落在唯一子事件 → 落点已定。 */
  | 'split-resolved'
  /** 已拆分、记录级引用横跨多个子事件 → 两个都呈现。 */
  | 'split-both';

/** 记忆 → 事件的解析结果（只读，不改写她的指针）。 */
export interface MemoryResolution {
  /** 解析口径。 */
  readonly kind: ResolutionKind;
  /** 唯一落点；待她定 / 横跨两者时为空（不替她猜）。 */
  readonly target: EventRecord | undefined;
  /** 候选（拆分场景下非空）。 */
  readonly candidates: readonly EventRecord[];
  /** 是否仍待她定（默认拆分情形为 true；「横跨两者」是已定的结论，不算待定）。 */
  readonly pendingDecision: boolean;
  /** 如实呈现给她的标注；无则为空。 */
  readonly note: string | undefined;
}

/** 标注文案（如实呈现，不加评价）。 */
const NOTE_MERGED = '这条记忆来自一件后来被合并的事';
const NOTE_SPLIT = '已拆分';
const NOTE_SPLIT_BOTH = '来自一件后来被拆分的事';

/**
 * 解析记忆指向的事件 —— **只读不写**（§7.3 上层接力）。
 *
 * 合并：顺 merged_into 追到唯一终点（多对一，唯一目标）。
 * 拆分：一对多 —— 记忆不带记录级引用时无法判断落点 → 呈现两个候选、待她定；
 * 带记录级引用时按引用落在哪个子事件解析，横跨两者则两个都呈现。
 */
export function resolveMemoryPointer(log: EventLog, pointer: MemoryPointer): MemoryResolution {
  const current = log.currentOf(pointer.eventId);

  // 合并是多对一、唯一目标 → 顺退役指针追到终点（可能连追多跳）。
  const visited = new Set<string>([current.id]);
  let target = current;
  while (target.status === 'merged') {
    const next = target.merged_into;
    if (next === undefined) {
      throw new CorruptedError(`merged 事件缺退役指针：${target.id}`);
    }
    if (visited.has(next)) {
      throw new CorruptedError(`merged_into 追成了环：${target.id}`);
    }
    visited.add(next);
    target = log.currentOf(next);
  }

  if (target.status === 'split') {
    const childIds = target.split_into;
    if (childIds === undefined || childIds.length < 2) {
      throw new CorruptedError(`split 事件缺退役指针：${target.id}`);
    }
    const children = childIds.map((id) => log.currentOf(id));
    const refs = pointer.recordIds ?? [];

    if (refs.length === 0) {
      // 默认情形：记忆无记录级引用 → 无法判断落点，呈现两个候选，待她定。
      return {
        kind: 'split-pending',
        target: undefined,
        candidates: children,
        pendingDecision: true,
        note: NOTE_SPLIT,
      };
    }

    const hit = children.filter((child) =>
      refs.some((ref) => child.pointers.some((p) => p.id === ref)),
    );
    const first = hit[0];
    if (hit.length === 1 && first !== undefined) {
      return {
        kind: 'split-resolved',
        target: first,
        candidates: [],
        pendingDecision: false,
        note: NOTE_SPLIT,
      };
    }
    if (hit.length >= 2) {
      return {
        kind: 'split-both',
        target: undefined,
        candidates: hit,
        pendingDecision: false,
        note: NOTE_SPLIT_BOTH,
      };
    }
    // 引用落在任何子事件之外 → 同样判不出落点 → 待她定。
    return {
      kind: 'split-pending',
      target: undefined,
      candidates: children,
      pendingDecision: true,
      note: NOTE_SPLIT,
    };
  }

  const viaMerged = visited.size > 1;
  return {
    kind: viaMerged ? 'merged' : 'direct',
    target,
    candidates: [],
    pendingDecision: false,
    note: viaMerged ? NOTE_MERGED : undefined,
  };
}

// ── 修正器 ────────────────────────────────────────────────────────────────

/**
 * 事件修正器 —— 五种修正 + 版本化 + 退役指针。
 *
 * 全部方法同步：调用方（门面）在**同一个写队列任务内**调用即可保证原子性
 * （队列内不得再排队 —— §4.2）。
 */
export class EventCorrector {
  private readonly log: EventLog;
  private readonly readExperience: (id: string) => Experience | undefined;
  private readonly ownerOf: (experienceId: string) => string | undefined;
  private readonly rerunner: CorrectionRerunner | undefined;
  private readonly now: () => number;

  constructor(deps: CorrectionDeps) {
    this.log = deps.log;
    this.readExperience = deps.readExperience;
    this.ownerOf = deps.ownerOf;
    this.rerunner = deps.rerunner;
    this.now = deps.now ?? Date.now;
  }

  /**
   * 合并：A + B → 新事件 C。
   *
   * C 的 pointers 取并集、时间范围取并集区间；A、B 各写一个新版本退役
   * （status='merged'、merged_into=C）。旧事件不删。
   */
  merge(input: MergeInput): MergeResult {
    const ids = [...input.sourceIds];
    if (ids.length < 2) {
      throw new SchemaError('合并至少需要两个来源事件');
    }
    if (new Set(ids).size !== ids.length) {
      throw new SchemaError('合并的来源事件 id 不得重复');
    }

    const sources = ids.map((id) => this.correctableEvent(id));
    const nowIso = msToIso(this.now());

    // 先写 C 再退役 A、B：退役指针必须指向**已存在**的事件，否则解析会读到悬空指针。
    const target = this.appendNewEvent({
      id: input.targetId ?? defaultUlid.next(),
      status: 'closed',
      // C 不经 A 类机械信号闭合 → 没有机械闭合原因。
      closedReason: null,
      pointers: dedupePointers(sources.flatMap((source) => source.pointers)),
      timeRange: unionRange(sources.map((source) => source.time_range)),
      assembledAt: nowIso,
      channel: mainChannel(sources),
      // 候选标记随其记录一起并入（标记的是位置，位置没变）。
      candidates: sources.flatMap((source) => source.boundary_candidates),
    });

    const retired = sources.map((source) =>
      this.retire(source, { status: 'merged', mergedInto: target.id }),
    );

    this.requestRerun(target.id);
    return { target, retired };
  }

  /**
   * 拆分：A → B1 + B2。
   *
   * A 写一个新版本退役（status='split'、split_into=[B1,B2]）；B1/B2 是新事件，
   * 各自按给定分组取指针并重算时间范围。
   */
  split(input: SplitInput): SplitResult {
    const source = this.correctableEvent(input.sourceId);
    const groups = input.groups;
    if (groups.length < 2) {
      throw new SchemaError('拆分至少需要两组');
    }

    const sourceIds = source.pointers.map((p) => p.id);
    const grouped = new Set<string>();
    for (const group of groups) {
      if (group.length === 0) {
        throw new SchemaError('拆分的每一组至少要有一条记录');
      }
      for (const id of group) {
        if (grouped.has(id)) {
          throw new SchemaError(`拆分的分组重复包含记录：${id}`);
        }
        grouped.add(id);
      }
    }
    for (const id of grouped) {
      if (!sourceIds.includes(id)) {
        throw new SchemaError(`拆分的分组含源事件之外的记录：${id}`);
      }
    }
    for (const id of sourceIds) {
      if (!grouped.has(id)) {
        throw new SchemaError(`拆分的分组未覆盖源事件的记录：${id}`);
      }
    }

    const nowIso = msToIso(this.now());
    const byId = new Map(source.pointers.map((p) => [p.id, p]));

    // 先建子事件再退役源事件：退役指针必须指向已存在的事件。
    const children = groups.map((group) => {
      const pointers = group.map((id) => {
        const found = byId.get(id);
        if (found === undefined) {
          throw new SchemaError(`拆分的分组含源事件之外的记录：${id}`);
        }
        return found;
      });
      return this.appendNewEvent({
        id: defaultUlid.next(),
        status: 'closed',
        closedReason: null,
        pointers,
        timeRange: this.rangeOf(pointers),
        assembledAt: nowIso,
        channel: source.channel,
        // 候选标记按记录归属分给子事件（标记的是位置）。
        candidates: source.boundary_candidates.filter((item) => group.includes(item.at_pointer_id)),
      });
    });

    const retired = this.retire(source, { status: 'split', splitInto: children.map((c) => c.id) });

    for (const child of children) {
      this.requestRerun(child.id);
    }
    return { retired, children };
  }

  /**
   * 改边界：换 pointers（移出/移入），时间范围重算。
   *
   * **记录唯一归属**（设计稿 v1.1 §7.1.1）：一条记录同时只能属于一个事件。
   *  - 移入前必查归属：已被**别的**当前态事件引用 → 拒绝，并指出归属事件；
   *    **不做自动换主** —— 换主等于替她决定「这条归谁」，而她没授权这个决定；
   *  - 移出后该记录回归孤儿候选池，**不自动补切**（补切是切分算法的活，
   *    在这里顺手补会绕过机械/语义信号的判定）。
   *
   * 派生字段必须重跑：换了指针就不许留旧摘要（§7.2 规则 1）；她手写的摘要保留（规则 2）。
   */
  reviseBoundary(input: ReviseBoundaryInput): ReviseBoundaryResult {
    const current = this.correctableEvent(input.eventId);
    const removed = new Set(input.removePointerIds ?? []);
    const added = input.addPointerIds ?? [];

    const kept = current.pointers.filter((p) => !removed.has(p.id));
    // 已在事件里的记录不再重复移入；同一条既移出又移入时**移出优先**。
    const moved = added.filter((id) => !current.pointers.some((p) => p.id === id));

    for (const id of moved) {
      const owner = this.ownerOf(id);
      if (owner !== undefined && owner !== current.id) {
        throw new ConflictError(
          `记录 ${id} 当前属于事件 ${owner}，请先在那里移出（不做自动换主）`,
        );
      }
    }

    const pointers = [...kept, ...moved.map((id) => this.pointerOf(id))];

    // 派生字段必须重跑（§7.2 规则 1）：换了指针就不许留旧摘要。
    // 她手写的摘要保留（规则 2）：只把 quality 置 pending，由闭合管线重跑锚点/话题线；
    // 「摘要待更新（基于旧边界）」是读时派生标注（source='her' 且 quality='pending'）。
    const hers = current.summary_source === 'her';

    const next: EventRecord = {
      ...current,
      version: current.version + 1,
      pointers,
      time_range: this.rangeOf(pointers),
      summary: hers ? current.summary : null,
      summary_quality: 'pending',
      summary_source: hers ? 'her' : null,
      // 溯源两字段描述的是**刚才那份**摘要 —— 它已作废（或换成她那份），必须清空；
      // 留着会让后来人以为「这条 pending 摘要是 v1 提示词产物」。
      summary_prompt_version: null,
      summary_model: null,
      // 关键点也是按旧边界生成的 → 一并作废（她保留的是摘要，不是模型的关键点）。
      key_points: [],
      created_by: 'her',
      created_at: msToIso(this.now()),
    };
    this.log.appendVersion(next);

    this.requestRerun(current.id);
    return { event: this.log.currentOf(current.id) };
  }

  /**
   * 重开：closed → open，写新版本；不重跑（摘要仍覆盖原指针）。
   *
   * 前置闸（#36）：同通道若已有另一个进行中的 open 事件，抛 EventOpenConflictError
   * 且不写任何版本 —— 系统不替她闭合那个事件，由她显式选择下一步（见 closeAndReopen）。
   */
  reopen(input: ReopenInput): EventRecord {
    const current = this.log.currentOf(input.eventId);
    if (current.status !== 'closed') {
      throw new ConflictError(`只有 closed 事件可以重开：${input.eventId}（当前 ${current.status}）`);
    }
    this.assertNoOpenBlocker(current);

    const next: EventRecord = {
      ...current,
      version: current.version + 1,
      status: 'open',
      // 重开 = 未被机械信号闭合（契约层 closed_reason 语义）。
      closed_reason: null,
      created_by: 'her',
      created_at: msToIso(this.now()),
    };
    this.log.appendVersion(next);
    return this.log.currentOf(current.id);
  }

  /**
   * 手动闭合一个 open 事件（**内部能力**，本期不开放独立门面原语）。
   *
   * 与切分器机械闭合的区别：closed_reason='manual'、created_by='her'，记录这是她显式
   * 结束一件事，而非 silence/channel-switch 等机械信号。闭合后请求派生字段重跑兜底摘要。
   *
   * 留痕（#36 评审）：未来若要开门面「仅手动闭合」原语，须走独立评审 —— 它会让
   * 「闭合 → 重开」的通道冲突循环重新出现，需要先想清楚独立 UX 与冲突处理，不能顺手暴露。
   */
  closeOpen(eventId: string): EventRecord {
    const current = this.log.currentOf(eventId);
    if (current.status !== 'open') {
      throw new ConflictError(`只有 open 事件可以手动闭合：${eventId}（当前 ${current.status}）`);
    }
    const next: EventRecord = {
      ...current,
      version: current.version + 1,
      status: 'closed',
      // manual = 人显式操作闭合（非机械信号）；是谁操作看 created_by。
      closed_reason: 'manual',
      created_by: 'her',
      created_at: msToIso(this.now()),
    };
    const saved = this.log.appendVersion(next).record;
    this.requestRerun(saved.id);
    return saved;
  }

  /**
   * 她显式授权的一键组合：先手动闭合 A，再重开 B。
   *
   * 原子性：**先全部校验、再顺序写入**，任一前提不满足即抛错且不写任何版本，杜绝
   * 「A 已闭合、B 却重开失败」的半程态。门面所有写原语经同一个串行 WriterQueue，
   * 两个并发组合任务不会交错（单写者；跨进程锁归 E 块，本期 local-first 单实例）。
   */
  closeAndReopen(input: CloseAndReopenInput): CloseAndReopenResult {
    if (input.closeId === input.reopenId) {
      throw new SchemaError(`closeId 与 reopenId 不能是同一事件：${input.closeId}`);
    }
    const closeTarget = this.log.currentOf(input.closeId);
    const reopenTarget = this.log.currentOf(input.reopenId);
    if (closeTarget.status !== 'open') {
      throw new ConflictError(`待闭合事件必须是 open：${input.closeId}（当前 ${closeTarget.status}）`);
    }
    if (reopenTarget.status !== 'closed') {
      throw new ConflictError(`待重开事件必须是 closed：${input.reopenId}（当前 ${reopenTarget.status}）`);
    }
    if (closeTarget.channel !== reopenTarget.channel) {
      throw new ConflictError(
        `闭合与重开事件必须同通道：${input.closeId}@${closeTarget.channel} 与 ${input.reopenId}@${reopenTarget.channel}`,
      );
    }

    // 校验通过后才写入：先闭合 A（通道随即没有进行中的 open），再重开 B，其前置闸放行。
    const closed = this.closeOpen(input.closeId);
    const reopened = this.reopen({ eventId: input.reopenId });
    return { closed, reopened };
  }

  /** 重开前置闸：同通道若另有 open 事件，交付带选项的结构化冲突；target 自身当前是 closed。 */
  private assertNoOpenBlocker(target: EventRecord): void {
    const blocker = this.otherOpenOnChannel(target.channel, target.id);
    if (blocker) {
      throw new EventOpenConflictError(target.id, this.blockingView(blocker));
    }
  }

  /** 找同通道另一个仍 open 的事件；无则 null。真出现多个说明「每通道唯一 open」不变量已被破坏。 */
  private otherOpenOnChannel(channel: string, selfId: string): EventRecord | null {
    const opens = this.log.listByStatus('open').filter((e) => e.channel === channel && e.id !== selfId);
    if (opens.length > 1) {
      throw new CorruptedError(`通道 ${channel} 同时存在 ${opens.length} 个 open 事件，无法唯一判定重开阻塞方`);
    }
    return opens[0] ?? null;
  }

  /** 从事件当前态投影出 UI 渲染冲突提示所需的客观事实（内核不拼文案）。 */
  private blockingView(e: EventRecord): EventOpenConflictBlocking {
    return {
      eventId: e.id,
      channel: e.channel,
      startedAt: e.time_range.started_at,
      endedAt: e.time_range.ended_at,
      pointerCount: e.pointers.length,
      summary: e.summary,
      summaryReady: e.summary_quality === 'ready',
    };
  }

  /** 重写摘要：她手写摘要 → 新版本、summary_source='her'；旧摘要留版本，不重跑。 */
  rewriteSummary(input: RewriteSummaryInput): EventRecord {
    const current = this.correctableEvent(input.eventId);

    const next: EventRecord = {
      ...current,
      version: current.version + 1,
      summary: input.summary,
      summary_quality: 'ready',
      summary_source: 'her',
      // 她写的摘要不是任何提示词/模型的产物 → 溯源两字段必须清空，
      // 否则“v1 提示词生成的”这个描述会盖到她手写的文字上（说谎）。
      summary_prompt_version: null,
      summary_model: null,
      created_by: 'her',
      created_at: msToIso(this.now()),
    };
    this.log.appendVersion(next);
    return this.log.currentOf(current.id);
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /** 取当前态；退役态 / 归档态不可再修正（退役事件是历史，不是可编辑对象）。 */
  private correctableEvent(id: string): EventRecord {
    const current = this.log.currentOf(id);
    if (current.status === 'merged' || current.status === 'split' || current.status === 'archived') {
      throw new ConflictError(`事件已退役，不可再修正：${id}（${current.status}）`);
    }
    return current;
  }

  /**
   * 退役：写一个新版本，带退役指针；旧版本原样留在历史里。
   *
   * 退役的是**历史**（不可再修正）；若切分器仍持有该事件的 open 状态，
   * 追加前需自行跳过 —— 那是切分器一侧的跨卡事项（§8-18 的退役指针只此一处产生）。
   */
  private retire(
    current: EventRecord,
    change: { status: 'merged'; mergedInto: string } | { status: 'split'; splitInto: string[] },
  ): EventRecord {
    const next: EventRecord = {
      ...current,
      version: current.version + 1,
      status: change.status,
      merged_into: change.status === 'merged' ? change.mergedInto : undefined,
      split_into: change.status === 'split' ? change.splitInto : undefined,
      created_by: 'her',
      created_at: msToIso(this.now()),
    };
    return this.log.appendVersion(next).record;
  }

  /**
   * 写一个新事件（version=1）。
   *
   * 两个「第一期恒空」的必填数组字段**不在本文件写死字段名**（契约层独占）：
   * 按契约层导出的字段表把没给出的字段补成空数组，再交给契约层逐字段校验。
   */
  private appendNewEvent(input: {
    id: string;
    status: 'closed';
    closedReason: null;
    pointers: readonly EventPointer[];
    timeRange: EventTimeRange;
    assembledAt: string;
    channel: string;
    candidates: EventRecord['boundary_candidates'];
  }): EventRecord {
    const raw: Record<string, unknown> = {
      id: input.id,
      schema_version: EVENT_SCHEMA_VERSION,
      version: 1,
      status: input.status,
      closed_reason: input.closedReason,
      pointers: input.pointers,
      time_range: input.timeRange,
      assembled_at: input.assembledAt,
      summary: null,
      key_points: [],
      summary_quality: 'pending',
      summary_source: null,
      // 溯源字段：新事件还没有摘要 → null（**不能**靠下面的补位循环，
      // 那一圈会把没给出的字段补成 []，而这两个字段是 string | null）。
      summary_prompt_version: null,
      summary_model: null,
      created_by: 'her',
      created_at: input.assembledAt,
      channel: input.channel,
      boundary_candidates: input.candidates,
      // 退役指针：本次不写（置 undefined = 该字段不存在）。
      merged_into: undefined,
      split_into: undefined,
      // v1.4 双计数器：新建事件尚无统计 → null（同 segmenter，必须显式写 null，
      // 补位循环只服务数组类字段）。
      effective_chars: null,
      raw_chars: null,
    };

    // 只为**数组类**字段兜底：可空字符串字段（summary / summary_source /
    // summary_prompt_version / summary_model / closed_reason）必须在上面显式写 null ——
    // 补成 [] 会被契约层当场拒收（这正是「补位循环」最容易埋的坑）。
    for (const field of EVENT_FIELDS) {
      if (!(field in raw)) {
        raw[field] = [];
      }
    }

    return this.log.appendVersion(parseEvent(raw, 'write')).record;
  }

  /**
   * 时间范围重算 —— 以记录的真实时刻为准；取不到即抛错（不静默降级、不编造）。
   */
  private rangeOf(pointers: readonly EventPointer[]): EventTimeRange {
    const first = pointers[0];
    if (first === undefined) {
      throw new SchemaError('事件至少要有一条记录');
    }

    let started = this.occurredAtOf(first);
    let ended = started;
    for (const pointer of pointers.slice(1)) {
      const at = this.occurredAtOf(pointer);
      if (isoToMs(at) < isoToMs(started)) {
        started = at;
      }
      if (isoToMs(at) > isoToMs(ended)) {
        ended = at;
      }
    }
    return { started_at: started, ended_at: ended };
  }

  /** 取记录的世界轴时刻。 */
  private occurredAtOf(pointer: EventPointer): string {
    const experience = this.readExperience(pointer.id);
    if (experience === undefined) {
      throw new NotFoundError(`记录取不到，无法重算时间范围：${pointer.id}`);
    }
    return experience.occurred_at;
  }

  /** 移入的记录 → 指针（id 权威，channel 冗余）。 */
  private pointerOf(experienceId: string): EventPointer {
    const experience = this.readExperience(experienceId);
    if (experience === undefined) {
      throw new NotFoundError(`记录取不到：${experienceId}`);
    }
    return { id: experience.id, channel: experience.scene.channel };
  }

  /** 触发派生字段重跑（没有注入重跑器时，事件保持 pending，由启动清道夫兜底）。 */
  private requestRerun(eventId: string): void {
    this.rerunner?.requestRerun(eventId);
  }
}

/** 指针去重（按 id 权威位；合并两个事件时两边不应共享记录，仍做防御）。 */
function dedupePointers(pointers: readonly EventPointer[]): EventPointer[] {
  const seen = new Set<string>();
  const out: EventPointer[] = [];
  for (const pointer of pointers) {
    if (seen.has(pointer.id)) {
      continue;
    }
    seen.add(pointer.id);
    out.push(pointer);
  }
  return out;
}

/** 时间区间并集 —— 合并后事件的时间范围。 */
function unionRange(ranges: readonly EventTimeRange[]): EventTimeRange {
  const first = ranges[0];
  if (first === undefined) {
    throw new SchemaError('时间区间为空');
  }
  let started = first;
  let ended = first;
  for (const range of ranges.slice(1)) {
    if (isoToMs(range.started_at) < isoToMs(started.started_at)) {
      started = range;
    }
    if (isoToMs(range.ended_at) > isoToMs(ended.ended_at)) {
      ended = range;
    }
  }
  return { started_at: started.started_at, ended_at: ended.ended_at };
}

/** 合并后事件的主通道 —— 取开始最早的那个来源事件的通道（跨通道合并时它代表起点）。 */
function mainChannel(sources: readonly EventRecord[]): string {
  const first = sources[0];
  if (first === undefined) {
    throw new SchemaError('来源事件为空');
  }
  let main = first;
  for (const source of sources.slice(1)) {
    if (isoToMs(source.time_range.started_at) < isoToMs(main.time_range.started_at)) {
      main = source;
    }
  }
  return main.channel;
}
