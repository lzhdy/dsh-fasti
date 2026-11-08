/**
 * 哈希原语 —— 只用 node: 内置 crypto，不引入任何运行时依赖。
 *
 * 旧行为契约 1.1：`content_hash = sha256(raw_text)`，供去重与完整性校验。
 */

import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 内容寻址的稳定 id —— sha256(payload) 的前 16 字节 hex。
 *
 * 用于「可从真源确定性重建」的投影行 id（定案稿 §7.2 投影确定性）：
 * 同样的载荷永远得到同样的 id，与写入路径、时刻、进程无关。
 */
export function stableId(prefix: string, payload: string): string {
  return `${prefix}_${sha256Hex(payload).slice(0, 32)}`;
}

/** 原文行的 content_hash（与旧项目口径一致：sha256(raw_text)）。 */
export function contentHashOf(rawText: string): string {
  return sha256Hex(rawText);
}

/** 64 位十六进制 sha256 串。 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
