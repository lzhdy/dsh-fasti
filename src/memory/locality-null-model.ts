/**
 * W3-2c 局部聚集度几何空模型（A1 的 G / G_gap）冻结表生成器（纯函数，默认不接生产门）。
 *
 * 设计出处：外审丙 A1（门算法v2_外部盲评回复 §8A）：
 *  - L2 span ≤ |f| + G(|f|,|q|)（434 行）；L3 gap ≤ G_gap(|f|)（435 行，只依赖字段长）；
 *  - 448 行 C6：k_min/G/G_gap 同由「随机查询空模型」在索引构建期冻结，门内只读整数、不算概率。
 *
 * 与 W3-2a（bigram-null-model.ts）的职责切分：
 *  - k_min 管 L1「要命中几个」（命中计数二项尾）；本模块管 L2/L3「命中在查询位置上摆得多紧」，
 *    按**满命中**（字段 n-1 个 bigram 全部命中）偶然形成紧凑簇的概率冻结几何容忍量；
 *    少命中能否凑数仍由 k_min 拦，本表不重复发明计数门。
 *
 * 安全侧近似（读懂再改，放松须走预注册 §9）：
 *  1. 把查询的 L=|q|-1 个 bigram 槽位视为独立 Bernoulli(p)，忽略字段 bigram 的有序/互异约束，
 *     只会高估「任意紧凑成功簇」概率，偏向 wc=0；p 取同字段长档下最不利边缘概率 pMax(n)。
 *  2. 紧凑簇用「首末成功 + 相邻间隙≤g」的窗口刻画，窗口并集概率用 Bonferroni 上界
 *     （允许同一簇被多窗口重复计数 → 只高估不低估）。
 *  3. 全程精确整数组合计数 + log 空间幂，不调用任何随机数发生器、无蒙特卡洛，对同一语料逐字节可重放；
 *     概率浮点封闭在本文件，FrozenLocalityGeometryTable 的 grid 全为整数。
 *
 * 合规边界：本模块只在索引构建期离线调用，不读终考卷，不被 gate.ts/locality.ts import
 * （task217 LNM-9 静态钉死）；生产 CURRENT_RULES_VERSION 仍为 rules-v1。
 */

import { normalizeBigramText } from './bigram.ts';
import { collectBigramStats } from './bigram-null-model.ts';

export const GEOMETRY_NULL_MODEL_SCHEMA = 'fasti-null-model-locality/v1';

/** 几何搜索上界：是建表期的候选搜索范围，不是门档；格内找不到达标组合即 fail-closed。 */
export const PADDING_SEARCH_MAX = 4;
export const GAP_SEARCH_MAX = 4;
/** 不授权格的拒识哨兵：门内读到 -1 必须按拒识处理，绝不可解释成容忍 0。 */
export const GEOMETRY_DENY = -1;

/** 整数二项系数 C(a,b)，网格规模小、不会越过 Number 安全整数范围。 */
function binomial(a: number, b: number): number {
  if (b < 0 || b > a) return 0;
  const k = Math.min(b, a - b);
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (a - k + i)) / i;
  return result;
}

/**
 * 布局计数 A(W,m,g)：W 个连续 bigram 槽位中，首末槽必为成功、共 m 个成功、
 * 相邻成功的间隙（gap＝槽位差-1）不超过 g 的布局数。
 * 等价间距方程 d_1+…+d_{m-1}=W-1、1≤d_i≤g+1 的整数解数，容斥精确求解。
 */
export function countGapLayouts(wSlots: number, successes: number, maxGap: number): number {
  if (successes < 2 || wSlots < successes) return 0;
  const r = successes - 1; // 间距变量个数
  const slack = wSlots - successes; // Σ e_i，e_i=d_i-1≥0、e_i≤maxGap
  const cap = maxGap + 1;
  let total = 0;
  for (let j = 0; j <= Math.floor(slack / cap); j += 1) {
    const remain = slack - j * cap;
    const ways = binomial(remain + r - 1, r - 1); // 无约束 stars-and-bars C(remain+r-1,r-1)
    total += (j % 2 === 0 ? 1 : -1) * binomial(r, j) * ways;
  }
  return total;
}

/**
 * 单个固定窗口（wSlots 个槽）内出现「首末成功、共 successes 个、相邻 gap≤maxGap、其余槽失败」
 * 这一组**具体布局之一**的概率：A(W,m,g)·p^m·(1-p)^(W-m)。
 */
