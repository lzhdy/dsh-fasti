/**
 * v3 真根空模型正式冻结表离线构建壳（W4 前置，218 蓝图 §7）。
 *
 * 定位：在索引构建期把 W3-2a/W3-2c 两个纯函数建表器跑在真实 v3 根上，产出随根冻结的
 * 五档 k_min 表（bMin=0..4，212 探针钉死的合法域；6/7 退化禁用）与一张 G/G_gap 几何表，
 * 外加内容哈希 manifest。**只读打开索引库、不写根、不接任何生产门**；门内未来只经 lookup
 * 读整数，本表本身不改变 CURRENT_RULES_VERSION（仍 rules-v1）。
 *
 * 字段文档口径（与门侧 lexicalFields 严格同组成，见 bm25.ts:361-377）：
 *  - mem_card.active 的 display_cues_json（原文字符串数组，建表器内部统一规范化）；
 *  - mem_alias 表 status='active' AND sensitive=0 的 term_norm（按 rowid 保序）；
 *  - 不读卡内 aliases_json 快照（对象形态、且门的召回侧实际以 mem_alias 行为准）。
 *
 * 可重放纪律：manifest 与各表不含墙钟/随机种子，同根同参数产物逐字节一致，差异只能来自
 * 根内容或显式网格参数。网格缺省值 maxQueryBigrams=32、maxQueryCodeLength=33 与 212/213
 * 仓外探针逐字对齐（码点＝bigram+1）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/p6/build-null-model-v3.ts \
 *     --index <v3-root>/projection/memory-index/memory-index.sqlite \
 *     --out <v3-root>/projection/null-model \
 *     [--max-query-bigrams 32] [--max-query-code-length 33]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import {
  buildKMinTable,
  buildRaritySnapshot,
  collectBigramStats,
  type FrozenKMinTable,
  type FrozenRaritySnapshot,
} from '../../src/memory/bigram-null-model.ts';
import {
  buildLocalityGeometryTable,
  type FrozenLocalityGeometryTable,
} from '../../src/memory/locality-null-model.ts';

/** 212 探针钉死的 k_min 合法标定域（B_min=6/7 已证退化禁用）。 */
export const KMIN_B_MIN_VALUES = [0, 1, 2, 3, 4] as const;
/** 212 仓外探针网格上界（查询 bigram 单元数）。 */
export const DEFAULT_MAX_QUERY_BIGRAMS = 32;
/** 213 仓外探针网格上界（查询码点数＝bigram 槽+1）。 */
export const DEFAULT_MAX_QUERY_CODE_LENGTH = 33;

export const MANIFEST_SCHEMA = 'fasti-null-model-manifest/v1';
export const MANIFEST_FILE_NAME = 'null-model-manifest.json';
export const GEOMETRY_FILE_NAME = 'locality-geometry.json';
/** #227 接线弥合：门内 rareCount 所需的 bigram→稀有桶号映射（与 bMin 无关，全根一件）。 */
export const RARITY_FILE_NAME = 'rarity-buckets.json';

export function kminFileName(bMin: number): string {
  return `kmin-b${bMin}.json`;
}

/** mem_card 侧最小行形状（只取构建需要的列）。 */
export interface CardFieldRow {
  readonly cardId: string;
  readonly displayCuesJson: string;
}

/** mem_alias 侧最小行形状（调用方 SQL 已过滤 active/非敏感，函数内再校验双保险）。 */
export interface AliasFieldRow {
  readonly cardId: string;
  readonly termNorm: string;
  readonly status: string;
  readonly sensitive: number;
}

/**
 * 纯装配：按卡行序（SQL ORDER BY rowid）逐卡挂 cue，再挂该卡 active/非敏感别名。
 * 输出顺序确定，与召回侧 selectAliasesByCardIds 的 rowid 序同构。
 */
export function assembleFieldDocuments(
  cardRows: readonly CardFieldRow[],
  aliasRows: readonly AliasFieldRow[],
): string[] {
  const aliasByCard = new Map<string, string[]>();
  for (const row of aliasRows) {
    if (row.status !== 'active' || row.sensitive !== 0) continue;
    const list = aliasByCard.get(row.cardId);
    if (list === undefined) aliasByCard.set(row.cardId, [row.termNorm]);
    else list.push(row.termNorm);
  }

  const fieldDocuments: string[] = [];
  for (const card of cardRows) {
    const cues = JSON.parse(card.displayCuesJson) as unknown;
    if (!Array.isArray(cues)) throw new Error(`卡 ${card.cardId} display_cues_json 不是数组`);
    for (const cue of cues) fieldDocuments.push(String(cue));
    for (const alias of aliasByCard.get(card.cardId) ?? []) fieldDocuments.push(alias);
  }
  return fieldDocuments;
}

