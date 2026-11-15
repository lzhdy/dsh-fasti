/**
 * 闭合管线 —— 机械闭合后的异步摘要（技术基线 §6.3–§6.5）。
 *
 * 冻结流程：
 *   闭合（切分器写出 closed 版本，summary=null、summary_quality='pending'、summary_source=null）
 *     → closure.enqueue(eventId)
 *     → worker 取到任务 → 读原文 → 建 L3 冻结序号表 → port.summarize(request)
 *     → 序号解析回 id → 硬约束校验（≤上限字数、非空）
 *     → 通过：写新版本（version = current+1；summary / key_points / anchors /
 *              summary_quality='ready' / summary_source='llm'）→ backlog.complete
 *     → 失败：backlog.retry（退避），事件保持 pending（不改写既有版本）
 *
 * 四条纪律：
 *  1. **校验只有两条**：字数上限 + 非空。绝不写三要素规则检查器 ——
 *     「谁 / 做了什么 / 结果如何」只进 prompt 指引，由 LLM 在同一次调用里自检。
 *  2. **不伪造**：失败就是失败（退避重试），不写占位文案、不截断超长结果。
 *  3. **不进摄入热路径**：enqueue 只碰内存队列，不 await、不写盘。
 *  4. **长度口径唯一**：字数按**码点**算，统一走契约层的 `summaryLengthOf`
 *     （与落盘校验同一实现 —— 两处各算一遍必然漂移，且 emoji 会造成假故障）。
 *
 * L3 序号协议（定稿 `docs/task90-l3-final-spec.md`）：线上只走 1..N 序号，内核在
 * appendVersion 前用本 tick 冻结表解析回 id；落盘仍是 id 字符串。建表 / prompt 行 /
 * 两处解析共用同一有序数组；协议错误（仅序号类）同 tick 重取一次，其余错误直接 failTask。
 *
 * 后台三条硬纪律（设计稿 v1.1 §6.3.1）：
 *  ① **每次模型调用必须有硬超时**（默认 60s，超时按一次失败处理）——
 *     没有它就是「一次不返回，整条队列永久停摆且静默」；
 *  ② 单轮处理必须有上限（条数 + 总时长，到限返回、照常排下一轮）；
 *  ③ **结果过期必须丢弃**（写回前比对发起时的边界快照，不一致即丢弃、保持 pending、重新入队）。
 */

import { withDeadline } from '../core/deadline.ts';
import { CorruptedError, NotFoundError, SchemaError, UnavailableError } from '../core/errors.ts';
import { isUlid } from '../core/ulid.ts';
import { isoToMs, msToIso, nowIso } from '../core/time.ts';
import {
  AnchorReferenceInvalidError,
  assertAnchorRefs,
  type ExperienceReader,
} from './anchor-refs.ts';
import { SUMMARY_MAX_CHARS, summaryLengthOf } from '../contract/event.ts';
import type { EventRecord } from '../contract/event.ts';
import type { BoundaryCandidate } from '../contract/event.ts';
import type { EventLog } from '../source/event-log.ts';
import { RETRY_MAX_ATTEMPTS } from './backlog.ts';
import type { Backlog, BacklogTask } from './backlog.ts';
import {
  AnchorSerialWireError,
  type LLMPort,
  type LLMSummarizeRequest,
  type LLMSummarizeResponse,
} from './llm-port.ts';
import {
  buildSerialTable,
  EventSerialReferenceError,
  isEventSerialRefusable,
  MAX_SERIAL_POOL_MEMBERS,
  resolveAnchorSerials,
  resolveCandidateSerials,
  renderFeedback,
  type SerialMember,
  type SerialTable,
  type SerialViolation,
} from './serial-table.ts';
import {
  SUMMARY_PROMPT_VERSION,
  closureCallTimeoutMsOf,
  resolveEventParams,
  summaryLimitOf,
} from './params.ts';
import type { EventParams } from './params.ts';

/** 失败明细条数上限（环形缓冲，与摄入 stage 失败同口径）。 */
const FAILURE_BUFFER_LIMIT = 100;

/** 观测条数上限（环形缓冲；与失败缓冲同款常量，零 IO、零 fs 写）。 */
const OBSERVATION_BUFFER_LIMIT = FAILURE_BUFFER_LIMIT;

/**
 * 单次摘要调用可带回的话题跳转候选条数上限（v1.4 · C7）。
 *
 * 定案稿 §6.4 钉死「最多 5 条」—— 多给也不写（候选是**非权威**的提示，
 * 不是决策输入；给太多既没用又稀释信号）。
 */
const MAX_BOUNDARY_CANDIDATES = 5;

/**
 * 失败后的处置 —— 三态区分（机器可判，别靠文案猜）。
 *
 *  - `retry`     临时失败（调用失败 / 原文取不到 / 本次结果不合规）→ 退避后重试；
 *  - `exhausted` 连续失败达上限 → 停止自动重试（事件保持 pending，等下次清道夫）；
 *  - `permanent` 永久缺失（模型未配置）→ 不入队、不重试，事件保持 pending。
 */
