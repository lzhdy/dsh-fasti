/**
 * #171 · 闭合永久失败台账（只记录不拦截）红测。
 *
 * 断言对象：`src/event/closure-failure-ledger.ts` 与 `ClosurePipeline` 的接线。
 *
 * 纪律：
 *  - 临时数据根（mkdtemp，沿用 tests/helpers.ts），真实数据根零写入；
 *  - 只对**终结态**（exhausted / permanent）落盘，retry 态一律不写（防刷屏）；
 *  - 台账是运行态观测（`state/closure-failures.jsonl`），不是事实源；
 *  - **本版不改变重试行为**：sweepPending 仍按 pending 重新入队（不拦截）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import { InMemoryBacklog, RETRY_MAX_ATTEMPTS } from '../../src/event/backlog.ts';
import type { Backlog, BacklogTask } from '../../src/event/backlog.ts';
import { ClosurePipeline } from '../../src/event/closure.ts';
import {
  CLOSURE_FAILURES_FILE,
  FileClosureFailureLedger,
  readClosureFailures,
} from '../../src/event/closure-failure-ledger.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { FakeLlmPort } from '../helpers/fake-llm-port.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const BASE_TIME = '2026-11-08T10:00:00.000Z';
const EVENT_ID = 'evt-ledger-1';

/** 造一条闭合、待摘要（pending）的事件。 */
function makeEvent(id: string = EVENT_ID): EventRecord {
  return {
    id,
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'closed',
    pointers: [{ id: 'exp-1', channel: 'dsh', shard: '2026-11', seq: 0 }],
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
    effective_chars: null,
    raw_chars: null,
  };
}

/** 预置尝试次数的队列桩：把 attempts 调到指定值，记录 complete/retry 走向。 */
class PreloadedBacklog implements Backlog {
  private task: BacklogTask | undefined;
  completed = false;
  retried = false;

  constructor(attempts: number) {
    this.task = { eventId: EVENT_ID, attempts, nextAttemptAtMs: 0 };
  }

  enqueue(): boolean {
    return true;
  }

  dequeue(): BacklogTask | undefined {
    return this.task;
  }

  complete(): void {
    this.completed = true;
    this.task = undefined;
  }

  retry(task: BacklogTask, nowMs: number): void {
    this.retried = true;
    this.task = { eventId: task.eventId, attempts: task.attempts + 1, nextAttemptAtMs: nowMs + 30_000 };
  }

  size(): number {
    return this.task === undefined ? 0 : 1;
  }

  snapshot(): BacklogTask[] {
    return this.task ? [this.task] : [];
  }
}

interface Harness {
  readonly root: string;
  readonly log: EventLog;
  readonly pipeline: ClosurePipeline;
  readonly ledgerPath: string;
}

/**
 * 装配管线：reader 缺成员 → 建表失败（确定性走 failTask，不碰 permanent 特例）；
 * port 为 null 时走「模型未配置」permanent 分支。
 */
function harness(options: {
  readonly backlog: Backlog;
  readonly port?: 'fake-empty' | 'none';
  readonly withLedger: boolean;
}): Harness {
  const root = makeTempRoot('task171-ledger-');
  const log = new EventLog(layoutOf(root).events);
  log.appendVersion(makeEvent());
  const ledger = options.withLedger ? new FileClosureFailureLedger(layoutOf(root).state) : undefined;
  const pipeline = new ClosurePipeline({
    log,
    port: options.port === 'none' ? null : new FakeLlmPort([]),
    backlog: options.backlog,
    readTexts: () => ['用户问晚餐吃什么'],
    readExperience: { readExperience: () => undefined },
    ...(ledger === undefined ? {} : { failureLedger: ledger }),
  });
  return { root, log, pipeline, ledgerPath: path.join(layoutOf(root).state, CLOSURE_FAILURES_FILE) };
}

