/**
 * drain 观测物理写面（#42 正本 §3.3 观测落点、§3.6 V-08 torn-read 尾行容忍、§3.4 物理隔离）。
 *
 * 落点：投影目录内，与 `memory-index` 平级——`<projection>/drain-observations.jsonl`，
 * 不进 `memory-index` 目录，不进 `decisions.jsonl` 台账，不进 `mem_miss` 表，不新增表。
 *
 * 纪律：
 *  - append-only：写面只有追加，无 update/delete/truncate/rename/整体改写；
 *  - 不 import ledger/store：观测面与决策台账/写柄单例物理隔离；
 *  - 写前 `validateObservation`：越界码/缺字段抛 `SchemaError` 且不落盘；
 *  - 读走尾行容忍模式：末行半截残行不可见、不消费；中间行坏仍抛 `CorruptedError`；
 *  - 幂等：同 `(event_id, version_token, reason_code)` 三元组重复写不倍增，首条快照哈希保留；
 *  - 不碰真源、不加定时器、零常驻。
 */

import path from 'node:path';

import { appendJsonl, readJsonlFile } from '../core/jsonl.ts';
import {
  mergeObservations,
  validateObservation,
  type DrainObservation,
} from './observations.ts';

/** 观测文件名（投影目录内固定具名）。 */
export const DRAIN_OBSERVATIONS_FILE = 'drain-observations.jsonl';

/**
 * 由索引目录推导观测文件路径：`dirname(indexDir)` 即投影目录，文件与 `memory-index` 平级。
 */
export function drainObservationsPath(indexDir: string): string {
  const projectionDir = path.dirname(path.resolve(indexDir));
  return path.join(projectionDir, DRAIN_OBSERVATIONS_FILE);
}

/** 观测仓写/读窄面。 */
export interface DrainObservationStore {
  /** 校验通过后追加一行；校验失败抛 `SchemaError`，不落盘。 */
  append(row: DrainObservation): void;
  /** 尾行容忍读取 + 逐行校验 + 三元组幂等合并（首条优先）。 */
  read(): DrainObservation[];
}

/** 打开观测仓（构造期只算路径，不触碰文件系统；首次 append 才建目录并追加）。 */
export function openDrainObservationStore(indexDir: string): DrainObservationStore {
  const filePath = drainObservationsPath(indexDir);

  return {
    append(row: DrainObservation): void {
      // 写前 fail-closed：非法行当场抛错，绝不落半份坏行。
      validateObservation(row);
      appendJsonl(filePath, row);
    },

    read(): DrainObservation[] {
      // 尾行容忍：末行半截残行不消费；中间行坏抛 CorruptedError（R-12）。
      const rawRows = readJsonlFile<DrainObservation>(filePath, { tolerant: true });
      const validated = rawRows.map((row) => validateObservation(row));
      // 三元组幂等合并：既有行在前、重复键首条快照哈希保留。
      return mergeObservations([], validated);
    },
  };
}