export type ClosureFailureState = 'retry' | 'exhausted' | 'permanent';

/** L3 冻结观测 reason 词表（定稿 §7.2，逐字对齐红测）。 */
export type ClosureObservationReason =
  | 'l3-empty-selection-with-nonempty-pool'
  | 'l3-serial-retry'
  | 'l3-serial-exhausted'
  | 'l3-candidate-dropped'
  | 'l3-pool-sampled';

/** 一条 L3 观测条目（内核内部类型，不进端口契约、不落盘）。 */
export interface ClosureObservation {
  readonly reason: ClosureObservationReason;
  readonly eventId?: string;
  readonly round?: 'first' | 'retry';
  readonly n?: number;
  readonly chars?: number;
  readonly dropped?: number;
  readonly kinds?: readonly string[];
  readonly detail?: Record<string, unknown>;
}

/** 一次摘要失败的明细（可观测性的载体）。 */
export interface ClosureFailure {
  /** 事件 id。 */
  readonly eventId: string;
  /** 累计尝试次数（permanent = 0 —— 从没试过）。 */
  readonly attempts: number;
  /** 失败原因（错误 message，非 Error 对象也转成字符串，不丢信息）。 */
  readonly error: string;
  /** 失败时刻（ISO）。 */
  readonly at: string;
  /** 失败后的处置。 */
  readonly state: ClosureFailureState;
  /**
   * 是否已耗尽自动重试 —— `state === 'exhausted'` 的**派生便捷位**。
   *
   * 只由 `pushFailure` 单点赋值（从 state 推导），不手填：
   * 两处各写一遍必然漂移，「已耗尽却还标着可重试」会让可观测性说谎。
   */
  readonly exhausted: boolean;
  /** L2 引用闸 / L3 序号 / 存储损坏的结构化明细（零经历正文；普通失败缺省不带）。 */
  readonly detail?: Record<string, unknown>;
}

/**
 * 锚点形态非法（#42 §2.1 前置甲 / §4.1 L1 形态闸）。
 *
 * 事件版本追加**之前**的单记录断言：每个锚点必须是 26 位 Crockford Base32 ULID；
 * 形态不符 fail-closed 抛错，绝不落盘。空数组（合法 abstain）放行 —— 本闸只管形态，
 * 不管建卡决策。基类复用既有 SchemaError（code='SCHEMA'），不新造错误层级。
 */
export class AnchorFormInvalidError extends SchemaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** 闭合管线依赖（显式注入，便于测试）。 */
export interface ClosureDeps {
  /** 事件真源（append-only，版本推进的唯一写入口）。 */
  readonly log: EventLog;
  /** 端口；null = 本环境没有模型（此时一切保持 pending，不伪造）。 */
  readonly port: LLMPort | null;
  /** 后台队列（进程内）。 */
  readonly backlog: Backlog;
  /** 可调参数（只给出要覆盖的项；缺省全取默认值）。 */
  readonly params?: Partial<EventParams> | undefined;
  /** 取事件的原文文本（内核提供；返回空数组表示取不到）。 */
  readonly readTexts: (event: EventRecord) => string[];
  /**
   * 经历点查窄接口（Q4：同步、单方法、只回 id/channel/occurredAtMs，不含正文）。
   * 与 readTexts 同一个 experienceLog 注入；写入闸必填，不允许 fail-open 跳过。
   */
  readonly readExperience: ExperienceReader;
  /**
   * 失败上报（宿主日志那一路）。
   *
   * 内核不持有 logger（零依赖），故由宿主注入；未注入时失败仍留在 failures() 明细里，
   * 绝不静默丢弃。
   */
  readonly onFailure?: (failure: ClosureFailure) => void;
  /**
   * L3 观测上报（与失败通道分离；定稿 §7.2）。可选：未注入时观测只留在内核环形缓冲，
   * 不报错、不静默丢失败。观测零 IO、不落盘、不写投影。
   */
  readonly onClosureObservation?: (observation: ClosureObservation) => void;
}

/** 解析后落盘前的中间结果：id 锚点 + id 候选（线协议序号已解析完毕）。 */
interface ResolvedSummary {
  readonly anchors: readonly string[];
  readonly candidates: readonly BoundaryCandidate[];
}

/**
 * 闭合管线 —— 闭合后异步产出摘要。
 *
 * 全程异步：**LLM 慢或挂掉都不会拖住摄入**（摄入路径只调 enqueue，
 * 它是纯内存操作，不 await）。
 */
export class ClosurePipeline {
  private readonly deps: ClosureDeps;
  private readonly limit: number;
  /** 单次模型调用的硬超时（毫秒）—— §6.3.1 纪律①。 */
  private readonly callTimeoutMs: number;
  private readonly failureLog: ClosureFailure[] = [];
  private readonly observationLog: ClosureObservation[] = [];
  /** 已按「模型未配置」如实记录过的事件 id —— 同一事件不重复上报。 */
  private readonly missingModel = new Set<string>();

