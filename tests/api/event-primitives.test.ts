/**
 * 门面事件开放面测试（技术基线 §7.4 · 任务卡 T14）。
 *
 * 覆盖：
 *  - 读原语（queryEvents / getEvent / listEventVersions）：不入队、语义正确；
 *  - 写原语（合并 / 拆分 / 改边界 / 重开 / 重写摘要）：**经单写者队列**，
 *    并发调用不交叉写入（版本号不重复、结果不互相污染）；
 *  - 修正后事件投影同步更新（投影只存当前态 → 查到的是新版本）；
 *  - `EventPrimitives` 与既有 `FastiPrimitives` 是**两个独立接口**（A 块冻结面不动）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fasti } from '../../src/api/index.ts';
import { NotFoundError } from '../../src/core/errors.ts';
import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import { PRIMITIVE_NAMES } from '../../src/contract/primitives.ts';
import type { LLMPort } from '../../src/event/llm-port.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const BASE_TIME = '2026-11-08T10:00:00.000Z';

/** 造一条闭合事件（指针指向已存在的经历 id）。 */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const base: EventRecord = {
    id: 'evt-1',
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'closed',
    pointers: [{ id: 'exp-1', channel: 'dsh' }],
    time_range: { started_at: BASE_TIME, ended_at: BASE_TIME },
    assembled_at: BASE_TIME,
    summary: null,
    key_points: [],
    anchors: [],
    topic_lines: [],
    summary_quality: 'pending',
    summary_source: null,
    summary_prompt_version: null,
    summary_model: null,
    closed_reason: 'silence',
    created_by: 'system',
    created_at: BASE_TIME,
    channel: 'dsh',
    boundary_candidates: [],
  };
  return { ...base, ...overrides };
}

/** 三条经历的真实 id（修正操作按 experience id 取指针 → 必须是真源里存在的 id）。 */
const EXP_IDS = [
  '01J0000000000000000000000A',
  '01J0000000000000000000000B',
  '01J0000000000000000000000C',
] as const;

/** 造一批经历（供修正操作按 experience id 取指针）。 */
async function seedExperiences(fasti: Fasti): Promise<void> {
  for (const id of EXP_IDS) {
    await fasti.appendExperience({
      id,
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 's-1' },
      initiation: 'user',
      observation: { cue: `记录 ${id}` },
      occurred_at: BASE_TIME,
    });
  }
}

// ── 读原语 ──────────────────────────────────────────────────────────────

