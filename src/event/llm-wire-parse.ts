/**
 * LLM 摘要线协议的**宿主无关**解析（平台化 H3 自 dsh/llm.ts 抽出）。
 *
 * 同一份「模型正文 → LLMSummarizeResponse」结构性规则，dsh 宿主路由与 headless
 * OpenAI 兼容直连管道共用，避免两套strict 解析漂移。本文件零 I/O、零宿主包、
 * 零传输假设：它只认文本与线协议形状，怎么把请求发出去由各适配器自己负责。
 *
 * 纪律沿用定案稿 §4 / 技术基线 §6.6：
 *  - 模型按 system 提示返回 JSON；解析不出来就是**这次调用失败**（UnavailableError），
 *    绝不返回半截内容或占位文案；
 *  - `anchor_serials` 结构性 strict（数组＋安全整数，任一不符整份拒绝），
 *    1..N 范围 / 重复判定归 closure 序号表，适配器不知道 N；
 *  - `boundary_candidates` 是附带输出，畸形条目 fail-soft 丢弃、不拖垮摘要。
 */

import { UnavailableError } from '../core/errors.ts';
import {
  AnchorSerialWireError,
  type LLMSummarizeResponse,
  type WireBoundaryCandidate,
} from './llm-port.ts';

/**
 * 解析模型正文为摘要结果。
 *
 * 模型按 system 提示返回 JSON；解析不出来就是**这次调用失败**（抛
 * UnavailableError），由调用方退避重试 —— 绝不返回半截内容或占位文案。
 */
export function parseSummaryPayload(raw: string): LLMSummarizeResponse {
  const text = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UnavailableError(`模型返回不是合法 JSON：${(error as Error).message}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UnavailableError('模型返回的 JSON 不是对象');
  }
  const obj = parsed as Record<string, unknown>;
  const summary = obj['summary'];
  if (typeof summary !== 'string') {
    throw new UnavailableError('模型返回缺少 summary 字段');
  }
  // v1.4 · C7：话题跳转候选是**附带输出** —— 解析失败**不抛错**，
  // 只丢候选，摘要照常落盘（失败降级表第 4 行：不写半成品）。
  const candidates = parseWireBoundaryCandidates(obj['boundary_candidates']);
  return {
    summary,
    keyPoints: keyPoints_stringArray(obj['key_points']),
    anchor_serials: parseAnchorSerialsField(obj['anchor_serials']),
    ...(candidates.length === 0 ? {} : { boundary_candidates: candidates }),
  };
}

/** 结构性判据：安全整数（适配器层不知道 N，1..N 范围归 closure 序号表）。 */
function isSafeSerial(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function describeShape(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * 锚点序号字段结构性 strict 解析（定稿 §4）。
 *
 * 必须为数组；每元素 `typeof number && Number.isSafeInteger`；任一不符整份
 * 拒绝（不 filter、不半截、不 `Number()` 宽容转换），`3.0` 按值接受为 3。
 * **不做** 1..N 范围与重复判定 —— 那是 closure 侧 `resolveAnchorSerials` 的事。
 */
export function parseAnchorSerialsField(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    throw new AnchorSerialWireError(`anchor_serials 必须为数组，收到 ${describeShape(raw)}`);
  }
  const out: number[] = [];
  for (const item of raw) {
    if (!isSafeSerial(item)) {
      throw new AnchorSerialWireError(
        `anchor_serials 元素必须为安全整数，收到 ${describeShape(item)}`,
      );
    }
    out.push(item);
  }
  return out;
}

/**
 * 候选序号结构性 fail-soft 解析：畸形条目整条丢弃并计数；空 / 非数组不抛错。
 * 只做 `typeof number && Number.isSafeInteger` 结构校验；1..N 越界、重复等成员归属
 * 判定一律透传给 closure 侧 `resolveCandidateSerials` 统一 fail-soft，丢弃计数单点出口。
 * M=64 候选池上限只用于 closure 的 anchors 池 overflow 闸，不进适配器。
 */
export function parseBoundaryCandidateSerials(
  raw: unknown,
): { readonly serials: readonly number[]; readonly dropped: number } {
  if (!Array.isArray(raw)) {
    return { serials: [], dropped: 0 };
  }
  const serials: number[] = [];
  let dropped = 0;
  for (const item of raw) {
    if (isSafeSerial(item)) {
      serials.push(item);
    } else {
      dropped += 1;
    }
  }
  return { serials, dropped };
}

/**
 * 解析话题跳转候选线协议（v1.4 · C7 + L3 序号协议）。
 *
 * **绝不抛错** —— 候选是慢路径的附带输出，解析不了就不给：
 * 摘要照常落盘，候选当没有（失败降级表第 4 行：不写半成品）。
 *
 * 每条候选必须有安全整数 `at_pointer_serial` 与非空 `marked_at`；缺任一 →
 * 丢弃该条（不猜、不补）。`kind` 缺省为 '话题跳转'；**没有分数、没有置信度**。
 */
function parseWireBoundaryCandidates(value: unknown): WireBoundaryCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: WireBoundaryCandidate[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const serial = obj['at_pointer_serial'];
    const markedAt = obj['marked_at'];
    if (!isSafeSerial(serial)) {
      continue;
    }
    if (typeof markedAt !== 'string' || markedAt === '') {
      continue;
    }
    const kind = typeof obj['kind'] === 'string' && obj['kind'] !== '' ? obj['kind'] : '话题跳转';
    out.push({ kind, at_pointer_serial: serial, marked_at: markedAt });
  }
  return out;
}

/** 剥掉模型常见的 ```json 围栏 —— 只剥围栏，不动正文。 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\s*/, '');
  return withoutOpen.replace(/\s*```$/, '').trim();
}

/** 取字符串数组；非数组视作空数组（缺字段不该让整次调用失败）。仅 key_points 路径使用。 */
function keyPoints_stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}
