/**
 * task211 红测：v3 调参卷装配机（出题成品 → fasti-p6-tuning/v3 四件套）。
 *
 * 复用面（只读核过）：`buildSynthIdMap` 不需要改——它按卡片 discriminator `disc-<synId>`
 * 建映射，v3 根的卡片 discriminator 正是 `disc-syn-v3a-0001`，实测 1920 条（A1404/B516）。
 * 故本批只新增装配机，不碰既有 id 映射与封存装配机。
 *
 * 钉六件事：
 *  1. 版本闸：非 v3 或四份互不一致一律拒（复用 assertTuningV3SetVersion）；
 *  2. 机械翻译：四类引用的 syn 事件 id → 合成根系统事件 id，字段名不变；
 *  3. 悬空引用拒（防止出题成品引用了根里不存在的事件）；
 *  4. 分区守卫：题面 partitionTag 必须与所引事件的实际分区一致（A/B 不得互串）；
 *  5. 前端严格白名单：出题成品里任何未登记键（如笔误 `goldEventIDs`）必须当场拒，
 *     不许「静默丢弃」——否则装配出的卷会少字段而看起来正常；
 *  6. 落盘四件套，且产物能被 tuning-fixtures-v3 校验器原样复检。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  assembleTuningV3,
  assertTuningV3Guards,
  writeAssembledTuningV3,
} from '../../scripts/p6/assemble-tuning-v3.ts';
import {
  assertTuningV3SetVersion,
  validateTuningV3File,
  TUNING_V3_VERSION,
} from '../../src/memory/audit/tuning-fixtures-v3.ts';
import { buildWorldV3 } from '../../src/memory/audit/corpus/world-plan-v3.ts';

const PLAN = buildWorldV3();

/** 合成根 id 映射的替身（结构等价：synId → 系统事件 id）。 */
function fakeIdMap(): Map<string, { systemEventId: string; cardId: string }> {
  const map = new Map<string, { systemEventId: string; cardId: string }>();
  PLAN.events.forEach((event, index) => {
    map.set(event.eventId, {
      systemEventId: `01SYS${String(index).padStart(4, '0')}`,
      cardId: `mc_stub_${index}`,
    });
  });
  return map;
}

const FIRST_A = PLAN.events.find((e) => e.partition === 'tuning-a')!.eventId;
const SECOND_A = PLAN.events.filter((e) => e.partition === 'tuning-a')[1]!.eventId;
const FIRST_B = PLAN.events.find((e) => e.partition === 'tuning-b')!.eventId;

function authoredSet(overrides?: {
  goldItems?: unknown[];
  decoyItems?: unknown[];
  abstainItems?: unknown[];
  clarifyItems?: unknown[];
  version?: string;
}): {
  gold: { probeSetVersion: string; layer: 'tuning-gold'; items: readonly unknown[] };
  decoy: { probeSetVersion: string; layer: 'tuning-decoy'; items: readonly unknown[] };
  abstain: { probeSetVersion: string; layer: 'tuning-abstain'; items: readonly unknown[] };
  clarify: { probeSetVersion: string; layer: 'tuning-clarify'; items: readonly unknown[] };
} {
  const V = overrides?.version ?? TUNING_V3_VERSION;
  return {
    gold: {
      probeSetVersion: V,
      layer: 'tuning-gold',
      items: overrides?.goldItems ?? [
        { probeId: 'P-A1', bucket: 'B1', partitionTag: 'tuning-a', goldEventIds: [FIRST_A], queries: ['问一句'] },
        { probeId: 'P-B1', bucket: 'B1', partitionTag: 'tuning-b', goldEventIds: [FIRST_B], queries: ['问另一句'] },
      ],
    },
    decoy: {
      probeSetVersion: V,
      layer: 'tuning-decoy',
      items: overrides?.decoyItems ?? [
        {
          probeId: 'P-D1',
          bucket: 'B5',
          partitionTag: 'tuning-a',
          goldEventId: FIRST_A,
          rivalEventIds: [SECOND_A],
          density: 1,
          discriminatorQuery: '哪一件',
        },
      ],
    },
    abstain: {
      probeSetVersion: V,
      layer: 'tuning-abstain',
      items: overrides?.abstainItems ?? [
        { probeId: 'P-U1', bucket: 'B2', partitionTag: 'tuning-a', query: '库里没有的事', hardness: 'hard', goldEventId: null },
        { probeId: 'P-U2', bucket: 'B2', partitionTag: 'tuning-a', query: '近似但不该答', hardness: 'soft', goldEventId: FIRST_A },
      ],
    },
    clarify: {
      probeSetVersion: V,
      layer: 'tuning-clarify',
      items: overrides?.clarifyItems ?? [
        {
          probeId: 'P-C1',
          bucket: 'B3',
          partitionTag: 'tuning-a',
          pairEventIds: [FIRST_A, SECOND_A],
          query: '两件都像',
          expectedBehavior: 'clarify',
        },
      ],
    },
  };
}

test('TA3-1 版本闸：非 v3 版本与四份不一致都拒', () => {
  const idMap = fakeIdMap();
  assert.throws(
    () => assembleTuningV3(authoredSet({ version: 'fasti-p6-tuning/v2' }), idMap),
    /不一致|probeSetVersion/,
  );
  const mixed = authoredSet();
  assert.throws(
    () =>
      assembleTuningV3(
        { ...mixed, decoy: { ...mixed.decoy, probeSetVersion: 'fasti-p6-tuning/v4' } },
        idMap,
      ),
    /不一致/,
  );
  assert.doesNotThrow(() => assertTuningV3SetVersion([mixed.gold, mixed.decoy, mixed.abstain, mixed.clarify]));
});

