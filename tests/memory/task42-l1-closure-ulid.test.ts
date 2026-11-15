/**
 * #42 · L1 前置卡红测（正本 §2.1 前置甲、§4.1 L1、§1.1 V-05、§4.4 MU-3 对位）。
 *
 * 断言对象：`src/event/closure.ts` 写入路径在落盘前必须对 anchors 做
 * 「26 位 Crockford ULID 形态」fail-closed 断言。
 *
 * 纪律（本文件只写测试，绝不改 src/）：
 *  - 临时数据根（mkdtemp，沿用 tests/helpers.ts），真实数据根零写入；
 *  - 确定性夹具：固定时间戳 ULID 生成器，不用 Date.now() 抖动；
 *  - 非法形态必须在 `appendVersion` 之前拦截（真源文件无新增 v2 行）；按裁决 4a
 *    错误走 failTask 收编进失败明细并退避，不再抛穿管线；
 *  - 合法 26 位 Crockford ULID 零误伤，正常写回新版本。
 *
 * 错误类：`AnchorFormInvalidError extends SchemaError`（code='SCHEMA'，src 侧导出）；
 * 收编后管线对外只暴露失败明细文本，类身份由 src 内部闸点保证。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import { UlidGenerator } from '../../src/core/ulid.ts';
import { InMemoryBacklog, RETRY_MAX_ATTEMPTS } from '../../src/event/backlog.ts';
import type { Backlog, BacklogTask } from '../../src/event/backlog.ts';
import { ClosurePipeline } from '../../src/event/closure.ts';
import type { LLMPort, LLMSummarizeRequest, LLMSummarizeResponse } from '../../src/event/llm-port.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { cleanupTempRoot, countLines, makeTempRoot } from '../helpers.ts';

const BASE_TIME = '2026-11-08T10:00:00.000Z';
const EVENT_ID = 'evt-l1';

/** 固定时间戳（2026-11-08 02:13:20 UTC）派生的确定性 ULID，同次构建两次一致。 */
const deterministicUlid = new UlidGenerator(() => 1_772_000_000_000).next();

/** 既有 fixture 形态（大写 26 位 Crockford，与 tests/api、tests/contract 存量一致）。 */
const FIXTURE_SHAPE_A = '01J0000000000000000000000A';
/** 既有真实 fixture（tests/fixtures/expected-segments-v1.4.json 取值形态）。 */
const FIXTURE_SHAPE_B = '01M6XFHE6S48Y4V1M4BZV5BVFJ';

