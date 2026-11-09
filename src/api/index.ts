/**
 * 接口层 —— 定案稿 §9 原语的实现（阶段 0–2 范围内）。
 *
 * 纪律：
 *  - 所有真源写入经同一写队列（单写者，审计口径 10）；
 *  - append 真源后**同步增量更新投影**（L1 用事务；失败回滚并标记需重建）；
 *  - 投影确定性、幂等、可从真源重建；
 *  - 激活/频率只影响排序，不改事实状态 —— 本层不实现任何重要性判定。
 */

import path from 'node:path';

import {
  ConflictError,
  DeletedError,
  NotFoundError,
  NotImplementedError,
  OutOfRangeError,
  UnavailableError,
} from '../core/errors.ts';
import { ensureDir, exists } from '../core/fsx.ts';
import { isSha256Hex, sha256Hex } from '../core/hash.ts';
import { isoToMs, nowIso } from '../core/time.ts';
import { parseChannelDescriptor } from '../contract/channel.ts';
import type { ChannelDescriptor } from '../contract/channel.ts';
import { parseEvent } from '../contract/event.ts';
import type { EventDerivedMarks, EventRecord, EventView } from '../contract/event.ts';
import type {
  EventPrimitives,
  EventQueryFilter,
  MergeEventsInput,
  MergeEventsResult,
  ReopenEventInput,
  ReviseBoundaryInput,
  ReviseBoundaryResult,
  RewriteSummaryInput,
  SplitEventInput,
  SplitEventsResult,
} from '../contract/event-primitives.ts';
import { readJsonlFile } from '../core/jsonl.ts';
import { parseExperience } from '../contract/validate-experience.ts';
import type { Experience, Pointer } from '../contract/experience.ts';
import type {
  AppendExperienceInput,
  ChannelVerification,
  EdgeQuery,
  EdgeView,
  FastiPrimitives,
  IngestRawTurnInput,
  IntegrityReport,
  QueryFilter,
  RebuildResult,
  ResolvedPointer,
  SearchHit,
} from '../contract/primitives.ts';
import { ChannelRegistry } from '../source/channels.ts';
import { EventLog } from '../source/event-log.ts';
import { ExperienceLog } from '../source/experience-log.ts';
import { RawLog } from '../source/raw-log.ts';
import { TickAllocator } from '../source/tick.ts';
import { WriterQueue } from '../source/writer-queue.ts';
import { layoutOf, rawDirOf, resolveDataRoot } from '../source/paths.ts';
import type { DataLayout } from '../source/paths.ts';
import { defaultUlid } from '../core/ulid.ts';
import { IngestStageRegistry } from '../event/ingest-stage.ts';
import type { IngestStage, IngestStageContext, IngestStageFailure } from '../event/ingest-stage.ts';
import { EventSegmenter } from '../event/segmenter.ts';
import { EventCorrector } from '../event/correction.ts';
import type { CorrectionRerunner } from '../event/correction.ts';
import { InMemoryBacklog } from '../event/backlog.ts';
import { ClosurePipeline } from '../event/closure.ts';
import type { ClosureFailure } from '../event/closure.ts';
import type { LLMPort } from '../event/llm-port.ts';
import { DEFAULT_CLOSURE_ROUND_BUDGET_MS } from '../event/params.ts';
import { selectEngine } from '../projection/detect.ts';
import { toEdgeRow } from '../projection/edge.ts';
import { toEventProjection } from '../projection/event-row.ts';
import { rebuildProjection } from '../projection/rebuild.ts';
import type { ProjectionEngine } from '../projection/types.ts';
import { CheckpointStore } from '../runtime/checkpoint.ts';

/**
 * 「待补摘要数」读取失败时，隔多少次再告警一次（m5）。
 *
 * 首次必告警（否则等于全静默）；之后隔 100 次再说一次，免得日志被刷屏。
 */
const PENDING_REFRESH_WARN_EVERY = 100;

/** 打开 Fasti 的选项。 */
export interface FastiOptions {
  /** 显式数据根（最高优先级）。 */
  dataRoot?: string | undefined;
  /** 环境变量（便于测试注入）。 */
  env?: NodeJS.ProcessEnv;
  /** 手动指定投影引擎档位（用于降级验证）。 */
  projectionLevel?: 'L1' | 'L2' | 'L3' | undefined;
  /**
   * 派生字段重跑器（闭合管线）。
   *
   * 缺省 = 用门面内部那条闭合管线（推荐）；显式传入则覆盖它（测试/特殊宿主用）。
   */
  closure?: CorrectionRerunner | undefined;
  /**
   * 摘要用的 LLM 端口。
   *
   * 缺省 `null` = 本环境没有模型 → 事件闭合后摘要保持 `pending` + `summary: null`
   * 如实标注，**绝不伪造**（§6.5 降级口径），配置就绪后由启动清道夫补齐。
   *
   * 内核只认 `LLMPort` 接口；真正调模型的实现只在适配器层
   * （`src/adapters/dsh/llm.ts` 的 `createDshLLMPort`）。
   */
  llmPort?: LLMPort | null | undefined;
  /**
   * 单次模型调用的硬超时（毫秒）—— 缺省 60 秒（设计稿 v1.1 §6.3.1 纪律①）。
   *
   * 宿主可往下调（例如真机验收时想快些看到超时行为），但**不该往上调到接近无限**：
   * 那等于把「一次挂死停掉整条队列」这个故障形态放回来。
   */
  closureCallTimeoutMs?: number | undefined;
  /** 摘要失败上报（宿主日志那一路）；缺省只留在门面的 `closureFailures()` 里。 */
  onClosureFailure?: (failure: ClosureFailure) => void;
  /**
   * 门面内部诊断上报（宿主日志那一路）—— 目前只有「待补摘要数读不出来」在用。
   *
   * 为什么要这个口：这类故障**不该让摄入崩**（诊断信息不得毁掉一级真源），
   * 但也不该完全闭嘴（否则坏了几个月都没人知道）。缺省 no-op：
   * 内核零依赖，日志是宿主的事。
   */
  onDiagnostic?: (level: 'warn', message: string) => void;
}

/**
 * Fasti —— A 块阶段 0–2 的对外门面。
 *
 * 她的一生是一条不可变的经历流；本类只提供「写入真源 + 查询投影 + 维护」的能力，
 * 不含任何记忆判断、主动系统、权限或身份逻辑（属 B/C/D/E 块）。
 *
 * B 块事件开放面（`EventPrimitives`）由同一类实现 —— 消费者拿到的仍是一个对象，
 * 不出现「两个门面」。
 */
export class Fasti implements FastiPrimitives, EventPrimitives {
  private readonly layout: DataLayout;
  private readonly registry: ChannelRegistry;
  private readonly experienceLog: ExperienceLog;
  private readonly rawLogs = new Map<string, RawLog>();
  private readonly queue = new WriterQueue();
  private readonly checkpoint: CheckpointStore;
  private readonly env: NodeJS.ProcessEnv;

  private engine: ProjectionEngine | null = null;
  private ticks: TickAllocator;
  private degraded = false;
  private degradedReason = '';
  /** 宿主诊断上报（零依赖：缺省 no-op）。 */
  private readonly onDiagnostic: (level: 'warn', message: string) => void;
  /** 「待补摘要数」读取失败次数（用于「首次 + 每 N 次」告警，不刷屏）。 */
  private pendingRefreshFailures = 0;
  /** 是否已 close —— 收尾后仍在飞的后台轮次据此早退（不碰已释放的引擎/真源）。 */
  private closed = false;

