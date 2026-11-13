/**
 * 记忆层选择索引库柄 —— 方案 §4.3（唯一持库柄，读写权限分柄）。
 *
 * 纪律：
 *  - 库文件以绝对路径打开，写入只允许发生在 indexDir 内；
 *  - 不封装任何指向 experiences/events/raw-turns/state 的写函数；
 *  - 写柄进程内单例：同目录二次 openMemoryWrite 抛 ConflictError（§11.2）；
 *  - 构建器根本不打开 fasti.sqlite —— 本模块只认 projection/memory-index/。
 *
 * C1 范围（§9）：开库/建表/只读查询/meta stamp。
 * C2 加入：transactionApply（卡/别名事务 + FTS 同步 + 账本追加）与共享库原语。
 * search 随 C3、recordMiss 随 C4、writeAuditRun 随 C5 加入。
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ConflictError, IntegrityError, NotFoundError, UnavailableError } from '../core/errors.ts';
import { ensureDir, exists } from '../core/fsx.ts';
import { isUlid, ulid } from '../core/ulid.ts';
import { applyMissAlias } from './alias-write.ts';
import type { ApplyMissAliasOutcome } from './alias-write.ts';
import { insertAuditItem, insertAuditRun } from './audit/metrics.ts';
import { normalizeQuery, searchCards, searchCardsExplained } from './bm25.ts';
import { aliasFromRow, cueTextOf, syncFts } from './fts.ts';
import { appendDecision, appendRevision, readRevisions, validateRevisionChain } from './ledger.ts';
import { MemoryIndexStaleError } from './memory-errors.ts';
import { insertMissRow } from './miss.ts';
import { MEMORY_SCHEMA, MEMORY_SCHEMA_VERSION } from './schema.ts';
import type {
  AliasRow,
  AuditItemRecord,
  AuditRunRecord,
  CardChangeSet,
  DecisionRecord,
  ExplainedRankedCard,
  MemoryCard,
  MissObservationInput,
  RankedCard,
  RevisionRecord,
  SearchQuery,
  TruthFingerprint,
} from './types.ts';

// N1 无环抽取：别名行映射/cue_text/FTS 重建实现移入 fts.ts，此处 re-export 保持公开 API 路径稳定
// （既有从 './store.ts' 引用 aliasFromRow/cueTextOf/syncFts 的调用方与测试零改动）。
export { aliasFromRow, cueTextOf, syncFts };

/** 选择索引目录（即 projection/memory-index/）。 */
export interface StorePaths {
  indexDir: string;
}

/** 只读柄 —— 未来运行时只拿这个（方案 §4.3）。 */
export interface MemoryReadHandle {
  getCard(cardId: string): MemoryCard | null;
  getCardByEvent(eventId: string): MemoryCard | null;
  /**
   * 按真源经历 id 反查锚定它的 active 卡（#44 她回查宽通道，§5.4）：
   * 入参须为合法 ULID；逐条 JSON.parse + 参数化查询，不拼 SQL、不依赖 SQL JSON 扩展；
   * 只读、确定性、不产生任何文件。读柄不因此获得任何写能力。
   */
  getCardsByAnchor(experienceId: string): MemoryCard[];
  search(query: SearchQuery): Promise<RankedCard[]>;
  listEffective(atMs: number): MemoryCard[];
  /** 真值指纹与 stamp 不符抛 MemoryIndexStaleError（读操作拒绝服务）。 */
  verifyStampedFingerprint(current: TruthFingerprint): void;
  close(): Promise<void>;
}

/**
 * 包内只读视图（第二层 v0.3 §4，N17）：在 MemoryReadHandle 之上加 explained 全集检索，
 * 仅供 memory 内部 runtime 窄柄工厂使用，**不对装配层公开**（WP3 白名单不枚举本接口与其工厂）。
 * MemoryReadHandle 公开面因此保持零增量，旧调用方零漂移。
 */
export interface MemoryInternalReadHandle extends MemoryReadHandle {
  /**
   * 全集 explained 检索：实现固定以 limit:undefined 委托 searchCardsExplained，
   * 不读取/透传调用方 query 对象上的任何 limit 字段（N11 防线②）。
   */
  searchExplained(query: SearchQuery): Promise<ExplainedRankedCard[]>;
}

/**
 * 漏召回填别名窄写请求（写柄 API，#44 §5.5）。
 * term 为未规范化词：写柄在委托低层前经 bm25.normalizeQuery 规范化（N5：alias-write 不 import bm25）；
 * sensitive 由调用方显式给出（第一层不自动猜隐私）；atMs 注入，同时作别名 created_ms 与决策 at_ms。
 */