/** 造一条闭合、待摘要（pending）的事件，v1 原样落真源。 */
function makeEvent(): EventRecord {
  return {
    id: EVENT_ID,
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

/** 假端口：按预设响应产出 anchors。 */
class FakePort implements LLMPort {
  response: LLMSummarizeResponse;

  constructor(anchors: readonly unknown[]) {
    this.response = {
      summary: '她打开了一个网页。',
      keyPoints: [],
      anchors: anchors as readonly string[],
    };
  }

  async summarize(request: LLMSummarizeRequest): Promise<LLMSummarizeResponse> {
    void request;
    return this.response;
  }
}

interface Harness {
  root: string;
  log: EventLog;
  backlog: Backlog;
  pipeline: ClosurePipeline;
}

/** 成员指针夹具：id 与夹具锚点一致（L2 成员包含闸点查面）。 */
function memberPointer(id: string): EventRecord['pointers'][number] {
  return { id, channel: 'dsh', shard: '2026-11', seq: 0 };
}

/** 临时根 + 真源 v1 事件 + 队列 + 假端口；anchors 由调用方给定。 */
function harness(anchors: readonly unknown[], backlog: Backlog = new InMemoryBacklog()): Harness {
  const root = makeTempRoot('task42-l1-');
  const port = new FakePort(anchors);
  const log = new EventLog(layoutOf(root).events);
  const anchorIds = anchors.map((anchor) => String(anchor));
  // 窄 reader：只回 id/channel/occurredAtMs；夹具锚点即成员引用。
  const readExperience = {
    readExperience: (id: string) =>
      anchorIds.includes(id)
        ? { id, channel: 'dsh', occurredAtMs: Date.parse(BASE_TIME) }
        : undefined,
  };
  const pipeline = new ClosurePipeline({
    log,
    port,
    backlog,
    readTexts: () => ['用户问晚餐吃什么', '她列了三个选项'],
    readExperience,
  });
  log.appendVersion({ ...makeEvent(), pointers: anchorIds.map(memberPointer) });
  pipeline.enqueue(EVENT_ID);
  return { root, log, backlog, pipeline };
}

/** 真源 events 分片文件里的总行数（跨分片累加，避免钉死月份文件名）。 */
function sourceLineCount(root: string): number {
  const eventsDir = path.join(root, 'events');
  if (!fs.existsSync(eventsDir)) {
    return 0;
  }
  let total = 0;
  for (const entry of fs.readdirSync(eventsDir)) {
    if (!entry.endsWith('.jsonl')) {
      continue;
    }
    total += countLines(path.join(eventsDir, entry));
  }
  return total;
}

// ── 非法形态：必须在落盘前 fail-closed ─────────────────────────────────────

/**
 * 收编口径（裁决 4a）：坏锚点形态闸在 appendVersion 之前拦截，错误走 failTask
 * 进失败明细 + 退避，不再抛穿管线。fail-closed 语义不变：真源无 v2、磁盘无新行、
 * v1 锚点不被脏值改写。
 */
async function runAndAssertBlocked(
  pipeline: ClosurePipeline,
  log: EventLog,
  root: string,
  raw?: string,
): Promise<void> {
  const processed = await pipeline.processOne(0);
  assert.equal(processed, true, '坏锚点被收编为失败任务（不再抛穿管线）');
  const failures = pipeline.failures();
  assert.equal(failures.length, 1, '坏锚点必须进失败明细');
  assert.equal(failures[0]!.eventId, EVENT_ID);
  if (raw !== undefined) {
    assert.ok(
      failures[0]!.error.includes(raw),
      `失败明细 error 须含坏锚点原值，实际：${failures[0]!.error}`,
    );
  }
  assert.equal(log.versionsOf(EVENT_ID).length, 1, '拦截先于落盘：真源仍只有 v1');
  assert.equal(sourceLineCount(root), 1, '磁盘分片未追加新版本行');
  const v1 = log.currentOf(EVENT_ID);
  assert.deepEqual(v1.anchors, [], 'v1 原样保留，锚点未被脏值改写');
}

/** 字符串形态非法向量：自由标签 / 小写 / Crockford 禁用字符 / 长度越界 / 空白 / 连字符。 */
const ILLEGAL_STRING_CASES: ReadonlyArray<readonly [string, string]> = [
  ['自由标签 web_search', 'web_search'],
  ['小写 ULID', '01j0000000000000000000000a'],
  ['禁用字符 I', '01J0000000000000000000000I'],
  ['禁用字符 L', '01J0000000000000000000000L'],
  ['禁用字符 O', '01J0000000000000000000000O'],
  ['禁用字符 U', '01J0000000000000000000000U'],
  ['长度 25', '01J000000000000000000000'],
  ['长度 27', '01J0000000000000000000000AA'],
  ['空串', ''],
  ['纯空白串', '   '],
  [
    '带连字符的 26 位',
    `${'01J0000000'.slice(0, 10)}-${'000000000000000'.slice(0, 15)}`,
  ],
];

for (const [label, anchor] of ILLEGAL_STRING_CASES) {
  test(`L1 形态闸：${label}（${JSON.stringify(anchor)}）落盘前被拦（收编退避）`, async () => {
    const { root, log, pipeline } = harness([anchor]);
    try {
      await runAndAssertBlocked(pipeline, log, root, anchor);
    } finally {
      cleanupTempRoot(root);
    }
  });
}

/** 非字符串元素：undefined / null / number（契约层本就拒收，L1 闸须同样先于落盘拦住）。 */
const ILLEGAL_PRIMITIVE_CASES: ReadonlyArray<readonly [string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['数字', 12345],
];

for (const [label, value] of ILLEGAL_PRIMITIVE_CASES) {
  test(`L1 形态闸：锚点元素为 ${label} 时落盘前被拦（收编退避）`, async () => {
    const { root, log, pipeline } = harness([value]);
    try {
      await runAndAssertBlocked(pipeline, log, root);
    } finally {
      cleanupTempRoot(root);
    }
  });
}

test('L1 形态闸：合法锚点与非法锚点混合时，整批拒绝（不写半份）', async () => {
  const { root, log, pipeline } = harness([FIXTURE_SHAPE_A, 'web_search']);
  try {
    await runAndAssertBlocked(pipeline, log, root, 'web_search');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 合法形态：零误伤 ────────────────────────────────────────────────────────

const VALID_CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['既有 fixture 形态（单锚）', [FIXTURE_SHAPE_A]],
  ['既有真实 fixture 取值', [FIXTURE_SHAPE_B]],
  ['确定性生成器产出的 ULID', [deterministicUlid]],
  ['两个合法 ULID', [FIXTURE_SHAPE_A, deterministicUlid]],
];

for (const [label, anchors] of VALID_CASES) {
  test(`L1 形态闸：${label} 零误伤，正常写回新版本`, async () => {
    const { root, log, pipeline } = harness(anchors);
    try {
      const processed = await pipeline.processOne(0);
      assert.equal(processed, true, '任务被正常处理');

      const versions = log.versionsOf(EVENT_ID);
      assert.equal(versions.length, 2, '合法锚点放行：追加 v2');
      const current = log.currentOf(EVENT_ID);
      assert.equal(current.version, 2);
      assert.equal(current.summary_quality, 'ready');
      assert.equal(current.summary_source, 'llm');
      assert.deepEqual(current.anchors, anchors, '锚点原样落盘，精确相等');
      assert.equal(sourceLineCount(root), 2, '真源两行：v1 + v2');
    } finally {
      cleanupTempRoot(root);
    }
  });
}

// ── 坏锚点走退避（§6.3.1 失败三态）：失败进明细、退避重排、耗尽出队 ──────────

/**
 * 预置尝试次数的队列桩：直接把任务 attempts 调到耗尽前一拍，
 * 避免用例连跑 RETRY_MAX_ATTEMPTS 次；记录 complete/retry 走向供断言。
 */
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

test('L1 退避：坏锚点进失败明细，error 文本含坏锚点原值，且先于落盘', async () => {
  const { root, log, pipeline } = harness(['web_search']);
  try {
    // 红相：AnchorFormInvalidError 从 writeSummary 抛穿、未走 failTask；
    // 转绿后 processOne 收编为失败任务、不再抛穿。这里先兜住抛穿，断言失败明细。
    try {
      await pipeline.processOne(0);
    } catch {
      // 转绿后不应再抛；红相抛穿不影响下方失败明细断言。
    }

    const failures = pipeline.failures();
    assert.equal(failures.length, 1, '坏锚点必须走 failTask 进失败明细，不能直接抛穿');
    assert.equal(failures[0]!.eventId, EVENT_ID, '失败明细挂到本事件');
    assert.ok(
      failures[0]!.error.includes('web_search'),
      `失败明细 error 须含坏锚点原值，实际：${failures[0]!.error}`,
    );
    assert.equal(log.versionsOf(EVENT_ID).length, 1, '失败先于落盘：真源仍只有 v1');
    assert.equal(sourceLineCount(root), 1, '磁盘分片未追加新版本行');
  } finally {
    cleanupTempRoot(root);
  }
});

test('L1 退避：坏锚点下一拍 nextAttemptAtMs > nowMs（退避生效，不再恒为 0）', async () => {
  const nowMs = 1_772_000_000_000;
  const { root, backlog, pipeline } = harness(['web_search']);
  try {
    try {
      await pipeline.processOne(nowMs);
    } catch {
      // 红相抛穿，转绿后收编退避。
    }
    const tasks = backlog.snapshot();
    assert.equal(tasks.length, 1, '重试任务仍留在队列');
    assert.ok(
      tasks[0]!.nextAttemptAtMs > nowMs,
      `退避后下次可执行时刻应晚于 ${nowMs}，实际 ${tasks[0]!.nextAttemptAtMs}`,
    );
  } finally {
    cleanupTempRoot(root);
  }
});

test('L1 耗尽：连续失败达 RETRY_MAX_ATTEMPTS → exhausted 出队，事件仍 pending、真源无新版本', async () => {
  const backlog = new PreloadedBacklog(RETRY_MAX_ATTEMPTS - 1);
  const { root, log, pipeline } = harness(['web_search'], backlog);
  try {
    try {
      await pipeline.processOne(0);
    } catch {
      // 红相抛穿，转绿后收编为 exhausted。
    }
    const failures = pipeline.failures();
    assert.equal(failures.length, 1, '耗尽事件留一条失败明细');
    assert.equal(failures[0]!.state, 'exhausted', `处置应为 exhausted，实际 ${failures[0]!.state}`);
    assert.equal(failures[0]!.exhausted, true, 'exhausted 派生便捷位为 true');
    assert.equal(backlog.completed, true, '耗尽后任务出队，不再被取');
    assert.equal(backlog.retried, false, '耗尽不再安排退避重试');
    assert.equal(backlog.size(), 0, '队列中无残留任务');

    const current = log.currentOf(EVENT_ID);
    assert.equal(current.summary_quality, 'pending', '事件保持 pending，不写占位摘要');
    assert.equal(log.versionsOf(EVENT_ID).length, 1, '真源无新版本');
    assert.equal(sourceLineCount(root), 1, '磁盘分片未追加新版本行');
  } finally {
    cleanupTempRoot(root);
  }
});

test('L1 护栏：anchors: [] 合法弃权，不抛错、照常落盘空锚点（防将来误拦 abstain）', async () => {
  const { root, log, pipeline } = harness([]);
  try {
    const processed = await pipeline.processOne(0);
    assert.equal(processed, true, '空锚点属于合法弃权，任务正常处理');
    const current = log.currentOf(EVENT_ID);
    assert.deepEqual(current.anchors, [], '空锚点原样落盘，精确相等');
    assert.equal(current.summary_quality, 'ready');
    assert.equal(log.versionsOf(EVENT_ID).length, 2, '空锚点放行：追加 v2');
  } finally {
    cleanupTempRoot(root);
  }
});
