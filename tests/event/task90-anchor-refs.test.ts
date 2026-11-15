/**
 * #90 批 A · L2 引用完整性闸红测（正本 `docs/task90-write-gate-final-spec.md` §2 / §5 / §6.1-6.2/6.8）。
 *
 * 头条口径（不能漂移）：L2 主判据是**成员包含性** ——
 * `anchors ⊆ current.pointers 成员 id 集`，且每个 id 经 reader 点查存在；
 * 同通道 / 闭区间三条件降级为只读诊断分桶 + 管线不变式测试，生产闸运行期不解析时间。
 *
 * 被测 seam（模块尚不存在，ERR_MODULE_NOT_FOUND 属预期红，写者同批内红→绿）：
 *  - `src/event/anchor-refs.ts`：`assertAnchorRefs(anchors, memberIds, reader)` 纯函数核心；
 *  - 诊断辅助 `classifyAnchorFailure(...)`；`AnchorReferenceInvalidError extends SchemaError`。
 *
 * 纪律：只写 tests/，绝不改 src/；reader 用 Map 构造的同步窄接口；无真实数据根写入。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CorruptedError, SchemaError } from '../../src/core/errors.ts';
import { ExperienceLog } from '../../src/source/experience-log.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = Date.parse('2026-11-08T02:13:20.000Z');
const DAY = 24 * 3600 * 1000;

// ── 窄接口形状（§4 Q4：单方法、同步、只回 id/channel/时间，不含正文）─────────────

/** reader 回传的经历引用面；刻意不含 cue/raw_text/summary 等正文字段。 */
interface ReaderRef {
  readonly id: string;
  readonly channel: string;
  readonly occurredAtMs: number;
}

interface Reader {
  readonly readExperience: (id: string) => ReaderRef | undefined;
}

/** §5.2 冻结 reason 词表（与 #42 同词表，anchor- 前缀）。 */
type AnchorReferenceReason =
  | 'anchor-duplicate'
  | 'anchor-not-found'
  | 'anchor-cross-channel'
  | 'anchor-out-of-window'
  | 'anchor-not-in-event'
  | 'experience-store-broken';

/** 结构化失败明细（§3 Q3）：零经历正文 / 零摘要正文。 */
interface AnchorReferenceDetail {
  readonly reason: AnchorReferenceReason;
  readonly anchor: string;
  readonly expected: string;
  readonly actual: string;
  readonly channel?: string;
  readonly window?: { readonly startedMs: number; readonly endedMs: number };
  readonly deltaMs?: number;
  readonly note?: string;
}

type InvalidErrorCtor = new (
  message: string,
  options?: { cause?: unknown },
) => { readonly detail: AnchorReferenceDetail; readonly message: string };

/** 诊断分桶所需的事件侧上下文；主谓词（成员包含性）不依赖它做放行判定。 */
interface EventContext {
  readonly channel: string;
  readonly startedMs: number;
  readonly endedMs: number;
}

interface AnchorRefsModule {
  readonly AnchorReferenceInvalidError: InvalidErrorCtor;
  readonly assertAnchorRefs: (
    anchors: readonly string[],
    memberIds: ReadonlySet<string>,
    reader: Reader,
    context?: EventContext,
  ) => void;
  readonly classifyAnchorFailure: (
    anchor: string,
    ref: ReaderRef | undefined,
    context: { readonly channel: string; readonly startedAt: string; readonly endedAt: string },
  ) => AnchorReferenceDetail;
}

const MODULE_URL = new URL('../../src/event/anchor-refs.ts', import.meta.url);

async function loadAnchorRefs(): Promise<AnchorRefsModule> {
  // URL 动态导入：seam 未落地时在调用点红，不连坐类型检查（沿用 #42 镜像惯例）。
  return (await import(MODULE_URL.href)) as unknown as AnchorRefsModule;
}

// ── 夹具 ──────────────────────────────────────────────────────────────────────

const A = '01J0000000000000000000000A';
const B = '01J0000000000000000000000B';
const C = '01J0000000000000000000000C';
const Z = '01J0000000000000000000000Z';

function ref(id: string, channel: string, occurredAtMs: number): ReaderRef {
  return { id, channel, occurredAtMs };
}

function readerOf(entries: Readonly<Record<string, ReaderRef>>): Reader {
  return { readExperience: (id) => entries[id] ?? undefined };
}

/** 事件通道 + 闭区间上下文（仅供诊断分桶，不参与主谓词放行）。 */
const CONTEXT: EventContext = { channel: 'dsh', startedMs: T0, endedMs: T0 + DAY };

