/**
 * #42 · B2 第一批：第七法 `drainProjection` + 四种短路 + 正常轮报告（正本 §3.2 轮报告、
 * §3.1 模块清单、R-10 离线持锁）。
 *
 * 被测 seam（写者在 B2 内落地，批内红→绿）：
 *  - `src/memory/drain.ts`：编排纯判定 + 轮报告形状导出；
 *  - `src/memory/runtime.ts` 窄柄第六法之外加第七法 `drainProjection(budgetMs)`，
 *    既有六法签名不动；第七法**永不进宿主工具表**（P-10 既有探针继续绿）。
 *
 * 短路口径（§3.1 F-A 自愈类）：持锁 `writer-lock-held` / 关停 `closed` / 预算 `budget` /
 * 端口未注入 `not-wired`；短路时事务未开始、派生集不推进、零写入、检索面仍可用。
 * 本文件只写测试，绝不改 src/；全部临时 DSH_HOME，真实数据根零写入。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { AbstainEntry, ExpectedCard, QuarantineEntry } from '../../src/memory/derive.ts';
import { DECISIONS_FILE, REVISIONS_FILE } from '../../src/memory/ledger.ts';
import { OBSERVATION_REASON_CODES } from '../../src/memory/observations.ts';
import { openMemoryRuntime } from '../../src/memory/runtime.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../src/memory/store.ts';
import type { DecisionRecord, RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, countLines, listTree, makeTempRoot } from '../helpers.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = Date.parse('2026-11-08T02:13:20.000Z');
const DAY = 24 * 3600 * 1000;

// ── 轮报告形状镜像（§3.2 终裁，与 drain.ts 导出同构）─────────────────────────

/** 短路码表；null = 正常跑完一轮（可能空轮，但不是短路）。 */
type DrainSkipped = 'writer-lock-held' | 'closed' | 'budget' | 'not-wired' | null;

interface DrainRoundReport {
  readonly scannedVersions: number;
  readonly cardUpserts: number;
  readonly invalidations: number;
  readonly quarantined: number;
  readonly emptyAnchored: number;
  readonly applied: boolean;
  readonly skipped: DrainSkipped;
  readonly consecutiveFailures: number;
  readonly rulesVersionMismatch: boolean;
  readonly durationMs: number;
}

interface DrainSkipContext {
  /** 写单例是否可取得（backend.writer !== null）。 */
  readonly writable: boolean;
  /** 窄柄/门面是否已关停。 */
  readonly closed: boolean;
  /** 事件真源/派生读取器是否已注入接线。 */
  readonly sourceWired: boolean;
  /** 本轮预算是否耗尽（0 预算或时长/条数到限）。 */
  readonly budgetExhausted: boolean;
}

/** 一轮纯规划入参（前后态卡引用 + 隔离/弃权集 + 规则版本 + 失败计数）。 */
interface DrainPlanInput {
  readonly previousCards: readonly ExpectedCard[];
  readonly currentCards: readonly ExpectedCard[];
  readonly quarantined: readonly QuarantineEntry[];
  readonly emptyAnchored: readonly AbstainEntry[];
  readonly rulesVersion: string;
  readonly projectionRulesVersion: string | null;
  readonly consecutiveFailures: number;
  readonly txFailed: boolean;
}

interface DrainPlanResult {
  readonly status: 'ok' | 'rebuild-required';
  readonly report: DrainRoundReport;
}

interface DrainModule {
  readonly classifyDrainSkip: (context: DrainSkipContext) => DrainSkipped;
  readonly isRulesVersionMismatch: (
    projectionRulesVersion: string | null,
    rulesVersion: string,
  ) => boolean;
  readonly consecutiveFailuresAfter: (prev: number, txFailed: boolean) => number;
  readonly planDrainRound: (input: DrainPlanInput) => DrainPlanResult;
}

const DRAIN_URL = new URL('../../src/memory/drain.ts', import.meta.url);

async function loadDrain(): Promise<DrainModule> {
  // 模块以当前导出为准；本批 seam 未落地时对应用例在调用点红，不连坐其他用例。
  return (await import(DRAIN_URL.href)) as DrainModule;
}

const SKIPPED_VALUES: readonly DrainSkipped[] = [
  'writer-lock-held',
  'closed',
  'budget',
  'not-wired',
  null,
];

