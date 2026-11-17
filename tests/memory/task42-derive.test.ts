/**
 * #42 · B0-G1 红测：derive 纯函数层（正本 §3.1、§3.4、§3.5、§2.3、§4.2 R-01/R-07/R-08、§4.3 P-08）。
 *
 * 被测目标模块（写者落地，B0）：`src/memory/derive.ts` —— 从 builder 抽取的零 IO 纯函数层。
 * 本文件只写测试，绝不改 src/。
 *
 * 登记给写者的 derive.ts 导出契约（类型名/函数名以此为准）：
 *  - `classifyAnchors(raw, experienceExists)`：空锚三分谓词（builder 与 drain 共用同一符号）；
 *  - `structuralHash(input)`：全结构派生输入快照哈希；
 *  - `deriveExpectedProjection({ events, experienceExists })`：期望态派生（卡身份 + 隔离/abstain 清单）。
 *
 * 纪律：临时数据根（mkdtemp），真实根零写入；确定性夹具（固定时间戳生成器），不用 Date.now 抖动。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { EventRecord } from '../../src/contract/event.ts';
import { appendJsonl } from '../../src/core/jsonl.ts';
import { UlidGenerator } from '../../src/core/ulid.ts';
import {
  buildMemoryIndex,
  computeContentHash,
  computeRowHashSum,
  computeTruthFingerprint,
  deriveCardId,
} from '../../src/memory/builder.ts';
import { cueTextOf } from '../../src/memory/fts.ts';
import { indexTextOf } from '../../src/memory/bigram.ts';
import { MEMORY_INDEX_FILE, openMemoryRead, openMemoryWrite } from '../../src/memory/store.ts';
import type { AliasRow, DecisionRecord, MemoryCard, RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, makeExperience, makeTempRoot } from '../helpers.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

// ── 确定性夹具：固定时间戳生成器的 ULID ─────────────────────────────────────

const fixedUlid = (() => {
  const gen = new UlidGenerator(() => 1_772_000_000_000);
  return (): string => gen.next();
})();

/** 经历全集内的合法 ULID 锚点。 */
const EXP_A = fixedUlid();
const EXP_B = fixedUlid();
const EXP_C = fixedUlid();
/** 形态合法但经历全集不存在 → anchor-not-found。 */
const MISSING = '01J0000000000000000000000Z';

/** 经历存在谓词（纯函数注入，不碰 IO）。 */
const experienceExists = (id: string): boolean => id === EXP_A || id === EXP_B || id === EXP_C;

// ── derive.ts 模块契约镜像（运行时动态加载，避免悬空静态 import）─────────────

type AnchorStatus = 'ok' | 'abstain' | 'form-invalid' | 'not-found';
type ReasonCode = 'empty-anchors' | 'anchor-form-invalid' | 'anchor-not-found' | null;

interface AnchorClassification {
  readonly status: AnchorStatus;
  readonly reasonCode: ReasonCode;
}

interface StructuralHashInput {
  readonly anchors: readonly string[];
  readonly channel: string;
  readonly startedMs: number;
  readonly endedMs: number;
  readonly eligibility: string;
  readonly rulesVersion: string;
}

interface ExpectedCard {
  readonly cardId: string;
  readonly eventId: string;
  readonly anchors: readonly string[];
  readonly channel: string;
  readonly startedMs: number;
  readonly endedMs: number;
}

interface QuarantineEntry {
  readonly eventId: string;
  readonly reasonCode: 'anchor-form-invalid' | 'anchor-not-found';
  readonly anchors: readonly string[];
}

interface AbstainEntry {
  readonly eventId: string;
  readonly anchors: readonly string[];
}

interface ExpectedProjection {
  readonly cards: ExpectedCard[];
  readonly byEvent: ReadonlyMap<string, ExpectedCard>;
  readonly quarantined: readonly QuarantineEntry[];
  readonly emptyAnchored: readonly AbstainEntry[];
}

interface DeriveModule {
  classifyAnchors: (raw: unknown, exists: (id: string) => boolean) => AnchorClassification;
  structuralHash: (input: StructuralHashInput) => string;
  deriveExpectedProjection: (input: {
    events: readonly EventRecord[];
    experienceExists: (id: string) => boolean;
  }) => ExpectedProjection;
}

