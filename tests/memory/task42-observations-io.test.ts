/**
 * #42 · B2 第三批：观测物理写入（正本 §3.3 观测落点、§3.6 V-08 torn-read 尾行容忍、
 * §3.4 观测面与决策面物理隔离）。
 *
 * 被测 seam（写者在 B2 内落地，批内红→绿）：`src/memory/drain-observations.ts`
 *  - `DRAIN_OBSERVATIONS_FILE` 常量；
 *  - `drainObservationsPath(indexDir)`：落点固定在投影目录内（indexDir 同级）；
 *  - `openDrainObservationStore(indexDir)`：append-only 写面 + 尾行容忍读面。
 *
 * 纪律：只写测试；全部临时 DSH_HOME，真实数据根零写入；观测行永不进 decisions 台账、
 * 永不进 mem_miss 表、不新增表。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { CorruptedError, SchemaError } from '../../src/core/errors.ts';
import { DECISIONS_FILE, REVISIONS_FILE } from '../../src/memory/ledger.ts';
import {
  observationId,
  validateObservation,
  type DrainObservation,
} from '../../src/memory/observations.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../src/memory/store.ts';
import type { RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, countLines, listTree, makeTempRoot } from '../helpers.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = Date.parse('2026-11-08T02:13:20.000Z');
const EVENT_ID = 'evt-obs-io-1';
const VERSION_TOKEN = `${EVENT_ID}#v1`;

// ── seam 形状镜像（与 drain-observations.ts 导出同构）──────────────────────────

interface ObservationStore {
  readonly append: (row: DrainObservation) => void;
  readonly read: () => DrainObservation[];
}

interface DrainObsModule {
  readonly DRAIN_OBSERVATIONS_FILE: string;
  readonly drainObservationsPath: (indexDir: string) => string;
  readonly openDrainObservationStore: (indexDir: string) => ObservationStore;
}

const OBS_URL = new URL('../../src/memory/drain-observations.ts', import.meta.url);

async function loadObsModule(): Promise<Partial<DrainObsModule>> {
  return (await import(OBS_URL.href)) as Partial<DrainObsModule>;
}

/** 合法观测行夹具；reason_code 变化时 id 按内容键重算（§3.5）。 */
function makeRow(overrides: Partial<DrainObservation> = {}): DrainObservation {
  const reasonCode = overrides.reason_code ?? 'anchor-not-found';
  const id = observationId(EVENT_ID, VERSION_TOKEN, reasonCode);
  return {
    id,
    event_id: EVENT_ID,
    version_token: VERSION_TOKEN,
    reason_code: reasonCode,
    snapshot_hash: 'snap-obs-io-1',
    at_ms: T0,
    ...overrides,
  };
}

// 决策面专属键（观测行绝不允许出现）。
const DECISION_ONLY_KEYS = [
  'decision_id',
  'action',
  'card_id',
  'anchor_json',
  'content_hash',
  'model_tag',
  'reason',
  'created_by',
] as const;

// 观测面专属键（决策行绝不允许出现）。
const OBSERVATION_ONLY_KEYS = ['version_token', 'reason_code', 'snapshot_hash'] as const;

interface Seeded {
  readonly root: string;
  readonly indexDir: string;
  readonly projectionDir: string;
}

