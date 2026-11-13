/**
 * C3 检索测试 —— bm25 + 只读柄 search 委托（方案 §4.4 / §11.3 M12；裁决 G1/G2/G12–G14）。
 *
 * 纪律：
 *  - 全部在 tests/helpers 临时根；真实数据根零接触；
 *  - atMs 注入，函数内无 Date.now()；limit 由调用方传入（§6.2 k=3 不硬编码）；
 *  - M12 只断言两路径结果集合一致，不断言分数相等（G12）；
 *  - 敏感词 FTS 恒不可见、精确路径任意长度可达（§4.4①/补充 5）；
 *  - as-of 过滤复用 invalidate.isEffectiveAt（G13），参照集亦用同一谓词。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { UnavailableError } from '../../src/core/errors.ts';
import {
  HALF_LIFE_MS,
  LAMBDA,
  normalizeQuery,
  recencyScore,
  searchCards,
  searchCardsExplained,
} from '../../src/memory/bm25.ts';
import { computeContentHash } from '../../src/memory/builder.ts';
import { isEffectiveAt } from '../../src/memory/invalidate.ts';
import {
  MEMORY_INDEX_FILE,
  aliasFromRow,
  cardFromRow,
  openMemoryRead,
  openMemoryWrite,
} from '../../src/memory/store.ts';
import type {
  AliasRow,
  MemoryCard,
  RankedCard,
  RevisionRecord,
  SearchQuery,
} from '../../src/memory/types.ts';
import { matchesSubstring } from '../../src/projection/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const AT = T0 + 30 * DAY;

// ── 夹具 ──────────────────────────────────────────────────────────────────

interface CardSpec {
  cardId: string;
  cues: string[];
  aliases: Array<{ term: string; sensitive: 0 | 1 }>;
  discriminator: string;
  occurredMs: number;
  invalidMs?: number | null;
  createdMs?: number;
}

function mkCard(spec: CardSpec): { card: MemoryCard; aliasRows: AliasRow[] } {
  const anchorJson = '["exp-1"]';
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
    invalidMs: spec.invalidMs ?? null,
    createdMs: spec.createdMs ?? T0,
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
  { cardId: 'mc_a', cues: ['咖啡馆约会'], aliases: [{ term: '咖啡馆', sensitive: 0 }, { term: '猫', sensitive: 0 }], discriminator: '城南老店', occurredMs: T0 },
  { cardId: 'mc_b', cues: ['深夜食堂加班'], aliases: [{ term: '深夜食堂', sensitive: 0 }, { term: '猫咪咖啡', sensitive: 0 }, { term: '猫', sensitive: 0 }], discriminator: '加班夜宵', occurredMs: T0 + 5 * DAY },
  { cardId: 'mc_c', cues: ['图书馆自习'], aliases: [{ term: '私密词', sensitive: 1 }], discriminator: '靠窗座位', occurredMs: T0 + 10 * DAY },
  { cardId: 'mc_d', cues: ['ÄPFEL 果园'], aliases: [], discriminator: '秋季采摘', occurredMs: T0 + 15 * DAY },
  { cardId: 'mc_e', cues: ['公园散步'], aliases: [{ term: '散步', sensitive: 0 }], discriminator: '河边步道', occurredMs: T0 + 20 * DAY, invalidMs: T0 + 25 * DAY },
  { cardId: 'mc_f', cues: ['私教课训练'], aliases: [{ term: '私教课', sensitive: 1 }], discriminator: '力量区', occurredMs: T0 + 2 * DAY },
  { cardId: 'mc_tie_a', cues: ['相同线索'], aliases: [], discriminator: 'tie-a', occurredMs: T0 },
  { cardId: 'mc_tie_b', cues: ['相同线索'], aliases: [], discriminator: 'tie-b', occurredMs: T0 },
  { cardId: 'mc_future', cues: ['未来卡线索'], aliases: [{ term: '未来卡', sensitive: 0 }], discriminator: '尚未创建', occurredMs: T0 + 40 * DAY, createdMs: T0 + 40 * DAY },
  { cardId: 'mc_apple_old', cues: ['苹果园'], aliases: [], discriminator: '老园', occurredMs: T0 },
  { cardId: 'mc_apple_new', cues: ['苹果园 苹果园 苹果园 苹果园'], aliases: [], discriminator: '新园', occurredMs: T0 + 29 * DAY },
];

interface Seeded {
  root: string;
  indexDir: string;
  file: string;
}

async function seedCorpus(): Promise<Seeded> {
  const root = makeTempRoot('bm25-test-');
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
      truth_fingerprint: 'fp-bm25-test',
      prior_revision: null,
      card_count: cards.length,
      alias_count: aliases.length,
      row_hash_sum: 'rh-bm25-test',
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

const ids = (ranked: readonly RankedCard[]): string[] => ranked.map((r) => r.card.cardId);
const scoreOf = (r: RankedCard, lambda: number): number =>
  r.scoreParts.bm25 + lambda * r.scoreParts.recency;

/** M12 参照：回退路径的独立 SQL 实现（精确 + LIKE，as-of 用同一 isEffectiveAt）。 */
function fallbackReference(db: DatabaseSync, q: string, atMs: number): string[] {
  const escaped = q.replace(/[\\%_]/g, (char) => `\\${char}`);
  const rows = db
    .prepare(
      "SELECT DISTINCT card_id FROM mem_alias WHERE status = 'active' AND (term_norm = ? OR (sensitive = 0 AND term_norm LIKE ? ESCAPE '\\'))",
    )
    .all(q, `%${escaped}%`) as Array<{ card_id: string }>;
  const out: string[] = [];
  for (const row of rows) {
    const raw = db.prepare('SELECT * FROM mem_card WHERE card_id = ?').get(row.card_id) as
      | Record<string, unknown>
      | undefined;
    if (raw !== undefined && isEffectiveAt(cardFromRow(raw), atMs)) {
      out.push(row.card_id);
    }
  }
  return out.sort();
}

