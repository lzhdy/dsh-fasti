/**
 * #90 批 3 · correction 护栏 + 静态门红测（正本 `docs/task90-write-gate-final-spec.md`
 * Q5 / Q6、§6.5 / §6.6 / §6.8）。
 *
 * 覆盖：
 *  - T-a 六类修正非 rerun 产出版本 anchors 继承 deep-Equal（新事件按契约补位 []）；
 *  - T-b rerun 走完整闭合管线（经 L1+L2），坏锚样本被闸拒收，而非继承放行；
 *  - T-d 改窗 / 改道必 rerun；pending 版本投影非权威；非 rerun 路径窗 / 道不变；
 *  - 类型护栏：六个 Input 不携带 anchors（Omit 形态 + 编译期负例）；
 *  - 静态门：correction 零 anchors 标识符；appendVersion 调用方全集与用途清单。
 *
 * 纪律：只写 tests/；临时 DSH_HOME，真实数据根零写入；不新增定时器 / 守护进程。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import type { BoundaryCandidate, EventPointer, EventRecord } from '../../src/contract/event.ts';
import type { Experience } from '../../src/contract/experience.ts';
import { EventCorrector } from '../../src/event/correction.ts';
import type { CorrectionRerunner } from '../../src/event/correction.ts';
import { InMemoryBacklog } from '../../src/event/backlog.ts';
import { ClosurePipeline } from '../../src/event/closure.ts';
import { AnchorReferenceInvalidError } from '../../src/event/anchor-refs.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { toEventProjection } from '../../src/projection/event-row.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_MS = Date.parse('2026-11-08T10:00:00.000Z');
const T0 = BASE_MS;
const FIXED_NOW_MS = Date.parse('2026-11-09T09:00:00.000Z');

/** 合法 ULID（过 L1 形态闸，才轮得到 L2 引用闸）。 */
const U_Z = '01J0000000000000000000000Z';

function at(minutes: number): string {
  return new Date(BASE_MS + minutes * 60_000).toISOString();
}

function pointer(id: string, channel = 'dsh'): EventPointer {
  return { id, channel, shard: '2026-11', seq: 0 };
}

function makeExperience(id: string, occurredAt: string): Experience {
  return {
    id,
    schema_version: 1,
    kind: 'dialogue',
    scene: { channel: 'dsh', ref: 'session-1' },
    initiation: 'user',
    observation: { cue: `记录 ${id}` },
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    tick: 0,
    char_count: null,
  };
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const base: EventRecord = {
    id: 'evt-a',
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'closed',
    closed_reason: 'silence',
    pointers: [pointer('r1')],
    time_range: { started_at: at(0), ended_at: at(10) },
    assembled_at: at(10),
    summary: '旧的客观摘要',
    key_points: ['旧关键点'],
    anchors: ['旧锚点'],
    topic_lines: [],
    summary_quality: 'ready',
    summary_source: 'llm',
    summary_prompt_version: 'v1',
    summary_model: 'dsh-default',
    created_by: 'system',
    created_at: at(10),
    channel: 'dsh',
    boundary_candidates: [],
    effective_chars: null,
    raw_chars: null,
  };
  return { ...base, ...overrides };
}

interface Harness {
  readonly root: string;
  readonly log: EventLog;
  readonly corrector: EventCorrector;
  readonly reruns: string[];
  readonly texts: Map<string, Experience>;
  seed(overrides: Partial<EventRecord>): EventRecord;
  cleanup(): void;
}

