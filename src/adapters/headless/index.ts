/**
 * headless 适配器桶出口（平台化 H3）。
 *
 * 这里是不依赖任何宿主的直连管道：填入 OpenAI 兼容端点配置即可让内核接上
 * 云端大模型或本地部署模型，与 dsh 适配器实现同一个 LLMPort 契约。
 */

export { createOpenAICompatLLMPort } from './openai-llm.ts';
export type {
  FetchLike,
  HttpRequestInit,
  MinimalHttpResponse,
  OpenAICompatLLMPortOptions,
} from './openai-llm.ts';
