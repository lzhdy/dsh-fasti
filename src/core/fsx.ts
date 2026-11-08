/**
 * 文件系统原语 —— 原子写、append-only 追加、目录与清单。
 *
 * 纪律：
 *  - 真源写入一律 append-only，绝不原地改写（冻结面第 1 条）；
 *  - 读失败必须抛出，绝不用空串覆盖既有数据（旧行为契约 1.1「读失败抛出、不用空串覆盖」）；
 *  - 清单与注册表这类「小文件整体替换」用原子写（临时文件 + rename）。
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CorruptedError, NotFoundError } from './errors.ts';

/** 确保目录存在。 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** 文件是否存在。 */
export function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * 原子写：先写临时文件，再 rename 覆盖。
 * rename 在同一文件系统内是原子的，故不会读到半截内容。
 */
export function writeFileAtomic(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8' });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw error;
  }
}

/**
 * 读文件；不存在抛 NotFoundError，读失败抛原始错误。
 * 绝不返回空串来掩盖失败。
 */
export function readFileStrict(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new NotFoundError(`文件不存在：${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * append-only 追加一行到文件（自动建目录、创建文件）。
 * 以 'a' 标志追加，天然不会截断既有内容。
 */
export function appendLine(filePath: string, line: string): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, line, { encoding: 'utf8' });
}

/** 列出目录下匹配后缀的文件名（已排序）。 */
export function listFiles(dir: string, suffix?: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => (suffix ? name.endsWith(suffix) : true))
    .sort();
}

/** 列出目录下的子目录名（已排序）。 */
export function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** 删除文件（不存在则忽略）。仅用于投影层这类「可丢弃」资产。 */
export function removeFile(filePath: string): void {
  fs.rmSync(filePath, { force: true, recursive: true });
}

/** 递归删除目录（不存在则忽略）。 */
export function removeDir(dir: string): void {
  fs.rmSync(dir, { force: true, recursive: true });
}

/** 目录整体重命名（原子换名，重建协议第 4 步用）。 */
export function renameDir(from: string, to: string): void {
  ensureDir(path.dirname(to));
  fs.renameSync(from, to);
}

/**
 * 严格解析 JSON；失败抛 CorruptedError（绝不静默吞掉坏数据）。
 */
export function parseJsonStrict<T>(text: string, source: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new CorruptedError(`JSON 解析失败（${source}）：${(error as Error).message}`, { cause: error });
  }
}
