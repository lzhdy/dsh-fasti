/**
 * RawTurn —— 原文层的行格式。
 *
 * 沿用旧项目 8 字段（审计口径 6）：event_id / session_id / turn_id / speaker /
 * raw_text / asserted_at / ingested_at / content_hash。
 *
 * 旧行为契约 1.1 的取舍，全部保留：
 *  - `session_id` 缺失时为空串 —— 不报错、不丢事件；
 *  - `asserted_at` 缺失时该字段留空 —— 不伪造当前时间；
 *  - `ingested_at` 是落盘时刻，系统维护；
 *  - `content_hash = sha256(raw_text)` —— 供去重与完整性校验。
 */

import { contentHashOf, isSha256Hex } from '../core/hash.ts';
import { SchemaError } from '../core/errors.ts';

export const RAW_TURN_FIELDS = [
  'event_id',
  'session_id',
  'turn_id',
  'speaker',
  'raw_text',
  'asserted_at',
  'ingested_at',
  'content_hash',
] as const;

/** 原文层一行。 */
export interface RawTurn {
  /** 通道命名空间内唯一的行 id；也是指针 id 的目标（定案稿 §4.5）。 */
  event_id: string;
  /** 会话 id；缺失时为空串（不报错、不丢事件）。 */
  session_id: string;
  turn_id: string;
  speaker: string;
  raw_text: string;
  /** 事件自带时间；缺失时留空字符串，不伪造当前时间。 */
  asserted_at: string;
  /** 落盘时刻，系统维护。 */
  ingested_at: string;
  /** sha256(raw_text)。 */
  content_hash: string;
}

export interface RawTurnInput {
  event_id: string;
  session_id?: string | undefined;
  turn_id?: string | undefined;
  speaker: string;
  raw_text: string;
  asserted_at?: string | undefined;
  ingested_at?: string | undefined;
  content_hash?: string | undefined;
}

function fail(message: string): never {
  throw new SchemaError(message);
}

/**
 * 校验并归一化一条原文行。
 *
 * 归一化只做「补齐缺省」与「算 content_hash」，不改写调用方给的事实：
 * session_id 缺失 → 空串；asserted_at 缺失 → 空串（不伪造当前时间）。
 */
export function parseRawTurn(raw: unknown, at = 'rawTurn'): RawTurn {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${at} 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;

  const eventId = obj['event_id'];
  if (typeof eventId !== 'string' || eventId === '') {
    fail(`${at}.event_id 必须是非空字符串`);
  }

  const speaker = obj['speaker'];
  if (typeof speaker !== 'string' || speaker === '') {
    fail(`${at}.speaker 必须是非空字符串`);
  }

  const rawText = obj['raw_text'];
  if (typeof rawText !== 'string') {
    fail(`${at}.raw_text 必须是字符串`);
  }

  const sessionId = obj['session_id'];
  if (sessionId !== undefined && typeof sessionId !== 'string') {
    fail(`${at}.session_id 必须是字符串`);
  }

  const turnId = obj['turn_id'];
  if (turnId !== undefined && typeof turnId !== 'string') {
    fail(`${at}.turn_id 必须是字符串`);
  }

  const assertedAt = obj['asserted_at'];
  if (assertedAt !== undefined && typeof assertedAt !== 'string') {
    fail(`${at}.asserted_at 必须是字符串`);
  }

  const ingestedAt = obj['ingested_at'];
  if (ingestedAt !== undefined && typeof ingestedAt !== 'string') {
    fail(`${at}.ingested_at 必须是字符串`);
  }

  const contentHash = obj['content_hash'];
  if (contentHash !== undefined && !isSha256Hex(contentHash)) {
    fail(`${at}.content_hash 必须是 64 位十六进制 sha256`);
  }

  return {
    event_id: eventId,
    session_id: sessionId ?? '',
    turn_id: turnId ?? '',
    speaker,
    raw_text: rawText,
    asserted_at: assertedAt ?? '',
    ingested_at: ingestedAt ?? '',
    content_hash: contentHash ?? contentHashOf(rawText),
  };
}

/** 构造一条原文行（供调用方与测试使用）。 */
export function makeRawTurn(input: RawTurnInput): RawTurn {
  return parseRawTurn(input);
}
