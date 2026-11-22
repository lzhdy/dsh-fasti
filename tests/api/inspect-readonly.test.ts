/**
 * 网页控制台 #157 门面只读检视面红测（先红后绿）。
 *
 * 三个纯读原语，专供本机 loopback 观测台使用，不新增任何写路径、不改真源语义：
 *  - inspectRawTurns：完整原文行（8 字段＋shard/seq 定位），分页带硬上限；
 *  - inspectExperience：按 id 取完整经历（窄 DTO readExperienceById 不给内部指针，观测台要全量）；
 *  - inspectRuntime：一次取齐引擎档位/检查点/启动对账/事件层/各层计数，喂启动屏与状态顶栏。
 *
 * 纪律：未注册通道 fail-closed（NotFoundError）；分页参数形状非法在任何 IO 前 SchemaError；
 * 未知经历 id 返回 null（不抛、不造空对象）。方法落地前本文件运行即红。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fasti } from '../../src/api/index.ts';
import type { ChannelDescriptor } from '../../src/contract/channel.ts';
import { RAW_TURN_FIELDS } from '../../src/contract/raw-turn.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const CHANNEL = 'inspect';
const descriptor: ChannelDescriptor = {
  id: CHANNEL,
  label: '检视面测试通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'inspect-0',
};

async function seedTurns(fasti: Fasti, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const written = await fasti.ingestRawTurn(CHANNEL, {
      event_id: `evt-${i}`,
      speaker: i % 2 === 0 ? 'user' : 'assistant',
      initiation: i % 2 === 0 ? 'user' : 'her',
      raw_text: `第 ${i} 句原话`,
    });
    ids.push(written.id);
  }
  return ids;
}

test('inspectRawTurns：返回完整 8 字段原文行与 shard/seq 定位，按摄入顺序排列', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.registerChannel(descriptor);
    await seedTurns(fasti, 3);

    const page = await fasti.inspectRawTurns(CHANNEL);
    assert.equal(page.channel, CHANNEL);
    assert.equal(page.total, 3);
    assert.equal(page.turns.length, 3);
    assert.deepEqual(
      page.turns.map((row) => row.seq),
      [0, 1, 2],
      'seq 从 0 起按序',
    );
    for (const row of page.turns) {
      assert.match(row.shard, /^\d{4}-\d{2}$/u, 'shard 是 YYYY-MM 月分片键');
      assert.equal(typeof row.turn.event_id, 'string');
      assert.deepEqual(
        Object.keys(row.turn).sort(),
        [...RAW_TURN_FIELDS].sort(),
        '观测台看真源必须是完整 8 字段，不许窄化',
      );
      assert.equal(row.turn.content_hash.length, 64);
    }
    assert.equal(page.turns[0]?.turn.raw_text, '第 0 句原话');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('inspectRawTurns：limit/offset 分页生效，参数非法在 IO 前拒绝', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.registerChannel(descriptor);
    await seedTurns(fasti, 5);

    const first = await fasti.inspectRawTurns(CHANNEL, { limit: 2 });
    assert.equal(first.turns.length, 2);
    assert.equal(first.turns[0]?.turn.event_id, 'evt-0');
    const second = await fasti.inspectRawTurns(CHANNEL, { limit: 2, offset: 2 });
    assert.equal(second.turns.length, 2);
    assert.equal(second.turns[0]?.turn.event_id, 'evt-2');
    const tail = await fasti.inspectRawTurns(CHANNEL, { limit: 2, offset: 4 });
    assert.equal(tail.turns.length, 1, '越界部分不补空行');

    for (const badLimit of [0, -1, 1.5, 101, Number.NaN]) {
      await assert.rejects(
        () => fasti.inspectRawTurns(CHANNEL, { limit: badLimit }),
        (error: unknown) => error instanceof Error && error.name === 'SchemaError',
        `limit=${String(badLimit)} 必须被 SchemaError 拒绝`,
      );
    }
    for (const badOffset of [-1, 1.5, Number.NaN]) {
      await assert.rejects(
        () => fasti.inspectRawTurns(CHANNEL, { offset: badOffset }),
        (error: unknown) => error instanceof Error && error.name === 'SchemaError',
        `offset=${String(badOffset)} 必须被 SchemaError 拒绝`,
      );
    }

    await assert.rejects(
      () => fasti.inspectRawTurns('never-registered'),
      (error: unknown) => error instanceof Error && error.name === 'NotFoundError',
      '未注册通道必须 fail-closed',
    );
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('inspectExperience：按 id 取完整经历；未知 id 返回 null', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.registerChannel(descriptor);
    const [firstId] = await seedTurns(fasti, 2);

    const found = await fasti.inspectExperience(firstId ?? '');
    assert.ok(found !== null);
    assert.equal(found?.id, firstId);
    assert.equal(typeof found?.tick, 'number');
    assert.ok(found?.observation.text !== undefined, '完整经历必须带原文指针（窄 DTO 才剥它）');
    assert.equal(found?.scene.channel, CHANNEL);

    assert.equal(await fasti.inspectExperience('no-such-id-000000'), null);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('inspectRuntime：一次取齐引擎/检查点/对账/事件层/各层计数，重启后仍可读', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.registerChannel(descriptor);
    await seedTurns(fasti, 4);

    const snapshot = await fasti.inspectRuntime();
    assert.ok(['L1', 'L2', 'L3'].includes(snapshot.engine.level));
    assert.equal(typeof snapshot.engine.degraded, 'boolean');
    assert.equal(typeof snapshot.engine.reason, 'string');
    assert.equal(snapshot.eventLayer.available, true);
    assert.equal(snapshot.checkpoint.tick, 3, '检查点 tick = 已分配最大 tick');
    // 启动对账是「开门时刻」的快照：本进程开门时真源为空，故停在 -1/-1/0；
    // 启动后写入不回改它（重开进程才重新对账，见下面重开段）。
    assert.deepEqual(snapshot.reconciliation, {
      sourceMaxTick: -1,
      lastProjectedTick: -1,
      folded: 0,
    });
    assert.equal(snapshot.counts.experiences, 4);
    assert.equal(snapshot.counts.rawTurns.find((row) => row.channel === CHANNEL)?.count, 4);
    assert.ok(snapshot.counts.events !== null);
    assert.equal(snapshot.counts.events.total, 1, '四句同属一个 open 事件');
    assert.equal(snapshot.counts.events.open, 1);
    assert.equal(typeof snapshot.pendingSummaryCount, 'number');
    assert.ok(snapshot.channels.some((row) => row.id === CHANNEL));
  } finally {
    await fasti.close();
  }

  // 重开同一数据根：快照口径不依赖进程内状态，仍然自洽。
  const reopened = await Fasti.open({ dataRoot: root });
  try {
    const snapshot = await reopened.inspectRuntime();
    assert.equal(snapshot.counts.experiences, 4);
    assert.equal(snapshot.checkpoint.tick, 3);
    assert.equal(snapshot.eventLayer.available, true);
    // 重开后启动对账读到真实尾差：真源 max=3、已投影到 3、无需补折。
    assert.deepEqual(snapshot.reconciliation, {
      sourceMaxTick: 3,
      lastProjectedTick: 3,
      folded: 0,
    });
  } finally {
    await reopened.close();
    cleanupTempRoot(root);
  }
});
