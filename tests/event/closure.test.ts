/**
 * 闭合管线测试（技术基线 §6.3–§6.5 · 任务卡 T8 / T9 / G07）。
 *
 * 覆盖：
 *  - pending → ready 流程（回写新版本、append-only、summary_source='llm'）；
 *  - 硬约束两条（超 600 字拒绝、空摘要拒绝）且**不设字数下限**；
 *  - 降级（端口不可用 / 调用失败 / 原文取不到）：保持 pending、不伪造、退避重试；
 *  - 启动清道夫（重扫 pending 重新入队、幂等）；
 *  - 重放幂等（同一事件重复入队只处理一次）；
 *  - LLM 慢 / 挂时摄入不阻塞、事件仍可检索。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { InMemoryBacklog, RETRY_BASE_DELAY_MS } from '../../src/event/backlog.ts';
import { ClosurePipeline } from '../../src/event/closure.ts';
import type { ClosureFailure } from '../../src/event/closure.ts';
import type { LLMPort, LLMSummarizeRequest, LLMSummarizeResponse } from '../../src/event/llm-port.ts';
import { SUMMARY_PROMPT_VERSION } from '../../src/event/params.ts';
import type { EventParams } from '../../src/event/params.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const BASE_TIME = '2026-11-08T10:00:00.000Z';

/** 造一条闭合但未出摘要的事件（pending）。 */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const base: EventRecord = {
    id: 'evt-1',
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
  return { ...base, ...overrides };
}

/** 假端口：记录收到的请求，按预设返回或抛错。 */
class FakePort implements LLMPort {
  readonly requests: LLMSummarizeRequest[] = [];
  response: LLMSummarizeResponse = { summary: '她打开了一个网页。', keyPoints: [], anchors: [] };
  error: Error | null = null;
  /** 挂起：调用后永不 resolve（模拟模型挂住）。 */
  hang = false;

  async summarize(request: LLMSummarizeRequest): Promise<LLMSummarizeResponse> {
    this.requests.push(request);
    if (this.hang) {
      return new Promise<LLMSummarizeResponse>(() => undefined);
    }
    if (this.error !== null) {
      throw this.error;
    }
    return this.response;
  }
}

/** 造一套管线（事件真源 + 队列 + 假端口）。 */
function makePipeline(
  root: string,
  port: LLMPort | null,
  overrides: {
    onFailure?: (failure: ClosureFailure) => void;
    params?: Partial<EventParams>;
    readTexts?: (event: EventRecord) => string[];
  } = {},
): { log: EventLog; backlog: InMemoryBacklog; pipeline: ClosurePipeline } {
  const log = new EventLog(layoutOf(root).events);
  const backlog = new InMemoryBacklog();
  const pipeline = new ClosurePipeline({
    log,
    port,
    backlog,
    readTexts: overrides.readTexts ?? (() => ['用户问晚餐吃什么', '她列了三个选项']),
    ...(overrides.params === undefined ? {} : { params: overrides.params }),
    ...(overrides.onFailure === undefined ? {} : { onFailure: overrides.onFailure }),
  });
  return { log, backlog, pipeline };
}

// ── pending → ready ──────────────────────────────────────────────────────

test('闭合：pending → ready —— 回写新版本（version+1、summary_source=llm）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    const { log, backlog, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    const processed = await pipeline.processOne(0);

    assert.equal(processed, true);
    const current = log.currentOf('evt-1');
    assert.equal(current.version, 2, '版本推进一版');
    assert.equal(current.status, 'closed', '状态不变');
    assert.equal(current.summary_quality, 'ready');
    assert.equal(current.summary_source, 'llm');
    assert.equal(current.summary, '她打开了一个网页。');
    assert.equal(backlog.size(), 0, '成功后出队');
  } finally {
    cleanupTempRoot(root);
  }
});

test('闭合：回写是 append-only —— 旧版本行仍在，未被改写', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const versions = log.versionsOf('evt-1');
    assert.equal(versions.length, 2, '两行（v1 + v2）');
    assert.equal(versions[0]?.summary, null, 'v1 仍是 pending 原样');
    assert.equal(versions[0]?.summary_quality, 'pending');
    assert.equal(versions[1]?.summary_quality, 'ready');
  } finally {
    cleanupTempRoot(root);
  }
});

