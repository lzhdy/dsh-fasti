/**
 * 统一调参新卷 · v3 调参夹具独立 schema 与白名单校验器（W2-2）。
 *
 * 隔离定位（201 号决策二）：
 *  - 本文件与终判 `fixtures.ts`、`judgment-v2.ts` 零 import 关系，v1/v2 终判白名单一字不动；
 *  - 调参卷只服务候选谓词标定，不产出 PASSED，权威终判权仍在冻结 v2 卷；
 *  - 纯函数、零 IO、零时钟、零随机，模块顶层仅字面量，不 import store/门面。
 *
 * 相对终判 schema 的新表达力：
 *  - 单/多金标统一为 goldEventIds 数组（B3/B11 多意图题 ≥2 金标）；
 *  - 诱饵 rivalEventIds 变长且 density 显式 ∈{1,2,5,10}（B5 密度梯度）；
 *  - 弃权带 hard/soft 分级（197-B3 预研原因码）；
 *  - 桶标 B1–B12、负样本整数签名 N1–N8、编辑距离边界/命中字段规格等标定标注。
 * 任何未登记字段一律 IntegrityError，沿用终判卷「夹具只含 id 与标注、拒收正文」的防自证纪律。
 */

import { IntegrityError } from '../../core/errors.ts';

/** v3 调参卷版本形态，独立于终判 fasti-p6-probes/vN。 */
export const TUNING_V3_VERSION = 'fasti-p6-tuning/v3';
export const TUNING_V3_PATTERN = /^fasti-p6-tuning\/v\d+(\.\d+)*$/;

export type TuningV3Layer = 'tuning-gold' | 'tuning-decoy' | 'tuning-abstain' | 'tuning-clarify';

export const TUNING_V3_LAYERS: readonly TuningV3Layer[] = [
  'tuning-gold',
  'tuning-decoy',
  'tuning-abstain',
  'tuning-clarify',
];

/** 12 个混淆桶（200 号立项书 B1–B12）。 */
export const TUNING_BUCKETS_V3 = [
  'B1', 'B2', 'B3', 'B4', 'B5', 'B6',
  'B7', 'B8', 'B9', 'B10', 'B11', 'B12',
] as const;
export type TuningBucketV3 = (typeof TUNING_BUCKETS_V3)[number];

/** 多意图桶：金标必须 ≥2 个事件。 */
export const MULTI_GOLD_BUCKETS_V3: readonly TuningBucketV3[] = ['B3', 'B11'];

export const TUNING_PARTITIONS_V3 = ['tuning-a', 'tuning-b'] as const;
export type TuningPartitionV3 = (typeof TUNING_PARTITIONS_V3)[number];

export const CONSTRUCTION_LAYERS_V3 = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const;
export type ConstructionLayerV3 = (typeof CONSTRUCTION_LAYERS_V3)[number];

export const HIGH_RISK_LABELS_V3 = ['strong', 'promise', 'date', 'verbatim', 'negation'] as const;
export type HighRiskLabelV3 = (typeof HIGH_RISK_LABELS_V3)[number];

export const EDIT_SITES_V3 = ['head', 'tail', 'internal'] as const;
export type EditSiteV3 = (typeof EDIT_SITES_V3)[number];

export const DECOY_DENSITIES_V3 = [1, 2, 5, 10] as const;
export type DecoyDensityV3 = (typeof DECOY_DENSITIES_V3)[number];

export const ABSTAIN_HARDNESS_V3 = ['hard', 'soft'] as const;
export type AbstainHardnessV3 = (typeof ABSTAIN_HARDNESS_V3)[number];

/** B6 编辑距离边界：0/1/2（乙的无锚 ed≤2 进门已驳回，此处仅作题面标注不授判据）。 */
export interface EditSpecV3 {
  readonly site: EditSiteV3;
  readonly distance: 0 | 1 | 2;
}

/** B10/B12 命中字段规格：非负整数且 strongFields 不得超过 hitFields。 */
export interface HitFieldSpecV3 {
  readonly hitFields: number;
  readonly strongFields: number;
}

