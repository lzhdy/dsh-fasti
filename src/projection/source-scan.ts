/**
 * L3 投影引擎 —— 真源直读（投影损坏且无法重建时的兜底）。
 *
 * 定案稿 §7.4：L3 = 真源直读，惰性分片扫描真源，功能不丢、仅延迟上升，标注「降级运行」。
 *
 * 本引擎**不持有任何投影存储**：查询直接扫真源。
 * upsert* 是 no-op —— L3 没有可写的投影。
 *
 * 关键约束：真源 append-only，故 L3 的读结果天然是确定性的；
 * 重建协议在 L3 下是「无操作」（真源即投影）。
 */

import type { Experience } from '../contract/experience.ts';
import { makeSnippet, matchesSubstring } from './types.ts';
import { toEdgeRow } from './edge.ts';
import type {
  EdgeProjection,
  ExperienceProjection,
  ProjectionEdgeQuery,
  ProjectionEngine,
  ProjectionQuery,
  ProjectionSearchHit,
} from './types.ts';

/** L3 需要的真源读取能力（由 source 层注入，避免层间耦合）。 */
export interface SourceReader {
  /** 全部经历（摄入顺序）。 */
  readExperiences(): Experience[];
  /** 全文文档文本（id → 原文回读 + cue）。 */
  readDocumentText(id: string): string | undefined;
  /** 全部文档（id → 文本）。 */
  readAllDocuments(): Map<string, string>;
}

/** L3 引擎。 */
export class SourceScanProjection implements ProjectionEngine {
  readonly level = 'L3' as const;
  private readonly reader: SourceReader;

  constructor(reader: SourceReader) {
    this.reader = reader;
  }

  async open(): Promise<void> {
    // 真源直读无需初始化。
  }

  async close(): Promise<void> {
    // 无外部资源。
  }

  async upsertExperience(): Promise<void> {
    // L3 无投影存储 —— no-op。
  }

  async upsertEdge(): Promise<void> {
    // L3 无投影存储 —— no-op。
  }

  async upsertDocument(): Promise<void> {
    // L3 无投影存储 —— no-op。
  }

  async query(query: ProjectionQuery): Promise<ExperienceProjection[]> {
    const rows = this.reader.readExperiences().map((experience) => toProjection(experience));

    const filtered = rows.filter((row) => {
      if (query.kind !== undefined && row.kind !== query.kind) {
        return false;
      }
      if (query.channel !== undefined && row.channel !== query.channel) {
        return false;
      }
      if (query.scene_ref !== undefined && row.scene_ref !== query.scene_ref) {
        return false;
      }
      if (query.initiation !== undefined && row.initiation !== query.initiation) {
        return false;
      }
      if (query.status !== undefined && row.status !== query.status) {
        return false;
      }
      if (query.occurred_from_ms !== undefined && row.occurred_ms < query.occurred_from_ms) {
        return false;
      }
      if (query.occurred_to_ms !== undefined && row.occurred_ms > query.occurred_to_ms) {
        return false;
      }
      return true;
    });

    filtered.sort((a, b) => a.occurred_ms - b.occurred_ms || a.tick - b.tick);
    return query.limit !== undefined ? filtered.slice(0, query.limit) : filtered;
  }

  async search(keyword: string, limit?: number): Promise<ProjectionSearchHit[]> {
    if (keyword === '') {
      return [];
    }

    const hits: ProjectionSearchHit[] = [];
    for (const experience of this.reader.readExperiences()) {
      const text = this.reader.readDocumentText(experience.id);
      if (text === undefined || !matchesSubstring(text, keyword)) {
        continue;
      }
      hits.push({
        id: experience.id,
        kind: experience.kind,
        channel: experience.scene.channel,
        snippet: makeSnippet(text, keyword),
      });
      if (limit !== undefined && hits.length >= limit) {
        break;
      }
    }
    return hits;
  }

  async queryEdges(query: ProjectionEdgeQuery): Promise<EdgeProjection[]> {
    const rows: EdgeProjection[] = [];

    for (const experience of this.reader.readExperiences()) {
      for (const pointer of experience.pointers ?? []) {
        // 边行与增量写入、全量重建共用 projection/edge.ts 的同一实现
        // → L3 直读与 L1/L2 对同一条边给出完全相同的 id 与内容（审计 M1）。
        const row = toEdgeRow(experience, pointer);

        if (query.src !== undefined && row.src !== query.src) {
          continue;
        }
        if (query.predicate !== undefined && row.predicate !== query.predicate) {
          continue;
        }
        if (query.dst !== undefined && row.dst !== query.dst) {
          continue;
        }
        if (query.as_of_ms !== undefined) {
          const valid = row.valid_ms === null || row.valid_ms <= query.as_of_ms;
          const notInvalid = row.invalid_ms === null || row.invalid_ms > query.as_of_ms;
          if (!valid || !notInvalid) {
            continue;
          }
        }
        rows.push(row);
      }
    }

    rows.sort((a, b) => a.created_ms - b.created_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }

  async allExperiences(): Promise<ExperienceProjection[]> {
    const rows = this.reader.readExperiences().map((experience) => toProjection(experience));
    rows.sort((a, b) => a.occurred_ms - b.occurred_ms || a.tick - b.tick);
    return rows;
  }

  async allEdges(): Promise<EdgeProjection[]> {
    return this.queryEdges({});
  }

  async allDocuments(): Promise<Map<string, string>> {
    return this.reader.readAllDocuments();
  }

  async clear(): Promise<void> {
    // L3 无投影存储 —— no-op。
  }

  /** L3 无投影存储，事务为 no-op。 */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/** 经历 → 投影行（与 L1/L2 的字段口径一致）。 */
export function toProjection(experience: Experience): ExperienceProjection {
  return {
    id: experience.id,
    kind: experience.kind,
    channel: experience.scene.channel,
    scene_ref: experience.scene.ref,
    initiation: experience.initiation,
    occurred_ms: Date.parse(experience.occurred_at),
    recorded_ms: Date.parse(experience.recorded_at),
    tick: experience.tick,
    status: 'active',
    shard: '',
    seq: 0,
  };
}
