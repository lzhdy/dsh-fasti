/**
 * 记忆层平坦检索 —— 方案 §4.4（BM25+近因先验；裁决 G1/G12–G14）。
 *
 * 纪律：
 *  - 零训练、零外部依赖、单层召回（K10）：无路由器、无查询分类器、无向量混排；
 *  - 本模块只导出纯函数与接收库柄的低层检索，**不自开连接**（唯一持库柄在 store）；
 *  - atMs 由 SearchQuery 注入，函数内禁止 Date.now()；
 *  - LAMBDA/HALF_LIFE_MS 覆盖走独立 tuning 入参，生产调用不传；
 *  - as-of 过滤直接复用 invalidate.isEffectiveAt（G13，与 listEffective 同一谓词）。
 *
 * #124 bigram 几何路径（charter §3.4；常量与经历库物理拆分，B9）：
 *  - 规范化后码点长度 ≥ MIN_FTS_CODEPOINTS(=2) 且 bigram 单元非空：查询同侧 bigram 化，
 *    以 ftsPhraseOf 短语发起 MATCH（unicode61 token 全等/相邻）；
 *  - 纯单字（1 码点）、空单元（纯标点/单字母）或 MATCH 解析失败：mem_alias 精确/LIKE 回退；
 *  - MATCH 命中后对**原文字段**（display_cues 与非敏感活跃别名，逐字段独立）matchesSubstring
 *    复核收口，不再对 bigram 化的 FTS 列复核；Hit.cueText 挂原文拼接串保 gate 接口零漂移；
 *  - 精确路径对任意长度查询可达（sensitive=1 别名 FTS 恒不可见）。
 * 注意：src/projection/sqlite.ts 的 MIN_TRIGRAM_LENGTH=3 保留给经历库 experience_fts，本模块不再引用。
 *
 * #126 rules-v2 宽召回几何（searchCardsExplainedV2，与 V1 双轨并存、CURRENT 仍冻结 rules-v1）：
 *  - bigram 单元以 ftsOrExprOf 组 OR MATCH，任一单元 token 命中即入候选，治愈长问句对短 cue 的
 *    全单元 AND 几何杀（阶段 0 实测 188/308 漏题死因）；
 *  - 召回侧不再做完整 query 子串收口，FTS 行统一标 fts-overlap，提交裁决移交 gate v2
 *    反向包含谓词＋最长证据严格优超（宽召回可以宽，过门必须严）；
 *  - 精确别名、LIKE 回退、as-of、BM25+近因评分、全序 tie-break 与 V1 同构。
 */

import type { DatabaseSync } from 'node:sqlite';

import { asciiLower, matchesSubstring } from '../projection/types.ts';
import { emitUnits, ftsOrExprOf, ftsPhraseOf } from './bigram.ts';
import { aliasFromRow, cueTextOf } from './fts.ts';
import { isEffectiveAt } from './invalidate.ts';
import { cardFromRow } from './store.ts';
import type { AliasRow, ExplainedRankedCard, MatchKind, RankedCard, SearchQuery } from './types.ts';
import { CURRENT_RULES_VERSION } from './types.ts';

/** 记忆侧 FTS 最短查询码点数（#124 bigram 几何；经历库 trigram 常量在 projection 侧独立保留）。 */
export const MIN_FTS_CODEPOINTS = 2;

/** 近因权重。观测初值，凭 harness 敏感性表修订，修订记 revision（§4.4②）。 */
export const LAMBDA = 0.15;

/** 近因半衰期（ms）。观测初值，凭 harness 敏感性表修订，修订记 revision（§4.4②）。 */
export const HALF_LIFE_MS = 30 * 24 * 3600 * 1000;

/** 低层调参入参（G1）：独立于 SearchQuery，供 harness 网格扫描；生产调用不传。 */
export interface SearchTuning {
  lambda?: number;
  halfLifeMs?: number;
}

/** 查询规范化（§4.4①）：Unicode NFKC → ASCII 小写（不动中文）→ 空白折叠。 */
export function normalizeQuery(text: string): string {
  return asciiLower(text.normalize('NFKC')).replace(/\s+/g, ' ').trim();
}

