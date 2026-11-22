/**
 * node 启动器的闭合节拍（平台化 #72 第一刀补件）红测。
 *
 * 背景：内核把「事件闭合 + 摘要 drain」的驱动权交给装配方——dsh 用宿主 scheduler
 * 起常驻 worker 调 `checkSilenceClock()` 与 `drainClosure()`。node 启动器若只装配
 * 端口而不驱动，结果就是"模型接上了但永远不会被叫到"，摘要永远 pending。
 *
 * 两个用例：
 *  1. 节拍器契约：按期调用、闭合先于摘要、stop 后不再触发（防悬挂定时器）。
 *  2. 端到端裸连：真起一个本机 OpenAI 兼容假端点 → 内核真发请求 → 摘要落成 ready。
 *     全程不装 dsh、不引 cordis，验证"一条命令直连模型"确实成立。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Fasti } from '../../../src/api/index.ts';
import { createOpenAICompatLLMPort } from '../../../src/adapters/headless/index.ts';
import { startClosureLoop } from '../../../src/adapters/node/index.ts';
import type { ChannelDescriptor } from '../../../src/contract/channel.ts';

const CHANNEL = 'loopdemo';

const descriptor: ChannelDescriptor = {
  id: CHANNEL,
  label: '闭合节拍演示通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'loop-0',
};

test('节拍器：按期触发、闭合先于摘要、stop 后静默', async () => {
  const calls: string[] = [];
  const target = {
    checkSilenceClock(): number {
      calls.push('silence');
      return 0;
    },
    async drainClosure(): Promise<number> {
      calls.push('drain');
      return 0;
    },
  };

  const handle = startClosureLoop(target, { intervalMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.ok(calls.length >= 2, `节拍器未按期触发，实际调用 ${calls.length} 次`);
    // 每一轮都必须是先闭合、后摘要。
    assert.equal(calls[0], 'silence', '首轮必须先闭合再摘要');
    for (let index = 0; index < calls.length; index += 2) {
      assert.equal(calls[index], 'silence', `第 ${index / 2 + 1} 轮顺序错乱：${calls.join(',')}`);
      if (calls[index + 1] !== undefined) {
        assert.equal(calls[index + 1], 'drain', `第 ${index / 2 + 1} 轮缺摘要调用：${calls.join(',')}`);
      }
    }
  } finally {
    handle.stop();
  }

  const snapshot = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, snapshot, 'stop 之后仍有节拍触发：定时器未清理');
});

test('端到端裸连：本机 OpenAI 兼容端点 → 内核真调模型 → 摘要 ready（全程无 dsh）', async () => {
  const seen: Array<{ model: string | undefined; authorization: string | undefined; body: string }> = [];

  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { model?: string };
      seen.push({
        model: parsed.model,
        authorization: req.headers.authorization,
        body,
      });
      const content = JSON.stringify({
        summary: '她在网页里连着说了两句话，是一段短对话。',
        key_points: ['两句话的短对话'],
        anchor_serials: [1],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((resolve) => {
    mock.listen(0, '127.0.0.1', resolve);
  });
  const address = mock.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-loop-'));
  const fasti = await Fasti.open({
    dataRoot: root,
    llmPort: createOpenAICompatLLMPort({ baseURL: `http://127.0.0.1:${port}/v1`, model: 'mock-model' }),
  });

  try {
    await fasti.registerChannel(descriptor);

    await fasti.ingestRawTurn(CHANNEL, {
      event_id: 'loop-1',
      session_id: 's1',
      turn_id: 't1',
      speaker: 'user',
      initiation: 'user',
      raw_text: '第一句话，用来起一个事件。',
      asserted_at: '2026-11-21T10:00:00.000Z',
    });
    await fasti.ingestRawTurn(CHANNEL, {
      event_id: 'loop-2',
      session_id: 's1',
      turn_id: 't2',
      speaker: 'user',
      initiation: 'user',
      raw_text: '第二句话，让这段对话够一个事件段。',
      asserted_at: '2026-11-21T10:00:30.000Z',
    });

    // 把时钟推到足够晚，让"安静够久"的 open 事件闭合（dsh worker 干的就是这件事）。
    const closed = fasti.checkSilenceClock(Date.now() + 24 * 3600 * 1000);
    assert.ok(closed >= 1, `静默检查未闭合任何事件（closed=${closed}）`);

    const drained = await fasti.drainClosure();
    assert.ok(drained >= 1, `摘要 drain 未处理任何任务（drained=${drained}）`);

    // 假端点必须真收到内核的请求，且模型名与密钥口径符合契约。
    assert.equal(seen.length, 1, `模型端点应被调用 1 次，实际 ${seen.length}`);
    assert.equal(seen[0]?.model, 'mock-model', '请求应带配置的模型名');
    assert.equal(seen[0]?.authorization, undefined, '未配置密钥时不得发送 Authorization 头');
    assert.ok(seen[0]?.body.includes('第一句话'), '请求体应含原文内容');

    // 摘要真落盘：事件当前态 summary_quality=ready 且正文来自模型。
    const events = await fasti.queryEvents({ channel: CHANNEL });
    const ready = events.filter((event) => event.summary_quality === 'ready');
    assert.equal(ready.length, 1, `摘要 ready 事件应恰好 1 条，实际 ${ready.length}`);
    assert.match(String(ready[0]?.summary ?? ''), /网页里连着说了两句话/);
  } finally {
    await fasti.close();
    await new Promise<void>((resolve, reject) => {
      mock.close((error) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
      mock.closeAllConnections();
    });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test('节拍器：onReport 钩子在每轮成功后上报闭合/摘要条数（#157 观测挂点）', async () => {
  const reports: Array<{ closed: number; summaries: number }> = [];
  const target = {
    checkSilenceClock: () => 2,
    drainClosure: async () => 1,
  };
  const handle = startClosureLoop(target, {
    intervalMs: 20,
    onReport: (report) => reports.push(report),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 70));
  } finally {
    handle.stop();
  }
  assert.ok(reports.length >= 2, `至少两轮上报，实际 ${reports.length}`);
  for (const report of reports) {
    assert.deepEqual(report, { closed: 2, summaries: 1 });
  }
});