test('闭合：提示词按冻结形态生成（system 写法约束 + user 时间范围与原文）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const request = port.requests[0];
    assert.ok(request, '调过一次端口');
    assert.match(request.system, /第三人称/, '第三人称');
    assert.match(request.system, /不写评价/, '不写评价');
    assert.match(request.system, /自检/, '同一次调用里自检');
    assert.match(request.system, /只输出 JSON/, '要求 JSON 输出');
    assert.match(request.user, /2026-11-08T10:00:00.000Z/, '含时间范围');
    assert.match(request.user, /1\. 用户问晚餐吃什么/, '原文按序号列出');
    assert.equal(request.maxChars, 600, '带上硬上限');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 硬约束两条 ───────────────────────────────────────────────────────────

test('硬约束：摘要超 600 字 → 拒绝本次结果（不截断、不入库），事件保持 pending', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = { summary: '她'.repeat(601), keyPoints: [], anchors: [] };
    const { log, backlog, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.version, 1, '没写新版本');
    assert.equal(current.summary, null, '没有占位文案');
    assert.equal(current.summary_quality, 'pending', '如实保持 pending');
    assert.equal(backlog.size(), 1, '任务仍在队列（退避重试）');
  } finally {
    cleanupTempRoot(root);
  }
});

test('硬约束：摘要为空 → 拒绝本次结果，事件保持 pending', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = { summary: '   ', keyPoints: [], anchors: [] };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.version, 1);
    assert.equal(current.summary, null);
    assert.equal(current.summary_quality, 'pending');
  } finally {
    cleanupTempRoot(root);
  }
});

test('硬约束：不设字数下限 —— 8 字的「她打开了一个网页」合法', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = { summary: '她打开了一个网页。', keyPoints: [], anchors: [] };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.summary_quality, 'ready');
    assert.equal(current.summary, '她打开了一个网页。');
  } finally {
    cleanupTempRoot(root);
  }
});

test('硬约束：不写三要素规则检查器 —— 只有结果没有「谁/做了什么/结果如何」的摘要照样放行', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    // 无主语、无结果、无三要素 —— 若内核写了规则检查器，这里就会被拒。
    port.response = { summary: '聊了晚餐。', keyPoints: [], anchors: [] };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    assert.equal(log.currentOf('evt-1').summary_quality, 'ready', '不替她判断语义');
    assert.equal(log.currentOf('evt-1').summary, '聊了晚餐。');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 降级（T9）────────────────────────────────────────────────────────────

test('降级：端口为 null（未配置模型）→ 不入队、不写任何版本，事件保持 pending', async () => {
  const root = makeTempRoot();
  try {
    const { log, backlog, pipeline } = makePipeline(root, null);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    assert.equal(backlog.size(), 0, '没有模型 → 不入队');

    const processed = await pipeline.processOne(0);
    assert.equal(processed, false, '没有任务可处理');

    const current = log.currentOf('evt-1');
    assert.equal(current.version, 1);
    assert.equal(current.summary, null);
    assert.equal(current.summary_quality, 'pending');
  } finally {
    cleanupTempRoot(root);
  }
});

test('降级：端口调用失败 → 事件保持 pending，退避重试（不伪造、不静默丢弃）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.error = new Error('宿主模型路由调用失败');
    const failures: ClosureFailure[] = [];
    const { log, backlog, pipeline } = makePipeline(root, port, {
      onFailure: (failure) => failures.push(failure),
    });
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.version, 1, '没写新版本');
    assert.equal(current.summary, null, '没有占位文案');
    assert.equal(current.summary_quality, 'pending');

    assert.equal(backlog.size(), 1, '任务仍在队列待重试');
    const task = backlog.snapshot()[0];
    assert.equal(task?.attempts, 1, '尝试次数 +1');
    assert.ok((task?.nextAttemptAtMs ?? 0) >= RETRY_BASE_DELAY_MS, '已退避');

    assert.equal(failures.length, 1, '失败被上报（可观测）');
    assert.equal(failures[0]?.eventId, 'evt-1');
    assert.equal(failures[0]?.exhausted, false);
  } finally {
    cleanupTempRoot(root);
  }
});

test('降级：连续失败达上限 → 标记失败并上报（不静默丢弃），事件保持 pending', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.error = new Error('一直失败');
    const failures: ClosureFailure[] = [];
    const { log, backlog, pipeline } = makePipeline(root, port, {
      onFailure: (failure) => failures.push(failure),
    });
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    // 反复处理（每次都失败）直到耗尽重试次数。
    for (let i = 0; i < 20; i += 1) {
      await pipeline.processOne(i * 10_000_000);
    }

    const exhausted = failures.filter((failure) => failure.exhausted);
    assert.equal(exhausted.length, 1, '恰好标记一次失败');
    assert.equal(exhausted[0]?.eventId, 'evt-1');

    const current = log.currentOf('evt-1');
    assert.equal(current.version, 1, '全程没写版本');
    assert.equal(current.summary, null, '没有占位文案');
    assert.equal(current.summary_quality, 'pending', '如实保持 pending');
    assert.equal(backlog.size(), 0, '失败任务已出队（不再空转重试）');
  } finally {
    cleanupTempRoot(root);
  }
});