/** 近因先验（纯函数）：exp(-ln2 * ageMs / halfLifeMs)，ageMs = max(0, atMs - occurredMs)。 */
export function recencyScore(occurredMs: number, atMs: number, halfLifeMs: number = HALF_LIFE_MS): number {
  const ageMs = Math.max(0, atMs - occurredMs);
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

/** 命中通道固定输出顺序（确定性：exact → fts → like），用于 matchKinds 排序。rules-v1 几何专用。 */
const MATCH_KIND_ORDER_V1: readonly MatchKind[] = ['exact-alias', 'fts-substring', 'like-fallback'];

interface Hit {
  /** FTS 命中的原始 bm25（负值）；null = 仅回退/精确命中。 */
  bm25Raw: number | null;
  terms: Set<string>;
  /** 该卡命中的全部通道（多通道取并集）。 */
  kinds: Set<MatchKind>;
  /** FTS 复核读取的 cue_text（仅 fts 类命中携带，供布尔门词边界/反向包含判定）。 */
  cueText?: string;
  /** rules-v2 结构化词面字段（仅 V2 fts-overlap 携带，gate 逐字段反向包含用）。 */
  lexicalFields?: string[];
}

/** 批量 IN 查询的每批 card_id 上限：守 SQLite 变量数缺省上限 999，留足余量。 */
const IN_QUERY_BATCH = 400;

function chunked<T>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += IN_QUERY_BATCH) {
    batches.push(items.slice(i, i + IN_QUERY_BATCH));
  }
  return batches;
}

/**
 * 按 card_id 批量取行（P-b：消逐卡 N+1）。返回以 card_id 为键的字典；缺行即缺键，
 * 与逐卡 `get` 的 skip 语义逐句同构。调用方只按字典取用，不依赖返回行序。
 */
function selectRowsByCardIds(
  db: DatabaseSync,
  selectHead: string,
  cardIds: readonly string[],
): Map<string, Record<string, unknown>> {
  const byCardId = new Map<string, Record<string, unknown>>();
  if (cardIds.length === 0) {
    return byCardId;
  }
  for (const batch of chunked([...new Set(cardIds)])) {
    const stmt = db.prepare(`${selectHead}${batch.map(() => '?').join(',')})`);
    for (const row of stmt.all(...batch) as Array<Record<string, unknown>>) {
      byCardId.set(String(row['card_id']), row);
    }
  }
  return byCardId;
}

/**
 * 按 card_id 批量取活跃非敏感别名（P-b：消逐卡 N+1）。
 * 组内顺序显式 ORDER BY rowid——逐卡 `WHERE card_id = ?` 在无索引约束下走全表 rowid 扫描，
 * 这里显式钉死同一顺序，保证 cueText 与 lexicalFields 的字段次序逐字节不变
 * （由 n1g 基线快照哈希与既有红测双重锁定）。
 */
function selectAliasesByCardIds(
  db: DatabaseSync,
  cardIds: readonly string[],
): Map<string, AliasRow[]> {
  const byCardId = new Map<string, AliasRow[]>();
  if (cardIds.length === 0) {
    return byCardId;
  }
  for (const batch of chunked([...new Set(cardIds)])) {
    const stmt = db.prepare(
      `SELECT * FROM mem_alias WHERE card_id IN (${batch.map(() => '?').join(',')})`
      + " AND status = 'active' AND sensitive = 0 ORDER BY rowid",
    );
    for (const row of stmt.all(...batch) as Array<Record<string, unknown>>) {
      const cardId = String(row['card_id']);
      const alias = aliasFromRow(row);
      const list = byCardId.get(cardId);
      if (list === undefined) {
        byCardId.set(cardId, [alias]);
      } else {
        list.push(alias);
      }
    }
  }
  return byCardId;
}

/**
 * rules-v1 低层检索（G2）：bigram 全单元 AND 短语 MATCH ＋完整 query 子串复核收口。
 *
 * #126 起作为冻结几何显式保留：函数体行为与 rules-v1 终判时逐字节一致，供历史考试永久重放，
 * 新开发不得修改本函数（改动须先证明 v1 红测同步更新且终判数字可重建）。
 * 评分（G12）：FTS 路径 scoreParts.bm25 = -bm25Raw；回退路径 scoreParts.bm25 = 0；
 * score = scoreParts.bm25 + lambda * recency；recency 恒为 exp 衰减值。
 * 排序（补充 9）：score 降序 → occurredMs 降序 → cardId 升序；limit 排序后截断。
 * matchedTerms（G14）：FTS=[规范化查询]；精确=[term_norm]；LIKE=命中别名集（去重字典序）；
 * 同卡 FTS+敏感精确双命中保留 FTS scoreParts、matchedTerms 取并集。
 */
