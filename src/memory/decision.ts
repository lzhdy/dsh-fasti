/**
 * 决策台账行纯铸造层（#42 正本 §3.5 / R-02 / R-16）。
 *
 * 边界：
 *  - 零 IO、零墙钟读取、零随机：时间部分取事件版本 `created_at` 毫秒（逐版本落盘事实，
 *    不取事件创建时刻、不取注入墙钟 / Date.now()）；随机段取去重键 sha256 切片；
 *  - 不 import store/ledger/builder/adapter/assembly；只依赖 core 低层与 types；
 *  - `card_id` 公式不在本模块（X-01 一律不动）；本模块只铸决策行。
 */

import { CROCKFORD_ALPHABET } from '../core/ulid.ts';
import { isoToMs } from '../core/time.ts';
import { sha256Hex } from './content-hash.ts';
import type { DecisionRecord, MemoryCard } from './types.ts';

/** ULID 布局：前 10 字符 48 bit 毫秒时间戳，后 16 字符 80 bit 随机段（与 core/ulid 对齐）。 */
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
/** 随机段取 10 字节（80 bit），对应 sha256 hex 前 20 个字符。 */
const RANDOM_HEX_CHARS = 20;

/** 定长 Crockford Base32 编码（纯函数，无随机、无状态）。 */
function encodeBase32Fixed(value: bigint, length: number): string {
  let rest = value;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = CROCKFORD_ALPHABET[Number(rest & 31n)] + out;
    rest >>= 5n;
  }
  return out;
}

/**
 * 版本时间毫秒：`isoToMs(version.created_at)`，纯换算，不读墙钟。
 * 非法 ISO 沿用 isoToMs 的抛错口径，不返回 0、不伪造时间。
 */
export function decisionAtMs(createdAtIso: string): number {
  return isoToMs(createdAtIso);
}

/**
 * 决策版本上下文（create-card / invalidate / add-alias 三处同一处注入）：
 *  - `version` = 事件版本号（折叠当前态版本）；
 *  - `createdAtIso` = 该版本 `created_at`（逐版本落盘事实，非墙钟）。
 * 由 drain 编排或事件版本上下文提供；铸造层不自行兜底版本号/时间。
 */
export interface DecisionVersionContext {
  readonly version: number;
  readonly createdAtIso: string;
}

/** `deriveDecisionId` 入参（事件版本身份 + 内容去重键）。 */
export interface DecisionIdInput {
  readonly eventId: string;
  readonly version: number;
  readonly createdAtIso: string;
  /** 同真源同语义决策的内容身份（动作 + 目标 + 锚点快照等）。 */
  readonly dedupKey: string;
}

/**
 * 内容派生 ULID decision_id（§3.5）：
 *  - 时间段 = 版本 `created_at` 毫秒的 48 位 Base32 编码（前 10 字符）；
 *  - 随机段 = sha256(`event_id|v{version}|dedupKey`) 前 10 字节的 80 bit Base32 编码（后 16 字符）；
 *  - 同去重键两次铸造同一 id；不同事件 id / 不同去重键 → 不同 id。
 */
export function deriveDecisionId(input: DecisionIdInput): string {
  const ms = decisionAtMs(input.createdAtIso);
  const material = `${input.eventId}|v${input.version}|${input.dedupKey}`;
  const digest = sha256Hex(material);
  const randomBits = BigInt(`0x${digest.slice(0, RANDOM_HEX_CHARS)}`);
  return (
    encodeBase32Fixed(BigInt(ms), TIME_CHARS) + encodeBase32Fixed(randomBits, RANDOM_CHARS)
  );
}

/** 铸造一条确定性决策台账行的入参。 */
export interface DecisionCasterInput {
  readonly eventId: string;
  readonly version: number;
  readonly createdAtIso: string;
  readonly action: DecisionRecord['action'];
  readonly cardId: string | null;
  readonly anchors: readonly string[];
  readonly contentHash: string;
  /** 结构快照哈希（six 输入面）；非建卡决策可置空串。 */
  readonly structuralHash: string;
  readonly modelTag: string;
  readonly reason: string;
  readonly dedupKey: string;
}

/**
 * drain 编排铸造入参：版本上下文由事件版本注入；卡片摘要哈希从卡行内部读取，
 * 编排层不直接引用卡片内容摘要字段（content_hash 护栏：结构判定路径不读摘要哈希）。
 */
export interface DrainDecisionInput {
  readonly card: MemoryCard | null;
  readonly eventId: string;
  readonly version: number;
  readonly createdAtIso: string;
  readonly action: DecisionRecord['action'];
  readonly cardId: string | null;
  readonly anchors: readonly string[];
  readonly structuralHash: string;
  readonly modelTag: string;
  readonly reason: string;
  readonly dedupKey: string;
}

/** drain 编排决策铸造：摘要哈希取卡行既有值；旧卡缺失时置空串（台账只要求字符串）。 */
export function castDrainDecision(input: DrainDecisionInput): DecisionRecord {
  const summaryHash = input.card !== null ? input.card.contentHash : '';
  return castDecision({
    eventId: input.eventId,
    version: input.version,
    createdAtIso: input.createdAtIso,
    action: input.action,
    cardId: input.cardId,
    anchors: [...input.anchors],
    contentHash: summaryHash,
    structuralHash: input.structuralHash,
    modelTag: input.modelTag,
    reason: input.reason,
    dedupKey: input.dedupKey,
  });
}

/**
 * 铸造一条决策台账行：`decision_id` 内容派生，`at_ms` 取版本时间；
 * 其余字段原样落位，`created_by` 恒为 'her'。
 */
export function castDecision(input: DecisionCasterInput): DecisionRecord {
  return {
    decision_id: deriveDecisionId({
      eventId: input.eventId,
      version: input.version,
      createdAtIso: input.createdAtIso,
      dedupKey: input.dedupKey,
    }),
    at_ms: decisionAtMs(input.createdAtIso),
    action: input.action,
    card_id: input.cardId,
    event_id: input.eventId,
    anchor_json: JSON.stringify([...input.anchors]),
    content_hash: input.contentHash,
    structural_hash: input.structuralHash,
    model_tag: input.modelTag,
    reason: input.reason,
    created_by: 'her',
  };
}
