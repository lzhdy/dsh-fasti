/**
 * OpenAI 兼容线的公共传输积木（headless 适配器内部共享）。
 *
 * 摘要端口（openai-llm）与对话 agent 客户端（openai-agent）走同一个 Chat Completions
 * HTTP 形状，传输纪律也必须逐字一致：无 key 不发 Authorization、失败归一
 * UnavailableError、错误消息不带鉴权头。共享件放这里，规则只写一份，不允许两个
 * 适配器各抄一份后漂移。本文件零运行时依赖、不认识任何业务契约。
 */

import { UnavailableError } from '../../core/errors.ts';

/** 最小 HTTP 响应面（全局 Response 与测试桩都满足，不绑定 undici 具体类型）。 */
export interface MinimalHttpResponse {
  readonly ok: boolean;
  readonly status: number;
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
