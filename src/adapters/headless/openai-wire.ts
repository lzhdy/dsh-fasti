/**
 * OpenAI 兼容线的公共传输积木（headless 适配器内部共享）。
 *
 * 摘要端口（openai-llm）与对话 agent 客户端（openai-agent）走同一个 Chat Completions
 * HTTP 形状，传输纪律也必须逐字一致：无 key 不发 Authorization、失败归一
 * UnavailableError、错误消息不带鉴权头。共享件放这里，规则只写一份，不允许两个
 * 适配器各抄一份后漂移。本文件零运行时依赖、不认识任何业务契约。
 */

import { withDeadline } from '../../core/deadline.ts';
import { UnavailableError } from '../../core/errors.ts';

/** 最小响应头读取面：全局 `Response.headers` 原生满足；测试桩可省略（视为「无该头」）。 */
export interface MinimalHeadersLike {
  get(name: string): string | null;
}

/** 最小 HTTP 响应面（全局 Response 与测试桩都满足，不绑定 undici 具体类型）。 */
export interface MinimalHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  /** 可选：仅用于读 `Retry-After`。注入方不给这个面时按「无该头」处理，不强制改造旧桩。 */
  readonly headers?: MinimalHeadersLike | undefined;
  text(): Promise<string>;
}

/** 发出的请求形状。 */
export interface HttpRequestInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** 最小 fetch 面：全局 fetch 结构兼容，测试可注入纯函数桩，绝不起真实 socket。 */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<MinimalHttpResponse>;

