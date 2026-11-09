/**
 * 重建协议（定案稿 §7.3）与对账。
 *
 * 本文件实际执行的是 §7.3 里的**就地重建 + 对账**两步：
 *  1. 就地清空投影（engine.clear）—— 不新建投影库、不做原子换名；
 *  2. 顺序扫描真源折叠（经历行 + 折叠边 + 全文文档）；
 *  3. 对账（RawTurn 数 = dialogue 经历数；各通道 experience_count 与 channels.json 一致；
 *     media 数与 asset 数在资产层未实现时显式标注 N/A）。
 *
 * 「停写 / 降级标注」不落在本文件：停写由调用方经单写者队列串行化保证，
 * 降级标注由运行态检查点承担（needs_rebuild 标记）。
 *
 * 关键纪律：
 *  - 重建**只折叠真源已有内容**，不重新调 LLM、不重新判断（定案稿 §7.2）；
 *  - 投影确定性：同样的真源 → 同样的投影内容；
 *  - 幂等：重建两次结果一致；
 *  - **重建白名单**（T13）：experience 投影从 `experiences/` 重建；
 *    event 投影从 `events/` 重建；**`events/` 永不从 `experiences/` 重建**。
 *    结构性保证：`rebuildProjection` 里的事件折叠只调 `source.events()`
 *    （唯一实现读 `events/` 目录），代码中**没有任何**从 experiences 推导事件的路径。
 */

import { isoToMs } from '../core/time.ts';
import type { Experience } from '../contract/experience.ts';
import type { EventRecord } from '../contract/event.ts';
import type { ReconciliationReport } from '../contract/primitives.ts';
import { toEdgeRow } from './edge.ts';
import { foldCurrentEvents } from './event-row.ts';
import type { ExperienceProjection, ProjectionEngine } from './types.ts';

/** 重建所需的数据源。 */
export interface RebuildSource {
  /** 全部经历 + 真源落点（摄入顺序）。 */
  experiences(): Array<{ experience: Experience; location: { shard: string; seq: number } }>;
  /**
   * 全部事件**版本行** + 真源落点。
   *
   * **重建白名单的核心**：事件投影的数据源**只有** `events/` 真源。
   * 本方法**不**从 `experiences()` 推导任何事件 —— 重建只折叠已有事件，
   * 绝不拿记录本重跑切分算法去覆盖已有事件（定案稿 §7.4「禁止重建」）。
   *
   * **可选**（裁定 19）：白名单的保证来自**代码路径**（下面只调 `source.events?.()`、
   * 没有任何从 experiences 推导事件的分支），不来自「接口必填」。必填只会让
   * 只想重建经历投影的老调用方被迫实现一个它并不拥有的数据源。
   * 缺省 = 本环境没有事件层 → 事件折叠 0 行（而不是抛错）。
   */
  events?(): Array<{ event: EventRecord; location: { shard: string; seq: number } }>;
  /** 某通道的原文行总数。 */
  rawTurnCount(channel: string): number;
  /** 全文文档文本（id → 原文回读 + cue）。 */
  documentText(id: string): string | undefined;
  /** 媒体引用总数（真源侧统计）。 */
  mediaRefCount(): number;
  /** 资产数（阶段 0–2 未实现资产层 → 返回 null）。 */
  assetCount(): number | null;
  /** 已注册通道 id 列表。 */
  registeredChannels(): string[];
}

/** 重建结果。 */
export interface RebuildOutcome {
  experiences: number;
  edges: number;
  documents: number;
  /** 折叠出的事件当前态数（每 event id 一行）。 */
  events: number;
  reconciliation: ReconciliationReport;
}

// ── G03 区块：重建协议注释与实际行为对齐 ──
/**
 * 执行重建：就地清空投影 → 顺序扫描真源折叠 → 对账。
 *
 * **就地清空，不是原子换名**：清空与重建发生在同一份投影存储上，
 * 因此中途失败会留下半截投影（旧投影此时已不在）。
 * 调用方必须在调用本函数**之前**落 `needs_rebuild=true`，
 * 失败时该标记保持为 true —— 下次启动才知道投影是半截的、需要重来。
 */