export function searchCardsExplainedV1(
  db: DatabaseSync,
  query: SearchQuery,
  tuning?: SearchTuning,
): ExplainedRankedCard[] {
  const lambda = tuning?.lambda ?? LAMBDA;
  const halfLifeMs = tuning?.halfLifeMs ?? HALF_LIFE_MS;
  const q = normalizeQuery(query.text);
  if (q === '') {
    return [];
  }

  const hits = new Map<string, Hit>();
  const addHit = (
    cardId: string,
    term: string,
    bm25Raw: number | null,
    kind: MatchKind,
    cueText?: string,
  ): void => {
    let hit = hits.get(cardId);
    if (hit === undefined) {
      hit = { bm25Raw: null, terms: new Set(), kinds: new Set<MatchKind>() };
      hits.set(cardId, hit);
    }
    hit.terms.add(term);
    hit.kinds.add(kind);
    if (cueText !== undefined) {
      hit.cueText = cueText;
    }
    if (bm25Raw !== null) {
      hit.bm25Raw = bm25Raw;
    }
  };

  // 精确路径：任意长度可达；sensitive=1 别名只走这条路（FTS 文本恒不可见）。
  const exactRows = db
    .prepare("SELECT term_norm, card_id FROM mem_alias WHERE term_norm = ? AND status = 'active'")
    .all(q) as Array<{ term_norm: string; card_id: string }>;
  for (const row of exactRows) {
    addHit(row.card_id, row.term_norm, null, 'exact-alias');
  }

  let ftsOk = false;
  // bigram 几何：查询与写入同函数切单元；纯单字（1 码点）走 LIKE，空单元（纯标点/单字母）不发 MATCH。
  const units = emitUnits(q);
  if ([...q].length >= MIN_FTS_CODEPOINTS && units.length > 0) {
    const phrase = ftsPhraseOf(units);
    try {
      const rows = db
        .prepare('SELECT card_id, bm25(mem_card_fts) AS bm25_raw FROM mem_card_fts WHERE mem_card_fts MATCH ?')
        .all(phrase) as Array<{ card_id: string; bm25_raw: number }>;
      // P-b：候选卡的 cue 与别名各一次批量取，取代逐卡单行查询（几何判定一行未改）。
      const cuesByCardId = selectRowsByCardIds(
        db,
        'SELECT card_id, display_cues_json FROM mem_card WHERE card_id IN (',
        rows.map((row) => row.card_id),
      );
      const aliasesByCardId = selectAliasesByCardIds(db, rows.map((row) => row.card_id));
      for (const row of rows) {
        const cardRow = cuesByCardId.get(row.card_id) as { display_cues_json: string } | undefined;
        if (cardRow === undefined) {
          continue;
        }
        const aliases = aliasesByCardId.get(row.card_id) ?? [];
        const cues = JSON.parse(cardRow.display_cues_json) as string[];
        // 复核靶＝原文字段（非 FTS bigram 列）：逐字段在规范化空间做子串判定，任一命中即收口通过。
        const confirmed = [...cues, ...aliases.map((alias) => alias.termNorm)].some((field) =>
          matchesSubstring(normalizeQuery(field), q),
        );
        if (confirmed) {
          // 挂原文拼接串（与改造前 cue_text 同形状），gate 词边界与下游接口零漂移。
          addHit(row.card_id, q, row.bm25_raw, 'fts-substring', cueTextOf(cardRow.display_cues_json, aliases));
        }
      }
      ftsOk = true;
    } catch {
      // FTS5 语法解析失败 → LIKE 回退（L1 同款义务）。
    }
  }
  if (!ftsOk) {
    const escaped = q.replace(/[\\%_]/g, (char) => `\\${char}`);
    const likeRows = db
      .prepare(
        "SELECT term_norm, card_id FROM mem_alias WHERE term_norm LIKE ? ESCAPE '\\' AND status = 'active' AND sensitive = 0",
      )
      .all(`%${escaped}%`) as Array<{ term_norm: string; card_id: string }>;
    for (const row of likeRows) {
      addHit(row.card_id, row.term_norm, null, 'like-fallback');
    }
  }

  // P-b：命中卡的整卡行一次批量取，取代逐卡单行查询。
  const cardsByCardId = selectRowsByCardIds(
    db,
    'SELECT * FROM mem_card WHERE card_id IN (',
    [...hits.keys()],
  );
  const ranked: ExplainedRankedCard[] = [];
  for (const [cardId, hit] of hits) {
    const raw = cardsByCardId.get(cardId);
    if (raw === undefined) {
      continue;
    }
    const card = cardFromRow(raw);
    if (!isEffectiveAt(card, query.atMs)) {
      continue;
    }
    ranked.push({
      card,
      scoreParts: {
        bm25: hit.bm25Raw === null ? 0 : -hit.bm25Raw,
        recency: recencyScore(card.occurredMs, query.atMs, halfLifeMs),
      },
      matchedTerms: [...hit.terms].sort(),
      matchKinds: MATCH_KIND_ORDER_V1.filter((kind) => hit.kinds.has(kind)),
      ...(hit.cueText !== undefined ? { cueText: hit.cueText } : {}),
    });
  }

  const scoreOf = (r: ExplainedRankedCard): number => r.scoreParts.bm25 + lambda * r.scoreParts.recency;
  ranked.sort(
    (a, b) =>
      scoreOf(b) - scoreOf(a) ||
      b.card.occurredMs - a.card.occurredMs ||
      (a.card.cardId < b.card.cardId ? -1 : a.card.cardId > b.card.cardId ? 1 : 0),
  );
  return query.limit === undefined ? ranked : ranked.slice(0, query.limit);
}

