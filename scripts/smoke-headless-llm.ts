/**
 * headless 直连管道手动冒烟（平台化 H3）。
 *
 * 这是「填配置即用」的真连通验证：不注入假 fetch、走全局 fetch 打真实端点，
 * 证明 headless 适配器接上后能直接跑通云端大模型或本地 OpenAI 兼容网关。
 * 本脚本不进 `npm run verify`（离线确定性测试才进 verify），仅供人工按需执行，
 * 也不内置任何真实密钥或端点——全部来自环境变量。
 *
 * 云端（OpenAI 兼容厂商，端点前缀给到 /v1）：
 *   OPENAI_BASE_URL=https://api.example.com/v1 \
 *   OPENAI_API_KEY=sk-xxxx \
 *   OPENAI_MODEL=your-model \
 *   node scripts/smoke-headless-llm.ts
 *
 * 本地部署（Ollama / vLLM / LM Studio 等，无鉴权就省略 OPENAI_API_KEY）：
 *   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
 *   OPENAI_MODEL=your-local-model \
 *   node scripts/smoke-headless-llm.ts
 *
 * 可选：OPENAI_TIMEOUT_MS（毫秒，默认沿用内核闭合管线预算）。
 */

import { createOpenAICompatLLMPort } from '../src/adapters/headless/index.ts';

const baseURL = process.env['OPENAI_BASE_URL']?.trim();
const model = process.env['OPENAI_MODEL']?.trim();
const apiKey = process.env['OPENAI_API_KEY']?.trim();
const timeoutRaw = process.env['OPENAI_TIMEOUT_MS']?.trim();
const timeoutMs = timeoutRaw !== undefined && timeoutRaw !== '' ? Number(timeoutRaw) : undefined;

if (baseURL === undefined || baseURL === '' || model === undefined || model === '') {
  console.error(
    [
      '用法：先设置环境变量再运行本脚本',
      '  必填：OPENAI_BASE_URL（OpenAI 兼容端点前缀，如 https://host/v1 或 http://127.0.0.1:11434/v1）',
      '  必填：OPENAI_MODEL（模型名）',
      '  可选：OPENAI_API_KEY（本地无鉴权网关省略）、OPENAI_TIMEOUT_MS（毫秒）',
    ].join('\n'),
  );
  process.exit(2);
}
if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
  console.error(`OPENAI_TIMEOUT_MS 必须是正整数毫秒，实际收到：${timeoutRaw ?? ''}`);
  process.exit(2);
}

const port = createOpenAICompatLLMPort({
  baseURL,
  model,
  apiKey: apiKey === undefined || apiKey === '' ? undefined : apiKey,
  timeoutMs,
});

const system = [
  '你是记忆摘要器。只输出一个 JSON 代码块，不要输出任何额外文字。',
  'JSON 对象形状固定为：',
  '{"summary": string, "key_points": string[], "anchor_serials": number[]}',
  '其中 summary 是一句话摘要，key_points 是要点字符串数组，本次 anchor_serials 恒为空数组 []。',
].join('\n');
const user = '今天和团队确认了记忆内核平台化的排期，决定先交付 headless 直连模型管道。';

console.log(
  `[smoke] endpoint=${baseURL.replace(/\/+$/, '')}/chat/completions model=${model} ` +
    `auth=${apiKey ? 'Bearer(已带密钥)' : '无密钥(本地网关)'}`,
);

try {
  const response = await port.summarize({ system, user, maxChars: 500 });
  console.log('[smoke] 线协议解析通过，模型返回：');
  console.log(`  model        : ${response.model ?? '(未回报)'}`);
  console.log(`  summary      : ${response.summary}`);
  console.log(`  keyPoints    : ${JSON.stringify(response.keyPoints)}`);
  console.log(`  anchor_serials: ${JSON.stringify(response.anchor_serials)}`);
  console.log('[smoke] PASS：headless 直连管道可用');
} catch (error) {
  const label = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[smoke] FAIL：直连未跑通（端点/密钥/模型名/网络请逐项排查）\n  ${label}`);
  process.exit(1);
}