  constructor(deps: ClosureDeps) {
    this.deps = deps;
    // 契约层是硬上限（parseEvent 写模式按它拒收），参数只能往下调 —— 取两者的较小值，
    // 免得参数调大后管线放行、契约层再抛错。
    const params = resolveEventParams(deps.params);
    this.limit = Math.min(summaryLimitOf(params), SUMMARY_MAX_CHARS);
    this.callTimeoutMs = closureCallTimeoutMsOf(params);
  }

  /**
   * 事件闭合后入队（幂等）。
   *
   * 模型未配置 → **不入队**（再试也是白试），但如实记一条 permanent 失败：
   * 事件保持 pending ＝「摘要未生成」的如实表达，配置就绪后由清道夫补齐。
   */
  enqueue(eventId: string): void {
    if (this.deps.port === null) {
      this.reportMissingModel(eventId);
      return;
    }
    this.deps.backlog.enqueue(eventId);
  }

  /**
   * 处理一个到期任务：调端口 → 校验硬约束 → 写新版本（summary_quality='ready'）。
   *
   * 失败：退避重试，事件保持 pending（**不改写既有版本**）。
   *
   * @returns true = 本轮取到并处理了一个任务（成功或已安排重试）；false = 没有到期任务。
   */
  async processOne(nowMs: number): Promise<boolean> {
    const port = this.deps.port;
    if (port === null) {
      return false;
    }
    const task = this.deps.backlog.dequeue(nowMs);
    if (task === undefined) {
      return false;
    }

    let current: EventRecord;
    try {
      current = this.deps.log.currentOf(task.eventId);
    } catch (error) {
      this.failTask(task, error, nowMs);
      return true;
    }

    // 还没闭合的事件不摘（内容还会变）—— 闭合后由闭合入队 / 清道夫再摘。
    if (current.status !== 'closed') {
      this.deps.backlog.complete(task.eventId);
      return true;
    }
    // 模型写的摘要已在 → 不重复生成（重放幂等）。她写的摘要要重跑（只刷锚点）。
    if (current.summary_quality === 'ready' && current.summary_source !== 'her') {
      this.deps.backlog.complete(task.eventId);
      return true;
    }

    // M=64 上限（定稿 §9）：N 直接取 current.pointers 长度，无需读文本；判定先于
    // readTexts 与建表 / LLM。超限不构造 prompt、零 LLM 调用，进失败缓冲而非观测回调
    // （确定性任务失败）；事件保 pending，由 correction 拆分后自然通过。
    if (current.pointers.length > MAX_SERIAL_POOL_MEMBERS) {
      this.failTask(
        task,
        this.overflowFailure(current),
        nowMs,
        {
          reason: 'l3-candidate-overflow',
          n: current.pointers.length,
          m: MAX_SERIAL_POOL_MEMBERS,
          eventId: current.id,
        },
      );
      return true;
    }

    const texts = this.deps.readTexts(current);
    if (texts.length === 0) {
      // 原文一条都取不到 → 不调模型（绝不编造原文），按失败退避重试。
      // N=0 不进 L3 选择协议：沿用既有 failTask 路径，零 LLM、零 L3 观测（定稿 §7.1）。
      this.failTask(task, new UnavailableError('事件原文取不到（指针悬空）'), nowMs);
      return true;
    }

    // 经历存储可用性与成员窄面在 `buildTable` 的逐成员点查里一并完成：读取侧损坏
    // （CorruptedError 等）原样上抛，不在调 LLM 之后才暴露；探针不做存在性 / 通道 /
    // 窗口拒收（那些由 writeSummary 内 L2 闸判）。点查只在本 tick 建表时做一次。

    // 本 tick 冻结表：逐成员点查一次；任一成员 reader 返 undefined → 整表 fail-closed，
    // 零 LLM。prompt 行 / 反馈范围 / 两处解析全引用这同一实例（定稿 §3.2 同源单实例）。
    let table: SerialTable;
    try {
      table = this.buildTable(current);
    } catch (error) {
      this.failTask(task, error, nowMs);
      return true;
    }

    const chars = texts.join('').length;
    this.reportObservation({ reason: 'l3-pool-sampled', eventId: current.id, n: table.size, chars });

    // ── 纪律③的起点：调模型前记下边界快照 ──
    const snapshot = boundarySnapshotOf(current);
    const textByPointerId = new Map<string, string>();
    current.pointers.forEach((pointer, index) => {
      textByPointerId.set(pointer.id, texts[index] ?? '');
    });

    // 共享 tick 预算 = 2 × 单次调用超时（定稿 §5.1）；第二次只拿剩余时间，不各自独立全量。
    const tickBudgetMs = this.callTimeoutMs * 2;
    const startedAt = Date.now();

    let response: LLMSummarizeResponse | undefined;
    let resolved: ResolvedSummary | undefined;
    let latest: EventRecord | undefined;
    let firstError: unknown;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const round: 'first' | 'retry' = attempt === 1 ? 'first' : 'retry';
      const feedbackBlock =
        attempt === 1 ? undefined : this.retryFeedback(table, firstError);
      const deadlineMs =
        attempt === 1 ? this.callTimeoutMs : tickBudgetMs - (Date.now() - startedAt);

      if (attempt === 2 && deadlineMs <= 0) {
        // 预算耗尽未发起二次调用：仍归 exhausted 失败族（占 1 次 attempt、退避留痕），
        // 但 detail 用 `skipped: 'budget'` 与协议重取耗尽区分，避免同义复用。该字段只供
        // 观测 / runbook 判读，不设代码阈值、不另造状态位。
        this.reportObservation({ reason: 'l3-serial-exhausted', eventId: current.id, round: 'retry' });
        this.failTask(
          task,
          new UnavailableError('重取预算不足，未发起二次调用'),
          nowMs,
          { reason: 'l3-serial-exhausted', round: 'retry', skipped: 'budget' },
        );
        return true;
      }

      const request = this.buildRequest(current, table, textByPointerId, feedbackBlock);
      try {
        response = await this.callWithBudget(port, request, deadlineMs);
      } catch (error) {
        if (!isProtocolRetryable(error)) {
          this.failTask(task, error, nowMs);
          return true;
        }
        if (attempt === 2) {
          return this.exhaust(task, current.id, error, nowMs);
        }
        firstError = error;
        this.reportObservation({ reason: 'l3-serial-retry', eventId: current.id, kinds: protocolKinds(error) });
        continue;
      }

      // 边界复检只在首轮成功响应后做一次；重取轮不重读 latest / 不二次 sameBoundary
      // （同表 / 同 snapshot / 同 texts，定稿 §5.1.2）。
      if (attempt === 1) {
        try {
          latest = this.deps.log.currentOf(task.eventId);
        } catch (error) {
          this.failTask(task, error, nowMs);
          return true;
        }
        if (latest.summary_quality === 'ready' && latest.summary_source !== 'her') {
          this.deps.backlog.complete(task.eventId);
          return true;
        }
        if (!sameBoundary(snapshot, latest)) {
          return true;
        }
      }

      try {
        resolved = this.resolveResponse(table, response, round, current.id);
        break;
      } catch (error) {
        if (!isProtocolRetryable(error)) {
          this.failTask(task, error, nowMs);
          return true;
        }
        if (attempt === 2) {
          return this.exhaust(task, current.id, error, nowMs);
        }
        firstError = error;
        this.reportObservation({ reason: 'l3-serial-retry', eventId: current.id, kinds: protocolKinds(error) });
      }
    }

