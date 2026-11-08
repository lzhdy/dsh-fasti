/**
 * 事件 → RawTurnInput 纯转换的单元测试。
 *
 * 口径基准：阶段 3 迁移脚本 `scripts/migrate-raw-turns.ts` 的 `readHarnessSession`
 * （该脚本已逐字复刻旧项目 dsh-persona-innate 的 buildRawTurn / rawTextOf）。
 *
 * 纪律：全部用合成事件，**不碰任何真实数据目录**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assistantTextFromBlocks,
  convertSessionEvent,
  joinTextBlocks,
  RUNTIME_CONTEXT_RE,
} from '../../../src/adapters/dsh/convert-event.ts';

/** 构造一条 user 消息事件。 */
function userEvent(options: {
  id?: string | undefined;
  content?: unknown;
  sourceKind?: string | undefined;
  time?: number | undefined;
} = {}): unknown {
  return {
    type: 'user/message',
    time: options.time ?? Date.parse('2026-11-08T10:00:00.000Z'),
    data: {
      id: 'id' in options ? options.id : 'evt-user-1',
      content: options.content ?? [{ type: 'text', text: '在吗' }],
      source: { kind: options.sourceKind ?? 'user' },
    },
  };
}

/** 构造一条 assistant 消息事件。 */
function assistantEvent(options: {
  id?: string | undefined;
  content?: unknown;
  fallbackContent?: unknown;
  time?: number | undefined;
} = {}): unknown {
  const data: Record<string, unknown> = {
    content: options.fallbackContent,
  };
  if (options.id !== undefined || options.content !== undefined) {
    data['message'] = {
      id: 'id' in options ? options.id : 'evt-assistant-1',
      content: options.content,
    };
  }
  return {
    type: 'assistant/message',
    time: options.time ?? Date.parse('2026-11-08T10:00:01.000Z'),
    data,
  };
}

const SESSION = { id: 'session-abc-123' };

// ── user 侧 ───────────────────────────────────────────────────────────────

test('user 消息：event_id 取 data.id，正文按单空格 join 后 trim', () => {
  const result = convertSessionEvent(SESSION, userEvent({
    content: [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
    ],
  }));

  assert.notEqual(result.input, null);
  assert.equal(result.input?.event_id, 'evt-user-1');
  assert.equal(result.input?.speaker, 'user');
  assert.equal(result.input?.raw_text, '第一段 第二段');
  assert.equal(result.input?.session_id, 'session-abc-123');
  assert.equal(result.input?.turn_id, '');
  assert.equal(result.skip, null);
});

test('user 消息：asserted_at 取事件 time（毫秒 → ISO）', () => {
  const time = Date.parse('2026-11-08T10:00:00.123Z');
  const result = convertSessionEvent(SESSION, userEvent({ time }));
  assert.equal(result.input?.asserted_at, new Date(time).toISOString());
});

test('user 消息：ingested_at 留空 —— 落盘时刻由 ingestRawTurn 唯一分配', () => {
  const result = convertSessionEvent(SESSION, userEvent());
  assert.ok(result.input !== null);
  assert.ok(!('ingested_at' in result.input!), 'ingested_at 应留空');
});

test('user 消息：content_hash 留空 —— 由 parseRawTurn 自动算 sha256(raw_text)', () => {
  const result = convertSessionEvent(SESSION, userEvent());
  assert.ok(result.input !== null);
  assert.ok(!('content_hash' in result.input!), 'content_hash 应留空');
});

// ── assistant 侧 ──────────────────────────────────────────────────────────

test('assistant 消息：event_id 取 data.message.id，正文取最后一个非空 text 块', () => {
  const result = convertSessionEvent(SESSION, assistantEvent({
    content: [
      { type: 'text', text: '先说这句' },
      { type: 'reasoning', text: '思考过程' },
      { type: 'text', text: '最后这句' },
    ],
  }));

  assert.equal(result.input?.event_id, 'evt-assistant-1');
  assert.equal(result.input?.speaker, 'assistant');
  // 从后往前取首个非空 text 块 → '最后这句'（不是 join）
  assert.equal(result.input?.raw_text, '最后这句');
});

test('assistant 消息：data.message.content 缺失时回退 data.content', () => {
  // data.message 存在（有 id，幂等键来源）但没有 content → 正文回退 data.content。
  const result = convertSessionEvent(SESSION, {
    type: 'assistant/message',
    time: Date.parse('2026-11-08T10:00:01.000Z'),
    data: {
      message: { id: 'evt-assistant-2' },
      content: [{ type: 'text', text: '回退路径的正文' }],
    },
  });
  assert.equal(result.input?.raw_text, '回退路径的正文');
  assert.equal(result.input?.event_id, 'evt-assistant-2');
});

test('assistant 消息：连 data.message 都没有时无幂等键 → 跳过（不伪造 id）', () => {
  const result = convertSessionEvent(SESSION, {
    type: 'assistant/message',
    time: Date.parse('2026-11-08T10:00:01.000Z'),
    data: { content: [{ type: 'text', text: '没有 message 块' }] },
  });
  assert.equal(result.input, null);
  assert.equal(result.skip?.kind, 'no-event-id');
});

