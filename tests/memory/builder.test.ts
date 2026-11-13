/**
 * C2 构建器测试 —— builder + CLI（方案 §4.6 / §5 流 1 / §11.3 M1/M3/M4/M8/M9）。
 *
 * 纪律：
 *  - 全部在 tests/helpers 式临时根；真实数据根零接触；
 *  - dry-run 默认零写入（listTree 快照 + 字节哈希对账）；
 *  - 真源只读（构建前后真值分片哈希不变）；
 *  - M8 用 monkey-patch fs.renameSync/fs.fsyncSync 注入中途失败（无生产 seams）；
 *  - M9 的 chmod 0500 为 POSIX-only：win32 上 test.skip（"POSIX-only，由审核方 Linux 补验"），
 *    断言原样保留、不削弱，由审核方在 Linux 补验；
 *  - CLI --apply 必须"先打印指纹与 diff → 二次确认（y/yes）才真写"；
 *    n / EOF / 其他输入一律取消（退出码 0、零写入）；--yes 供自动化跳过交互。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { EventRecord } from '../../src/contract/event.ts';
import { IntegrityError } from '../../src/core/errors.ts';
import { appendJsonl } from '../../src/core/jsonl.ts';
import { ulid } from '../../src/core/ulid.ts';
import {
  buildMemoryIndex,
  computeContentHash,
  computeRowHashSum,
  computeTruthFingerprint,
  deriveCardId,
} from '../../src/memory/builder.ts';
import { appendDecision, readDecisions, readRevisions } from '../../src/memory/ledger.ts';
import { MemoryAnchorDanglingError, MemoryIndexStaleError } from '../../src/memory/memory-errors.ts';
import { MEMORY_INDEX_FILE, openMemoryRead, openMemoryWrite } from '../../src/memory/store.ts';
import type { AliasRow, DecisionRecord, MemoryCard, RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, countLines, listTree, makeExperience, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const sha256 = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliScript = path.join(repoRoot, 'scripts', 'build-memory-index.ts');

// ── 夹具 ──────────────────────────────────────────────────────────────────

function eventRecord(id: string, anchors: string[], overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id,
    schema_version: 1,
    version: 1,
    status: 'closed',
    closed_reason: 'silence',
    pointers: anchors.map((a) => ({ id: a })),
    time_range: { started_at: iso(T0), ended_at: iso(T0 + DAY) },
    assembled_at: iso(T0 + DAY),
    summary: '客观摘要（仅供测试阅读，不进卡）',
    key_points: ['关键点一'],
    anchors,
    topic_lines: [],
    summary_quality: 'ready',
    summary_source: 'llm',
    summary_prompt_version: null,
    summary_model: null,
    effective_chars: null,
    raw_chars: null,
    created_by: 'system',
    created_at: iso(T0 + DAY),
    channel: 'dsh',
    boundary_candidates: [],
    ...overrides,
  };
}

interface Truth {
  root: string;
  e1: string;
  e2: string;
  e3: string;
  eventA: EventRecord;
  eventB: EventRecord;
}

/** 临时根 + 3 条经历 + 2 个 closed/ready 事件（A 锚 e1/e2，B 锚 e3）。 */
function makeTruth(): Truth {
  const root = makeTempRoot('builder-test-');
  const e1 = ulid();
  const e2 = ulid();
  const e3 = ulid();
  // 候选池口径：经历 occurred_at 必须落在所属事件时间窗内（闭区间）。
  const experienceTimes = [T0, T0 + Math.floor(DAY / 2), T0 + 4 * DAY];
  for (const [i, id] of [e1, e2, e3].entries()) {
    const at = experienceTimes[i]!;
    appendJsonl(
      path.join(root, 'experiences', '2026-11.jsonl'),
      makeExperience({ id, tick: i, occurred_at: iso(at), recorded_at: iso(at) }),
    );
  }
  const eventA = eventRecord(ulid(), [e1, e2]);
  const eventB = eventRecord(ulid(), [e3], {
    time_range: { started_at: iso(T0 + 4 * DAY), ended_at: iso(T0 + 5 * DAY) },
  });
  appendJsonl(path.join(root, 'events', '2026-11.jsonl'), eventA);
  appendJsonl(path.join(root, 'events', '2026-11.jsonl'), eventB);
  return { root, e1, e2, e3, eventA, eventB };
}

