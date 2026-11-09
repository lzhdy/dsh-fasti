/**
 * QA 独立验证用例 · 第二组（B 块第一期 · 事件层）
 *
 * 覆盖第一组未覆盖的关键口径：
 *  - Q-B12 事件投影三档同语义（T13-a）—— 现有 tests/projection/parity.test.ts
 *    **只覆盖经历**，事件零覆盖；本组补齐。
 *  - Q-B13 重建白名单（B2 · 唯一原 Blocker 的落法）。
 *  - Q-B14 重建不得冲掉她修正过的事件边界。
 *  - Q-B15 门面 close 后能否对同一数据根重开（单写者登记的释放）。
 *
 * 纪律：临时 dataRoot；不改生产代码；不改别人的测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { layoutOf } from '../../src/source/paths.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const TIMES = [
  '2026-11-08T10:00:00.000Z',
  '2026-11-08T10:01:00.000Z',
  '2026-11-08T10:02:00.000Z',
];

/** 造一轮摄入输入。 */
function turn(eventId: string, at: string) {
  return {
    event_id: eventId,
    session_id: 'session-1',
    speaker: 'user' as const,
    raw_text: `内容 ${eventId}`,
    asserted_at: at,
    occurred_at: at,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Q-B12 · 事件投影三档同语义（T13-a）
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B12 · 事件投影三档同语义：L1 / L2 / L3 对同一事件集合逐字一致', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');

  const seeder = await Fasti.open({ dataRoot: root });
  try {
    for (const [i, at] of TIMES.entries()) {
      await seeder.ingestRawTurn('dsh', turn(`evt-${i}`, at));
    }
  } finally {
    await seeder.close();
  }

  const perLevel = new Map<string, string>();
  for (const level of ['L1', 'L2', 'L3'] as const) {
    const fasti = await Fasti.open({ dataRoot: root, projectionLevel: level });
    try {
      perLevel.set(level, JSON.stringify(await fasti.queryEvents()));
    } finally {
      await fasti.close();
    }
  }

  const l1 = perLevel.get('L1');
  assert.ok(l1 !== undefined && l1 !== '[]', 'L1 必须查到事件（否则是「全都不命中」的假一致）');
  assert.equal(perLevel.get('L2'), l1, 'L2 与 L1 的事件结果集必须逐字一致');
  assert.equal(perLevel.get('L3'), l1, 'L3 与 L1 的事件结果集必须逐字一致');
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B13 · 重建白名单（B2）
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B13 · 重建后事件仍在（重建不清掉事件），且事件数与真源一致', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');

  const first = await Fasti.open({ dataRoot: root });
  let beforeCount = 0;
  try {
    for (const [i, at] of TIMES.entries()) {
      await first.ingestRawTurn('dsh', turn(`evt-${i}`, at));
    }
    beforeCount = (await first.queryEvents()).length;
    assert.ok(beforeCount > 0, '重建前应有事件');
  } finally {
    await first.close();
  }

  const second = await Fasti.open({ dataRoot: root });
  try {
    await second.rebuildProjections();
    assert.equal(
      (await second.queryEvents()).length,
      beforeCount,
      '重建不得丢事件',
    );
  } finally {
    await second.close();
  }
});

test('Q-B13 · 重建白名单：events/ 真源为空时，重建不得从 experiences/ 造出事件', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');

  const first = await Fasti.open({ dataRoot: root });
  try {
    await first.appendExperience({
      id: '01J0000000000000000000000A',
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 'session-1' },
      initiation: 'user',
      observation: { cue: '一条经历' },
      occurred_at: '2026-11-08T10:00:00.000Z',
    });
  } finally {
    await first.close();
  }

  // 清空 events/ 真源（模拟「事件真源为空」）。
  const eventsDir = layoutOf(root).events;
  for (const name of fs.readdirSync(eventsDir)) {
    fs.rmSync(path.join(eventsDir, name), { force: true, recursive: true });
  }

  const second = await Fasti.open({ dataRoot: root });
  try {
    await second.rebuildProjections();
    assert.equal(
      (await second.queryEvents()).length,
      0,
      '重建白名单：events/ 为空时，重建绝不能从 experiences/ 造出事件（否则就是「重建」）',
    );
  } finally {
    await second.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B14 · 重建不得冲掉修正过的事件边界
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B14 · 一次 rebuildProjections() 不会清掉她修正过的事件边界', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');

  const fasti = await Fasti.open({ dataRoot: root });
  try {
    for (const [i, at] of TIMES.entries()) {
      await fasti.ingestRawTurn('dsh', turn(`evt-${i}`, at));
    }

    const events = await fasti.queryEvents();
    assert.equal(events.length, 1);
    const eventId = events[0]!.id;
    const pointersBefore = events[0]!.pointers.length;

    // 她做一次修正（改边界：把一条记录挪出去）。
    const removeId = events[0]!.pointers[0]!.id;
    const revised = await fasti.reviseEventBoundary({
      eventId,
      removePointerIds: [removeId],
    });
    const pointersAfter = revised.event.pointers.length;
    assert.equal(pointersAfter, pointersBefore - 1, '修正本身应生效');

    // 重建 —— 修正过的边界必须还在。
    await fasti.rebuildProjections();
    const afterRebuild = await fasti.getEvent(eventId);
    assert.equal(
      afterRebuild.pointers.length,
      pointersAfter,
      '重建不得把修正过的事件边界改回原样',
    );
    assert.equal(
      afterRebuild.pointers.some((p) => p.id === removeId),
      false,
      '重建不得把被挪出的记录放回去',
    );
  } finally {
    await fasti.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B15 · 门面 close 后重开同一数据根（单写者登记的释放）
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B15 · 门面 close 后重开同一数据根（close 释放单写者登记，可重开）', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');

  const first = await Fasti.open({ dataRoot: root });
  await first.close();

  let error: unknown;
  try {
    const second = await Fasti.open({ dataRoot: root });
    await second.close();
  } catch (caught) {
    error = caught;
  }
  assert.equal(
    error,
    undefined,
    '⚠️ 当前实现：close() 未释放 EventLog 的单写者登记 → 同进程重开同一数据根失败',
  );
});
