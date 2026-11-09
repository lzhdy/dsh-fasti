/**
 * 嵌套未知字段的宽容度（审计 N2 / 阶段 0 · G05）。
 *
 * 契约：未知字段按模式分流 ——
 *  - read ：未知字段（含嵌套层）原样带过，不报错、不裁剪；
 *  - write：未知字段即契约违约 → 抛错（写入边界不放松）。
 *
 * 红线纪律：禁字段拦截（importance/score/session_id/chat_id）在 write 模式下
 * 一点都不能弱化 —— 本次只放宽「未知字段」这一项。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseExperience } from '../../src/contract/validate-experience.ts';
import { SchemaError } from '../../src/core/errors.ts';
import { makeExperience } from '../helpers.ts';

/** 带各层未知字段的一条经历。 */
function experienceWithNestedExtras(): Record<string, unknown> {
  return {
    ...makeExperience(),
    scene: { channel: 'dsh', ref: 's-1', future_scene: '场景侧新字段' },
    observation: {
      cue: '线索',
      future_observation: { deep: true },
      text: { id: 'raw-1', channel: 'dsh', future_pointer: '指针侧新字段' },
      media: [
        {
          ref_id: '01J0000000000000000000000M',
          kind: 'image',
          mime: 'image/png',
          origin: { channel: 'dsh', host_ref: 'att-1', captured_at: '2026-11-08T10:00:00.000Z' },
          future_media: '媒体侧新字段',
        },
      ],
    },
    action: { type: 'tool-call', future_action: 1 },
    outcome: { status: 'success', future_outcome: true },
  };
}

test('G05：read 模式 —— 嵌套层的未知字段不抛错', () => {
  assert.doesNotThrow(() => parseExperience(experienceWithNestedExtras() as never, 'read'));
});

test('G05：read 模式 —— 嵌套层的未知字段原样保留（不裁剪）', () => {
  const parsed = parseExperience(experienceWithNestedExtras() as never, 'read');

  const scene = parsed.scene as unknown as Record<string, unknown>;
  assert.equal(scene['future_scene'], '场景侧新字段');

  const observation = parsed.observation as unknown as Record<string, unknown>;
  assert.deepEqual(observation['future_observation'], { deep: true });

  const text = parsed.observation.text as unknown as Record<string, unknown>;
  assert.equal(text['future_pointer'], '指针侧新字段');

  const media = parsed.observation.media?.[0] as unknown as Record<string, unknown>;
  assert.equal(media['future_media'], '媒体侧新字段');

  const action = parsed.action as unknown as Record<string, unknown>;
  assert.equal(action['future_action'], 1);

  const outcome = parsed.outcome as unknown as Record<string, unknown>;
  assert.equal(outcome['future_outcome'], true);
});

test('G05：默认模式即 read —— 真源读取路径（experience-log 用它）同样宽容', () => {
  assert.doesNotThrow(() => parseExperience(experienceWithNestedExtras() as never));
});

test('G05：write 模式 —— 嵌套层的未知字段仍然抛错（写入边界不放松）', () => {
  assert.throws(
    () => parseExperience(experienceWithNestedExtras() as never, 'write'),
    SchemaError,
  );
});

test('G05：write 模式 —— 逐个嵌套结构都拦未知字段', () => {
  const base = makeExperience();
  const cases: Array<[string, Record<string, unknown>]> = [
    ['scene', { ...base, scene: { channel: 'dsh', ref: 's-1', extra: 1 } }],
    [
      'observation',
      { ...base, observation: { cue: 'x', extra: 1 } },
    ],
    [
      'observation.text',
      { ...base, observation: { text: { id: 'raw-1', extra: 1 } } },
    ],
    ['action', { ...base, action: { type: 'tool-call', extra: 1 } }],
    ['outcome', { ...base, outcome: { status: 'success', extra: 1 } }],
  ];

  for (const [label, raw] of cases) {
    assert.throws(
      () => parseExperience(raw as never, 'write'),
      SchemaError,
      `${label} 的未知字段在 write 模式必须被拦下`,
    );
  }
});

test('G05：红线未弱化 —— write 模式仍拒绝「重要性」类与「聊天前提」类字段名', () => {
  for (const forbidden of ['importance', 'score', 'session_id', 'chat_id']) {
    assert.throws(
      () => parseExperience({ ...makeExperience(), [forbidden]: 'x' } as never, 'write'),
      SchemaError,
      `${forbidden} 在 write 模式必须被拒绝`,
    );
  }
});

test('G05：红线未弱化 —— 嵌套层的禁字段名在 write 模式下同样被拦下', () => {
  assert.throws(
    () =>
      parseExperience(
        { ...makeExperience(), observation: { cue: 'x', importance: 0.9 } } as never,
        'write',
      ),
    SchemaError,
  );
});

test('G05：read 模式 —— 禁字段名只当普通未知字段保留（不报错、不丢弃）', () => {
  const parsed = parseExperience(
    { ...makeExperience(), observation: { cue: 'x', importance: 0.9 } } as never,
    'read',
  );
  const observation = parsed.observation as unknown as Record<string, unknown>;
  assert.equal(observation['importance'], 0.9);
});

test('G05：scene.detail 是开放字典 —— 内层键不算未知字段（read/write 都不拦）', () => {
  const raw = {
    ...makeExperience(),
    scene: { channel: 'qq', ref: 'chat-1', detail: { 群号: '12345', 站点: 'example' } },
  };
  assert.doesNotThrow(() => parseExperience(raw as never, 'read'));
  assert.doesNotThrow(() => parseExperience(raw as never, 'write'));

  const parsed = parseExperience(raw as never, 'read');
  assert.deepEqual(parsed.scene.detail, { 群号: '12345', 站点: 'example' });
});

test('G05：write 模式 —— 媒体元素的未知字段维持既有行为（不拦截、也不保留）', () => {
  const raw = {
    ...makeExperience(),
    observation: {
      media: [
        {
          ref_id: '01J0000000000000000000000M',
          kind: 'image',
          mime: 'image/png',
          origin: { channel: 'dsh', host_ref: 'att-1', captured_at: '2026-11-08T10:00:00.000Z' },
          extra: 'x',
        },
      ],
    },
  };
  // 媒体元素本就没有字段名白名单（既有行为）—— 本次不扩大改动面。
  assert.doesNotThrow(() => parseExperience(raw as never, 'write'));
  const media = parseExperience(raw as never, 'write').observation.media?.[0] as unknown as Record<
    string,
    unknown
  >;
  assert.equal(media['extra'], undefined, 'write 模式维持既有行为：媒体未知字段被丢弃');
});
