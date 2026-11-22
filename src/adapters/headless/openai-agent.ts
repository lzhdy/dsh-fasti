/**
 * headless OpenAI 兼容 function-calling 客户端（对话第二刀：node 身体自带 agent 回路）。
 *
 * dsh 时代"模型决定调工具 → 宿主执行 → 结果回灌 → 再问一轮"的循环由外部 dsh-agent
 * 承担；dsh 拿掉后由本客户端在 node 身体内自跑，且不依赖任何宿主包。
 *
 * 安全纪律（与 openai-llm 同源，共享 openai-wire）：
 *  - 请求体缺省恒为 {model, messages, tools} 三键，不发 tool_choice（缺省 auto）与温度等采样参数；
 *    唯一可选第四键是 reasoning_effort（#154）：显式配置 reasoningEffort 才发出，每轮请求都带，
 *    字符串原样透传、不配置则零漂移，合法取值由端点模型能力决定；
 *  - 只认 OpenAI function 形状（type 恒 'function'），工具执行体由调用方注入，本模块不内置
 *    任何业务工具，也不知道记忆门/真源的存在；
 *  - 工具轮次硬顶 MAX_AGENT_TOOL_ROUNDS：防模型陷入工具死循环烧 token，超限归一
 *    UnavailableError（上层 HTTP 映射 502，用户话已在真源、不写假助手行）；
 *  - 模型回的 tool_call 形状在边界做确定性归一：缺 id 补合成 id、坏形状不触达执行器，
 *    统一回 {ok:false,error:{code,message}} 字符串信封让模型自纠，绝不让脏线协议炸回路；
 *  - 执行器自身抛错同样归一封装，不泄漏堆栈/内部路径；
 *  - 无 key 不发 Authorization，传输/信封失败一律 UnavailableError。
 */

import { withDeadline } from '../../core/deadline.ts';
import { UnavailableError } from '../../core/errors.ts';
import {
  buildCommonHeaders,
  endpointOf,
  resolveGlobalFetch,
  toUnavailable,
  type FetchLike,
  type HttpRequestInit,
  type MinimalHttpResponse,
} from './openai-wire.ts';

/** 自带兜底超时（毫秒），每次模型 HTTP 调用独立计时。 */
const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

/**
 * 工具调用轮次硬顶：一次 run 内最多容忍 5 个"模型要求调工具"的回包（每轮可并行多工具），
 * 第 6 个工具回包直接判失败。写死、外部不可配——这是身体的成本/安全闸。
 */
export const MAX_AGENT_TOOL_ROUNDS = 5;

/** 调用方声明的工具：OpenAI function 的宿主中立形状。 */
export interface OpenAIAgentTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema 参数定义（原样放进 function.parameters）。 */
  readonly parameters: Record<string, unknown>;
}

/** 归一后交给执行器的一次工具调用；argumentsText 是模型给的原始 JSON 字符串。 */
export interface OpenAIAgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsText: string;
}

/** 工具执行器：返回放进 role:'tool' 消息的字符串正文（约定为 JSON 信封）。 */
export type OpenAIAgentExecutor = (call: OpenAIAgentToolCall) => Promise<string>;

/** 入口消息（system/user/assistant 三角色，正文必填字符串）。 */
export interface OpenAIAgentInputMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** agent 客户端结构面；node 身体经此注入，机制层不认识 headless。 */
export interface OpenAIAgentClient {
  readonly modelName: string;
  run(
    input: {
      readonly messages: readonly OpenAIAgentInputMessage[];
      readonly tools: readonly OpenAIAgentTool[];
      readonly execute: OpenAIAgentExecutor;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ content: string; model: string }>;
}

/** 构造选项与聊天客户端同形。 */
export interface OpenAIAgentClientOptions {
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string | undefined;
  /**
   * 可选推理档位（#154）：透传为每轮请求体的 `reasoning_effort` 字符串。
   * 省略即不发该键（吃端点默认档，请求体保持三键零漂移）；合法取值由端点决定。
   */
  readonly reasoningEffort?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}

// ── 线协议内部形状（不对外导出，出了本文件都经 JSON 序列化）──

interface WireToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_calls?: readonly WireToolCall[];
  readonly tool_call_id?: string;
}

