/**
 * C5 · 记忆层评测 harness 独立验证（方案 §4.10/§6/§11.3 M7，裁决 I1–I16 见 §11.8）。
 *
 * 为什么独立写：验收要求「不得直接采信开发自测结论」→ 本文件由验收工程师独立设计，
 * 把边界两侧钉死（投毒两通路、N/A 不填零、bootstrap 确定性、provenance 硬失败、hit_count 不回写）。
 *
 * 纪律：
 *  - 一律用临时 dataRoot（makeTempRoot/withTempRoot），绝不触碰真实根；
 *  - 记忆索引 memory-index.sqlite 审计期间零字节写入（只读打开；零字节承诺仅限该文件，I1-A）；
 *    dataRoot 并非整体零字节：Fasti.open 写 state/checkpoint.json、事件追加写 events/*.jsonl；
 *  - 不改生产代码、不改别人的测试文件；断言只针对方案/裁决写明的行为。
 *
 * 本文件随 C5 各模块增量生长；当前段：I1-A 审计落库低层 + 写柄 writeAuditRun。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { Fasti } from '../../src/api/index.ts';
import { parseEvent } from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import { listFiles } from '../../src/core/fsx.ts';
import { appendJsonl, readJsonlFile } from '../../src/core/jsonl.ts';
import { ulid } from '../../src/core/ulid.ts';
import { buildMemoryIndex, computeTruthFingerprint, computeContentHash, computeRowHashSum, deriveCardId, normalizeDisplayCues } from '../../src/memory/builder.ts';
import { deriveCuesFromKeyPoints } from '../../src/memory/cue-derive.ts';
import { foldCurrentEvents } from '../../src/projection/event-row.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { runAudit } from '../../scripts/run-memory-audit.ts';
import { sealFixtures, readUnsealLog } from '../../src/memory/audit/sealing.ts';
import { ConflictError } from '../../src/core/errors.ts';
import { openMemoryRead, openMemoryWrite } from '../../src/memory/store.ts';
import { insertAuditRun, insertAuditItem, mulberry32, DEFAULT_RNG_SEED, BOOTSTRAP_RESAMPLES, P95_REPEATS, percentileCI, ratioEstimate, aggregateMetrics } from '../../src/memory/audit/metrics.ts';
import type { Rng, AggregateInput } from '../../src/memory/audit/metrics.ts';
import { auditProvenance } from '../../src/memory/audit/provenance.ts';
import type { PointerResolver } from '../../src/memory/audit/provenance.ts';
import type { Pointer } from '../../src/contract/experience.ts';
import type { ResolvedPointer } from '../../src/contract/primitives.ts';
import {
  PROBE_SET_VERSION_PATTERN,
  validateFixtureFile,
  loadFixtures,
} from '../../src/memory/audit/fixtures.ts';
import { replayGold } from '../../src/memory/audit/gold.ts';
import type { GoldQuestion, GoldQuestionResult, SearchFn } from '../../src/memory/audit/gold.ts';
import { cardTermSet, jaccardSimilarity, buildDecoyPairs, scoreDecoy } from '../../src/memory/audit/decoy.ts';
import { evaluateConsistency, consistencyPairKey } from '../../src/memory/audit/consistency.ts';
import type { DecoyItem } from '../../src/memory/audit/fixtures.ts';
import type {
  AuditRunRecord,
  AuditItemRecord,
  ProbeType,
  RankedCard,
  MemoryCard,
  AssembledWindow,
  AliasRow,
  RevisionRecord,
  DecisionRecord,
} from '../../src/memory/types.ts';
import { cleanupTempRoot, makeExperience, makeTempRoot, seedDshChannel, withTempRoot } from '../helpers.ts';

const DB_FILE = 'memory-index.sqlite';

function auditRun(overrides: Partial<AuditRunRecord> = {}): AuditRunRecord {
  return {
    runId: 'run-1',
    createdMs: 1_000,
    sampleN: 3,
    probeSetVersion: 'v1',
    modelTag: 'rules-v1',
    metricsJson: '{}',
    notesJson: '{}',
    ...overrides,
  };
}

function auditItem(overrides: Partial<AuditItemRecord> = {}): AuditItemRecord {
  return {
    runId: 'run-1',
    itemNo: 1,
    probeType: 'gold',
    expectedRef: 'ev1',
    returnedRefsJson: '["ev1"]',
    passed: 1,
    detailJson: '{}',
    ...overrides,
  };
}

/** 只读打开临时库取整表（核对落行）。 */
function readTable(indexDir: string, table: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path.join(indexDir, DB_FILE), { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// I1-A · 审计落库低层 insertAuditRun / insertAuditItem（收库柄、不自开连接）
// ═══════════════════════════════════════════════════════════════════════════

test('I1-A · insertAuditRun 落 mem_audit_run 一行（列值逐字对账）', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const handle = openMemoryWrite({ indexDir });
    try {
      const db = new DatabaseSync(path.join(indexDir, DB_FILE));
      try {
        insertAuditRun(db, auditRun({ modelTag: null, notesJson: '{"rngSeed":20261111}' }));
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
    const rows = readTable(indexDir, 'mem_audit_run');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['run_id'], 'run-1');
    assert.equal(rows[0]?.['created_ms'], 1000);
    assert.equal(rows[0]?.['sample_n'], 3);
    assert.equal(rows[0]?.['probe_set_version'], 'v1');
    assert.equal(rows[0]?.['model_tag'], null);
    assert.equal(rows[0]?.['metrics_json'], '{}');
    assert.equal(rows[0]?.['notes_json'], '{"rngSeed":20261111}');
  });
});

test('I1-A · insertAuditItem 落 mem_audit_item 一行（expected_ref 可空、passed 0/1）', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const handle = openMemoryWrite({ indexDir });
    try {
      const db = new DatabaseSync(path.join(indexDir, DB_FILE));
      try {
        insertAuditItem(db, auditItem({ itemNo: 7, probeType: 'provenance', expectedRef: null, passed: 0 }));
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
    const rows = readTable(indexDir, 'mem_audit_item');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['run_id'], 'run-1');
    assert.equal(rows[0]?.['item_no'], 7);
    assert.equal(rows[0]?.['probe_type'], 'provenance');
    assert.equal(rows[0]?.['expected_ref'], null);
    assert.equal(rows[0]?.['passed'], 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I1-A · 写柄 writeAuditRun（单事务写 1 run + items；签名对齐 §4.3:373）
// ═══════════════════════════════════════════════════════════════════════════

test('I1-A · writeAuditRun 单事务落 1 条 run 与其全部 items', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const handle = openMemoryWrite({ indexDir });
    try {
      const items = [
        auditItem({ itemNo: 1, probeType: 'gold' }),
        auditItem({ itemNo: 2, probeType: 'decoy' }),
        auditItem({ itemNo: 3, probeType: 'provenance' }),
      ];
      handle.writeAuditRun(auditRun({ sampleN: 3 }), items);
    } finally {
      await handle.close();
    }
    assert.equal(readTable(indexDir, 'mem_audit_run').length, 1);
    const items = readTable(indexDir, 'mem_audit_item');
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((r) => r['item_no']), [1, 2, 3]);
  });
});

test('I1-A · writeAuditRun 原子性：中途 item 违 CHECK → 整事务回滚（run/items 零行）', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const handle = openMemoryWrite({ indexDir });
    try {
      const badItems = [
        auditItem({ itemNo: 1, probeType: 'gold' }),
        // probe_type 越域（CHECK IN 四值）→ INSERT 失败 → 整事务回滚
        auditItem({ itemNo: 2, probeType: 'bogus' as ProbeType }),
      ];
      assert.throws(() => handle.writeAuditRun(auditRun(), badItems));
    } finally {
      await handle.close();
    }
    assert.equal(readTable(indexDir, 'mem_audit_run').length, 0, 'run 必须回滚');
    assert.equal(readTable(indexDir, 'mem_audit_item').length, 0, '已插入的 item 也必须回滚');
  });
});

test('I1-A · writeAuditRun 空 items：仍落 1 条 run（N/A run 合法）', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const handle = openMemoryWrite({ indexDir });
    try {
      handle.writeAuditRun(auditRun({ sampleN: 0 }), []);
    } finally {
      await handle.close();
    }
    assert.equal(readTable(indexDir, 'mem_audit_run').length, 1);
    assert.equal(readTable(indexDir, 'mem_audit_item').length, 0);
  });
});

