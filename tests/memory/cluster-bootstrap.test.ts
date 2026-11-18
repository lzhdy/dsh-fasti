/**
 * 卡簇 bootstrap 红测（v4 §7，外审 B4：题级 iid 区间虚窄，终判必须按事件簇重采样）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  DEFAULT_RNG_SEED,
  clusterRatioEstimate,
  isClusterGateConclusive,
  MIN_GATE_CLUSTERS,
  percentileCI,
} from '../../src/memory/audit/metrics.ts';

test('空样本返回零值与 clusterCount=0（N/A 交由聚合层）', () => {
  assert.deepEqual(clusterRatioEstimate([], mulberry32(DEFAULT_RNG_SEED)), {
    point: 0,
    ciLower: 0,
    ciUpper: 0,
    n: 0,
    clusterCount: 0,
  });
});

test('同一事件多题只算一簇：clusterCount 按事件 id 去重，n 仍是题数', () => {
  const obs = [
    { clusterId: 'evt-a', outcome: 1 as const },
    { clusterId: 'evt-a', outcome: 0 as const },
    { clusterId: 'evt-a', outcome: 1 as const },
    { clusterId: 'evt-b', outcome: 0 as const },
  ];
  const estimate = clusterRatioEstimate(obs, mulberry32(DEFAULT_RNG_SEED));
  assert.equal(estimate.n, 4);
  assert.equal(estimate.clusterCount, 2);
  assert.equal(estimate.point, 0.5);
});

test('单簇重采样只能抽到自己：CI 退化为该簇 pooled 命中率', () => {
  const obs = Array.from({ length: 6 }, (_, i) => ({
    clusterId: 'only',
    outcome: (i < 4 ? 1 : 0) as 0 | 1,
  }));
  const estimate = clusterRatioEstimate(obs, mulberry32(DEFAULT_RNG_SEED));
  assert.equal(estimate.point, 4 / 6);
  assert.equal(estimate.ciLower, estimate.point);
  assert.equal(estimate.ciUpper, estimate.point);
  assert.equal(isClusterGateConclusive(estimate.clusterCount), false, '单簇远不足 30，终判必须 INCONCLUSIVE');
});

test('同种子逐字节可复现', () => {
  const obs = Array.from({ length: 40 }, (_, i) => ({
    clusterId: `evt-${i % 10}`,
    outcome: (i % 3 === 0 ? 0 : 1) as 0 | 1,
  }));
  const a = clusterRatioEstimate(obs, mulberry32(DEFAULT_RNG_SEED));
  const b = clusterRatioEstimate(obs, mulberry32(DEFAULT_RNG_SEED));
  assert.deepEqual(a, b);
});

test('簇内同质、簇间对立时：卡簇区间不窄于题级 iid 区间（不许再用虚窄区间）', () => {
  // 10 个簇：5 簇全对、5 簇全错，每簇 4 题。题级 iid 假装 40 个独立样本，区间虚窄；
  // 卡簇 bootstrap 只看见 10 个独立单位，区间必须更宽或相等。
  const obs: Array<{ clusterId: string; outcome: 0 | 1 }> = [];
  for (let c = 0; c < 10; c += 1) {
    for (let q = 0; q < 4; q += 1) {
      obs.push({ clusterId: `evt-${c}`, outcome: c < 5 ? 1 : 0 });
    }
  }
  const clustered = clusterRatioEstimate(obs, mulberry32(DEFAULT_RNG_SEED), 2000);
  const iid = percentileCI(
    obs.map((o) => o.outcome),
    mulberry32(DEFAULT_RNG_SEED),
    2000,
  );
  assert.ok(clustered.ciLower <= iid.ciLower, `下界 ${clustered.ciLower} 应 ≤ iid ${iid.ciLower}`);
  assert.ok(clustered.ciUpper >= iid.ciUpper, `上界 ${clustered.ciUpper} 应 ≥ iid ${iid.ciUpper}`);
});

test('终判门簇数阈值：29 簇 INCONCLUSIVE，30 簇可判（边界钉死）', () => {
  assert.equal(isClusterGateConclusive(MIN_GATE_CLUSTERS - 1), false);
  assert.equal(isClusterGateConclusive(MIN_GATE_CLUSTERS), true);
  assert.equal(MIN_GATE_CLUSTERS, 30);
});
