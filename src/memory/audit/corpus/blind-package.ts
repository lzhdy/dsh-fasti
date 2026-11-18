/**
 * P6 D 批 · 独立出题盲包（v4 §8：出题方只拿 raw-turns／summary 与事件 id）。
 *
 * 纯函数模块：把世界蓝本投影成「出题人可见面」。key_points、cue、别名、判别词、
 * 派生器产物等答案侧字段一律不出现；assertBlindPackageSafe 递归锁白名单，
 * 序列化后的产物也必须能通过同一道检查（红测以此防呆，防后续改字段偷偷漏题）。
 */

import { IntegrityError } from '../../../core/errors.ts';
import type { PlannedEvent, WorldPlan } from './world-plan.ts';

/** 答案侧违禁键：任一层级出现即视为盲包被污染。 */
export const BLIND_FORBIDDEN_KEYS: readonly string[] = [
  'keyPoints',
  'key_points',
  'cues',
  'cue',
  'displayCues',
  'displayCuesJson',
  'display_cues',
  'aliases',
  'aliasesJson',
  'discriminator',
  'derivedCues',
  'modelTag',
  'model_tag',
  'rulesVersion',
  'rules_version',
];

export interface BlindTurn {
  readonly speaker: 'user';
  readonly offsetMinutes: number;
  readonly rawText: string;
}

export interface BlindEvent {
  readonly eventId: string;
  readonly partition: 'sealed' | 'tuning';
  readonly familyId: string;
  readonly channel: 'dsh';
  readonly startedAtMs: number;
  readonly endedMs: number;
  readonly summary: string;
  readonly turns: readonly BlindTurn[];
  readonly sensitiveTerms: readonly string[];
  readonly highRiskLabels: readonly string[];
}

export interface BlindPackage {
  readonly schema: 'fasti-p6-blind/v1';
  readonly seed: number;
  readonly baseEpochMs: number;
  readonly events: readonly BlindEvent[];
}

export function toBlindEvent(event: PlannedEvent): BlindEvent {
  return {
    eventId: event.eventId,
    partition: event.partition,
    familyId: event.familyId,
    channel: event.channel,
    startedAtMs: event.startedAtMs,
    endedMs: event.endedMs,
    summary: event.summary,
    turns: event.turns.map((turn) => ({
      speaker: turn.speaker,
      offsetMinutes: turn.offsetMinutes,
      rawText: turn.rawText,
    })),
    sensitiveTerms: [...event.sensitiveTerms],
    highRiskLabels: [...event.highRiskLabels],
  };
}

export function buildBlindPackage(plan: WorldPlan): BlindPackage {
  return {
    schema: 'fasti-p6-blind/v1',
    seed: plan.seed,
    baseEpochMs: plan.baseEpochMs,
    events: plan.events.map(toBlindEvent),
  };
}

/** 递归检查：任何对象层级出现违禁键即抛 IntegrityError（红测先锁，脚本调用兜底）。 */
export function assertBlindPackageSafe(node: unknown, trail = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertBlindPackageSafe(child, `${trail}[${i}]`));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (BLIND_FORBIDDEN_KEYS.includes(key)) {
        throw new IntegrityError(`盲包含答案侧违禁字段 ${trail}.${key}（独立出题人不得见）`);
      }
      assertBlindPackageSafe(value, `${trail}.${key}`);
    }
  }
}
