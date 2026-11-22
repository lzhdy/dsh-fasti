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
import { isUlid } from '../core/ulid.ts';
import { msToIso } from '../core/time.ts';
import { applyMissAlias } from './alias-write.ts';
import type { ApplyMissAliasOutcome } from './alias-write.ts';
import { buildAdoptionRecord } from './adoption.ts';
import type { AdoptionRecord } from './adoption.ts';
import { openAdoptionStore } from './adoption-store.ts';
import { applyAdoption } from './adoption-write.ts';
import type { RecordAdoptionOutcome } from './adoption-write.ts';
import { insertAuditItem, insertAuditRun } from './audit/metrics.ts';
import { normalizeQuery, searchCards, searchCardsExplained } from './bm25.ts';
import { castDecision } from './decision.ts';
import type { DecisionVersionContext } from './decision.ts';
import { aliasFromRow, cueTextOf, syncFts } from './fts.ts';
import { appendDecision, appendRevision, readRevisions, validateRevisionChain } from './ledger.ts';
import { MemoryIndexStaleError } from './memory-errors.ts';
import { insertMissRow } from './miss.ts';
import { pruneMissRows } from './miss-prune.ts';
import type { MissPruneOutcome } from './miss-prune.ts';
import { createMissSentinel } from './miss-sentinel.ts';
import type { MissSentinel, MissSentinelOptions, MissSentinelSnapshot } from './miss-sentinel.ts';
import { MISS_RETENTION_TMP_POLICY } from './miss-retention.ts';
import type { MissRetentionPolicy } from './miss-retention.ts';
import { MEMORY_SCHEMA, MEMORY_SCHEMA_VERSION } from './schema.ts';
import type { MemoryObservationCounts } from './observation.ts';
import {
  CURRENT_RULES_VERSION,
  type AliasRow,
  type AuditItemRecord,
  type AuditRunRecord,
  type CardChangeSet,
  type DecisionRecord,
  type ExplainedRankedCard,
  type MemoryCard,
  type MissObservationInput,
  type RankedCard,
  type RevisionRecord,
  type SearchQuery,
  type TruthFingerprint,
} from './types.ts';

// N1 无环抽取：别名行映射/cue_text/FTS 重建实现移入 fts.ts，此处 re-export 保持公开 API 路径稳定
// （既有从 './store.ts' 引用 aliasFromRow/cueTextOf/syncFts 的调用方与测试零改动）。
export { aliasFromRow, cueTextOf, syncFts };

/**
 * 【仅遗留 miss 回填路径使用 · B3 收编时根治】写柄只持 indexDir、不触真源（M6 规则①），
 * 读不到事件版本；此常量仅作 miss 回填决策行的版本身份占位，不是事件版本号。
 * B3 收编接事件版本读取器后删除；drain 编排内 create-card / invalidate / add-alias
 * 三处决策一律由事件版本上下文注入，不经此占位。
 */
const LEGACY_ONLY_MISS_ALIAS_VERSION = 1;

/** 选择索引目录（即 projection/memory-index/）。 */
export interface StorePaths {
  indexDir: string;
  /** 事件真源数据根（第七法只读读取器注入点；缺省 null = 未接真源，空轮处理）。 */
  dataRoot?: string | null;
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
  /** 几何版本窗口校验：版本/tokenizer 不符抛 MemoryIndexStaleError（#124，检索与 drain 入口调用）。 */
  assertGeometryCurrent(): void;
  listEffective(atMs: number): MemoryCard[];
  /**
   * 观测面：列出**全部状态**卡（含 invalid/superseded），确定性次序
   * occurred_ms, card_id。供 #157 本机观测台使用，模型检索路径仍走 listEffective。
   */
  listAllCards(): MemoryCard[];
  /** 观测面：取某卡的权威别名行（mem_alias 表，而非卡内快照）。 */
  listAliasesByCard(cardId: string): AliasRow[];
  /** 观测面：卡/别名/漏召台账聚合计数（纯 SELECT，参数化，零写）。 */
  observationCounts(): MemoryObservationCounts;
  /** 真值指纹与 stamp 不符抛 MemoryIndexStaleError（读操作拒绝服务）。 */
  verifyStampedFingerprint(current: TruthFingerprint): void;
  /** 读 schema_meta 单键；缺键返回 null（只读，不建表/不写值）。 */
  getMeta(key: string): string | null;
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
  /**
   * 决策版本上下文（事件版本号 + 该版本 created_at）；与 create-card/invalidate 同一处注入。
   * 缺省走遗留 miss 回填占位口径；drain 编排路径必须显式传入事件版本上下文。
   */
  versionContext?: DecisionVersionContext | undefined;
}

