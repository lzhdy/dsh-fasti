/**
 * C4 漏召观测测试 —— miss.ts + 写柄 recordMiss + --replay-misses CLI
 * （方案 §4.9 / §6.5③ / §11.3 M11；裁决 H1/H2/H11，记录见 §11.7）。
 *
 * 纪律：
 *  - 纯函数单测用 :memory: 库，CLI/写柄单例用 tests/helpers 临时根；真实数据根零接触；
 *  - M11 三层反证：类型层（编译期断言，tsc 守门）+ 运行时 Object.keys 白名单拒收 + PRAGMA 列集冻结八列；
 *  - 重放行数倍增、term_hash 集合一致（§6.5③）；每行新 ulid、append-only、不去重；
 *  - --replay-misses 独立回放模式：默认 dry-run 零写入且不跑构建流；--apply 经既有二次确认；
 *  - 未传 --replay-misses 时构建流回归不变（dry-run/apply 报告与退出码）。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { EventRecord } from '../../src/contract/event.ts';
import { IntegrityError } from '../../src/core/errors.ts';
import { appendJsonl } from '../../src/core/jsonl.ts';
import { isUlid, ulid } from '../../src/core/ulid.ts';
import { searchCards } from '../../src/memory/bm25.ts';
import { computeMissTermHash, insertMissRow, validateMissInput } from '../../src/memory/miss.ts';
import { MEMORY_SCHEMA } from '../../src/memory/schema.ts';
import {
  MEMORY_INDEX_FILE,
  openMemoryWrite,
  syncFts,
  writeAliases,
  writeCards,
} from '../../src/memory/store.ts';
import type { AliasRow, MemoryCard, MissObservationInput } from '../../src/memory/types.ts';
import { cleanupTempRoot, countLines, listTree, makeExperience, makeTempRoot } from '../helpers.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildCli = path.join(repoRoot, 'scripts', 'build-memory-index.ts');
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

// ── M11 类型层反证（编译期）──────────────────────────────────────────────
// 若 MissObservationInput 未来被加入任何原始查询字段，下列条件类型变为 false，
// `const ... = true` 即在 tsc（npm run typecheck）阶段失败 —— 类型层守门。
type AssertNoRawQuery = 'rawQuery' extends keyof MissObservationInput ? false : true;
type AssertNoText = 'text' extends keyof MissObservationInput ? false : true;
type AssertNoRawText = 'raw_text' extends keyof MissObservationInput ? false : true;
const m11TypeGuard: AssertNoRawQuery & AssertNoText & AssertNoRawText = true;

// ── 夹具 ──────────────────────────────────────────────────────────────────

/** :memory: 库 + 全量 schema（纯函数单测用，不落盘）。 */
function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const statement of MEMORY_SCHEMA) {
    db.exec(statement);
  }
  return db;
}

function validInput(overrides: Partial<MissObservationInput> = {}): MissObservationInput {
  return {
    termNorm: '漏召词',
    channel: 'dsh',
    anchorEventId: null,
    anchorIds: null,
    returnedCount: 0,
    observedMs: T0,
    ...overrides,
  };
}

