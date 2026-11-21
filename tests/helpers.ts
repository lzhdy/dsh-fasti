/**
 * 测试公共工具 —— 临时目录、样例数据、断言助手。
 *
 * 纪律：全部测试使用临时目录，**绝不读写任何真实数据目录**。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Experience } from '../src/contract/experience.ts';
import { dshChannelDescriptor } from '../src/adapters/dsh/channel-descriptor.ts';

/** 建一个临时数据根；测试结束由调用方清理。 */
export function makeTempRoot(prefix = 'fasti-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 在临时数据根预置一份「已登记 dsh 通道」的 channels.json（测试夹具）。
 *
 * 平台化步骤2 起内核空白启动不再自动预置任何通道；凡经门面以 dsh 通道写入或做
 * 通道对账的用例，在首次 Fasti.open 前调用本函数，等价该环境已显式挂载登记过 dsh。
 * 登记结果随 channels.json 持久化，后续 reopen 同一数据根自动可见，无需重复调用。
 */
export function seedDshChannel(root: string, channel = 'dsh'): void {
  fs.writeFileSync(
    path.join(root, 'channels.json'),
    `${JSON.stringify({ version: 1, channels: [dshChannelDescriptor(channel)] }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * 递归删除临时目录。
 *
 * Windows 上被占用的文件（如仍打开的 SQLite 库）无法删除，
 * 故先重试几次再报错 —— 但绝不静默吞掉失败。
 */
export function cleanupTempRoot(root: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(root, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** 用临时数据根跑一段测试逻辑，结束后关闭并清理。 */
export async function withTempRoot<T>(
  fn: (root: string) => Promise<T>,
  prefix = 'fasti-test-',
): Promise<T> {
  const root = makeTempRoot(prefix);
  try {
    return await fn(root);
  } finally {
    cleanupTempRoot(root);
  }
}

/** 构造一条样例经历（尽量少填，调用方按需覆盖）。 */
export function makeExperience(overrides: Partial<Experience> = {}): Experience {
  const base: Experience = {
    id: '01J0000000000000000000000A',
    schema_version: 1,
    kind: 'dialogue',
    scene: { channel: 'dsh', ref: 'session-1' },
    initiation: 'user',
    observation: { cue: '测试线索' },
    occurred_at: '2026-11-08T10:00:00.000Z',
    recorded_at: '2026-11-08T10:00:00.000Z',
    tick: 0,
    char_count: null,
  };
  return { ...base, ...overrides };
}

/** 读取目录下的文件树（相对路径列表），用于结构断言。 */
export function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root, '');
  return out;
}

/** 读取 JSONL 文件的行数。 */
export function countLines(file: string): number {
  if (!fs.existsSync(file)) {
    return 0;
  }
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter((line) => line.trim() !== '').length;
}
