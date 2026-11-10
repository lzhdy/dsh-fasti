/**
 * 事件投影测试（技术基线 §7.1 / §7.2 · 任务卡 T13）。
 *
 * 覆盖四条硬验收：
 *  1. **三档同语义**：L1(sqlite) / L2(jsonl) / L3(真源直读) 对同一事件集合给出
 *     **完全相同**的结果集（逐字段、逐顺序）；
 *  2. **重建白名单**：experience 投影从 experiences/ 重建；event 投影从 events/ 重建；
 *     `events/` **永不**从 `experiences/` 重建 —— 且重建后她修正过的事件边界仍在；
 *  3. **版本保护**：增量 upsert 时旧版本不得覆盖新版本；
 *  4. **投影只存当前态**：每个 event id 一行 + version 列，历史版本留在 events/ 真源。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Fasti } from '../../src/api/index.ts';
import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { ExperienceLog } from '../../src/source/experience-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { rebuildProjection } from '../../src/projection/rebuild.ts';
import type { RebuildSource } from '../../src/projection/rebuild.ts';
import { SqliteProjection, loadSqlite } from '../../src/projection/sqlite.ts';
import { JsonlProjection } from '../../src/projection/jsonl.ts';
import { SourceScanProjection } from '../../src/projection/source-scan.ts';
import { toEventProjection } from '../../src/projection/event-row.ts';
import type { EventProjection, ProjectionEngine } from '../../src/projection/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const BASE_TIME = '2026-11-08T10:00:00.000Z';
const LATER_TIME = '2026-11-08T12:00:00.000Z';

/** 造一条事件记录。 */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const base: EventRecord = {
    id: 'evt-1',
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'closed',
    pointers: [{ id: 'exp-1', channel: 'dsh', shard: '2026-11', seq: 0 }],
    time_range: { started_at: BASE_TIME, ended_at: BASE_TIME },
    assembled_at: BASE_TIME,
    summary: null,
    key_points: [],
    anchors: [],
    topic_lines: [],
    summary_quality: 'pending',
    summary_source: null,
    summary_prompt_version: null,
    summary_model: null,
    closed_reason: 'silence',
    created_by: 'system',
    created_at: BASE_TIME,
    channel: 'dsh',
    boundary_candidates: [],
    effective_chars: null,
    raw_chars: null,
  };
  return { ...base, ...overrides };
}

/** 一组事件：两个 id、其中一个有历史版本（多版本折叠）。 */
function sampleEvents(): EventRecord[] {
  return [
    makeEvent({ id: 'evt-a', version: 1, channel: 'dsh' }),
    // evt-a 的第 2 版（她修正过摘要）—— 当前态应是这一行。
    makeEvent({
      id: 'evt-a',
      version: 2,
      channel: 'dsh',
      summary: '她在浏览器里读了一篇论文',
      summary_quality: 'ready',
      summary_source: 'llm',
      key_points: ['读了论文'],
      anchors: ['论文'],
      boundary_candidates: [
        { kind: '话题跳转', at_pointer_id: 'exp-1', marked_at: LATER_TIME },
      ],
    }),
    makeEvent({
      id: 'evt-b',
      version: 1,
      channel: 'browser',
      status: 'open',
      closed_reason: null,
      time_range: { started_at: LATER_TIME, ended_at: LATER_TIME },
      assembled_at: LATER_TIME,
      created_at: LATER_TIME,
    }),
  ];
}

/** 造一套事件真源（events/ 目录），返回日志（调用方负责 dispose）。 */
function seedEvents(root: string, events: EventRecord[]): EventLog {
  const log = EventLog.open(layoutOf(root).events);
  for (const event of events) {
    log.appendVersion(event);
  }
  return log;
}

/** 造一个只有 events/ 的重建数据源（experiences 为空）。 */
function eventOnlySource(log: EventLog): RebuildSource {
  return {
    experiences: () => [],
    events: () =>
      log.shards().flatMap((shard) => {
        const rows = fs
          .readFileSync(log.shardFile(shard), 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '');
        return rows.map((line, seq) => ({
          event: JSON.parse(line) as EventRecord,
          location: { shard, seq },
        }));
      }),
    rawTurnCount: () => 0,
    documentText: () => undefined,
    mediaRefCount: () => 0,
    assetCount: () => null,
    registeredChannels: () => [],
  };
}