export interface AddMissAliasRequest {
  term: string;
  cardId: string;
  sensitive: 0 | 1;
  atMs: number;
}

/** 写柄 —— 仅 builder 脚本可实例化（方案 §4.3）。 */
export interface MemoryWriteHandle extends MemoryInternalReadHandle {
  /** meta stamp：写 schema_meta.stamped_revision / truth_fingerprint（§3.4）。 */
  stampRevision(revision: RevisionRecord): void;
  /**
   * 事务落卡与别名（§4.3）：DB 事务（upsert + FTS 同步 + meta stamp）提交后
   * 追加 revisions/decisions 账本。账本连续性在事务前预校验，避免半状态。
   */
  transactionApply(changes: CardChangeSet, revision: RevisionRecord, decisions: DecisionRecord[]): void;
  /** 漏召观测写入（§4.9）：委托 miss.ts 低层 insertMissRow，白名单字段、无原始查询。 */
  recordMiss(input: MissObservationInput): void;
  /**
   * 漏召回填别名窄写（#44 §5.5）：写柄规范化 term 后单向委托无环低层 alias-write.applyMissAlias；
   * 仅真实新增（changed）在 DB 提交后追加一条 action='add-alias' 决策，幂等/拒绝不写账本。
   */
  addMissAlias(request: AddMissAliasRequest): ApplyMissAliasOutcome;
  /** 审计落库（§4.10/I1-A）：单事务写 1 条 run 与其 items，委托 audit/metrics.ts 低层。 */
  writeAuditRun(run: AuditRunRecord, items: AuditItemRecord[]): void;
}

/** 库文件名（与 fasti.sqlite、l2/ 平级隔离，§3.1）。 */
export const MEMORY_INDEX_FILE = 'memory-index.sqlite';

/** 进程内写柄单例表（键 = 绝对 indexDir）。 */
const writeHandles = new Map<string, MemoryWriteHandle>();

function dbFileOf(paths: StorePaths): string {
  return path.join(path.resolve(paths.indexDir), MEMORY_INDEX_FILE);
}

/** 行 → 轻卡（列名 snake_case → camelCase，可空列归一为 null）。 */
export function cardFromRow(raw: Record<string, unknown>): MemoryCard {
  const nullableNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return {
    cardId: String(raw['card_id']),
    eventId: String(raw['event_id']),
    anchorJson: String(raw['anchor_json']),
    channel: String(raw['channel']),
    cardType: String(raw['card_type']) as MemoryCard['cardType'],
    selection: String(raw['selection']) as MemoryCard['selection'],
    weight: Number(raw['weight']),
    displayCuesJson: String(raw['display_cues_json']),
    aliasesJson: String(raw['aliases_json']),
    discriminator: String(raw['discriminator']),
    entityHintJson: null,
    occurredMs: Number(raw['occurred_ms']),
    endedMs: Number(raw['ended_ms']),
    validMs: Number(raw['valid_ms']),
    invalidMs: nullableNumber(raw['invalid_ms']),
    createdMs: Number(raw['created_ms']),
    expiredMs: nullableNumber(raw['expired_ms']),
    status: String(raw['status']) as MemoryCard['status'],
    contentHash: String(raw['content_hash']),
    hitCount: Number(raw['hit_count']),
    lastHitMs: nullableNumber(raw['last_hit_ms']),
    schemaVersion: Number(raw['schema_version']),
  };
}

// aliasFromRow / cueTextOf 已 N1 抽取至 ./fts.ts（见文件顶部 re-export）。

const CARD_COLUMNS = [
  'card_id',
  'event_id',
  'anchor_json',
  'channel',
  'card_type',
  'selection',
  'weight',
  'display_cues_json',
  'aliases_json',
  'discriminator',
  'entity_hint_json',
  'occurred_ms',
  'ended_ms',
  'valid_ms',
  'invalid_ms',
  'created_ms',
  'expired_ms',
  'status',
  'content_hash',
  'hit_count',
  'last_hit_ms',
  'schema_version',
] as const;

/** 卡 → 绑定值（顺序与 CARD_COLUMNS 一致；行哈希也按此序规范化，§4.6⑥）。 */
export function cardValues(card: MemoryCard): Array<string | number | null> {
  return [
    card.cardId,
    card.eventId,
    card.anchorJson,
    card.channel,
    card.cardType,
    card.selection,
    card.weight,
    card.displayCuesJson,
    card.aliasesJson,
    card.discriminator,
    card.entityHintJson,
    card.occurredMs,
    card.endedMs,
    card.validMs,
    card.invalidMs,
    card.createdMs,
    card.expiredMs,
    card.status,
    card.contentHash,
    card.hitCount,
    card.lastHitMs,
    card.schemaVersion,
  ];
}

