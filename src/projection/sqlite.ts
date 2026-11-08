/**
 * L1 投影引擎 —— node:sqlite（FTS5 trigram + 事务 + 多维索引）。
 *
 * 定案稿 §7.4：node:sqlite 是**实验性 API**（可能变化、宿主可能禁用），
 * 故本引擎必须能被降级（L2 → L3），且降级不影响数据完整性。
 *
 * 检索策略（用户拍板 Q1，经实测校准）：
 *  - 查询长度 ≥ 3 字符 → FTS5 trigram MATCH 作快速预筛（实测为 ASCII 子串匹配的超集）；
 *  - 查询长度 < 3 字符 → trigram 无法命中，改用 LIKE 回退；
 *  - 两条路径最终都过同一道「ASCII 大小写不敏感子串」精确判定（L1/L2/L3 语义一致）。
 */

import { DatabaseSync } from 'node:sqlite';

import { CorruptedError, UnavailableError } from '../core/errors.ts';
import { ensureDir } from '../core/fsx.ts';
import { MINIMAL_SCHEMA } from './schema.ts';
import { asciiLower, makeSnippet, matchesSubstring } from './types.ts';
import type {
  EdgeProjection,
  ExperienceProjection,
  ProjectionEdgeQuery,
  ProjectionEngine,
  ProjectionQuery,
  ProjectionSearchHit,
} from './types.ts';

/** trigram 预筛所需的最小查询长度。 */
export const MIN_TRIGRAM_LENGTH = 3;

/** node:sqlite 的模块形态（动态 import，宿主禁用时抛错）。 */
interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

let sqliteModule: SqliteModule | null = null;

/**
 * 动态载入 node:sqlite。
 * 导入失败或被宿主禁用 → 抛 UnavailableError（调用方据此降级 L2）。
 */
export async function loadSqlite(): Promise<SqliteModule> {
  if (sqliteModule !== null) {
    return sqliteModule;
  }
  try {
    const mod = (await import('node:sqlite')) as unknown as SqliteModule;
    if (typeof mod.DatabaseSync !== 'function') {
      throw new UnavailableError('node:sqlite 未导出 DatabaseSync');
    }
    sqliteModule = mod;
    return mod;
  } catch (error) {
    throw new UnavailableError(`node:sqlite 不可用：${(error as Error).message}`, { cause: error });
  }
}

/** 供测试重置模块缓存。 */
/** 判断 node:sqlite 当前是否可用。 */
export async function isSqliteAvailable(): Promise<boolean> {
  try {
    await loadSqlite();
    return true;
  } catch {
    return false;
  }
}

/** L1 引擎。 */
export class SqliteProjection implements ProjectionEngine {
  readonly level = 'L1' as const;
  private readonly file: string;
  private db: DatabaseSync | null = null;

  constructor(file: string) {
    this.file = file;
  }

  async open(): Promise<void> {
    const { DatabaseSync: Database } = await loadSqlite();
    ensureDir(this.file.replace(/[\\/][^\\/]*$/, ''));

    // 打开失败时必须关闭句柄 —— 否则文件被占用（Windows 上无法删除/替换）。
    let db: DatabaseSync | null = null;
    try {
      db = new Database(this.file);
      for (const statement of MINIMAL_SCHEMA) {
        db.exec(statement);
      }
      this.db = db;
    } catch (error) {
      if (db !== null) {
        try {
          db.close();
        } catch {
          // 关闭失败不掩盖原始错误。
        }
      }
      throw new UnavailableError(`无法打开投影库：${(error as Error).message}`, { cause: error });
    }
  }

  async close(): Promise<void> {
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }

  async upsertExperience(row: ExperienceProjection): Promise<void> {
    const db = this.require();
    db.prepare(
      `INSERT INTO experience(id, kind, channel, scene_ref, initiation, occurred_ms, recorded_ms, tick, status, shard, seq)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind=excluded.kind, channel=excluded.channel, scene_ref=excluded.scene_ref,
         initiation=excluded.initiation, occurred_ms=excluded.occurred_ms,
         recorded_ms=excluded.recorded_ms, tick=excluded.tick, status=excluded.status,
         shard=excluded.shard, seq=excluded.seq`,
    ).run(
      row.id,
      row.kind,
      row.channel,
      row.scene_ref,
      row.initiation,
      row.occurred_ms,
      row.recorded_ms,
      row.tick,
      row.status,
      row.shard,
      row.seq,
    );
  }

