/**
 * P0 分级词面信号（194 号设计稿 §四 P0）：纯整数留痕，不参与裁决或排序。
 *
 * 无环纪律：只依赖 bigram.ts（同为 leaf，规范化/切词口径唯一来源）与全局字符串/正则，
 * 不 import gate/bm25/store/builder/装配层，不持库柄、无随机、无时钟、无学习权重。
 *
 * 三个信号（全部整数量，覆盖率保留分子分母，不做浮点 cutoff）：
 *  ① 单元覆盖：emitUnits(qNorm) 共 m 个单元，被任一规范化字段包含的 c 个；
 *  ② 最长公共连续码点 LCS（卡级取 max_f），「整字段反向包含」是它的特例；
 *  ③ 字段命中分布：命中字段数、LCS≥3 的强字段数、最短/最长命中字段码点数。
 *
 * 用途边界：本模块只产出观测值供审计报告与 DTO 留痕。任何把本信号接进 accept/reject
 * 或排序键的用法都属判据变更，必须另走预注册 §9。
 */

import { emitUnits, normalizeBigramText } from './bigram.ts';
import type { GradedSignals } from './types.ts';

/** 强命中字段的 LCS 门槛（与 gate 现行 `minContainCodepoints=3` 同口径，仅作分组标签，不参与判据）。 */
const STRONG_LCS_CODEPOINTS = 3;

const EMPTY_SIGNALS: GradedSignals = {
  lcs: 0,
  unitCovered: 0,
  unitTotal: 0,
  hitFields: 0,
  strongFields: 0,
  minHitFieldLength: 0,
  maxHitFieldLength: 0,
};

/** 最长公共连续码点子串长度（经典 O(n·m) DP，仅保留上一行以省内存）。 */
function lcsCodepoints(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        const run = (prev[j - 1] ?? 0) + 1;
        row[j] = run;
        if (run > best) best = run;
      }
    }
    prev = row;
  }
  return best;
}

/**
 * 计算一次「查询 × 候选卡字段集」的分级信号。
 * 入参可为原文：内部经 normalizeBigramText 归一化（与索引/查询/门三处同构）。
 */
export function gradedLexicalSignals(query: string, lexicalFields: readonly string[]): GradedSignals {
  const qNorm = normalizeBigramText(query);
  if (qNorm.length === 0) return { ...EMPTY_SIGNALS };

  const units = emitUnits(qNorm);
  const fields = lexicalFields.map((field) => normalizeBigramText(field)).filter((field) => field.length > 0);
  if (fields.length === 0) return { ...EMPTY_SIGNALS, unitTotal: units.length };

  const qChars = [...qNorm];
  let lcs = 0;
  let hitFields = 0;
  let strongFields = 0;
  let minHitFieldLength = 0;
  let maxHitFieldLength = 0;

  for (const field of fields) {
    const fieldChars = [...field];
    const fieldLcs = lcsCodepoints(qChars, fieldChars);
    if (fieldLcs > lcs) lcs = fieldLcs;

    const isHit = units.some((unit) => field.includes(unit));
    if (!isHit) continue;
    hitFields += 1;
    if (fieldLcs >= STRONG_LCS_CODEPOINTS) strongFields += 1;
    const len = fieldChars.length;
    if (minHitFieldLength === 0 || len < minHitFieldLength) minHitFieldLength = len;
    if (len > maxHitFieldLength) maxHitFieldLength = len;
  }

  const unitCovered = units.filter((unit) => fields.some((field) => field.includes(unit))).length;

  return { lcs, unitCovered, unitTotal: units.length, hitFields, strongFields, minHitFieldLength, maxHitFieldLength };
}