interface CommonMeta {
  readonly probeId: string;
  readonly bucket: TuningBucketV3;
  readonly partitionTag: TuningPartitionV3;
  readonly negativeSignature?: number;
  readonly highRiskLabel?: HighRiskLabelV3;
}

export interface TuningGoldItemV3 extends CommonMeta {
  readonly goldEventIds: readonly string[];
  readonly queries: readonly string[];
  readonly constructionLayer?: ConstructionLayerV3;
  readonly edit?: EditSpecV3;
  readonly hitFieldSpec?: HitFieldSpecV3;
}

export interface TuningDecoyItemV3 extends CommonMeta {
  readonly goldEventId: string;
  readonly rivalEventIds: readonly string[];
  readonly density: DecoyDensityV3;
  readonly discriminatorQuery: string;
}

export interface TuningAbstainItemV3 extends CommonMeta {
  readonly query: string;
  readonly hardness: AbstainHardnessV3;
  /** null＝库内无金标（unanswerable）；非空＝noise 档带一真卡。 */
  readonly goldEventId: string | null;
}

export interface TuningClarifyItemV3 extends CommonMeta {
  readonly pairEventIds: readonly string[];
  readonly query: string;
  readonly detailWord?: string;
  readonly expectedBehavior: 'clarify';
}

interface DocEnvelope {
  readonly probeSetVersion: string;
  readonly layer: TuningV3Layer;
  readonly items: readonly unknown[];
}

export interface TuningGoldDocV3 extends DocEnvelope {
  readonly layer: 'tuning-gold';
  readonly items: readonly TuningGoldItemV3[];
}
export interface TuningDecoyDocV3 extends DocEnvelope {
  readonly layer: 'tuning-decoy';
  readonly items: readonly TuningDecoyItemV3[];
}
export interface TuningAbstainDocV3 extends DocEnvelope {
  readonly layer: 'tuning-abstain';
  readonly items: readonly TuningAbstainItemV3[];
}
export interface TuningClarifyDocV3 extends DocEnvelope {
  readonly layer: 'tuning-clarify';
  readonly items: readonly TuningClarifyItemV3[];
}

const GOLD_KEYS = [
  'probeId', 'bucket', 'partitionTag', 'negativeSignature', 'highRiskLabel',
  'goldEventIds', 'queries', 'constructionLayer', 'edit', 'hitFieldSpec',
] as const;
const DECOY_KEYS = [
  'probeId', 'bucket', 'partitionTag', 'negativeSignature', 'highRiskLabel',
  'goldEventId', 'rivalEventIds', 'density', 'discriminatorQuery',
] as const;
const ABSTAIN_KEYS = [
  'probeId', 'bucket', 'partitionTag', 'negativeSignature', 'highRiskLabel',
  'query', 'hardness', 'goldEventId',
] as const;
const CLARIFY_KEYS = [
  'probeId', 'bucket', 'partitionTag', 'negativeSignature', 'highRiskLabel',
  'pairEventIds', 'query', 'detailWord', 'expectedBehavior',
] as const;
const EDIT_KEYS = ['site', 'distance'] as const;
const HIT_FIELD_KEYS = ['hitFields', 'strongFields'] as const;

function fail(fileLabel: string, index: number, reason: string): never {
  throw new IntegrityError(`调参夹具 ${fileLabel} 条目 ${index + 1}：${reason}`);
}

function asRecord(value: unknown, label: string, index: number): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(label, index, '须为对象');
  return value as Record<string, unknown>;
}

function checkKeys(item: Record<string, unknown>, allowed: readonly string[], label: string, index: number): void {
  for (const key of Object.keys(item)) {
    if (!allowed.includes(key)) fail(label, index, `非法字段 ${key}（只允许 id 与标注，拒收正文/多余字段）`);
  }
}

function nonEmptyString(value: unknown, key: string, label: string, index: number): string {
  if (typeof value !== 'string' || value.length === 0) fail(label, index, `${key} 须为非空字符串`);
  return value as string;
}

