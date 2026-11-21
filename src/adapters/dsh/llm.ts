/**
 * dsh 宿主的 LLM 端口实现（技术基线 §6.6）。
 *
 * 这是**唯一**调模型的地方 —— 内核（event / contract / source / core）只认
 * `src/event/llm-port.ts` 的接口，不认识宿主；本文件也不再 import 任何宿主包。
 *
 * 宿主纪律：**不硬编码 API key**，凭据来自宿主（OAuth 账号路由）。本文件只依赖
 * `DshModelRoute` 这层最小形状 —— 宿主怎么路由由宿主决定。
 *
 * 后台自管理循环（闭合 / 记忆投影两个 worker）已抽到宿主无关的
 * `src/assembly/recurring-worker.ts`，经 LifecyclePort / SchedulerPort / LoggerPort
 * 驱动；本文件只保留投影 drain 的轮询预算常量与模型端口本身。
 *
 * 已知宿主约束（阶段 4 文档 §13.3）：headless profile 的 bundle patch 显式
 * 禁用了凭据，`MISSING_CREDENTIAL` / `ACCOUNT_SIGN_IN_REQUIRED` 是必然结果 ——
 * **跑真实 LLM 必须走 web profile**。这是真机验收的事，不影响单元测试
 * （本文件对路由是注入的，测试用假路由）。
 */

import { withDeadline } from '../../core/deadline.ts';
import { UnavailableError } from '../../core/errors.ts';
import {
  AnchorSerialWireError,
  type LLMPort,
  type LLMSummarizeOptions,
  type LLMSummarizeRequest,
  type LLMSummarizeResponse,
  type WireBoundaryCandidate,
} from '../../event/llm-port.ts';
import { DEFAULT_CLOSURE_CALL_TIMEOUT_MS } from '../../event/params.ts';

/** 补全结果（路由**可以**只返回正文，也可以多报一个模型名）。 */
export type DshCompletionResult = string | { readonly text: string; readonly model?: string };

/** 宿主模型路由的最小形状（由 dsh 侧提供，实现走 OAuth 账号，不硬编码 API key）。 */
export interface DshModelRoute {
  /**
   * 发起一次对话补全。
   *
   * `signal` 可选：路由**应当**在收到 abort 时中断底层请求。
   * 不理会它的路由也不会拖死队列（调用方自己有时限闸），只是会留一个悬挂连接。
   */
  complete(req: { system: string; user: string; model?: string; signal?: AbortSignal }): Promise<DshCompletionResult>;
}

/** 端口构造选项。 */
export interface DshLLMPortOptions {
  /** 摘要模型（缺省 = 宿主默认模型）。 */
  readonly model?: string | undefined;
  /**
   * 没有 `signal` 时的自带兜底超时（毫秒）。
   *
   * 生产路径上超时闸在闭合管线（它拿得到注入的参数、也是队列活性的责任方），
   * 此处的兜底只为「有人绕过管线直调端口」这一种情形 —— 同默认值，不再另造一个数字。
   */
  readonly timeoutMs?: number | undefined;
}

/**
 * 构造走宿主模型路由的摘要端口。
 *
 * 超时与取消（设计稿 v1.1 §6.3.1 纪律①）：
 *  - 调用方给 `signal` → 原样透给路由，abort 时底层请求被取消；
 *  - 调用方没给 `signal` → 本端口自带的 `timeoutMs` 兜底。
 * 两种情况超时都抛 `UnavailableError`（不新增错误码），交由调用方退避重试。
 */
export function createDshLLMPort(route: DshModelRoute, options?: DshLLMPortOptions): LLMPort {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLOSURE_CALL_TIMEOUT_MS;

  return {
    async summarize(
      request: LLMSummarizeRequest,
      callOptions?: LLMSummarizeOptions,
    ): Promise<LLMSummarizeResponse> {
      const model = request.model ?? options?.model;
      const external = callOptions?.signal;

      const call = (signal: AbortSignal): Promise<DshCompletionResult> =>
        route.complete({
          system: request.system,
          user: request.user,
          ...(model === undefined ? {} : { model }),
          signal,
        });

      let raw: DshCompletionResult;
      try {
        // 有上级 signal = 上级已经管着时限（管线那条路径）→ 只透传、不重复计时；
        // 没有上级 signal = 有人绕过管线直调端口 → 自带兜底时限，绝不无限等。
        raw =
          external === undefined
            ? await withDeadline(timeoutMs, call, {
                timeoutError: () =>
                  new UnavailableError(`宿主模型路由超时（>${timeoutMs}ms 未返回，已中断）`),
              })
            : await call(external);
      } catch (error) {
        // withDeadline 已经给出「超时」语义，原样上抛（别再包一层）。
        if (error instanceof UnavailableError) {
          throw error;
        }
        // 上级 abort（或路由自己抛 AbortError）也归到「没回来」——
        // 与「模型报错」的排查方向完全不同（一个是没返回，一个是返回了错）。
        if (isAbort(error) || external?.aborted === true) {
          throw new UnavailableError('宿主模型路由调用被中止（未返回结果）', { cause: error });
        }
        // 端口不可用 → 抛既有的 UnavailableError（不新增错误码），交由调用方退避重试。
        throw new UnavailableError(`宿主模型路由调用失败：${(error as Error).message}`, { cause: error });
      }
      const text = typeof raw === 'string' ? raw : raw.text;
      const reported = typeof raw === 'string' ? undefined : raw.model;
      const response = parseSummaryPayload(text);
      // 溯源：优先信路由**实际**报出来的模型名；它没报就填我们请求的那个；
      // 连请求都没指定（宿主默认）→ 不填 → 落库为 null（不知道就是不知道）。
      const actual = reported ?? model;
      return actual === undefined ? response : { ...response, model: actual };
    },
  };
}

/** 判断错误是否是 abort（DOMException 名 / 带 name 的普通错误都要认）。 */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** 记忆投影 drain 轮询预算（毫秒）：与闭合管线预算各自独立，互不复用。 */
export const DEFAULT_MEMORY_PROJECTION_BUDGET_MS = 60_000;

/**
 * 解析模型正文为摘要结果。
 *
 * 模型按 system 提示返回 JSON；解析不出来就是**这次调用失败**（抛
 * UnavailableError），由调用方退避重试 —— 绝不返回半截内容或占位文案。
 */
function parseSummaryPayload(raw: string): LLMSummarizeResponse {
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
