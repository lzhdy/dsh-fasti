/**
 * task210 红测：v3 出题盲包（出题人可见面）与安全门。
 *
 * 钉四件事：
 *  1. 逐字段白名单投影——蓝本的答案侧字段（keyPoints/hasRef/reusePlan）物理不进盲包；
 *  2. 同一张违禁键表（v1 的 assertBlindPackageSafe）对 v3 产物零命中；
 *  3. 契约闸：schema/seed/分区/轮次/偏移/族数不自洽必须逐条报出；
 *  4. 分区过滤：可整包、可单出 A 或 B（A/B 物理隔离留待发卷环节决定，生成器先支持）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertBlindPackageSafe, BLIND_FORBIDDEN_KEYS } from '../../src/memory/audit/corpus/blind-package.ts';
import {
  assertBlindPackageV3Shape,
  buildBlindPackageV3,
  toBlindEventV3,
} from '../../src/memory/audit/corpus/blind-package-v3.ts';
import {
  FAMILY_COUNT_V3,
  FAMILY_SIZE_V3,
  SEED_V3,
  TOTAL_EVENT_COUNT_V3,
  buildWorldV3,
} from '../../src/memory/audit/corpus/world-plan-v3.ts';
import { buildWorldManifestV3 } from '../../src/memory/audit/corpus/world-manifest-v3.ts';

const PLAN = buildWorldV3();
const MANIFEST = buildWorldManifestV3(PLAN);

test('BP3-1 整包：schema/seed/总量/分区计数齐备，且通过违禁键递归扫描', () => {
  const pkg = buildBlindPackageV3(PLAN);
  assert.equal(pkg.schema, 'fasti-p6-blind/v3');
  assert.equal(pkg.seed, SEED_V3);
  assert.equal(pkg.baseEpochMs, PLAN.baseEpochMs);
  assert.equal(pkg.events.length, TOTAL_EVENT_COUNT_V3);
  assert.equal(pkg.events.filter((e) => e.partition === 'tuning-a').length, 1404);
  assert.equal(pkg.events.filter((e) => e.partition === 'tuning-b').length, 516);
  // 同一张表、同一道递归检查：产物本身必须零命中（不靠事后手查）。
  assert.doesNotThrow(() => assertBlindPackageSafe(pkg));
  assert.doesNotThrow(() => assertBlindPackageSafe(JSON.parse(JSON.stringify(pkg))));
});

test('BP3-2 白名单投影：字段集合精确，答案侧字段一个不漏地挡在门外', () => {
  const event = PLAN.events[0]!;
  const blind = toBlindEventV3(event);
  // 允许面：只有出题必需的 10 个字段（顺序无关）。
  assert.deepEqual(
    Object.keys(blind).sort(),
    ['channel', 'endedAtMs', 'eventId', 'familyId', 'highRiskLabels', 'partition', 'sensitiveTerms', 'startedAtMs', 'summary', 'turns'].sort(),
  );
  // 逐个点名：这些蓝本字段必须不存在于盲包（含 v3 特有的 reuse 计划与族共享点）。
  for (const key of ['keyPoints', 'hasRef', 'familyPoint', 'reusePlan', 'details']) {
    assert.equal(key in (blind as unknown as Record<string, unknown>), false, `盲包含答案侧字段 ${key}`);
  }
  // 表本身要覆盖这些键，否则「不存在」只是巧合。
  for (const key of ['keyPoints', 'hasRef', 'reusePlan']) {
    assert.ok(BLIND_FORBIDDEN_KEYS.includes(key), `违禁键表缺 ${key}`);
  }
  // turns 逐字段投影，不得透传蓝本新增字段。
  assert.deepEqual(
    Object.keys(blind.turns[0]!).sort(),
    ['offsetMinutes', 'rawText', 'speaker'].sort(),
  );
  assert.equal(blind.endedAtMs, event.endedAtMs);
  assert.notEqual(blind.startedAtMs, undefined);
});

test('BP3-3 分区过滤：整包之外可单出 A/B（供后续发卷做物理隔离）', () => {
  const a = buildBlindPackageV3(PLAN, 'tuning-a');
  const b = buildBlindPackageV3(PLAN, 'tuning-b');
  assert.equal(a.events.length, 1404);
  assert.equal(b.events.length, 516);
  assert.ok(a.events.every((e) => e.partition === 'tuning-a'));
  assert.ok(b.events.every((e) => e.partition === 'tuning-b'));
  // 两包 id 不相交，且并集恰为整包。
  const full = buildBlindPackageV3(PLAN);
  const ids = new Set([...a.events.map((e) => e.eventId), ...b.events.map((e) => e.eventId)]);
  assert.equal(ids.size, full.events.length);
  assert.doesNotThrow(() => assertBlindPackageSafe(a));
  assert.doesNotThrow(() => assertBlindPackageSafe(b));
  // 非法分区值直接拒，不静默出空包。
  assert.throws(() => buildBlindPackageV3(PLAN, 'sealed' as never), /partition/);
});

test('BP3-4 契约闸：不自洽逐条报出，自洽零错', () => {
  const pkg = buildBlindPackageV3(PLAN);
  assert.deepEqual(assertBlindPackageV3Shape(pkg, MANIFEST), []);

  const badSchema = { ...pkg, schema: 'fasti-p6-blind/v2' };
  assert.match(assertBlindPackageV3Shape(badSchema as never, MANIFEST).join(';'), /schema/);

  const badSeed = { ...pkg, seed: 1 };
  assert.match(assertBlindPackageV3Shape(badSeed as never, MANIFEST).join(';'), /seed/);

  const badPartition = {
    ...pkg,
    events: [{ ...pkg.events[0]!, partition: 'sealed' }, ...pkg.events.slice(1)],
  };
  assert.match(assertBlindPackageV3Shape(badPartition as never, MANIFEST).join(';'), /partition|分区/);

  const badTurns = {
    ...pkg,
    events: [
      {
        ...pkg.events[0]!,
        highRiskLabels: [],
        turns: pkg.events[0]!.turns.slice(0, 5),
      },
      ...pkg.events.slice(1),
    ],
  };
  assert.match(assertBlindPackageV3Shape(badTurns as never, MANIFEST).join(';'), /turns/);

  const badOffset = {
    ...pkg,
    events: [
      { ...pkg.events[0]!, turns: pkg.events[0]!.turns.map((t, i) => (i === 0 ? { ...t, offsetMinutes: 5 } : t)) },
      ...pkg.events.slice(1),
    ],
  };
  assert.match(assertBlindPackageV3Shape(badOffset as never, MANIFEST).join(';'), /offsetMinutes/);
});

test('BP3-5 族数配套与高危轮次：160 族×12，带高危的事件 7 轮、不带 6 轮', () => {
  const pkg = buildBlindPackageV3(PLAN);
  const families = new Set(pkg.events.map((e) => e.familyId));
  assert.equal(families.size, FAMILY_COUNT_V3);
  assert.equal(families.size * FAMILY_SIZE_V3, pkg.events.length);
  for (const event of pkg.events) {
    const expected = event.highRiskLabels.length > 0 ? 7 : 6;
    assert.equal(event.turns.length, expected, `${event.eventId} 轮次 ${event.turns.length} ≠ ${expected}`);
    assert.ok(event.turns.every((t) => t.speaker === 'user'));
  }
  // 高危事件恰 700 个、五类各 140（与蓝本配额一致，盲包不得丢标签）。
  assert.equal(pkg.events.filter((e) => e.highRiskLabels.length > 0).length, 700);
});