    if (response === undefined || resolved === undefined || latest === undefined) {
      // 循环正常出口必已赋值；兜底防御，不写半截版本。
      this.failTask(task, new Error('摘要管线未取得有效响应'), nowMs);
      return true;
    }

    // 硬约束只有两条：非空 + 字数上限（码点）。超长即拒绝本次结果（不截断、不改写）。
    // 她写的摘要不重新生成（§6.5 requestRerun / §7.3）—— 那条路径只更新锚点。
    const regenerate = latest.summary_source !== 'her';
    const trimmedSummary = response.summary.trim();
    if (regenerate && trimmedSummary === '') {
      this.failTask(task, new Error('模型返回空摘要'), nowMs);
      return true;
    }
    if (regenerate && summaryLengthOf(trimmedSummary) > this.limit) {
      const length = summaryLengthOf(trimmedSummary);
      this.failTask(task, new Error(`模型返回摘要超长（${length} 字 > ${this.limit} 字）`), nowMs);
      return true;
    }

    try {
      this.writeSummary(
        latest,
        resolved.anchors,
        resolved.candidates,
        trimmedSummary,
        response.keyPoints,
        regenerate,
        response.model,
      );
    } catch (error) {
      // L1 退避收编：落盘前形态闸等写回失败不再抛穿管线 —— 沿用既有 failTask
      // 退避 / 耗尽 / 失败明细口径；不 fail-open、不写半份、不跳过断言、不静默吞错。
      this.failTask(task, error, nowMs);
      return true;
    }
    this.deps.backlog.complete(task.eventId);
    return true;
  }

  /** 二次仍协议失败：观测 exhausted + failTask（占 1 次 attempt，重取本身不占）。 */
  private exhaust(
    task: BacklogTask,
    eventId: string,
    error: unknown,
    nowMs: number,
  ): boolean {
    this.reportObservation({ reason: 'l3-serial-exhausted', eventId, round: 'retry' });
    this.failTask(
      task,
      this.exhaustedFailure(error),
      nowMs,
      { reason: 'l3-serial-exhausted', round: 'retry' },
    );
    return true;
  }

  /** 启动清道夫（G07）：扫描当前态中待补摘要的闭合事件 → 重新入队。 */
  sweepPending(): number {
    let count = 0;
    for (const event of this.deps.log.readAll()) {
      if (event.status !== 'closed' || event.summary_quality !== 'pending') {
        continue;
      }
      if (event.summary_source === 'her') {
        continue;
      }
      if (this.deps.port === null) {
        this.reportMissingModel(event.id);
        continue;
      }
      if (this.deps.backlog.enqueue(event.id)) {
        count += 1;
      }
    }
    return count;
  }

  /** 事件被修正后请求重跑派生字段。 */
  requestRerun(eventId: string): void {
    this.enqueue(eventId);
  }

  /** 最近的失败明细（可观测性读口；环形缓冲，只留最近 100 条）。 */
  failures(): readonly ClosureFailure[] {
    return this.failureLog.slice();
  }

  /** 最近的 L3 观测（可观测性读口；环形缓冲，零 IO）。 */
  observations(): readonly ClosureObservation[] {
    return this.observationLog.slice();
  }

  /**
   * 真源里「待补摘要」的**事件数**（不是队列长度）。
   *
   * 与队列的区别：队列只是加速手段、不落盘；启动清道夫写进 checkpoint 的
   * 「待补摘要数」必须来自真源，否则进程重启后这个数会莫名其妙归零。
   */
  pendingCount(): number {
    let count = 0;
    for (const event of this.deps.log.readAll()) {
      if (event.status !== 'closed' || event.summary_quality !== 'pending') {
        continue;
      }
      if (event.summary_source === 'her') {
        continue;
      }
      count += 1;
    }
    return count;
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /** 建本 tick 冻结表：逐成员点查窄面，缺失槽位由 `buildSerialTable` 整表拒收。 */
  private buildTable(current: EventRecord): SerialTable {
    const members: (SerialMember | undefined)[] = current.pointers.map((pointer) => {
      const ref = this.deps.readExperience.readExperience(pointer.id);
      if (ref === undefined) {
        return undefined;
      }
      return { id: ref.id, channel: ref.channel, occurredAtMs: ref.occurredAtMs };
    });
    return buildSerialTable(members);
  }

  /** 构造一次摘要请求（prompt 形态冻结，§6.3）；反馈块只拼进 user 文本，Request 形状不变。 */
  private buildRequest(
    event: EventRecord,
    table: SerialTable,
    textByPointerId: ReadonlyMap<string, string>,
    feedbackBlock?: string,
  ): LLMSummarizeRequest {
    return {
      system: systemPrompt(this.limit),
      user: userPrompt(event, table, textByPointerId, feedbackBlock),
      maxChars: this.limit,
    };
  }

  /** 重取反馈块：内核纯函数渲染，脱敏回显；范围 1..N。 */
  private retryFeedback(table: SerialTable, error: unknown): string {
    return renderFeedback(referenceViolations(error), { min: 1, max: table.size }, 'retry');
  }

  /** 在给定预算内调一次端口；超时抛 UnavailableError（不包一层）。 */
  private async callWithBudget(
    port: LLMPort,
    request: LLMSummarizeRequest,
    deadlineMs: number,
  ): Promise<LLMSummarizeResponse> {
    return withDeadline(
      deadlineMs,
      (signal) => port.summarize(request, { signal }),
      {
        timeoutError: () =>
          new UnavailableError(`模型调用超时（>${deadlineMs}ms 未返回，已中断）`),
      },
    );
  }

  /**
   * 响应序号 → id 纯数据变换：锚点 fail-closed，候选 fail-soft；首轮空选是合法
   * abstain 并进观测，重取轮回空选按协议失败（R-1）。
   */
  private resolveResponse(
    table: SerialTable,
    response: LLMSummarizeResponse,
    round: 'first' | 'retry',
    eventId: string,
  ): ResolvedSummary {
    let anchors: string[];
    try {
      anchors = resolveAnchorSerials(table, response.anchor_serials);
    } catch (error) {
      throw this.toReferenceError(error, table);
    }
    if (round === 'retry' && anchors.length === 0) {
      throw new EventSerialReferenceError('l3-serial-exhausted: 重取轮回空选，按协议失败', {
        reason: 'l3-serial-exhausted',
      });
    }
    if (round === 'first' && anchors.length === 0 && table.size > 0) {
      this.reportObservation({
        reason: 'l3-empty-selection-with-nonempty-pool',
        eventId,
        round: 'first',
        n: table.size,
      });
    }

    const wireCandidates = response.boundary_candidates ?? [];
    const serials = wireCandidates.map((candidate) => candidate.at_pointer_serial);
    const resolved = resolveCandidateSerials(table, serials);
    if (resolved.dropped > 0) {
      this.reportObservation({
        reason: 'l3-candidate-dropped',
        eventId,
        dropped: resolved.dropped,
      });
    }

    // 成员归属 / 越界 / 去重判定只在 resolver 单点出口完成；这里只按已接受的
    // serial→id 映射回填 kind 与 marked_at，不二次校验范围或重复。
    const accepted = new Map<number, string>(resolved.serials.map((serial, i) => [serial, resolved.ids[i] as string]));
    const candidates: BoundaryCandidate[] = [];
    for (const wire of wireCandidates) {
      if (candidates.length >= MAX_BOUNDARY_CANDIDATES) {
        break;
      }
      const id = accepted.get(wire.at_pointer_serial);
      if (id === undefined) {
        continue;
      }
      candidates.push({ kind: wire.kind, at_pointer_id: id, marked_at: wire.marked_at });
    }
    return { anchors, candidates };
  }

  /** 适配器 wire 错误包成内核序号引用错误并补合法范围；其余错误原样抛穿。 */
  private toReferenceError(error: unknown, table: SerialTable): EventSerialReferenceError {
    if (error instanceof EventSerialReferenceError) {
      return error;
    }
    // 不带自定义 reason：协议形态违约由结构化 violations 承载，reason 词表只保留
    // 建表坏 / 溢出 / 耗尽三枚标准词（定稿 §10 无私码）。
    return new EventSerialReferenceError('锚点序号线协议形态非法', {
      cause: error,
      violations: [
        { kind: 'non-array', index: 0, legalRange: { min: 1, max: table.size } },
      ],
    });
  }

  /** 超限失败错误（detail n/m/eventId 由 failTask 入参补）。 */
  private overflowFailure(current: EventRecord): EventSerialReferenceError {
    return new EventSerialReferenceError(
      `l3-candidate-overflow: 候选池成员 ${current.pointers.length} 超过上限 ${MAX_SERIAL_POOL_MEMBERS}`,
      { reason: 'l3-candidate-overflow' },
    );
  }

  /** 重取仍败：包成序号引用错误，占 1 次 backlog attempt；重取本身不占 attempt。 */
  private exhaustedFailure(error: unknown): EventSerialReferenceError {
    if (error instanceof EventSerialReferenceError) {
      return error;
    }
    return new EventSerialReferenceError('l3-serial-exhausted: 重取后序号引用仍非法', {
      cause: error,
      reason: 'l3-serial-exhausted',
    });
  }

  /** 诊断分桶上下文（毫秒口径；主谓词不依赖它做放行判定）。 */
  private anchorRefContext(current: EventRecord): {
    channel: string;
    startedMs: number;
    endedMs: number;
  } {
    // E-5：真源时间戳由系统生成、恒为 UTC Z，正常不会坏；此处 isoToMs 若抛 TypeError
    // 属基础设施损坏，走 failTask，不进诊断桶的 time-unparseable（该标记只属于诊断
    // 函数对坏串的容错）。不加 try/catch 折算，不引 NaN 路径。
    return {
      channel: current.channel,
      startedMs: isoToMs(current.time_range.started_at),
      endedMs: isoToMs(current.time_range.ended_at),
    };
  }

  /**
   * 写回新版本（append-only，版本号 = 当前版本 + 1，§3.3）。
   *
   * 入参已是 id 数组（序号解析前移完成）；L1 形态闸 / L2 引用闸代码与入参形状零改动。
   *
   * regenerate=false（她写的摘要）→ 保留她的摘要与来源，只更新锚点；
   * regenerate=true → 整份替换，来源改为 llm。
   */
  private writeSummary(
    current: EventRecord,
    anchors: readonly string[],
    candidates: readonly BoundaryCandidate[],
    summary: string,
    keyPoints: readonly string[],
    regenerate: boolean,
    model: string | undefined,
  ): void {
    // L1 前置甲（§2.1 / §4.1）：版本追加**之前**的 ULID 形态闸 —— 先于 appendVersion
    // 落盘；形态不符整批拒绝（不写半份），绝不落盘。空数组（合法 abstain）放行。
    assertAnchorsUlid(anchors);
    // L2 引用完整性闸（#90 批 A/B）：L1 形态之后、appendVersion 之前、writeSummary 的
    // try/catch 之内。memberIds = 本事件 pointers 成员集；context 仅诊断分桶，
    // 主谓词是成员包含性。整份拒收：不剥锚、不写空锚占位版本。
    const memberIds = new Set(current.pointers.map((pointer) => pointer.id));
    assertAnchorRefs(anchors, memberIds, this.deps.readExperience, this.anchorRefContext(current));

    const next: EventRecord = {
      ...current,
      version: current.version + 1,
      summary: regenerate ? summary : current.summary,
      key_points: regenerate ? [...keyPoints] : current.key_points,
      anchors: [...anchors],
      // 候选只追加到既有候选之后（历史候选不丢）；她手写的摘要不重跑 → 不带候选。
      boundary_candidates:
        candidates.length === 0
          ? current.boundary_candidates
          : [...current.boundary_candidates, ...candidates],
      // 她写的摘要即便重跑完也仍是「基于旧边界」→ quality 保持原值（§5.6/§7.3）。
      summary_quality: regenerate ? 'ready' : current.summary_quality,
      summary_source: regenerate ? 'llm' : 'her',
      summary_prompt_version: regenerate ? SUMMARY_PROMPT_VERSION : null,
      summary_model: regenerate ? (model ?? null) : null,
      created_at: nowIso(),
    };
    this.deps.log.appendVersion(next);
  }

  /**
   * 失败处理：退避重试；连续失败达上限 → 标记失败并出队（事件保持 pending）。
   *
   * 失败必须可观测：明细进环形缓冲 + 上报宿主日志。
   */
  private failTask(
    task: BacklogTask,
    error: unknown,
    nowMs: number,
    detail?: Record<string, unknown>,
  ): void {
    const attempts = task.attempts + 1;
    const exhausted = attempts >= RETRY_MAX_ATTEMPTS;
    this.pushFailure({
      eventId: task.eventId,
      attempts,
      error: error instanceof Error ? error.message : String(error),
      at: nowIso(),
      state: exhausted ? 'exhausted' : 'retry',
      detail: detail ?? failureDetailOf(error),
    });

    if (exhausted) {
      // 标记失败：不再自动重试（事件仍保持 pending —— 如实标注「摘要未生成」）。
      this.deps.backlog.complete(task.eventId);
      return;
    }
    this.deps.backlog.retry(task, nowMs);
  }

  /**
   * 模型未配置（永久缺失）—— 不入队、不重试，如实记一条失败。
   *
   * 与「调用失败」的区别：调用失败可能是暂时的（宿主抖动、OAuth 过期）→ 退避重试；
   * 模型压根没配 → 再试也是白试 → 保持 pending，等启动清道夫在配置就绪后补齐。
   */
  private reportMissingModel(eventId: string): void {
    if (this.missingModel.has(eventId)) {
      return;
    }
    this.missingModel.add(eventId);
    this.pushFailure({
      eventId,
      attempts: 0,
      error: '模型未配置（无 LLM 端口）：摘要保持待生成，配置就绪后由启动清道夫补齐',
      at: nowIso(),
      state: 'permanent',
    });
  }

  /** 记一条失败明细（环形缓冲 + 上报宿主日志；绝不静默丢弃）。 */
  private pushFailure(input: Omit<ClosureFailure, 'exhausted'>): void {
    const failure: ClosureFailure = { ...input, exhausted: input.state === 'exhausted' };
    this.failureLog.push(failure);
    if (this.failureLog.length > FAILURE_BUFFER_LIMIT) {
      this.failureLog.shift();
    }
    this.deps.onFailure?.(failure);
  }

  /** 记一条 L3 观测（环形缓冲 + 可选上报；零 IO、不落盘）。 */
  private reportObservation(observation: ClosureObservation): void {
    this.observationLog.push(observation);
    if (this.observationLog.length > OBSERVATION_BUFFER_LIMIT) {
      this.observationLog.shift();
    }
    this.deps.onClosureObservation?.(observation);
  }
}

