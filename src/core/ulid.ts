/**
 * 自实现单调 ULID —— 零运行时依赖（生产 dependencies 为空，硬约束）。
 *
 * 布局（审计口径 2）：128 bit = 48 bit 毫秒时间戳（Crockford Base32 前 10 字符）
 *                   + 80 bit 随机熵（后 16 字符），共 26 字符。
 *
 * 单调性：
 *  - 同一毫秒内，随机段按 80 bit 计数器递增；
 *  - 时钟回拨（now < lastMs）时不产生比上一条更小的 id —— 沿用 lastMs 并继续递增随机段；
 *  - 随机段溢出时 lastMs +1 并重置随机段，仍保持严格递增。
 *
 * 字典序 == 时间序：时间戳定长前 10 位，故按字符串比较即按时间比较。
 */

import { randomBytes } from 'node:crypto';

/** Crockford Base32：去掉了 I、L、O、U，避免手抄歧义。 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BITS = 80n;
const MAX_RANDOM = (1n << RANDOM_BITS) - 1n;

export const ULID_LENGTH = TIME_CHARS + RANDOM_CHARS;

/** 随机段取值范围上界（80 bit 全 1）。 */
const RANDOM_LIMIT = MAX_RANDOM;

function encodeBase32(value: bigint, length: number): string {
  let rest = value;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = CROCKFORD_ALPHABET[Number(rest & 31n)] + out;
    rest >>= 5n;
  }
  return out;
}

function randomBits(): bigint {
  const bytes = randomBytes(10);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * 单调 ULID 生成器。
 * 时钟可注入 —— 时钟回拨专项测试需要（审计第四节阶段 0 验收项）。
 */
export class UlidGenerator {
  private lastMs = -1;
  private lastRandom = 0n;
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** 产出下一个 id：严格大于本生成器此前产出的任何 id。 */
  next(): string {
    const now = Math.floor(this.clock());

    if (now > this.lastMs) {
      this.lastMs = now;
      this.lastRandom = randomBits();
    } else {
      // 同毫秒 或 时钟回拨：沿用 lastMs，随机段递增，绝不产生更小的 id。
      this.lastRandom += 1n;
      if (this.lastRandom > RANDOM_LIMIT) {
        this.lastRandom = 0n;
        this.lastMs += 1;
      }
    }

    return encodeBase32(BigInt(this.lastMs), TIME_CHARS) + encodeBase32(this.lastRandom, RANDOM_CHARS);
  }

  /** 当前生成器所处的时间戳（毫秒）；尚未产出过则为 -1。 */
  get lastTimestampMs(): number {
    return this.lastMs;
  }
}

/**
 * 进程内默认生成器 —— 同一进程的所有调用方共用一条递增序列。
 *
 * 审计 m3 的口径：多个调用方各自 `new UlidGenerator()` 时，
 * 各自在同一毫秒内独立递增随机段 → 局部有序但全局可能乱序。
 * 共用本单例即可保证进程内全局单调。
 *
 * 注：A 块阶段 0–2 的 Fasti 门面**不铸造** ULID（experience.id 由调用方提供），
 * 故单例供调用方与阶段 3+ 的媒体/资产 id 使用。
 */
export const defaultUlid = new UlidGenerator();

/** 便捷函数：产出下一个单调 ULID。 */
export function ulid(): string {
  return defaultUlid.next();
}

/** 从 ULID 解出时间戳（毫秒）。非法格式抛错。 */
export function ulidTimestampMs(id: string): number {
  if (!isUlid(id)) {
    throw new TypeError(`非法 ULID：${id}`);
  }
  let value = 0n;
  for (const char of id.slice(0, TIME_CHARS)) {
    value = (value << 5n) | BigInt(CROCKFORD_ALPHABET.indexOf(char));
  }
  return Number(value);
}

/** 是否为合法 ULID（26 字符、Crockford 字符集、时间戳不溢出 48 bit）。 */
export function isUlid(id: string): boolean {
  if (typeof id !== 'string' || id.length !== ULID_LENGTH) {
    return false;
  }
  for (const char of id) {
    if (CROCKFORD_ALPHABET.indexOf(char) < 0) {
      return false;
    }
  }
  // 首字符只用 3 bit（时间戳 48 bit / 10 字符 = 50 bit 位宽，首字符上限 '7'）
  return CROCKFORD_ALPHABET.indexOf(id[0] as string) <= 7;
}