const DERIVE_URL = new URL('../../src/memory/derive.ts', import.meta.url);

async function loadDerive(): Promise<DeriveModule> {
  const mod = (await import(DERIVE_URL.href)) as Partial<DeriveModule>;
  assert.equal(
    typeof mod.classifyAnchors,
    'function',
    'derive.ts 须导出 classifyAnchors（§2.3 空锚三分谓词）',
  );
  assert.equal(
    typeof mod.structuralHash,
    'function',
    'derive.ts 须导出 structuralHash（§3.5 全结构快照哈希）',
  );
  assert.equal(
    typeof mod.deriveExpectedProjection,
    'function',
    'derive.ts 须导出 deriveExpectedProjection（§2.5 期望态派生）',
  );
  return mod as DeriveModule;
}

// ── 事件夹具 ──────────────────────────────────────────────────────────────

function makeEvent(
  id: string,
  anchors: readonly string[],
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    id,
    schema_version: 1,
    version: 1,
    status: 'closed',
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
    closed_reason: 'silence',
    created_by: 'system',
    created_at: iso(T0 + DAY),
    channel: 'dsh',
    boundary_candidates: [],
    effective_chars: null,
    raw_chars: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// §2.3 空锚三分谓词（R-11 / §4.2 R-08 分类口径）
// 注意：分类在「原始行容错解析之后、契约校验之前」生效，故这里直接喂原始值，
// 不经过 parseEvent —— null / 非数组 / 缺失这类输入到不了契约层。
// ═══════════════════════════════════════════════════════════════════════════

const CLASSIFY_CASES: ReadonlyArray<
  readonly [string, unknown, AnchorStatus, ReasonCode]
> = [
  ['空数组 → 合法 abstain', [], 'abstain', 'empty-anchors'],
  ['单锚存在 → ok', [EXP_A], 'ok', null],
  ['双锚均存在 → ok', [EXP_A, EXP_B], 'ok', null],
  ['重复锚点 → ok', [EXP_A, EXP_A], 'ok', null],
  ['自由文本（非数组元素）→ form-invalid', [EXP_A, 'web_search'], 'form-invalid', 'anchor-form-invalid'],
  ['字符串本身不是数组 → form-invalid', '论文', 'form-invalid', 'anchor-form-invalid'],
  ['null → form-invalid', null, 'form-invalid', 'anchor-form-invalid'],
  ['缺失 undefined → form-invalid', undefined, 'form-invalid', 'anchor-form-invalid'],
  ['对象不是数组 → form-invalid', { anchors: [EXP_A] }, 'form-invalid', 'anchor-form-invalid'],
  ['小写 ULID → form-invalid', ['01j0000000000000000000000a'], 'form-invalid', 'anchor-form-invalid'],
  ['空串元素 → form-invalid', [''], 'form-invalid', 'anchor-form-invalid'],
  ['数字元素 → form-invalid', [12345], 'form-invalid', 'anchor-form-invalid'],
  ['形态合法但经历不存在 → not-found', [MISSING], 'not-found', 'anchor-not-found'],
];

for (const [label, raw, status, reasonCode] of CLASSIFY_CASES) {
  test(`§2.3 三分：${label}`, async () => {
    const derive = await loadDerive();
    const classification = derive.classifyAnchors(raw, experienceExists);
    assert.equal(classification.status, status);
    assert.equal(classification.reasonCode, reasonCode);
  });
}

test('§2.3 三分：混合 —— 一个悬空 + 一个存在 → not-found（整批按最差姿态隔离）', async () => {
  const derive = await loadDerive();
  const classification = derive.classifyAnchors([EXP_A, MISSING], experienceExists);
  assert.equal(classification.status, 'not-found');
  assert.equal(classification.reasonCode, 'anchor-not-found');
});

// ── §2.3.4 / R-11：builder 与 drain 必须走同一纯函数符号（不是两处同逻辑）────

test('R-11：builder.ts 从 derive.ts 引用同一个 classifyAnchors 符号（单点实现）', () => {
  const builderText = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'memory', 'builder.ts'),
    'utf8',
  );
  assert.match(
    builderText,
    /from\s+['"]\.\/derive\.ts['"]/,
    'builder 必须从 derive.ts 引入共享谓词，不得在本文件内另写一份锚点分类逻辑',
  );
  assert.match(
    builderText,
    /classifyAnchors/,
    'builder 调用的共享符号必须是 classifyAnchors',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// §3.5 structural hash：anchors＋channel＋时间窗＋eligibility＋rules_version；
// 仅摘要文字变 → hash 不变。
// ═══════════════════════════════════════════════════════════════════════════

const BASE_HASH_INPUT: StructuralHashInput = {
  anchors: [EXP_A],
  channel: 'dsh',
  startedMs: T0,
  endedMs: T0 + DAY,
  eligibility: 'closed-ready',
  rulesVersion: 'rules-v1',
};

test('§3.5 structuralHash：同输入两次派生相等（确定性）', async () => {
  const derive = await loadDerive();
  assert.equal(derive.structuralHash(BASE_HASH_INPUT), derive.structuralHash(BASE_HASH_INPUT));
});

const HASH_SENSITIVITY: ReadonlyArray<readonly [string, Partial<StructuralHashInput>]> = [
  ['anchors 变', { anchors: [EXP_B] }],
  ['channel 变', { channel: 'web' }],
  ['时间窗起点变', { startedMs: T0 + DAY }],
  ['时间窗终点变', { endedMs: T0 + 2 * DAY }],
  ['eligibility 变', { eligibility: 'open' }],
  ['rules_version 变', { rulesVersion: 'rules-v2' }],
];

for (const [label, patch] of HASH_SENSITIVITY) {
  test(`§3.5 structuralHash：${label} → 哈希必变`, async () => {
    const derive = await loadDerive();
    const before = derive.structuralHash(BASE_HASH_INPUT);
    const after = derive.structuralHash({ ...BASE_HASH_INPUT, ...patch });
    assert.notEqual(after, before);
  });
}

test('§3.5 structuralHash：仅摘要文字变 → 哈希不变（摘要不进结构快照）', async () => {
  const derive = await loadDerive();
  const before = derive.structuralHash(BASE_HASH_INPUT);
  // 摘要文字不属于结构派生输入面；额外携带 summary 字段不得影响哈希。
  const after = derive.structuralHash({ ...BASE_HASH_INPUT, summary: '另一段完全不同的摘要' } as StructuralHashInput);
  assert.equal(after, before);
});

// ═══════════════════════════════════════════════════════════════════════════
// R-08 混合脏夹具：悬空 / 非 ULID / 空锚 / 未 ready / 未 closed 混合输入；
// cards 零坏卡；quarantined 与 emptyAnchored 计数精确；同输入重跑集合相等。
// ═══════════════════════════════════════════════════════════════════════════

function dirtyFixture(): EventRecord[] {
  return [
    makeEvent('ev-ok', [EXP_A]),
    makeEvent('ev-abstain', []),
    makeEvent('ev-form-text', ['论文']),
    makeEvent('ev-form-lower', ['01j0000000000000000000000a']),
    makeEvent('ev-notfound', [MISSING]),
    makeEvent('ev-open', [EXP_A], { status: 'open' }),
    makeEvent('ev-pending', [EXP_A], { summary_quality: 'pending' }),
  ];
}

test('R-08 混合脏夹具：零坏卡，隔离/abstain 计数精确', async () => {
  const derive = await loadDerive();
  const projection = derive.deriveExpectedProjection({
    events: dirtyFixture(),
    experienceExists,
  });

  assert.equal(projection.cards.length, 1, '仅 ev-ok 出卡');
  assert.equal(projection.byEvent.size, 1);
  const onlyCard = projection.byEvent.get('ev-ok');
  assert.ok(onlyCard);
  assert.deepEqual([...onlyCard.anchors], [EXP_A]);

  assert.equal(projection.quarantined.length, 3, 'form-text / form-lower / notfound 隔离 3 条');
  const reasons = projection.quarantined.map((q) => q.reasonCode).sort();
  assert.deepEqual(reasons, ['anchor-form-invalid', 'anchor-form-invalid', 'anchor-not-found']);

  assert.equal(projection.emptyAnchored.length, 1, '空数组 1 条 abstain');
  assert.deepEqual(projection.emptyAnchored[0]?.eventId, 'ev-abstain');

  // 未 closed / 未 ready：既不进卡集，也不进隔离/abstain 清单。
  const allAccounted = [
    ...projection.cards.map((c) => c.eventId),
    ...projection.quarantined.map((q) => q.eventId),
    ...projection.emptyAnchored.map((a) => a.eventId),
  ];
  assert.deepEqual([...allAccounted].sort(), ['ev-abstain', 'ev-form-lower', 'ev-form-text', 'ev-notfound', 'ev-ok']);
});

test('R-08 混合脏夹具：同输入重跑两次，卡集/隔离集/abstain 集逐行相等（可重算）', async () => {
  const derive = await loadDerive();
  const input = { events: dirtyFixture(), experienceExists };
  const first = derive.deriveExpectedProjection(input);
  const second = derive.deriveExpectedProjection(input);

  const snapshot = (p: ExpectedProjection) => ({
    cards: p.cards.map((c) => [c.cardId, c.eventId, [...c.anchors], c.channel, c.startedMs, c.endedMs]),
    quarantined: p.quarantined.map((q) => [q.eventId, q.reasonCode, [...q.anchors]]),
    emptyAnchored: p.emptyAnchored.map((a) => [a.eventId, [...a.anchors]]),
  });
  assert.deepEqual(snapshot(second), snapshot(first));
});

// ═══════════════════════════════════════════════════════════════════════════
// R-07 修正链三形态（§4.2 R-07 / MU-6）：
//  1. 锚点变 → 旧卡 invalidate + 新卡建（card_id 变、结构哈希变）；
//  2. 仅摘要文字变 → 不重算（结构哈希不变）；
//  3. 时间窗/元数据变 → 必须重算（结构哈希变）。
// ═══════════════════════════════════════════════════════════════════════════

test('R-07 形态①：锚点变 → card_id 变且 structuralHash 变（旧卡作废、新卡建立）', async () => {
  const derive = await loadDerive();
  const eventId = 'ev-r07';
  const oldCardId = deriveCardId(eventId, [EXP_A]);
  const newCardId = deriveCardId(eventId, [EXP_B]);
  assert.notEqual(newCardId, oldCardId, '锚点变 → card_id 必变（X-01 公式不动）');

  const oldHash = derive.structuralHash({ ...BASE_HASH_INPUT, anchors: [EXP_A] });
  const newHash = derive.structuralHash({ ...BASE_HASH_INPUT, anchors: [EXP_B] });
  assert.notEqual(newHash, oldHash);
});

test('R-07 形态②：仅摘要文字变 → structuralHash 不变（不触发重算）', async () => {
  const derive = await loadDerive();
  const oldHash = derive.structuralHash(BASE_HASH_INPUT);
  const newHash = derive.structuralHash({ ...BASE_HASH_INPUT, summary: '摘要被她改写了一段' } as StructuralHashInput);
  assert.equal(newHash, oldHash, '摘要文字不进结构快照，不应触发重算');
});

test('R-07 形态③：时间窗变 → structuralHash 变（必须重算）', async () => {
  const derive = await loadDerive();
  const oldHash = derive.structuralHash(BASE_HASH_INPUT);
  const newHash = derive.structuralHash({ ...BASE_HASH_INPUT, startedMs: T0 + DAY, endedMs: T0 + 2 * DAY });
  assert.notEqual(newHash, oldHash, '时间窗变 → 结构快照必变，必须重算');
});

// ═══════════════════════════════════════════════════════════════════════════
// R-01 抽取零漂移：同一合成真源下，derive 期望态与 builder 全量输出逐行相等
// （活卡集合、card_id、anchors、channel、时间窗、event_id→卡映射）。
// ═══════════════════════════════════════════════════════════════════════════

function writeTruth(root: string, events: EventRecord[]): void {
  const experienceIds = [EXP_A, EXP_B, EXP_C];
  experienceIds.forEach((id, i) => {
    appendJsonl(
      path.join(root, 'experiences', '2026-11.jsonl'),
      makeExperience({ id, tick: i, occurred_at: iso(T0 + i * Math.floor(DAY / 2)), recorded_at: iso(T0 + i * Math.floor(DAY / 2)) }),
    );
  });
  for (const event of events) {
    appendJsonl(path.join(root, 'events', '2026-11.jsonl'), event);
  }
}

function seedCard(
  event: EventRecord,
  cues: string[],
  aliases: Array<{ term: string; sensitive: 0 | 1 }>,
  discriminator: string,
  atMs: number,
): { card: MemoryCard; aliasRows: AliasRow[] } {
  const cardId = deriveCardId(event.id, event.anchors);
  const anchorJson = JSON.stringify(event.anchors);
  const displayCuesJson = JSON.stringify(cues);
  const aliasesJson = JSON.stringify(
    aliases.map((a) => ({ term: a.term, source: 'miss', sensitive: a.sensitive })),
  );
  const card: MemoryCard = {
    cardId,
    eventId: event.id,
    anchorJson,
    channel: event.channel,
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator,
    entityHintJson: null,
    occurredMs: Date.parse(event.time_range.started_at),
    endedMs: Date.parse(event.time_range.ended_at),
    validMs: atMs,
    invalidMs: null,
    createdMs: atMs,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, discriminator),
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  const aliasRows: AliasRow[] = aliases.map((a) => ({
    termNorm: a.term,
    cardId,
    source: 'miss',
    sensitive: a.sensitive,
    status: 'active',
    createdMs: atMs,
    hitCount: 0,
    lastHitMs: null,
  }));
  return { card, aliasRows };
}

async function seedIndex(
  root: string,
  entries: Array<{ card: MemoryCard; aliasRows: AliasRow[] }>,
  atMs: number,
): Promise<void> {
  const indexDir = path.join(root, 'projection', 'memory-index');
  const handle = openMemoryWrite({ indexDir });
  try {
    const cards = entries.map((e) => e.card);
    const aliases = entries.flatMap((e) => e.aliasRows);
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: atMs,
      schema_version: 3,
      truth_fingerprint: computeTruthFingerprint(root).aggregate,
      prior_revision: null,
      card_count: cards.filter((c) => c.status === 'active').length,
      alias_count: aliases.length,
      row_hash_sum: computeRowHashSum(cards),
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'task42 derive 零漂移夹具',
      operator: 'offline-cli',
    };
    const decisions: DecisionRecord[] = cards.map((c) => ({
      decision_id: fixedUlid(),
      at_ms: atMs,
      action: 'create-card',
      card_id: c.cardId,
      event_id: c.eventId,
      anchor_json: c.anchorJson,
      content_hash: c.contentHash,
      model_tag: 'rules-v1',
      reason: 'fixture: 零漂移',
      created_by: 'her',
    }));
    handle.transactionApply({ cards, aliases }, revision, decisions);
  } finally {
    await handle.close();
  }
}

test('R-01 零漂移：derive 期望态卡集合/身份/锚点/通道/时间窗/事件映射与 builder 影子库逐行相等', async () => {
  const derive = await loadDerive();
  const root = makeTempRoot('task42-derive-');
  try {
    const eventA = makeEvent('ev-A', [EXP_A, EXP_B]);
    const eventB = makeEvent('ev-B', [EXP_C], {
      time_range: { started_at: iso(T0 + 4 * DAY), ended_at: iso(T0 + 5 * DAY) },
    });
    writeTruth(root, [eventA, eventB]);

    const seededA = seedCard(eventA, ['线索甲'], [{ term: '别名甲', sensitive: 0 }], '区别于乙', T0);
    const seededB = seedCard(eventB, ['线索丙'], [], '区别于丁', T0);
    await seedIndex(root, [seededA, seededB], T0);

    const report = await buildMemoryIndex({ dataRoot: root, dryRun: true, nowMs: T0 + DAY });
    const read = openMemoryRead({ indexDir: report.outputDir });
    try {
      const shadowCards = read.listEffective(T0 + 10 * DAY);
      const shadowById = new Map(shadowCards.map((c) => [c.eventId, c]));

      const projection = derive.deriveExpectedProjection({
        events: [eventA, eventB],
        experienceExists,
      });
      const deriveById = projection.byEvent;

      // 活卡集合相等。
      assert.deepEqual(
        shadowCards.map((c) => c.cardId).sort(),
        [...deriveById.keys()].map((id) => deriveById.get(id)!.cardId).sort(),
      );

      for (const [eventId, deriveCard] of deriveById) {
        const shadow = shadowById.get(eventId);
        assert.ok(shadow, `builder 影子库缺事件 ${eventId} 的卡`);
        assert.equal(shadow.cardId, deriveCard.cardId, 'card_id 逐行相等');
        assert.deepEqual(JSON.parse(shadow.anchorJson) as string[], [...deriveCard.anchors], 'anchors 逐行相等');
        assert.equal(shadow.channel, deriveCard.channel, 'channel 逐行相等');
        assert.equal(shadow.occurredMs, deriveCard.startedMs, '时间窗起点逐行相等');
        assert.equal(shadow.endedMs, deriveCard.endedMs, '时间窗终点逐行相等');
      }

      // event_id → 卡映射相等。
      assert.deepEqual(
        [...shadowById.keys()].sort(),
        [...deriveById.keys()].sort(),
      );
    } finally {
      await read.close();
      cleanupTempRoot(report.outputDir);
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('R-01 零漂移：FTS 文本＝cueTextOf 原文经 bigram.indexTextOf 的单元序列（#124 几何）', async () => {
  const root = makeTempRoot('task42-derive-fts-');
  try {
    const eventA = makeEvent('ev-A', [EXP_A]);
    writeTruth(root, [eventA]);
    const seededA = seedCard(
      eventA,
      ['线索甲'],
      [
        { term: '别名甲', sensitive: 0 },
        { term: '隐私词', sensitive: 1 },
      ],
      '区别于乙',
      T0,
    );
    await seedIndex(root, [seededA], T0);

    const report = await buildMemoryIndex({ dataRoot: root, dryRun: true, nowMs: T0 + DAY });
    const db = new DatabaseSync(path.join(report.outputDir, MEMORY_INDEX_FILE), { readOnly: true });
    try {
      const row = db
        .prepare('SELECT display_cues_json, aliases_json, cue_text FROM mem_card JOIN mem_card_fts USING (card_id) WHERE card_id = ?')
        .get(seededA.card.cardId) as {
        display_cues_json: string;
        aliases_json: string;
        cue_text: string;
      };
      const aliases = (JSON.parse(row.aliases_json) as Array<{ term: string; sensitive: 0 | 1 }>).map(
        (a) => ({
          termNorm: a.term,
          cardId: seededA.card.cardId,
          source: 'miss' as const,
          sensitive: a.sensitive,
          status: 'active' as const,
          createdMs: T0,
          hitCount: 0,
          lastHitMs: null,
        }),
      );
      const expected = indexTextOf(cueTextOf(row.display_cues_json, aliases));
      assert.equal(row.cue_text, expected, 'FTS 文本 = 原文串经 bigram 单元化后的空格序列（#124 共享低层口径）');
      assert.ok(!row.cue_text.includes('隐私词'), '敏感别名不进 FTS（原文整词）');
      assert.ok(!row.cue_text.includes('隐私'), '敏感别名不进 FTS（bigram 单元亦不可见）');
      assert.ok(!row.cue_text.includes('私词'), '敏感别名不进 FTS（bigram 单元亦不可见）');
    } finally {
      db.close();
      cleanupTempRoot(report.outputDir);
    }
  } finally {
    cleanupTempRoot(root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// P-08 探针（§4.3）：derive.ts 是零 IO 纯函数层，不得出现 node:fs / DB 导入。
// ═══════════════════════════════════════════════════════════════════════════

test('P-08：derive.ts 不 import node:fs / node:sqlite / 任何 DB 访问', () => {
  const derivePath = path.join(REPO_ROOT, 'src', 'memory', 'derive.ts');
  if (!fs.existsSync(derivePath)) {
    assert.fail('src/memory/derive.ts 尚未落地（P-08 探针待实现后生效）');
  }
  const text = fs.readFileSync(derivePath, 'utf8');
  const forbidden = ['node:fs', 'node:fs/promises', 'node:sqlite'];
  for (const spec of forbidden) {
    assert.ok(!text.includes(spec), `derive.ts 不得引入 ${spec}（纯函数层零 IO）`);
  }
  assert.ok(!/\bDatabaseSync\b/.test(text), 'derive.ts 不得直接开 SQLite 连接');
});