/** upsert 轻卡（主键 card_id；调用方负责事务边界）。 */
export function writeCards(db: DatabaseSync, cards: readonly MemoryCard[]): void {
  const updates = CARD_COLUMNS.filter((c) => c !== 'card_id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const stmt = db.prepare(
    `INSERT INTO mem_card(${CARD_COLUMNS.join(', ')}) VALUES (${CARD_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(card_id) DO UPDATE SET ${updates}`,
  );
  for (const card of cards) {
    stmt.run(...cardValues(card));
  }
}

/** upsert 别名（主键 term_norm+card_id；调用方负责事务边界）。 */
export function writeAliases(db: DatabaseSync, aliases: readonly AliasRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO mem_alias(term_norm, card_id, source, sensitive, status, created_ms, hit_count, last_hit_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(term_norm, card_id) DO UPDATE SET
       source = excluded.source, sensitive = excluded.sensitive, status = excluded.status,
       created_ms = excluded.created_ms, hit_count = excluded.hit_count, last_hit_ms = excluded.last_hit_ms`,
  );
  for (const alias of aliases) {
    stmt.run(
      alias.termNorm,
      alias.cardId,
      alias.source,
      alias.sensitive,
      alias.status,
      alias.createdMs,
      alias.hitCount,
      alias.lastHitMs,
    );
  }
}

// syncFts 已 N1 抽取至 ./fts.ts（见文件顶部 re-export）。

/** meta stamp 三键（调用方负责事务边界）。 */
export function stampMeta(
  db: DatabaseSync,
  values: { schema_version: number; stamped_revision: number; truth_fingerprint: string },
): void {
  const upsert = db.prepare(
    'INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  upsert.run('schema_version', String(values.schema_version));
  upsert.run('stamped_revision', String(values.stamped_revision));
  upsert.run('truth_fingerprint', values.truth_fingerprint);
}

/** 读柄实现（只读打开，不建表、不创建文件）。 */
class ReadHandle implements MemoryReadHandle, MemoryInternalReadHandle {
  protected db: DatabaseSync | null;
  protected readonly file: string;

  constructor(file: string, db: DatabaseSync) {
    this.file = file;
    this.db = db;
  }

  protected require(): DatabaseSync {
    if (this.db === null) {
      throw new UnavailableError(`记忆索引库已关闭：${this.file}`);
    }
    return this.db;
  }

  getCard(cardId: string): MemoryCard | null {
    const row = this.require().prepare('SELECT * FROM mem_card WHERE card_id = ?').get(cardId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : cardFromRow(row);
  }

  getCardByEvent(eventId: string): MemoryCard | null {
    const row = this.require()
      .prepare(
        "SELECT * FROM mem_card WHERE event_id = ? AND status = 'active' ORDER BY created_ms ASC, card_id ASC LIMIT 1",
      )
      .get(eventId) as Record<string, unknown> | undefined;
    return row === undefined ? null : cardFromRow(row);
  }

  getCardsByAnchor(experienceId: string): MemoryCard[] {
    if (!isUlid(experienceId)) {
      throw new IntegrityError(`anchor 反查入参必须是合法 ULID：${experienceId}`);
    }
    // 仅参数化查询取 active 卡（确定性次序），锚点包含判定在 JS 侧逐条 JSON.parse 纯计算，
    // 不拼 SQL、不依赖可能缺失的 SQL JSON 扩展；只读连接上执行，不产生文件。
    const rows = this.require()
      .prepare(
        "SELECT * FROM mem_card WHERE status = 'active' ORDER BY created_ms ASC, card_id ASC",
      )
      .all() as Array<Record<string, unknown>>;
    const matched: MemoryCard[] = [];
    for (const raw of rows) {
      const card = cardFromRow(raw);
      let parsedAnchorIds: unknown;
      try {
        parsedAnchorIds = JSON.parse(card.anchorJson);
      } catch {
        throw new IntegrityError(`mem_card.anchor_json 损坏：${card.cardId}`);
      }
      if (!Array.isArray(parsedAnchorIds) || parsedAnchorIds.some((id) => typeof id !== 'string')) {
        throw new IntegrityError(`mem_card.anchor_json 必须是字符串数组：${card.cardId}`);
      }
      if ((parsedAnchorIds as string[]).includes(experienceId)) {
        matched.push(card);
      }
    }
    return matched;
  }

  async search(query: SearchQuery): Promise<RankedCard[]> {
    return searchCards(this.require(), query);
  }

  async searchExplained(query: SearchQuery): Promise<ExplainedRankedCard[]> {
    // N11 防线②：写死 limit: undefined 取全集，绝不读取 query.limit（即使上层 any 强塞也不转发）。
    return searchCardsExplained(this.require(), {
      text: query.text,
      atMs: query.atMs,
      limit: undefined,
    });
  }

  listEffective(atMs: number): MemoryCard[] {
    // as-of 三条件，与 edge 同构（§3.3）：valid<=T 且 (invalid 空或>T) 且 created<=T。
    const rows = this.require()
      .prepare(
        'SELECT * FROM mem_card WHERE valid_ms <= ? AND (invalid_ms IS NULL OR invalid_ms > ?) AND created_ms <= ? ORDER BY occurred_ms ASC, card_id ASC',
      )
      .all(atMs, atMs, atMs) as Array<Record<string, unknown>>;
    return rows.map(cardFromRow);
  }

  verifyStampedFingerprint(current: TruthFingerprint): void {
    const row = this.require()
      .prepare("SELECT value FROM schema_meta WHERE key = 'truth_fingerprint'")
      .get() as { value: string } | undefined;
    if (row === undefined || row.value !== current.aggregate) {
      throw new MemoryIndexStaleError(
        `记忆索引真值指纹与 stamp 不符（索引过期，须离线重建）：${this.file}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }
}