function runCli(
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [buildCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60000,
    input,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function indexDirOf(root: string): string {
  return path.join(root, 'projection', 'memory-index');
}

function missRows(root: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path.join(indexDirOf(root), MEMORY_INDEX_FILE), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM mem_miss ORDER BY observed_ms, id').all() as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
}

/** 临时根 + 3 经历 + 2 closed/ready 事件（构建流回归用，无人工种子）。 */
function makeTruth(): { root: string } {
  const root = makeTempRoot('miss-test-');
  const ids = [ulid(), ulid(), ulid()];
  // 候选池口径：经历 occurred_at 必须落在所属事件时间窗内（闭区间）。
  const experienceTimes = [T0, T0 + Math.floor(DAY / 2), T0 + 4 * DAY];
  for (const [i, id] of ids.entries()) {
    const at = experienceTimes[i]!;
    appendJsonl(
      path.join(root, 'experiences', '2026-11.jsonl'),
      makeExperience({ id, tick: i, occurred_at: iso(at), recorded_at: iso(at) }),
    );
  }
  const event = (id: string, anchors: string[], start: number): EventRecord => ({
    id,
    schema_version: 1,
    version: 1,
    status: 'closed',
    closed_reason: 'silence',
    pointers: anchors.map((a) => ({ id: a })),
    time_range: { started_at: iso(start), ended_at: iso(start + DAY) },
    assembled_at: iso(start + DAY),
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
    created_at: iso(start + DAY),
    channel: 'dsh',
    boundary_candidates: [],
  });
  appendJsonl(path.join(root, 'events', '2026-11.jsonl'), event(ulid(), [ids[0]!, ids[1]!], T0));
  appendJsonl(
    path.join(root, 'events', '2026-11.jsonl'),
    event(ulid(), [ids[2]!], T0 + 4 * DAY),
  );
  return { root };
}

function writeObs(root: string, value: unknown): string {
  const file = path.join(root, 'observations.json');
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

// ── 纯函数：computeMissTermHash ───────────────────────────────────────────

test('computeMissTermHash：sha256(termNorm) hex、确定性、与独立实现一致', () => {
  const term = '漏召词';
  const expected = createHash('sha256').update(term).digest('hex');
  assert.equal(computeMissTermHash(term), expected);
  assert.match(computeMissTermHash(term), /^[0-9a-f]{64}$/);
  assert.equal(computeMissTermHash(term), computeMissTermHash(term));
  assert.notEqual(computeMissTermHash('甲'), computeMissTermHash('乙'));
});

// ── 纯函数：validateMissInput 表驱动（运行时白名单 + 字段校验）────────────

test('validateMissInput：合法六字段通过（含 null 锚点与数组锚点）', () => {
  assert.doesNotThrow(() => validateMissInput(validInput()));
  assert.doesNotThrow(() =>
    validateMissInput(validInput({ anchorEventId: 'ev-1', anchorIds: ['e1', 'e2'] })),
  );
  assert.doesNotThrow(() => validateMissInput(validInput({ anchorIds: [] })));
});

test('validateMissInput：白名单外键即拒（M11 运行时层）', () => {
  for (const extra of ['rawQuery', 'text', 'raw_text', 'query', 'foo']) {
    const poisoned = { ...validInput(), [extra]: '原始问句全文' } as MissObservationInput;
    assert.throws(() => validateMissInput(poisoned), IntegrityError, `键 ${extra} 应被拒`);
  }
});

test('validateMissInput：字段越界表驱动整份拒绝', () => {
  const bad: Array<[string, Partial<MissObservationInput>]> = [
    ['termNorm 空串', { termNorm: '' }],
    ['termNorm 非字符串', { termNorm: 123 as unknown as string }],
    ['channel 空串', { channel: '' }],
    ['channel 非字符串', { channel: null as unknown as string }],
    ['returnedCount 负', { returnedCount: -1 }],
    ['returnedCount 非整数', { returnedCount: 1.5 }],
    ['returnedCount NaN', { returnedCount: Number.NaN }],
    ['observedMs 负', { observedMs: -1 }],
    ['observedMs NaN', { observedMs: Number.NaN }],
    ['observedMs Infinity', { observedMs: Number.POSITIVE_INFINITY }],
    ['observedMs 非数', { observedMs: 'x' as unknown as number }],
    ['anchorEventId 非 string|null', { anchorEventId: 5 as unknown as string }],
    ['anchorIds 非数组', { anchorIds: 'e1' as unknown as string[] }],
    ['anchorIds 含非字符串', { anchorIds: [1] as unknown as string[] }],
  ];
  for (const [label, overrides] of bad) {
    assert.throws(() => validateMissInput(validInput(overrides)), IntegrityError, label);
  }
});

test('validateMissInput：缺必填字段 / 非对象即拒', () => {
  const missing = validInput() as unknown as Record<string, unknown>;
  delete missing['termNorm'];
  assert.throws(() => validateMissInput(missing as unknown as MissObservationInput), IntegrityError);
  assert.throws(() => validateMissInput(null as unknown as MissObservationInput), IntegrityError);
  assert.throws(() => validateMissInput('x' as unknown as MissObservationInput), IntegrityError);
});

// ── 低层：insertMissRow ───────────────────────────────────────────────────

test('insertMissRow：落行字段全对、返回 ULID、term_hash=sha256、anchor_json 快照', () => {
  const db = memoryDb();
  try {
    const input = validInput({ anchorEventId: 'ev-1', anchorIds: ['e1', 'e2'], returnedCount: 3 });
    const id = insertMissRow(db, input);
    assert.ok(isUlid(id), '返回 id 必须是 ULID');
    const row = db.prepare('SELECT * FROM mem_miss WHERE id = ?').get(id) as Record<string, unknown>;
    assert.equal(row['term_norm'], input.termNorm);
    assert.equal(row['term_hash'], createHash('sha256').update(input.termNorm).digest('hex'));
    assert.equal(row['channel'], 'dsh');
    assert.equal(row['anchor_event_id'], 'ev-1');
    assert.equal(row['anchor_json'], JSON.stringify(['e1', 'e2']));
    assert.equal(row['returned_count'], 3);
    assert.equal(row['observed_ms'], T0);
  } finally {
    db.close();
  }
});

test('insertMissRow：anchorIds=null → anchor_json=null；anchorEventId=null 落 NULL', () => {
  const db = memoryDb();
  try {
    const id = insertMissRow(db, validInput());
    const row = db.prepare('SELECT * FROM mem_miss WHERE id = ?').get(id) as Record<string, unknown>;
    assert.equal(row['anchor_json'], null);
    assert.equal(row['anchor_event_id'], null);
  } finally {
    db.close();
  }
});

test('insertMissRow：非法入参拒收且零行（复用同一 validateMissInput）', () => {
  const db = memoryDb();
  try {
    const poisoned = { ...validInput(), rawQuery: '原始问句' } as MissObservationInput;
    assert.throws(() => insertMissRow(db, poisoned), IntegrityError);
    const count = db.prepare('SELECT COUNT(*) AS n FROM mem_miss').get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    db.close();
  }
});

test('insertMissRow：同输入重复 → 行数倍增、id 各异、term_hash 集合一致（§6.5③）', () => {
  const db = memoryDb();
  try {
    const input = validInput();
    const id1 = insertMissRow(db, input);
    const id2 = insertMissRow(db, input);
    assert.notEqual(id1, id2, '每行新 ulid');
    const rows = db.prepare('SELECT * FROM mem_miss').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2, 'append-only 不去重，行数倍增');
    const hashes = new Set(rows.map((r) => r['term_hash']));
    assert.equal(hashes.size, 1, 'term_hash 集合一致');
  } finally {
    db.close();
  }
});

// ── M11 第三层：PRAGMA 列集冻结 ───────────────────────────────────────────

test('M11 读库反证：mem_miss 列集冻结八列、无任何原始查询列', () => {
  const db = memoryDb();
  try {
    const cols = (db.prepare('PRAGMA table_info(mem_miss)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.deepEqual(cols, [
      'id',
      'term_norm',
      'term_hash',
      'channel',
      'anchor_event_id',
      'anchor_json',
      'returned_count',
      'observed_ms',
    ]);
    for (const forbidden of ['raw_query', 'rawquery', 'text', 'raw_text', 'query', 'summary', 'body']) {
      assert.ok(!cols.includes(forbidden), `不得出现原始查询列 ${forbidden}`);
    }
    // mem_miss 无 FTS 虚表（schema 冻结）。
    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mem_miss%'")
      .all() as Array<{ name: string }>;
    assert.deepEqual(fts.map((t) => t.name), ['mem_miss']);
  } finally {
    db.close();
  }
});

test('M11 类型层反证：编译期断言成立（tsc 守门，运行时恒真）', () => {
  assert.equal(m11TypeGuard, true);
});

// ── 写柄 recordMiss 委托（H1）─────────────────────────────────────────────

test('写柄 recordMiss：委托 insertMissRow 落行、返回 void、单例纪律不破', async () => {
  const root = makeTempRoot('miss-handle-');
  try {
    const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
    try {
      const result = handle.recordMiss(validInput({ termNorm: '委托词' }));
      assert.equal(result, undefined, '接口 void');
      handle.recordMiss(validInput({ termNorm: '委托词' }));
    } finally {
      await handle.close();
    }
    const rows = missRows(root);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r['term_norm'] === '委托词'));
  } finally {
    cleanupTempRoot(root);
  }
});

