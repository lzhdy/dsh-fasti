/**
 * ORD-α 整数定点 IDF 冻结快照与加权和（215 §3.1；198 §6 实测公式
 * `idf(g)=floor(Q·ln(N/(df(g)+1)))`，Q=1000）。
 *
 * 定位：索引构建期离线把全库 bigram 的逆文档频率冻结成纯整数快照，未来经预注册 §9 授权
 * 后才可替换门内证据 sum 排序位；本模块默认不接线（TI-9 静态守卫），不持库柄、不读时钟、
 * 不引随机。
 *
 * 口径钉版（215 未细钉之处，按数学自洽补完并在 TI-1/TI-2 锁红）：
 *  - df(g) 是**字段文档**粒度（collectBigramStats 同款），故 N 取字段文档总数而非卡数；
 *    否则 df 可能大于 N 产生无界负值，破坏排序语义；
 *  - 忠实裸 floor 公式不夹 0：全覆盖 bigram 的 idf 可为负（经典 BM25 IDF 已知特性），
 *    行为由 TI-2 钉死，未来要夹 0 属调参变更须另走 §9；
 *  - 查询侧 bigram 去重后各计一次（与 rareBigramHitCount 的 querySet 口径一致）；
 *  - 未登录单元不臆造权重：查询级留痕 unknownUnits，字段级天然不可能命中。
 *
 * 浮点纪律：自然对数运算全模块仅 buildTermIdfTable 内代码一处（离线建表），查询热路径
 * （lookup/query/field 权重）只有整数查表与加乘，逐题可手算复现。
 *
 * 无环纪律：仅依赖 bigram.ts 与 bigram-null-model.ts（collectBigramStats，同为 leaf），
 * 不 import gate/rank/bm25/store。
 */

import { emitUnits, normalizeBigramText } from './bigram.ts';
import { collectBigramStats } from './bigram-null-model.ts';

export const TERM_IDF_SCHEMA = 'fasti-term-idf/v1';
/** 定点放大倍数 Q（198 实测口径），建表与热路径共用冻结常量。 */
export const IDF_FIXED_POINT_Q = 1000;

export interface TermIdfWeightEntry {
  readonly gram: string;
  readonly idf: number;
}

/** 随索引版本冻结的整数 IDF 快照（可整体 JSON 封存，weights 按 gram 字典序保确定性）。 */
export interface FrozenTermIdfTable {
  readonly schema: typeof TERM_IDF_SCHEMA;
  /** IDF 分母 N＝参与统计的字段文档总数（与 df 文档粒度自洽）。 */
  readonly fieldDocumentCount: number;
  readonly fixedPointQ: number;
  readonly weights: readonly TermIdfWeightEntry[];
}

export interface BuildTermIdfInput {
  readonly fieldDocuments: readonly string[];
}

/**
 * 离线构建整数 IDF 冻结表。同一语料逐字节可重放（无随机、无时钟输入）。
 * 自然对数浮点运算仅此函数内代码一处，不出本构建边界。
 */
export function buildTermIdfTable(input: BuildTermIdfInput): FrozenTermIdfTable {
  const { fieldDocuments } = input;
  const n = fieldDocuments.length;
  if (n <= 0) throw new Error('IDF 冻结表要求非空字段文档语料（N 必须为正）');

  const stats = collectBigramStats(fieldDocuments);
  const weights: TermIdfWeightEntry[] = [];
  for (const [gram, df] of stats.documentFrequency) {
    const idf = Math.floor(IDF_FIXED_POINT_Q * Math.log(n / (df + 1)));
    weights.push({ gram, idf });
  }
  weights.sort((a, b) => (a.gram < b.gram ? -1 : a.gram > b.gram ? 1 : 0));

  return {
    schema: TERM_IDF_SCHEMA,
    fieldDocumentCount: n,
    fixedPointQ: IDF_FIXED_POINT_Q,
    weights,
  };
}

