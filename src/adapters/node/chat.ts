/**
 * node 身体的对话编排（对话第一刀：拿掉 dsh 后，由 FasTI 自己直连模型与用户对话）。
 *
 * 本模块是 node 适配器内的装配策略，**不是机制层**：
 *  - 只依赖 node 内置 + 内核门面的结构化面，不 import headless 或任何兄弟适配器
 *    （具体 OpenAI 客户端由 serve.ts 组合根注入 ChatModelClient）；
 *  - 一轮对话的固定次序：用户话先落真源 → 从真源重建近期上下文 → 调模型 →
 *    助手回话落真源。模型失败时用户话仍保留，且绝不写入伪造的助手行。
 *
 * 红线口径：
 *  - system prompt 固定中性、不注人设（CHAT_SYSTEM_PROMPT），不提供 env 覆盖口子；
 *  - 历史只从真源 readRecentRawTurns 重建，不信任客户端投递的任何"上下文"；
 *  - 第一刀没有工具回路，发给模型的消息只有 system/user/assistant 三种角色。
 */

import { randomBytes } from 'node:crypto';

import type { Fasti } from '../../api/index.ts';

/** 固定中性 system prompt：只约束诚实与表达，不编人格、不赋予未接线的能力。 */
export const CHAT_SYSTEM_PROMPT =
  '你是运行在用户本机的记忆助手。只根据当前对话如实回答：没有依据的内容直接说明不知道，' +
  '不编造事实，不声称拥有对话中未提供的工具或能力；回答简洁，使用与用户相同的语言。';

/**
 * 聊天历史窗口（条）：每次请求从真源取最近 N 条原文加在 system 之后。
 * 外部不可配——窗口策略是身体的安全/成本边界，不是调用方参数。
 */
export const CHAT_HISTORY_TURNS = 20;

/** 结构化模型面：headless 的 OpenAIChatClient 天然满足，机制层无需认识具体实现。 */
export interface ChatModelClient {
  readonly modelName: string;
  complete(
    messages: readonly ChatMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<{ content: string; model: string }>;
}

/** 发给模型的一条消息（第一刀三角色封闭集）。 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
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
  readonly client: ChatModelClient;
}

/** 构造聊天处理器；纯函数装配，不持会话状态（状态的权威在真源）。 */
export function createChatHandler(deps: CreateChatHandlerDeps): ChatHandler {
  const { fasti, channel, client } = deps;

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

    // 3) 调模型；传输/信封失败原样上抛 UnavailableError，由路由归一错误信封。
    const { content, model } = await client.complete(messages);

    // 4) 助手回话落真源：speaker=assistant，initiation 映射为 her（与 dsh 口径一致）。
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
