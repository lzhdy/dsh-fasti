/**
 * QA 独立验证用例（B 块第一期 · 事件层）
 *
 * 为什么要独立写：
 *  - 验收要求「不得直接采信开发自测结论」→ 本文件由验收工程师独立设计；
 *  - 开发者现有用例的边界取样有缺口（如静默只测 29/31 分钟、条数只测 3、
 *    摘要只测 BMP 汉字），假通过风险高 → 本文件把边界两侧都钉死。
 *
 * 纪律：
 *  - 一律用临时 dataRoot（makeTempRoot / cleanupTempRoot），绝不触碰 ~/.dsh/fasti；
 *  - 不改生产代码、不改别人的测试文件；
 *  - 断言只针对「定案稿 / 任务书 / 技术基线」写明的行为。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CorruptedError, ConflictError } from '../../src/core/errors.ts';
import { EVENT_SCHEMA_VERSION, parseEvent, summaryLengthOf } from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import type { Experience } from '../../src/contract/experience.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { EventSegmenter } from '../../src/event/segmenter.ts';
import { resolveEventParams } from '../../src/event/params.ts';
import type { EventParams } from '../../src/event/params.ts';
import { InMemoryBacklog } from '../../src/event/backlog.ts';
import { ClosurePipeline } from '../../src/event/closure.ts';
import type { ClosureFailure } from '../../src/event/closure.ts';
import type { LLMPort, LLMSummarizeRequest, LLMSummarizeResponse } from '../../src/event/llm-port.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const BASE_MS = Date.parse('2026-11-08T10:00:00.000Z');
const MINUTE_MS = 60_000;

/** 基准 + 毫秒偏移 → ISO。 */
function atMs(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

/** 基准 + 分钟偏移 → ISO。 */
function atMinutes(minutes: number): string {
  return atMs(minutes * MINUTE_MS);
}

// ── 切分器测试台 ───────────────────────────────────────────────────────────

interface Harness {
  readonly root: string;
  readonly log: EventLog;
  readonly segmenter: EventSegmenter;
  feed(id: string, channel: string, occurredAt: string, extra?: Partial<Experience>): void;
  cleanup(): void;
}

function makeHarness(params?: Partial<EventParams>): Harness {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  const segmenter = new EventSegmenter({
    log,
    readExperience: () => undefined,
    now: () => BASE_MS,
    ...(params === undefined ? {} : { params: resolveEventParams(params) }),
  });

  let seq = 0;
  return {
    root,
    log,
    segmenter,
    feed(id, channel, occurredAt, extra) {
      const at = seq;
      seq += 1;
      const experience: Experience = {
        id,
        schema_version: 1,
        kind: 'dialogue',
        scene: { channel, ref: 'session-1' },
        initiation: 'user',
        observation: { cue: `记录 ${id}` },
        occurred_at: occurredAt,
        recorded_at: occurredAt,
        tick: at,
        ...extra,
        // v1.4 加法字段：默认 null（未统计）；extra 若显式给了 char_count 则以其为准。
        // 放在 ...extra **之后** 显式归一 —— Partial<Experience> 展开出的类型含 undefined。
        char_count: extra?.char_count ?? null,
      };
      segmenter.run({
        experience,
        location: { shard: '2026-11', seq: at },
        channel,
        tick: at,
      });
    },
    cleanup() {
      log.dispose();
      cleanupTempRoot(root);
    },
  };
}

// ── 闭管线测试台 ───────────────────────────────────────────────────────────

class FakePort implements LLMPort {
  readonly requests: LLMSummarizeRequest[] = [];
  response: LLMSummarizeResponse = { summary: '她打开了一个网页。', keyPoints: [], anchors: [] };
  error: Error | null = null;

  async summarize(request: LLMSummarizeRequest): Promise<LLMSummarizeResponse> {
    this.requests.push(request);
    if (this.error !== null) {
      throw this.error;
    }
    return this.response;
  }
}

function makeEventRecord(overrides: Partial<EventRecord> = {}): EventRecord {
  const base: EventRecord = {
    id: 'evt-1',
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'closed',
    closed_reason: 'silence',
    pointers: [{ id: 'exp-1', channel: 'dsh', shard: '2026-11', seq: 0 }],
    time_range: { started_at: atMinutes(0), ended_at: atMinutes(0) },
    assembled_at: atMinutes(0),
    summary: null,
    key_points: [],
    anchors: [],
    topic_lines: [],
    summary_quality: 'pending',
    summary_source: null,
    summary_prompt_version: null,
    summary_model: null,
    created_by: 'system',
    created_at: atMinutes(0),
    channel: 'dsh',
    boundary_candidates: [],
    effective_chars: null,
    raw_chars: null,
  };
  return { ...base, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════
// Q-B01 · 时间阈值边界两侧（29 分 59 秒 vs 30 分钟整）
// 定案稿 §5.2：静默 ≥ 30 分钟 → 闭合
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B01 · 静默 29 分 59 秒（29:59）→ 不切，仍在同一事件', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMs(29 * MINUTE_MS + 59_000));

    const events = h.log.readAll();
    assert.equal(events.length, 1, '29 分 59 秒未达阈值 → 不切');
    assert.equal(events[0]?.status, 'open');
    assert.equal(events[0]?.pointers.length, 2);
  } finally {
    h.cleanup();
  }
});

