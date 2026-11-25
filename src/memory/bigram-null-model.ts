/**
 * W3-2a 随机查询空模型 k_min 冻结表生成器（纯函数，默认不接生产门）。
 *
 * 设计出处：外审丙 A1 C6（门算法v2_外部盲评回复 §自适应门槛/冻结表）。
 *
 * 合规边界（立项书 200 §9 与 A1 C2/C3/C6）：
 *  - 本模块只在**索引构建期**被离线调用，产物是随索引版本冻结的纯整数表；
 *  - 概率浮点封闭在本文件内，门内未来只经 lookupKMin 读整数，运行时零概率、零随机、无时钟；
 *  - 全程无 Math.random：统计量来自字段文本本身，结果对同一语料逐字节可重放；
 *  - 不读终考卷、不被 gate.ts/locality.ts import（task215 NM-8 静态钉死）。
 *
 * 安全侧近似（必须读懂再改）：A1 的 rarecount 数的是「字段稀有 bigram 被查询命中的不同
 * 种类数」。精确种类占用分布推导繁琐；这里改数命中**次数** X~Binomial(qLen, p_f)，其中
 * p_f 是一次随机查询 token 落在该字段稀有集合内的边缘概率（集合内互斥事件求和）。
 * 种类数恒 ≤ 命中次数，故 P(种类数≥k) ≤ P(X≥k)；用 P(X≥k)≤1/N 定出的 k 只会更难放行，
 * 偏向 wc=0 的安全侧。未来若 wa 损失需要放松到精确占用模型，属判据变更，另走预注册 §9。
 */

import { emitUnits, normalizeBigramText } from './bigram.ts';

export const NULL_MODEL_SCHEMA = 'fasti-null-model-kmin/v1';
/** A1 C6 冻结的稀有度桶数 K=8。 */
export const RARITY_BUCKET_COUNT = 8;

export interface BigramCorpusStats {
  /** 全库 bigram token 出现总次数（含同一字段内重复），多项分布归一化分母 M。 */
  readonly totalBigramTokens: number;
  /** bigram → 总出现次数。 */
  readonly tokenFrequency: ReadonlyMap<string, number>;
  /** bigram → 含该 bigram 的字段文档数 df(g)。 */
  readonly documentFrequency: ReadonlyMap<string, number>;
  /** 每个字段去重后的 bigram 集合（与 df 文档粒度一致）。 */
  readonly fieldBigramSets: readonly ReadonlySet<string>[];
}

/** 扫描全库字段文本，复用 emitUnits 同规约统计词频/文档频率，纯确定性。 */
export function collectBigramStats(fieldDocuments: readonly string[]): BigramCorpusStats {
  const tokenFrequency = new Map<string, number>();
  const documentFrequency = new Map<string, number>();
  const fieldBigramSets: ReadonlySet<string>[] = [];
  let totalBigramTokens = 0;

  for (const doc of fieldDocuments) {
    const units = emitUnits(normalizeBigramText(doc));
    const uniq = new Set(units);
    fieldBigramSets.push(uniq);
    for (const unit of units) {
      totalBigramTokens += 1;
      tokenFrequency.set(unit, (tokenFrequency.get(unit) ?? 0) + 1);
    }
    for (const unit of uniq) {
      documentFrequency.set(unit, (documentFrequency.get(unit) ?? 0) + 1);
    }
  }
  return { totalBigramTokens, tokenFrequency, documentFrequency, fieldBigramSets };
}

export interface RarityBuckets {
  /** K-1 个整数分界 df 值（允许重复，反映稀疏语料下的桶退化）。 */
  readonly cutpoints: readonly number[];
  /** bigram → 稀有度桶 0（最高频）..K-1（最稀有）。 */
  readonly bucketOf: ReadonlyMap<string, number>;
}

/**
 * 按 df 经验分布的 nearest-rank 把 bigram 划入 K 个稀有度桶。
 * df 越小桶号越大（越稀有）；相同 df 必同桶；纯整数边界、无随机、可重放。
 * 不强制每桶非空：df 取值少于 K 时桶退化是真实稀疏性的如实反映（A1 偏差风险明示）。
 */
