/**
 * 期望态派生纯函数层（#42 正本 §3.1 / §2.3 / §3.5）。
 *
 * 职责（零 IO、零常驻、零定时器、零 LLM）：
 *  - `classifyAnchors`：空锚三分谓词（ok / abstain / form-invalid / not-found），
 *    builder 与未来 drain 共用**同一符号**（R-11），不得在两侧各写一份形态/悬空判定；
 *  - `structuralHash`：全结构派生输入快照哈希（anchors＋channel＋时间窗＋eligibility＋
 *    规则版本）；摘要文字不进输入面，改摘要哈希不得变（§3.5 / R-07 形态②）；
 *  - `deriveExpectedProjection`：从折叠后的当前态事件派生活卡期望集、隔离集与 abstain 集。
 *
 * 无环纪律（P-08）：本模块零文件系统访问、零数据库连接，纯入参派生；
 * 只依赖 content-hash / core 无环低层与 contract 类型，不 import api/assembly/event 编排层/
 * adapters。事件折叠（foldCurrentEvents）由编排层在调用前完成，本函数只收当前态记录。
 */

import { isUlid } from '../core/ulid.ts';
import { isoToMs } from '../core/time.ts';
import type { EventRecord } from '../contract/event.ts';
import { deriveCardId, sha256Hex } from './content-hash.ts';
import { deriveCuesFromKeyPoints, isCueDerivationEnabled } from './cue-derive.ts';
import { CURRENT_RULES_VERSION } from './types.ts';

// ── 空锚三分（§2.3）─────────────────────────────────────────────────────────

/** 锚点分类姿态：合法 / 合法空锚 / 形态缺陷 / 悬空。 */
export type AnchorStatus = 'ok' | 'abstain' | 'form-invalid' | 'not-found';

/** 受控观测原因码；ok 姿态不带原因码（null）。 */
export type AnchorReasonCode =
  | 'empty-anchors'
  | 'anchor-form-invalid'
  | 'anchor-not-found'
  | null;

/** 一次锚点分类的结果（机器可判，不匹配 message 文案）。 */
export interface AnchorClassification {
  readonly status: AnchorStatus;
  readonly reasonCode: AnchorReasonCode;
}

/**
 * 空锚三分谓词（§2.3 终裁）：
 *  - `[]` → `abstain` / `empty-anchors`：合法弃权，不建卡也不算缺陷；
 *  - null / undefined / 非数组 / 非字符串元素 / 非 26 位 Crockford ULID（含空串、数字）
 *    → `form-invalid` / `anchor-form-invalid`；
 *  - 形态合法但 `experienceExists(id) === false` → `not-found` / `anchor-not-found`。
 *
 * 姿态优先级：形态缺陷先于悬空判定（混合样本里只要有一个坏形态，整批按 form-invalid）；
 * 形态全合法时再逐锚回查经历全集，任一悬空即整批 not-found（整批按最差姿态隔离）。
 *
 * @param raw 原始锚点值（容错解析之后、契约校验之前也可能到此，故按 unknown 收）
 * @param experienceExists 经历全集存在谓词（由调用方注入，本函数不碰 IO）
 */
export function classifyAnchors(
  raw: unknown,
  experienceExists: (id: string) => boolean,
): AnchorClassification {
  if (!Array.isArray(raw)) {
    return { status: 'form-invalid', reasonCode: 'anchor-form-invalid' };
  }
  if (raw.length === 0) {
    return { status: 'abstain', reasonCode: 'empty-anchors' };
  }
  for (const anchor of raw) {
    if (typeof anchor !== 'string' || !isUlid(anchor)) {
      return { status: 'form-invalid', reasonCode: 'anchor-form-invalid' };
    }
  }
  for (const anchor of raw) {
    if (!experienceExists(anchor)) {
      return { status: 'not-found', reasonCode: 'anchor-not-found' };
    }
  }
  return { status: 'ok', reasonCode: null };
}

// ── 结构快照哈希（§3.5）────────────────────────────────────────────────────

/** 结构快照输入面：六项任一变哈希必变；摘要文字刻意不在其中。 */
export interface StructuralHashInput {
  readonly anchors: readonly string[];
  readonly channel: string;
  readonly startedMs: number;
  readonly endedMs: number;
  readonly eligibility: string;
  readonly rulesVersion: string;
}

/**
 * 全结构派生输入快照哈希（§3.5 / R-07）。
 *
 * 规范化：锚点去重并排序（序无关，与 card_id 同口径）；其余五项原样入面。
 * 调用方额外携带的 `summary` 等字段不参与哈希 —— 仅摘要文字变不得触发重算。
 */