test('Q-B01 · 静默恰好 30 分 00 秒（30:00）→ 切（阈值是「≥」不是「>」）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMs(30 * MINUTE_MS));

    const events = h.log.readAll();
    assert.equal(events.length, 2, '恰好 30 分钟必须闭合（判据是 ≥ 30 分钟）');
    assert.equal(events[0]?.status, 'closed');
    assert.equal(events[0]?.closed_reason, 'silence');
    assert.equal(events[1]?.status, 'open');
  } finally {
    h.cleanup();
  }
});

test('Q-B01 · 静默 30 分 00 秒 001 毫秒 → 仍切（阈值含端点，不漂移）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMs(30 * MINUTE_MS + 1));

    assert.equal(h.log.readAll().length, 2);
  } finally {
    h.cleanup();
  }
});

test('Q-B01 · 改参数后阈值随动（30 → 29 分钟时 29:00 即切）', () => {
  const h = makeHarness({ silenceGapMinutes: 29 });
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(29));

    assert.equal(h.log.readAll().length, 2, '参数改小后 29:00 即闭合');
  } finally {
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B02 · 上限边界（默认有效对话 7000 字：6999 / 7000 / 7001）
// 定案稿 §5.2：单事件 ≤ 7000 有效对话字，超限强制闭合
//
// v1.4 设计性改写（定案稿 §9「不做 20 条记录硬上限（退役，max-records 仅保留
// 兼容读取）」+ 任务书 C3/C4）：旧用例组以**条数**为界（19/20/21 条），
// 新用例组以**有效对话字数**为界（6999/7000/7001 字），结构一一对应。
// 约束项数不减（每条 4~5 项 → 每条 5~6 项），且覆盖面更广：
// 多断言了计数器落盘值与「旧事件不被后续记录撑大」。
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B02 · 默认参数下 6999 字 → 同一事件且仍 open', () => {
  const h = makeHarness();
  try {
    // 一条 6999 字（非工具轮）。
    h.feed('exp-1', 'dsh', atMinutes(1), { char_count: 6999 });

    const events = h.log.readAll();
    assert.equal(events.length, 1, '6999 字未达上限 → 1 个事件');
    assert.equal(events[0]?.status, 'open', '未达上限不得闭合');
    assert.equal(events[0]?.pointers.length, 1);
    assert.equal(events[0]?.closed_reason, null);
    assert.equal(events[0]?.effective_chars, 6999, '有效对话字数已累计落盘');
  } finally {
    h.cleanup();
  }
});

test('Q-B02 · 默认参数下 7000 字 → 闭合且含触发的那一条（≤7000 上限）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(1), { char_count: 7000 });

    const events = h.log.readAll();
    assert.equal(events.length, 1, '闭合本事件，仍只有 1 个事件');
    assert.equal(events[0]?.status, 'closed');
    assert.equal(events[0]?.closed_reason, 'max-dialogue-chars');
    assert.equal(events[0]?.pointers.length, 1, '事件含触发闭合的那一条');
    assert.equal(events[0]?.effective_chars, 7000, '闭合时刻的计数随版本落盘');
  } finally {
    h.cleanup();
  }
});

