/**
 * 切分器 ↔ 修正器进程内状态接线测试（落地分析 P1-A / P1-B 回归）。
 *
 * 两条同根缺陷都源于：修正器只对事件真源追加版本，不通知切分器，导致切分器持有
 * 陈旧的 open 状态。本文件经**完整门面 + 单写者队列**端到端复现并锁定修复：
 *
 *  - P1-A：reopen 已闭合事件后，切分器必须重新接管 —— 同通道再摄入并入被 reopen
 *    的事件，而不是造出第二个同通道 open（那种状态会让重启 restore 抛 CorruptedError）；
 *  - P1-B：对正在 open 的事件做 split（merge 同构）后，切分器不得在退役版本链上
 *    复活写新版本；该通道再摄入应按规则 2 另起一个新 open 事件。
 *
 * 全程只走公开原语与临时目录，不直接改事件真源。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fasti } from '../../src/api/index.ts';
import { EventOpenConflictError } from '../../src/contract/event.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const BASE_TIME = '2026-11-08T10:00:00.000Z';

/** 基准时刻偏移若干分钟的 ISO 串。 */
function atMinute(minute: number): string {
  return new Date(Date.parse(BASE_TIME) + minute * 60_000).toISOString();
}

/** 投喂一条 dsh 通道原文（世界轴/系统轴时刻显式给定，结果确定）。 */
async function feedTurn(
  fasti: Fasti,
  eventId: string,
  minute: number,
  rawText = `原文 ${eventId}`,
): Promise<void> {
  await fasti.ingestRawTurn('dsh', {
    event_id: eventId,
    session_id: 'session-1',
    speaker: 'user',
    raw_text: rawText,
    asserted_at: atMinute(minute),
    ingested_at: atMinute(minute),
  });
}

// ── P1-A：reopen 接管 + 重启 restore ────────────────────────────────────

