/**
 * #90 批 2 · closure 集成 L2 红测（正本 `docs/task90-write-gate-final-spec.md` §6.3 / §6.4 /
 * §6.7 / §6.9 + Q3 / Q4 / Q7）。
 *
 * 被测 seam（写者尚未落地，红相属预期；批内红→绿，不跨批留红）：
 *  - `ClosureDeps` 增 `readExperience` 窄接口（Q4 形状）；
 *  - `writeSummary` 在 L1（assertAnchorsUlid）之后、`appendVersion` 之前、try/catch 之内
 *    调用 L2 `assertAnchorRefs`，memberIds 取 `current.pointers.map(p => p.id)`；
 *  - L2 拒收走既有 `failTask` 退避 / 耗尽 / 失败明细口径；
 *  - `ClosureFailure` 附结构化 detail（reason/anchor/expected/actual/deltaMs…，零正文）。
 *
 * 纪律：只写 tests/；reader 用 Map 构造的同步窄接口；临时 DSH_HOME，真实数据根零写入；
 * 不新增定时器 / 守护进程。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CorruptedError, NotFoundError, UnavailableError } from '../../src/core/errors.ts';
import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import type { BoundaryCandidate, EventRecord } from '../../src/contract/event.ts';
import { AnchorReferenceInvalidError } from '../../src/event/anchor-refs.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { ExperienceLog } from '../../src/source/experience-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { InMemoryBacklog } from '../../src/event/backlog.ts';
import { ClosurePipeline } from '../../src/event/closure.ts';
import type { ClosureDeps, ClosureFailure } from '../../src/event/closure.ts';
import type {
  LLMPort,
  LLMSummarizeRequest,
  LLMSummarizeResponse,
} from '../../src/event/llm-port.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_TIME = '2026-11-08T10:00:00.000Z';

// ── 窄接口形状（§4 Q4：单方法、同步、只回 id/channel/时间，不含正文）──────────────

/** reader 回传的经历引用面；刻意不含 cue/raw_text/summary/key_points 等正文字段。 */
interface ReaderRef {
  readonly id: string;
  readonly channel: string;
  readonly occurredAtMs: number;
}

interface Reader {
  readonly readExperience: (id: string) => ReaderRef | undefined;
}

/** §5.2 冻结 reason 词表（与 #42 同词表，anchor- 前缀；store-broken 独立）。 */
type DetailReason =
  | 'anchor-duplicate'
  | 'anchor-not-found'
  | 'anchor-cross-channel'
  | 'anchor-out-of-window'
  | 'anchor-not-in-event'
  | 'experience-store-broken';

/** L2 失败结构化明细；零经历正文 / 零摘要正文。 */
interface AnchorRefDetail {
  readonly reason: DetailReason;
  readonly anchor: string;
  readonly expected: string;
  readonly actual: string;
  readonly channel?: string;
  readonly window?: { readonly startedMs: number; readonly endedMs: number };
  readonly deltaMs?: number;
  readonly note?: string;
}

/** 既有 ClosureFailure 上挂载 L2 结构化明细（seam：写者补 detail 字段）。 */
type FailureWithDetail = ClosureFailure & { readonly detail?: AnchorRefDetail };

// ── 确定性夹具 ───────────────────────────────────────────────────────────────────

/** 合法 26 位 Crockford ULID（过 L1 形态闸，才轮得到 L2 引用闸）。 */
const U_A = '01J0000000000000000000000A';
const U_B = '01J0000000000000000000000B';
const U_C = '01J0000000000000000000000C';
const U_Z = '01J0000000000000000000000Z';
/** 存在于经历真源、但属 web 通道、且不在事件成员集内的非成员锚点。 */
const U_W = '01J0000000000000000000000W';

const T0 = Date.parse(BASE_TIME);
const DAY = 24 * 3600 * 1000;

function ref(id: string, channel: string, occurredAtMs: number): ReaderRef {
  return { id, channel, occurredAtMs };
}

function readerOf(entries: Readonly<Record<string, ReaderRef>>): Reader {
  return { readExperience: (id) => entries[id] ?? undefined };
}