function captureThrow(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function detailOf(error: unknown): AnchorReferenceDetail {
  return (error as { detail: AnchorReferenceDetail }).detail;
}

/** 经历正文秘密串：detail 序列化里绝不得出现（零正文断言夹具）。 */
const SECRET_BODY = 'SECRET-CUE-正文明文-7f3a9c21';

// ═══════════════════════════════════════════════════════════════════════════
// A. 纯函数表驱动（§6.1）
// ═══════════════════════════════════════════════════════════════════════════

test('L2 闸：合法成员锚点全部通过（成员包含性主谓词）', async () => {
  const mod = await loadAnchorRefs();
  const memberIds = new Set([A, B]);
  const reader = readerOf({
    [A]: ref(A, 'dsh', T0),
    [B]: ref(B, 'dsh', T0 + DAY),
  });
  assert.doesNotThrow(() => mod.assertAnchorRefs([A, B], memberIds, reader, CONTEXT));
});

test('L2 闸：空锚 [] 合法放行（#42 abstain 口径不变）', async () => {
  const mod = await loadAnchorRefs();
  const reader = readerOf({});
  assert.doesNotThrow(() => mod.assertAnchorRefs([], new Set<string>(), reader));
});

test('L2 闸：重复 ULID → anchor-duplicate 显式拒收，不去重', async () => {
  const mod = await loadAnchorRefs();
  const memberIds = new Set([A]);
  const reader = readerOf({ [A]: ref(A, 'dsh', T0) });
  const error = captureThrow(() => mod.assertAnchorRefs([A, A], memberIds, reader, CONTEXT));
  assert.ok(error instanceof SchemaError, '重复锚点须抛 SchemaError 子类');
  const detail = detailOf(error);
  assert.equal(detail.reason, 'anchor-duplicate');
  assert.equal(detail.anchor, A, '明细须指向重复的那个锚点');
});

test('L2 闸：reader 返 undefined → anchor-not-found', async () => {
  const mod = await loadAnchorRefs();
  const reader = readerOf({});
  const error = captureThrow(() => mod.assertAnchorRefs([Z], new Set<string>(), reader));
  assert.ok(error instanceof SchemaError);
  const detail = detailOf(error);
  assert.equal(detail.reason, 'anchor-not-found');
  assert.equal(detail.anchor, Z);
});

test('L2 闸：存在但 channel 不同 → anchor-cross-channel（诊断桶，不推翻拒收）', async () => {
  const mod = await loadAnchorRefs();
  const reader = readerOf({ [B]: ref(B, 'web', T0) });
  const error = captureThrow(() => mod.assertAnchorRefs([B], new Set([A]), reader, CONTEXT));
  assert.ok(error instanceof SchemaError);
  const detail = detailOf(error);
  assert.equal(detail.reason, 'anchor-cross-channel');
  assert.equal(detail.channel, 'web');
});

test('L2 闸：存在、同通道但不在闭区间 → anchor-out-of-window', async () => {
  const mod = await loadAnchorRefs();
  const reader = readerOf({ [A]: ref(A, 'dsh', T0 + 2 * DAY) });
  const error = captureThrow(() => mod.assertAnchorRefs([A], new Set<string>(), reader, CONTEXT));
  assert.ok(error instanceof SchemaError);
  const detail = detailOf(error);
  assert.equal(detail.reason, 'anchor-out-of-window');
  assert.ok(detail.window !== undefined, '诊断桶须带事件时间窗');
  assert.equal(detail.window.startedMs, T0);
  assert.equal(detail.window.endedMs, T0 + DAY);
});

test('L2 闸：存在、同通道、在窗内但不在成员集 → anchor-not-in-event（兜底桶）', async () => {
  const mod = await loadAnchorRefs();
  const reader = readerOf({ [B]: ref(B, 'dsh', T0 + DAY) });
  const error = captureThrow(() => mod.assertAnchorRefs([B], new Set([A]), reader, CONTEXT));
  assert.ok(error instanceof SchemaError);
  const detail = detailOf(error);
  assert.equal(detail.reason, 'anchor-not-in-event');
  assert.equal(detail.anchor, B);
});

test('L2 闸：reader 抛 CorruptedError → experience-store-broken 原样上抛，禁吞成 not-found', async () => {
  const mod = await loadAnchorRefs();
  const brokenReader: Reader = {
    readExperience: () => {
      throw new CorruptedError('experience log corrupted');
    },
  };
  const error = captureThrow(() => mod.assertAnchorRefs([A], new Set([A]), brokenReader));
  assert.ok(error instanceof CorruptedError, '基础设施错误须原样上抛 CorruptedError');
  assert.ok(
    !(error instanceof mod.AnchorReferenceInvalidError),
    '损坏不得被归类为 anchor 类 SchemaError',
  );
  assert.ok(!/not-found/i.test(String(error)), '不得吞成 anchor-not-found');
});

test('L2 闸：拒收错误类为 AnchorReferenceInvalidError extends SchemaError', async () => {
  const mod = await loadAnchorRefs();
  const reader = readerOf({});
  const error = captureThrow(() => mod.assertAnchorRefs([Z], new Set<string>(), reader));
  assert.ok(error instanceof mod.AnchorReferenceInvalidError, '须为闸内错误类实例');
  assert.ok(error instanceof SchemaError, '基类为 SchemaError（可重试标记）');
});

test('L2 闸：detail 结构化字段精确，且零经历正文 / 零摘要正文', async () => {
  const mod = await loadAnchorRefs();
  const reader = readerOf({ [B]: ref(B, 'web', T0) });
  const error = captureThrow(() => mod.assertAnchorRefs([B], new Set([A]), reader, CONTEXT));
  const detail = detailOf(error);

  // 必备四件套；expected/actual 为字符串（不回裸正文）。
  for (const key of ['reason', 'anchor', 'expected', 'actual'] as const) {
    assert.equal(typeof detail[key], 'string', `detail.${key} 须为字符串`);
  }
  // 可选桶字段只允许在冻结清单内。
  const allowed = new Set(['reason', 'anchor', 'expected', 'actual', 'channel', 'window', 'deltaMs', 'note']);
  for (const key of Object.keys(detail)) {
    assert.ok(allowed.has(key), `detail 出现未登记字段：${key}`);
  }

  // 零正文：秘密串不得进序列化明细；明细键不得出现正文/摘要载体。
  const serialized = JSON.stringify(detail);
  assert.ok(!serialized.includes(SECRET_BODY), 'detail 不得泄漏经历正文秘密串');
  for (const bodyKey of ['raw_text', 'body', 'summary', 'cue', 'key_points']) {
    assert.ok(!(bodyKey in detail), `detail 不得携带正文字段：${bodyKey}`);
  }
});

test('诊断分桶：坏时间串打 time-unparseable 标记，禁止 NaN 巧合比较放行', async () => {
  const mod = await loadAnchorRefs();
  const detail = mod.classifyAnchorFailure(
    C,
    ref(C, 'dsh', T0),
    { channel: 'dsh', startedAt: 'not-an-iso', endedAt: '2026-11-08T03:00:00.000Z' },
  );
  assert.match(detail.note ?? '', /time-unparseable/, '时间解析失败须显式标记，不折算 NaN');
  if (detail.deltaMs !== undefined) {
    assert.ok(Number.isFinite(detail.deltaMs), 'deltaMs 不得为 NaN/Infinity');
  }
  if (detail.window !== undefined) {
    assert.ok(Number.isFinite(detail.window.startedMs) && Number.isFinite(detail.window.endedMs));
  }
});

test('诊断桶不能推翻主谓词拒收：分桶结果存在时主函数仍 throw', async () => {
  const mod = await loadAnchorRefs();
  const reader = readerOf({ [B]: ref(B, 'dsh', T0 + DAY) });
  const bucket = mod.classifyAnchorFailure(B, reader.readExperience(B), {
    channel: 'dsh',
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + DAY).toISOString(),
  });
  assert.ok(bucket.reason.length > 0, '诊断须给出分桶结果');
  // 兜底桶不改变 fail-closed 结论：主闸仍拒收。
  assert.throws(() => mod.assertAnchorRefs([B], new Set([A]), reader, CONTEXT));
});