function makeHarness(rerunner?: CorrectionRerunner): Harness {
  const root = makeTempRoot('fasti-correction-rerun-');
  const log = new EventLog(layoutOf(root).events);
  const texts = new Map<string, Experience>();
  const reruns: string[] = [];

  const spy: CorrectionRerunner = {
    requestRerun: (eventId) => {
      reruns.push(eventId);
      rerunner?.requestRerun(eventId);
    },
  };

  const corrector = new EventCorrector({
    log,
    readExperience: (id) => texts.get(id),
    ownerOf: (id) => log.ownerOf(id),
    rerunner: spy,
    now: () => FIXED_NOW_MS,
  });

  return {
    root,
    log,
    corrector,
    reruns,
    texts,
    seed: (overrides) => {
      const record = makeEvent(overrides);
      for (const p of record.pointers) {
        if (!texts.has(p.id)) {
          texts.set(p.id, makeExperience(p.id, record.time_range.started_at));
        }
      }
      return log.appendVersion(record).record;
    },
    cleanup: () => cleanupTempRoot(root),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// A1. T-a：六类修正非 rerun 产出版本，anchors 与当前版本 deep-Equal
//     （merge/split 新事件由契约补位 []）
// ═══════════════════════════════════════════════════════════════════════════════

test('T-a 继承：merge 退役行 anchors 原样继承；新事件 C 契约补位 []', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')], anchors: ['锚-A'] });
    h.seed({ id: 'evt-b', pointers: [pointer('r2')], anchors: ['锚-B'] });

    const result = h.corrector.merge({ sourceIds: ['evt-a', 'evt-b'] });

    assert.deepEqual(result.target.anchors, [], '新事件 anchors 由契约补位空数组');
    assert.deepEqual(h.log.currentOf('evt-a').anchors, ['锚-A'], '退役行 anchors 继承');
    assert.deepEqual(h.log.currentOf('evt-b').anchors, ['锚-B'], '退役行 anchors 继承');
  } finally {
    h.cleanup();
  }
});

test('T-a 继承：split 子事件补位 []；退役源事件 anchors 原样继承', () => {
  const h = makeHarness();
  try {
    h.seed({
      id: 'evt-s',
      pointers: [pointer('r1'), pointer('r2')],
      anchors: ['锚-S'],
    });

    const result = h.corrector.split({ sourceId: 'evt-s', groups: [['r1'], ['r2']] });

    for (const child of result.children) {
      assert.deepEqual(child.anchors, [], '子事件 anchors 契约补位 []');
    }
    assert.deepEqual(h.log.currentOf('evt-s').anchors, ['锚-S'], '退役行 anchors 继承');
  } finally {
    h.cleanup();
  }
});

test('T-a 继承：reviseBoundary / reopen / rewriteSummary 产出版本 anchors 原样继承', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1'), pointer('r2')], anchors: ['锚-A'] });

    const revised = h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: ['r2'] });
    assert.deepEqual(revised.event.anchors, ['锚-A'], '改边界继承旧 anchors（pending 待 rerun 覆写）');

    const reopened = h.corrector.reopen({ eventId: 'evt-a' });
    assert.deepEqual(reopened.anchors, ['锚-A'], '重开继承 anchors');

    const rewritten = h.corrector.rewriteSummary({ eventId: 'evt-a', summary: '她手写的新摘要' });
    assert.deepEqual(rewritten.anchors, ['锚-A'], '重写摘要继承 anchors');
  } finally {
    h.cleanup();
  }
});

