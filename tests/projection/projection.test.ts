/**
 * 最小投影测试（审计第四节阶段 2 验收项）：
 *  - 三表 + 索引建立，字段与 §7.1 一致；
 *  - FTS 文本来自原文回读 + cue（非摘要），trigram 中文可命中；
 *  - experience.pointers 正确折叠进 edge，predicate 与来源一致；
 *  - 增量投影与真源在事务内一致；强制失败后可触发重建；
 *  - L1→L2→L3 降级可手动触发验证，每级功能不丢、降级有标注；
 *  - 全量重建后对账。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { Fasti } from '../../src/api/index.ts';
import { RawLog } from '../../src/source/raw-log.ts';
import {
  EXPECTED_EDGE_COLUMNS,
  EXPECTED_EXPERIENCE_COLUMNS,
  EXPECTED_INDEXES,
  EXPECTED_TABLES,
} from '../../src/projection/schema.ts';
import { selectEngine, parseLevel } from '../../src/projection/detect.ts';
import { cleanupTempRoot, makeTempRoot, makeExperience } from '../helpers.ts';

const OPEN_ULID = '01J0000000000000000000000A';

/** 造一条带原文指针的经历：正文在原文层，经历只带指针 + cue。 */
async function seedWithRaw(root: string, options: { rawText: string; cue: string }): Promise<string> {
  const rawLog = new RawLog('dsh', path.join(root, 'raw-turns'));
  rawLog.append({
    event_id: 'raw-1',
    speaker: 'user',
    raw_text: options.rawText,
    ingested_at: '2026-11-15T12:00:00.000Z',
  });

  const fasti = await Fasti.open({ dataRoot: root });
  await fasti.appendExperience(
    makeExperience({
      id: OPEN_ULID,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 'session-1' },
      occurred_at: '2026-11-15T12:00:00.000Z',
      observation: {
        text: { id: 'raw-1', channel: 'dsh', shard: '2026-11', seq: 0 },
        cue: options.cue,
      },
    }),
  );
  await fasti.close();
  return OPEN_ULID;
}