/**
 * 把 L2 / 存储损坏 / L3 序号错误映射到结构化失败明细（零经历正文）。
 *
 * - `AnchorReferenceInvalidError`：detail 由闸内铸造，原样透传；
 * - 读取口基础设施错误**白名单**（`CorruptedError` 坏行 / `NotFoundError` 缺失或落点失效）：
 *   独立 reason `experience-store-broken`，不吞成 anchor-not-found；只有 reader 正常
 *   返回 undefined 才由闸内分桶 `anchor-not-found`；
 * - `EventSerialReferenceError`：透传 reason 与违例 kinds，不带 L2 正文；
 * - 其他一切错误（模型超时 `UnavailableError`、空摘要 / 超长等）：返回 undefined，
 *   不挂明细；failTask 既有退避 / 留痕行为不变。错误本体不在此 catch 改类。
 */
function failureDetailOf(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof AnchorReferenceInvalidError) {
    return error.detail as unknown as Record<string, unknown>;
  }
  if (error instanceof CorruptedError || error instanceof NotFoundError) {
    const causeClass = error instanceof Error ? error.constructor.name : String(typeof error);
    return {
      reason: 'experience-store-broken',
      anchor: '',
      expected: 'experience log readable',
      actual: 'experience store unavailable',
      note: `cause: ${causeClass}`,
    };
  }
  if (error instanceof EventSerialReferenceError) {
    const detail: Record<string, unknown> = {
      anchor: '',
      expected: '1..N serial reference',
      actual: 'invalid serial selection',
    };
    if (error.reason !== undefined) {
      detail.reason = error.reason;
    }
    if (error.violations.length > 0) {
      detail.kinds = error.violations.map((violation) => violation.kind);
    }
    return detail;
  }
  return undefined;
}

