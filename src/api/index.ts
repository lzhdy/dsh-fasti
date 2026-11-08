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
import { parseExperience } from '../contract/validate-experience.ts';
import type { Experience, Pointer } from '../contract/experience.ts';
import type {
  AppendExperienceInput,
  ChannelVerification,
  EdgeQuery,
  EdgeView,
  FastiPrimitives,
  IntegrityReport,
  QueryFilter,
  RebuildResult,
  ResolvedPointer,
  SearchHit,
} from '../contract/primitives.ts';
import { ChannelRegistry } from '../source/channels.ts';
import { ExperienceLog } from '../source/experience-log.ts';
import { RawLog } from '../source/raw-log.ts';
import { TickAllocator } from '../source/tick.ts';
import { WriterQueue } from '../source/writer-queue.ts';
import { layoutOf, rawDirOf, resolveDataRoot } from '../source/paths.ts';
import type { DataLayout } from '../source/paths.ts';
import { selectEngine } from '../projection/detect.ts';
import { toEdgeRow } from '../projection/edge.ts';
import { rebuildProjection } from '../projection/rebuild.ts';
import type { ProjectionEngine } from '../projection/types.ts';
import { CheckpointStore } from '../runtime/checkpoint.ts';

/** 打开 Fasti 的选项。 */
export interface FastiOptions {
  /** 显式数据根（最高优先级）。 */
  dataRoot?: string | undefined;
  /** 环境变量（便于测试注入）。 */
  env?: NodeJS.ProcessEnv;
  /** 手动指定投影引擎档位（用于降级验证）。 */
  projectionLevel?: 'L1' | 'L2' | 'L3' | undefined;
}

/**
 * Fasti —— A 块阶段 0–2 的对外门面。
 *
 * 她的一生是一条不可变的经历流；本类只提供「写入真源 + 查询投影 + 维护」的能力，
 * 不含任何记忆判断、主动系统、权限或身份逻辑（属 B/C/D/E 块）。
 */
export class Fasti implements FastiPrimitives {
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

  private constructor(options: FastiOptions) {
    this.env = options.env ?? process.env;
    this.layout = layoutOf(resolveDataRoot(options));

    ensureDir(this.layout.experiences);
    ensureDir(this.layout.projection);
    ensureDir(this.layout.state);

    this.registry = new ChannelRegistry(this.layout.channelsFile);
    this.registry.load();

    this.experienceLog = new ExperienceLog(this.layout.experiences);
    this.experienceLog.reindex();

    this.checkpoint = new CheckpointStore(path.join(this.layout.state, 'checkpoint.json'));

    // tick 权威 = 真源 max(tick)（决策 D-6）；检查点仅作加速。
    this.ticks = TickAllocator.fromSource(this.experienceLog.maxTick());
  }

  /** 打开 Fasti（异步：需要探测投影引擎可用性）。 */
  static async open(options: FastiOptions = {}): Promise<Fasti> {
    const instance = new Fasti(options);
    await instance.initEngine(options);
    return instance;
  }

  private async initEngine(options: FastiOptions): Promise<void> {
    const selection = await selectEngine({
      projectionDir: this.layout.projection,
      reader: {
        readExperiences: () => this.experienceLog.readAll(),
        readDocumentText: (id) => this.documentTextOf(id),
        readAllDocuments: () => this.allDocumentTexts(),
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
    return this.queue.run(async () => {
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
      //  一旦落盘即永不改写（定案稿 §5：系统轴「永不」）。
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

      // 同步增量更新投影（审计口径 13）：投影失败 → 回滚并标记需重建，
      // 但真源写入不回滚（真源是唯一权威）。
      try {
        await this.updateProjection(stamped, outcome.location);
      } catch {
        this.checkpoint.setNeedsRebuild(true);
        this.checkpoint.save();
      }

      this.checkpoint.setTick(tick);
      this.checkpoint.save();

      return outcome.experience;
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
        if (error instanceof OutOfRangeError || error instanceof NotFoundError) {
          // 该通道不命中 → 试下一个通道；全都不命中则抛出最后一个错误。
          lastError = error;
          continue;
        }
        throw error;
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

  async rebuildProjections(scope?: { channels?: string[] }): Promise<RebuildResult> {
    return this.queue.run(async () => {
      const outcome = await rebuildProjection(this.requireEngine(), this.rebuildSource(scope));

      // 重建后 tick 权威仍来自真源；检查点同步。
      this.checkpoint.setNeedsRebuild(false);
      this.checkpoint.setTick(this.ticks.peek() - 1);
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

  /** 重建所需的数据源。 */
  private rebuildSource(scope?: { channels?: string[] }): {
    experiences: () => Array<{ experience: Experience; location: { shard: string; seq: number } }>;
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
    if (this.engine !== null) {
      await this.engine.close();
      this.engine = null;
    }
  }
}

/** 冲突错误导出（便于上层区分「同 id 不等价」的注册冲突）。 */
export { ConflictError };