test('#171-1 连续失败达上限 → exhausted 结算落盘一行，字段完整', async () => {
  const backlog = new PreloadedBacklog(RETRY_MAX_ATTEMPTS - 1);
  const h = harness({ backlog, withLedger: true });
  try {
    await h.pipeline.processOne(0);

    assert.equal(backlog.completed, true, '耗尽出队');
    assert.ok(fs.existsSync(h.ledgerPath), `台账文件必须落盘：${h.ledgerPath}`);
    const rows = readClosureFailures(layoutOf(h.root).state);
    assert.equal(rows.length, 1, '一次终结结算只落一行');
    const row = rows[0]!;
    assert.equal(row.event_id, EVENT_ID);
    assert.equal(row.state, 'exhausted');
    assert.equal(row.attempts, RETRY_MAX_ATTEMPTS, 'attempts 记录本轮结算的累计次数');
    assert.equal(row.settlement_index, 1, '首次终结结算 index 为 1');
    assert.equal(typeof row.at, 'string');
    assert.notEqual(row.error, '', '错误文本非空');
    assert.equal(row.reason, 'l3-serial-table-broken', 'detail.reason 原样带出，便于分桶排查');
  } finally {
    cleanupTempRoot(h.root);
  }
});

test('#171-2 retry 态不落盘（只记终结态，防刷屏）', async () => {
  const backlog = new PreloadedBacklog(0);
  const h = harness({ backlog, withLedger: true });
  try {
    await h.pipeline.processOne(0);

    assert.equal(backlog.retried, true, '首次失败走退避重试');
    assert.equal(backlog.completed, false);
    assert.equal(fs.existsSync(h.ledgerPath), false, 'retry 态绝不写台账');
    assert.equal(h.pipeline.failures().length, 1, '内存环形缓冲仍留一条（既有行为不变）');
  } finally {
    cleanupTempRoot(h.root);
  }
});

test('#171-3 未注入台账 → 零落盘、零行为变化（旧构造完全兼容）', async () => {
  const backlog = new PreloadedBacklog(RETRY_MAX_ATTEMPTS - 1);
  const h = harness({ backlog, withLedger: false });
  try {
    await h.pipeline.processOne(0);
    assert.equal(backlog.completed, true, '耗尽出队行为不变');
    assert.equal(fs.existsSync(h.ledgerPath), false, '无注入则无落盘');
  } finally {
    cleanupTempRoot(h.root);
  }
});

test('#171-4 模型未配置 → permanent 结算落盘一行（attempts=0）', () => {
  const root = makeTempRoot('task171-ledger-');
  const log = new EventLog(layoutOf(root).events);
  log.appendVersion(makeEvent());
  const ledger = new FileClosureFailureLedger(layoutOf(root).state);
  const pipeline = new ClosurePipeline({
    log,
    port: null,
    backlog: new InMemoryBacklog(),
    readTexts: () => ['用户问晚餐吃什么'],
    readExperience: { readExperience: () => undefined },
    failureLedger: ledger,
  });
  try {
    pipeline.sweepPending();
    const rows = readClosureFailures(layoutOf(root).state);
    assert.equal(rows.length, 1, 'permanent 必须留痕');
    assert.equal(rows[0]!.state, 'permanent');
    assert.equal(rows[0]!.attempts, 0, 'permanent = 从没试过');
    assert.match(rows[0]!.error, /模型未配置/, '错误文本如实表达「无 LLM 端口」');
  } finally {
    cleanupTempRoot(root);
  }
});

test('#171-5 permanent 重复清扫不重复写（幂等）', () => {
  const root = makeTempRoot('task171-ledger-');
  const log = new EventLog(layoutOf(root).events);
  log.appendVersion(makeEvent());
  const ledger = new FileClosureFailureLedger(layoutOf(root).state);
  const pipeline = new ClosurePipeline({
    log,
    port: null,
    backlog: new InMemoryBacklog(),
    readTexts: () => ['用户问晚餐吃什么'],
    readExperience: { readExperience: () => undefined },
    failureLedger: ledger,
  });
  try {
    pipeline.sweepPending();
    pipeline.sweepPending();
    pipeline.sweepPending();
    const rows = readClosureFailures(layoutOf(root).state);
    assert.equal(rows.length, 1, '同一事件同一进程只结算一次');
  } finally {
    cleanupTempRoot(root);
  }
});