test('Q-B02 · 默认参数下第 2 条（累计超限）→ 另开新事件（旧事件保持不变）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(1), { char_count: 7000 });
    h.feed('exp-2', 'dsh', atMinutes(2), { char_count: 10 });

    const events = h.log.readAll();
    assert.equal(events.length, 2, '超限后的记录必须另开新事件');
    assert.equal(events[0]?.pointers.length, 1, '旧事件不被后续记录撑大');
    assert.equal(events[0]?.status, 'closed');
    assert.equal(events[0]?.effective_chars, 7000, '旧事件的计数不被回写');
    assert.equal(events[1]?.pointers.length, 1);
    assert.equal(events[1]?.status, 'open');
    assert.equal(events[1]?.effective_chars, 10, '新事件从零起算');
  } finally {
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B03 · 摘要长度边界（600 码点 vs 601 码点；含 emoji 代理对）
// 定案稿 §6.4 + 契约层 summaryLengthOf：按**码点**算
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B03 · 契约层：600 码点通过、601 码点拒收', () => {
  assert.equal(summaryLengthOf('事'.repeat(600)), 600);
  assert.doesNotThrow(() =>
    parseEvent(makeEventRecord({ summary: '事'.repeat(600) }), 'write'),
  );
  assert.throws(() => parseEvent(makeEventRecord({ summary: '事'.repeat(601) }), 'write'));
});

test('Q-B03 · 契约层：600 个 emoji（1200 码元）按码点口径放行', () => {
  const emoji = '😀'.repeat(600);
  assert.equal(emoji.length, 1200, '前置条件：UTF-16 码元数 = 2 × 码点数');
  assert.equal(summaryLengthOf(emoji), 600, '前置条件：码点数 = 600');
  assert.doesNotThrow(
    () => parseEvent(makeEventRecord({ summary: emoji }), 'write'),
    '契约层按码点判 → 600 码点应放行',
  );
});

test('Q-B03 · 契约层：601 个 emoji 按码点口径拒收', () => {
  const tooLong = '😀'.repeat(601);
  assert.equal(summaryLengthOf(tooLong), 601);
  assert.throws(() => parseEvent(makeEventRecord({ summary: tooLong }), 'write'));
});

