/**
 * 真实数据重放 · 分段与冻结夹具一致（v1.4 评审 P0 的验收用例）。
 *
 * **P0 是什么**：上一轮把「任务闭环信号」的判据落地后，信号被**直接激活**了 ——
 * 于是真实数据上切出了 21 段（14 task-closure + 7 silence），而冻结夹具是
 * 8 段（7 silence + 1 open），A11 无法通过。
 *
 * **根因**：定案稿 §5.2 机械信号表把任务闭环标为 `dormant`，唤醒路径写得很死 ——
 * 「阶段 0 类型化 + 作用域级判据落地并经用例验证后，**才把该信号从 `dormant`
 * 改为 `active`**」，并强调「**休眠是显式状态，不是一句注释**」。
 * 上一轮把「判据落地 + 用例验证」当成了自动激活，漏掉了那次显式的口径变更。
 *
 * **本用例守什么**：
 *  1. 默认参数下重放 → **零 task-closure**；
 *  2. 分段结果与冻结夹具**逐段一致**（段数、段边界、闭合原因、指针数、双计数器）；
 *  3. 显式打开开关 → task-closure 重新出现（证明门控是**真的**在门控，
 *     而不是「判据恰好永不触发」这种假通过）。
 *
 * **能抓住这个 P0 的实证（变异测试）**：把 `mergeInto` 里的门控
 * （`taskScopeActiveOf(this.params) &&`）临时拆掉，本文件的用例立刻变红：
 *   - 段数 **21**（期望 8）—— 与评审报告的「21 段」完全一致；
 *   - task-closure **14**（期望 0）—— 与评审报告的「14 task-closure」完全一致。
 * 两者数字吻合说明：本用例的反推数据与真实数据在切分口径上等价，
 * 且用例确实能抓住这个缺陷（不是假通过）。
 *
 * **数据从哪来**：真实数据根 `~/.dsh/fasti` 不在仓库里（也不在本机 ——
 * 见 README 第五节的阻塞说明），所以本用例从**冻结夹具**
 * （`tests/fixtures/expected-segments-v1.4.json`，与任务书附件同 sha256）
 * 反推出等价的记录序列：段边界、每段的 kind 序列、每段的两个计数器总量
 * 都取自夹具，段内相邻记录的时间按夹具的跨度均分（保证落在同一段内）。
 *
 * 这样得到的重放与真实数据在**切分口径上等价**：夹具生成器
 * （`make-fixture.py`）与 `backfill-events.ts` 用的是同一套规则
 * （occurred_at 世界轴、≥30min 静默、两上限先保险丝后有效对话字数、
 * **任务闭环 dormant 不参与**）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Experience } from '../../src/contract/experience.ts';
import { EventSegmenter } from '../../src/event/segmenter.ts';
import type { IngestStageContext } from '../../src/event/ingest-stage.ts';
import { resolveEventParams } from '../../src/event/params.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 冻结夹具副本（与任务书附件 `expected-segments-v1.4.json` 同 sha256）。 */
const FIXTURE_PATH = path.join(here, '..', 'fixtures', 'expected-segments-v1.4.json');

/** 夹具的一段。 */
interface FixtureSegment {
  segment: number;
  status: 'closed' | 'open';
  closed_reason: string | null;
  started_at: string;
  ended_at: string;
  pointers: { tick: number; experience_id: string; kind: 'dialogue' | 'call-step' | 'result' }[];
  effective_chars: number;
  raw_chars: number;
}

/** 夹具顶层。 */
interface Fixture {
  segment_count: number;
  cap_hits: unknown[];
  segments: FixtureSegment[];
}

function loadFixture(): Fixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
}

const MINUTE_MS = 60_000;

/**
 * 从夹具反推出的等价记录序列里的一条。
 *
 * `charCount` 是该条记录的 `char_count`（= 原文全量码点数）。
 * `kind` 是载荷形状（与 `make-fixture.py` 的 `payload_kind` 同一判据）。
 */
interface ReplayRecord {
  id: string;
  tick: number;
  occurredAt: string;
  kind: 'dialogue' | 'call-step' | 'result';
  charCount: number;
  /** 该条是否为「她交付结果」的轮次（initiation='her'）。 */
  isHerTurn: boolean;
}

/**
 * 从夹具反推等价记录序列。
 *
 * 关键约束（必须让重放落在与夹具相同的分段上）：
 *  - **段内**相邻记录间隔 < 30 分钟（否则会被静默切开）；
 *  - **段间**间隔 ≥ 30 分钟（否则不会切开）；
 *  - 每段的两个计数器总量等于夹具记录值（否则上限判定与夹具不一致）。
 *
 * 时间分配：段内按指针顺序在 [started_at, ended_at] 之间均分；
 * 每段的 `char_count` 按 kind 分配 —— 工具轮吃 raw 额度、非工具轮吃 effective 额度，
 * 且两者之和分别等于夹具的 `raw_chars` / `effective_chars`（与生成器同口径）。
 */
