/**
 * 闭合管线 —— 机械闭合后的异步摘要（技术基线 §6.3–§6.5）。
 *
 * 冻结流程：
 *   闭合（切分器写出 closed 版本，summary=null、summary_quality='pending'、summary_source=null）
 *     → closure.enqueue(eventId)
 *     → worker 取到任务 → 读原文 → port.summarize(request)
 *     → 硬约束校验（≤上限字数、非空）
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
 * 后台三条硬纪律（设计稿 v1.1 §6.3.1）：
 *  ① **每次模型调用必须有硬超时**（默认 60s，超时按一次失败处理）——
 *     没有它就是「一次不返回，整条队列永久停摆且静默」；
 *  ② 单轮处理必须有上限（条数 + 总时长，到限返回、照常排下一轮）；
 *  ③ **结果过期必须丢弃**（写回前比对发起时的边界快照，不一致即丢弃、保持 pending、重新入队）。
 */

import { withDeadline } from '../core/deadline.ts';
import { UnavailableError } from '../core/errors.ts';
import { nowIso } from '../core/time.ts';
import { SUMMARY_MAX_CHARS, summaryLengthOf } from '../contract/event.ts';
import type { EventRecord } from '../contract/event.ts';
import type { EventLog } from '../source/event-log.ts';
import { RETRY_MAX_ATTEMPTS } from './backlog.ts';
import type { Backlog, BacklogTask } from './backlog.ts';
import type { LLMPort, LLMSummarizeRequest, LLMSummarizeResponse } from './llm-port.ts';
import {
  SUMMARY_PROMPT_VERSION,
  closureCallTimeoutMsOf,
  resolveEventParams,
  summaryLimitOf,
} from './params.ts';
import type { EventParams } from './params.ts';

/** 失败明细条数上限（环形缓冲，与摄入 stage 失败同口径）。 */
const FAILURE_BUFFER_LIMIT = 100;

/**
 * 失败后的处置 —— 三态区分（机器可判，别靠文案猜）。
 *
 *  - `retry`     临时失败（调用失败 / 原文取不到 / 本次结果不合规）→ 退避后重试；
 *  - `exhausted` 连续失败达上限 → 停止自动重试（事件保持 pending，等下次清道夫）；
 *  - `permanent` 永久缺失（模型未配置）→ 不入队、不重试，事件保持 pending。
 */