test('降级：原文取不到 → 不调模型（绝不编造原文），按失败退避', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    const log = new EventLog(layoutOf(root).events);
    const backlog = new InMemoryBacklog();
    const pipeline = new ClosurePipeline({
      log,
      port,
      backlog,
      readTexts: () => [],
    });
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    assert.equal(port.requests.length, 0, '没调模型');
    assert.equal(log.currentOf('evt-1').summary, null);
    assert.equal(log.currentOf('evt-1').summary_quality, 'pending');
    assert.equal(backlog.size(), 1, '待重试');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 启动清道夫（G07）─────────────────────────────────────────────────────

test('清道夫：重扫 pending 事件重新入队 → 事后补齐摘要', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    const { log, backlog, pipeline } = makePipeline(root, port);
    // 模拟「进程被杀时闭合已落盘、但没来得及入队」。
    log.appendVersion(makeEvent({ id: 'evt-1' }));
    log.appendVersion(makeEvent({ id: 'evt-2' }));

    const swept = pipeline.sweepPending();
    assert.equal(swept, 2, '两个 pending 事件都重新入队');
    assert.equal(backlog.size(), 2);

    await pipeline.processOne(0);
    await pipeline.processOne(0);

    assert.equal(log.currentOf('evt-1').summary_quality, 'ready');
    assert.equal(log.currentOf('evt-2').summary_quality, 'ready');
  } finally {
    cleanupTempRoot(root);
  }
});

test('清道夫：幂等 —— 重复扫不产生重复处理', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    const { log, backlog, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    assert.equal(pipeline.sweepPending(), 1);
    assert.equal(pipeline.sweepPending(), 0, '已在队列 → 不重复入队');
    assert.equal(backlog.size(), 1, '队列里仍只有一份');
  } finally {
    cleanupTempRoot(root);
  }
});

test('清道夫：只扫闭合且待补摘要的事件（open 事件不摘、ready 事件不摘）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent({ id: 'evt-open', status: 'open' }));
    log.appendVersion(makeEvent({ id: 'evt-ready', summary_quality: 'ready', summary: '已有摘要' }));
    log.appendVersion(makeEvent({ id: 'evt-pending' }));

    assert.equal(pipeline.sweepPending(), 1, '只扫 evt-pending');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 幂等与不阻塞 ─────────────────────────────────────────────────────────

test('重放幂等：同一事件重复入队 → 只处理一次、只写一个版本', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    const { log, backlog, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    pipeline.enqueue('evt-1');
    pipeline.enqueue('evt-1');
    assert.equal(backlog.size(), 1, '重复入队只留一份');

    await pipeline.processOne(0);
    assert.equal(port.requests.length, 1, '只调一次模型');
    assert.equal(log.versionsOf('evt-1').length, 2, '只写一个新版本');
  } finally {
    cleanupTempRoot(root);
  }
});

test('重放幂等：已 ready 的事件再入队 → 不重复生成摘要', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);
    const afterFirst = log.versionsOf('evt-1').length;

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);
    assert.equal(port.requests.length, 1, '没有第二次调模型');
    assert.equal(log.versionsOf('evt-1').length, afterFirst, '没有多写版本');
  } finally {
    cleanupTempRoot(root);
  }
});

test('不阻塞：LLM 挂住时摄入路径不等待 —— 入队是纯内存操作，事件仍可检索', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.hang = true;
    const { log, backlog, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent({ id: 'evt-1' }));

    // 摄入侧只做「闭合 → 入队」，不 await 模型。
    const started = process.hrtime.bigint();
    pipeline.enqueue('evt-1');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    assert.ok(elapsedMs < 50, `入队不等待模型（${elapsedMs.toFixed(3)}ms）`);
    assert.equal(backlog.size(), 1, '任务已入队');

    // 事件照样可检索（靠 pointers 回原文），摘要在路上。
    const current = log.currentOf('evt-1');
    assert.equal(current.status, 'closed');
    assert.equal(current.pointers.length, 1, '指针在 → 可回原文');
    assert.equal(current.summary_quality, 'pending', '摘要还没好');
  } finally {
    cleanupTempRoot(root);
  }
});