// ── M11 敏感词：FTS 空 / 精确可达 ─────────────────────────────────────────

test('M11 敏感词：sensitive=1 别名不进 FTS 文本、精确路径可达', () => {
  const db = memoryDb();
  try {
    const cardId = 'mc_sensitive_test';
    const aliases: AliasRow[] = [
      { termNorm: 'secretword', cardId, source: 'miss', sensitive: 1, status: 'active', createdMs: T0, hitCount: 0, lastHitMs: null },
      { termNorm: 'betaterm', cardId, source: 'miss', sensitive: 0, status: 'active', createdMs: T0, hitCount: 0, lastHitMs: null },
    ];
    const card: MemoryCard = {
      cardId,
      eventId: 'ev-1',
      anchorJson: JSON.stringify(['e1']),
      channel: 'dsh',
      cardType: 'event',
      selection: 'selected',
      weight: 0,
      displayCuesJson: JSON.stringify(['alpha']),
      aliasesJson: JSON.stringify([
        { term: 'secretword', source: 'miss', sensitive: 1 },
        { term: 'betaterm', source: 'miss', sensitive: 0 },
      ]),
      discriminator: 'disc',
      entityHintJson: null,
      occurredMs: T0,
      endedMs: T0 + DAY,
      validMs: T0,
      invalidMs: null,
      createdMs: T0,
      expiredMs: null,
      status: 'active',
      contentHash: 'x',
      hitCount: 0,
      lastHitMs: null,
      schemaVersion: 1,
    };
    writeCards(db, [card]);
    writeAliases(db, aliases);
    syncFts(db, [cardId]);

    const ftsRow = db.prepare('SELECT cue_text FROM mem_card_fts WHERE card_id = ?').get(cardId) as {
      cue_text: string;
    };
    assert.ok(!ftsRow.cue_text.includes('secretword'), '敏感词不得进 FTS 文本');
    assert.ok(ftsRow.cue_text.includes('betaterm'), '非敏感别名进 FTS');

    // 敏感词精确路径可达（任意长度），FTS 文本恒不可见。
    const hit = searchCards(db, { text: 'secretword', atMs: T0 + DAY });
    assert.equal(hit.length, 1);
    assert.ok(hit[0]!.matchedTerms.includes('secretword'));
  } finally {
    db.close();
  }
});

