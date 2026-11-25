/**
 * #227 正式冻结表适配（218 蓝图 §4）：把 W3-2a/W3-2c 两张随根空模型冻结表翻译成逐字段
 * 见证判定，并复用 locality.ts 的七维比较器完成 L4 统一安全锁。
 *
 * 与 locality.ts 占位路径的唯一实质差异在 L1：
 *  - 占位表比总命中数（m ≥ n-1-deficit），只服务库存单测，生产门永不引用该占位常量；
 *  - 本模块比「稀有 bigram 命中种类数」rareCount ≥ lookupKMin(...)（A1 C6 口径），
 *    稀有桶号来自由索引构建期冻结的 FrozenRaritySnapshot，门内不持库、不算 df、不算概率。
 *
 * fail-closed 纪律：未建模 k_min 格（哨兵 m+1）、格内 kMin>m、几何未授权/GEOMETRY_DENY、
 * 字段无 bigram 命中，全部按「无见证」处理，绝不返回宽松默认值。
 *
 * 无环：依赖 locality/bigram/lexical-signals/两个 null-model 模块，均为不到达 store 的 leaf；
 * 纯整数热路径，无 I/O、无墙钟、无随机、无浮点。
 */

import { emitUnits, normalizeBigramText } from './bigram.ts';
import { compareGradedSignals, localityDetail } from './locality.ts';
import { gradedLexicalSignals } from './lexical-signals.ts';
import {
  lookupKMin,
  rareBigramHitCount,
  rarityBucketMapOf,
  type FrozenKMinTable,
  type FrozenRaritySnapshot,
} from './bigram-null-model.ts';
import {
  lookupLocalityGeometry,
  type FrozenLocalityGeometryTable,
} from './locality-null-model.ts';
import type { GradedSignals } from './types.ts';

/** 卡级作证留痕（与 types.GatedRankedCard.localityDetail 同形状，全整数可手算复核）。 */
export interface FrozenLocalityWitness {
  readonly fieldIndex: number;
  /** 见证字段在查询中的 bigram 命中数（LocalityTriple.m，非字段 bigram 种类数）。 */
  readonly m: number;
  /** 稀有 bigram 命中种类数（A1 rarecount，L1 实际比较量）。 */
  readonly rareCount: number;
  readonly span: number;
  readonly gap: number;
}

export interface FrozenLocalityCandidate {
  readonly cardId: string;
  readonly lexicalFields: readonly string[];
}

export type FrozenLocalityVerdict =
  | {
      readonly outcome: 'pass';
      readonly cardId: string;
      readonly witness: FrozenLocalityWitness;
      readonly signals: GradedSignals;
    }
  | {
      readonly outcome: 'conflict-abstain';
      readonly reason: 'no-witness' | 'exact-equal' | 'no-strict-leader';
    };

export interface FrozenLocalityInput {
  readonly queryNorm: string;
  readonly candidates: readonly FrozenLocalityCandidate[];
  readonly kminTable: FrozenKMinTable;
  readonly geometryTable: FrozenLocalityGeometryTable;
  readonly raritySnapshot: FrozenRaritySnapshot;
}