function cardFor(
  event: EventRecord,
  cues: string[],
  aliases: Array<{ term: string; sensitive: 0 | 1 }>,
  discriminator: string,
  atMs: number,
): { card: MemoryCard; aliasRows: AliasRow[] } {
  const cardId = deriveCardId(event.id, event.anchors);
  const anchorJson = JSON.stringify(event.anchors);
  const displayCuesJson = JSON.stringify(cues);
  const aliasesJson = JSON.stringify(
    aliases.map((a) => ({ term: a.term, source: 'miss', sensitive: a.sensitive })),
  );
  const card: MemoryCard = {
    cardId,
    eventId: event.id,
    anchorJson,
    channel: event.channel,
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator,
    entityHintJson: null,
    occurredMs: Date.parse(event.time_range.started_at),
    endedMs: Date.parse(event.time_range.ended_at),
    validMs: atMs,
    invalidMs: null,
    createdMs: atMs,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, discriminator),
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  const aliasRows: AliasRow[] = aliases.map((a) => ({
    termNorm: a.term,
    cardId,
    source: 'miss',
    sensitive: a.sensitive,
    status: 'active',
    createdMs: atMs,
    hitCount: 0,
    lastHitMs: null,
  }));
  return { card, aliasRows };
}

/** 经写柄事务直接种入一张合成卡（revision 1 / build + create-card 决策，测试夹具）。 */
async function seedIndex(
  root: string,
  entries: Array<{ card: MemoryCard; aliasRows: AliasRow[] }>,
  atMs: number,
): Promise<void> {
  const indexDir = path.join(root, 'projection', 'memory-index');
  const handle = openMemoryWrite({ indexDir });
  try {
    const cards = entries.map((e) => e.card);
    const aliases = entries.flatMap((e) => e.aliasRows);
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: atMs,
      schema_version: 1,
      truth_fingerprint: computeTruthFingerprint(root).aggregate,
      prior_revision: null,
      card_count: cards.filter((c) => c.status === 'active').length,
      alias_count: aliases.length,
      row_hash_sum: computeRowHashSum(cards),
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    const decisions: DecisionRecord[] = cards.map((c) => ({
      decision_id: ulid(),
      at_ms: atMs,
      action: 'create-card',
      card_id: c.cardId,
      event_id: c.eventId,
      anchor_json: c.anchorJson,
      content_hash: c.contentHash,
      model_tag: 'rules-v1',
      reason: 'fixture: 测试建卡',
      created_by: 'her',
    }));
    handle.transactionApply({ cards, aliases }, revision, decisions);
  } finally {
    await handle.close();
  }
}

function indexDirOf(root: string): string {
  return path.join(root, 'projection', 'memory-index');
}

function truthHashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of ['experiences', 'events']) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) {
      continue;
    }
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.jsonl')) {
        out.set(`${dir}/${name}`, sha256(path.join(full, name)));
      }
    }
  }
  return out;
}