function nonEmptyStringArray(value: unknown, key: string, label: string, index: number): string[] {
  if (!Array.isArray(value)) fail(label, index, `${key} 须为数组`);
  return value.map((element, i) => {
    if (typeof element !== 'string' || element.length === 0) fail(label, index, `${key}[${i}] 须为非空字符串`);
    return element;
  });
}

function enumOf<T extends string>(value: unknown, allowed: readonly T[], key: string, label: string, index: number): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(label, index, `${key} 须为枚举 {${allowed.join(',')}} 之一`);
  }
  return value as T;
}

function validateCommonMeta(item: Record<string, unknown>, label: string, index: number): void {
  nonEmptyString(item['probeId'], 'probeId', label, index);
  enumOf(item['bucket'], TUNING_BUCKETS_V3, 'bucket', label, index);
  enumOf(item['partitionTag'], TUNING_PARTITIONS_V3, 'partitionTag', label, index);
  if (item['negativeSignature'] !== undefined) {
    const n = item['negativeSignature'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 8) {
      fail(label, index, 'negativeSignature 须为 1..8 整数');
    }
  }
  if (item['highRiskLabel'] !== undefined) {
    enumOf(item['highRiskLabel'], HIGH_RISK_LABELS_V3, 'highRiskLabel', label, index);
  }
}

function assertDistinct(values: readonly string[], key: string, label: string, index: number): void {
  if (new Set(values).size !== values.length) fail(label, index, `${key} 须互异`);
}

function validateGoldItem(raw: unknown, label: string, index: number): void {
  const item = asRecord(raw, label, index);
  checkKeys(item, GOLD_KEYS, label, index);
  validateCommonMeta(item, label, index);

  const golds = nonEmptyStringArray(item['goldEventIds'], 'goldEventIds', label, index);
  if (golds.length < 1) fail(label, index, 'goldEventIds 至少 1 个金标');
  assertDistinct(golds, 'goldEventIds', label, index);
  const bucket = item['bucket'] as TuningBucketV3;
  const isMulti = MULTI_GOLD_BUCKETS_V3.includes(bucket);
  if (isMulti && golds.length < 2) fail(label, index, `多金标桶 ${bucket} 的 goldEventIds 必须 ≥2`);
  if (!isMulti && golds.length !== 1) fail(label, index, `单金标桶 ${bucket} 的 goldEventIds 必须恰为 1`);

  const queries = nonEmptyStringArray(item['queries'], 'queries', label, index);
  if (queries.length < 1) fail(label, index, 'queries 至少 1 条');

  if (item['constructionLayer'] !== undefined) {
    enumOf(item['constructionLayer'], CONSTRUCTION_LAYERS_V3, 'constructionLayer', label, index);
  }

  if (item['edit'] !== undefined) {
    const edit = asRecord(item['edit'], label, index);
    checkKeys(edit, EDIT_KEYS, `${label}.edit`, index);
    enumOf(edit['site'], EDIT_SITES_V3, 'edit.site', label, index);
    const dist = edit['distance'];
    if (dist !== 0 && dist !== 1 && dist !== 2) fail(label, index, 'edit.distance 须为 0|1|2');
  }

  if (item['hitFieldSpec'] !== undefined) {
    const spec = asRecord(item['hitFieldSpec'], label, index);
    checkKeys(spec, HIT_FIELD_KEYS, `${label}.hitFieldSpec`, index);
    const { hitFields, strongFields } = spec as { hitFields?: unknown; strongFields?: unknown };
    if (typeof hitFields !== 'number' || !Number.isInteger(hitFields) || hitFields < 0) {
      fail(label, index, 'hitFieldSpec.hitFields 须为非负整数');
    }
    if (typeof strongFields !== 'number' || !Number.isInteger(strongFields) || strongFields < 0) {
      fail(label, index, 'hitFieldSpec.strongFields 须为非负整数');
    }
    if ((strongFields as number) > (hitFields as number)) {
      fail(label, index, 'hitFieldSpec.strongFields 不得大于 hitFields');
    }
  }
}

