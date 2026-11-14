/**
 * WP4b 宿主无关装配工厂测试（内核侧，不 import 任何 @deepseek-ai/* 宿主包）。
 *
 * 该工厂是薄壳与记忆内核之间唯一的宿主无关编排点：打开窄柄（缺库降级 null）、
 * 把影子 sink 注入 createMemoryTools、统一 dispose，并提供模型回显卡的 N14 白名单投影。
 * #114 拆除后旁路检索端口已不存在：off fail-closed、shadow 回 observing 空信封、on 唯一走门。
 * DSH 薄壳只负责 defineTool 形状，不直接接触 memory/。
 *
 * 纪律：临时根、零真实数据；时钟注入，无 Date.now() 依赖。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { computeContentHash } from '../../src/memory/builder.ts';
import { openMemoryRuntime } from '../../src/memory/runtime.ts';
import { SHADOW_DIRNAME, SHADOW_LOG_FILE } from '../../src/memory/shadow-write.ts';
import { MEMORY_INDEX_FILE, openMemoryWrite } from '../../src/memory/store.ts';
import type { AliasRow, MemoryCard, RevisionRecord } from '../../src/memory/types.ts';
import {
  openAssembledMemoryTools,
  projectCardForHost,
  type AssembledMemoryRuntime,
  type HostCardView,
} from '../../src/assembly/host-tool-runtime.ts';
import { UnavailableError } from '../../src/core/errors.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const FIXED_NOW = T0 + 123;

/** 在 root/projection/memory-index 建一张带敏感别名的卡，返回 indexDir。 */
function seedOneCard(root: string): string {
  const indexDir = path.join(root, 'projection', 'memory-index');
  const anchorJson = JSON.stringify(['01J0000000000000000000001']);
  const displayCuesJson = JSON.stringify(['咖啡馆约会']);
  const aliasesJson = JSON.stringify([{ term: '咖啡馆', source: 'miss', sensitive: 1 }]);
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
  ];
  const revision: RevisionRecord = {
    revision: 1,
    slug: 'build',
    at_ms: T0,
    schema_version: 1,
    truth_fingerprint: 'fp-wp4b-test',
    prior_revision: null,
    card_count: 1,
    alias_count: 1,
    row_hash_sum: 'rh-wp4b-test',
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

test('WP4b 装配工厂：索引库不存在时降级 indexReady=false 且不创建文件、dispose 幂等', async () => {
  const root = makeTempRoot('wp4b-missing-');
  try {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const rt = openAssembledMemoryTools({
      indexDir,
      mode: 'off',
      now: () => FIXED_NOW,
    });
    assert.equal(rt.indexReady, false);
    assert.ok(!fs.existsSync(path.join(indexDir, MEMORY_INDEX_FILE)), '降级不得侧建索引文件');

    // 缺库且 off：内核 fail-closed，不返回任何候选（off 生产环境靠不注册，此处验证兜底）。
    await assert.rejects(() => rt.tools.gatedSearch({ text: '随便什么' }), UnavailableError);

    await rt.dispose();
    await rt.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 装配工厂：off 态门控检索 fail-closed，别名写 deferred，窄柄零触达', async () => {
  const root = makeTempRoot('wp4b-off-');
  try {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const rt = openAssembledMemoryTools({
      indexDir,
      mode: 'off',
      now: () => FIXED_NOW,
    });
    await assert.rejects(
      () => rt.tools.gatedSearch({ text: '关键词甲' }),
      UnavailableError,
      'off 态无门控召回可用，必须显式报错而非静默造结果',
    );
    const aliasView = rt.tools.addMissAlias({ term: '关键词甲', cardId: 'mc_x' });
    assert.deepEqual(aliasView, { deferred: true, mode: 'off', reason: 'gate-not-on' });
    assert.ok(!fs.existsSync(path.join(indexDir, MEMORY_INDEX_FILE)), 'fail-closed 不得侧建任何库文件');
    await rt.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 装配工厂：真实库 on 态窄柄命中（indexReady=true，门控是唯一召回路径）', async () => {
  const root = makeTempRoot('wp4b-on-');
  try {
    const indexDir = seedOneCard(root);
    const rt = openAssembledMemoryTools({
      indexDir,
      mode: 'on',
      now: () => FIXED_NOW,
    });
    assert.equal(rt.indexReady, true);
    const view = await rt.tools.gatedSearch({ text: '咖啡馆' });
    assert.equal(view.status, 'hit', `别名命中门控状态应为 hit，实际 ${view.status}`);
    assert.ok(!('source' in view), '拆除后信封单形态，无 source 键');
    assert.ok(view.cards.length >= 1, '应命中至少一张门控卡');
    await rt.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 装配工厂：shadow 态对外 observing 空信封且影子落盘字段映射正确（observedMs=时钟、无原始词明文）', async () => {
  const root = makeTempRoot('wp4b-shadow-');
  try {
    const indexDir = seedOneCard(root);
    const rt = openAssembledMemoryTools({
      indexDir,
      mode: 'shadow',
      now: () => FIXED_NOW,
    });
    // 用一个不会命中的词，得到 no-match 影子观测；对外只回定死空信封。
    const view = await rt.tools.gatedSearch({ text: '不存在的冷词XYZ' });
    assert.equal(view.status, 'observing');
    assert.deepEqual(view.cards, []);
    assert.deepEqual(view.serialMap, new Map());
    assert.ok(!('source' in view));
    await rt.dispose();

    const shadowFile = path.join(root, 'projection', SHADOW_DIRNAME, SHADOW_LOG_FILE);
    assert.ok(fs.existsSync(shadowFile), '影子日志应落盘在 projection/memory-shadow');
    const lines = fs
      .readFileSync(shadowFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    assert.ok(lines.length >= 1, '至少一行影子观测');
    const row = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    assert.equal(row.observedMs, FIXED_NOW, 'atMs 必须映射为 observedMs');
    assert.equal(row.gatedStatus, 'no-match');
    assert.equal(typeof row.termHash, 'string', '只落不可逆 termHash');
    for (const forbidden of ['termNorm', 'term', 'rawQuery', 'sensitive']) {
      assert.ok(!(forbidden in row), `影子行不得含明文/敏感字段 ${forbidden}`);
    }
    assert.ok(!JSON.stringify(row).includes('不存在的冷词XYZ'), '影子行不得回显原始词');
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 装配工厂：缺库时 shadow 回 observing 空信封不抛，不侧建影子目录', async () => {
  const root = makeTempRoot('wp4b-shadow-missing-');
  try {
    const rt = openAssembledMemoryTools({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'shadow',
      now: () => FIXED_NOW,
    });
    const view = await rt.tools.gatedSearch({ text: '任意' });
    assert.equal(view.status, 'observing');
    assert.deepEqual(view.cards, []);
    const shadowDir = path.join(root, 'projection', SHADOW_DIRNAME);
    assert.ok(!fs.existsSync(shadowDir), '无窄柄不得创建影子目录');
    await rt.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('WP4b 装配工厂：projectCardForHost 仅回显白名单安全字段，剥离全部内部/敏感列', () => {
  const card: MemoryCard = {
    cardId: 'mc_x',
    eventId: 'evt-internal',
    anchorJson: JSON.stringify(['anchor1', 'anchor2']),
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0.37,
    displayCuesJson: JSON.stringify(['线索一', '线索二']),
    aliasesJson: JSON.stringify([{ term: '私密别名', source: 'miss', sensitive: 1 }]),
    discriminator: '消歧短句',
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: 'deadbeef',
    hitCount: 9,
    lastHitMs: null,
    schemaVersion: 1,
  };
  const view: HostCardView = projectCardForHost(card);
  assert.deepEqual(view.anchorIds, ['anchor1', 'anchor2']);
  assert.deepEqual(view.displayCues, ['线索一', '线索二']);
  assert.equal(view.cardId, 'mc_x');
  assert.equal(view.channel, 'dsh');
  assert.equal(view.cardType, 'event');
  assert.equal(view.discriminator, '消歧短句');

  const json = JSON.stringify(view);
  for (const forbidden of [
    'aliasesJson',
    'aliases',
    'sensitive',
    'eventId',
    'weight',
    'contentHash',
    'entityHintJson',
    'validMs',
    'hitCount',
    '私密别名',
  ]) {
    assert.ok(!json.includes(forbidden), `模型回显不得包含内部/敏感字段或值：${forbidden}`);
  }
});

test('WP4b 装配工厂：返回对象满足装配面契约（四方法可读、dispose 为函数）', () => {
  const root = makeTempRoot('wp4b-shape-');
  try {
    const rt: AssembledMemoryRuntime = openAssembledMemoryTools({
      indexDir: path.join(root, 'projection', 'memory-index'),
      mode: 'off',
      now: () => FIXED_NOW,
    });
    assert.deepEqual(
      Object.keys(rt.tools).sort(),
      ['addMissAlias', 'gatedSearch', 'getCardsByAnchor', 'resolvePointer'].sort(),
    );
    assert.equal(typeof rt.dispose, 'function');
    void rt.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

// 仅引用 openMemoryRuntime 以保持与窄柄同源夹具的显式依赖说明（类型/用途对照）。
void openMemoryRuntime;
