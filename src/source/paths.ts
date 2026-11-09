/**
 * 数据根解析与目录布局。
 *
 * 三级优先级（定案稿 §18.3 + 用户拍板 Q3）：
 *   显式配置 > $DSH_HOME/fasti > ~/.dsh/fasti
 *
 * $DSH_HOME 是 ~/.dsh 的替代基址（沿用旧项目 paths.ts:90 的既有约定）。
 * 阶段 0–2 不读写任何真实数据目录 —— 全部测试使用临时目录。
 */

import os from 'node:os';
import path from 'node:path';

export interface PathOptions {
  /** 显式配置的数据根（最高优先级）。 */
  dataRoot?: string | undefined;
  /** 进程环境（便于测试注入）。 */
  env?: NodeJS.ProcessEnv;
  /** 家目录（便于测试注入）。 */
  homeDir?: string | undefined;
}

/**
 * 默认数据根：`~/.dsh/fasti`。
 *
 * `$DSH_HOME` 是 `~/.dsh` 的替代基址（沿用旧项目 paths.ts:90 的既有约定）。
 */
export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  const base = homeDir ?? os.homedir();
  const dshHome = env['DSH_HOME'];
  if (dshHome !== undefined && dshHome !== '') {
    return path.resolve(dshHome, 'fasti');
  }
  return path.resolve(base, '.dsh', 'fasti');
}

/**
 * 解析数据根。
 * 优先级：显式配置 > $DSH_HOME/fasti > ~/.dsh/fasti。
 */
export function resolveDataRoot(options: PathOptions = {}): string {
  const env = options.env ?? process.env;

  if (options.dataRoot !== undefined && options.dataRoot !== '') {
    return path.resolve(options.dataRoot);
  }

  return path.resolve(defaultDataRoot(env, options.homeDir));
}

/** 数据根下的目录布局。 */
export interface DataLayout {
  /** 数据根本身。 */
  root: string;
  /** 原文层 · DSH 通道（现有格式不动，兼容存量）。 */
  rawTurns: string;
  /** 原文层 · 新通道统一格式：raw/<channel>/。 */
  raw: string;
  /** 结构层 · 经历条目。 */
  experiences: string;
  /** 记事本 · 事件条目（二级真源，按月分片）。 */
  events: string;
  /** 通道注册表（数据文件，随她迁移）。 */
  channelsFile: string;
  /** 投影层目录（可丢弃、可重建）。 */
  projection: string;
  /** 运行态检查点。 */
  state: string;
}

/** 由数据根推导出完整布局。 */
export function layoutOf(root: string): DataLayout {
  return {
    root,
    rawTurns: path.join(root, 'raw-turns'),
    raw: path.join(root, 'raw'),
    experiences: path.join(root, 'experiences'),
    events: path.join(root, 'events'),
    channelsFile: path.join(root, 'channels.json'),
    projection: path.join(root, 'projection'),
    state: path.join(root, 'state'),
  };
}

/** 某通道的原文层目录：dsh 走 raw-turns/，其余走 raw/<channel>/。 */
export function rawDirOf(layout: DataLayout, channel: string): string {
  return channel === 'dsh' ? layout.rawTurns : path.join(layout.raw, channel);
}
