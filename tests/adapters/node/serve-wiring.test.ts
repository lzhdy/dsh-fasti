/**
 * #157 组合根装配冒烟（红测先行）。
 *
 * 单测已分别覆盖 bus / 观测 stage / chat 钩子 / 两个 loop 报告；本文件验证 serve()
 * 这一层把它们真的接到了一起，且生产姿态可干净启停：
 *  ① 真路由鉴权（不是测试夹具自证）：/api 无 token 401、/health 免 token；
 *  ② 正式 web/ 目录经 /app 托管，静态资产免凭证直开、入口 HTML 注入 bootstrap，且带强 CSP；
 *  ③ pulse 长轮询期间客户端断连不悬挂，close() 能快速干净退出（bus.dispose 生效）。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { serve } from '../../../src/adapters/node/serve.ts';
import { cleanupTempRoot, makeTempRoot } from '../../helpers.ts';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers ?? {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('serve() 组合根：鉴权/静态托管/长轮询断连/干净关闭 全链路装配', async () => {
  const root = makeTempRoot();
  const handle = await serve({
    dataRoot: root,
    port: 0,
    channel: 'wiring-smoke',
    openaiBaseURL: undefined,
    openaiModel: undefined,
    openaiApiKey: undefined,
    openaiReasoningEffort: undefined,
  });
  const port = handle.port;
  const auth = { Authorization: `Bearer ${handle.token}` };

  try {
    // ① 鉴权在真实 serve 装配下成立。
    assert.equal((await rawRequest(port, { path: '/api/status' })).status, 401);
    assert.equal((await rawRequest(port, { path: '/health' })).status, 200);
    const status = await rawRequest(port, { path: '/api/status', headers: auth });
    assert.equal(status.status, 200);
    const statusPayload = JSON.parse(status.body) as { bootId?: string };
    assert.equal(typeof statusPayload.bootId, 'string');
    assert.ok((statusPayload.bootId ?? '').length === 12, 'bootId 为 6 字节 hex（12 字符）');

    // ② 正式 web/ 目录（src/adapters/node/web）经 /app 托管：静态资产免 Bearer 直开
    //    （地址栏与 <script>/<link> 标签无法附 Authorization），强 CSP/nosniff 一道不少。
    for (const suffix of ['index.html', 'styles.css', 'app.js']) {
      const res = await rawRequest(port, { path: `/app/${suffix}` });
      assert.equal(res.status, 200, `${suffix} 应免凭证经 /app 读取`);
      assert.equal(typeof res.headers['content-security-policy'], 'string');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    }
    // 入口 HTML 注入本次一次性凭证；数据墙 /api 的 401 已在 ① 验证，不随静态面放开。
    const entry = await rawRequest(port, { path: '/app/index.html' });
    assert.ok(entry.body.includes('window.__FASTI_BOOTSTRAP__'));
    assert.ok(entry.body.includes(handle.token), '引导内联携带本次启动一次性 token');
    assert.ok(entry.body.includes('wiring-smoke'));

    // ③ 长轮询挂起中（客户端保持连接、不读不掐）直接关停：
    // bus.dispose 必须立即释放等待者，让响应收尾、连接转空闲，否则 server.close 要等满 5s 轮询窗。
    let hangingStatus = 0;
    const hanging = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/api/pulse?after=0',
      headers: auth,
    });
    hanging.on('response', (res) => {
      hangingStatus = res.statusCode ?? 0;
      res.resume(); // 排空响应但不主动断连，连接保持到服务端关停。
    });
    hanging.on('error', () => {
      /* 关停期 socket 错误属预期，忽略 */
    });
    hanging.end();
    // 确认请求已进入长轮询挂起（无新事件，100ms 内不会有响应）。
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hangingStatus, 0, 'pulse 此刻应仍在挂起等待');

    const closeStart = Date.now();
    await handle.close();
    const closeMs = Date.now() - closeStart;
    assert.ok(closeMs < 1000, `close() 不应被长轮询等待者悬挂（实际 ${closeMs}ms）`);
  } finally {
    await handle.close().catch(() => {
      /* 主流程已 close 时幂等忽略 */
    });
    cleanupTempRoot(root);
  }
});
