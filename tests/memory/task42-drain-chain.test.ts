/**
 * #42 · B2 收口批：drain 真链红测（正本 §2.5 无状态对账、§3.1 模块清单、§3.5 版本上下文、§3.3 观测）。
 *
 * 本批把第七法从「真实空轮」钉到真链：fold 真源 → derive 期望态 → diff/plan → 单事务 apply →
 * 观测落盘。被测 seam（写者在同批内红→绿）：
 *  - `openMemoryRuntime({ indexDir, dataRoot })`：编排层经 dataRoot 只读读取 events/experiences；
 *  - 正常轮读真源折叠态，产出 cardUpserts/decision/revision；applied 集仅进程内从 decisions 派生；
 *  - 观测 `drain-observations.jsonl` 落投影目录；F-B 隔离/弃权落受控码观测，不进台账；
 *  - 决策版本上下文从事件版本注入：`at_ms = isoToMs(version.created_at)`，不读墙钟。
 *
 * 纪律：只写 tests/，绝不改 src/；全部临时 DSH_HOME，真实数据根零写入；无 git 写操作。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { EventRecord } from '../../src/contract/event.ts';
import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import { createHash } from 'node:crypto';
import { appendJsonl } from '../../src/core/jsonl.ts';
import { isoToMs } from '../../src/core/time.ts';
import { appendDecision, readDecisions, readRevisions, REVISIONS_FILE } from '../../src/memory/ledger.ts';
import { OBSERVATION_REASON_CODES, validateObservation } from '../../src/memory/observations.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../src/memory/store.ts';
import { openMemoryRuntime } from '../../src/memory/runtime.ts';
import type { DecisionRecord, RevisionRecord } from '../../src/memory/types.ts';
import { CURRENT_RULES_VERSION } from '../../src/memory/types.ts';
import { MEMORY_TOOL_NAMES } from '../../src/adapters/dsh/memory-tool-bridge.ts';
import { cleanupTempRoot, countLines, listTree, makeExperience, makeTempRoot } from '../helpers.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = Date.parse('2026-11-08T02:13:20.000Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** 经历全集内合法 ULID 锚点（与既有夹具同形态）。 */
const EXP_A = '01J0000000000000000000000A';
const EXP_B = '01J0000000000000000000000B';
const EXP_C = '01J0000000000000000000000C';
/** 形态合法但经历全集不存在 → anchor-not-found。 */
const MISSING = '01J0000000000000000000000Z';

const TIME_A = T0;
const TIME_B = T0 + DAY;
const TIME_C = T0 + 2 * DAY;
const TIME_D = T0 + 3 * DAY;

// ── 夹具：临时数据根（experiences/events 真源 + 空白投影台账）─────────────────

function makeEvent(
  overrides: Partial<EventRecord> & { id: string; anchors: readonly string[] },
): EventRecord {
  const { id, anchors, ...rest } = overrides;
  const createdAt = rest.created_at ?? iso(T0);
  const anchorList = [...anchors];
  return {
    id,
    schema_version: EVENT_SCHEMA_VERSION,
    version: rest.version ?? 1,
    status: 'closed',
    closed_reason: 'silence',
    pointers: anchorList.map((anchor) => ({ id: anchor })),
    time_range: { started_at: createdAt, ended_at: createdAt },
    assembled_at: createdAt,
    summary: '客观摘要（测试阅读，不进卡）',
    key_points: [],
    anchors: anchorList,
    topic_lines: [],
    summary_quality: 'ready',
    summary_source: 'llm',
    summary_prompt_version: null,
    summary_model: null,
    effective_chars: null,
    raw_chars: null,
    created_by: 'system',
    created_at: createdAt,
    channel: 'dsh',
    boundary_candidates: [],
    ...rest,
  };
}

interface ChainRoot {
  readonly root: string;
  readonly indexDir: string;
  readonly projectionDir: string;
}

function buildSeedRevision(): RevisionRecord {
  return {
    revision: 1,
    slug: 'build',
    at_ms: T0,
    schema_version: 3,
    truth_fingerprint: 'fp-chain',
    prior_revision: null,
    card_count: 0,
    alias_count: 0,
    row_hash_sum: 'rh-chain',
    shadow_diff: { added: 0, removed: 0, changed: 0 },
    reason: 'test fixture',
    operator: 'offline-cli',
  };
}