test('不阻塞：模型挂住时 processOne 不写版本（事件保持 pending，等模型回来）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.hang = true;
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    const pending = pipeline.processOne(0);
    // 让出一个事件循环，确认它没被"卡住后写死"。
    await new Promise((resolve) => setTimeout(resolve, 20));

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, '挂住的调用仍未完成（没有伪造结果）');
    assert.equal(log.currentOf('evt-1').summary_quality, 'pending');
  } finally {
    cleanupTempRoot(root);
  }
});

test('不阻塞：模型挂住时，另一事件照常处理（互不牵连）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.hang = true;
    const { log, backlog, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent({ id: 'evt-1' }));

    pipeline.enqueue('evt-1');
    void pipeline.processOne(0); // 挂住，不等它

    // 换一个好端口处理另一个事件 —— 说明管线本身不串行阻塞。
    //
    // 第二条管线必须**复用同一份事件真源实例**（`EventLog.open`）：单写者纪律不许
    // 同一目录出现第二个持有者（那不是待修的缺陷，是防二级真源静默损坏的门禁）。
    // 本用例要证的是「两条管线互不牵连」，与「几个 log 实例」无关。
    const good = new FakePort();
    const log2 = EventLog.open(layoutOf(root).events);
    const backlog2 = new InMemoryBacklog();
    const pipeline2 = new ClosurePipeline({
      log: log2,
      port: good,
      backlog: backlog2,
      readTexts: () => ['原文'],
    });
    log2.appendVersion(makeEvent({ id: 'evt-2' }));
    pipeline2.enqueue('evt-2');
    await pipeline2.processOne(0);

    assert.equal(log2.currentOf('evt-2').summary_quality, 'ready');
    assert.equal(log.currentOf('evt-1').summary_quality, 'pending');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 修正后重跑（§6.5 requestRerun）─────────────────────────────────────

test('重跑：她写的摘要不覆盖 —— summary_source=her 的事件只更新锚点', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = { summary: '模型新写的摘要', keyPoints: ['新要点'], anchors: ['新锚点'] };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(
      makeEvent({
        summary: '她自己写的摘要',
        summary_quality: 'pending',
        summary_source: 'her',
      }),
    );

    pipeline.requestRerun('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.summary, '她自己写的摘要', '她的摘要没被覆盖');
    assert.equal(current.summary_source, 'her', '来源仍是她');
    assert.deepEqual(current.anchors, ['新锚点'], '锚点更新了');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 契约红线自证 ─────────────────────────────────────────────────────────

test('红线：内核层不出现「消费 anchors」的写法（第一期 anchors 生成但不消费）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = { summary: '摘要', keyPoints: [], anchors: ['锚点'] };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    // 只写不读：anchors 被写进版本，但内核不据它做任何判断。
    const current = log.currentOf('evt-1');
    assert.deepEqual(current.anchors, ['锚点'], '锚点确实产出了');
    assert.equal(current.topic_lines.length, 0, 'topic_lines 恒空');
  } finally {
    cleanupTempRoot(root);
  }
});

test('红线：src/event 与 src/adapters 内不出现锚点/话题线的读取式消费', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  const files = [
    'src/event/llm-port.ts',
    'src/event/backlog.ts',
    'src/event/closure.ts',
    'src/adapters/dsh/llm.ts',
  ];
  for (const file of files) {
    const text = readFileSync(path.join(repoRoot, file), 'utf8');
    assert.equal(
      /topic_lines/.test(text),
      false,
      `${file} 不得引用 topic_lines（第一期恒空）`,
    );
  }
});

// ── Major-1：单队列活性（模型调用的硬超时）──────────────────────────────
//
// 要证的是**生产形态**：一条队列、一条管线、两个事件。
// 反例（之前那条「不阻塞」用例）用的是第二条独立管线 —— 那证明的是
// 「两条管线互不牵连」，不是「挂死的任务不会堵死同一条队列」。

/** 第一次调用永挂、之后正常返回的端口 —— 模拟「一条挂死，后面还有活」。 */
class FirstCallHangsPort implements LLMPort {
  calls = 0;
  /** 每次调用收到的 signal（用来断言超时真的 abort 了）。 */
  readonly signals: AbortSignal[] = [];
  readonly requests: LLMSummarizeRequest[] = [];