/** 命中通道固定输出顺序（rules-v2：exact → fts-overlap → like），确定性排序。 */
const MATCH_KIND_ORDER_V2: readonly MatchKind[] = ['exact-alias', 'fts-overlap', 'like-fallback'];

/**
 * rules-v2 低层检索（#126 词法结构解）：bigram 单元 **OR 宽召回**，不做召回侧子串收口。
 *
 * 与 V1 的唯一几何差异：MATCH 表达式由全单元 AND 相邻短语改为单元 OR（ftsOrExprOf），
 * FTS 任意单元命中即入候选并标 fts-overlap；「是否真的值得提交」全部移交 gate v2 的
 * 反向包含布尔谓词裁定，本层不再越权做完整 query 子串判定。
 * 精确别名、LIKE 回退、as-of 过滤、BM25+近因评分与全序排序与 V1 逐字同构；
 * 函数体刻意独立保留（不与 V1 抽公共工厂），确保冻结的 V1 几何不被新开发牵动。
 */
export function searchCardsExplainedV2(
  db: DatabaseSync,
  query: SearchQuery,
  tuning?: SearchTuning,
): ExplainedRankedCard[] {
  const lambda = tuning?.lambda ?? LAMBDA;
  const halfLifeMs = tuning?.halfLifeMs ?? HALF_LIFE_MS;
  const q = normalizeQuery(query.text);
  if (q === '') {
    return [];
  }

  const hits = new Map<string, Hit>();
  const addHit = (
    cardId: string,
    term: string,
    bm25Raw: number | null,
    kind: MatchKind,
    cueText?: string,
    lexicalFields?: string[],
  ): void => {
    let hit = hits.get(cardId);
    if (hit === undefined) {
      hit = { bm25Raw: null, terms: new Set(), kinds: new Set<MatchKind>() };
      hits.set(cardId, hit);
    }
    hit.terms.add(term);
    hit.kinds.add(kind);
    if (cueText !== undefined) {
      hit.cueText = cueText;
    }
    if (lexicalFields !== undefined) {
      hit.lexicalFields = lexicalFields;
    }
    if (bm25Raw !== null) {
      hit.bm25Raw = bm25Raw;
    }
  };

  // 精确路径：任意长度可达；sensitive=1 别名只走这条路（FTS 文本恒不可见）。
  const exactRows = db
    .prepare("SELECT term_norm, card_id FROM mem_alias WHERE term_norm = ? AND status = 'active'")
    .all(q) as Array<{ term_norm: string; card_id: string }>;
  for (const row of exactRows) {
    addHit(row.card_id, row.term_norm, null, 'exact-alias');
  }

  let ftsOk = false;
  // 同函数切单元；纯单字（1 码点）走 LIKE，空单元（纯标点/单字母）不发 MATCH——准入与 V1 一致。
  const units = emitUnits(q);
  if ([...q].length >= MIN_FTS_CODEPOINTS && units.length > 0) {
    const orExpr = ftsOrExprOf(units);
    try {
      const rows = db
        .prepare('SELECT card_id, bm25(mem_card_fts) AS bm25_raw FROM mem_card_fts WHERE mem_card_fts MATCH ?')
        .all(orExpr) as Array<{ card_id: string; bm25_raw: number }>;
      // P-b：候选卡的 cue 与别名各一次批量取，取代逐卡单行查询（几何判定一行未改）。
      const cuesByCardId = selectRowsByCardIds(
        db,
        'SELECT card_id, display_cues_json FROM mem_card WHERE card_id IN (',
        rows.map((row) => row.card_id),
      );
      const aliasesByCardId = selectAliasesByCardIds(db, rows.map((row) => row.card_id));
      for (const row of rows) {
        const cardRow = cuesByCardId.get(row.card_id) as { display_cues_json: string } | undefined;
        if (cardRow === undefined) {
          continue;
        }
        const aliases = aliasesByCardId.get(row.card_id) ?? [];
        const cues = JSON.parse(cardRow.display_cues_json) as string[];
        const fields = [...cues, ...aliases.map((alias) => alias.termNorm)];
        // v2：OR 命中即宽召回入候选，不做完整 query 子串收口；携带原文拼接串与结构化字段供 gate 反向包含裁决。
        addHit(
          row.card_id,
          q,
          row.bm25_raw,
          'fts-overlap',
          cueTextOf(cardRow.display_cues_json, aliases),
          fields,
        );
      }
      ftsOk = true;
    } catch {
      // FTS5 语法解析失败 → LIKE 回退（与 V1 同款义务）。
    }
  }
  if (!ftsOk) {
    const escaped = q.replace(/[\\%_]/g, (char) => `\\${char}`);
    const likeRows = db
      .prepare(
        "SELECT term_norm, card_id FROM mem_alias WHERE term_norm LIKE ? ESCAPE '\\' AND status = 'active' AND sensitive = 0",
      )
      .all(`%${escaped}%`) as Array<{ term_norm: string; card_id: string }>;
    for (const row of likeRows) {
      addHit(row.card_id, row.term_norm, null, 'like-fallback');
    }
  }

  // P-b：命中卡的整卡行一次批量取，取代逐卡单行查询。
  const cardsByCardId = selectRowsByCardIds(
    db,
    'SELECT * FROM mem_card WHERE card_id IN (',
    [...hits.keys()],
  );
  const ranked: ExplainedRankedCard[] = [];
  for (const [cardId, hit] of hits) {
    const raw = cardsByCardId.get(cardId);
    if (raw === undefined) {
      continue;
    }
    const card = cardFromRow(raw);
    if (!isEffectiveAt(card, query.atMs)) {
      continue;
    }
    ranked.push({
      card,
      scoreParts: {
        bm25: hit.bm25Raw === null ? 0 : -hit.bm25Raw,
        recency: recencyScore(card.occurredMs, query.atMs, halfLifeMs),
      },
      matchedTerms: [...hit.terms].sort(),
      matchKinds: MATCH_KIND_ORDER_V2.filter((kind) => hit.kinds.has(kind)),
      ...(hit.cueText !== undefined ? { cueText: hit.cueText } : {}),
      ...(hit.lexicalFields !== undefined ? { lexicalFields: hit.lexicalFields } : {}),
    });
  }

  const scoreOf = (r: ExplainedRankedCard): number => r.scoreParts.bm25 + lambda * r.scoreParts.recency;
  ranked.sort(
    (a, b) =>
      scoreOf(b) - scoreOf(a) ||
      b.card.occurredMs - a.card.occurredMs ||
      (a.card.cardId < b.card.cardId ? -1 : a.card.cardId > b.card.cardId ? 1 : 0),
  );
  return query.limit === undefined ? ranked : ranked.slice(0, query.limit);
}

