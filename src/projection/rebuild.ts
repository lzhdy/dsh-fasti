/**
 * 重建协议（定案稿 §7.3）与对账。
 *
 * 1. 停写或降级标注（沿 §7.3 语义）；
 * 2. 新建投影库，顺序扫描真源折叠；
 * 3. 对账（RawTurn 数 = dialogue 经历数；media 数 = asset 数；各通道 experience_count 与 channels.json 一致）；
 * 4. 原子换名。SQLite 文件即快照；年级别 <20 万条，分钟级。
 *
 * 关键纪律：
 *  - 重建**只折叠真源已有内容**，不重新调 LLM、不重新判断（定案稿 §7.2）；
 *  - 投影确定性：同样的真源 → 同样的投影内容；
 *  - 幂等：重建两次结果一致。
 */

import { isoToMs } from '../core/time.ts';
import type { Experience } from '../contract/experience.ts';
import type { ReconciliationReport } from '../contract/primitives.ts';
import { toEdgeRow } from './edge.ts';
import type { ExperienceProjection, ProjectionEngine } from './types.ts';

/** 重建所需的数据源。 */
export interface RebuildSource {
  /** 全部经历 + 真源落点（摄入顺序）。 */
  experiences(): Array<{ experience: Experience; location: { shard: string; seq: number } }>;
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
  reconciliation: ReconciliationReport;
}

/**
 * 执行重建：清空投影 → 顺序扫描真源折叠 → 对账。
 *
 * 不做原子换名（换名由调用方在关闭旧库后进行）—— 这样重建失败时旧投影仍在。
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

  const reconciliation = await reconcile(engine, source);

  return {
    experiences: entries.length,
    edges: edgeCount,
    documents: documentCount,
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
