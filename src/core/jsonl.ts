/**
 * JSONL 原语 —— 原文层与结构层的落盘格式。
 *
 * 纪律：
 *  - 一行一条 JSON；写入用 append-only；
 *  - 读时逐行严格解析，坏行抛 CorruptedError（绝不用空串覆盖、绝不静默跳过，
 *    对应旧行为契约 1.1「读失败抛出、不用空串覆盖」与边界清单第 12 条）；
 *  - 保留未知字段：解析结果原样返回，不做字段裁剪（定案稿 §10.4 C2）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { CorruptedError } from './errors.ts';
import { ensureDir } from './fsx.ts';

/** 序列化为一行（不含换行符）。 */
export function toJsonLine(value: unknown): string {
  return JSON.stringify(value);
}

/** JSONL 读取选项。 */
export interface JsonlReadOptions {
  /**
   * 尾行容忍模式（R-12 / §3.6 V-08 torn-read）：仅**最后一行** parse 失败视为截断不可见
   * （不消费、不推进，物理残行保留待下一轮重读）；中间行坏仍抛 `CorruptedError` 硬失败。
   * 默认严格模式：任何坏行（含末行）都抛错，绝不静默容忍。
   */
  readonly tolerant?: boolean;
}

/**
 * 解析 JSONL 文本。
 * @param source 用于错误信息的来源描述（如文件路径）
 */
export function parseJsonl<T>(text: string, source: string, options?: JsonlReadOptions): T[] {
  const out: T[] = [];
  const lines = text.split('\n');

  let lastNonEmptyIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] as string).trim() !== '') {
      lastNonEmptyIndex = i;
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string;
    if (raw.trim() === '') {
      // 空行（通常是文件末尾换行）不算坏行
      continue;
    }
    try {
      out.push(JSON.parse(raw) as T);
    } catch (error) {
      if (options?.tolerant && i === lastNonEmptyIndex) {
        // 末行截断残行：不可见、不消费；物理文件原样保留（R-12）。
        continue;
      }
      throw new CorruptedError(`JSONL 第 ${i + 1} 行解析失败（${source}）：${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  return out;
}

/** 读取并解析 JSONL 文件（文件不存在返回空数组）。 */
export function readJsonlFile<T>(filePath: string, options?: JsonlReadOptions): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const text = fs.readFileSync(filePath, 'utf8');
  return parseJsonl<T>(text, filePath, options);
}

/** append-only 追加一条记录。 */
export function appendJsonl(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${toJsonLine(value)}\n`, { encoding: 'utf8' });
}

/** 统计 JSONL 文件的行数（用于 seq 分配与对账）。 */
export function countJsonlLines(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  if (text === '') {
    return 0;
  }
  const lines = text.split('\n');
  let count = 0;
  for (const line of lines) {
    if (line.trim() !== '') {
      count += 1;
    }
  }
  return count;
}