/** 是否属于可触发轮内重取的协议错误（序号引用错误 / 适配器 wire 形态错误）。 */
function isProtocolRetryable(error: unknown): boolean {
  return isEventSerialRefusable(error) || error instanceof AnchorSerialWireError;
}

/** 违例 kinds（观测用）；wire 错误归 `non-array` 兜底。 */
function protocolKinds(error: unknown): readonly string[] {
  if (error instanceof EventSerialReferenceError) {
    return error.violations.map((violation) => violation.kind);
  }
  return ['non-array'];
}

/** 反馈渲染用违例明细；wire 错误无结构化违例时传空数组。 */
function referenceViolations(error: unknown): readonly SerialViolation[] {
  return error instanceof EventSerialReferenceError ? error.violations : [];
}

/**
 * 摘要 system 提示（形态冻结，§6.3）。
 *
 * 写法约束全部在这里，靠模型自检 —— 内核不写任何语义检查器。
 */
function systemPrompt(limit: number): string {
  return [
    '你是事件摘要器。用第三人称、客观语气，只写发生了什么与关键数据。',
    '不写评价、不写感受、不写"重要"。语气词、表情、无意义寒暄不进摘要。',
    `按实际信息量自然写，能短则短（不设字数下限，但不得超过 ${limit} 字）。`,
    '事件内有多个话题转折时，按「先做什么、后做什么」顺叙，不展开对话细节。',
    '输出前自检一次：是否说清了「谁 / 做了什么 / 结果如何」（自检即可，不要输出自检过程）。',
    '只输出 JSON：{"summary": string, "key_points": string[], "anchor_serials": number[], "boundary_candidates": [{"kind": string, "at_pointer_serial": number, "marked_at": string}]}',
    '',
    // ── v1.4 · C7：话题跳转候选（慢路径附带输出）──
    '可选字段 boundary_candidates：若你认为事件内部出现了「话题跳转」，可标出候选。',
    'at_pointer_serial 只能填**本次事件内**记录的序号（见 user 提示 #1..N），不得引用事件外的任何序号。',
    '最多 5 条；没有话题跳转就省略这个字段。',
    '候选是**非权威提示**，只供她复盘时参考；不要因为标了候选就改变摘要的写法或分段。',
    '候选**不含分数、不含置信度**：只给 kind / at_pointer_serial / marked_at 三个字段。',
    'kind 固定用「话题跳转」。',
  ].join('\n');
}

