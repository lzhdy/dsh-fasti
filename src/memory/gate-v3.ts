/**
 * rules-v3 候选门（#227，P2 局部聚集度组级二次裁决，默认不生效）：
 *
 * 双轨接线，绝不复制 v2 判据——先跑 applyGateV2，再按 218 蓝图 §3 决定透传或唯一分叉：
 *
 *  1. v2 已 hit（含 exact-alias/fts-substring/反向包含）、空查询、零词面候选：
 *     原样返回 v2 outcome（同一对象引用），保证深相等、零漂移；
 *  2. v2 all-rejected 但没有任何携带 lexicalFields 的候选（纯 like-fallback 等）：
 *     无词面可作证，原样透传；
 *  3. v2 all-rejected 且存在词面候选：交 frozenLocalityDecision 做组级二次裁决——
 *     - pass：仅唯一领袖一张转 accepted（原 v2 原因码保留并追加 locality-pass，
 *       挂五元组 localityDetail，slot='ranked'），其余卡原样留 rejected；
 *     - conflict-abstain（全等/无严格领袖/无见证）：整组弃权；其中 no-witness
 *       保持 v2 all-rejected 信封透传，exact-equal/no-strict-leader 才产
 *       no-match/locality-conflict，rejected 全集每卡追加 conflict-abstain。
 *
 * 本文件是纯函数、无时钟无随机；冻结三表由调用方注入，门内不持库、不做 I/O。
 * 生产分派壳 applyGate 与 types.ts 的 CURRENT_RULES_VERSION 在切常量授权前对本文件零感知。
 */

import { applyGateV2, type ApplyGateInput } from './gate.ts';
import { buildSerialMap } from './serial.ts';
import {
  frozenLocalityDecision,
  type FrozenLocalityCandidate,
} from './locality-frozen.ts';
import type { FrozenKMinTable, FrozenRaritySnapshot } from './bigram-null-model.ts';
import type { FrozenLocalityGeometryTable } from './locality-null-model.ts';
import type { GateReasonCode, GatedRankedCard, GatedSearchOutcome } from './types.ts';

/** applyGateV3 入参：v2 入参超集，追加三张正式冻结表（schema 版本由各表自校验）。 */
export interface ApplyGateV3Input extends ApplyGateInput {
  readonly kminTable: FrozenKMinTable;
  readonly geometryTable: FrozenLocalityGeometryTable;
  readonly raritySnapshot: FrozenRaritySnapshot;
}

/**
 * rules-v3 候选门。返回的 GatedSearchOutcome 与 v2 同构；
 * 透传路径直接复用 v2 对象，分叉路径只做信封重组，不引入任何新数值计算。
 */
export function applyGateV3(input: ApplyGateV3Input): GatedSearchOutcome {
  const outcome2 = applyGateV2(input);

  // 透传一：v2 已放行（exact/fts/反向包含任意通道 hit），v3 不碰合格集。
  if (outcome2.status === 'hit') {
    return outcome2;
  }
  // 透传二：空查询、零词面候选等非 all-rejected 汇总态原样返回。
  if (outcome2.reason !== 'all-rejected') {
    return outcome2;
  }

  // 唯二分叉的入口：v2 全拒。like-fallback 卡没有 lexicalFields，不得进入幸存集。
  const frozenCandidates: FrozenLocalityCandidate[] = [];
  for (const candidate of input.candidates) {
    const fields = candidate.lexicalFields;
    if (Array.isArray(fields) && fields.length > 0) {
      frozenCandidates.push({ cardId: candidate.card.cardId, lexicalFields: fields });
    }
  }
  // 透传三：全拒集里没有任何带词面字段的卡，局部聚集度无从作证。
  if (frozenCandidates.length === 0) {
    return outcome2;
  }

  const verdict = frozenLocalityDecision({
    queryNorm: input.qNorm,
    candidates: frozenCandidates,
    kminTable: input.kminTable,
    geometryTable: input.geometryTable,
    raritySnapshot: input.raritySnapshot,
  });

  // 透传四：无卡幸存（哨兵/几何/L1-L3 全部 fail-closed），保持 v2 all-rejected 信封。
  if (verdict.outcome === 'conflict-abstain' && verdict.reason === 'no-witness') {
    return outcome2;
  }

  // 全拒集每卡在 v2 信封里都有一条 rejected 记录，按 cardId 建索引取原原因码。
  const rejectedById = new Map<string, GatedRankedCard>();
  for (const gated of outcome2.rejected) {
    rejectedById.set(gated.card.cardId, gated);
  }

  if (verdict.outcome === 'pass') {
    const leaderGated = rejectedById.get(verdict.cardId);
    // 防御：领袖必然来自全拒候选；索引缺失说明信封不变量被破坏，fail-loud 而非静默挑卡。
    if (leaderGated === undefined) {
      throw new Error(`rules-v3 内部不变量破坏：领袖卡 ${verdict.cardId} 不在 v2 rejected 集中`);
    }
    const leader: GatedRankedCard = {
      ...leaderGated,
      // 原 v2 拒绝原因码保留在前，追加二次裁决放行码，审计可完整回放两段裁决。
      gateReasons: [...leaderGated.gateReasons, 'locality-pass'] as GateReasonCode[],
      localityDetail: { ...verdict.witness },
      slot: 'ranked',
    };
    const restRejected = outcome2.rejected.filter((gated) => gated.card.cardId !== verdict.cardId);
    return {
      status: 'hit',
      candidateCount: outcome2.candidateCount,
      accepted: [leader],
      rejected: restRejected,
      serialMap: buildSerialMap([leader]),
      // 候选门只救回唯一领袖，marked/explore 恒 0。
      slots: { marked: 0, ranked: 1, explore: 0, exploreWanted: 0, exploreFilled: 0 },
    };
  }

  // conflict-abstain 且原因为 exact-equal/no-strict-leader：组级冲突，整组弃权，绝不挑卡。
  const rejected = outcome2.rejected.map((gated) => ({
    ...gated,
    gateReasons: [...gated.gateReasons, 'conflict-abstain'] as GateReasonCode[],
  }));
  return {
    status: 'no-match',
    candidateCount: outcome2.candidateCount,
    accepted: [],
    rejected,
    reason: 'locality-conflict',
    serialMap: buildSerialMap([]),
  };
}