/** M12 参照：短词的语义判定（精确 或 ASCII 子串；敏感词仅精确）。 */
function semanticReference(db: DatabaseSync, q: string, atMs: number): string[] {
  const rows = (db.prepare("SELECT * FROM mem_alias WHERE status = 'active'").all() as Array<Record<string, unknown>>).map(aliasFromRow);
  const hitCards = new Set<string>();
  for (const row of rows) {
    if (row.termNorm === q || (row.sensitive === 0 && matchesSubstring(row.termNorm, q))) {
      hitCards.add(row.cardId);
    }
  }
  const out: string[] = [];
  for (const cardId of hitCards) {
    const raw = db.prepare('SELECT * FROM mem_card WHERE card_id = ?').get(cardId) as
      | Record<string, unknown>
      | undefined;
    if (raw !== undefined && isEffectiveAt(cardFromRow(raw), atMs)) {
      out.push(cardId);
    }
  }
  return out.sort();
}

// ── 纯函数：规范化与近因（§4.4①②）─────────────────────────────────────────

test('normalizeQuery：NFKC → ASCII 小写 → 空白折叠（中文与非 ASCII 不动）', () => {
  assert.equal(normalizeQuery('ＡＢＣ'), 'abc', '全角 NFKC + ASCII 小写');
  assert.equal(normalizeQuery('ABC'), 'abc');
  assert.equal(normalizeQuery('  a\t b  '), 'a b', '空白折叠 + 首尾修剪');
  assert.equal(normalizeQuery('咖啡馆'), '咖啡馆', '中文原样');
  assert.equal(normalizeQuery('ÄPFEL'), 'Äpfel', '非 ASCII 大小写不动');
  assert.equal(normalizeQuery('①②'), '12', 'NFKC 兼容分解');
  assert.equal(normalizeQuery(''), '');
  assert.equal(normalizeQuery(' \t\n '), '');
});

test('recencyScore：exp 半衰减、未来时刻钳零、halfLife 可覆盖', () => {
  assert.equal(recencyScore(T0, T0), 1, 'age=0 → 1');
  assert.ok(Math.abs(recencyScore(T0, T0 + HALF_LIFE_MS) - 0.5) < 1e-12, 'age=半衰期 → 0.5');
  assert.equal(recencyScore(T0 + DAY, T0), 1, '未来 occurred → age 钳 0');
  assert.ok(Math.abs(recencyScore(T0, T0 + 1000, 1000) - 0.5) < 1e-12, '自定义 halfLife');
});