/**
 * 摘要 user 提示（形态冻结，§6.3 + 定稿 §6 单列表）：事件时间范围 + 按冻结有序表
 * 对齐的原文单列表 `#i | 发生时间 | 原文`。废除「原文列表 + id 对照表」双列表；
 * 线上零系统 ULID、无 XML 包裹标签。反馈块只在重取轮拼在末尾。
 */
function userPrompt(
  event: EventRecord,
  table: SerialTable,
  textByPointerId: ReadonlyMap<string, string>,
  feedbackBlock?: string,
): string {
  const rows = table.ordered.map((member, index) => {
    const text = textByPointerId.get(member.id) ?? '';
    return `#${index + 1} | ${msToIso(member.occurredAtMs)} | ${text}`;
  });
  const body = [
    `事件时间范围：${event.time_range.started_at} ~ ${event.time_range.ended_at}`,
    '事件内记录（按时间顺序；锚点与候选只填 # 后的序号 1..N）：',
    ...rows,
  ];
  if (feedbackBlock !== undefined) {
    body.push('', feedbackBlock);
  }
  return body.join('\n');
}

/** 边界快照 —— 「我发起这次调用时，这个事件长什么样」。 */
interface BoundarySnapshot {
  readonly version: number;
  readonly pointerIds: readonly string[];
}