  /**
   * 事件幂等索引 —— `(channel, event_id)` → `experience.id`。
   *
   * **真源派生**：键来自每条经历的 `(scene.channel, observation.text.id)`，
   * 值是经历自身的 id。故本索引不是新真源、不是新表，进程重启后从真源恢复，
   * 投影重建时也不需要额外动作（符合冻结面第 5 条：投影/索引皆可从真源重建）。
   *
   * 键必须带 channel：`event_id` 仅在通道命名空间内唯一。
   */
  private readonly eventIndex = new Map<string, string>();

  private constructor(options: FastiOptions) {
    this.env = options.env ?? process.env;
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.layout = layoutOf(resolveDataRoot(options));

    ensureDir(this.layout.experiences);
    ensureDir(this.layout.projection);
    ensureDir(this.layout.state);

    this.registry = new ChannelRegistry(this.layout.channelsFile);
    this.registry.load();

    this.experienceLog = new ExperienceLog(this.layout.experiences);
    this.experienceLog.reindex();

    this.reindexEvents();

    // 事件层（记事本）：事件真源 + 切分器。切分器是**第一个**注册的摄入后置 stage。
    // `EventLog.open` 是显式复用出口（取本目录的活实例，没有才新建）——
    // 事件真源是单写者资源，同一目录不能有两个持有者。
    this.t5EventLog = EventLog.open(this.layout.events);
    this.t5Segmenter = new EventSegmenter({
      log: this.t5EventLog,
      readExperience: (id) =>
        this.experienceLog.has(id) ? this.experienceLog.get(id) : undefined,
    });
    this.registerIngestStage({
      name: this.t5Segmenter.name,
      run: (ctx) => {
        // 事件层不可用 → 事件相关原语抛 UnavailableError（不静默、不阻断记录本）。
        if (this.eventLayerError !== null) {
          throw new UnavailableError(`事件层不可用（真源损坏）：${this.eventLayerError.message}`);
        }
        this.t5Segmenter.run(ctx);
      },
    });

    // ── T8/T9 区块：闭合管线（后台摘要）──
    // 三个件必须在此**实体化**：队列（进程内、不落盘）、端口（缺省 null）、管线。
    // 只把类写好而不实例化 = 闭合事件永远没人摘（摘要停在 pending、静默失效）。
    this.t8Backlog = new InMemoryBacklog();
    this.t8Closure = new ClosurePipeline({
      log: this.t5EventLog,
      port: options.llmPort ?? null,
      backlog: this.t8Backlog,
      readTexts: (event) => this.textsOfEvent(event),
      ...(options.closureCallTimeoutMs === undefined
        ? {}
        : { params: { closureCallTimeoutMs: options.closureCallTimeoutMs } }),
      ...(options.onClosureFailure === undefined
        ? {}
        : { onFailure: options.onClosureFailure }),
    });

    // ── T14 区块：事件开放面 ──
    // 修正器直接持有事件真源（同步写版本，队列内不再排队 —— §4.2）。
    // 派生字段重跑器缺省就是上面那条闭合管线（修正后重跑锚点/话题线）。
    this.t14Corrector = new EventCorrector({
      log: this.t5EventLog,
      readExperience: (id) =>
        this.experienceLog.has(id) ? this.experienceLog.get(id) : undefined,
      // 记录唯一归属的判定口 —— 归属索引在真源层（O(1)），修正器自己不去扫全量。
      ownerOf: (id) => this.t5EventLog.ownerOf(id),
      rerunner: options.closure ?? this.t8Closure,
    });

    // 事件投影同步 stage —— 注册在切分器**之后**（stage 按注册顺序执行），
    // 故它看到的、切分器刚写下的事件版本已是最新。
    this.registerIngestStage(this.t14EventProjectionStage);

    this.checkpoint = new CheckpointStore(path.join(this.layout.state, 'checkpoint.json'));

    // tick 权威 = 真源 max(tick)（决策 D-6）；检查点仅作加速。
    this.ticks = TickAllocator.fromSource(this.experienceLog.maxTick());
  }

  /** 打开 Fasti（异步：需要探测投影引擎可用性）。 */
  static async open(options: FastiOptions = {}): Promise<Fasti> {
    const instance = new Fasti(options);
    await instance.initEngine(options);
    // ── G04 区块：启动对账（真源 max tick vs 投影）──
    // 必须在折事件之前：投影若落后于真源，先补齐经历，再谈事件。
    await instance.reconcileOnStartup();
    await instance.startEventLayer();
    // ── T14 区块：事件投影启动同步 ──
    // 事件投影既可由重建产生，也可增量折入。启动时必须折一次：
    // 重建的触发条件是「档位变了 / 标记需重建」，而 events/ 里可能有
    // **没有对应经历**的事件（重建白名单：事件只从 events/ 重建）。
    // 不折一次的话，这些事件在 L1/L2 上查不到，而 L3 直读真源能查到 → 三档不一致。
    await instance.syncEventProjection();
    // ── G07 区块：启动清道夫（三步启动序列的第三步）──
    await instance.startClosureSweeper();
    return instance;
  }

  private async initEngine(options: FastiOptions): Promise<void> {
    const selection = await selectEngine({
      projectionDir: this.layout.projection,
      reader: {
        readExperiences: () => this.experienceLog.readAll(),
        readDocumentText: (id) => this.documentTextOf(id),
        readAllDocuments: () => this.allDocumentTexts(),
        // 事件真源直读（L3 无投影存储，当前态在读取时现算）。
        readEvents: () => this.t5EventLog.readAllVersions(),
      },
      force: options.projectionLevel,
      env: this.env,
    });

    this.engine = selection.engine;
    this.degraded = selection.degraded;
    this.degradedReason = selection.reason;

    const checkpoint = this.checkpoint.load();

    // 引擎档位变了（或检查点标记需重建）→ 从真源重建投影。
    //
    // 这是「投影引擎可替换，真源永不换」的落点（定案稿 §7.4）：
    // 降级到另一档引擎时，新引擎的存储是空的；若不重建，检索能力会**静默丢失**，
    // 违背「任何降级都不影响数据完整性，只影响查询性能与功能丰富度」。
    const engineChanged = checkpoint.engine !== selection.level;
    const needsRebuild = engineChanged || checkpoint.needs_rebuild;

    if (needsRebuild && this.experienceLog.count() > 0) {
      await rebuildProjection(this.engine, this.rebuildSource());
    }

    this.checkpoint.setEngine(selection.level, selection.degraded, selection.reason);
    this.checkpoint.setNeedsRebuild(false);
    this.checkpoint.save();
  }

  // ── 注册 ────────────────────────────────────────────────────────────────

  async registerChannel(descriptor: ChannelDescriptor): Promise<ChannelDescriptor> {
    const validated = parseChannelDescriptor(descriptor, 'channel');
    return this.queue.run(() => this.registry.register(validated));
  }

  // ── 写入 ────────────────────────────────────────────────────────────────

  async appendExperience(experience: AppendExperienceInput): Promise<Experience> {
    return this.queue.run(() => this.appendExperienceUnlocked(experience));
  }

