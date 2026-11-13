/**
 * 记忆层离线构建器 —— 方案 §4.6（冻结接口，照图施工）。
 *
 * 纪律：
 *  - 真值只读：只读 experiences/events 的 JSONL 分片，**从不打开 fasti.sqlite**；
 *  - 只收 status='closed' AND summary_quality='ready' 的当前态事件作为卡来源（§4.6②）；
 *  - 零正文：无人工种子线索的事件不建卡（卡内容全部来自旧库搬运 + 决策回放，
 *    构建器不生成任何 cues/discriminator 文本）；
 *  - 悬空锚点零产物：任何卡来源事件的锚点回查不到经历 → MemoryAnchorDanglingError，
 *    发生在一切写入之前（§4.6③ / M1）；
 *  - 影子协议：产物先写影子库 → fsync → rename 原子换文件 → 追加 revisions 一行；
 *    任何一步失败：旧库保持在位、tmp 清理、抛错（§5 流 1 / M8）；
 *  - dryRun 不触碰真实 indexDir，影子落 os.tmpdir()，报告 outputDir 指向影子目录（§4.6⑦）；
 *  - 幂等：同真值同决策连跑两次，row_hash_sum 与逐行 card_id/content_hash 全等（§4.6⑥ / M4）。
 *
 * 决策回放（§5 流 2「下次构建以决策行为输入复现同一结果」）：
 *  - tombstone-card → status='superseded' + expired_ms/invalid_ms = 决策时刻（记账不物理删除）；
 *  - invalidate     → status='invalid' + invalid_ms = 决策时刻；
 *  - 目标解析：card_id 优先，缺省按 deriveCardId(event_id, anchor_json) 派生；
 *  - 同一目标多条决策按台账顺序回放，后者覆盖前者。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseEvent } from '../contract/event.ts';
import type { EventRecord } from '../contract/event.ts';
import { parseExperience } from '../contract/validate-experience.ts';
import { IntegrityError, NotFoundError } from '../core/errors.ts';
import { ensureDir, listFiles } from '../core/fsx.ts';
import { readJsonlFile } from '../core/jsonl.ts';
import { isUlid, ulid } from '../core/ulid.ts';
import { foldCurrentEvents } from '../projection/event-row.ts';
import { layoutOf, resolveDataRoot } from '../source/paths.ts';
import { appendRevision, readDecisions, readRevisions } from './ledger.ts';
import { MemoryAnchorDanglingError } from './memory-errors.ts';
import { MEMORY_SCHEMA, MEMORY_SCHEMA_VERSION } from './schema.ts';
import { computeContentHash, deriveCardId, sha256Hex } from './content-hash.ts';
import { aliasFromRow, syncFts } from './fts.ts';
import {
  MEMORY_INDEX_FILE,
  cardFromRow,
  cardValues,
  stampMeta,
  writeAliases,
  writeCards,
} from './store.ts';
import type {
  AliasRow,
  DecisionRecord,
  MemoryCard,
  RevisionRecord,
  TruthFingerprint,
} from './types.ts';

// N1 无环抽取后保持公开 API 路径稳定：哈希/卡 id 实现移入 content-hash.ts，此处本地导入后 re-export，
// 既有从 './builder.ts' 引用 deriveCardId/computeContentHash 的调用方与测试零改动。
export { computeContentHash, deriveCardId };

// ── 冻结接口（方案 §4.6，逐字对齐）────────────────────────────────────────

export interface BuildOptions {
  /** 必填；测试传 tmp 根。 */
  dataRoot: string;
  /** 默认 true；true 时所有产物落 os.tmpdir() 影子目录。 */
  dryRun: boolean;
  /** 缺省全量；增量只影响 diff 报告，结果仍全量比对。 */
  sinceRevision?: number;
  /** 测试注入时钟。 */
  nowMs?: number;
}

export interface BuildReport {
  /** dryRun 时为 null。 */
  revision: number | null;
  fingerprint: TruthFingerprint;
  shadowDiff: { added: number; removed: number; changed: number };
  cards: number;
  aliases: number;
  misses: number;
  /** 非空即失败、零写入。 */
  danglingAnchors: string[];
  outputDir: string;
}