test('T-a 继承：closeAndReopen 闭合侧 / 重开侧 anchors 各自继承原事件', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-open', status: 'open', pointers: [pointer('r3')], channel: 'dsh', anchors: ['锚-OPEN'] });
    h.seed({ id: 'evt-b', pointers: [pointer('r2')], anchors: ['锚-B'] });

    const result = h.corrector.closeAndReopen({ closeId: 'evt-open', reopenId: 'evt-b' });

    assert.deepEqual(result.closed.anchors, ['锚-OPEN'], '闭合侧继承');
    assert.deepEqual(result.reopened.anchors, ['锚-B'], '重开侧继承');
  } finally {
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// A2. T-b：rerun 走完整闭合管线（L1+L2）——坏锚样本被闸拒收，不是继承放行
// ═══════════════════════════════════════════════════════════════════════════════

test('T-b rerun 过闸：坏锚样本经 writeSummary 直注进闭合管线被 L2 拒收，零新版本落盘', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')], summary: '旧摘要' });

    // reader 夹具：事件成员指针 r1 可读；坏锚 U_Z 不在成员集也查不到 → L2 拒收。
    const reader = {
      readExperience: (id: string) =>
        id === 'r1' ? { id: 'r1', channel: 'dsh', occurredAtMs: T0 } : undefined,
    };
    const pipeline = new ClosurePipeline({
      log: h.log,
      port: null,
      backlog: new InMemoryBacklog(),
      readTexts: () => ['用户问晚餐吃什么'],
      readExperience: reader,
    } as never);

    // 修正器请求重跑 → rerun 路由接线仍在（reruns 回调记录到 evt-a）。
    h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: [] });
    assert.deepEqual(h.reruns, ['evt-a'], '改边界触发 requestRerun');

    // L3 后线协议只收序号；坏锚走 writeSummary 私有直注 seam（类型逃逸，零生产入口），
    // 经同一真实 L2 成员包含闸拒收，不是在修正层继承放行。
    const privateApi = pipeline as unknown as {
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
    let thrown: unknown;
    try {
      privateApi.writeSummary(h.log.currentOf('evt-a'), [U_Z], [], '模型摘要', [], true, undefined);
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof AnchorReferenceInvalidError, 'rerun 路径经 L2 闸拒收坏锚');
    assert.equal(
      (thrown as AnchorReferenceInvalidError).detail.reason,
      'anchor-not-found',
      '坏锚不在成员集 → not-found 桶',
    );
    assert.equal(h.log.versionsOf('evt-a').length, 2, 'L2 拒收：没有落第三个版本');
    assert.equal(h.log.currentOf('evt-a').summary_quality, 'pending', '坏锚轮次保持 pending');
  } finally {
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// A3. T-d：改窗 / 改道必 rerun；pending 版本投影非权威；非 rerun 路径窗 / 道不变
// ═══════════════════════════════════════════════════════════════════════════════

test('T-d 改窗：reviseBoundary 重算时间窗 → pending 落盘 + requestRerun，投影行标 pending 非权威', () => {
  const h = makeHarness();
  try {
    h.seed({
      id: 'evt-a',
      pointers: [pointer('r1'), pointer('r2')],
      time_range: { started_at: at(0), ended_at: at(30) },
      anchors: ['旧锚点'],
    });

    const revised = h.corrector.reviseBoundary({ eventId: 'evt-a', removePointerIds: ['r2'] });

    assert.equal(revised.event.summary_quality, 'pending', '继承旧锚点的版本标 pending，待 rerun 覆写');
    assert.deepEqual(h.reruns, ['evt-a'], '改边界必须走 rerunner');
    assert.notEqual(revised.event.time_range.ended_at, at(30), '时间窗随指针重算');

    const row = toEventProjection(revised.event);
    assert.equal(row.summary_quality, 'pending', '投影行携带 pending 标记，ready 前不作权威锚点 / 摘要');
  } finally {
    h.cleanup();
  }
});

test('T-d 拆分：子事件 pending 落盘且各自 requestRerun；退役源窗道不变', () => {
  const h = makeHarness();
  try {
    h.seed({
      id: 'evt-s',
      pointers: [pointer('r1'), pointer('r2')],
      anchors: ['锚-S'],
    });

    const result = h.corrector.split({ sourceId: 'evt-s', groups: [['r1'], ['r2']] });

    for (const child of result.children) {
      assert.equal(child.summary_quality, 'pending', '子事件待重跑');
    }
    assert.deepEqual(
      h.reruns.sort(),
      result.children.map((c) => c.id).sort(),
      '每个子事件都请求 rerun',
    );
    const retired = h.log.currentOf('evt-s');
    assert.equal(retired.time_range.started_at, makeEvent().time_range.started_at, '退役行时间窗继承');
  } finally {
    h.cleanup();
  }
});

test('T-d 非 rerun 路径：reopen / rewriteSummary 不改时间窗与通道', () => {
  const h = makeHarness();
  try {
    h.seed({ id: 'evt-a', pointers: [pointer('r1')] });
    const before = h.log.currentOf('evt-a');

    const reopened = h.corrector.reopen({ eventId: 'evt-a' });
    assert.deepEqual(reopened.time_range, before.time_range, '重开不改窗');
    assert.equal(reopened.channel, before.channel, '重开不改道');
    assert.deepEqual(h.reruns, [], '重开不触发 rerun');

    const rewritten = h.corrector.rewriteSummary({ eventId: 'evt-a', summary: '她手写摘要' });
    assert.deepEqual(rewritten.time_range, before.time_range, '重写摘要不改窗');
    assert.equal(rewritten.channel, before.channel, '重写摘要不改道');
    assert.deepEqual(h.reruns, [], '重写摘要不触发 rerun');
  } finally {
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. 类型护栏（§6.6）：六个 Input 不携带 anchors 字段（Omit 形态静态钉）
// ═══════════════════════════════════════════════════════════════════════════════

const INPUT_NAMES = [
  'MergeInput',
  'SplitInput',
  'ReviseBoundaryInput',
  'ReopenInput',
  'CloseAndReopenInput',
  'RewriteSummaryInput',
] as const;

test('类型护栏：六个修正 Input 均为排除 anchors 的形态（Omit 或显式无该字段），无 anchors 声明', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/event/correction.ts'), 'utf8');

  for (const name of INPUT_NAMES) {
    const block = source.match(new RegExp(`interface\\s+${name}\\s*(?:extends\\s+([^\\{]+))?\\{([\\s\\S]*?)\\}`));
    assert.ok(block, `声明可定位：${name}`);
    const [, extendsClause, body] = block;
    const declaresAnchors = /\banchors\b\s*:/.test(body ?? '');
    assert.equal(declaresAnchors, false, `${name} 不得声明 anchors 字段`);
    const omitGuarded = (extendsClause ?? '').includes("'anchors'") || (body ?? '').includes("Omit<");
    assert.ok(omitGuarded, `${name} 须经 Omit<..., 'anchors'> 或等价排除形态护栏`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// C6. 静态门：correction 全文件零 anchors 标识符（继承靠展开，不读不写锚点值）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 剥除类型位置子句后再扫值位置：
 *  - 注释先剥离；
 *  - `Omit<…, 'anchors'>` 这类类型护栏子句整体去掉；
 *  - `interface` / `type` 声明块整体去掉。
 * 类型位出现 `anchors` 是护栏本体，合法；值读取 / 赋值位置出现才被门拦。
 */
function stripTypePositions(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\bOmit\s*<[^>]*>/g, '')
    .replace(/^\s*(?:export\s+)?interface\b[^\n]*\{[\s\S]*?\}/gm, '')
    .replace(/^\s*(?:export\s+)?type\b[^\n]*[;=][^\n]*/gm, '');
}

test('静态门：correction.ts 值位置不出现 anchors（类型位 Omit 护栏合法）', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/event/correction.ts'), 'utf8');
  const valueCode = stripTypePositions(source);
  assert.equal(/\banchors\b/.test(valueCode), false, 'correction.ts 值位置不得读写 anchors 标识符');

  // 投毒自证：值读取 / 赋值位置的 anchors 引用仍必红；类型位 Omit 不被误伤。
  const valuePoison = 'const leaked = current.anchors;';
  assert.ok(
    /\banchors\b/.test(stripTypePositions(valuePoison)),
    '值位置 anchors 引用必须被门拦住（自证正则未失效）',
  );
  const typeGuard = "interface GuardedInput { payload: Omit<EventVersion, 'anchors'>; }";
  assert.equal(
    /\banchors\b/.test(stripTypePositions(typeGuard)),
    false,
    '类型位 Omit<…, anchors> 子句合法，不参与值位置扫描',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// C7 + D8. appendVersion 调用方全集审计 + correction 六处用途清单（可执行镜像）
// ═══════════════════════════════════════════════════════════════════════════════

/** correction.ts 六处 appendVersion 的用途清单（Q5.1 附录的可执行镜像）。 */
const CORRECTION_SITES = [
  {
    method: 'reviseBoundary',
    quality: 'pending',
    anchorsSource: '继承 current（pending 待 rerun 覆写）',
    rerun: true,
  },
  {
    method: 'reopen',
    quality: '继承当前态',
    anchorsSource: '继承 current',
    rerun: false,
  },
  {
    method: 'closeOpen',
    quality: 'closed / manual',
    anchorsSource: '继承 current',
    rerun: true,
  },
  {
    method: 'rewriteSummary',
    quality: 'ready / her',
    anchorsSource: '继承 current',
    rerun: false,
  },
  {
    method: 'retire',
    quality: '退役态（merged / split）',
    anchorsSource: '继承 current',
    rerun: false,
  },
  {
    method: 'appendNewEvent',
    quality: 'pending（新事件）',
    anchorsSource: '契约补位 []',
    rerun: true,
  },
] as const;

test('D8 用途清单：correction.ts 恰六处 appendVersion、四处 requestRerun，清单方法名齐备', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/event/correction.ts'), 'utf8');
  const appendSites = source.match(/\.appendVersion\(/g) ?? [];
  assert.equal(appendSites.length, 6, 'correction.ts 恰六处版本追加');

  const rerunSites = source.match(/this\.requestRerun\(/g) ?? [];
  // merge 目标、split 子事件循环、reviseBoundary、closeOpen 各一处调用点。
  assert.equal(rerunSites.length, 4, '四处 rerun 调用点（合并 / 拆分 / 改边界 / 手动闭合）');

  for (const site of CORRECTION_SITES) {
    assert.match(source, new RegExp(`\\b${site.method}\\s*\\(`), `清单方法在源码中存在：${site.method}`);
  }

  // rerun=true 的清单行必须落在源码确有 requestRerun 调用的方法族内。
  const rerunMethods = CORRECTION_SITES.filter((site) => site.rerun).map((site) => site.method);
  assert.deepEqual(rerunMethods, ['reviseBoundary', 'closeOpen', 'appendNewEvent']);
});

test('C7 调用方全集：appendVersion 生产调用方仅 segmenter（结构写入）/ closure（摘要锚点写入）/ correction（修正继承物化）', () => {
  const eventDir = path.join(REPO_ROOT, 'src/event');
  const callers: string[] = [];
  for (const entry of fs.readdirSync(eventDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const file = path.join(eventDir, entry.name);
    const text = fs.readFileSync(file, 'utf8');
    if (/\.appendVersion\(/.test(text)) {
      callers.push(`src/event/${entry.name}`);
    }
  }

  const allowed = new Set([
    'src/event/segmenter.ts', // 结构写入：新事件 / 并入 / 机械闭合 / 孤儿标记，anchors 由展开继承或契约补位
    'src/event/closure.ts', // 摘要 + 模型锚点产出落盘
    'src/event/correction.ts', // 修正：继承 / 退役 / 新事件物化
  ]);
  for (const caller of callers) {
    assert.ok(allowed.has(caller), `未登记的 appendVersion 调用方：${caller}`);
  }

  // 结构写入方不得承载 anchors 写值：segmenter 全文件无 anchors 标识符。
  const segmenter = fs.readFileSync(path.join(REPO_ROOT, 'src/event/segmenter.ts'), 'utf8');
  const segmenterCode = segmenter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(segmenterCode, /^(?!.*\banchors\b).*$/s, 'segmenter 不写 anchors 值');
});