export function windowClusterProb(
  wSlots: number,
  successes: number,
  maxGap: number,
  p: number,
): number {
  if (successes < 2 || wSlots < successes) return 0;
  const layouts = countGapLayouts(wSlots, successes, maxGap);
  if (layouts === 0) return 0;
  return layouts * p ** successes * (1 - p) ** (wSlots - successes);
}

export interface CompactBoundInput {
  /** 字段码点长 n（字段 bigram 数 m=n-1，满命中）。 */
  readonly fieldLength: number;
  /** 查询码点长 |q|（查询 bigram 槽位 L=|q|-1）。 */
  readonly queryCodeLength: number;
  /** L3 允许的内部空隙上界 G_gap。 */
  readonly maxGap: number;
  /** L2 允许的 span 外扩上界 G。 */
  readonly spanPadding: number;
  /** 单 bigram 槽位空模型命中概率（调用方按最不利 pMax 给入）。 */
  readonly p: number;
}

/**
 * 紧凑簇假阳性概率的 Bonferroni 上界。
 * span=W+1，约束 span≤n+G ⇒ 窗口槽数 W∈[n-1, n+G-1]；长度 W 的窗口在 L 个槽位中有
 * max(0,L-W+1) 个起点；对所有窗口/窗口尺寸求和（重复计数只高估）。查询短到放不下满命中时为 0。
 */
export function compactClusterFalsePositiveBound(input: CompactBoundInput): number {
  const { fieldLength: n, queryCodeLength, maxGap, spanPadding, p } = input;
  const m = n - 1;
  const slots = queryCodeLength - 1;
  const wMin = n - 1;
  const wMax = n + spanPadding - 1;
  let bound = 0;
  for (let w = wMin; w <= wMax; w += 1) {
    const windows = Math.max(0, slots - w + 1);
    if (windows === 0) continue;
    bound += windows * windowClusterProb(w, m, maxGap, p);
  }
  return bound;
}

export interface LocalityGeometryCell {
  /** 字段码点长 n。 */
  readonly n: number;
  /** 查询码点长 |q|。 */
  readonly qCodeLength: number;
  /** false＝空模型在搜索界内无法授权该格，门内须 fail-closed（此时两阈值为 GEOMETRY_DENY）。 */
  readonly authorized: boolean;
  /** 冻结的 G_gap（同 n 各查询格一致）。 */
  readonly maxGap: number;
  /** 冻结的 G（span padding，随 n、|q| 分格）。 */
  readonly maxSpanPadding: number;
}

export interface FrozenLocalityGeometryTable {
  readonly schema: typeof GEOMETRY_NULL_MODEL_SCHEMA;
  readonly cardCount: number;
  readonly maxQueryCodeLength: number;
  readonly paddingSearchMax: number;
  readonly gapSearchMax: number;
  readonly grid: readonly LocalityGeometryCell[];
}

export interface BuildGeometryInput {
  readonly fieldDocuments: readonly string[];
  /** Bonferroni 全库卡数 N：紧凑簇假阳性上界取 1/N。 */
  readonly cardCount: number;
  /** 查询码点长网格上界（含），下界为 2。 */
  readonly maxQueryCodeLength: number;
}

/** 在给定 g 下求使上界≤alpha 的最小 padding G；搜索界内找不到返回 null。 */
function smallestPadding(
  n: number,
  qCodeLength: number,
  maxGap: number,
  p: number,
  alpha: number,
): number | null {
  for (let gPad = 0; gPad <= PADDING_SEARCH_MAX; gPad += 1) {
    const b = compactClusterFalsePositiveBound({
      fieldLength: n,
      queryCodeLength: qCodeLength,
      maxGap,
      spanPadding: gPad,
      p,
    });
    if (b <= alpha) return gPad;
  }
  return null;
}

/**
 * 离线构建 G/G_gap 整数冻结表。
 * 第一遍逐格求各自最优 (G,g)；第二遍把 G_gap 收敛为同 n 跨查询格的最保守值 max g，再在该统一
 * gap 下重定每格最小 G（外审 435 行 G_gap 只依赖 |f|）；统一 gap 下无法达标的格 fail-closed。
 */