  async summarize(
    request: LLMSummarizeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<LLMSummarizeResponse> {
    this.calls += 1;
    this.requests.push(request);
    if (options?.signal !== undefined) {
      this.signals.push(options.signal);
    }
    if (this.calls === 1) {
      // 永不 resolve：这就是「宿主路由不返回」的形态。
      return new Promise<LLMSummarizeResponse>(() => undefined);
    }
    return { summary: `第 ${this.calls} 次调用产出的摘要`, keyPoints: [], anchors: [] };
  }
}

test('Major-1 · 单队列活性：第 1 条挂死 → 超时记失败并退回重试，第 2 条照常出摘要', async () => {
  const root = makeTempRoot();
  try {
    const port = new FirstCallHangsPort();
    // 把超时压到 30ms：用例要快，但走的仍是生产那条代码路径。
    const { log, backlog, pipeline } = makePipeline(root, port, {
      params: { closureCallTimeoutMs: 30 },
    });
    log.appendVersion(makeEvent({ id: 'evt-1' }));
    log.appendVersion(makeEvent({ id: 'evt-2' }));
    pipeline.enqueue('evt-1');
    pipeline.enqueue('evt-2');

    const startedMs = Date.now();
    const processed = await pipeline.processOne(Date.now());
    const elapsedMs = Date.now() - startedMs;

    assert.equal(processed, true, '取到并处理了一个任务');
    assert.ok(elapsedMs < 2_000, `超时闸必须真的生效（实际 ${elapsedMs}ms）`);

    const failures = pipeline.failures();
    assert.equal(failures.length, 1, '超时必须进失败明细 —— 不能「静默没回来」');
    assert.equal(failures[0]?.eventId, 'evt-1');
    assert.equal(failures[0]?.state, 'retry', '超时是临时失败 → 退避重试');
    assert.match(failures[0]?.error ?? '', /超时/, '失败原因要说清是超时，不是「调用失败」');
    assert.equal(port.signals[0]?.aborted, true, '超时时要把 signal abort 掉（能取消就取消）');
    assert.equal(log.currentOf('evt-1').summary_quality, 'pending', '挂死的那条不伪造摘要');

    // 同一条队列、同一条管线：第 2 条照常处理 —— 队头挂死不堵队尾。
    await pipeline.processOne(Date.now());
    assert.equal(log.currentOf('evt-2').summary_quality, 'ready', '第 2 条照常出摘要');
    assert.equal(log.currentOf('evt-2').summary, '第 2 次调用产出的摘要');

    const retrying = backlog.snapshot().find((task) => task.eventId === 'evt-1');
    assert.ok(retrying !== undefined, '挂死的那条仍在队列里（退回重试，不是被丢掉）');
    assert.equal(retrying?.attempts, 1, '记了一次尝试');
    assert.equal(log.currentOf('evt-1').version, 1, '失败不写版本（append-only 的一侧）');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── Major-3：模型在途期间边界被改写 → 结果过期即丢弃 ──────────────────────

test('Major-3 · 过期丢弃：在途改边界 → 本次结果作废（不写版本、仍 pending），下一轮按新指针重生成', async () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(layoutOf(root).events);
    const backlog = new InMemoryBacklog();

    /** 每次调用收到的 user 提示（用来断言「摘要基于哪版指针」）。 */
    const requests: string[] = [];
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const port: LLMPort = {
      async summarize(request): Promise<LLMSummarizeResponse> {
        requests.push(request.user);
        markStarted?.();
        if (requests.length === 1) {
          // 第一次调用停在门口：等测试把边界改完再放行。
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        const covered = request.user.split('\n').filter((line) => line.includes('原文-')).length;
        return { summary: `覆盖 ${covered} 条记录`, keyPoints: [], anchors: [] };
      },
    };

    const pipeline = new ClosurePipeline({
      log,
      port,
      backlog,
      readTexts: (event) => event.pointers.map((pointer) => `原文-${pointer.id}`),
    });

    log.appendVersion(
      makeEvent({
        id: 'evt-1',
        pointers: [
          { id: 'exp-1', channel: 'dsh' },
          { id: 'exp-2', channel: 'dsh' },
        ],
      }),
    );
    pipeline.enqueue('evt-1');

    const inFlight = pipeline.processOne(Date.now());
    await started; // 模型已收到请求、正在「想」

    // 她在模型在途时改边界：移出 exp-2（等同 reviseBoundary 写下的新版本）。
    const snapshot = log.currentOf('evt-1');
    const kept = snapshot.pointers[0];
    assert.ok(kept !== undefined, '样本事件至少有一条指针');
    log.appendVersion({
      ...snapshot,
      version: snapshot.version + 1,
      pointers: [kept],
      summary: null,
      summary_quality: 'pending',
      summary_source: null,
      key_points: [],
    });

    release?.();
    await inFlight;

    const afterDiscard = log.currentOf('evt-1');
    assert.equal(afterDiscard.version, 2, '过期结果不得写版本（仍是改边界产生的 v2）');
    assert.equal(afterDiscard.summary_quality, 'pending', '仍待补摘要');
    assert.equal(afterDiscard.summary, null, '不许把基于旧边界的摘要挂上来');
    assert.equal(requests.length, 1, '只调了一次模型（那一次被作废）');
    assert.ok(backlog.size() >= 1, '任务留在队列里 → 下一轮重取（重新入队）');

    // 下一轮：基于新指针重新生成。
    await pipeline.processOne(Date.now());
    const final = log.currentOf('evt-1');
    assert.equal(final.version, 3, '这一版才是真正落盘的摘要');
    assert.equal(final.summary_quality, 'ready');
    assert.equal(final.summary, '覆盖 1 条记录', '摘要必须基于新边界（只剩 1 条记录）');
    assert.equal(requests.length, 2);
    assert.equal(
      requests[1]?.includes('原文-exp-2'),
      false,
      '第二次请求的原文里不该还有被移出的记录',
    );
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 溯源两字段（设计稿 v1.1 §3.2）──────────────────────────────────────

test('溯源：模型写的摘要带 summary_prompt_version=SUMMARY_PROMPT_VERSION 与模型名', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = { summary: '她打开了一个网页。', keyPoints: [], anchors: [], model: 'dsh-pro' };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.summary_prompt_version, SUMMARY_PROMPT_VERSION, '提示词版本要落盘');
    assert.equal(current.summary_model, 'dsh-pro', '模型名由适配器报，原样落盘');
  } finally {
    cleanupTempRoot(root);
  }
});

test('溯源：适配器报不出模型名 → 落 null（不猜）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.summary_prompt_version, SUMMARY_PROMPT_VERSION);
    assert.equal(current.summary_model, null, '不知道就是不知道');
  } finally {
    cleanupTempRoot(root);
  }
});

test('溯源：重跑她写的摘要（只刷锚点）→ 两字段清空（它们描述的是被替换的那份）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = { summary: '模型新写的摘要', keyPoints: [], anchors: ['新锚点'], model: 'dsh-pro' };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(
      makeEvent({
        summary: '她自己写的摘要',
        summary_quality: 'pending',
        summary_source: 'her',
        summary_prompt_version: 'v1',
        summary_model: 'dsh-default',
      }),
    );