async function seedBlankIndex(): Promise<Seeded> {
  const root = makeTempRoot('mem-obs-io-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const projectionDir = path.dirname(indexDir);
  const handle = openMemoryWrite({ indexDir });
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 1,
      truth_fingerprint: 'fp-obs-io',
      prior_revision: null,
      card_count: 0,
      alias_count: 0,
      row_hash_sum: 'rh-obs-io',
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

function countMissRows(indexDir: string): number {
  const dbFile = path.join(indexDir, MEMORY_INDEX_FILE);
  if (!fs.existsSync(dbFile)) {
    return 0;
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM mem_miss').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

test('观测落点：drain-observations.jsonl 固定落在投影目录内（不进 indexDir、不进真源）', async () => {
  const mod = await loadObsModule();
  assert.equal(typeof mod.drainObservationsPath, 'function', '须导出 drainObservationsPath');
  const seed = await seedBlankIndex();
  try {
    const obsPath = mod.drainObservationsPath!(seed.indexDir);
    assert.equal(path.basename(obsPath), 'drain-observations.jsonl', '文件名须为 drain-observations.jsonl');
    assert.equal(path.dirname(obsPath), seed.projectionDir, '落点须在投影目录内');
    assert.ok(!obsPath.startsWith(seed.indexDir), '观测文件不得落在 memory-index 目录内');

    const store = mod.openDrainObservationStore!(seed.indexDir);
    store.append(makeRow());
    assert.ok(fs.existsSync(obsPath), 'append 后观测文件落在投影目录');
    assert.equal(countLines(obsPath), 1);
    // 目录树：观测文件与 memory-index 平级，不污染 indexDir 内部。
    const tree = listTree(seed.projectionDir);
    assert.ok(tree.some((rel) => rel.endsWith('drain-observations.jsonl')));
  } finally {
    cleanupTempRoot(seed.root);
  }
});

test('幂等：同 (event_id, version_token, reason_code) 重复写不倍增，首条快照哈希保留', async () => {
  const mod = await loadObsModule();
  const seed = await seedBlankIndex();
  try {
    const store = mod.openDrainObservationStore!(seed.indexDir);
    store.append(makeRow());
    store.append(makeRow({ snapshot_hash: 'snap-overwrite-attempt' }));

    const rows = store.read();
    assert.equal(rows.length, 1, '同三元组不得倍增');
    assert.equal(rows[0]?.snapshot_hash, 'snap-obs-io-1', '重复写不得覆盖首条快照哈希');

    // 不同 reason_code 视为不同观测（§3.3 三元组去重）。
    store.append(makeRow({ reason_code: 'empty-anchors' }));
    assert.equal(store.read().length, 2);
  } finally {
    cleanupTempRoot(seed.root);
  }
});

test('读侧尾行容忍：末行半截不抛、不消费；中间行坏仍抛 CorruptedError', async () => {
  const mod = await loadObsModule();
  const seed = await seedBlankIndex();
  try {
    const store = mod.openDrainObservationStore!(seed.indexDir);
    const obsPath = mod.drainObservationsPath!(seed.indexDir);

    // 合法行 + 末行半截残行（torn-read，§3.6 V-08）。
    fs.mkdirSync(path.dirname(obsPath), { recursive: true });
    fs.writeFileSync(obsPath, `${JSON.stringify(makeRow())}\n{"event_id":"evt-`);
    const rows = store.read();
    assert.equal(rows.length, 1, '末行半截残行不可见、不消费');

    // 中间行坏：严格硬失败，不静默跳过。
    fs.writeFileSync(
      obsPath,
      `${JSON.stringify(makeRow())}\n{broken middle line\n${JSON.stringify(makeRow({ reason_code: 'empty-anchors' }))}\n`,
    );
    assert.throws(() => store.read(), CorruptedError, '中间行坏仍须抛 CorruptedError');
  } finally {
    cleanupTempRoot(seed.root);
  }
});

test('物理隔离：写观测不增决策行、不增 mem_miss；观测行不含决策专属键', async () => {
  const mod = await loadObsModule();
  const seed = await seedBlankIndex();
  try {
    const decisionsPath = path.join(seed.indexDir, DECISIONS_FILE);
    const decisionsBefore = fs.existsSync(decisionsPath) ? countLines(decisionsPath) : 0;
    const missBefore = countMissRows(seed.indexDir);

    const store = mod.openDrainObservationStore!(seed.indexDir);
    store.append(makeRow());
    store.append(makeRow({ reason_code: 'anchor-form-invalid' }));

    const decisionsAfter = fs.existsSync(decisionsPath) ? countLines(decisionsPath) : 0;
    assert.equal(decisionsAfter, decisionsBefore, '观测写入不得追加 decisions.jsonl');
    assert.equal(countMissRows(seed.indexDir), missBefore, '观测写入不得新增 mem_miss 行');

    for (const row of store.read()) {
      for (const key of DECISION_ONLY_KEYS) {
        assert.ok(!(key in row), `观测行不得携带决策键：${key}`);
      }
      validateObservation(row);
    }

    // 决策面不存在观测专属键（空台账下逐行核；有决策行时同样不得混入）。
    if (fs.existsSync(decisionsPath)) {
      for (const line of fs.readFileSync(decisionsPath, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        const decision = JSON.parse(line) as Record<string, unknown>;
        for (const key of OBSERVATION_ONLY_KEYS) {
          assert.ok(!(key in decision), `决策行不得混入观测键：${key}`);
        }
      }
    }
  } finally {
    cleanupTempRoot(seed.root);
  }
});

test('形状校验：越界 reason_code / 缺字段的观测行拒绝落盘', async () => {
  const mod = await loadObsModule();
  const seed = await seedBlankIndex();
  try {
    const store = mod.openDrainObservationStore!(seed.indexDir);
    const badReason = makeRow({ reason_code: 'web_search' as DrainObservation['reason_code'] });
    assert.throws(() => store.append(badReason), SchemaError, '越界原因码须拒绝');

    const missing = { ...makeRow(), snapshot_hash: '' } as DrainObservation;
    assert.throws(() => store.append(missing), SchemaError, '缺字段观测行须拒绝');

    const obsPath = mod.drainObservationsPath!(seed.indexDir);
    assert.equal(fs.existsSync(obsPath) ? countLines(obsPath) : 0, 0, '拒绝的行不得落盘');
  } finally {
    cleanupTempRoot(seed.root);
  }
});

test('静态守卫：观测写面不连决策台账/存储层，写面仅 append（无更新/删除/截断路径）', () => {
  const obsFile = path.join(REPO_ROOT, 'src', 'memory', 'drain-observations.ts');
  if (!fs.existsSync(obsFile)) {
    return; // seam 未落地期静态守卫空过；落地后起拦截作用
  }
  const code = fs.readFileSync(obsFile, 'utf8');
  assert.ok(!/from\s+['"]\.\/ledger\.ts['"]/.test(code), '观测面不得 import 决策台账模块');
  assert.ok(!/from\s+['"]\.\/store\.ts['"]/.test(code), '观测面不得直连存储写柄单例');
  for (const forbidden of ['updateSync', 'deleteSync', 'truncateSync', 'renameSync', 'writeFileSync']) {
    assert.ok(!code.includes(forbidden), `观测写面为 append-only，禁止 ${forbidden}`);
  }
});