export interface NullModelStats {
  readonly fieldDocumentCount: number;
  readonly totalBigramTokens: number;
  readonly distinctBigramCount: number;
}

export interface NullModelArtifacts {
  readonly kmin: ReadonlyArray<{ readonly bMin: number; readonly table: FrozenKMinTable }>;
  readonly geometry: FrozenLocalityGeometryTable;
  readonly rarity: FrozenRaritySnapshot;
  readonly stats: NullModelStats;
}

export interface BuildArtifactsInput {
  readonly fieldDocuments: readonly string[];
  /** Bonferroni 分母 N＝active 卡数（实测，不由调用方估计）。 */
  readonly cardCount: number;
  readonly maxQueryBigrams: number;
  readonly maxQueryCodeLength: number;
  readonly bMinValues: readonly number[];
}

/** 纯构建：产五档 k_min＋几何表与语料统计，不做任何 I/O。 */
export function buildNullModelArtifacts(input: BuildArtifactsInput): NullModelArtifacts {
  const { fieldDocuments, cardCount, maxQueryBigrams, maxQueryCodeLength, bMinValues } = input;
  if (fieldDocuments.length === 0) throw new Error('字段文档为空：无法在空语料上冻结空模型');
  if (cardCount <= 0) throw new Error('active 卡数 N 必须为正');
  if (bMinValues.length === 0) throw new Error('bMin 档位列表不能为空');
  if (maxQueryBigrams <= 0 || maxQueryCodeLength < 2) throw new Error('网格上界非法');
  if (maxQueryCodeLength !== maxQueryBigrams + 1) {
    throw new Error('网格不自洽：maxQueryCodeLength 必须等于 maxQueryBigrams+1');
  }

  const statsRaw = collectBigramStats(fieldDocuments);
  const kmin = bMinValues.map((bMin) => ({
    bMin,
    table: buildKMinTable({ fieldDocuments, cardCount, bMin, maxQueryBigrams }),
  }));
  const geometry = buildLocalityGeometryTable({ fieldDocuments, cardCount, maxQueryCodeLength });
  const rarity = buildRaritySnapshot(fieldDocuments);

  return {
    kmin,
    geometry,
    rarity,
    stats: {
      fieldDocumentCount: fieldDocuments.length,
      totalBigramTokens: statsRaw.totalBigramTokens,
      distinctBigramCount: statsRaw.documentFrequency.size,
    },
  };
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface ManifestArtifactEntry {
  readonly file: string;
  readonly schema: string;
  readonly sha256: string;
}

export interface NullModelManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly indexHint: string;
  readonly activeCardCount: number;
  readonly stats: NullModelStats;
  readonly maxQueryBigrams: number;
  readonly maxQueryCodeLength: number;
  readonly bMinValues: readonly number[];
  readonly artifacts: readonly ManifestArtifactEntry[];
}

/** 纯 manifest 组装：哈希只对 artifact 序列化正文负责，无墙钟无随机。 */
export function buildNullModelManifest(input: {
  readonly meta: {
    readonly indexHint: string;
    readonly activeCardCount: number;
    readonly stats: NullModelStats;
    readonly maxQueryBigrams: number;
    readonly maxQueryCodeLength: number;
    readonly bMinValues: readonly number[];
  };
  readonly entries: ReadonlyArray<{ readonly file: string; readonly schema: string; readonly body: string }>;
}): NullModelManifest {
  return {
    schema: MANIFEST_SCHEMA,
    indexHint: input.meta.indexHint,
    activeCardCount: input.meta.activeCardCount,
    stats: input.meta.stats,
    maxQueryBigrams: input.meta.maxQueryBigrams,
    maxQueryCodeLength: input.meta.maxQueryCodeLength,
    bMinValues: [...input.meta.bMinValues],
    artifacts: input.entries.map((entry) => ({
      file: entry.file,
      schema: entry.schema,
      sha256: sha256Hex(entry.body),
    })),
  };
}

export interface BuildCliArgs {
  readonly index: string | undefined;
  readonly out: string | undefined;
  readonly maxQueryBigrams: number;
  readonly maxQueryCodeLength: number;
  readonly bMinValues: readonly number[];
}

