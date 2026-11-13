/**
 * C3 候选序号化测试 —— serial（方案 §4.7 / §11.3 M2）。
 *
 * 纪律：
 *  - 请求级私有映射：不落库、不跨请求复用（纯函数，输入深冻结守卫）；
 *  - M2 反证：越界/已失效序号抛 MemorySerialReferenceError；
 *    模拟「重取一次后再败 → 本轮放弃引用」，断言无任何 id 猜测；
 *  - 降级判定 isSerialRefusable 只认本错误类，不靠 message 文案。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NotFoundError } from '../../src/core/errors.ts';
import { MemorySerialReferenceError } from '../../src/memory/memory-errors.ts';
import { buildSerialMap, isSerialRefusable, resolveSerials } from '../../src/memory/serial.ts';
import type { MemoryCard, RankedCard } from '../../src/memory/types.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');

function mkRanked(cardId: string): RankedCard {
  const card: MemoryCard = {
    cardId,
    eventId: `evt-${cardId}`,
    anchorJson: '["exp-1"]',
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson: '["线索"]',
    aliasesJson: '[]',
    discriminator: '区别短句',
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + 1000,
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

const CARDS = ['mc_a', 'mc_b', 'mc_c'].map(mkRanked);

// ── 映射构造与解析 ────────────────────────────────────────────────────────

test('buildSerialMap：1..n 按入参名次映射，请求级私有、输入零改写', () => {
  const frozen = deepFreeze(structuredClone(CARDS));
  const map = buildSerialMap(frozen);
  assert.equal(map.size, 3);
  assert.equal(map.get(1), 'mc_a');
  assert.equal(map.get(2), 'mc_b');
  assert.equal(map.get(3), 'mc_c');
  assert.equal(map.get(0), undefined);
  assert.equal(map.get(4), undefined);

  // 私有性：另一次检索（不同名次）得到不同映射，互不串扰。
  const other = buildSerialMap([CARDS[2]!, CARDS[0]!]);
  assert.equal(other.get(1), 'mc_c');
  assert.equal(other.get(2), 'mc_a');
  assert.equal(map.get(1), 'mc_a', '原映射不受影响');

  assert.deepEqual(buildSerialMap([]), new Map(), '空候选 → 空映射');
});

test('resolveSerials：合法序号按 picked 顺序解析、允许重复、空 picked 为空', () => {
  const map = buildSerialMap(CARDS);
  assert.deepEqual(resolveSerials(map, [3, 1, 2]), ['mc_c', 'mc_a', 'mc_b']);
  assert.deepEqual(resolveSerials(map, [2, 2]), ['mc_b', 'mc_b'], '重复序号各自解析');
  assert.deepEqual(resolveSerials(map, []), []);
});

// ── M2 反证：越界/失效序号拒绝 ────────────────────────────────────────────

test('M2：越界/非整数序号抛 MemorySerialReferenceError（禁止猜序号）', () => {
  const map = buildSerialMap(CARDS);
  for (const bad of [0, -1, 4, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveSerials(map, [bad]),
      (error: unknown) => {
        assert.ok(error instanceof MemorySerialReferenceError, `序号 ${bad} 须抛本错误类`);
        assert.ok(error instanceof NotFoundError, '继承 NotFoundError（机器可判）');
        assert.equal(isSerialRefusable(error), true);
        return true;
      },
      `序号 ${bad} 应被拒绝`,
    );
  }
  // 部分合法也不放行：整批解析在首个未知序号即抛，不返回半截结果。
  assert.throws(() => resolveSerials(map, [1, 99]), MemorySerialReferenceError);
});

test('M2：已失效序号（重取后候选集变化）同样拒绝', () => {
  const oldMap = buildSerialMap(CARDS);
  assert.deepEqual(resolveSerials(oldMap, [3]), ['mc_c']);
  // 重取后只剩两张卡：旧序号 3 在新映射里失效。
  const newMap = buildSerialMap(CARDS.slice(0, 2));
  assert.throws(() => resolveSerials(newMap, [3]), MemorySerialReferenceError);
});

test('isSerialRefusable：只认本错误类，不靠 message 文案', () => {
  assert.equal(isSerialRefusable(new MemorySerialReferenceError('x')), true);
  assert.equal(isSerialRefusable(new NotFoundError('候选序号越界')), false, '基类不算');
  assert.equal(isSerialRefusable(new Error('候选序号越界')), false, '文案相同也不算');
  assert.equal(isSerialRefusable(null), false);
  assert.equal(isSerialRefusable(undefined), false);
  assert.equal(isSerialRefusable('MemorySerialReferenceError'), false);
});

// ── M2 降级纪律：重取一次后再败 → 本轮放弃引用、如实不带卡 ────────────────

/** 模拟上层调用方纪律：捕获后允许重新检索一次，第二次仍败则放弃（不猜 id）。 */
function attemptReference(
  fetch: () => readonly RankedCard[],
  picked: readonly number[],
): { refs: string[]; fetches: number } {
  let fetches = 0;
  const tryOnce = (): string[] => {
    fetches += 1;
    return resolveSerials(buildSerialMap(fetch()), picked);
  };
  try {
    return { refs: tryOnce(), fetches };
  } catch (error) {
    if (!isSerialRefusable(error)) {
      throw error;
    }
    try {
      return { refs: tryOnce(), fetches };
    } catch (retryError) {
      if (!isSerialRefusable(retryError)) {
        throw retryError;
      }
      return { refs: [], fetches };
    }
  }
}

test('M2 反证：首败 → 重取一次 → 再败 → 放弃引用且无任何 id 猜测', () => {
  let round = 0;
  const fetch = (): readonly RankedCard[] => {
    round += 1;
    return round === 1 ? CARDS.slice(0, 2) : CARDS.slice(0, 1);
  };
  const { refs, fetches } = attemptReference(fetch, [1, 5]);
  assert.equal(fetches, 2, '恰好重取一次（不是无限重试）');
  assert.deepEqual(refs, [], '本轮放弃记忆引用、如实不带卡');
  // 无猜测：连首轮合法序号 1 对应的 id 也不带（整轮放弃，不返回半截）。
});

test('M2 对照：首败 → 重取一次成功 → 正常引用（重取义务可用）', () => {
  let round = 0;
  const fetch = (): readonly RankedCard[] => {
    round += 1;
    return round === 1 ? CARDS.slice(0, 1) : CARDS;
  };
  const { refs, fetches } = attemptReference(fetch, [2]);
  assert.equal(fetches, 2);
  assert.deepEqual(refs, ['mc_b']);
});

test('M2 对照：首轮成功不触发重取', () => {
  const { refs, fetches } = attemptReference(() => CARDS, [3, 1]);
  assert.equal(fetches, 1);
  assert.deepEqual(refs, ['mc_c', 'mc_a']);
});