/**
 * writeSummary 私有方法的测试反射 seam（定稿 §10：不开生产专用入口，TS private 仅编译期）。
 * 测试内用类型逃逸直调真实私有方法，L1 形态闸 / L2 成员闸走的仍是生产同一实现、
 * 同一 `assertAnchorRefs`；生产码零新增面。候选传空、regenerate=true、model 缺省。
 */
type WriteSummaryPrivate = {
  writeSummary(
    current: EventRecord,
    anchors: readonly string[],
    candidates: readonly BoundaryCandidate[],
    summary: string,
    keyPoints: readonly string[],
    regenerate: boolean,
    model: string | undefined,
  ): void;
};

function writeSummaryDirect(
  pipeline: ClosurePipeline,
  current: EventRecord,
  anchors: readonly string[],
  summary: string,
): void {
  const privateMethod = pipeline as unknown as WriteSummaryPrivate;
  privateMethod.writeSummary(current, anchors, [], summary, [], true, undefined);
}

/** 捕获同步抛出的闸错误（writeSummary 在 appendVersion 前同步抛 L1/L2）。 */
function captureThrow(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** 造一条闭合但未出摘要的事件（pending）。 */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const base: EventRecord = {
    id: 'evt-1',
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'closed',
    pointers: [{ id: U_A, channel: 'dsh', shard: '2026-11', seq: 0 }],
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

/** 假端口：记录收到的请求次数（spy），按预设返回。 */
class FakePort implements LLMPort {
  readonly requests: LLMSummarizeRequest[] = [];
  response: LLMSummarizeResponse = { summary: '她打开了一个网页。', keyPoints: [], anchor_serials: [] };

  async summarize(request: LLMSummarizeRequest): Promise<LLMSummarizeResponse> {
    this.requests.push(request);
    return this.response;
  }
}

interface Harness {
  log: EventLog;
  backlog: InMemoryBacklog;
  port: FakePort;
  pipeline: ClosurePipeline;
  failures: FailureWithDetail[];
}

function makeHarness(
  root: string,
  opts: {
    reader?: Reader;
    response?: LLMSummarizeResponse;
    readTexts?: (event: EventRecord) => string[];
  } = {},
): Harness {
  const log = new EventLog(layoutOf(root).events);
  const backlog = new InMemoryBacklog();
  const port = new FakePort();
  if (opts.response !== undefined) {
    port.response = opts.response;
  }
  const failures: FailureWithDetail[] = [];
  const deps = {
    log,
    port,
    backlog,
    readTexts: opts.readTexts ?? (() => ['用户问晚餐吃什么', '她列了三个选项']),
    readExperience: opts.reader ?? readerOf({}),
    onFailure: (failure: ClosureFailure) => failures.push(failure as FailureWithDetail),
  } as unknown as ClosureDeps;
  const pipeline = new ClosurePipeline(deps);
  return { log, backlog, port, pipeline, failures };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. 闸位：L2 拒收 → 真源零新版本（appendVersion 未发生），任务留队退避
// ═══════════════════════════════════════════════════════════════════════════════

test('L2 闸位：锚点不在成员集且 reader 取不到 → 拒收，真源零新版本追加', () => {
  const root = makeTempRoot();
  try {
    const harness = makeHarness(root, { reader: readerOf({}) });
    harness.log.appendVersion(makeEvent());
    const current = harness.log.currentOf('evt-1');

    // 直注 writeSummary 私有 seam：id[] 绕过线协议序号层，走真实 L1/L2 闸。
    const error = captureThrow(() => writeSummaryDirect(harness.pipeline, current, [U_Z], '摘要'));

    assert.ok(error instanceof AnchorReferenceInvalidError, 'L2 闸抛 AnchorReferenceInvalidError');
    assert.equal(
      (error as AnchorReferenceInvalidError).detail.reason,
      'anchor-not-found',
      'reader 取不到 → anchor-not-found 桶（未被建表期 l3-serial-table-broken 取代）',
    );
    assert.equal(harness.log.versionsOf('evt-1').length, 1, 'appendVersion 未发生：仍只有 v1');
    assert.equal(current.version, 1, '版本号未推进');
    assert.equal(current.summary, null, '没有占位摘要');
    assert.equal(current.summary_quality, 'pending', '如实保持 pending');
  } finally {
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. 空锚不降级承重墙：四锚三真一假 → 整份失败，禁剥锚、禁空锚落版
// ═══════════════════════════════════════════════════════════════════════════════

test('L2 禁剥锚：部分有效（三真一假）整份拒收，不得改写为空锚版本落盘', async () => {
  const root = makeTempRoot();
  try {
    const harness = makeHarness(root, {
      reader: readerOf({
        [U_A]: ref(U_A, 'dsh', T0),
        [U_B]: ref(U_B, 'dsh', T0 + DAY),
        [U_C]: ref(U_C, 'dsh', T0 + 2 * DAY),
      }),
    });
    harness.log.appendVersion(
      makeEvent({
        pointers: [
          { id: U_A, channel: 'dsh', shard: '2026-11', seq: 0 },
          { id: U_B, channel: 'dsh', shard: '2026-11', seq: 1 },
          { id: U_C, channel: 'dsh', shard: '2026-11', seq: 2 },
        ],
      }),
    );
    const current = harness.log.currentOf('evt-1');

    // 三真一假整份喂入；闸在 appendVersion 前同步拒收，禁剥锚、禁空锚落版。
    const error = captureThrow(() =>
      writeSummaryDirect(harness.pipeline, current, [U_A, U_B, U_C, U_Z], '摘要'),
    );

    assert.ok(error instanceof AnchorReferenceInvalidError, '整份拒收：不剥锚');
    assert.equal(harness.log.versionsOf('evt-1').length, 1, '整份失败：零新版本');
    assert.deepEqual(current.anchors, [], 'v1 空锚 abstain 原样保留，未被剥成 anchors:[] 的新版');
    assert.equal(current.summary, null);
    assert.equal(current.summary_quality, 'pending');
  } finally {
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. 退避回归（§6.3 / #119 同款独立钉）：nextAttemptAtMs 严格递增；8 次耗尽出队、
//    事件保持 pending、真源零追加
// ═══════════════════════════════════════════════════════════════════════════════

test('L2 退避：nextAttemptAtMs 严格递增（无相等 / 紧密重循环），8 次耗尽出队保持 pending', async () => {
  const root = makeTempRoot();
  try {
    const harness = makeHarness(root, {
      reader: readerOf({}),
      response: { summary: '她打开了一个网页。', keyPoints: [], anchor_serials: [] },
    });
    harness.log.appendVersion(makeEvent());

    harness.pipeline.enqueue('evt-1');

    const nextAttempts: number[] = [];
    const attempts: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      await harness.pipeline.processOne(i * 10_000_000);
      const task = harness.backlog.snapshot()[0];
      if (task !== undefined) {
        nextAttempts.push(task.nextAttemptAtMs);
        attempts.push(task.attempts);
      }
    }

    // 退避时刻严格单调递增（无相等、无同一时刻紧密重循环）。
    for (let i = 1; i < nextAttempts.length; i += 1) {
      assert.ok(
        (nextAttempts[i] ?? 0) > (nextAttempts[i - 1] ?? 0),
        `退避时刻须严格递增：#${i} ${nextAttempts[i]} ≤ #${i - 1} ${nextAttempts[i - 1]}`,
      );
    }
    // attempts 单调累加。
    for (let i = 1; i < attempts.length; i += 1) {
      assert.ok((attempts[i] ?? 0) > (attempts[i - 1] ?? 0), 'attempts 须逐轮累加');
    }

    const exhausted = harness.pipeline.failures().filter((f) => f.exhausted);
    assert.equal(exhausted.length, 1, '恰好标记一次耗尽');
    assert.equal(harness.backlog.size(), 0, '耗尽后出队，不再空转重试');

    const current = harness.log.currentOf('evt-1');
    assert.equal(current.version, 1, '全程零版本追加');
    assert.equal(current.summary, null, '无占位内容');
    assert.equal(current.summary_quality, 'pending', '耗尽仍保持 pending（不写永久占位）');
  } finally {
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. 损坏传播（§6.4）：CorruptedError 独立 reason=experience-store-broken，不吞 not-found；
//    真源零追加<[PLHD93_never_used_51bce0c785ca2f68081bfa7d91973934]>；LLM spy 零调用；onFailure 明细结构化且零正文
// ═══════════════════════════════════════════════════════════════════════════════

test('损坏传播：reader 抛 CorruptedError → experience-store-broken，LLM 零调用、真源零追加', async () => {
  const root = makeTempRoot();
  try {
    const brokenReader: Reader = {
      readExperience: () => {
        throw new CorruptedError('experience log corrupted');
      },
    };
    const harness = makeHarness(root, {
      reader: brokenReader,
      response: { summary: '她打开了一个网页。', keyPoints: [], anchor_serials: [] },
    });
    harness.log.appendVersion(makeEvent());

    harness.pipeline.enqueue('evt-1');
    await harness.pipeline.processOne(0);

    assert.equal(harness.log.versionsOf('evt-1').length, 1, '损坏轮零版本追加');
    assert.equal(harness.port.requests.length, 0, '损坏在调 LLM 之前抛出，spy 调用次数为 0');

    const failures = harness.pipeline.failures() as FailureWithDetail[];
    assert.equal(failures.length, 1, '损坏失败经 onFailure / failures 可达');
    const detail = failures[0]?.detail;
    assert.equal(detail?.reason, 'experience-store-broken', '独立 reason，不被吞成 anchor-not-found');
    assert.ok(!/not-found/i.test(failures[0]?.error ?? ''), '错误文案不得伪装 not-found');

    // 结构化字段必备四件套；零经历正文 / 零摘要正文。
    assert.equal(typeof detail?.anchor, 'string');
    assert.equal(typeof detail?.expected, 'string');
    assert.equal(typeof detail?.actual, 'string');
    const serialized = JSON.stringify(failures[0]);
    const secretBody = 'SECRET-CUE-正文明文-7f3a9c21';
    assert.ok(!serialized.includes(secretBody), '失败明细序列化里不得出现经历正文');
  } finally {
    cleanupTempRoot(root);
  }
});

test('损坏传播（真源层）：experienceLog 分片行损坏 → 两轮退避均 store-broken，LLM 零调用、真源零追加', async () => {
  const root = makeTempRoot();
  try {
    const brokenDir = path.join(root, 'experiences');
    const brokenLog = new ExperienceLog(brokenDir);
    brokenLog.append({
      id: U_A,
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 'session-1' },
      initiation: 'user',
      observation: { cue: 'SECRET-CUE-正文明文-7f3a9c21' },
      occurred_at: new Date(T0).toISOString(),
      recorded_at: new Date(T0).toISOString(),
      tick: 1,
      char_count: null,
    });
    // 篡改分片行为损坏行：索引仍记 U_A 落点，但重读解析抛 CorruptedError。
    for (const name of fs.readdirSync(brokenDir).filter((n) => n.endsWith('.jsonl'))) {
      fs.writeFileSync(path.join(brokenDir, name), '{"id": "broken",\n');
    }

    const corruptedReader: Reader = {
      readExperience: (id) => {
        if (!brokenLog.has(id)) return undefined;
        return brokenLog.get(id) as unknown as ReaderRef;
      },
    };

    const harness = makeHarness(root, {
      reader: corruptedReader,
      response: { summary: '她打开了一个网页。', keyPoints: [], anchor_serials: [] },
    });
    harness.log.appendVersion(makeEvent());
    harness.pipeline.enqueue('evt-1');

    await harness.pipeline.processOne(0);
    assert.equal(harness.log.versionsOf('evt-1').length, 1, '第一轮零版本追加');
    assert.equal(harness.port.requests.length, 0, '第一轮 LLM spy 零调用');

    await harness.pipeline.processOne(10_000_000);
    assert.equal(harness.log.versionsOf('evt-1').length, 1, '第二轮零版本追加');
    assert.equal(harness.port.requests.length, 0, '第二轮累计 LLM spy 仍为 0');

    const failures = harness.pipeline.failures() as FailureWithDetail[];
    assert.ok(failures.length >= 1, '损坏失败经 onFailure 留痕');
    assert.equal(failures[0]?.detail?.reason, 'experience-store-broken', '独立 reason，不被吞成 not-found');
    const serialized = JSON.stringify(failures);
    assert.ok(!serialized.includes('SECRET-CUE-正文明文-7f3a9c21'), '失败明细零经历正文');
  } finally {
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// D6. 分类边界：读取口基础设施错误才进 experience-store-broken 桶；模型类错误
//     detail 必须为 undefined，不得被泛化成存储损坏。
// ═══════════════════════════════════════════════════════════════════════════════

test('D6 分类边界：LLM UnavailableError 不挂 experience-store-broken 桶，detail 为 undefined，退避照旧', async () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(layoutOf(root).events);
    const backlog = new InMemoryBacklog();
    const failingPort: LLMPort = {
      async summarize(): Promise<LLMSummarizeResponse> {
        throw new UnavailableError('模型路由超时');
      },
    };
    const failures: ClosureFailure[] = [];
    const pipeline = new ClosurePipeline({
      log,
      port: failingPort,
      backlog,
      readTexts: () => ['用户问晚餐吃什么'],
      // 成员 U_A 须进 reader：否则建表期 l3-serial-table-broken 会先于端口错误，
      // 本用例要钉的是模型类 UnavailableError 不挂存储损坏桶。
      readExperience: readerOf({ [U_A]: ref(U_A, 'dsh', T0) }),
      onFailure: (failure) => failures.push(failure),
    });
    log.appendVersion(makeEvent());
    pipeline.enqueue('evt-1');

    await pipeline.processOne(0);

    assert.equal(log.versionsOf('evt-1').length, 1, '模型失败真源零版本追加');
    assert.equal(failures.length, 1, '失败经 onFailure 留痕');
    const failure = failures[0];
    const detail = failure?.detail;
    assert.equal(detail, undefined, '模型类错误 detail 必须为 undefined，不得挂存储损坏桶');

    // 退避语义照旧：任务留队、attempts 累加（不因分类变化改成永久丢弃）。
    const task = backlog.snapshot()[0];
    assert.equal(task?.eventId, 'evt-1');
    assert.equal(task?.attempts, 1);
  } finally {
    cleanupTempRoot(root);
  }
});

test('D6 分类边界：reader 抛 NotFoundError 归 experience-store-broken，note 带原始类名，真源零追加', async () => {
  const root = makeTempRoot();
  try {
    const notFoundReader: Reader = {
      readExperience: () => {
        throw new NotFoundError('经历不存在');
      },
    };
    const harness = makeHarness(root, {
      reader: notFoundReader,
      response: { summary: '她打开了一个网页。', keyPoints: [], anchor_serials: [] },
    });
    harness.log.appendVersion(makeEvent());
    harness.pipeline.enqueue('evt-1');

    await harness.pipeline.processOne(0);

    assert.equal(harness.log.versionsOf('evt-1').length, 1, '读取口基础设施错误零版本追加');
    assert.equal(harness.port.requests.length, 0, '损坏轮到不了 LLM，spy 零调用');

    const failures = harness.pipeline.failures() as FailureWithDetail[];
    assert.equal(failures.length >= 1, true, '损坏失败留痕');
    const detail = failures[0]?.detail;
    assert.equal(detail?.reason, 'experience-store-broken', 'NotFoundError 属读取口基础设施错误，独立成桶');
    assert.match(detail?.note ?? '', /NotFoundError/, 'note 带原始错误类名供排障');
  } finally {
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. 窄接口接线（§6.9 / Q4）：api 构造点复用既有匿名适配器形状；Ref 只含
//    id/channel/occurredAtMs，无正文字段
// ═══════════════════════════════════════════════════════════════════════════════

test('窄接口接线：api ClosurePipeline 构造点注入 readExperience，复用 has/get 既有适配器形状', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/api/index.ts'), 'utf8');

  const closureBlock = source.match(/new ClosurePipeline\(\{([\s\S]*?)\}\);/);
  assert.ok(closureBlock, 'ClosurePipeline 构造点可定位');
  const block = closureBlock[1] ?? '';

  assert.match(block, /readExperience:/, 'ClosureDeps 注入 readExperience 窄接口');
  assert.match(
    block,
    /this\.experienceLog\.has\(id\)\s*\?\s*this\.experienceLog\.get\(id\)\s*:\s*undefined/,
    '复用既有 has/get 匿名适配器形状，不新写适配类 / 不泄漏 ExperienceLog 整体',
  );
});

test('窄接口形状：Ref 只暴露 id/channel/occurredAtMs，不含 raw_text/summary/cue/key_points', () => {
  const narrow: ReaderRef = ref(U_A, 'dsh', T0);
  const forbidden = ['raw_text', 'summary', 'cue', 'key_points', 'body', 'observation'];
  for (const field of forbidden) {
    assert.ok(!(field in narrow), `Ref 不得含正文字段：${field}`);
  }
  assert.deepEqual(
    Reflect.ownKeys(narrow).sort(),
    ['channel', 'id', 'occurredAtMs'],
    'Ref 键集合恰为窄三面',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. 重启语义（§6.7 / E-4）：backlog 进程内丢失 → sweepPending 重摘 closed+pending+
//    非 her 来源，attempts 从 1 重新计数；her 来源不重摘；重入队后一轮可成功闭合
// ═══════════════════════════════════════════════════════════════════════════════

test('重启语义：新实例 sweepPending 重摘非 her pending，her 不重摘；attempts 重置后可成功闭合', async () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(layoutOf(root).events);
    log.appendVersion(makeEvent({ id: 'evt-1' }));
    log.appendVersion(makeEvent({ id: 'evt-2' }));
    log.appendVersion(
      makeEvent({ id: 'evt-3', summary_source: 'her', summary: '她手写的摘要' }),
    );

    // 模拟进程重启：全新 backlog + 全新 pipeline（队列纯进程内丢失，真值在事件真源）。
    const freshBacklog = new InMemoryBacklog();
    const freshPort = new FakePort();
    const freshPipeline = new ClosurePipeline({
      log,
      port: freshPort,
      backlog: freshBacklog,
      readTexts: () => ['用户问晚餐吃什么'],
      readExperience: readerOf({ [U_A]: ref(U_A, 'dsh', T0) }),
    });

    const swept = freshPipeline.sweepPending();
    assert.equal(swept, 2, '只重摘两个非 her 的 closed+pending 事件');

    const queuedIds = freshBacklog.snapshot().map((task) => task.eventId).sort();
    assert.deepEqual(queuedIds, ['evt-1', 'evt-2'], 'her 来源 evt-3 不被清道夫重摘');
    assert.ok(
      freshBacklog.snapshot().every((task) => task.attempts === 0),
      '重启后 attempts 从 0 重新计数（新一轮 8 次）',
    );

    // 重入队后再跑一轮：合法空锚夹具可成功闭合。
    await freshPipeline.processOne(0);
    await freshPipeline.processOne(0);
    assert.equal(log.currentOf('evt-1').summary_quality, 'ready');
    assert.equal(log.currentOf('evt-2').summary_quality, 'ready');
    assert.equal(log.currentOf('evt-3').summary_source, 'her', 'her 事件原样保持');
    assert.equal(log.currentOf('evt-3').summary_quality, 'pending', 'her 不被重跑刷 ready');
  } finally {
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. 诊断不翻转：cross-channel 分桶 detail 存在，但主结论仍是拒收（端到端呼应批 1）
// ═══════════════════════════════════════════════════════════════════════════════

test('诊断不翻转：cross-channel 分桶明细存在，管线仍拒收、零新版本', () => {
  const root = makeTempRoot();
  try {
    const harness = makeHarness(root, {
      reader: readerOf({ [U_W]: ref(U_W, 'web', T0) }),
    });
    harness.log.appendVersion(makeEvent());
    const current = harness.log.currentOf('evt-1');

    const error = captureThrow(() => writeSummaryDirect(harness.pipeline, current, [U_W], '摘要'));

    assert.ok(error instanceof AnchorReferenceInvalidError, '跨通道仍被主结论拒收');
    const detail = (error as AnchorReferenceInvalidError).detail;
    assert.equal(detail.reason, 'anchor-cross-channel', '诊断桶 = 跨通道');
    assert.equal(detail.channel, 'web', '明细带实际通道');

    assert.equal(harness.log.versionsOf('evt-1').length, 1, '分桶不推翻拒收：零新版本');
    assert.equal(harness.log.currentOf('evt-1').summary_quality, 'pending');
  } finally {
    cleanupTempRoot(root);
  }
});