function boundarySnapshotOf(event: EventRecord): BoundarySnapshot {
  return { version: event.version, pointerIds: event.pointers.map((pointer) => pointer.id) };
}

/**
 * 快照与当前态是否仍是同一个边界（设计稿 v1.1 §6.3.1 纪律③的判据）。
 *
 * 版本号变了就足以判定；版本号相同而指针不同只可能来自「绕过 appendVersion 的写路径」
 * —— 那是 bug，但宁可丢弃一次结果，也不要把旧摘要挂到新指针上（永不自愈）。
 */
function sameBoundary(snapshot: BoundarySnapshot, current: EventRecord): boolean {
  if (snapshot.version !== current.version) {
    return false;
  }
  if (snapshot.pointerIds.length !== current.pointers.length) {
    return false;
  }
  return current.pointers.every((pointer, index) => pointer.id === snapshot.pointerIds[index]);
}

/**
 * L1 形态闸（§2.1 前置甲）：锚点数组逐个过 26 位 Crockford ULID 形态断言。
 *
 * 形态判定复用 `core/ulid.ts` 的 `isUlid`（不在本文件另写一份，避免两处漂移）；
 * 非数组 / 非字符串元素 / 形态不符 → fail-closed 抛 `AnchorFormInvalidError`，
 * 空数组是合法 abstain，直接放行。
 */
function assertAnchorsUlid(anchors: unknown): asserts anchors is readonly string[] {
  if (!Array.isArray(anchors)) {
    throw new AnchorFormInvalidError(`anchors 必须为字符串数组：${JSON.stringify(anchors)}`);
  }
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || !isUlid(anchor)) {
      throw new AnchorFormInvalidError(`锚点不是 26 位 Crockford ULID：${JSON.stringify(anchor)}`);
    }
  }
}