test('I1-A · 只读柄无 writeAuditRun（写路径只在写柄；只读柄零写副作用）', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const write = openMemoryWrite({ indexDir });
    try {
      write.writeAuditRun(auditRun(), [auditItem()]);
    } finally {
      await write.close();
    }
    const read = openMemoryRead({ indexDir });
    try {
      assert.equal((read as unknown as Record<string, unknown>)['writeAuditRun'], undefined);
      assert.equal((read as unknown as Record<string, unknown>)['recordMiss'], undefined);
      assert.equal((read as unknown as Record<string, unknown>)['transactionApply'], undefined);
    } finally {
      await read.close();
    }
  });
});

test('I1-A · 写柄进程内单例：同目录二次 openMemoryWrite 抛 ConflictError（既有纪律不回归）', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const first = openMemoryWrite({ indexDir });
    try {
      assert.throws(() => openMemoryWrite({ indexDir }), ConflictError);
    } finally {
      await first.close();
    }
    // 关闭后可重开（单例表已清理）
    const second = openMemoryWrite({ indexDir });
    await second.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 共用夹具工厂（合成卡/检索结果；id 全部指向合成数据，I3）
// ═══════════════════════════════════════════════════════════════════════════

function memoryCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  return {
    cardId: 'mc_a',
    eventId: 'ev1',
    anchorJson: '["exp1"]',
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson: '["线索"]',
    aliasesJson: '[]',
    discriminator: '判别',
    entityHintJson: null,
    occurredMs: 100,
    endedMs: 200,
    validMs: 100,
    invalidMs: null,
    createdMs: 100,
    expiredMs: null,
    status: 'active',
    contentHash: 'h'.repeat(64),
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
    ...overrides,
  };
}

function ranked(eventId: string, cardId: string, bm25 = 1, recency = 0.5): RankedCard {
  return { card: memoryCard({ eventId, cardId }), scoreParts: { bm25, recency }, matchedTerms: ['线索'] };
}

// ═══════════════════════════════════════════════════════════════════════════
// I7 · fixtures.ts 版本/形状/正文字段拒收（纯校验表驱动）
// ═══════════════════════════════════════════════════════════════════════════

const L0_ITEM = {
  eventId: 'ev1',
  channel: 'dsh',
  queries: ['线索一', '线索二', '线索三'],
  aliases: [{ term: '别名', source: 'miss', sensitive: 0 }],
  sensitiveTerms: [],
  discriminatorNeighborEventIds: ['ev2'],
  expectedSlots: ['relevance'],
};
const L1_ITEM = { questionExperienceId: 'exp-q', targetEventId: 'ev1', initiation: 'user', coldStart: false };
const DECOY_ITEM = { pairCardIds: ['mc_a', 'mc_b'], discriminatorQuery: '只应命中甲', goldCardId: 'mc_a' };

function fixtureFile(layer: string, items: unknown[]): unknown {
  return { probeSetVersion: 'v1', layer, items };
}

test('I7 · probeSetVersion 正则：v1/v1.2/v1.2.3 放行，空/无前缀/含字母拒收', () => {
  for (const ok of ['v1', 'v1.2', 'v1.2.3', 'v10.0.1']) {
    assert.ok(PROBE_SET_VERSION_PATTERN.test(ok), `应放行 ${ok}`);
  }
  for (const bad of ['', '1', 'v', 'v1.x', 'V1', 'v1.', 'v1..2']) {
    assert.equal(PROBE_SET_VERSION_PATTERN.test(bad), false, `应拒收 ${bad}`);
  }
});

test('I7 · validateFixtureFile 合规样例（l0/l1/l2/decoy）零误报', () => {
  assert.doesNotThrow(() => validateFixtureFile(fixtureFile('l0', [L0_ITEM]), 'l0', 'gold-l0.json'));
  assert.doesNotThrow(() => validateFixtureFile(fixtureFile('l1', [L1_ITEM]), 'l1', 'gold-l1.json'));
  assert.doesNotThrow(() => validateFixtureFile(fixtureFile('l2', [L1_ITEM]), 'l2', 'holdout.json'));
  assert.doesNotThrow(() => validateFixtureFile(fixtureFile('decoy', [DECOY_ITEM]), 'decoy', 'decoy.json'));
});

test('I7 · validateFixtureFile 坏版本/错 layer/非对象 → 抛 core 基类', () => {
  assert.throws(() => validateFixtureFile({ probeSetVersion: '1', layer: 'l0', items: [] }, 'l0', 'f'));
  assert.throws(() => validateFixtureFile({ probeSetVersion: 'v1', layer: 'l1', items: [] }, 'l0', 'f'));
  assert.throws(() => validateFixtureFile(null, 'l0', 'f'));
  assert.throws(() => validateFixtureFile({ probeSetVersion: 'v1', layer: 'l0' }, 'l0', 'f'));
});

test('I7 · validateFixtureFile 拒收任何正文字段（summary/body/raw_text/key_points）', () => {
  for (const bodyKey of ['summary', 'body', 'raw_text', 'key_points']) {
    const poisoned = { ...L0_ITEM, [bodyKey]: '正文副本' };
    assert.throws(
      () => validateFixtureFile(fixtureFile('l0', [poisoned]), 'l0', 'gold-l0.json'),
      `含正文字段 ${bodyKey} 必须拒收`,
    );
  }
});

test('I7 · validateFixtureFile 条目缺必填/坏枚举 → 抛错带文件标签', () => {
  const { eventId: _omit, ...noEventId } = L0_ITEM;
  assert.throws(() => validateFixtureFile(fixtureFile('l0', [noEventId]), 'l0', 'gold-l0.json'));
  assert.throws(() => validateFixtureFile(fixtureFile('l1', [{ ...L1_ITEM, initiation: 'system' }]), 'l1', 'gold-l1.json'));
  assert.throws(() => validateFixtureFile(fixtureFile('decoy', [{ ...DECOY_ITEM, highRiskLabel: 'bogus' }]), 'decoy', 'decoy.json'));
});

test('I7 · loadFixtures 读合成四文件 → LoadedFixtures（版本一致、分层归位）', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, 'fixtures');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gold-l0.json'), JSON.stringify(fixtureFile('l0', [L0_ITEM])));
    fs.writeFileSync(path.join(dir, 'gold-l1.json'), JSON.stringify(fixtureFile('l1', [L1_ITEM])));
    fs.writeFileSync(path.join(dir, 'holdout.json'), JSON.stringify(fixtureFile('l2', [L1_ITEM])));
    fs.writeFileSync(path.join(dir, 'decoy.json'), JSON.stringify(fixtureFile('decoy', [DECOY_ITEM])));
    const loaded = loadFixtures(dir);
    assert.equal(loaded.probeSetVersion, 'v1');
    assert.equal(loaded.l0.length, 1);
    assert.equal(loaded.l1.length, 1);
    assert.equal(loaded.l2.length, 1);
    assert.equal(loaded.decoy.length, 1);
    assert.equal(loaded.l0[0]?.eventId, 'ev1');
  });
});

test('I7 · loadFixtures 缺文件 → NotFoundError；跨文件版本不一致 → IntegrityError', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, 'fixtures');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gold-l0.json'), JSON.stringify(fixtureFile('l0', [L0_ITEM])));
    assert.throws(() => loadFixtures(dir)); // 缺其余三文件
    fs.writeFileSync(path.join(dir, 'gold-l1.json'), JSON.stringify(fixtureFile('l1', [L1_ITEM])));
    fs.writeFileSync(path.join(dir, 'holdout.json'), JSON.stringify({ probeSetVersion: 'v2', layer: 'l2', items: [L1_ITEM] }));
    fs.writeFileSync(path.join(dir, 'decoy.json'), JSON.stringify(fixtureFile('decoy', [DECOY_ITEM])));
    assert.throws(() => loadFixtures(dir)); // v1 vs v2 不一致
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I6/I16 · gold.ts R1 回放（search 注入、relayMap、k 敏感性、分层透传）
// ═══════════════════════════════════════════════════════════════════════════

function question(overrides: Partial<GoldQuestion> = {}): GoldQuestion {
  return {
    queryText: '线索一',
    targetEventId: 'ev1',
    questionRef: 'exp-q',
    source: 'l1',
    initiation: 'user',
    coldStart: false,
    ...overrides,
  };
}

