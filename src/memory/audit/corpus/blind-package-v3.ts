/**
 * 统一调参新卷 · v3 出题盲包（W2-4）。
 *
 * 与 v1/v2 盲包并列、互不 import 蓝本侧答案字段：本模块只**逐字段白名单**投影出题人可见面，
 * 蓝本加字段不会自动流入（新字段默认不外泄，这是唯一防线）。
 *
 * 三处与 v2 的差异：
 *  1. schema 升 `fasti-p6-blind/v3`，规模 1920 事件（纯调参卷，无 sealed 分区）；
 *  2. `partition` 保留 `tuning-a | tuning-b`：v3 的 eventId/familyId 本身已编码分区，
 *     隐藏它必须重写 id、断掉「盲包→出题答案→根目录→装配」的钥匙链，代价远大于收益，
 *     且 v2 早已暴露更粗的 sealed/tuning 分区（先例）；
 *  3. 支持按分区单出子包（`buildBlindPackageV3(plan, 'tuning-a'|'tuning-b')`），
 *     为立项书 §8「A/B 卷物理隔离」留出口——发几包属发卷环节，本模块不预设。
 *
 * 安全门复用 v1 的 `assertBlindPackageSafe`（同一道检查、同一张违禁键表），不另开第二套。
 */

import { IntegrityError } from '../../../core/errors.ts';
import { assertBlindPackageSafe } from './blind-package.ts';
import type { CorpusPartitionV3, PlannedEventV3, WorldPlanV3 } from './world-plan-v3.ts';
import {
  COLLIDE_WORDS_V3,
  FAMILY_COUNT_V3,
  FAMILY_SIZE_V3,
  SEED_V3,
  TOTAL_EVENT_COUNT_V3,
  WORLD_SCHEMA_V3,
} from './world-plan-v3.ts';
import type { WorldManifestV3 } from './world-manifest-v3.ts';

export const BLIND_V3_SCHEMA = 'fasti-p6-blind/v3';

export interface BlindTurnV3 {
  readonly speaker: 'user';
  readonly offsetMinutes: number;
  readonly rawText: string;
}

/** 出题人可见面：**不含** keyPoints（答案侧）、**不含** hasRef（指代金标位置）、**不含** reusePlan。 */
export interface BlindEventV3 {
  readonly eventId: string;
  readonly partition: CorpusPartitionV3;
  readonly familyId: string;
  readonly channel: 'dsh';
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly summary: string;
  readonly turns: readonly BlindTurnV3[];
  readonly sensitiveTerms: readonly string[];
  readonly highRiskLabels: readonly string[];
}

export interface BlindPackageV3 {
  readonly schema: typeof BLIND_V3_SCHEMA;
  readonly seed: number;
  readonly baseEpochMs: number;
  readonly events: readonly BlindEventV3[];
}

/**
 * 逐字段投影。**白名单式**拷贝：蓝本将来新增字段不会自动进来，必须在此显式加一行。
 */
