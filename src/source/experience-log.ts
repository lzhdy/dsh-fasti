/**
 * 结构层 —— experiences/YYYY-MM.jsonl。
 *
 * 关键口径：
 *  - append-only、不可变（冻结面第 1 条）；
 *  - **以 id 为幂等键**（审计口径 7）：重复 append 同 id 视为重试，返回既有条目、
 *    不重复写、不报错；
 *  - tick 由 A 在摄入时分配，单调递增；乱序到达时 tick 与 occurred_at 允许不一致（定案稿 §5）；
 *  - 分片键取摄入月（recorded_at 所在月），迟到条目自然落入当前月。
 */

import path from 'node:path';

import { NotFoundError } from '../core/errors.ts';
import { writeFileAtomic } from '../core/fsx.ts';
import { appendJsonl, countJsonlLines, readJsonlFile } from '../core/jsonl.ts';
import { shardKeyOf } from '../core/time.ts';
import { parseExperience } from '../contract/validate-experience.ts';
import type { Experience } from '../contract/experience.ts';
import { readManifest } from './raw-log.ts';
import type { Manifest } from './raw-log.ts';

const MANIFEST_FILE = 'manifest.json';

/** 一条经历的落点。 */
export interface ExperienceLocation {
  shard: string;
  seq: number;
}

/** append 的结果。 */
export interface AppendOutcome {
  experience: Experience;
  location: ExperienceLocation;
  /** 是否为新写入（false = 幂等命中既有条目）。 */
  created: boolean;
}

/**
 * 经历日志 —— 结构层唯一写入口。
 *
 * 只提供 append / read 能力；不提供任何修改既有记录的路径（冻结面第 1 条）。
 */
export class ExperienceLog {
  private readonly dir: string;
  /** 每个分片的下一个 seq。 */
  private readonly nextSeq = new Map<string, number>();
  /** id → 落点（幂等键索引）。 */
  private readonly index = new Map<string, ExperienceLocation>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * 追加一条经历。
   *
   * @param input 经历（recorded_at / tick 未定则由调用方在分配后传入）
   */
  append(experience: Experience): AppendOutcome {
    const existing = this.index.get(experience.id);
    if (existing !== undefined) {
      const found = this.readAt(existing);
      return { experience: found, location: existing, created: false };
    }

    const shard = shardKeyOf(experience.recorded_at);
    const seq = this.seqOf(shard);
    const location: ExperienceLocation = { shard, seq };

    appendJsonl(this.shardFile(shard), experience);
    this.nextSeq.set(shard, seq + 1);
    this.index.set(experience.id, location);
    this.registerShard(shard);

    return { experience, location, created: true };
  }

  /** 按 id 取经历；不存在抛 NotFoundError。 */
  get(id: string): Experience {
    const location = this.index.get(id);
    if (location === undefined) {
      throw new NotFoundError(`经历不存在：${id}`);
    }
    return this.readAt(location);
  }

  /** 是否已存在该 id。 */
  has(id: string): boolean {
    return this.index.has(id);
  }

  /** 全部经历（按分片、seq 升序 = 摄入顺序）。 */
  readAll(): Experience[] {
    return this.readAllWithLocations().map((item) => item.experience);
  }

  /**
   * 全部经历 + 其真源落点。
   *
   * 投影的 experience 表带 shard / seq 两列（§7.1），指向结构层的真实位置，
   * 使双定位指针（id 权威 + shard/seq 冗余）可从投影反查真源。
   */
  readAllWithLocations(): Array<{ experience: Experience; location: ExperienceLocation }> {
    const out: Array<{ experience: Experience; location: ExperienceLocation }> = [];
    for (const shard of this.shards()) {
      const rows = readJsonlFile<Experience>(this.shardFile(shard));
      rows.forEach((row, seq) => {
        out.push({ experience: parseExperience(row), location: { shard, seq } });
      });
    }
    return out;
  }

  /** 经历总数。 */
  count(): number {
    let total = 0;
    for (const shard of this.shards()) {
      total += countJsonlLines(this.shardFile(shard));
    }
    return total;
  }

  /** 已登记的分片列表。 */
  shards(): string[] {
    return readManifest(this.dir).months.slice().sort();
  }

  /**
   * 真源中的最大 tick。
   *
   * 空目录返回 -1（表示「尚未分配过任何 tick」）——
   * 否则首个 tick 会从 1 起跳，白白浪费一个节拍序号。
   */
  maxTick(): number {
    let max = -1;
    for (const shard of this.shards()) {
      for (const row of readJsonlFile<Experience>(this.shardFile(shard))) {
        const tick = row.tick;
        if (typeof tick === 'number' && tick > max) {
          max = tick;
        }
      }
    }
    return max;
  }

  /**
   * 从真源重建内存索引与 seq 计数。
   * 进程重启后必须调用，否则幂等键与 seq 不准。
   */
  reindex(): void {
    this.index.clear();
    this.nextSeq.clear();
    for (const shard of this.shards()) {
      const rows = readJsonlFile<Experience>(this.shardFile(shard));
      rows.forEach((row, seq) => {
        this.index.set(row.id, { shard, seq });
      });
      this.nextSeq.set(shard, rows.length);
    }
  }

  /** 某分片的文件路径。 */
  shardFile(shard: string): string {
    return path.join(this.dir, `${shard}.jsonl`);
  }

  private readAt(location: ExperienceLocation): Experience {
    const rows = readJsonlFile<Experience>(this.shardFile(location.shard));
    const row = rows[location.seq];
    if (row === undefined) {
      throw new NotFoundError(`经历落点失效：${location.shard}#${location.seq}`);
    }
    return parseExperience(row);
  }

  private seqOf(shard: string): number {
    const cached = this.nextSeq.get(shard);
    if (cached !== undefined) {
      return cached;
    }
    const count = countJsonlLines(this.shardFile(shard));
    this.nextSeq.set(shard, count);
    return count;
  }

  private registerShard(shard: string): void {
    const manifest: Manifest = readManifest(this.dir);
    if (!manifest.months.includes(shard)) {
      manifest.months.push(shard);
      manifest.months.sort();
      writeFileAtomic(path.join(this.dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
}
