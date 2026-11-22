/**
 * node 启动器环境变量配置解析测试。
 *
 * 重点守 reasoningEffort 可选档（#154）：不设/空白 → undefined（请求体零漂移），
 * 设了 → 原样透传给 headless 两端口；其余既有变量做最小冒烟。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readServeConfig } from '../../../src/adapters/node/config.ts';

test('readServeConfig：未设 OPENAI_REASONING_EFFORT 时为 undefined（零漂移）', () => {
  const config = readServeConfig({});
  assert.equal(config.openaiReasoningEffort, undefined);
});

test('readServeConfig：空白 OPENAI_REASONING_EFFORT 回落 undefined', () => {
  const config = readServeConfig({ OPENAI_REASONING_EFFORT: '   ' });
  assert.equal(config.openaiReasoningEffort, undefined);
});

test('readServeConfig：OPENAI_REASONING_EFFORT 取值 trim 后原样保留，不做别名转换', () => {
  const config = readServeConfig({ OPENAI_REASONING_EFFORT: ' high ' });
  assert.equal(config.openaiReasoningEffort, 'high');
});

test('readServeConfig：既有 OPENAI_* 变量与端口解析不受影响', () => {
  const config = readServeConfig({
    OPENAI_BASE_URL: 'https://gw.example/v1/',
    OPENAI_MODEL: 'SCNet-Max',
    OPENAI_API_KEY: 'sk-x',
    FASTI_HTTP_PORT: '9001',
    FASTI_CHANNEL: 'dsh',
  });
  assert.equal(config.openaiBaseURL, 'https://gw.example/v1/');
  assert.equal(config.openaiModel, 'SCNet-Max');
  assert.equal(config.openaiApiKey, 'sk-x');
  assert.equal(config.port, 9001);
  assert.equal(config.channel, 'dsh');
});
