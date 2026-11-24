/**
 * P6 D 批 · 独立出题盲包 v2（预注册 v5 §3.3、出题任务书 v2 §3）。
 *
 * 与 v1 的关系：并列第二份，v1（`blind-package.ts`）一字不动。差异只有三处：
 *  1. schema 升 `fasti-p6-blind/v2`，规模 500 事件；
 *  2. **显式逐字段投影**，不 spread、不透传——蓝本新增的 `hasRef`（S5 金标位置）因此
 *     物理上进不了盲包，而不是靠违禁键表事后拦；
 *  3. manifest 增 `reusedDetailWords`（18 个跨族共享细节词）：出题任务书 §7.3/§7.4
 *     共 54 条排序压力题要求按这些词原样出题，缺这一项这 54 条就出不来。
 *
 * 安全门复用 v1 的 `assertBlindPackageSafe`（同一道检查、一张违禁键表），不另开第二套。
 */

import type { HighRiskLabelV2, PlannedEventV2, WorldPlanV2 } from './world-plan-v2.ts';
import { FAMILY_SIZE_V2, SEED_V2, TOTAL_EVENT_COUNT_V2, WORLD_SCHEMA_V2, reusedDetailWordsV2 } from './world-plan-v2.ts';

export interface BlindTurnV2 {
  readonly speaker: 'user';
  readonly offsetMinutes: number;
  readonly rawText: string;
}

/** 出题人可见面：**不含** keyPoints（答案侧）、**不含** hasRef（S5 位置）、**不含** any 派生器字段。 */
export interface BlindEventV2 {
  readonly eventId: string;
  readonly partition: 'sealed' | 'tuning';
  readonly familyId: string;
  readonly channel: 'dsh';
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly summary: string;
  readonly turns: readonly BlindTurnV2[];
  readonly sensitiveTerms: readonly string[];
  readonly highRiskLabels: readonly HighRiskLabelV2[];
}

export interface BlindPackageV2 {
  readonly schema: 'fasti-p6-blind/v2';
  readonly seed: number;
  readonly baseEpochMs: number;
  readonly events: readonly BlindEventV2[];
}

/**
 * 逐字段投影。注意这里是**白名单式**拷贝：蓝本加字段不会自动流入盲包，
 * 必须在本函数里显式加一行——这是「新字段默认不外泄」的唯一防线。
 */
export function toBlindEventV2(event: PlannedEventV2): BlindEventV2 {
  return {
    eventId: event.eventId,
    partition: event.partition,
    familyId: event.familyId,
    channel: event.channel,
    startedAtMs: event.startedAtMs,
    endedAtMs: event.endedMs,
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

export function buildBlindPackageV2(plan: WorldPlanV2): BlindPackageV2 {
  return {
    schema: 'fasti-p6-blind/v2',
    seed: plan.seed,
    baseEpochMs: plan.baseEpochMs,
    events: plan.events.map(toBlindEventV2),
  };
}

export interface WorldManifestV2 {
  readonly schema: typeof WORLD_SCHEMA_V2;
  readonly seed: number;
  readonly baseEpochMs: number;
  readonly referenceNowMs: number;
  readonly totalEvents: number;
  readonly sealedEvents: number;
  readonly tuningEvents: number;
  readonly highRiskInventory: readonly { readonly eventId: string; readonly label: string }[];
  /** 18 个跨族共享细节词（原样字符串）。出题任务书 §7.3/§7.4 按它出 54 条题。 */
  readonly reusedDetailWords: readonly string[];
}

/**
 * 世界清单。**只给总量、分区、高危清单、复用词**，不给结构统计（族覆盖/周桶/唯一度等）：
 * 那些数字会反向缩小出题人的搜索空间（Q3 裁定）。
 */
export function buildWorldManifestV2(plan: WorldPlanV2): WorldManifestV2 {
  return {
    schema: plan.schema,
    seed: plan.seed,
    baseEpochMs: plan.baseEpochMs,
    referenceNowMs: plan.referenceNowMs,
    totalEvents: plan.events.length,
    sealedEvents: plan.events.filter((event) => event.partition === 'sealed').length,
    tuningEvents: plan.events.filter((event) => event.partition === 'tuning').length,
    highRiskInventory: plan.events.flatMap((event) =>
      event.highRiskLabels.map((label) => ({ eventId: event.eventId, label })),
    ),
    reusedDetailWords: reusedDetailWordsV2(plan),
  };
}

/** 自检：v2 盲包与 manifest 的基本契约（脚本 fail-fast 用，不进 blind 文件本身）。 */
export function assertBlindPackageV2Shape(pkg: BlindPackageV2, manifest: WorldManifestV2): string[] {
  const errs: string[] = [];
  if (pkg.schema !== 'fasti-p6-blind/v2') errs.push(`盲包 schema=${pkg.schema}`);
  if (manifest.schema !== WORLD_SCHEMA_V2) errs.push(`清单 schema=${manifest.schema}`);
  if (pkg.seed !== SEED_V2 || manifest.seed !== SEED_V2) errs.push('seed 与预注册不一致');
  if (pkg.events.length !== TOTAL_EVENT_COUNT_V2) errs.push(`盲包事件数 ${pkg.events.length}`);
  if (manifest.totalEvents !== TOTAL_EVENT_COUNT_V2) errs.push(`清单总量 ${manifest.totalEvents}`);
  if (manifest.sealedEvents + manifest.tuningEvents !== manifest.totalEvents) errs.push('分区计数不自洽');
  if (manifest.reusedDetailWords.length !== 18) errs.push(`复用词 ${manifest.reusedDetailWords.length} ≠ 18`);
  for (const event of pkg.events) {
    const expectedTurns = event.highRiskLabels.length > 0 ? 7 : 6;
    if (event.turns.length !== expectedTurns) errs.push(`${event.eventId} turns ${event.turns.length} ≠ ${expectedTurns}`);
    for (const turn of event.turns) {
      if (turn.offsetMinutes % 12 !== 0) errs.push(`${event.eventId} offsetMinutes 非 12 的倍数`);
      if (turn.speaker !== 'user') errs.push(`${event.eventId} 说话人非 user`);
    }
  }
  const families = new Set(pkg.events.map((event) => event.familyId));
  if (families.size * FAMILY_SIZE_V2 !== pkg.events.length) errs.push('族数与事件数不配套');
  return errs;
}