function validateDecoyItem(raw: unknown, label: string, index: number): void {
  const item = asRecord(raw, label, index);
  checkKeys(item, DECOY_KEYS, label, index);
  validateCommonMeta(item, label, index);

  nonEmptyString(item['goldEventId'], 'goldEventId', label, index);
  const rivals = nonEmptyStringArray(item['rivalEventIds'], 'rivalEventIds', label, index);
  assertDistinct(rivals, 'rivalEventIds', label, index);
  if (rivals.includes(item['goldEventId'] as string)) fail(label, index, 'rivalEventIds 不得包含 goldEventId');

  const density = item['density'];
  if (typeof density !== 'number' || !(DECOY_DENSITIES_V3 as readonly number[]).includes(density)) {
    fail(label, index, 'density 须为 {1,2,5,10} 之一');
  }
  if (density !== rivals.length) fail(label, index, 'density 须与 rivalEventIds 长度一致');

  nonEmptyString(item['discriminatorQuery'], 'discriminatorQuery', label, index);
}

function validateAbstainItem(raw: unknown, label: string, index: number): void {
  const item = asRecord(raw, label, index);
  checkKeys(item, ABSTAIN_KEYS, label, index);
  validateCommonMeta(item, label, index);

  nonEmptyString(item['query'], 'query', label, index);
  enumOf(item['hardness'], ABSTAIN_HARDNESS_V3, 'hardness', label, index);
  const gold = item['goldEventId'];
  if (gold !== null && (typeof gold !== 'string' || gold.length === 0)) {
    fail(label, index, 'goldEventId 须为 null 或非空字符串');
  }
}

function validateClarifyItem(raw: unknown, label: string, index: number): void {
  const item = asRecord(raw, label, index);
  checkKeys(item, CLARIFY_KEYS, label, index);
  validateCommonMeta(item, label, index);

  const pairs = nonEmptyStringArray(item['pairEventIds'], 'pairEventIds', label, index);
  if (pairs.length < 2) fail(label, index, 'pairEventIds 至少 2 个配对事件');
  assertDistinct(pairs, 'pairEventIds', label, index);
  nonEmptyString(item['query'], 'query', label, index);
  if (item['detailWord'] !== undefined) nonEmptyString(item['detailWord'], 'detailWord', label, index);
  if (item['expectedBehavior'] !== 'clarify') fail(label, index, 'expectedBehavior 须恒为 "clarify"');
}

/**
 * 严格校验一份 v3 调参夹具文件：版本正则 / layer 相符 / items 数组 / 逐条白名单形状。
 * 坏形状一律抛 IntegrityError（带文件标签与条目号），不做任何容错回填。
 */
export function validateTuningV3File(raw: unknown, expectedLayer: TuningV3Layer): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IntegrityError('调参夹具：须为 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;
  const version = obj['probeSetVersion'];
  if (typeof version !== 'string' || !TUNING_V3_PATTERN.test(version)) {
    throw new IntegrityError('调参夹具：probeSetVersion 须匹配 fasti-p6-tuning/v<N>');
  }
  if (obj['layer'] !== expectedLayer) {
    throw new IntegrityError(`调参夹具：layer 须为 ${expectedLayer}`);
  }
  const items = obj['items'];
  if (!Array.isArray(items)) throw new IntegrityError(`调参夹具 ${expectedLayer}：items 须为数组`);

  items.forEach((item, index) => {
    if (expectedLayer === 'tuning-gold') validateGoldItem(item, expectedLayer, index);
    else if (expectedLayer === 'tuning-decoy') validateDecoyItem(item, expectedLayer, index);
    else if (expectedLayer === 'tuning-abstain') validateAbstainItem(item, expectedLayer, index);
    else validateClarifyItem(item, expectedLayer, index);
  });
}

/** 跨文件版本一致性：四份/若干份调参文档必须同属一个 v3 版本，否则拒绝装配。 */
export function assertTuningV3SetVersion(docs: readonly { readonly probeSetVersion?: unknown }[]): void {
  for (const doc of docs) {
    if (doc.probeSetVersion !== TUNING_V3_VERSION) {
      throw new IntegrityError(
        `调参夹具跨文件 probeSetVersion 不一致：期望 ${TUNING_V3_VERSION}，实得 ${String(doc.probeSetVersion)}`,
      );
    }
  }
}