test('观测初值常量：LAMBDA=0.15、HALF_LIFE_MS=30 天（§4.4②）', () => {
  assert.equal(LAMBDA, 0.15);
  assert.equal(HALF_LIFE_MS, 30 * 24 * 3600 * 1000);
});

// ── FTS 路径（≥3 码点）────────────────────────────────────────────────────

test('FTS 路径：命中、scoreParts.bm25=-bm25Raw>0、recency 为 exp 衰减值、matchedTerms=[规范化查询]', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const ranked = searchCards(db, { text: '咖啡馆', atMs: AT });
    assert.deepEqual(ids(ranked), ['mc_a']);
    const hit = ranked[0];
    assert.ok(hit);
    assert.ok(hit.scoreParts.bm25 > 0, 'bm25() 为负值，取反后为正');
    assert.ok(
      Math.abs(hit.scoreParts.recency - 0.5) < 1e-12,
      'age=30 天=半衰期 → recency=0.5',
    );
    assert.deepEqual(hit.matchedTerms, ['咖啡馆']);
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

test('MATCH 后精确复核：trigram 超集命中被 matchesSubstring 收口（L1 同款语义）', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // trigram 折叠 Unicode 大小写：原始 MATCH 能命中 ÄPFEL（超集事实）。
    const raw = db
      .prepare('SELECT card_id FROM mem_card_fts WHERE mem_card_fts MATCH ?')
      .all('"äpfel"') as Array<{ card_id: string }>;
    assert.deepEqual(raw.map((r) => r.card_id), ['mc_d'], '前提：trigram MATCH 是超集');
    // 精确判定（ASCII-only 小写）不认 Ä≠ä → 检索结果必须为空。
    assert.deepEqual(searchCards(db, { text: 'äpfel', atMs: AT }), [], '超集命中被精确复核排除');
    // 同词 ASCII 部分大小写不敏感 → 命中。
    assert.deepEqual(ids(searchCards(db, { text: 'ÄPFEL', atMs: AT })), ['mc_d']);
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

// ── 回退路径（<3 码点）与敏感词 ───────────────────────────────────────────

test('短词回退：精确+LIKE 命中、bm25=0、按近因排序、matchedTerms 为命中别名集', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const ranked = searchCards(db, { text: '猫', atMs: AT });
    assert.deepEqual(ids(ranked), ['mc_b', 'mc_a'], '回退命中间按近因排序（B 更新）');
    for (const hit of ranked) {
      assert.equal(hit.scoreParts.bm25, 0, '回退路径 scoreParts.bm25=0（G12）');
      const expected = LAMBDA * hit.scoreParts.recency;
      assert.ok(Math.abs(scoreOf(hit, LAMBDA) - expected) < 1e-12);
    }
    const first = ranked[0];
    const second = ranked[1];
    assert.ok(first);
    assert.ok(second);
    assert.deepEqual(first.matchedTerms, ['猫', '猫咪咖啡'], 'LIKE 命中别名集去重字典序');
    assert.deepEqual(second.matchedTerms, ['猫']);
    // trigram 对短词无能为力 → 回退是义务（原始 MATCH 零行）。
    const raw = db
      .prepare('SELECT card_id FROM mem_card_fts WHERE mem_card_fts MATCH ?')
      .all('"猫"') as Array<{ card_id: string }>;
    assert.equal(raw.length, 0, '短词 trigram 无法命中');
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

test('敏感词：FTS 恒不可见、精确路径任意长度可达、LIKE 不漏敏感词', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const ftsC = db
      .prepare('SELECT cue_text FROM mem_card_fts WHERE card_id = ?')
      .get('mc_c') as { cue_text: string };
    assert.ok(!ftsC.cue_text.includes('私密词'), 'sensitive=1 不进 FTS 文本');

    // 3 码点敏感词：FTS 无命中，精确路径可达。
    const hit3 = searchCards(db, { text: '私密词', atMs: AT });
    assert.deepEqual(ids(hit3), ['mc_c']);
    const only3 = hit3[0];
    assert.ok(only3);
    assert.equal(only3.scoreParts.bm25, 0, '仅精确命中 → bm25=0');
    assert.deepEqual(only3.matchedTerms, ['私密词']);

    // 2 码点敏感前缀：精确不等、LIKE 排除敏感 → 零命中。
    assert.deepEqual(searchCards(db, { text: '私密', atMs: AT }), []);

    // 同卡 FTS（经 cue）+ 敏感精确同时命中：保留 FTS scoreParts，matchedTerms 并集。
    const ftsF = db
      .prepare('SELECT cue_text FROM mem_card_fts WHERE card_id = ?')
      .get('mc_f') as { cue_text: string };
    assert.equal(ftsF.cue_text, '私教课训练', '敏感别名不追加进 FTS 文本（cue 本身含同词另当别论）');
    const hitF = searchCards(db, { text: '私教课', atMs: AT });
    assert.deepEqual(ids(hitF), ['mc_f']);
    const onlyF = hitF[0];
    assert.ok(onlyF);
    assert.ok(onlyF.scoreParts.bm25 > 0, 'FTS 命中保留 FTS scoreParts');
    assert.deepEqual(onlyF.matchedTerms, ['私教课']);
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

// ── M12：两路径结果集合一致（不断言分数相等，G12）─────────────────────────

test('M12：同一组词走 trigram MATCH 与精确/LIKE 回退，结果集合一致', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // ≥3 码点别名承载词：searchCards 走 FTS，参照走回退 SQL。
    for (const word of ['咖啡馆', '深夜食堂', '猫咪咖啡']) {
      const viaSearch = ids(searchCards(db, { text: word, atMs: AT })).sort();
      const viaFallback = fallbackReference(db, word, AT);
      assert.ok(viaSearch.length > 0, `「${word}」须有命中（避免空集假阳性）`);
      assert.deepEqual(viaSearch, viaFallback, `M12 集合不一致：${word}`);
    }
    // 短词：searchCards 走回退，参照走语义判定（精确 或 ASCII 子串）。
    for (const word of ['猫', '论文']) {
      const viaSearch = ids(searchCards(db, { text: word, atMs: AT })).sort();
      const viaSemantic = semanticReference(db, word, AT);
      assert.deepEqual(viaSearch, viaSemantic, `M12 短词集合不一致：${word}`);
      const raw = db
        .prepare('SELECT card_id FROM mem_card_fts WHERE mem_card_fts MATCH ?')
        .all(`"${word}"`) as Array<{ card_id: string }>;
      assert.equal(raw.length, 0, `短词「${word}」trigram 零命中（回退义务）`);
    }
    assert.ok(searchCards(db, { text: '猫', atMs: AT }).length > 0, '短词须有命中（避免空集假阳性）');
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

// ── as-of 过滤（G13：复用 isEffectiveAt）──────────────────────────────────

test('as-of：已失效卡与未创建卡被过滤，边界时刻可达', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(searchCards(db, { text: '散步', atMs: AT }), [], 'invalid 已过 → 过滤');
    assert.deepEqual(ids(searchCards(db, { text: '散步', atMs: T0 + 20 * DAY })), ['mc_e']);
    assert.deepEqual(searchCards(db, { text: '未来卡', atMs: AT }), [], 'created 未到 → 过滤');
    assert.deepEqual(ids(searchCards(db, { text: '未来卡', atMs: T0 + 40 * DAY })), ['mc_future']);
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

// ── 排序、tie-break、tuning、limit ────────────────────────────────────────

test('排序：score 降序 → occurredMs 降序 → cardId 升序（确定性 tie-break）', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // 同分同刻 → cardId 升序。
    assert.deepEqual(ids(searchCards(db, { text: '相同线索', atMs: AT })), ['mc_tie_a', 'mc_tie_b']);

    // 多命中 FTS：默认序与公式序一致。
    const ranked = searchCards(db, { text: '苹果园', atMs: AT });
    assert.deepEqual(ids(ranked).sort(), ['mc_apple_new', 'mc_apple_old']);
    const byFormula = [...ranked].sort(
      (a, b) =>
        scoreOf(b, LAMBDA) - scoreOf(a, LAMBDA) ||
        b.card.occurredMs - a.card.occurredMs ||
        (a.card.cardId < b.card.cardId ? -1 : 1),
    );
    assert.deepEqual(ids(ranked), ids(byFormula), '默认序 = score 公式序');

    // lambda 极大 → 近因主导（新卡置顶）；lambda=0 → 纯 bm25 序。
    const recencyFirst = searchCards(db, { text: '苹果园', atMs: AT }, { lambda: 1e6 });
    const top = recencyFirst[0];
    assert.ok(top);
    assert.equal(top.card.cardId, 'mc_apple_new', 'lambda 极大近因主导');
    const bm25Only = searchCards(db, { text: '苹果园', atMs: AT }, { lambda: 0 });
    const byBm25 = [...bm25Only].sort(
      (a, b) =>
        b.scoreParts.bm25 - a.scoreParts.bm25 ||
        b.card.occurredMs - a.card.occurredMs ||
        (a.card.cardId < b.card.cardId ? -1 : 1),
    );
    assert.deepEqual(ids(bm25Only), ids(byBm25), 'lambda=0 纯 bm25 序');
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

test('tuning.halfLifeMs 覆盖近因衰减（独立入参，不进 SearchQuery）', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const ranked = searchCards(db, { text: '咖啡馆', atMs: AT }, { halfLifeMs: DAY });
    const only = ranked[0];
    assert.ok(only);
    assert.ok(
      Math.abs(only.scoreParts.recency - Math.pow(2, -30)) < 1e-15,
      'halfLife=1 天、age=30 天 → 2^-30',
    );
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

test('limit：排序后截断、缺省不截断（top-k 由调用方传入，§6.2 k=3）', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const query: SearchQuery = { text: '咖啡', atMs: AT };
    assert.deepEqual(ids(searchCards(db, query)), ['mc_b', 'mc_a'], '缺省不截断');
    assert.deepEqual(ids(searchCards(db, { ...query, limit: 1 })), ['mc_b'], 'limit=1 取排序后首张');
    assert.deepEqual(ids(searchCards(db, { ...query, limit: 3 })), ['mc_b', 'mc_a'], 'k=3 调用方策略');
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

test('规范化后空查询 → []（无检索意图）', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const text of ['', '   ', '\t\n']) {
      assert.deepEqual(searchCards(db, { text, atMs: AT }), []);
    }
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

// ── G2：只读柄委托、写柄经继承获得、关闭后拒绝 ────────────────────────────

test('G2：handle.search 委托 searchCards；写柄经类继承获得（零新增逻辑）', async () => {
  const root = makeTempRoot('bm25-handle-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const entries = CORPUS.map(mkCard);
  const cards = entries.map((e) => e.card);
  const aliases = entries.flatMap((e) => e.aliasRows);
  const query: SearchQuery = { text: '咖啡馆', atMs: AT };

  const write = openMemoryWrite({ indexDir });
  let viaWrite: RankedCard[];
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 1,
      truth_fingerprint: 'fp-bm25-handle',
      prior_revision: null,
      card_count: cards.length,
      alias_count: aliases.length,
      row_hash_sum: 'rh-bm25-handle',
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    write.transactionApply({ cards, aliases }, revision, []);
    viaWrite = await write.search(query);
    assert.deepEqual(ids(viaWrite), ['mc_a'], '写柄经继承可用 search');
  } finally {
    await write.close();
  }

  const read = openMemoryRead({ indexDir });
  const db = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
  try {
    const viaRead = await read.search(query);
    assert.deepEqual(viaRead, viaWrite, '只读柄与写柄结果一致');
    assert.deepEqual(viaRead, searchCards(db, query), '委托低层 searchCards 逐字一致');
  } finally {
    db.close();
    await read.close();
    cleanupTempRoot(root);
  }

  await assert.rejects(read.search(query), UnavailableError, '关闭后拒绝服务');
});

// ── #44 可解释检索（searchCardsExplained）：零漂移薄封装 + 通道标记 + ftsOk 两路 ──────────

const stripExplain = (ranked: ReturnType<typeof searchCardsExplained>): RankedCard[] =>
  ranked.map(({ card, scoreParts, matchedTerms }) => ({ card, scoreParts, matchedTerms }));

test('explained/legacy 零漂移：剥离 matchKinds/cueText 后集合·名次·分值·matchedTerms 逐字一致（含 limit/空查询）', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const text of ['咖啡馆', '猫', '私密词', '私教课', '苹果园', '相同线索', '论文', '', '咖啡']) {
      const query: SearchQuery = { text, atMs: AT };
      const legacy = searchCards(db, query);
      const explained = searchCardsExplained(db, query);
      assert.equal(explained.length, legacy.length, `候选数不一致：${text}`);
      assert.deepEqual(stripExplain(explained), legacy, `薄封装零漂移失败：${text}`);
      // 旧入口返回对象不得携带 explain 新字段。
      for (const item of legacy) {
        assert.equal('matchKinds' in item, false, 'legacy RankedCard 不应含 matchKinds');
        assert.equal('cueText' in item, false, 'legacy RankedCard 不应含 cueText');
      }
    }
    const limited: SearchQuery = { text: '咖啡', atMs: AT, limit: 1 };
    assert.deepEqual(stripExplain(searchCardsExplained(db, limited)), searchCards(db, limited), 'limit 路径零漂移');
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

test('explained 通道标记：纯 FTS 携 cueText、纯短词 LIKE 无 cueText、敏感精确 exact、双命中并集且顺序固定', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // 纯 FTS：取 cue 文本的子串且非任何别名完整等值（≥3 码点），精确路不中、仅 trigram 子串命中。
    const ftsOnly = searchCardsExplained(db, { text: '咖啡馆约', atMs: AT });
    assert.deepEqual(ids(ftsOnly), ['mc_a']);
    assert.deepEqual(ftsOnly[0]?.matchKinds, ['fts-substring']);
    assert.equal(typeof ftsOnly[0]?.cueText, 'string');
    assert.ok(ftsOnly[0]?.cueText?.includes('咖啡馆约'));

    // 纯 LIKE：短词（<3 码点）非完整别名，但为某非敏感别名的子串 → 仅 like-fallback、无 cueText。
    const likeOnly = searchCardsExplained(db, { text: '猫咪', atMs: AT });
    assert.deepEqual(ids(likeOnly), ['mc_b']);
    assert.deepEqual(likeOnly[0]?.matchKinds, ['like-fallback']);
    assert.equal(likeOnly[0]?.cueText, undefined);

    const sensitive = searchCardsExplained(db, { text: '私密词', atMs: AT });
    assert.deepEqual(sensitive[0]?.matchKinds, ['exact-alias'], 'sensitive=1 仅精确路可达');
    assert.equal(sensitive[0]?.cueText, undefined);

    const dual = searchCardsExplained(db, { text: '私教课', atMs: AT });
    assert.deepEqual(dual[0]?.matchKinds, ['exact-alias', 'fts-substring'], '同卡精确+FTS 取并集且按固定优先级排序');
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

test('ftsOk 两路控制流：≥3 码点零命中不产生 like-fallback；<3 码点确走 LIKE 分支', async () => {
  const { root, file } = await seedCorpus();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // 不存在的长词（≥3 码点）：FTS MATCH 正常执行但零行、不抛错 → ftsOk=true，不得追加 LIKE 候选。
    const longMiss = searchCardsExplained(db, { text: 'nosuchterm', atMs: AT });
    assert.ok(longMiss.every((h) => !h.matchKinds.includes('like-fallback')));
    assert.deepEqual(longMiss, []);

    // 对照：同库 <3 码点查询确会启用 LIKE 并标注 like-fallback，证明 LIKE 分支只在 !ftsOk 时触发。
    const shortFallback = searchCardsExplained(db, { text: '猫', atMs: AT });
    assert.ok(shortFallback.every((h) => h.matchKinds.includes('like-fallback')));

    // 不存在的单码点查询走 LIKE 也安全返回空、不抛错。
    assert.deepEqual(searchCardsExplained(db, { text: 'z', atMs: AT }), []);
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});