/**
 * 版本分派检索入口（#126）：按 CURRENT_RULES_VERSION 选择几何，调用方与 store 接线零改动。
 * - rules-v1：冻结的 AND 短语＋全 query 子串复核几何（终判可重放）；
 * - rules-v2：OR 宽召回几何（批次 2 落地前显式 fail-loud，绝不静默回退到 v1）。
 * 测试可直接调用具名 V1/V2 函数做双轨断言，禁止经本壳传版本参数（版本只由冻结常量决定）。
 */
export function searchCardsExplained(
  db: DatabaseSync,
  query: SearchQuery,
  tuning?: SearchTuning,
): ExplainedRankedCard[] {
  const rulesVersion: string = CURRENT_RULES_VERSION;
  switch (rulesVersion) {
    case 'rules-v1':
      return searchCardsExplainedV1(db, query, tuning);
    case 'rules-v2':
      return searchCardsExplainedV2(db, query, tuning);
    default:
      throw new Error(`未知 rules 版本：${CURRENT_RULES_VERSION}`);
  }
}

/**
 * 旧检索入口（行为零漂移薄封装）：剥离 explain 字段，返回的候选集合、排序 tie-break 与分值
 * 与引入布尔门之前逐字节一致；SearchQuery/SearchTuning 形状不变。
 */
export function searchCards(db: DatabaseSync, query: SearchQuery, tuning?: SearchTuning): RankedCard[] {
  return searchCardsExplained(db, query, tuning).map((explained) => ({
    card: explained.card,
    scoreParts: explained.scoreParts,
    matchedTerms: explained.matchedTerms,
  }));
}