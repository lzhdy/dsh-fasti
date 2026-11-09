/**
 * 重建自愈（审计 N1 / 阶段 0 · G03）。
 *
 * 契约：重建是「就地清空 + 整体重折」，中途失败会留下半截投影。
 * 故入口必须**先**落 needs_rebuild=true 再 clear，成功才清标记；
 * 失败则标记保持 true（异常继续上抛，不吞）——
 * 下次启动据此知道投影是半截的，会自动重来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Fasti } from '../../src/api/index.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

/** 读检查点文件（运行态标注，磁盘上的真相）。 */
function readCheckpoint(root: string): { needs_rebuild: boolean; tick: number } {
  const file = path.join(root, 'state', 'checkpoint.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { needs_rebuild: boolean; tick: number };
}

/** 写一条经历，让真源非空（重建才有东西可折）。 */
async function seed(fasti: Fasti): Promise<void> {
  await fasti.appendExperience({
    id: '01J0000000000000000000000A',
    schema_version: 1,
    kind: 'dialogue',
    scene: { channel: 'dsh', ref: 's-1' },
    initiation: 'user',
    observation: { cue: '线索' },
    occurred_at: '2026-11-15T12:00:00.000Z',
  });
}

test('G03：重建中途失败 → 异常上抛、needs_rebuild 保持 true', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await seed(fasti);

    // 观测 clear 发生时检查点上的标记 → 证明标记是「先落再 clear」。
    let markerAtClear: boolean | undefined;
    const engine = fasti.projectionEngine;
    const originalClear = engine.clear.bind(engine);
    engine.clear = async () => {
      markerAtClear = readCheckpoint(root).needs_rebuild;
      await originalClear();
    };
    engine.upsertExperience = async () => {
      throw new Error('注入：重建中途失败');
    };

    await assert.rejects(() => fasti.rebuildProjections(), /注入：重建中途失败/);

    assert.equal(markerAtClear, true, 'clear 之前必须已落 needs_rebuild=true');
    assert.equal(readCheckpoint(root).needs_rebuild, true, '失败后标记保持 true，不得清');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('G03：重建失败后下次启动自动重建（半截投影被修复），标记复位 false', async () => {
  const root = makeTempRoot();
  let fasti = await Fasti.open({ dataRoot: root });
  try {
    await seed(fasti);

    const engine = fasti.projectionEngine;
    engine.upsertExperience = async () => {
      throw new Error('注入：重建中途失败');
    };
    await assert.rejects(() => fasti.rebuildProjections(), /注入：重建中途失败/);
  } finally {
    await fasti.close();
  }

  try {
    // 重开：检查点标着 needs_rebuild → 启动即从真源重建。
    fasti = await Fasti.open({ dataRoot: root });
    assert.equal(readCheckpoint(root).needs_rebuild, false, '重建完成后标记复位');
    const rows = await fasti.query({});
    assert.equal(rows.length, 1, '半截投影已被重建修复');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('G03：重建成功 → needs_rebuild 复位 false（正常路径不残留标记）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await seed(fasti);
    const result = await fasti.rebuildProjections();
    assert.equal(result.experiences, 1);
    assert.equal(readCheckpoint(root).needs_rebuild, false);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