/** 写柄实现（读写打开 + 建表 + meta stamp）。 */
class WriteHandle extends ReadHandle implements MemoryWriteHandle {
  private readonly indexDir: string;

  constructor(indexDir: string, file: string, db: DatabaseSync) {
    super(file, db);
    this.indexDir = indexDir;
  }

  stampRevision(revision: RevisionRecord): void {
    const db = this.require();
    db.exec('BEGIN');
    try {
      stampMeta(db, {
        schema_version: revision.schema_version,
        stamped_revision: revision.revision,
        truth_fingerprint: revision.truth_fingerprint,
      });
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败不掩盖原始错误。
      }
      throw error;
    }
  }

  transactionApply(
    changes: CardChangeSet,
    revision: RevisionRecord,
    decisions: DecisionRecord[],
  ): void {
    // 账本连续性在 DB 事务前预校验：链不合法就一行都不写，避免半状态。
    validateRevisionChain(readRevisions(this.indexDir), revision);
    const db = this.require();
    db.exec('BEGIN');
    try {
      writeCards(db, changes.cards);
      writeAliases(db, changes.aliases);
      syncFts(
        db,
        new Set([
          ...changes.cards.map((card) => card.cardId),
          ...changes.aliases.map((alias) => alias.cardId),
        ]),
      );
      stampMeta(db, {
        schema_version: revision.schema_version,
        stamped_revision: revision.revision,
        truth_fingerprint: revision.truth_fingerprint,
      });
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败不掩盖原始错误。
      }
      throw error;
    }
    // DB 提交后才追加账本：账本记的是「已提交」的事实。
    appendRevision(this.indexDir, revision);
    for (const decision of decisions) {
      appendDecision(this.indexDir, decision);
    }
  }

  recordMiss(input: MissObservationInput): void {
    insertMissRow(this.require(), input);
  }

  addMissAlias(request: AddMissAliasRequest): ApplyMissAliasOutcome {
    // N5：规范化在写柄完成（store→bm25 为既有合法方向），alias-write 只收已规范化 termNorm。
    const termNorm = normalizeQuery(request.term);
    const outcome = applyMissAlias(this.require(), {
      termNorm,
      cardId: request.cardId,
      sensitive: request.sensitive,
      createdMs: request.atMs,
    });
    // 仅真实新增在 DB 事务提交成功后追加决策；幂等跳过/拒绝零账本、零半状态。reason 为受控码，不存原文。
    if (outcome.ok && outcome.changed) {
      const card = this.getCard(request.cardId);
      if (card === null) {
        throw new IntegrityError(`addMissAlias 后目标卡消失（不变量破坏）：${request.cardId}`);
      }
      const decision: DecisionRecord = {
        decision_id: ulid(),
        at_ms: request.atMs,
        action: 'add-alias',
        card_id: card.cardId,
        event_id: card.eventId,
        anchor_json: card.anchorJson,
        content_hash: outcome.contentHash,
        model_tag: 'rules-v1',
        reason: 'add-alias:miss-recheck',
        created_by: 'her',
      };
      appendDecision(this.indexDir, decision);
    }
    return outcome;
  }

  writeAuditRun(run: AuditRunRecord, items: AuditItemRecord[]): void {
    const db = this.require();
    db.exec('BEGIN');
    try {
      insertAuditRun(db, run);
      for (const item of items) {
        insertAuditItem(db, item);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败不掩盖原始错误。
      }
      throw error;
    }
  }

  override async close(): Promise<void> {
    await super.close();
    writeHandles.delete(this.indexDir);
  }
}

