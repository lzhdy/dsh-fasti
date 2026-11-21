/**
 * headless OpenAI 兼容通用聊天客户端（对话第一刀：node 身体直连模型与用户对话）。
 *
 * 与摘要端口 `openai-llm.ts` 的分工：
 *  - 摘要端口实现内核 `LLMPort` 契约，请求形状被摘要协议锁死（固定两条消息、解析摘要 JSON）；
 *  - 本客户端是**通用对话管道**：调用方给任意长度的 messages，原样发 Chat Completions，
 *    只拿回模型正文字符串，不做任何业务解析。
 *
 * 纪律与摘要端口同源（共享 openai-wire 积木）：
 *  - 零运行时依赖、无 key 不发 Authorization、失败一律归一 UnavailableError；
 *  - 不硬编码温度/maxTokens；第一刀**绝不发 tools 字段**（function-calling 属后续刀），
 *    请求体恒为 {model, messages} 两个键；
 *  - 不内置 system prompt：说什么人设/规则是装配策略，由 node 身体显式传入。
 */

import { withDeadline } from '../../core/deadline.ts';
import { UnavailableError } from '../../core/errors.ts';
import {
  buildCommonHeaders,
  endpointOf,
  extractAssistantContent,
  resolveGlobalFetch,
  toUnavailable,
  type FetchLike,
  type HttpRequestInit,
  type MinimalHttpResponse,
} from './openai-wire.ts';

/** 自带兜底超时（毫秒），与闭合管线同量级；上级 signal 在场时由上级管时限。 */
const DEFAULT_CHAT_TIMEOUT_MS = 60_000;

/** 一条聊天消息（OpenAI role 三子集；第一刀没有 tool 角色）。 */
export interface OpenAIChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** 通用聊天客户端结构面；node 身体经此注入机制层，机制层不认识 headless。 */
export interface OpenAIChatClient {
  /** 配置的模型名（信封回显/日志用）。 */
  readonly modelName: string;
  /** 发一轮对话，返回模型正文与回报模型名。 */
  complete(
    messages: readonly OpenAIChatMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<{ content: string; model: string }>;
}

/** 构造选项与摘要端口同形（baseURL 须含 /v1 前缀；无密钥网关省略 apiKey）。 */
export interface OpenAIChatClientOptions {
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}

/** 构造一个通用 OpenAI 兼容聊天客户端（云端 / 本地网关同构）。 */
export function createOpenAIChatClient(options: OpenAIChatClientOptions): OpenAIChatClient {
  const baseURL = options.baseURL.trim();
  const model = options.model.trim();
  if (baseURL.length === 0) {
    throw new TypeError('createOpenAIChatClient：baseURL 不能为空（需含完整端点前缀，如 https://host/v1）');
  }
  if (model.length === 0) {
    throw new TypeError('createOpenAIChatClient：model 不能为空');
  }

  const endpoint = endpointOf(baseURL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? resolveGlobalFetch();
  const headers = buildCommonHeaders(options.apiKey);

  return {
    modelName: model,
    async complete(messages, callOptions) {
      const external = callOptions?.signal;
      // 第一刀定死：请求体只有 model + messages，不带 tools/采样参数。
      const body: { model: string; messages: readonly OpenAIChatMessage[] } = { model, messages };
      const baseInit: HttpRequestInit = { method: 'POST', headers, body: JSON.stringify(body) };
      const call = (signal: AbortSignal): Promise<MinimalHttpResponse> =>
        fetchImpl(endpoint, { ...baseInit, signal });

      let response: MinimalHttpResponse;
      try {
        response =
          external === undefined
            ? await withDeadline(timeoutMs, call, {
                timeoutError: () =>
                  new UnavailableError(`聊天模型请求超时（>${timeoutMs}ms 未返回，已中断）：${endpoint}`),
              })
            : await call(external);
      } catch (error) {
        if (external?.aborted === true) {
          throw new UnavailableError('聊天模型请求被中止（未返回结果）', { cause: error });
        }
        throw toUnavailable(error, '聊天模型请求');
      }

      if (!response.ok) {
        let snippet = '(响应正文不可读)';
        try {
          snippet = (await response.text()).slice(0, 200);
        } catch {
          // 读正文失败保留占位，不掩盖原始 HTTP 失败。
        }
        throw new UnavailableError(`聊天模型端点返回 HTTP ${response.status}：${snippet}`);
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(await response.text());
      } catch (error) {
        throw new UnavailableError('聊天模型响应不是合法的 JSON 信封', { cause: error });
      }

      const { content, reportedModel } = extractAssistantContent(envelope);
      if (content === undefined || content === '') {
        throw new UnavailableError('聊天模型响应缺少非空 choices[0].message.content 字符串');
      }
      return { content, model: reportedModel ?? model };
    },
  };
}