  async upsertEdge(row: EdgeProjection): Promise<void> {
    const db = this.require();
    db.prepare(
      `INSERT INTO edge(id, src, predicate, dst, valid_ms, invalid_ms, created_ms, expired_ms, confidence, reason, provenance)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         src=excluded.src, predicate=excluded.predicate, dst=excluded.dst,
         valid_ms=excluded.valid_ms, invalid_ms=excluded.invalid_ms,
         created_ms=excluded.created_ms, expired_ms=excluded.expired_ms,
         confidence=excluded.confidence, reason=excluded.reason, provenance=excluded.provenance`,
    ).run(
      row.id,
      row.src,
      row.predicate,
      row.dst,
      row.valid_ms,
      row.invalid_ms,
      row.created_ms,
      row.expired_ms,
      row.confidence,
      row.reason,
      row.provenance,
    );
  }

  async upsertDocument(id: string, text: string): Promise<void> {
    const db = this.require();
    // FTS 行以 experience.tick 为 rowid（tick 是 UNIQUE 整数），
    // 于是 FTS ↔ experience 的联结无需额外映射表 —— 保持 §7.1 最小三表不增表。
    const row = db.prepare('SELECT tick FROM experience WHERE id = ?').get(id) as
      | { tick: number }
      | undefined;
    if (row === undefined) {
      throw new CorruptedError(`全文文档对应的经历不存在：${id}`);
    }
    db.prepare('DELETE FROM experience_fts WHERE rowid = ?').run(row.tick);
    db.prepare('INSERT INTO experience_fts(rowid, text) VALUES(?, ?)').run(row.tick, text);
  }

  async query(query: ProjectionQuery): Promise<ExperienceProjection[]> {
    const db = this.require();
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.kind !== undefined) {
      where.push('kind = ?');
      params.push(query.kind);
    }
    if (query.channel !== undefined) {
      where.push('channel = ?');
      params.push(query.channel);
    }
    if (query.scene_ref !== undefined) {
      where.push('scene_ref = ?');
      params.push(query.scene_ref);
    }
    if (query.initiation !== undefined) {
      where.push('initiation = ?');
      params.push(query.initiation);
    }
    if (query.status !== undefined) {
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.occurred_from_ms !== undefined) {
      where.push('occurred_ms >= ?');
      params.push(query.occurred_from_ms);
    }
    if (query.occurred_to_ms !== undefined) {
      where.push('occurred_ms <= ?');
      params.push(query.occurred_to_ms);
    }

    const sql =
      `SELECT id, kind, channel, scene_ref, initiation, occurred_ms, recorded_ms, tick, status, shard, seq` +
      ` FROM experience${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}` +
      ` ORDER BY occurred_ms ASC, tick ASC` +
      (query.limit !== undefined ? ' LIMIT ?' : '');
    if (query.limit !== undefined) {
      params.push(query.limit);
    }