  /**
   * 从真源经历重建事件幂等索引。
   *
   * 键是 `(channel, event_id)`，取自每条经历的 `(scene.channel, observation.text.id)`；
   * 值是经历自身的 id。故索引**完全派生自真源** —— 不是新真源、不是新表，
   * 进程重启后自动恢复（冻结面第 5 条：投影/索引皆可从真源重建）。
   *
   * 没有 `observation.text.id` 的经历不进索引：它们本来就没有 event_id 幂等键。
   */
  private reindexEvents(): void {
    this.eventIndex.clear();
    for (const experience of this.experienceLog.readAll()) {
      const eventId = experience.observation.text?.id;
      if (eventId === undefined || eventId === '') {
        continue;
      }
      this.eventIndex.set(eventKeyOf(experience.scene.channel, eventId), experience.id);
    }
  }

  /**
   * 写结构层经历 + 增量更新投影 —— **不经过单写者队列**。
   *
   * 存在的唯一理由：`ingestRawTurn` 需要在**同一个**队列任务内完成
   * 「写原文 → 写经历 → 更新投影」。若这里的实现再排一次队，
   * 就是队列内再排队（`WriterQueue` 是 Promise 串行队列）→ **永久挂起**。
   *
   * 因此纪律是：**只有最外层入口可以调它**。公开的 `appendExperience`
   * 仍以 `queue.run` 包裹，行为与既有实现完全一致。
   */
  private async appendExperienceUnlocked(experience: AppendExperienceInput): Promise<Experience> {
    // 幂等：同 id 视为重试，返回既有条目、不重复写、不报错（审计口径 7）。
    if (this.experienceLog.has(experience.id)) {
      return this.experienceLog.get(experience.id);
    }

    const parsed = parseExperience(
      { ...experience, recorded_at: experience.recorded_at ?? '' } as unknown,
      'write',
    );

    // recorded_at（系统轴）：
    //  - 调用方未提供 → 由 A 分配当前时刻（定案稿 §9「appendExperience 分配 recorded_at/tick」）；
    //  - 调用方显式提供 → 予以保留。定案稿 §12 的转写要求 recorded_at=ingested_at
    //    （原文进入真源的时刻），若一律覆盖当前时刻，转写行的系统轴就会失真。
    // 一旦落盘即永不改写（定案稿 §5：系统轴「永不」）。
    const recordedAt =
      experience.recorded_at === undefined || experience.recorded_at === ''
        ? nowIso()
        : experience.recorded_at;

    const tick = this.ticks.next();

    const stamped: Experience = {
      ...parsed,
      recorded_at: recordedAt,
      tick,
    };

    const outcome = this.experienceLog.append(stamped);

    let projectedOk = true;
    // 同步增量更新投影（审计口径 13）：投影失败 → 回滚并标记需重建，
    // 但真源写入不回滚（真源是唯一权威）。
    try {
      await this.updateProjection(stamped, outcome.location);
    } catch {
      projectedOk = false;
      this.checkpoint.setNeedsRebuild(true);
    }

    this.checkpoint.setTick(tick);
    // 已投影 tick 只在投影**成功**时推进：失败却推进，下次启动就查不出这条尾差，
    // 投影会永久缺一条（而 L3 直读照常能查到 → 静默的三档不一致）。
    if (projectedOk) {
      this.checkpoint.setLastProjectedTick(tick);
    }
    this.checkpoint.save();

    // ── G01 / T5：摄入后置 stage（切分员）──
    // 同一写队列任务内、真源 append 成功之后同步执行；stage 失败不阻断摄入。
    await this.runIngestStages({
      experience: outcome.experience,
      location: outcome.location,
      channel: outcome.experience.scene.channel,
      tick: outcome.experience.tick,
    });

    return outcome.experience;
  }

  /**
   * 摄入一轮原始对话 —— 「写原文 → 构造经历 → 写经历 → 更新投影」
   * 封装为一个**经单写者队列的原子操作**（阶段 4 开放面扩展）。
   *
   * 幂等键是 **(channel, event_id)**：
   *  - 命中 → 返回既有经历，零新增、不重复写、不报错；
   *  - 未命中 → 生成新 ULID，写原文 + 写经历，并把映射记入真源派生的索引。
   *
   * 落盘时刻只算一次：原文行的 `ingested_at` 与经历条目的 `recorded_at` 严格相等。
   */
  async ingestRawTurn(channel: string, input: IngestRawTurnInput): Promise<Experience> {
    return this.queue.run(async () => {
      // 幂等：先查 (channel, event_id) → experience.id。
      const key = eventKeyOf(channel, input.event_id);
      const existingId = this.eventIndex.get(key);
      if (existingId !== undefined) {
        const existing = this.experienceLog.get(existingId);
        // 幂等命中也要补登记索引（覆盖「原文已在、经历刚补建」的半成品状态）。
        this.eventIndex.set(key, existing.id);
        return existing;
      }

      // 落盘时刻**只计算一次**：原文的 ingested_at 与经历的 recorded_at 必须严格相等，
      // 否则跨毫秒边界时两者会漂移（同一次摄入却有两个落盘时刻）。
      const ingestedAt = input.ingested_at ?? nowIso();

      // 写原文层 —— 拿落点 (shard, seq) 构造双定位指针。
      const log = this.rawLog(channel);
      if (log === undefined) {
        throw new NotFoundError(`通道未注册，无法写入原文层：${channel}`);
      }
      const location = log.append({ ...input, ingested_at: ingestedAt });

      // 构造经历 —— tick 由 A 分配，调用方不传。
      const experience: AppendExperienceInput = {
        id: defaultUlid.next(),
        schema_version: 1,
        kind: 'dialogue',
        scene: {
          channel,
          ref: input.session_id ?? '',
        },
        initiation: initiationOf(input.speaker),
        observation: {
          text: {
            id: input.event_id,
            channel,
            shard: location.shard,
            seq: location.seq,
          },
        },
        occurred_at: input.occurred_at ?? input.asserted_at ?? ingestedAt,
        recorded_at: ingestedAt,
      };

      const written = await this.appendExperienceUnlocked(experience);

      // 索引登记（真源派生：键取自刚写入经历自身的 observation.text.id）。
      this.eventIndex.set(key, written.id);

      return written;
    });
  }

  /** 摄入媒体。阶段 3+（资产层）才实现。 */
  async ingestMedia(bytes?: Uint8Array, meta?: Record<string, unknown>): Promise<never> {
    void bytes;
    void meta;
    throw new NotImplementedError('ingestMedia 属阶段 3+（资产层），阶段 0–2 不实现');
  }

  /** 保存媒体副本。阶段 3+（资产层）才实现。 */
  async preserveMedia(refId: string): Promise<never> {
    void refId;
    throw new NotImplementedError('preserveMedia 属阶段 3+（资产层），阶段 0–2 不实现');
  }

  // ── G01 区块：摄入后置 stage ────────────────────────────────────────────

  /** 已注册的摄入后置 stage（切分员是第一个注册的）。 */
  private readonly ingestStages = new IngestStageRegistry();

  /** 注册摄入后置 stage（切分员是第一个注册的）。 */
  registerIngestStage(stage: IngestStage): void {
    this.ingestStages.register(stage);
  }

  /** 最近的后置 stage 失败（可观测性读口）。 */
  ingestStageFailures(): readonly IngestStageFailure[] {
    return this.ingestStages.failures();
  }