test('TA3-2 机械翻译：四类引用 syn 事件 → 系统事件 id，字段名与其余标注原样保留', () => {
  const idMap = fakeIdMap();
  const files = assembleTuningV3(authoredSet(), idMap);

  assert.equal(files.gold.layer, 'tuning-gold');
  assert.equal(files.decoy.layer, 'tuning-decoy');
  assert.equal(files.abstain.layer, 'tuning-abstain');
  assert.equal(files.clarify.layer, 'tuning-clarify');

  // gold：多金标语义保留，值换成系统事件 id。
  assert.deepEqual(files.gold.items[0]!.goldEventIds, [idMap.get(FIRST_A)!.systemEventId]);
  assert.equal(files.gold.items[0]!.partitionTag, 'tuning-a');
  assert.deepEqual(files.gold.items[0]!.queries, ['问一句']);

  // decoy：金标与对手都翻译；density 与对手数一致的关系不被破坏。
  const decoy = files.decoy.items[0]!;
  assert.equal(decoy.goldEventId, idMap.get(FIRST_A)!.systemEventId);
  assert.deepEqual(decoy.rivalEventIds, [idMap.get(SECOND_A)!.systemEventId]);
  assert.equal(decoy.density, 1);

  // abstain：null 保持 null（不得被翻译成字符串）。
  assert.equal(files.abstain.items[0]!.goldEventId, null);
  assert.equal(files.abstain.items[1]!.goldEventId, idMap.get(FIRST_A)!.systemEventId);

  // clarify：配对逐个翻译。
  assert.deepEqual(
    files.clarify.items[0]!.pairEventIds,
    [idMap.get(FIRST_A)!.systemEventId, idMap.get(SECOND_A)!.systemEventId],
  );

  // 产物本身必须能过同一套校验器。
  assert.doesNotThrow(() => validateTuningV3File(files.gold, 'tuning-gold'));
  assert.doesNotThrow(() => validateTuningV3File(files.decoy, 'tuning-decoy'));
  assert.doesNotThrow(() => validateTuningV3File(files.abstain, 'tuning-abstain'));
  assert.doesNotThrow(() => validateTuningV3File(files.clarify, 'tuning-clarify'));
});

test('TA3-3 悬空引用：成品引用了根里不存在的事件必须拒，不许静默产出', () => {
  const idMap = fakeIdMap();
  assert.throws(
    () =>
      assembleTuningV3(
        authoredSet({
          goldItems: [{ probeId: 'P-X', bucket: 'B1', partitionTag: 'tuning-a', goldEventIds: ['syn-v3a-9999'], queries: ['q'] }],
        }),
        idMap,
      ),
    /找不到|悬空/,
  );
});

test('TA3-4 分区守卫：题面分区与所引事件实际分区必须一致（A/B 不得互串）', () => {
  const idMap = fakeIdMap();
  // 标称 A 却引用 B 事件 → 装配后守卫必须拒。
  const files = assembleTuningV3(
    authoredSet({
      goldItems: [{ probeId: 'P-MIX', bucket: 'B1', partitionTag: 'tuning-a', goldEventIds: [FIRST_B], queries: ['q'] }],
    }),
    idMap,
  );
  assert.throws(() => assertTuningV3Guards(files, idMap, PLAN), /分区/);
  // 自洽成品零错。
  assert.doesNotThrow(() => assertTuningV3Guards(assembleTuningV3(authoredSet(), idMap), idMap, PLAN));
});

test('TA3-5 前端严格白名单：出题成品的未登记键（如笔误 goldEventIDs）当场拒', () => {
  const idMap = fakeIdMap();
  assert.throws(
    () =>
      assembleTuningV3(
        authoredSet({
          goldItems: [
            { probeId: 'P-T', bucket: 'B1', partitionTag: 'tuning-a', goldEventIDs: [FIRST_A], queries: ['q'] },
          ],
        }),
        idMap,
      ),
    /非法字段/,
  );
});

test('TA3-6 落盘：四件套齐备、可解析、可被校验器复检，且拒绝覆盖非空目录', () => {
  const idMap = fakeIdMap();
  const files = assembleTuningV3(authoredSet(), idMap);
  const outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-211-')), 'tuning');
  writeAssembledTuningV3(outDir, files);

  for (const name of ['tuning-gold.json', 'tuning-decoy.json', 'tuning-abstain.json', 'tuning-clarify.json']) {
    assert.equal(fs.existsSync(path.join(outDir, name)), true, `缺 ${name}`);
  }
  const gold = JSON.parse(fs.readFileSync(path.join(outDir, 'tuning-gold.json'), 'utf8')) as unknown;
  assert.doesNotThrow(() => validateTuningV3File(gold, 'tuning-gold'));
  const decoy = JSON.parse(fs.readFileSync(path.join(outDir, 'tuning-decoy.json'), 'utf8')) as unknown;
  assert.doesNotThrow(() => validateTuningV3File(decoy, 'tuning-decoy'));
  // 再次写入非空目录必须拒，杜绝新旧夹具混杂。
  assert.throws(() => writeAssembledTuningV3(outDir, files), /拒绝覆盖/);
});