function buildReplayRecords(fixture: Fixture): ReplayRecord[] {
  const out: ReplayRecord[] = [];
  for (const segment of fixture.segments) {
    const count = segment.pointers.length;
    const startMs = Date.parse(segment.started_at);
    const endMs = Date.parse(segment.ended_at);

    // 工具轮（call-step / result）只吃 raw 额度；其余吃 effective 额度。
    const toolCount = segment.pointers.filter((p) => p.kind !== 'dialogue').length;
    const dialogueCount = count - toolCount;
    // 工具轮在 raw 里的超额部分（raw - effective）由工具轮承担。
    const toolRawQuota = segment.raw_chars - segment.effective_chars;
    const dialogueRawQuota = segment.effective_chars;

    // 均分额度（余数给最后一条，保证求和精确等于夹具值）。
    const dialogueEach = dialogueCount === 0 ? 0 : Math.floor(dialogueRawQuota / dialogueCount);
    const toolEach = toolCount === 0 ? 0 : Math.floor(toolRawQuota / toolCount);
    let dialogueLeft = dialogueRawQuota - dialogueEach * dialogueCount;
    let toolLeft = toolRawQuota - toolEach * toolCount;

    for (let index = 0; index < count; index += 1) {
      const pointer = segment.pointers[index];
      assert.ok(pointer, '夹具指针存在');
      const isTool = pointer.kind !== 'dialogue';
      let charCount: number;
      if (isTool) {
        charCount = toolEach + (toolLeft > 0 ? 1 : 0);
        toolLeft -= toolLeft > 0 ? 1 : 0;
      } else {
        charCount = dialogueEach + (dialogueLeft > 0 ? 1 : 0);
        dialogueLeft -= dialogueLeft > 0 ? 1 : 0;
      }

      // 段内时间均分（末条落在 ended_at 上）。
      const ratio = count === 1 ? 0 : index / (count - 1);
      const occurredMs = Math.round(startMs + (endMs - startMs) * ratio);

      out.push({
        id: pointer.experience_id,
        tick: pointer.tick,
        occurredAt: new Date(occurredMs).toISOString(),
        kind: pointer.kind,
        charCount,
        // 结果轮之后的第一条非工具轮 =「她交付结果」的轮次（initiation='her'）。
        // 这是 v1.4 作用域判据的交付轮信号 —— 门控打开时它正是闭合的触发点。
        isHerTurn: index > 0 && segment.pointers[index - 1]?.kind === 'result',
      });
    }
  }
  // 全局按**世界轴时间**排序（同时刻按 tick 兜底）—— 与夹具生成器
  // （`make-fixture.py` 的 `experiences.sort(key=lambda e: (occurred_at, tick))`）
  // 与 `backfill-events.ts` 的排序口径完全一致。
  //
  // 注意：**不能按 tick 排序** —— 夹具的 tick 是「每个会话各自计数」，
  // 全局并不单调（seg1 是 tick 163..186，seg4 却是 tick 0..19）。
  return out.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) {
      return a.occurredAt < b.occurredAt ? -1 : 1;
    }
    return a.tick - b.tick;
  });
}

/** 构造一条经历（按夹具的 kind 给出类型化产物）。 */
function toExperience(record: ReplayRecord, channel: string): Experience {
  const base: Experience = {
    id: record.id,
    schema_version: 1,
    kind: 'dialogue',
    scene: { channel, ref: 'session-replay' },
    initiation: record.isHerTurn ? 'her' : 'user',
    observation: { cue: `重放 ${record.id}` },
    occurred_at: record.occurredAt,
    recorded_at: record.occurredAt,
    tick: record.tick,
    char_count: record.charCount,
  };

  if (record.kind === 'call-step') {
    // 调用步：带 callId 的工具调用（准入门槛置位 + 进入在途集合）。
    return {
      ...base,
      action: { type: 'tool-call', tool: 'replay_tool', call_id: `call-${record.tick}` },
    };
  }
  if (record.kind === 'result') {
    // 结果轮：配对离场。
    return {
      ...base,
      outcome: { status: 'success', call_id: `call-${record.tick - 1}` },
    };
  }
  return base;
}

/** 重放结果。 */
interface ReplayOutcome {
  segmentCount: number;
  taskClosureCount: number;
  /** 逐段：段边界 / 闭合原因 / 指针数 / 双计数器。 */
  segments: {
    status: string;
    closed_reason: string | null;
    started_at: string;
    ended_at: string;
    pointerCount: number;
    effective_chars: number | null;
    raw_chars: number | null;
  }[];
}