/** 把投影行拍平成可比对的数组（字段顺序无关，值逐个相等即可）。 */
function plain(rows: EventProjection[]): unknown[] {
  return rows.map((row) => ({ ...row, boundary_candidates: [...row.boundary_candidates] }));
}

// ── 1. 三档同语义 ────────────────────────────────────────────────────────

test('三档引擎对同一事件集合给出完全相同的结果集（L1 = L2 = L3）', async () => {
  const root = makeTempRoot();
  try {
    const log = seedEvents(root, sampleEvents());

    const sqlite = new SqliteProjection(path.join(root, 'projection', 'fasti.sqlite'));
    const jsonl = new JsonlProjection(path.join(root, 'projection', 'l2'));
    const scan = new SourceScanProjection({
      readExperiences: () => [],
      readDocumentText: () => undefined,
      readAllDocuments: () => new Map(),
      readEvents: () => log.readAllVersions(),
    });

    const engines: ProjectionEngine[] = [sqlite, jsonl, scan];
    for (const engine of engines) {
      await engine.open();
    }

    try {
      const source = eventOnlySource(log);
      for (const engine of engines) {
        await rebuildProjection(engine, source);
      }

      // 全量：逐字段相同。
      assert.deepEqual(plain(await jsonl.allEvents()), plain(await sqlite.allEvents()));
      assert.deepEqual(plain(await scan.allEvents()), plain(await sqlite.allEvents()));

      // 逐个过滤条件：结果集与顺序都相同。
      const queries = [
        {},
        { status: 'closed' },
        { status: 'open' },
        { channel: 'dsh' },
        { channel: 'browser' },
        { from_ms: Date.parse(LATER_TIME) },
        { to_ms: Date.parse(BASE_TIME) },
        { from_ms: Date.parse(BASE_TIME), to_ms: Date.parse(LATER_TIME) },
        { status: 'closed', channel: 'dsh' },
      ];
      for (const query of queries) {
        const l1 = await sqlite.queryEvents(query);
        assert.deepEqual(
          plain(await jsonl.queryEvents(query)),
          plain(l1),
          `L2 与 L1 不一致：${JSON.stringify(query)}`,
        );
        assert.deepEqual(
          plain(await scan.queryEvents(query)),
          plain(l1),
          `L3 与 L1 不一致：${JSON.stringify(query)}`,
        );
      }

      // 确认语料确实能命中（避免「全都不匹配」造成的假阳性一致）。
      assert.equal((await sqlite.queryEvents({ channel: 'browser' })).length, 1);
      assert.equal((await sqlite.queryEvents({ channel: 'dsh' })).length, 1);
    } finally {
      for (const engine of engines) {
        await engine.close();
      }
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('三档投影对「同一事件多版本」的折叠结果一致（当前态 = 最大 version）', async () => {
  const root = makeTempRoot();
  try {
    const log = seedEvents(root, sampleEvents());

    const sqlite = new SqliteProjection(path.join(root, 'projection', 'fasti.sqlite'));
    const jsonl = new JsonlProjection(path.join(root, 'projection', 'l2'));
    const scan = new SourceScanProjection({
      readExperiences: () => [],
      readDocumentText: () => undefined,
      readAllDocuments: () => new Map(),
      readEvents: () => log.readAllVersions(),
    });

    const engines: ProjectionEngine[] = [sqlite, jsonl, scan];
    for (const engine of engines) {
      await engine.open();
    }

    try {
      const source = eventOnlySource(log);
      for (const engine of engines) {
        await rebuildProjection(engine, source);
      }

      for (const engine of engines) {
        const rows = await engine.allEvents();
        assert.equal(rows.length, 2, `${engine.level}：每个 event id 只留一行当前态`);
        const evtA = rows.find((row) => row.id === 'evt-a');
        assert.equal(evtA?.version, 2, `${engine.level}：当前态应是最大 version`);
        assert.equal(evtA?.summary, '她在浏览器里读了一篇论文');
        assert.deepEqual(evtA?.key_points, ['读了论文']);
      }
    } finally {
      for (const engine of engines) {
        await engine.close();
      }
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('L1/L2 增量 upsert 遵守版本保护：旧版本不得覆盖新版本', async () => {
  const root = makeTempRoot();
  try {
    const sqlite = new SqliteProjection(path.join(root, 'projection', 'fasti.sqlite'));
    const jsonl = new JsonlProjection(path.join(root, 'projection', 'l2'));

    for (const engine of [sqlite, jsonl]) {
      await engine.open();
    }

    try {
      const newer = toEventProjection(
        makeEvent({ id: 'evt-v', version: 3, summary: '新版本摘要', summary_quality: 'ready' }),
      );
      const older = toEventProjection(
        makeEvent({ id: 'evt-v', version: 1, summary: '旧版本摘要', summary_quality: 'ready' }),
      );

      for (const engine of [sqlite, jsonl]) {
        await engine.upsertEvent(newer);
        await engine.upsertEvent(older);

        const rows = await engine.allEvents();
        assert.equal(rows.length, 1, `${engine.level}：仍是同一 id 的一行`);
        assert.equal(rows[0]?.version, 3, `${engine.level}：旧版本不得覆盖新版本`);
        assert.equal(rows[0]?.summary, '新版本摘要', `${engine.level}：应保留新版本内容`);
      }
    } finally {
      await sqlite.close();
      await jsonl.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('L2 的 event.jsonl 落在 projection/l2 下，clear() 一并清掉', async () => {
  const root = makeTempRoot();
  try {
    const dir = path.join(root, 'projection', 'l2');
    const jsonl = new JsonlProjection(dir);
    await jsonl.open();

    await jsonl.upsertEvent(toEventProjection(makeEvent()));
    const file = path.join(dir, 'event.jsonl');
    assert.ok(fs.existsSync(file), '事件投影文件应落在 projection/l2/event.jsonl');

    await jsonl.clear();
    assert.equal(fs.readFileSync(file, 'utf8'), '', 'clear() 必须一并清 event.jsonl');
    assert.equal((await jsonl.allEvents()).length, 0);

    await jsonl.close();
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 2. 重建白名单 ────────────────────────────────────────────────────────

test('重建白名单：experiences/ 有数据、events/ 为空 → 重建后事件投影为 0 条', async () => {
  const root = makeTempRoot();
  try {
    // 造一条经历（走门面摄入，真源 experiences/ 有数据）。
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await fasti.appendExperience({
        id: '01J0000000000000000000000A',
        schema_version: 1,
        kind: 'dialogue',
        scene: { channel: 'dsh', ref: 's-1' },
        initiation: 'user',
        observation: { cue: '测试线索' },
        occurred_at: '2026-11-15T12:00:00.000Z',
      });
    } finally {
      await fasti.close();
    }

    // events/ 为空（没有事件）。
    const engine = new SqliteProjection(path.join(root, 'projection', 'fasti.sqlite'));
    await engine.open();
    try {
      const outcome = await rebuildProjection(engine, {
        experiences: () => [
          {
            experience: {
              id: '01J0000000000000000000000A',
              schema_version: 1,
              kind: 'dialogue',
              scene: { channel: 'dsh', ref: 's-1' },
              initiation: 'user',
              observation: { cue: '测试线索' },
              occurred_at: '2026-11-15T12:00:00.000Z',
              recorded_at: '2026-11-15T12:00:00.000Z',
              tick: 0,
              char_count: null,
            },
            location: { shard: '2026-11', seq: 0 },
          },
        ],
        events: () => [],
        rawTurnCount: () => 1,
        documentText: () => undefined,
        mediaRefCount: () => 0,
        assetCount: () => null,
        registeredChannels: () => ['dsh'],
      });

      assert.equal(outcome.events, 0, 'events/ 为空 → 事件投影 0 条');
      assert.equal((await engine.allEvents()).length, 0);
    } finally {
      await engine.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('重建白名单：experiences/ 为空、events/ 有数据 → 重建后事件数 = events/ 当前态数', async () => {
  const root = makeTempRoot();
  try {
    const log = seedEvents(root, sampleEvents());
    const engine = new SqliteProjection(path.join(root, 'projection', 'fasti.sqlite'));
    await engine.open();
    try {
      const outcome = await rebuildProjection(engine, eventOnlySource(log));
      assert.equal(outcome.events, 2, '两个 id → 两行当前态');
      assert.equal((await engine.allEvents()).length, 2);
    } finally {
      await engine.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('重建白名单：重建前后 events/ 真源目录逐字节不变', async () => {
  const root = makeTempRoot();
  try {
    seedEvents(root, sampleEvents());
    const eventsDir = layoutOf(root).events;

    const before = fs
      .readdirSync(eventsDir)
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(eventsDir, name), 'utf8')] as const);

    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await fasti.rebuildProjections();
    } finally {
      await fasti.close();
    }

    const after = fs
      .readdirSync(eventsDir)
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(eventsDir, name), 'utf8')] as const);

    assert.deepEqual(after, before, '重建只读真源，不得改写 events/ 目录');
  } finally {
    cleanupTempRoot(root);
  }
});

test('重建白名单：重建后她修正过的事件边界仍在（当前态 = 她的修正版本）', async () => {
  const root = makeTempRoot();
  try {
    // 造一条事件：v1 是原始边界，v2 是她修正过的边界（换了指针集合）。
    const log = EventLog.open(layoutOf(root).events);
    log.appendVersion(
      makeEvent({
        id: 'evt-fix',
        version: 1,
        pointers: [{ id: 'exp-1', channel: 'dsh' }],
      }),
    );
    log.appendVersion(
      makeEvent({
        id: 'evt-fix',
        version: 2,
        pointers: [
          { id: 'exp-1', channel: 'dsh' },
          { id: 'exp-2', channel: 'dsh' },
        ],
      }),
    );

    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await fasti.rebuildProjections();

      const current = await fasti.getEvent('evt-fix');
      assert.equal(current.version, 2, '重建后当前态仍是她的修正版本');
      assert.deepEqual(
        current.pointers.map((pointer) => pointer.id),
        ['exp-1', 'exp-2'],
        '她修正过的边界原样还在',
      );

      // 投影也反映修正后的当前态（指针数 = 2）。
      const rows = await fasti.projectionEngine.allEvents();
      const projected = rows.find((row) => row.id === 'evt-fix');
      assert.equal(projected?.version, 2);
      assert.equal(projected?.pointer_count, 2);
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('重建白名单：events/ 永不从 experiences/ 重建（只改 experiences 不产生新事件）', async () => {
  const root = makeTempRoot();
  try {
    // 直接往 experiences/ 真源写经历（**绕开门面** → 绕开切分器，
    // 故不会产生任何事件）。这才是「只有记录本、没有事件」的干净场景。
    const experiences = new ExperienceLog(layoutOf(root).experiences);
    experiences.append({
      id: '01J0000000000000000000000A',
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 's-1' },
      initiation: 'user',
      observation: { cue: '只有记录本' },
      occurred_at: '2026-11-15T12:00:00.000Z',
      recorded_at: '2026-11-15T12:00:00.000Z',
      tick: 0,
      char_count: null,
    });

    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await fasti.rebuildProjections();
      assert.equal(
        (await fasti.queryEvents()).length,
        0,
        '记录本有数据、事件真源为空 → 重建后仍是 0 条事件',
      );

      // 再造一条事件（事件真源有数据）→ 重建后只应有这 1 条。
      const log = EventLog.open(layoutOf(root).events);
      log.appendVersion(makeEvent({ id: 'evt-only' }));
      log.dispose();

      await fasti.rebuildProjections();
      const after = await fasti.queryEvents();
      assert.equal(after.length, 1, '事件数只由 events/ 决定');
      assert.deepEqual(
        after.map((event) => event.id),
        ['evt-only'],
      );
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 3. 门面层的重建白名单 ────────────────────────────────────────────────

test('门面重建后事件仍在（rebuildProjections 不清掉事件真源）', async () => {
  const root = makeTempRoot();
  try {
    const log = EventLog.open(layoutOf(root).events);
    log.appendVersion(makeEvent({ id: 'evt-keep' }));

    const fasti = await Fasti.open({ dataRoot: root });
    try {
      const before = await fasti.queryEvents();
      assert.equal(before.length, 1);

      await fasti.rebuildProjections();

      const after = await fasti.queryEvents();
      assert.equal(after.length, 1, '重建后事件仍在');
      assert.equal(after[0]?.id, 'evt-keep');
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 5. 溯源两字段：三档列往返一致（设计稿 v1.1 §3.2）────────────────────

test('溯源两字段：三档列往返一致（含 null 与有值两种情形）', async () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(layoutOf(root).events);
    // 一条有溯源信息（模型写的摘要），一条没有（她手写 / 未生成）。
    log.appendVersion(
      makeEvent({
        id: 'evt-llm',
        summary: '模型写的摘要',
        summary_quality: 'ready',
        summary_source: 'llm',
        summary_prompt_version: 'v1',
        summary_model: 'dsh-pro',
      }),
    );
    log.appendVersion(
      makeEvent({
        id: 'evt-her',
        summary: '她写的摘要',
        summary_quality: 'ready',
        summary_source: 'her',
        summary_prompt_version: null,
        summary_model: null,
      }),
    );

    const engines: ProjectionEngine[] = [
      new SqliteProjection(path.join(root, 'proj-l1', 'proj.db')),
      new JsonlProjection(path.join(root, 'proj-l2')),
      // L3 = 真源直读：给它一个读真源的 reader（与生产同一形状）。
      new SourceScanProjection({
        readExperiences: () => [],
        readDocumentText: () => undefined,
        readAllDocuments: () => new Map(),
        readEvents: () => log.readAllVersions(),
      }),
    ];

    const results: EventProjection[][] = [];
    for (const engine of engines) {
      await engine.open();
      try {
        for (const event of log.readAll()) {
          await engine.upsertEvent(toEventProjection(event));
        }
        results.push(await engine.allEvents());
      } finally {
        await engine.close();
      }
    }

    const [l1, l2, l3] = results;
    assert.ok(l1 !== undefined && l2 !== undefined && l3 !== undefined);
    assert.deepEqual(plain(l1), plain(l2), 'L1 与 L2 必须逐字段一致');
    assert.deepEqual(plain(l2), plain(l3), 'L2 与 L3 必须逐字段一致');

    const llmRow = l1.find((row) => row.id === 'evt-llm');
    assert.equal(llmRow?.summary_prompt_version, 'v1', '有值的三档都要读得回来');
    assert.equal(llmRow?.summary_model, 'dsh-pro');

    const herRow = l1.find((row) => row.id === 'evt-her');
    assert.equal(herRow?.summary_prompt_version, null, 'null 不能被读成空串或 undefined');
    assert.equal(herRow?.summary_model, null);
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 6. L1 老库迁移：新增可空列必须能自动补上 ─────────────────────────────

test('L1 迁移：老库缺 summary_prompt_version / summary_model → 打开时自动补列，老行读成 null', async () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'old', 'proj.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // 造一个「上一版」的 event 表：没有两个溯源列，且已有一行数据。
    const { DatabaseSync } = await loadSqlite();
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE event(
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, channel TEXT NOT NULL,
      started_ms INTEGER NOT NULL, ended_ms INTEGER NOT NULL, assembled_ms INTEGER NOT NULL,
      summary TEXT, summary_quality TEXT NOT NULL, summary_source TEXT,
      key_points TEXT, anchors TEXT, topic_lines TEXT, boundary_candidates TEXT,
      pointer_count INTEGER NOT NULL, merged_into TEXT, split_into TEXT,
      created_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL);`);
    old
      .prepare(
        `INSERT INTO event(id, version, status, channel, started_ms, ended_ms, assembled_ms,
           summary, summary_quality, summary_source, key_points, anchors, topic_lines,
           boundary_candidates, pointer_count, merged_into, split_into, created_by, created_at_ms)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'evt-old',
        1,
        'closed',
        'dsh',
        Date.parse(BASE_TIME),
        Date.parse(BASE_TIME),
        Date.parse(BASE_TIME),
        '老摘要',
        'ready',
        'llm',
        '[]',
        '[]',
        '[]',
        '[]',
        1,
        null,
        '[]',
        'system',
        Date.parse(BASE_TIME),
      );
    old.close();

    const engine = new SqliteProjection(file);
    await engine.open();
    try {
      const rows = await engine.allEvents();
      assert.equal(rows.length, 1, '老行还在（迁移是纯加法，不重建）');
      assert.equal(rows[0]?.summary, '老摘要');
      assert.equal(rows[0]?.summary_prompt_version, null, '新列对老行就是「不知道」');
      assert.equal(rows[0]?.summary_model, null);

      // 新列可写：不补列的话这条 upsert 会直接抛错（缺列）。
      await engine.upsertEvent(
        toEventProjection(
          makeEvent({ id: 'evt-new', summary_prompt_version: 'v1', summary_model: 'dsh-pro' }),
        ),
      );
      const written = (await engine.allEvents()).find((row) => row.id === 'evt-new');
      assert.equal(written?.summary_prompt_version, 'v1');
      assert.equal(written?.summary_model, 'dsh-pro');
    } finally {
      await engine.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 7. v1.4 双计数器：投影两列往返与老库补列（定案稿 §16.1 / A8）──────────

test('双计数器：三档列往返一致（含 null 与有值两种情形）', async () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(layoutOf(root).events);
    // 一条已统计（有效对话 700 字 / raw 13477 字），一条未统计（旧数据 → null）。
    log.appendVersion(
      makeEvent({ id: 'evt-counted', effective_chars: 700, raw_chars: 13477 }),
    );
    log.appendVersion(makeEvent({ id: 'evt-uncounted', effective_chars: null, raw_chars: null }));

    const engines: ProjectionEngine[] = [
      new SqliteProjection(path.join(root, 'proj-l1', 'proj.db')),
      new JsonlProjection(path.join(root, 'proj-l2')),
      new SourceScanProjection({
        readExperiences: () => [],
        readDocumentText: () => undefined,
        readAllDocuments: () => new Map(),
        readEvents: () => log.readAllVersions(),
      }),
    ];

    const results: EventProjection[][] = [];
    for (const engine of engines) {
      await engine.open();
      try {
        for (const event of log.readAll()) {
          await engine.upsertEvent(toEventProjection(event));
        }
        results.push(await engine.allEvents());
      } finally {
        await engine.close();
      }
    }

    const [l1, l2, l3] = results;
    assert.ok(l1 !== undefined && l2 !== undefined && l3 !== undefined);
    assert.deepEqual(plain(l1), plain(l2), 'L1 与 L2 必须逐字段一致');
    assert.deepEqual(plain(l2), plain(l3), 'L2 与 L3 必须逐字段一致');

    const counted = l1.find((row) => row.id === 'evt-counted');
    assert.equal(counted?.effective_chars, 700, '已统计的有效对话字数要能读回来');
    assert.equal(counted?.raw_chars, 13477);

    const uncounted = l1.find((row) => row.id === 'evt-uncounted');
    assert.equal(uncounted?.effective_chars, null, 'null 不能被读成 0 或 undefined');
    assert.equal(uncounted?.raw_chars, null);
  } finally {
    cleanupTempRoot(root);
  }
});

test('双计数器：L1 老库缺两列 → 打开时自动补列，老行读成 null，新行可写', async () => {
  const root = makeTempRoot();
  try {
    const file = path.join(root, 'old', 'proj.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // 造一个「上一版」的 event 表：没有两个计数器列，且已有一行数据。
    const { DatabaseSync } = await loadSqlite();
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE event(
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, channel TEXT NOT NULL,
      started_ms INTEGER NOT NULL, ended_ms INTEGER NOT NULL, assembled_ms INTEGER NOT NULL,
      summary TEXT, summary_quality TEXT NOT NULL, summary_source TEXT,
      summary_prompt_version TEXT, summary_model TEXT,
      key_points TEXT, anchors TEXT, topic_lines TEXT, boundary_candidates TEXT,
      pointer_count INTEGER NOT NULL, merged_into TEXT, split_into TEXT,
      created_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL);`);
    old
      .prepare(
        `INSERT INTO event(id, version, status, channel, started_ms, ended_ms, assembled_ms,
           summary, summary_quality, summary_source, summary_prompt_version, summary_model,
           key_points, anchors, topic_lines, boundary_candidates,
           pointer_count, merged_into, split_into, created_by, created_at_ms)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'evt-old',
        1,
        'closed',
        'dsh',
        Date.parse(BASE_TIME),
        Date.parse(BASE_TIME),
        Date.parse(BASE_TIME),
        '老摘要',
        'ready',
        'llm',
        'v1',
        'dsh-pro',
        '[]',
        '[]',
        '[]',
        '[]',
        1,
        null,
        '[]',
        'system',
        Date.parse(BASE_TIME),
      );
    old.close();

    const engine = new SqliteProjection(file);
    await engine.open();
    try {
      const rows = await engine.allEvents();
      assert.equal(rows.length, 1, '老行还在（迁移是纯加法，不重建）');
      assert.equal(rows[0]?.effective_chars, null, '新列对老行就是「不知道」');
      assert.equal(rows[0]?.raw_chars, null);

      // 新列可写：不补列的话这条 upsert 会直接抛错（缺列）。
      await engine.upsertEvent(
        toEventProjection(makeEvent({ id: 'evt-new', effective_chars: 5170, raw_chars: 13477 })),
      );
      const written = (await engine.allEvents()).find((row) => row.id === 'evt-new');
      assert.equal(written?.effective_chars, 5170);
      assert.equal(written?.raw_chars, 13477);
    } finally {
      await engine.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});
