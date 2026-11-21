/**
 * headless 适配器桶出口（平台化 H3）。
 *
 * 这里是不依赖任何宿主的直连管道：填入 OpenAI 兼容端点配置即可让内核接上
 * 云端大模型或本地部署模型。摘要端口实现内核 LLMPort 契约；聊天客户端供
 * node 身体的对话回路使用；wire 是两者共享的传输积木。
 */

export { createOpenAICompatLLMPort } from './openai-llm.ts';
export type { OpenAICompatLLMPortOptions } from './openai-llm.ts';

export { createOpenAIChatClient } from './openai-chat.ts';
export type { OpenAIChatClient, OpenAIChatClientOptions, OpenAIChatMessage } from './openai-chat.ts';

export type {
  FetchLike,
  HttpRequestInit,
  MinimalHttpResponse,
} from './openai-wire.ts';