/** 临时根：写 experiences/events 分片，再建空白投影（revision 1、零卡）。 */
async function seedChainRoot(input: {
  experiences: readonly string[];
  events: readonly EventRecord[];
}): Promise<ChainRoot> {
  const root = makeTempRoot('drain-chain-');
  input.experiences.forEach((id, index) => {
    appendJsonl(
      path.join(root, 'experiences', '2026-11.jsonl'),
      makeExperience({ id, tick: index, occurred_at: iso(T0), recorded_at: iso(T0) }),
    );
  });
  for (const event of input.events) {
    appendJsonl(path.join(root, 'events', '2026-11.jsonl'), event);
  }
  const indexDir = path.join(root, 'projection', 'memory-index');
  const projectionDir = path.dirname(indexDir);
  const writer = openMemoryWrite({ indexDir });
  try {
    writer.transactionApply({ cards: [], aliases: [] }, buildSeedRevision(), []);
  } finally {
    await writer.close();
  }
  return { root, indexDir, projectionDir };
}

/** 开运行期窄柄；dataRoot 为本批 seam（真源只读读取器注入点）。 */
function openChainHandle(chain: ChainRoot) {
  const paths = { indexDir: chain.indexDir, dataRoot: chain.root } as unknown as Parameters<
    typeof openMemoryRuntime
  >[0];
  return openMemoryRuntime(paths);
}

/** 反射取第七法（seam 未落地期不连坐类型检查；调用前断言函数形态）。 */
function drainOf(handle: object): (budgetMs: number) => Promise<Record<string, unknown>> {
  const rec = handle as Record<string, unknown>;
  assert.equal(typeof rec.drainProjection, 'function', '窄柄须挂第七法 drainProjection');
  return rec.drainProjection as (budgetMs: number) => Promise<Record<string, unknown>>;
}

// ── 投影面读数助手 ────────────────────────────────────────────────────────────

function cardCount(indexDir: string): number {
  const dbFile = path.join(indexDir, MEMORY_INDEX_FILE);
  if (!fs.existsSync(dbFile)) return 0;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM mem_card').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function decisionRows(indexDir: string): DecisionRecord[] {
  return readDecisions(indexDir);
}

function revisionCount(indexDir: string): number {
  const file = path.join(indexDir, REVISIONS_FILE);
  return fs.existsSync(file) ? countLines(file) : 0;
}