export function buildRarityBuckets(documentFrequency: ReadonlyMap<string, number>): RarityBuckets {
  const distinctDf = [...new Set(documentFrequency.values())].sort((a, b) => a - b);
  const u = distinctDf.length;
  const bucketByDf = new Map<number, number>();
  distinctDf.forEach((dfValue, i) => {
    // i=0（最小 df）→ K-1；i 越大越高频，桶号单调下降到 0。
    const bucket = RARITY_BUCKET_COUNT - 1 - Math.floor((i / Math.max(u, 1)) * RARITY_BUCKET_COUNT);
    bucketByDf.set(dfValue, Math.min(RARITY_BUCKET_COUNT - 1, Math.max(0, bucket)));
  });

  const bucketOf = new Map<string, number>();
  for (const [gram, dfValue] of documentFrequency) {
    bucketOf.set(gram, bucketByDf.get(dfValue)!);
  }

  // 相邻桶分界：取落入更高桶号（更稀有）一侧的最大 df。
  const cutpoints: number[] = [];
  for (let b = 1; b < RARITY_BUCKET_COUNT; b += 1) {
    const inRarerBucket = distinctDf.filter((dfValue) => bucketByDf.get(dfValue)! === b);
    cutpoints.push(inRarerBucket.length > 0 ? Math.max(...inRarerBucket) : (cutpoints[b - 2] ?? 0));
  }
  return { cutpoints, bucketOf };
}

/**
 * rarecount(f,q)：字段集合与查询共有、且稀有度桶 ≥ bMin 的 bigram **种类数**。
 * fieldTexts 为该卡参与词面统计的字段，queryText 为查询原文（内部统一 emitUnits）。
 */
export function rareBigramHitCount(
  queryText: string,
  fieldTexts: readonly string[],
  bucketOf: ReadonlyMap<string, number>,
  bMin: number,
): number {
  const fieldSet = new Set<string>();
  for (const f of fieldTexts) for (const u of new Set(emitUnits(normalizeBigramText(f)))) fieldSet.add(u);
  const querySet = new Set(emitUnits(normalizeBigramText(queryText)));
  let hits = 0;
  for (const gram of querySet) {
    if (fieldSet.has(gram) && (bucketOf.get(gram) ?? -1) >= bMin) hits += 1;
  }
  return hits;
}

/** 建表期专用：log 二项系数，避免大 n 下组合数溢出；浮点不出本文件。 */
function logBinomialCoefficient(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i += 1) s += Math.log((n - k + i) / i);
  return s;
}

/** 建表期专用：二项上尾 P(X≥k)，X~Binomial(n,p)，log 空间求和。 */
function binomialTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  let tail = 0;
  for (let j = k; j <= n; j += 1) {
    tail += Math.exp(logBinomialCoefficient(n, j) + j * logP + (n - j) * logQ);
  }
  return tail;
}

export interface KMinGridCell {
  /** 字段去重 bigram 种类数。 */
  readonly m: number;
  /** 查询 bigram 单元数。 */
  readonly qLen: number;
  /** 满足单字段假阳性 ≤1/N 的最小稀有命中数；kMin>m 表示该格空模型不足以授权（fail-closed）。 */
  readonly kMin: number;
}

export interface FrozenKMinTable {
  readonly schema: typeof NULL_MODEL_SCHEMA;
  readonly cardCount: number;
  readonly rarityBuckets: number;
  readonly bMin: number;
  readonly dfCutpoints: readonly number[];
  readonly grid: readonly KMinGridCell[];
}

export interface BuildKMinInput {
  readonly fieldDocuments: readonly string[];
  /** Bonferroni 全库卡数 N：单字段假阳性上界取 1/N。 */
  readonly cardCount: number;
  /** 稀有桶下界冻结常量 B_min。 */
  readonly bMin: number;
  readonly maxQueryBigrams: number;
}

/**
 * 离线构建 k_min 整数冻结表。
 * 同一 m 的字段取其中最不利（稀有集合单次命中概率 p 最大）者定档，保证全库任一同 m 字段
 * 都满足 Bonferroni 上界；网格按 (m,qLen) 确定性排序，输出可整体 JSON 封存。
 */
