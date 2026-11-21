/**
 * dsh 适配器的 LLM 端口测试（技术基线 §6.6 · 任务卡 T7）。
 *
 * 覆盖：端口走注入的模型路由、JSON 解析与围栏剥离、坏输出抛 UnavailableError。
 * 后台循环 worker 已抽到 src/assembly/recurring-worker.ts，其轮询/续排/卸载行为在
 * tests/assembly/recurring-worker.test.ts 用虚拟时钟端口确定性覆盖。
 *
 * 纪律：路由是注入的假实现 —— 测试不碰真实模型，也不需要 OAuth 凭据。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableError } from '../../../src/core/errors.ts';
import { createDshLLMPort } from '../../../src/adapters/dsh/llm.ts';
import type { DshModelRoute } from '../../../src/adapters/dsh/llm.ts';

/** 假路由：记录请求，按预设返回正文或抛错。 */
class FakeRoute implements DshModelRoute {
  readonly calls: Array<{ system: string; user: string; model?: string }> = [];
  reply = '{"summary":"她打开了一个网页。","key_points":[],"anchor_serials":[]}';
  error: Error | null = null;

  async complete(req: { system: string; user: string; model?: string }): Promise<string> {
    this.calls.push(req);
    if (this.error !== null) {
      throw this.error;
    }
    return this.reply;
  }
}

/** 最小请求（端口只关心 system/user/model/maxChars）。 */
const REQUEST = {
  system: '你是事件摘要器。',
  user: '事件时间范围：2026-11-08T10:00:00.000Z ~ 2026-11-08T10:05:00.000Z\n1. 原文',
  maxChars: 600,
};

test('端口：走注入的模型路由，透传 system / user', async () => {
  const route = new FakeRoute();
  const port = createDshLLMPort(route);

  const response = await port.summarize(REQUEST);

  assert.equal(route.calls.length, 1);
  assert.equal(route.calls[0]?.system, REQUEST.system);
  assert.equal(route.calls[0]?.user, REQUEST.user);
  assert.equal(response.summary, '她打开了一个网页。');
  assert.deepEqual(response.keyPoints, []);
  assert.deepEqual(response.anchor_serials, []);
});

test('端口：解析 key_points 与 anchor_serials（结构序号）', async () => {
  const route = new FakeRoute();
  // 本用例无事件成员集上下文：适配器只做结构性解析，序号 1 原样透传，
  // 1..N 成员归属由内核序号表判定（不回猜 id）。
  route.reply = JSON.stringify({
    summary: '摘要',
    key_points: ['要点一', '要点二'],
    anchor_serials: [1],
  });
  const port = createDshLLMPort(route);

  const response = await port.summarize(REQUEST);
  assert.deepEqual(response.keyPoints, ['要点一', '要点二']);
  assert.deepEqual(response.anchor_serials, [1]);
});

test('端口：剥掉模型常见的 ```json 围栏', async () => {
  const route = new FakeRoute();
  route.reply = '```json\n{"summary":"围栏里的摘要","key_points":[],"anchor_serials":[]}\n```';
  const port = createDshLLMPort(route);

  const response = await port.summarize(REQUEST);
  assert.equal(response.summary, '围栏里的摘要');
});

test('端口：模型返回坏 JSON → 抛 UnavailableError（不返回半截内容）', async () => {
  const route = new FakeRoute();
  route.reply = '这不是 JSON';
  const port = createDshLLMPort(route);

  await assert.rejects(() => port.summarize(REQUEST), UnavailableError);
});

test('端口：模型返回缺 summary → 抛 UnavailableError', async () => {
  const route = new FakeRoute();
  route.reply = '{"key_points":[],"anchor_serials":[]}';
  const port = createDshLLMPort(route);

  await assert.rejects(() => port.summarize(REQUEST), UnavailableError);
});

test('端口：路由调用失败 → 抛 UnavailableError（沿用既有错误码，不新增）', async () => {
  const route = new FakeRoute();
  route.error = new Error('MISSING_CREDENTIAL');
  const port = createDshLLMPort(route);

  await assert.rejects(() => port.summarize(REQUEST), UnavailableError);
});

test('端口：模型名可由 options 指定，也接受请求里的覆盖', async () => {
  const route = new FakeRoute();
  const port = createDshLLMPort(route, { model: '摘要专用模型' });

  await port.summarize(REQUEST);
  assert.equal(route.calls[0]?.model, '摘要专用模型');

  await port.summarize({ ...REQUEST, model: '临时模型' });
  assert.equal(route.calls[1]?.model, '临时模型', '请求里的模型名优先');
});
