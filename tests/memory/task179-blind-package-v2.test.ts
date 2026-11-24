/**
 * task179 红测 W2：v2 盲包投影（`blind-package-v2.ts`）。
 *
 * 要钉死的是「出题人可见面」的边界，而不是漂亮与否：
 *  1. 每事件对外键恰好 10 个，`hasRef`/`keyPoints` 物理上不存在（白名单投影，不靠事后拦）；
 *  2. 序列化产物仍能过 `assertBlindPackageSafe`，且全文不含任何 key point 字符串；
 *  3. #179 新增的四类违禁键真的会抛（否则表只是装饰）；
 *  4. manifest 必须给 18 个复用词（否则出题书 §7.3/§7.4 那 54 条题出不来），
 *     但**不得**给结构统计（否则反向缩小出题人搜索空间）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IntegrityError } from '../../src/core/errors.ts';
import { assertBlindPackageSafe, BLIND_FORBIDDEN_KEYS } from '../../src/memory/audit/corpus/blind-package.ts';
import {
  assertBlindPackageV2Shape,
  buildBlindPackageV2,
  buildWorldManifestV2,
  toBlindEventV2,
} from '../../src/memory/audit/corpus/blind-package-v2.ts';
import { buildWorldV2, reusedDetailWordsV2 } from '../../src/memory/audit/corpus/world-plan-v2.ts';

const plan = buildWorldV2();
const blind = buildBlindPackageV2(plan);
const manifest = buildWorldManifestV2(plan);

test('B1 白名单投影：每事件对外键恰好 10 个，hasRef/keyPoints 物理不存在', () => {
  assert.equal(blind.events.length, 500);
  const EXPECTED = [
    'eventId', 'partition', 'familyId', 'channel', 'startedAtMs',
    'endedAtMs', 'summary', 'turns', 'sensitiveTerms', 'highRiskLabels',
  ];
  for (const event of blind.events) {
    assert.deepEqual(Object.keys(event).sort(), [...EXPECTED].sort(), `${event.eventId} 对外键集不符`);
    assert.equal('hasRef' in event, false, 'hasRef 泄漏＝S5 金标位置整包外泄');
    assert.equal('keyPoints' in event, false, 'keyPoints 泄漏');
  }
  // 蓝本侧确实有 hasRef，投影后消失（证明是投影白名单在起作用，而非蓝本没有）。
  assert.equal(plan.events.filter((e) => e.hasRef).length, 160);
});

test('B2 序列化后安全门仍过，且全文不含任何 key point 字符串', () => {
  const text = JSON.stringify(blind);
  assert.doesNotThrow(() => assertBlindPackageSafe(blind));
  assert.doesNotThrow(() => assertBlindPackageSafe(JSON.parse(text) as unknown), '落盘再读回也必须过');
  // 细节词允许出现在原话里（那是题面本身），但 keyPoints 这个字段名不得出现。
  assert.equal(text.includes('"keyPoints"'), false);
  // 族共享点：由「撞词+后缀」拼成，原话里从不整串出现 → 必须一个都不在盲包里。
  const familyPoints = new Set(plan.events.map((e) => e.keyPoints[0]!));
  for (const fp of familyPoints) assert.equal(text.includes(fp), false, `族共享点「${fp}」出现在盲包（等于送族标签）`);
});

test('B3 新增违禁键真的会抛：hasRef / reusePlan / familyPoint / details 各一例', () => {
  for (const key of ['hasRef', 'reusePlan', 'familyPoint', 'details', 'noisePlan']) {
    assert.ok(BLIND_FORBIDDEN_KEYS.includes(key), `${key} 未进违禁键表`);
    const polluted = structuredClone(blind) as unknown as Record<string, unknown>;
    (polluted.events as Record<string, unknown>[])[3]![key] = true;
    assert.throws(() => assertBlindPackageSafe(polluted), IntegrityError, `塞入 ${key} 未抛`);
  }
  // 深层嵌套也拦得住。
  const deep = structuredClone(blind) as unknown as Record<string, unknown>;
  ((deep.events as Record<string, unknown>[])[0]!.turns as Record<string, unknown>[])[0]!.details = ['x'];
  assert.throws(() => assertBlindPackageSafe(deep), IntegrityError, '深层嵌套未拦');
});

test('B4 manifest：总量/分区/高危 10 条/复用词 18 且与蓝本一致', () => {
  assert.equal(manifest.totalEvents, 500);
  assert.equal(manifest.sealedEvents, 400);
  assert.equal(manifest.tuningEvents, 100);
  assert.equal(manifest.highRiskInventory.length, 10, '五类各 2 个事件 = 10 条清单');
  assert.deepEqual(
    new Set(manifest.highRiskInventory.map((r) => r.label)).size,
    5,
  );
  assert.equal(manifest.reusedDetailWords.length, 18);
  assert.deepEqual(manifest.reusedDetailWords, reusedDetailWordsV2(plan));
  assert.equal(new Set(manifest.reusedDetailWords).size, 18, '18 个复用词必须互不相同');
  for (const event of manifest.highRiskInventory) {
    assert.match(event.eventId, /^syn-sealed-/, '高危只落在封存事件');
  }
});

test('B5 高危可见性：盲包里高危 7 条 turns、非高危 6 条，且第 7 条含高危话头', () => {
  const hr = blind.events.filter((e) => e.highRiskLabels.length > 0);
  assert.equal(hr.length, 10);
  for (const event of hr) {
    assert.equal(event.turns.length, 7);
    assert.ok(event.turns[6]!.rawText.length > 10, '第 7 条须是真正的高危话头，不是占位');
  }
  const rest = blind.events.filter((e) => e.highRiskLabels.length === 0);
  for (const event of rest) assert.equal(event.turns.length, 6, `${event.eventId} 非高危应 6 条`);
});

test('B6 manifest 不得含结构统计（族覆盖/周桶/唯一度），只给复用词与清单', () => {
  const text = JSON.stringify(manifest);
  for (const forbidden of ['collideFamilies', 'calendarWeeks', 'uniqueDetails', 'reusedDetails', 'refCandidates', 'violations']) {
    assert.equal(text.includes(forbidden), false, `manifest 泄漏结构统计「${forbidden}」`);
  }
  assert.deepEqual(Object.keys(manifest).sort(), [
    'baseEpochMs', 'highRiskInventory', 'referenceNowMs', 'reusedDetailWords',
    'schema', 'sealedEvents', 'seed', 'totalEvents', 'tuningEvents',
  ]);
  assert.deepEqual(assertBlindPackageV2Shape(blind, manifest), []);
});

test('B7 投影保真：盲包 turns 与蓝本逐字一致（出题人看到的就是原话）', () => {
  const sample = plan.events[42]!;
  const projected = toBlindEventV2(sample);
  assert.deepEqual(projected.turns, sample.turns.map((t) => ({ ...t })));
  assert.equal(projected.summary, sample.summary);
  assert.equal(projected.endedAtMs, sample.endedMs);
});