export function buildKMinTable(input: BuildKMinInput): FrozenKMinTable {
  const { fieldDocuments, cardCount, bMin, maxQueryBigrams } = input;
  if (cardCount <= 0) throw new Error('空模型卡数 N 必须为正');
  if (maxQueryBigrams <= 0) throw new Error('查询 bigram 上界必须为正');

  const stats = collectBigramStats(fieldDocuments);
  const rarity = buildRarityBuckets(stats.documentFrequency);
  if (stats.totalBigramTokens === 0) {
    return {
      schema: NULL_MODEL_SCHEMA,
      cardCount,
      rarityBuckets: RARITY_BUCKET_COUNT,
      bMin,
      dfCutpoints: rarity.cutpoints,
      grid: [],
    };
  }

  // 按字段 bigram 种类数 m 聚合最不利单次命中概率 pMax(m)。
  const pMaxByM = new Map<number, number>();
  stats.fieldBigramSets.forEach((unitSet) => {
    const m = unitSet.size;
    let pField = 0;
    for (const gram of unitSet) {
      if ((rarity.bucketOf.get(gram) ?? -1) >= bMin) {
        pField += (stats.tokenFrequency.get(gram) ?? 0) / stats.totalBigramTokens;
      }
    }
    const prev = pMaxByM.get(m) ?? 0;
    if (pField > prev) pMaxByM.set(m, pField);
  });

  const alpha = 1 / cardCount;
  const grid: KMinGridCell[] = [];
  const ms = [...pMaxByM.keys()].sort((a, b) => a - b);
  for (const m of ms) {
    const p = pMaxByM.get(m)!;
    for (let qLen = 1; qLen <= maxQueryBigrams; qLen += 1) {
      // 最小 k∈1..qLen 使二项上尾 ≤ α；找不到则记 qLen+1，调用方据此 fail-closed。
      let kMin = qLen + 1;
      for (let k = 1; k <= qLen; k += 1) {
        if (binomialTail(qLen, k, p) <= alpha) {
          kMin = k;
          break;
        }
      }
      grid.push({ m, qLen, kMin });
    }
  }

  return {
    schema: NULL_MODEL_SCHEMA,
    cardCount,
    rarityBuckets: RARITY_BUCKET_COUNT,
    bMin,
    dfCutpoints: rarity.cutpoints,
    grid,
  };
}

/**
 * 门内只读查表：命中返回冻结 kMin；未建模格（含越界 qLen、未知 m）返回 m+1 拒识哨兵，
 * 绝不返回 0 等宽松值。kMin>m 同样表示该格不能凭空模型放行，由未来接线方判 fail-closed。
 */
export function lookupKMin(table: FrozenKMinTable, m: number, qLen: number): number {
  const cell = table.grid.find((c) => c.m === m && c.qLen === qLen);
  return cell === undefined ? m + 1 : cell.kMin;
}

/**
 * W3-2a 配套冻结件（#227 接线弥合）：bigram→稀有桶号快照。
 * FrozenKMinTable 只冻结 dfCutpoints，而门热路径的 rareBigramHitCount 需要逐 bigram 桶号；
 * 门是不持库纯函数、无法现场重算 df，故桶映射作为随根独立快照注入（与 bMin 档位无关，全根一件）。
 *  entries 按 gram 字典序排列，保证 JSON 逐字节可重放；门内消费只经 rarityBucketMapOf 读整数。
 */
export const RARITY_SNAPSHOT_SCHEMA = 'fasti-null-model-rarity/v1';

export interface FrozenRarityEntry {
  readonly gram: string;
  readonly bucket: number;
}

export interface FrozenRaritySnapshot {
  readonly schema: typeof RARITY_SNAPSHOT_SCHEMA;
  readonly rarityBuckets: number;
  readonly dfCutpoints: readonly number[];
  readonly entries: readonly FrozenRarityEntry[];
}

function assertRaritySnapshot(table: FrozenRaritySnapshot): void {
  if (table.schema !== RARITY_SNAPSHOT_SCHEMA) throw new Error(`非法稀有桶快照 schema：${table.schema}`);
  if (table.rarityBuckets !== RARITY_BUCKET_COUNT) throw new Error('稀有桶快照桶数与建表器不一致，拒绝读取');
  if (table.dfCutpoints.length !== RARITY_BUCKET_COUNT - 1) throw new Error('稀有桶快照 cutpoints 形状非法');
}

/** 离线构建稀有桶快照：纯确定性，同语料逐字节一致。 */
export function buildRaritySnapshot(fieldDocuments: readonly string[]): FrozenRaritySnapshot {
  if (fieldDocuments.length === 0) throw new Error('字段文档为空：无法在空语料上冻结稀有桶快照');
  const stats = collectBigramStats(fieldDocuments);
  const rarity = buildRarityBuckets(stats.documentFrequency);
  const entries = [...rarity.bucketOf.entries()]
    .map(([gram, bucket]) => ({ gram, bucket }))
    .sort((a, b) => (a.gram < b.gram ? -1 : a.gram > b.gram ? 1 : 0));
  return {
    schema: RARITY_SNAPSHOT_SCHEMA,
    rarityBuckets: RARITY_BUCKET_COUNT,
    dfCutpoints: [...rarity.cutpoints],
    entries,
  };
}

/** 门内只读：把冻结快照还原为 rareBigramHitCount 同构的桶号映射；未登录 gram 不在 Map 中。 */
export function rarityBucketMapOf(snapshot: FrozenRaritySnapshot): ReadonlyMap<string, number> {
  assertRaritySnapshot(snapshot);
  const map = new Map<string, number>();
  for (const entry of snapshot.entries) map.set(entry.gram, entry.bucket);
  return map;
}
