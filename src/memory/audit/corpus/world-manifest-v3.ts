/**
 * 统一调参新卷 · v3 世界清单（W2-3）。
 *
 * 与 v2 的 `buildWorldManifestV2` 并列、互不 import：v3 是**纯调参卷**（无 sealed 分区），
 * 故清单只出调参侧口径——A/B 两分区计数、高危盘点、复用词、撞词族映射。
 *
 * 只给总量与盘点，不给族覆盖/周桶/唯一度等结构统计：那些数字会反向缩小出题人的搜索空间
 * （Q3 裁定，v2 立项沿用）。v3 盲包投影（blind-package-v3）是另一件，本模块不产出任何盲包。
 */

import type { HighRiskLabelV3, WorldPlanV3 } from './world-plan-v3.ts';
import { COLLIDE_WORDS_V3, FAMILY_COUNT_V3, WORLD_SCHEMA_V3 } from './world-plan-v3.ts';

/** 五类高危（与蓝本内部常量同序；蓝本未导出该常量，此处按类型收窄本地声明，改序会被下方类型与测试同时钉住）。 */
const HIGH_RISK_LABELS_V3: readonly HighRiskLabelV3[] = ['strong', 'promise', 'date', 'verbatim', 'negation'];

export interface WorldManifestV3 {
  readonly schema: typeof WORLD_SCHEMA_V3;
  readonly seed: number;
  readonly baseEpochMs: number;
  readonly referenceNowMs: number;
  readonly totalEvents: number;
  readonly familyCount: number;
  readonly partitionEvents: Readonly<Record<'tuning-a' | 'tuning-b', number>>;
  readonly highRiskInventory: readonly { readonly eventId: string; readonly label: HighRiskLabelV3 }[];
  readonly highRiskByLabel: Readonly<Record<HighRiskLabelV3, number>>;
  /** 30 个受控复用细节词（原样字符串），每词恰跨 2 个 A 区族，供排序压力题出题。 */
  readonly reusedDetailWords: readonly string[];
  /** 24 个设计撞词及其承载族（只给族 id，不给事件 id、不给要点）。 */
  readonly collisionWords: readonly { readonly word: string; readonly familyIds: readonly string[] }[];
}

/**
 * 复用词：同一细节词出现在 ≥2 个族的专属点（keyPoints[1]/[2]）即受控复用产物。
 * 直接扫蓝本事件而非复用计划，避免依赖 `DETAIL_POOL_V3` 这类内部槽位算术——
 * 若哪天复用机制变了而清单没跟上，这里会自然给出不同数字而不是静默漂移。
 */
function reusedDetailWordsOf(plan: WorldPlanV3): string[] {
  const familiesByWord = new Map<string, Set<string>>();
  for (const event of plan.events) {
    for (const word of [event.keyPoints[1]!, event.keyPoints[2]!]) {
      const set = familiesByWord.get(word) ?? new Set<string>();
      set.add(event.familyId);
      familiesByWord.set(word, set);
    }
  }
  return [...familiesByWord.entries()]
    .filter(([, families]) => families.size >= 2)
    .map(([word]) => word);
}

export function buildWorldManifestV3(plan: WorldPlanV3): WorldManifestV3 {
  const highRiskInventory = plan.events.flatMap((event) =>
    event.highRiskLabels.map((label) => ({ eventId: event.eventId, label })),
  );
  const highRiskByLabel = HIGH_RISK_LABELS_V3.reduce<Record<HighRiskLabelV3, number>>(
    (acc, label) => {
      acc[label] = highRiskInventory.filter((entry) => entry.label === label).length;
      return acc;
    },
    { strong: 0, promise: 0, date: 0, verbatim: 0, negation: 0 },
  );

  return {
    schema: plan.schema,
    seed: plan.seed,
    baseEpochMs: plan.baseEpochMs,
    referenceNowMs: plan.referenceNowMs,
    totalEvents: plan.events.length,
    familyCount: FAMILY_COUNT_V3,
    partitionEvents: {
      'tuning-a': plan.events.filter((event) => event.partition === 'tuning-a').length,
      'tuning-b': plan.events.filter((event) => event.partition === 'tuning-b').length,
    },
    highRiskInventory,
    highRiskByLabel,
    reusedDetailWords: reusedDetailWordsOf(plan),
    collisionWords: COLLIDE_WORDS_V3.map((word) => ({
      word,
      // keyPoints[0] 是族共享点（撞词＋后缀），前 2 码点即撞词；只取族 id，去重递增。
      familyIds: plan.events
        .filter((event) => Array.from(event.keyPoints[0]!).slice(0, 2).join('') === word)
        .map((event) => event.familyId)
        .filter((familyId, index, arr) => arr.indexOf(familyId) === index)
        .sort(),
    })),
  };
}
