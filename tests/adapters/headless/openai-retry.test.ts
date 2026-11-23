/**
 * headless 瞬态失败退避重试红测（2026-11-24，《headless退避与召回韧性只读评估》方案 C 施工批 1）。
 *
 * 真机 SCNet 演示暴露：一次 /chat 的 agent 回路在同一轮内要连发 2 个 HTTP 请求，
 * 第 2 轮撞上游 429 时当前实现立即抛错 → HTTP 502，用户话虽留存但这一轮白费。
 *
 * 本批只钉死**传输层单请求级**退避语义（重试发生在拿到 200 之前，重发字节完全相同的同一请求体）：
 *  - 可重试白名单：429 与 500/502/503/504；其余 4xx/5xx 立即放弃，不白烧额度；
 *  - 等待优先尊重 Retry-After（秒数与 HTTP-date 两种格式），缺失或非法回退确定性指数退避；
 *  - 次数硬顶默认 1 + 2 次；耗尽仍归一 UnavailableError（上层行为零变化）；
 *  - 外部 signal 已中止时绝不重试；
 *  - **工具执行在拿到 200 之后**，退避够不到执行器，副作用不可能被重放（本批专设用例钉死）。
 *
 * 不起真实 socket、不真实等待：fetch 与 sleep 双桩注入，等待序列可逐项断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableError } from '../../../src/core/errors.ts';
import { createOpenAIAgentClient } from '../../../src/adapters/headless/openai-agent.ts';
import { createOpenAICompatLLMPort } from '../../../src/adapters/headless/openai-llm.ts';
import {
  DEFAULT_RETRY_POLICY,
  RETRY_AFTER_CAP_MS,
  backoffDelayMs,
  isRetryableStatus,
  parseRetryAfterMs,
  retryDelayMsFor,
  type FetchLike,
  type HttpRequestInit,
  type MinimalHttpResponse,
  type SleepLike,
} from '../../../src/adapters/headless/openai-wire.ts';

const MODEL = 'mock-retry-model';
const BASE_URL = 'http://127.0.0.1:9999/v1';

/** 带 headers.get 面的响应（模拟全局 Response.headers 的大小写不敏感取值）。 */
function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): MinimalHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(payload),
  };
}

/** 无 headers 面的旧桩形态（验证对注入方不强制新面）。 */
function legacyResponse(status: number, payload: unknown): MinimalHttpResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

function textResponse(content: string): MinimalHttpResponse {
  return jsonResponse(200, { model: MODEL, choices: [{ message: { role: 'assistant', content } }] });
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

const RATE_LIMIT_429 = (retryAfter?: string): MinimalHttpResponse =>
  jsonResponse(429, { error: { message: 'Request Rate Reaches Maximum Limit', code: '429' } },
    retryAfter === undefined ? {} : { 'retry-after': retryAfter });

interface Harness {
  readonly captured: HttpRequestInit[];
  readonly sleeps: number[];
  readonly fetchImpl: FetchLike;
  readonly sleepImpl: SleepLike;
}

/** 按脚本顺序消耗的 fetch 桩（响应或抛错皆可）；sleep 桩只记录毫秒、立即返回。 */
function makeHarness(script: ReadonlyArray<MinimalHttpResponse | Error>): Harness {
  const captured: HttpRequestInit[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    captured.push(init);
    const step = script[index];
    index += 1;
    if (step === undefined) {
      throw new Error(`脚本只给了 ${script.length} 步，却发生第 ${index} 次请求`);
    }
    if (step instanceof Error) throw step;
    return step;
  };
  const sleepImpl: SleepLike = async (ms) => {
    sleeps.push(ms);
  };
  return { captured, sleeps, fetchImpl, sleepImpl };
}

function agentWith(harness: Harness) {
  return createOpenAIAgentClient({
    baseURL: BASE_URL,
    model: MODEL,
    fetchImpl: harness.fetchImpl,
    sleepImpl: harness.sleepImpl,
  });
}

const TOOLS = [
  {
    name: 'fasti_memory_search',
    description: 'Search long-term memory under the gate.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

const SEED_MESSAGES = [
  { role: 'system' as const, content: '系统提示' },
  { role: 'user' as const, content: '8801 是哪个端口？' },
];

// ── 一、纯函数：可重试判定与等待时长（零 IO、可逐字节重放）──

test('白名单：429 与 500/502/503/504 重试；其余 4xx/5xx 立即放弃不白烧额度', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, `${status} 应判可重试`);
  }
  for (const status of [200, 201, 304, 400, 401, 403, 404, 409, 422, 501, 505]) {
    assert.equal(isRetryableStatus(status), false, `${status} 应判不可重试`);
  }
});

