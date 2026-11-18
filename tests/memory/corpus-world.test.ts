/**
 * D1 红测：合成世界蓝本、盲包纪律、诱饵近邻产能与端到端建根（v4 §9 序8/§8）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  buildWorldPlan,
  sealedEvents,
  tuningEvents,
  SEALED_EVENT_COUNT,
  TUNING_EVENT_COUNT,
  TOTAL_EVENT_COUNT,
  SEALED_FAMILY_COUNT,
  TUNING_FAMILY_COUNT,
  FAMILY_SIZE,
  HIGH_RISK_LABELS,
  WORLD_SCHEMA,
} from '../../src/memory/audit/corpus/world-plan.ts';
import {
  buildBlindPackage,
  assertBlindPackageSafe,
  BLIND_FORBIDDEN_KEYS,
} from '../../src/memory/audit/corpus/blind-package.ts';
import { deriveCuesFromKeyPoints } from '../../src/memory/cue-derive.ts';
import { normalizeDisplayCues } from '../../src/memory/builder.ts';
import { buildDecoyPairs } from '../../src/memory/audit/decoy.ts';
import type { MemoryCard } from '../../src/memory/types.ts';
import { ingestWorld, seedDerivedCards, ensureFreshDir } from '../../scripts/p6/build-synthetic-world.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 复刻 run-memory-audit.ts:330 的日历周桶算法（D1 必须保证 ≥5 桶以走真 holdout）。 */
function auditWeekKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-W${Math.floor(date.getUTCMonth() * 4.34 + date.getUTCDate() / 7)}`;
}

test('蓝本结构：100 事件＝80 封存＋20 调参，id 唯一，每事件固定 3 条短 key_points', () => {
  const plan = buildWorldPlan();
  assert.equal(plan.schema, WORLD_SCHEMA);
  assert.equal(plan.events.length, TOTAL_EVENT_COUNT);
  assert.equal(sealedEvents(plan).length, SEALED_EVENT_COUNT);
  assert.equal(tuningEvents(plan).length, TUNING_EVENT_COUNT);
  const ids = plan.events.map((event) => event.eventId);
  assert.equal(new Set(ids).size, TOTAL_EVENT_COUNT, '事件 id 全唯一');
  for (const event of plan.events) {
    assert.equal(event.keyPoints.length, 3);
    for (const point of event.keyPoints) {
      assert.ok([...point].length <= 10, 'key_points 全短于 H7 20 码点门槛，绝不触发摘要反查误伤');
    }
    assert.ok(event.turns.length >= 6, '每事件至少 6 条用户原话供 S0/S1 出题');
    assert.equal(event.sensitiveTerms.length, 1);
  }
});

test('确定性：同 seed 两次构建逐字一致，换 seed 改种子可追溯', () => {
  assert.deepEqual(buildWorldPlan(), buildWorldPlan());
  assert.notEqual(buildWorldPlan(1).seed, buildWorldPlan(2).seed);
  assert.deepEqual(buildWorldPlan(1), buildWorldPlan(1));
});

test('族结构：16 封存族每族 5 事件共享族点，族间族点互不复用（诱饵近邻图的设计前提）', () => {
  const sealed = sealedEvents(buildWorldPlan());
  const families = new Map<string, string[][]>();
  for (const event of sealed) {
    const list = families.get(event.familyId) ?? [];
    list.push([...event.keyPoints]);
    families.set(event.familyId, list);
  }
  assert.equal(families.size, SEALED_FAMILY_COUNT);
  const familyPoints: string[] = [];
  for (const [, events] of families) {
    assert.equal(events.length, FAMILY_SIZE);
    const shared = events[0]![0]!;
    familyPoints.push(shared);
    for (const points of events) {
      assert.equal(points[0], shared, '族内首条 key_point 必须逐字相同');
    }
  }
  assert.equal(new Set(familyPoints).size, SEALED_FAMILY_COUNT, '族点互不撞词');
  assert.equal(tuningEvents(buildWorldPlan()).length / FAMILY_SIZE, TUNING_FAMILY_COUNT);
});

test('时间轴：审计周桶 ≥8 且首尾跨度 ≥9 周，真 holdout 可触发', () => {
  const plan = buildWorldPlan();
  const weekKeys = new Set(plan.events.map((event) => auditWeekKey(event.startedAtMs)));
  assert.ok(weekKeys.size >= 8, `实得周桶 ${weekKeys.size} 个`);
  const starts = plan.events.map((event) => event.startedAtMs).sort((a, b) => a - b);
  const spanDays = (starts.at(-1)! - starts[0]!) / (24 * 60 * 60 * 1000);
  assert.ok(spanDays >= 7 * 9, `首尾跨度 ${spanDays} 天，须覆盖约 10 周`);
});

test('素材库存：五类高危标签各有 ≥2 个封存事件承载', () => {
  const sealed = sealedEvents(buildWorldPlan());
  for (const label of HIGH_RISK_LABELS) {
    const count = sealed.filter((event) => event.highRiskLabels.includes(label)).length;
    assert.ok(count >= 2, `${label} 仅 ${count} 个事件`);
  }
});

test('盲包：只含 raw-turns/summary 等白名单字段，递归违禁键检查可拦截污染', () => {
  const blind = buildBlindPackage(buildWorldPlan());
  assertBlindPackageSafe(blind);
  assert.equal(blind.events.length, TOTAL_EVENT_COUNT);
  assert.ok(!('keyPoints' in blind.events[0]!));
  assert.equal(typeof blind.events[0]!.turns[0]!.rawText, 'string');
  // 序列化后再验一道，模拟磁盘产物被独立进程读回。
  const roundTrip = JSON.parse(JSON.stringify(blind)) as unknown;
  assertBlindPackageSafe(roundTrip);
  const polluted = JSON.parse(JSON.stringify(blind)) as { events: Array<Record<string, unknown>> };
  polluted.events[0]!['keyPoints'] = ['偷带答案'];
  assert.throws(() => assertBlindPackageSafe(polluted), /违禁字段/);
  for (const forbidden of BLIND_FORBIDDEN_KEYS) {
    assert.ok(!JSON.stringify(blind).includes(`"${forbidden}"`), `盲包序列化文本不得出现键名 ${forbidden}`);
  }
});

test('诱饵产能：80 张封存卡经真派生后，每卡 ≥2 个 Jaccard 近邻、近邻对 ≥100', () => {
  const sealed = sealedEvents(buildWorldPlan());
  const cards = sealed.map((event, i) => {
    const cues = normalizeDisplayCues(deriveCuesFromKeyPoints({ keyPoints: event.keyPoints, summary: event.summary }).cues);
    return {
      cardId: `card-${i}`,
      displayCuesJson: JSON.stringify(cues),
      aliasesJson: JSON.stringify([]),
    } as unknown as MemoryCard;
  });
  const pairs = buildDecoyPairs(cards);
  assert.equal(pairs.length, SEALED_EVENT_COUNT);
  let totalNeighborLinks = 0;
  for (const pair of pairs) {
    assert.ok(pair.neighborCardIds.length >= 2, `卡 ${pair.cardId} 近邻不足 2 个`);
    totalNeighborLinks += pair.neighborCardIds.length;
  }
  assert.ok(totalNeighborLinks >= 100, `近邻有向对 ${totalNeighborLinks}，R2 需 ≥100`);
});

test('端到端：脚本真摄入建根——100 active 卡、FTS 同步、决策行盖 rules-v2、盲包落盘', async () => {
  const plan = buildWorldPlan();
  const root = tempDir('p6-world-');
  const blindDir = tempDir('p6-blind-');
  try {
    const closedAnchors = await ingestWorld(plan, root);
    assert.equal(closedAnchors.size, TOTAL_EVENT_COUNT);
    await seedDerivedCards(plan, root, closedAnchors);

    const db = new DatabaseSync(path.join(root, 'projection', 'memory-index', 'memory-index.sqlite'));
    try {
      assert.equal((db.prepare('select count(*) c from mem_card where status=?').get('active') as { c: number }).c, TOTAL_EVENT_COUNT);
      assert.equal((db.prepare('select count(*) c from mem_card_fts').get() as { c: number }).c, TOTAL_EVENT_COUNT);
      assert.equal((db.prepare('select count(*) c from mem_alias').get() as { c: number }).c, 0, 'D1 合成卡零别名（G3 A 夹具零别名口径）');
      const meta = db.prepare("select value v from schema_meta where key='rules_version'").get() as { v: string };
      assert.equal(meta.v, 'rules-v1', '库位章仍是生产版本，rules-v2 只落在决策行，不污染生产门档');
    } finally {
      db.close();
    }
    const decisions = fs
      .readFileSync(path.join(root, 'projection', 'memory-index', 'decisions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { model_tag: string });
    assert.equal(decisions.length, TOTAL_EVENT_COUNT);
    assert.ok(decisions.every((row) => row.model_tag === 'rules-v2'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(blindDir, { recursive: true, force: true });
  }
});

test('防覆盖：非空目标目录 ensureFreshDir 直接拒，杜绝世界重建时误覆盖既有根', () => {
  const root = tempDir('p6-guard-');
  try {
    fs.writeFileSync(path.join(root, 'occupied.txt'), 'x');
    assert.throws(() => ensureFreshDir(root, '--out'), /拒绝覆盖/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