test('三表 + 索引建立，字段与 §7.1 一致', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const dbFile = path.join(root, 'projection', 'fasti.sqlite');
    assert.ok(fs.existsSync(dbFile), '投影库文件应存在');

    const db = new DatabaseSync(dbFile);
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      for (const table of EXPECTED_TABLES) {
        assert.ok(tables.includes(table), `缺少表 ${table}`);
      }

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      for (const index of EXPECTED_INDEXES) {
        assert.ok(indexes.includes(index), `缺少索引 ${index}`);
      }

      const experienceCols = (db.prepare('PRAGMA table_info(experience)').all() as Array<{
        name: string;
        type: string;
      }>).map((row) => [row.name, row.type]);
      assert.deepEqual(experienceCols, EXPECTED_EXPERIENCE_COLUMNS.map((r) => [...r]));

      const edgeCols = (db.prepare('PRAGMA table_info(edge)').all() as Array<{
        name: string;
        type: string;
      }>).map((row) => [row.name, row.type]);
      assert.deepEqual(edgeCols, EXPECTED_EDGE_COLUMNS.map((r) => [...r]));

      // FTS5 trigram 分词器按 §7.1 落定。
      const ftsSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name='experience_fts'").get() as {
          sql: string;
        }
      ).sql;
      assert.ok(ftsSql.includes('fts5'), 'experience_fts 必须是 fts5 虚表');
      assert.ok(ftsSql.includes("tokenize='trigram'"), 'experience_fts 必须用 trigram 分词器');
    } finally {
      db.close();
    }
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('FTS 文本来自原文回读 + cue（索引原文与线索，不是摘要）', async () => {
  const root = makeTempRoot();
  try {
    await seedWithRaw(root, { rawText: '今天下午她在浏览器里读到一篇论文', cue: '关于论文的对话' });

    const fasti = await Fasti.open({ dataRoot: root });
    try {
      const hits = await fasti.search('浏览器');
      assert.equal(hits.length, 1, '原文中的词应可命中');
      assert.equal(hits[0]?.id, OPEN_ULID);

      const snippet = hits[0]?.snippet ?? '';
      assert.ok(snippet.includes('浏览器'), '片段应含原文');
      assert.ok(snippet.includes('论文'), '片段应含原文其余部分');

      // cue 也在索引里。
      const cueHits = await fasti.search('关于论文的对话');
      assert.equal(cueHits.length, 1, 'cue 应被索引');

      // 索引内容不含任何「摘要」字段。
      const db = new DatabaseSync(path.join(root, 'projection', 'fasti.sqlite'));
      try {
        const rows = db.prepare('SELECT text FROM experience_fts').all() as Array<{ text: string }>;
        assert.equal(rows.length, 1);
        assert.ok(rows[0]?.text.includes('浏览器'));
        assert.ok(rows[0]?.text.includes('关于论文的对话'));
        assert.ok(!rows[0]?.text.includes('summary'));
        assert.ok(!rows[0]?.text.includes('摘要'));
      } finally {
        db.close();
      }
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('trigram 中文可命中：3 字查询命中，且 2 字查询经 LIKE 回退同样命中', async () => {
  const root = makeTempRoot();
  try {
    await seedWithRaw(root, { rawText: '今天下午她在浏览器里读到一篇论文', cue: '线索' });

    const fasti = await Fasti.open({ dataRoot: root });
    try {
      const three = await fasti.search('浏览器');
      assert.equal(three.length, 1, '3 字中文查询应命中（trigram 主路径）');

      const two = await fasti.search('论文');
      assert.equal(two.length, 1, '2 字中文查询应经 LIKE 回退命中');
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('experience.pointers 正确折叠进 edge，predicate 与来源一致', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience(
      makeExperience({
        id: OPEN_ULID,
        occurred_at: '2026-11-15T12:00:00.000Z',
        recorded_at: '2026-11-15T12:00:01.000Z',
        pointers: [
          { type: 'continues', target: 'target-a', note: '接着说' },
          { type: 'references', target: 'target-b' },
        ],
      }),
    );

    const db = new DatabaseSync(path.join(root, 'projection', 'fasti.sqlite'));
    try {
      const rows = db.prepare('SELECT * FROM edge ORDER BY predicate').all() as Array<Record<string, unknown>>;
      assert.equal(rows.length, 2);

      const continues = rows.find((row) => row['predicate'] === 'continues');
      assert.ok(continues, '应有 continues 边');
      assert.equal(continues['src'], OPEN_ULID, 'src = experience.id');
      assert.equal(continues['dst'], 'target-a');
      assert.equal(continues['valid_ms'], Date.parse('2026-11-15T12:00:00.000Z'), 'valid_ms = occurred');
      assert.equal(continues['created_ms'], Date.parse('2026-11-15T12:00:01.000Z'), 'created_ms = recorded');
      assert.equal(continues['reason'], '接着说');
      assert.equal(continues['provenance'], 'experience.pointers');

      const references = rows.find((row) => row['predicate'] === 'references');
      assert.ok(references);
      assert.equal(references['dst'], 'target-b');
    } finally {
      db.close();
    }
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('增量投影与真源一致：append 后投影立即可查', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience(
      makeExperience({
        id: OPEN_ULID,
        occurred_at: '2026-11-15T12:00:00.000Z',
        scene: { channel: 'dsh', ref: 's-1' },
      }),
    );

    const rows = await fasti.query({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, OPEN_ULID);

    // 投影的 shard/seq 指向真源真实落点（双定位指针可从投影反查真源）。
    const db = new DatabaseSync(path.join(root, 'projection', 'fasti.sqlite'));
    try {
      const row = db.prepare('SELECT shard, seq FROM experience WHERE id = ?').get(OPEN_ULID) as {
        shard: string;
        seq: number;
      };
      assert.ok(row.shard.length > 0, 'shard 应指向真实分片');
      assert.equal(row.seq, 0);
    } finally {
      db.close();
    }
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('投影失败不丢真源：真源写入仍成立，并标记需重建', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    // 制造一次投影写入失败：把 experience 表改名，使 upsert 报错。
    const db = new DatabaseSync(path.join(root, 'projection', 'fasti.sqlite'));
    db.exec('ALTER TABLE experience RENAME TO experience_broken');
    db.close();

    await fasti.appendExperience(
      makeExperience({ id: OPEN_ULID, recorded_at: '2026-11-15T12:00:00.000Z' }),
    );

    // 真源里必须有这条经历（真源是唯一权威）。
    const experienceFile = path.join(root, 'experiences', '2026-11.jsonl');
    assert.ok(fs.existsSync(experienceFile), '真源写入不应因投影失败而丢失');
    const content = fs.readFileSync(experienceFile, 'utf8');
    assert.ok(content.includes(OPEN_ULID));

    // 检查点标记需重建。
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(root, 'state', 'checkpoint.json'), 'utf8'),
    ) as { needs_rebuild: boolean };
    assert.equal(checkpoint.needs_rebuild, true, '投影失败后应标记需重建');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('全量重建后对账：RawTurn 数 = dialogue 经历数、通道 count 与 channels.json 一致', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const rawLog = new RawLog('dsh', path.join(root, 'raw-turns'));
    rawLog.append({
      event_id: 'raw-1',
      speaker: 'user',
      raw_text: '你好',
      ingested_at: '2026-11-15T12:00:00.000Z',
    });

    await fasti.appendExperience(
      makeExperience({
        id: OPEN_ULID,
        kind: 'dialogue',
        occurred_at: '2026-11-15T12:00:00.000Z',
        recorded_at: '2026-11-15T12:00:00.000Z',
        observation: { text: { id: 'raw-1', channel: 'dsh', shard: '2026-11', seq: 0 } },
      }),
    );

    const result = await fasti.rebuildProjections();

    assert.equal(result.experiences, 1);
    assert.equal(result.reconciliation.rawTurns, 1);
    assert.equal(result.reconciliation.dialogueExperiences, 1);
    assert.equal(result.reconciliation.rawVsDialogueMatch, true, 'RawTurn 数应等于 dialogue 经历数');
    assert.equal(result.reconciliation.channelsMatch, true, '通道 count 应与 channels.json 一致');
    assert.deepEqual(result.reconciliation.perChannel, { dsh: 1 });

    // 阶段 0–2 未实现资产层 → media/asset 显式标注 N/A（用户拍板 Q2）。
    assert.equal(result.reconciliation.mediaVsAsset.applicable, false);
    assert.equal(result.reconciliation.mediaVsAsset.assets, null);
    assert.ok(result.reconciliation.mediaVsAsset.reason.includes('资产层'));
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('重建幂等：重建两次结果一致（投影确定性）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience(
      makeExperience({
        id: OPEN_ULID,
        occurred_at: '2026-11-15T12:00:00.000Z',
        recorded_at: '2026-11-15T12:00:00.000Z',
        pointers: [{ type: 'continues', target: 'target-a' }],
      }),
    );

    const first = await fasti.rebuildProjections();
    const second = await fasti.rebuildProjections();

    assert.equal(first.experiences, second.experiences);
    assert.equal(first.edges, second.edges);
    assert.deepEqual(first.reconciliation.perChannel, second.reconciliation.perChannel);

    const db = new DatabaseSync(path.join(root, 'projection', 'fasti.sqlite'));
    try {
      const edges = db.prepare('SELECT id, src, predicate, dst FROM edge ORDER BY id').all();
      assert.equal(edges.length, 1);
    } finally {
      db.close();
    }
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('L1→L2→L3 降级可手动触发，且每级功能不丢（结果集一致）', async () => {
  const root = makeTempRoot();
  try {
    await seedWithRaw(root, { rawText: '今天下午她在浏览器里读到一篇论文', cue: '关于论文的对话' });

    const queries = ['浏览器', '论文', '对话'];
    const resultsPerLevel: Array<Map<string, string[]>> = [];

    for (const level of ['L1', 'L2', 'L3'] as const) {
      const fasti = await Fasti.open({ dataRoot: root, projectionLevel: level });
      try {
        assert.equal(fasti.level, level, `手动指定档位应生效（${level}）`);
        assert.equal(fasti.isDegraded, level !== 'L1', '降级状态应被标注');

        const collected = new Map<string, string[]>();
        for (const keyword of queries) {
          const hits = await fasti.search(keyword);
          collected.set(
            keyword,
            hits.map((hit) => hit.id).sort(),
          );
        }
        // 多维查询在每级都可用。
        const rows = await fasti.query({ kind: 'dialogue' });
        collected.set('query', rows.map((row) => row.id).sort());
        resultsPerLevel.push(collected);
      } finally {
        await fasti.close();
      }
    }

    const [l1, l2, l3] = resultsPerLevel;
    assert.deepEqual(l2, l1, 'L2 结果集必须与 L1 一致（功能不丢）');
    assert.deepEqual(l3, l1, 'L3 结果集必须与 L1 一致（功能不丢）');

    // 每级都真的命中了。
    for (const keyword of queries) {
      assert.equal((l1 as Map<string, string[]>).get(keyword)?.length, 1, `${keyword} 应在 L1 命中`);
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('降级状态写检查点并在状态接口标注', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root, projectionLevel: 'L2' });
  try {
    assert.equal(fasti.isDegraded, true);
    assert.ok(fasti.degradationReason.length > 0, '降级原因应可读');

    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(root, 'state', 'checkpoint.json'), 'utf8'),
    ) as { engine: string; degraded: boolean; degraded_reason: string };
    assert.equal(checkpoint.engine, 'L2');
    assert.equal(checkpoint.degraded, true);
    assert.ok(checkpoint.degraded_reason.length > 0);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('L2 索引布局含时间索引、通道索引、词法倒排三类', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root, projectionLevel: 'L2' });
  try {
    await fasti.appendExperience(
      makeExperience({
        id: OPEN_ULID,
        occurred_at: '2026-11-15T12:00:00.000Z',
        recorded_at: '2026-11-15T12:00:00.000Z',
        observation: { cue: '关键词 abc' },
      }),
    );

    const indexDir = path.join(root, 'projection', 'l2', 'index');
    for (const name of ['time.jsonl', 'channel.jsonl', 'term.jsonl']) {
      assert.ok(fs.existsSync(path.join(indexDir, name)), `缺少索引文件 ${name}`);
    }
    const terms = fs.readFileSync(path.join(indexDir, 'term.jsonl'), 'utf8');
    assert.ok(terms.includes('abc'), '倒排索引应含词条');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('降级档位解析：非法值抛错，不静默忽略', () => {
  assert.equal(parseLevel(undefined), undefined);
  assert.equal(parseLevel('l1'), 'L1');
  assert.equal(parseLevel('L2'), 'L2');
  assert.equal(parseLevel('jsonl'), 'L2');
  assert.equal(parseLevel('source'), 'L3');
  assert.throws(() => parseLevel('l9'), /未知的投影引擎档位/);
});

test('手动指定 L1 但 sqlite 不可用时抛错（不静默回退）', async () => {
  const root = makeTempRoot();
  try {
    const selection = await selectEngine({
      projectionDir: path.join(root, 'projection'),
      reader: {
        readExperiences: () => [],
        readDocumentText: () => undefined,
        readAllDocuments: () => new Map(),
      },
      force: 'L1',
    });
    assert.equal(selection.level, 'L1');
    assert.equal(selection.degraded, false);
    await selection.engine.close();
  } finally {
    cleanupTempRoot(root);
  }
});