interface NormalizedCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsText: string;
  /** 形状非法时不触达执行器，直接回 schema 信封（id 可能为边界补的合成 id）。 */
  readonly invalid: boolean;
}

function envelopeFail(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 归一模型回包里的 tool_calls。
 * 缺 id 时补确定性合成 id（保证回灌的 tool 消息能在同一 assistant 消息里找到配对）；
 * function/name/arguments 形状非法的条目标记 invalid，绝不投递执行器。
 */
function normalizeToolCalls(raw: unknown, round: number): NormalizedCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry, index): NormalizedCall => {
    const syntheticId = `rejected-${round}-${index}`;
    if (!isPlainObject(entry)) {
      return { id: syntheticId, name: '', argumentsText: '', invalid: true };
    }
    // 缺 id 本身即非法：合成 id 只用于回灌配对，该条仍判 invalid、不触达执行器。
    const hasValidId = typeof entry['id'] === 'string' && entry['id'].length > 0;
    const id = hasValidId ? (entry['id'] as string) : syntheticId;
    const fn = entry['function'];
    if (!isPlainObject(fn)) {
      return { id, name: '', argumentsText: '', invalid: true };
    }
    const name = fn['name'];
    const args = fn['arguments'];
    if (typeof name !== 'string' || name.length === 0 || typeof args !== 'string') {
      return { id, name: typeof name === 'string' ? name : '', argumentsText: '', invalid: true };
    }
    return { id, name, argumentsText: args, invalid: !hasValidId };
  });
}

