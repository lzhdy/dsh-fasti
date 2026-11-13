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
 * 路径（L1 三档语义统一同款，src/projection/sqlite.ts:464-499 先例）：
 *  - 规范化后码点长度 ≥3：mem_card_fts MATCH（短语包裹+引号转义）→ matchesSubstring 精确复核；
 *  - <3 或 MATCH 解析失败：mem_alias.term_norm 精确/LIKE 回退（敏感词仅精确）；
 *  - 精确路径对任意长度查询可达（sensitive=1 别名 FTS 恒不可见）。
 */

import type { DatabaseSync } from 'node:sqlite';

import { MIN_TRIGRAM_LENGTH } from '../projection/sqlite.ts';
import { asciiLower, matchesSubstring } from '../projection/types.ts';
import { isEffectiveAt } from './invalidate.ts';
import { cardFromRow } from './store.ts';
import type { ExplainedRankedCard, MatchKind, RankedCard, SearchQuery } from './types.ts';

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

/** 命中通道固定输出顺序（确定性：exact → fts → like），用于 matchKinds 排序。 */
const MATCH_KIND_ORDER: readonly MatchKind[] = ['exact-alias', 'fts-substring', 'like-fallback'];

interface Hit {
  /** FTS 命中的原始 bm25（负值）；null = 仅回退/精确命中。 */
  bm25Raw: number | null;
  terms: Set<string>;
  /** 该卡命中的全部通道（多通道取并集）。 */
  kinds: Set<MatchKind>;
  /** FTS 复核读取的 cue_text（仅 fts-substring 命中携带，供布尔门词边界判定）。 */
  cueText?: string;
}

/**
 * 低层检索（G2）：接收调用方库柄，返回可解释排序结果。
 *
 * 评分（G12）：FTS 路径 scoreParts.bm25 = -bm25Raw；回退路径 scoreParts.bm25 = 0；
 * score = scoreParts.bm25 + lambda * recency；recency 恒为 exp 衰减值。
 * 排序（补充 9）：score 降序 → occurredMs 降序 → cardId 升序；limit 排序后截断。
 * matchedTerms（G14）：FTS=[规范化查询]；精确=[term_norm]；LIKE=命中别名集（去重字典序）；
 * 同卡 FTS+敏感精确双命中保留 FTS scoreParts、matchedTerms 取并集。
 */
export function searchCardsExplained(
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
  if ([...q].length >= MIN_TRIGRAM_LENGTH) {
    // 短语包裹 + 内部双引号转义（照 src/projection/sqlite.ts:475 先例）。
    const phrase = `"${q.replace(/"/g, '""')}"`;
    try {
      const rows = db
        .prepare('SELECT card_id, bm25(mem_card_fts) AS bm25_raw FROM mem_card_fts WHERE mem_card_fts MATCH ?')
        .all(phrase) as Array<{ card_id: string; bm25_raw: number }>;
      const cueStmt = db.prepare('SELECT cue_text FROM mem_card_fts WHERE card_id = ?');
      for (const row of rows) {
        const cue = cueStmt.get(row.card_id) as { cue_text: string } | undefined;
        // trigram MATCH 是 ASCII 子串匹配的超集 → 精确复核收口（L1 同款）。
        if (cue !== undefined && matchesSubstring(cue.cue_text, q)) {
          addHit(row.card_id, q, row.bm25_raw, 'fts-substring', cue.cue_text);
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

  const cardStmt = db.prepare('SELECT * FROM mem_card WHERE card_id = ?');
  const ranked: ExplainedRankedCard[] = [];
  for (const [cardId, hit] of hits) {
    const raw = cardStmt.get(cardId) as Record<string, unknown> | undefined;
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
      matchKinds: MATCH_KIND_ORDER.filter((kind) => hit.kinds.has(kind)),
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