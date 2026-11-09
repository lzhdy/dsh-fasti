/**
 * as-of 的时间轴修正（审计 Q3 / 阶段 0 · G06）。
 *
 * 契约：as-of 查询「她在 T 时刻相信什么」，判据是三条同时成立：
 *  1. 这一行在 T 时刻**已经存在**（created_ms <= T）；
 *  2. 有效性窗覆盖 T（valid_ms <= T 且尚未失效）。
 *
 * 缺第 1 条时，后补进来的回填行会被误判为「早前就已相信」。
 * L1(sqlite) / L2(jsonl) / L3(真源直读) 三档必须给出同一结果集。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { Fasti } from '../../src/api/index.ts';
import { JsonlProjection } from '../../src/projection/jsonl.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

/** as-of 时刻。 */
const T = Date.parse('2026-11-10T00:00:00.000Z');

/** 一条经历（世界轴与系统轴可分别指定，用来造回填行）。 */
function experienceOf(
  id: string,
  occurredAt: string,
  recordedAt: string,
  target: string,
): Parameters<Fasti['appendExperience']>[0] {
  return {
    id,
    schema_version: 1,
    kind: 'dialogue',
    scene: { channel: 'dsh', ref: 's-1' },
    initiation: 'user',
    observation: { cue: target },
    occurred_at: occurredAt,
    recorded_at: recordedAt,
    pointers: [{ type: 'references', target }],
  };
}

/** 写入两条：一条在 T 之前落源，一条是 T 之后才补进来的回填行。 */
async function seed(fasti: Fasti): Promise<void> {
  await fasti.appendExperience(
    experienceOf(
      '01J0000000000000000000000A',
      '2026-11-01T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      'target-normal',
    ),
  );
  await fasti.appendExperience(
    experienceOf(
      '01J0000000000000000000000B',
      '2026-11-05T00:00:00.000Z',
      '2026-11-20T00:00:00.000Z',
      'target-backfilled',
    ),
  );
}

test('G06：回填行（created_ms 晚于 T）在 as-of 查询中不返回', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await seed(fasti);

    // 不带 as-of：两条都在（as-of 只是额外的过滤条件）。
    assert.equal((await fasti.queryEdges({})).length, 2);

    const edges = await fasti.queryEdges({ asOf: T });
    assert.equal(edges.length, 1, '回填行在 T 时刻还不存在 → 不得被当成「早前已相信」');
    assert.equal(edges[0]?.dst, 'target-normal');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('G06：边界 —— created_ms == T 的行仍返回（<= 闭区间）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience(
      experienceOf(
        '01J0000000000000000000000A',
        '2026-11-01T00:00:00.000Z',
        '2026-11-10T00:00:00.000Z',
        'target-on-boundary',
      ),
    );

    const edges = await fasti.queryEdges({ asOf: T });
    assert.equal(edges.length, 1);
    assert.equal(edges[0]?.dst, 'target-on-boundary');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('G06：as-of 早于任何落源时刻 → 结果为空（不是「全都有」）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await seed(fasti);
    const edges = await fasti.queryEdges({ asOf: Date.parse('2026-10-01T00:00:00.000Z') });
    assert.equal(edges.length, 0);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('G06：三档引擎的 as-of 结果集完全一致（L1 = L2 = L3）', async () => {
  const root = makeTempRoot();
  try {
    const seedFasti = await Fasti.open({ dataRoot: root });
    try {
      await seed(seedFasti);
    } finally {
      await seedFasti.close();
    }

    const perLevel = new Map<string, string[]>();
    for (const level of ['L1', 'L2', 'L3'] as const) {
      const fasti = await Fasti.open({ dataRoot: root, projectionLevel: level });
      try {
        const edges = await fasti.queryEdges({ asOf: T });
        perLevel.set(level, edges.map((edge) => edge.dst).sort());
      } finally {
        await fasti.close();
      }
    }

    const l1 = perLevel.get('L1') as string[];
    assert.deepEqual(perLevel.get('L2'), l1, 'L2 与 L1 的 as-of 结果不一致');
    assert.deepEqual(perLevel.get('L3'), l1, 'L3 与 L1 的 as-of 结果不一致');
    assert.deepEqual(l1, ['target-normal'], '回填行在 T 时刻还不存在');
  } finally {
    cleanupTempRoot(root);
  }
});

test('G06：created_ms 为 null → 不返回（无法证明它在 T 时刻存在）', async () => {
  const root = makeTempRoot();
  const engine = new JsonlProjection(path.join(root, 'l2'));
  try {
    await engine.open();
    await engine.upsertEdge({
      id: 'edge_null_created',
      src: 'src-1',
      predicate: 'references',
      dst: 'dst-null-created',
      valid_ms: 0,
      invalid_ms: null,
      // L1 的 DDL 里 created_ms 是 NOT NULL、L3 由 recorded_at 派生（不会是 null）；
      // 这里用 L2 直写边行验证「为 null 就不返回」这条边界口径。
      created_ms: null as unknown as number,
      expired_ms: null,
      confidence: null,
      reason: null,
      provenance: 'experience.pointers',
    });
    await engine.upsertEdge({
      id: 'edge_with_created',
      src: 'src-1',
      predicate: 'references',
      dst: 'dst-with-created',
      valid_ms: 0,
      invalid_ms: null,
      created_ms: T,
      expired_ms: null,
      confidence: null,
      reason: null,
      provenance: 'experience.pointers',
    });

    const edges = await engine.queryEdges({ as_of_ms: T });
    assert.deepEqual(
      edges.map((edge) => edge.dst),
      ['dst-with-created'],
      'created_ms 为 null 的行不得被当成「T 时刻已存在」',
    );
  } finally {
    await engine.close();
    cleanupTempRoot(root);
  }
});
