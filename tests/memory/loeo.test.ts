/**
 * LOEO 真逐折回算红测（v4 §9 序6：禁止只贴 mode=loeo 标签）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoeo, targetEventIds } from '../../src/memory/audit/loeo.ts';
import type { GoldQuestion, SearchFn } from '../../src/memory/audit/gold.ts';
import type { RankedCard } from '../../src/memory/types.ts';

function question(eventId: string, suffix: string): GoldQuestion {
  return {
    queryText: `${eventId}-${suffix}`,
    targetEventId: eventId,
    questionRef: `${eventId}-${suffix}`,
    source: 'l0',
    initiation: 'user',
    coldStart: false,
  };
}

/** 按 queryText 前缀返回对应事件卡的假检索（命中/漏召可切换）。 */
function fakeSearch(hit: boolean): SearchFn {
  return (q) => {
    if (!hit) {
      return [];
    }
    const eventId = q.text.split('-')[0]!;
    // 只填 replayGold 实际读取的 card.eventId，其余字段与本测试无关。
    return [{ card: { eventId } } as unknown as RankedCard];
  };
}

const opts = { atMs: 1_700_000_000_000, k: 3, relayMap: new Map<string, string>() };

test('目标事件 id 保序去重', () => {
  const qs = [question('e1', 'a'), question('e1', 'b'), question('e2', 'a'), question('e3', 'a')];
  assert.deepEqual(targetEventIds(qs), ['e1', 'e2', 'e3']);
});

test('三事件各两题：逐折留出、每折 4 题全命中，conclusive 且 pooled=1', async () => {
  const qs = [
    question('e1', 'a'), question('e1', 'b'),
    question('e2', 'a'), question('e2', 'b'),
    question('e3', 'a'), question('e3', 'b'),
  ];
  const result = await runLoeo(qs, fakeSearch(true), opts);
  assert.equal(result.conclusive, true);
  assert.equal(result.folds, 3);
  assert.equal(result.perFold.length, 3);
  for (const fold of result.perFold) {
    assert.equal(fold.n, 4, '留出一事件后剩 4 题');
    assert.equal(fold.hits, 4);
    assert.equal(fold.rate, 1);
  }
  assert.deepEqual(
    result.perFold.map((f) => f.heldEventId),
    ['e1', 'e2', 'e3'],
  );
  assert.equal(result.pooledRate, 1);
});

test('全漏召：conclusive 但 pooledRate=0（如实出数，不伪装）', async () => {
  const qs = [question('e1', 'a'), question('e2', 'a')];
  const result = await runLoeo(qs, fakeSearch(false), opts);
  assert.equal(result.conclusive, true);
  assert.equal(result.pooledRate, 0);
  assert.ok(result.perFold.every((f) => f.hits === 0 && f.rate === 0));
});

test('仅一个目标事件：折数 <2 → INCONCLUSIVE，禁止贴 LOEO 标签出数', async () => {
  const qs = [question('solo', 'a'), question('solo', 'b')];
  const result = await runLoeo(qs, fakeSearch(true), opts);
  assert.equal(result.conclusive, false);
  assert.equal(result.reason, 'loeo-folds-lt-2');
  assert.equal(result.pooledRate, null);
});