  /** 在写队列任务内执行所有 stage；失败只记录、不回滚真源。 */
  private async runIngestStages(ctx: IngestStageContext): Promise<void> {
    const failures = await this.ingestStages.runAll(ctx);
    if (failures.length > 0) {
      // 失败明细进内存环形缓冲（可观测读口）；检查点里存**累计计数 + 最近 10 条明细**
      // —— 累计数看「发生过多少、是否还在持续」，明细看「具体是什么」。
      this.checkpoint.setStageFailures(this.ingestStages.failureCount(), this.ingestStages.failures());
      this.checkpoint.save();
    }

    // ── T8/T9 接入点：闭合事件 → 后台队列 ──
    // 切分器在 stage 里写出 closed 版本后，把事件交到这里。
    // **必须消费它的返回值**：这是「闭合 → 摘要」链路的唯一入口；
    // 丢掉它，闭合事件就永远停在 pending，而且是**静默**失效
    // （真源状态自洽、查询照常，只是摘要永远出不来）。
    //
    // enqueue 是纯内存操作（不 await、不写盘）→ 不拖慢摄入热路径（DoD 3）。
    // 端口为 null 时管线自己会记一条 permanent 失败并保持 pending，仍不进队列。
    const closedNow = this.t5Segmenter.drainClosedEvents();
    for (const closed of closedNow) {
      this.t8Closure.enqueue(closed.id);
    }
    // 待补摘要数只可能因「有事件闭合」而变（open 事件不算待补）→ 只在真闭合时重算，
    // 别让每条消息都全量扫一遍事件真源（那是摄入热路径）。
    if (closedNow.length > 0) {
      this.refreshPendingEvents();
    }
  }