function replay(params?: { taskClosureActive?: boolean }): ReplayOutcome {
  const fixture = loadFixture();
  const records = buildReplayRecords(fixture);
  const root = makeTempRoot('fasti-replay-');
  try {
    const log = new EventLog(layoutOf(root).events);
    const segmenter = new EventSegmenter({
      log,
      readExperience: () => undefined,
      params: resolveEventParams(
        params === undefined ? {} : { taskClosureActive: params.taskClosureActive === true },
      ),
      now: () => Date.parse('2026-11-10T00:00:00.000Z'),
    });

    for (const record of records) {
      const experience = toExperience(record, 'dsh');
      const ctx: IngestStageContext = {
        experience,
        location: { shard: '2026-11', seq: record.tick },
        channel: 'dsh',
        tick: record.tick,
      };
      segmenter.run(ctx);
    }

    const events = log.readAll();
    return {
      segmentCount: events.length,
      taskClosureCount: events.filter((event) => event.closed_reason === 'task-closure').length,
      segments: events.map((event) => ({
        status: event.status,
        closed_reason: event.closed_reason,
        started_at: event.time_range.started_at,
        ended_at: event.time_range.ended_at,
        pointerCount: event.pointers.length,
        effective_chars: event.effective_chars,
        raw_chars: event.raw_chars,
      })),
    };
  } finally {
    cleanupTempRoot(root);
  }
}

test('P0 · 默认参数下重放真实数据 → 零 task-closure（信号 dormant）', () => {
  const outcome = replay();
  assert.equal(
    outcome.taskClosureCount,
    0,
    '任务闭环信号默认休眠 → 不得产生任何 task-closure（定案稿 §5.2 dormant）',
  );
});

test('P0 · 默认参数下重放 → 分段与冻结夹具一致（8 段 / 7 silence + 1 open）', () => {
  const fixture = loadFixture();
  const outcome = replay();

  assert.equal(outcome.segmentCount, fixture.segment_count, '段数与冻结夹具一致');
  assert.equal(outcome.segmentCount, 8, '冻结夹具是 8 段');
  assert.equal(outcome.taskClosureCount, 0, '零 task-closure');

  // 逐段比对：状态 / 闭合原因 / 段边界 / 指针数 / 双计数器。
  for (let index = 0; index < fixture.segments.length; index += 1) {
    const expected = fixture.segments[index];
    assert.ok(expected, '夹具段存在');
    const actual = outcome.segments[index];
    assert.ok(actual, `第 ${index + 1} 段存在`);
    assert.equal(actual.status, expected.status, `第 ${index + 1} 段状态一致`);
    assert.equal(
      actual.closed_reason,
      expected.closed_reason,
      `第 ${index + 1} 段闭合原因一致（夹具：${String(expected.closed_reason)}）`,
    );
    assert.equal(
      actual.pointerCount,
      expected.pointers.length,
      `第 ${index + 1} 段指针数一致`,
    );
    assert.equal(
      actual.effective_chars,
      expected.effective_chars,
      `第 ${index + 1} 段有效对话字数一致`,
    );
    assert.equal(actual.raw_chars, expected.raw_chars, `第 ${index + 1} 段 raw 全量字符一致`);
  }

  // 闭合原因分布：7 段静默 + 1 段 open，零 task-closure。
  const reasons = outcome.segments.map((segment) => segment.closed_reason);
  assert.equal(reasons.filter((reason) => reason === 'silence').length, 7, '7 段静默闭合');
  assert.equal(reasons.filter((reason) => reason === null).length, 1, '末段保持 open');
  assert.equal(reasons.filter((reason) => reason === 'task-closure').length, 0, '零 task-closure');
});

test('P0 · 门控是真的在门控 —— 显式打开开关后 task-closure 重新出现', () => {
  // 反向对照：若打开开关后仍然零 task-closure，说明「零」是因为判据本就永不触发，
  // 门控就是假通过；本用例排除这种可能。
  const outcome = replay({ taskClosureActive: true });
  assert.ok(
    outcome.taskClosureCount > 0,
    '显式激活后必须能产生 task-closure（否则上面的零是假通过）',
  );
  assert.ok(
    outcome.segmentCount > 8,
    `激活后段数应多于夹具的 8 段（实际 ${outcome.segmentCount}）`,
  );
});

