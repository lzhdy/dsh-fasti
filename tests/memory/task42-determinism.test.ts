/**
 * #42 · B0 第二批：确定性契约红测（正本 §3.5、§4.2 R-02/R-16；X-01 card_id 公式钉死）。
 *
 * 主控裁决口径（EventRecord 无逐版本 ULID）：
 *  - 版本身份复合键 versionToken = `${event_id}#v${version}`；
 *  - `at_ms = isoToMs(version.created_at)`，不取注入墙钟 / Date.now()；
 *  - decision_id 内容派生：时间段取该毫秒的 48 位 ULID 时间，随机段取去重键 sha256 切片。
 *
 * 被测目标模块（写者落地，B0）：`src/memory/decision.ts` —— 决策台账行的纯铸造层，
 * 零 IO、零墙钟读取、零随机；事件折叠用既有 `foldCurrentEvents`，期望态用既有 `deriveExpectedProjection`。
 *
 * 边界说明：IO 级「两个独立临时投影各跑一次、decisions.jsonl 逐行相等」依赖 B2 drain 编排，
 * 本批只钉纯铸造双跑相等（同一输入两次独立铸造，口径字段逐行相等）；不造 drain、不开运行期写路径。
 *
 * 纪律：本文件只写测试，绝不改 src/；确定性夹具固定时间戳，不用 Date.now() 抖动。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EventRecord } from '../../src/contract/event.ts';
import { isoToMs } from '../../src/core/time.ts';
import { isUlid, ulidTimestampMs } from '../../src/core/ulid.ts';
import { deriveCardId } from '../../src/memory/content-hash.ts';
import { deriveExpectedProjection } from '../../src/memory/derive.ts';
import { foldCurrentEvents } from '../../src/projection/event-row.ts';

// ── 决策铸造模块契约镜像（运行时动态加载，避免悬空静态 import）─────────────────

type DecisionAction =
  | 'create-card'
  | 'update-cues'
  | 'tombstone-card'
  | 'add-alias'
  | 'invalidate';

interface DecisionCasterInput {
  readonly eventId: string;
  readonly version: number;
  readonly createdAtIso: string;
  readonly action: DecisionAction;
  readonly cardId: string | null;
  readonly anchors: readonly string[];
  readonly contentHash: string;
  readonly modelTag: string;
  readonly reason: string;
  /** 去重键：同真源同语义决策的内容身份（动作 + 目标 + 锚点快照等）。 */
  readonly dedupKey: string;
}

interface DeterministicDecision {
  readonly decision_id: string;
  readonly at_ms: number;
  readonly action: DecisionAction;
  readonly card_id: string | null;
  readonly event_id: string;
  readonly anchor_json: string;
  readonly content_hash: string;
  readonly model_tag: string;
  readonly reason: string;
  readonly created_by: 'her';
}

interface DecisionModule {
  /** 版本时间毫秒：`isoToMs(created_at)`，纯换算，不读墙钟。 */
  decisionAtMs: (createdAtIso: string) => number;
  /** 内容派生 ULID：时间段 = 版本时间 48 位；随机段 = 去重键 sha256 切片。 */
  deriveDecisionId: (input: {
    eventId: string;
    version: number;
    createdAtIso: string;
    dedupKey: string;
  }) => string;
  /** 铸造一条确定性决策台账行。 */
  castDecision: (input: DecisionCasterInput) => DeterministicDecision;
}

const DECISION_URL = new URL('../../src/memory/decision.ts', import.meta.url);

async function loadDecision(): Promise<DecisionModule> {
  const mod = (await import(DECISION_URL.href)) as Partial<DecisionModule>;
  assert.equal(typeof mod.decisionAtMs, 'function', 'decision.ts 须导出 decisionAtMs（§3.5 版本时间口径）');
  assert.equal(typeof mod.deriveDecisionId, 'function', 'decision.ts 须导出 deriveDecisionId（内容派生 ULID）');
  assert.equal(typeof mod.castDecision, 'function', 'decision.ts 须导出 castDecision（纯铸造决策行）');
  return mod as DecisionModule;
}

// ── 确定性夹具 ──────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-11-08T10:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

const ANCHOR_A = '01J0000000000000000000000A';
const ANCHOR_B = '01J0000000000000000000000B';

const EVENT_ID = 'evt-dec-1';
const VERSION = 1;
const CREATED_AT = iso(T0 + DAY);
/** 注入的「墙钟」参照值：决策 at_ms 必须不等于它。 */
const INJECTED_WALL_CLOCK = T0 + 777;