function runCli(
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60000,
    input,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ── 纯函数 ────────────────────────────────────────────────────────────────

test('deriveCardId：mc_+32hex、锚点序无关、锚点集不同则 id 不同', () => {
  const a = deriveCardId('ev-1', ['x', 'y']);
  assert.match(a, /^mc_[0-9a-f]{32}$/);
  assert.equal(deriveCardId('ev-1', ['y', 'x']), a);
  assert.notEqual(deriveCardId('ev-1', ['x', 'z']), a);
  assert.notEqual(deriveCardId('ev-2', ['x', 'y']), a);
});

test('computeTruthFingerprint：覆盖 experiences+events 分片、路径排序、改一字节聚合变', () => {
  const t = makeTruth();
  try {
    const fp = computeTruthFingerprint(t.root);
    assert.deepEqual(
      fp.files.map((f) => f.path),
      ['events/2026-11.jsonl', 'experiences/2026-11.jsonl'],
    );
    for (const f of fp.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
    }
    const before = fp.aggregate;
    fs.appendFileSync(path.join(t.root, 'experiences', '2026-11.jsonl'), ' ', 'utf8');
    const after = computeTruthFingerprint(t.root);
    assert.notEqual(after.aggregate, before);
  } finally {
    cleanupTempRoot(t.root);
  }
});

// ── dry-run 零写入 ────────────────────────────────────────────────────────

test('dry-run（无旧库）：未种子事件不建卡、revision=null、真实根零写入', async () => {
  const t = makeTruth();
  const before = listTree(t.root);
  const hashes = truthHashes(t.root);
  try {
    const report = await buildMemoryIndex({ dataRoot: t.root, dryRun: true, nowMs: T0 });
    assert.equal(report.revision, null);
    assert.equal(report.cards, 0, '零正文纪律：无人工线索不建卡');
    assert.equal(report.aliases, 0);
    assert.deepEqual(report.danglingAnchors, []);
    assert.deepEqual(report.shadowDiff, { added: 0, removed: 0, changed: 0 });
    assert.ok(report.outputDir.startsWith(os.tmpdir()), '影子目录必须在系统临时目录');
    assert.deepEqual(listTree(t.root), before, 'dry-run 不得触碰真实根');
    assert.deepEqual(truthHashes(t.root), hashes, '真源只读');
    cleanupTempRoot(report.outputDir);
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('dry-run（有旧库）：旧库字节不变、账本不增行、outputDir 指向临时影子', async () => {
  const t = makeTruth();
  try {
    const seeded = cardFor(t.eventA, ['线索甲'], [{ term: '别名甲', sensitive: 0 }], '区别于乙', T0);
    await seedIndex(t.root, [seeded], T0);
    const indexDir = indexDirOf(t.root);
    const dbFile = path.join(indexDir, MEMORY_INDEX_FILE);
    const dbHashBefore = sha256(dbFile);
    const revisionsBefore = fs.readFileSync(path.join(indexDir, 'revisions.jsonl'), 'utf8');

    const report = await buildMemoryIndex({ dataRoot: t.root, dryRun: true, nowMs: T0 + DAY });
    assert.equal(report.revision, null);
    assert.equal(report.cards, 1);
    assert.deepEqual(report.shadowDiff, { added: 0, removed: 0, changed: 0 });
    assert.equal(sha256(dbFile), dbHashBefore, 'dry-run 不得改旧库一个字节');
    assert.equal(
      fs.readFileSync(path.join(indexDir, 'revisions.jsonl'), 'utf8'),
      revisionsBefore,
      'dry-run 不得追加账本',
    );
    assert.ok(report.outputDir.startsWith(os.tmpdir()));
    cleanupTempRoot(report.outputDir);
  } finally {
    cleanupTempRoot(t.root);
  }
});

// ── apply：搬运种子卡 + 账本 ──────────────────────────────────────────────

test('apply：种子卡原样搬运、revision 盖章、账本前缀 preserved、真源只读', async () => {
  const t = makeTruth();
  const hashes = truthHashes(t.root);
  try {
    const seeded = cardFor(
      t.eventA,
      ['线索甲', '线索乙'],
      [
        { term: '别名甲', sensitive: 0 },
        { term: '隐私词', sensitive: 1 },
      ],
      '区别于事件乙',
      T0,
    );
    await seedIndex(t.root, [seeded], T0);
    const indexDir = indexDirOf(t.root);
    const revisionsFile = path.join(indexDir, 'revisions.jsonl');
    const decisionsFile = path.join(indexDir, 'decisions.jsonl');
    const revisionsBefore = fs.readFileSync(revisionsFile, 'utf8');
    const decisionsBefore = fs.readFileSync(decisionsFile, 'utf8');

    const report = await buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY });
    assert.equal(report.revision, 2);
    assert.equal(report.cards, 1);
    assert.equal(report.aliases, 2);
    assert.deepEqual(report.shadowDiff, { added: 0, removed: 0, changed: 0 });
    assert.equal(report.outputDir, indexDir);

    const revisions = readRevisions(indexDir);
    assert.equal(revisions.length, 2);
    assert.equal(revisions[1]?.slug, 'rebuild');
    assert.equal(revisions[1]?.prior_revision, 1);
    assert.equal(revisions[1]?.card_count, 1);
    assert.equal(revisions[1]?.operator, 'offline-cli');
    assert.ok(fs.readFileSync(revisionsFile, 'utf8').startsWith(revisionsBefore));
    assert.equal(fs.readFileSync(decisionsFile, 'utf8'), decisionsBefore, '构建器不写决策台账');

    const read = openMemoryRead({ indexDir });
    try {
      read.verifyStampedFingerprint(computeTruthFingerprint(t.root));
      const card = read.getCard(seeded.card.cardId);
      assert.ok(card);
      assert.equal(card.contentHash, seeded.card.contentHash);
      assert.equal(card.displayCuesJson, seeded.card.displayCuesJson);
      assert.equal(card.discriminator, seeded.card.discriminator);
      assert.equal(card.occurredMs, Date.parse(t.eventA.time_range.started_at));
      // FTS 文本 = cues + 活跃非敏感别名；敏感词不进 FTS。
      const db = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
      try {
        const fts = db
          .prepare('SELECT cue_text FROM mem_card_fts WHERE card_id = ?')
          .get(seeded.card.cardId) as { cue_text: string };
        assert.ok(fts.cue_text.includes('线索甲'));
        assert.ok(fts.cue_text.includes('别名甲'));
        assert.ok(!fts.cue_text.includes('隐私词'), '敏感别名不得进 FTS 文本');
      } finally {
        db.close();
      }
    } finally {
      await read.close();
    }
    assert.deepEqual(truthHashes(t.root), hashes, '真源只读');
    assert.equal(
      listTree(indexDir).some((f) => f.startsWith(`${MEMORY_INDEX_FILE}.tmp-`)),
      false,
      'apply 成功后不得残留 tmp 文件',
    );
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('M4 幂等：同真值同决策连跑两次，row_hash_sum 与逐行 card_id/content_hash 全等、二次 diff 全 0', async () => {
  const t = makeTruth();
  try {
    const seeded = cardFor(t.eventA, ['线索甲'], [{ term: '别名甲', sensitive: 0 }], '区别于乙', T0);
    await seedIndex(t.root, [seeded], T0);
    const indexDir = indexDirOf(t.root);

    const first = await buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY });
    const second = await buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY });
    const revisions = readRevisions(indexDir);
    assert.equal(revisions.length, 3);
    assert.equal(revisions[1]?.row_hash_sum, revisions[2]?.row_hash_sum);
    assert.deepEqual(revisions[2]?.shadow_diff, { added: 0, removed: 0, changed: 0 });
    assert.equal(first.cards, second.cards);

    const read = openMemoryRead({ indexDir });
    try {
      const cards = read.listEffective(T0 + 10 * DAY);
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.cardId, seeded.card.cardId);
      assert.equal(cards[0]?.contentHash, seeded.card.contentHash);
    } finally {
      await read.close();
    }
  } finally {
    cleanupTempRoot(t.root);
  }
});