test('读原语：queryEvents 按条件过滤，getEvent 取当前态，listEventVersions 列历史', async () => {
  const root = makeTempRoot();
  try {
    const log = EventLog.open(layoutOf(root).events);
    log.appendVersion(makeEvent({ id: 'evt-a', channel: 'dsh' }));
    log.appendVersion(
      makeEvent({
        id: 'evt-b',
        channel: 'browser',
        status: 'open',
        closed_reason: null,
      }),
    );
    log.appendVersion(makeEvent({ id: 'evt-a', version: 2, summary: '第二版摘要' }));

    const fasti = await Fasti.open({ dataRoot: root });
    try {
      const all = await fasti.queryEvents();
      assert.equal(all.length, 2, '两个 id → 两条当前态');

      const dsh = await fasti.queryEvents({ channel: 'dsh' });
      assert.equal(dsh.length, 1);
      assert.equal(dsh[0]?.id, 'evt-a');

      const open = await fasti.queryEvents({ status: 'open' });
      assert.equal(open.length, 1);
      assert.equal(open[0]?.id, 'evt-b');

      const current = await fasti.getEvent('evt-a');
      assert.equal(current.version, 2, '取当前态 = 最大 version');
      assert.equal(current.summary, '第二版摘要');

      const versions = await fasti.listEventVersions('evt-a');
      assert.equal(versions.length, 2, '版本历史留痕');
      assert.deepEqual(
        versions.map((event) => event.version),
        [1, 2],
      );

      assert.equal((await fasti.listEventVersions('evt-unknown')).length, 0);
      await assert.rejects(() => fasti.getEvent('evt-unknown'), NotFoundError);
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 写原语：经单写者队列 ────────────────────────────────────────────────

test('写原语：合并经单写者队列 —— A、B 退役并带 merged_into=C，C 为新事件', async () => {
  const root = makeTempRoot();
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await seedExperiences(fasti);
      const log = EventLog.open(layoutOf(root).events);
      log.appendVersion(makeEvent({ id: 'evt-a', pointers: [{ id: EXP_IDS[0], channel: 'dsh' }] }));
      log.appendVersion(makeEvent({ id: 'evt-b', pointers: [{ id: EXP_IDS[1], channel: 'dsh' }] }));

      const result = await fasti.mergeEvents({ sourceIds: ['evt-a', 'evt-b'] });

      assert.equal(result.target.version, 1, 'C 是新事件（version=1）');
      assert.equal(result.retired.length, 2);
      for (const retired of result.retired) {
        assert.equal(retired.status, 'merged');
        assert.equal(retired.merged_into, result.target.id);
        assert.equal(retired.version, 2, '退役写新版本');
      }
      assert.deepEqual(
        result.target.pointers.map((pointer) => pointer.id).sort(),
        [...EXP_IDS.slice(0, 2)].sort(),
        'C 的指针取并集',
      );

      // 退役指针不悬空：C 必须已存在。
      const target = await fasti.getEvent(result.target.id);
      assert.equal(target.id, result.target.id);
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('写原语：并发调用不交叉写入（单写者队列保证版本号不重复）', async () => {
  const root = makeTempRoot();
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await seedExperiences(fasti);
      const log = EventLog.open(layoutOf(root).events);
      for (const id of ['evt-1', 'evt-2', 'evt-3', 'evt-4']) {
        log.appendVersion(
          makeEvent({
            id,
            pointers: [{ id: EXP_IDS[0], channel: 'dsh' }],
          }),
        );
      }

      // 并发发起 4 个重写摘要 —— 若不排队，版本号会撞（都读到 version=1 → 都写 version=2）。
      const results = await Promise.all([
        fasti.rewriteEventSummary({ eventId: 'evt-1', summary: '摘要一' }),
        fasti.rewriteEventSummary({ eventId: 'evt-2', summary: '摘要二' }),
        fasti.rewriteEventSummary({ eventId: 'evt-3', summary: '摘要三' }),
        fasti.rewriteEventSummary({ eventId: 'evt-4', summary: '摘要四' }),
      ]);

      for (const event of results) {
        assert.equal(event.version, 2, '并发写入后版本号应为 2（未撞车）');
        assert.equal(event.summary_source, 'her', '她手写的摘要标 her');
      }

      // 每个事件的版本历史都是 2 行（version 1 + version 2），没有重复版本。
      for (const id of ['evt-1', 'evt-2', 'evt-3', 'evt-4']) {
        const versions = await fasti.listEventVersions(id);
        assert.equal(versions.length, 2, `${id}：应是两版，未交叉写入`);
        assert.deepEqual(
          versions.map((event) => event.version),
          [1, 2],
        );
      }
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('写原语：拆分 —— A 置 split 并带 split_into，两个子事件各取自己的指针', async () => {
  const root = makeTempRoot();
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await seedExperiences(fasti);
      const log = EventLog.open(layoutOf(root).events);
      log.appendVersion(
        makeEvent({
          id: 'evt-split',
          pointers: [
            { id: EXP_IDS[0], channel: 'dsh' },
            { id: EXP_IDS[1], channel: 'dsh' },
          ],
        }),
      );

      const result = await fasti.splitEvent({
        sourceId: 'evt-split',
        groups: [[EXP_IDS[0]], [EXP_IDS[1]]],
      });

      assert.equal(result.retired.status, 'split');
      assert.deepEqual(result.retired.split_into, result.children.map((child) => child.id));
      assert.equal(result.children.length, 2);
      assert.deepEqual(
        result.children.map((child) => child.pointers.map((pointer) => pointer.id)),
        [[EXP_IDS[0]], [EXP_IDS[1]]],
      );
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('写原语：改边界换指针并写新版本；重开 closed → open；重写摘要标 her', async () => {
  const root = makeTempRoot();
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await seedExperiences(fasti);
      const log = EventLog.open(layoutOf(root).events);
      log.appendVersion(
        makeEvent({
          id: 'evt-x',
          pointers: [
            { id: EXP_IDS[0], channel: 'dsh' },
            { id: EXP_IDS[1], channel: 'dsh' },
          ],
        }),
      );

      // 改边界：**移出**一条记录 → 指针集合变化 + 版本推进。
      //
      // 这里刻意不用「移入」：经门面摄入过的记录，切分器都会给它挂上一个 open 事件
      // （那是它的正常工作），于是「移入」必然先撞唯一归属闸 —— 得先在原事件移出。
      // 归属闸本身由下面那条用例与本文件的 correction 用例覆盖，这里只验版本推进。
      const revised = await fasti.reviseEventBoundary({
        eventId: 'evt-x',
        removePointerIds: [EXP_IDS[1]],
      });
      assert.equal(revised.event.version, 2);
      assert.deepEqual(
        revised.event.pointers.map((pointer) => pointer.id),
        [EXP_IDS[0]],
      );

      // 重开：closed → open。
      const reopened = await fasti.reopenEvent({ eventId: 'evt-x' });
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.version, 3);

      // 重写摘要：summary_source='her'。
      const rewritten = await fasti.rewriteEventSummary({
        eventId: 'evt-x',
        summary: '她改了摘要',
      });
      assert.equal(rewritten.summary, '她改了摘要');
      assert.equal(rewritten.summary_source, 'her');
      assert.equal(rewritten.version, 4);
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('写原语：修正后事件投影同步到新版本（投影只存当前态）', async () => {
  const root = makeTempRoot();
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await seedExperiences(fasti);
      const log = EventLog.open(layoutOf(root).events);
      log.appendVersion(makeEvent({ id: 'evt-p' }));

      await fasti.rewriteEventSummary({ eventId: 'evt-p', summary: '投影里的新摘要' });

      const rows = await fasti.projectionEngine.allEvents();
      const projected = rows.find((row) => row.id === 'evt-p');
      assert.equal(projected?.version, 2, '投影应反映修正后的当前态');
      assert.equal(projected?.summary, '投影里的新摘要');
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 冻结面不动 ──────────────────────────────────────────────────────────

test('A 块冻结面不动：FastiPrimitives 仍是 15 个原语，事件原语走独立接口', async () => {
  assert.equal(PRIMITIVE_NAMES.length, 15, 'A 块原语数不变');
  // 断言的是「事件原语**不在** A 块原语表里」——`PRIMITIVE_NAMES` 是字面量元组，
  // 直接 includes 一个它不可能含的字符串会被 TS 拒（那正是这条断言要表达的事），
  // 故先放宽成 string[] 再查。
  assert.ok(!(PRIMITIVE_NAMES as readonly string[]).includes('mergeEvents'), '事件原语不得混进 A 块原语表');

  const root = makeTempRoot();
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      // 同一个对象同时实现两个接口（不出现「两个门面」）。
      assert.equal(typeof fasti.query, 'function');
      assert.equal(typeof fasti.queryEvents, 'function');
      assert.equal(typeof fasti.mergeEvents, 'function');
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 归属闸 / 单轮时长闸：接在门面路径上才算数 ──────────────────────────

test('门面：跨事件移入被拒 —— 归属闸真的接在门面路径上（错误信息指出归属事件）', async () => {
  const root = makeTempRoot();
  try {
    const fasti = await Fasti.open({ dataRoot: root });
    try {
      await seedExperiences(fasti);
      const log = EventLog.open(layoutOf(root).events);
      log.appendVersion(makeEvent({ id: 'evt-A', pointers: [{ id: EXP_IDS[0], channel: 'dsh' }] }));

      // 经门面摄入的记录，切分器都已经给它挂上了事件 —— 归属就取真源里的事实，
      // 不在测试里假设 id（假设出来的 id 会随摄入路径变化而失效）。
      const owner = log.readAll().find((event) => event.pointers.some((p) => p.id === EXP_IDS[1]));
      assert.ok(owner !== undefined, '样本前提：这条记录当前确实属于某个事件');

      await assert.rejects(
        () => fasti.reviseEventBoundary({ eventId: 'evt-A', addPointerIds: [EXP_IDS[1]] }),
        (error: unknown) => {
          assert.match((error as Error).message, /当前属于事件/, '要指出这条记录当前归谁');
          assert.ok(
            (error as Error).message.includes(owner.id),
            `错误信息必须含归属事件 id（${owner.id}）`,
          );
          return true;
        },
      );
      // 被拒 = 没写版本（不是写了一半被回滚）。
      assert.equal(log.currentOf('evt-A').version, 1);
      assert.deepEqual(log.currentOf('evt-A').pointers.map((p) => p.id), [EXP_IDS[0]]);
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('drainClosure：单轮总时长到限即返回（条数没到上限也返回，让调度排下一轮）', async () => {
  const root = makeTempRoot();
  try {
    // 阶段一：先造 6 条「闭合 + 待补摘要」的事件（真实指针，否则会走「原文取不到」的岔路）。
    const first = await Fasti.open({ dataRoot: root });
    try {
      await seedExperiences(first);
      const log = EventLog.open(layoutOf(root).events);
      for (let index = 0; index < 6; index += 1) {
        log.appendVersion(
          makeEvent({ id: `evt-${index}`, pointers: [{ id: EXP_IDS[0], channel: 'dsh' }] }),
        );
      }
    } finally {
      await first.close();
    }

    // 阶段二：带一个「永不返回」的端口重新打开 —— 启动清道夫会把 6 条都排进队列。
    const hangPort: LLMPort = {
      summarize: () => new Promise<never>(() => undefined),
    };
    const fasti = await Fasti.open({
      dataRoot: root,
      llmPort: hangPort,
      closureCallTimeoutMs: 25,
    });
    try {
      const startedMs = Date.now();
      const processed = await fasti.drainClosure(10, 55);
      const elapsedMs = Date.now() - startedMs;

      assert.ok(processed >= 1, '至少处理一条（证明队列真的被推起来了）');
      assert.ok(processed < 6, `时长到限必须提前返回（实际处理 ${processed} 条 / 共 6 条）`);
      assert.ok(elapsedMs < 3_000, `不该拖成一整轮（实际 ${elapsedMs}ms）`);
      // 没处理完的任务不会丢：真源仍是 pending，下一轮还会被摘。
      assert.ok((await fasti.pendingSummaryCount()) >= 1);
    } finally {
      await fasti.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});