function baseInput(overrides: Partial<DecisionCasterInput> = {}): DecisionCasterInput {
  return {
    eventId: EVENT_ID,
    version: VERSION,
    createdAtIso: CREATED_AT,
    action: 'create-card',
    cardId: null,
    anchors: [ANCHOR_A],
    contentHash: 'hash-1',
    modelTag: 'rules-v1',
    reason: 'create-card:fold',
    dedupKey: `create-card|${EVENT_ID}|${ANCHOR_A}`,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// §3.5 decision_id 内容派生（R-02 决策确定性；证伪 V-01 旧 ulid() 随机风险）
// ═══════════════════════════════════════════════════════════════════════════

test('decision_id：形状为 26 位 ULID，时间部分取版本 created_at 的 48 位时间', async () => {
  const decision = await loadDecision();
  const id = decision.deriveDecisionId({
    eventId: EVENT_ID,
    version: VERSION,
    createdAtIso: CREATED_AT,
    dedupKey: baseInput().dedupKey,
  });
  assert.ok(isUlid(id), `decision_id 须为 26 位 Crockford ULID，实际 ${id}`);
  assert.equal(
    ulidTimestampMs(id),
    isoToMs(CREATED_AT),
    'decision_id 时间部分必须取版本 created_at 毫秒，而非墙钟',
  );
});

test('decision_id：同去重键同 id、不同去重键 / 不同事件 id 必不同', async () => {
  const decision = await loadDecision();
  const input = baseInput();

  const first = decision.deriveDecisionId({
    eventId: input.eventId,
    version: input.version,
    createdAtIso: input.createdAtIso,
    dedupKey: input.dedupKey,
  });
  const again = decision.deriveDecisionId({
    eventId: input.eventId,
    version: input.version,
    createdAtIso: input.createdAtIso,
    dedupKey: input.dedupKey,
  });
  assert.equal(first, again, '同去重键两次铸造同一 id（内容派生，非随机）');

  const otherKey = decision.deriveDecisionId({
    eventId: input.eventId,
    version: input.version,
    createdAtIso: input.createdAtIso,
    dedupKey: 'add-alias|evt-dec-1|其他键',
  });
  assert.notEqual(otherKey, first, '不同去重键 → 不同 id');

  const otherEvent = decision.deriveDecisionId({
    eventId: 'evt-dec-2',
    version: input.version,
    createdAtIso: input.createdAtIso,
    dedupKey: input.dedupKey,
  });
  assert.notEqual(otherEvent, first, '不同事件 id → 不同 id');
});

// ═══════════════════════════════════════════════════════════════════════════
// §3.5 DecisionRecord.at_ms：取版本 created_at，不取注入墙钟
// ═══════════════════════════════════════════════════════════════════════════

test('at_ms：等于 isoToMs(version.created_at)，不等于注入墙钟', async () => {
  const decision = await loadDecision();
  assert.equal(decision.decisionAtMs(CREATED_AT), isoToMs(CREATED_AT));

  const record = decision.castDecision(baseInput());
  assert.equal(record.at_ms, isoToMs(CREATED_AT), '决策 at_ms 必须取版本 created_at 毫秒');
  assert.notEqual(record.at_ms, INJECTED_WALL_CLOCK, 'at_ms 不得采用注入墙钟 / Date.now()');
  assert.equal(record.created_by, 'her');
});

// ═══════════════════════════════════════════════════════════════════════════
// R-02 双跑决策确定性（纯铸造边界）：同一输入两次独立铸造，口径字段逐行相等。
// IO 级 decisions.jsonl 双跑随 B2 drain 编排，本批不越界造 drain。
// ═══════════════════════════════════════════════════════════════════════════

const DECISION_EQUAL_FIELDS = [
  'decision_id',
  'at_ms',
  'event_id',
  'action',
  'anchor_json',
] as const;

test('R-02：同一真源两份输入两次独立铸造，决策口径字段逐行相等', async () => {
  const decision = await loadDecision();
  const inputs = [
    baseInput(),
    baseInput({
      eventId: 'evt-dec-2',
      cardId: 'mc_second',
      anchors: [ANCHOR_B],
      dedupKey: `create-card|evt-dec-2|${ANCHOR_B}`,
    }),
  ];

  const runOne = inputs.map((input) => decision.castDecision(input));
  const runTwo = inputs.map((input) => decision.castDecision(input));

  assert.equal(runOne.length, runTwo.length);
  for (let i = 0; i < runOne.length; i += 1) {
    for (const field of DECISION_EQUAL_FIELDS) {
      assert.deepEqual(
        runOne[i]![field],
        runTwo[i]![field],
        `第 ${i} 条决策口径字段 ${field} 双跑不等`,
      );
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// R-16 时钟回拨：fold 按版本号取当前态，不漏不重；回拨的 created_at 不污染排序；
// applied 派生集（期望态卡）不误判。折叠纯函数不读墙钟，回拨只体现在数据行上。
// ═══════════════════════════════════════════════════════════════════════════

function makeVersion(
  eventId: string,
  version: number,
  anchors: readonly string[],
  createdAtIso: string,
): EventRecord {
  return {
    id: eventId,
    schema_version: 1,
    version,
    status: 'closed',
    closed_reason: 'silence',
    pointers: anchors.map((anchor) => ({ id: anchor, channel: 'dsh', shard: '2026-11', seq: 0 })),
    time_range: { started_at: iso(T0), ended_at: iso(T0 + DAY) },
    assembled_at: iso(T0 + DAY),
    summary: '客观摘要',
    key_points: ['关键点'],
    anchors: [...anchors],
    topic_lines: [],
    summary_quality: 'ready',
    summary_source: 'llm',
    summary_prompt_version: null,
    summary_model: null,
    effective_chars: null,
    raw_chars: null,
    created_by: 'system',
    created_at: createdAtIso,
    channel: 'dsh',
    boundary_candidates: [],
  };
}

test('R-16：created_at 回拨/乱序注入，fold 仍按版本号取当前态，不漏不重', () => {
  // v1 的 created_at 反而晚于 v2（模拟时钟回拨：旧版本行时间戳更大）。
  const v1 = makeVersion(EVENT_ID, 1, [ANCHOR_A], iso(T0 + 2 * DAY));
  const v2 = makeVersion(EVENT_ID, 2, [ANCHOR_B], iso(T0 + DAY));

  // 两种入序（v2 先到 / v1 先到）折叠结果必须一致。
  for (const rows of [[v2, v1], [v1, v2]] as const) {
    const folded = foldCurrentEvents(rows);
    assert.equal(folded.length, 1, '同 id 两版本折叠后只留一条，不重复');
    const current = folded[0]!;
    assert.equal(current.version, 2, '按版本号取最大版本，不被回拨的 created_at 带偏');
    assert.deepEqual(current.anchors, [ANCHOR_B], '当前态锚点取 v2');
    assert.equal(current.created_at_ms, isoToMs(v2.created_at), '当前态时间戳随 v2');
  }

  // applied 派生集（期望态卡）以折叠后的当前态为准，不误判成 v1 锚点。
  // deriveExpectedProjection 只收折叠后的当前态事件（折叠由编排层在调用前完成）。
  const expected = deriveExpectedProjection({
    events: [v2],
    experienceExists: (id) => id === ANCHOR_A || id === ANCHOR_B,
  });
  assert.equal(expected.cards.length, 1, '只派生一张当前态卡');
  assert.deepEqual(expected.cards[0]!.anchors, [ANCHOR_B]);

  // 重放一次结果集合相等（无游标状态被污染）。
  const replay = deriveExpectedProjection({
    events: [v2],
    experienceExists: (id) => id === ANCHOR_A || id === ANCHOR_B,
  });
  assert.deepEqual(
    expected.cards.map((card) => card.cardId),
    replay.cards.map((card) => card.cardId),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// X-01 card_id 公式钉死：`mc_` + sha256(canonical([eventId, sorted(anchors)])) 前 32 位。
// 公式不得变；锚点排序后入参（序无关）。
// ═══════════════════════════════════════════════════════════════════════════

test('card_id：公式固定向量钉死，锚点序无关；换锚点必换 id', () => {
  const fixed = deriveCardId('evt-card-1', [ANCHOR_B, ANCHOR_A]);
  assert.equal(fixed, 'mc_87563a7da7c43eaa85e3aad1a6ebd770', 'card_id 固定向量不得漂移');

  const reordered = deriveCardId('evt-card-1', [ANCHOR_A, ANCHOR_B]);
  assert.equal(reordered, fixed, '锚点排序后规范化，顺序不影响 card_id');

  const otherAnchors = deriveCardId('evt-card-1', [ANCHOR_A]);
  assert.notEqual(otherAnchors, fixed, '锚点集合变化 → card_id 变化');
});
