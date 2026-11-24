/**
 * 终判 harness top1 对齐红测（192 号文书实证两缺陷的回归锁）。
 *
 * 背景：run-memory-audit 曾以 eventId 为键在 Map 里存 top1（questionRef=eventId），
 * 预注册允许同事件跨层供题（v5 §5.3），后写层覆盖先写层，导致 L_S4 门表被 S5 同事件题
 * 顶包污染（192 号逐字复现 wc=10）。本文件锁定：层探针必须按题目索引逐题对齐，
 * 同事件不同层各算各的 top1，且长度不齐 fail-loud。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayerProbesV2, collectTop1Records } from '../../src/memory/audit/top1-alignment.ts';
import type { GoldQuestion, GoldQuestionResult } from '../../src/memory/audit/gold.ts';

function question(over: Partial<GoldQuestion> & Pick<GoldQuestion, 'targetEventId' | 'constructionLayer'>): GoldQuestion {
  return {
    queryText: 'q',
    questionRef: over.targetEventId,
    source: 'l0',
    initiation: 'user',
    coldStart: false,
    ...over,
  };
}

const qs: GoldQuestion[] = [
  question({ targetEventId: 'ev-shared', constructionLayer: 'S1' }),
  question({ targetEventId: 'ev-shared', constructionLayer: 'S4', highRisk: true }),
  question({ targetEventId: 'ev-only-s2', constructionLayer: 'S2' }),
  question({ targetEventId: 'ev-l1-no-layer', constructionLayer: undefined }),
];

const gold: GoldQuestionResult[] = qs.map((q, i) => ({
  questionRef: q.questionRef,
  targetEventId: q.targetEventId,
  resolvedEventId: q.targetEventId,
  hit: i !== 2,
  rank: i !== 2 ? 1 : null,
  scoreParts: null,
  relayChain: [q.targetEventId],
  initiation: 'user',
  coldStart: false,
  source: 'l0',
  constructionLayer: q.constructionLayer,
}));

test('同事件跨层题：两层各自读取本题 top1，互不覆盖', async () => {
  // S1 题 top1 错认；S4 题 top1 正确——旧 Map 口径会让两层都读到后写的 S4 结果。
  const records = await collectTop1Records(qs, async (q) =>
    q.constructionLayer === 'S1' ? { committed: true, top1IsGold: false } : { committed: true, top1IsGold: true },
  );
  const probes = buildLayerProbesV2(gold, qs, records);
  const s1 = probes.find((p) => p.layer === 'S1')!;
  const s4 = probes.find((p) => p.layer === 'S4')!;
  assert.equal(s1.committed, true);
  assert.equal(s1.top1IsGold, false, 'S1 必须保留自己的错认，不能被同事件 S4 题顶包');
  assert.equal(s4.committed, true);
  assert.equal(s4.top1IsGold, true);
  assert.equal(s4.highRisk, true, '高危标记随题不随事件键');
  const s2 = probes.find((p) => p.layer === 'S2')!;
  assert.equal(s2.hit, false, 'R1 hit 仍取自 gold 回放结果');
});

test('无构造层题（l1/l2）不产生层探针', () => {
  const records = qs.map(() => ({ committed: true, top1IsGold: true }));
  const probes = buildLayerProbesV2(gold, qs, records);
  assert.equal(probes.length, 3);
  assert.ok(probes.every((p) => p.layer !== undefined));
});

test('题目数与 top1 记录数不齐：fail-loud 拒绝静默错位', async () => {
  const records = [{ committed: false, top1IsGold: false }];
  await assert.rejects(() => collectTop1Records(qs, async () => ({ committed: false, top1IsGold: false })).then((r) => buildLayerProbesV2(gold, qs, r.slice(0, 1))), /对齐/);
  assert.throws(() => buildLayerProbesV2(gold, qs, records), /对齐/);
});

test('collectTop1Records 严格按题目顺序回填，搜索函数可异步', async () => {
  const records = await collectTop1Records(qs, async (q) => ({ committed: q.constructionLayer !== 'S2', top1IsGold: false }));
  assert.deepEqual(records.map((r) => r.committed), [true, true, false, true]);
});