test('I16 · replayGold 目标在 top-3 → hit、rank 与 scoreParts 如实记录', async () => {
  const search: SearchFn = () => [ranked('ev9', 'mc_x'), ranked('ev1', 'mc_a'), ranked('ev2', 'mc_b')];
  const results = await replayGold([question()], search, { atMs: 1000, k: 3, relayMap: new Map() });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.hit, true);
  assert.equal(results[0]?.rank, 2);
  assert.deepEqual(results[0]?.scoreParts, { bm25: 1, recency: 0.5 });
  assert.equal(results[0]?.resolvedEventId, 'ev1');
});

test('I16 · replayGold 目标不在 top-k → miss、rank=null（recall@k 口径）', async () => {
  // 假检索须遵守 SearchQuery.limit 契约（排序后截断），与真实 searchCards 同口径。
  const search: SearchFn = (q) =>
    [ranked('ev9', 'mc_x'), ranked('ev8', 'mc_y'), ranked('ev1', 'mc_a')].slice(0, q.limit ?? 3);
  const r3 = await replayGold([question()], search, { atMs: 1000, k: 3, relayMap: new Map() });
  assert.equal(r3[0]?.hit, true, 'k=3 含第 3 位');
  const r1 = await replayGold([question()], search, { atMs: 1000, k: 1, relayMap: new Map() });
  assert.equal(r1[0]?.hit, false, 'k=1 仅第 1 位 → 未命中');
  assert.equal(r1[0]?.rank, null);
});

test('I16 · replayGold relayMap 把金标事件映射到当前态后判定（接力链留痕）', async () => {
  const search: SearchFn = () => [ranked('ev1-current', 'mc_a')];
  const results = await replayGold([question({ targetEventId: 'ev1-old' })], search, {
    atMs: 1000,
    k: 3,
    relayMap: new Map([['ev1-old', 'ev1-current']]),
    relayChains: new Map([['ev1-old', ['ev1-old', 'ev1-current']]]),
  });
  assert.equal(results[0]?.hit, true);
  assert.equal(results[0]?.resolvedEventId, 'ev1-current');
  assert.equal(results[0]?.targetEventId, 'ev1-old');
  assert.deepEqual(results[0]?.relayChain, ['ev1-old', 'ev1-current']);
});

test('I16 · replayGold 分层字段透传（initiation/coldStart/source）+ search 收到注入 atMs', async () => {
  let seenAtMs = -1;
  let seenLimit = -1;
  const search: SearchFn = (q) => {
    seenAtMs = q.atMs;
    seenLimit = q.limit ?? -1;
    return [];
  };
  const results = await replayGold(
    [question({ initiation: 'her', coldStart: true, source: 'l0' })],
    search,
    { atMs: 4242, k: 5, relayMap: new Map() },
  );
  assert.equal(seenAtMs, 4242);
  assert.equal(seenLimit, 5);
  assert.equal(results[0]?.initiation, 'her');
  assert.equal(results[0]?.coldStart, true);
  assert.equal(results[0]?.source, 'l0');
  assert.equal(results[0]?.hit, false);
});

test('I16 · replayGold 兼容 async search（读柄 search 为 Promise）', async () => {
  const search: SearchFn = async () => [ranked('ev1', 'mc_a')];
  const results = await replayGold([question()], search, { atMs: 1000, relayMap: new Map() });
  assert.equal(results[0]?.hit, true);
  assert.equal(results[0]?.rank, 1, 'k 缺省 3');
});

// ═══════════════════════════════════════════════════════════════════════════
// I14 · decoy.ts 近邻对（同一 Jaccard 口径、top2、防漂移）+ R2 判别
// ═══════════════════════════════════════════════════════════════════════════

function cardWithTerms(cardId: string, cues: string[], aliasTerms: string[]): MemoryCard {
  return memoryCard({
    cardId,
    eventId: `ev-${cardId}`,
    displayCuesJson: JSON.stringify(cues),
    aliasesJson: JSON.stringify(aliasTerms.map((term) => ({ term, source: 'miss', sensitive: 0 }))),
  });
}

test('I14 · cardTermSet 取规范化 cue+alias term（NFKC/小写/空白折叠，空词剔除）', () => {
  const card = cardWithTerms('mc_a', ['ＡＢＣ', '  线索  '], ['Alias']);
  const terms = cardTermSet(card);
  assert.ok(terms.has('abc'), '全角→半角+小写');
  assert.ok(terms.has('线索'), '空白折叠');
  assert.ok(terms.has('alias'));
  assert.equal(terms.size, 3);
});

