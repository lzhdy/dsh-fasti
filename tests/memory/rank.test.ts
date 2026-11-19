/**
 * #129 P1 红测：记忆排序器 rank（合格全召回后的字典序排序，不删卡）。
 *
 * 设计依据（仓库外《#129记忆排序化-P1红测与施工评估》主控 2026-11-19 拍板）：
 *  排序键字典序：weight 档（分高→occurred 新）→ strength（带遗忘的记忆强度）
 *              → occurredMs 新→旧 → cardId 字典序兜底。
 * 纪律：纯函数、零 I/O、不读 Date.now/Math.random；时钟由入参注入，同入参逐字节可重放；
 *      不 import gate/bm25/store，守无环。本文件先红后绿，rank.ts 尚不存在时整文件红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RANK_POLICY, humanTimeLabel, memoryStrength, rankCards } from '../../src/memory/rank.ts';
import type { MemoryCard } from '../../src/memory/types.ts';

let seq = 0;

function makeCard(partial: Partial<MemoryCard> = {}): MemoryCard {
  seq += 1;
  const n = seq;
  return {
    cardId: `mc_test_${String(n).padStart(3, '0')}`,
    eventId: `ev_${n}`,
    anchorJson: JSON.stringify([`exp_${n}`]),
    channel: 'main',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson: JSON.stringify(['合成线索']),
    aliasesJson: JSON.stringify([]),
    discriminator: '',
    entityHintJson: null,
    occurredMs: 1000,
    endedMs: 1000,
    validMs: 1000,
    invalidMs: null,
    createdMs: 1000,
    expiredMs: null,
    status: 'active',
    contentHash: `hash_${n}`,
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
    ...partial,
  };
}

const DAY = RANK_POLICY.dayMs;
const NOW = 100 * DAY; // 任意固定锚点，绝不读系统时钟

function idsOf(cards: readonly MemoryCard[], opts: { limit?: number } = {}) {
  return rankCards(cards, { nowMs: NOW, ...opts }).entries.map((e) => e.cardId);
}

// T1：其余全等，发生时间新者在前
test('T1 occurred 新者恒在前', () => {
  const older = makeCard({ cardId: 'mc_a', occurredMs: NOW - 10 * DAY });
  const newer = makeCard({ cardId: 'mc_b', occurredMs: NOW - 1 * DAY });
  assert.deepEqual(idsOf([older, newer]), ['mc_b', 'mc_a']);
});

// T2：四键全并列 → cardId 字典序；同入参重放逐字节同形
test('T2 全并列 cardId 字典序且可重放', () => {
  const c1 = makeCard({ cardId: 'mc_z', occurredMs: NOW });
  const c2 = makeCard({ cardId: 'mc_a', occurredMs: NOW });
  const c3 = makeCard({ cardId: 'mc_m', occurredMs: NOW });
  const first = JSON.stringify(rankCards([c1, c2, c3], { nowMs: NOW }));
  const second = JSON.stringify(rankCards([c3, c1, c2], { nowMs: NOW }));
  assert.deepEqual(JSON.parse(first).entries.map((e: { cardId: string }) => e.cardId), ['mc_a', 'mc_m', 'mc_z']);
  assert.equal(first, second); // 输入顺序不同，输出同形
});

// T3：weight 非零恒在最前，哪怕最旧、零采用（第一层凌驾）
test('T3 weight 标记凌驾时间与强度', () => {
  const marked = makeCard({ cardId: 'mc_marked', weight: 0.5, occurredMs: NOW - 90 * DAY, hitCount: 0, lastHitMs: null });
  const fresh = makeCard({ cardId: 'mc_fresh', weight: 0, occurredMs: NOW - 1 * DAY, hitCount: 20, lastHitMs: NOW });
  assert.deepEqual(idsOf([fresh, marked]), ['mc_marked', 'mc_fresh']);
});

// T4：weight 同分 → occurred 新者在前
test('T4 weight 同分按 occurred', () => {
  const a = makeCard({ cardId: 'mc_a', weight: 0.8, occurredMs: NOW - 30 * DAY });
  const b = makeCard({ cardId: 'mc_b', weight: 0.8, occurredMs: NOW - 2 * DAY });
  assert.deepEqual(idsOf([a, b]), ['mc_b', 'mc_a']);
});

// T5：同 weight 档，strength 高者在前
test('T5 strength 高者在前（近期多次采用压过远期多次）', () => {
  // 近期被采用 3 次 vs 很久以前采用 10 次（隔 10 个半衰期，衰减到约 10/1024）
  const recent = makeCard({
    cardId: 'mc_recent',
    occurredMs: NOW - 40 * DAY,
    hitCount: 3,
    lastHitMs: NOW - 1 * DAY,
  });
  const old = makeCard({
    cardId: 'mc_old',
    occurredMs: NOW - 80 * DAY,
    hitCount: 10,
    lastHitMs: NOW - 10 * RANK_POLICY.halfLifeMs,
  });
  assert.ok(memoryStrength(recent, NOW) > memoryStrength(old, NOW));
  assert.deepEqual(idsOf([old, recent]), ['mc_recent', 'mc_old']);
});

// T6：weight、strength 皆同 → occurred 新者在前
test('T6 强度相同退回 occurred', () => {
  const a = makeCard({ cardId: 'mc_a', occurredMs: NOW - 9 * DAY, hitCount: 2, lastHitMs: NOW - DAY });
  const b = makeCard({ cardId: 'mc_b', occurredMs: NOW - 3 * DAY, hitCount: 2, lastHitMs: NOW - DAY });
  assert.deepEqual(idsOf([a, b]), ['mc_b', 'mc_a']);
});

// T7：排序器不删卡——合格集一张不丢，只换顺序
test('T7 合格卡全数保留不弃权', () => {
  const cards = Array.from({ length: 12 }, (_, i) => makeCard({ cardId: `mc_${String(i).padStart(2, '0')}` }));
  const out = rankCards(cards, { nowMs: NOW, limit: 20 }); // 截断行为归 T10，本测只证不删卡
  assert.equal(out.candidateTotal, 12);
  assert.equal(new Set(out.entries.map((e) => e.cardId)).size, 12);
});

// T8：空集 → 空列表与零总数，不抛错
test('T8 空输入', () => {
  const out = rankCards([], { nowMs: NOW });
  assert.deepEqual(out.entries, []);
  assert.equal(out.candidateTotal, 0);
});

// T9：每条带结构化排序理由四字段，且无人话时间缺失
test('T9 排序理由字段完整且含人话时间标签', () => {
  const card = makeCard({ cardId: 'mc_x', weight: 0.5, hitCount: 2, lastHitMs: NOW - DAY, occurredMs: NOW - DAY });
  const [entry] = rankCards([card], { nowMs: NOW }).entries;
  assert.ok(entry);
  assert.equal(entry.cardId, 'mc_x');
  assert.equal(entry.weight, 0.5);
  assert.equal(entry.hitCount, 2);
  assert.ok(typeof entry.strength === 'number' && Number.isFinite(entry.strength) && entry.strength > 0);
  assert.equal(entry.occurredMs, NOW - DAY);
  assert.equal(entry.timeLabel, humanTimeLabel(card.occurredMs, NOW));
  assert.ok(entry.timeLabel.length > 0);
});

// T10：默认上限截断但总数如实
test('T10 limit 截断与 candidateTotal', () => {
  const cards = Array.from({ length: 25 }, (_, i) =>
    makeCard({ cardId: `mc_${String(i).padStart(2, '0')}`, occurredMs: NOW - i * DAY }),
  );
  const def = rankCards(cards, { nowMs: NOW });
  assert.equal(def.candidateTotal, 25);
  assert.equal(def.entries.length, RANK_POLICY.defaultLimit);
  const custom = rankCards(cards, { nowMs: NOW, limit: 5 });
  assert.equal(custom.entries.length, 5);
});

// T11：纯函数——交换调用次序与重复调用结果一致（无时钟/随机依赖由本测间接锁死）
test('T11 同参重复调用逐字节同形', () => {
  const cards = [makeCard({ cardId: 'mc_a' }), makeCard({ cardId: 'mc_b', weight: 0.2 })];
  const r1 = JSON.stringify(rankCards(cards, { nowMs: NOW }));
  const r2 = JSON.stringify(rankCards(cards, { nowMs: NOW }));
  assert.equal(r1, r2);
});

// T13：同采用次数，久未采用者强度更低、排更后（遗忘方向）
test('T13 久未采用自然沉底', () => {
  const forgotten = makeCard({ cardId: 'mc_f', occurredMs: NOW - 50 * DAY, hitCount: 5, lastHitMs: NOW - 8 * RANK_POLICY.halfLifeMs });
  const remembered = makeCard({ cardId: 'mc_r', occurredMs: NOW - 50 * DAY, hitCount: 5, lastHitMs: NOW - DAY });
  assert.ok(memoryStrength(remembered, NOW) > memoryStrength(forgotten, NOW));
  assert.deepEqual(idsOf([forgotten, remembered]), ['mc_r', 'mc_f']);
});

// T14：采用事件（hitCount+1、lastHit 刷新）提升强度；重放同 now 同形
test('T14 采用加固且可重放', () => {
  const before = makeCard({ cardId: 'mc_x', hitCount: 1, lastHitMs: NOW - 6 * RANK_POLICY.halfLifeMs });
  const adopted = { ...before, hitCount: 2, lastHitMs: NOW };
  assert.ok(memoryStrength(adopted, NOW) > memoryStrength(before, NOW));
  assert.equal(memoryStrength(adopted, NOW), memoryStrength(adopted, NOW));
});

// T15：第一层标记不参与遗忘，恒在最前
test('T15 weight 标记不受衰减影响', () => {
  const marked = makeCard({ cardId: 'mc_m', weight: 0.1, hitCount: 0, lastHitMs: null, occurredMs: NOW - 200 * DAY });
  const hot = makeCard({ cardId: 'mc_h', weight: 0, hitCount: 99, lastHitMs: NOW, occurredMs: NOW });
  assert.deepEqual(idsOf([hot, marked]), ['mc_m', 'mc_h']);
});

// T16：零采用卡 strength=0，退回 occurred 排序，不出 NaN/负数
test('T16 零采用强度为 0 且数值合法', () => {
  const newer = makeCard({ cardId: 'mc_n', hitCount: 0, lastHitMs: null, occurredMs: NOW - 1 * DAY });
  const older = makeCard({ cardId: 'mc_o', hitCount: 0, lastHitMs: null, occurredMs: NOW - 9 * DAY });
  assert.equal(memoryStrength(newer, NOW), 0);
  assert.equal(memoryStrength(older, NOW), 0);
  assert.deepEqual(idsOf([older, newer]), ['mc_n', 'mc_o']);
});

// 人话时间标签：今天/昨天/N天前/绝对日期
test('humanTimeLabel 纯函数四档', () => {
  assert.equal(humanTimeLabel(NOW, NOW), '今天');
  assert.equal(humanTimeLabel(NOW - DAY, NOW), '昨天');
  assert.equal(humanTimeLabel(NOW - 3 * DAY, NOW), '3天前');
  const old = NOW - 200 * DAY;
  const d = new Date(old + 8 * 3600_000);
  const expected = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  assert.equal(humanTimeLabel(old, NOW), expected);
});