/** 快照形状校验：任何 schema 不符/形状损坏的表一律 fail-loud。 */
function assertTable(table: FrozenTermIdfTable): void {
  if (table.schema !== TERM_IDF_SCHEMA) {
    throw new Error(`非法 IDF 快照 schema：${String(table.schema)}`);
  }
  if (table.fieldDocumentCount <= 0 || table.fixedPointQ !== IDF_FIXED_POINT_Q) {
    throw new Error('IDF 快照参数损坏：N 非正或定点倍数与冻结常量不符');
  }
}

/**
 * 门内只读查表：返回冻结整数 idf（可为负）；未登录 bigram 返回 null，
 * 由调用方显式登记，绝不返回臆造的最大权重或数字哨兵。
 */
export function lookupTermIdf(table: FrozenTermIdfTable, gram: string): number | null {
  assertTable(table);
  const entry = table.weights.find((candidate) => candidate.gram === gram);
  return entry === undefined ? null : entry.idf;
}

export interface TermIdfQueryWeight {
  /** 去重后命中冻结表的查询单元整数 idf 之和。 */
  readonly sum: number;
  readonly matchedUnits: readonly TermIdfWeightEntry[];
  /** 全库未登录的查询单元（不计权、不臆造），保查询去重后出现序。 */
  readonly unknownUnits: readonly string[];
}

/** 查询级整数加权和（热路径：无浮点、无时钟、无随机）。 */
export function termIdfQueryWeight(queryText: string, table: FrozenTermIdfTable): TermIdfQueryWeight {
  assertTable(table);
  const queryUnits = [...new Set(emitUnits(normalizeBigramText(queryText)))];
  const matchedUnits: TermIdfWeightEntry[] = [];
  const unknownUnits: string[] = [];
  let sum = 0;
  for (const gram of queryUnits) {
    const idf = lookupTermIdf(table, gram);
    if (idf === null) {
      unknownUnits.push(gram);
    } else {
      matchedUnits.push({ gram, idf });
      sum += idf;
    }
  }
  return { sum, matchedUnits, unknownUnits };
}

export interface TermIdfFieldWeight {
  readonly fieldIndex: number;
  /** 查询与该字段共有 bigram 的整数 idf 之和（字段内 bigram 去重）。 */
  readonly sum: number;
  readonly matchedUnits: readonly TermIdfWeightEntry[];
}

export interface TermIdfFieldWeights {
  /** 各字段独立计权，保输入字段序。 */
  readonly perField: readonly TermIdfFieldWeight[];
  /** 各字段 sum 之总和（同一 bigram 命中多字段重复累计，与证据 sum 字段独立口径同构）。 */
  readonly totalSum: number;
}

/** 卡级逐字段整数加权和（热路径：无浮点、无时钟、无随机）。 */
export function termIdfFieldWeights(
  queryText: string,
  lexicalFields: readonly string[],
  table: FrozenTermIdfTable,
): TermIdfFieldWeights {
  assertTable(table);
  const queryUnitSet = new Set(emitUnits(normalizeBigramText(queryText)));
  const perField: TermIdfFieldWeight[] = [];
  let totalSum = 0;

  lexicalFields.forEach((fieldText, fieldIndex) => {
    const fieldUnits = [...new Set(emitUnits(normalizeBigramText(fieldText)))];
    const matchedUnits: TermIdfWeightEntry[] = [];
    let sum = 0;
    for (const gram of fieldUnits) {
      if (!queryUnitSet.has(gram)) continue;
      // 字段含有的 bigram 必在全库快照中（表由同一全库语料构建）；缺失即快照与卡面不同源，fail-loud。
      const idf = lookupTermIdf(table, gram);
      if (idf === null) throw new Error(`字段单元 ${gram} 不在 IDF 冻结快照中：表与卡面不同源`);
      matchedUnits.push({ gram, idf });
      sum += idf;
    }
    perField.push({ fieldIndex, sum, matchedUnits });
    totalSum += sum;
  });

  return { perField, totalSum };
}