/** 归一端点前缀并拼出 chat/completions 全路径（末尾斜杠容错，不擅自补 /v1）。 */
export function endpointOf(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/chat/completions`;
}

/** 公共请求头：仅 content-type；有非空 key 才带 authorization。 */
export function buildCommonHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey !== undefined && apiKey.length > 0) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/** 从 Chat Completions 响应信封里安全取出首个候选的字符串正文与回报模型名。 */
export function extractAssistantContent(envelope: unknown): {
  content?: string;
  reportedModel?: string;
} {
  if (typeof envelope !== 'object' || envelope === null) {
    return {};
  }
  const root = envelope as Record<string, unknown>;
  const reportedModel = typeof root['model'] === 'string' ? (root['model'] as string) : undefined;
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return { reportedModel };
  }
  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    return { reportedModel };
  }
  const message = (first as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) {
    return { reportedModel };
  }
  const content = (message as Record<string, unknown>)['content'];
  return typeof content === 'string' ? { content, reportedModel } : { reportedModel };
}

/** 判断错误是否是 abort（DOMException 名 / 带 name 的普通错误都要认）。 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
  );
}

/** 把传输层/信封层失败统一归一成 UnavailableError（abort 单独给消息）。 */
export function toUnavailable(error: unknown, prefix: string): UnavailableError {
  if (error instanceof UnavailableError) {
    return error;
  }
  if (isAbortError(error)) {
    return new UnavailableError(`${prefix}被中止（未返回结果）`, { cause: error });
  }
  return new UnavailableError(`${prefix}失败：${(error as Error).message}`, { cause: error });
}

/** 取全局 fetch；运行时若无内置 fetch（且未注入），给出可操作的明确报错。 */
export function resolveGlobalFetch(): FetchLike {
  const global = globalThis as { fetch?: FetchLike };
  if (typeof global.fetch !== 'function') {
    throw new TypeError(
      '当前运行时没有可用的全局 fetch，请通过 options.fetchImpl 注入兼容的 HTTP 客户端',
    );
  }
  return global.fetch;
}

// ── 瞬态失败退避重试（2026-11-24）：规则只写一份，两个适配器共用 ──
//
// 为什么在「单请求」这一层重试，而不是在 /chat 最外层整次重发：
//  · Chat Completions 是无提交副作用的推理请求，同一 body 再发一遍不会产生重复数据；
//  · 工具执行发生在拿到 200 之后（openai-agent 的 execute），退避层根本够不到执行器，
//    所以工具副作用不可能被重放；真源写入在更外层，更不会被碰到；
//  · 一旦拿到 200 就进入解析/回灌阶段，不再退避 —— 语义与现状逐字一致。

/** 退避参数：额外重试次数与确定性指数退避的起点/封顶。 */
export interface RetryPolicy {
  /** 额外重试次数（不含首发）：默认 2，即一个请求最多发出 3 次。 */
  readonly maxRetries: number;
  /** 指数退避起点（毫秒）。 */
  readonly baseDelayMs: number;
  /** 指数退避单次封顶（毫秒）。 */
  readonly maxDelayMs: number;
}

/** 默认策略：500ms 起、倍率 2、封顶 2s；无 `Retry-After` 时两次等待合计 1.5s，交互可接受。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 2_000,
});

/** 服务器 `Retry-After` 的采纳上限：再久也不让一次对话挂太久。 */
export const RETRY_AFTER_CAP_MS = 5_000;

/**
 * 可重试状态码白名单（保守，不做无脑全重试）：
 * 429 限流必重试；5xx 只认瞬时网关类 500/502/503/504。
 * 401/403 这类鉴权/请求本身的问题重试只会白烧额度，一律立即放弃。
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * 解析 `Retry-After`：支持「秒数」与「HTTP-date」两种格式（RFC 7231）。
 * 返回毫秒；缺失、非法、负数、非整数一律返回 null（调用方回退指数退避）。
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return null;
    return seconds * 1000;
  }
  // 只有「带字母」的串才可能是 HTTP-date；`Date.parse` 对 `-1`、`1.5` 之类过于宽松，
  // 不先收紧会把明显非法的值解析成日期（实测 `-1` 会落到某个过去时刻）。
  if (!/[A-Za-z]/.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, parsed - nowMs);
}

/** 第 `attempt` 次失败后应等多久（attempt 从 1 起；<=1 视作首次，均按起点计）。 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}

/**
 * 本次重试的等待时长：优先尊重服务器 `Retry-After`（夹到 `RETRY_AFTER_CAP_MS`），
 * 缺失或非法则回退确定性指数退避。不做随机抖动——单机单用户没有惊群问题，
 * 确定性更利于离线逐项断言与复现。
 */
export function retryDelayMsFor(
  status: number,
  retryAfterMs: number | null,
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  }
  return backoffDelayMs(attempt, policy);
}

/** 等待面：生产用 `defaultSleep`，红测注入「记录毫秒、立即返回」的假 sleep，不真实等待。 */
export type SleepLike = (ms: number, signal?: AbortSignal) => Promise<void>;

/** abort 感知的默认等待：被上级取消时立即以 AbortError 退出，不把取消拖到等待结束。 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abortError = (): Error => {
      const error = new Error('sleep aborted');
      error.name = 'AbortError';
      return error;
    };
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 一次重试的可观测信息（只给外部做日志/观测，不得借此改动控制流）。 */
export interface RetryAttemptInfo {
  /** 第几次失败（1 起）。 */
  readonly attempt: number;
  /** 触发重试的 HTTP 状态码（传输层 reject 不会走到这里）。 */
  readonly status: number;
  /** 本次实际等待的毫秒。 */
  readonly delayMs: number;
}

/** `requestWithRetry` 的可选面。 */
export interface RequestWithRetryRetryOptions {
  readonly policy?: RetryPolicy | undefined;
  readonly sleep?: SleepLike | undefined;
  /** 时钟注入（仅用于解析 HTTP-date 形式的 Retry-After），默认 `Date.now`。 */
  readonly now?: (() => number) | undefined;
  readonly onRetry?: ((info: RetryAttemptInfo) => void) | undefined;
}

/** `requestWithRetry` 入参。 */
export interface RequestWithRetryInput {
  /** 发一次请求；每次尝试都会拿到一个全新的 signal。 */
  readonly send: (signal: AbortSignal) => Promise<MinimalHttpResponse>;
  /** 单次尝试的兜底时限（毫秒）；每次尝试独立计时。 */
  readonly timeoutMs: number;
  /** 到时限时构造的错误（由调用方决定类型与文案）。 */
  readonly timeoutError: () => Error;
  /** 上级取消信号：已中止时绝不重试，立即原样上抛。 */
  readonly signal?: AbortSignal | undefined;
  readonly retry?: RequestWithRetryRetryOptions | undefined;
}

/** 安全读一个响应头；注入方不给 headers 面时按「无该头」处理。 */
function headerOf(response: MinimalHttpResponse, name: string): string | null {
  const headers = response.headers;
  if (headers === undefined || typeof headers.get !== 'function') return null;
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

/**
 * 发一次请求，遇瞬态失败按 `RetryPolicy` 有限次退避重试，返回**最终那次**响应（可能仍非 2xx）。
 *
 * 三类退出条件：
 *  - 拿到可用的 2xx / 不可重试的状态码 / 重试次数用尽 → 返回响应，由调用方按原逻辑处理；
 *  - 超时或被上级取消 → 直接抛错不重试（一次都等不满，再试只会成倍拖长）；
 *  - 其余传输层失败（连接重置等）→ 视为瞬态，计入重试预算。
 */
export async function requestWithRetry(input: RequestWithRetryInput): Promise<MinimalHttpResponse> {
  const policy = input.retry?.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = input.retry?.sleep ?? defaultSleep;
  const now = input.retry?.now ?? Date.now;
  const onRetry = input.retry?.onRetry;
  const external = input.signal;

  let attempt = 0;
  /** 记录本次尝试的「超时错误」引用，用于把它与传输层失败区分开（超时不重试）。 */
  let timeoutErrorOfThisAttempt: Error | undefined;

  while (true) {
    attempt += 1;
    let response: MinimalHttpResponse;
    try {
      response = await withDeadline(input.timeoutMs, input.send, {
        signal: external,
        timeoutError: () => {
          timeoutErrorOfThisAttempt = input.timeoutError();
          return timeoutErrorOfThisAttempt;
        },
      });
    } catch (error) {
      // 上级取消：立即退出，绝不重试（用户/上层已经不要这个结果了）。
      if (external?.aborted === true) throw error;
      // 中止语义（fetch 自身 AbortError）同样不重试：重试等于把已经撤掉的请求再发一遍。
      if (isAbortError(error)) throw error;
      if (error === timeoutErrorOfThisAttempt) throw error;
      if (attempt > policy.maxRetries) throw error;
      await sleep(backoffDelayMs(attempt, policy), external);
      continue;
    }

    if (response.ok || !isRetryableStatus(response.status) || attempt > policy.maxRetries) {
      return response;
    }

    const delayMs = retryDelayMsFor(
      response.status,
      parseRetryAfterMs(headerOf(response, 'retry-after'), now()),
      attempt,
      policy,
    );
    onRetry?.({ attempt, status: response.status, delayMs });
    await sleep(delayMs, external);
  }
}
