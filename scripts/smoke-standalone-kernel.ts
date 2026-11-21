/**
 * 内核同进程独立运行冒烟（平台化 #72 宿主无关启动器·零网络最小切片）。
 *
 * 与 `smoke-headless-llm.ts`（验模型管道、要真端点）互补：本脚本**不连任何模型、
 * 不开网络端口、不依赖 dsh/cordis**，只在当前 node 进程内把内核当普通库装配起来，
 * 在一个与真机完全隔离的临时数据根上跑通：
 *   Fasti.open（llmPort=null，摘要如实 pending）→ 登记中性通道 → 写入一条原文/经历
 *     → 门面读回 → 幂等重放 → close，进程跑完即退、不留常驻句柄。
 *
 * 它是「内核脱离 dsh 宿主、作为零依赖库独立可用」的人工证据；机制本身由
 * tests/adapters/headless/standalone-kernel.test.ts 在 `npm run verify` 内机器守护，
 * 本脚本不进 verify（人工按需执行，沿用 scripts/ 离线脚本惯例）。
 *
 * 用法：
 *   node scripts/smoke-standalone-kernel.ts                     # 用内置演示文案
 *   node scripts/smoke-standalone-kernel.ts "今天我自己喂的一句话"  # 自定义原文
 *   FASTI_HOME=/你的/数据根 node scripts/smoke-standalone-kernel.ts   # 换数据根（可选）
 *
 * 数据根纪律：默认用系统临时目录下的独立演示根，绝不读取或写入任何真机数据目录；
 * 该根持久保留以便重复运行观察幂等与累积，可用 FASTI_HOME 覆盖。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Fasti } from '../src/api/index.ts';
import type { ChannelDescriptor } from '../src/contract/channel.ts';

const CHANNEL = 'standalone';

const descriptor: ChannelDescriptor = {
  id: CHANNEL,
  label: '独立直连冒烟通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'smoke-0',
};

// 数据根：显式 FASTI_HOME 优先；否则用与真机隔离的临时演示根（recursive 幂等自建）。
const dataRoot = process.env['FASTI_HOME']?.trim() || path.join(os.tmpdir(), 'fasti-standalone-smoke');
fs.mkdirSync(dataRoot, { recursive: true });

const rawText = process.argv[2]?.trim() || '平台化收尾：内核不装 dsh 也能在同进程独立开门、写入并读回。';
// event_id 由原文内容派生：同一句话重跑命中同一 (channel,event_id) 走幂等，不同话各自累积。
const eventId = `smoke-${createHash('sha256').update(rawText).digest('hex').slice(0, 12)}`;
const now = new Date().toISOString();

console.log('[smoke] 数据根 =', dataRoot);
console.log('[smoke] 1/4 开门：llmPort=null（无模型，摘要保持 pending，绝不伪造）');
const fasti = await Fasti.open({ dataRoot, llmPort: null });

try {
  await fasti.registerChannel(descriptor);
  console.log('[smoke] 2/4 已登记中性通道：', CHANNEL);

  // 读回口径用「经历」(query) 而非「事件段」(queryEvents)：同一 session 的多轮会被
  // 事件层归并成一个事件段，事件数不随轮次增长；经历才与每次 ingest 一一对应。
  const before = (await fasti.query({ channel: CHANNEL })).length;
  const experience = await fasti.ingestRawTurn(CHANNEL, {
    event_id: eventId,
    speaker: 'user',
    initiation: 'user',
    raw_text: rawText,
    asserted_at: now,
    occurred_at: now,
  });
  console.log('[smoke] 3/4 写入经历：id=%s channel=%s initiation=%s', experience.id, experience.scene.channel, experience.initiation);

  // 幂等：同一 (channel,event_id) 重放返回同一条、不新增经历。
  const replayed = await fasti.ingestRawTurn(CHANNEL, {
    event_id: eventId,
    speaker: 'user',
    initiation: 'user',
    raw_text: rawText,
    asserted_at: now,
    occurred_at: now,
  });
  const after = (await fasti.query({ channel: CHANNEL })).length;
  // 本次净增只能是 1（该 event_id 首次出现）或 0（持久根里已存在、幂等沿用）。
  const delta = after - before;
  if (replayed.id !== experience.id || (delta !== 0 && delta !== 1)) {
    throw new Error(`冒烟失败：幂等/计数异常 idSame=${replayed.id === experience.id} delta=${delta}`);
  }
  console.log(
    '[smoke] 4/4 读回：本通道经历总数 %d（写入前 %d，本次净增 %d；首跑=1、同句再跑=0、新句累积）；重放 id 一致=%s',
    after,
    before,
    delta,
    String(replayed.id === experience.id),
  );

  console.log('[smoke] PASS：内核同进程零网络独立闭环可用（未碰真机数据、未连模型、未引宿主包）');
} finally {
  await fasti.close();
  console.log('[smoke] 已关门，进程退出（无常驻句柄）。可重复运行观察幂等，或换 FASTI_HOME 指定数据根。');
}