function assertReportShape(report: DrainRoundReport, label: string): void {
  assert.ok(Number.isInteger(report.scannedVersions) && report.scannedVersions >= 0, `${label} scannedVersions`);
  assert.ok(Number.isInteger(report.cardUpserts) && report.cardUpserts >= 0, `${label} cardUpserts`);
  assert.ok(Number.isInteger(report.invalidations) && report.invalidations >= 0, `${label} invalidations`);
  assert.ok(Number.isInteger(report.quarantined) && report.quarantined >= 0, `${label} quarantined`);
  assert.ok(Number.isInteger(report.emptyAnchored) && report.emptyAnchored >= 0, `${label} emptyAnchored`);
  assert.equal(typeof report.applied, 'boolean', `${label} applied 须为布尔`);
  assert.ok(SKIPPED_VALUES.includes(report.skipped), `${label} skipped 受控码表内：${String(report.skipped)}`);
  assert.ok(Number.isInteger(report.consecutiveFailures) && report.consecutiveFailures >= 0, `${label} consecutiveFailures`);
  assert.equal(typeof report.rulesVersionMismatch, 'boolean', `${label} rulesVersionMismatch 须为布尔`);
  assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0, `${label} durationMs`);
}

// ── 夹具：空白投影库（空卡/空别名 + 一条 build revision）───────────────────────

interface Seeded {
  readonly root: string;
  readonly indexDir: string;
  readonly projectionDir: string;
}

async function seedBlankIndex(): Promise<Seeded> {
  const root = makeTempRoot('mem-drain-b2-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const projectionDir = path.dirname(indexDir);
  const handle = openMemoryWrite({ indexDir });
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 1,
      truth_fingerprint: 'fp-drain-b2',
      prior_revision: null,
      card_count: 0,
      alias_count: 0,
      row_hash_sum: 'rh-drain-b2',
      shadow_diff: { added: 0, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    handle.transactionApply({ cards: [], aliases: [] }, revision, []);
  } finally {
    await handle.close();
  }
  return { root, indexDir, projectionDir };
}

/** 投影面快照：卡数 / miss 数 / 决策行 / 修订行 / 观测行 / 文件树。 */
interface ProjectionSnapshot {
  readonly cards: number;
  readonly miss: number;
  readonly decisions: number;
  readonly revisions: number;
  readonly observations: number;
  readonly tree: readonly string[];
}

function snapshotProjection(seed: Seeded): ProjectionSnapshot {
  let cards = 0;
  let miss = 0;
  const dbFile = path.join(seed.indexDir, MEMORY_INDEX_FILE);
  if (fs.existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      cards = (db.prepare('SELECT COUNT(*) AS n FROM mem_card').get() as { n: number }).n;
      miss = (db.prepare('SELECT COUNT(*) AS n FROM mem_miss').get() as { n: number }).n;
    } finally {
      db.close();
    }
  }
  const decisions = fs.existsSync(path.join(seed.indexDir, DECISIONS_FILE))
    ? countLines(path.join(seed.indexDir, DECISIONS_FILE))
    : 0;
  const revisions = fs.existsSync(path.join(seed.indexDir, REVISIONS_FILE))
    ? countLines(path.join(seed.indexDir, REVISIONS_FILE))
    : 0;
  const observationFile = path.join(seed.projectionDir, 'drain-observations.jsonl');
  const observations = fs.existsSync(observationFile) ? countLines(observationFile) : 0;
  return { cards, miss, decisions, revisions, observations, tree: listTree(seed.projectionDir) };
}

function assertZeroWrite(before: ProjectionSnapshot, after: ProjectionSnapshot, label: string): void {
  assert.equal(after.cards, before.cards, `${label} 短路不得增卡`);
  assert.equal(after.miss, before.miss, `${label} 短路不得增 miss 行`);
  assert.equal(after.decisions, before.decisions, `${label} 短路不得追加决策行`);
  assert.equal(after.revisions, before.revisions, `${label} 短路不得追加 revision`);
  assert.equal(after.observations, before.observations, `${label} 短路不得写观测行`);
  assert.deepEqual(after.tree, before.tree, `${label} 短路不得产生新投影文件`);
}

