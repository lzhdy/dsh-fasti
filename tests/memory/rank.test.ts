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

import {
  RANK_POLICY,
  composeView,
  humanTimeLabel,
  memoryStrength,
  mulberry32,
  rankCards,
} from '../../src/memory/rank.ts';
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

// ── #130 P2：29 天半衰期与离散步进整数强度（S 组）──────────────────────────

const H = RANK_POLICY.halfLifeMs;

test('S1 半衰期具名常量锁定 29 天', () => {
  assert.equal(H, 29 * DAY);
});

test('S2 离散步进：10 次采用跨五档强度 10/5/2/1/0', () => {
  const card = (idleMs: number) => makeCard({ cardId: 'mc_step', hitCount: 10, lastHitMs: NOW - idleMs });
  assert.equal(memoryStrength(card(0), NOW), 10);
  assert.equal(memoryStrength(card(H), NOW), 5); // k=1：floor(10/2)
  assert.equal(memoryStrength(card(2 * H), NOW), 2); // k=2：floor(10/4)
  assert.equal(memoryStrength(card(3 * H), NOW), 1); // k=3：floor(10/8)
  assert.equal(memoryStrength(card(4 * H), NOW), 0); // k=4：floor(10/16)
});

test('S3 单次采用：首个 29 天档内强度为 1，跨档即 0（不猝死也不恋栈）', () => {
  const card = (idleMs: number) => makeCard({ cardId: 'mc_one', hitCount: 1, lastHitMs: NOW - idleMs });
  assert.equal(memoryStrength(card(0), NOW), 1);
  assert.equal(memoryStrength(card(28 * DAY), NOW), 1); // 档内整日地板仍是 k=0
  assert.equal(memoryStrength(card(H - 1), NOW), 1); // 档边界前 1ms 仍是 k=0
  assert.equal(memoryStrength(card(H), NOW), 0); // 整 29 天 k=1：floor(1/2)=0
});

test('S4 强度恒为非负整数，不出小数/NaN/负数', () => {
  for (const hitCount of [1, 2, 4, 10, 99]) {
    for (let k = 0; k <= 6; k += 1) {
      const s = memoryStrength(
        makeCard({ cardId: `mc_i_${hitCount}_${k}`, hitCount, lastHitMs: NOW - k * H }),
        NOW,
      );
      assert.ok(Number.isInteger(s) && s >= 0, `hit=${hitCount} k=${k} got ${String(s)}`);
    }
  }
});

test('S5 lastHit 在未来（时钟倒挂 idle≤0）按 k=0 给原次数，不抛错', () => {
  const c = makeCard({ cardId: 'mc_future', hitCount: 3, lastHitMs: NOW + 5 * DAY });
  assert.equal(memoryStrength(c, NOW), 3);
});

// ── #130 P2：composeView 截窗分块（V 组）────────────────────────────────────

/** 可控序列 RNG：按预设 [0,1) 数列循环，测试不碰 Math.random。 */
function rngFrom(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
}

function viewOf(cards: readonly MemoryCard[], opts: { limit?: number; rng?: () => number } = {}) {
  const full = rankCards(cards, { nowMs: NOW, limit: null }); // 显式不截断：完整有序名单交 composeView
  return composeView(full, { rng: opts.rng ?? rngFrom([0.123]), ...(opts.limit === undefined ? {} : { limit: opts.limit }) });
}

function oldCard(id: string, partial: Partial<MemoryCard> = {}): MemoryCard {
  return makeCard({ cardId: id, weight: 0, hitCount: 1, lastHitMs: NOW, ...partial });
}
function freshCard(id: string, partial: Partial<MemoryCard> = {}): MemoryCard {
  return makeCard({ cardId: id, weight: 0, hitCount: 0, lastHitMs: null, ...partial });
}
function markedCard(id: string, partial: Partial<MemoryCard> = {}): MemoryCard {
  return makeCard({ cardId: id, weight: 0.5, hitCount: 0, lastHitMs: null, ...partial });
}