// ── 确定性派生（§4.6 公式）────────────────────────────────────────────────
// 注：sha256Hex/deriveCardId/computeContentHash 已 N1 抽取至 ./content-hash.ts（builder 经
// re-export 保持旧路径可用）；本文件保留真值指纹与行哈希聚合等构建器专用派生。

/**
 * 真值指纹（§4.6④）：experiences+events 分片相对路径排序后逐文件 sha256(字节)，
 * 再按 `路径:哈希` 有序聚合。改一个字节聚合即变（M3 的数据源）。
 */
export function computeTruthFingerprint(dataRoot: string): TruthFingerprint {
  const layout = layoutOf(resolveDataRoot({ dataRoot }));
  const files: Array<{ path: string; sha256: string }> = [];
  const sources: ReadonlyArray<readonly [string, string]> = [
    [layout.experiences, 'experiences'],
    [layout.events, 'events'],
  ];
  for (const [dir, rel] of sources) {
    for (const name of listFiles(dir, '.jsonl')) {
      files.push({
        path: `${rel}/${name}`,
        sha256: sha256Hex(fs.readFileSync(path.join(dir, name))),
      });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const aggregate = sha256Hex(files.map((f) => `${f.path}:${f.sha256}`).join('\n'));
  return { files, aggregate };
}

/** 单行规范化哈希：按 CARD_COLUMNS 列序取值（与落盘绑定值同源，不另写一份字段表）。 */
function cardRowHash(card: MemoryCard): string {
  return sha256Hex(JSON.stringify(cardValues(card)));
}

/** 全量行哈希聚合（§3.4 row_hash_sum）：逐行哈希排序后 join 再 sha256 → 行序无关。 */
export function computeRowHashSum(cards: readonly MemoryCard[]): string {
  const hashes = cards.map(cardRowHash);
  hashes.sort();
  return sha256Hex(hashes.join('\n'));
}

// ── 旧库快照（只读）───────────────────────────────────────────────────────

interface ExistingIndex {
  exists: boolean;
  cards: MemoryCard[];
  aliases: AliasRow[];
  misses: Array<Record<string, unknown>>;
  auditRuns: Array<Record<string, unknown>>;
  auditItems: Array<Record<string, unknown>>;
}

/** 只读打开现有库取全量快照；不存在返回空快照（不创建任何文件）。 */
function readExistingIndex(liveFile: string): ExistingIndex {
  if (!fs.existsSync(liveFile)) {
    return { exists: false, cards: [], aliases: [], misses: [], auditRuns: [], auditItems: [] };
  }
  const db = new DatabaseSync(liveFile, { readOnly: true });
  try {
    const all = (table: string): Array<Record<string, unknown>> =>
      db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    return {
      exists: true,
      cards: all('mem_card').map(cardFromRow),
      aliases: all('mem_alias').map(aliasFromRow),
      misses: all('mem_miss'),
      auditRuns: all('mem_audit_run'),
      auditItems: all('mem_audit_item'),
    };
  } finally {
    db.close();
  }
}

/** 观测行原样搬运（mem_miss / mem_audit_*）—— 重建不抹掉历史观测。 */
function copyRows(
  db: DatabaseSync,
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  const first = rows[0];
  if (first === undefined) {
    return;
  }
  const columns = Object.keys(first);
  const stmt = db.prepare(
    `INSERT INTO ${table}(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  for (const row of rows) {
    stmt.run(...columns.map((column) => row[column] as string | number | null));
  }
}

// ── 决策回放（§5 流 2）────────────────────────────────────────────────────

interface DecisionOutcome {
  status: 'superseded' | 'invalid';
  atMs: number;
}

/**
 * 回放决策台账中的状态类决策（tombstone-card / invalidate）。
 *
 * 目标解析：card_id 优先；缺省按 deriveCardId(event_id, anchor_json) 派生。
 * 同一目标多条决策按台账顺序回放，后者覆盖前者。
 */
function replayDecisions(decisions: readonly DecisionRecord[]): Map<string, DecisionOutcome> {
  const out = new Map<string, DecisionOutcome>();
  for (const decision of decisions) {
    if (decision.action !== 'tombstone-card' && decision.action !== 'invalidate') {
      continue;
    }
    const target =
      decision.card_id ??
      deriveCardId(decision.event_id, JSON.parse(decision.anchor_json) as string[]);
    out.set(target, {
      status: decision.action === 'tombstone-card' ? 'superseded' : 'invalid',
      atMs: decision.at_ms,
    });
  }
  return out;
}

// ── 构建主流程 ────────────────────────────────────────────────────────────

/**
 * 离线构建记忆选择索引（方案 §4.6 / §5 流 1）。
 *
 * dryRun=true：影子落系统临时目录，真实根与 indexDir 零写入，revision=null。
 * dryRun=false：影子写 indexDir 内 tmp 文件 → fsync → rename → 追加 revisions。
 */
export async function buildMemoryIndex(options: BuildOptions): Promise<BuildReport> {
  const root = resolveDataRoot({ dataRoot: options.dataRoot });
  const layout = layoutOf(root);
  const indexDir = path.join(layout.projection, 'memory-index');
  const liveFile = path.join(indexDir, MEMORY_INDEX_FILE);
  const nowMs = options.nowMs ?? Date.now();

  if (
    options.sinceRevision !== undefined &&
    (!Number.isInteger(options.sinceRevision) || options.sinceRevision < 1)
  ) {
    throw new IntegrityError(`sinceRevision 必须是 >=1 的整数（收到 ${String(options.sinceRevision)}）`);
  }
  if (!fs.existsSync(layout.experiences)) {
    throw new NotFoundError(`数据根没有记录本目录：${layout.experiences}`);
  }

  // ── 1. 真值指纹（只读）──
  const fingerprint = computeTruthFingerprint(root);

  // ── 2. 读经历（只读）→ 全集 id（悬空锚点回查用）──
  const experienceIds = new Set<string>();
  for (const name of listFiles(layout.experiences, '.jsonl')) {
    for (const raw of readJsonlFile<unknown>(path.join(layout.experiences, name))) {
      const experience = parseExperience(raw, 'read');
      experienceIds.add(experience.id);
    }
  }

  // ── 3. 读事件（只读）→ 折叠复用 foldCurrentEvents → 只收 closed+ready ──
  const eventRows: EventRecord[] = [];
  for (const name of listFiles(layout.events, '.jsonl')) {
    for (const raw of readJsonlFile<unknown>(path.join(layout.events, name))) {
      eventRows.push(parseEvent(raw, 'read'));
    }
  }
  const readyEvents = foldCurrentEvents(eventRows).filter(
    (event) => event.status === 'closed' && event.summary_quality === 'ready',
  );

  // ── 4. 悬空锚点校验（发生在一切写入之前 —— 零产物，M1）──
  // 锚点必须是 26 位 ULID 且存在于真值经历全集；任一悬空即整份硬失败、零产物。
  const dangling = new Set<string>();
  for (const event of readyEvents) {
    for (const anchor of event.anchors) {
      if (!isUlid(anchor) || !experienceIds.has(anchor)) {
        dangling.add(anchor);
      }
    }
  }
  if (dangling.size > 0) {
    throw new MemoryAnchorDanglingError(
      `锚点解析不到真值经历（悬空 ${dangling.size} 个）：${[...dangling].join('、')}`,
    );
  }

  // ── 5. 旧库快照 + 决策回放 → 新卡集（内容全部搬运，不生成文本）──
  const decisions = readDecisions(indexDir);
  const existing = readExistingIndex(liveFile);
  const outcomes = replayDecisions(decisions);
  const oldCards = new Map(existing.cards.map((card) => [card.cardId, card]));

  const newCards: MemoryCard[] = [];
  for (const event of readyEvents) {
    const effectiveAnchors = [...new Set(event.anchors)].sort();
    const cardId = deriveCardId(event.id, effectiveAnchors);
    const old = oldCards.get(cardId);
    if (old === undefined) {
      // 零正文纪律：未种子事件不建卡（无人工线索，CHECK 也不允许空 cues）。
      continue;
    }
    const anchorJson = JSON.stringify(effectiveAnchors);
    const card: MemoryCard = {
      ...old,
      eventId: event.id,
      anchorJson,
      channel: event.channel,
      occurredMs: event.started_ms,
      endedMs: event.ended_ms,
      contentHash: computeContentHash(
        anchorJson,
        old.displayCuesJson,
        old.aliasesJson,
        old.discriminator,
      ),
      schemaVersion: MEMORY_SCHEMA_VERSION,
    };
    const outcome = outcomes.get(cardId);
    if (outcome !== undefined) {
      if (outcome.status === 'superseded') {
        card.status = 'superseded';
        card.expiredMs = outcome.atMs;
        card.invalidMs = outcome.atMs;
      } else {
        card.status = 'invalid';
        card.invalidMs = outcome.atMs;
      }
    }
    newCards.push(card);
  }

  const surviving = new Set(newCards.map((card) => card.cardId));
  const newAliases = existing.aliases.filter((alias) => surviving.has(alias.cardId));

  // ── 6. 影子 diff：与旧库全量行哈希比对（sinceRevision 只记 reason，不改口径）──
  const oldHashes = new Map(existing.cards.map((card) => [card.cardId, cardRowHash(card)]));
  const newHashes = new Map(newCards.map((card) => [card.cardId, cardRowHash(card)]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [cardId, hash] of newHashes) {
    const oldHash = oldHashes.get(cardId);
    if (oldHash === undefined) {
      added += 1;
    } else if (oldHash !== hash) {
      changed += 1;
    }
  }
  for (const cardId of oldHashes.keys()) {
    if (!newHashes.has(cardId)) {
      removed += 1;
    }
  }
  const shadowDiff = { added, removed, changed };

  // ── 7. 影子库（dryRun 落系统临时目录；apply 落 indexDir 内 tmp 文件）──
  const revisions = readRevisions(indexDir);
  const last = revisions[revisions.length - 1];
  const nextRevision = (last?.revision ?? 0) + 1;

  const dryRun = options.dryRun;
  const shadowDir = dryRun
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'memory-build-'))
    : indexDir;
  const shadowFile = dryRun
    ? path.join(shadowDir, MEMORY_INDEX_FILE)
    : path.join(indexDir, `${MEMORY_INDEX_FILE}.tmp-${ulid()}`);
  const removeShadow = (): void => {
    fs.rmSync(dryRun ? shadowDir : shadowFile, { recursive: true, force: true });
  };

  if (!dryRun) {
    ensureDir(indexDir);
  }

  const db = new DatabaseSync(shadowFile);
  try {
    db.exec('BEGIN');
    for (const statement of MEMORY_SCHEMA) {
      db.exec(statement);
    }
    writeCards(db, newCards);
    writeAliases(db, newAliases);
    syncFts(db, newCards.map((card) => card.cardId));
    copyRows(db, 'mem_miss', existing.misses);
    copyRows(db, 'mem_audit_run', existing.auditRuns);
    copyRows(db, 'mem_audit_item', existing.auditItems);
    stampMeta(db, {
      schema_version: MEMORY_SCHEMA_VERSION,
      stamped_revision: nextRevision,
      truth_fingerprint: fingerprint.aggregate,
    });
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.close();
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    removeShadow();
    throw error;
  }
  db.close();

  if (dryRun) {
    // 影子留给调用方检查（报告 outputDir 指向它）；真实 indexDir 零触碰。
    return {
      revision: null,
      fingerprint,
      shadowDiff,
      cards: newCards.length,
      aliases: newAliases.length,
      misses: existing.misses.length,
      danglingAnchors: [],
      outputDir: shadowDir,
    };
  }

  // ── 8. apply：fsync → rename 原子换文件 → 追加账本（M8：中途失败旧库完好）──
  try {
    const fd = fs.openSync(shadowFile, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(shadowFile, liveFile);
  } catch (error) {
    fs.rmSync(shadowFile, { force: true });
    throw error;
  }

  const revisionRecord: RevisionRecord = {
    revision: nextRevision,
    slug: existing.exists ? 'rebuild' : 'build',
    at_ms: nowMs,
    schema_version: MEMORY_SCHEMA_VERSION,
    truth_fingerprint: fingerprint.aggregate,
    prior_revision: last?.revision ?? null,
    card_count: newCards.filter((card) => card.status === 'active').length,
    alias_count: newAliases.length,
    row_hash_sum: computeRowHashSum(newCards),
    shadow_diff: shadowDiff,
    reason: `cli --apply${options.sinceRevision !== undefined ? ` --since-revision ${options.sinceRevision}` : ''}`,
    operator: 'offline-cli',
  };
  appendRevision(indexDir, revisionRecord);

  return {
    revision: nextRevision,
    fingerprint,
    shadowDiff,
    cards: newCards.length,
    aliases: newAliases.length,
    misses: existing.misses.length,
    danglingAnchors: [],
    outputDir: indexDir,
  };
}