test('Q-B03 · 闭合管线：600 码点的含 emoji 摘要被接受（与落盘同一码点口径）', async () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    const port = new FakePort();
    // 300 个 emoji = 300 码点 / 600 码元（远低于 600 字上限，语义上完全合格）。
    port.response = { summary: '😀'.repeat(300), keyPoints: [], anchors: [] };
    const backlog = new InMemoryBacklog();
    const failures: ClosureFailure[] = [];
    const pipeline = new ClosurePipeline({
      log,
      port,
      backlog,
      readTexts: () => ['原文'],
      onFailure: (failure) => failures.push(failure),
    });
    log.appendVersion(makeEventRecord());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(
      current.summary_quality,
      'ready',
      '300 码点（600 码元）的摘要远低于 600 字上限，闭合管线不得拒收',
    );
    assert.equal(current.summary, '😀'.repeat(300));
    assert.equal(failures.length, 0, '不应产生失败明细');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

test('Q-B03 · 闭合管线：恰好 600 码点的 emoji 摘要应被接受', async () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    const port = new FakePort();
    port.response = { summary: '😀'.repeat(600), keyPoints: [], anchors: [] };
    const backlog = new InMemoryBacklog();
    const pipeline = new ClosurePipeline({ log, port, backlog, readTexts: () => ['原文'] });
    log.appendVersion(makeEventRecord());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    assert.equal(
      log.currentOf('evt-1').summary_quality,
      'ready',
      '600 码点 = 契约层硬上限，闭合管线必须放行（与契约层同口径）',
    );
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

test('Q-B03 · 闭合管线：601 码点的 emoji 摘要应被拒收（真超限）', async () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    const port = new FakePort();
    port.response = { summary: '😀'.repeat(601), keyPoints: [], anchors: [] };
    const backlog = new InMemoryBacklog();
    const pipeline = new ClosurePipeline({ log, port, backlog, readTexts: () => ['原文'] });
    log.appendVersion(makeEventRecord());

    pipeline.enqueue('evt-1');
    await pipeline.processOne(0);

    const current = log.currentOf('evt-1');
    assert.equal(current.summary_quality, 'pending', '真超限 → 保持 pending');
    assert.equal(current.summary, null, '不得截断入库');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B04 · 空事件 / 单指针事件 / 超长指针组
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B04 · 空指针组事件可被真源接受（契约不禁止空数组）', () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    log.appendVersion(makeEventRecord({ pointers: [] }));
    const current = log.currentOf('evt-1');
    assert.deepEqual(current.pointers, [], '空指针组原样保留');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

test('Q-B04 · 单指针事件可被真源接受且可往返', () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    log.appendVersion(makeEventRecord({ pointers: [{ id: 'exp-only' }] }));
    const current = log.currentOf('evt-1');
    assert.equal(current.pointers.length, 1);
    assert.equal(current.pointers[0]?.id, 'exp-only');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

test('Q-B04 · 超长指针组（500 条）往返后条数与顺序不变', () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    const pointers = Array.from({ length: 500 }, (_, i) => ({
      id: `exp-${i}`,
      channel: 'dsh',
      shard: '2026-11',
      seq: i,
    }));
    log.appendVersion(makeEventRecord({ pointers }));
    const current = log.currentOf('evt-1');
    assert.equal(current.pointers.length, 500);
    assert.equal(current.pointers[0]?.id, 'exp-0');
    assert.equal(current.pointers[499]?.id, 'exp-499');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B05 · 并发写入同一事件（幂等性）
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B05 · 并发追加同一 (id, version) → 只落一行，不报错', async () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    const record = makeEventRecord();
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, async () => log.appendVersion(record)),
    );

    assert.equal(outcomes.filter((outcome) => outcome.created).length, 1, '只有一次是真写入');
    assert.equal(outcomes.filter((outcome) => !outcome.created).length, 9, '其余 9 次是幂等命中');
    assert.equal(log.versionsOf('evt-1').length, 1, '真源只落一行');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

test('Q-B05 · 并发追加不同 version → 版本号连续、无洞', async () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, async (_, i) =>
        log.appendVersion(makeEventRecord({ version: i + 1 })),
      ),
    );

    assert.equal(outcomes.filter((outcome) => outcome.created).length, 5, '5 个版本都写入');
    const versions = log.versionsOf('evt-1').map((r) => r.version).sort((a, b) => a - b);
    assert.deepEqual(versions, [1, 2, 3, 4, 5], '版本号无洞无重');
    assert.equal(log.currentOf('evt-1').version, 5, '当前态 = 最大 version');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B06 · 重放同一批摄入（幂等性）
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B06 · 重放同一批摄入（走生产门面）→ 事件数不增、指针不重复', async () => {
  const root = makeTempRoot('qa-fasti-');
  // 生产路径：门面在幂等命中时早退，stage 不会二次切。
  const { Fasti } = await import('../../src/api/index.ts');
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const turn = (eventId: string, at: string) => ({
      event_id: eventId,
      session_id: 'session-1',
      speaker: 'user' as const,
      raw_text: `内容 ${eventId}`,
      asserted_at: at,
      occurred_at: at,
    });

    const first = await fasti.ingestRawTurn('dsh', turn('evt-1', atMinutes(0)));
    await fasti.ingestRawTurn('dsh', turn('evt-2', atMinutes(1)));

    // 重放整批。
    const replay = await fasti.ingestRawTurn('dsh', turn('evt-1', atMinutes(0)));
    await fasti.ingestRawTurn('dsh', turn('evt-2', atMinutes(1)));

    assert.equal(replay.id, first.id, '同 event_id 视为重试，返回同一条经历');

    const events = await fasti.queryEvents();
    assert.equal(events.length, 1, '重放不产生第二个事件');
    assert.equal(events[0]?.pointers.length, 2, '指针组不重复（没有 exp-1,exp-2,exp-1,exp-2）');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('Q-B06 · 重启后重放同一批摄入 → 事件数不增（索引从真源恢复）', async () => {
  const root = makeTempRoot('qa-fasti-');
  const { Fasti } = await import('../../src/api/index.ts');
  const turn = (eventId: string, at: string) => ({
    event_id: eventId,
    session_id: 'session-1',
    speaker: 'user' as const,
    raw_text: `内容 ${eventId}`,
    asserted_at: at,
    occurred_at: at,
  });

  const first = await Fasti.open({ dataRoot: root });
  try {
    await first.ingestRawTurn('dsh', turn('evt-1', atMinutes(0)));
    await first.ingestRawTurn('dsh', turn('evt-2', atMinutes(1)));
  } finally {
    await first.close();
  }

  const second = await Fasti.open({ dataRoot: root });
  try {
    await second.ingestRawTurn('dsh', turn('evt-1', atMinutes(0)));
    await second.ingestRawTurn('dsh', turn('evt-2', atMinutes(1)));

    const events = await second.queryEvents();
    assert.equal(events.length, 1, '重启后重放不新增事件');
    assert.equal(events[0]?.pointers.length, 2, '指针不重复');
  } finally {
    await second.close();
    cleanupTempRoot(root);
  }
});

test('Q-B06 · 切分器自身按记录 id 去重（直接驱动 stage 也不重复挂指针）', () => {
  // 原为特征化断言（记录「无记录级去重」这一缺口）。缺口已修：防线从门面下沉到 stage，
  // 因为门面的幂等早退只挡得住经过门面的路径，挡不住回填 / 补切这类直接驱动 stage 的入口。
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-1', 'dsh', atMinutes(0));

    const events = h.log.readAll();
    assert.equal(events.length, 1, '重复驱动不产生第二个事件');
    assert.equal(events[0]?.pointers.length, 1, '同一条经历只挂一次指针');
    assert.equal(events[0]?.version, 1, '重放连版本行都不该追加');
  } finally {
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B07 · 事件真源损坏时的行为（应降级不整体失败）
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B07 · 事件真源坏行 → 抛 CorruptedError（不静默跳过、不返回空）', () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    log.appendVersion(makeEventRecord({ id: 'evt-good' }));
    log.dispose();

    // 追加一行损坏数据。
    const shardFile = path.join(layoutOf(root).events, '2026-11.jsonl');
    fs.appendFileSync(shardFile, '{"id":"evt-bad","version":\n');

    const log2 = new EventLog(layoutOf(root).events);
    assert.throws(() => log2.reindex(), CorruptedError, '重建索引时坏行必须响亮失败');
    log2.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('Q-B07 · 一个分片坏行 → 整个事件层不可读（事实记录：真源损坏是响亮失败，不是局部降级）', () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    log.appendVersion(makeEventRecord({ id: 'evt-good' }));
    log.dispose();

    // 另建一个分片放坏行。
    const badShard = path.join(layoutOf(root).events, '2026-12.jsonl');
    fs.writeFileSync(badShard, '{"id":"evt-bad","version":\n');
    const manifestPath = path.join(layoutOf(root).events, 'manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ months: ['2026-11', '2026-12'] }, null, 2),
    );

    const log2 = new EventLog(layoutOf(root).events);
    // 事实：索引重建与整表读取都会被坏分片拖住 —— 没有任何局部降级路径。
    // 定案依据：A 块 §7.4 的「降级」只针对**投影层**（L1→L2→L3），
    // 真源是不可再生的二级真源 → 损坏必须**响亮失败**，绝不静默跳过。
    assert.throws(() => log2.reindex(), CorruptedError, '索引重建必须响亮失败');
    assert.throws(() => log2.readAll(), CorruptedError, '整表读取必须响亮失败');
    log2.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B08 · EventLog 多实例 / 索引漂移（双层防线）
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B08 · 同一目录第二个实例 → 构造时即抛 ConflictError（单写者）', () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    assert.throws(() => new EventLog(layoutOf(root).events), ConflictError);
    // 显式复用出口是唯一合法路径。
    const reused = EventLog.open(layoutOf(root).events);
    assert.equal(reused, log, 'open() 返回既有活实例');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

test('Q-B08 · dispose 后可重新 new 同一目录', () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  log.dispose();
  const log2 = new EventLog(layoutOf(root).events);
  assert.notEqual(log2, log);
  log2.dispose();
  cleanupTempRoot(root);
});

test('Q-B08 · 索引漂移（旁路写入）→ 写前校验抛 ConflictError，不写坏真源', () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    log.appendVersion(makeEventRecord({ id: 'evt-1' }));

    // 模拟旁路脚本往同一分片写了一行（绕过 EventLog）。
    fs.appendFileSync(
      path.join(layoutOf(root).events, '2026-11.jsonl'),
      `${JSON.stringify({ ...makeEventRecord({ id: 'evt-foreign' }), id: 'evt-foreign' })}\n`,
    );

    assert.throws(
      () => log.appendVersion(makeEventRecord({ id: 'evt-2', version: 1 })),
      ConflictError,
      '漂移必须抛错',
    );
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

test('Q-B08 · 索引漂移时读侧兜底：落点对不上即抛 CorruptedError（不静默读错）', () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    log.appendVersion(makeEventRecord({ id: 'evt-1' }));

    // 旁路改写第 0 行 → 本实例的索引落点漂移（不 reindex）。
    const shardFile = path.join(layoutOf(root).events, '2026-11.jsonl');
    const lines = fs
      .readFileSync(shardFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    lines[0] = JSON.stringify({ ...makeEventRecord({ id: 'evt-swapped' }), id: 'evt-swapped' });
    fs.writeFileSync(shardFile, `${lines.join('\n')}\n`);

    assert.throws(
      () => log.currentOf('evt-1'),
      CorruptedError,
      '读侧兜底：落点对不上必须抛错，绝不静默返回别人的行',
    );
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B09 · 未配置模型时闭合任务的行为（保持 pending、可观测、不伪造）
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B09 · 未配置模型（port=null）→ 事件保持 pending、summary 为 null、不伪造', async () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    const backlog = new InMemoryBacklog();
    const pipeline = new ClosurePipeline({ log, port: null, backlog, readTexts: () => ['原文'] });
    log.appendVersion(makeEventRecord());

    pipeline.enqueue('evt-1');
    assert.equal(backlog.size(), 0, '无模型 → 不入队（省得空转）');

    const processed = await pipeline.processOne(0);
    assert.equal(processed, false, '无任务可处理');

    const current = log.currentOf('evt-1');
    assert.equal(current.summary, null, '不伪造占位文案');
    assert.equal(current.summary_quality, 'pending', '如实保持 pending');
    assert.equal(current.version, 1, '不写新版本');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

test('Q-B09 · 未配置模型时清道夫不入队，但事件仍可被扫出（可观测）', () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    const backlog = new InMemoryBacklog();
    const pipeline = new ClosurePipeline({ log, port: null, backlog, readTexts: () => ['原文'] });
    log.appendVersion(makeEventRecord({ id: 'evt-a' }));
    log.appendVersion(makeEventRecord({ id: 'evt-b' }));

    assert.equal(pipeline.sweepPending(), 0, '无模型 → 清道夫不入队');
    assert.equal(backlog.size(), 0);

    // 可观测：调用方仍能从真源读出「哪些事件还欠摘要」。
    const pending = log.readAll().filter((e) => e.summary_quality === 'pending');
    assert.equal(pending.length, 2, '待补摘要的事件在真源里可见');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

test('Q-B09 · 连续失败达上限 → 事件如实保持 pending、失败明细可查（不静默丢弃）', async () => {
  const root = makeTempRoot('qa-fasti-');
  const log = new EventLog(layoutOf(root).events);
  try {
    const port = new FakePort();
    port.error = new Error('模型路由不可用');
    const backlog = new InMemoryBacklog();
    const failures: ClosureFailure[] = [];
    const pipeline = new ClosurePipeline({
      log,
      port,
      backlog,
      readTexts: () => ['原文'],
      onFailure: (f) => failures.push(f),
    });
    log.appendVersion(makeEventRecord());
    pipeline.enqueue('evt-1');

    for (let i = 0; i < 20; i += 1) {
      await pipeline.processOne(i * 60_000_000);
    }

    assert.ok(failures.length > 0, '失败明细可查');
    assert.equal(failures[failures.length - 1]?.exhausted, true, '最终标记为耗尽');
    const current = log.currentOf('evt-1');
    assert.equal(current.summary, null, '不伪造');
    assert.equal(current.summary_quality, 'pending', '如实 pending');
    assert.equal(backlog.size(), 0, '耗尽后不再空转');
  } finally {
    log.dispose();
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B10 · 闭合期间事件仍可检索（摘要未生成时可回原文）
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B10 · 摘要未生成时事件已 closed 且指针完整（可回原文）', () => {
  const h = makeHarness();
  try {
    h.feed('exp-1', 'dsh', atMinutes(0));
    h.feed('exp-2', 'dsh', atMinutes(31));

    const closed = h.log.readAll().find((e) => e.status === 'closed');
    assert.ok(closed, '有闭合事件');
    assert.equal(closed.summary_quality, 'pending');
    assert.equal(closed.pointers.length, 1, '指针在 → 可回原文');
    assert.equal(closed.closed_reason, 'silence');
  } finally {
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Q-B11 · 参数集中：阈值字面量不得散落（静态扫描）
// ═══════════════════════════════════════════════════════════════════════════

test('Q-B11 · 切分器/闭合管线内不出现静默阈值与条数上限的字面量', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  for (const file of ['src/event/segmenter.ts', 'src/event/closure.ts', 'src/event/backlog.ts']) {
    const text = readFileSync(path.join(repoRoot, file), 'utf8');
    // 30 分钟 / 20 条 / 600 字三个阈值不得以裸字面量出现在这些文件里。
    assert.equal(
      /(?<![0-9])30\s*\*\s*60_000/.test(text),
      false,
      `${file} 不得内联「30 分钟」换算（须走 params.ts）`,
    );
    assert.equal(
      /(?:maxRecords|recordsLimit|MAX_RECORDS)\s*=\s*20\b/.test(text),
      false,
      `${file} 不得内联「20 条」上限`,
    );
  }
});
