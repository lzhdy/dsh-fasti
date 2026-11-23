/**
 * headless function-calling 客户端红测（对话第二刀）：node 身体自己跑 agent 回路。
 *
 * 不起真实 socket：fetch 纯函数桩注入，钉死 OpenAI 线协议——
 *  - 请求体恒 {model, messages, tools} 三键，无 tool_choice/采样参数，无 key 不发 auth；
 *  - tool_calls 回包 → 本地执行 → role:'tool' 回灌 → 再请求，直到纯正文；
 *  - 并行 tool_calls 逐个执行、结果全部回灌；
 *  - 坏 tool_call 形状/执行器抛错不得炸回路，回稳定错误信封让模型自纠；
 *  - 工具轮次硬顶，超轮归一 UnavailableError（上层映射 502）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableError } from '../../../src/core/errors.ts';
import { createOpenAIAgentClient } from '../../../src/adapters/headless/openai-agent.ts';
import type {
  FetchLike,
  HttpRequestInit,
  MinimalHttpResponse,
} from '../../../src/adapters/headless/openai-wire.ts';

const MODEL = 'mock-agent-model';

function jsonResponse(status: number, payload: unknown): MinimalHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function toolCallResponse(calls: Array<{ id: string; name: string; args: unknown }>): MinimalHttpResponse {
  return jsonResponse(200, {
    model: MODEL,
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      },
    ],
  });
}

function textResponse(content: string): MinimalHttpResponse {
  return jsonResponse(200, { model: MODEL, choices: [{ message: { role: 'assistant', content } }] });
}

interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** 顺序消耗预设响应的 fetch 桩，同时记录全部请求。 */
function scriptedFetch(responses: MinimalHttpResponse[], captured: HttpRequestInit[], throwOnCall?: number): FetchLike {
  let calls = 0;
  return async (_url, init) => {
    captured.push(init);
    const index = calls;
    calls += 1;
    if (throwOnCall !== undefined && index === throwOnCall) {
      throw new Error('network down');
    }
    const response = responses[index];
    if (response === undefined) {
      throw new Error(`脚本只给了 ${responses.length} 个响应，却发生第 ${calls} 次请求`);
    }
    return response;
  };
}

const TOOLS = [
  {
    name: 'fasti_memory_search',
    description: 'Search long-term memory under the gate.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, limit: { type: 'number' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'fasti_memory_raw_text',
    description: 'Read raw turns by pointer.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const SEED_MESSAGES = [
  { role: 'system' as const, content: '系统提示' },
  { role: 'user' as const, content: '我去年生日怎么过的？' },
];

test('请求装配：tools 按 OpenAI function 形状发出，请求体恰好三键且无 tool_choice/采样参数', async () => {
  const captured: HttpRequestInit[] = [];
  const client = createOpenAIAgentClient({
    baseURL: 'http://127.0.0.1:9999/v1',
    model: MODEL,
    fetchImpl: scriptedFetch([textResponse('最终回答')], captured),
  });

  await client.run({ messages: SEED_MESSAGES, tools: TOOLS, execute: async () => '{}' });

  assert.equal(captured.length, 1);
  const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'tools']);
  assert.equal(body['model'], MODEL);
  assert.ok(!('tool_choice' in body), '不硬编码 tool_choice，缺省即 auto');
  assert.ok(!('temperature' in body) && !('max_tokens' in body), '不发采样参数');
  assert.ok(!('reasoning_effort' in body), '未配置 reasoningEffort 时零漂移：请求体不含 reasoning_effort');
  const wireTools = body['tools'] as Array<Record<string, unknown>>;
  assert.equal(wireTools.length, 2);
  assert.deepEqual(Object.keys(wireTools[0]!).sort(), ['function', 'type']);
  assert.equal(wireTools[0]!['type'], 'function');
  const fn = wireTools[0]!['function'] as Record<string, unknown>;
  assert.equal(fn['name'], 'fasti_memory_search');
  assert.equal(fn['description'], TOOLS[0]!.description);
  assert.deepEqual(fn['parameters'], TOOLS[0]!.parameters);
  assert.equal(captured[0]!.headers['authorization'], undefined, '无 key 不发 Authorization');
});

test('请求装配：reasoningEffort 可选项配置后每轮请求都带 reasoning_effort，取值原样透传', async () => {
  const captured: HttpRequestInit[] = [];
  const client = createOpenAIAgentClient({
    baseURL: 'http://127.0.0.1:9999/v1',
    model: MODEL,
    reasoningEffort: 'high',
    fetchImpl: scriptedFetch([textResponse('最终回答')], captured),
  });

  await client.run({ messages: SEED_MESSAGES, tools: TOOLS, execute: async () => '{}' });

  assert.equal(captured.length, 1);
  const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'reasoning_effort', 'tools']);
  assert.equal(body['reasoning_effort'], 'high');
});

