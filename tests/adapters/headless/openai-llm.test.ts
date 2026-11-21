/**
 * headless OpenAI 兼容直连 LLM 管道（平台化 H3）离线测试。
 *
 * 不发任何真实网络请求：fetch 以纯函数桩注入，断言 URL/鉴权头/请求体装配、
 * 成功与各类失败归一，以及与 dsh 端口**共用同一份** llm-wire-parse 线协议解析。
 * 云端账号与本地无鉴权网关的差别只在 baseURL / apiKey 配置，行为同构。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableError } from '../../../src/core/errors.ts';
import { AnchorSerialWireError, type LLMSummarizeRequest } from '../../../src/event/llm-port.ts';
import {
  createOpenAICompatLLMPort,
} from '../../../src/adapters/headless/openai-llm.ts';
import type {
  FetchLike,
  HttpRequestInit,
  MinimalHttpResponse,
} from '../../../src/adapters/headless/openai-wire.ts';

const REQ: LLMSummarizeRequest = { system: '你是摘要器', user: '1. 原文', maxChars: 500 };

const SUMMARY_PAYLOAD = {
  summary: '她整理了排期。',
  key_points: ['排期'],
  anchor_serials: [1],
};
const SUMMARY_TEXT = '```json\n' + JSON.stringify(SUMMARY_PAYLOAD) + '\n```';

interface Captured {
  url: string;
  init: HttpRequestInit;
}

function jsonResponse(status: number, payload: unknown): MinimalHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function stubFetch(response: MinimalHttpResponse, captured: Captured[], throwError?: unknown): FetchLike {
  return async (url, init) => {
    captured.push({ url, init });
    if (throwError !== undefined) {
      throw throwError;
    }
    return response;
  };
}

function chatSuccess(content: string, model = 'gpt-cloud-x'): MinimalHttpResponse {
  return jsonResponse(200, {
    model,
    choices: [{ message: { role: 'assistant', content } }],
  });
}

test('请求装配：POST 到归一化后的 /chat/completions，带 Bearer 鉴权与两条消息，默认模型入 body', async () => {
  const captured: Captured[] = [];
  const port = createOpenAICompatLLMPort({
    baseURL: 'https://api.example.com/v1/',
    model: 'default-model',
    apiKey: 'sk-secret',
    fetchImpl: stubFetch(chatSuccess(SUMMARY_TEXT), captured),
  });

  await port.summarize(REQ);

  assert.equal(captured.length, 1);
  const { url, init } = captured[0]!;
  assert.equal(url, 'https://api.example.com/v1/chat/completions', '尾部斜杠必须归一，路径拼接固定');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['authorization'], 'Bearer sk-secret');
  const body = JSON.parse(init.body) as { model: string; messages: Array<{ role: string; content: string }> };
  assert.equal(body.model, 'default-model');
  assert.deepEqual(body.messages, [
    { role: 'system', content: REQ.system },
    { role: 'user', content: REQ.user },
  ]);
});

test('请求装配：单次 request.model 覆盖默认模型', async () => {
  const captured: Captured[] = [];
  const port = createOpenAICompatLLMPort({
    baseURL: 'https://api.example.com/v1',
    model: 'default-model',
    apiKey: 'sk',
    fetchImpl: stubFetch(chatSuccess(SUMMARY_TEXT, 'cheap-model'), captured),
  });

  const response = await port.summarize({ ...REQ, model: 'cheap-model' });

  const body = JSON.parse(captured[0]!.init.body) as { model: string };
  assert.equal(body.model, 'cheap-model');
  assert.equal(response.model, 'cheap-model', '响应溯源优先取端点回报的模型名');
  assert.equal(response.summary, SUMMARY_PAYLOAD.summary);
  assert.deepEqual(response.keyPoints, SUMMARY_PAYLOAD.key_points, '驼峰 keyPoints 由共用线协议解析填充');
  assert.deepEqual(response.anchor_serials, [1], '围栏 JSON 由共用线协议解析剥壳');
});

test('本地无鉴权网关：省略 apiKey 时不得发送 Authorization 头', async () => {
  const captured: Captured[] = [];
  const port = createOpenAICompatLLMPort({
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'local-model',
    fetchImpl: stubFetch(chatSuccess(SUMMARY_TEXT), captured),
  });

  await port.summarize(REQ);

  assert.equal(Object.hasOwn(captured[0]!.init.headers, 'authorization'), false);
  assert.equal(captured[0]!.url, 'http://127.0.0.1:11434/v1/chat/completions');
});

test('失败归一：HTTP 非 2xx 抛 UnavailableError 并带状态码', async () => {
  const port = createOpenAICompatLLMPort({
    baseURL: 'https://api.example.com/v1',
    model: 'm',
    apiKey: 'k',
    fetchImpl: stubFetch({ ok: false, status: 401, text: async () => 'Unauthorized' }, []),
  });

  await assert.rejects(
    () => port.summarize(REQ),
    (error: unknown) => error instanceof UnavailableError && /401/.test((error as Error).message),
  );
});

test('失败归一：传输层抛普通错误与 AbortError 都包成 UnavailableError', async () => {
  const networkError = new Error('ECONNREFUSED');
  const portNetwork = createOpenAICompatLLMPort({
    baseURL: 'https://api.example.com/v1',
    model: 'm',
    fetchImpl: stubFetch(jsonResponse(500, {}), [], networkError),
  });
  await assert.rejects(() => portNetwork.summarize(REQ), UnavailableError);

  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  const portAbort = createOpenAICompatLLMPort({
    baseURL: 'https://api.example.com/v1',
    model: 'm',
    fetchImpl: stubFetch(jsonResponse(500, {}), [], abortError),
  });
  await assert.rejects(() => portAbort.summarize(REQ), UnavailableError);
});

test('失败归一：chat 响应缺 choices / message / 字符串 content 都拒绝', async () => {
  const badShapes = [
    {},
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: 123 } }] },
  ];
  for (const payload of badShapes) {
    const port = createOpenAICompatLLMPort({
      baseURL: 'https://api.example.com/v1',
      model: 'm',
      fetchImpl: stubFetch(jsonResponse(200, payload), []),
    });
    await assert.rejects(() => port.summarize(REQ), UnavailableError, `畸形响应应拒绝：${JSON.stringify(payload)}`);
  }
});

test('失败归一：模型正文不是合法 JSON 时抛 UnavailableError（共用 parseSummaryPayload）', async () => {
  const port = createOpenAICompatLLMPort({
    baseURL: 'https://api.example.com/v1',
    model: 'm',
    fetchImpl: stubFetch(chatSuccess('我不是 JSON'), []),
  });
  await assert.rejects(() => port.summarize(REQ), UnavailableError);
});

test('同源 strict：正文 anchor_serials 含非安全整数时抛 AnchorSerialWireError，与 dsh 端口同口径', async () => {
  const bad = JSON.stringify({ summary: 's', key_points: [], anchor_serials: [1, '2'] });
  const port = createOpenAICompatLLMPort({
    baseURL: 'https://api.example.com/v1',
    model: 'm',
    fetchImpl: stubFetch(chatSuccess(bad), []),
  });
  await assert.rejects(() => port.summarize(REQ), AnchorSerialWireError);
});

test('兜底超时：fetch 永不返回且无上级 signal 时，timeoutMs 到点抛 UnavailableError', async () => {
  const hang: FetchLike = () => new Promise(() => {});
  const port = createOpenAICompatLLMPort({
    baseURL: 'https://api.example.com/v1',
    model: 'm',
    timeoutMs: 20,
    fetchImpl: hang,
  });
  await assert.rejects(() => port.summarize(REQ), UnavailableError);
});

test('构造校验：baseURL / model 为空字符串当场拒绝（配置编程错误，不发起请求）', () => {
  assert.throws(() => createOpenAICompatLLMPort({ baseURL: '', model: 'm' }), TypeError);
  assert.throws(() => createOpenAICompatLLMPort({ baseURL: 'https://x/v1', model: '' }), TypeError);
});