    pipeline.requestRerun('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.summary, '她自己写的摘要', '她的摘要没被覆盖');
    assert.equal(current.summary_prompt_version, null, '她手写的摘要不来自任何提示词');
    assert.equal(current.summary_model, null, '也不来自任何模型');
    assert.deepEqual(current.anchors, ['新锚点'], '锚点照常重跑');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 双流职责（设计稿 v1.1 §6.1.1）─────────────────────────────────────────

test('双流职责：慢路径只追加派生字段 —— 快路径写的事实一位都不动（§6.1.1）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = { summary: '她问晚餐吃什么，并自己列了三个选项。', keyPoints: ['晚餐'], anchors: ['列选项'] };
    const { log, pipeline } = makePipeline(root, port);

    const before = makeEvent({
      closed_reason: 'silence',
      time_range: { started_at: BASE_TIME, ended_at: '2026-11-08T10:20:00.000Z' },
      boundary_candidates: [{ kind: '话题跳转', at_pointer_id: 'exp-1', marked_at: BASE_TIME }],
    });
    log.appendVersion(before);
    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const after = log.currentOf('evt-1');

    // 快路径写的事实：一个字节都不许动（慢路径只读它们）。
    assert.deepEqual(after.pointers, before.pointers, '点针组不许改');
    assert.deepEqual(after.time_range, before.time_range, '时间范围不许改');
    assert.deepEqual(after.boundary_candidates, before.boundary_candidates, '候选标记不许改');
    assert.equal(after.status, before.status, '状态不许改（pending→ready 是派生位，不是 status）');
    assert.equal(after.closed_reason, before.closed_reason, '闭合原因不许改');
    assert.equal(after.assembled_at, before.assembled_at);
    assert.equal(after.created_by, before.created_by);
    assert.equal(after.channel, before.channel);
    assert.equal(after.id, before.id);
    assert.equal(after.schema_version, before.schema_version);

    // 反过来：真正变了的字段必须**全部**落在派生白名单里 ——
    // 这条比逐个 assert 更强：将来谁在 writeSummary 里顺手加一个非派生字段，这里会红。
    const DERIVED = new Set([
      'version',        // 版本号必然推进
      'created_at',     // 行写入时刻
      'summary',
      'key_points',
      'anchors',
      'topic_lines',
      'summary_quality',
      'summary_source',
      'summary_prompt_version',
      'summary_model',
    ]);
    const changed = (Object.keys(after) as Array<keyof EventRecord>).filter(
      (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
    );
    assert.deepEqual(
      changed.filter((key) => !DERIVED.has(key)),
      [],
      `慢路径改了不该改的字段：${changed.filter((key) => !DERIVED.has(key)).join('、')}`,
    );
    assert.ok(changed.includes('summary'), '摘要本身当然要变（否则这条用例是空过）');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── v1.4 慢路径话题候选（定案稿 §6.4 · 任务书 C7/C9 · A7）─────────────────
// 旧口径「第一期不产生任何候选」已按 C9 拆为快/慢两条路径：
// 快路径恒空（见 tests/event/segmenter.test.ts 的 T4 改写），
// 慢路径（摘要调用）可产 ≤5 条非权威候选 —— 以下逐条验证。

test('A7 · 慢路径：候选与摘要在同一次 appendVersion 写回（≤5 条、kind 封闭、无分数字段）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = {
      summary: '她在读一篇论文。',
      keyPoints: ['读了论文'],
      anchors: ['论文'],
      boundary_candidates: [
        { kind: '话题跳转', at_pointer_id: 'exp-1', marked_at: '2026-11-08T10:05:00.000Z' },
      ],
    };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.version, 2, '候选与摘要在同一个版本里写回');
    assert.equal(current.summary_quality, 'ready', '摘要照常落盘');
    assert.equal(current.summary, '她在读一篇论文。');
    assert.equal(current.boundary_candidates.length, 1, '候选写进了 boundary_candidates');
    assert.equal(current.boundary_candidates[0]?.kind, '话题跳转', 'kind 封闭为「话题跳转」');
    assert.equal(current.boundary_candidates[0]?.at_pointer_id, 'exp-1');
    assert.equal(current.boundary_candidates[0]?.marked_at, '2026-11-08T10:05:00.000Z');
    // 无分数、无置信度：候选只有三个字段。
    assert.deepEqual(
      Object.keys(current.boundary_candidates[0] ?? {}).sort(),
      ['at_pointer_id', 'kind', 'marked_at'],
      '候选不含分数字段',
    );
    assert.equal(current.summary_prompt_version, 'v2', '提示词版本随本次 bump 到 v2');
  } finally {
    cleanupTempRoot(root);
  }
});