test('单工具往返：执行器收到原始参数，assistant(tool_calls) 与 tool 结果按序回灌', async () => {
  const captured: HttpRequestInit[] = [];
  const executed: Array<{ id: string; name: string; argumentsText: string }> = [];
  const client = createOpenAIAgentClient({
    baseURL: 'http://127.0.0.1:9999/v1',
    model: MODEL,
    fetchImpl: scriptedFetch(
      [
        toolCallResponse([{ id: 'call-1', name: 'fasti_memory_search', args: { text: '去年生日', limit: 3 } }]),
        textResponse('你的去年生日是和朋友聚餐。'),
      ],
      captured,
    ),
  });

  const result = await client.run({
    messages: SEED_MESSAGES,
    tools: TOOLS,
    execute: async (call) => {
      executed.push({ id: call.id, name: call.name, argumentsText: call.argumentsText });
      return JSON.stringify({ ok: true, data: { status: 'hit', cards: [] } });
    },
  });

  assert.equal(result.content, '你的去年生日是和朋友聚餐。');
  assert.equal(result.model, MODEL);
  assert.deepEqual(executed, [
    { id: 'call-1', name: 'fasti_memory_search', argumentsText: JSON.stringify({ text: '去年生日', limit: 3 }) },
  ]);

  assert.equal(captured.length, 2);
  const secondBody = JSON.parse(captured[1]!.body) as { messages: WireMessage[]; tools: unknown[] };
  assert.equal(secondBody.tools.length, 2, '每一轮请求都带齐工具定义');
  const roles = secondBody.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool']);
  const assistantMsg = secondBody.messages[2]!;
  assert.equal(assistantMsg.content, null);
  assert.equal(assistantMsg.tool_calls?.[0]?.id, 'call-1');
  assert.equal(assistantMsg.tool_calls?.[0]?.type, 'function');
  const toolMsg = secondBody.messages[3]!;
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'call-1');
  assert.equal(toolMsg.content, JSON.stringify({ ok: true, data: { status: 'hit', cards: [] } }));
});

test('并行 tool_calls：两个调用都执行，两条 tool 消息一次性回灌', async () => {
  const captured: HttpRequestInit[] = [];
  const names: string[] = [];
  const client = createOpenAIAgentClient({
    baseURL: 'http://127.0.0.1:9999/v1',
    model: MODEL,
    fetchImpl: scriptedFetch(
      [
        toolCallResponse([
          { id: 'call-a', name: 'fasti_memory_search', args: { text: '生日' } },
          { id: 'call-b', name: 'fasti_memory_raw_text', args: { id: 'exp-1' } },
        ]),
        textResponse('查完了。'),
      ],
      captured,
    ),
  });

  await client.run({
    messages: SEED_MESSAGES,
    tools: TOOLS,
    execute: async (call) => {
      names.push(call.name);
      return `result-of-${call.id}`;
    },
  });

  assert.deepEqual(names, ['fasti_memory_search', 'fasti_memory_raw_text']);
  const secondBody = JSON.parse(captured[1]!.body) as { messages: WireMessage[] };
  const toolMessages = secondBody.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.deepEqual(toolMessages.map((m) => m.tool_call_id), ['call-a', 'call-b']);
});

test('坏形状 tool_call（缺 id）不调执行器，回 schema 错误信封后模型自纠成功', async () => {
  const captured: HttpRequestInit[] = [];
  let executed = 0;
  const broken = jsonResponse(200, {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ type: 'function', function: { name: 'fasti_memory_search', arguments: '{}' } }],
        },
      },
    ],
  });
  const client = createOpenAIAgentClient({
    baseURL: 'http://127.0.0.1:9999/v1',
    model: MODEL,
    fetchImpl: scriptedFetch([broken, textResponse('我重新组织了回答。')], captured),
  });

  const result = await client.run({
    messages: SEED_MESSAGES,
    tools: TOOLS,
    execute: async () => {
      executed += 1;
      return '{}';
    },
  });

  assert.equal(result.content, '我重新组织了回答。');
  assert.equal(executed, 0, '形状不合法的 tool_call 不许触达执行器');
  const secondBody = JSON.parse(captured[1]!.body) as { messages: WireMessage[] };
  const toolMsg = secondBody.messages.find((m) => m.role === 'tool')!;
  const envelope = JSON.parse(toolMsg.content!) as { ok: boolean; error: { code: string } };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'schema');
});

