/**
 * headless OpenAI 兼容直连 LLM 端口（平台化 H3）。
 *
 * 与 dsh 端口实现同一个内核契约 `LLMPort`，但**不依赖任何宿主包、零运行时依赖**：
 * 只发一个标准 OpenAI Chat Completions 请求。任何兼容该协议的端点都能直接插上：
 *  - 云端账号：填厂商 baseURL + apiKey + model；
 *  - 本地部署（Ollama / vLLM / LM Studio 等）：填本地网关 baseURL + model，无密钥就省略 apiKey。
 *
 * 设计纪律（与 dsh 端口对齐，不另造一套）：
 *  - 不硬编码温度 / maxTokens 等采样参数（YAGNI），body 只发 model + 两条消息；
 *  - 超时与取消复用 `withDeadline`：有上级 signal 原样透传，没有就用 timeoutMs 兜底；
 *  - 传输失败 / abort / 非 2xx / 信封残缺 / 正文非法，统一归一为 `UnavailableError`，
 *    序号线错误（AnchorSerialWireError）原样上抛；错误信息不回显鉴权头，避免泄密钥；
 *  - 摘要正文的 strict 解析与 dsh 端口共用 `event/llm-wire-parse.ts`，规则不复制不漂移。
 *
 * fetch 可注入（options.fetchImpl）：测试用纯函数桩离线验证，非 Node 运行时也可塞入自带 HTTP 客户端；
 * 缺省取全局 fetch（Node 18+/22 内置）。
 */

import { withDeadline } from '../../core/deadline.ts';
import { UnavailableError } from '../../core/errors.ts';
import type {
  LLMPort,
  LLMSummarizeOptions,
  LLMSummarizeRequest,
  LLMSummarizeResponse,
} from '../../event/llm-port.ts';
import { parseSummaryPayload } from '../../event/llm-wire-parse.ts';
import { DEFAULT_CLOSURE_CALL_TIMEOUT_MS } from '../../event/params.ts';

/** 本端口只用到的最小 HTTP 响应面（全局 Response 与测试桩都满足，不绑定 undici 具体类型）。 */
export interface MinimalHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** 本端口发出的请求形状。 */
export interface HttpRequestInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** 最小 fetch 面：全局 fetch 结构兼容，测试可注入纯函数桩，绝不起真实 socket。 */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<MinimalHttpResponse>;

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
  /** 无上级 signal 时的自带兜底超时（毫秒），默认同闭合管线预算。 */
  readonly timeoutMs?: number | undefined;
  /** 注入 HTTP 客户端；缺省使用全局 fetch。 */
  readonly fetchImpl?: FetchLike | undefined;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessage[];
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

  const endpoint = `${baseURL.replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOSURE_CALL_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? resolveGlobalFetch();

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.apiKey !== undefined && options.apiKey.length > 0) {
    headers['authorization'] = `Bearer ${options.apiKey}`;
  }

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
      };
      const baseInit: HttpRequestInit = { method: 'POST', headers, body: JSON.stringify(body) };
      const call = (signal: AbortSignal): Promise<MinimalHttpResponse> =>
        fetchImpl(endpoint, { ...baseInit, signal });

      let response: MinimalHttpResponse;
      try {
        // 与 dsh 端口同一套超时纪律：上级管着时限就只透传，否则自带兜底，绝不无限等。
        response =
          external === undefined
            ? await withDeadline(timeoutMs, call, {
                timeoutError: () =>
                  new UnavailableError(`直连模型请求超时（>${timeoutMs}ms 未返回，已中断）：${endpoint}`),
              })
            : await call(external);
      } catch (error) {
        if (error instanceof UnavailableError) {
          throw error;
        }
        if (isAbort(error) || external?.aborted === true) {
          throw new UnavailableError('直连模型请求被中止（未返回结果）', { cause: error });
        }
        throw new UnavailableError(`直连模型请求失败：${(error as Error).message}`, { cause: error });
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

/** 从 Chat Completions 响应信封里安全取出首个候选的字符串正文与回报模型名。 */
function extractAssistantContent(envelope: unknown): {
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
function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
  );
}

/** 取全局 fetch；运行时若无内置 fetch（且未注入），给出可操作的明确报错而非神秘 TypeError。 */
function resolveGlobalFetch(): FetchLike {
  const global = globalThis as { fetch?: FetchLike };
  if (typeof global.fetch !== 'function') {
    throw new TypeError(
      '当前运行时没有可用的全局 fetch，请通过 options.fetchImpl 注入兼容的 HTTP 客户端',
    );
  }
  return global.fetch;
}
