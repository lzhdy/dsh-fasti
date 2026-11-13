/**
 * 第二层 WP1 · 运行期窄柄骨架与只读 searchExplained 测试（提纲 v0.3 §4/§5.2/§6.2）。
 *
 * 本 WP 范围（只读骨架，写方法在 WP2 增补）：
 *  - 独立窄柄工厂 openMemoryRuntime 返回委托包装对象（N13-i）：禁对完整柄 as 断言，
 *    反射只见窄方法，全量写/读方法名在窄柄上不可见；
 *  - N11 三道防线（只读侧）：RuntimeSearchQuery 类型无 limit 键（编译期守门）、
 *    委托写死 limit:undefined 不转发（any 强传 limit 运行时无效）、全集 explained 零漂移；
 *  - N17：searchExplained 仅窄柄暴露，MemoryReadHandle 公开面不新增该方法；
 *  - getCardsByAnchor 只读委托；缺库抛 NotFoundError；close 生命周期。
 *
 * 纪律：全部 tests/helpers 临时根，真实数据根零接触；atMs 注入、无 Date.now()。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { ConflictError, NotFoundError, UnavailableError } from '../../src/core/errors.ts';
import { sha256Hex } from '../../src/core/hash.ts';
import { ulid } from '../../src/core/ulid.ts';
import { searchCardsExplained } from '../../src/memory/bm25.ts';
import { computeContentHash } from '../../src/memory/builder.ts';
import { computeMissTermHash } from '../../src/memory/miss.ts';
import { MemoryIndexStaleError } from '../../src/memory/memory-errors.ts';
import { openMemoryRuntime } from '../../src/memory/runtime.ts';
import { SHADOW_DIRNAME, SHADOW_LOG_FILE } from '../../src/memory/shadow-write.ts';
import type { ShadowObservationInput } from '../../src/memory/shadow-write.ts';
import type {
  RuntimeAddMissAliasInput,
  RuntimeMemoryHandle,
  RuntimeSearchQuery,
} from '../../src/memory/runtime.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../src/memory/store.ts';
import type {
  AliasRow,
  MemoryCard,
  MissObservationInput,
  RevisionRecord,
} from '../../src/memory/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const AT = T0 + 30 * DAY;
const ANCHOR_A = ulid();
const ANCHOR_B = ulid();

// ── N11 类型层守门（编译期）：RuntimeSearchQuery 出现 limit 键即 tsc 红 ──────
type AssertNoLimit = 'limit' extends keyof RuntimeSearchQuery ? false : true;
const n11NoLimitKey: AssertNoLimit = true;
// N4/N14 类型层守门：运行期卡写入参不得出现 sensitive 键（内部固定 1，不可表达）。
type AssertNoSensitive = 'sensitive' extends keyof RuntimeAddMissAliasInput ? false : true;
const n4NoSensitiveParam: AssertNoSensitive = true;
// WP4a/N16 窄柄恰六方法：六个窄方法都在，全量柄方法一个都不在（第五→六为影子观测窄写）。
type RtKeys = keyof RuntimeMemoryHandle;
type NarrowKeys =
  | 'searchExplained'
  | 'getCardsByAnchor'
  | 'close'
  | 'addMissAlias'
  | 'recordMiss'
  | 'recordShadowObservation';
type AssertAllNarrowPresent = NarrowKeys extends RtKeys ? true : false;
type AssertNoFullHandle =
  RtKeys extends NarrowKeys
    ? 'transactionApply' extends RtKeys
      ? false
      : 'stampRevision' extends RtKeys
        ? false
        : 'writeAuditRun' extends RtKeys
          ? false
            : 'search' extends RtKeys
              ? false
              : true
    : false;
const wp4aSixKeyShape: AssertAllNarrowPresent & AssertNoFullHandle = true;
void n11NoLimitKey;
void n4NoSensitiveParam;
void wp4aSixKeyShape;

// ── 夹具 ──────────────────────────────────────────────────────────────────

interface CardSpec {
  cardId: string;
  anchor: string;
  cues: string[];
  aliases: Array<{ term: string; sensitive: 0 | 1 }>;
  discriminator: string;
  occurredMs: number;
}

function mkCard(spec: CardSpec): { card: MemoryCard; aliasRows: AliasRow[] } {
  const anchorJson = JSON.stringify([spec.anchor]);
  const displayCuesJson = JSON.stringify(spec.cues);
  const aliasesJson = JSON.stringify(
    spec.aliases.map((a) => ({ term: a.term, source: 'miss', sensitive: a.sensitive })),
  );
  const card: MemoryCard = {
    cardId: spec.cardId,
    eventId: `evt-${spec.cardId}`,
    anchorJson,
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator: spec.discriminator,
    entityHintJson: null,
    occurredMs: spec.occurredMs,
    endedMs: spec.occurredMs + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, spec.discriminator),
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  const aliasRows: AliasRow[] = spec.aliases.map((a) => ({
    termNorm: a.term,
    cardId: spec.cardId,
    source: 'miss',
    sensitive: a.sensitive,
    status: 'active',
    createdMs: T0,
    hitCount: 0,
    lastHitMs: null,
  }));
  return { card, aliasRows };
}

const CORPUS: CardSpec[] = [
  {
    cardId: 'mc_a',
    anchor: ANCHOR_A,
    cues: ['咖啡馆约会'],
    aliases: [
      { term: '咖啡馆', sensitive: 0 },
      { term: '猫', sensitive: 0 },
    ],
    discriminator: '城南老店',
    occurredMs: T0,
  },
  {
    cardId: 'mc_b',
    anchor: ANCHOR_B,
    cues: ['深夜食堂加班'],
    aliases: [
      { term: '深夜食堂', sensitive: 0 },
      { term: '猫', sensitive: 0 },
    ],
    discriminator: '加班夜宵',
    occurredMs: T0 + 5 * DAY,
  },
  {
    cardId: 'mc_c',
    anchor: ulid(),
    cues: ['图书馆自习'],
    aliases: [{ term: '私密词', sensitive: 1 }],
    discriminator: '靠窗座位',
    occurredMs: T0 + 10 * DAY,
  },
];

async function seedCorpus(): Promise<{ root: string; indexDir: string; file: string }> {
  const root = makeTempRoot('mem-runtime-wp1-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const entries = CORPUS.map(mkCard);
  const cards = entries.map((e) => e.card);
  const aliases = entries.flatMap((e) => e.aliasRows);
  const handle = openMemoryWrite({ indexDir });
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 1,
      truth_fingerprint: 'fp-runtime-wp1',
      prior_revision: null,
      card_count: cards.length,
      alias_count: aliases.length,
      row_hash_sum: 'rh-runtime-wp1',
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    handle.transactionApply({ cards, aliases }, revision, []);
  } finally {
    await handle.close();
  }
  return { root, indexDir, file: path.join(indexDir, MEMORY_INDEX_FILE) };
}

// ── 用例 ──────────────────────────────────────────────────────────────────

test('openMemoryRuntime：索引库不存在时抛 NotFoundError 且不创建文件', () => {
  const root = makeTempRoot('mem-runtime-missing-');
  try {
    const indexDir = path.join(root, 'projection', 'memory-index');
    assert.throws(() => openMemoryRuntime({ indexDir }), NotFoundError);
  } finally {
    cleanupTempRoot(root);
  }
});

test('N13-i 委托包装对象：反射恰见六窄方法，全量柄方法名不可见', async () => {
  const { root, indexDir } = await seedCorpus();
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      assert.deepEqual(Object.keys(handle).sort(), [
        'addMissAlias',
        'close',
        'getCardsByAnchor',
        'recordMiss',
        'recordShadowObservation',
        'searchExplained',
      ]);
      for (const forbidden of [
        'search',
        'getCard',
        'getCardByEvent',
        'listEffective',
        'verifyStampedFingerprint',
        'stampRevision',
        'transactionApply',
        'writeAuditRun',
      ]) {
        assert.equal(
          Object.getOwnPropertyDescriptor(handle, forbidden),
          undefined,
          `窄柄不得可见全量方法 ${forbidden}`,
        );
      }
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('searchExplained：返回带 matchKinds 的全集，与低层零漂移逐字一致', async () => {
  const { root, indexDir, file } = await seedCorpus();
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      const query: RuntimeSearchQuery = { text: '猫', atMs: AT };
      const explained = await handle.searchExplained(query);
      // “猫”精确别名命中 mc_a 与 mc_b 两张（多候选全集，不截断）。
      assert.deepEqual(
        explained.map((r) => r.card.cardId),
        ['mc_b', 'mc_a'],
      );
      for (const item of explained) {
        assert.ok(Array.isArray(item.matchKinds) && item.matchKinds.includes('exact-alias'));
      }
      // 零漂移参照：直开只读库、显式 limit:undefined 的低层结果须逐字一致。
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const reference = searchCardsExplained(db, { text: '猫', atMs: AT, limit: undefined });
        assert.deepEqual(explained, reference);
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('N11 防线②：any 强塞 limit 运行时无效，窄柄仍返回未截断全集', async () => {
  const { root, indexDir } = await seedCorpus();
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      const poisoned = { text: '猫', atMs: AT, limit: 1 } as unknown as RuntimeSearchQuery;
      const explained = await handle.searchExplained(poisoned);
      assert.equal(explained.length, 2, '委托不得转发调用方 limit，弱尾候选不得被预截断');
      assert.deepEqual(
        explained.map((r) => r.card.cardId),
        ['mc_b', 'mc_a'],
      );
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('getCardsByAnchor：委托只读反查命中锚定卡，非法 ULID fail-loud', async () => {
  const { root, indexDir } = await seedCorpus();
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      const hits = handle.getCardsByAnchor(ANCHOR_A);
      assert.deepEqual(
        hits.map((c) => c.cardId),
        ['mc_a'],
      );
      assert.deepEqual(handle.getCardsByAnchor(ulid()), []);
      assert.throws(() => handle.getCardsByAnchor('not-a-ulid'));
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('N4/N14 addMissAlias：窄柄无 sensitive 入参，落库别名恒 sensitive=1 且下轮精确命中', async () => {
  const { root, indexDir, file } = await seedCorpus();
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      // 回填前该词零命中。
      assert.deepEqual((await handle.searchExplained({ text: '回查新词', atMs: AT })).map((r) => r.card.cardId), []);

      const input: RuntimeAddMissAliasInput = { term: '回查新词', cardId: 'mc_a', atMs: AT };
      const outcome = handle.addMissAlias(input);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.cardId, 'mc_a');

      // 下一轮精确路即命中（sensitive=1 仅精确路可达）。
      assert.deepEqual(
        (await handle.searchExplained({ text: '回查新词', atMs: AT })).map((r) => r.card.cardId),
        ['mc_a'],
      );

      // 库内实证：窄柄写入的别名 sensitive 恒为 1。
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT sensitive, status, source FROM mem_alias WHERE term_norm = ? AND card_id = ?")
          .get('回查新词', 'mc_a') as { sensitive: number; status: string; source: string };
        assert.equal(row.sensitive, 1);
        assert.equal(row.status, 'active');
        assert.equal(row.source, 'miss');

        // any 强塞 sensitive:0 不可表达：委托忽略，落库仍为 1。
        const poisoned = { term: '强塞词', cardId: 'mc_b', atMs: AT, sensitive: 0 } as unknown as RuntimeAddMissAliasInput;
        handle.addMissAlias(poisoned);
        const poisonedRow = db
          .prepare('SELECT sensitive FROM mem_alias WHERE term_norm = ?')
          .get('强塞词') as { sensitive: number };
        assert.equal(poisonedRow.sensitive, 1);
      } finally {
        db.close();
      }

      // 幂等：同一别名二次写入 already-active、不抛错。
      const again = handle.addMissAlias({ term: '回查新词', cardId: 'mc_a', atMs: AT });
      assert.equal(again.ok, true);
      assert.equal(again.changed, false);
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('recordMiss：观测落 mem_miss（term_hash、无原文列、append-only 不去重）', async () => {
  const { root, indexDir, file } = await seedCorpus();
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      const observation: MissObservationInput = {
        termNorm: '漏召词',
        channel: 'dsh',
        anchorEventId: null,
        anchorIds: null,
        returnedCount: 0,
        observedMs: AT,
      };
      handle.recordMiss(observation);
      handle.recordMiss(observation);

      const db = new DatabaseSync(file, { readOnly: true });
      try {
        // 列集冻结八列，不存在任何原始查询文本列。
        const rawColumns = db.prepare('PRAGMA table_info(mem_miss)').all() as Array<{ name: string }>;
        const columns = rawColumns.map((c) => c.name);
        assert.deepEqual(columns.sort(), [
          'anchor_event_id',
          'anchor_json',
          'channel',
          'id',
          'observed_ms',
          'returned_count',
          'term_hash',
          'term_norm',
        ].sort());
        const rows = db.prepare('SELECT term_hash FROM mem_miss WHERE term_norm = ?').all('漏召词') as Array<{
          term_hash: string;
        }>;
        assert.equal(rows.length, 2, 'append-only 不去重，重放行数倍增');
        const first = rows[0];
        assert.ok(first);
        assert.equal(first.term_hash, computeMissTermHash('漏召词'));
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('N16 recordShadowObservation：第六窄方法落独立影子 JSONL，termNorm 不落盘、写失败隔离', async () => {
  const { root, indexDir } = await seedCorpus();
  try {
    const handle = openMemoryRuntime({ indexDir });
    try {
      const shadowInput: ShadowObservationInput = {
        termNorm: 'cat',
        gatedStatus: 'abstain',
        legacyCount: 2,
        acceptedCount: 0,
        rejectedReasonCodes: ['like-only-weak-match'],
        observedMs: AT,
      };
      const outcome = handle.recordShadowObservation(shadowInput);
      assert.equal(outcome.ok, true);

      const logFile = path.join(root, 'projection', SHADOW_DIRNAME, SHADOW_LOG_FILE);
      const raw = fs.readFileSync(logFile, 'utf8');
      const row = JSON.parse(raw.trim()) as Record<string, unknown>;
      assert.equal(row.termHash, sha256Hex('cat'));
      assert.equal(row.gatedStatus, 'abstain');
      assert.ok(!raw.includes('termNorm') && !raw.includes('"cat"'), '原文/termNorm 永不落影子盘');

      // 白名单外键（路径形参/原文）在窄柄面上同样 fail-closed，且不抛穿、回 ok:false 或 IntegrityError。
      const smuggled = { ...shadowInput, shadowDir: '/etc' } as unknown as ShadowObservationInput;
      const bad = handle.recordShadowObservation(smuggled);
      assert.equal(bad.ok, false, '封闭窄写：白名单外键不得落盘');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('单例冲突：离线写柄占用时窄柄降级只读，读可用、写抛 UnavailableError', async () => {
  const { root, indexDir } = await seedCorpus();
  try {
    const occupier = openMemoryWrite({ indexDir });
    try {
      assert.throws(() => openMemoryWrite({ indexDir }), ConflictError);
      const handle = openMemoryRuntime({ indexDir });
      try {
        // 读路径在降级形态仍可用。
        assert.equal((await handle.searchExplained({ text: '猫', atMs: AT })).length, 2);
        assert.throws(
          () => handle.addMissAlias({ term: 'x', cardId: 'mc_a', atMs: AT }),
          UnavailableError,
        );
        assert.throws(
          () =>
            handle.recordMiss({
              termNorm: 'x',
              channel: 'dsh',
              anchorEventId: null,
              anchorIds: null,
              returnedCount: 0,
              observedMs: AT,
            }),
          UnavailableError,
        );

        // N16 影子写与 sqlite 写柄物理隔离：降级只读下旁路观测仍成功，不抢锁、不抛 UnavailableError。
        const shadowOutcome = handle.recordShadowObservation({
          termNorm: 'cat',
          gatedStatus: 'hit',
          legacyCount: 1,
          acceptedCount: 1,
          rejectedReasonCodes: [],
          observedMs: AT,
        });
        assert.equal(shadowOutcome.ok, true);
        const shadowLog = path.join(root, 'projection', SHADOW_DIRNAME, SHADOW_LOG_FILE);
        assert.ok(fs.existsSync(shadowLog));
      } finally {
        await handle.close();
      }
    } finally {
      await occupier.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('close：关闭后窄柄生命周期结束（内部连接释放）', async () => {
  const { root, indexDir } = await seedCorpus();
  try {
    const handle = openMemoryRuntime({ indexDir });
    await assert.doesNotReject(handle.close());
    // MemoryIndexStaleError 仅类型引用，确认本测试不依赖写柄指纹路径。
    assert.equal(typeof MemoryIndexStaleError, 'function');
  } finally {
    cleanupTempRoot(root);
  }
});