test('执行器抛错被归一成 internal 错误信封，回路不中断', async () => {
  const captured: HttpRequestInit[] = [];
  const client = createOpenAIAgentClient({
    baseURL: 'http://127.0.0.1:9999/v1',
    model: MODEL,
    fetchImpl: scriptedFetch(
      [toolCallResponse([{ id: 'call-x', name: 'fasti_memory_search', args: { text: 'x' } }]), textResponse('恢复了。')],
      captured,
    ),
  });

  const result = await client.run({
    messages: SEED_MESSAGES,
    tools: TOOLS,
    execute: async () => {
      throw new Error('适配器内爆');
    },
  });

  assert.equal(result.content, '恢复了。');
  const secondBody = JSON.parse(captured[1]!.body) as { messages: WireMessage[] };
  const envelope = JSON.parse(secondBody.messages.find((m) => m.role === 'tool')!.content!) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(envelope.error.code, 'internal');
});

test('工具轮次硬顶：连续 tool_calls 超过 5 轮即抛 UnavailableError，不再执行/请求', async () => {
  const captured: HttpRequestInit[] = [];
  let executions = 0;
  const endless = Array.from({ length: 8 }, () =>
    toolCallResponse([{ id: `call-${captured.length}-${Math.random()}`, name: 'fasti_memory_search', args: { text: 'q' } }]),
  );
  const client = createOpenAIAgentClient({
    baseURL: 'http://127.0.0.1:9999/v1',
    model: MODEL,
    fetchImpl: scriptedFetch(endless, captured),
  });

  await assert.rejects(
    client.run({
      messages: SEED_MESSAGES,
      tools: TOOLS,
      execute: async () => {
        executions += 1;
        return '{}';
      },
    }),
    (error: unknown) => error instanceof UnavailableError,
  );
  assert.equal(captured.length, 6, '5 轮工具各一次请求，第 6 个工具回包触发硬顶');
  assert.equal(executions, 5);
});

test('传输失败/HTTP 5xx/空正文无工具调用 均归一 UnavailableError', async () => {
  // 瞬态失败（传输 reject、5xx）按默认策略重试 2 次后才归一；这里注入假 sleep 免真实等待。
  const noSleep = async (): Promise<void> => {};

  const networkCapture: HttpRequestInit[] = [];
  const networkClient = createOpenAIAgentClient({
    baseURL: 'http://127.0.0.1:9999/v1',
    model: MODEL,
    fetchImpl: scriptedFetch([], networkCapture, 0),
    sleepImpl: noSleep,
  });
  await assert.rejects(
    networkClient.run({ messages: SEED_MESSAGES, tools: TOOLS, execute: async () => '{}' }),
    (error: unknown) => error instanceof UnavailableError,
  );
  assert.equal(networkCapture.length, 3, '瞬态传输失败按 1+2 次用完退避预算后归一');

  const httpCapture: HttpRequestInit[] = [];
  const httpClient = createOpenAIAgentClient({
    baseURL: 'http://127.0.0.1:9999/v1',
    model: MODEL,
    fetchImpl: scriptedFetch(
      [jsonResponse(500, { error: 'boom' }), jsonResponse(500, { error: 'boom' }), jsonResponse(500, { error: 'boom' })],
      httpCapture,
    ),
    sleepImpl: noSleep,
  });
  await assert.rejects(
    httpClient.run({ messages: SEED_MESSAGES, tools: TOOLS, execute: async () => '{}' }),
    (error: unknown) => error instanceof UnavailableError,
  );
  assert.equal(httpCapture.length, 3, '5xx 同样按退避预算重试，用尽后归一');

  // 200 但正文为空：不是瞬态，不重试，一次即归一。
  const emptyCapture: HttpRequestInit[] = [];
  const emptyClient = createOpenAIAgentClient({
    baseURL: 'http://127.0.0.1:9999/v1',
    model: MODEL,
    fetchImpl: scriptedFetch([jsonResponse(200, { choices: [{ message: { role: 'assistant', content: '' } }] })], emptyCapture),
    sleepImpl: noSleep,
  });
  await assert.rejects(
    emptyClient.run({ messages: SEED_MESSAGES, tools: TOOLS, execute: async () => '{}' }),
    (error: unknown) => error instanceof UnavailableError,
  );
  assert.equal(emptyCapture.length, 1, '非瞬态的空正文不消耗重试预算');
});
