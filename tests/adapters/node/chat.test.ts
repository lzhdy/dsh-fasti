/**
 * 对话第一刀红测（平台化 #72 延伸：node 身体直连模型对话，零工具纯聊天）。
 *
 * 端到端：真起本机 OpenAI 兼容假端点 → POST /chat → 用户话先落真源 → 从真源重建历史 →
 * 真发 Chat Completions（不带 tools）→ 助手回话落真源（speaker=assistant/initiation=her）。
 *
 * 覆盖：
 *  1. happy path 线协议：中性 system、请求体恰好 model+messages 无 tools、无 key 不发 Authorization；
 *  2. 多轮上下文从真源重建（客户端不投递历史，第二问仍带上一轮问答）；
 *  3. 历史窗口封顶（CHAT_HISTORY_TURNS，外部不可配）；
 *  4. 未配模型 → 503；上游 5xx/网络失败 → 502 且用户话保留、无助手行；
 *  5. 入参/鉴权/方法约束；
 *  6. import 面自证：机制层不引 headless、全 node 目录零兄弟适配器由架构门专守。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Fasti } from '../../../src/api/index.ts';
import { createOpenAIAgentClient } from '../../../src/adapters/headless/index.ts';
import { startHttpServer } from '../../../src/adapters/node/http-server.ts';
import { openNodeMemoryRuntime } from '../../../src/adapters/node/memory-session.ts';
import {
  CHAT_HISTORY_TURNS,
  CHAT_SYSTEM_PROMPT,
  createChatHandler,
} from '../../../src/adapters/node/chat.ts';
import type { ChannelDescriptor } from '../../../src/contract/channel.ts';

const CHANNEL = 'webdemo';
const TOKEN = 'chat-test-token-0123';
const MODEL = 'mock-chat-model';
const REPLY = '你好，这是本机模型的回话。';

const descriptor: ChannelDescriptor = {
  id: CHANNEL,
  label: '聊天测试通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'chat-0',
};

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers: options.headers ?? {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

interface SeenRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** 起一个可编排回复的假 OpenAI 端点；replies 队列逐条消耗，缺省回固定 REPLY。 */
async function startMockEndpoint(replies: string[] = []): Promise<{
  port: number;
  seen: SeenRequest[];
  stop: () => Promise<void>;
}> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
      const content = replies.shift() ?? REPLY;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    seen,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/** 总是 500 的假端点。 */
async function startFailingEndpoint(): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function openStack(mockPort: number, root: string): Promise<{
  fasti: Fasti;
  port: number;
  stop: () => Promise<void>;
}> {
  const fasti = await Fasti.open({ dataRoot: root, llmPort: null });
  await fasti.registerChannel(descriptor);
  const client = createOpenAIAgentClient({ baseURL: `http://127.0.0.1:${mockPort}/v1`, model: MODEL });
  const memoryRuntime = openNodeMemoryRuntime({ fasti, channel: CHANNEL });
  const chat = createChatHandler({ fasti, channel: CHANNEL, client, toolHost: memoryRuntime });
  const handle = await startHttpServer(fasti, { port: 0, token: TOKEN, channel: CHANNEL, chat });
  return {
    fasti,
    port: handle.port,
    stop: async () => {
      await handle.close();
      await memoryRuntime.dispose();
      await fasti.close();
    },
  };
}