test('I14 · jaccardSimilarity |交|/|并|，空集对=0，相同=1', () => {
  assert.equal(jaccardSimilarity(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
  assert.equal(jaccardSimilarity(new Set(), new Set()), 0);
  assert.equal(jaccardSimilarity(new Set(['a']), new Set()), 0);
  assert.equal(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
});

test('I14 · buildDecoyPairs 每卡 top2 近邻（相似度降序→cardId 升序，仅 >0，不足取实际数）', () => {
  const cards = [
    cardWithTerms('mc_a', ['x', 'y', 'z'], []),
    cardWithTerms('mc_b', ['x', 'y', 'z'], []),   // 与 a 完全相同 → sim 1
    cardWithTerms('mc_c', ['x'], []),             // 与 a 交 1 并 3 → 1/3
    cardWithTerms('mc_d', ['q'], []),             // 与 a 无交 → 0（不入近邻）
  ];
  const pairs = buildDecoyPairs(cards);
  const a = pairs.find((p) => p.cardId === 'mc_a');
  assert.deepEqual(a?.neighborCardIds, ['mc_b', 'mc_c'], 'top2：b(1) 先于 c(1/3)，d(0) 剔除');
  const d = pairs.find((p) => p.cardId === 'mc_d');
  assert.deepEqual(d?.neighborCardIds, [], '无 >0 近邻 → 空');
});

test('I14 · scoreDecoy top1 必须金标卡；错认计错误，高危标签单独计', async () => {
  const items: DecoyItem[] = [
    { pairCardIds: ['mc_a', 'mc_b'], discriminatorQuery: 'q1', goldCardId: 'mc_a' },
    { pairCardIds: ['mc_a', 'mc_b'], discriminatorQuery: 'q2', goldCardId: 'mc_a', highRiskLabel: 'date' },
  ];
  const okSearch: SearchFn = () => [ranked('ev-mc_a', 'mc_a')];
  const ok = await scoreDecoy(items, okSearch, { atMs: 1000 });
  assert.equal(ok[0]?.correct, true);
  assert.equal(ok[1]?.correct, true);
  assert.equal(ok[1]?.highRiskError, false);

  const badSearch: SearchFn = () => [ranked('ev-mc_b', 'mc_b')];
  const bad = await scoreDecoy(items, badSearch, { atMs: 1000 });
  assert.equal(bad[0]?.correct, false);
  assert.equal(bad[0]?.topCardId, 'mc_b');
  assert.equal(bad[0]?.highRiskError, false, '无高危标签');
  assert.equal(bad[1]?.highRiskError, true, '高危日期类错认单独计');
});

test('I14 · scoreDecoy 零结果 → topCardId=null、correct=false（不漏报）', async () => {
  const items: DecoyItem[] = [{ pairCardIds: ['mc_a', 'mc_b'], discriminatorQuery: 'q', goldCardId: 'mc_a' }];
  const empty: SearchFn = () => [];
  const r = await scoreDecoy(items, empty, { atMs: 1000 });
  assert.equal(r[0]?.topCardId, null);
  assert.equal(r[0]?.correct, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// I9 · consistency.ts N/A 空置规则 + 结构判定（严禁填零造样）
// ═══════════════════════════════════════════════════════════════════════════

function window(identityCardIds: string[], relevanceCardIds: string[] = []): AssembledWindow {
  return {
    slots: [
      { slot: 'guaranteed', cardIds: [] },
      { slot: 'recency', cardIds: [] },
      { slot: 'identity', cardIds: identityCardIds },
      { slot: 'relevance', cardIds: relevanceCardIds },
      { slot: 'obligation', cardIds: [] },
    ],
    totalChars: 10,
    turnsWhole: true,
    needRefetch: false,
  };
}

function alias(termNorm: string, cardId: string): AliasRow {
  return { termNorm, cardId, source: 'miss', sensitive: 0, status: 'active', createdMs: 0, hitCount: 0, lastHitMs: null };
}

test('I9 · evaluateConsistency 空样本 → n-a/no-reflection-pair/pairs:0（不填零造样）', () => {
  const result = evaluateConsistency([], new Map(), { atMs: 1000, aliasTable: [], cardsById: new Map() });
  assert.deepEqual(result, { status: 'n-a', reason: 'no-reflection-pair', pairs: 0 });
});

test('I9 · evaluateConsistency 同 identity 槽且无 alias-conflict → consistent', () => {
  const pair = { questionARef: 'qA', questionBRef: 'qB' };
  const card = memoryCard({ cardId: 'mc_id', eventId: 'ev-id' });
  const windows = new Map([[consistencyPairKey(pair), [window(['mc_id']), window(['mc_id'])] as const]]);
  const result = evaluateConsistency([pair], windows, {
    atMs: 1000,
    aliasTable: [],
    cardsById: new Map([['mc_id', card]]),
  });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.pairs, 1);
  assert.equal(result.consistent, 1);
  assert.equal(result.contradictory, 0);
});

test('I9 · evaluateConsistency identity 槽不一致 → contradictory', () => {
  const pair = { questionARef: 'qA', questionBRef: 'qB' };
  const cards = new Map([
    ['mc_1', memoryCard({ cardId: 'mc_1' })],
    ['mc_2', memoryCard({ cardId: 'mc_2' })],
  ]);
  const windows = new Map([[consistencyPairKey(pair), [window(['mc_1']), window(['mc_2'])] as const]]);
  const result = evaluateConsistency([pair], windows, { atMs: 1000, aliasTable: [], cardsById: cards });
  assert.equal(result.consistent, 0);
  assert.equal(result.contradictory, 1);
});

test('I9 · evaluateConsistency 未决 alias-conflict（同词双卡）→ contradictory', () => {
  const pair = { questionARef: 'qA', questionBRef: 'qB' };
  const cardA = memoryCard({ cardId: 'mc_a', aliasesJson: JSON.stringify([{ term: '共享词', source: 'miss', sensitive: 0 }]) });
  const cardB = memoryCard({ cardId: 'mc_b', aliasesJson: JSON.stringify([{ term: '共享词', source: 'miss', sensitive: 0 }]) });
  const windows = new Map([
    [consistencyPairKey(pair), [window([], ['mc_a', 'mc_b']), window([], ['mc_a', 'mc_b'])] as const],
  ]);
  const result = evaluateConsistency([pair], windows, {
    atMs: 1000,
    aliasTable: [alias('共享词', 'mc_a'), alias('共享词', 'mc_b')],
    cardsById: new Map([['mc_a', cardA], ['mc_b', cardB]]),
  });
  assert.equal(result.contradictory, 1, '同 termNorm 不同 cardId 的 active 别名 → alias-conflict');
});

// ═══════════════════════════════════════════════════════════════════════════
// I8 · metrics.ts mulberry32 / percentileCI / ratioEstimate（确定性 + 手算分位）
// ═══════════════════════════════════════════════════════════════════════════

test('I8 · mulberry32 同种子逐字节一致、异种子不同、值域 [0,1)', () => {
  const a = mulberry32(DEFAULT_RNG_SEED);
  const b = mulberry32(DEFAULT_RNG_SEED);
  const c = mulberry32(DEFAULT_RNG_SEED + 1);
  const seqA = Array.from({ length: 50 }, () => a());
  const seqB = Array.from({ length: 50 }, () => b());
  const seqC = Array.from({ length: 50 }, () => c());
  assert.deepEqual(seqA, seqB, '同种子必须逐字节一致');
  assert.notDeepEqual(seqA, seqC, '异种子必须不同');
  for (const value of seqA) {
    assert.ok(value >= 0 && value < 1, '值域 [0,1)');
  }
});

test('I8 · 常量冻结：DEFAULT_RNG_SEED/BOOTSTRAP_RESAMPLES/P95_REPEATS', () => {
  assert.equal(DEFAULT_RNG_SEED, 20261111);
  assert.equal(BOOTSTRAP_RESAMPLES, 1000);
  assert.equal(P95_REPEATS, 1000);
});

test('I8 · percentileCI 手算：全同值 → CI 退化为该值；空数组 → {0,0}', () => {
  const rng = mulberry32(DEFAULT_RNG_SEED);
  assert.deepEqual(percentileCI([1, 1, 1, 1], rng), { ciLower: 1, ciUpper: 1 });
  assert.deepEqual(percentileCI([0, 0, 0], rng), { ciLower: 0, ciUpper: 0 });
  assert.deepEqual(percentileCI([], rng), { ciLower: 0, ciUpper: 0 });
});

test('I8 · percentileCI 重复运行相等 + 区间有序且落在 [0,1]（指标数组）', () => {
  const values = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1];
  const first = percentileCI(values, mulberry32(DEFAULT_RNG_SEED));
  const second = percentileCI(values, mulberry32(DEFAULT_RNG_SEED));
  assert.deepEqual(first, second, '同种子同输入逐字节一致');
  assert.ok(first.ciLower <= first.ciUpper);
  assert.ok(first.ciLower >= 0 && first.ciUpper <= 1);
});

test('I8 · ratioEstimate point=均值、n=样本数；全 1 → CI{1,1}；空 → point0/n0', () => {
  const rng = mulberry32(DEFAULT_RNG_SEED);
  const half = ratioEstimate([1, 1, 0, 0], rng);
  assert.equal(half.point, 0.5);
  assert.equal(half.n, 4);
  const all = ratioEstimate([1, 1, 1], rng);
  assert.equal(all.point, 1);
  assert.deepEqual({ ciLower: all.ciLower, ciUpper: all.ciUpper }, { ciLower: 1, ciUpper: 1 });
  const empty = ratioEstimate([], rng);
  assert.equal(empty.point, 0);
  assert.equal(empty.n, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// I2/I8 · provenance.ts DI 解析 / 20% 分层抽样 / 硬失败
// ═══════════════════════════════════════════════════════════════════════════

/** 假 resolver：已知 id 返回非空 turns，未知 id 抛错（模拟门面 resolvePointer 悬空即抛）。 */
function fakeResolver(known: ReadonlySet<string>): PointerResolver {
  return async (pointer: Pointer): Promise<ResolvedPointer> => {
    const id = pointer.id ?? '';
    if (!known.has(id)) {
      throw new Error(`dangling: ${id}`);
    }
    return { turns: [{ channel: 'dsh', shard: '2026-11', seq: 0, event_id: 'ev1', raw_text: '原文' }] };
  };
}

function provCards(n: number): MemoryCard[] {
  return Array.from({ length: n }, (_, i) =>
    memoryCard({ cardId: `mc_${i}`, eventId: `ev${i}`, anchorJson: JSON.stringify([`exp${i}`]) }),
  );
}

test('I2 · auditProvenance 全锚点可解析 → successRate1/failed false/dangling0；resolver 收到 {id}', async () => {
  const cards = provCards(5);
  const seen: string[] = [];
  const resolver: PointerResolver = async (p) => {
    seen.push(p.id ?? '');
    return { turns: [{ channel: 'dsh', shard: '2026-11', seq: 0, event_id: 'ev', raw_text: 'x' }] };
  };
  const fts = new Map(cards.map((c) => [c.cardId, '线索']));
  const result = await auditProvenance(cards, resolver, {
    rng: mulberry32(DEFAULT_RNG_SEED),
    sampleRatio: 1,
    cacheDrift: new Map(),
    ftsTextByCard: fts,
  });
  assert.equal(result.sampled, 5);
  assert.equal(result.successRate, 1);
  assert.equal(result.danglingCount, 0);
  assert.equal(result.failed, false);
  assert.deepEqual(seen.sort(), ['exp0', 'exp1', 'exp2', 'exp3', 'exp4']);
});

test('I2/I13 · auditProvenance 悬空锚点（resolver 抛错）→ dangling>0、failed true（硬失败）', async () => {
  const cards = provCards(3);
  const fts = new Map(cards.map((c) => [c.cardId, '线索']));
  const result = await auditProvenance(cards, fakeResolver(new Set(['exp0'])), {
    rng: mulberry32(DEFAULT_RNG_SEED),
    sampleRatio: 1,
    cacheDrift: new Map(),
    ftsTextByCard: fts,
  });
  assert.ok(result.danglingCount >= 2, 'exp1/exp2 悬空');
  assert.equal(result.failed, true);
  assert.ok(result.successRate < 1);
});

test('I2 · auditProvenance 缓存漂移（注入 Map）→ 该卡 ok=false、failed true', async () => {
  const cards = provCards(2);
  const fts = new Map(cards.map((c) => [c.cardId, '线索']));
  const result = await auditProvenance(cards, fakeResolver(new Set(['exp0', 'exp1'])), {
    rng: mulberry32(DEFAULT_RNG_SEED),
    sampleRatio: 1,
    cacheDrift: new Map([['mc_0', true]]),
    ftsTextByCard: fts,
  });
  const drifted = result.results.find((r) => r.cardId === 'mc_0');
  assert.equal(drifted?.cacheDrift, true);
  assert.equal(drifted?.ok, false);
  assert.equal(result.failed, true);
});

test('I2 · auditProvenance FTS 溯源：词项须全部来自 cue/alias，泄露正文 → ftsTraceable false', async () => {
  const cards = provCards(1);
  const ok = await auditProvenance(cards, fakeResolver(new Set(['exp0'])), {
    rng: mulberry32(DEFAULT_RNG_SEED),
    sampleRatio: 1,
    cacheDrift: new Map(),
    ftsTextByCard: new Map([['mc_0', '线索']]),
  });
  assert.equal(ok.results[0]?.ftsTraceable, true);
  const leak = await auditProvenance(cards, fakeResolver(new Set(['exp0'])), {
    rng: mulberry32(DEFAULT_RNG_SEED),
    sampleRatio: 1,
    cacheDrift: new Map(),
    ftsTextByCard: new Map([['mc_0', '线索 正文泄露']]),
  });
  assert.equal(leak.results[0]?.ftsTraceable, false);
  assert.equal(leak.failed, true);
});

test('I8 · auditProvenance 20% 分层抽样：10 卡 → 抽 2，同种子可复算', async () => {
  const cards = provCards(10);
  const fts = new Map(cards.map((c) => [c.cardId, '线索']));
  const known = new Set(cards.map((_, i) => `exp${i}`));
  const opts = { sampleRatio: 0.2, cacheDrift: new Map<string, boolean>(), ftsTextByCard: fts };
  const first = await auditProvenance(cards, fakeResolver(known), { ...opts, rng: mulberry32(DEFAULT_RNG_SEED) });
  const second = await auditProvenance(cards, fakeResolver(known), { ...opts, rng: mulberry32(DEFAULT_RNG_SEED) });
  assert.equal(first.sampled, 2);
  assert.deepEqual(first.results.map((r) => r.cardId), second.results.map((r) => r.cardId), '同种子抽样一致');
});

test('I2 · auditProvenance 空卡集 → sampled0/successRate1/failed false（无样本不硬失败）', async () => {
  const result = await auditProvenance([], fakeResolver(new Set()), {
    rng: mulberry32(DEFAULT_RNG_SEED),
    cacheDrift: new Map(),
    ftsTextByCard: new Map(),
  });
  assert.equal(result.sampled, 0);
  assert.equal(result.total, 0);
  assert.equal(result.failed, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// I9 · aggregateMetrics 四组聚合 / N/A 不填零 / 确定性
// ═══════════════════════════════════════════════════════════════════════════

function goldResult(overrides: Partial<GoldQuestionResult> = {}): GoldQuestionResult {
  return {
    questionRef: 'q',
    targetEventId: 'ev1',
    resolvedEventId: 'ev1',
    hit: true,
    rank: 1,
    scoreParts: { bm25: 1, recency: 0.5 },
    relayChain: ['ev1'],
    initiation: 'user',
    coldStart: false,
    source: 'l1',
    ...overrides,
  };
}

function aggregateInput(overrides: Partial<AggregateInput> = {}): AggregateInput {
  return {
    gold: [goldResult()],
    goldK1: [goldResult()],
    goldK5: [goldResult()],
    decoy: [{ goldCardId: 'mc_a', topCardId: 'mc_a', correct: true, highRiskError: false }],
    consistency: { status: 'n-a', reason: 'no-reflection-pair', pairs: 0 },
    provenance: { total: 1, sampled: 1, results: [], successRate: 1, danglingCount: 0, failed: false },
    windows: [window([], ['mc_a'])],
    p95Ms: 1.5,
    roi: { writeCostMinutes: 10, simulatedHits: 5, cards: 1 },
    ...overrides,
  };
}

test('I9 · aggregateMetrics 四组齐备、比率类 {point,ciLower,ciUpper,n}、N/A 不填零', () => {
  const metrics = aggregateMetrics(aggregateInput(), { rng: mulberry32(DEFAULT_RNG_SEED) });
  assert.deepEqual(Object.keys(metrics).sort(), ['assembly', 'quality', 'retrieval', 'roi']);
  const recall = metrics.retrieval.recallAtK;
  assert.ok('point' in recall && 'ciLower' in recall && 'ciUpper' in recall && 'n' in recall);
  assert.equal(recall.point, 1);
  // consistency n-a → r3 为 N/A（不填 0）
  assert.deepEqual(metrics.quality.r3, { status: 'n-a', reason: 'no-reflection-pair' });
  assert.equal(metrics.quality.r2HighRiskErrors, 0);
  assert.equal(metrics.assembly.p95Ms, 1.5);
  assert.equal(metrics.roi.perCardCost, 10);
  assert.equal(metrics.roi.expectedHitsPerThousand, 5000);
  assert.equal(metrics.roi.costPerEffectiveRecall, 2);
});

test('I9 · aggregateMetrics 空金标/空诱饵 → 对应比率 N/A（no-sample），不伪造达标', () => {
  const metrics = aggregateMetrics(
    aggregateInput({ gold: [], goldK1: [], goldK5: [], decoy: [] }),
    { rng: mulberry32(DEFAULT_RNG_SEED) },
  );
  assert.deepEqual(metrics.retrieval.recallAtK, { status: 'n-a', reason: 'no-sample' });
  assert.deepEqual(metrics.quality.r2, { status: 'n-a', reason: 'no-sample' });
});

test('I9 · aggregateMetrics R2 为错误率（错认越多 point 越高）+ 高危计数', () => {
  const metrics = aggregateMetrics(
    aggregateInput({
      decoy: [
        { goldCardId: 'mc_a', topCardId: 'mc_b', correct: false, highRiskLabel: 'date', highRiskError: true },
        { goldCardId: 'mc_a', topCardId: 'mc_a', correct: true, highRiskError: false },
      ],
    }),
    { rng: mulberry32(DEFAULT_RNG_SEED) },
  );
  const r2 = metrics.quality.r2;
  assert.ok('point' in r2);
  assert.equal(r2.point, 0.5, 'R2=错误数/总数=1/2');
  assert.equal(metrics.quality.r2HighRiskErrors, 1);
});

test('I9 · aggregateMetrics 同输入同种子 → JSON 逐字节一致（确定性）', () => {
  const input = aggregateInput();
  const a = aggregateMetrics(input, { rng: mulberry32(DEFAULT_RNG_SEED) });
  const b = aggregateMetrics(input, { rng: mulberry32(DEFAULT_RNG_SEED) });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ═══════════════════════════════════════════════════════════════════════════
// I1-A/I11/I13 · CLI 集成（独立 --out 库 / 旗标守卫 / 退出码 / hit_count 边界）
// ═══════════════════════════════════════════════════════════════════════════

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const auditCli = path.join(repoRoot, 'scripts', 'run-memory-audit.ts');
const AUDIT_NOW = T0 + 200 * DAY;

function runAuditCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [auditCli, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 60000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readyEventRecord(id: string, anchors: string[], startMs: number, keyPoints: readonly string[] = ['关键点']): EventRecord {
  return {
    id,
    schema_version: 1,
    version: 1,
    status: 'closed',
    closed_reason: 'silence',
    pointers: anchors.map((a) => ({ id: a })),
    time_range: { started_at: iso(startMs), ended_at: iso(startMs + 3600_000) },
    assembled_at: iso(startMs + 3600_000),
    summary: '客观摘要（仅供测试阅读，不进卡）',
    key_points: [...keyPoints],
    anchors,
    topic_lines: [],
    summary_quality: 'ready',
    summary_source: 'llm',
    summary_prompt_version: null,
    summary_model: null,
    effective_chars: null,
    raw_chars: null,
    created_by: 'system',
    created_at: iso(startMs + 3600_000),
    channel: 'dsh',
    boundary_candidates: [],
  };
}

/** 可解析数据根：ingestRawTurn 造真实经历/原文/通道 → 事件追加 closed+ready 版本（锚点指向可解析经历）。 */
async function makeAuditableRoot(n: number): Promise<{ root: string; eventIds: string[]; expIds: string[] }> {
  const root = makeTempRoot('audit-qa-');
  seedDshChannel(root);
  const fasti = await Fasti.open({ dataRoot: root });
  const expIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const exp = await fasti.ingestRawTurn('dsh', {
      event_id: `evt-${i}`,
      session_id: 's1',
      speaker: 'user',
      initiation: 'user',
      raw_text: `内容${i}`,
      asserted_at: iso(T0 + i * DAY),
      occurred_at: iso(T0 + i * DAY),
    });
    expIds.push(exp.id);
  }
  const events = await fasti.queryEvents();
  await fasti.close();
  const eventIds: string[] = [];
  for (const [i, ev] of events.entries()) {
    eventIds.push(ev.id);
    const ready: EventRecord = {
      ...ev,
      version: ev.version + 1,
      status: 'closed',
      closed_reason: 'silence',
      summary_quality: 'ready',
      summary: '客观摘要（仅供测试阅读，不进卡）',
      // G7：每个事件带可区分 key_points，供种子卡走 key_points→cue 真派生（禁手写线索）。
      key_points: [`关键点${i}`],
      anchors: ev.pointers.map((p) => p.id),
    };
    appendJsonl(path.join(layoutOf(root).events, '2026-11.jsonl'), ready);
  }
  return { root, eventIds, expIds };
}

/** 不可解析数据根：直写经历/事件 JSONL（无原文/通道）→ resolvePointer 悬空（硬失败通路用）。 */
function makeNonResolvableRoot(n: number): { root: string; eventIds: string[]; expIds: string[] } {
  const root = makeTempRoot('audit-nonres-');
  const expIds: string[] = [];
  const eventIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = ulid();
    expIds.push(id);
    appendJsonl(path.join(root, 'experiences', '2026-11.jsonl'), makeExperience({ id, tick: i, occurred_at: iso(T0 + i * DAY), recorded_at: iso(T0 + i * DAY) }));
  }
  for (let i = 0; i < n; i += 1) {
    const eid = ulid();
    eventIds.push(eid);
    appendJsonl(path.join(root, 'events', '2026-11.jsonl'), readyEventRecord(eid, [expIds[i]!], T0 + i * DAY, [`关键点${i}`]));
  }
  return { root, eventIds, expIds };
}

/**
 * 测试夹具：经写柄事务直接种入合成记忆卡（仅测试基建，不经任何人工建卡/填表通道）。
 * 为每个 closed+ready 事件写一张 active 卡与一条 miss 别名，供后续 build/audit 在合成一致根上端到端验证。
 */
async function seedCards(root: string): Promise<void> {
  const rows: EventRecord[] = [];
  const dir = layoutOf(root).events;
  for (const name of listFiles(dir, '.jsonl')) {
    for (const raw of readJsonlFile<unknown>(path.join(dir, name))) {
      rows.push(parseEvent(raw, 'read'));
    }
  }
  const ready = foldCurrentEvents(rows).filter((e) => e.status === 'closed' && e.summary_quality === 'ready');
  // 种入时刻取「真实现在 - 1 天」：保证 CLI 边界 Date.now() 的 listEffective 能纳入卡（spawn 与程序化两路一致）。
  const atMs = Date.now() - DAY;
  const entries = ready.map((event, i) => {
    const anchors = [...new Set(event.anchors)].sort();
    const cardId = deriveCardId(event.id, anchors);
    const anchorJson = JSON.stringify(anchors);
    // G7（v4 §6）：合成构造方以 rules-v2 离线口径从事件 key_points 真派生 cue，
    // 禁止手写「线索i」——手写 cue 绕过 key_points→cue 派生链，会让 P6 测不到路线 A 真链路。
    const derivedCues = normalizeDisplayCues(
      deriveCuesFromKeyPoints({ keyPoints: event.key_points, summary: event.summary }).cues,
    );
    const displayCuesJson = JSON.stringify(derivedCues);
    // G3/E-12：miss 别名生产恒 sensitive=1，C5 合成根须与生产对齐（v4 §9 序 7）。
    const aliasesJson = JSON.stringify([{ term: `别名${i}`, source: 'miss' as const, sensitive: 1 as const }]);
    const discriminator = `判别${i}`;
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
      occurredMs: event.started_ms,
      endedMs: event.ended_ms,
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
    const aliasRows: AliasRow[] = [{
      termNorm: `别名${i}`,
      cardId,
      source: 'miss',
      sensitive: 1,
      status: 'active',
      createdMs: atMs,
      hitCount: 0,
      lastHitMs: null,
    }];
    return { card, aliasRows };
  });

  const indexDir = path.join(root, 'projection', 'memory-index');
  const handle = openMemoryWrite({ indexDir });
  try {
    const cards = entries.map((e) => e.card);
    const aliases = entries.flatMap((e) => e.aliasRows);
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: atMs,
      schema_version: 3,
      truth_fingerprint: computeTruthFingerprint(root).aggregate,
      prior_revision: null,
      card_count: cards.length,
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
      // G7：本合成根由离线构造方显式按 rules-v2 派生 cue，决策行如实落章（生产面仍 rules-v1）。
      model_tag: 'rules-v2',
      reason: 'fixture: 测试建卡',
      created_by: 'her',
    }));
    handle.transactionApply({ cards, aliases }, revision, decisions);
  } finally {
    await handle.close();
  }
}

/** 合成夹具（id 指向被测合成数据；l0 检索词与种子卡的真派生 cue 同源对齐，禁手写）。 */
function writeSyntheticFixtures(dir: string, eventIds: string[], expIds: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const l0 = {
    probeSetVersion: 'v1',
    layer: 'l0',
    items: eventIds.map((id, i) => {
      // 与 seedCards 同一派生函数、同一 key_points：查询即该事件派生 cue 的首条，
      // 保证 l0 命中走的是真派生链路上的词面，而不是测试里另写的一套词。
      const [derivedCue] = deriveCuesFromKeyPoints({
        keyPoints: [`关键点${i}`],
        summary: '客观摘要（仅供测试阅读，不进卡）',
      }).cues;
      return {
        eventId: id,
        channel: 'dsh',
        queries: [derivedCue],
        aliases: [],
        sensitiveTerms: [],
        discriminatorNeighborEventIds: [],
        expectedSlots: ['relevance'],
      };
    }),
  };
  const l1 = {
    probeSetVersion: 'v1',
    layer: 'l1',
    items: expIds.map((id, i) => ({ questionExperienceId: id, targetEventId: eventIds[i], initiation: 'user', coldStart: false })),
  };
  fs.writeFileSync(path.join(dir, 'gold-l0.json'), JSON.stringify(l0));
  fs.writeFileSync(path.join(dir, 'gold-l1.json'), JSON.stringify(l1));
  fs.writeFileSync(path.join(dir, 'holdout.json'), JSON.stringify({ probeSetVersion: 'v1', layer: 'l2', items: [] }));
  fs.writeFileSync(path.join(dir, 'decoy.json'), JSON.stringify({ probeSetVersion: 'v1', layer: 'decoy', items: [] }));
}

test('I11 · CLI 旗标守卫：无参/缺 --out/--out 落根内 → exit2；--help → exit0', () => {
  assert.equal(runAuditCli([]).status, 2, '无参');
  assert.equal(runAuditCli(['--data-root', '/tmp/x']).status, 2, '缺 --out');
  const root = makeTempRoot('audit-guard-');
  try {
    assert.equal(runAuditCli(['--data-root', root, '--out', path.join(root, 'audit')]).status, 2, '--out 位于根内');
    assert.equal(runAuditCli(['--data-root', root, '--out', root]).status, 2, '--out 等于根');
    assert.equal(runAuditCli(['--help']).status, 0, '--help');
  } finally {
    cleanupTempRoot(root);
  }
});

test('I1-A/I2 · runAudit dry-run：生产索引零字节、provenance 可解析通过、不落库', async () => {
  const { root, eventIds, expIds } = await makeAuditableRoot(2);
  const fixDir = makeTempRoot('audit-fix-');
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    writeSyntheticFixtures(fixDir, eventIds, expIds);
    const indexFile = path.join(root, 'projection', 'memory-index', 'memory-index.sqlite');
    const before = fs.readFileSync(indexFile);
    const report = await runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: false, dryRun: true, nowMs: AUDIT_NOW });
    assert.equal(report.written, false);
    assert.equal(report.provenanceFailed, false, '合成经历可解析 → provenance 通过');
    assert.deepEqual(fs.readFileSync(indexFile), before, '生产索引零字节写入');
    assert.ok(report.items.length > 0);
    assert.ok(report.redLines.r1 !== null && report.redLines.r1 > 0, 'l0 检索词命中 → R1>0');
  } finally {
    cleanupTempRoot(fixDir);
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

test('I1-A/I10 · runAudit 写独立 --out 库：审计落行、生产索引零字节、生产卡 hitCount 恒 0', async () => {
  const { root, eventIds, expIds } = await makeAuditableRoot(2);
  const fixDir = makeTempRoot('audit-fix-');
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    writeSyntheticFixtures(fixDir, eventIds, expIds);
    const indexFile = path.join(root, 'projection', 'memory-index', 'memory-index.sqlite');
    const before = fs.readFileSync(indexFile);
    const report = await runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: false, dryRun: false, nowMs: AUDIT_NOW });
    assert.equal(report.written, true);
    assert.deepEqual(fs.readFileSync(indexFile), before, '生产索引零字节写入');
    const outDb = new DatabaseSync(path.join(outDir, 'memory-index.sqlite'), { readOnly: true });
    try {
      assert.equal((outDb.prepare('SELECT * FROM mem_audit_run').all() as unknown[]).length, 1);
      assert.equal((outDb.prepare('SELECT * FROM mem_audit_item').all() as unknown[]).length, report.items.length);
      assert.equal((outDb.prepare('SELECT * FROM mem_card').all() as unknown[]).length, 0, '--out 库卡表为空');
    } finally {
      outDb.close();
    }
    const read = openMemoryRead({ indexDir: path.join(root, 'projection', 'memory-index') });
    try {
      for (const card of read.listEffective(AUDIT_NOW)) {
        assert.equal(card.hitCount, 0, '生产卡 hitCount 恒 0（I10）');
        assert.equal(card.lastHitMs, null, '生产卡 lastHitMs 恒 null');
      }
    } finally {
      await read.close();
    }
  } finally {
    cleanupTempRoot(fixDir);
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

test('I13 · CLI 硬失败通路：经历不可解析 → 悬空锚点 → provenance failed → exit 非零', async () => {
  const { root } = makeNonResolvableRoot(2);
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    const result = runAuditCli(['--data-root', root, '--out', outDir, '--json']);
    assert.notEqual(result.status, 0, 'provenance 硬失败 → 非零退出码');
  } finally {
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

test('I11/I13 · CLI 红线观测不卡退出码：可解析数据 → exit0（R1 即便 0 也不门禁）', async () => {
  const { root } = await makeAuditableRoot(2);
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    const result = runAuditCli(['--data-root', root, '--out', outDir, '--json']);
    assert.equal(result.status, 0, 'provenance 通过 → exit0');
    const report = JSON.parse(result.stdout) as { provenanceFailed: boolean; written: boolean };
    assert.equal(report.provenanceFailed, false);
    assert.equal(report.written, true);
  } finally {
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// I15/I13/I9 · LOEO 降级标注 / M7 指标正确性通路 / 10 事件全流程
// ═══════════════════════════════════════════════════════════════════════════

test('I15/序6/序9 · --holdout 必须走封存集：哈希核验＋解封留痕＋LOEO 真逐折', async () => {
  const { root, eventIds, expIds } = await makeAuditableRoot(3);
  const fixDir = makeTempRoot('audit-fix-');
  const sealDir = makeTempRoot('audit-seal-');
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    writeSyntheticFixtures(fixDir, eventIds, expIds);
    sealFixtures({
      sourceDir: fixDir,
      sealDir,
      probeSetVersion: 'v1',
      rulesVersion: 'rules-v1',
      rngSeed: DEFAULT_RNG_SEED,
      sealedAtMs: AUDIT_NOW,
      sealedBy: 'qa-harness',
      layerQuotas: { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0 },
      decoyPairCount: 0,
    });
    const report = await runAudit({
      dataRoot: root,
      outDir,
      fixturesDir: fixDir,
      holdout: true,
      dryRun: true,
      nowMs: AUDIT_NOW,
      sealedDir: sealDir,
      unsealReason: 'P6 C5 合成根首跑',
      operator: 'qa-harness',
    });
    assert.equal(report.holdout.mode, 'loeo', '日历周数 <5 → LOEO');
    assert.equal(report.holdout.folds, 3, '折数=参与提问的去重目标事件数');
    assert.ok(report.holdout.loeo);
    const loeo = report.holdout.loeo!;
    assert.equal(loeo.conclusive, true);
    assert.equal(loeo.perFold.length, 3);
    for (const fold of loeo.perFold) {
      assert.equal(fold.n, 4, '留出一事件后每折剩 4 题（6-2）');
      assert.ok(fold.hits >= 0 && fold.hits <= fold.n);
      assert.equal(fold.rate, fold.hits / fold.n);
    }
    assert.equal(typeof loeo.pooledRate, 'number');
    const log = readUnsealLog(sealDir);
    assert.equal(log.length, 1, '本次读取封存集追加一行解封留痕');
    assert.equal(log[0]!.reason, 'P6 C5 合成根首跑');
    assert.equal(log[0]!.mode, 'loeo');
    assert.equal(log[0]!.folds, 3);
    const notes = JSON.parse(report.run.notesJson) as { holdout: { mode: string; folds: number; unsealedAt?: number; loeo?: unknown } };
    assert.ok(notes.holdout.loeo, '逐折结果随封存信封落 notes');
    assert.ok(typeof notes.holdout.unsealedAt === 'number', '解封时刻入 notes');
  } finally {
    cleanupTempRoot(fixDir);
    cleanupTempRoot(sealDir);
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

test('序9/G6 · 裸 --holdout（无封存目录/无理由）fail-closed，旧旗标通路彻底废止', async () => {
  const { root, eventIds, expIds } = await makeAuditableRoot(2);
  const fixDir = makeTempRoot('audit-fix-');
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    writeSyntheticFixtures(fixDir, eventIds, expIds);
    await assert.rejects(
      () => runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: true, dryRun: true, nowMs: AUDIT_NOW }),
      /--seal-dir/,
    );
  } finally {
    cleanupTempRoot(fixDir);
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

test('I13 · M7 指标正确性通路：注入错标金标卡 → R2 精确捕获（错误计数≥注入数，高危单独计）', () => {
  // 注入 2 条错标（top1 不符），其中 1 条高危日期类；1 条正确。
  const decoy = [
    { goldCardId: 'mc_a', topCardId: 'mc_a', correct: true, highRiskError: false },
    { goldCardId: 'mc_b', topCardId: 'mc_wrong', correct: false, highRiskLabel: 'date' as const, highRiskError: true },
    { goldCardId: 'mc_c', topCardId: 'mc_wrong', correct: false, highRiskError: false },
  ];
  const metrics = aggregateMetrics(aggregateInput({ decoy }), { rng: mulberry32(DEFAULT_RNG_SEED) });
  const r2 = metrics.quality.r2;
  assert.ok('point' in r2);
  assert.equal(r2.n, 3);
  assert.ok(r2.point >= 2 / 3, 'R2 错误率≥注入错误数/总数（不漏报）');
  assert.equal(metrics.quality.r2HighRiskErrors, 1, '高危错认单独计 1');
});

test('I9 · N/A 规则：consistency 空样本 → notes 记 n-a/pairs0，R3 不填数不参与达标', async () => {
  const { root, eventIds, expIds } = await makeAuditableRoot(2);
  const fixDir = makeTempRoot('audit-fix-');
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    writeSyntheticFixtures(fixDir, eventIds, expIds);
    const report = await runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: false, dryRun: true, nowMs: AUDIT_NOW });
    const notes = JSON.parse(report.run.notesJson) as { consistency: { status: string; pairs: number } };
    assert.deepEqual(notes.consistency, { status: 'n-a', pairs: 0 });
    assert.deepEqual(report.metrics.quality.r3, { status: 'n-a', reason: 'no-reflection-pair' });
    assert.equal(report.redLines.r3, null, 'R3 不填数');
  } finally {
    cleanupTempRoot(fixDir);
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

test('I1-A/I10 · 10 事件全流程：合成卡→build→audit，10 卡、provenance 通过、R1>0、hitCount 恒 0、审计落独立库', async () => {
  const { root, eventIds, expIds } = await makeAuditableRoot(10);
  const fixDir = makeTempRoot('audit-fix-');
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    writeSyntheticFixtures(fixDir, eventIds, expIds);
    const indexFile = path.join(root, 'projection', 'memory-index', 'memory-index.sqlite');
    const before = fs.readFileSync(indexFile);
    const report = await runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: false, dryRun: false, nowMs: AUDIT_NOW });
    assert.equal(report.provenanceFailed, false, '10 事件锚点全可解析');
    assert.deepEqual(fs.readFileSync(indexFile), before, '生产索引零字节');
    assert.equal(report.items.filter((i) => i.probeType === 'gold').length, 20, 'l0 10 问 + l1 10 问');
    assert.ok(report.redLines.r1 !== null && report.redLines.r1 > 0, 'l0 检索词命中 → R1>0');
    const read = openMemoryRead({ indexDir: path.join(root, 'projection', 'memory-index') });
    try {
      const cards = read.listEffective(AUDIT_NOW);
      assert.equal(cards.length, 10, '10 张卡');
      for (const card of cards) {
        assert.equal(card.hitCount, 0);
        assert.equal(card.lastHitMs, null);
      }
    } finally {
      await read.close();
    }
    const outDb = new DatabaseSync(path.join(outDir, 'memory-index.sqlite'), { readOnly: true });
    try {
      assert.equal((outDb.prepare('SELECT * FROM mem_audit_run').all() as unknown[]).length, 1);
      assert.equal((outDb.prepare('SELECT * FROM mem_card').all() as unknown[]).length, 0);
    } finally {
      outDb.close();
    }
  } finally {
    cleanupTempRoot(fixDir);
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// G7 · 审计信封去硬编码：规则版本如实落 modelTag（v4 §6/§9 序 5）
// ═══════════════════════════════════════════════════════════════════════════

test('G7 · runAudit 缺省信封记 rules-v1；显式 rules-v2 如实落 modelTag；未知版本 fail-closed', async () => {
  const { root, eventIds, expIds } = await makeAuditableRoot(2);
  const fixDir = makeTempRoot('audit-fix-');
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    writeSyntheticFixtures(fixDir, eventIds, expIds);

    const v1 = await runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: false, dryRun: true, nowMs: AUDIT_NOW });
    assert.equal(v1.run.modelTag, 'rules-v1', '缺省=当前生产版本，不再硬编码但默认值一致');
    assert.equal((JSON.parse(v1.run.notesJson) as { rulesVersion: string }).rulesVersion, 'rules-v1');

    const v2 = await runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: false, dryRun: true, nowMs: AUDIT_NOW, rulesVersion: 'rules-v2' });
    assert.equal(v2.run.modelTag, 'rules-v2', '离线构造方显式传入的受测版本如实入信封');
    assert.equal(v2.redLines.r1 !== null && v2.redLines.r1 > 0, true, '真派生 cue 对齐 l0 查询，R1>0 不依赖手写线索');

    await assert.rejects(
      () => runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: false, dryRun: true, nowMs: AUDIT_NOW, rulesVersion: 'rules-v9' }),
      /未知规则版本/,
    );
  } finally {
    cleanupTempRoot(fixDir);
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

test('G7 · CLI --rules-version 未知值非零退出；--help 暴露该参数', async () => {
  const { root } = await makeAuditableRoot(1);
  const outDir = makeTempRoot('audit-out-');
  try {
    const bad = runAuditCli(['--data-root', root, '--out', path.join(outDir, 'x'), '--rules-version', 'rules-v9', '--json']);
    assert.notEqual(bad.status, 0, '未知规则版本 fail-closed');
    const help = runAuditCli(['--help']);
    assert.match(help.stdout, /--rules-version/);
  } finally {
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// B4/序10 · 零字节承诺边界钉死：承诺仅限记忆索引，dataRoot 其他写通路如实承认
// ═══════════════════════════════════════════════════════════════════════════

test('B4 · 审计只读不改记忆索引；checkpoint/events 写通路客观存在，零字节承诺不得外扩', async () => {
  const { root, eventIds, expIds } = await makeAuditableRoot(2);
  const fixDir = makeTempRoot('audit-fix-');
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    writeSyntheticFixtures(fixDir, eventIds, expIds);

    // 写通路事实（非记忆索引）：Fasti.open 对账落 checkpoint；事件版本追加落 events JSONL。
    const checkpointFile = path.join(root, 'state', 'checkpoint.json');
    assert.ok(fs.existsSync(checkpointFile), 'Fasti.open 启动对账原子写 state/checkpoint.json（api/index.ts → checkpoint.save）');
    const eventFiles = listFiles(layoutOf(root).events, '.jsonl');
    assert.ok(eventFiles.some((name) => fs.statSync(path.join(layoutOf(root).events, name)).size > 0), 'events/*.jsonl 存在非零事件版本追加');

    // 零字节承诺本体：审计运行前后记忆索引逐字节一致，且 checkpoint 不在索引目录内。
    const indexDir = path.join(root, 'projection', 'memory-index');
    const indexFile = path.join(indexDir, 'memory-index.sqlite');
    const before = fs.readFileSync(indexFile);
    const report = await runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: false, dryRun: true, nowMs: AUDIT_NOW });
    assert.deepEqual(fs.readFileSync(indexFile), before, '记忆索引审计期间零字节变化');
    assert.equal(report.provenanceFailed, false);
    assert.ok(!checkpointFile.startsWith(indexDir), 'checkpoint 写通路位于索引目录之外，边界可机械区分');
  } finally {
    cleanupTempRoot(fixDir);
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// C2/序3 · 四态/弃权接入 CLI 主链路（v4 §5.0：top1 口径与 R1 top-k 并列、三分母隔离）
// ═══════════════════════════════════════════════════════════════════════════

test('C2 · 无 abstain.json：金标题四态照算且显式标注探针文件缺失', async () => {
  const { root, eventIds, expIds } = await makeAuditableRoot(2);
  const fixDir = makeTempRoot('audit-fix-');
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    writeSyntheticFixtures(fixDir, eventIds, expIds); // 不写 abstain.json
    const report = await runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: false, dryRun: true, nowMs: AUDIT_NOW });
    assert.equal(report.abstainFixturePresent, false);
    assert.ok('rates' in report.fourState, '金标题存在，四态不得整体 N/A');
    if ('rates' in report.fourState) {
      // 2 事件 ×（l0 一问 + l1 一问）= 4 条有金标探针
      assert.equal(report.fourState.counts.N, 4);
      assert.equal(report.fourState.counts.G, 4);
      assert.equal(report.fourState.counts.NG, 0);
    }
    const notes = JSON.parse(report.run.notesJson) as { abstainFixturePresent: boolean; fourState: unknown };
    assert.equal(notes.abstainFixturePresent, false);
    assert.ok(notes.fourState !== undefined, '四态结果落 notes（审计 item DDL 冻结不新增 probe_type）');
  } finally {
    cleanupTempRoot(fixDir);
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});

test('C2 · 加载 abstain.json：不可答探针未认定 → correct-abstain（ca），三分母独立计数', async () => {
  const { root, eventIds, expIds } = await makeAuditableRoot(2);
  const fixDir = makeTempRoot('audit-fix-');
  const outDir = makeTempRoot('audit-out-');
  try {
    await seedCards(root);
    writeSyntheticFixtures(fixDir, eventIds, expIds);
    fs.writeFileSync(
      path.join(fixDir, 'abstain.json'),
      JSON.stringify({
        probeSetVersion: 'v1',
        layer: 'abstain',
        items: [{ query: '绝对查不到的天外飞来提问xyz123', goldCardId: null, kind: 'unanswerable' }],
      }),
    );
    const report = await runAudit({ dataRoot: root, outDir, fixturesDir: fixDir, holdout: false, dryRun: true, nowMs: AUDIT_NOW });
    assert.equal(report.abstainFixturePresent, true);
    assert.ok('rates' in report.fourState);
    if ('rates' in report.fourState) {
      assert.equal(report.fourState.counts.N, 5, '4 金标题 + 1 无金标探针');
      assert.equal(report.fourState.counts.ca, 1, '不可答且门未认定 → correct-abstain');
      assert.equal(report.fourState.counts.NG, 1);
      // 无金标题正确拒绝率 = ca/NG = 1
      assert.equal(report.fourState.rates.correctRejectRate, 1);
    }
    // R1 分母不含弃权探针（三分母隔离）：R1 仍只来自 4 条金标题
    assert.ok(report.redLines.r1 !== null);
  } finally {
    cleanupTempRoot(fixDir);
    cleanupTempRoot(outDir);
    cleanupTempRoot(root);
  }
});