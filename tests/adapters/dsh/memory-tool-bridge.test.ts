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
import type { LegacyHit, MemoryGateMode } from '../../../src/assembly/memory-tools.ts';
import {
  MEMORY_TOOL_NAMES,
  openDshMemoryBridge,
  registerMemoryToolDefinitions,
  wireMemoryTools,
  type DshMemoryBridge,
  type DshToolRegistry,
} from '../../../src/adapters/dsh/memory-tool-bridge.ts';
import { cleanupTempRoot, makeTempRoot } from '../../helpers.ts';

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

function legacyHits(): (q: { text: string; limit?: number }) => Promise<LegacyHit[]> {
  return async (q) => [{ id: 'exp_legacy_1', kind: 'dialogue', channel: 'dsh', snippet: `命中:${q.text}` }];
}

/** 解析工具 execute 返回的字符串信封。 */
async function callTool(def: ToolDefinition, args: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> {
  const text = (await def.execute(args, EXEC)) as string;
  return JSON.parse(text) as { ok: boolean; data?: unknown; error?: { code: string } };
}

function byName(bridge: DshMemoryBridge): Map<string, ToolDefinition> {
  return new Map(bridge.definitions.map((d) => [d.name, d]));
}

test('WP4b 薄壳：恰注册四个记忆工具，命名/参数/字符串输出契约正确', async () => {
  const root = makeTempRoot('wp4b-bridge-shape-');
  try {
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'off',
      now: NOW,
      legacySearch: legacyHits(),
    });
    assert.deepEqual(
      bridge.definitions.map((d) => d.name).sort(),
      [
        MEMORY_TOOL_NAMES.addMissAlias,
        MEMORY_TOOL_NAMES.cardsByAnchor,
        MEMORY_TOOL_NAMES.gatedSearch,
        MEMORY_TOOL_NAMES.resolvePointer,
      ].sort(),
    );
    assert.equal(bridge.definitions.length, 4);

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

test('WP4b 薄壳：缺库 off 态走旧路、信封不泄漏 serialMap、门工具报 unavailable、别名 deferred', async () => {
  const root = makeTempRoot('wp4b-bridge-off-');
  try {
    const bridge = openDshMemoryBridge({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'off',
      now: NOW,
      legacySearch: legacyHits(),
    });
    const tools = byName(bridge);

    const searchResult = await callTool(tools.get(MEMORY_TOOL_NAMES.gatedSearch) as ToolDefinition, { text: '关键词' });
    assert.equal(searchResult.ok, true);
    const data = searchResult.data as { source: string; status: string; cards: unknown[] };
    assert.equal(data.source, 'legacy');
    assert.equal(data.status, 'legacy-ok');
    assert.ok(!('serialMap' in data), 'Map 不可 JSON 化且属内部状态，禁止回显给模型');

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
      legacySearch: legacyHits(),
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
    const bridge = openDshMemoryBridge({ indexDir, mode: 'on', now: NOW, legacySearch: legacyHits() });
    const tools = byName(bridge);
    const search = tools.get(MEMORY_TOOL_NAMES.gatedSearch) as ToolDefinition;
    const resolve = tools.get(MEMORY_TOOL_NAMES.resolvePointer) as ToolDefinition;

    const hit = await callTool(search, { text: '咖啡馆' });
    assert.equal(hit.ok, true);
    assert.equal((hit.data as { source: string }).source, 'gate');

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
    const bridge = openDshMemoryBridge({ indexDir, mode: 'on', now: NOW, legacySearch: legacyHits() });
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

test('WP4b 薄壳：register 聚合四个 disposer，注销时每个工具恰好注销一次', () => {
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
      legacySearch: legacyHits(),
    });
    const unregisterAll = registerMemoryToolDefinitions(registry, bridge.definitions);
    assert.equal(events.filter((e) => e.startsWith('reg:')).length, 4);
    unregisterAll();
    assert.equal(events.filter((e) => e.startsWith('unreg:')).length, 4);
    void bridge.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 薄壳：缺库降级不侧建索引文件，dispose 可重复调用不抛', async () => {
  const root = makeTempRoot('wp4b-bridge-dispose-');
  try {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const bridge = openDshMemoryBridge({ indexDir, mode: 'off', now: NOW, legacySearch: legacyHits() });
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
      legacySearch: legacyHits(),
      now: NOW,
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
      legacySearch: legacyHits(),
      now: NOW,
    });
    assert.equal(wiring.registered, false);
    await wiring.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

for (const mode of ['shadow', 'on'] as MemoryGateMode[]) {
  test(`WP4b 接线：mode=${mode} 注册恰四工具，dispose 全注销且幂等`, async () => {
    const root = makeTempRoot(`wp4b-wire-${mode}-`);
    try {
      const fake = makeFakeRegistry();
      const wiring = wireMemoryTools({
        registry: fake.registry,
        mode,
        indexDir: path.join(root, 'projection', 'memory-index'),
        legacySearch: legacyHits(),
        now: NOW,
      });
      assert.equal(wiring.registered, true);
      assert.equal(fake.definitions.length, 4);
      await wiring.dispose();
      assert.equal(fake.unregisterCount(), 4);
      await wiring.dispose();
      assert.equal(fake.unregisterCount(), 4, '重复 dispose 不得再次注销');
    } finally {
      cleanupTempRoot(root);
    }
  });
}

test('WP4b 接线：shadow 态注册的检索工具仍走旧路（影子不改模型所见召回）', async () => {
  const root = makeTempRoot('wp4b-wire-shadow-legacy-');
  try {
    const fake = makeFakeRegistry();
    const wiring = wireMemoryTools({
      registry: fake.registry,
      mode: 'shadow',
      indexDir: path.join(root, 'projection', 'memory-index'),
      legacySearch: legacyHits(),
      now: NOW,
    });
    assert.equal(wiring.registered, true);
    const search = fake.definitions.find((d) => d.name === MEMORY_TOOL_NAMES.gatedSearch) as ToolDefinition;
    const result = await callTool(search, { text: '任意词' });
    assert.equal(result.ok, true);
    assert.equal((result.data as { source: string }).source, 'legacy');
    await wiring.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});
