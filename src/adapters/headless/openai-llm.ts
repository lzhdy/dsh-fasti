/**
 * headless OpenAI 兼容直连 LLM 端口（平台化 H3）。
 *
 * 与 dsh 端口实现同一个内核契约 `LLMPort`，但**不依赖任何宿主包、零运行时依赖**：
 * 只发一个标准 OpenAI Chat Completions 请求。任何兼容该协议的端点都能直接插上：
 *  - 云端账号：填厂商 baseURL + apiKey + model；
 *  - 本地部署（Ollama / vLLM / LM Studio 等）：填本地网关 baseURL + model，无密钥就省略 apiKey。
 *
 * 设计纪律（与 dsh 端口对齐，不另造一套）：
 *  - 不硬编码温度 / maxTokens 等采样参数（YAGNI）；唯一例外是显式可选的 `reasoningEffort`
 *    （#154，与 dsh 同语义：不配置零漂移，配置了才发 OpenAI 协议键 `reasoning_effort`，
 *    字符串原样透传，合法取值由端点模型能力决定，本端口不做别名转换或静默裁剪），
 *    body 只发 model + 两条消息（+可选 reasoning_effort）；
 *  - 超时、取消与瞬态重试复用共享传输件 `requestWithRetry`（内部仍走 `withDeadline`）：
 *    有上级 signal 原样透传，没有就用 timeoutMs 兜底；429 与瞬时 5xx 在拿到 200 之前
 *    有限次退避重发同一 body，超时/取消不重试；
 *  - 传输失败 / abort / 非 2xx / 信封残缺 / 正文非法，统一归一为 `UnavailableError`，
 *    序号线错误（AnchorSerialWireError）原样上抛；错误信息不回显鉴权头，避免泄密钥；
 *  - 摘要正文的 strict 解析与 dsh 端口共用 `event/llm-wire-parse.ts`，规则不复制不漂移。
 *
 * fetch 可注入（options.fetchImpl）：测试用纯函数桩离线验证，非 Node 运行时也可塞入自带 HTTP 客户端；
 * 缺省取全局 fetch（Node 18+/22 内置）。
 */

import { UnavailableError } from '../../core/errors.ts';
import type {
  LLMPort,
  LLMSummarizeOptions,
  LLMSummarizeRequest,
  LLMSummarizeResponse,
} from '../../event/llm-port.ts';
import { parseSummaryPayload } from '../../event/llm-wire-parse.ts';
import { DEFAULT_CLOSURE_CALL_TIMEOUT_MS } from '../../event/params.ts';
import {
  buildCommonHeaders,
  endpointOf,
  extractAssistantContent,
  requestWithRetry,
  resolveGlobalFetch,
  toUnavailable,
  type FetchLike,
  type HttpRequestInit,
  type MinimalHttpResponse,
  type RetryPolicy,
  type SleepLike,
} from './openai-wire.ts';

/** 直连端口构造选项；全部为显式配置，不读宿主、不碰全局凭据库。 */
export interface OpenAICompatLLMPortOptions {
  /**
   * OpenAI 兼容端点根地址，需给到可拼接 `/chat/completions` 的完整前缀。
   * 例：`https://api.openai.com/v1`、`http://127.0.0.1:11434/v1`。
   * 末尾斜杠会被归一；不在此处擅自补 `/v1`，版本前缀由调用方给全。
   */
  readonly baseURL: string;
  /** 默认模型名（OpenAI `model` 字段）；单次 request.model 可覆盖。 */
  readonly model: string;
  /** API 密钥；本地无鉴权网关可省略，省略即不发送 Authorization 头。 */
  readonly apiKey?: string | undefined;
  /**
   * 可选推理档位（#154）：透传为 OpenAI 请求体 `reasoning_effort` 字符串。
   * 省略即不发该键（吃端点默认档，请求体与历史行为逐字节一致）；合法取值由端点决定。
   */
  readonly reasoningEffort?: string | undefined;
  /** 无上级 signal 时的自带兜底超时（毫秒），默认同闭合管线预算。 */
  readonly timeoutMs?: number | undefined;
  /** 注入 HTTP 客户端；缺省使用全局 fetch。 */
  readonly fetchImpl?: FetchLike | undefined;
  /**
   * 瞬态失败退避策略（429 与瞬时 5xx 单请求级重试）；省略用 DEFAULT_RETRY_POLICY。
   * 与对话 agent 共用同一份传输规则（openai-wire），不另造一套。
   */
  readonly retryPolicy?: RetryPolicy | undefined;
  /** 退避等待面：生产用 defaultSleep，红测注入假 sleep 保证确定性。 */
  readonly sleepImpl?: SleepLike | undefined;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessage[];
  reasoning_effort?: string;
}

