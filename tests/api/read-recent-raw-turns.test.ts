/**
 * 对话第一刀门面红测：Fasti.readRecentRawTurns —— 从 append-only 原文真源重建近期对话。
 *
 * 设计约束：
 *  - 纯读窄 DTO，只回 speaker / raw_text（聊天组上下文所需的最小面），不回 content_hash 等内部字段；
 *  - 跨分片按时间顺序返回尾部 N 条；通道未注册 fail-closed；limit 形状非法在任何 IO 前拒绝；
 *  - 方法落地前本文件编译即红。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fasti } from '../../src/api/index.ts';
import type { ChannelDescriptor } from '../../src/contract/channel.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const CHANNEL = 'chatread';
const descriptor: ChannelDescriptor = {
  id: CHANNEL,
  label: '聊天读取测试通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'chatread-0',
};

async function seedTurns(fasti: Fasti, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await fasti.ingestRawTurn(CHANNEL, {
      event_id: `evt-${i}`,
      speaker: i % 2 === 0 ? 'user' : 'assistant',
      initiation: i % 2 === 0 ? 'user' : 'her',
      raw_text: `第 ${i} 句`,
    });
  }
}

test('readRecentRawTurns：按摄入顺序返回尾部 N 条，且只有 speaker/raw_text 两个白名单键', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.registerChannel(descriptor);
    await seedTurns(fasti, 5);

    const rows = await fasti.readRecentRawTurns(CHANNEL, 3);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.raw_text),
      ['第 2 句', '第 3 句', '第 4 句'],
    );
    assert.deepEqual(
      rows.map((row) => row.speaker),
      ['user', 'assistant', 'user'],
    );
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['raw_text', 'speaker'], '窄 DTO 不得夹带内部字段');
    }

    const all = await fasti.readRecentRawTurns(CHANNEL, 100);
    assert.equal(all.length, 5, 'limit 大于存量时返回全部，不补空行');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('readRecentRawTurns：未注册通道 fail-closed，limit 非法在 IO 前拒绝', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.registerChannel(descriptor);
    await seedTurns(fasti, 2);

    await assert.rejects(
      () => fasti.readRecentRawTurns('never-registered', 10),
      (error: unknown) => error instanceof Error && error.name === 'NotFoundError',
    );
    for (const bad of [0, -1, 1.5, 101, Number.NaN]) {
      await assert.rejects(
        () => fasti.readRecentRawTurns(CHANNEL, bad),
        (error: unknown) => error instanceof Error && error.name === 'SchemaError',
        `limit=${String(bad)} 必须被 SchemaError 拒绝`,
      );
    }
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
