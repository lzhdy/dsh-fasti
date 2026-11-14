/**
 * #114 门面增量红测（A 案附带条件①）：Fasti.readExperienceById 纯读窄 DTO。
 *
 *  - 现成 experienceLog.has/get 支撑，append-only 零写风险；
 *  - 返回契约层 ExperienceSummaryView 白名单（id/时间三轴/摘要线索/锚点元数据），
 *    raw 原文只能经 resolvePointer 获取，本方法不得回显任何原文；
 *  - 未知名返回 null（不抛、不造空对象）。
 *
 * 纪律：临时数据根、结束即清理，真实根零接触。方法落地前本文件编译/运行均红。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fasti } from '../../src/api/index.ts';
import type { ExperienceSummaryView } from '../../src/contract/experience.ts';
import { cleanupTempRoot, makeTempRoot, makeExperience } from '../helpers.ts';

const ID_A = '01J0000000000000000000000A';
const ID_MISSING = '01J0000000000000000000000Z';

test('readExperienceById：返回白名单窄 DTO，不含原文指针目标内容与任何内部字段', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience(
      makeExperience({
        id: ID_A,
        observation: {
          cue: '门控拆除后的只读下钻线索',
          text: { id: 'raw_1', channel: 'dsh', shard: '2026-11', seq: [3, 5] },
        },
      }),
    );

    const view = await fasti.readExperienceById(ID_A);
    assert.ok(view !== null);
    const snapshot: ExperienceSummaryView = view;
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'cue',
      'id',
      'initiation',
      'kind',
      'occurredAt',
      'recordedAt',
      'scene',
      'tick',
    ]);
    assert.equal(snapshot.id, ID_A);
    assert.equal(snapshot.cue, '门控拆除后的只读下钻线索');
    const json = JSON.stringify(snapshot);
    for (const leaked of ['raw_text', 'rawText', 'observation', 'text', 'pointer', 'contentHash']) {
      assert.ok(!json.includes(leaked), `门面窄 DTO 混入原文/内部字段：${leaked}`);
    }
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('readExperienceById：未知 id 返回 null；重复读取结果逐字一致', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience(makeExperience({ id: ID_A }));
    assert.equal(await fasti.readExperienceById(ID_MISSING), null);
    const v1 = await fasti.readExperienceById(ID_A);
    const v2 = await fasti.readExperienceById(ID_A);
    assert.deepEqual(v1, v2);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
