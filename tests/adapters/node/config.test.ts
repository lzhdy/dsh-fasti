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

test('readServeConfig：默认不代开浏览器（openBrowser/browserPath 均为 undefined）', () => {
  const config = readServeConfig({}, []);
  assert.equal(config.openBrowser, undefined);
  assert.equal(config.browserPath, undefined);
});

test('readServeConfig：FASTI_OPEN_BROWSER=app/fullscreen 透传，off 与空白回落 undefined', () => {
  assert.equal(readServeConfig({ FASTI_OPEN_BROWSER: 'app' }, []).openBrowser, 'app');
  assert.equal(readServeConfig({ FASTI_OPEN_BROWSER: ' fullscreen ' }, []).openBrowser, 'fullscreen');
  assert.equal(readServeConfig({ FASTI_OPEN_BROWSER: 'off' }, []).openBrowser, undefined);
  assert.equal(readServeConfig({ FASTI_OPEN_BROWSER: '  ' }, []).openBrowser, undefined);
});

test('readServeConfig：argv --open=app 覆盖环境变量；--browser-path 透传', () => {
  const config = readServeConfig(
    { FASTI_OPEN_BROWSER: 'fullscreen', FASTI_BROWSER_PATH: ' /opt/browser/chrome ' },
    ['--open=app'],
  );
  assert.equal(config.openBrowser, 'app');
  assert.equal(config.browserPath, '/opt/browser/chrome');
});

test('readServeConfig：argv 也支持 --open <mode> 空格形式', () => {
  const config = readServeConfig({}, ['--open', 'fullscreen']);
  assert.equal(config.openBrowser, 'fullscreen');
});

test('readServeConfig：非法模式值启动即报错（env 与 argv 各守一道）', () => {
  assert.throws(() => readServeConfig({ FASTI_OPEN_BROWSER: 'kiosk' }, []), /FASTI_OPEN_BROWSER/);
  assert.throws(() => readServeConfig({}, ['--open=kiosk']), /--open/);
});
