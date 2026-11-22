/**
 * #157 观测 ingest stage 红测（先红后绿）。
 *
 * 写入链实时脉冲的第一个挂点：stage 跑在真源 append 之后、写队列内，
 * 只把「一拍打进来了」报给活动总线，不读不写任何业务数据、永不抛错——
 * 观测故障不得污染摄入主链路（stage runner 会把 stage 异常记为摄入失败）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fasti } from '../../../src/api/index.ts';
import type { ChannelDescriptor } from '../../../src/contract/channel.ts';
import { ActivityBus } from '../../../src/adapters/node/activity-bus.ts';
import { createObservationStage } from '../../../src/adapters/node/observe-stage.ts';
import { cleanupTempRoot, makeTempRoot } from '../../helpers.ts';

const descriptor: ChannelDescriptor = {
  id: 'obsstage',
  label: '观测 stage 通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'obsstage-0',
};

test('观测 stage：每次摄入后总线上出现带 tick/通道/经历 id 的脉冲', async () => {
  const root = makeTempRoot();
  const bus = new ActivityBus({ unrefTimers: false });
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    fasti.registerIngestStage(createObservationStage(bus));
    await fasti.registerChannel(descriptor);

    await fasti.ingestRawTurn('obsstage', {
      event_id: 'evt-obs-1',
      speaker: 'user',
      initiation: 'user',
      raw_text: '今天去了江边',
    });

    const events = bus.since(0);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'ingest.turn');
    assert.equal(events[0]?.data?.['tick'], 0);
    assert.equal(events[0]?.data?.['channel'], 'obsstage');
    assert.equal(typeof events[0]?.data?.['experienceId'], 'string');
    assert.equal(typeof events[0]?.data?.['shard'], 'string');
    assert.equal(events[0]?.data?.['seq'], 0);
  } finally {
    await fasti.close();
    bus.dispose();
    cleanupTempRoot(root);
  }
});

test('观测 stage：总线已关停时 stage 静默吞错，摄入主链路照常成功', async () => {
  const root = makeTempRoot();
  const bus = new ActivityBus({ unrefTimers: false });
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    fasti.registerIngestStage(createObservationStage(bus));
    await fasti.registerChannel(descriptor);
    bus.dispose();

    const written = await fasti.ingestRawTurn('obsstage', {
      event_id: 'evt-obs-2',
      speaker: 'user',
      initiation: 'user',
      raw_text: '总线关了也要写进去',
    });
    assert.equal(written.id.length > 0, true);
    assert.deepEqual(fasti.ingestStageFailures(), [], '观测 stage 不得制造摄入失败');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