export function parseBuildArgs(argv: readonly string[]): BuildCliArgs {
  const mutable: {
    index: string | undefined;
    out: string | undefined;
    maxQueryBigrams: number;
    maxQueryCodeLength: number;
    bMinValues: readonly number[];
  } = {
    index: undefined,
    out: undefined,
    maxQueryBigrams: DEFAULT_MAX_QUERY_BIGRAMS,
    maxQueryCodeLength: DEFAULT_MAX_QUERY_CODE_LENGTH,
    bMinValues: KMIN_B_MIN_VALUES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`参数 ${flag} 缺少取值`);
    i += 1;
    if (flag === '--index') mutable.index = value;
    else if (flag === '--out') mutable.out = value;
    else if (flag === '--max-query-bigrams') mutable.maxQueryBigrams = Number(value);
    else if (flag === '--max-query-code-length') mutable.maxQueryCodeLength = Number(value);
    else throw new Error(`未知参数 ${flag}`);
  }
  return mutable;
}

/** 只读读根并装配字段文档（I/O 壳，纯口径在 assembleFieldDocuments）。 */
function readFieldDocuments(db: DatabaseSync): {
  readonly cardRows: CardFieldRow[];
  readonly aliasRows: AliasFieldRow[];
} {
  const cardRows = db
    .prepare("SELECT card_id, display_cues_json FROM mem_card WHERE status = 'active' ORDER BY rowid")
    .all() as Array<{ card_id: string; display_cues_json: string }>;
  const aliasRows = db
    .prepare(
      "SELECT card_id, term_norm, status, sensitive FROM mem_alias" +
        " WHERE status = 'active' AND sensitive = 0 ORDER BY rowid",
    )
    .all() as Array<{ card_id: string; term_norm: string; status: string; sensitive: number }>;
  return {
    cardRows: cardRows.map((row) => ({ cardId: row.card_id, displayCuesJson: row.display_cues_json })),
    aliasRows: aliasRows.map((row) => ({
      cardId: row.card_id,
      termNorm: row.term_norm,
      status: row.status,
      sensitive: row.sensitive,
    })),
  };
}

export async function main(): Promise<void> {
  const args = parseBuildArgs(process.argv.slice(2));
  if (!args.index || !args.out) {
    process.stderr.write(
      '用法：build-null-model-v3.ts --index <memory-index.sqlite> --out <null-model 目录>' +
        ' [--max-query-bigrams 32] [--max-query-code-length 33]\n',
    );
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(args.index)) throw new Error(`索引库不存在：${args.index}`);

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(args.index, { readOnly: true });
  let fieldDocuments: string[];
  let activeCardCount: number;
  try {
    const { cardRows, aliasRows } = readFieldDocuments(db);
    activeCardCount = cardRows.length;
    fieldDocuments = assembleFieldDocuments(cardRows, aliasRows);
  } finally {
    db.close();
  }

  const built = buildNullModelArtifacts({
    fieldDocuments,
    cardCount: activeCardCount,
    maxQueryBigrams: args.maxQueryBigrams,
    maxQueryCodeLength: args.maxQueryCodeLength,
    bMinValues: args.bMinValues,
  });

  const serializedEntries = [
    ...built.kmin.map((entry) => ({
      file: kminFileName(entry.bMin),
      schema: entry.table.schema,
      body: JSON.stringify(entry.table),
    })),
    {
      file: GEOMETRY_FILE_NAME,
      schema: built.geometry.schema,
      body: JSON.stringify(built.geometry),
    },
    {
      file: RARITY_FILE_NAME,
      schema: built.rarity.schema,
      body: JSON.stringify(built.rarity),
    },
  ];

  const manifest = buildNullModelManifest({
    meta: {
      indexHint: args.index,
      activeCardCount,
      stats: built.stats,
      maxQueryBigrams: args.maxQueryBigrams,
      maxQueryCodeLength: args.maxQueryCodeLength,
      bMinValues: args.bMinValues,
    },
    entries: serializedEntries,
  });

  fs.mkdirSync(args.out, { recursive: true });
  for (const entry of serializedEntries) {
    fs.writeFileSync(path.join(args.out, entry.file), `${entry.body}\n`);
  }
  fs.writeFileSync(path.join(args.out, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `空模型冻结表已落盘：${args.out}\n` +
      ` active 卡=${activeCardCount} 字段文档=${built.stats.fieldDocumentCount}` +
      ` distinct bigram=${built.stats.distinctBigramCount}\n` +
      ` k_min 档=${args.bMinValues.join(',')} 几何网格格数=${built.geometry.grid.length}` +
      ` 稀有桶条目=${built.rarity.entries.length}\n` +
      ` manifest=${MANIFEST_FILE_NAME}（哈希登记 ${serializedEntries.length} 张表，manifest 自身不入哈希）\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