test('A7 · 慢路径：候选非权威 —— 不改 pointers / status / time_range', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = {
      summary: '她在读一篇论文。',
      keyPoints: [],
      anchors: [],
      boundary_candidates: [
        { kind: '话题跳转', at_pointer_id: 'exp-1', marked_at: '2026-11-08T10:01:00.000Z' },
        { kind: '话题跳转', at_pointer_id: 'exp-2', marked_at: '2026-11-08T10:02:00.000Z' },
      ],
    };
    const { log, pipeline } = makePipeline(root, port);
    const before = makeEvent({
      pointers: [
        { id: 'exp-1', channel: 'dsh', shard: '2026-11', seq: 0 },
        { id: 'exp-2', channel: 'dsh', shard: '2026-11', seq: 1 },
      ],
    });
    log.appendVersion(before);

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const after = log.currentOf('evt-1');
    assert.deepEqual(after.pointers, before.pointers, '候选不改 pointers');
    assert.equal(after.status, before.status, '候选不改 status');
    assert.deepEqual(after.time_range, before.time_range, '候选不改 time_range');
    assert.equal(after.closed_reason, before.closed_reason, '候选不改闭合原因');
    assert.equal(after.boundary_candidates.length, 2, '两条候选都写下了');
  } finally {
    cleanupTempRoot(root);
  }
});

test('A7 · 慢路径：候选最多 5 条（超出截断，不多写）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = {
      summary: '她在读一篇论文。',
      keyPoints: [],
      anchors: [],
      boundary_candidates: Array.from({ length: 9 }, () => ({
        kind: '话题跳转',
        at_pointer_id: 'exp-1',
        marked_at: '2026-11-08T10:00:00.000Z',
      })),
    };
    const { log, pipeline } = makePipeline(root, port);
    // 9 条候选全部指向本事件的唯一指针（exp-1）→ 都合法，只受条数上限约束。
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.boundary_candidates.length, 5, '最多 5 条，超出截断');
  } finally {
    cleanupTempRoot(root);
  }
});