/** 构造一个 OpenAI 兼容 function-calling 客户端。 */
export function createOpenAIAgentClient(options: OpenAIAgentClientOptions): OpenAIAgentClient {
  const baseURL = options.baseURL.trim();
  const model = options.model.trim();
  if (baseURL.length === 0) {
    throw new TypeError('createOpenAIAgentClient：baseURL 不能为空（需含完整端点前缀，如 https://host/v1）');
  }
  if (model.length === 0) {
    throw new TypeError('createOpenAIAgentClient：model 不能为空');
  }

  const endpoint = endpointOf(baseURL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? resolveGlobalFetch();
  const headers = buildCommonHeaders(options.apiKey);
  // 仅当显式配置时携带推理档；空白与 undefined 都不产出该键，保持未配置时的三键零漂移。
  const reasoningEffort = options.reasoningEffort?.trim();

  return {
    modelName: model,
    async run(input, callOptions) {
      const tools = input.tools;
      if (!Array.isArray(tools) || tools.length === 0) {
        throw new TypeError('agent run：tools 必须是非空数组（无工具场景请用纯聊天客户端）');
      }
      const knownNames = new Set<string>();
      const wireTools = tools.map((tool) => {
        if (
          typeof tool.name !== 'string' || tool.name.length === 0
          || typeof tool.description !== 'string' || tool.description.length === 0
          || !isPlainObject(tool.parameters)
        ) {
          throw new TypeError('agent run：每个工具须含非空 name/description 与对象型 parameters');
        }
        knownNames.add(tool.name);
        return {
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        };
      });

      const convo: WireMessage[] = input.messages.map((message) => ({ role: message.role, content: message.content }));
      const external = callOptions?.signal;
      let toolRounds = 0;

      while (true) {
        // body 在循环内构造：每一轮工具回灌后都重新携带同一组键（含可选 reasoning_effort）。
        const body = {
          model,
          messages: convo,
          tools: wireTools,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        };
        const init: HttpRequestInit = { method: 'POST', headers, body: JSON.stringify(body) };
        const call = (signal: AbortSignal): Promise<MinimalHttpResponse> => fetchImpl(endpoint, { ...init, signal });

        let response: MinimalHttpResponse;
        try {
          response =
            external === undefined
              ? await withDeadline(timeoutMs, call, {
                  timeoutError: () =>
                    new UnavailableError(`agent 模型请求超时（>${timeoutMs}ms 未返回，已中断）：${endpoint}`),
                })
              : await call(external);
        } catch (error) {
          if (external?.aborted === true) {
            throw new UnavailableError('agent 模型请求被中止（未返回结果）', { cause: error });
          }
          throw toUnavailable(error, 'agent 模型请求');
        }

        if (!response.ok) {
          let snippet = '(响应正文不可读)';
          try {
            snippet = (await response.text()).slice(0, 200);
          } catch {
            // 读正文失败保留占位，不掩盖原始 HTTP 失败。
          }
          throw new UnavailableError(`agent 模型端点返回 HTTP ${response.status}：${snippet}`);
        }

        let envelope: unknown;
        try {
          envelope = JSON.parse(await response.text());
        } catch (error) {
          throw new UnavailableError('agent 模型响应不是合法的 JSON 信封', { cause: error });
        }

        const root = isPlainObject(envelope) ? envelope : {};
        const reportedModel = typeof root['model'] === 'string' ? root['model'] : undefined;
        const choices = root['choices'];
        const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
        const message = isPlainObject(firstChoice) ? firstChoice['message'] : undefined;
        const messageObj = isPlainObject(message) ? message : {};
        const normalized = normalizeToolCalls(messageObj['tool_calls'], toolRounds + 1);

        // 无工具调用：本应收口为纯正文。
        if (normalized.length === 0) {
          const content = messageObj['content'];
          if (typeof content !== 'string' || content === '') {
            throw new UnavailableError('agent 模型响应既无 tool_calls 也无非空 content 字符串');
          }
          return { content, model: reportedModel ?? model };
        }

        // 工具轮次硬顶：第 MAX+1 个工具回包不再执行、不再请求。
        toolRounds += 1;
        if (toolRounds > MAX_AGENT_TOOL_ROUNDS) {
          throw new UnavailableError(
            `工具调用轮次超过硬顶 ${MAX_AGENT_TOOL_ROUNDS} 轮，已中断（防工具死循环）`,
          );
        }

        // 先把 assistant 的工具调用原样（归一后）回灌，tool 结果才能配对。
        convo.push({
          role: 'assistant',
          content: typeof messageObj['content'] === 'string' ? messageObj['content'] : null,
          tool_calls: normalized.map((item) => ({
            id: item.id,
            type: 'function' as const,
            function: { name: item.name, arguments: item.argumentsText },
          })),
        });

        // 逐条执行（并行回包也按数组顺序处理，结果彼此独立）。
        for (const item of normalized) {
          let resultText: string;
          if (item.invalid) {
            resultText = envelopeFail('schema', '工具调用形状非法：缺 id/函数名或参数不是字符串，请按工具 schema 修正后重试。');
          } else if (!knownNames.has(item.name)) {
            resultText = envelopeFail('schema', `未知工具名 ${item.name}，只能调用本次声明的工具。`);
          } else {
            try {
              resultText = await input.execute({ id: item.id, name: item.name, argumentsText: item.argumentsText });
              if (typeof resultText !== 'string' || resultText.length === 0) {
                resultText = envelopeFail('internal', '工具执行返回了空结果，请重试或改用普通检索。');
              }
            } catch {
              // 执行器错误不泄漏内部细节：统一稳定码，回路继续给模型自纠机会。
              resultText = envelopeFail('internal', '工具执行失败，请重试或改用普通检索。');
            }
          }
          convo.push({ role: 'tool', tool_call_id: item.id, content: resultText });
        }
      }
    },
  };
}
