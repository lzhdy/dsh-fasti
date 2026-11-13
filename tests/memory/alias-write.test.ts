/**
 * alias-write.ts 漏召回填别名窄写测试（#44，TDD；提案 §5.4/§5.5，闭合 D5/D6/D7/D8/N5）。
 *
 * 纪律：
 *  - :memory: 库测纯函数与低层事务；临时根测写柄委托/决策账本/读柄反查；真实数据根零接触；
 *  - 时钟经 createdMs/atMs 注入，函数内无 Date.now()；
 *  - INSERT-or-guard、仅两列写、单事务、上限 5、sensitive 不降级、统计不重置、两源自洽、N5 规范化归属。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { IntegrityError } from '../../src/core/errors.ts';
import { isUlid, ulid } from '../../src/core/ulid.ts';
import {
  MAX_MISS_ALIASES_PER_CARD,
  applyMissAlias,
  buildMissAlias,
} from '../../src/memory/alias-write.ts';
import type { BuildMissAliasInput } from '../../src/memory/alias-write.ts';
import { computeContentHash } from '../../src/memory/content-hash.ts';
import { syncFts } from '../../src/memory/fts.ts';
import { readDecisions } from '../../src/memory/ledger.ts';
import { MEMORY_SCHEMA } from '../../src/memory/schema.ts';
import {
  MEMORY_INDEX_FILE,
  cardFromRow,
  openMemoryRead,
  openMemoryWrite,
  writeAliases,
  writeCards,
} from '../../src/memory/store.ts';
import type { AliasRow, MemoryCard } from '../../src/memory/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 86400000;
const CARD_ID = 'mc_alias_under_test';
const EVENT_ID = 'evt-alias-under-test';

// ── 夹具 ──────────────────────────────────────────────────────────────────

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const statement of MEMORY_SCHEMA) {
    db.exec(statement);
  }
  return db;
}

function cardAliasObjects(aliases: readonly AliasRow[]): Array<{ term: string; source: 'miss'; sensitive: 0 | 1 }> {
  return aliases
    .filter((a) => a.status === 'active')
    .map((a) => ({ term: a.termNorm, source: 'miss' as const, sensitive: a.sensitive }));
}

function mkCard(aliases: readonly AliasRow[], overrides: Partial<MemoryCard> = {}): MemoryCard {
  const anchorJson = JSON.stringify(['exp-anchor-1', 'exp-anchor-2']);
  const displayCuesJson = JSON.stringify(['线索甲', '线索乙']);
  const aliasesJson = JSON.stringify(cardAliasObjects(aliases));
  return {
    cardId: CARD_ID,
    eventId: EVENT_ID,
    anchorJson,
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator: 'disc-alias',
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, 'disc-alias'),
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
    ...overrides,
  };
}

function seedDb(
  initialAliases: readonly AliasRow[],
  cardOverrides: Partial<MemoryCard> = {},
): { db: DatabaseSync; card: MemoryCard } {
  const db = memoryDb();
  const card = mkCard(initialAliases, cardOverrides);
  writeCards(db, [card]);
  writeAliases(db, initialAliases);
  syncFts(db, [CARD_ID]);
  return { db, card };
}

function row(termNorm: string, over: Partial<AliasRow> = {}): AliasRow {
  return {
    termNorm,
    cardId: CARD_ID,
    source: 'miss',
    sensitive: 0,
    status: 'active',
    createdMs: T0,
    hitCount: 0,
    lastHitMs: null,
    ...over,
  };
}

const newInput = (termNorm: string, over: Partial<BuildMissAliasInput> = {}): BuildMissAliasInput => ({
  termNorm,
  cardId: CARD_ID,
  sensitive: 0,
  createdMs: T0 + DAY,
  ...over,
});

function cardColumnsExcept(db: DatabaseSync, cols: readonly string[]): Record<string, unknown> {
  const raw = db.prepare('SELECT * FROM mem_card WHERE card_id = ?').get(CARD_ID) as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!cols.includes(k)) {
      clone[k] = v;
    }
  }
  return clone;
}

// ── A. 纯函数 buildMissAlias ───────────────────────────────────────────────

test('buildMissAlias：合法输入产出 plan（source 恒 miss、active、统计初值零、卡内对象同形）', () => {
  const aliases = [row('已有词')];
  const card = mkCard(aliases);
  const result = buildMissAlias(newInput('新词', { sensitive: 1 }), card, aliases);
  assert.equal(result.ok, true);
  if (!result.ok || !result.changed) {
    assert.fail('应返回 changed plan');
    return;
  }
  assert.deepEqual(result.plan.alias, {
    termNorm: '新词',
    cardId: CARD_ID,
    source: 'miss',
    sensitive: 1,
    status: 'active',
    createdMs: T0 + DAY,
    hitCount: 0,
    lastHitMs: null,
  });
  assert.deepEqual(result.plan.cardAliasObject, { term: '新词', source: 'miss', sensitive: 1 });
});

test('buildMissAlias：表驱动拒绝原因码', () => {
  const aliases = [row('已有词')];
  const activeCard = mkCard(aliases);
  const inactiveCard = mkCard(aliases, { status: 'invalid' });
  const cases: Array<[string, ReturnType<typeof buildMissAlias>]> = [
    ['卡不存在', buildMissAlias(newInput('x'), null, aliases)],
    ['卡非 active', buildMissAlias(newInput('x'), inactiveCard, aliases)],
    ['termNorm 空串', buildMissAlias(newInput('', { termNorm: '' }), activeCard, aliases)],
    ['sensitive=2', buildMissAlias(newInput('x', { sensitive: 2 as 0 | 1 }), activeCard, aliases)],
    ['sensitive=-1', buildMissAlias(newInput('x', { sensitive: -1 as 0 | 1 }), activeCard, aliases)],
  ];
  for (const [label, result] of cases) {
    assert.equal(result.ok, false, label);
    if (result.ok) {
      assert.fail(`${label} 不应 ok`);
    }
  }
  const notFound = buildMissAlias(newInput('x'), null, aliases);
  if (!notFound.ok) {
    assert.equal(notFound.reason, 'card-not-found');
  }
  const inactive = buildMissAlias(newInput('x'), inactiveCard, aliases);
  if (!inactive.ok) {
    assert.equal(inactive.reason, 'card-not-active');
  }
  const empty = buildMissAlias(newInput(''), activeCard, aliases);
  if (!empty.ok) {
    assert.equal(empty.reason, 'empty-term');
  }
  const badSens = buildMissAlias(newInput('x', { sensitive: 2 as 0 | 1 }), activeCard, aliases);
  if (!badSens.ok) {
    assert.equal(badSens.reason, 'bad-sensitive');
  }
});

test('buildMissAlias：同 termNorm 已 active → 幂等跳过、不占名额', () => {
  const aliases = [row('重复词')];
  const result = buildMissAlias(newInput('重复词'), mkCard(aliases), aliases);
  assert.deepEqual(result, { ok: true, changed: false, reason: 'already-active' });
});

test('buildMissAlias：上限 5 表驱动（第 6 个不同词拒、重复不占额、tombstone 不占额）', () => {
  assert.equal(MAX_MISS_ALIASES_PER_CARD, 5);
  const fiveActive = [0, 1, 2, 3, 4].map((i) => row(`词${i}`));
  const sixth = buildMissAlias(newInput('第6词'), mkCard(fiveActive), fiveActive);
  if (!sixth.ok) {
    assert.equal(sixth.reason, 'alias-cap-exceeded');
  } else {
    assert.fail('第 6 个不同词必须被拒');
  }
  // 已满 5 但重复其中一个 → 幂等跳过而非 cap 拒绝。
  const dup = buildMissAlias(newInput('词2'), mkCard(fiveActive), fiveActive);
  assert.deepEqual(dup, { ok: true, changed: false, reason: 'already-active' });

  // 4 active + 1 tombstoned：active 名额仅 4，仍可加入第 5 个 active 词。
  const fourWithTomb = [row('a'), row('b'), row('c'), row('d'), row('dead', { status: 'tombstoned' })];
  const activeOnly = fourWithTomb.filter((a) => a.status === 'active');
  const canAdd = buildMissAlias(newInput('e'), mkCard(activeOnly), activeOnly);
  assert.equal(canAdd.ok, true);
  if (canAdd.ok) {
    assert.equal(canAdd.changed, true);
  }
});

// ── B. 低层 applyMissAlias（真库事务）──────────────────────────────────────

test('applyMissAlias：新增仅改 aliases_json/content_hash 两列，其余 20 列逐字不变且 hash/排序/FTS 正确', () => {
  const initial = [row('zebra'), row('apple', { sensitive: 1 })];
  const { db } = seedDb(initial);
  try {
    const before = cardColumnsExcept(db, ['aliases_json', 'content_hash']);
    const cueBefore = (db.prepare('SELECT cue_text FROM mem_card_fts WHERE card_id=?').get(CARD_ID) as { cue_text: string }).cue_text;
    assert.ok(!cueBefore.includes('mango'), '前置：FTS 暂无新词');
    assert.ok(!cueBefore.includes('apple'), '前置：敏感别名不在 FTS');

    const outcome = applyMissAlias(db, newInput('mango', { sensitive: 0 }));
    assert.equal(outcome.ok, true);
    if (!outcome.ok || !outcome.changed) {
      assert.fail('应 changed');
      return;
    }

    // 其余 20 列逐字不变。
    assert.deepEqual(cardColumnsExcept(db, ['aliases_json', 'content_hash']), before);

    // 别名对象确定性排序（term 码点升序）。
    const objects = JSON.parse(outcome.aliasesJson) as Array<{ term: string }>;
    const terms = objects.map((o) => o.term);
    assert.deepEqual(terms, [...terms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    assert.ok(terms.includes('mango'));

    // contentHash 用共享无环公式按新 aliasesJson 逐字重算。
    const card = cardFromRow(db.prepare('SELECT * FROM mem_card WHERE card_id=?').get(CARD_ID) as Record<string, unknown>);
    const expectedHash = computeContentHash(card.anchorJson, card.displayCuesJson, outcome.aliasesJson, card.discriminator);
    assert.equal(outcome.contentHash, expectedHash);
    assert.equal(card.contentHash, expectedHash);

    // 新 mem_alias 行字段：专用 insert，统计初值零、source miss、active。
    const newRow = db.prepare('SELECT * FROM mem_alias WHERE term_norm=? AND card_id=?').get('mango', CARD_ID) as Record<string, unknown>;
    assert.equal(newRow['source'], 'miss');
    assert.equal(newRow['sensitive'], 0);
    assert.equal(newRow['status'], 'active');
    assert.equal(newRow['hit_count'], 0);
    assert.equal(newRow['last_hit_ms'], null);
    assert.equal(newRow['created_ms'], T0 + DAY);

    // FTS 同步：非敏感新词进 FTS，敏感词仍不进。
    const cueAfter = (db.prepare('SELECT cue_text FROM mem_card_fts WHERE card_id=?').get(CARD_ID) as { cue_text: string }).cue_text;
    assert.ok(cueAfter.includes('mango'));
    assert.ok(!cueAfter.includes('apple'));
  } finally {
    db.close();
  }
});

test('applyMissAlias：重复 active 词整笔幂等跳过、全库零 churn', () => {
  const initial = [row('repeat')];
  const { db } = seedDb(initial);
  try {
    const snapshot = {
      card: db.prepare('SELECT * FROM mem_card WHERE card_id=?').get(CARD_ID),
      aliases: db.prepare('SELECT * FROM mem_alias ORDER BY term_norm').all(),
      fts: db.prepare('SELECT * FROM mem_card_fts ORDER BY card_id').all(),
    };
    const outcome = applyMissAlias(db, newInput('repeat'));
    assert.deepEqual(outcome, {
      ok: true,
      changed: false,
      reason: 'already-active',
      cardId: CARD_ID,
      termNorm: 'repeat',
    });
    assert.deepEqual(db.prepare('SELECT * FROM mem_card WHERE card_id=?').get(CARD_ID), snapshot.card);
    assert.deepEqual(db.prepare('SELECT * FROM mem_alias ORDER BY term_norm').all(), snapshot.aliases);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM mem_alias').get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});

test('applyMissAlias：权威上限——连加 5 个不同词成功、第 6 个拒绝且库零变化', () => {
  const { db } = seedDb([]);
  try {
    for (let i = 0; i < MAX_MISS_ALIASES_PER_CARD; i += 1) {
      const r = applyMissAlias(db, newInput(`term${i}`));
      assert.equal(r.ok, true, `第 ${i + 1} 个应成功`);
      if (r.ok) {
        assert.equal(r.changed, true);
      }
    }
    const beforeCard = db.prepare('SELECT * FROM mem_card WHERE card_id=?').get(CARD_ID);
    const blocked = applyMissAlias(db, newInput('overflow'));
    if (!blocked.ok) {
      assert.equal(blocked.reason, 'alias-cap-exceeded');
    } else {
      assert.fail('第 6 个必须拒绝');
    }
    assert.deepEqual(db.prepare('SELECT * FROM mem_card WHERE card_id=?').get(CARD_ID), beforeCard, '拒绝零写');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM mem_alias').get() as { n: number }).n, 5);
    assert.equal(db.prepare('SELECT 1 FROM mem_alias WHERE term_norm=?').get('overflow'), undefined);
  } finally {
    db.close();
  }
});

test('applyMissAlias：不重置既有别名统计、不把 sensitive 1→0', () => {
  const initial = [row('keep', { sensitive: 1 })];
  const { db } = seedDb(initial);
  try {
    // 模拟既有命中统计。
    db.prepare("UPDATE mem_alias SET hit_count=7, last_hit_ms=? WHERE term_norm='keep'").run(T0 + 2 * DAY);
    const outcome = applyMissAlias(db, newInput('fresh'));
    assert.equal(outcome.ok, true);
    const kept = db.prepare("SELECT * FROM mem_alias WHERE term_norm='keep'").get() as Record<string, unknown>;
    assert.equal(kept['sensitive'], 1, '敏感标记不得降级');
    assert.equal(kept['hit_count'], 7, '命中计数不得重置');
    assert.equal(kept['last_hit_ms'], T0 + 2 * DAY, '最近命中时刻不得重置');
  } finally {
    db.close();
  }
});

test('applyMissAlias：两源自洽——mem_alias active 词集合 == aliasesJson，且 hash 可重算', () => {
  const { db } = seedDb([row('one')]);
  try {
    applyMissAlias(db, newInput('two'));
    applyMissAlias(db, newInput('three', { sensitive: 1 }));
    const card = cardFromRow(db.prepare('SELECT * FROM mem_card WHERE card_id=?').get(CARD_ID) as Record<string, unknown>);
    const jsonTerms = (JSON.parse(card.aliasesJson) as Array<{ term: string }>).map((o) => o.term).sort();
    const tableTerms = (db.prepare("SELECT term_norm FROM mem_alias WHERE status='active' ORDER BY term_norm").all() as Array<{ term_norm: string }>).map((r) => r.term_norm).sort();
    assert.deepEqual(jsonTerms, tableTerms);
    assert.equal(
      card.contentHash,
      computeContentHash(card.anchorJson, card.displayCuesJson, card.aliasesJson, card.discriminator),
    );
  } finally {
    db.close();
  }
});

test('applyMissAlias：同主键存在 tombstoned 行（v1 不可达不变量）→ IntegrityError，不静默复活', () => {
  const { db } = seedDb([row('ghost', { status: 'tombstoned' })]);
  try {
    assert.throws(() => applyMissAlias(db, newInput('ghost')), IntegrityError);
    const r = db.prepare("SELECT status FROM mem_alias WHERE term_norm='ghost'").get() as { status: string };
    assert.equal(r.status, 'tombstoned');
  } finally {
    db.close();
  }
});

// ── C. 写柄 addMissAlias（N5 规范化归属 + 决策账本）────────────────────────

function indexDirOf(rootPath: string): string {
  return path.join(rootPath, 'projection', 'memory-index');
}

test('写柄 addMissAlias：N5 在写柄规范化（空白/全角），落库 termNorm 规范形并追加 add-alias 决策', async () => {
  const root = makeTempRoot('alias-write-handle-');
  const indexDir = indexDirOf(root);
  try {
    const handle = openMemoryWrite({ indexDir });
    try {
      handle.transactionApply(
        { cards: [mkCard([])], aliases: [] },
        {
          revision: 1, slug: 'build', at_ms: T0, schema_version: 1, truth_fingerprint: 'fp-alias',
          prior_revision: null, card_count: 1, alias_count: 0, row_hash_sum: 'rh',
          shadow_diff: { added: 1, removed: 0, changed: 0 }, reason: 'fixture', operator: 'offline-cli',
        },
        [],
      );
      const outcome = handle.addMissAlias({ term: '  Ｇｉｔ ', cardId: CARD_ID, sensitive: 0, atMs: T0 + 3 * DAY });
      assert.equal(outcome.ok, true);
    } finally {
      await handle.close();
    }
    const ro = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
    try {
      const rows = ro.prepare('SELECT term_norm FROM mem_alias').all() as Array<{ term_norm: string }>;
      assert.deepEqual(rows.map((r) => r.term_norm), ['git'], 'NFKC+小写+空白折叠后落库');
    } finally {
      ro.close();
    }
    const decisions = readDecisions(indexDir);
    assert.equal(decisions.length, 1);
    const d = decisions[0]!;
    assert.equal(d.action, 'add-alias');
    assert.equal(d.created_by, 'her');
    assert.equal(d.model_tag, 'rules-v1');
    assert.equal(d.card_id, CARD_ID);
    assert.equal(d.event_id, EVENT_ID);
    assert.ok(isUlid(d.decision_id));
    assert.ok(!d.reason.includes('git') && !d.reason.includes('Ｇｉｔ'), 'reason 受控码不复制原文');
  } finally {
    cleanupTempRoot(root);
  }
});

test('写柄 addMissAlias：幂等跳过与上限拒绝都不追加决策、不产生半状态', async () => {
  const root = makeTempRoot('alias-write-skip-');
  const indexDir = indexDirOf(root);
  try {
    const handle = openMemoryWrite({ indexDir });
    try {
      handle.transactionApply(
        { cards: [mkCard([])], aliases: [] },
        {
          revision: 1, slug: 'build', at_ms: T0, schema_version: 1, truth_fingerprint: 'fp2',
          prior_revision: null, card_count: 1, alias_count: 0, row_hash_sum: 'rh2',
          shadow_diff: { added: 1, removed: 0, changed: 0 }, reason: 'fixture', operator: 'offline-cli',
        },
        [],
      );
      const first = handle.addMissAlias({ term: 'same', cardId: CARD_ID, sensitive: 0, atMs: T0 });
      assert.equal(first.ok, true);
      const again = handle.addMissAlias({ term: 'same', cardId: CARD_ID, sensitive: 0, atMs: T0 + DAY });
      if (again.ok) {
        assert.equal(again.changed, false);
      } else {
        assert.fail('重复应幂等而非拒绝');
      }
    } finally {
      await handle.close();
    }
    assert.equal(readDecisions(indexDir).length, 1, '仅真实新增写一条决策');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── D. 读柄 getCardsByAnchor 与读柄零写权 ─────────────────────────────────

test('读柄 getCardsByAnchor：ULID 校验、按 anchor_json 含经历 id 过滤 active、确定性、不产生文件', async () => {
  const root = makeTempRoot('anchor-lookup-');
  const indexDir = indexDirOf(root);
  const anchorA = ulid();
  const anchorB = ulid();
  const shared = ulid();
  const cards: MemoryCard[] = [
    mkCard([], { cardId: 'mc_lookup_1', anchorJson: JSON.stringify([anchorA, shared]) }),
    mkCard([], { cardId: 'mc_lookup_2', anchorJson: JSON.stringify([anchorB, shared]), createdMs: T0 - DAY }),
    mkCard([], { cardId: 'mc_lookup_inactive', anchorJson: JSON.stringify([shared]), status: 'invalid' }),
  ];
  try {
    const w = openMemoryWrite({ indexDir });
    try {
      w.transactionApply(
        { cards, aliases: [] },
        {
          revision: 1, slug: 'build', at_ms: T0, schema_version: 1, truth_fingerprint: 'fp3',
          prior_revision: null, card_count: cards.length, alias_count: 0, row_hash_sum: 'rh3',
          shadow_diff: { added: cards.length, removed: 0, changed: 0 }, reason: 'fixture', operator: 'offline-cli',
        },
        [],
      );
    } finally {
      await w.close();
    }
    const before = fs.readdirSync(indexDir).slice().sort();
    const read = openMemoryRead({ indexDir });
    try {
      assert.throws(() => read.getCardsByAnchor('not-a-ulid'), IntegrityError);
      const hitShared = read.getCardsByAnchor(shared).map((c) => c.cardId);
      assert.deepEqual(hitShared, ['mc_lookup_2', 'mc_lookup_1'], 'created_ms 升序、card_id 次序确定；invalid 卡排除');
      assert.deepEqual(read.getCardsByAnchor(anchorA).map((c) => c.cardId), ['mc_lookup_1']);
      assert.deepEqual(read.getCardsByAnchor(ulid()), [], '无锚点命中返回空数组');
      assert.deepEqual(fs.readdirSync(indexDir).sort(), before, '只读反查不产生/改动文件');
      // 读柄在运行期不具备窄写方法（类型层 MemoryReadHandle 亦无该签名，tsc 另守）。
      const asRecord = read as unknown as Record<string, unknown>;
      assert.equal(typeof asRecord['addMissAlias'], 'undefined');
    } finally {
      await read.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});