export function structuralHash(input: StructuralHashInput): string {
  const canonical = {
    anchors: [...new Set(input.anchors)].sort(),
    channel: input.channel,
    startedMs: input.startedMs,
    endedMs: input.endedMs,
    eligibility: input.eligibility,
    rulesVersion: input.rulesVersion,
  };
  return sha256Hex(JSON.stringify(canonical));
}

// ── 期望态派生（§2.5 / R-01 零漂移）─────────────────────────────────────────

/** 期望态活卡（可导结构子空间；cues 为按 rules_version 派生出的期望线索，v1 恒空）。 */
export interface ExpectedCard {
  readonly cardId: string;
  readonly eventId: string;
  readonly anchors: readonly string[];
  readonly channel: string;
  readonly startedMs: number;
  readonly endedMs: number;
  /**
   * 期望 cue 集（#123 P2）。
   * `rules-v1` ⇒ 恒 `[]`（表示"无派生，沿用经历快照"），保证接入前后逐字节零漂移；
   * `rules-v2` ⇒ 由 key_points 确定性派生（见 cue-derive.ts）。
   */
  readonly cues: readonly string[];
}

/** F-B 隔离条目（形态缺陷 / 悬空）。 */
export interface QuarantineEntry {
  readonly eventId: string;
  readonly reasonCode: 'anchor-form-invalid' | 'anchor-not-found';
  readonly anchors: readonly string[];
}

/** 合法空锚弃权条目。 */
export interface AbstainEntry {
  readonly eventId: string;
  readonly anchors: readonly string[];
}

/** 期望态投影：活卡集 + event_id→卡映射 + 隔离集 + 弃权集。 */
export interface ExpectedProjection {
  readonly cards: readonly ExpectedCard[];
  readonly byEvent: ReadonlyMap<string, ExpectedCard>;
  readonly quarantined: readonly QuarantineEntry[];
  readonly emptyAnchored: readonly AbstainEntry[];
}

/** 卡来源 eligibility 口径（与 builder §4.6② 逐字同一条件）：只收 closed + ready。 */
function isCardEligible(event: EventRecord): boolean {
  return event.status === 'closed' && event.summary_quality === 'ready';
}

/**
 * 从折叠后的当前态事件派生期望态（§2.5 第 2 步）。
 *
 * 纯函数：经历存在谓词由入参注入，本函数不读真源、不开 DB、不写投影。
 * 未 closed / 未 ready 的事件既不进卡集，也不进隔离/弃权清单（ eligibility 之外，不归类）。
 *
 * card_id 一律调用既有 `deriveCardId`（X-01 公式不动）；锚点去重排序后入卡，
 * 与 builder 影子库落盘口径逐行一致（R-01）。
 */
export function deriveExpectedProjection(input: {
  readonly events: readonly EventRecord[];
  readonly experienceExists: (id: string) => boolean;
  /**
   * 派生口径（缺省 CURRENT_RULES_VERSION）。
   * 只在测试/未来 rules-v2 显式传入；生产调用面不传，因此 v1 下 cues 恒空、行为不变。
   */
  readonly rulesVersion?: string;
}): ExpectedProjection {
  const rulesVersion = input.rulesVersion ?? CURRENT_RULES_VERSION;
  const cueEnabled = isCueDerivationEnabled(rulesVersion);
  const cards: ExpectedCard[] = [];
  const byEvent = new Map<string, ExpectedCard>();
  const quarantined: QuarantineEntry[] = [];
  const emptyAnchored: AbstainEntry[] = [];

  for (const event of input.events) {
    if (!isCardEligible(event)) {
      continue;
    }
    const classification = classifyAnchors(event.anchors, input.experienceExists);

    if (classification.status === 'abstain') {
      emptyAnchored.push({ eventId: event.id, anchors: [...event.anchors] });
      continue;
    }
    if (classification.status === 'form-invalid' || classification.status === 'not-found') {
      quarantined.push({
        eventId: event.id,
        reasonCode: classification.reasonCode as QuarantineEntry['reasonCode'],
        anchors: [...event.anchors],
      });
      continue;
    }

    const anchors = [...new Set(event.anchors)].sort();
    const cues = cueEnabled
      ? deriveCuesFromKeyPoints({ keyPoints: event.key_points, summary: event.summary }).cues
      : [];
    const card: ExpectedCard = {
      cardId: deriveCardId(event.id, anchors),
      eventId: event.id,
      anchors,
      channel: event.channel,
      startedMs: isoToMs(event.time_range.started_at),
      endedMs: isoToMs(event.time_range.ended_at),
      cues,
    };
    cards.push(card);
    byEvent.set(event.id, card);
  }

  return { cards, byEvent, quarantined, emptyAnchored };
}
