/**
 * 事件投影的新鲜度 —— worker 写点必须立即折进投影（真机实测反推的回归）。
 *
 * 现场：静默闭合与摘要装配都发生在宿主后台 worker，而事件投影原先只在
 * 摄入流水线里跑（`event-projection` stage）。长会话里几小时不摄入一次，
 * SQLite 于是长期停在旧版本：真源 9 个事件 summary_quality=ready、
 * 投影 9 行仍是 pending 且每行版本恰好差 1。
 *
 * 契约（本文件锁死）：
 *  - `checkSilenceClock` 闭合事件后，投影的 version / status 立即追平真源；
 *  - `drainClosure` 产出摘要后，投影的 version / summary_quality / summary 立即追平；
 *  - 真源仍是唯一权威：投影跟进只是缓存刷新，失败不回滚真源。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { Fasti } from '../../src/api/index.ts';
import type { LLMPort } from '../../src/event/llm-port.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const BASE_TIME = '2026-11-08T10:00:00.000Z';

interface ProjectionRow {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly summary_quality: string;
  readonly summary: string | null;
}

/** 投影 event 表的同步只读探针（DatabaseSync 是同步 API，构造器异步加载）。 */
async function projectionProbe(root: string): Promise<{ read: () => ProjectionRow[]; close: () => void }> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'projection', 'fasti.sqlite'));
  return {
    read: () => {
      const rows = db
        .prepare('SELECT id, version, status, summary_quality, summary FROM event ORDER BY version')
        .all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row['id']),
        version: Number(row['version']),
        status: String(row['status']),
        summary_quality: String(row['summary_quality']),
        summary: row['summary'] === null ? null : String(row['summary']),
      }));
    },
    close: () => db.close(),
  };
}

/** 轮询等待（投影跟进是 fire-and-forget，需要一个可见的到位窗口）。 */
async function waitFor(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${what}`);
}

/** 投一条原文（凭空造一个 open 事件）。 */
async function seedOpenEvent(fasti: Fasti): Promise<void> {
  await fasti.ingestRawTurn('dsh', {
    event_id: 'evt-raw-sync-1',
    session_id: 's-sync',
    speaker: 'user',
    raw_text: '她把论文摊在桌上',
    asserted_at: BASE_TIME,
    ingested_at: BASE_TIME,
  });
}

test('checkSilenceClock 闭合后，投影的版本与状态立即追平真源', async () => {
  const root = makeTempRoot();
  try {
    // 不传端口：闭合照常，摘要保持 pending（A6b）。
    const fasti = await Fasti.open({ dataRoot: root });
    const probe = await projectionProbe(root);
    try {
      await seedOpenEvent(fasti);
      const listed = await fasti.queryEvents({});
      assert.equal(listed.length, 1);
      const eventId = listed[0]!.id;
      assert.equal(listed[0]!.status, 'open');

      assert.equal(
        fasti.checkSilenceClock(Date.parse(BASE_TIME) + 31 * 60_000),
        1,
        '静默跨过 30 分钟应闭合 1 个',
      );

      const source = await fasti.getEvent(eventId);
      assert.equal(source?.status, 'closed');
      assert.equal(source?.closed_reason, 'silence');

      // 关键断言：投影不等下一轮摄入，自己就该到 closed + 同版本。
      await waitFor(() => {
        const row = probe.read().find((item) => item.id === eventId);
        return row !== undefined && row.version === source!.version && row.status === 'closed';
      }, '投影追平闭合版本');
    } finally {
      probe.close();
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('drainClosure 产出摘要后，投影的摘要列立即追平真源', async () => {
  const root = makeTempRoot();
  const port: LLMPort = {
    summarize: async () => ({
      summary: '她把论文摊在桌上，随后沉默地读完了引言。',
      keyPoints: ['摊开论文', '读完引言'],
      anchors: [],
      model: 'stub-model',
    }),
  };
  try {
    // 阶段一：无端口闭合 —— 事件停在 closed + pending。
    const bare = await Fasti.open({ dataRoot: root });
    let eventId: string;
    try {
      await seedOpenEvent(bare);
      assert.equal(bare.checkSilenceClock(Date.parse(BASE_TIME) + 31 * 60_000), 1);
      const listed = await bare.queryEvents({});
      eventId = listed[0]!.id;
      assert.equal(listed[0]!.summary_quality, 'pending');
    } finally {
      await bare.close();
    }

    // 阶段二：接上端口重开 —— 启动清道夫把 pending 排进队列，drainClosure 出摘要。
    const fasti = await Fasti.open({ dataRoot: root, llmPort: port });
    const probe = await projectionProbe(root);
    try {
      const processed = await fasti.drainClosure(10, 60_000);
      assert.ok(processed >= 1, '应处理至少一条');

      const source = await fasti.getEvent(eventId);
      assert.equal(source?.summary_quality, 'ready', '真源应已 ready');

      // 关键断言：投影的摘要列不等下一轮摄入，自己就该到 ready + 同版本。
      await waitFor(() => {
        const row = probe.read().find((item) => item.id === eventId);
        return row !== undefined && row.version === source!.version && row.summary_quality === 'ready';
      }, '投影追平摘要版本');

      const row = probe.read().find((item) => item.id === eventId);
      assert.equal(row?.summary, '她把论文摊在桌上，随后沉默地读完了引言。');
    } finally {
      probe.close();
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});
