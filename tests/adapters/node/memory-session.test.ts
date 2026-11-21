/**
 * node 身体记忆工具会话红测（对话第二刀：固定 on 的内存工具宿主）。
 *
 * 不引任何 @deepseek-ai/* 包：node 自己的薄壳直接装配宿主中立运行面，输出 OpenAI
 * function 形状的六工具描述符与字符串 JSON 信封。临时根、零真实数据。
 *
 * 覆盖：
 *  1. 六工具命名/JSON Schema 形状，模型侧任何 schema 都不含 channel 键；
 *  2. 索引未建（Q3 只开不建）→ indexReady=false，门工具回 unavailable 信封不炸；
 *  3. 有索引：gatedSearch 命中白名单 DTO、resolve 序号反查、会话间序号表隔离；
 *  4. 固定 on：addMissAlias 真写投影（不是 deferred）；
 *  5. 通道二：未知经历 not-found、raw 参数形状闸、rogue channel 键被剥离；
 *  6. 未知工具名/坏 JSON 回 schema 信封；dispose 幂等。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeContentHash } from '../../../src/memory/builder.ts';
import { openMemoryWrite } from '../../../src/memory/store.ts';
import type { AliasRow, MemoryCard, RevisionRecord } from '../../../src/memory/types.ts';
import { Fasti } from '../../../src/api/index.ts';
import { openNodeMemoryRuntime } from '../../../src/adapters/node/memory-session.ts';
import type { ChannelDescriptor } from '../../../src/contract/channel.ts';

const CHANNEL = 'webdemo';
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const NOW = () => T0 + 777;
const ANCHOR = '01JTESTANCHOR0000000000001';

const descriptor: ChannelDescriptor = {
  id: CHANNEL,
  label: '记忆会话测试通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'node-mem-0',
};

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-node-mem-'));
}

/** 直接走离线写柄种一张卡（运行期只开不建，测试夹具才允许建库）。 */
async function seedOneCard(root: string): Promise<string> {
  const indexDir = path.join(root, 'projection', 'memory-index');
  const anchorJson = JSON.stringify([ANCHOR]);
  const displayCuesJson = JSON.stringify(['咖啡馆约会']);
  const aliasesJson = JSON.stringify([{ term: '咖啡馆', source: 'miss', sensitive: 1 }]);
  const card: MemoryCard = {
    cardId: 'mc_seed',
    eventId: 'evt-seed',
    anchorJson,
    channel: CHANNEL,
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
  ];
  const revision: RevisionRecord = {
    revision: 1,
    slug: 'build',
    at_ms: T0,
    schema_version: 3,
    truth_fingerprint: 'fp-node-mem-test',
    prior_revision: null,
    card_count: 1,
    alias_count: 1,
    row_hash_sum: 'rh-node-mem-test',
    shadow_diff: { added: 1, removed: 0, changed: 0 },
    reason: 'test fixture',
    operator: 'offline-cli',
  };
  const handle = openMemoryWrite({ indexDir });
  try {
    handle.transactionApply({ cards: [card], aliases: aliasRows }, revision, []);
  } finally {
    await handle.close();
  }
  return indexDir;
}

async function openFasti(root: string): Promise<Fasti> {
  const fasti = await Fasti.open({ dataRoot: root, llmPort: null });
  await fasti.registerChannel(descriptor);
  return fasti;
}

async function call(
  session: { execute: (call: { id: string; name: string; argumentsText: string }) => Promise<string> },
  name: string,
  args: unknown,
  id = 'call-1',
): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message?: string } }> {
  const text = await session.execute({ id, name, argumentsText: JSON.stringify(args) });
  return JSON.parse(text) as { ok: boolean; data?: unknown; error?: { code: string; message?: string } };
}