/** 写柄打开选项（#117 哨兵注入；缺省用段一临时硬顶、无告警回调）。 */
export interface OpenMemoryWriteOptions {
  readonly missSentinel?: MissSentinelOptions;
}

/**
 * 采用计数窄写请求（#130 P2）。桥接层已完成第③跳原文下钻成功确认、锚点→active 卡映射与
 * 本检索情节去重；写柄只认 cardId + 注入时钟，不接收任何查询词/指针/原文形参。
 */
export interface RecordAnchorAdoptionRequest {
  readonly cardId: string;
  readonly atMs: number;
}

/** 写柄采用结果：成功携带账本行与新计数，拒绝透传低层受控原因码。 */
export type RecordAnchorAdoptionHandleOutcome =
  | (RecordAdoptionOutcome & { readonly ok: true; readonly record: AdoptionRecord })
  | Extract<RecordAdoptionOutcome, { readonly ok: false }>;

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
  /**
   * 采用计数窄写（#130 P2，I10 重裁后实时采用唯一写口）：她钻真源原文成功后由桥接层调用。
   * 单向委托无环低层 adoption-write.applyAdoption，单事务只 UPDATE hit_count/last_hit_ms 两列；
   * DB 提交成功后向 indexDir/adoptions.jsonl 追加同内容键账本行（只记已提交事实）。
   * 缺卡/非 active 结构化拒绝且零账本；模式门（on/shadow/off）在上层工具桥接，写柄本身不判模式。
   */
  recordAnchorAdoption(request: RecordAnchorAdoptionRequest): RecordAnchorAdoptionHandleOutcome;
  /** 审计落库（§4.10/I1-A）：单事务写 1 条 run 与其 items，委托 audit/metrics.ts 低层。 */
  writeAuditRun(run: AuditRunRecord, items: AuditItemRecord[]): void;
  /**
   * 漏召观测留存维护（#117 3.2 第 1 件）：**不搭 transactionApply 的便车**。
   * 未越界零写事务；越界时台账先行 → fsync → 独立删除事务。纯函数裁决在 miss-retention.ts。
   */
  pruneMisses(policy: MissRetentionPolicy): MissPruneOutcome;
  /** 哨兵快照（诊断/测试）：估算行数、阈值、是否已告警。 */
  missSentinelSnapshot(): MissSentinelSnapshot;
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

/**
 * meta stamp 四键（调用方负责事务边界）。
 *
 * #123 P4：第四键 `rules_version` 是"本投影由哪套派生规则产出"的唯一印章；
 * 缺它则 drain 的 `isRulesVersionMismatch` 永远拿到 null、`rebuild-required` 永不触发。
 */