// ── M1：悬空锚点 ──────────────────────────────────────────────────────────

test('M1：篡改经历行致锚点悬空 → MemoryAnchorDanglingError、旧库完好、账本不增行、无 tmp 残留', async () => {
  const t = makeTruth();
  try {
    const seeded = cardFor(t.eventA, ['线索甲'], [], '区别于乙', T0);
    await seedIndex(t.root, [seeded], T0);
    const indexDir = indexDirOf(t.root);
    const revisionsFile = path.join(indexDir, 'revisions.jsonl');
    const revisionsBefore = fs.readFileSync(revisionsFile, 'utf8');

    // 手工删掉 e1 所在经历行（只留 e2/e3）—— eventA 的锚点悬空。
    const shard = path.join(t.root, 'experiences', '2026-11.jsonl');
    const lines = fs.readFileSync(shard, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const kept = lines.filter((l) => !(JSON.parse(l) as { id: string }).id.includes(t.e1));
    fs.writeFileSync(shard, `${kept.join('\n')}\n`, 'utf8');

    await assert.rejects(
      buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY }),
      MemoryAnchorDanglingError,
    );
    assert.equal(fs.readFileSync(revisionsFile, 'utf8'), revisionsBefore, '失败不得增账本行');
    assert.equal(
      listTree(indexDir).some((f) => f.startsWith(`${MEMORY_INDEX_FILE}.tmp-`)),
      false,
      '失败不得残留 tmp',
    );
    const read = openMemoryRead({ indexDir });
    try {
      assert.ok(read.getCard(seeded.card.cardId), '旧库必须仍可正常打开');
    } finally {
      await read.close();
    }
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('M1（无旧库）：悬空锚点 → 抛错且零产物（不创建 projection 目录）', async () => {
  const t = makeTruth();
  try {
    const shard = path.join(t.root, 'experiences', '2026-11.jsonl');
    const lines = fs.readFileSync(shard, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const kept = lines.filter((l) => !(JSON.parse(l) as { id: string }).id.includes(t.e3));
    fs.writeFileSync(shard, `${kept.join('\n')}\n`, 'utf8');

    const before = listTree(t.root);
    await assert.rejects(
      buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 }),
      MemoryAnchorDanglingError,
    );
    assert.deepEqual(listTree(t.root), before, '零产物');
  } finally {
    cleanupTempRoot(t.root);
  }
});

// ── M3：指纹过期 ──────────────────────────────────────────────────────────

test('M3：改一个真值字节后不重新 stamp → verifyStampedFingerprint 抛 MemoryIndexStaleError', async () => {
  const t = makeTruth();
  try {
    const seeded = cardFor(t.eventA, ['线索甲'], [], '区别于乙', T0);
    await seedIndex(t.root, [seeded], T0);
    await buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY });

    fs.appendFileSync(path.join(t.root, 'events', '2026-11.jsonl'), ' ', 'utf8');
    const read = openMemoryRead({ indexDir: indexDirOf(t.root) });
    try {
      assert.throws(
        () => read.verifyStampedFingerprint(computeTruthFingerprint(t.root)),
        MemoryIndexStaleError,
      );
    } finally {
      await read.close();
    }
  } finally {
    cleanupTempRoot(t.root);
  }
});

// ── M8：rename/fsync 中途失败 ─────────────────────────────────────────────