    return db.prepare(sql).all(...(params as never[])).map((row) => toExperienceProjection(row));
  }

  async search(keyword: string, limit?: number): Promise<ProjectionSearchHit[]> {
    const db = this.require();
    if (keyword === '') {
      return [];
    }

    // 预筛：≥3 字符走 trigram MATCH（快）；<3 字符 trigram 无法命中，走 LIKE。
    const candidates = this.prefilter(keyword);
    const hits: ProjectionSearchHit[] = [];

    for (const candidate of candidates) {
      // 精确判定：三档统一语义（ASCII 大小写不敏感子串）。
      if (!matchesSubstring(candidate.text, keyword)) {
        continue;
      }
      hits.push({
        id: candidate.id,
        kind: candidate.kind,
        channel: candidate.channel,
        snippet: makeSnippet(candidate.text, keyword),
      });
      if (limit !== undefined && hits.length >= limit) {
        break;
      }
    }

    return hits;
  }

  async queryEdges(query: ProjectionEdgeQuery): Promise<EdgeProjection[]> {
    const db = this.require();
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.src !== undefined) {
      where.push('src = ?');
      params.push(query.src);
    }
    if (query.predicate !== undefined) {
      where.push('predicate = ?');
      params.push(query.predicate);
    }
    if (query.dst !== undefined) {
      where.push('dst = ?');
      params.push(query.dst);
    }
    if (query.as_of_ms !== undefined) {
      // as-of：只要在 T 时刻有效（valid_ms <= T 且尚未失效）。
      where.push('(valid_ms IS NULL OR valid_ms <= ?)');
      params.push(query.as_of_ms);
      where.push('(invalid_ms IS NULL OR invalid_ms > ?)');
      params.push(query.as_of_ms);
    }

    const sql =
      `SELECT id, src, predicate, dst, valid_ms, invalid_ms, created_ms, expired_ms, confidence, reason, provenance` +
      ` FROM edge${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}` +
      ` ORDER BY created_ms ASC, id ASC`;

    return db.prepare(sql).all(...(params as never[])).map((row) => toEdgeProjection(row));
  }

  async allExperiences(): Promise<ExperienceProjection[]> {
    return this.query({});
  }

  async allEdges(): Promise<EdgeProjection[]> {
    return this.queryEdges({});
  }

  async allDocuments(): Promise<Map<string, string>> {
    const db = this.require();
    const rows = db
      .prepare(
        `SELECT e.id AS id, f.text AS text FROM experience_fts f` +
          ` JOIN experience e ON e.tick = f.rowid`,
      )
      .all() as Array<{ id: string; text: string }>;
    const out = new Map<string, string>();
    for (const row of rows) {
      out.set(row.id, row.text);
    }
    return out;
  }

  async clear(): Promise<void> {
    const db = this.require();
    db.exec('DELETE FROM experience_fts; DELETE FROM edge; DELETE FROM experience;');
  }

  /**
   * 真事务：失败整体回滚，不留半截数据（审计口径 13「L1 用事务，失败回滚」）。
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const db = this.require();
    db.exec('BEGIN');
    try {
      const result = await fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败不掩盖原始错误。
      }
      throw error;
    }
  }

  /**
   * 预筛：返回候选（id + 文本 + kind + channel）。
   *
   * 实测结论：trigram MATCH 是 ASCII 子串匹配的超集（它还折叠 Unicode 大小写），
   * 故 MATCH 后仍需精确判定；<3 字符时 trigram 无法命中，改走 LIKE。
   */
  private prefilter(keyword: string): Array<{ id: string; text: string; kind: string; channel: string }> {
    const db = this.require();

    if (keyword.length >= MIN_TRIGRAM_LENGTH) {
      // 关键词作为 FTS5 短语：双引号包裹并转义内部引号，避免被当作 FTS 语法。
      const phrase = `"${keyword.replace(/"/g, '""')}"`;
      try {
        const rows = db
          .prepare(
            `SELECT e.id AS id, e.kind AS kind, e.channel AS channel, f.text AS text` +
              ` FROM experience_fts f JOIN experience e ON e.tick = f.rowid` +
              ` WHERE experience_fts MATCH ? ORDER BY e.occurred_ms ASC, e.tick ASC`,
          )
          .all(phrase) as Array<{ id: string; kind: string; channel: string; text: string }>;
        return rows;
      } catch {
        // 关键词含 FTS5 特殊语法导致解析失败 → 落到 LIKE 回退。
      }
    }

    const escaped = keyword.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = db
      .prepare(
        `SELECT e.id AS id, e.kind AS kind, e.channel AS channel, f.text AS text` +
          ` FROM experience_fts f JOIN experience e ON e.tick = f.rowid` +
          ` WHERE f.text LIKE ? ESCAPE '\\' ORDER BY e.occurred_ms ASC, e.tick ASC`,
      )
      .all(`%${escaped}%`) as Array<{ id: string; kind: string; channel: string; text: string }>;
    return rows;
  }

  private require(): DatabaseSync {
    if (this.db === null) {
      throw new UnavailableError('投影库未打开');
    }
    return this.db;
  }
}

/** 行 → 经历投影。 */
export function toExperienceProjection(row: unknown): ExperienceProjection {
  const obj = row as Record<string, unknown>;
  return {
    id: String(obj['id']),
    kind: String(obj['kind']),
    channel: String(obj['channel']),
    scene_ref: obj['scene_ref'] === null || obj['scene_ref'] === undefined ? null : String(obj['scene_ref']),
    initiation:
      obj['initiation'] === null || obj['initiation'] === undefined ? null : String(obj['initiation']),
    occurred_ms: Number(obj['occurred_ms']),
    recorded_ms: Number(obj['recorded_ms']),
    tick: Number(obj['tick']),
    status: String(obj['status']),
    shard: String(obj['shard']),
    seq: Number(obj['seq']),
  };
}

/** 行 → 边投影。 */
export function toEdgeProjection(row: unknown): EdgeProjection {
  const obj = row as Record<string, unknown>;
  const num = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return {
    id: String(obj['id']),
    src: String(obj['src']),
    predicate: String(obj['predicate']),
    dst: String(obj['dst']),
    valid_ms: num(obj['valid_ms']),
    invalid_ms: num(obj['invalid_ms']),
    created_ms: Number(obj['created_ms']),
    expired_ms: num(obj['expired_ms']),
    confidence: num(obj['confidence']),
    reason: obj['reason'] === null || obj['reason'] === undefined ? null : String(obj['reason']),
    provenance:
      obj['provenance'] === null || obj['provenance'] === undefined ? null : String(obj['provenance']),
  };
}

/** 供 L2/L3 复用的 ASCII 小写（避免循环依赖，直接内联实现）。 */
export { asciiLower };