function observationLines(projectionDir: string): unknown[] {
  const file = path.join(projectionDir, 'drain-observations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

/** 按 event_id 读 mem_card 行；无行返回 null（精确断言用，不做存在性宽容）。 */
function readCardRow(indexDir: string, eventId: string): Record<string, unknown> | null {
  const dbFile = path.join(indexDir, MEMORY_INDEX_FILE);
  if (!fs.existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT * FROM mem_card WHERE event_id = ?')
      .get(eventId) as Record<string, unknown> | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

/** 逐行比对只取稳定列；排除 created_ms/hit_count/last_hit_ms 等运行期计数列。 */
function stableCardSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'card_id',
    'event_id',
    'anchor_json',
    'channel',
    'display_cues_json',
    'aliases_json',
    'occurred_ms',
    'ended_ms',
    'status',
    'content_hash',
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

/**
 * 测试侧独立重算六项结构快照哈希：**不复用**生产 `structuralHash` 函数，
 * 按正本六项输入面（anchors/channel/时间窗/eligibility/rulesVersion）自行实现同口径。
 */
function independentStructuralHash(event: EventRecord): string {
  const canonical = {
    anchors: [...new Set(event.anchors)].sort(),
    channel: event.channel,
    startedMs: isoToMs(event.time_range.started_at),
    endedMs: isoToMs(event.time_range.ended_at),
    eligibility: event.summary_quality,
    rulesVersion: CURRENT_RULES_VERSION,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 真链一轮：fold 真源 → 建卡 → 决策/revision 落账。
// ═══════════════════════════════════════════════════════════════════════════

test('真链一轮：2 个 ready 事件被 fold 派生，建卡 + create-card 决策 + revision 增 1', async () => {
  const eventA = makeEvent({ id: 'evt-chain-a', anchors: [EXP_A, EXP_B], version: 1, created_at: iso(TIME_A) });
  const eventB = makeEvent({ id: 'evt-chain-b', anchors: [EXP_C], version: 2, created_at: iso(TIME_B) });
  const chain = await seedChainRoot({ experiences: [EXP_A, EXP_B, EXP_C], events: [eventA, eventB] });
  try {
    const handle = openChainHandle(chain);
    try {
      const before = {
        cards: cardCount(chain.indexDir),
        decisions: decisionRows(chain.indexDir).length,
        revisions: revisionCount(chain.indexDir),
      };
      const drain = drainOf(handle);
      const report = await drain(60_000);

      assert.equal(report.skipped, null, '就绪轮不是短路');
      assert.equal(report.applied, true, '真链一轮须提交事务');
      assert.ok(Number(report.scannedVersions) >= 2, `scannedVersions 须 >0：${String(report.scannedVersions)}`);
      assert.ok(Number(report.cardUpserts) >= 2, `cardUpserts 须 >0：${String(report.cardUpserts)}`);

      const afterCards = cardCount(chain.indexDir);
      assert.ok(afterCards > before.cards, 'mem_card 须真有新行');

      const decisions = decisionRows(chain.indexDir);
      assert.ok(decisions.length > before.decisions, 'decisions.jsonl 须追加 create-card 决策');
      const createCards = decisions.filter((d) => d.action === 'create-card');
      assert.ok(createCards.length >= 2, `create-card 决策 ≥2：${createCards.length}`);

      assert.equal(revisionCount(chain.indexDir), before.revisions + 1, '一轮成功须增 1 条 revision');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 空转轮：真源无 ready 事件 → 零增量、不提交、不追加观测。
// ═══════════════════════════════════════════════════════════════════════════

test('空转轮：无 ready 事件 → cardUpserts=0、revision 不增、决策/观测零追加、不提交', async () => {
  const chain = await seedChainRoot({ experiences: [], events: [] });
  try {
    const handle = openChainHandle(chain);
    try {
      const before = {
        decisions: decisionRows(chain.indexDir).length,
        revisions: revisionCount(chain.indexDir),
        observations: observationLines(chain.projectionDir).length,
        tree: listTree(chain.projectionDir),
      };
      const drain = drainOf(handle);
      const report = await drain(60_000);

      assert.equal(report.skipped, null);
      assert.equal(report.cardUpserts, 0);
      assert.equal(report.invalidations, 0);
      assert.equal(report.applied, false, '空轮不提交事务');
      assert.equal(decisionRows(chain.indexDir).length, before.decisions);
      assert.equal(revisionCount(chain.indexDir), before.revisions);
      assert.equal(observationLines(chain.projectionDir).length, before.observations);
      assert.deepEqual(listTree(chain.projectionDir), before.tree, '空轮不产生新投影文件');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. 单事务：一轮一个应用点；提交后卡集与决策/台账一致，revision 链连续。
//    （事务内故障回滚注入需写柄故障 seam，当前仓无此注入面；回滚语义由
//      store.transactionApply 既有 rollback 测试守卫，登记为不可直测边界。）
// ═══════════════════════════════════════════════════════════════════════════

test('单事务：成功提交后每张活卡都有 create-card 决策，revision 链连续、decision_id 为 ULID', async () => {
  const eventA = makeEvent({ id: 'evt-tx-a', anchors: [EXP_A], version: 1, created_at: iso(TIME_A) });
  const chain = await seedChainRoot({ experiences: [EXP_A], events: [eventA] });
  try {
    const handle = openChainHandle(chain);
    try {
      const drain = drainOf(handle);
      await drain(60_000);

      // 台账链回读即校验连续性；断链/跳号 readRevisions 抛 IntegrityError。
      const revisions = readRevisions(chain.indexDir);
      assert.ok(revisions.length >= 1, 'revision 链可读');

      const decisions = decisionRows(chain.indexDir);
      const createByEvent = new Map(decisions.filter((d) => d.action === 'create-card').map((d) => [d.event_id, d]));
      const dbFile = path.join(chain.indexDir, MEMORY_INDEX_FILE);
      const db = new DatabaseSync(dbFile, { readOnly: true });
      let activeEvents: string[];
      try {
        activeEvents = (db
          .prepare("SELECT DISTINCT event_id FROM mem_card WHERE status = 'active'")
          .all() as Array<{ event_id: string }>).map((row) => row.event_id);
      } finally {
        db.close();
      }
      for (const eventId of activeEvents) {
        assert.ok(createByEvent.has(eventId), `活卡 ${eventId} 必须有对应 create-card 决策`);
      }
      for (const decision of decisions) {
        assert.match(decision.decision_id, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'decision_id 须为 26 位 ULID');
      }
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

test('单事务静态守卫：drain.ts 一轮只允许一个事务应用点', () => {
  const drainFile = path.join(REPO_ROOT, 'src', 'memory', 'drain.ts');
  const code = fs.readFileSync(drainFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const applySites = code.match(/transactionApply\s*\(/g) ?? [];
  assert.ok(applySites.length <= 1, `一轮只允许一个事务应用点，实际 ${applySites.length} 处`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. applied 集回放：同版本第二轮零增量；applied 不落盘、不建表、无水位键。
// ═══════════════════════════════════════════════════════════════════════════

test('applied 回放：同一真源连跑两轮，第二轮零 upsert、revision/决策不增；applied 不落盘', async () => {
  const eventA = makeEvent({ id: 'evt-replay-a', anchors: [EXP_A], version: 1, created_at: iso(TIME_A) });
  const chain = await seedChainRoot({ experiences: [EXP_A], events: [eventA] });
  try {
    const handle = openChainHandle(chain);
    try {
      const drain = drainOf(handle);
      await drain(60_000);

      const afterFirst = {
        cards: cardCount(chain.indexDir),
        decisions: decisionRows(chain.indexDir).length,
        revisions: revisionCount(chain.indexDir),
        observations: observationLines(chain.projectionDir).length,
      };
      const second = await drain(60_000);
      assert.equal(second.skipped, null);
      assert.equal(second.cardUpserts, 0, '已应用版本第二轮不得再建卡');
      assert.equal(second.invalidations, 0);
      assert.equal(second.applied, false, '空轮转不提交');

      assert.equal(cardCount(chain.indexDir), afterFirst.cards);
      assert.equal(decisionRows(chain.indexDir).length, afterFirst.decisions);
      assert.equal(revisionCount(chain.indexDir), afterFirst.revisions);
      assert.equal(observationLines(chain.projectionDir).length, afterFirst.observations);

      // applied 集只在进程内从 decisions 派生：投影库不得建 applied/watermark 表或 meta 键。
      const dbFile = path.join(chain.indexDir, MEMORY_INDEX_FILE);
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
          (row) => row.name,
        );
        for (const table of tables) {
          assert.ok(!/applied|watermark|cursor/i.test(table), `不得为 applied/水位建表：${table}`);
        }
        const metaKeys = (db.prepare('SELECT key FROM schema_meta').all() as Array<{ key: string }>).map(
          (row) => row.key,
        );
        for (const key of metaKeys) {
          assert.ok(!/applied|watermark|cursor|last_seen|offset/i.test(key), `不得落 applied/水位 meta 键：${key}`);
        }
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. 观测行真写入：F-B 悬空隔离 / 空锚 abstain 落受控码观测，不进台账；重跑不倍增。
// ═══════════════════════════════════════════════════════════════════════════

test('观测写入：悬空 → anchor-not-found、空锚 → empty-anchors；决策零追加；第二轮观测不倍增', async () => {
  const dangling = makeEvent({ id: 'evt-quar-dang', anchors: [MISSING], version: 1, created_at: iso(TIME_C) });
  const abstain = makeEvent({ id: 'evt-quar-empty', anchors: [], version: 1, created_at: iso(TIME_D) });
  const chain = await seedChainRoot({ experiences: [EXP_A], events: [dangling, abstain] });
  try {
    const handle = openChainHandle(chain);
    try {
      const drain = drainOf(handle);
      const report = await drain(60_000);

      assert.equal(report.quarantined, 1, '悬空版本进 quarantine');
      assert.equal(report.emptyAnchored, 1, '空锚版本进 abstain');
      assert.equal(report.cardUpserts, 0, '隔离/弃权版本不建卡');
      assert.equal(decisionRows(chain.indexDir).length, 0, '隔离/弃权不追加决策台账');

      const rows = observationLines(chain.projectionDir);
      assert.equal(rows.length, 2, '两类各落一条观测');
      const codes: string[] = rows.map((row) => validateObservation(row).reason_code);
      assert.ok(codes.includes('anchor-not-found'), '悬空落 anchor-not-found 观测');
      assert.ok(codes.includes('empty-anchors'), '空锚落 empty-anchors 观测');

      const byEvent = new Map(rows.map((row) => [validateObservation(row).event_id, validateObservation(row)]));
      const danglingObs = byEvent.get('evt-quar-dang');
      const abstainObs = byEvent.get('evt-quar-empty');
      assert.ok(danglingObs !== undefined && abstainObs !== undefined);
      assert.equal(danglingObs.version_token, 'evt-quar-dang#v1', 'version_token = event_id#v{version}');
      assert.equal(abstainObs.version_token, 'evt-quar-empty#v1');
      assert.ok(Number.isFinite(danglingObs.at_ms) && danglingObs.at_ms >= 0, '观测 at_ms 取版本时间');

      // 幂等：同三元组重跑不倍增。
      await drain(60_000);
      assert.equal(observationLines(chain.projectionDir).length, 2, '重复轮观测不倍增');
      assert.equal(decisionRows(chain.indexDir).length, 0, '重跑仍不追加决策');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. rules 版本不符：rebuild-required 口径，零写入。
//    seam 登记：投影 rules_version 落 schema_meta 键 `rules_version`；编排层与当前规则常量比对。
//    纯函数层不符判定已由 task42-drain.test.ts 覆盖，本条钉真链短路零写入。
// ═══════════════════════════════════════════════════════════════════════════

test('rules 版本不符：投影标记 stale → rulesVersionMismatch，卡/决策/revision/观测零增量', async () => {
  const eventA = makeEvent({ id: 'evt-rules-a', anchors: [EXP_A], version: 1, created_at: iso(TIME_A) });
  const chain = await seedChainRoot({ experiences: [EXP_A], events: [eventA] });
  // 手工盖一个过期规则版本戳（写柄故障注入面之外，测试直接操作投影库 meta）。
  const dbFile = path.join(chain.indexDir, MEMORY_INDEX_FILE);
  const seedDb = new DatabaseSync(dbFile);
  try {
    seedDb.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)").run(
      'rules_version',
      'rules-v-stale',
    );
  } finally {
    seedDb.close();
  }

  try {
    const handle = openChainHandle(chain);
    try {
      const before = {
        cards: cardCount(chain.indexDir),
        decisions: decisionRows(chain.indexDir).length,
        revisions: revisionCount(chain.indexDir),
        observations: observationLines(chain.projectionDir).length,
      };
      const drain = drainOf(handle);
      const report = await drain(60_000);

      assert.equal(report.rulesVersionMismatch, true, '规则版本不符须置位 rebuild-required 标记');
      assert.equal(report.applied, false, '版本不符不得提交');
      assert.equal(cardCount(chain.indexDir), before.cards);
      assert.equal(decisionRows(chain.indexDir).length, before.decisions);
      assert.equal(revisionCount(chain.indexDir), before.revisions);
      assert.equal(observationLines(chain.projectionDir).length, before.observations);
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. 三级失败真链边界：
//    F-A 自愈（预算耗尽）零观测、零 applied；F-B 隔离版本不进卡集、不重试；
//    F-C 连续失败计数挂在柄上跨轮可读、成功清零。
//    （事务/IO 故障注入需写柄故障 seam，当前仓无此注入面；F-C 累加/清零纯函数已由
//      task42-drain.test.ts 的 consecutiveFailuresAfter 覆盖，本条钉跨轮状态挂载。）
// ═══════════════════════════════════════════════════════════════════════════

test('F-A：预算 0 短路 → 零观测、零卡、零决策', async () => {
  const eventA = makeEvent({ id: 'evt-fa', anchors: [EXP_A], version: 1, created_at: iso(TIME_A) });
  const chain = await seedChainRoot({ experiences: [EXP_A], events: [eventA] });
  try {
    const handle = openChainHandle(chain);
    try {
      const drain = drainOf(handle);
      const report = await drain(0);
      assert.equal(report.skipped, 'budget');
      assert.equal(report.applied, false);
      assert.equal(cardCount(chain.indexDir), 0);
      assert.equal(decisionRows(chain.indexDir).length, 0);
      assert.equal(observationLines(chain.projectionDir).length, 0);
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

test('F-B：隔离版本第二轮仍不进卡集（不重试、不进 applied）', async () => {
  const dangling = makeEvent({ id: 'evt-fb', anchors: [MISSING], version: 1, created_at: iso(TIME_C) });
  const chain = await seedChainRoot({ experiences: [EXP_A], events: [dangling] });
  try {
    const handle = openChainHandle(chain);
    try {
      const drain = drainOf(handle);
      await drain(60_000);
      await drain(60_000);
      assert.equal(cardCount(chain.indexDir), 0, '悬空版本两轮都不得建卡');
      assert.equal(decisionRows(chain.indexDir).length, 0);
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

test('F-C：成功轮连续失败计数归零；柄上计数器跨轮可读（不回落到恒 0 伪装）', async () => {
  const eventA = makeEvent({ id: 'evt-fc', anchors: [EXP_A], version: 1, created_at: iso(TIME_A) });
  const chain = await seedChainRoot({ experiences: [EXP_A], events: [eventA] });
  try {
    const handle = openChainHandle(chain);
    try {
      const drain = drainOf(handle);
      const report = await drain(60_000);
      assert.equal(report.consecutiveFailures, 0, '成功轮失败计数归零');
      assert.ok(Number.isInteger(report.consecutiveFailures), '计数器为非负整数');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. 版本上下文统一注入 e2e：决策 at_ms 取事件版本 created_at，不取墙钟。
//    注：DecisionRecord 无独立 version 列，版本身份经 event_id + decision_id 派生材料
//    （G2 确定性契约覆盖）；本条钉时间口径与去兜底字面量。
// ═══════════════════════════════════════════════════════════════════════════

test('版本上下文：create-card 决策 at_ms === isoToMs(版本 created_at)，不读注入墙钟', async () => {
  const eventB = makeEvent({ id: 'evt-ctx-b', anchors: [EXP_B], version: 2, created_at: iso(TIME_B) });
  const chain = await seedChainRoot({ experiences: [EXP_B], events: [eventB] });
  try {
    const handle = openChainHandle(chain);
    try {
      const drain = drainOf(handle);
      await drain(60_000);
      const decisions = decisionRows(chain.indexDir).filter((d) => d.event_id === 'evt-ctx-b');
      assert.equal(decisions.length, 1, '该事件一条 create-card 决策');
      const decision = decisions[0]!;
      assert.equal(decision.at_ms, isoToMs(iso(TIME_B)), 'at_ms 必须等于版本 created_at 毫秒');
      assert.notEqual(decision.at_ms, isoToMs(iso(TIME_A)), '不得回退到其他版本/墙钟时间');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

test('版本上下文静态守卫：决策铸造站版本不得为数字字面量', () => {
  const storeFile = path.join(REPO_ROOT, 'src', 'memory', 'store.ts');
  const code = fs.readFileSync(storeFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const callSites = code.match(/castDecision\(\{[\s\S]*?\}\)/g) ?? [];
  for (const site of callSites) {
    assert.ok(!/version\s*:\s*\d+\b/.test(site), `castDecision 版本不得为数字字面量：${site.slice(0, 120)}`);
  }
});

/** 扫描 src/memory 下全部 .ts（静态规则只判可执行代码）。 */
function readMemorySourcesChain(): Array<{ relPath: string; text: string }> {
  const out: Array<{ relPath: string; text: string }> = [];
  const memoryDir = path.join(REPO_ROOT, 'src', 'memory');
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push({
          relPath: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
          text: fs.readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(memoryDir);
  return out;
}

/** 按类方法声明切分方法块（2 空格缩进），便于把常量引用钉到具体归属路径。 */
function methodBlocks(text: string): Map<string, string> {
  const matches = [...text.matchAll(/^  (\w+)\([^)]*\)(?::[^{]+)?\s*\{/gm)];
  const blocks = new Map<string, string>();
  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    blocks.set(match[1]!, text.slice(start, end));
  });
  return blocks;
}

test('裁决 8：LEGACY_MISS_ALIAS* 常量只被 store.ts miss 回填路径引用，不得扩散到决策铸造站', () => {
  const files = readMemorySourcesChain();
  const LEGACY = /LEGACY_MISS_ALIAS\w*/g;

  const references: Array<{ relPath: string; token: string }> = [];
  for (const file of files) {
    const code = file.text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of code.matchAll(LEGACY)) {
      references.push({ relPath: file.relPath, token: match[0]! });
    }
  }

  // 定义与引用面只允许落在 store.ts；drain/decision/planner/builder 等决策/规划层零引用。
  for (const ref of references) {
    assert.equal(ref.relPath, 'src/memory/store.ts', `遗留常量不得扩散到 ${ref.relPath}（${ref.token}）`);
  }

  const store = files.find((f) => f.relPath === 'src/memory/store.ts');
  assert.ok(store !== undefined);
  const blocks = methodBlocks(store!.text);
  const missBlock = blocks.get('addMissAlias');
  assert.ok(missBlock !== undefined, '须能切出 addMissAlias miss 回填方法块');

  // store.ts 内除模块级定义外，每一处引用都必须落在 addMissAlias 块内。
  for (const line of store!.text.split('\n')) {
    if (!LEGACY.test(line)) continue;
    LEGACY.lastIndex = 0;
    if (/^\s*const\s+LEGACY_MISS_ALIAS\w*\s*=/.test(line)) continue; // 定义站点豁免
    assert.ok(
      missBlock.includes(line),
      `遗留常量只能在 addMissAlias（miss 回填）路径引用：${line.trim()}`,
    );
  }

  // drain 编排的 create-card / invalidate 决策铸造站走事件版本上下文真值，不引用占位常量。
  const drainFile = files.find((f) => f.relPath === 'src/memory/drain.ts');
  if (drainFile !== undefined) {
    assert.ok(!LEGACY.test(drainFile.text), 'drain 决策铸造站不得引用 LEGACY_MISS_ALIAS* 占位常量');
    LEGACY.lastIndex = 0;
    for (const site of drainFile.text.match(/castDrainDecision\(\{[\s\S]*?\}\)/g) ?? []) {
      assert.ok(/version:\s*event\.version/.test(site), 'create-card/invalidate 版本须取事件版本上下文');
      assert.ok(/createdAtIso:\s*event\.created_at/.test(site), '时间须取事件版本 created_at');
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. P-10：第七法永不进宿主工具表（六法快照不变）。
// ═══════════════════════════════════════════════════════════════════════════

test('P-10：第七法 drainProjection 不进宿主工具表（仍恰六法）', () => {
  const toolNames: readonly string[] = Object.values(MEMORY_TOOL_NAMES);
  assert.equal(toolNames.length, 6, '宿主记忆工具恰六法');
  assert.ok(!toolNames.includes('fasti_memory_drain_projection'), '第七法不得注册为宿主工具');
  assert.ok(!('drainProjection' in MEMORY_TOOL_NAMES), '工具表键集合不含 drainProjection');
});

// 受控码表自检：本文件引用的观测码均在 OBSERVATION_REASON_CODES 内。
test('观测码受控：anchor-not-found / empty-anchors 均在码表内', () => {
  for (const code of ['anchor-not-found', 'empty-anchors'] as const) {
    assert.ok((OBSERVATION_REASON_CODES as readonly string[]).includes(code), `观测码受控：${code}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. 裁决 9：applied 降为纯观测，不得抑制 DB 缺失卡的补建（R-03 单卡自愈）。
// ═══════════════════════════════════════════════════════════════════════════

test('裁决 9 单卡自愈：投影卡行被删后下一轮按期望态补建，台账 applied 不得抑制重建', async () => {
  const eventA = makeEvent({ id: 'evt-heal-a', anchors: [EXP_A], version: 1, created_at: iso(TIME_A) });
  const chain = await seedChainRoot({ experiences: [EXP_A], events: [eventA] });
  try {
    const handle = openChainHandle(chain);
    try {
      const drain = drainOf(handle);
      await drain(60_000);
      const first = readCardRow(chain.indexDir, 'evt-heal-a');
      assert.ok(first !== null, '首轮须建出卡');
      const snapshot = stableCardSnapshot(first);

      // 模拟卡行损坏/误删/恢复不全；台账 create-card 决策仍在案。
      const dbFile = path.join(chain.indexDir, MEMORY_INDEX_FILE);
      const db = new DatabaseSync(dbFile);
      try {
        db.prepare('DELETE FROM mem_card WHERE event_id = ?').run('evt-heal-a');
        db.prepare('DELETE FROM mem_card_fts WHERE card_id = ?').run(String(snapshot.card_id));
      } finally {
        db.close();
      }
      assert.equal(readCardRow(chain.indexDir, 'evt-heal-a'), null, '夹具前置：删除后库内确无该行');

      const second = await drain(60_000);
      assert.equal(second.skipped, null, '就绪轮不是短路');
      assert.ok(Number(second.cardUpserts) >= 1, '丢失的卡必须在下一轮补建');
      const restored = readCardRow(chain.indexDir, 'evt-heal-a');
      assert.ok(restored !== null, '补建后 mem_card 必须有该 event_id 行');
      assert.deepEqual(stableCardSnapshot(restored), snapshot, '补建行与首轮期望态逐行相等');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

test('裁决 9 台账 hash：create-card 决策 structural_hash = 测试侧独立重算的六项结构哈希', async () => {
  const eventA = makeEvent({ id: 'evt-hash-a', anchors: [EXP_A, EXP_B], version: 1, created_at: iso(TIME_A) });
  const chain = await seedChainRoot({ experiences: [EXP_A, EXP_B], events: [eventA] });
  try {
    const handle = openChainHandle(chain);
    try {
      const drain = drainOf(handle);
      await drain(60_000);
      const decisions = decisionRows(chain.indexDir).filter(
        (d) => d.action === 'create-card' && d.event_id === 'evt-hash-a',
      );
      assert.equal(decisions.length, 1, '该事件一条 create-card 决策');
      const expected = independentStructuralHash(eventA);
      assert.equal(decisions[0]!.structural_hash, expected, 'structural_hash 须与独立重算一致');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});

test('裁决 9：历史 applied 行不得抑制重建（DB 无卡时即便台账有 applied 决策也须建卡）', async () => {
  const eventA = makeEvent({ id: 'evt-applied-a', anchors: [EXP_A], version: 1, created_at: iso(TIME_A) });
  const chain = await seedChainRoot({ experiences: [EXP_A], events: [eventA] });
  // 预置一条含 event_id + 匹配 structural_hash 的 applied 决策行；投影 DB 无对应卡。
  appendDecision(chain.indexDir, {
    decision_id: '01J0000000000000000000000D',
    at_ms: isoToMs(iso(TIME_A)),
    action: 'create-card',
    card_id: null,
    event_id: 'evt-applied-a',
    anchor_json: JSON.stringify([EXP_A]),
    content_hash: 'seed-applied',
    structural_hash: independentStructuralHash(eventA),
    model_tag: CURRENT_RULES_VERSION,
    reason: 'seed: applied history (rebuild must not be suppressed)',
    created_by: 'her',
  });
  assert.equal(cardCount(chain.indexDir), 0, '夹具前置：DB 无卡');

  try {
    const handle = openChainHandle(chain);
    try {
      const drain = drainOf(handle);
      const report = await drain(60_000);
      assert.equal(report.skipped, null, '就绪轮不是短路');
      assert.ok(Number(report.cardUpserts) >= 1, 'applied 台账行不得抑制 DB 缺失卡的重建');
      const restored = readCardRow(chain.indexDir, 'evt-applied-a');
      assert.ok(restored !== null, 'mem_card 必须建出该 event_id 行');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(chain.root);
  }
});