test('M8：rename 中途失败 → 旧库完好、tmp 清理、账本无半行、抛错', async () => {
  const t = makeTruth();
  const originalRename = fs.renameSync;
  try {
    const seeded = cardFor(t.eventA, ['线索甲'], [], '区别于乙', T0);
    await seedIndex(t.root, [seeded], T0);
    const indexDir = indexDirOf(t.root);
    const revisionsFile = path.join(indexDir, 'revisions.jsonl');
    const revisionsBefore = fs.readFileSync(revisionsFile, 'utf8');

    fs.renameSync = (() => {
      throw new Error('M8: 注入 rename 失败');
    }) as typeof fs.renameSync;
    try {
      await assert.rejects(
        buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY }),
        /M8: 注入 rename 失败/,
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(fs.readFileSync(revisionsFile, 'utf8'), revisionsBefore, '账本无半行');
    assert.equal(
      listTree(indexDir).some((f) => f.startsWith(`${MEMORY_INDEX_FILE}.tmp-`)),
      false,
      'tmp 必须被清理',
    );
    const read = openMemoryRead({ indexDir });
    try {
      assert.ok(read.getCard(seeded.card.cardId), '旧 sqlite 仍可正常打开');
    } finally {
      await read.close();
    }
  } finally {
    fs.renameSync = originalRename;
    cleanupTempRoot(t.root);
  }
});

test('M8：fsync 中途失败 → 旧库完好、tmp 清理、账本不增行', async () => {
  const t = makeTruth();
  const originalFsync = fs.fsyncSync;
  try {
    const seeded = cardFor(t.eventA, ['线索甲'], [], '区别于乙', T0);
    await seedIndex(t.root, [seeded], T0);
    const indexDir = indexDirOf(t.root);
    const revisionsBefore = fs.readFileSync(path.join(indexDir, 'revisions.jsonl'), 'utf8');

    fs.fsyncSync = (() => {
      throw new Error('M8: 注入 fsync 失败');
    }) as typeof fs.fsyncSync;
    try {
      await assert.rejects(
        buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY }),
        /M8: 注入 fsync 失败/,
      );
    } finally {
      fs.fsyncSync = originalFsync;
    }

    assert.equal(
      fs.readFileSync(path.join(indexDir, 'revisions.jsonl'), 'utf8'),
      revisionsBefore,
    );
    assert.equal(
      listTree(indexDir).some((f) => f.startsWith(`${MEMORY_INDEX_FILE}.tmp-`)),
      false,
    );
    const read = openMemoryRead({ indexDir });
    try {
      assert.ok(read.getCard(seeded.card.cardId));
    } finally {
      await read.close();
    }
  } finally {
    fs.fsyncSync = originalFsync;
    cleanupTempRoot(t.root);
  }
});

// ── M9：真值只读 + 输出隔离 ───────────────────────────────────────────────

test(
  'M9：chmod 0500 真值目录后构建成功，indexDir 之外零改动（POSIX-only，由审核方 Linux 补验）',
  { skip: process.platform === 'win32' ? 'POSIX-only，由审核方 Linux 补验' : false },
  async () => {
    const t = makeTruth();
    const expDir = path.join(t.root, 'experiences');
    const evDir = path.join(t.root, 'events');
    try {
      const seeded = cardFor(t.eventA, ['线索甲'], [], '区别于乙', T0);
      await seedIndex(t.root, [seeded], T0);
      const outsideBefore = listTree(t.root).filter((f) => !f.startsWith('projection/memory-index/'));
      const hashes = truthHashes(t.root);

      fs.chmodSync(expDir, 0o500);
      fs.chmodSync(evDir, 0o500);
      try {
        const report = await buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY });
        assert.equal(report.revision, 2);
        assert.equal(report.cards, 1);
      } finally {
        fs.chmodSync(expDir, 0o700);
        fs.chmodSync(evDir, 0o700);
      }

      const outsideAfter = listTree(t.root).filter((f) => !f.startsWith('projection/memory-index/'));
      assert.deepEqual(outsideAfter, outsideBefore, 'indexDir 之外零创建/修改');
      assert.deepEqual(truthHashes(t.root), hashes, '真值字节不变');
    } finally {
      cleanupTempRoot(t.root);
    }
  },
);

// ── 卡来源过滤与决策回放 ──────────────────────────────────────────────────

