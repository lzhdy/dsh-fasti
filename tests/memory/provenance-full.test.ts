/**
 * provenance 全量核验红测（v4 §9 序11：20% 抽样默认停用，C5 必须逐卡全验）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditProvenance } from '../../src/memory/audit/provenance.ts';
import type { PointerResolver } from '../../src/memory/audit/provenance.ts';
import { emitUnits } from '../../src/memory/bigram.ts';
import { mulberry32, DEFAULT_RNG_SEED } from '../../src/memory/audit/metrics.ts';
import type { MemoryCard } from '../../src/memory/types.ts';
import type { Pointer } from '../../src/contract/experience.ts';

function fakeCard(cardId: string, channel: string, anchorId: string): MemoryCard {
  const anchorJson = JSON.stringify([anchorId]);
  const displayCuesJson = JSON.stringify(['报销单']);
  const aliasesJson = JSON.stringify([]);
  // 仅 auditProvenance 实际读取的字段，其余与本测试无关。
  return { cardId, channel, anchorJson, displayCuesJson, aliasesJson } as unknown as MemoryCard;
}

const okResolver: PointerResolver = async () => ({ turns: [{}] }) as never;
const failResolver: PointerResolver = async (pointer: Pointer) => {
  if (pointer.id === 'exp-bad') {
    throw new Error('悬空锚点');
  }
  return { turns: [{}] } as never;
};

function optionsFor(cards: MemoryCard[], sampleRatio?: number) {
  const ftsTextByCard = new Map(cards.map((c) => [c.cardId, emitUnits('报销单').join(' ')]));
  return {
    rng: mulberry32(DEFAULT_RNG_SEED),
    ...(sampleRatio === undefined ? {} : { sampleRatio }),
    cacheDrift: new Map<string, boolean>(),
    ftsTextByCard,
  };
}

test('缺省即全量：5 张卡跨 2 通道逐卡核验，sampled=total，不再抽 20%', async () => {
  const cards = [
    fakeCard('c1', 'dsh', 'exp-1'),
    fakeCard('c2', 'dsh', 'exp-2'),
    fakeCard('c3', 'dsh', 'exp-3'),
    fakeCard('c4', 'api', 'exp-4'),
    fakeCard('c5', 'api', 'exp-5'),
  ];
  const result = await auditProvenance(cards, okResolver, optionsFor(cards));
  assert.equal(result.total, 5);
  assert.equal(result.sampled, 5, 'C5 默认全量：一张都不能少');
  assert.equal(result.successRate, 1);
  assert.equal(result.danglingCount, 0);
  assert.equal(result.failed, false);
});

test('全量下任一悬空锚点 → 硬失败（抽样时代可能漏网，全量无处藏）', async () => {
  const cards = [fakeCard('c1', 'dsh', 'exp-1'), fakeCard('c2', 'dsh', 'exp-bad')];
  const result = await auditProvenance(cards, failResolver, optionsFor(cards));
  assert.equal(result.sampled, 2);
  assert.equal(result.danglingCount, 1);
  assert.equal(result.failed, true);
});

test('显式抽样入口仍在（专项调查用），但终判默认值不受其影响', async () => {
  const cards = Array.from({ length: 10 }, (_, i) => fakeCard(`c${i}`, 'dsh', `exp-${i}`));
  const sampled = await auditProvenance(cards, okResolver, optionsFor(cards, 0.2));
  assert.ok(sampled.sampled < 10, '显式 0.2 仍可抽样');
  const full = await auditProvenance(cards, okResolver, optionsFor(cards));
  assert.equal(full.sampled, 10, '缺省回落到全量');
});
