/**
 * 写入链观测挂点（#157 网页控制台）。
 *
 * 一个零副作用的 ingest stage：在内核写完原文/经历、折完投影后把本拍元数据
 * （通道/tick/经历 id/事件 id，无正文）报给进程内活动总线。它是流水线「原文→经历→投影」
 * 段的脉冲源；任何上报异常都在 stage 内吞掉——观测永远不能把一次正常摄入变成失败。
 */

import type { IngestStage, IngestStageContext } from '../../event/ingest-stage.ts';
import { ActivityBus } from './activity-bus.ts';

export function createObservationStage(bus: ActivityBus): IngestStage {
  return {
    name: 'node-web-observation',
    async run(ctx: IngestStageContext): Promise<void> {
      try {
        bus.emit('ingest.turn', 'ok', `第 ${ctx.tick} 拍摄入完成（${ctx.experience.scene.channel}）`, {
          channel: ctx.experience.scene.channel,
          tick: ctx.tick,
          experienceId: ctx.experience.id,
          shard: ctx.location.shard,
          seq: ctx.location.seq,
        });
      } catch {
        // 总线关停等情况下静默：观测面故障不回灌主链路。
      }
    },
  };
}
