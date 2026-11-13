/**
 * C3 槽位制窗口测试 —— window（方案 §4.8 / §11.3 M10；裁决 G3–G6）。
 *
 * 纪律：
 *  - 纯函数无 I/O：输入深冻结守卫，同输入两次装配逐字一致；
 *  - 预算口径（G4）：[...displayCues, discriminator].join(' ') 的码点数，别名不计；
 *  - identity 资格（G3）：第三入参 cardId 集合，缺省空集恒空槽；不读 event.anchors；
 *  - M10：种子化 PRNG 随机 1–50 张随机长度卡，totalChars 恒 ≤700、turnsWhole 恒 true、
 *    needRefetch 至多一次、空槽规则成立；
 *  - 裁撤（G6）：obligation→relevance→identity→recency→guaranteed，槽内装入逆序逐卡。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AssembledWindow, MemoryCard, RankedCard } from '../../src/memory/types.ts';
import { EMPTY_SUMMARY_V1, assembleWindow } from '../../src/memory/window.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const SLOT_NAMES = ['guaranteed', 'recency', 'identity', 'relevance', 'obligation'] as const;

// ── 夹具 ──────────────────────────────────────────────────────────────────

function mkRanked(
  cardId: string,
  opts: { cues?: string[]; discriminator?: string; occurredMs?: number; aliasesJson?: string } = {},
): RankedCard {
  const cues = opts.cues ?? ['线索'];
  const discriminator = opts.discriminator ?? '区别';
  const card: MemoryCard = {
    cardId,
    eventId: `evt-${cardId}`,
    anchorJson: '["exp-1"]',
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson: JSON.stringify(cues),
    aliasesJson: opts.aliasesJson ?? '[]',
    discriminator,
    entityHintJson: null,
    occurredMs: opts.occurredMs ?? T0,
    endedMs: (opts.occurredMs ?? T0) + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: `hash-${cardId}`,
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  return { card, scoreParts: { bm25: 0, recency: 1 }, matchedTerms: ['线索'] };
}

/** G4 预算口径的独立实现（码点数，别名不计）。 */
function charsOf(ranked: RankedCard): number {
  const cues = JSON.parse(ranked.card.displayCuesJson) as string[];
  return [...[...cues, ranked.card.discriminator].join(' ')].length;
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

function slotOf(w: AssembledWindow, name: (typeof SLOT_NAMES)[number]): string[] {
  const found = w.slots.find((s) => s.slot === name);
  assert.ok(found !== undefined, `槽位 ${name} 必须存在`);
  return found.cardIds;
}

function allIds(w: AssembledWindow): string[] {
  return w.slots.flatMap((s) => s.cardIds);
}

/** 种子化 PRNG（mulberry32）—— M10 可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 槽位结构与归槽（G5/G6）────────────────────────────────────────────────

test('空候选：五槽恒输出、全空、empty-relevance 补取标记', () => {
  const w = assembleWindow([]);
  assert.deepEqual(w.slots.map((s) => s.slot), [...SLOT_NAMES], '五槽固定顺序');
  for (const name of SLOT_NAMES) {
    assert.deepEqual(slotOf(w, name), [], `${name} 空`);
  }
  assert.equal(w.totalChars, 0);
  assert.equal(w.turnsWhole, true);
  assert.equal(w.needRefetch, true);
  assert.equal(w.refetchReason, 'empty-relevance');
});

test('摘要位 v1：具名空常量留痕，不占槽不占预算（G5）', () => {
  assert.equal(EMPTY_SUMMARY_V1, '', '摘要位 v1 恒空');
  const w = assembleWindow([mkRanked('mc_a')]);
  assert.equal(w.slots.length, 5, '摘要位不占槽');
  assert.equal(w.totalChars, charsOf(mkRanked('mc_a')), '摘要位不占预算');
});

test('单卡：归 recency 槽；identity 缺省空集恒空（G3）', () => {
  const w = assembleWindow([mkRanked('mc_a')]);
  assert.deepEqual(slotOf(w, 'recency'), ['mc_a']);
  assert.deepEqual(slotOf(w, 'identity'), []);
  assert.deepEqual(slotOf(w, 'relevance'), []);
  assert.deepEqual(slotOf(w, 'guaranteed'), [], 'guaranteed v1 恒空');
  assert.deepEqual(slotOf(w, 'obligation'), [], 'obligation v1 恒空');
  assert.equal(w.needRefetch, false);
  assert.equal(w.refetchReason, undefined);
});

test('recency = occurredMs 最大 1 张；relevance = 其余按入参名次（G6）', () => {
  const a = mkRanked('mc_a', { occurredMs: T0 });
  const b = mkRanked('mc_b', { occurredMs: T0 + 9 * DAY });
  const c = mkRanked('mc_c', { occurredMs: T0 + 5 * DAY });
  const w = assembleWindow([a, b, c]);
  assert.deepEqual(slotOf(w, 'recency'), ['mc_b'], 'occurredMs 最大');
  assert.deepEqual(slotOf(w, 'relevance'), ['mc_a', 'mc_c'], '其余按入参检索名次');
});

test('identity 显式资格集：集内 occurredMs 最大 1 张、不与 recency 重复（G3/G6）', () => {
  const a = mkRanked('mc_a', { occurredMs: T0 + 9 * DAY });
  const b = mkRanked('mc_b', { occurredMs: T0 + 2 * DAY });
  const c = mkRanked('mc_c', { occurredMs: T0 + 5 * DAY });
  const w = assembleWindow([a, b, c], undefined, new Set(['mc_b', 'mc_c']));
  assert.deepEqual(slotOf(w, 'recency'), ['mc_a']);
  assert.deepEqual(slotOf(w, 'identity'), ['mc_c'], '资格集内最新');
  assert.deepEqual(slotOf(w, 'relevance'), ['mc_b']);

  // 资格集只含 recency 卡 → identity 不得重复 → 空。
  const w2 = assembleWindow([a, b, c], undefined, new Set(['mc_a']));
  assert.deepEqual(slotOf(w2, 'identity'), []);
  assert.deepEqual(slotOf(w2, 'relevance'), ['mc_b', 'mc_c']);

  // 资格集含不在候选中的 id → 忽略。
  const w3 = assembleWindow([a, b], undefined, new Set(['mc_ghost']));
  assert.deepEqual(slotOf(w3, 'identity'), []);
});

// ── 预算口径（G4）─────────────────────────────────────────────────────────

test('预算 = cues+discriminator 拼接码点数；别名不计；代理对按码点（G4）', () => {
  const ranked = mkRanked('mc_x', {
    cues: ['abcdefghij'],
    discriminator: '12345',
    aliasesJson: '[{"term":"这是一个很长的别名不应该计入预算","source":"miss","sensitive":0}]',
  });
  const w = assembleWindow([ranked]);
  assert.equal(w.totalChars, 16, '10 + 1 空格 + 5 = 16 码点');

  const emoji = mkRanked('mc_emoji', { cues: ['😀😀'], discriminator: '中' });
  const w2 = assembleWindow([emoji]);
  assert.equal(w2.totalChars, 4, '2 码点 emoji + 空格 + 1 汉字 = 4（非 UTF-16 长度）');
});

// ── 裁撤顺序与原子性（G6）─────────────────────────────────────────────────

test('裁撤：槽间 obligation→relevance→identity→recency，槽内装入逆序逐卡', () => {
  const r = mkRanked('mc_r', { cues: ['x'.repeat(28)], discriminator: '', occurredMs: T0 + 9 * DAY });
  const i = mkRanked('mc_i', { cues: ['y'.repeat(28)], discriminator: '', occurredMs: T0 + 5 * DAY });
  const v1 = mkRanked('mc_v1', { cues: ['z'.repeat(28)], discriminator: '', occurredMs: T0 + 2 * DAY });
  const v2 = mkRanked('mc_v2', { cues: ['w'.repeat(28)], discriminator: '', occurredMs: T0 + 1 * DAY });
  // 每卡 29 码点（28 线索 + 1 分隔空格 + 空 discriminator）；入参序 [v1, r, i, v2]。
  const candidates = [v1, r, i, v2];
  assert.equal(charsOf(r), 29);

  // cap=100：总 116 → 裁 relevance 逆序首张 v2 → 87 ≤ 100。
  const w100 = assembleWindow(candidates, { hardCapChars: 100 }, new Set(['mc_i']));
  assert.deepEqual(slotOf(w100, 'relevance'), ['mc_v1'], 'v2 后装入先裁');
  assert.deepEqual(slotOf(w100, 'recency'), ['mc_r']);
  assert.deepEqual(slotOf(w100, 'identity'), ['mc_i']);
  assert.equal(w100.totalChars, 87);

  // cap=50：裁尽 relevance 后裁 identity → 只剩 recency。
  const w50 = assembleWindow(candidates, { hardCapChars: 50 }, new Set(['mc_i']));
  assert.deepEqual(slotOf(w50, 'relevance'), []);
  assert.deepEqual(slotOf(w50, 'identity'), [], 'identity 先于 recency 被裁');
  assert.deepEqual(slotOf(w50, 'recency'), ['mc_r']);
  assert.equal(w50.totalChars, 29);

  // cap=20：每卡 29 码点各自超预算 → 全数以 oversized 移出、不补取（优先于 empty-relevance）。
  const w20 = assembleWindow(candidates, { hardCapChars: 20 }, new Set(['mc_i']));
  assert.deepEqual(allIds(w20), []);
  assert.equal(w20.needRefetch, false, 'oversized 优先于 empty-relevance');
  assert.equal(w20.refetchReason, 'oversized-card');
});

test('卡为原子单位：totalChars = 存活卡预算和，卡内线索整组进退（G6）', () => {
  const cards = [
    mkRanked('mc_a', { cues: ['a'.repeat(100), 'b'.repeat(100)], discriminator: 'c'.repeat(40), occurredMs: T0 + 3 * DAY }),
    mkRanked('mc_b', { cues: ['d'.repeat(100)], discriminator: 'e'.repeat(40), occurredMs: T0 + 2 * DAY }),
    mkRanked('mc_c', { cues: ['f'.repeat(100)], discriminator: 'g'.repeat(40), occurredMs: T0 + 1 * DAY }),
  ];
  const w = assembleWindow(cards, { hardCapChars: 300 });
  const byId = new Map(cards.map((c) => [c.card.cardId, c]));
  const sum = allIds(w).reduce((acc, id) => acc + charsOf(byId.get(id)!), 0);
  assert.equal(w.totalChars, sum, '预算逐卡整组计');
  assert.ok(w.totalChars <= 300);
  assert.equal(w.turnsWhole, true);
});

// ── oversized-card 与 empty-relevance（G6 优先级）─────────────────────────

test('单卡超预算：整体移出、needRefetch=false、reason=oversized-card', () => {
  const big = mkRanked('mc_big', { cues: ['超'.repeat(800)], discriminator: '', occurredMs: T0 + 9 * DAY });
  const small = mkRanked('mc_small', { cues: ['小线索'], discriminator: '', occurredMs: T0 });
  assert.ok(charsOf(big) > 700);

  // big 是 recency：裁尽 small 后 big 仍超 → 整体移出。
  const w = assembleWindow([big, small]);
  assert.deepEqual(allIds(w), []);
  assert.equal(w.needRefetch, false, 'oversized 不触发补取');
  assert.equal(w.refetchReason, 'oversized-card');

  // oversized 与 empty-relevance 同时成立 → oversized 优先。
  const w2 = assembleWindow([big]);
  assert.equal(w2.needRefetch, false);
  assert.equal(w2.refetchReason, 'oversized-card');
});

test('oversized 卡在 relevance：移出后其余卡可存活，reason 仍记 oversized-card', () => {
  const big = mkRanked('mc_big', { cues: ['超'.repeat(800)], discriminator: '', occurredMs: T0 });
  const r = mkRanked('mc_r', { cues: ['近因卡'], discriminator: '', occurredMs: T0 + 9 * DAY });
  const v = mkRanked('mc_v', { cues: ['相关卡'], discriminator: '', occurredMs: T0 + 1 * DAY });
  // 入参序 [big, r, v]：recency=r，relevance=[big, v]。
  const w = assembleWindow([big, r, v]);
  assert.deepEqual(slotOf(w, 'recency'), ['mc_r']);
  assert.deepEqual(slotOf(w, 'relevance'), [], 'big 与 v 均被裁（逆序 v 先、big 后）');
  assert.equal(w.needRefetch, false);
  assert.equal(w.refetchReason, 'oversized-card');
  assert.ok(w.totalChars <= 700);
});

// ── 确定性与纯函数纪律 ────────────────────────────────────────────────────

test('同输入两次装配逐字一致；输入零改写（深冻结守卫）', () => {
  const candidates = deepFreeze(
    structuredClone([
      mkRanked('mc_a', { occurredMs: T0 + 3 * DAY }),
      mkRanked('mc_b', { occurredMs: T0 + 1 * DAY }),
      mkRanked('mc_c', { occurredMs: T0 + 2 * DAY }),
    ]),
  );
  const eligible = deepFreeze(new Set(['mc_b', 'mc_c']));
  const before = JSON.stringify([...candidates]);
  const w1 = assembleWindow(candidates, { hardCapChars: 700 }, eligible);
  const w2 = assembleWindow(candidates, { hardCapChars: 700 }, eligible);
  assert.deepEqual(w1, w2);
  assert.equal(JSON.stringify([...candidates]), before);
});

// ── M10：种子化 property test（1–50 张随机长度卡）─────────────────────────

test('M10 property：随机 1–50 卡，700 硬顶零违反、turnsWhole 恒 true、空槽规则成立', () => {
  const rand = mulberry32(20261111);
  const pool = [...'abc咖啡馆😀Äxyz'];
  const randText = (maxLen: number): string => {
    const len = Math.floor(rand() * (maxLen + 1));
    let out = '';
    for (let k = 0; k < len; k += 1) {
      out += pool[Math.floor(rand() * pool.length)];
    }
    return out;
  };

  for (let trial = 0; trial < 300; trial += 1) {
    const n = Math.floor(rand() * 51); // 0..50
    const candidates: RankedCard[] = [];
    const eligible = new Set<string>();
    for (let k = 0; k < n; k += 1) {
      const cueCount = 1 + Math.floor(rand() * 3);
      const cues = Array.from({ length: cueCount }, () => randText(400));
      const ranked = mkRanked(`mc_r${trial}_${k}`, {
        cues,
        discriminator: randText(40),
        occurredMs: T0 + Math.floor(rand() * 100) * DAY,
      });
      candidates.push(ranked);
      if (rand() < 0.3) {
        eligible.add(ranked.card.cardId);
      }
    }

    const w = assembleWindow(candidates, undefined, eligible);
    const at = `trial ${trial}（n=${n}）`;

    // 硬顶与完整回合。
    assert.ok(w.totalChars <= 700, `${at} totalChars=${w.totalChars} 超 700`);
    assert.equal(w.turnsWhole, true, at);

    // 五槽结构、无重复、全部来自候选。
    assert.deepEqual(w.slots.map((s) => s.slot), [...SLOT_NAMES], at);
    const ids = allIds(w);
    assert.equal(new Set(ids).size, ids.length, `${at} 卡重复`);
    const candidateIds = new Set(candidates.map((c) => c.card.cardId));
    for (const id of ids) {
      assert.ok(candidateIds.has(id), `${at} 出现候选外 id`);
    }
    assert.deepEqual(slotOf(w, 'guaranteed'), [], at);
    assert.deepEqual(slotOf(w, 'obligation'), [], at);
    assert.ok(slotOf(w, 'recency').length <= 1, at);
    assert.ok(slotOf(w, 'identity').length <= 1, at);

    // identity 资格与互斥。
    for (const id of slotOf(w, 'identity')) {
      assert.ok(eligible.has(id), `${at} identity 无资格`);
    }
    assert.ok(!slotOf(w, 'identity').includes(slotOf(w, 'recency')[0] ?? ''), `${at} identity 与 recency 重复`);

    // 裁撤保序：identity 存活 ⇒ recency 存活；recency 空 ⇒ identity/relevance 空。
    if (slotOf(w, 'identity').length > 0) {
      assert.equal(slotOf(w, 'recency').length, 1, `${at} identity 存活而 recency 被裁`);
    }
    if (slotOf(w, 'recency').length === 0) {
      assert.deepEqual(slotOf(w, 'identity'), [], at);
      assert.deepEqual(slotOf(w, 'relevance'), [], at);
    }

    // recency 存活时必为 occurredMs 最大。
    if (slotOf(w, 'recency').length === 1) {
      const maxOccurred = Math.max(...candidates.map((c) => c.card.occurredMs));
      const recencyCard = candidates.find((c) => c.card.cardId === slotOf(w, 'recency')[0])!;
      assert.equal(recencyCard.card.occurredMs, maxOccurred, `${at} recency 非最新`);
    }

    // relevance 保持入参名次子序列。
    const relevance = slotOf(w, 'relevance');
    const positions = relevance.map((id) => candidates.findIndex((c) => c.card.cardId === id));
    for (let k = 1; k < positions.length; k += 1) {
      assert.ok(positions[k]! > positions[k - 1]!, `${at} relevance 乱序`);
    }

    // 预算逐卡整组求和。
    const byId = new Map(candidates.map((c) => [c.card.cardId, c]));
    const sum = ids.reduce((acc, id) => acc + charsOf(byId.get(id)!), 0);
    assert.equal(w.totalChars, sum, `${at} 预算和非整卡`);

    // needRefetch 至多一次 + reason 规则。
    assert.equal(typeof w.needRefetch, 'boolean', at);
    const hasOversized = candidates.some((c) => charsOf(c) > 700);
    if (hasOversized) {
      assert.equal(w.needRefetch, false, `${at} oversized 须不补取`);
      assert.equal(w.refetchReason, 'oversized-card', at);
    } else if (w.needRefetch) {
      assert.equal(w.refetchReason, 'empty-relevance', at);
      assert.deepEqual(ids, [], `${at} empty-relevance 须全空`);
    } else {
      assert.equal(w.refetchReason, undefined, at);
    }

    // 确定性：同输入再装配一次逐字一致。
    assert.deepEqual(assembleWindow(candidates, undefined, eligible), w, `${at} 不确定`);
  }
});