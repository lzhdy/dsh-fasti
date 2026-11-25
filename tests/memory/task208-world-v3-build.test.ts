/**
 * task208 红测：v3 建根薄封装与 CLI 版本分派。
 *
 * 纪律：本文件**绝不真建根**（不调 ingestWorld / seedDerivedCards），只钉纯函数面：
 *  - 参数解析把 v3 接进 `--world`，v1 默认与 v1/v2 行为零变化；
 *  - v3 的 seed 与 v2 同样冻结（改 seed 即改蓝图，N1h 结论脱节）；
 *  - 蓝本 → 建根可食 plan 的适配器：分区折叠为 'tuning'、endedAtMs→endedMs，且不改原蓝本；
 *  - 世界清单：总量/分区计数/高危盘点/复用词/撞词族映射；
 *  - 根标记认得 world='v3'；`--blind-out` 对 v3 可省（v3 盲包契约尚未立卷）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  SYNTHETIC_ROOT_MARKER,
  parseArgs,
  requiresBlindOut,
  toBuildablePlanV3,
  writeRootMarker,
} from '../../scripts/p6/build-synthetic-world.ts';
import {
  FAMILY_COUNT_V3,
  SEED_V3,
  TOTAL_EVENT_COUNT_V3,
  WORLD_SCHEMA_V3,
  buildWorldV3,
} from '../../src/memory/audit/corpus/world-plan-v3.ts';
import { buildWorldManifestV3 } from '../../src/memory/audit/corpus/world-manifest-v3.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-208-'));

test('V3B-1 参数解析：v1 默认零变化，v3 接入且 seed 冻结，未知值仍拒', () => {
  // 默认仍是 v1（改造前行为逐字节不变）。
  const base = parseArgs(['--out', '/tmp/a', '--blind-out', '/tmp/b']);
  assert.equal(base.world, 'v1');
  assert.equal(base.forceRebuild, false);
  assert.equal(base.seed, undefined);

  // v3 被接受；给对冻结 seed 通过。
  assert.equal(parseArgs(['--out', '/tmp/a', '--world', 'v3']).world, 'v3');
  assert.equal(parseArgs(['--out', '/tmp/a', '--world', 'v3', '--seed', String(SEED_V3)]).seed, SEED_V3);

  // 给错 seed 必抛（与 v2 同一纪律）。
  assert.throws(() => parseArgs(['--out', '/tmp/a', '--world', 'v3', '--seed', '7']), /冻结/);

  // 未知值仍拒，且错误信息列出合法三值。
  assert.throws(() => parseArgs(['--out', '/tmp/a', '--world', 'v4']), /只接受 v1\|v2\|v3/);

  // v1/v2 老行为不回退。
  assert.equal(parseArgs(['--out', '/tmp/a', '--blind-out', '/tmp/b', '--seed', '7']).seed, 7);
});

test('V3B-2 建根门：v1/v2 仍强制 --blind-out，只有 v3 可省', () => {
  assert.equal(requiresBlindOut('v1'), true);
  assert.equal(requiresBlindOut('v2'), true);
  assert.equal(requiresBlindOut('v3'), false, 'v3 盲包契约未立卷，不得强制给 blind 目录');
});

test('V3B-3 适配器：分区折叠 tuning、字段改名、形状可喂共享摄入链，且不改原蓝本', () => {
  const plan = buildWorldV3();
  const before = JSON.stringify(plan);
  const buildable = toBuildablePlanV3(plan);

  assert.equal(buildable.events.length, TOTAL_EVENT_COUNT_V3);
  assert.equal(buildable.referenceNowMs, plan.referenceNowMs);
  assert.ok(buildable.events.every((e) => e.partition === 'tuning'), 'v3 全部属调参卷，折叠为 tuning');
  assert.ok(
    buildable.events.every((e) => e.endedMs > e.startedAtMs),
    'endedAtMs 须映射为 endedMs 且晚于开始',
  );
  assert.ok(buildable.events.every((e) => e.keyPoints.length === 3), '族共享点 + 两个专属点');
  assert.ok(buildable.events.every((e) => e.turns.length >= 6), '每事件至少 6 轮');
  // eventId 逐一保序，摄入锚点才能与蓝本对齐。
  assert.deepEqual(
    buildable.events.map((e) => e.eventId),
    plan.events.map((e) => e.eventId),
  );
  // 原蓝本未被就地改写（适配器是纯投影）。
  assert.equal(JSON.stringify(plan), before, '适配器不得改写蓝本');
});

test('V3B-4 世界清单：总量/分区计数/高危盘点/复用词/撞词族映射', () => {
  const plan = buildWorldV3();
  const manifest = buildWorldManifestV3(plan);

  assert.equal(manifest.schema, WORLD_SCHEMA_V3);
  assert.equal(manifest.seed, SEED_V3);
  assert.equal(manifest.totalEvents, TOTAL_EVENT_COUNT_V3);
  assert.equal(manifest.partitionEvents['tuning-a'], 1404);
  assert.equal(manifest.partitionEvents['tuning-b'], 516);
  assert.equal(manifest.partitionEvents['tuning-a'] + manifest.partitionEvents['tuning-b'], manifest.totalEvents);
  assert.equal(manifest.familyCount, FAMILY_COUNT_V3);

  // 高危 700 条，五类各 140。
  assert.equal(manifest.highRiskInventory.length, 700);
  for (const label of ['strong', 'promise', 'date', 'verbatim', 'negation'] as const) {
    assert.equal(manifest.highRiskByLabel[label], 140, `${label} 应各 140`);
  }

  // 复用词 30 个，每词恰跨 2 个族（受控复用只在 A 区）。
  assert.equal(manifest.reusedDetailWords.length, 30);
  const wordFamilies = new Map<string, Set<string>>();
  for (const event of plan.events) {
    for (const word of [event.keyPoints[1]!, event.keyPoints[2]!]) {
      const set = wordFamilies.get(word) ?? new Set<string>();
      set.add(event.familyId);
      wordFamilies.set(word, set);
    }
  }
  for (const word of manifest.reusedDetailWords) {
    assert.equal(wordFamilies.get(word)?.size, 2, `复用词 ${word} 应恰跨 2 族`);
  }

  // 撞词 24 个，每个至少承载 1 个族；族 id 全属 v3 命名空间、去重递增。
  assert.equal(manifest.collisionWords.length, 24);
  for (const entry of manifest.collisionWords) {
    assert.ok(entry.familyIds.length >= 1, `撞词 ${entry.word} 无承载族`);
    assert.ok(entry.familyIds.every((id) => /^v3-[ab]-f\d{3}$/.test(id)), `撞词族 id 越界：${entry.familyIds.join(',')}`);
    assert.deepEqual([...entry.familyIds], [...entry.familyIds].sort(), `撞词 ${entry.word} 族序须递增`);
  }
});

test('V3B-5 根标记认清 v3：world 字段可识别，schema/seed 自描述', () => {
  const dir = tmp();
  writeRootMarker(dir, WORLD_SCHEMA_V3, SEED_V3, 'v3');
  const marker = JSON.parse(fs.readFileSync(path.join(dir, SYNTHETIC_ROOT_MARKER), 'utf8')) as Record<string, unknown>;
  assert.equal(marker.world, 'v3');
  assert.equal(marker.schema, WORLD_SCHEMA_V3);
  assert.equal(marker.seed, SEED_V3);
});
