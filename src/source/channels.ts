/**
 * 通道注册表 —— channels.json。
 *
 * 口径：
 *  - 首次初始化预置 dsh 描述符（审计口径 8）；
 *  - registerChannel 追加不破坏既有条目；
 *  - 同 id 重复注册：内容等价 → 幂等返回；不等价 → ConflictError（决策 D-7）。
 *
 * channels.json 是**数据文件**，随她迁移（定案稿 §4.6），不是投影。
 */

import path from 'node:path';

import { ConflictError, NotFoundError } from '../core/errors.ts';
import { exists, writeFileAtomic } from '../core/fsx.ts';
import { parseJsonStrict } from '../core/fsx.ts';
import fs from 'node:fs';
import { DEFAULT_DSH_DESCRIPTOR, parseChannelDescriptor } from '../contract/channel.ts';
import type { ChannelDescriptor } from '../contract/channel.ts';

/** 注册表文件结构。 */
export interface ChannelRegistryFile {
  version: 1;
  channels: ChannelDescriptor[];
}

/**
 * 通道注册表。
 *
 * 只提供 register / read 能力。注册表是「可增长的登记表」——
 * 既有条目永不被改写或删除（定案稿 §10.2 开放面：旧读取器遇未知值必须原样保留）。
 */
export class ChannelRegistry {
  private readonly file: string;
  private channels: ChannelDescriptor[] = [];

  constructor(file: string) {
    this.file = file;
  }

  /**
   * 载入注册表；文件不存在则初始化并预置 dsh 描述符。
   */
  load(): void {
    if (!exists(this.file)) {
      this.channels = [{ ...DEFAULT_DSH_DESCRIPTOR }];
      this.persist();
      return;
    }

    const text = readFileUtf8(this.file);
    const parsed = parseJsonStrict<ChannelRegistryFile>(text, this.file);
    if (parsed.version !== 1 || !Array.isArray(parsed.channels)) {
      throw new Error(`通道注册表格式非法：${this.file}`);
    }
    this.channels = parsed.channels.map((item) => parseChannelDescriptor(item, 'channel'));
  }

  /** 全部通道描述符。 */
  list(): ChannelDescriptor[] {
    return this.channels.map((channel) => ({ ...channel }));
  }

  /** 取某个通道；不存在抛 NotFoundError。 */
  get(id: string): ChannelDescriptor {
    const found = this.channels.find((channel) => channel.id === id);
    if (found === undefined) {
      throw new NotFoundError(`通道未注册：${id}`);
    }
    return { ...found };
  }

  /** 通道是否已注册。 */
  has(id: string): boolean {
    return this.channels.some((channel) => channel.id === id);
  }

  /**
   * 注册一个通道。
   *
   * 同 id 重复注册：内容等价 → 幂等返回既有；不等价 → ConflictError。
   */
  register(descriptor: ChannelDescriptor): ChannelDescriptor {
    const validated = parseChannelDescriptor(descriptor, 'channel');
    const existing = this.channels.find((channel) => channel.id === validated.id);

    if (existing !== undefined) {
      if (descriptorsEqual(existing, validated)) {
        return { ...existing };
      }
      throw new ConflictError(
        `通道 ${validated.id} 已注册且描述不同；既有条目不可被改写（开放面纪律）`,
      );
    }

    this.channels.push(validated);
    this.persist();
    return { ...validated };
  }

  private persist(): void {
    const payload: ChannelRegistryFile = { version: 1, channels: this.channels };
    writeFileAtomic(this.file, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

/** 描述符等价比较（忽略对象顺序，比较全部字段值）。 */
export function descriptorsEqual(a: ChannelDescriptor, b: ChannelDescriptor): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(descriptor: ChannelDescriptor): unknown {
  return {
    id: descriptor.id,
    label: descriptor.label,
    modalities: [...descriptor.modalities],
    capture: descriptor.capture,
    staging: descriptor.staging === undefined ? null : { ...descriptor.staging },
    counterpart: descriptor.counterpart ?? null,
    adapter_version: descriptor.adapter_version,
  };
}

/** 读 UTF-8 文件（不存在抛 NotFoundError）。 */
export function readFileUtf8(file: string): string {
  if (!exists(file)) {
    throw new NotFoundError(`文件不存在：${file}`);
  }
  // 同步读；读取失败会抛原始错误（绝不用空串覆盖）
  return fs.readFileSync(file, 'utf8');
}

/** 注册表默认文件名。 */
export function defaultRegistryFile(root: string): string {
  return path.join(root, 'channels.json');
}
