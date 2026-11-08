/**
 * 引擎探测与降级选择（审计口径 14、定案稿 §7.4）。
 *
 * 三级降级，按可用性自动选择，对上层透明：
 *   L1 node:sqlite（默认）—— 完整投影：FTS5、多维索引、事务
 *   L2 JSONL 索引          —— node:sqlite 不可用/被禁用
 *   L3 真源直读            —— 投影损坏且无法重建
 *
 * 核心保证：投影引擎可替换，真源永不换。任何降级都不影响数据完整性，
 * 只影响查询性能与功能丰富度。
 *
 * 手动触发（用户拍板 Q4）：环境变量 + API 参数双入口。
 *   FASTI_PROJECTION_ENGINE=l1|l2|l3
 */

import fs from 'node:fs';
import path from 'node:path';

import { UnavailableError } from '../core/errors.ts';
import { exists } from '../core/fsx.ts';
import { isSqliteAvailable, SqliteProjection } from './sqlite.ts';
import { JsonlProjection } from './jsonl.ts';
import { SourceScanProjection } from './source-scan.ts';
import type { SourceReader } from './source-scan.ts';
import type { ProjectionEngine, ProjectionLevel } from './types.ts';

/** 引擎选择的输入。 */
export interface DetectOptions {
  /** 投影库所在目录。 */
  projectionDir: string;
  /** L3 所需的真源读取能力。 */
  reader: SourceReader;
  /** 手动指定档位（优先于自动探测）。 */
  force?: ProjectionLevel | undefined;
  /** 环境变量（便于测试注入）。 */
  env?: NodeJS.ProcessEnv;
}

/** 引擎选择的结果。 */
export interface EngineSelection {
  engine: ProjectionEngine;
  level: ProjectionLevel;
  /** 是否处于降级运行。 */
  degraded: boolean;
  /** 降级原因（未降级则为空串）。 */
  reason: string;
}

/** 投影库文件路径（L1）。 */
export function sqlitePathOf(projectionDir: string): string {
  return path.join(projectionDir, 'fasti.sqlite');
}

/** L2 目录路径。 */
export function jsonlDirOf(projectionDir: string): string {
  return path.join(projectionDir, 'l2');
}

/**
 * 选择引擎。
 *
 * 手动档位不可用时**不静默回退** —— 抛 UnavailableError，
 * 让「手动触发降级验证」有明确的失败反馈（测试据此断言降级确实发生）。
 */
export async function selectEngine(options: DetectOptions): Promise<EngineSelection> {
  const env = options.env ?? process.env;
  const forced = options.force ?? parseLevel(env['FASTI_PROJECTION_ENGINE']);

  if (forced !== undefined) {
    return {
      engine: await buildForced(forced, options),
      level: forced,
      degraded: forced !== 'L1',
      reason: forced === 'L1' ? '' : `手动指定引擎档位 ${forced}`,
    };
  }

  // L1：node:sqlite 可用？
  if (await isSqliteAvailable()) {
    try {
      const engine = new SqliteProjection(sqlitePathOf(options.projectionDir));
      await engine.open();
      return { engine, level: 'L1', degraded: false, reason: '' };
    } catch (error) {
      // 投影库损坏 → 隔离坏文件，让后续重建能从干净状态开始
      // （定案稿 §16-4「投影损坏自动检测周期与自动重建入口」的落位）。
      const quarantined = quarantineCorruptProjection(options.projectionDir);
      const engine = new JsonlProjection(jsonlDirOf(options.projectionDir));
      await engine.open();
      return {
        engine,
        level: 'L2',
        degraded: true,
        reason:
          `L1 打开失败：${(error as Error).message}` +
          (quarantined === null ? '' : `；已隔离损坏的投影文件 ${quarantined}`),
      };
    }
  }

  // L2：JSONL 索引可用？
  try {
    const engine = new JsonlProjection(jsonlDirOf(options.projectionDir));
    await engine.open();
    return {
      engine,
      level: 'L2',
      degraded: true,
      reason: 'node:sqlite 不可用（宿主禁用或模块不可加载）',
    };
  } catch (error) {
    // L2 索引损坏 → L3 真源直读。
    const engine = new SourceScanProjection(options.reader);
    await engine.open();
    return {
      engine,
      level: 'L3',
      degraded: true,
      reason: `L2 索引损坏：${(error as Error).message}`,
    };
  }
}

/** 构造指定档位的引擎（手动触发路径）。 */
async function buildForced(level: ProjectionLevel, options: DetectOptions): Promise<ProjectionEngine> {
  if (level === 'L1') {
    if (!(await isSqliteAvailable())) {
      throw new UnavailableError('手动指定 L1，但 node:sqlite 不可用');
    }
    const engine = new SqliteProjection(sqlitePathOf(options.projectionDir));
    await engine.open();
    return engine;
  }

  if (level === 'L2') {
    const engine = new JsonlProjection(jsonlDirOf(options.projectionDir));
    await engine.open();
    return engine;
  }

  const engine = new SourceScanProjection(options.reader);
  await engine.open();
  return engine;
}

/** 解析档位字符串；非法值抛错（不静默忽略）。 */
export function parseLevel(value: string | undefined): ProjectionLevel | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower === 'l1' || lower === 'sqlite') {
    return 'L1';
  }
  if (lower === 'l2' || lower === 'jsonl') {
    return 'L2';
  }
  if (lower === 'l3' || lower === 'source') {
    return 'L3';
  }
  throw new UnavailableError(`未知的投影引擎档位：${value}`);
}

/**
 * 隔离损坏的投影文件（改名保留，不删除）。
 *
 * 投影是可丢弃资产（真源才是权威），故损坏时隔离即可 ——
 * 保留原文件便于事后诊断，同时解除文件占用，让重建从干净状态开始。
 *
 * @returns 被隔离的文件名；无可隔离文件时返回 null
 */
export function quarantineCorruptProjection(projectionDir: string): string | null {
  const file = sqlitePathOf(projectionDir);
  if (!exists(file)) {
    return null;
  }
  const quarantined = `${file}.corrupt`;
  try {
    fs.renameSync(file, quarantined);
    return path.basename(quarantined);
  } catch {
    return null;
  }
}