test('Retry-After 解析：秒数、HTTP-date、过去时刻夹 0、非法值返 null', () => {
  const nowMs = Date.parse('2026-11-24T00:00:00Z');
  assert.equal(parseRetryAfterMs('1', nowMs), 1000);
  assert.equal(parseRetryAfterMs('0', nowMs), 0);
  assert.equal(parseRetryAfterMs(' 2 ', nowMs), 2000, '容忍两侧空白');
  assert.equal(parseRetryAfterMs('Tue, 24 Nov 2026 00:00:03 GMT', nowMs), 3000, 'HTTP-date 取与当前的差值');
  assert.equal(parseRetryAfterMs('Mon, 23 Nov 2026 00:00:00 GMT', nowMs), 0, '过去时刻夹到 0');
  assert.equal(parseRetryAfterMs('soon', nowMs), null);
  assert.equal(parseRetryAfterMs('-1', nowMs), null, '负数非法');
  assert.equal(parseRetryAfterMs('1.5', nowMs), null, '非整数秒非法');
  assert.equal(parseRetryAfterMs(null, nowMs), null);
  assert.equal(parseRetryAfterMs(undefined, nowMs), null);
  assert.equal(parseRetryAfterMs('', nowMs), null);
});

test('指数退避：500 起倍率 2、封顶 2000，首次尝试视作 attempt<=1', () => {
  assert.equal(backoffDelayMs(0), DEFAULT_RETRY_POLICY.baseDelayMs);
  assert.equal(backoffDelayMs(1), 500);
  assert.equal(backoffDelayMs(2), 1000);
  assert.equal(backoffDelayMs(3), 2000);
  assert.equal(backoffDelayMs(4), 2000, '封顶后不再增长');
});

test('等待时长：优先 Retry-After 并夹到上限，缺失时回退指数退避', () => {
  assert.equal(retryDelayMsFor(429, 1000, 1), 1000);
  assert.equal(retryDelayMsFor(429, 6000, 1), RETRY_AFTER_CAP_MS, '服务器要得再久也夹到上限');
  assert.equal(retryDelayMsFor(429, null, 1), 500);
  assert.equal(retryDelayMsFor(429, null, 2), 1000);
  assert.equal(retryDelayMsFor(503, null, 3), 2000);
});

// ── 二、agent 回路接线 ──

test('agent：首次 429 后重试成功，且重发的是逐字节相同的同一请求体', async () => {
  const harness = makeHarness([RATE_LIMIT_429('1'), textResponse('8801 是网页直连端口。')]);
  const result = await agentWith(harness).run({
    messages: SEED_MESSAGES,
    tools: TOOLS,
    execute: async () => '{}',
  });

  assert.equal(result.content, '8801 是网页直连端口。');
  assert.equal(harness.captured.length, 2, '429 后应恰好重发一次');
  assert.equal(harness.captured[0]!.body, harness.captured[1]!.body, '同一轮内重发必须逐字节相同');
  assert.deepEqual(harness.sleeps, [1000], '尊重 Retry-After: 1');
});

test('agent：连续 429 耗尽重试后抛 UnavailableError，出站恰为 3 个请求', async () => {
  const harness = makeHarness([RATE_LIMIT_429(), RATE_LIMIT_429(), RATE_LIMIT_429()]);
  await assert.rejects(
    () => agentWith(harness).run({ messages: SEED_MESSAGES, tools: TOOLS, execute: async () => '{}' }),
    (error: unknown) => error instanceof UnavailableError && /429/.test((error as Error).message),
  );
  assert.equal(harness.captured.length, 3, '1 次首发 + 2 次重试');
  assert.deepEqual(harness.sleeps, [500, 1000], '无 Retry-After 时走确定性指数退避');
});

test('agent：401 立即放弃不重试（鉴权问题重试只会白烧额度）', async () => {
  const harness = makeHarness([jsonResponse(401, { error: 'invalid api key' }), textResponse('不该走到这里')]);
  await assert.rejects(
    () => agentWith(harness).run({ messages: SEED_MESSAGES, tools: TOOLS, execute: async () => '{}' }),
    (error: unknown) => error instanceof UnavailableError && /401/.test((error as Error).message),
  );
  assert.equal(harness.captured.length, 1);
  assert.deepEqual(harness.sleeps, []);
});

