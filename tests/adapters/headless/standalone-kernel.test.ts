/**
 * 平台化插件化步骤4 · 内核＋headless 直连的「库级独立运行」活证据。
 *
 * 本文件刻意**不 import 任何真机适配器目录、不 import 任何宿主作用域包**（见末尾
 * import 面自证用例），只用内核门面 Fasti 与 headless 自带的 OpenAI 兼容 LLMPort，
 * 在一个临时数据根上跑通：开门 → 显式登记一个中性通道 → 写入原文/经历 → 读回 →
 * 幂等重放 → 未注册通道拒绝 → 关门。证明不挂载真机插件、不装宿主框架时，
 * 内核＋headless 作为一个普通库即可独立工作。
 *
 * 边界：这是测试期对库的驱动，**不是** 11.13/#72 挂账的「宿主无关启动器/CLI 服务面」——
 * src 下不新增任何入口、常驻进程或插件加载器。headless 端口的 HTTP 装配与线协议由
 * openai-llm.test.ts 专测；此处 fetch 桩若被调用即抛错，反证主摄入链路不依赖模型。
 *
 * 纪律：全部用临时数据根，绝不读写真实数据目录；不依赖公共 tests/helpers（其夹具引用
 * 真机适配器工厂），临时根在本文件内自给，保持 import 闭包彻底无真机适配器触点。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Fasti } from '../../../src/api/index.ts';
import type { ChannelDescriptor } from '../../../src/contract/channel.ts';
import { createOpenAICompatLLMPort } from '../../../src/adapters/headless/openai-llm.ts';

/** 建临时数据根。 */
function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-standalone-'));
}

/** 一个与任何真机宿主都无关的中性通道描述符（不走真机适配器工厂，本测试自行声明）。 */
const STANDALONE_CHANNEL: ChannelDescriptor = {
  id: 'standalone',
  label: '独立直连通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'test-0',
};

const AT = '2026-11-21T09:00:00.000Z';

test('独立运行：不挂真机插件，内核＋headless 在临时根上完成登记/写入/读回/幂等/关门', async () => {
  const root = makeRoot();
  // headless 摘要端口被真实构造并注入；主摄入链路不应触发任何模型调用，故桩被碰即 fail。
  const llmPort = createOpenAICompatLLMPort({
    baseURL: 'http://127.0.0.1:0/v1',
    model: 'local-model',
    fetchImpl: async () => {
      throw new Error('主摄入链路不得依赖模型调用，headless 端口在本用例不应被请求');
    },
  });

  const fasti = await Fasti.open({ dataRoot: root, llmPort });
  try {
    // 内核空白启动不预置任何通道：由使用方显式登记中性通道后才可写。
    const descriptor = await fasti.registerChannel(STANDALONE_CHANNEL);
    assert.equal(descriptor.id, 'standalone');

    const first = await fasti.ingestRawTurn('standalone', {
      event_id: 'evt-1',
      session_id: 's1',
      speaker: 'user',
      initiation: 'user',
      raw_text: '你好，独立内核',
      asserted_at: AT,
      occurred_at: AT,
    });
    assert.equal(first.scene.channel, 'standalone');
    assert.equal(first.initiation, 'user');

    // 读回：事件已可经门面查询，且原文/经历确实落进临时根。
    const eventsAfterFirst = await fasti.queryEvents();
    assert.equal(eventsAfterFirst.length, 1);
    assert.equal(eventsAfterFirst[0]?.channel, 'standalone');
    assert.ok(fs.existsSync(path.join(root, 'experiences')), '经历目录应已落盘');

    // 幂等：同一 (channel,event_id) 重放不新增、返回同一条经历。
    const replayed = await fasti.ingestRawTurn('standalone', {
      event_id: 'evt-1',
      session_id: 's1',
      speaker: 'user',
      initiation: 'user',
      raw_text: '你好，独立内核',
      asserted_at: AT,
      occurred_at: AT,
    });
    assert.equal(replayed.id, first.id);
    assert.equal((await fasti.queryEvents()).length, 1, '重放不得新增事件');

    // 内核谁都不预置：未登记通道写入被 NotFound 拒绝（fail-closed，不偷偷建通道）。
    await assert.rejects(
      () =>
        fasti.ingestRawTurn('never-registered', {
          event_id: 'evt-x',
          speaker: 'user',
          initiation: 'user',
          raw_text: '不应落盘',
        }),
      /通道未注册/,
    );
  } finally {
    await fasti.close();
    // close 已释放句柄：临时根可被完整递归删除（Windows 上占用会在此暴露）。
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test('独立运行自证：本测试 import 面零真机适配器目录、零宿主作用域包', async () => {
  // 读取测试自身源码做静态自证；违禁整串拆段拼接，避免断言字符串在源文件里自指命中。
  const selfPath = fileURLToPath(import.meta.url);
  const source = fs.readFileSync(selfPath, 'utf8');
  const realAdapterImport = 'adapters' + '/dsh';
  const hostScope = '@deepseek-' + 'ai';
  assert.ok(!source.includes(realAdapterImport), '独立运行测试不得 import 真机适配器目录');
  assert.ok(!source.includes(hostScope), '独立运行测试不得 import 宿主作用域包');

  // 同一临时根开门/关门的最小烟囱：无 LLM 端口（null，无模型如实降级）也能独立起停。
  const root = makeRoot();
  const fasti = await Fasti.open({ dataRoot: root, llmPort: null });
  try {
    await fasti.registerChannel(STANDALONE_CHANNEL);
    assert.equal((await fasti.queryEvents()).length, 0);
  } finally {
    await fasti.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
