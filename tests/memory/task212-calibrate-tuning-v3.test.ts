/**
 * task212 红测：v3 调参卷标定读数聚合（纯函数，不触库、不建根）。
 *
 * 为什么要先做纯函数：真正跑一遍标定要开 v3 根并逐题检索（分钟级、依赖仓外产物），
 * 而「位次怎么算、什么算被对手反超、弃权怎么记」这些口径恰恰最容易写错、也最该被单测钉死。
 * 故把口径留在纯函数里红测锁定，I/O 壳只负责喂行。
 *
 * 两条口径由正本决定，不在本文件自造：
 *  - V2 门已退役 abstain 语义（`src/memory/gate.ts:377`：「abstain 语义在 V2 退役；v1 路径保留 abstain 不动」），
 *    因此弃权题在 v2 几何下只能记「是否零合格卡」（no-match），不能记「abstain」；
 *  - 排序在 V2 是证据三元组字典序（gate.ts:343-360），故 topTie 的口径是「top1 与 top2 证据总和相等」。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  summarizeTuningRows,
  type TuningCalibrationRowV3,
} from '../../scripts/p6/calibrate-tuning-v3.ts';

function row(over: Partial<TuningCalibrationRowV3>): TuningCalibrationRowV3 {
  return {
    probeId: 'P',
    layer: 'tuning-gold',
    bucket: 'B1',
    partition: 'tuning-a',
    queryText: 'q',
    candidateCount: 3,
    acceptedCount: 3,
    status: 'matched',
    goldRanks: [-1],
    rivalRanks: [],
    topTie: false,
    topEvidenceSum: null,
    secondEvidenceSum: null,
    ...over,
  };
}

test('TA4-1 金标位次派生：未进合格集不算召回，位次 0 才算 top1', () => {
  const s = summarizeTuningRows([
    row({ probeId: 'A', goldRanks: [-1] }),
    row({ probeId: 'B', goldRanks: [0] }),
    row({ probeId: 'C', goldRanks: [2] }),
    row({ probeId: 'D', goldRanks: [1, 4] }),
  ]);
  const b1 = s.byBucket['B1']!;
  assert.equal(b1.n, 4);
  assert.equal(b1.goldAcceptedCount, 3);
  assert.equal(b1.goldTop1Count, 1);
  assert.equal(b1.goldAcceptedRate, 0.75);
  assert.equal(b1.goldTop1Rate, 0.25);
});

test('TA4-2 对手反超判定：只有全部对手都排在金标之后（或未进）才算赢', () => {
  const s = summarizeTuningRows([
    // 金标首位，对手 2/3 位 → 赢
    row({ layer: 'tuning-decoy', bucket: 'B5', goldRanks: [0], rivalRanks: [2, 3] }),
    // 对手 0 位、金标 1 位 → 输
    row({ layer: 'tuning-decoy', bucket: 'B5', goldRanks: [1], rivalRanks: [0] }),
    // 金标未进 → 输
    row({ layer: 'tuning-decoy', bucket: 'B5', goldRanks: [-1], rivalRanks: [0] }),
    // 对手全未进 → 赢
    row({ layer: 'tuning-decoy', bucket: 'B5', goldRanks: [0], rivalRanks: [-1, -1] }),
  ]);
  const b5 = s.byBucket['B5']!;
  assert.equal(b5.rivalBeatenCount, 2);
  assert.equal(b5.rivalBeatenRate, 0.5);
});

test('TA4-3 弃权在 v2 口径下只记零合格卡，不得伪造 abstain 状态', () => {
  const s = summarizeTuningRows([
    row({ layer: 'tuning-abstain', bucket: 'B2', hardness: 'hard', acceptedCount: 0, status: 'no-match', goldRanks: [-1] }),
    row({ layer: 'tuning-abstain', bucket: 'B2', hardness: 'soft', acceptedCount: 0, status: 'no-match', goldRanks: [-1] }),
    row({ layer: 'tuning-abstain', bucket: 'B2', hardness: 'soft', acceptedCount: 2, status: 'matched', goldRanks: [0] }),
  ]);
  const b2 = s.byBucket['B2']!;
  assert.equal(b2.noMatchCount, 2);
  assert.equal(Math.round(b2.noMatchRate * 100) / 100, 0.67);
  // 硬度维度单独可见：hard 全零合格，soft 有 1 题漏过。
  assert.equal(s.byHardness['hard']!.n, 1);
  assert.equal(s.byHardness['hard']!.noMatchCount, 1);
  assert.equal(s.byHardness['soft']!.noMatchCount, 1);
  assert.equal(s.byHardness['soft']!.n, 2);
});

test('TA4-4 分桶/分区/型别聚合互不串，且给出总计', () => {
  const s = summarizeTuningRows([
    row({ bucket: 'B1', partition: 'tuning-a', goldRanks: [0] }),
    row({ bucket: 'B11', partition: 'tuning-b', goldRanks: [-1], negativeSignature: 3 }),
    row({ bucket: 'B11', partition: 'tuning-a', goldRanks: [0], negativeSignature: 3 }),
  ]);
  assert.equal(s.byBucket['B1']!.n, 1);
  assert.equal(s.byBucket['B11']!.n, 2);
  assert.equal(s.byPartition['tuning-a']!.n, 2);
  assert.equal(s.byPartition['tuning-b']!.n, 1);
  assert.equal(s.bySignature['3']!.n, 2);
  assert.equal(s.bySignature['3']!.goldTop1Count, 1);
  assert.equal(s.totals.n, 3);
  assert.equal(s.totals.goldTop1Count, 2);
});

test('TA4-5 空输入与零候选不产出 NaN / Infinity', () => {
  const empty = summarizeTuningRows([]);
  assert.equal(empty.totals.n, 0);
  assert.equal(empty.totals.goldTop1Rate, 0);
  assert.equal(empty.totals.rivalBeatenRate, 0);
  assert.equal(Object.keys(empty.byBucket).length, 0);

  const zeroCand = summarizeTuningRows([
    row({ acceptedCount: 0, candidateCount: 0, status: 'no-match', goldRanks: [-1] }),
  ]);
  const b1 = zeroCand.byBucket['B1']!;
  assert.equal(b1.noMatchCount, 1);
  assert.equal(b1.noMatchRate, 1);
  assert.equal(Number.isFinite(b1.goldTop1Rate), true);
  assert.equal(Number.isFinite(b1.rivalBeatenRate), true);
});