test('agent：500/503 重试、501 不重试（5xx 只认瞬时网关类）', async () => {
  const retryable = makeHarness([jsonResponse(500, { error: 'boom' }), textResponse('恢复了')]);
  const ok = await agentWith(retryable).run({ messages: SEED_MESSAGES, tools: TOOLS, execute: async () => '{}' });
  assert.equal(ok.content, '恢复了');
  assert.equal(retryable.captured.length, 2);

  const notRetryable = makeHarness([jsonResponse(501, { error: 'not implemented' })]);
  await assert.rejects(
    () => agentWith(notRetryable).run({ messages: SEED_MESSAGES, tools: TOOLS, execute: async () => '{}' }),
    UnavailableError,
  );
  assert.equal(notRetryable.captured.length, 1);
});

test('agent：传输层 reject（非取消）可重试，重试后成功', async () => {
  const harness = makeHarness([new Error('ECONNRESET'), textResponse('通了')]);
  const result = await agentWith(harness).run({
    messages: SEED_MESSAGES,
    tools: TOOLS,
    execute: async () => '{}',
  });
  assert.equal(result.content, '通了');
  assert.equal(harness.captured.length, 2);
  assert.deepEqual(harness.sleeps, [500]);
});

test('agent：外部 signal 已中止时绝不重试', async () => {
  const controller = new AbortController();
  controller.abort();
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  const harness = makeHarness([abortError, textResponse('不该走到这里')]);

  await assert.rejects(
    () => agentWith(harness).run(
      { messages: SEED_MESSAGES, tools: TOOLS, execute: async () => '{}' },
      { signal: controller.signal },
    ),
    (error: unknown) => error instanceof UnavailableError && /中止/.test((error as Error).message),
  );
  assert.equal(harness.captured.length, 1, '取消后不再发起第二次请求');
  assert.deepEqual(harness.sleeps, []);
});

test('agent：工具副作用不可能被重放——回灌轮 429 重试，执行器全程只执行一次', async () => {
  let executions = 0;
  const harness = makeHarness([
    toolCallResponse([{ id: 'call-1', name: 'fasti_memory_search', args: { text: '8801' } }]),
    RATE_LIMIT_429('1'),
    textResponse('它来自长期记忆。'),
  ]);

  const result = await agentWith(harness).run({
    messages: SEED_MESSAGES,
    tools: TOOLS,
    execute: async () => {
      executions += 1;
      return JSON.stringify({ ok: true, data: { status: 'hit', cards: [] } });
    },
  });

  assert.equal(result.content, '它来自长期记忆。');
  assert.equal(executions, 1, '退避只在拿到 200 之前发生，工具只执行一次');
  assert.equal(harness.captured.length, 3, '第 2 轮 429 重试一次共 3 个请求');
  assert.deepEqual(harness.sleeps, [1000]);
});

test('agent：响应对象没有 headers 面（旧桩形态）时回退指数退避，不报错', async () => {
  const harness = makeHarness([legacyResponse(429, { error: 'limit' }), textResponse('好了')]);
  const result = await agentWith(harness).run({
    messages: SEED_MESSAGES,
    tools: TOOLS,
    execute: async () => '{}',
  });
  assert.equal(result.content, '好了');
  assert.deepEqual(harness.sleeps, [500], '缺 headers 面即无 Retry-After，走指数退避');
});

// ── 三、闭合摘要直连端口（共用同一份传输规则，规则只写一份）──

const REQ = { system: '你是摘要器', user: '1. 原文', maxChars: 600 };
const SUMMARY_TEXT = '```json\n' + JSON.stringify({ summary: '她整理了排期。', key_points: ['排期'], anchor_serials: [1] }) + '\n```';

test('llm：首次 429 后重试成功，与 agent 共用同一份退避规则', async () => {
  const harness = makeHarness([RATE_LIMIT_429('1'), textResponse(SUMMARY_TEXT)]);
  const port = createOpenAICompatLLMPort({
    baseURL: BASE_URL,
    model: MODEL,
    fetchImpl: harness.fetchImpl,
    sleepImpl: harness.sleepImpl,
  });

  const response = await port.summarize(REQ);
  assert.equal(response.summary, '她整理了排期。');
  assert.equal(harness.captured.length, 2);
  assert.deepEqual(harness.sleeps, [1000]);
});

test('llm：连续 429 耗尽后抛 UnavailableError，出站恰为 3 个请求', async () => {
  const harness = makeHarness([RATE_LIMIT_429(), RATE_LIMIT_429(), RATE_LIMIT_429()]);
  const port = createOpenAICompatLLMPort({
    baseURL: BASE_URL,
    model: MODEL,
    fetchImpl: harness.fetchImpl,
    sleepImpl: harness.sleepImpl,
  });

  await assert.rejects(
    () => port.summarize(REQ),
    (error: unknown) => error instanceof UnavailableError && /429/.test((error as Error).message),
  );
  assert.equal(harness.captured.length, 3);
  assert.deepEqual(harness.sleeps, [500, 1000]);
});
