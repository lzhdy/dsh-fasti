/**
 * Experience schema 契约测试（审计第四节阶段 0 验收项：
 * 「Experience schema 与定案稿 §4.2 字段逐一对应，无新增『重要性』类字段、无聊天前提字段」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPERIENCE_FIELDS,
  FORBIDDEN_CONVERSATION_FIELDS,
  FORBIDDEN_SEMANTIC_FIELDS,
  KNOWN_KINDS,
  isForbiddenFieldName,
} from '../../src/contract/experience.ts';
import { parseExperience } from '../../src/contract/validate-experience.ts';
import { SchemaError } from '../../src/core/errors.ts';
import { makeExperience } from '../helpers.ts';

test('字段集合与定案稿 §4.2 逐一对应', () => {
  // §4.2 中必填字段（可选字段以 ? 标注）。
  const required = [
    'id',
    'schema_version',
    'kind',
    'scene',
    'initiation',
    'observation',
    'occurred_at',
    'recorded_at',
    'tick',
  ] as const;

  const parsed = parseExperience(makeExperience());
  for (const field of required) {
    assert.ok(field in parsed, `缺少必填字段 ${field}`);
  }

  // 可选字段在提供时必须被识别。
  const full = parseExperience(
    makeExperience({
      agent_meta: { model: 'test-model', persona_version: 'v1' },
      action: { type: 'reply' },
      outcome: { status: 'success' },
      marks: [{ type: 'x', by: 'rule-layer' }],
      pointers: [{ type: 'references', target: 'other-id' }],
    }),
  );
  for (const field of ['agent_meta', 'action', 'outcome', 'marks', 'pointers']) {
    assert.ok(field in full, `缺少可选字段 ${field}`);
  }

  // 出现的字段不得超出 §4.2 的字段集合。
  const known = new Set<string>(EXPERIENCE_FIELDS);
  for (const key of Object.keys(full)) {
    assert.ok(known.has(key), `出现了 §4.2 之外的字段 ${key}`);
  }
});

test('schema 不含任何『重要性』类字段（红线②）', () => {
  const serialized = JSON.stringify(parseExperience(makeExperience()));
  for (const forbidden of FORBIDDEN_SEMANTIC_FIELDS) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `schema 出现了重要性类字段 ${forbidden}`);
  }
});

test('schema 不含任何『聊天/对话』前提字段（红线①）', () => {
  const serialized = JSON.stringify(parseExperience(makeExperience()));
  for (const forbidden of FORBIDDEN_CONVERSATION_FIELDS) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `schema 出现了聊天前提字段 ${forbidden}`);
  }
  // 会话只以 scene.ref 承载，不是独立字段。
  assert.ok(!('session_id' in parseExperience(makeExperience())));
});

test('kind 是开放枚举：dialogue 只是六种已知形状之一', () => {
  for (const kind of KNOWN_KINDS) {
    const parsed = parseExperience(makeExperience({ kind }));
    assert.equal(parsed.kind, kind);
  }
  // 未知形状照样合法（旧读取器遇未知值必须原样保留，不得丢弃）。
  const unknown = parseExperience(makeExperience({ kind: 'weather-mood-shift' }));
  assert.equal(unknown.kind, 'weather-mood-shift');
});

test('initiation 是开放枚举：已知四态 + 任意扩展', () => {
  for (const initiation of ['user', 'her', 'system', 'environment', 'weather']) {
    assert.equal(parseExperience(makeExperience({ initiation })).initiation, initiation);
  }
});

test('scene.channel 是一等维度且开放', () => {
  const parsed = parseExperience(makeExperience({ scene: { channel: 'camera', ref: 'stream-7' } }));
  assert.equal(parsed.scene.channel, 'camera');
  assert.equal(parsed.scene.ref, 'stream-7');
});

test('scene.detail 允许通道自定义键值（开放）', () => {
  const parsed = parseExperience(
    makeExperience({ scene: { channel: 'qq', ref: 'chat-1', detail: { 群号: '12345', 站点: 'example' } } }),
  );
  assert.deepEqual(parsed.scene.detail, { 群号: '12345', 站点: 'example' });
});

test('三段槽位形状冻结：observation / action / outcome', () => {
  const parsed = parseExperience(
    makeExperience({
      observation: { text: { id: 'raw-1', channel: 'dsh' }, cue: '线索' },
      action: { type: 'tool-call', tool: 'browser', args: { id: 'raw-2' } },
      outcome: { text: '完成', status: 'success', duration_ms: 12 },
    }),
  );
  assert.equal(parsed.observation.cue, '线索');
  assert.equal(parsed.action?.type, 'tool-call');
  assert.equal(parsed.outcome?.status, 'success');
});

test('cue 超过硬上限 200 字符即拒绝（定案稿 §4.2）', () => {
  assert.throws(
    () => parseExperience(makeExperience({ observation: { cue: 'x'.repeat(201) } })),
    SchemaError,
  );
  assert.doesNotThrow(() => parseExperience(makeExperience({ observation: { cue: 'x'.repeat(200) } })));
});

test('时间三轴齐备：occurred_at / recorded_at / tick', () => {
  const parsed = parseExperience(makeExperience());
  assert.equal(typeof parsed.occurred_at, 'string');
  assert.equal(typeof parsed.recorded_at, 'string');
  assert.equal(typeof parsed.tick, 'number');
});

test('Pointer.seq 从 0 起算、区间为闭区间', () => {
  const single = parseExperience(makeExperience({ observation: { text: { seq: 0 } } }));
  assert.deepEqual(single.observation.text?.seq, 0);

  const range = parseExperience(makeExperience({ observation: { text: { seq: [2, 5] } } }));
  assert.deepEqual(range.observation.text?.seq, [2, 5]);

  assert.throws(() => parseExperience(makeExperience({ observation: { text: { seq: -1 } } })), SchemaError);
  assert.throws(() => parseExperience(makeExperience({ observation: { text: { seq: [5, 2] } } })), SchemaError);
  // 单元素区间是类型上就非法的形状 —— 用 as never 表达「运行期也要拒绝」。
  assert.throws(
    () => parseExperience(makeExperience({ observation: { text: { seq: [1] } } } as never)),
    SchemaError,
  );
});

test('marks 只贴标签：by 必须是 rule-layer，永不表示重要性', () => {
  const parsed = parseExperience(
    makeExperience({ marks: [{ type: 'possible-interesting', by: 'rule-layer', note: '流里留意' }] }),
  );
  assert.equal(parsed.marks?.[0]?.by, 'rule-layer');
  assert.throws(
    () => parseExperience(makeExperience({ marks: [{ type: 'x', by: 'system' }] } as never)),
    SchemaError,
    'marks.by 不是 rule-layer 时必须拒绝',
  );
});

test('未知字段原样保留（定案稿 §10.4 C2）', () => {
  const raw = { ...makeExperience(), future_field: { nested: true }, another: 42 };
  const parsed = parseExperience(raw as never);
  assert.deepEqual((parsed as unknown as Record<string, unknown>)['future_field'], { nested: true });
  assert.equal((parsed as unknown as Record<string, unknown>)['another'], 42);
});

test('写入路径拒绝『重要性』类与『聊天前提』类字段名', () => {
  assert.throws(
    () => parseExperience({ ...makeExperience(), importance: 0.9 } as never, 'write'),
    SchemaError,
  );
  assert.throws(
    () => parseExperience({ ...makeExperience(), session_id: 's-1' } as never, 'write'),
    SchemaError,
  );
  // 读取路径把它当普通未知字段 —— 不报错、不丢弃。
  const read = parseExperience({ ...makeExperience(), importance: 0.9 } as never, 'read');
  assert.equal((read as unknown as Record<string, unknown>)['importance'], 0.9);
});

test('isForbiddenFieldName 精确匹配（不误伤同前缀字段）', () => {
  assert.equal(isForbiddenFieldName('importance'), true);
  assert.equal(isForbiddenFieldName('Importance'), true);
  assert.equal(isForbiddenFieldName('chat_id'), true);
  assert.equal(isForbiddenFieldName('important_note'), false);
  assert.equal(isForbiddenFieldName('scene_ref'), false);
});

test('MediaRef 有字节时必须带 sha256（完整性校验前提）', () => {
  assert.throws(
    () =>
      parseExperience(
        makeExperience({
          observation: {
            media: [
              {
                ref_id: '01J0000000000000000000000M',
                kind: 'image',
                mime: 'image/png',
                bytes: 1024,
                origin: { channel: 'dsh', host_ref: 'att-1', captured_at: '2026-11-08T10:00:00.000Z' },
              },
            ],
          },
        }),
      ),
    SchemaError,
  );
});

test('MediaRef 不含 status / local 字段（状态是折叠不是字段，定案稿 §6.2）', () => {
  const parsed = parseExperience(
    makeExperience({
      observation: {
        media: [
          {
            ref_id: '01J0000000000000000000000M',
            kind: 'image',
            mime: 'image/png',
            origin: { channel: 'dsh', host_ref: 'att-1', captured_at: '2026-11-08T10:00:00.000Z' },
          },
        ],
      },
    }),
  );
  const media = parsed.observation.media?.[0] as unknown as Record<string, unknown>;
  assert.ok(!('status' in media), 'MediaRef 不得含 status');
  assert.ok(!('local' in media), 'MediaRef 不得含 local');
});