// ═══════════════════════════════════════════════════════════════════════════
// B. 分区不变式（§6.2，合成语料，非生产闸）
// ═══════════════════════════════════════════════════════════════════════════

test('分区不变式：窗口池 ≡ 事件 pointers 成员集 ≡ readTexts 输入 id 集（三方等价）', async () => {
  await loadAnchorRefs(); // seam 存在性先钉；不变式本身不依赖生产闸函数
  const corpus: ReaderRef[] = [
    ref(A, 'dsh', T0),
    ref(B, 'dsh', T0 + DAY),
    ref(C, 'web', T0), // 异通道，必须在池外
  ];
  const memberIds = new Set([A, B]);
  const channel = 'dsh';
  const startedMs = T0;
  const endedMs = T0 + DAY;
  const pointers = [{ id: A }, { id: B }];

  // 窗口池：同通道 + 闭区间（不变式测试口径，非运行期主谓词）。
  const pool = new Set(
    corpus
      .filter((e) => e.channel === channel && e.occurredAtMs >= startedMs && e.occurredAtMs <= endedMs)
      .map((e) => e.id),
  );
  // readTexts 输入 id 集：逐条 pointer 点查，取不到的跳过（对齐 textsOfEvent 口径）。
  const log = new Map(corpus.map((e) => [e.id, e]));
  const textIds = new Set(pointers.map((p) => p.id).filter((id) => log.has(id)));

  assert.deepEqual([...pool].sort(), [...memberIds].sort(), '窗口池 ≡ 成员集');
  assert.deepEqual([...textIds].sort(), [...memberIds].sort(), 'readTexts 输入集 ≡ 成员集');
});

