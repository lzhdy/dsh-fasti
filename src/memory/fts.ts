/**
 * 记忆层 FTS 快照共享低层（N1 无环抽取，自 store.ts 原样搬入）。
 *
 * 无环纪律：本模块只依赖 node:sqlite 的类型、memory 纯类型 types.ts 与字符串/JSON 全局，
 * **不 import 任何能到达 store 的 memory 模块**（不依赖 store/builder/bm25），供 builder/store 及
 * 别名窄写共同引用。tests/memory/layer-imports.test.ts 对该约束做静态断言与投毒自证。
 *
 * 本模块为纯移动：行映射、cue_text 拼接规则、FTS 重建 SQL 与抽取前逐字一致（零漂移）。
 * 库柄由调用方传入，本模块不自开连接。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { AliasRow } from './types.ts';

/** 行 → 别名（可空列归一为 null）。 */
export function aliasFromRow(raw: Record<string, unknown>): AliasRow {
  return {
    termNorm: String(raw['term_norm']),
    cardId: String(raw['card_id']),
    source: String(raw['source']) as AliasRow['source'],
    sensitive: Number(raw['sensitive']) as 0 | 1,
    status: String(raw['status']) as AliasRow['status'],
    createdMs: Number(raw['created_ms']),
    hitCount: Number(raw['hit_count']),
    lastHitMs:
      raw['last_hit_ms'] === null || raw['last_hit_ms'] === undefined ? null : Number(raw['last_hit_ms']),
  };
}

/**
 * FTS 索引文本 —— 仅由 display_cues + 活跃非敏感别名拼成，绝无正文/摘要（§3.2）。
 * sensitive=1 的别名不进 FTS（仅精确匹配路径可用，§4.4）。
 */
export function cueTextOf(displayCuesJson: string, aliases: readonly AliasRow[]): string {
  const cues = JSON.parse(displayCuesJson) as string[];
  const terms = aliases
    .filter((alias) => alias.status === 'active' && alias.sensitive === 0)
    .map((alias) => alias.termNorm);
  return [...cues, ...terms].join(' ');
}

/** 重建指定卡的 FTS 行（从库内现读 cues + 别名 → 同源快照，调用方负责事务边界）。 */
export function syncFts(db: DatabaseSync, cardIds: Iterable<string>): void {
  const del = db.prepare('DELETE FROM mem_card_fts WHERE card_id = ?');
  const ins = db.prepare('INSERT INTO mem_card_fts(card_id, cue_text) VALUES (?, ?)');
  const cardStmt = db.prepare('SELECT display_cues_json FROM mem_card WHERE card_id = ?');
  const aliasStmt = db.prepare('SELECT * FROM mem_alias WHERE card_id = ?');
  for (const cardId of cardIds) {
    del.run(cardId);
    const cardRow = cardStmt.get(cardId) as { display_cues_json: string } | undefined;
    if (cardRow === undefined) {
      continue;
    }
    const aliases = (aliasStmt.all(cardId) as Array<Record<string, unknown>>).map(aliasFromRow);
    ins.run(cardId, cueTextOf(cardRow.display_cues_json, aliases));
  }
}
