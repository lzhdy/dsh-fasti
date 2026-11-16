/**
 * #123 P2/P3/P4 · 期望态/比对面/落章 机制红测。
 *
 * 锁定三件事：
 *  1. 派生只在 rules-v2 生效，rules-v1 下期望 cue 恒空（零漂移前提）；
 *  2. cue 哈希进 `sameShape` 后，"关键词从空到有"能产出 `update-card`；
 *  3. `stampMeta` 落第四键 `rules_version`（缺它 rebuild-required 永不触发）。
 *
 * 纪律：临时内存库/纯函数，不读写真根。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import type { EventRecord } from '../../src/contract/event.ts';
import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import { deriveExpectedProjection } from '../../src/memory/derive.ts';
import { planProjection } from '../../src/memory/planner.ts';
import type { PlanCardRef } from '../../src/memory/planner.ts';
import { MEMORY_SCHEMA } from '../../src/memory/schema.ts';
import { stampMeta } from '../../src/memory/store.ts';
import { CURRENT_RULES_VERSION } from '../../src/memory/types.ts';

const T0 = Date.parse('2026-11-08T02:13:20.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const ANCHOR_A = '01J0000000000000000000000A';

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const createdAt = overrides.created_at ?? iso(T0);
  return {
    id: '01J0000000000000000000000E',
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'closed',
    closed_reason: 'silence',
    pointers: [{ id: ANCHOR_A }],
    time_range: { started_at: createdAt, ended_at: createdAt },
    assembled_at: createdAt,
    summary: '用户在讨论荷花翻倍题',
    key_points: ['荷花', '池塘'],
    anchors: [ANCHOR_A],
    topic_lines: [],
    summary_quality: 'ready',
    summary_source: 'llm',
    summary_prompt_version: null,
    summary_model: null,
    effective_chars: null,
    raw_chars: null,
    created_by: 'system',
    created_at: createdAt,
    channel: 'dsh',
    boundary_candidates: [],
    ...overrides,
  };
}

test('#123 P2：rules-v2 从 key_points 派生期望 cue；rules-v1 恒空', () => {
  const event = makeEvent();
  const exists = (): boolean => true;

  const v2 = deriveExpectedProjection({ events: [event], experienceExists: exists, rulesVersion: 'rules-v2' });
  assert.equal(v2.cards.length, 1);
  assert.deepEqual(v2.cards[0]?.cues, ['荷花', '池塘']);

  const v1 = deriveExpectedProjection({ events: [event], experienceExists: exists });
  assert.equal(v1.cards.length, 1);
  assert.deepEqual(v1.cards[0]?.cues, []);
});

function ref(overrides: Partial<PlanCardRef> = {}): PlanCardRef {
  return {
    eventId: '01J0000000000000000000000E',
    cardId: 'mc_test',
    anchors: [ANCHOR_A],
    channel: 'dsh',
    startedMs: T0,
    endedMs: T0,
    ...overrides,
  };
}

test('#123 P2：cue 哈希变化可产出 update-card；相同则无卡动作', () => {
  const changed = planProjection({
    previous: [ref({ cuesHash: 'hash-empty' })],
    current: [ref({ cuesHash: 'hash-filled' })],
    aliases: [],
    rulesVersion: 'rules-v2',
    projectionRulesVersion: 'rules-v2',
  });
  assert.equal(changed.status, 'ok');
  assert.ok(changed.actions.some((action) => action.type === 'update-card'));

  const same = planProjection({
    previous: [ref({ cuesHash: 'hash-filled' })],
    current: [ref({ cuesHash: 'hash-filled' })],
    aliases: [],
    rulesVersion: 'rules-v2',
    projectionRulesVersion: 'rules-v2',
  });
  assert.equal(same.status, 'ok');
  assert.equal(same.actions.filter((action) => action.type === 'update-card').length, 0);
});

test('#123 P2 零漂移锁：两侧都不传 cuesHash 时与接入前完全一致（无卡动作）', () => {
  const result = planProjection({
    previous: [ref()],
    current: [ref()],
    aliases: [],
    rulesVersion: CURRENT_RULES_VERSION,
    projectionRulesVersion: CURRENT_RULES_VERSION,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.actions.length, 0);
});

test('#123 P4：stampMeta 写第四键 rules_version', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const statement of MEMORY_SCHEMA) {
      db.exec(statement);
    }
    stampMeta(db, {
      schema_version: 1,
      stamped_revision: 1,
      truth_fingerprint: 'fp-test',
      rules_version: CURRENT_RULES_VERSION,
    });
    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('rules_version') as
      | { value: string }
      | undefined;
    assert.equal(row?.value, CURRENT_RULES_VERSION);
    // 旧三键仍在，避免盖章改造误伤既有读取面。
    const schemaVersion = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined;
    assert.equal(schemaVersion?.value, '1');
  } finally {
    db.close();
  }
});
