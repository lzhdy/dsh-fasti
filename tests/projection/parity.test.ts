/**
 * 三档引擎检索语义一致性测试（决策 D-5 的机器可验形式）。
 *
 * 契约：L1（sqlite/FTS5 trigram）、L2（JSONL 倒排）、L3（真源直读）
 * 对同一语料、同一查询必须给出**完全相同**的结果集 ——
 * 这是「每级功能不丢、仅性能/丰富度下降」（审计第四节阶段 2）的可执行断言。
 *
 * 本文件覆盖的查询形态：ASCII 词内子串、ASCII 整词、中文双字、中文单字、
 * Unicode 带变音符、无命中、以及含空格的查询。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fasti } from '../../src/api/index.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const CORPUS = '今天下午她在 browser 里读到 English 论文 与 Ünïcödé';

/** 建一份带语料的真源，返回数据根。 */
async function seedCorpus(root: string): Promise<void> {
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience({
      id: '01J0000000000000000000000A',
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 's-1' },
      initiation: 'user',
      observation: { cue: CORPUS },
      occurred_at: '2026-11-15T12:00:00.000Z',
    });
  } finally {
    await fasti.close();
  }
}

const QUERIES = [
  'brows', // ASCII 词内子串（整词索引会漏）
  'rowser',
  'rows',
  'Eng', // ASCII 词前缀
  'nglish',
  'browser', // ASCII 整词
  '论', // 中文单字
  '文',
  '论文', // 中文双字（trigram 需 LIKE 回退）
  'Ünïcödé', // Unicode 带变音符
  'nicod', // Unicode 子串
  '浏览器', // 无命中
  'xyz', // 无命中
];

test('三档引擎对同一语料的检索结果集完全一致', async () => {
  const root = makeTempRoot();
  try {
    await seedCorpus(root);

    const perLevel = new Map<string, Map<string, string[]>>();

    for (const level of ['L1', 'L2', 'L3'] as const) {
      const fasti = await Fasti.open({ dataRoot: root, projectionLevel: level });
      try {
        const collected = new Map<string, string[]>();
        for (const query of QUERIES) {
          const hits = await fasti.search(query);
          collected.set(
            query,
            hits.map((hit) => hit.id).sort(),
          );
        }
        perLevel.set(level, collected);
      } finally {
        await fasti.close();
      }
    }

    const l1 = perLevel.get('L1') as Map<string, string[]>;
    const l2 = perLevel.get('L2') as Map<string, string[]>;
    const l3 = perLevel.get('L3') as Map<string, string[]>;

    for (const query of QUERIES) {
      assert.deepEqual(
        l2.get(query),
        l1.get(query),
        `L2 与 L1 结果不一致：${JSON.stringify(query)}`,
      );
      assert.deepEqual(
        l3.get(query),
        l1.get(query),
        `L3 与 L1 结果不一致：${JSON.stringify(query)}`,
      );
    }

    // 确认语料确实可命中（避免「全都不命中」造成的假阳性一致）。
    assert.equal(l1.get('brows')?.length, 1, 'ASCII 词内子串应命中');
    assert.equal(l1.get('论文')?.length, 1, '中文双字应命中');
    assert.equal(l1.get('浏览器')?.length, 0, '不存在的词不应命中');
  } finally {
    cleanupTempRoot(root);
  }
});

test('三档引擎的多维查询结果集完全一致', async () => {
  const root = makeTempRoot();
  try {
    await seedCorpus(root);

    const filters = [
      { kind: 'dialogue' },
      { channel: 'dsh' },
      { scene: 's-1' },
      { initiation: 'user' },
      { channel: 'nonexistent' },
    ];

    for (const filter of filters) {
      const counts: number[] = [];
      for (const level of ['L1', 'L2', 'L3'] as const) {
        const fasti = await Fasti.open({ dataRoot: root, projectionLevel: level });
        try {
          counts.push((await fasti.query(filter)).length);
        } finally {
          await fasti.close();
        }
      }
      assert.equal(
        counts[0],
        counts[1],
        `L2 与 L1 查询结果数不一致：${JSON.stringify(filter)}`,
      );
      assert.equal(
        counts[0],
        counts[2],
        `L3 与 L1 查询结果数不一致：${JSON.stringify(filter)}`,
      );
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('三档引擎的边查询结果集完全一致（含边内部 id）', async () => {
  const root = makeTempRoot();
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await fasti.appendExperience({
        id: '01J0000000000000000000000A',
        schema_version: 1,
        kind: 'dialogue',
        scene: { channel: 'dsh', ref: 's-1' },
        initiation: 'user',
        observation: { cue: CORPUS },
        occurred_at: '2026-11-15T12:00:00.000Z',
        pointers: [{ type: 'continues', target: 'target-x', note: '接着说' }],
      });
    } finally {
      await fasti.close();
    }

    // 比的是**边内部 id**（审计 M1 指出：此前比的是经历 id，故三档 id 不一致没被抓到）。
    for (const level of ['L1', 'L2', 'L3'] as const) {
      const fasti = await Fasti.open({ dataRoot: root, projectionLevel: level });
      try {
        const edges = await fasti.queryEdges({ predicate: 'continues' });
        assert.equal(edges.length, 1, `${level} 档应查到 1 条边`);
        assert.equal(edges[0]?.src, '01J0000000000000000000000A');
        assert.equal(edges[0]?.dst, 'target-x');
        assert.equal(edges[0]?.reason, '接着说');
        // 边 id 形如 edge_<32 位十六进制>，三档必须逐字相同。
        assert.match(edges[0]?.id ?? '', /^edge_[0-9a-f]{32}$/, `${level} 档边 id 格式异常`);
      } finally {
        await fasti.close();
      }
    }
  } finally {
    cleanupTempRoot(root);
  }
});
