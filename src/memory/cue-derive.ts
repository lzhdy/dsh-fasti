/**
 * A 路线 · 保底 cue 派生（#123 P1）。
 *
 * 定位：把事件已固化的 `key_points` 确定性地投影成 `display_cues`，补上"三产词口"里
 * 唯一一条不依赖 LLM、不违反冻结令 587 / K5 的产词路径。
 *
 * 纪律（本文件全部成立才可调用）：
 *  - **纯函数**：只吃入参，不读真源、不开 DB、不读时钟、无随机、无 await。
 *  - **真源零新增字段**：输入只用事件行已有的 `key_points` 与 `summary`（projection/types.ts）。
 *  - **不设独立运行期开关**：启用口径由 rules_version 决定（外审 R3 条件二）；生产恒传
 *    CURRENT_RULES_VERSION，本文件因此不引入任何 config flag。
 *  - **v1 零漂移**：当前 CURRENT_RULES_VERSION = rules-v1 不在启用集合内，派生结果恒为空，
 *    接入后生产行为与接入前逐字节一致。
 *
 * 算法（外审裁定 P1，按 H7 硬约束排序）：
 *  清洗（NFKC）→ 去重保序 → 超 40 码点整条丢弃 → H7 双形态反查丢弃 → 保序取前 3。
 */

import { sha256Hex } from './content-hash.ts';
import { normalizeLexicalText } from './gate.ts';

/**
 * 启用 key_points→cue 派生的规则版本白名单。
 * 新增版本时在此登记，不改任何运行期 flag（R3 条件二：生产只认 rules_version）。
 */
const CUE_DERIVATION_RULES: ReadonlySet<string> = new Set(['rules-v2']);

/** 单条 cue 码点上限（超限整条丢弃，不截断）。 */
export const CUE_MAX_CODEPOINTS = 40;
/** 单卡 cue 条数上限（保序取前 3，外审 3:1 裁定）。 */
export const CUE_MAX_COUNT = 3;
/** H7：cue 码点达到该值时执行 summary 字面子串反查。 */
export const H7_MIN_CODEPOINTS = 20;

/** 本批 rules_version 是否启用 cue 派生（生产恒 false 直到发布 rules-v2）。 */
export function isCueDerivationEnabled(rulesVersion: string): boolean {
  return CUE_DERIVATION_RULES.has(rulesVersion);
}

export interface CueDeriveInput {
  readonly keyPoints: readonly string[];
  readonly summary: string | null;
}

export interface CueDeriveResult {
  readonly cues: readonly string[];
  /** 遥测：≥40 码点被丢弃条数（上游摘要 prompt 漂移信号）。 */
  readonly droppedTooLong: number;
  /** 遥测：被 H7 子串反查丢弃条数。 */
  readonly droppedH7: number;
}

/**
 * H7 子串反查：原始形态与 NFKC 形态任一命中即丢。
 * 依据 docs/memory-v1-offline-scaffold-plan.md:502 —— 码点 ≥20 且被 summary 字面包含，整份拒绝。
 */
function hitsH7(raw: string, normalized: string, summary: string | null): boolean {
  if (summary === null) {
    return false;
  }
  for (const form of [raw, normalized]) {
    if ([...form].length >= H7_MIN_CODEPOINTS && summary.includes(form)) {
      return true;
    }
  }
  return false;
}

/**
 * key_points → cue 派生。空 key_points 返回空 cue 集（物化层据此回落空线索占位）。
 */
export function deriveCuesFromKeyPoints(input: CueDeriveInput): CueDeriveResult {
  const seen = new Set<string>();
  const cues: string[] = [];
  let droppedTooLong = 0;
  let droppedH7 = 0;

  for (const raw of input.keyPoints) {
    if (typeof raw !== 'string') {
      continue;
    }
    const normalized = normalizeLexicalText(raw);
    if (normalized === '') {
      continue;
    }
    // 去重保序（同一词重复出现只留首次）
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    // 超长整条丢弃：截断会造出原文不存在的词，且可能撞 H7 新串（外审 3:1）
    if ([...normalized].length > CUE_MAX_CODEPOINTS) {
      droppedTooLong += 1;
      continue;
    }
    // H7 硬约束：≥20 码点且被摘要字面包含 → 该条丢弃
    if (hitsH7(raw, normalized, input.summary)) {
      droppedH7 += 1;
      continue;
    }
    cues.push(normalized);
  }

  return { cues: cues.slice(0, CUE_MAX_COUNT), droppedTooLong, droppedH7 };
}

/**
 * cue 集的稳定哈希（进 planner 比对面）。
 * 空集 `[]` 与占位 `[""]` 哈希不同，便于区分"未派生"与"派生为空"。
 */
export function cuesHashOf(cues: readonly string[]): string {
  return sha256Hex(JSON.stringify([...cues]));
}