test('只收 closed+ready：open / pending 事件的卡被移除（shadowDiff.removed）', async () => {
  const t = makeTruth();
  try {
    const openEvent = eventRecord(ulid(), [t.e1], { status: 'open', closed_reason: null });
    const pendingEvent = eventRecord(ulid(), [t.e2], { summary_quality: 'pending', summary: null, summary_source: null });
    appendJsonl(path.join(t.root, 'events', '2026-11.jsonl'), openEvent);
    appendJsonl(path.join(t.root, 'events', '2026-11.jsonl'), pendingEvent);

    const a = cardFor(t.eventA, ['线索甲'], [], '甲', T0);
    const b = cardFor(openEvent, ['线索乙'], [], '乙', T0);
    const c = cardFor(pendingEvent, ['线索丙'], [], '丙', T0);
    await seedIndex(t.root, [a, b, c], T0);

    const report = await buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY });
    assert.equal(report.cards, 1);
    assert.deepEqual(report.shadowDiff, { added: 0, removed: 2, changed: 0 });
    const read = openMemoryRead({ indexDir: indexDirOf(t.root) });
    try {
      assert.ok(read.getCard(a.card.cardId));
      assert.equal(read.getCard(b.card.cardId), null);
      assert.equal(read.getCard(c.card.cardId), null);
    } finally {
      await read.close();
    }
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('决策回放：tombstone-card → superseded+expired_ms；invalidate → invalid+invalid_ms；active 计数如实', async () => {
  const t = makeTruth();
  try {
    const a = cardFor(t.eventA, ['线索甲'], [], '甲', T0);
    const b = cardFor(t.eventB, ['线索乙'], [], '乙', T0);
    await seedIndex(t.root, [a, b], T0);
    const indexDir = indexDirOf(t.root);

    const tombstoneAt = T0 + 2 * DAY;
    const invalidateAt = T0 + 3 * DAY;
    appendDecision(indexDir, {
      decision_id: ulid(),
      at_ms: tombstoneAt,
      action: 'tombstone-card',
      card_id: a.card.cardId,
      event_id: t.eventA.id,
      anchor_json: a.card.anchorJson,
      content_hash: a.card.contentHash,
      model_tag: 'rules-v1',
      reason: 'tombstone: 测试作废',
      created_by: 'her',
    });
    appendDecision(indexDir, {
      decision_id: ulid(),
      at_ms: invalidateAt,
      action: 'invalidate',
      card_id: b.card.cardId,
      event_id: t.eventB.id,
      anchor_json: b.card.anchorJson,
      content_hash: b.card.contentHash,
      model_tag: 'rules-v1',
      reason: 'invalidate: 测试失效',
      created_by: 'her',
    });

    const report = await buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + 4 * DAY });
    assert.equal(report.cards, 2, '行仍在（tombstone 记账，不物理删除）');
    const revisions = readRevisions(indexDir);
    assert.equal(revisions[1]?.card_count, 0, 'active 卡数为 0');

    const read = openMemoryRead({ indexDir });
    try {
      const cardA = read.getCard(a.card.cardId);
      assert.equal(cardA?.status, 'superseded');
      assert.equal(cardA?.expiredMs, tombstoneAt);
      const cardB = read.getCard(b.card.cardId);
      assert.equal(cardB?.status, 'invalid');
      assert.equal(cardB?.invalidMs, invalidateAt);
      assert.deepEqual(read.listEffective(T0 + 10 * DAY), []);
    } finally {
      await read.close();
    }
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('重建搬运 mem_miss / mem_audit_* 观测行（不抹掉历史观测）', async () => {
  const t = makeTruth();
  try {
    const seeded = cardFor(t.eventA, ['线索甲'], [], '甲', T0);
    await seedIndex(t.root, [seeded], T0);
    const indexDir = indexDirOf(t.root);
    const dbFile = path.join(indexDir, MEMORY_INDEX_FILE);

    const db = new DatabaseSync(dbFile);
    try {
      db.prepare(
        'INSERT INTO mem_miss(id, term_norm, term_hash, channel, anchor_event_id, anchor_json, returned_count, observed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '漏召词', 'hash-1', 'dsh', null, null, 0, T0);
      db.prepare(
        'INSERT INTO mem_audit_run(run_id, created_ms, sample_n, probe_set_version, model_tag, metrics_json, notes_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('run-1', T0, 1, 'v1', 'rules-v1', '{}', '{}');
      db.prepare(
        'INSERT INTO mem_audit_item(run_id, item_no, probe_type, expected_ref, returned_refs_json, passed, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('run-1', 1, 'gold', 'ev-1', '[]', 1, '{}');
    } finally {
      db.close();
    }

    const report = await buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY });
    assert.equal(report.misses, 1);
    const after = new DatabaseSync(dbFile, { readOnly: true });
    try {
      assert.equal((after.prepare('SELECT COUNT(*) AS n FROM mem_miss').get() as { n: number }).n, 1);
      assert.equal((after.prepare('SELECT COUNT(*) AS n FROM mem_audit_run').get() as { n: number }).n, 1);
      assert.equal((after.prepare('SELECT COUNT(*) AS n FROM mem_audit_item').get() as { n: number }).n, 1);
    } finally {
      after.close();
    }
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('sinceRevision：只记入账本 reason，结果仍全量比对（§4.6 口径）', async () => {
  const t = makeTruth();
  try {
    const seeded = cardFor(t.eventA, ['线索甲'], [], '甲', T0);
    await seedIndex(t.root, [seeded], T0);
    await buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + DAY });
    await buildMemoryIndex({
      dataRoot: t.root,
      dryRun: false,
      nowMs: T0 + 2 * DAY,
      sinceRevision: 1,
    });
    const revisions = readRevisions(indexDirOf(t.root));
    assert.equal(revisions.length, 3);
    assert.ok(revisions[2]?.reason.includes('since-revision'));
    assert.deepEqual(revisions[2]?.shadow_diff, { added: 0, removed: 0, changed: 0 });
    await assert.rejects(
      buildMemoryIndex({ dataRoot: t.root, dryRun: true, nowMs: T0, sinceRevision: 0 }),
      IntegrityError,
    );
  } finally {
    cleanupTempRoot(t.root);
  }
});

// ── CLI（继承 backfill 纪律；--data-root 缺省退出码 2，方案 §11.2）─────────

test('CLI：无参 → 打印用法并退出码 2（杜绝隐式真实根）', () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes('用法') || result.stdout.includes('用法'));
});

test('CLI：--help → 用法 + 退出码 0', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('--data-root'));
  assert.ok(result.stdout.includes('--apply'));
});

