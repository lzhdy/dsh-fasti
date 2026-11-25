/**
 * task207 红测：v3 调参卷独立 schema 与白名单校验器（W2-2）。
 *
 * 隔离纪律：本套类型/校验器与终判 fixtures.ts、judgment-v2 零 import 关系，调参卷不产出
 * PASSED；终判六件套白名单不受影响。校验器纯函数、零 IO，拒收任何未登记字段（防自证）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IntegrityError } from '../../src/core/errors.ts';
import {
  TUNING_V3_VERSION,
  TUNING_V3_PATTERN,
  validateTuningV3File,
  assertTuningV3SetVersion,
} from '../../src/memory/audit/tuning-fixtures-v3.ts';
import type {
  TuningV3Layer,
  TuningGoldDocV3,
  TuningDecoyDocV3,
  TuningAbstainDocV3,
  TuningClarifyDocV3,
} from '../../src/memory/audit/tuning-fixtures-v3.ts';

const V = TUNING_V3_VERSION;

function goldDoc(partial: Partial<TuningGoldDocV3['items'][number]> = {}): TuningGoldDocV3 {
  return {
    probeSetVersion: V,
    layer: 'tuning-gold',
    items: [
      {
        probeId: 'g-0001',
        bucket: 'B1',
        partitionTag: 'tuning-a',
        goldEventIds: ['syn-v3a-0001'],
        queries: ['更换水管接头怎么安排'],
        negativeSignature: 1,
        ...partial,
      },
    ],
  };
}
const decoyDoc = (partial: Partial<TuningDecoyDocV3['items'][number]> = {}): TuningDecoyDocV3 => ({
  probeSetVersion: V,
  layer: 'tuning-decoy',
  items: [
    {
      probeId: 'd-0001',
      bucket: 'B5',
      partitionTag: 'tuning-a',
      goldEventId: 'syn-v3a-0001',
      rivalEventIds: ['syn-v3a-0002', 'syn-v3a-0003'],
      density: 2,
      discriminatorQuery: '清洗和更换别搞混',
      ...partial,
    },
  ],
});
const abstainDoc = (partial: Partial<TuningAbstainDocV3['items'][number]> = {}): TuningAbstainDocV3 => ({
  probeSetVersion: V,
  layer: 'tuning-abstain',
  items: [
    { probeId: 'u-0001', bucket: 'B8', partitionTag: 'tuning-b', query: '一个完全无关的长尾问题', hardness: 'hard', goldEventId: null, ...partial },
  ],
});
const clarifyDoc = (partial: Partial<TuningClarifyDocV3['items'][number]> = {}): TuningClarifyDocV3 => ({
  probeSetVersion: V,
  layer: 'tuning-clarify',
  items: [
    { probeId: 'c-0001', bucket: 'B10', partitionTag: 'tuning-a', pairEventIds: ['syn-v3a-0001', 'syn-v3a-0002'], query: '那个续费的事', detailWord: '续费', expectedBehavior: 'clarify', ...partial },
  ],
});

const expectThrow = (fn: () => void, fragment: string): void => {
  assert.throws(fn, (err: unknown) => err instanceof IntegrityError && String((err as Error).message).includes(fragment));
};

test('TF-1 版本形态：常量匹配独立正则，且与终判 probes 形态不同名', () => {
  assert.ok(TUNING_V3_PATTERN.test('fasti-p6-tuning/v3'));
  assert.ok(TUNING_V3_PATTERN.test('fasti-p6-tuning/v10.2'));
  assert.ok(!TUNING_V3_PATTERN.test('fasti-p6-probes/v2'));
  assert.ok(!/^fasti-p6-probes/.test(TUNING_V3_VERSION));
});

test('TF-2 四类合法最小件与全字段件均通过', () => {
  validateTuningV3File(goldDoc(), 'tuning-gold');
  validateTuningV3File(decoyDoc(), 'tuning-decoy');
  validateTuningV3File(abstainDoc(), 'tuning-abstain');
  validateTuningV3File(clarifyDoc(), 'tuning-clarify');
  // 全字段金标（ed 标注 + 命中字段规格 + 高危 + 构造层）。
  validateTuningV3File(
    goldDoc({
      bucket: 'B6',
      constructionLayer: 'S2',
      edit: { site: 'tail', distance: 1 },
      hitFieldSpec: { hitFields: 2, strongFields: 0 },
      highRiskLabel: 'promise',
    }),
    'tuning-gold',
  );
});

test('TF-3 版本/层/容器形状错误被拒', () => {
  expectThrow(() => validateTuningV3File(null, 'tuning-gold'), 'JSON 对象');
  expectThrow(() => validateTuningV3File({ probeSetVersion: 'fasti-p6-probes/v2', layer: 'tuning-gold', items: [] }, 'tuning-gold'), 'probeSetVersion');
  expectThrow(() => validateTuningV3File(goldDoc({} as never), 'tuning-decoy'), 'layer');
  expectThrow(() => validateTuningV3File({ probeSetVersion: V, layer: 'tuning-gold', items: 'x' }, 'tuning-gold'), 'items 须为数组');
});

test('TF-4 白名单：任何未登记字段一律拒收（四类分别验）', () => {
  const g = goldDoc(); (g.items[0]! as unknown as Record<string, unknown>).sneaky = 'x';
  expectThrow(() => validateTuningV3File(g, 'tuning-gold'), '非法字段');
  const d = decoyDoc(); (d.items[0]! as unknown as Record<string, unknown>).body = '正文泄漏';
  expectThrow(() => validateTuningV3File(d, 'tuning-decoy'), '非法字段');
  const u = abstainDoc(); (u.items[0]! as unknown as Record<string, unknown>).rawText = 'x';
  expectThrow(() => validateTuningV3File(u, 'tuning-abstain'), '非法字段');
  const c = clarifyDoc(); (c.items[0]! as unknown as Record<string, unknown>).summary = 'x';
  expectThrow(() => validateTuningV3File(c, 'tuning-clarify'), '非法字段');
});

test('TF-5 金标：单金标恰好 1 个；B3/B11 多金标必须 ≥2，反之普通桶拒绝多金标', () => {
  validateTuningV3File(goldDoc({ bucket: 'B3', goldEventIds: ['syn-v3a-0001', 'syn-v3a-0009'] }), 'tuning-gold');
  validateTuningV3File(goldDoc({ bucket: 'B11', goldEventIds: ['syn-v3a-0001', 'syn-v3a-0009', 'syn-v3a-0010'] }), 'tuning-gold');
  expectThrow(() => validateTuningV3File(goldDoc({ bucket: 'B3', goldEventIds: ['syn-v3a-0001'] }), 'tuning-gold'), '多金标桶');
  expectThrow(() => validateTuningV3File(goldDoc({ bucket: 'B1', goldEventIds: ['a', 'b'] }), 'tuning-gold'), '单金标桶');
  expectThrow(() => validateTuningV3File(goldDoc({ goldEventIds: [] }), 'tuning-gold'), '至少 1');
  expectThrow(() => validateTuningV3File(goldDoc({ goldEventIds: ['x', 'x'] }), 'tuning-gold'), '互异');
});

test('TF-6 诱饵：density 必须 ∈{1,2,5,10} 且与 rivalEventIds 长度严格相等', () => {
  validateTuningV3File(decoyDoc({ density: 1, rivalEventIds: ['syn-v3a-0002'] }), 'tuning-decoy');
  validateTuningV3File(decoyDoc({ density: 10, rivalEventIds: Array.from({ length: 10 }, (_, i) => `syn-v3a-000${i + 2}`) }), 'tuning-decoy');
  expectThrow(() => validateTuningV3File(decoyDoc({ density: 3 as never }), 'tuning-decoy'), 'density');
  expectThrow(() => validateTuningV3File(decoyDoc({ density: 5, rivalEventIds: ['a', 'b'] }), 'tuning-decoy'), '一致');
  expectThrow(() => validateTuningV3File(decoyDoc({ rivalEventIds: ['only'] }), 'tuning-decoy'), 'density');
});

test('TF-7 弃权 hard/soft 分级与金标可空性', () => {
  validateTuningV3File(abstainDoc({ hardness: 'soft', goldEventId: 'syn-v3b-0007' }), 'tuning-abstain');
  expectThrow(() => validateTuningV3File(abstainDoc({ hardness: 'maybe' as never }), 'tuning-abstain'), 'hardness');
  expectThrow(() => validateTuningV3File(abstainDoc({ goldEventId: '' }), 'tuning-abstain'), 'null 或非空');
});

test('TF-8 澄清：至少 2 配对、expectedBehavior 恒 clarify', () => {
  expectThrow(() => validateTuningV3File(clarifyDoc({ pairEventIds: ['only-one'] }), 'tuning-clarify'), '至少 2');
  expectThrow(() => validateTuningV3File(clarifyDoc({ expectedBehavior: 'commit' as never }), 'tuning-clarify'), 'clarify');
});

test('TF-9 桶/分区/层标/负样本签名/ed 标注/命中字段/高危枚举校验', () => {
  expectThrow(() => validateTuningV3File(goldDoc({ bucket: 'B99' as never }), 'tuning-gold'), 'bucket');
  expectThrow(() => validateTuningV3File(goldDoc({ partitionTag: 'sealed' as never }), 'tuning-gold'), 'partitionTag');
  expectThrow(() => validateTuningV3File(goldDoc({ constructionLayer: 'S9' as never }), 'tuning-gold'), 'constructionLayer');
  expectThrow(() => validateTuningV3File(goldDoc({ negativeSignature: 0 }), 'tuning-gold'), 'negativeSignature');
  expectThrow(() => validateTuningV3File(goldDoc({ negativeSignature: 9 }), 'tuning-gold'), 'negativeSignature');
  expectThrow(() => validateTuningV3File(goldDoc({ edit: { site: 'middle' as never, distance: 1 } }), 'tuning-gold'), 'site');
  expectThrow(() => validateTuningV3File(goldDoc({ edit: { site: 'head', distance: 3 as never } }), 'tuning-gold'), 'distance');
  expectThrow(() => validateTuningV3File(goldDoc({ hitFieldSpec: { hitFields: -1, strongFields: 0 } }), 'tuning-gold'), 'hitFields');
  expectThrow(() => validateTuningV3File(goldDoc({ highRiskLabel: 'bogus' as never }), 'tuning-gold'), 'highRiskLabel');
  // B1-B12 全部合法枚举（多金标桶 B3/B11 配 2 金标，其余单金标）。
  for (const b of ['B1','B2','B3','B4','B5','B6','B7','B8','B9','B10','B11','B12'] as const) {
    const multi = b === 'B3' || b === 'B11';
    validateTuningV3File(goldDoc({ bucket: b, goldEventIds: multi ? ['syn-v3a-0001', 'syn-v3a-0002'] : ['syn-v3a-0001'] }), 'tuning-gold');
  }
});

test('TF-10 跨文件版本一致性助手：版本不一致即拒', () => {
  const docs: Record<TuningV3Layer, unknown> = {
    'tuning-gold': goldDoc(),
    'tuning-decoy': decoyDoc(),
    'tuning-abstain': abstainDoc(),
    'tuning-clarify': clarifyDoc(),
  };
  assert.doesNotThrow(() => assertTuningV3SetVersion(
    Object.values(docs) as { readonly probeSetVersion: string }[],
  ));
  const mixed: { readonly probeSetVersion: string }[] = [
    { probeSetVersion: V },
    { probeSetVersion: 'fasti-p6-tuning/v4' },
  ];
  expectThrow(() => assertTuningV3SetVersion(mixed), '不一致');
});