test('V1 三块身份纯净：marked=weight>0、ranked=采用过、explore=零采用', () => {
  const cards = [markedCard('mc_m1'), markedCard('mc_m2', { weight: 0.8 }), oldCard('mc_o1'), freshCard('mc_n1'), freshCard('mc_n2')];
  const view = viewOf(cards); // N=3 → exploreWanted=1，只露 1 张新卡
  for (const e of view.entries) {
    if (e.slot === 'marked') assert.ok(e.weight > 0);
    if (e.slot === 'ranked') assert.ok(e.hitCount > 0 && e.weight === 0);
    if (e.slot === 'explore') assert.equal(e.hitCount, 0);
  }
  // 名额按窗口容量算：N=10−2=8 → exploreWanted=2；候选仅 5，空槽回填后全数返回不藏卡
  assert.deepEqual(view.entries.map((e) => e.slot), ['marked', 'marked', 'ranked', 'explore', 'explore']);
  assert.equal(view.candidateTotal, 5);
  assert.equal(view.slots.exploreWanted, 2);
  assert.equal(view.slots.exploreFilled, 2);
});

test('V2 名额 ceil 规则：N=6..10 给 2、N=2..5 保底 1、N=1 无保底', () => {
  const pool = (limit: number) => {
    const cards = [
      ...Array.from({ length: limit }, (_, i) => oldCard(`mc_old_${String(i).padStart(2, '0')}`)),
      ...Array.from({ length: limit }, (_, i) => freshCard(`mc_new_${String(i).padStart(2, '0')}`)),
    ];
    return viewOf(cards, { limit }).slots;
  };
  assert.equal(pool(10).exploreWanted, 2);
  assert.equal(pool(6).exploreWanted, 2);
  assert.equal(pool(5).exploreWanted, 1);
  assert.equal(pool(2).exploreWanted, 1);
  assert.equal(pool(1).exploreWanted, 0); // 独苗不给探索位
});

test('V3 九张重要卡吃满截窗：N=1 独苗给老卡、无 explore', () => {
  const cards = [...Array.from({ length: 9 }, (_, i) => markedCard(`mc_m${i}`)), oldCard('mc_o'), freshCard('mc_n')];
  const view = viewOf(cards, { limit: 10 });
  assert.equal(view.slots.marked, 9);
  assert.equal(view.slots.explore, 0);
  assert.equal(view.slots.ranked, 1);
  assert.deepEqual(view.entries[9]?.cardId, 'mc_o');
});

test('V4 探索位由注入 RNG 决定而非时间序：同种子同形、异种子可异', () => {
  const fresh = Array.from({ length: 6 }, (_, i) => freshCard(`mc_n${i}`, { occurredMs: NOW - i * DAY }));
  const olds = Array.from({ length: 8 }, (_, i) => oldCard(`mc_o${i}`));
  const cards = [...olds, ...fresh];
  const a = viewOf(cards, { rng: mulberry32(42) });
  const b = viewOf(cards, { rng: mulberry32(42) });
  assert.equal(JSON.stringify(a), JSON.stringify(b)); // 同种子逐字节同形
  // 确定性序列而非概率断言：0.01 抽索引 0、0.9 抽索引 5，证明是 RNG 不是时间序伪装
  const low = viewOf(cards, { rng: rngFrom([0.01]) }).entries.find((e) => e.slot === 'explore');
  const high = viewOf(cards, { rng: rngFrom([0.9]) }).entries.find((e) => e.slot === 'explore');
  assert.equal(low?.cardId, 'mc_n0');
  assert.equal(high?.cardId, 'mc_n5');
});

test('V5 rng 为必填注入项：缺省即抛，纯内核无 Math.random 后门', () => {
  const full = rankCards([freshCard('mc_n')], { nowMs: NOW });
  assert.throws(() => composeView(full, { rng: undefined as unknown as () => number }));
});

test('V6 新卡不足：探索位回填老卡，wanted/filled 如实标注不造卡', () => {
  const cards = [markedCard('mc_m1'), markedCard('mc_m2'), oldCard('mc_o0'), ...Array.from({ length: 7 }, (_, i) => oldCard(`mc_o${i + 1}`)), freshCard('mc_only_new')];
  const view = viewOf(cards, { limit: 10 });
  assert.equal(view.slots.exploreWanted, 2);
  assert.equal(view.slots.exploreFilled, 1);
  assert.equal(view.slots.ranked, 7); // 缺额 1 由老卡补
  assert.equal(view.entries.length, 10);
  assert.equal(new Set(view.entries.map((e) => e.cardId)).size, 10);
});