test('P1-A：reopen 后同通道再摄入并入被重开事件，不造第二个 open；重启 restore 通过', async () => {
  const root = makeTempRoot();
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await feedTurn(fasti, 'raw-1', 0);

      const before = await fasti.queryEvents({});
      assert.equal(before.length, 1);
      const eventId = before[0]?.id;
      assert.equal(before[0]?.status, 'open');
      assert.ok(eventId);

      // 时钟静默闭合（无 LLM 端口也能闭合）。
      assert.equal(fasti.checkSilenceClock(Date.parse(BASE_TIME) + 31 * 60_000), 1);
      assert.equal((await fasti.queryEvents({}))[0]?.status, 'closed');

      // 她重开该事件。
      const reopened = await fasti.reopenEvent({ eventId });
      assert.equal(reopened.status, 'open');

      // 静默窗内同通道再投喂一条 —— 修复前会造第二个同通道 open，修复后必须并入。
      await feedTurn(fasti, 'raw-2', 5);

      const afterIngest = await fasti.queryEvents({});
      assert.equal(afterIngest.length, 1, 'reopen 后不得新建第二个 open 事件');
      assert.equal(afterIngest[0]?.id, eventId, '新记录必须并入被重开的同一事件');
      assert.equal(afterIngest[0]?.status, 'open');
      assert.equal(afterIngest[0]?.pointers.length, 2, '被重开事件应含两条记录');
    } finally {
      await fasti.close();
    }

    // 模拟进程重启：修复前同通道两个 open 会让 restore 抛 CorruptedError、事件层 Unavailable。
    const reopenedFasti = await Fasti.open({ dataRoot: root });
    try {
      assert.equal(reopenedFasti.eventLayerStatus().available, true, '重启后事件层必须可用（restore 通过）');
      const restored = await reopenedFasti.queryEvents({});
      assert.equal(restored.length, 1, '重启后仍只有一个事件（无重复 open）');
      assert.equal(restored[0]?.status, 'open');
      assert.equal(restored[0]?.pointers.length, 2);
    } finally {
      await reopenedFasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

// ── P1-B：split 一个正在 open 的事件后，不在退役链上复活 ─────────────────

test('P1-B：split 正在 open 的事件后再摄入，另起新事件而非在退役版本链复活', async () => {
  const root = makeTempRoot();
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await feedTurn(fasti, 'raw-1', 0);
      await feedTurn(fasti, 'raw-2', 5);

      const openEvents = await fasti.queryEvents({});
      assert.equal(openEvents.length, 1, '两条连续记录并入同一个 open 事件');
      const source = openEvents[0];
      assert.equal(source?.status, 'open');
      assert.equal(source?.pointers.length, 2);
      const sourceId = source!.id;
      const pointerIds = source!.pointers.map((pointer) => pointer.id);

      // 对**正在 open** 的事件做拆分（切分器此刻仍持有它的 open 状态）。
      const split = await fasti.splitEvent({
        sourceId,
        groups: [[pointerIds[0]!], [pointerIds[1]!]],
      });
      assert.equal(split.retired.status, 'split');
      const childIds = split.children.map((child) => child.id);

      // 同通道再投喂第三条 —— 修复前会在 split 退役链上 append 新版本复活，修复后另起。
      const third = await fasti.ingestRawTurn('dsh', {
        event_id: 'raw-3',
        session_id: 'session-1',
        speaker: 'user',
        raw_text: '原文 raw-3',
        asserted_at: atMinute(10),
        ingested_at: atMinute(10),
      });

      // 被拆事件停在 split 版本，没有任何复活追加（v1 新建 / v2 并入 / v3 拆分退役）。
      const retiredCurrent = await fasti.getEvent(sourceId);
      assert.equal(retiredCurrent.status, 'split');
      const versions = await fasti.listEventVersions(sourceId);
      assert.equal(versions.length, 3, '退役后版本数必须停住，不得再追加复活版本');
      assert.equal(versions[versions.length - 1]?.status, 'split', '末版本必须仍是 split');

      // 通道里唯一的 open 是一个全新事件，承接第三条记录。
      const current = await fasti.queryEvents({});
      const openNow = current.filter((event) => event.status === 'open');
      assert.equal(openNow.length, 1, '该通道应有且仅有一个新 open 事件');
      const next = openNow[0]!;
      assert.notEqual(next.id, sourceId, '新 open 不得复用被退役事件 id');
      assert.ok(!childIds.includes(next.id), '新 open 不得是拆分子事件');
      assert.ok(
        next.pointers.some((pointer) => pointer.id === third.id),
        '第三条记录必须归到新事件',
      );

      // 两个子事件保持 closed，未被后续摄入改写。
      for (const childId of childIds) {
        const child = await fasti.getEvent(childId);
        assert.equal(child.status, 'closed');
      }
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

// ── #36：reopen 同通道冲突 → 带选项拒绝；显式组合后切分器重算接管 ─────────

test('#36：同通道有进行中事件时 reopen 被带选项拒绝；显式 closeAndReopen 后唯一 open 转到 B、重启 restore 通过', async () => {
  const root = makeTempRoot();
  let bId = '';
  let aId = '';
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      // 第一件事 B：投喂后静默闭合。
      await feedTurn(fasti, 'raw-1', 0);
      const first = await fasti.queryEvents({});
      bId = first[0]!.id;
      assert.equal(fasti.checkSilenceClock(Date.parse(BASE_TIME) + 31 * 60_000), 1);
      assert.equal((await fasti.getEvent(bId)).status, 'closed');

      // 静默窗之后的新记录另起一件进行中的事 A（同通道 dsh）。
      await feedTurn(fasti, 'raw-2', 40);
      const openAfterSecond = (await fasti.queryEvents({})).filter((e) => e.status === 'open');
      assert.equal(openAfterSecond.length, 1);
      aId = openAfterSecond[0]!.id;
      assert.notEqual(aId, bId);

      // 直接重开 B：通道被 A 占着 → 带选项拒绝，且不写任何版本、不自动闭合 A。
      const versionsOfBBefore = await fasti.listEventVersions(bId);
      await assert.rejects(
        fasti.reopenEvent({ eventId: bId }),
        (err: unknown) => {
          assert.ok(err instanceof EventOpenConflictError);
          assert.equal(err.reopenId, bId);
          assert.equal(err.blocking.eventId, aId);
          assert.equal(err.blocking.channel, 'dsh');
          assert.equal(err.blocking.pointerCount, 1);
          assert.deepEqual([...err.actions], ['close-then-reopen', 'merge']);
          return true;
        },
      );
      const versionsOfBAfter = await fasti.listEventVersions(bId);
      assert.equal(versionsOfBAfter.length, versionsOfBBefore.length, '拒绝不产生新版本');
      assert.equal((await fasti.getEvent(aId)).status, 'open', 'A 未被系统自动闭合');

      // 她显式点击「闭合 A，再重开 B」：一个组合原语、两条她落款的版本。
      const combo = await fasti.closeAndReopenEvent({ closeId: aId, reopenId: bId });
      assert.equal(combo.closed.id, aId);
      assert.equal(combo.closed.status, 'closed');
      assert.equal(combo.closed.closed_reason, 'manual');
      assert.equal(combo.closed.created_by, 'her');
      assert.equal(combo.reopened.id, bId);
      assert.equal(combo.reopened.status, 'open');

      const openNow = (await fasti.queryEvents({})).filter((e) => e.status === 'open');
      assert.equal(openNow.length, 1, '切分器重算后该通道唯一 open 是 B');
      assert.equal(openNow[0]!.id, bId);

      // 组合只改状态、不搬运记录：A、B 各自指针归属保持不变。
      assert.equal((await fasti.getEvent(bId)).pointers.length, 1);
      assert.equal((await fasti.getEvent(aId)).pointers.length, 1, 'A 停在自己那条记录，未被改动');
      // 注：「reopen 后静默窗内再摄入并入被重开事件」已由 P1-A 端到端覆盖（同一
      // resyncAfterCorrection 接线）；此处 B 的末条记录停在静默闭合之前，跨静默窗的新摄入
      // 会被切分器静默规则正常另起新事件，属既有行为、与本原语无关，故不在此重复构造。
    } finally {
      await fasti.close();
    }

    // 重启 restore：每通道唯一 open=B，派生重算不得报 CorruptedError。
    const reopenedFasti = await Fasti.open({ dataRoot: root });
    try {
      assert.equal(reopenedFasti.eventLayerStatus().available, true);
      const restoredOpen = (await reopenedFasti.queryEvents({})).filter((e) => e.status === 'open');
      assert.equal(restoredOpen.length, 1);
      assert.equal(restoredOpen[0]!.id, bId);
      assert.equal(restoredOpen[0]!.status, 'open');
      assert.equal(restoredOpen[0]!.pointers.length, 1);
    } finally {
      await reopenedFasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});