/**
 * 打开只读柄。
 * 库文件不存在抛 NotFoundError，且**不创建任何文件**（只读柄零写副作用）。
 */
export function openMemoryRead(paths: StorePaths): MemoryReadHandle {
  const file = dbFileOf(paths);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    throw new NotFoundError(`记忆索引库不存在或不可读：${file}`, { cause: error });
  }
  return new ReadHandle(file, db);
}

/**
 * 包内只读视图工厂（N17）：与 openMemoryRead 同一开库纪律，返回类型收窄标注为
 * MemoryInternalReadHandle（ReadHandle 已显式 implements，无需类型断言）。
 * 仅供 memory 内 runtime 窄柄工厂调用；装配层白名单不枚举本符号，引用即红（WP3 投毒）。
 */
export function openMemoryInternalRead(paths: StorePaths): MemoryInternalReadHandle {
  const file = dbFileOf(paths);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    throw new NotFoundError(`记忆索引库不存在或不可读：${file}`, { cause: error });
  }
  return new ReadHandle(file, db);
}

/**
 * 运行期窄柄后端（第二层 v0.3 §5.2/Q3，包内类型，不对装配层公开）。
 * - writable=true：writer 为完整写柄（同时满足只读视图），窄柄五方法全开；
 * - writable=false：离线 builder 占着写单例（ConflictError），writer=null，窄柄降级只读。
 */
export interface MemoryRuntimeBackend {
  readonly writable: boolean;
  readonly reader: MemoryInternalReadHandle;
  readonly writer: MemoryWriteHandle | null;
}

/**
 * 打开运行期窄柄后端：Q3“只开不建”闸门 + 写单例冲突降级。
 * 1. 库文件不存在直接抛 NotFoundError——绝不走 openMemoryWrite 的 ensureDir 建库路径；
 * 2. 库存在才尝试写柄（CREATE TABLE IF NOT EXISTS 对既有库为幂等 no-op，不改 schema）；
 * 3. 写单例被占用（ConflictError）时回退只读连接，writable=false，由窄柄把写调用转为 UnavailableError。
 */
export function openMemoryRuntimeBackend(paths: StorePaths): MemoryRuntimeBackend {
  const file = dbFileOf(paths);
  if (!exists(file)) {
    throw new NotFoundError(`记忆索引库不存在，运行期窄柄只开不建：${file}`);
  }
  try {
    const writer = openMemoryWrite(paths);
    return { writable: true, reader: writer, writer };
  } catch (error) {
    if (!(error instanceof ConflictError)) {
      throw error;
    }
    return { writable: false, reader: openMemoryInternalRead(paths), writer: null };
  }
}

/**
 * 打开写柄（仅 builder 脚本用）。
 * 建表在事务内执行 CREATE TABLE IF NOT EXISTS（重开幂等）；
 * 同目录二次打开抛 ConflictError（进程内单例，防双写，§11.2）。
 */
export function openMemoryWrite(paths: StorePaths): MemoryWriteHandle {
  const indexDir = path.resolve(paths.indexDir);
  if (writeHandles.has(indexDir)) {
    throw new ConflictError(`记忆索引写柄已存在（进程内单例）：${indexDir}`);
  }
  const file = path.join(indexDir, MEMORY_INDEX_FILE);
  ensureDir(indexDir);

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file);
    db.exec('BEGIN');
    for (const statement of MEMORY_SCHEMA) {
      db.exec(statement);
    }
    db.prepare('INSERT OR IGNORE INTO schema_meta(key, value) VALUES (?, ?)').run(
      'schema_version',
      String(MEMORY_SCHEMA_VERSION),
    );
    db.exec('COMMIT');
  } catch (error) {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // 关闭失败不掩盖原始错误。
      }
    }
    throw new UnavailableError(`无法打开记忆索引库：${file}`, { cause: error });
  }

  const handle = new WriteHandle(indexDir, file, db);
  writeHandles.set(indexDir, handle);
  return handle;
}