// ── CLI：--replay-misses 独立回放模式 ─────────────────────────────────────

test('--replay-misses dry-run：校验 + 行数/哈希摘要、零写入、不跑构建流', () => {
  const root = makeTempRoot('miss-replay-');
  try {
    const file = writeObs(root, [validInput({ termNorm: '甲' }), validInput({ termNorm: '乙' })]);
    const before = listTree(root);
    const result = runCli(['--data-root', root, '--replay-misses', file, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { rows: number; termHashes: string[] };
    assert.equal(report.rows, 2);
    assert.equal(report.termHashes.length, 2);
    assert.ok(report.termHashes.includes(computeMissTermHash('甲')));
    assert.deepEqual(listTree(root), before, 'dry-run 零写入');
    assert.ok(!fs.existsSync(indexDirOf(root)), '不创建索引目录（不跑构建流）');
  } finally {
    cleanupTempRoot(root);
  }
});

test('--replay-misses --apply --yes：经写柄逐条落行；重放行数倍增哈希集合一致', () => {
  const root = makeTempRoot('miss-replay-apply-');
  try {
    const file = writeObs(root, [validInput({ termNorm: '甲' }), validInput({ termNorm: '乙' })]);
    const first = runCli(['--data-root', root, '--replay-misses', file, '--apply', '--yes']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(missRows(root).length, 2);
    const second = runCli(['--data-root', root, '--replay-misses', file, '--apply', '--yes']);
    assert.equal(second.status, 0, second.stderr);
    const rows = missRows(root);
    assert.equal(rows.length, 4, '重放行数倍增');
    assert.equal(new Set(rows.map((r) => r['term_hash'])).size, 2, '哈希集合一致');
    assert.equal(new Set(rows.map((r) => r['id'])).size, 4, '每行新 id');
  } finally {
    cleanupTempRoot(root);
  }
});

test('--replay-misses：白名单外键 / 坏 JSON / 非数组 / 缺文件 → 退出码非零、零写入', () => {
  const root = makeTempRoot('miss-replay-bad-');
  try {
    const poisoned = writeObs(root, [{ ...validInput(), rawQuery: '原始问句' }]);
    const bad = runCli(['--data-root', root, '--replay-misses', poisoned]);
    assert.notEqual(bad.status, 0);
    assert.ok(!fs.existsSync(indexDirOf(root)));

    const broken = path.join(root, 'broken.json');
    fs.writeFileSync(broken, '{not json', 'utf8');
    assert.notEqual(runCli(['--data-root', root, '--replay-misses', broken]).status, 0);

    const nonArray = writeObs(root, { termNorm: '甲' });
    assert.notEqual(runCli(['--data-root', root, '--replay-misses', nonArray]).status, 0);

    const missing = path.join(root, 'nope.json');
    assert.notEqual(runCli(['--data-root', root, '--replay-misses', missing]).status, 0);
    assert.ok(!fs.existsSync(indexDirOf(root)), '全程零写入');
  } finally {
    cleanupTempRoot(root);
  }
});

test('--replay-misses --apply 二次确认：n / EOF 取消（退出码 0、零写入）', () => {
  const root = makeTempRoot('miss-replay-confirm-');
  try {
    const file = writeObs(root, [validInput()]);
    const no = runCli(['--data-root', root, '--replay-misses', file, '--apply'], 'n\n');
    assert.equal(no.status, 0);
    assert.ok(!fs.existsSync(indexDirOf(root)), 'n 取消零写入');
    const eof = runCli(['--data-root', root, '--replay-misses', file, '--apply'], '');
    assert.equal(eof.status, 0);
    assert.ok(!fs.existsSync(indexDirOf(root)), 'EOF 取消零写入');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 构建流回归（未传 --replay-misses 字节级不变）──────────────────────────

test('回归：未传 --replay-misses 时构建流 dry-run/apply 报告与退出码不变', () => {
  const t = makeTruth();
  try {
    const dry = runCli(['--data-root', t.root, '--json']);
    assert.equal(dry.status, 0, dry.stderr);
    const report = JSON.parse(dry.stdout) as {
      revision: number | null;
      cards: number;
      shadowDiff: { added: number; removed: number; changed: number };
    };
    assert.equal(report.revision, null);
    assert.equal(report.cards, 0, '零正文：未种子不建卡（C2 口径不变）');
    assert.deepEqual(report.shadowDiff, { added: 0, removed: 0, changed: 0 });
    assert.ok(!fs.existsSync(indexDirOf(t.root)), 'dry-run 零写入');

    const applied = runCli(['--data-root', t.root, '--apply', '--yes']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(countLines(path.join(indexDirOf(t.root), 'revisions.jsonl')), 1);
    assert.equal(missRows(t.root).length, 0, '构建流不灌漏召');
  } finally {
    cleanupTempRoot(t.root);
  }
});