test('A7 · 慢路径：候选解析失败 → 丢弃候选，摘要照常落盘（不写半成品）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    // 候选形态不对（不是数组 / 缺 at_pointer_id）→ 解析失败。
    port.response = {
      summary: '她在读一篇论文。',
      keyPoints: [],
      anchors: [],
      boundary_candidates: [{ kind: '话题跳转' } as never],
    };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    const processed = await pipeline.processOne(0);

    assert.equal(processed, true, '候选坏掉不该让整次调用失败');
    const current = log.currentOf('evt-1');
    assert.equal(current.summary_quality, 'ready', '摘要照常落盘');
    assert.equal(current.summary, '她在读一篇论文。');
    assert.deepEqual(current.boundary_candidates, [], '坏候选被丢弃');
  } finally {
    cleanupTempRoot(root);
  }
});

test('A7 · 慢路径：边界快照不一致 → 摘要与候选一起作废（不写半份）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = {
      summary: '她在读一篇论文。',
      keyPoints: [],
      anchors: [],
      boundary_candidates: [
        { kind: '话题跳转', at_pointer_id: 'exp-1', marked_at: '2026-11-08T10:01:00.000Z' },
      ],
    };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    // 模型在途期间她改了边界 → 快照不一致。
    const original = port.summarize.bind(port);
    port.summarize = async (request) => {
      const result = await original(request);
      log.appendVersion({
        ...log.currentOf('evt-1'),
        version: log.currentOf('evt-1').version + 1,
        pointers: [{ id: 'exp-9', channel: 'dsh', shard: '2026-11', seq: 9 }],
      });
      return result;
    };

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.summary_quality, 'pending', '摘要作废（事件保持 pending）');
    assert.equal(current.summary, null, '没有半份摘要');
    assert.deepEqual(current.boundary_candidates, [], '候选与摘要一起作废');
    assert.equal(current.pointers.length, 1, '她改的边界原样保留');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── v1.4 评审 P2 · 候选指针必须属于本事件 ────────────────────────────────
// 模型可能指向本事件之外的记录（幻觉 / 串轮 / 抄了别的事件的 id）。
// 这样的候选指向一个不存在于本事件的边界 —— 代码过滤掉，不写。

test('P2 · 慢路径：at_pointer_id 不属于本事件指针 → 代码过滤掉（不写）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = {
      summary: '她在读一篇论文。',
      keyPoints: [],
      anchors: [],
      boundary_candidates: [
        { kind: '话题跳转', at_pointer_id: 'exp-1', marked_at: '2026-11-08T10:01:00.000Z' },
        { kind: '话题跳转', at_pointer_id: 'exp-999', marked_at: '2026-11-08T10:02:00.000Z' },
        { kind: '话题跳转', at_pointer_id: 'other-event-exp', marked_at: '2026-11-08T10:03:00.000Z' },
      ],
    };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent()); // 事件只有一个指针 exp-1

    pipeline.enqueue('evt-1');
    const processed = await pipeline.processOne(0);

    assert.equal(processed, true, '坏候选不该让整次调用失败');
    const current = log.currentOf('evt-1');
    assert.equal(current.boundary_candidates.length, 1, '只有本事件的指针那条留下');
    assert.equal(current.boundary_candidates[0]?.at_pointer_id, 'exp-1');
    assert.equal(current.summary_quality, 'ready', '摘要照常落盘');
    assert.equal(current.summary, '她在读一篇论文。');
  } finally {
    cleanupTempRoot(root);
  }
});

test('P2 · 慢路径：全部候选都越界 → 候选为空，摘要照常落盘（不写半成品）', async () => {
  const root = makeTempRoot();
  try {
    const port = new FakePort();
    port.response = {
      summary: '她在读一篇论文。',
      keyPoints: [],
      anchors: [],
      boundary_candidates: [
        { kind: '话题跳转', at_pointer_id: 'exp-999', marked_at: '2026-11-08T10:01:00.000Z' },
      ],
    };
    const { log, pipeline } = makePipeline(root, port);
    log.appendVersion(makeEvent());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.deepEqual(current.boundary_candidates, [], '越界候选全被过滤');
    assert.equal(current.summary_quality, 'ready', '摘要照常落盘');
    assert.equal(current.summary, '她在读一篇论文。');
  } finally {
    cleanupTempRoot(root);
  }
});