// ── 脚本级守卫：评审复现用的就是回填脚本的 dry-run ────────────────────────
//
// 上面的用例走切分器直调；评审是在**回填脚本**（`backfill-events.ts --json`）
// 的 dry-run 上看到 21 段 / 14 task-closure 的。那条路径必须同样有守卫 ——
// 否则「切分器对了、脚本不对」也是一种漏网。
//
// 本用例从冻结夹具反推一份**等价数据根**（经历层 + 原文层，RawTurn 八字段齐全），
// 跑真实脚本，断言：8 段、零 task-closure、逐段指针数与夹具一致。

/** 构造等价数据根（经历层 + 原文层）。 */
function seedReplayRoot(root: string, fixture: Fixture, records: ReplayRecord[]): void {
  const layout = layoutOf(root);
  fs.mkdirSync(layout.experiences, { recursive: true });
  fs.mkdirSync(layout.rawTurns, { recursive: true });

  const expLines: string[] = [];
  const rawLines: string[] = [];
  // 按 kind 重建载荷：工具轮用真实 JSON 形态（否则类型化认不出来），
  // 结果轮的 toolCallId 引用**最近一个未配对的调用步**（与真实数据同构）。
  let pendingCallId: string | undefined;
  for (const record of records) {
    let rawText: string;
    if (record.kind === 'call-step') {
      pendingCallId = `call-${record.tick}`;
      rawText = JSON.stringify({
        name: 'replay_tool',
        arguments: { pad: 'y'.repeat(Math.max(1, record.charCount)) },
        callId: pendingCallId,
      });
    } else if (record.kind === 'result') {
      const callId = pendingCallId ?? `call-${record.tick}`;
      pendingCallId = undefined;
      rawText = JSON.stringify({
        message: { toolCallId: callId, content: 'r'.repeat(Math.max(1, record.charCount)) },
      });
    } else {
      rawText = 'd'.repeat(Math.max(1, record.charCount));
    }

    rawLines.push(
      JSON.stringify({
        event_id: record.id,
        session_id: 'session-replay',
        turn_id: `turn-${record.tick}`,
        speaker: record.kind === 'dialogue' ? 'user' : 'tool',
        raw_text: rawText,
        asserted_at: record.occurredAt,
        ingested_at: record.occurredAt,
        content_hash: createHash('sha256').update(rawText).digest('hex'),
      }),
    );
    expLines.push(
      JSON.stringify({
        id: record.id,
        schema_version: 1,
        kind: 'dialogue',
        scene: { channel: 'dsh', ref: 'session-replay' },
        initiation: 'user',
        observation: {
          text: { id: record.id, channel: 'dsh', shard: '2026-11', seq: record.tick },
        },
        occurred_at: record.occurredAt,
        recorded_at: record.occurredAt,
        tick: record.tick,
      }),
    );
  }

  fs.writeFileSync(
    path.join(layout.experiences, '2026-11.jsonl'),
    `${expLines.join('\n')}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(layout.experiences, 'manifest.json'),
    `${JSON.stringify({ version: 1, months: ['2026-11'] })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(layout.rawTurns, '2026-11.jsonl'),
    `${rawLines.join('\n')}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(layout.rawTurns, 'manifest.json'),
    `${JSON.stringify({ version: 1, months: ['2026-11'] })}\n`,
    'utf8',
  );
}

test('P0 · 回填脚本 dry-run（评审复现路径）→ 8 段、零 task-closure、逐段与夹具一致', () => {
  const fixture = loadFixture();
  const records = buildReplayRecords(fixture);
  const root = makeTempRoot('fasti-replay-cli-');
  try {
    seedReplayRoot(root, fixture, records);

    // 真实脚本、真实 dry-run（**不执行 --apply**）。
    const raw = execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, '..', '..', 'scripts', 'backfill-events.ts'),
        '--data-root',
        root,
        '--json',
        '--backfill-counts',
      ],
      { encoding: 'utf8' },
    );
    const report = JSON.parse(raw) as {
      mode: string;
      created: { events: number; records: number };
      reason_stats: Record<string, number>;
      segments: { records: number; closed_reason: string | null }[];
    };

    assert.equal(report.mode, 'dry-run', '默认是试运行');
    assert.equal(report.created.events, fixture.segment_count, '段数与冻结夹具一致');
    assert.equal(report.created.records, 247, '覆盖记录数与夹具一致（247 条）');
    assert.equal(
      report.reason_stats['task-closure'] ?? 0,
      0,
      '零 task-closure（信号 dormant）—— 这正是评审看到 14 的那个计数',
    );
    assert.equal(report.reason_stats['silence'] ?? 0, 8, '全部按静默闭合');

    // 逐段指针数与夹具一致。
    assert.deepEqual(
      report.segments.map((segment) => segment.records),
      fixture.segments.map((segment) => segment.pointers.length),
      '逐段指针数与冻结夹具一致',
    );
  } finally {
    cleanupTempRoot(root);
  }
});