test('assistant 消息：尾部有 tool_call 块时不把工具调用当成表达', () => {
  const result = convertSessionEvent(SESSION, assistantEvent({
    content: [
      { type: 'text', text: '这是回答' },
      { type: 'tool_call', text: '{"name":"read"}' },
    ],
  }));
  assert.equal(result.input?.raw_text, '这是回答');
});

// ── 排除与跳过 ────────────────────────────────────────────────────────────

test('系统注入的 user 消息（source.kind 非 user）被跳过，且不算异常', () => {
  const result = convertSessionEvent(SESSION, userEvent({ sourceKind: 'runtime-context' }));
  assert.equal(result.input, null);
  assert.equal(result.skip?.kind, 'system-injection');
  assert.deepEqual(result.warnings, []);
});

test('user 消息缺 source 时被跳过（口径：必须 source.kind === user）', () => {
  const result = convertSessionEvent(SESSION, {
    type: 'user/message',
    time: Date.parse('2026-11-08T10:00:00.000Z'),
    data: { id: 'evt-1', content: [{ type: 'text', text: '无来源标记' }] },
  });
  assert.equal(result.input, null);
  assert.equal(result.skip?.kind, 'system-injection');
});

test('非消息事件（turn/step/request/command）被跳过', () => {
  for (const type of ['turn/start', 'step/begin', 'request/created', 'command/run', 'system/message', 'tool/call']) {
    const result = convertSessionEvent(SESSION, { type, data: {} });
    assert.equal(result.input, null, `${type} 不应被转换`);
    assert.equal(result.skip?.kind, 'not-message');
  }
});

test('运行时上下文正文被 RUNTIME_CONTEXT_RE 二次过滤', () => {
  assert.ok(RUNTIME_CONTEXT_RE.test('Current runtime context: ...'));
  assert.ok(RUNTIME_CONTEXT_RE.test('this snapshot supersedes the previous one'));
  assert.ok(!RUNTIME_CONTEXT_RE.test('正常的一句话'));

  const result = convertSessionEvent(SESSION, userEvent({
    content: [{ type: 'text', text: 'Current runtime context: foo' }],
  }));
  assert.equal(result.input, null);
  assert.equal(result.skip?.kind, 'runtime-context');
});

test('提取不到非空 text 的消息被跳过，不写空正文', () => {
  const result = convertSessionEvent(SESSION, userEvent({
    content: [{ type: 'text', text: '   ' }],
  }));
  assert.equal(result.input, null);
  assert.equal(result.skip?.kind, 'no-text');
});

test('缺 event_id 的事件被跳过（没有幂等键不能摄入）', () => {
  const result = convertSessionEvent(SESSION, userEvent({ id: undefined }));
  assert.equal(result.input, null);
  assert.equal(result.skip?.kind, 'no-event-id');
});

test('缺有效 time 的事件被跳过，不伪造时间', () => {
  const result = convertSessionEvent(SESSION, {
    type: 'user/message',
    data: { id: 'evt-1', content: [{ type: 'text', text: '无时间' }], source: { kind: 'user' } },
  });
  assert.equal(result.input, null);
  assert.equal(result.skip?.kind, 'no-time');
});

test('session.id 缺失时 session_id 为空串（不报错、不丢事件）', () => {
  const result = convertSessionEvent(undefined, userEvent());
  assert.notEqual(result.input, null);
  assert.equal(result.input?.session_id, '');
});

// ── 多模态 ────────────────────────────────────────────────────────────────

test('非 text 内容块只取 text 部分，并产生告警（不落字节、不转述）', () => {
  const result = convertSessionEvent(SESSION, userEvent({
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', mime: 'image/png', data: 'AAAA' },
    ],
  }));

  assert.equal(result.input?.raw_text, '看这张图');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /非 text 内容块/);
  assert.match(result.warnings[0] ?? '', /image/);
});

test('assistant 的非 text 块同样告警', () => {
  const result = convertSessionEvent(SESSION, assistantEvent({
    content: [
      { type: 'text', text: '回答' },
      { type: 'audio', data: 'xx' },
    ],
  }));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /audio/);
});

// ── 纯函数性 ──────────────────────────────────────────────────────────────

test('转换是纯函数：同一事件两次转换结果深相等', () => {
  const event = userEvent({ content: [{ type: 'text', text: '在吗' }] });
  const a = convertSessionEvent(SESSION, event);
  const b = convertSessionEvent(SESSION, event);
  assert.deepEqual(a, b);
});

test('joinTextBlocks 与 assistantTextFromBlocks 的口径差异（join vs 取末块）', () => {
  assert.equal(
    joinTextBlocks([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]),
    'A B',
  );
  assert.equal(
    assistantTextFromBlocks([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]),
    'B',
  );
  assert.equal(assistantTextFromBlocks([{ type: 'text', text: 'A' }, { type: 'tool_call' }]), 'A');
  assert.equal(assistantTextFromBlocks('not-an-array'), null);
});