export async function rebuildProjection(
  engine: ProjectionEngine,
  source: RebuildSource,
): Promise<RebuildOutcome> {
  await engine.clear();

  const entries = source.experiences();
  let edgeCount = 0;
  let documentCount = 0;

  for (const { experience, location } of entries) {
    const projection = toProjection(experience, location.shard, location.seq);
    await engine.upsertExperience(projection);

    // pointers 折叠进 edge（审计口径 12）：
    // src=experience.id、predicate=Edge.type、dst=target、valid_ms=occurred、created_ms=recorded。
    // 边行由 projection/edge.ts 统一派生 → 与增量写入、L3 直读逐字段一致。
    for (const pointer of experience.pointers ?? []) {
      const edge = toEdgeRow(experience, pointer);
      await engine.upsertEdge(edge);
      edgeCount += 1;
    }

    // FTS 文本来自原文回读 + cue（审计口径 11）—— 索引原文与线索，不是摘要。
    const text = source.documentText(experience.id);
    if (text !== undefined && text !== '') {
      await engine.upsertDocument(experience.id, text);
      documentCount += 1;
    }
  }

  // ── T13 区块：事件折叠（重建白名单）──
  //
  // 事件折叠**只认 `source.events()`**（即 `events/` 真源），绝不从 experiences 推导：
  //   - 重建只是把真源里已有的事件重新折进投影；
  //   - 「拿全量记录重跑切分算法去覆盖已有事件」是**重建**，定案稿 §7.4 明令禁止
  //     （那会把她修正过的边界抹掉）。
  // 因此 `source.events()` 返回**全部版本行**，折叠时按 id 取最大 version
  // → 她的修正版本胜出，边界原样还在。
  //
  // 存在性判断而非直接调用：`events` 是可选数据源（裁定 19）。**没有**任何
  // 「没有 events 就从 experiences 造」的兜底分支 —— 那正是白名单要禁的事，
  // 宁可得 0 行，也不凭空造事件。
  const eventRows = foldCurrentEvents((source.events?.() ?? []).map((item) => item.event));
  for (const row of eventRows) {
    await engine.upsertEvent(row);
  }

  const reconciliation = await reconcile(engine, source);

  return {
    experiences: entries.length,
    edges: edgeCount,
    documents: documentCount,
    events: eventRows.length,
    reconciliation,
  };
}

/**
 * 对账（定案稿 §7.3 第 3 步）。
 *
 * 产出结构化报告 —— 不静默通过、不抛错掩盖差异。
 */
export async function reconcile(
  engine: ProjectionEngine,
  source: RebuildSource,
): Promise<ReconciliationReport> {
  const projected = await engine.allExperiences();

  const dialogueExperiences = projected.filter((row) => row.kind === 'dialogue').length;

  const rawByChannel = new Map<string, number>();
  for (const channel of source.registeredChannels()) {
    rawByChannel.set(channel, source.rawTurnCount(channel));
  }
  const rawTurns = [...rawByChannel.values()].reduce((sum, n) => sum + n, 0);

  const perChannel: Record<string, number> = {};
  for (const row of projected) {
    perChannel[row.channel] = (perChannel[row.channel] ?? 0) + 1;
  }

  // 各通道 experience_count 与 channels.json 一致：
  // 通道必须已注册，且该通道在真源中的经历数与投影数相同。
  const registered = new Set(source.registeredChannels());
  let channelsMatch = true;
  for (const [channel, count] of Object.entries(perChannel)) {
    if (!registered.has(channel)) {
      channelsMatch = false;
      break;
    }
    const sourceCount = countSourceExperiences(source, channel);
    if (sourceCount !== count) {
      channelsMatch = false;
      break;
    }
  }

  const mediaRefs = source.mediaRefCount();
  const assets = source.assetCount();

  return {
    rawTurns,
    dialogueExperiences,
    rawVsDialogueMatch: rawTurns === dialogueExperiences,
    perChannel,
    channelsMatch,
    mediaVsAsset: {
      applicable: assets !== null,
      reason:
        assets === null
          ? '资产层属阶段 3+（用户拍板 Q2：阶段 0–2 不实现资产层），media 数与 asset 数无法比对 —— 本项显式标注 N/A，不作通过判定'
          : '资产层已实现，media 数与 asset 数可比对',
      mediaRefs,
      assets,
    },
  };
}

/** 统计真源中某通道的经历数（重建前后都从真源读，不从投影读）。 */
function countSourceExperiences(source: RebuildSource, channel: string): number {
  return source.experiences().filter((item) => item.experience.scene.channel === channel).length;
}

/**
 * 经历 → 投影行。
 *
 * shard / seq 指向结构层的**真实落点**，使双定位指针可从投影反查真源。
 */
export function toProjection(
  experience: Experience,
  shard = '',
  seq = 0,
): ExperienceProjection {
  return {
    id: experience.id,
    kind: experience.kind,
    channel: experience.scene.channel,
    scene_ref: experience.scene.ref,
    initiation: experience.initiation,
    occurred_ms: isoToMs(experience.occurred_at),
    recorded_ms: isoToMs(experience.recorded_at),
    tick: experience.tick,
    status: 'active',
    shard,
    seq,
  };
}