/** 取窄柄上的第七法（运行时反射面；类型接缝避免今日 tsc 报多余实参）。 */
function drainProjectionOf(
  handle: object,
): ((budgetMs: number) => Promise<DrainRoundReport>) | undefined {
  const rec = handle as Record<string, unknown>;
  return typeof rec.drainProjection === 'function'
    ? (rec.drainProjection as (budgetMs: number) => Promise<DrainRoundReport>)
    : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// 短路纯判定：码表与优先级（closed > 持锁 > 未接线 > 预算 > null）。
// ═══════════════════════════════════════════════════════════════════════════

test('短路判定：已关停 → closed（最高优先级）', async () => {
  const drain = await loadDrain();
  assert.equal(
    drain.classifyDrainSkip({ closed: true, writable: false, sourceWired: false, budgetExhausted: true }),
    'closed',
  );
});

test('短路判定：未关停但写单例被占用 → writer-lock-held（R-10）', async () => {
  const drain = await loadDrain();
  assert.equal(
    drain.classifyDrainSkip({ closed: false, writable: false, sourceWired: true, budgetExhausted: false }),
    'writer-lock-held',
  );
});

test('短路判定：写柄可取但读取器未接线 → not-wired', async () => {
  const drain = await loadDrain();
  assert.equal(
    drain.classifyDrainSkip({ closed: false, writable: true, sourceWired: false, budgetExhausted: false }),
    'not-wired',
  );
});

test('短路判定：接线就绪但预算耗尽 → budget', async () => {
  const drain = await loadDrain();
  assert.equal(
    drain.classifyDrainSkip({ closed: false, writable: true, sourceWired: true, budgetExhausted: true }),
    'budget',
  );
});

test('短路判定：全部就绪 → null（正常轮，非短路）', async () => {
  const drain = await loadDrain();
  assert.equal(
    drain.classifyDrainSkip({ closed: false, writable: true, sourceWired: true, budgetExhausted: false }),
    null,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 窄柄第七法：R-10 持锁短路 + 关停 + 预算 + 正常轮；短路零写入、检索面可用。
// ═══════════════════════════════════════════════════════════════════════════

test('R-10：写单例被离线任务占用 → 第七法返 writer-lock-held，零写入、检索仍可用', async () => {
  const seed = await seedBlankIndex();
  try {
    const occupier = openMemoryWrite({ indexDir: seed.indexDir });
    try {
      const handle = openMemoryRuntime({ indexDir: seed.indexDir });
      try {
        const before = snapshotProjection(seed);
        const drain = drainProjectionOf(handle);
        assert.equal(typeof drain, 'function', '窄柄须挂第七法 drainProjection');
        const report = (await drain!(60_000)) as DrainRoundReport;
        assertReportShape(report, 'writer-lock-held');
        assert.equal(report.skipped, 'writer-lock-held');
        assert.equal(report.applied, false, '持锁短路不得提交事务');
        const after = snapshotProjection(seed);
        assertZeroWrite(before, after, 'writer-lock-held');
        // 检索面在降级只读形态仍可用（与既有单例冲突惯例一致）。
        const found = await handle.searchExplained({ text: '不存在的词', atMs: T0 });
        assert.deepEqual(found.map((c) => c.card.cardId), []);
      } finally {
        await handle.close();
      }
    } finally {
      await occupier.close();
    }
  } finally {
    cleanupTempRoot(seed.root);
  }
});

test('closed：窄柄关停后再 drain → skipped=closed，零写入', async () => {
  const seed = await seedBlankIndex();
  try {
    const handle = openMemoryRuntime({ indexDir: seed.indexDir });
    await handle.close();
    const before = snapshotProjection(seed);
    const drain = drainProjectionOf(handle);
    assert.equal(typeof drain, 'function', '窄柄须挂第七法 drainProjection');
    const report = (await drain!(60_000)) as DrainRoundReport;
    assertReportShape(report, 'closed');
    assert.equal(report.skipped, 'closed');
    assert.equal(report.applied, false);
    const after = snapshotProjection(seed);
    assertZeroWrite(before, after, 'closed');
  } finally {
    cleanupTempRoot(seed.root);
  }
});

test('budget：预算为 0 → skipped=budget，零写入', async () => {
  const seed = await seedBlankIndex();
  try {
    const handle = openMemoryRuntime({ indexDir: seed.indexDir });
    try {
      const before = snapshotProjection(seed);
      const drain = drainProjectionOf(handle);
      assert.equal(typeof drain, 'function', '窄柄须挂第七法 drainProjection');
      const report = (await drain!(0)) as DrainRoundReport;
      assertReportShape(report, 'budget');
      assert.equal(report.skipped, 'budget');
      assert.equal(report.applied, false);
      const after = snapshotProjection(seed);
      assertZeroWrite(before, after, 'budget');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(seed.root);
  }
});

test('正常轮：接线就绪且预算充足 → skipped=null，轮报告十字段齐全', async () => {
  const seed = await seedBlankIndex();
  try {
    const handle = openMemoryRuntime({ indexDir: seed.indexDir });
    try {
      const drain = drainProjectionOf(handle);
      assert.equal(typeof drain, 'function', '窄柄须挂第七法 drainProjection');
      const report = (await drain!(60_000)) as DrainRoundReport;
      assertReportShape(report, '正常轮');
      assert.equal(report.skipped, null, '就绪轮不是短路');
      assert.equal(report.rulesVersionMismatch, false);
      assert.equal(report.consecutiveFailures, 0);
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(seed.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第二批：drain 编排 —— 无状态对账 / 空轮 / 规则版本 / 单事务 / 三级失败。
// ═══════════════════════════════════════════════════════════════════════════

function expectedCard(eventId: string, anchors: readonly string[], cardId: string): ExpectedCard {
  // #123：ExpectedCard 新增 cues，rules-v1 夹具恒空（与生产零漂移口径一致）。
  return {
    eventId,
    cardId,
    anchors: [...anchors],
    channel: 'dsh',
    startedMs: T0,
    endedMs: T0 + DAY,
    cues: [],
  };
}

function readMemorySources(): Array<{ relPath: string; text: string }> {
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

/** 剥 TS 行/块注释（与 schema.test.ts 同口径：静态规则只判可执行代码）。 */
function stripTsComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.split('//')[0] ?? '')
    .join('\n');
}

test('无状态对账：src/memory/ 内不得出现水位/游标/已读偏移（注释外）', () => {
  const watermark = /\b(watermark|cursor|lastSeen|processedOffset|processed_offset|last_seen)\b|水位/;
  for (const file of readMemorySources()) {
    const code = stripTsComments(file.text);
    const hit = watermark.exec(code);
    assert.equal(hit, null, `${file.relPath} 出现权威水位/游标：${hit?.[0] ?? ''}`);
  }
});

test('投影 schema 不新增表：CREATE TABLE DDL 只允许出现在 schema.ts', () => {
  for (const file of readMemorySources()) {
    const code = stripTsComments(file.text);
    if (/CREATE\s+TABLE/i.test(code)) {
      assert.equal(file.relPath, 'src/memory/schema.ts', `新表 DDL 必须落在 schema.ts：${file.relPath}`);
    }
  }
});

test('drain 编排层不直开文件/数据库写面（写面仅经 store/ledger 间接访问）', () => {
  const drainFile = readMemorySources().find((f) => f.relPath === 'src/memory/drain.ts');
  if (drainFile === undefined) return;
  assert.ok(!/from\s+['"]node:fs['"]/.test(drainFile.text), 'drain 编排层不得直开文件写面');
  assert.ok(!/from\s+['"]node:sqlite['"]/.test(drainFile.text), 'drain 编排层不得直开数据库');
});

test('applied 编排守卫：禁止 event_id 单层去重回填；禁止空结构哈希占位', () => {
  const drainFile = readMemorySources().find((f) => f.relPath === 'src/memory/drain.ts');
  if (drainFile === undefined) return;
  const code = stripTsComments(drainFile.text);
  assert.ok(!/appliedEventIds/.test(code), '不得保留 eventId 单层 applied 回填集（结构变化会被误判已应用）');
  assert.ok(
    !/structuralHash\s*:\s*decision\.\w+\s*\?\?\s*''/.test(code),
    '缺 structural_hash 不得兜底空串入 applied 集；缺哈希按未 applied 重算',
  );
});

test('规则版本协议：空白投影(null)不判冲突；同版本不冲突；不符 → rebuild-required', async () => {
  const drain = await loadDrain();
  assert.equal(drain.isRulesVersionMismatch(null, 'rules-v1'), false, '空白投影不视为版本冲突');
  assert.equal(drain.isRulesVersionMismatch('rules-v1', 'rules-v1'), false);
  assert.equal(drain.isRulesVersionMismatch('rules-v1', 'rules-v2'), true);
});

test('空转轮：前后态一致 → upserts/invalidations/quarantine/abstain 全 0，不提交事务', async () => {
  const drain = await loadDrain();
  const card = expectedCard('evt-empty', ['01J0000000000000000000000A'], 'mc_empty');
  const plan = drain.planDrainRound({
    previousCards: [card],
    currentCards: [card],
    quarantined: [],
    emptyAnchored: [],
    rulesVersion: 'rules-v1',
    projectionRulesVersion: 'rules-v1',
    consecutiveFailures: 0,
    txFailed: false,
  });
  assert.equal(plan.status, 'ok');
  const r = plan.report;
  assertReportShape(r, '空转轮');
  assert.equal(r.cardUpserts, 0);
  assert.equal(r.invalidations, 0);
  assert.equal(r.quarantined, 0);
  assert.equal(r.emptyAnchored, 0);
  assert.equal(r.applied, false, '空轮不提交事务、不追加 revision');
  assert.equal(r.rulesVersionMismatch, false);
});

test('rules 版本不符：plan 返 rebuild-required，动作计数全 0、零提交', async () => {
  const drain = await loadDrain();
  const card = expectedCard('evt-mismatch', ['01J0000000000000000000000A'], 'mc_mm');
  const plan = drain.planDrainRound({
    previousCards: [],
    currentCards: [card],
    quarantined: [],
    emptyAnchored: [],
    rulesVersion: 'rules-v2',
    projectionRulesVersion: 'rules-v1',
    consecutiveFailures: 0,
    txFailed: false,
  });
  assert.equal(plan.status, 'rebuild-required');
  assert.equal(plan.report.rulesVersionMismatch, true);
  assert.equal(plan.report.applied, false);
  assert.equal(plan.report.cardUpserts, 0);
  assert.equal(plan.report.invalidations, 0);
  assert.equal(plan.report.quarantined, 0);
});

test('F-B 数据级 quarantine：悬空/形态非法不建卡、计数进 quarantine、观测码受控', async () => {
  const drain = await loadDrain();
  const quarantined: QuarantineEntry[] = [
    { eventId: 'evt-dangling', reasonCode: 'anchor-not-found', anchors: ['01J0000000000000000000000B'] },
  ];
  const plan = drain.planDrainRound({
    previousCards: [],
    currentCards: [],
    quarantined,
    emptyAnchored: [],
    rulesVersion: 'rules-v1',
    projectionRulesVersion: 'rules-v1',
    consecutiveFailures: 0,
    txFailed: false,
  });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.report.quarantined, 1);
  assert.equal(plan.report.cardUpserts, 0, 'quarantine 版本不得进卡集');
  assert.equal(plan.report.invalidations, 0);
  for (const entry of quarantined) {
    assert.ok(
      (OBSERVATION_REASON_CODES as readonly string[]).includes(entry.reasonCode),
      `quarantine 观测码受控：${entry.reasonCode}`,
    );
    assert.ok(!plan.report.applied, '被隔离版本不进 applied 集');
  }
});

test('F-C 系统级退避：事务/IO 失败 → 连续失败计数累加、不提交、不写决策；成功清零', async () => {
  const drain = await loadDrain();
  assert.equal(drain.consecutiveFailuresAfter(2, true), 3, '失败累加进轮报告');
  assert.equal(drain.consecutiveFailuresAfter(3, false), 0, '下一轮成功清零');

  const plan = drain.planDrainRound({
    previousCards: [],
    currentCards: [],
    quarantined: [],
    emptyAnchored: [],
    rulesVersion: 'rules-v1',
    projectionRulesVersion: 'rules-v1',
    consecutiveFailures: 2,
    txFailed: true,
  });
  assert.equal(plan.report.consecutiveFailures, 3);
  assert.equal(plan.report.applied, false, '事务失败不得提交半份');
  assert.equal(plan.report.cardUpserts, 0, '系统级失败不写决策/不建卡');
});

test('单事务编排：drain.ts 仅一个事务应用点（一轮 apply 一次事务，无第二写分支）', () => {
  const drainFile = readMemorySources().find((f) => f.relPath === 'src/memory/drain.ts');
  if (drainFile !== undefined) {
    const code = stripTsComments(drainFile.text);
    const applySites = code.match(/transactionApply\s*\(/g) ?? [];
    assert.ok(
      applySites.length <= 1,
      `一轮只允许一个事务应用点，实际 ${applySites.length} 处 transactionApply`,
    );
  }
});

test('轮报告守恒下界：扫描数 ≥ 各类动作数之和，计数均非负', async () => {
  const drain = await loadDrain();
  const card = expectedCard('evt-cons', ['01J0000000000000000000000A'], 'mc_cons');
  const plan = drain.planDrainRound({
    previousCards: [],
    currentCards: [card],
    quarantined: [],
    emptyAnchored: [],
    rulesVersion: 'rules-v1',
    projectionRulesVersion: 'rules-v1',
    consecutiveFailures: 0,
    txFailed: false,
  });
  const r = plan.report;
  const actionSum = r.cardUpserts + r.invalidations + r.quarantined + r.emptyAnchored;
  assert.ok(r.scannedVersions >= actionSum, `scannedVersions ${r.scannedVersions} 不得小于动作和 ${actionSum}`);
});