test('V7 老卡不足：新卡回填老卡缺额且全部带 explore 身份', () => {
  const cards = [oldCard('mc_o0'), oldCard('mc_o1'), oldCard('mc_o2'), ...Array.from({ length: 10 }, (_, i) => freshCard(`mc_n${i}`))];
  const view = viewOf(cards, { limit: 10 });
  assert.equal(view.slots.ranked, 3);
  assert.equal(view.slots.explore, 7); // 2 个名额外的 5 个缺额也由新卡补
  assert.equal(view.slots.exploreWanted, 2);
});

test('V8 截窗不重复不越界：无重复卡、皆来自候选、candidateTotal 恒全集', () => {
  const cards = [...Array.from({ length: 4 }, (_, i) => oldCard(`mc_o${i}`)), ...Array.from({ length: 20 }, (_, i) => freshCard(`mc_n${i}`))];
  const view = viewOf(cards, { limit: 10 });
  const ids = view.entries.map((e) => e.cardId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(view.candidateTotal, 24);
  assert.ok(view.entries.length <= 10);
  for (const e of view.entries) assert.ok(cards.some((c) => c.cardId === e.cardId));
});

test('V9 真运气无轮转保证：函数无跨调用状态，恒定运气可一直落在同一张，其他新卡永不露面', () => {
  const fresh = Array.from({ length: 5 }, (_, i) => freshCard(`mc_n${i}`));
  const olds = Array.from({ length: 8 }, (_, i) => oldCard(`mc_o${i}`));
  const draw = () =>
    viewOf([...olds, ...fresh], { rng: rngFrom([0]) })
      .entries.filter((e) => e.slot === 'explore')
      .map((e) => e.cardId);
  const first = draw();
  const second = draw(); // 纯函数无轮转记忆：两次独立调用运气恒定，首位恒为 mc_n0
  assert.equal(first[0], 'mc_n0');
  assert.equal(second[0], 'mc_n0');
  const everShown = new Set([...first, ...second]);
  assert.ok(!everShown.has('mc_n2') && !everShown.has('mc_n3') && !everShown.has('mc_n4')); // 不承诺人人有份
  assert.equal(new Set(first).size, first.length); // 同一截窗内仍不许重复出卡
});

test('V10 分块顺序恒定：marked 全在 ranked 前、ranked 全在 explore 前', () => {
  const cards = [freshCard('mc_n1'), oldCard('mc_o1'), markedCard('mc_m1'), freshCard('mc_n2'), oldCard('mc_o2'), markedCard('mc_m2')];
  const tags = viewOf(cards).entries.map((e) => e.slot);
  const rankOf = (t: string) => tags.findIndex((x) => x === t);
  assert.ok(rankOf('marked') < rankOf('ranked') && rankOf('ranked') < rankOf('explore'));
});

test('V11 ranked 块内按有效强度→时间序，衰减归零老卡退回时间序不装新卡', () => {
  const strong = oldCard('mc_strong', { hitCount: 10, lastHitMs: NOW });
  const decayed = oldCard('mc_decayed', { hitCount: 10, lastHitMs: NOW - 4 * H, occurredMs: NOW - 2 * DAY });
  const freshOld = oldCard('mc_recent_old', { hitCount: 1, lastHitMs: NOW, occurredMs: NOW - 1 * DAY });
  const brandNew = freshCard('mc_brand', { occurredMs: NOW });
  const view = viewOf([decayed, brandNew, freshOld, strong]);
  const rankedIds = view.entries.filter((e) => e.slot === 'ranked').map((e) => e.cardId);
  assert.deepEqual(rankedIds, ['mc_strong', 'mc_recent_old', 'mc_decayed']); // 10＞1＞0，归零者末位但仍在老卡池
  assert.deepEqual(view.entries.filter((e) => e.slot === 'explore').map((e) => e.cardId), ['mc_brand']);
});
