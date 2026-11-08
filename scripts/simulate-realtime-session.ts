/**
 * 真机对账演练 —— 在**数据根副本**上模拟 dsh 宿主加载适配器、emit 真实事件流。
 *
 * 用途有二：
 *  1. 验证对账工具链自身可用（在真机对话之前先跑一遍）；
 *  2. 提供「宿主侧怎么用这个插件」的可运行样例。
 *
 * 真实宿主里的用法与此完全一致，只是事件来自 dsh 而非文件。
 *
 * 用法：node scripts/simulate-realtime-session.ts --root <数据根> --events <事件流.jsonl>
 */

import fs from 'node:fs';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { apply } from '../src/adapters/dsh/plugin.ts';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = path.resolve(argOf('root') ?? '');
const EVENTS_FILE = path.resolve(argOf('events') ?? '');

if (ROOT === '' || EVENTS_FILE === '') {
  console.error('用法：node scripts/simulate-realtime-session.ts --root <数据根> --events <事件流.jsonl>');
  process.exit(2);
}

const ctx = new Context();
const fiber = ctx.plugin({ apply }, { dataRoot: ROOT });
await fiber;

const rows = fs
  .readFileSync(EVENTS_FILE, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as unknown);

const session = { id: 'session-simulated-1' };

for (const row of rows) {
  ctx.emit('session/event', session, row);
}

// 等旁路摄入落盘（写入经单写者队列，异步完成）。
await new Promise((resolve) => setTimeout(resolve, 1500));

await fiber.dispose();
console.log(`已模拟 emit ${rows.length} 条事件，数据根：${ROOT}`);
