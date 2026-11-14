/**
 * WP4b DSH 真机工具注册薄壳测试（本目录是全仓唯一允许 import @deepseek-ai/* 的地方）。
 *
 * 薄壳只做三件宿主特定的事：defineTool 形状映射、会话级私有序号表持有/失效、
 * 把内核错误翻译成稳定安全码；内核能力全部来自宿主无关的 openAssembledMemoryTools。
 *
 * 纪律：临时根、零真实数据；离线 node:test 用假 registry 与直接调用 definition，
 * 真机 ctx.tools 的装载/可见性留给真机验收清单，不在此伪装。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

import { computeContentHash } from '../../../src/memory/builder.ts';
import { ulid } from '../../../src/core/ulid.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../../src/memory/store.ts';
import type { AliasRow, MemoryCard, RevisionRecord } from '../../../src/memory/types.ts';
import type { MemoryGateMode } from '../../../src/assembly/memory-tools.ts';
import {
  MEMORY_TOOL_NAMES,
  openDshMemoryBridge,
  registerMemoryToolDefinitions,
  wireMemoryTools,
  type DshMemoryBridge,
  type DshToolRegistry,
} from '../../../src/adapters/dsh/memory-tool-bridge.ts';
import { ChannelBoundaryError } from '../../../src/core/errors.ts';
import {
  projectExperienceSummary,
  type ExperienceSummaryView,
  type Pointer,
  type RawTurnLookupView,
  type SourceLookupPort,
} from '../../../src/assembly/source-lookup.ts';
import { cleanupTempRoot, makeTempRoot, makeExperience } from '../../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const NOW = () => T0 + 777;
const ANCHOR = ulid();
const EXEC = {} as ToolRunContext;

function seedOneCard(root: string): string {
  const indexDir = path.join(root, 'projection', 'memory-index');
  const anchorJson = JSON.stringify([ANCHOR]);
  const displayCuesJson = JSON.stringify(['咖啡馆约会']);
  const aliasesJson = JSON.stringify([
    { term: '咖啡馆', source: 'miss', sensitive: 1 },
    { term: '秘密代号Q', source: 'miss', sensitive: 1 },
  ]);
  const card: MemoryCard = {
    cardId: 'mc_seed',
    eventId: 'evt-seed',
    anchorJson,
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator: '城南老店',
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, '城南老店'),
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  const aliasRows: AliasRow[] = [
    {
      termNorm: '咖啡馆',
      cardId: 'mc_seed',
      source: 'miss',
      sensitive: 1,
      status: 'active',
      createdMs: T0,
      hitCount: 0,
      lastHitMs: null,
    },
    {
      termNorm: '秘密代号Q',
      cardId: 'mc_seed',
      source: 'miss',
      sensitive: 1,
      status: 'active',
      createdMs: T0,
      hitCount: 0,
      lastHitMs: null,
    },
  ];
  const revision: RevisionRecord = {
    revision: 1,
    slug: 'build',
    at_ms: T0,
    schema_version: 1,
    truth_fingerprint: 'fp-wp4b-bridge',
    prior_revision: null,
    card_count: 1,
    alias_count: 2,
    row_hash_sum: 'rh-wp4b-bridge',
    shadow_diff: { added: 1, removed: 0, changed: 0 },
    reason: 'test fixture',
    operator: 'offline-cli',
  };
  const handle = openMemoryWrite({ indexDir });
  try {
    handle.transactionApply({ cards: [card], aliases: aliasRows }, revision, []);
  } finally {
    void handle.close();
  }
  return indexDir;
}

/** 解析工具 execute 返回的字符串信封。 */
async function callTool(def: ToolDefinition, args: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> {
  const text = (await def.execute(args, EXEC)) as string;
  return JSON.parse(text) as { ok: boolean; data?: unknown; error?: { code: string } };
}

function byName(bridge: DshMemoryBridge): Map<string, ToolDefinition> {
  return new Map(bridge.definitions.map((d) => [d.name, d]));
}

test('WP4b 薄壳：恰注册六个记忆工具（通道一四件套+通道二两件套），命名/参数/字符串输出契约正确', async () => {
  const root = makeTempRoot('wp4b-bridge-shape-');
  try {
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'off',
      now: NOW,
      channel: 'dsh',
    });
    assert.deepEqual(
      bridge.definitions.map((d) => d.name).sort(),
      [
        MEMORY_TOOL_NAMES.addMissAlias,
        MEMORY_TOOL_NAMES.cardsByAnchor,
        MEMORY_TOOL_NAMES.experienceSummary,
        MEMORY_TOOL_NAMES.gatedSearch,
        MEMORY_TOOL_NAMES.rawText,
        MEMORY_TOOL_NAMES.resolvePointer,
      ].sort(),
    );
    assert.equal(bridge.definitions.length, 6);

    for (const def of bridge.definitions) {
      assert.equal(def.output.schema.type, 'string', `${def.name} 统一字符串输出`);
      const blocks = def.output.render({} as never, 'hello');
      assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }]);
    }

    const tools = byName(bridge);
    const search = tools.get(MEMORY_TOOL_NAMES.gatedSearch) as ToolDefinition;
    // defineTool 运行时把扁平参数编译为标准对象根 JSON schema：属性进 properties、必填进根 required。
    const searchParams = search.parameters as {
      type: string;
      required: string[];
      properties: Record<string, { type: string; items?: { type: string } }>;
    };
    assert.equal(searchParams.type, 'object');
    assert.equal(searchParams.properties.text!.type, 'string');
    assert.ok(searchParams.required.includes('text'));
    assert.equal(searchParams.properties.limit!.type, 'number');
    assert.ok(!searchParams.required.includes('limit'));

    const resolve = tools.get(MEMORY_TOOL_NAMES.resolvePointer) as ToolDefinition;
    const resolveParams = resolve.parameters as {
      type: string;
      required: string[];
      properties: { serials: { type: string; items: { type: string } } };
    };
    assert.equal(resolveParams.properties.serials.type, 'array');
    assert.equal(resolveParams.properties.serials.items.type, 'integer');
    assert.ok(resolveParams.required.includes('serials'));
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 薄壳：缺库 off 态检索 fail-closed 报 unavailable、信封无 source 键、别名 deferred', async () => {
  const root = makeTempRoot('wp4b-bridge-off-');
  try {
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'off',
      now: NOW,
      channel: 'dsh',
    });
    const tools = byName(bridge);

    // off 生产环境靠不注册保证零变化；薄壳直调时内核 fail-closed，经错误翻译回稳定安全码。
    const searchResult = await callTool(tools.get(MEMORY_TOOL_NAMES.gatedSearch) as ToolDefinition, { text: '关键词' });
    assert.equal(searchResult.ok, false);
    assert.equal(searchResult.error?.code, 'unavailable');
    assert.equal(searchResult.data, undefined, '失败信封不得夹带任何候选数据');

    const cardsResult = await callTool(tools.get(MEMORY_TOOL_NAMES.cardsByAnchor) as ToolDefinition, {
      experienceId: ANCHOR,
    });
    assert.equal(cardsResult.ok, false);
    assert.equal(cardsResult.error?.code, 'unavailable');

    const aliasResult = await callTool(tools.get(MEMORY_TOOL_NAMES.addMissAlias) as ToolDefinition, {
      term: '某个词',
      cardId: 'mc_seed',
    });
    assert.equal(aliasResult.ok, true);
    assert.deepEqual(aliasResult.data, { deferred: true, mode: 'off', reason: 'gate-not-on' });
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 薄壳：未检索就解析序号 → fail-closed 提示先检索（安全码 serial-context-missing）', async () => {
  const root = makeTempRoot('wp4b-bridge-noctx-');
  try {
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'on',
      now: NOW,
      channel: 'dsh',
    });
    const resolve = byName(bridge).get(MEMORY_TOOL_NAMES.resolvePointer) as ToolDefinition;
    const result = await callTool(resolve, { serials: [1] });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'serial-context-missing');
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 薄壳：on 态检索后序号可解析；新检索替换序号表后旧序号 fail-closed（serial-stale）', async () => {
  const root = makeTempRoot('wp4b-bridge-serial-');
  try {
    const indexDir = seedOneCard(root);
    const bridge = openDshMemoryBridge({ indexDir, mode: 'on', now: NOW, channel: 'dsh' });
    const tools = byName(bridge);
    const search = tools.get(MEMORY_TOOL_NAMES.gatedSearch) as ToolDefinition;
    const resolve = tools.get(MEMORY_TOOL_NAMES.resolvePointer) as ToolDefinition;

    const hit = await callTool(search, { text: '咖啡馆' });
    assert.equal(hit.ok, true);
    const hitData = hit.data as { status: string; cards: unknown[] };
    assert.equal(hitData.status, 'hit');
    assert.ok(!('source' in hitData), '拆除后信封单形态，不得回传 source 键');

    const resolved = await callTool(resolve, { serials: [1] });
    assert.equal(resolved.ok, true);
    assert.deepEqual((resolved.data as { cardIds: string[] }).cardIds, ['mc_seed']);

    // 一次不命中的新检索整体替换会话序号表，旧序号随即失效。
    await callTool(search, { text: '完全无关的冷词XYZ' });
    const stale = await callTool(resolve, { serials: [1] });
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, 'serial-stale');
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 薄壳：卡详情经 N14 白名单投影，模型侧看不到任何内部/敏感字段', async () => {
  const root = makeTempRoot('wp4b-bridge-n14-');
  try {
    const indexDir = seedOneCard(root);
    const bridge = openDshMemoryBridge({ indexDir, mode: 'on', now: NOW, channel: 'dsh' });
    const cards = byName(bridge).get(MEMORY_TOOL_NAMES.cardsByAnchor) as ToolDefinition;
    const result = await callTool(cards, { experienceId: ANCHOR });
    assert.equal(result.ok, true);
    const list = result.data as Array<Record<string, unknown>>;
    assert.ok(list.length >= 1);
    const first = list[0] as Record<string, unknown>;
    assert.equal(first.cardId, 'mc_seed');
    assert.deepEqual(first.anchorIds, [ANCHOR]);
    const raw = JSON.stringify(first);
    // 注：展示线索 displayCues 本就允许模型可见，故只校验别名字段/内部列不回显，
    // 不把与线索文本同名的子串当禁词；别名与 cue 的结构性隔离由下列字段名禁列保证。
    for (const forbidden of [
      'aliasesJson',
      'sensitive',
      'eventId',
      'weight',
      'contentHash',
      'entityHintJson',
      'validMs',
      'hitCount',
      '秘密代号Q',
    ]) {
      if (raw.includes(forbidden)) assert.fail(`卡详情回显了内部/敏感项 ${forbidden}；实际投影=${raw}`);
    }
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 薄壳：register 聚合六个 disposer，注销时每个工具恰好注销一次', () => {
  const root = makeTempRoot('wp4b-bridge-reg-');
  try {
    const events: string[] = [];
    const registry: DshToolRegistry = {
      register(def) {
        events.push(`reg:${def.name}`);
        return () => events.push(`unreg:${def.name}`);
      },
    };
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'off',
      now: NOW,
      channel: 'dsh',
    });
    const unregisterAll = registerMemoryToolDefinitions(registry, bridge.definitions);
    assert.equal(events.filter((e) => e.startsWith('reg:')).length, 6);
    unregisterAll();
    assert.equal(events.filter((e) => e.startsWith('unreg:')).length, 6);
    void bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 薄壳：缺库降级不侧建索引文件，dispose 可重复调用不抛', async () => {
  const root = makeTempRoot('wp4b-bridge-dispose-');
  try {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const bridge = openDshMemoryBridge({ indexDir, mode: 'off', now: NOW, channel: 'dsh' });
    const { existsSync } = await import('node:fs');
    assert.ok(!existsSync(path.join(indexDir, MEMORY_INDEX_FILE)));
    await bridge.dispose();
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

// ── plugin 接线编排 wireMemoryTools（默认 off 零挂载、无 tools 服务安全跳过）────────

function makeFakeRegistry(): {
  registry: DshToolRegistry;
  definitions: ToolDefinition[];
  unregisterCount: () => number;
} {
  const definitions: ToolDefinition[] = [];
  let unregistered = 0;
  const registry: DshToolRegistry = {
    register(def) {
      definitions.push(def);
      return () => {
        unregistered += 1;
      };
    },
  };
  return { registry, definitions, unregisterCount: () => unregistered };
}

test('WP4b 接线：mode=off 时不打开桥接、不注册任何工具（线上行为零变化）', async () => {
  const root = makeTempRoot('wp4b-wire-off-');
  try {
    const fake = makeFakeRegistry();
    const wiring = wireMemoryTools({
      registry: fake.registry,
      mode: 'off',
      indexDir: path.join(root, 'projection', 'memory-index'),
      now: NOW,
      channel: 'dsh',
    });
    assert.equal(wiring.registered, false);
    assert.equal(fake.definitions.length, 0);
    await wiring.dispose();
    assert.equal(fake.unregisterCount(), 0);
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 接线：宿主无 tools 服务（registry=null）时安全跳过、不抛错', async () => {
  const root = makeTempRoot('wp4b-wire-notools-');
  try {
    const wiring = wireMemoryTools({
      registry: null,
      mode: 'shadow',
      indexDir: path.join(root, 'projection', 'memory-index'),
      now: NOW,
      channel: 'dsh',
    });
    assert.equal(wiring.registered, false);
    await wiring.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

for (const mode of ['shadow', 'on'] as MemoryGateMode[]) {
  test(`WP4b 接线：mode=${mode} 注册恰六工具，dispose 全注销且幂等`, async () => {
    const root = makeTempRoot(`wp4b-wire-${mode}-`);
    try {
      const fake = makeFakeRegistry();
      const wiring = wireMemoryTools({
        registry: fake.registry,
        mode,
        indexDir: path.join(root, 'projection', 'memory-index'),
        now: NOW,
        channel: 'dsh',
      });
      assert.equal(wiring.registered, true);
      assert.equal(fake.definitions.length, 6);
      await wiring.dispose();
      assert.equal(fake.unregisterCount(), 6);
      await wiring.dispose();
      assert.equal(fake.unregisterCount(), 6, '重复 dispose 不得再次注销');
    } finally {
      cleanupTempRoot(root);
    }
  });
}

test('WP4b 接线：shadow 态检索工具恒定回 observing 空信封（无 source 键），description 明示观测期不可用', async () => {
  const root = makeTempRoot('wp4b-wire-shadow-observing-');
  try {
    const fake = makeFakeRegistry();
    const wiring = wireMemoryTools({
      registry: fake.registry,
      mode: 'shadow',
      indexDir: path.join(root, 'projection', 'memory-index'),
      now: NOW,
      channel: 'dsh',
    });
    assert.equal(wiring.registered, true);
    const search = fake.definitions.find((d) => d.name === MEMORY_TOOL_NAMES.gatedSearch) as ToolDefinition;
    assert.ok(
      String(search.description).includes('观测期检索不可用'),
      '工具 description 必须显式声明观测期检索不可用（设计正本 7.2）',
    );
    const result = await callTool(search, { text: '任意词' });
    assert.equal(result.ok, true);
    const data = result.data as { status: string; cards: unknown[] };
    assert.equal(data.status, 'observing');
    assert.deepEqual(data.cards, []);
    assert.ok(!('source' in data), '空信封不得携带 source 双形态键');
    await wiring.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

// ── #115 红相：通道二两个回查工具（4→6）、显式键白名单、fail-closed 与翻页话术 ──
//
// 下列符号绿相才落地：MEMORY_TOOL_NAMES.experienceSummary/rawText、OpenDshMemoryBridgeInput
// 的 channel 注入、RawTurnLookupView 信封、ChannelBoundaryError 安全码映射。红相 tsc/运行期必红。

function makeSpyPort(poisonSummary = false, rawThrows?: Error) {
  const summaryCalls: string[] = [];
  const rawCalls: Pointer[] = [];
  const validSummary = projectExperienceSummary(makeExperience());
  const summary: ExperienceSummaryView = poisonSummary
    ? { ...validSummary, rawText: '走私原文' } as ExperienceSummaryView
    : validSummary;
  const envelope: RawTurnLookupView = {
    turns: [{ channel: 'dsh', shard: '2026-11', seq: 1, eventId: 'e1', rawText: '通道二原文' }],
    truncated: false,
    totalTurns: 1,
    totalChars: 5,
    midRow: false,
    nextSeq: null,
    nextCharOffset: null,
  };
  const port: SourceLookupPort = {
    async summaryByAnchor(anchorId: string) {
      summaryCalls.push(anchorId);
      return summary;
    },
    async resolveRawText(pointer: Pointer) {
      rawCalls.push(pointer);
      if (rawThrows !== undefined) throw rawThrows;
      return envelope;
    },
  };
  return { port, summaryCalls, rawCalls, validSummary, envelope };
}

for (const mode of ['shadow', 'on'] as MemoryGateMode[]) {
  test(`#115 B1（${mode}）：注册面 4→6，两新工具名在册且与 MEMORY_TOOL_NAMES 一一对应`, async () => {
    const root = makeTempRoot(`wp4b-lookup-six-${mode}-`);
    try {
      const bridge = openDshMemoryBridge({
        indexDir: path.join(root, 'projection', 'memory-index'),
        mode,
        now: NOW,
        channel: 'dsh',
        sourceLookup: makeSpyPort().port,
      });
      const names = bridge.definitions.map((d) => d.name).sort();
      assert.deepEqual(names, [
        MEMORY_TOOL_NAMES.addMissAlias,
        MEMORY_TOOL_NAMES.cardsByAnchor,
        MEMORY_TOOL_NAMES.experienceSummary,
        MEMORY_TOOL_NAMES.gatedSearch,
        MEMORY_TOOL_NAMES.rawText,
        MEMORY_TOOL_NAMES.resolvePointer,
      ].sort());
      assert.equal(bridge.definitions.length, 6, '通道二回查两工具净增，注册面 4→6');
      await bridge.dispose();
    } finally {
      cleanupTempRoot(root);
    }
  });
}

test('#115 B2：两工具 description 标明通道二回查专用；参数 schema 无 channel 键，原文工具含 seq 区间翻页话术', async () => {
  const root = makeTempRoot('wp4b-lookup-desc-');
  try {
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'on',
      now: NOW,
      channel: 'dsh',
      sourceLookup: makeSpyPort().port,
    });
    const tools = byName(bridge);
    const summaryDef = tools.get(MEMORY_TOOL_NAMES.experienceSummary) as ToolDefinition;
    const rawDef = tools.get(MEMORY_TOOL_NAMES.rawText) as ToolDefinition;

    for (const def of [summaryDef, rawDef]) {
      assert.ok(String(def.description).includes('通道二回查'), `${def.name} 必须写明通道二回查专用、返回正文`);
    }
    assert.ok(
      String(rawDef.description).includes('seq') && String(rawDef.description).includes('区间'),
      '截断后必须告知她用 Pointer.seq 区间翻页取剩余部分，truncated 不能是死胡同',
    );
    assert.ok(
      String(rawDef.description).includes('charOffset') && String(rawDef.description).includes('midRow'),
      '单行自身超闸时行内剩余只能用 charOffset 续取，话术必须写明，否则 midRow 是新死胡同',
    );
    assert.ok(
      String(rawDef.description).includes('nextSeq') && String(rawDef.description).includes('nextCharOffset'),
      '话术必须锁死续取配对：用 nextSeq 起、保留原上界作为 seq 区间、带 nextCharOffset',
    );
    assert.ok(
      String(rawDef.description).includes('首行') && String(rawDef.description).includes('上界'),
      'charOffset 语义必须写明"作用于本次解析首行"，且续取保留原区间上界以一次取完尾部',
    );
    assert.ok(
      String(rawDef.description).includes('作为下一次调用的 seq')
        && String(rawDef.description).includes('作为下一次调用的 charOffset'),
      '续取话术必须写死参数映射：信封 nextSeq 映射为 seq、nextCharOffset 映射为 charOffset；'
        + 'schema 没有这两个同名参数，让模型直传会被白名单剥掉并重复取同一段',
    );

    const summaryParams = summaryDef.parameters as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(summaryParams.properties).sort(), ['experienceId']);
    const rawParams = rawDef.parameters as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(rawParams.properties).sort(), ['charOffset', 'id', 'seq', 'shard']);
    assert.ok(!('channel' in rawParams.properties), '模型侧 schema 不得出现 channel：通道只能 L6 盖章');
    assert.ok(!rawParams.required.includes('charOffset'), 'charOffset 只在 midRow 续取时按需传入');
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('#115 B3：摘要/原文 happy path 经端口窄 DTO 返回，入参只透传白名单键', async () => {
  const root = makeTempRoot('wp4b-lookup-happy-');
  try {
    const spy = makeSpyPort();
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'on',
      now: NOW,
      channel: 'dsh',
      sourceLookup: spy.port,
    });
    const tools = byName(bridge);

    const summaryResult = await callTool(
      tools.get(MEMORY_TOOL_NAMES.experienceSummary) as ToolDefinition,
      { experienceId: spy.validSummary.id },
    );
    assert.equal(summaryResult.ok, true);
    assert.deepEqual(summaryResult.data, spy.validSummary);
    assert.deepEqual(spy.summaryCalls, [spy.validSummary.id]);

    const rawResult = await callTool(tools.get(MEMORY_TOOL_NAMES.rawText) as ToolDefinition, {
      id: 'raw_1',
      shard: '2026-11',
      seq: 1,
    });
    assert.equal(rawResult.ok, true);
    assert.deepEqual(rawResult.data, spy.envelope);
    assert.deepEqual(spy.rawCalls[0], { id: 'raw_1', shard: '2026-11', seq: 1, channel: 'dsh' });
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('#115 B4：模型私传 channel/未知键一律显式剥离，执行体永远收不到模型 channel（不依赖框架自动过滤）', async () => {
  const root = makeTempRoot('wp4b-lookup-whitelist-');
  try {
    const spy = makeSpyPort();
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'on',
      now: NOW,
      channel: 'dsh',
      sourceLookup: spy.port,
    });
    const rawDef = byName(bridge).get(MEMORY_TOOL_NAMES.rawText) as ToolDefinition;

    const result = await callTool(rawDef, {
      id: 'raw_1',
      shard: '2026-11',
      seq: [1, 3],
      channel: 'evil-channel',
      rogue: 'x',
    });
    assert.equal(result.ok, true);
    const received = spy.rawCalls[0]!;
    assert.equal(received.channel, 'dsh', '模型私传的异通道必须被剥离，盖上 L6 注入通道');
    assert.deepEqual(Object.keys(received).sort(), ['channel', 'id', 'seq', 'shard'], '显式键白名单：未知键不到执行体');
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('#115 B5：端口未注入（null 缺省）时两工具 fail-closed 返回 unavailable，不吞成空成功', async () => {
  const root = makeTempRoot('wp4b-lookup-null-');
  try {
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'on',
      now: NOW,
      channel: 'dsh',
    });
    const tools = byName(bridge);
    const summaryResult = await callTool(
      tools.get(MEMORY_TOOL_NAMES.experienceSummary) as ToolDefinition,
      { experienceId: 'exp_1' },
    );
    const rawResult = await callTool(tools.get(MEMORY_TOOL_NAMES.rawText) as ToolDefinition, {
      id: 'raw_1',
      seq: 1,
    });
    assert.equal(summaryResult.ok, false);
    assert.equal(summaryResult.error?.code, 'unavailable');
    assert.equal(summaryResult.data, undefined);
    assert.equal(rawResult.ok, false);
    assert.equal(rawResult.error?.code, 'unavailable');
    assert.equal(rawResult.data, undefined);
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('#115 B6：端口层 ChannelBoundaryError 翻译成稳定安全码 channel-boundary', async () => {
  const root = makeTempRoot('wp4b-lookup-boundary-');
  try {
    const spy = makeSpyPort(false, new ChannelBoundaryError('Pointer 通道与注入通道不一致，拒绝跨通道读取'));
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'on',
      now: NOW,
      channel: 'dsh',
      sourceLookup: spy.port,
    });
    const result = await callTool(byName(bridge).get(MEMORY_TOOL_NAMES.rawText) as ToolDefinition, {
      id: 'raw_1',
      seq: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'channel-boundary');
    assert.equal(result.data, undefined);
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('#115 B7：端口返回污染形状（多余字段）时边界拒收，失败信封不夹带数据', async () => {
  const root = makeTempRoot('wp4b-lookup-poison-');
  try {
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'on',
      now: NOW,
      channel: 'dsh',
      sourceLookup: makeSpyPort(true).port,
    });
    const result = await callTool(
      byName(bridge).get(MEMORY_TOOL_NAMES.experienceSummary) as ToolDefinition,
      { experienceId: 'exp_1' },
    );
    assert.equal(result.ok, false, '键集守卫不允许污染 DTO 出桥');
    assert.equal(result.data, undefined);
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('#115 B8：charOffset/seq 键存在但形状非法时 fail-closed，零端口调用、绝不静默降级', async () => {
  const root = makeTempRoot('wp4b-lookup-badargs-');
  // JSON schema 子集表达不了的形状（无 minimum/元组长度约束）：必须由桥接执行体自己拒收，回稳定信封码。
  const envelopeRejected: ReadonlyArray<Record<string, unknown>> = [
    { id: 'raw_1', seq: 1, charOffset: -5 },
    { id: 'raw_1', seq: [1] },
    { id: 'raw_1', seq: [1, 2, 3] },
  ];
  // JSON schema 子集本身即可判死的形状：defineTool 包装层在 userExecute 之前抛 ToolArgsError，
  // 同样属于 fail-closed（拒绝而非降级），且端口同样零调用。
  const frameworkRejected: ReadonlyArray<Record<string, unknown>> = [
    { id: 'raw_1', seq: 1, charOffset: 1.5 },
    { id: 'raw_1', seq: '1' },
    { id: 'raw_1', seq: [1, '3'] },
  ];
  try {
    for (const badArgs of envelopeRejected) {
      const spy = makeSpyPort();
      const bridge = openDshMemoryBridge({
        indexDir: path.join(root, 'projection', 'memory-index'),
        mode: 'on',
        now: NOW,
        channel: 'dsh',
        sourceLookup: spy.port,
      });
      const result = await callTool(
        byName(bridge).get(MEMORY_TOOL_NAMES.rawText) as ToolDefinition,
        badArgs,
      );
      assert.equal(result.ok, false, `非法入参不得被吞成成功：${JSON.stringify(badArgs)}`);
      assert.equal(result.error?.code, 'schema', '越过框架 schema 的形状由桥接统一稳定码 schema 拒绝');
      assert.equal(result.data, undefined, '失败信封不夹带数据');
      assert.equal(spy.rawCalls.length, 0, '拒绝发生在端口调用之前，非法参数零 IO，不存在静默从头读');
      await bridge.dispose();
    }
    for (const badArgs of frameworkRejected) {
      const spy = makeSpyPort();
      const bridge = openDshMemoryBridge({
        indexDir: path.join(root, 'projection', 'memory-index'),
        mode: 'on',
        now: NOW,
        channel: 'dsh',
        sourceLookup: spy.port,
      });
      await assert.rejects(
        callTool(byName(bridge).get(MEMORY_TOOL_NAMES.rawText) as ToolDefinition, badArgs),
        /invalid arguments/,
        `框架 schema 校验必须硬拒：${JSON.stringify(badArgs)}`,
      );
      assert.equal(spy.rawCalls.length, 0, '框架层拒收同样不得触达端口');
      await bridge.dispose();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('#115 B9：端口返 null（查无/异通道按未找到）时回 not-found，与 unavailable、成功信封三分形', async () => {
  const root = makeTempRoot('wp4b-lookup-notfound-');
  try {
    const nullPort: SourceLookupPort = {
      async summaryByAnchor() {
        return null;
      },
      async resolveRawText() {
        throw new Error('本用例不应触发原文路径');
      },
    };
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'on',
      now: NOW,
      channel: 'dsh',
      sourceLookup: nullPort,
    });
    const result = await callTool(
      byName(bridge).get(MEMORY_TOOL_NAMES.experienceSummary) as ToolDefinition,
      { experienceId: 'missing' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'not-found');
    assert.equal(result.data, undefined);
    await bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});