test('#171-6 跨进程累计：新实例读回历史并续写 settlement_index', () => {
  const root = makeTempRoot('task171-ledger-');
  try {
    const dir = layoutOf(root).state;
    const first = new FileClosureFailureLedger(dir);
    first.append({
      event_id: EVENT_ID,
      at: '2026-11-24T00:00:00.000Z',
      attempts: RETRY_MAX_ATTEMPTS,
      state: 'exhausted',
      error: '第一次耗尽',
    });
    assert.equal(first.lookup(EVENT_ID)?.settlements, 1);

    // 模拟进程重启：新实例从磁盘载入历史。
    const second = new FileClosureFailureLedger(dir);
    const history = second.lookup(EVENT_ID);
    assert.equal(history?.settlements, 1, '重启后仍能读到历史结算次数');
    assert.equal(history?.last_error, '第一次耗尽', '重启后仍能读到上次错误');
    assert.equal(history?.total_attempts, RETRY_MAX_ATTEMPTS, '累计尝试次数跨进程可见');

    const appended = second.append({
      event_id: EVENT_ID,
      at: '2026-11-24T01:00:00.000Z',
      attempts: 3,
      state: 'permanent',
      error: '第二次结算',
    });
    assert.equal(appended.settlement_index, 2, '续写 settlement_index 递增');
    assert.equal(second.lookup(EVENT_ID)?.settlements, 2);
    assert.equal(second.lookup(EVENT_ID)?.total_attempts, RETRY_MAX_ATTEMPTS + 3);
    assert.equal(readClosureFailures(dir).length, 2, 'append-only：历史行不丢');
  } finally {
    cleanupTempRoot(root);
  }
});

test('#171-7 末行截断残行容忍：构造不抛、残行不消费、仍可续写', () => {
  const root = makeTempRoot('task171-ledger-');
  try {
    const dir = layoutOf(root).state;
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, CLOSURE_FAILURES_FILE);
    const good = JSON.stringify({
      event_id: EVENT_ID,
      at: '2026-11-24T00:00:00.000Z',
      attempts: 8,
      state: 'exhausted',
      error: '完整行',
      settlement_index: 1,
    });
    fs.writeFileSync(filePath, `${good}\n{"event_id":"evt-ledger-1","at":"2026-11-24T0`, 'utf8');

    const ledger = new FileClosureFailureLedger(dir);
    assert.equal(ledger.lookup(EVENT_ID)?.settlements, 1, '残行不计入，完整行照常读');
    const appended = ledger.append({
      event_id: EVENT_ID,
      at: '2026-11-24T02:00:00.000Z',
      attempts: 1,
      state: 'permanent',
      error: '续写',
    });
    assert.equal(appended.settlement_index, 2);
  } finally {
    cleanupTempRoot(root);
  }
});

test('#171-8 本版不拦截：台账已有 exhausted 记录，sweepPending 仍重新入队', () => {
  const root = makeTempRoot('task171-ledger-');
  try {
    const dir = layoutOf(root).state;
    const ledger = new FileClosureFailureLedger(dir);
    ledger.append({
      event_id: EVENT_ID,
      at: '2026-11-24T00:00:00.000Z',
      attempts: RETRY_MAX_ATTEMPTS,
      state: 'exhausted',
      error: '历史耗尽',
    });

    const log = new EventLog(layoutOf(root).events);
    log.appendVersion(makeEvent());
    const backlog = new InMemoryBacklog();
    const pipeline = new ClosurePipeline({
      log,
      port: new FakeLlmPort([]),
      backlog,
      readTexts: () => ['用户问晚餐吃什么'],
      readExperience: { readExperience: () => undefined },
      failureLedger: new FileClosureFailureLedger(dir),
    });

    const swept = pipeline.sweepPending();
    assert.equal(swept, 1, '本版只记录不拦截：仍在重试队列里');
    assert.equal(backlog.size(), 1);
  } finally {
    cleanupTempRoot(root);
  }
});
