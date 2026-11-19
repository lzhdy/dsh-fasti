/**
 * #130 P2 采用账本物理写面（投影内 append-only `adoptions.jsonl`）。
 *
 * 落点：**indexDir 内**，与 revisions.jsonl / decisions.jsonl 同目录族——
 * 采用账本是卡面 hit_count/last_hit_ms 的重建输入，builder 折叠时与决策台账同目录取材；
 * 不进真源、不新增 sqlite 表、不写 decisions（采用不是她的复盘决策，是她的回忆动作）。
 *
 * 纪律（与 drain-observations.ts 同范式，落点不同）：
 *  - append-only：写面只有追加，无 update/delete/truncate/rename/整体改写；
 *  - 写前 validateAdoption：形状越界抛 SchemaError 且不落盘；
 *  - 读走尾行容忍模式：末行半截残行不可见、不消费；中间行坏仍抛 CorruptedError；
 *  - 写侧不做内容键去重（只追加不裁决），幂等折叠归属 adoption.ts 纯函数层；
 *  - 构造期只算路径不触 fs，首次 append 才建目录。
 */

import path from 'node:path';

import { appendJsonl, readJsonlFile } from '../core/jsonl.ts';
import { validateAdoption, type AdoptionRecord } from './adoption.ts';

/** 采用账本文件名（indexDir 内固定具名）。 */
export const ADOPTIONS_FILE = 'adoptions.jsonl';

/** 账本路径：就在 indexDir 内（revisions/decisions 同族），调用方无法经行内容改写落点。 */
export function adoptionLedgerPath(indexDir: string): string {
  return path.join(path.resolve(indexDir), ADOPTIONS_FILE);
}

/** 采用账本写/读窄面。 */
export interface AdoptionLedgerStore {
  /** 校验通过后追加一行；校验失败抛 SchemaError，不落盘。 */
  append(row: AdoptionRecord): void;
  /** 尾行容忍读取 + 逐行形状校验（不折叠；折叠用 adoption.ts foldAdoptions）。 */
  read(): AdoptionRecord[];
}

/** 打开采用账本（构造期只算路径，不触碰文件系统；首次 append 才建目录并追加）。 */
export function openAdoptionStore(indexDir: string): AdoptionLedgerStore {
  const filePath = adoptionLedgerPath(indexDir);

  return {
    append(row: AdoptionRecord): void {
      // 写前 fail-closed：非法行当场抛错，绝不落半份坏行。
      validateAdoption(row);
      appendJsonl(filePath, row);
    },

    read(): AdoptionRecord[] {
      // 尾行容忍：末行半截残行不消费；中间行坏抛 CorruptedError（R-12 同族口径）。
      const rawRows = readJsonlFile<AdoptionRecord>(filePath, { tolerant: true });
      return rawRows.map((row) => validateAdoption(row));
    },
  };
}
