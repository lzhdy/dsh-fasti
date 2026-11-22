/**
 * node 身体的对话编排（对话第二刀：agent 回路＋固定 on 记忆工具）。
 *
 * 本模块是 node 适配器内的装配策略，**不是机制层**：
 *  - 只依赖 node 内置 + 内核门面的结构化面，不 import headless 或任何兄弟适配器
 *    （具体 OpenAI 客户端由 serve.ts 组合根注入）；
 *  - 一轮对话的固定次序：用户话先落真源 → 从真源重建近期上下文 → 开请求级工具会话、
 *    跑 function-calling 回路 → 最终助手回话落真源。模型失败时用户话仍保留，绝不写伪造行。
 *
 * 红线口径：
 *  - system prompt 固定中性、不注人设（CHAT_SYSTEM_PROMPT），不提供 env 覆盖口子；
 *  - 历史只从真源 readRecentRawTurns 重建，不信任客户端投递的任何"上下文"；
 *  - 工具中间轮（assistant tool_calls/role:tool 消息）只存在于本次模型回路，
 *    **不进真源**：append-only 真源只留用户原话与助手最终正文两条；
 *  - 工具会话每请求新建，私有序号表不跨请求；模型只能经白名单信封碰记忆，碰不到真源写。
 */

import { randomBytes } from 'node:crypto';

import type { Fasti } from '../../api/index.ts';
import { SHARED_SYSTEM_PROMPT } from '../../contract/system-prompts.ts';

/**
 * 固定中性 system prompt（#154 收口）：本通道不再持有专属提示词文本，
 * 直接引用契约层唯一母本 SHARED_SYSTEM_PROMPT——与 dsh complete 段同一常量、
 * 同一段英文，改文本只须改契约层那一处。无身份句、不提供 env 覆盖口子；
 * 字面冻结与单点定义守卫见 tests/contract/system-prompts.test.ts。
 */
export const CHAT_SYSTEM_PROMPT = SHARED_SYSTEM_PROMPT;

/**
 * 聊天历史窗口（条）：每次请求从真源取最近 N 条原文加在 system 之后。
 * 外部不可配——窗口策略是身体的安全/成本边界，不是调用方参数。
 */
export const CHAT_HISTORY_TURNS = 20;

/** 工具描述符（与 headless OpenAIAgentTool 结构同构，此处本地定义不跨适配器引用）。 */
export interface ChatToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** 一次工具调用（模型给的原始 arguments JSON 字符串原样下发）。 */
export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsText: string;
}

/** 结构化 agent 模型面：headless 的 OpenAIAgentClient 天然满足，机制层无需认识具体实现。 */
export interface ChatAgentClient {
  readonly modelName: string;
  run(input: {
    readonly messages: readonly ChatMessage[];
    readonly tools: readonly ChatToolDescriptor[];
    readonly execute: (call: ChatToolCall) => Promise<string>;
  }): Promise<{ content: string; model: string }>;
}

/** 发给模型的入口消息（工具轮由 agent 客户端内部产生，不经此类型）。 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** 工具宿主：进程内共享的六工具描述符 + 请求级会话工厂。 */
export interface ChatToolHost {
  readonly tools: readonly ChatToolDescriptor[];
  createSession(): { execute: (call: ChatToolCall) => Promise<string> };
}

/** /chat 路由解析后的入参（文本已过非空校验）。 */
export interface ChatRequest {
  readonly text: string;
  readonly sessionId?: string | undefined;
}

/** 聊天结果：助手正文与实际回报模型名。 */
export interface ChatResponse {
  readonly reply: string;
  readonly model: string;
}

/** 聊天处理器结构面（机制层只依赖这个函数形状）。 */
export type ChatHandler = (request: ChatRequest) => Promise<ChatResponse>;

/**
 * speaker（原文事实）→ 聊天角色（模型协议）映射。
 *
 * 只认 user/assistant 两个对话角色；系统注入/工具轮等其它 speaker 不进聊天上下文
 * （宁空勿错，不猜角色）。与 dsh 适配器 initiationOf 的职责不同、口径对齐：
 * 写入经历时 user→user、assistant→her，此处本地保留同一张最小映射，不横向引兄弟适配器。
 */
function chatRoleOf(speaker: string): ChatMessage['role'] | undefined {
  if (speaker === 'user') return 'user';
  if (speaker === 'assistant') return 'assistant';
  return undefined;
}

/** 生成通道内唯一的原文事件 id（服务端生成，不信任客户端）。 */
function newEventId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(6).toString('base64url')}`;
}

export interface CreateChatHandlerDeps {
  readonly fasti: Fasti;
  readonly channel: string;
  readonly client: ChatAgentClient;
  readonly toolHost: ChatToolHost;
}

/** 构造聊天处理器；纯函数装配，不持会话状态（状态的权威在真源）。 */
export function createChatHandler(deps: CreateChatHandlerDeps): ChatHandler {
  const { fasti, channel, client, toolHost } = deps;

  return async (request: ChatRequest): Promise<ChatResponse> => {
    const sessionId = request.sessionId ?? '';
    const userEventId = newEventId('chat');

    // 1) 用户话先落真源——后续模型失败也不丢她的输入。
    await fasti.ingestRawTurn(channel, {
      event_id: userEventId,
      ...(sessionId === '' ? {} : { session_id: sessionId }),
      speaker: 'user',
      initiation: 'user',
      raw_text: request.text,
    });

    // 2) 从 append-only 真源重建窗口内历史（含刚写入的这句），角色不明的行跳过。
    const recent = await fasti.readRecentRawTurns(channel, CHAT_HISTORY_TURNS);
    const history: ChatMessage[] = [];
    for (const row of recent) {
      const role = chatRoleOf(row.speaker);
      if (role !== undefined) {
        history.push({ role, content: row.raw_text });
      }
    }
    const messages: ChatMessage[] = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...history];

    // 3) 请求级工具会话：序号表/采用去重集只活在这一次模型回路里。
    const session = toolHost.createSession();
    const { content, model } = await client.run({
      messages,
      tools: toolHost.tools,
      execute: (call) => session.execute(call),
    });

    // 4) 助手最终回话落真源：speaker=assistant，initiation 映射为 her（与 dsh 口径一致）。
    //    工具中间轮不落盘——真源只记双向对话原文，不记模型的内部检索动作。
    await fasti.ingestRawTurn(channel, {
      event_id: `${userEventId}-reply`,
      ...(sessionId === '' ? {} : { session_id: sessionId }),
      speaker: 'assistant',
      initiation: 'her',
      raw_text: content,
    });

    return { reply: content, model };
  };
}