/** 构造一个走 OpenAI 兼容 HTTP 端点的摘要端口（云端 / 本地同构，只差配置）。 */
export function createOpenAICompatLLMPort(options: OpenAICompatLLMPortOptions): LLMPort {
  const baseURL = options.baseURL.trim();
  const model = options.model.trim();
  if (baseURL.length === 0) {
    throw new TypeError('createOpenAICompatLLMPort：baseURL 不能为空（需含完整端点前缀，如 https://host/v1）');
  }
  if (model.length === 0) {
    throw new TypeError('createOpenAICompatLLMPort：model 不能为空');
  }

  const endpoint = endpointOf(baseURL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOSURE_CALL_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? resolveGlobalFetch();
  // 仅当显式配置时携带推理档；undefined 不产出该键，保持未配置时的零漂移。
  const reasoningEffort = options.reasoningEffort?.trim();

  const headers = buildCommonHeaders(options.apiKey);
  const retryPolicy = options.retryPolicy;
  const sleepImpl = options.sleepImpl;

  return {
    async summarize(
      request: LLMSummarizeRequest,
      callOptions?: LLMSummarizeOptions,
    ): Promise<LLMSummarizeResponse> {
      const chosenModel = request.model ?? model;
      const external = callOptions?.signal;
      const body: ChatCompletionRequestBody = {
        model: chosenModel,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      };
      const baseInit: HttpRequestInit = { method: 'POST', headers, body: JSON.stringify(body) };
      const call = (signal: AbortSignal): Promise<MinimalHttpResponse> =>
        fetchImpl(endpoint, { ...baseInit, signal });

      let response: MinimalHttpResponse;
      try {
        // 与对话 agent 共用同一份瞬态退避规则：拿到 200 之前有限次重发同一 body，超时/取消不重试。
        response = await requestWithRetry({
          send: call,
          timeoutMs,
          timeoutError: () =>
            new UnavailableError(`直连模型请求超时（>${timeoutMs}ms 未返回，已中断）：${endpoint}`),
          ...(external === undefined ? {} : { signal: external }),
          retry: {
            ...(retryPolicy === undefined ? {} : { policy: retryPolicy }),
            ...(sleepImpl === undefined ? {} : { sleep: sleepImpl }),
          },
        });
      } catch (error) {
        if (external?.aborted === true) {
          throw new UnavailableError('直连模型请求被中止（未返回结果）', { cause: error });
        }
        throw toUnavailable(error, '直连模型请求');
      }

      if (!response.ok) {
        // 只截一小段正文辅助定位；鉴权信息只在请求头里，不会出现在错误消息中。
        let snippet = '(响应正文不可读)';
        try {
          snippet = (await response.text()).slice(0, 200);
        } catch {
          // 读正文失败就保留占位，不掩盖原始 HTTP 失败。
        }
        throw new UnavailableError(`直连模型端点返回 HTTP ${response.status}：${snippet}`);
      }

      let rawText: string;
      try {
        rawText = await response.text();
      } catch (error) {
        throw new UnavailableError('直连模型响应正文读取失败', { cause: error });
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(rawText);
      } catch (error) {
        throw new UnavailableError('直连模型响应不是合法的 JSON 信封', { cause: error });
      }

      const { content, reportedModel } = extractAssistantContent(envelope);
      if (content === undefined) {
        throw new UnavailableError('直连模型响应缺少 choices[0].message.content 字符串');
      }

      // 线协议 strict 解析与 dsh 端口同源：缺字段 → UnavailableError，序号非法 → AnchorSerialWireError。
      const parsed = parseSummaryPayload(content);
      const actualModel = reportedModel ?? chosenModel;
      return { ...parsed, model: actualModel };
    },
  };
}
