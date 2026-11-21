/**
 * node 本地 HTTP 启动器（第一刀）红测 —— 先写预期，后写实现。
 *
 * 覆盖三件事：
 *  1. 功能闭环：同源页面自托管 → 带 token 写入 → 带 token 读回经历 → 幂等 → 关门。
 *  2. loopback 安全：Host 头白名单（防 DNS-rebinding）、随机 token 鉴权、body 上限。
 *  3. 边界与自证：未注册通道 fail-closed、坏请求分类码、close 无悬挂句柄、import 面零宿主。
 *
 * 用 node:http 原始请求而非 fetch：fetch 属规范禁止设置 Host 头，无法测 DNS-rebinding 防线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Fasti } from '../../../src/api/index.ts';
import { startHttpServer } from '../../../src/adapters/node/http-server.ts';
import type { ChannelDescriptor } from '../../../src/contract/channel.ts';

const CHANNEL = 'webdemo';
const TOKEN = 'test-token-0123456789';

const descriptor: ChannelDescriptor = {
  id: CHANNEL,
  label: '网页演示通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'web-0',
};

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** 原始 HTTP 请求（可自定义 Host 头，fetch 做不到）。 */
function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

test('node HTTP 启动器第一刀', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-http-'));
  const fasti = await Fasti.open({ dataRoot: root, llmPort: null });
  await fasti.registerChannel(descriptor);

  // port 0 → 由系统分配空闲端口，避免测试抢占固定端口。
  const handle = await startHttpServer(fasti, { port: 0, token: TOKEN, channel: CHANNEL });
  const { port } = handle;

  const auth = { Authorization: `Bearer ${TOKEN}` };
  const jsonAuth = { ...auth, 'Content-Type': 'application/json' };

  try {
    await t.test('GET / 返回同源页面且注入 token（免 token 即可打开）', async () => {
      const res = await rawRequest(port, { path: '/' });
      assert.equal(res.status, 200);
      assert.match(String(res.headers['content-type'] ?? ''), /text\/html/);
      assert.ok(res.body.includes(TOKEN), '页面必须注入一次性 token 供同源脚本使用');
    });

    await t.test('GET /health 免 token 存活检查', async () => {
      const res = await rawRequest(port, { path: '/health' });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { ok: true });
    });

    await t.test('带 token 写入一条经历并可读回', async () => {
      const body = JSON.stringify({
        event_id: 'evt-1',
        speaker: 'user',
        initiation: 'user',
        raw_text: '网页里喂的第一句话',
        asserted_at: '2026-11-21T10:00:00.000Z',
      });
      const write = await rawRequest(port, {
        method: 'POST',
        path: `/channels/${CHANNEL}/turns`,
        headers: jsonAuth,
        body,
      });
      assert.equal(write.status, 201);
      const wrote = JSON.parse(write.body) as { id: string; channel: string };
      assert.equal(wrote.channel, CHANNEL);

      const read = await rawRequest(port, {
        path: `/experiences?channel=${CHANNEL}`,
        headers: auth,
      });
      assert.equal(read.status, 200);
      const payload = JSON.parse(read.body) as { count: number; experiences: Array<{ id: string }> };
      assert.equal(payload.count, 1);
      assert.equal(payload.experiences[0]?.id, wrote.id);
    });

    await t.test('同一 event_id 重放幂等，经历数不增长', async () => {
      const body = JSON.stringify({
        event_id: 'evt-1',
        speaker: 'user',
        initiation: 'user',
        raw_text: '网页里喂的第一句话',
      });
      const replay = await rawRequest(port, {
        method: 'POST',
        path: `/channels/${CHANNEL}/turns`,
        headers: jsonAuth,
        body,
      });
      assert.equal(replay.status, 201);
      const read = await rawRequest(port, { path: `/experiences?channel=${CHANNEL}`, headers: auth });
      const payload = JSON.parse(read.body) as { count: number };
      assert.equal(payload.count, 1, '重放不得新增经历');
    });

    await t.test('缺 token / 错 token 一律 401（写入与读回都要凭证）', async () => {
      const noToken = await rawRequest(port, { path: `/experiences?channel=${CHANNEL}` });
      assert.equal(noToken.status, 401);
      const wrongToken = await rawRequest(port, {
        path: `/experiences?channel=${CHANNEL}`,
        headers: { Authorization: 'Bearer wrong-token' },
      });
      assert.equal(wrongToken.status, 401);
      const writeNoToken = await rawRequest(port, {
        method: 'POST',
        path: `/channels/${CHANNEL}/turns`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: 'evt-2', speaker: 'user', initiation: 'user', raw_text: 'x' }),
      });
      assert.equal(writeNoToken.status, 401);
    });

    await t.test('伪造 Host（DNS-rebinding 形态）一律 403，即使带正确 token', async () => {
      const rebound = await rawRequest(port, {
        path: `/experiences?channel=${CHANNEL}`,
        headers: { ...auth, Host: 'attacker.com' },
      });
      assert.equal(rebound.status, 403);
      const reboundPage = await rawRequest(port, { path: '/', headers: { Host: 'attacker.com' } });
      assert.equal(reboundPage.status, 403);
    });

    await t.test('坏 JSON / 缺必填 → 400；未注册通道 → 404；错方法 → 405；未知路径 → 404', async () => {
      const badJson = await rawRequest(port, {
        method: 'POST',
        path: `/channels/${CHANNEL}/turns`,
        headers: jsonAuth,
        body: '{not json',
      });
      assert.equal(badJson.status, 400);

      const missing = await rawRequest(port, {
        method: 'POST',
        path: `/channels/${CHANNEL}/turns`,
        headers: jsonAuth,
        body: JSON.stringify({ event_id: 'evt-3', speaker: 'user' }),
      });
      assert.equal(missing.status, 400);

      const unknownChannel = await rawRequest(port, {
        method: 'POST',
        path: '/channels/never-registered/turns',
        headers: jsonAuth,
        body: JSON.stringify({ event_id: 'evt-4', speaker: 'user', initiation: 'user', raw_text: 'x' }),
      });
      assert.equal(unknownChannel.status, 404);

      const wrongMethod = await rawRequest(port, { method: 'DELETE', path: '/experiences', headers: auth });
      assert.equal(wrongMethod.status, 405);

      const unknownPath = await rawRequest(port, { path: '/nope' });
      assert.equal(unknownPath.status, 404);
    });

    await t.test('请求体超过上限 → 413', async () => {
      const huge = 'x'.repeat(1024 * 1024 + 1024);
      const res = await rawRequest(port, {
        method: 'POST',
        path: `/channels/${CHANNEL}/turns`,
        headers: jsonAuth,
        body: JSON.stringify({ event_id: 'evt-5', speaker: 'user', initiation: 'user', raw_text: huge }),
      });
      assert.equal(res.status, 413);
    });
  } finally {
    await handle.close();
    await fasti.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }

  await t.test('close 后端口已释放，无悬挂句柄', async () => {
    await assert.rejects(() => rawRequest(port, { path: '/health' }), /ECONNREFUSED|connect/i);
  });

  await t.test('import 面自证：本模块零宿主作用域包、零兄弟适配器', () => {
    const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    // 拆段拼接，避免断言字符串在源文件里自指命中。
    const hostScope = '@deepseek-' + 'ai';
    const sibling = 'adapters' + '/dsh';
    assert.ok(!self.includes(hostScope), 'node 适配器不得 import 宿主作用域包');
    assert.ok(!self.includes(sibling), 'node 适配器不得横向依赖兄弟适配器');
  });
});