/** 合成一条最小经历（结构层 ExperienceLog 可 append）。 */
function fixtureExperience(id: string, channel: string, occurredAtMs: number, tick: number) {
  const iso = new Date(occurredAtMs).toISOString();
  return {
    id,
    schema_version: 1,
    kind: 'dialogue',
    scene: { channel, ref: 'session-1' },
    initiation: 'user',
    observation: { cue: `线索 ${id}` },
    occurred_at: iso,
    recorded_at: iso,
    tick,
    char_count: null,
  };
}

test('分区不变式：真实 ExperienceLog 生产者链路闭环 —— pool ≡ 成员集 ≡ readTexts 输入 id 集', async () => {
  await loadAnchorRefs(); // seam 存在性先钉；不变式走真实结构层，不依赖闸函数
  const root = makeTempRoot();
  try {
    // 真实结构层：A/B 同通道在窗内，C 异通道落池外。
    const log = new ExperienceLog(path.join(root, 'experiences'));
    log.append(fixtureExperience(A, 'dsh', T0, 1));
    log.append(fixtureExperience(B, 'dsh', T0 + DAY, 2));
    log.append(fixtureExperience(C, 'web', T0, 3));

    const eventPointers = [{ id: A }, { id: B }];
    const memberIds = new Set([A, B]);

    // 生产 readTexts 注入路径口径（api/index.ts textsOfEvent）：逐条 pointer 点查
    // experienceLog，取不到的跳过；输入 id 集即点查命中的指针 id。
    const textIds = new Set(eventPointers.map((p) => p.id).filter((id) => log.has(id)));

    // 窗口池：同通道 + 闭区间（不变式测试口径，非运行期主谓词）。
    const pool = new Set(
      log
        .readAll()
        .filter(
          (e) =>
            e.scene.channel === 'dsh' &&
            Date.parse(e.occurred_at) >= T0 &&
            Date.parse(e.occurred_at) <= T0 + DAY,
        )
        .map((e) => e.id),
    );

    assert.deepEqual([...pool].sort(), [...memberIds].sort(), '真实结构层窗口池 ≡ 成员集');
    assert.deepEqual([...textIds].sort(), [...memberIds].sort(), '真实 readTexts 输入集 ≡ 成员集');
  } finally {
    cleanupTempRoot(root);
  }
});

test('分区不变式：窗内非成员样本必须被主谓词拒收（成员谓词比窗口池谓词更严、fail-safe）', async () => {
  const mod = await loadAnchorRefs();
  // B 同通道、在窗内，但不属于本事件 pointers（分段器被改坏时的假阳性样本）。
  const reader = readerOf({ [B]: ref(B, 'dsh', T0 + DAY) });
  const error = captureThrow(() => mod.assertAnchorRefs([B], new Set([A]), reader, CONTEXT));
  assert.ok(error instanceof SchemaError, '窗内非成员不得被窗口池谓词误放行');
  const detail = detailOf(error);
  assert.equal(detail.reason, 'anchor-not-in-event');
});

// ═══════════════════════════════════════════════════════════════════════════
// C. 静态投毒（§6.8）：闸模块禁 node:fs / ExperienceLog / readAll。
// ═══════════════════════════════════════════════════════════════════════════

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.split('//')[0] ?? '')
    .join('\n');
}

function forbiddenHits(code: string): string[] {
  const hits: string[] = [];
  if (/from\s+['"]node:fs['"]/.test(code)) hits.push('node:fs');
  if (/\bExperienceLog\b/.test(code)) hits.push('ExperienceLog');
  if (/\breadAll\b/.test(code)) hits.push('readAll');
  return hits;
}

test('静态投毒：anchor-refs.ts 禁 node:fs / ExperienceLog / readAll 标识符', () => {
  const file = path.join(REPO_ROOT, 'src', 'event', 'anchor-refs.ts');
  if (fs.existsSync(file)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(forbiddenHits(code), [], '闸模块纯函数核心不得持文件面/真源日志/全量枚举');
  }
  // 投毒自证：同一谓词对合成坏码必须标红（证明门真能拦，不是恰好为空）。
  const poison = [
    "import fs from 'node:fs';",
    "import { ExperienceLog } from '../source/experience-log.ts';",
    'const all = log.readAll();',
  ].join('\n');
  assert.deepEqual(forbiddenHits(poison).sort(), ['ExperienceLog', 'node:fs', 'readAll'].sort());
});