/** 单字段 L1-L3 见证判定；任一条件不满足返回 null（fail-closed，不造宽松见证）。 */
function fieldWitness(
  queryNorm: string,
  fieldText: string,
  fieldIndex: number,
  bucketMap: ReadonlyMap<string, number>,
  kminTable: FrozenKMinTable,
  geometryTable: FrozenLocalityGeometryTable,
): FrozenLocalityWitness | null {
  const fieldNorm = normalizeBigramText(fieldText);
  const fieldChars = [...fieldNorm];
  const n = fieldChars.length;
  if (n < 2) return null;

  const triple = localityDetail(queryNorm, fieldText);
  if (triple === null) return null;

  const queryNormText = normalizeBigramText(queryNorm);
  const queryUnits = emitUnits(queryNormText);
  const qLen = queryUnits.length;
  if (qLen === 0) return null;

  // k_min 网格的 m 轴是字段去重 bigram 种类数（与建表器 fieldBigramSets 同粒度）。
  const fieldUnitCount = new Set(emitUnits(fieldNorm)).size;
  const kMin = lookupKMin(kminTable, fieldUnitCount, qLen);
  // 未建模格返回 m+1 哨兵、格内 kMin>m 表示空模型不足以授权：两种情形都 fail-closed。
  if (kMin > fieldUnitCount) return null;

  // L1：稀有命中种类数（逐字段调用，保证 rareCount 与 k_min 的字段级粒度一致）。
  const rareCount = rareBigramHitCount(queryNorm, [fieldText], bucketMap, kminTable.bMin);
  if (rareCount < kMin) return null;

  // L2/L3：几何容忍量只能读冻结表，禁止硬编码 0。
  const qCodeLength = [...queryNormText].length;
  const geometry = lookupLocalityGeometry(geometryTable, n, qCodeLength);
  if (!geometry.authorized) return null;
  if (triple.gap > geometry.maxGap) return null;
  if (triple.span - n > geometry.maxSpanPadding) return null;

  return { fieldIndex, m: triple.m, rareCount, span: triple.span, gap: triple.gap };
}

function signalsEqual(a: GradedSignals, b: GradedSignals): boolean {
  return (
    a.lcs === b.lcs &&
    a.unitCovered === b.unitCovered &&
    a.unitTotal === b.unitTotal &&
    a.hitFields === b.hitFields &&
    a.strongFields === b.strongFields &&
    a.minHitFieldLength === b.minHitFieldLength &&
    a.maxHitFieldLength === b.maxHitFieldLength
  );
}

/**
 * 正式冻结表组级裁决（A1 L1-L4＋200 §6.1 安全锁）：
 *  1. 幸存集＝至少一个字段过 L1-L3 的候选，空集 no-witness；
 *  2. 任意两张幸存卡七维全等 → exact-equal，整组弃权不挑卡；
 *  3. 唯一严格支配其余每张者 → pass 并附见证五元组与信号向量；
 *  4. 否则 no-strict-leader。比较器复用 locality.compareGradedSignals，不另写 φ 定义。
 */
export function frozenLocalityDecision(input: FrozenLocalityInput): FrozenLocalityVerdict {
  const { queryNorm, candidates, kminTable, geometryTable, raritySnapshot } = input;
  const bucketMap = rarityBucketMapOf(raritySnapshot);

  const survivors = candidates
    .map((candidate) => {
      // 字段保序：取首个过 L1-L3 的字段作证（与 locality.witnessLocality 同范式）。
      let witness: FrozenLocalityWitness | null = null;
      candidate.lexicalFields.forEach((field, fieldIndex) => {
        if (witness !== null) return;
        witness = fieldWitness(queryNorm, field, fieldIndex, bucketMap, kminTable, geometryTable);
      });
      if (witness === null) return null;
      return {
        candidate,
        witness,
        signals: gradedLexicalSignals(queryNorm, candidate.lexicalFields),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (survivors.length === 0) {
    return { outcome: 'conflict-abstain', reason: 'no-witness' };
  }

  for (let i = 0; i < survivors.length; i += 1) {
    for (let j = i + 1; j < survivors.length; j += 1) {
      if (signalsEqual(survivors[i]!.signals, survivors[j]!.signals)) {
        return { outcome: 'conflict-abstain', reason: 'exact-equal' };
      }
    }
  }

  const leaders = survivors.filter((entry) =>
    survivors.every(
      (other) => other === entry || compareGradedSignals(entry.signals, other.signals) === 'dominates',
    ),
  );

  if (leaders.length === 1) {
    const leader = leaders[0]!;
    return { outcome: 'pass', cardId: leader.candidate.cardId, witness: leader.witness, signals: leader.signals };
  }
  return { outcome: 'conflict-abstain', reason: 'no-strict-leader' };
}