  /**
   * 把「待补摘要数」同步进检查点（来自真源，不是队列长度）。
   *
   * **绝不抛错**：这是纯诊断计数。事件真源损坏时读它会抛 CorruptedError ——
   * 让一个计数把摄入路径带崩，等于让二级真源的故障毁掉一级真源（裁定 11 明令禁止）。
   * 事件层的不可用由 stage 失败明细与启动扫描负责标注，这里只闭嘴。
   */
  private refreshPendingEvents(): void {
    try {
      const pending = this.t8Closure.pendingCount();
      // 读成功即清零：只有「连续读不到」才值得继续告警，偶尔一次不该一直算在头上。
      this.pendingRefreshFailures = 0;
      if (pending === this.checkpoint.get().pending_events) {
        return;
      }
      this.checkpoint.setPendingEvents(pending);
      this.checkpoint.save();
    } catch (error) {
      // 绝不抛错：这是个纯诊断计数，真源损坏时读它会抛 CorruptedError ——
      // 让一个计数把摄入路径带崩，等于让二级真源的故障毁掉一级真源（裁定 11 明令禁止）。
      //
      // 但也不能全静默（m5）：首次失败与之后每 N 次各告警一次，
      // 否则「检查点里的待补数长期不动」这类故障会几个月没人发现。
      this.pendingRefreshFailures += 1;
      if (
        this.pendingRefreshFailures === 1 ||
        this.pendingRefreshFailures % PENDING_REFRESH_WARN_EVERY === 0
      ) {
        this.onDiagnostic(
          'warn',
          `待补摘要数读取失败（第 ${this.pendingRefreshFailures} 次，本次已忽略）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  // ── T8/T9 区块：闭合管线（异步摘要）──────────────────────────────────────

  /** 后台队列（进程内；持久真相是事件真源的 summary_quality='pending'）。 */
  private readonly t8Backlog: InMemoryBacklog;

  /**
   * 闭合管线 —— 闭合后异步产摘要。
   *
   * 为什么门面必须持有它：切分器只负责「切」，「出摘要」由这条管线在后台做。
   * 没有它，事件层就是个只有边界、没有内容的空壳。
   */
  private readonly t8Closure: ClosurePipeline;

  /**
   * 处理一批到期的摘要任务（一轮最多 `maxPerRound` 条，且不超过 `maxDurationMs`）。
   *
   * 由宿主的后台 worker 周期调用（dsh 侧：`startClosureWorker`）。
   *
   * **两道上限**（设计稿 v1.1 §6.3.1 纪律②）：
   *  - 条数：`maxPerRound`；
   *  - 总时长：`maxDurationMs`（缺省 2 分钟）—— 到限即返回，让调度照常排下一轮。
   *    条数上限挡不住「每条都很慢」：10 条 × 60 秒 = 一轮十分钟，那时候
   *    worker 早就看起来像死了。
   *
   * 时长闸只在**任务之间**检查：已经在飞的那一次调用由管线的单次调用超时兜底
   * （否则要么中断一个可能马上成功的调用，要么把时长闸做成假的）。
   *
   * @returns 本轮实际处理的条数（0 = 队列已空，worker 可歇一拍）
   */
  async drainClosure(
    maxPerRound = 10,
    maxDurationMs = DEFAULT_CLOSURE_ROUND_BUDGET_MS,
  ): Promise<number> {
    // 关闭后仍可能有一轮 worker 在飞：直接返回 0，不碰已释放的真源/引擎。
    if (this.closed) {
      return 0;
    }
    const deadlineMs = Date.now() + Math.max(0, maxDurationMs);
    let processed = 0;
    while (processed < maxPerRound) {
      const did = await this.t8Closure.processOne(Date.now());
      if (!did) {
        break;
      }
      processed += 1;
      if (Date.now() >= deadlineMs) {
        break;
      }
    }
    if (processed > 0) {
      // 摘要出完后待补数会变小 —— 同步回检查点，别让运维看到一个只增不减的数。
      this.refreshPendingEvents();
    }
    return processed;
  }

  /** 最近一次摘要失败（可观测性读口；环形缓冲，只留最近 100 条）。 */
  closureFailures(): readonly ClosureFailure[] {
    return this.t8Closure.failures();
  }

  /** 真源里「待补摘要」的事件数（closed + pending 且非她手写）。 */
  async pendingSummaryCount(): Promise<number> {
    return this.t8Closure.pendingCount();
  }

  /**
   * 事件的原文文本（闭合管线的输入）。
   *
   * 逐条指针回原文层；**取不到的跳过**（指针悬空时不编造原文，也不因此让整件事作废），
   * 一条都取不到 → 返回空数组，管线据此按失败退避、绝不调模型硬编。
   */
  private textsOfEvent(event: EventRecord): string[] {
    const texts: string[] = [];
    for (const pointer of event.pointers) {
      const experience = this.experienceLog.has(pointer.id)
        ? this.experienceLog.get(pointer.id)
        : undefined;
      if (experience === undefined) {
        continue;
      }
      const channel = experience.observation.text?.channel ?? experience.scene.channel;
      const log = this.rawLog(channel);
      if (log !== undefined && experience.observation.text !== undefined) {
        try {
          for (const row of log.resolve(experience.observation.text)) {
            texts.push(row.raw_text);
          }
          continue;
        } catch {
          // 指针悬空：落到 cue 兜底（不编造正文）。
        }
      }
      const cue = experience.observation.cue;
      if (cue !== undefined && cue !== '') {
        texts.push(cue);
      }
    }
    return texts;
  }

  // ── T5 区块：事件层接线（切分器）────────────────────────────────────────

  /** 事件真源（记事本，二级真源）。 */
  private readonly t5EventLog: EventLog;
  /**
   * 事件层不可用的原因（真源损坏等）；`null` = 可用。
   *
   * 降级姿态：事件是**二级**真源，坏的是它 —— 不该让整个数据根打不开
   * （记录本才是不可再生的唯一权威）。事件相关原语抛 `UnavailableError`，
   * 记录本照常读写，**绝不静默**。
   */
  private eventLayerError: Error | null = null;
  /** 切分器 —— 零 LLM、纯机械；摄入后置 stage 的第一个注册者。 */
  private readonly t5Segmenter: EventSegmenter;

  // ── G04 区块：启动对账 ──────────────────────────────────────────────────

  /**
   * 最近一次启动对账的结果（可观测性读口）。
   *
   * `folded > 0` = 上次进程在「真源已 append」与「投影已折入 / 检查点已落」之间被杀，
   * 这次开机把尾差补上了。不是异常路径，是崩溃恢复的常态。
   */
  private lastReconcile: {
    sourceMaxTick: number;
    lastProjectedTick: number;
    folded: number;
  } = { sourceMaxTick: -1, lastProjectedTick: -1, folded: 0 };

  /** 最近一次启动对账的结果。 */
  startupReconciliation(): { sourceMaxTick: number; lastProjectedTick: number; folded: number } {
    return { ...this.lastReconcile };
  }

  /**
   * 启动对账（G04）：比对「真源 max tick」与「检查点记录的已投影 tick」，尾差补折。
   *
   * 为什么需要它：tick 是真源已知的**最大**序号，投影是增量折入的 —— 两者之间
   * 存在一个「真源已写、投影未折」的窗口（进程被杀、投影写失败）。不补折的话，
   * 这段经历在 L1/L2 上查不到，而 L3 直读真源能查到 → 三档不一致且**静默**。
   *
   * 幂等：按 tick 逐条 upsert，重复补折结果相同。
   */
  private async reconcileOnStartup(): Promise<void> {
    const sourceMax = this.experienceLog.maxTick();
    const recorded = this.checkpoint.get().last_projected_tick;

    // 旧检查点没有这一项：以真源为准建标记（不重折 —— 投影是否完整由
    // initEngine 的「档位变了/需重建」判定负责）。
    if (recorded === undefined) {
      this.checkpoint.setLastProjectedTick(sourceMax);
      this.checkpoint.save();
      this.lastReconcile = { sourceMaxTick: sourceMax, lastProjectedTick: sourceMax, folded: 0 };
      return;
    }

    if (sourceMax <= recorded) {
      this.lastReconcile = { sourceMaxTick: sourceMax, lastProjectedTick: recorded, folded: 0 };
      return;
    }

    let folded = 0;
    for (const item of this.experienceLog.readAllWithLocations()) {
      if (item.experience.tick <= recorded) {
        continue;
      }
      await this.updateProjection(item.experience, item.location);
      folded += 1;
    }

    this.checkpoint.setLastProjectedTick(sourceMax);
    this.checkpoint.save();
    this.lastReconcile = { sourceMaxTick: sourceMax, lastProjectedTick: sourceMax, folded };
  }

  // ── G07 区块：启动清道夫 ────────────────────────────────────────────────

  /**
   * 启动清道夫（G07）—— 扫 `summary_quality='pending'` 的闭合事件重新入队。
   *
   * 为什么必须有：后台队列**不落盘**（持久真相是事件真源里的 pending 标记）。
   * 进程随时可能被挂起/杀掉，队列一丢，闭合事件就永远没人摘 ——
   * 靠开机重扫补齐，是「不丢闭合任务」的充要件（DoD 3）。
   *
   * 顺带把「待补摘要数」写进检查点：这个数必须来自真源，
   * 用队列长度写会在重启后莫名归零。
   */
  private async startClosureSweeper(): Promise<void> {
    if (this.eventLayerError !== null) {
      // 事件层不可用：跳过（事件原语本来就会抛 UnavailableError），记录本照常。
      return;
    }
    try {
      this.t8Closure.sweepPending();
      this.refreshPendingEvents();
    } catch (error) {
      // 清道夫失败不该让门面打不开（记录本才是不可再生的权威）。
      this.eventLayerError = error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * 启动事件层 —— 从事件真源恢复每通道的 open 状态，再扫一遍孤立记录标注。
   *
   * 恢复不出（真源损坏 / 同通道两个 open 事件）→ 抛 CorruptedError：
   * **不静默从零开始**（静默从零会把已有记录重切一遍，破坏「事件不可由算法批量重建」）。
   */
  private async startEventLayer(): Promise<void> {
    try {
      await this.queue.run(() => {
        this.t5Segmenter.restore();
        this.t5Segmenter.sweepOrphanMarks(Date.now());
      });
    } catch (error) {
      // 降级 + 明确告警（不静默、不整体失败）：事件层进入不可用态，
      // 记录本照常读写；事件相关原语改为抛 UnavailableError。
      this.eventLayerError = error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 事件层状态（真源损坏 → 不可用；记录本不受影响）。 */
  eventLayerStatus(): { available: boolean; reason: string } {
    return this.eventLayerError === null
      ? { available: true, reason: '' }
      : { available: false, reason: this.eventLayerError.message };
  }

  /**
   * 事件真源实例 —— 门面事件原语用它读写事件层。
   *
   * 事件层不可用时抛 `UnavailableError`（而不是返回空或静默降级）。
   */
  requireEventLog(): EventLog {
    if (this.eventLayerError !== null) {
      throw new UnavailableError(`事件层不可用（真源损坏）：${this.eventLayerError.message}`);
    }
    return this.t5EventLog;
  }

  // ── T14 区块：事件开放面 ────────────────────────────────────────────────

  /**
   * 事件修正器 —— 五种修正的执行体（合并 / 拆分 / 改边界 / 重开 / 重写摘要）。
   *
   * 修正器**同步**执行并直接调 `EventLog.appendVersion`：它跑在门面的写队列任务内，
   * 队列内再排队会永久挂起（§4.2），故修正器自己绝不排队。
   */
  private readonly t14Corrector: EventCorrector;

  /**
   * 事件投影同步 stage —— 摄入后置 stage 的**第二个**注册者（切分器之后）。
   *
   * 为什么必须有它：切分器把事件版本写进 `events/` 真源，但**不碰投影**；
   * 若无人把新版本折进投影，L1/L2 的事件投影就会停在旧版本，
   * 而 L3 是真源直读（永远最新）→ **三档结果集不一致**。
   *
   * stage 失败不阻断摄入（§4.3）：真源已落盘，投影可重建。
   */
  private readonly t14EventProjectionStage: IngestStage = {
    name: 'event-projection',
    run: async () => {
      await this.syncEventProjection();
    },
  };

  /**
   * 已折进投影的事件版本（id → version）—— 用来跳过没变的事件。
   *
   * 真源很小，但每次摄入都全量重折是白费力气；记住版本号即可只折变化的。
   */
  private readonly t14ProjectedVersions = new Map<string, number>();

  /**
   * 把 `events/` 真源的当前态折进投影。
   *
   * 增量路径的版本保护在引擎侧（L1 的 `WHERE excluded.version > event.version`），
   * 故这里可以放心地重复折 —— 旧版本不会覆盖新版本。
   */
  private async syncEventProjection(): Promise<void> {
    try {
      for (const event of this.t5EventLog.readAll()) {
        if (this.t14ProjectedVersions.get(event.id) === event.version) {
          continue;
        }
        await this.requireEngine().upsertEvent(toEventProjection(event));
        this.t14ProjectedVersions.set(event.id, event.version);
      }
    } catch {
      // 投影失败不回滚真源（真源是唯一权威）→ 标记需重建。
      this.checkpoint.setNeedsRebuild(true);
      this.checkpoint.save();
    }
  }

  /**
   * 事件读原语 —— 查当前态 / 取单条 / 列版本历史。
   *
   * 读走「投影筛 id + 真源取全文」，与 A 块 `query()` 的既有模式一致
   * （engine 筛 → 真源回读详情）；**不入队**（读不改真源）。
   */
  async queryEvents(filter?: EventQueryFilter): Promise<EventRecord[]> {
    const rows = await this.requireEngine().queryEvents({
      status: filter?.status,
      channel: filter?.channel,
      from_ms: filter?.time?.from,
      to_ms: filter?.time?.to,
      limit: filter?.limit,
    });

    // 投影只筛出 id 与顺序；全文回真源取当前态（投影行不含指针明细）。
    // 用 `readAll()`（当前态）而不是全部版本行 —— 否则同一 id 的历史版本会重复返回。
    const current = new Map(this.t5EventLog.readAll().map((event) => [event.id, event]));
    const out: EventRecord[] = [];
    for (const row of rows) {
      const event = current.get(row.id);
      if (event !== undefined) {
        out.push(event);
      }
    }
    return out;
  }

  /** 取单个事件当前态；不存在抛 NotFoundError。 */
  async getEvent(id: string): Promise<EventRecord> {
    return this.t5EventLog.currentOf(id);
  }

  /**
   * 查事件当前态，并带出**读时派生的标注**（§5.6）。
   *
   * 标注由切分器的 `marksOf` 现算（要回读记录本判断「带附件 / 跨通道」），
   * **不落盘、不进投影表** —— 能派生就不落盘：一旦落盘，记录本或事件被修正后
   * 标注就成了第二份会漂移的「事实」。
   */
  async queryEventViews(filter?: EventQueryFilter): Promise<EventView[]> {
    const events = await this.queryEvents(filter);
    return events.map((event) => ({ ...event, marks: this.marksOfEvent(event) }));
  }

  /** 取单个事件当前态 + 派生标注。 */
  async getEventView(id: string): Promise<EventView> {
    const event = this.t5EventLog.currentOf(id);
    return { ...event, marks: this.marksOfEvent(event) };
  }

  /** 派生标注的现算入口（事件层不可用时如实降级为「全部 false」，不抛错）。 */
  private marksOfEvent(event: EventRecord): EventDerivedMarks {
    if (this.eventLayerError !== null) {
      return EMPTY_MARKS;
    }
    return this.t5Segmenter.marksOf(event);
  }

  /** 取某事件的全部版本（历史留痕）；未知 id 返回空数组。 */
  async listEventVersions(id: string): Promise<EventRecord[]> {
    return this.t5EventLog.versionsOf(id);
  }

  /**
   * 合并：A + B → C；A、B 置 merged 并带 merged_into=C。
   *
   * **经单写者队列**（与 `appendExperience` 同纪律）：多行追加（写 C + 退役 A、B）
   * 必须原子 —— 否则并发修正会互相踩版本号。
   */
  async mergeEvents(input: MergeEventsInput): Promise<MergeEventsResult> {
    return this.queue.run(async () => {
      const result = this.t14Corrector.merge({
        sourceIds: input.sourceIds,
        targetId: input.targetId,
      });
      await this.syncEventProjection();
      return { target: result.target, retired: result.retired };
    });
  }

  /** 拆分：A → B1 + B2；A 置 split 并带 split_into=[B1,B2]。 */
  async splitEvent(input: SplitEventInput): Promise<SplitEventsResult> {
    return this.queue.run(async () => {
      const result = this.t14Corrector.split({ sourceId: input.sourceId, groups: input.groups });
      await this.syncEventProjection();
      return { retired: result.retired, children: result.children };
    });
  }

  /** 改边界：换 pointers，写新版本，并触发派生字段重跑。 */
  async reviseEventBoundary(input: ReviseBoundaryInput): Promise<ReviseBoundaryResult> {
    return this.queue.run(async () => {
      const result = this.t14Corrector.reviseBoundary({
        eventId: input.eventId,
        removePointerIds: input.removePointerIds,
        addPointerIds: input.addPointerIds,
      });
      await this.syncEventProjection();
      return { event: result.event };
    });
  }

  /** 重开：closed → open，写新版本。 */
  async reopenEvent(input: ReopenEventInput): Promise<EventRecord> {
    return this.queue.run(async () => {
      const event = this.t14Corrector.reopen({ eventId: input.eventId });
      await this.syncEventProjection();
      return event;
    });
  }

  /** 重写摘要：summary_source='her'，写新版本。 */
  async rewriteEventSummary(input: RewriteSummaryInput): Promise<EventRecord> {
    return this.queue.run(async () => {
      const event = this.t14Corrector.rewriteSummary({
        eventId: input.eventId,
        summary: input.summary,
      });
      await this.syncEventProjection();
      return event;
    });
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  async query(filter: QueryFilter): Promise<Experience[]> {
    const rows = await this.requireEngine().query({
      kind: filter.kind,
      channel: filter.channel,
      scene_ref: filter.scene,
      initiation: filter.initiation,
      status: filter.status,
      occurred_from_ms: filter.time?.from,
      occurred_to_ms: filter.time?.to,
      limit: filter.limit,
    });

    const ids = new Set(rows.map((row) => row.id));
    return this.experienceLog.readAll().filter((experience) => ids.has(experience.id));
  }

  async search(keyword: string, limit?: number): Promise<SearchHit[]> {
    const hits = await this.requireEngine().search(keyword, limit);
    return hits.map((hit) => ({
      id: hit.id,
      kind: hit.kind,
      channel: hit.channel,
      snippet: hit.snippet,
    }));
  }

  /** 实体查询。阶段 3+（实体表属完整投影集）才实现。 */
  async queryEntity(id: string): Promise<never> {
    void id;
    throw new NotImplementedError('queryEntity 依赖实体表（完整投影集 P3），阶段 0–2 不实现');
  }

  /**
   * 边查询 —— 返回**边行**（审计 Q1 澄清）。
   *
   * 此前返回的是边的源经历，丢掉了 valid_ms / invalid_ms / confidence / reason，
   * 使 as-of「她在 T 时刻相信什么」无从表达（那正是边有效期窗的语义）。
   * 现在返回边本身；需要源经历内容时，用返回行里的 `src`（经历 id）再调 `query`。
   */
  async queryEdges(query: EdgeQuery): Promise<EdgeView[]> {
    const edges = await this.requireEngine().queryEdges({
      src: query.src,
      predicate: query.predicate,
      dst: query.dst,
      as_of_ms: query.asOf,
    });

    return edges.map((edge) => ({
      id: edge.id,
      src: edge.src,
      predicate: edge.predicate,
      dst: edge.dst,
      valid_ms: edge.valid_ms,
      invalid_ms: edge.invalid_ms,
      created_ms: edge.created_ms,
      expired_ms: edge.expired_ms,
      confidence: edge.confidence,
      reason: edge.reason,
      provenance: edge.provenance,
    }));
  }

  async resolvePointer(pointer: Pointer): Promise<ResolvedPointer> {
    if (pointer === null || typeof pointer !== 'object') {
      throw new NotFoundError('指针必须是对象');
    }

    const channel = pointer.channel;
    const candidates = channel !== undefined ? [channel] : this.registry.list().map((item) => item.id);

    // 跨通道回退时暂存最后一个错误，全部不命中则抛出它（不返回空）。
    let lastError: Error | undefined;

    for (const candidate of candidates) {
      const log = this.rawLog(candidate);
      if (log === undefined) {
        continue;
      }
      try {
        const rows = log.resolve(pointer);
        return {
          turns: rows.map((row, index) => ({
            channel: candidate,
            shard: pointer.shard ?? log.shards()[0] ?? '',
            seq: typeof pointer.seq === 'number' ? pointer.seq : (pointer.seq ? pointer.seq[0] + index : index),
            event_id: row.event_id,
            raw_text: row.raw_text,
          })),
        };
      } catch (error) {
        // ── G08 区块：已删 vs 从未存在的分叉位 ──
        // B1-③ 语义预留：删除闭包落地后，「目标已删」与「目标从未存在」在此分叉 ——
        // 已删不回退到下一个通道、也不退化成 NotFoundError：
        // 上层要能区分「曾经有过、现在没了」与「从来没有过」（悬空留痕 vs 从未有过）。
        // 本期不实现删除工具 → 真源无 tombstone，RawLog 不会抛 DeletedError。
        if (error instanceof DeletedError) {
          throw error;
        }
        const fallback = fallbackErrorOf(error);
        if (fallback === undefined) {
          throw error;
        }
        // 该通道不命中 → 试下一个通道；全都不命中则抛出最后一个错误。
        lastError = fallback;
        continue;
      }
    }

    throw lastError ?? new NotFoundError('指针无法解析：没有匹配的通道');
  }

  /** 取媒体字节。阶段 3+（资产层）才实现。 */
  async getMedia(refId: string): Promise<never> {
    void refId;
    throw new NotImplementedError('getMedia 属阶段 3+（资产层），阶段 0–2 不实现');
  }

  // ── 维护 ────────────────────────────────────────────────────────────────

  /**
   * 她的节拍序号 —— 已分配的最大 tick（审计 Q2 澄清）。
   *
   * 此前返回「下一个将分配的序号」（peek），与「节拍序号」的直觉相反：
   * 写入一条 tick=0 的经历后返回 1，而她实际所处的节拍是 0。
   * 现在返回真源已分配的最大 tick；空真源为 -1（尚未分配过任何 tick）。
   */
  async tick(): Promise<number> {
    return this.experienceLog.maxTick();
  }

  // ── G03 区块：重建自愈（先落 needs_rebuild 再 clear）──
  async rebuildProjections(scope?: { channels?: string[] }): Promise<RebuildResult> {
    return this.queue.run(async () => {
      // 自愈（审计 N1）：**先落 needs_rebuild=true，再 clear**。
      // 重建是「就地清空 + 整体重折」，中途崩溃/失败会留下半截投影；
      // 若先 clear 后落标记，失败那一刻检查点还写着「正常」→ 下次启动
      // 拿半截投影当完整用。故入口立刻落标记，成功才清。
      this.checkpoint.setNeedsRebuild(true);
      this.checkpoint.save();

      const outcome = await rebuildProjection(this.requireEngine(), this.rebuildSource(scope));

      // 重建成功才清标记；失败时异常继续上抛（不吞），标记保持 true。
      this.checkpoint.setNeedsRebuild(false);
      this.checkpoint.setTick(this.ticks.peek() - 1);
      // 重建是全量重折 → 投影已覆盖到真源 max，对账基线一并推到最新，
      // 免得下次开机把刚重建好的内容再当「尾差」折一遍。
      this.checkpoint.setLastProjectedTick(this.experienceLog.maxTick());
      this.checkpoint.save();

      return {
        experiences: outcome.experiences,
        edges: outcome.edges,
        documents: outcome.documents,
        reconciliation: outcome.reconciliation,
      };
    });
  }

  async verifyIntegrity(refId?: string): Promise<IntegrityReport> {
    const mismatched: IntegrityReport['mismatched'] = [];
    let checked = 0;

    if (refId !== undefined) {
      // 校验单个媒体引用的 sha256（阶段 0–2 无资产字节，只能校验声明的自洽性）。
      for (const experience of this.experienceLog.readAll()) {
        for (const media of experience.observation.media ?? []) {
          if (media.ref_id !== refId) {
            continue;
          }
          checked += 1;
          if (media.bytes !== undefined && !isSha256Hex(media.sha256)) {
            mismatched.push({
              location: `${experience.id}/${media.ref_id}`,
              expected: '64 位十六进制 sha256',
              actual: String(media.sha256),
            });
          }
        }
      }
      return { checked, mismatched, ok: mismatched.length === 0 };
    }

    // 全量校验：原文行的 content_hash = sha256(raw_text)（旧行为契约 1.1）。
    for (const channel of this.registry.list()) {
      const log = this.rawLog(channel.id);
      if (log === undefined) {
        continue;
      }
      for (const turn of log.readAll()) {
        checked += 1;
        const actual = sha256Hex(turn.raw_text);
        if (actual !== turn.content_hash) {
          mismatched.push({
            location: `${channel.id}/${turn.event_id}`,
            expected: turn.content_hash,
            actual,
          });
        }
      }
    }

    return { checked, mismatched, ok: mismatched.length === 0 };
  }

  async verifyChannel(channelId?: string): Promise<ChannelVerification[]> {
    const channels =
      channelId !== undefined ? [channelId] : this.registry.list().map((item) => item.id);

    const verifications: ChannelVerification[] = [];

    for (const id of channels) {
      const registered = this.registry.has(id);
      const experiences = this.experienceLog
        .readAll()
        .filter((experience) => experience.scene.channel === id).length;
      const log = this.rawLog(id);
      const rawTurns = log === undefined ? 0 : log.count();

      verifications.push({
        id,
        registered,
        experiences,
        rawTurns,
        ok: registered,
        notes: registered
          ? `已注册：经历 ${experiences} 条、原文 ${rawTurns} 行`
          : '通道未注册（channels.json 中无此 id）',
      });
    }

    return verifications;
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 取得已初始化的投影引擎；未初始化即抛错（不返回空引擎）。 */
  private requireEngine(): ProjectionEngine {
    if (this.engine === null) {
      throw new UnavailableError('投影引擎尚未初始化');
    }
    return this.engine;
  }

  /** 增量更新投影：经历行 + 折叠的边 + 全文文档（同一事务内）。 */
  private async updateProjection(
    experience: Experience,
    location: { shard: string; seq: number },
  ): Promise<void> {
    const engine = this.requireEngine();

    await engine.transaction(async () => {
      await engine.upsertExperience({
        id: experience.id,
        kind: experience.kind,
        channel: experience.scene.channel,
        scene_ref: experience.scene.ref,
        initiation: experience.initiation,
        occurred_ms: isoToMs(experience.occurred_at),
        recorded_ms: isoToMs(experience.recorded_at),
        tick: experience.tick,
        status: 'active',
        shard: location.shard,
        seq: location.seq,
      });

      for (const pointer of experience.pointers ?? []) {
        // 边行由 projection/edge.ts 统一派生 → 增量写入与全量重建给出同一 id（审计 M1）。
        await engine.upsertEdge(toEdgeRow(experience, pointer));
      }

      const text = this.documentTextOf(experience.id);
      if (text !== undefined && text !== '') {
        await engine.upsertDocument(experience.id, text);
      }
    });
  }

  /**
   * 某经历的全文文本 —— 原文回读 + cue（审计口径 11）。
   *
   * 正文一律不内联在经历里，故须经指针回原文层取回。
   */
  private documentTextOf(id: string): string | undefined {
    const experience = this.experienceLog.has(id) ? this.experienceLog.get(id) : undefined;
    if (experience === undefined) {
      return undefined;
    }

    const parts: string[] = [];

    const pointer = experience.observation.text;
    if (pointer !== undefined) {
      const channel = pointer.channel ?? experience.scene.channel;
      const log = this.rawLog(channel);
      if (log !== undefined) {
        try {
          const rows = log.resolve(pointer);
          for (const row of rows) {
            parts.push(row.raw_text);
          }
        } catch {
          // 指针指向的原文缺失 —— 不静默编造文本，只索引 cue。
        }
      }
    }

    const cue = experience.observation.cue;
    if (cue !== undefined && cue !== '') {
      parts.push(cue);
    }

    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  /** 全部文档文本（重建与 L3 直读用）。 */
  private allDocumentTexts(): Map<string, string> {
    const out = new Map<string, string>();
    for (const experience of this.experienceLog.readAll()) {
      const text = this.documentTextOf(experience.id);
      if (text !== undefined) {
        out.set(experience.id, text);
      }
    }
    return out;
  }

  /**
   * 事件版本行 + 真源落点（重建白名单的数据源）。
   *
   * 走事件日志的公开面（`shards()` / `shardFile()`）逐分片读行 —— 不碰它的内部状态，
   * 也不自己算 seq（seq 归事件日志管）。
   */
  private eventRowsWithLocations(): Array<{
    event: EventRecord;
    location: { shard: string; seq: number };
  }> {
    const out: Array<{ event: EventRecord; location: { shard: string; seq: number } }> = [];
    for (const shard of this.t5EventLog.shards()) {
      const rows = readJsonlFile<unknown>(this.t5EventLog.shardFile(shard));
      rows.forEach((row, seq) => {
        out.push({ event: parseEvent(row, 'read'), location: { shard, seq } });
      });
    }
    return out;
  }

  /** 重建所需的数据源。 */
  private rebuildSource(scope?: { channels?: string[] }): {
    experiences: () => Array<{ experience: Experience; location: { shard: string; seq: number } }>;
    events: () => Array<{ event: EventRecord; location: { shard: string; seq: number } }>;
    rawTurnCount: (channel: string) => number;
    documentText: (id: string) => string | undefined;
    mediaRefCount: () => number;
    assetCount: () => number | null;
    registeredChannels: () => string[];
  } {
    const channels = scope?.channels;
    return {
      experiences: () => {
        const all = this.experienceLog.readAllWithLocations();
        return channels === undefined
          ? all
          : all.filter((item) => channels.includes(item.experience.scene.channel));
      },
      // 重建白名单（§7.2）：事件投影的数据源**只有** events/ 真源 ——
      // 绝不从 experiences() 推导事件、绝不拿记录本重跑切分算法覆盖已有事件。
      events: () => this.eventRowsWithLocations(),
      rawTurnCount: (channel: string) => this.rawLog(channel)?.count() ?? 0,
      documentText: (id: string) => this.documentTextOf(id),
      mediaRefCount: () =>
        this.experienceLog
          .readAll()
          .reduce((sum, experience) => sum + (experience.observation.media?.length ?? 0), 0),
      // 阶段 0–2 未实现资产层（用户拍板 Q2）→ 返回 null，对账时显式标注 N/A。
      assetCount: () => null,
      registeredChannels: () => this.registry.list().map((item) => item.id),
    };
  }

  /** 取某通道的原文层日志；通道未注册过则返回 undefined。 */
  private rawLog(channel: string): RawLog | undefined {
    const cached = this.rawLogs.get(channel);
    if (cached !== undefined) {
      return cached;
    }
    const dir = rawDirOf(this.layout, channel);
    if (!exists(dir) && !this.registry.has(channel)) {
      return undefined;
    }
    const log = new RawLog(channel, dir);
    this.rawLogs.set(channel, log);
    return log;
  }

  /** 当前引擎档位。 */
  get level(): 'L1' | 'L2' | 'L3' {
    return this.requireEngine().level;
  }

  /** 是否降级运行。 */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /** 降级原因。 */
  get degradationReason(): string {
    return this.degradedReason;
  }

  /**
   * 当前投影引擎。
   *
   * 暴露它是为了让调用方能执行引擎级操作（如自定义事务批次），
   * 同时也便于诊断投影状态。注意：直接写引擎**不经过单写者队列**，
   * 生产路径应使用本类的高层原语。
   */
  get projectionEngine(): ProjectionEngine {
    return this.requireEngine();
  }

  /** 数据根布局（供测试与工具使用）。 */
  get paths(): DataLayout {
    return this.layout;
  }

  /** 通道注册表（只读访问）。 */
  get channels(): ChannelRegistry {
    return this.registry;
  }

  /**
   * 关闭 Fasti —— 释放投影引擎持有的资源（如 SQLite 文件句柄）。
   *
   * 不调用会导致数据根目录无法删除（Windows 上文件被占用）。
   */
  async close(): Promise<void> {
    // 先置关闭位：后台 worker 可能正有一轮在飞，让它下一轮早退，
    // 不碰即将释放的引擎与事件真源。
    this.closed = true;
    if (this.engine !== null) {
      await this.engine.close();
      this.engine = null;
    }
    // 释放事件真源实例（单写者纪律：同一目录同时只能有一个活实例）。
    // 不释放的话，同一个数据根再开一次 Fasti 就会撞「已有活实例」。
    this.t5EventLog.dispose();
  }
}

/** 事件层不可用时派生标注的降级值（不抛错，也不假装有标注）。 */
const EMPTY_MARKS: EventDerivedMarks = {
  hasMedia: false,
  crossChannel: false,
  pendingMerge: false,
  orphan: false,
  summaryStale: false,
};

/**
 * 事件幂等键 —— `(channel, event_id)`。
 *
 * 必须带 channel：`event_id` 仅在**通道命名空间内**唯一
 * （`RawLog` 是「一个通道命名空间一份」）。
 *
 * 分隔符用 U+0000 —— 它不可能出现在 event_id 或 channel id 里，
 * 故不存在「拼接歧义」（`a` + `b\0c` 与 `a\0b` + `c` 撞键）。
 */
export function eventKeyOf(channel: string, eventId: string): string {
  return `${channel}\u0000${eventId}`;
}

/**
 * speaker → initiation 映射（开放枚举）。
 *
 * 与阶段 3 迁移脚本 `INITIATION_BY_SPEAKER` 同口径：
 * `user`→`user`、`assistant`→`her`、`system`→`system`、`tool`→`environment`。
 * 未知值**原样保留**（开放枚举：不报错、不丢事件）。
 */
export function initiationOf(speaker: string): string {
  switch (speaker) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'her';
    case 'system':
      return 'system';
    case 'tool':
      return 'environment';
    default:
      return speaker;
  }
}

// ── G08 区块：指针解析失败的通道回退判定 ──
/**
 * 指针解析失败时的通道回退判定 —— 返回可回退时该记下的错误，不可回退则 undefined。
 *
 * B1-③ 语义预留：「已删除」（DeletedError）**不**回退、也**不**退化成「从未存在」——
 * 上层必须能区分「曾经有过、现在没了」与「从来没有过」（悬空留痕 vs 从未有过）。
 * 判定靠错误类型/code，不靠 message 文案匹配。
 *
 * 本期不实现删除工具 → 真源无 tombstone → 已删除这一态还不会被真正触发。
 */
export function fallbackErrorOf(
  error: unknown,
): OutOfRangeError | NotFoundError | undefined {
  if (error instanceof OutOfRangeError || error instanceof NotFoundError) {
    return error;
  }
  return undefined;
}

/** 冲突错误导出（便于上层区分「同 id 不等价」的注册冲突）。 */
export { ConflictError };