export function toBlindEventV3(event: PlannedEventV3): BlindEventV3 {
  return {
    eventId: event.eventId,
    partition: event.partition,
    familyId: event.familyId,
    channel: event.channel,
    startedAtMs: event.startedAtMs,
    endedAtMs: event.endedAtMs,
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

const PARTITIONS_V3: readonly CorpusPartitionV3[] = ['tuning-a', 'tuning-b'];

/**
 * 生成盲包。`partition` 省略＝整包；给出则只出该分区子包（A/B 物理隔离用）。
 * 非法分区值直接抛，不静默出空包。
 */
export function buildBlindPackageV3(plan: WorldPlanV3, partition?: CorpusPartitionV3): BlindPackageV3 {
  if (partition !== undefined && !PARTITIONS_V3.includes(partition)) {
    throw new IntegrityError(`盲包 partition 只接受 tuning-a|tuning-b，收到 ${String(partition)}`);
  }
  const source = partition === undefined
    ? plan.events
    : plan.events.filter((event) => event.partition === partition);
  const pkg: BlindPackageV3 = {
    schema: BLIND_V3_SCHEMA,
    seed: plan.seed,
    baseEpochMs: plan.baseEpochMs,
    events: source.map(toBlindEventV3),
  };
  // 出包即自检：产物当场过一遍违禁键扫描，不给「先出后查」留窗口。
  assertBlindPackageSafe(pkg);
  return pkg;
}

 /**
 * 自检：v3 盲包与清单的契约（脚本 fail-fast 用，不进 blind 文件本身）。
 * 同时兼容整包与分区子包（子包只校验「不超过清单对应计数」，不要求等于总量）。
 */
export function assertBlindPackageV3Shape(pkg: BlindPackageV3, manifest: WorldManifestV3): string[] {
  const errs: string[] = [];
  if (pkg.schema !== BLIND_V3_SCHEMA) errs.push(`盲包 schema=${String(pkg.schema)}`);
  if (manifest.schema !== WORLD_SCHEMA_V3) errs.push(`清单 schema=${String(manifest.schema)}`);
  if (pkg.seed !== SEED_V3 || manifest.seed !== SEED_V3) errs.push('seed 与预注册不一致');
  if (pkg.events.length === 0) errs.push('盲包零事件');
  if (pkg.events.length > manifest.totalEvents) errs.push(`盲包事件数 ${pkg.events.length} 超过清单总量`);
  if (manifest.partitionEvents['tuning-a'] + manifest.partitionEvents['tuning-b'] !== manifest.totalEvents) {
    errs.push('清单分区计数不自洽');
  }

  const counted: Record<CorpusPartitionV3, number> = { 'tuning-a': 0, 'tuning-b': 0 };
  const families = new Set<string>();
  for (const event of pkg.events) {
    if (!PARTITIONS_V3.includes(event.partition)) errs.push(`${event.eventId} 分区非法 ${String(event.partition)}`);
    else counted[event.partition] += 1;
    families.add(event.familyId);

    const expectedTurns = event.highRiskLabels.length > 0 ? 7 : 6;
    if (event.turns.length !== expectedTurns) errs.push(`${event.eventId} turns ${event.turns.length} ≠ ${expectedTurns}`);
    for (const turn of event.turns) {
      if (turn.offsetMinutes % 12 !== 0) errs.push(`${event.eventId} offsetMinutes 非 12 的倍数`);
      if (turn.speaker !== 'user') errs.push(`${event.eventId} 说话人非 user`);
    }
  }
  for (const partition of PARTITIONS_V3) {
    if (counted[partition] > manifest.partitionEvents[partition]) {
      errs.push(`${partition} 事件数 ${counted[partition]} 超过清单 ${manifest.partitionEvents[partition]}`);
    }
  }
  if (families.size * FAMILY_SIZE_V3 !== pkg.events.length) errs.push('族数与事件数不配套');
  if (manifest.familyCount !== FAMILY_COUNT_V3) errs.push(`清单族数 ${manifest.familyCount} ≠ ${FAMILY_COUNT_V3}`);
  if (manifest.totalEvents !== TOTAL_EVENT_COUNT_V3) errs.push(`清单总量 ${manifest.totalEvents} ≠ ${TOTAL_EVENT_COUNT_V3}`);
  if (manifest.reusedDetailWords.length !== 30) errs.push(`复用词 ${manifest.reusedDetailWords.length} ≠ 30`);
  if (manifest.collisionWords.length !== COLLIDE_WORDS_V3.length) {
    errs.push(`撞词表 ${manifest.collisionWords.length} ≠ ${COLLIDE_WORDS_V3.length}`);
  }
  for (const entry of manifest.collisionWords) {
    if (!COLLIDE_WORDS_V3.includes(entry.word)) errs.push(`撞词表含非设计词「${entry.word}」`);
    if (entry.familyIds.length === 0) errs.push(`撞词「${entry.word}」无承载族`);
    for (const familyId of entry.familyIds) {
      if (!/^v3-[ab]-f\d{3}$/.test(familyId)) errs.push(`撞词「${entry.word}」映射了非法族 ${familyId}`);
    }
  }
  return errs;
}
