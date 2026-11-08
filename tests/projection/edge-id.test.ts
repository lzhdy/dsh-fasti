/**
 * 边的确定性断言（审计 M1）。
 *
 * 审计指出的缺陷：edge id 曾有三套口径
 *   增量写入 `edge_<src>_<pred>_<dst>` / L3 直读 同格式 / 全量重建 `edge_<sha256>`
 * → 同一条边在重建前后内部 id 变化，L3 与 L1/L2 对同一条边给出不同 id，
 *   违反定案稿 §7.2「投影确定性、幂等」与 types.ts「三档结果集必须一致」。
 *
 * 本文件把「重建前后 id 恒定」与「三档 id 逐字相同」变成可执行断言 ——
 * 审计同时指出，parity 测试此前比的是经历 id 而非边 id，故该缺陷在测试全绿时未被抓到。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fasti } from '../../src/api/index.ts';
import { edgeIdOf } from '../../src/projection/edge.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const EXP_ID = '01J0000000000000000000000A';
const POINTERS = [
  { type: 'continues', target: 'target-x', note: '接着说' },
  { type: 'references', target: 'target-y' },
];

test('增量写入与全量重建后 edge 内部 id 逐字一致（M1 核心断言）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience({
      id: EXP_ID,
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 's-1' },
      initiation: 'user',
      observation: { cue: '测试线索' },
      occurred_at: '2026-11-15T12:00:00.000Z',
      pointers: POINTERS,
    });

    // 增量写入路径产生的边 id。
    const before = await fasti.queryEdges({});
    assert.equal(before.length, 2, '两条指针应折叠出两条边');
    const beforeIds = before.map((edge) => edge.id).sort();

    // 触发全量重建（清空投影后从真源重新折叠）。
    await fasti.rebuildProjections();

    const after = await fasti.queryEdges({});
    const afterIds = after.map((edge) => edge.id).sort();

    assert.deepEqual(afterIds, beforeIds, '重建前后同一条边的内部 id 不得变化');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('三档引擎对同一条边给出逐字相同的内部 id（M1 跨档断言）', async () => {
  const root = makeTempRoot();
  try {
    const seed = await Fasti.open({ dataRoot: root });
    try {
      await seed.appendExperience({
        id: EXP_ID,
        schema_version: 1,
        kind: 'dialogue',
        scene: { channel: 'dsh', ref: 's-1' },
        initiation: 'user',
        observation: { cue: '测试线索' },
        occurred_at: '2026-11-15T12:00:00.000Z',
        pointers: POINTERS,
      });
    } finally {
      await seed.close();
    }

    const perLevel = new Map<string, string[]>();
    for (const level of ['L1', 'L2', 'L3'] as const) {
      const fasti = await Fasti.open({ dataRoot: root, projectionLevel: level });
      try {
        const edges = await fasti.queryEdges({});
        perLevel.set(
          level,
          edges.map((edge) => edge.id).sort(),
        );
      } finally {
        await fasti.close();
      }
    }

    const l1 = perLevel.get('L1') as string[];
    assert.deepEqual(perLevel.get('L2'), l1, 'L2 与 L1 的边 id 集合不一致');
    assert.deepEqual(perLevel.get('L3'), l1, 'L3 与 L1 的边 id 集合不一致');
    assert.equal(l1.length, 2);
  } finally {
    cleanupTempRoot(root);
  }
});

test('边 id 只由 (src, predicate, dst) 决定，与写入顺序、写入路径无关', async () => {
  const root = makeTempRoot();
  try {
    // 同一条关系，无论谁先写，id 恒定。
    const a = await Fasti.open({ dataRoot: root });
    let firstId: string;
    try {
      await a.appendExperience({
        id: EXP_ID,
        schema_version: 1,
        kind: 'dialogue',
        scene: { channel: 'dsh', ref: 's-1' },
        initiation: 'user',
        observation: { cue: '线索' },
        occurred_at: '2026-11-15T12:00:00.000Z',
        pointers: [{ type: 'continues', target: 'target-x' }],
      });
      const edges = await a.queryEdges({});
      firstId = edges[0]?.id ?? '';
      assert.ok(firstId, '应查到一条边');
    } finally {
      await a.close();
    }

    // 再开一个实例（模拟新进程），从真源重建后 id 不变。
    const b = await Fasti.open({ dataRoot: root, projectionLevel: 'L3' });
    try {
      const edges = await b.queryEdges({});
      assert.equal(edges[0]?.id, firstId, '重开进程后边 id 不得变化');
    } finally {
      await b.close();
    }

    // id 也不随 note 等可变字段变化 —— 它只标识「谁指向谁、什么关系」。
    const otherRoot = makeTempRoot();
    const withNote = await Fasti.open({ dataRoot: otherRoot });
    try {
      await withNote.appendExperience({
        id: EXP_ID,
        schema_version: 1,
        kind: 'dialogue',
        scene: { channel: 'dsh', ref: 's-1' },
        initiation: 'user',
        observation: { cue: '线索' },
        occurred_at: '2026-11-15T12:00:00.000Z',
        pointers: [{ type: 'continues', target: 'target-x', note: '不同的备注' }],
      });
      const edges = await withNote.queryEdges({});
      assert.equal(edges[0]?.id, firstId, 'note 变化不应影响边 id');
    } finally {
      await withNote.close();
      cleanupTempRoot(otherRoot);
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('边 id 对含下划线的 predicate / dst 不产生歧义（分隔符不是可见字符）', async () => {
  // 若 id 用 `edge_<src>_<pred>_<dst>` 拼接，
  // 则 (pred='a_b', dst='c') 与 (pred='a', dst='b_c') 会得到同一个字符串 → 撞车。
  const idA = edgeIdOf('src-1', 'a_b', 'c');
  const idB = edgeIdOf('src-1', 'a', 'b_c');
  assert.notEqual(idA, idB, '不同三元组不得得到同一个边 id');
});

test('边 id 格式稳定：edge_ 前缀 + 32 位十六进制', async () => {
  const id = edgeIdOf('src-1', 'continues', 'target-x');
  assert.match(id, /^edge_[0-9a-f]{32}$/);
});