export function buildLocalityGeometryTable(input: BuildGeometryInput): FrozenLocalityGeometryTable {
  const { fieldDocuments, cardCount, maxQueryCodeLength } = input;
  if (cardCount <= 0) throw new Error('空模型卡数 N 必须为正');
  if (maxQueryCodeLength < 2) throw new Error('查询码点长上界至少为 2');

  const empty: FrozenLocalityGeometryTable = {
    schema: GEOMETRY_NULL_MODEL_SCHEMA,
    cardCount,
    maxQueryCodeLength,
    paddingSearchMax: PADDING_SEARCH_MAX,
    gapSearchMax: GAP_SEARCH_MAX,
    grid: [],
  };

  const stats = collectBigramStats(fieldDocuments);
  if (stats.totalBigramTokens === 0) return empty;

  // 按字段码点长 n 聚合最不利单次命中边缘概率 pMax(n)。
  const pMaxByN = new Map<number, number>();
  fieldDocuments.forEach((doc, i) => {
    const n = [...normalizeBigramText(doc)].length;
    if (n < 2) return;
    const unitSet = stats.fieldBigramSets[i];
    if (!unitSet) return;
    let pField = 0;
    for (const gram of unitSet) {
      pField += (stats.tokenFrequency.get(gram) ?? 0) / stats.totalBigramTokens;
    }
    const prev = pMaxByN.get(n) ?? 0;
    if (pField > prev) pMaxByN.set(n, pField);
  });

  const alpha = 1 / cardCount;
  const ns = [...pMaxByN.keys()].sort((a, b) => a - b);

  // 第一遍：每格独立求最优 (g,pad)，并记录该 n 所需的最保守 gap。
  const firstPass = new Map<string, { gap: number; pad: number }>();
  const gapStarByN = new Map<number, number>();
  for (const n of ns) {
    const p = pMaxByN.get(n)!;
    let gapStar = 0;
    for (let q = 2; q <= maxQueryCodeLength; q += 1) {
      let found: { gap: number; pad: number } | null = null;
      outer: for (let gPad = 0; gPad <= PADDING_SEARCH_MAX; gPad += 1) {
        for (let gap = 0; gap <= GAP_SEARCH_MAX; gap += 1) {
          const b = compactClusterFalsePositiveBound({
            fieldLength: n,
            queryCodeLength: q,
            maxGap: gap,
            spanPadding: gPad,
            p,
          });
          if (b <= alpha) {
            found = { gap, pad: gPad };
            break outer;
          }
        }
      }
      const key = `${n}#${q}`;
      if (found === null) {
        firstPass.set(key, { gap: GEOMETRY_DENY, pad: GEOMETRY_DENY });
      } else {
        firstPass.set(key, found);
        if (found.gap > gapStar) gapStar = found.gap;
      }
    }
    gapStarByN.set(n, gapStar);
  }

  // 第二遍：统一 G_gap=gapStar(n)，重定每格最小 G；不达标即不授权。
  const grid: LocalityGeometryCell[] = [];
  for (const n of ns) {
    const p = pMaxByN.get(n)!;
    const gapStar = gapStarByN.get(n)!;
    for (let q = 2; q <= maxQueryCodeLength; q += 1) {
      const first = firstPass.get(`${n}#${q}`)!;
      if (first.gap === GEOMETRY_DENY) {
        grid.push({ n, qCodeLength: q, authorized: false, maxGap: GEOMETRY_DENY, maxSpanPadding: GEOMETRY_DENY });
        continue;
      }
      const pad = smallestPadding(n, q, gapStar, p, alpha);
      if (pad === null) {
        grid.push({ n, qCodeLength: q, authorized: false, maxGap: GEOMETRY_DENY, maxSpanPadding: GEOMETRY_DENY });
      } else {
        grid.push({ n, qCodeLength: q, authorized: true, maxGap: gapStar, maxSpanPadding: pad });
      }
    }
  }

  return { ...empty, grid };
}

/**
 * 门内只读查表：返回该 (n,|q|) 冻结几何容忍量；未建模格或不授权格一律返回拒识哨兵，
 * 绝不返回 maxGap=0 之类可被误读为「放行」的宽松值。
 */
export function lookupLocalityGeometry(
  table: FrozenLocalityGeometryTable,
  fieldLength: number,
  queryCodeLength: number,
): { readonly authorized: boolean; readonly maxGap: number; readonly maxSpanPadding: number } {
  const deny = { authorized: false, maxGap: GEOMETRY_DENY, maxSpanPadding: GEOMETRY_DENY } as const;
  const cell = table.grid.find((c) => c.n === fieldLength && c.qCodeLength === queryCodeLength);
  if (cell === undefined || !cell.authorized) return deny;
  return { authorized: true, maxGap: cell.maxGap, maxSpanPadding: cell.maxSpanPadding };
}
