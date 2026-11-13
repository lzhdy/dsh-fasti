/**
 * C3 失效纯函数测试 —— invalidate（方案 §3.3 / §4.5 / §11.3 M5；裁决 G7–G11、G13）。
 *
 * 纪律：
 *  - 纯函数用例不触库、不触文件系统；输入深冻结，任何原地改写当场抛错；
 *  - M5：六类表驱动 + 同输入重复 100 次逐字节一致（atMs 注入，无当前时间副作用）；
 *  - duplicate-selection 本期不在纯函数内判定（G8 采 B）：表驱动全行断言恒不触发，
 *    该类以构建期拦截口径在 builder 侧覆盖（本文件末尾，临时根）；
 *  - G13 反漂移：isEffectiveAt 与 listEffective 同一 SQL 谓词在边界时刻网格上逐卡一致；
 *  - 全部库操作在 tests/helpers 临时根，真实数据根零接触。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import type { EventRecord } from '../../src/contract/event.ts';
import { appendJsonl } from '../../src/core/jsonl.ts';
import { ulid } from '../../src/core/ulid.ts';
import {
  buildMemoryIndex,
  computeContentHash,
  computeRowHashSum,
  computeTruthFingerprint,
  deriveCardId,
} from '../../src/memory/builder.ts';
import {
  evaluateInvalidation,
  isEffectiveAt,
} from '../../src/memory/invalidate.ts';
import type { InvalidationInput, InvalidationResult } from '../../src/memory/invalidate.ts';
import { readRevisions } from '../../src/memory/ledger.ts';
import { MEMORY_INDEX_FILE, openMemoryRead, openMemoryWrite } from '../../src/memory/store.ts';
import type { AliasRow, MemoryCard, RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, makeExperience, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const AT = T0 + 10 * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();

// ── 夹具 ──────────────────────────────────────────────────────────────────

function mkCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  const base: MemoryCard = {
    cardId: 'mc_card_a',
    eventId: 'evt-a',
    anchorJson: '["exp-1"]',
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson: '["线索一"]',
    aliasesJson: '[]',
    discriminator: '区别短句',
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: 'hash-a',
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  return { ...base, ...overrides };
}

function mkAlias(termNorm: string, cardId: string, overrides: Partial<AliasRow> = {}): AliasRow {
  return {
    termNorm,
    cardId,
    source: 'miss',
    sensitive: 0,
    status: 'active',
    createdMs: T0,
    hitCount: 0,
    lastHitMs: null,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

const ACTIVE: InvalidationResult = {
  status: 'active',
  invalidMs: null,
  reason: null,
  successorCardHints: [],
};

// ── 六类表驱动（§4.5）+ 裁决边界行 ────────────────────────────────────────

interface Row {
  name: string;
  input: InvalidationInput;
  expected: InvalidationResult;
}

const TABLE: Row[] = [
  {
    name: '无变化：无作废/无事件变更/无别名冲突 → active',
    input: { card: mkCard(), atMs: AT, aliasTable: [] },
    expected: ACTIVE,
  },
  {
    name: '同窗冲突：同 term_norm 指向另一张同窗 active 卡 → alias-conflict',
    input: {
      card: mkCard({ aliasesJson: '[{"term":"咖啡馆","source":"miss","sensitive":0}]' }),
      atMs: AT,
      aliasTable: [mkAlias('咖啡馆', 'mc_card_b')],
    },
    expected: { status: 'invalid', invalidMs: AT, reason: 'alias-conflict', successorCardHints: [] },
  },
  {
    name: '跨窗接力：merged → superseded + successor 提示原样',
    input: {
      card: mkCard(),
      atMs: AT,
      eventChange: { kind: 'merged', successorEventIds: ['evt-b'] },
      aliasTable: [],
    },
    expected: {
      status: 'superseded',
      invalidMs: AT,
      reason: 'anchor-superseded',
      successorCardHints: ['evt-b'],
    },
  },
  {
    name: '事件 split 一对多：successorEventIds 原样、不自动迁卡',
    input: {
      card: mkCard(),
      atMs: AT,
      eventChange: { kind: 'split', successorEventIds: ['evt-b', 'evt-c', 'evt-d'] },
      aliasTable: [],
    },
    expected: {
      status: 'superseded',
      invalidMs: AT,
      reason: 'anchor-superseded',
      successorCardHints: ['evt-b', 'evt-c', 'evt-d'],
    },
  },
  {
    name: 'alias 冲突：卡内多词只要一词双卡即冲突（区分恒成立口径，G10）',
    input: {
      card: mkCard({
        aliasesJson:
          '[{"term":"深夜食堂","source":"miss","sensitive":0},{"term":"咖啡馆","source":"miss","sensitive":0}]',
      }),
      atMs: AT,
      aliasTable: [mkAlias('无关词', 'mc_card_b'), mkAlias('深夜食堂', 'mc_card_b')],
    },
    expected: { status: 'invalid', invalidMs: AT, reason: 'alias-conflict', successorCardHints: [] },
  },
  {
    name: 'manual tombstone：expiredMs 非空即判，invalidMs 取 expiredMs 不取 atMs（G9）',
    input: { card: mkCard({ expiredMs: T0 + 2 * DAY }), atMs: AT, aliasTable: [] },
    expected: {
      status: 'invalid',
      invalidMs: T0 + 2 * DAY,
      reason: 'manual-tombstone',
      successorCardHints: [],
    },
  },
  {
    name: 'reopened 与 merged/split 同判（G7）：superseded + anchor-superseded',
    input: {
      card: mkCard(),
      atMs: AT,
      eventChange: { kind: 'reopened', successorEventIds: ['evt-a-v2'] },
      aliasTable: [],
    },
    expected: {
      status: 'superseded',
      invalidMs: AT,
      reason: 'anchor-superseded',
      successorCardHints: ['evt-a-v2'],
    },
  },
  {
    name: '优先级：manual-tombstone > anchor-superseded；hints 仍原样给 eventChange（G11）',
    input: {
      card: mkCard({ expiredMs: T0 + 2 * DAY }),
      atMs: AT,
      eventChange: { kind: 'merged', successorEventIds: ['evt-b'] },
      aliasTable: [],
    },
    expected: {
      status: 'invalid',
      invalidMs: T0 + 2 * DAY,
      reason: 'manual-tombstone',
      successorCardHints: ['evt-b'],
    },
  },
  {
    name: '优先级：anchor-superseded > alias-conflict',
    input: {
      card: mkCard({ aliasesJson: '[{"term":"咖啡馆","source":"miss","sensitive":0}]' }),
      atMs: AT,
      eventChange: { kind: 'split', successorEventIds: ['evt-b', 'evt-c'] },
      aliasTable: [mkAlias('咖啡馆', 'mc_card_b')],
    },
    expected: {
      status: 'superseded',
      invalidMs: AT,
      reason: 'anchor-superseded',
      successorCardHints: ['evt-b', 'evt-c'],
    },
  },
  {
    name: '优先级：manual-tombstone > alias-conflict',
    input: {
      card: mkCard({
        expiredMs: T0 + 2 * DAY,
        aliasesJson: '[{"term":"咖啡馆","source":"miss","sensitive":0}]',
      }),
      atMs: AT,
      aliasTable: [mkAlias('咖啡馆', 'mc_card_b')],
    },
    expected: {
      status: 'invalid',
      invalidMs: T0 + 2 * DAY,
      reason: 'manual-tombstone',
      successorCardHints: [],
    },
  },
  {
    name: '三重叠：tombstone + eventChange + alias 冲突 → manual-tombstone 胜出',
    input: {
      card: mkCard({
        expiredMs: T0 + 2 * DAY,
        aliasesJson: '[{"term":"咖啡馆","source":"miss","sensitive":0}]',
      }),
      atMs: AT,
      eventChange: { kind: 'reopened', successorEventIds: ['evt-a-v2'] },
      aliasTable: [mkAlias('咖啡馆', 'mc_card_b')],
    },
    expected: {
      status: 'invalid',
      invalidMs: T0 + 2 * DAY,
      reason: 'manual-tombstone',
      successorCardHints: ['evt-a-v2'],
    },
  },
  {
    name: 'tombstoned 别名行不计冲突（保守判据只看 active，G10）',
    input: {
      card: mkCard({ aliasesJson: '[{"term":"咖啡馆","source":"miss","sensitive":0}]' }),
      atMs: AT,
      aliasTable: [mkAlias('咖啡馆', 'mc_card_b', { status: 'tombstoned' })],
    },
    expected: ACTIVE,
  },
  {
    name: '同卡别名行不计冲突（cardId 相同）',
    input: {
      card: mkCard({ aliasesJson: '[{"term":"咖啡馆","source":"miss","sensitive":0}]' }),
      atMs: AT,
      aliasTable: [mkAlias('咖啡馆', 'mc_card_a')],
    },
    expected: ACTIVE,
  },
  {
    name: '不同 term_norm 不计冲突',
    input: {
      card: mkCard({ aliasesJson: '[{"term":"咖啡馆","source":"miss","sensitive":0}]' }),
      atMs: AT,
      aliasTable: [mkAlias('茶馆', 'mc_card_b')],
    },
    expected: ACTIVE,
  },
  {
    name: '空别名卡：aliasTable 非空也不冲突',
    input: { card: mkCard(), atMs: AT, aliasTable: [mkAlias('咖啡馆', 'mc_card_b')] },
    expected: ACTIVE,
  },
  {
    name: 'eventChange 空 successor 列表：hints 原样为空数组',
    input: {
      card: mkCard(),
      atMs: AT,
      eventChange: { kind: 'merged', successorEventIds: [] },
      aliasTable: [],
    },
    expected: {
      status: 'superseded',
      invalidMs: AT,
      reason: 'anchor-superseded',
      successorCardHints: [],
    },
  },
];

test('M5 六类表驱动：逐行断言冻结规则（§4.5 / G7–G11）', () => {
  for (const row of TABLE) {
    const actual = evaluateInvalidation(deepFreeze(structuredClone(row.input)));
    assert.deepEqual(actual, row.expected, row.name);
  }
});

test('M5 同输入重复 100 次：结果逐字节一致、输入零改写（深冻结守卫）', () => {
  for (const row of TABLE) {
    const input = deepFreeze(structuredClone(row.input));
    const before = JSON.stringify(input);
    const first = JSON.stringify(evaluateInvalidation(input));
    for (let i = 0; i < 100; i += 1) {
      assert.equal(JSON.stringify(evaluateInvalidation(input)), first, `${row.name} 第 ${i} 次`);
    }
    assert.equal(JSON.stringify(input), before, `${row.name} 输入被改写`);
  }
});

test('G8：duplicate-selection 在纯函数内恒不触发（构建期拦截为主）', () => {
  for (const row of TABLE) {
    const result = evaluateInvalidation(deepFreeze(structuredClone(row.input)));
    assert.notEqual(result.reason, 'duplicate-selection', row.name);
  }
  // 即便 aliasTable 出现「同 anchor 集合的第二张 selected 卡」形态，纯函数也不判该 reason：
  // 冻结入参不含 otherActiveCards，函数无从也无需判定（不扩 §3.3 入参）。
  const result = evaluateInvalidation(
    deepFreeze({
      card: mkCard({ aliasesJson: '[{"term":"咖啡馆","source":"miss","sensitive":0}]' }),
      atMs: AT,
      aliasTable: [mkAlias('咖啡馆', 'mc_card_b')],
    }),
  );
  assert.equal(result.reason, 'alias-conflict', '同词双卡走 alias-conflict，不是 duplicate-selection');
});

// ── isEffectiveAt：as-of 三条件边界（与 listEffective SQL 同构，G13）────────

test('isEffectiveAt 边界：valid<=T、invalid 空或>T、created<=T', () => {
  const card = mkCard();
  assert.equal(isEffectiveAt(card, T0), true, 'valid==T 且 created==T 有效');
  assert.equal(isEffectiveAt(card, T0 - 1), false, 'T 早于 valid/created 无效');
  assert.equal(isEffectiveAt(mkCard({ validMs: T0 + 1 }), T0), false, 'valid>T 无效');
  assert.equal(isEffectiveAt(mkCard({ createdMs: T0 + 1 }), T0), false, 'created>T 无效');
  assert.equal(isEffectiveAt(mkCard({ invalidMs: T0 }), T0), false, 'invalid==T 无效（严格 >T）');
  assert.equal(isEffectiveAt(mkCard({ invalidMs: T0 + 1 }), T0), true, 'invalid>T 有效');
  assert.equal(isEffectiveAt(mkCard({ invalidMs: null }), AT), true, 'invalid 空恒有效（其余条件满足）');
  assert.equal(
    isEffectiveAt(mkCard({ validMs: T0, invalidMs: T0 + 5 * DAY, createdMs: T0 }), T0 + 5 * DAY),
    false,
    'invalid 边界时刻已失效',
  );
});

test('G13 反漂移：isEffectiveAt 与 listEffective 同一谓词在边界网格上逐卡一致', async () => {
  const root = makeTempRoot('invalidate-equivalence-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const cards = [
    mkCard({ cardId: 'mc_eq_1' }),
    mkCard({ cardId: 'mc_eq_2', invalidMs: T0 + 5 * DAY }),
    mkCard({ cardId: 'mc_eq_3', validMs: T0 + 5 * DAY }),
    mkCard({ cardId: 'mc_eq_4', createdMs: T0 + 5 * DAY }),
    mkCard({ cardId: 'mc_eq_5', invalidMs: T0 }),
    mkCard({ cardId: 'mc_eq_6', validMs: T0 + 2 * DAY, createdMs: T0 + 2 * DAY, invalidMs: T0 + 2 * DAY }),
  ];
  const handle = openMemoryWrite({ indexDir });
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 1,
      truth_fingerprint: 'fp-equivalence-test',
      prior_revision: null,
      card_count: cards.length,
      alias_count: 0,
      row_hash_sum: computeRowHashSum(cards),
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    handle.transactionApply({ cards, aliases: [] }, revision, []);
  } finally {
    await handle.close();
  }

  const read = openMemoryRead({ indexDir });
  try {
    const grid = [
      T0 - 1, T0, T0 + 1,
      T0 + 2 * DAY - 1, T0 + 2 * DAY, T0 + 2 * DAY + 1,
      T0 + 5 * DAY - 1, T0 + 5 * DAY, T0 + 5 * DAY + 1,
      AT,
    ];
    for (const atMs of grid) {
      const viaSql = read.listEffective(atMs).map((c) => c.cardId).sort();
      const viaPure = cards.filter((c) => isEffectiveAt(c, atMs)).map((c) => c.cardId).sort();
      assert.deepEqual(viaPure, viaSql, `as-of 谓词漂移 @ ${atMs}`);
    }
  } finally {
    await read.close();
    cleanupTempRoot(root);
  }
});

// ── G8 构建期拦截：duplicate-selection 由 builder 确定性幂等覆盖 ───────────

function eventRecord(id: string, anchors: string[]): EventRecord {
  return {
    id,
    schema_version: 1,
    version: 1,
    status: 'closed',
    closed_reason: 'silence',
    pointers: anchors.map((a) => ({ id: a })),
    time_range: { started_at: iso(T0), ended_at: iso(T0 + DAY) },
    assembled_at: iso(T0 + DAY),
    summary: '客观摘要（仅供测试阅读，不进卡）',
    key_points: ['关键点一'],
    anchors,
    topic_lines: [],
    summary_quality: 'ready',
    summary_source: 'llm',
    summary_prompt_version: null,
    summary_model: null,
    effective_chars: null,
    raw_chars: null,
    created_by: 'system',
    created_at: iso(T0 + DAY),
    channel: 'dsh',
    boundary_candidates: [],
  };
}

test('G8 构建期拦截：同真值同决策连建两次，同 anchor 集合不产生第二张 selected 卡', async () => {
  const root = makeTempRoot('invalidate-dup-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const e1 = ulid();
  appendJsonl(
    path.join(root, 'experiences', '2026-11.jsonl'),
    makeExperience({ id: e1, tick: 0, occurred_at: iso(T0), recorded_at: iso(T0) }),
  );
  const event = eventRecord(ulid(), [e1]);
  appendJsonl(path.join(root, 'events', '2026-11.jsonl'), event);

  const cardId = deriveCardId(event.id, event.anchors);
  const anchorJson = JSON.stringify(event.anchors);
  const displayCuesJson = '["咖啡馆线索"]';
  const aliasesJson = '[]';
  const discriminator = '区别短句';
  const card = mkCard({
    cardId,
    eventId: event.id,
    anchorJson,
    displayCuesJson,
    aliasesJson,
    discriminator,
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, discriminator),
  });

  const handle = openMemoryWrite({ indexDir });
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 1,
      truth_fingerprint: computeTruthFingerprint(root).aggregate,
      prior_revision: null,
      card_count: 1,
      alias_count: 0,
      row_hash_sum: computeRowHashSum([card]),
      shadow_diff: { added: 1, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    handle.transactionApply({ cards: [card], aliases: [] }, revision, [
      {
        decision_id: ulid(),
        at_ms: T0,
        action: 'create-card',
        card_id: cardId,
        event_id: event.id,
        anchor_json: anchorJson,
        content_hash: card.contentHash,
        model_tag: 'rules-v1',
        reason: 'fixture: 测试建卡',
        created_by: 'her',
      },
    ]);
  } finally {
    await handle.close();
  }

  const report1 = await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + 20 * DAY });
  const report2 = await buildMemoryIndex({ dataRoot: root, dryRun: false, nowMs: T0 + 21 * DAY });
  assert.equal(report1.revision, 2);
  assert.equal(report2.revision, 3);
  assert.deepEqual(report2.shadowDiff, { added: 0, removed: 0, changed: 0 }, '第二次构建零差异');

  const revisions = readRevisions(indexDir);
  assert.equal(revisions.length, 3);
  assert.equal(revisions[2]!.row_hash_sum, revisions[1]!.row_hash_sum, 'row_hash_sum 幂等');

  const db = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
  try {
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM mem_card WHERE event_id = ?')
      .get(event.id) as { n: number };
    assert.equal(count.n, 1, '同 anchor 集合只有一张卡（构建期幂等拦截）');
    const row = db
      .prepare('SELECT card_id, selection, status FROM mem_card WHERE event_id = ?')
      .get(event.id) as { card_id: string; selection: string; status: string };
    assert.equal(row.card_id, cardId, '确定性 id 不变');
    assert.equal(row.selection, 'selected');
    assert.equal(row.status, 'active');
    const total = db.prepare('SELECT COUNT(*) AS n FROM mem_card').get() as { n: number };
    assert.equal(total.n, 1, '全库无第二张 selected 卡');
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});