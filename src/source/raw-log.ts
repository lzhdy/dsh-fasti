/**
 * 原文层 —— raw-turns/ 与 raw/<channel>/ 的同构实现。
 *
 * 关键口径：
 *  - 8 字段 RawTurn，raw-turns 与 raw/<channel> 完全同构（审计第四节阶段 1 验收项）；
 *  - append-only、**不去重**（旧行为契约 1.1：原文层必须全量，去重责任在调用方）；
 *  - 读失败抛出，绝不用空串覆盖（边界清单第 12 条）；
 *  - 指针双定位：event_id 权威，shard + seq 冗余加速（定案稿 §4.5、冻结面第 2 条）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { CorruptedError, NotFoundError, OutOfRangeError } from '../core/errors.ts';
import { exists, parseJsonStrict, writeFileAtomic } from '../core/fsx.ts';
import { appendJsonl, countJsonlLines, readJsonlFile } from '../core/jsonl.ts';
import { isMonthKey, shardKeyOf } from '../core/time.ts';
import { parseRawTurn } from '../contract/raw-turn.ts';
import type { RawTurn, RawTurnInput } from '../contract/raw-turn.ts';

/** 分片清单 —— 与旧项目 manifest 口径一致：{ version, months }。 */
export interface Manifest {
  version: 1;
  months: string[];
}

const MANIFEST_FILE = 'manifest.json';

/** 一条原文行的落点。 */
export interface RawTurnLocation {
  channel: string;
  shard: string;
  seq: number;
}

/**
 * 原文层日志 —— 一个通道命名空间一份。
 *
 * 只提供 append / read 能力；不提供任何修改既有行的路径（冻结面第 1 条）。
 */
export class RawLog {
  readonly channel: string;
  private readonly dir: string;
  /** 每个分片的下一个 seq（0 起算）。首次写入某分片时按既有行数校准。 */
  private readonly nextSeq = new Map<string, number>();

  constructor(channel: string, dir: string) {
    this.channel = channel;
    this.dir = dir;
  }

  /**
   * 追加一条原文行（不去重）。
   *
   * @param input 原文行；ingested_at 缺省用当前时刻
   * @returns 落点（shard + seq），供构造双定位指针
   */
  append(input: RawTurnInput): RawTurnLocation {
    const ingestedAt = input.ingested_at ?? new Date().toISOString();
    const turn = parseRawTurn({ ...input, ingested_at: ingestedAt });

    const shard = shardKeyOf(turn.ingested_at);
    const file = this.shardFile(shard);

    // seq 从 0 起算（审计口径 4）。
    const seq = this.seqOf(shard);
    appendJsonl(file, turn);
    this.nextSeq.set(shard, seq + 1);
    this.registerShard(shard);

    return { channel: this.channel, shard, seq };
  }

  /** 某分片的全部原文行（按 seq 升序）。 */
  readShard(shard: string): RawTurn[] {
    if (!isMonthKey(shard)) {
      throw new NotFoundError(`非法分片键：${shard}`);
    }
    return readJsonlFile<RawTurn>(this.shardFile(shard)).map((row) => parseRawTurn(row, 'rawTurn'));
  }

  /** 全部原文行（按分片、seq 升序）。 */
  readAll(): RawTurn[] {
    const out: RawTurn[] = [];
    for (const shard of this.shards()) {
      out.push(...this.readShard(shard));
    }
    return out;
  }

  /** 原文行总数。 */
  count(): number {
    let total = 0;
    for (const shard of this.shards()) {
      total += countJsonlLines(this.shardFile(shard));
    }
    return total;
  }

  /** 已登记的分片列表（按时间升序）。 */
  shards(): string[] {
    return readManifest(this.dir).months.slice().sort();
  }

  /**
   * 按指针定位原文行。
   *
   * 双定位：给了 seq 就用 seq（冗余加速路径），没给就用 id（权威路径）。
   * 缺指针或越界一律抛错，不返回空。
   */
  resolve(pointer: { id?: string; shard?: string; seq?: number | [number, number] }): RawTurn[] {
    const shard = pointer.shard;
    const seq = pointer.seq;

    if (shard !== undefined && seq !== undefined) {
      const rows = this.readShard(shard);
      const range = seqToRange(seq);
      if (range.to >= rows.length) {
        throw new OutOfRangeError(
          `指针越界：${this.channel}/${shard} 只有 ${rows.length} 行，请求 seq=${range.to}`,
        );
      }
      return rows.slice(range.from, range.to + 1);
    }

    if (pointer.id !== undefined) {
      for (const candidate of this.shards()) {
        const rows = this.readShard(candidate);
        const hit = rows.find((row) => row.event_id === pointer.id);
        if (hit !== undefined) {
          return [hit];
        }
      }
      throw new NotFoundError(`指针目标不存在：${this.channel} 下找不到 event_id=${pointer.id}`);
    }

    throw new NotFoundError('指针缺少定位信息：需要 id 或 (shard, seq)');
  }

  /** 某分片的文件路径。 */
  shardFile(shard: string): string {
    return path.join(this.dir, `${shard}.jsonl`);
  }

  /** 某分片下一个可用的 seq。 */
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
    const manifest = readManifest(this.dir);
    if (!manifest.months.includes(shard)) {
      manifest.months.push(shard);
      manifest.months.sort();
      writeFileAtomic(path.join(this.dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
}

/** seq 归一为闭区间 [from, to]。 */
export function seqToRange(seq: number | [number, number]): { from: number; to: number } {
  if (typeof seq === 'number') {
    return { from: seq, to: seq };
  }
  const [from, to] = seq;
  return { from, to };
}

/** 读清单；不存在则返回空清单。 */
export function readManifest(dir: string): Manifest {
  const file = path.join(dir, MANIFEST_FILE);
  if (!exists(file)) {
    return { version: 1, months: [] };
  }
  const text = fs.readFileSync(file, 'utf8');
  // 坏清单必须抛 CorruptedError（不静默、也不退化成空清单）。
  const parsed = parseJsonStrict<Manifest>(text, file);
  if (parsed.version !== 1 || !Array.isArray(parsed.months)) {
    throw new CorruptedError(`清单格式非法：${file}`);
  }
  return parsed;
}
