/**
 * 阶段 0 · 工具轮类型化映射测试（定案稿 §5.0.2 / 任务书 C2c · A2″）。
 *
 * 覆盖：
 *  - 调用步载荷 → `action: { type:'tool-call', tool, args }`（args 走指针不内联）；
 *  - 结果载荷 → `outcome: { status, error_type?, duration_ms?, tokens? }`；
 *  - 普通对话轮 → 不产生 action/outcome；
 *  - 未知形态 → 原样保留（不猜字段、不丢弃）；
 *  - 载荷 JSON 解析失败 → 不抛、不阻断（原样保留）；
 *  - callId 只从载荷 JSON 提取，**不提升为顶层字段**；
 *  - 17 调用步 + 17 结果 = 34 工具轮，callId 一一配对（对齐真实数据实测口径）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { typeToolTurn } from '../../src/event/tool-typing.ts';

// ── 调用步载荷（实测 17 条）──────────────────────────────────────────────

test('调用步载荷 → 映射为 tool-call（tool 取自 name，callId 取自载荷）', () => {
  const typing = typeToolTurn(
    JSON.stringify({
      name: 'web_fetch',
      arguments: { url: 'https://example.com' },
      callId: 'call-001',
    }),
  );
  assert.equal(typing.kind, 'call-step');
  if (typing.kind !== 'call-step') {
    return;
  }
  assert.equal(typing.tool, 'web_fetch', 'tool 取载荷的 name');
  assert.equal(typing.callId, 'call-001', 'callId 从载荷 JSON 提取');
});

test('调用步载荷：缺少 name 或 callId → 不猜，按非工具轮处理', () => {
  // 缺 name
  assert.equal(typeToolTurn(JSON.stringify({ arguments: {}, callId: 'c1' })).kind, 'dialogue');
  // 缺 callId
  assert.equal(typeToolTurn(JSON.stringify({ name: 'web_fetch', arguments: {} })).kind, 'dialogue');
  // 缺 arguments
  assert.equal(typeToolTurn(JSON.stringify({ name: 'web_fetch', callId: 'c1' })).kind, 'dialogue');
});

// ── 结果载荷（实测 17 条）────────────────────────────────────────────────

test('结果载荷 → 映射为 result（status=success，callId 取自 message.toolCallId）', () => {
  const typing = typeToolTurn(
    JSON.stringify({
      message: { toolCallId: 'call-001', content: '页面正文', isError: false },
    }),
  );
  assert.equal(typing.kind, 'result');
  if (typing.kind !== 'result') {
    return;
  }
  assert.equal(typing.callId, 'call-001');
  assert.equal(typing.status, 'success');
  assert.equal(typing.errorType, undefined);
});

test('结果载荷：isError=true → status=failure；错误码原样记录不翻译', () => {
  const typing = typeToolTurn(
    JSON.stringify({
      message: { toolCallId: 'call-002', content: '失败', isError: true },
      error: { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' },
    }),
  );
  assert.equal(typing.kind, 'result');
  if (typing.kind !== 'result') {
    return;
  }
  assert.equal(typing.status, 'failure', 'isError:true → failure');
  assert.equal(
    typing.errorType,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
    '错误码原样记录（§5.0.3，不做翻译改写）',
  );
});

test('结果载荷：截断 → partial；无结果正文 → unknown', () => {
  const truncated = typeToolTurn(
    JSON.stringify({ message: { toolCallId: 'c', content: '半截', isPartial: true } }),
  );
  assert.equal(truncated.kind === 'result' ? truncated.status : null, 'partial');

  const empty = typeToolTurn(JSON.stringify({ message: { toolCallId: 'c' } }));
  assert.equal(empty.kind === 'result' ? empty.status : null, 'unknown');
});

test('结果载荷：duration_ms 与 tokens 按载荷原样记录', () => {
  const typing = typeToolTurn(
    JSON.stringify({
      message: {
        toolCallId: 'c',
        content: 'ok',
        duration_ms: 1234,
        tokens: { input: 100, output: 20 },
      },
    }),
  );
  assert.equal(typing.kind, 'result');
  if (typing.kind !== 'result') {
    return;
  }
  assert.equal(typing.durationMs, 1234);
  assert.equal(typing.inputTokens, 100);
  assert.equal(typing.outputTokens, 20);
});

// ── 对话轮与未知形态 ────────────────────────────────────────────────────

test('普通对话轮（非 JSON）→ dialogue，不产生 action/outcome', () => {
  assert.equal(typeToolTurn('她打开了一篇论文').kind, 'dialogue');
  assert.equal(typeToolTurn('').kind, 'dialogue');
  assert.equal(typeToolTurn('   ').kind, 'dialogue');
});

test('未知工具形态 → 原样保留（不猜字段、不当工具轮）', () => {
  // 是个合法 JSON 对象，但既不是调用步也不是结果。
  assert.equal(typeToolTurn(JSON.stringify({ foo: 'bar' })).kind, 'dialogue');
  // 数组不是对象。
  assert.equal(typeToolTurn(JSON.stringify([1, 2, 3])).kind, 'dialogue');
  // 字符串 JSON。
  assert.equal(typeToolTurn(JSON.stringify('hello')).kind, 'dialogue');
});

test('载荷 JSON 解析失败 → 不抛、不阻断（原样保留）', () => {
  // 看起来像 JSON 但是坏的。
  assert.equal(typeToolTurn('{ 这不是 JSON ').kind, 'dialogue');
  assert.doesNotThrow(() => typeToolTurn('{ broken'));
});

// ── A2″ · 真实数据口径：17 调用步 + 17 结果，callId 一一配对 ────────────

test('A2″ · 34 个工具轮 → 17 调用步 + 17 结果，17 对 callId 一一配对', () => {
  const callIds = Array.from({ length: 17 }, (_, index) => `call-${String(index).padStart(3, '0')}`);
  const payloads: string[] = [];

  // 每个工具调用拆成两条记录：请求（调用步）+ 结果（结果载荷）。
  for (const callId of callIds) {
    payloads.push(
      JSON.stringify({ name: 'web_fetch', arguments: { url: `https://example.com/${callId}` }, callId }),
    );
    payloads.push(
      JSON.stringify({ message: { toolCallId: callId, content: `结果 ${callId}`, isError: false } }),
    );
  }
  // 混入普通对话轮（真实数据里 213 条对话）。
  payloads.push('她打开了一篇论文');

  const typings = payloads.map((text) => typeToolTurn(text));
  const callSteps = typings.filter((t) => t.kind === 'call-step');
  const results = typings.filter((t) => t.kind === 'result');
  const dialogues = typings.filter((t) => t.kind === 'dialogue');

  assert.equal(callSteps.length, 17, '17 个调用步');
  assert.equal(results.length, 17, '17 个结果');
  assert.equal(dialogues.length, 1, '普通对话轮不计入工具轮');

  // 17 对 callId 一一配对（请求的 callId 与结果的 toolCallId 对上）。
  const stepIds = callSteps.map((t) => (t.kind === 'call-step' ? t.callId : '')).sort();
  const resultIds = results.map((t) => (t.kind === 'result' ? t.callId : '')).sort();
  assert.deepEqual(stepIds, resultIds, '请求与结果的 callId 一一配对');
  assert.equal(new Set(stepIds).size, 17, '17 个 callId 互不重复');
});