test('六工具描述符：命名全集固定、参数是标准 JSON Schema 且全部不含 channel 键', async () => {
  const root = tempRoot();
  const fasti = await openFasti(root);
  try {
    const runtime = openNodeMemoryRuntime({ fasti, channel: CHANNEL, now: NOW });
    assert.deepEqual(
      runtime.tools.map((tool) => tool.name).sort(),
      [
        'fasti_memory_add_alias',
        'fasti_memory_cards_by_anchor',
        'fasti_memory_experience_summary',
        'fasti_memory_raw_text',
        'fasti_memory_resolve_pointer',
        'fasti_memory_search',
      ].sort(),
    );
    for (const tool of runtime.tools) {
      assert.equal(tool.parameters['type'], 'object', `${tool.name} 参数根必须是 object schema`);
      assert.equal(tool.parameters['additionalProperties'], false, `${tool.name} 显式拒收未知键`);
      const props = tool.parameters['properties'] as Record<string, unknown>;
      assert.ok(!('channel' in props), `${tool.name} 模型侧 schema 绝不暴露 channel`);
      assert.ok(tool.description.length > 0);
    }
    await runtime.dispose();
  } finally {
    await fasti.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('索引未建：indexReady=false，门工具显式 unavailable，纯对话能力不受影响', async () => {
  const root = tempRoot();
  const fasti = await openFasti(root);
  try {
    const runtime = openNodeMemoryRuntime({ fasti, channel: CHANNEL, now: NOW });
    assert.equal(runtime.indexReady, false);
    const session = runtime.createSession();
    const result = await call(session, 'fasti_memory_search', { text: '咖啡馆' });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'unavailable');
    await assert.doesNotReject(() => runtime.dispose());
    await assert.doesNotReject(() => runtime.dispose(), 'dispose 必须幂等');
  } finally {
    await fasti.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('有索引：gatedSearch 命中白名单 DTO，序号反查成功；新会话序号表互不可见', async () => {
  const root = tempRoot();
  await seedOneCard(root);
  const fasti = await openFasti(root);
  try {
    const runtime = openNodeMemoryRuntime({ fasti, channel: CHANNEL, now: NOW });
    assert.equal(runtime.indexReady, true);
    const sessionA = runtime.createSession();

    const search = await call(sessionA, 'fasti_memory_search', { text: '咖啡馆' });
    assert.equal(search.ok, true, JSON.stringify(search));
    const data = search.data as { status: string; cards: Array<Record<string, unknown>> };
    assert.equal(data.status, 'hit');
    assert.equal(data.cards.length, 1);
    const card = data.cards[0]!;
    for (const banned of ['sensitive', 'aliasesJson', 'contentHash', 'termNorm']) {
      assert.ok(!(banned in card), `白名单 DTO 不得含内部字段 ${banned}`);
    }
    assert.equal(card['cardId'], 'mc_seed');
    assert.deepEqual(card['displayCues'], ['咖啡馆约会']);

    const resolve = await call(sessionA, 'fasti_memory_resolve_pointer', { serials: [card['serial']] });
    assert.equal(resolve.ok, true);
    assert.deepEqual((resolve.data as { cardIds: string[] }).cardIds, ['mc_seed']);

    // 新会话没有自己的检索情节：序号上下文缺失，fail-closed。
    const sessionB = runtime.createSession();
    const staleAcrossSession = await call(sessionB, 'fasti_memory_resolve_pointer', { serials: [1] });
    assert.equal(staleAcrossSession.ok, false);
    assert.equal(staleAcrossSession.error?.code, 'serial-context-missing');

    await runtime.dispose();
  } finally {
    await fasti.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('固定 on：addMissAlias 在 node 身体真写投影，不返回 deferred', async () => {
  const root = tempRoot();
  await seedOneCard(root);
  const fasti = await openFasti(root);
  try {
    const runtime = openNodeMemoryRuntime({ fasti, channel: CHANNEL, now: NOW });
    const session = runtime.createSession();
    const result = await call(session, 'fasti_memory_add_alias', { term: '城南咖啡', cardId: 'mc_seed' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const data = (result.data ?? {}) as Record<string, unknown>;
    assert.ok(!('deferred' in data), 'node 身体固定 on，卡写不得 deferred');
    await runtime.dispose();
  } finally {
    await fasti.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('通道二：未知经历 not-found；raw 参数形状闸；rogue channel 键被盖章通道剥离', async () => {
  const root = tempRoot();
  await seedOneCard(root);
  const fasti = await openFasti(root);
  try {
    const runtime = openNodeMemoryRuntime({ fasti, channel: CHANNEL, now: NOW });
    const session = runtime.createSession();

    const missing = await call(session, 'fasti_memory_experience_summary', { experienceId: 'no-such-id' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, 'not-found');

    const badOffset = await call(session, 'fasti_memory_raw_text', { id: ANCHOR, seq: 0, charOffset: -5 });
    assert.equal(badOffset.ok, false);
    assert.equal(badOffset.error?.code, 'schema');

    const badSeq = await call(session, 'fasti_memory_raw_text', { id: ANCHOR, seq: '0' });
    assert.equal(badSeq.ok, false);
    assert.equal(badSeq.error?.code, 'schema');

    // 私传异通道键：白名单构造时必须剥离，绝不允许通道越权（端口只认盖章的 webdemo）。
    const rogue = await session.execute({
      id: 'call-rogue',
      name: 'fasti_memory_raw_text',
      argumentsText: JSON.stringify({ id: ANCHOR, seq: 0, channel: 'evil-channel' }),
    });
    const rogueEnvelope = JSON.parse(rogue) as { ok: boolean; error?: { code: string } };
    assert.notEqual(rogueEnvelope.error?.code, 'channel-boundary', '盖章通道下不应触发通道闸');
    assert.equal(rogueEnvelope.ok, false, '锚点无原文时按既有失败码返回，但不是越权失败');

    await runtime.dispose();
  } finally {
    await fasti.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('未知工具名与坏 JSON 一律 schema 信封，不抛异常', async () => {
  const root = tempRoot();
  const fasti = await openFasti(root);
  try {
    const runtime = openNodeMemoryRuntime({ fasti, channel: CHANNEL, now: NOW });
    const session = runtime.createSession();

    const unknown = await session.execute({ id: 'c1', name: 'rm_rf_everything', argumentsText: '{}' });
    assert.equal((JSON.parse(unknown) as { error: { code: string } }).error.code, 'schema');

    const broken = await session.execute({
      id: 'c2',
      name: 'fasti_memory_search',
      argumentsText: '{not-json',
    });
    assert.equal((JSON.parse(broken) as { error: { code: string } }).error.code, 'schema');

    await runtime.dispose();
  } finally {
    await fasti.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
