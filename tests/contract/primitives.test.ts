/**
 * 原语契约测试（审计第四节阶段 0 验收项：
 * 「原语 .d.ts 契约齐全（§9 全部原语），错误约定明确」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFERRED_PRIMITIVES,
  PRIMITIVE_NAMES,
  type FastiPrimitives,
} from '../../src/contract/primitives.ts';
import { Fasti } from '../../src/api/index.ts';
import { NotImplementedError } from '../../src/core/errors.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

test('§9 全部原语都在契约里（15 项，无遗漏）', () => {
  const expected = [
    'registerChannel',
    'appendExperience',
    'ingestRawTurn',
    'ingestMedia',
    'preserveMedia',
    'query',
    'search',
    'queryEntity',
    'queryEdges',
    'resolvePointer',
    'getMedia',
    'tick',
    'rebuildProjections',
    'verifyIntegrity',
    'verifyChannel',
  ];
  assert.deepEqual([...PRIMITIVE_NAMES].sort(), [...expected].sort());
  assert.equal(PRIMITIVE_NAMES.length, 15);
});

test('Fasti 实现了契约的全部原语（结构检查）', () => {
  const methods: Array<keyof FastiPrimitives> = [
    'registerChannel',
    'appendExperience',
    'ingestRawTurn',
    'ingestMedia',
    'preserveMedia',
    'query',
    'search',
    'queryEntity',
    'queryEdges',
    'resolvePointer',
    'getMedia',
    'tick',
    'rebuildProjections',
    'verifyIntegrity',
    'verifyChannel',
  ];
  for (const method of methods) {
    assert.equal(typeof Fasti.prototype[method], 'function', `缺少原语 ${method}`);
  }
});

test('阶段 0–2 之外的原语抛 NotImplementedError（不静默返回空）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await assert.rejects(() => fasti.ingestMedia(undefined, {}), NotImplementedError);
    await assert.rejects(() => fasti.preserveMedia('ref-1'), NotImplementedError);
    await assert.rejects(() => fasti.getMedia('ref-1'), NotImplementedError);
    await assert.rejects(() => fasti.queryEntity('ent-1'), NotImplementedError);

    assert.deepEqual([...DEFERRED_PRIMITIVES].sort(), [
      'getMedia',
      'ingestMedia',
      'preserveMedia',
      'queryEntity',
    ]);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('错误约定明确：缺指针 / 越界 / 坏哈希一律抛错，不返回空', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    // 缺指针定位信息。
    await assert.rejects(() => fasti.resolvePointer({}), /指针缺少定位信息/);

    // 指针目标不存在。
    await assert.rejects(() => fasti.resolvePointer({ id: 'nope', channel: 'dsh' }), /指针目标不存在/);

    // 越界。
    await assert.rejects(
      () => fasti.resolvePointer({ channel: 'dsh', shard: '2026-11', seq: 99 }),
      /指针越界/,
    );
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('query 对不存在的通道返回空数组（查询无命中不是错误）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    assert.deepEqual(await fasti.query({ channel: 'nonexistent' }), []);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