test('POST /chat happy path：线协议形状正确，user/assistant 双向落真源', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-chat-'));
  const mock = await startMockEndpoint();
  const stack = await openStack(mock.port, root);
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  try {
    const res = await rawRequest(stack.port, {
      method: 'POST',
      path: '/chat',
      headers: auth,
      body: JSON.stringify({ text: '你接收到的这条消息是什么样子的。' }),
    });
    assert.equal(res.status, 200, res.body);
    const payload = JSON.parse(res.body) as { ok: boolean; reply: string; model: string };
    assert.equal(payload.ok, true);
    assert.equal(payload.reply, REPLY);
    assert.equal(payload.model, MODEL);

    assert.equal(mock.seen.length, 1);
    const wire = mock.seen[0]!;
    assert.equal(wire.authorization, undefined, '未配 key 不得发 Authorization');
    assert.deepEqual(Object.keys(wire.body).sort(), ['messages', 'model', 'tools'], '第二刀请求体三键：model+messages+tools');
    assert.equal(wire.body['model'], MODEL);
    const wireTools = wire.body['tools'] as Array<{ type: string; function: { name: string } }>;
    assert.equal(wireTools.length, 6, '固定 on：六工具每次请求都随包声明');
    assert.ok(wireTools.every((tool) => tool.type === 'function'));
    assert.ok(!('tool_choice' in wire.body), '不硬编码 tool_choice，也不发采样参数');
    const messages = wire.body['messages'] as Array<{ role: string; content: string }>;
    assert.equal(messages[0]?.role, 'system');
    assert.equal(messages[0]?.content, CHAT_SYSTEM_PROMPT, 'system 必须是固定中性提示，不注人设');
    assert.equal(messages.at(-1)?.role, 'user');
    assert.equal(messages.at(-1)?.content, '你接收到的这条消息是什么样子的。');

    const rows = await stack.fasti.readRecentRawTurns(CHANNEL, 10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.speaker, 'user');
    assert.equal(rows[0]?.raw_text, '你接收到的这条消息是什么样子的。');
    assert.equal(rows[1]?.speaker, 'assistant');
    assert.equal(rows[1]?.raw_text, REPLY);

    const experiences = await stack.fasti.query({ channel: CHANNEL });
    assert.deepEqual(
      experiences.map((item) => item.initiation),
      ['user', 'her'],
      'assistant 一轮的 initiation 必须映射为 her（与 dsh 口径一致）',
    );
  } finally {
    await stack.stop();
    await mock.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POST /chat 多轮：历史从真源重建，第二次请求自带第一轮问答', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-chat-'));
  const mock = await startMockEndpoint(['第一轮回话', '第二轮回话']);
  const stack = await openStack(mock.port, root);
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  try {
    const first = await rawRequest(stack.port, {
      method: 'POST', path: '/chat', headers: auth, body: JSON.stringify({ text: '第一问' }),
    });
    assert.equal(first.status, 200, first.body);
    const second = await rawRequest(stack.port, {
      method: 'POST', path: '/chat', headers: auth, body: JSON.stringify({ text: '第二问' }),
    });
    assert.equal(second.status, 200, second.body);
    assert.equal((JSON.parse(second.body) as { reply: string }).reply, '第二轮回话');

    assert.equal(mock.seen.length, 2);
    const secondMessages = mock.seen[1]!.body['messages'] as Array<{ role: string; content: string }>;
    assert.deepEqual(
      secondMessages.map((message) => [message.role, message.content]),
      [
        ['system', CHAT_SYSTEM_PROMPT],
        ['user', '第一问'],
        ['assistant', '第一轮回话'],
        ['user', '第二问'],
      ],
      '历史必须由服务端从真源重建，而不是信任客户端投递',
    );
  } finally {
    await stack.stop();
    await mock.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POST /chat 历史窗口封顶：只送最近 CHAT_HISTORY_TURNS 条加 system', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-chat-'));
  const mock = await startMockEndpoint();
  const stack = await openStack(mock.port, root);
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  try {
    for (let i = 0; i < CHAT_HISTORY_TURNS + 4; i += 1) {
      await stack.fasti.ingestRawTurn(CHANNEL, {
        event_id: `seed-${i}`,
        speaker: i % 2 === 0 ? 'user' : 'assistant',
        initiation: i % 2 === 0 ? 'user' : 'her',
        raw_text: `第 ${i} 句`,
      });
    }
    const res = await rawRequest(stack.port, {
      method: 'POST', path: '/chat', headers: auth, body: JSON.stringify({ text: '新的一句' }),
    });
    assert.equal(res.status, 200, res.body);

    const messages = mock.seen[0]!.body['messages'] as Array<{ role: string; content: string }>;
    assert.equal(messages.length, CHAT_HISTORY_TURNS + 1, 'system 一条 + 窗口内历史，不得超发');
    assert.equal(messages[0]?.role, 'system');
    assert.equal(messages[1]?.content, '第 5 句', '窗口外的更早原文必须被截掉');
    assert.equal(messages.at(-1)?.content, '新的一句');
  } finally {
    await stack.stop();
    await mock.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POST /chat 未配模型 → 503；上游 500 → 502 且只留用户行', async () => {
  const root503 = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-chat-'));
  const fasti503 = await Fasti.open({ dataRoot: root503, llmPort: null });
  await fasti503.registerChannel(descriptor);
  const handle503 = await startHttpServer(fasti503, { port: 0, token: TOKEN, channel: CHANNEL });
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  try {
    const res = await rawRequest(handle503.port, {
      method: 'POST', path: '/chat', headers: auth, body: JSON.stringify({ text: '在吗' }),
    });
    assert.equal(res.status, 503);
    assert.equal((JSON.parse(res.body).error as { code: string }).code, 'chat-unavailable');
  } finally {
    await handle503.close();
    await fasti503.close();
    fs.rmSync(root503, { recursive: true, force: true });
  }

  const root502 = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-chat-'));
  const failing = await startFailingEndpoint();
  const stack = await openStack(failing.port, root502);
  try {
    const res = await rawRequest(stack.port, {
      method: 'POST', path: '/chat', headers: auth, body: JSON.stringify({ text: '模型会失败的一句' }),
    });
    assert.equal(res.status, 502);
    assert.equal((JSON.parse(res.body).error as { code: string }).code, 'model-unavailable');
    const rows = await stack.fasti.readRecentRawTurns(CHANNEL, 10);
    assert.equal(rows.length, 1, '失败时用户话仍须留痕');
    assert.equal(rows[0]?.speaker, 'user');
  } finally {
    await stack.stop();
    await failing.stop();
    fs.rmSync(root502, { recursive: true, force: true });
  }
});

test('POST /chat 入参/鉴权/方法约束', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-chat-'));
  const mock = await startMockEndpoint();
  const stack = await openStack(mock.port, root);
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  try {
    const empty = await rawRequest(stack.port, {
      method: 'POST', path: '/chat', headers: auth, body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(empty.status, 400);

    const noToken = await rawRequest(stack.port, {
      method: 'POST', path: '/chat', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(noToken.status, 401);

    const wrongMethod = await rawRequest(stack.port, { path: '/chat', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(wrongMethod.status, 405);
    assert.equal(mock.seen.length, 0, '被拦下的请求一次模型都不许调');
  } finally {
    await stack.stop();
    await mock.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