export type ClosureFailureState = 'retry' | 'exhausted' | 'permanent';

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
   * 失败上报（宿主日志那一路）。
   *
   * 内核不持有 logger（零依赖），故由宿主注入；未注入时失败仍留在 failures() 明细里，
   * 绝不静默丢弃。
   */
  readonly onFailure?: (failure: ClosureFailure) => void;
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

    const texts = this.deps.readTexts(current);
    if (texts.length === 0) {
      // 原文一条都取不到 → 不调模型（绝不编造原文），按失败退避重试。
      this.failTask(task, new UnavailableError('事件原文取不到（指针悬空）'), nowMs);
      return true;
    }

    // ── 纪律③的起点：调模型前记下边界快照 ──
    // 模型在途期间她可能改边界 / 重开 / 重写摘要 —— 回来后必须知道「我还是不是
    // 当初那个我」。只记 version 不够：将来若有别的写路径不推版本，指针照样可能变。
    const snapshot = boundarySnapshotOf(current);

    let response: LLMSummarizeResponse;
    try {
      // ── 纪律①：硬超时 ──
      // 不设上限的话，一次不返回的调用会让 drain 永不返回、worker 不再排下一轮、
      // 后续事件永久 pending —— 而且**不进失败明细**（它不是失败，是没回来）。
      const request = this.buildRequest(current, texts);
      response = await withDeadline(
        this.callTimeoutMs,
        (signal) => port.summarize(request, { signal }),
        {
          timeoutError: () =>
            new UnavailableError(`模型调用超时（>${this.callTimeoutMs}ms 未返回，已中断）`),
        },
      );
    } catch (error) {
      this.failTask(task, error, nowMs);
      return true;
    }

    // 模型调用是异步的 —— 期间可能有别的写者推进过版本（修正 / 再次闭合）。
    // 落盘前重读当前态：版本号按**落盘那一刻**的当前态算（§3.3）。
    let latest: EventRecord;
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

    // ── 纪律③：结果过期即丢弃 ──
    // 边界在模型在途期间变了 → 这份摘要是按**旧指针**写的，写进去就是
    // 「旧摘要配新指针」且标 ready，之后所有扫描都会因为「已 ready」跳过它 →
    // **永不自愈**。故：不写任何版本、不改 quality，任务留在队列里下一轮重取
    // （dequeue 不摘除任务，故这里什么都不用做，天然就是「重新入队」）。
    //
    // 不计失败：这不是失败，是主动作废。计失败会污染失败率，还会用光重试次数 →
    // 反而让摘要永远补不上。
    if (!sameBoundary(snapshot, latest)) {
      return true;
    }

    // 硬约束只有两条：非空 + 字数上限（码点）。超长即拒绝本次结果（不截断、不改写）。
    // 她写的摘要不重新生成（§6.5 requestRerun / §7.3）—— 那条路径只更新锚点。
    const regenerate = latest.summary_source !== 'her';
    const summary = response.summary.trim();
    if (regenerate && summary === '') {
      this.failTask(task, new Error('模型返回空摘要'), nowMs);
      return true;
    }
    if (regenerate && summaryLengthOf(summary) > this.limit) {
      const length = summaryLengthOf(summary);
      this.failTask(task, new Error(`模型返回摘要超长（${length} 字 > ${this.limit} 字）`), nowMs);
      return true;
    }

    this.writeSummary(latest, response, summary, regenerate);
    this.deps.backlog.complete(task.eventId);
    return true;
  }

  /**
   * 启动清道夫（G07）：扫描当前态中待补摘要的闭合事件 → 重新入队。
   *
   * 幂等（按 event id 去重）：已在队列的不重复入队。
   *
   * 她写的摘要（source='her'）不摘 —— 那类事件的 quality 恒为 pending
   * （派生标注「摘要待更新（基于旧边界）」，§5.6），摘了会无限重跑。
   *
   * @returns 本次新入队的数量（已入队的不计入）。
   */
  sweepPending(): number {
    let count = 0;
    for (const event of this.deps.log.readAll()) {
      // 只扫「闭合 + 待补摘要」的：open 事件内容还会变，摘了也是废摘要。
      if (event.status !== 'closed' || event.summary_quality !== 'pending') {
        continue;
      }
      if (event.summary_source === 'her') {
        continue;
      }
      if (this.deps.port === null) {
        // 模型未配置 → 不入队（如实记录，等配置就绪后的清道夫补齐）。
        this.reportMissingModel(event.id);
        continue;
      }
      if (this.deps.backlog.enqueue(event.id)) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * 事件被修正后请求重跑派生字段。
   *
   * 她写的摘要（summary_source='her'）不覆盖 —— 见 §7.3。
   */
  requestRerun(eventId: string): void {
    this.enqueue(eventId);
  }

  /** 最近的失败明细（可观测性读口；环形缓冲，只留最近 100 条）。 */
  failures(): readonly ClosureFailure[] {
    return this.failureLog.slice();
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
      // 她写的摘要恒 pending（「基于旧边界」的派生标注）→ 不计入待补（不摘）。
      if (event.summary_source === 'her') {
        continue;
      }
      count += 1;
    }
    return count;
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /** 构造一次摘要请求（prompt 形态冻结，§6.3）。 */
  private buildRequest(event: EventRecord, texts: readonly string[]): LLMSummarizeRequest {
    return {
      system: systemPrompt(this.limit),
      user: userPrompt(event, texts),
      maxChars: this.limit,
    };
  }

  /**
   * 写回新版本（append-only，版本号 = 当前版本 + 1，§3.3）。
   *
   * **继承式**：以当前版本为底（`...current`）—— 旧版本的全部字段
   * （closed_reason / pointers / time_range / assembled_at / channel /
   * boundary_candidates / created_by 等）原样带过，只覆盖派生字段。
   *
   * regenerate=false（她写的摘要）→ 保留她的摘要与来源，只更新锚点；
   * regenerate=true → 整份替换，来源改为 llm。
   *
   * 两个溯源字段（`summary_prompt_version` / `summary_model`，设计稿 v1.1 §3.2）
   * 描述的是**刚写进去的这份摘要**：
   *  - regenerate=true → 填本次的提示词版本与模型（模型名由适配器报，报不出来就是 null）；
   *  - regenerate=false → 摘要还是她那份，本次只刷锚点 → 两个字段**清空**
   *    （它们描述的是已被替换的那份摘要，留着就是在撒谎）。
   */
  private writeSummary(
    current: EventRecord,
    response: LLMSummarizeResponse,
    summary: string,
    regenerate: boolean,
  ): void {
    const next: EventRecord = {
      ...current,
      version: current.version + 1,
      summary: regenerate ? summary : current.summary,
      key_points: regenerate ? [...response.keyPoints] : current.key_points,
      anchors: [...response.anchors],
      // 她写的摘要即便重跑完也仍是「基于旧边界」→ quality 保持原值（§5.6/§7.3）。
      summary_quality: regenerate ? 'ready' : current.summary_quality,
      summary_source: regenerate ? 'llm' : 'her',
      summary_prompt_version: regenerate ? SUMMARY_PROMPT_VERSION : null,
      summary_model: regenerate ? (response.model ?? null) : null,
      created_at: nowIso(),
    };
    this.deps.log.appendVersion(next);
  }

  /**
   * 失败处理：退避重试；连续失败达上限 → 标记失败并出队（事件保持 pending）。
   *
   * 失败必须可观测：明细进环形缓冲 + 上报宿主日志。
   */
  private failTask(task: BacklogTask, error: unknown, nowMs: number): void {
    const attempts = task.attempts + 1;
    const exhausted = attempts >= RETRY_MAX_ATTEMPTS;
    this.pushFailure({
      eventId: task.eventId,
      attempts,
      error: error instanceof Error ? error.message : String(error),
      at: nowIso(),
      state: exhausted ? 'exhausted' : 'retry',
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
    // 派生的便捷位在这里**单点**算出 —— 调用方只报 state，不重复表达同一件事。
    const failure: ClosureFailure = { ...input, exhausted: input.state === 'exhausted' };
    this.failureLog.push(failure);
    if (this.failureLog.length > FAILURE_BUFFER_LIMIT) {
      this.failureLog.shift();
    }
    this.deps.onFailure?.(failure);
  }
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
    '只输出 JSON：{"summary": string, "key_points": string[], "anchors": string[]}',
  ].join('\n');
}

/** 摘要 user 提示（形态冻结，§6.3）：事件时间范围 + 按时间顺序的原文。 */
function userPrompt(event: EventRecord, texts: readonly string[]): string {
  const lines = texts.map((text, index) => `${index + 1}. ${text}`);
  return [
    `事件时间范围：${event.time_range.started_at} ~ ${event.time_range.ended_at}`,
    '事件内记录（按时间顺序）：',
    ...lines,
  ].join('\n');
}

/**
 * 边界快照 —— 「我发起这次调用时，这个事件长什么样」。
 *
 * 只记**会决定摘要内容**的两样：版本号与指针组。别的字段（摘要本身、锚点）
 * 不影响「这段话覆盖了哪些原文」，比对它们只会造成假过期。
 */
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
 * 版本号变了就足以判定（版本推进是改指针的唯一路径），但仍逐个比指针：
 * 版本号相同而指针不同只可能来自「绕过 appendVersion 的写路径」——
 * 那是 bug，但宁可丢弃一次结果，也不要把旧摘要挂到新指针上（永不自愈）。
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