test('CLI：--data-root <tmp> --json 默认 dry-run → 退出码 0、revision=null、真实根零写入', () => {
  const t = makeTruth();
  try {
    const before = listTree(t.root);
    const result = runCli(['--data-root', t.root, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { revision: number | null; outputDir: string };
    assert.equal(report.revision, null);
    assert.ok(report.outputDir.startsWith(os.tmpdir()));
    assert.deepEqual(listTree(t.root), before);
    cleanupTempRoot(report.outputDir);
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('CLI：--apply --yes --json → 退出码 0、revision=1、仍先打印指纹与 diff（stderr，stdout 纯 JSON）', () => {
  const t = makeTruth();
  try {
    const result = runCli(['--data-root', t.root, '--apply', '--yes', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      revision: number | null;
      outputDir: string;
      fingerprint: { aggregate: string };
    };
    assert.equal(report.revision, 1);
    assert.equal(report.outputDir, indexDirOf(t.root));
    assert.ok(fs.existsSync(path.join(indexDirOf(t.root), MEMORY_INDEX_FILE)));
    assert.equal(countLines(path.join(indexDirOf(t.root), 'revisions.jsonl')), 1);
    // --yes 只跳过交互确认，指纹与 diff 仍必须先打印（§11.1）。
    assert.ok(result.stderr.includes(report.fingerprint.aggregate), '必须先打印真值指纹');
    assert.ok(result.stderr.includes('影子 diff'), '必须先打印影子 diff');
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('CLI：--apply 先打印指纹与 diff、回答 y 才真写（二次确认，--json 模式）', () => {
  const t = makeTruth();
  try {
    const fp = computeTruthFingerprint(t.root).aggregate;
    const result = runCli(['--data-root', t.root, '--apply', '--json'], 'y\n');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stderr.includes(fp), '确认前必须打印真值指纹');
    assert.ok(result.stderr.includes('影子 diff'), '确认前必须打印影子 diff');
    assert.ok(result.stderr.includes('确认写入'), '必须发起二次确认');
    const report = JSON.parse(result.stdout) as { revision: number | null };
    assert.equal(report.revision, 1);
    assert.equal(countLines(path.join(indexDirOf(t.root), 'revisions.jsonl')), 1);
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('CLI：--apply 回答 n → 取消、退出码 0、真实根零写入', () => {
  const t = makeTruth();
  try {
    const before = listTree(t.root);
    const result = runCli(['--data-root', t.root, '--apply', '--json'], 'n\n');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stderr.includes('已取消'));
    assert.equal(result.stdout.trim(), '', '取消时不得输出报告');
    assert.deepEqual(listTree(t.root), before, '取消必须零写入');
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('CLI：--apply EOF（无输入）→ 视为取消、退出码 0、零写入', () => {
  const t = makeTruth();
  try {
    const before = listTree(t.root);
    const result = runCli(['--data-root', t.root, '--apply'], '');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stderr.includes('已取消'));
    assert.deepEqual(listTree(t.root), before, 'EOF 取消必须零写入');
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('CLI：--apply 人读模式 stdout 打印指纹/diff/确认，回答 y 真写', () => {
  const t = makeTruth();
  try {
    const fp = computeTruthFingerprint(t.root).aggregate;
    const result = runCli(['--data-root', t.root, '--apply'], 'y\n');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(fp), '人读模式指纹进 stdout');
    assert.ok(result.stdout.includes('确认写入'));
    assert.ok(result.stdout.includes('revision'));
    assert.equal(countLines(path.join(indexDirOf(t.root), 'revisions.jsonl')), 1);
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('CLI：--apply 悬空锚点 → 退出码 1、零产物（失败必须非零退出）', () => {
  const t = makeTruth();
  try {
    const shard = path.join(t.root, 'experiences', '2026-11.jsonl');
    const lines = fs.readFileSync(shard, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const kept = lines.filter((l) => !(JSON.parse(l) as { id: string }).id.includes(t.e3));
    fs.writeFileSync(shard, `${kept.join('\n')}\n`, 'utf8');
    const before = listTree(t.root);
    const result = runCli(['--data-root', t.root, '--apply', '--yes']);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('悬空'), result.stderr);
    assert.deepEqual(listTree(t.root), before, '失败零产物');
  } finally {
    cleanupTempRoot(t.root);
  }
});

test('CLI：未知参数 / --data-root 缺值 / --since-revision 非正整数 → 退出码 2', () => {
  const t = makeTruth();
  try {
    assert.equal(runCli(['--data-root', t.root, '--bogus']).status, 2);
    assert.equal(runCli(['--data-root']).status, 2);
    assert.equal(runCli(['--data-root', t.root, '--since-revision', 'abc']).status, 2);
    assert.equal(runCli(['--data-root', t.root, '--since-revision', '0']).status, 2);
    assert.deepEqual(listTree(t.root).filter((f) => f.startsWith('projection')), []);
  } finally {
    cleanupTempRoot(t.root);
  }
});

// ── #44 §8.6：miss → add-alias → rebuild 端到端两源一致 ─────────────────────

test('miss→add-alias→rebuild：补别名只改两列、cue 不变、重建两源一致且零漂移', async () => {
  const t = makeTruth();
  const hashes = truthHashes(t.root);
  try {
    const seeded = cardFor(
      t.eventA,
      ['线索甲', '线索乙'],
      [{ term: '别名甲', sensitive: 0 }],
      '区别于事件乙',
      T0,
    );
    await seedIndex(t.root, [seeded], T0);
    const indexDir = indexDirOf(t.root);
    const cardId = seeded.card.cardId;
    const cuesBefore = seeded.card.displayCuesJson;
    const decisionsBefore = fs
      .readFileSync(path.join(indexDir, 'decisions.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '').length;

    // 写柄补一条 miss 别名（模拟她回查下钻成功后补检索别名）。
    const write = openMemoryWrite({ indexDir });
    try {
      const outcome = write.addMissAlias({ term: '  她回查补入  ', cardId, sensitive: 0, atMs: T0 + DAY });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.ok && outcome.changed, true, '首次补入应真实写入');
    } finally {
      await write.close();
    }

    // 写后：只补别名不碰展示线索、source 恒 miss、hash 可重算、两源自洽。
    const read = openMemoryRead({ indexDir });
    try {
      const card = read.getCard(cardId);
      assert.ok(card);
      assert.equal(card.displayCuesJson, cuesBefore, '只补别名不碰 display_cues');
      const aliases = JSON.parse(card.aliasesJson) as Array<{ term: string; source: string; sensitive: 0 | 1 }>;
      assert.deepEqual(
        aliases.map((a) => a.term).sort(),
        ['她回查补入', '别名甲'].sort(),
        '写柄已规范化（去首尾空白）',
      );
      assert.ok(aliases.every((a) => a.source === 'miss'));
      assert.equal(
        card.contentHash,
        computeContentHash(card.anchorJson, card.displayCuesJson, card.aliasesJson, card.discriminator),
        'contentHash 与两列同源自洽',
      );
    } finally {
      await read.close();
    }

    const decisions = readDecisions(indexDir);
    assert.equal(decisions.length, decisionsBefore + 1, '真实新增才追加一条决策');
    assert.equal(decisions[decisions.length - 1]?.action, 'add-alias');

    // 重建：读取旧 aliasesJson 重放别名，两源须一致且零漂移。
    const report = await buildMemoryIndex({ dataRoot: t.root, dryRun: false, nowMs: T0 + 2 * DAY });
    assert.equal(report.aliases, 2, '重建后别名数保持 2');
    assert.deepEqual(report.shadowDiff, { added: 0, removed: 0, changed: 0 }, '重建零漂移');

    const after = openMemoryRead({ indexDir });
    try {
      const card = after.getCard(cardId);
      assert.ok(card);
      assert.equal(card.displayCuesJson, cuesBefore);
      const aliases = JSON.parse(card.aliasesJson) as Array<{ term: string }>;
      assert.equal(aliases.length, 2);
      const db = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
      try {
        const rows = db
          .prepare("SELECT term_norm, source, status FROM mem_alias WHERE card_id = ? AND status = 'active'")
          .all(cardId) as Array<{ term_norm: string; source: string; status: string }>;
        assert.deepEqual(rows.map((r) => r.term_norm).sort(), aliases.map((a) => a.term).sort(), '两源一致');
        assert.ok(rows.every((r) => r.source === 'miss'));
      } finally {
        db.close();
      }
    } finally {
      await after.close();
    }

    // 真源只读：三 jsonl 哈希逐字不变。
    for (const [file, hash] of hashes) {
      assert.equal(
        createHash('sha256').update(fs.readFileSync(path.join(t.root, file))).digest('hex'),
        hash,
        `真源 ${file} 必须只读`,
      );
    }
  } finally {
    cleanupTempRoot(t.root);
  }
});