/**
 * 乙机制澄清决策器纯函数内核（#194；195 号评估文书 3.2）。
 *
 * 职责边界（第一批，纯加法离线层）：
 *  - 只消费门后候选的 cardId 与 P0 分级词面信号（GradedSignals，七整数），
 *    输出封闭四态枚举与打平组，供审计 harness 离线模拟「若当时有澄清机制会怎样分」；
 *  - 不 import gate/store/bm25/装配层，无随机、无时钟、无 IO、无学习权重；
 *  - 生产门（applyGateV2）不 import 本模块，GatedRankedCard 不携带本模块产物；
 *    任何接进 accept/reject、排序或生产写入闸的改动都属判据变更，须另走预注册 §9。
 *
 * 第一版刻意零阈值常数：只识别「信号向量七字段精确全等」的结构性打平——
 * 封存卷实测 S0 4 wc 与澄清 18/18 均为此形态（194 号文书 3.2 硬结论 3）。
 * NOMINATE_SINGLE（单候选弱证据提名）与「近邻但非全等」的反问档需要 P1
 * 梯度负样本卷标定后才能给常数，本版保留枚举但不可达，禁止拍小样本伪标定。
 */
import type { GradedSignals } from './types.ts';

/** 澄清动作四态（#126 卡两形态＋现行提交/落空两态的封闭枚举）。 */
export type ClarifyAction = 'COMMIT' | 'NOMINATE_SINGLE' | 'ASK_MULTI' | 'ABSTAIN';

/** 决策理由码：与动作一一对应，封闭词表，供报告分桶与未来变异测试锁定。 */
export type ClarifyReason = 'no-candidate' | 'single-candidate' | 'exact-signal-tie' | 'strict-order';

/** 决策器输入：调用方负责按生产门后顺序给候选，决策器不重排。 */
export interface ClarifyCandidate {
  cardId: string;
  signals: GradedSignals;
}

export interface ClarifyVerdict {
  action: ClarifyAction;
  reason: ClarifyReason;
  /** 参与判定的全部 cardId 副本（保持传入顺序）。 */
  candidateIds: readonly string[];
  /** ASK_MULTI 时与第一名信号精确全等的打平组 cardId（含第一名）；其余态为空数组。 */
  tiedCardIds: readonly string[];
}

const SIGNAL_FIELDS = [
  'lcs',
  'unitCovered',
  'unitTotal',
  'hitFields',
  'strongFields',
  'minHitFieldLength',
  'maxHitFieldLength',
] as const satisfies readonly (keyof GradedSignals)[];

/** 七整数字段逐字段相等；GradedSignals 形状封闭，无需通用深比较。 */
function signalsEqual(a: GradedSignals, b: GradedSignals): boolean {
  return SIGNAL_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * 结构性可裁决性判定（纯函数）。
 *
 * - 零候选        → ABSTAIN（对接现行 no-match/all-rejected 落空纪律）；
 * - 恰好一张      → COMMIT（弱证据提名档未启用，信号全零也提交，与现行生产行为逐字一致）；
 * - 多张且首张有精确全等伙伴 → ASK_MULTI（多候选反问，不赌）；
 * - 多张但严格序  → COMMIT（尊重调用方给定的生产排序）。
 *
 * 不修改输入数组；返回的编号数组都是独立新数组，调用方无法经返回值突变内部状态。
 */
export function decideClarify(candidates: readonly ClarifyCandidate[]): ClarifyVerdict {
  const candidateIds = candidates.map((candidate) => candidate.cardId);

  if (candidates.length === 0) {
    return { action: 'ABSTAIN', reason: 'no-candidate', candidateIds, tiedCardIds: [] };
  }
  if (candidates.length === 1) {
    return { action: 'COMMIT', reason: 'single-candidate', candidateIds, tiedCardIds: [] };
  }

  const leader = candidates[0]!;
  const tiedCardIds = candidates
    .filter((candidate) => signalsEqual(candidate.signals, leader.signals))
    .map((candidate) => candidate.cardId);

  if (tiedCardIds.length >= 2) {
    return { action: 'ASK_MULTI', reason: 'exact-signal-tie', candidateIds, tiedCardIds };
  }
  return { action: 'COMMIT', reason: 'strict-order', candidateIds, tiedCardIds: [] };
}