export function stampMeta(
  db: DatabaseSync,
  values: {
    schema_version: number;
    stamped_revision: number;
    truth_fingerprint: string;
    rules_version: string;
  },
): void {
  const upsert = db.prepare(
    'INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  upsert.run('schema_version', String(values.schema_version));
  upsert.run('stamped_revision', String(values.stamped_revision));
  upsert.run('truth_fingerprint', values.truth_fingerprint);
  upsert.run('rules_version', values.rules_version);
}

/**
 * 几何版本窗口硬校验（#124 charter §3.6，全新机制）。
 *
 * 双项核对，任一不符抛 {@link MemoryIndexStaleError}（显式“须离线重建”，禁静默返空）：
 *  1. schema_meta.schema_version 戳记 === 当前代码 {@link MEMORY_SCHEMA_VERSION}；
 *  2. sqlite_master 中 mem_card_fts 的实际 DDL 声明确为 unicode61（防戳记被手工改写但几何仍旧）。
 * 纯只读、事务外、无写入；卡片读取路径（getCard/listEffective）不挂本断言，仅检索入口与 drain 挂。
 */
export function assertMemoryGeometryCurrent(db: DatabaseSync, file: string): void {
  const meta = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const stamped = meta === undefined ? null : Number(meta.value);
  if (stamped !== MEMORY_SCHEMA_VERSION) {
    throw new MemoryIndexStaleError(
      `记忆索引 schema 版本为 v${stamped === null ? '缺失' : stamped}，当前代码要求 v${MEMORY_SCHEMA_VERSION}：` +
        `索引几何不兼容，须经离线影子库整库重建并原子切换后才能检索（禁原地迁移）：${file}`,
    );
  }
  const ftsRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mem_card_fts'")
    .get() as { sql: string } | undefined;
  if (ftsRow === undefined || !/tokenize\s*=\s*'unicode61'/i.test(ftsRow.sql)) {
    throw new MemoryIndexStaleError(
      `mem_card_fts 实际 tokenizer 不是 unicode61（#124 bigram 几何）：须经离线影子库整库重建后切换：${file}`,
    );
  }
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
    this.assertGeometryCurrent();
    return searchCards(this.require(), query);
  }

  async searchExplained(query: SearchQuery): Promise<ExplainedRankedCard[]> {
    this.assertGeometryCurrent();
    // N11 防线②：写死 limit: undefined 取全集，绝不读取 query.limit（即使上层 any 强塞也不转发）。
    return searchCardsExplained(this.require(), {
      text: query.text,
      atMs: query.atMs,
      limit: undefined,
    });
  }

  assertGeometryCurrent(): void {
    assertMemoryGeometryCurrent(this.require(), this.file);
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

  listAllCards(): MemoryCard[] {
    // 观测面全状态列举（含 invalid/superseded）；确定性次序，分页由上层窄柄切片。
    const rows = this.require()
      .prepare('SELECT * FROM mem_card ORDER BY occurred_ms ASC, card_id ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(cardFromRow);
  }

  listAliasesByCard(cardId: string): AliasRow[] {
    const rows = this.require()
      .prepare('SELECT * FROM mem_alias WHERE card_id = ? ORDER BY created_ms ASC, term_norm ASC')
      .all(cardId) as Array<Record<string, unknown>>;
    return rows.map(aliasFromRow);
  }

  observationCounts(): MemoryObservationCounts {
    const db = this.require();
    const countOf = (sql: string, ...params: Array<string | number | bigint | null>): number => {
      const row = db.prepare(sql).get(...params) as { n: number } | undefined;
      return row?.n ?? 0;
    };
    const statusRows = db
      .prepare('SELECT status, COUNT(*) AS n FROM mem_card GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const byStatus = new Map(statusRows.map((row) => [row.status, row.n]));
    return {
      cards: countOf('SELECT COUNT(*) AS n FROM mem_card'),
      activeCards: byStatus.get('active') ?? 0,
      invalidCards: byStatus.get('invalid') ?? 0,
      supersededCards: byStatus.get('superseded') ?? 0,
      aliases: countOf('SELECT COUNT(*) AS n FROM mem_alias'),
      sensitiveAliases: countOf('SELECT COUNT(*) AS n FROM mem_alias WHERE sensitive = 1'),
      misses: countOf('SELECT COUNT(*) AS n FROM mem_miss'),
    };
  }

  getMeta(key: string): string | null {
    const row = this.require()
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row === undefined ? null : String(row.value);
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
  /** #117 3.2 第 3 件：漏召台账行数哨兵（打开时播种，之后写入递增；每进程只告警一次）。 */
  private readonly missSentinel: MissSentinel;

  constructor(
    indexDir: string,
    file: string,
    db: DatabaseSync,
    sentinelOptions: MissSentinelOptions = { hardCapK: MISS_RETENTION_TMP_POLICY.hardCapK },
  ) {
    super(file, db);
    this.indexDir = indexDir;
    this.missSentinel = createMissSentinel(sentinelOptions);
    this.missSentinel.reseed(this.countMissRows());
  }

  /** 播种口径：只读 `COUNT(*)`，不扫表、不进事务。 */
  private countMissRows(): number {
    const row = this.require().prepare('SELECT COUNT(*) AS n FROM mem_miss').get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  stampRevision(revision: RevisionRecord): void {
    const db = this.require();
    db.exec('BEGIN');
    try {
      stampMeta(db, {
        schema_version: revision.schema_version,
        stamped_revision: revision.revision,
        truth_fingerprint: revision.truth_fingerprint,
        rules_version: CURRENT_RULES_VERSION,
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
        rules_version: CURRENT_RULES_VERSION,
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
    // 仅成功落行才递增：写失败不应虚增估算值。
    this.missSentinel.onAppend();
  }

  /** 哨兵快照（诊断/测试用；不暴露写能力）。 */
  missSentinelSnapshot(): MissSentinelSnapshot {
    return this.missSentinel.snapshot();
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
      // 决策行经 decision.ts 纯铸造：decision_id 内容派生（非随机 ulid()）。
      // 版本上下文与 create-card/invalidate 同一处注入：优先取调用方按事件版本传入的
      // DecisionVersionContext；遗留 miss 回填路径无事件版本读取器时，版本身份用占位常量、
      // 时间取注入 ms（不写版本号字面量到铸造站点）。
      const anchors = JSON.parse(card.anchorJson) as string[];
      const versionContext: DecisionVersionContext = request.versionContext ?? {
        version: LEGACY_ONLY_MISS_ALIAS_VERSION,
        createdAtIso: msToIso(request.atMs),
      };
      const decision: DecisionRecord = castDecision({
        eventId: card.eventId,
        version: versionContext.version,
        createdAtIso: versionContext.createdAtIso,
        action: 'add-alias',
        cardId: card.cardId,
        anchors,
        contentHash: outcome.contentHash,
        structuralHash: '',
        modelTag: CURRENT_RULES_VERSION,
        reason: 'add-alias:miss-recheck',
        dedupKey: `add-alias|${card.eventId}|${card.cardId}|${outcome.termNorm}`,
      });
      appendDecision(this.indexDir, decision);
    }
    return outcome;
  }

  recordAnchorAdoption(request: RecordAnchorAdoptionRequest): RecordAnchorAdoptionHandleOutcome {
    // 无环低层权威窄写：单事务仅 hit_count/last_hit_ms 两列，active 守卫在事务内再核验。
    const outcome = applyAdoption(this.require(), {
      cardId: request.cardId,
      atMs: request.atMs,
    });
    if (!outcome.ok) {
      // 缺卡/非 active：不开账本、零半状态，原样透传受控原因码。
      return outcome;
    }
    // DB 提交成功后才追加账本：账本只记已提交事实。contentHash 从事务内读到的卡面带出，
    // 写柄不重新查询、不接受调用方传入。追加失败向上抛错（批6 reconcile 负责发现 DB/账本漂移）。
    const record = buildAdoptionRecord({
      cardId: outcome.cardId,
      atMs: outcome.atMs,
      contentHash: outcome.contentHash,
    });
    openAdoptionStore(this.indexDir).append(record);
    return { ...outcome, record };
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

  pruneMisses(policy: MissRetentionPolicy): MissPruneOutcome {
    const outcome = pruneMissRows(this.require(), this.indexDir, policy);
    // 裁剪后重校准：否则估算值会一直停在裁剪前的高位，哨兵永久闭麦。
    if (outcome.applied) {
      this.missSentinel.reseed(outcome.kept);
    }
    return outcome;
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
export function openMemoryRuntimeBackend(
  paths: StorePaths,
  options?: OpenMemoryWriteOptions,
): MemoryRuntimeBackend {
  const file = dbFileOf(paths);
  if (!exists(file)) {
    throw new NotFoundError(`记忆索引库不存在，运行期窄柄只开不建：${file}`);
  }
  try {
    const writer = openMemoryWrite(paths, options);
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
export function openMemoryWrite(paths: StorePaths, options?: OpenMemoryWriteOptions): MemoryWriteHandle {
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

  const handle = new WriteHandle(indexDir, file, db, options?.missSentinel);
  writeHandles.set(indexDir, handle);
  return handle;
}