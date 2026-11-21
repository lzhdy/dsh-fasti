/**
 * 数据根解析与目录布局（平台化 H2-b 去宿主化）。
 *
 * 数据根四级优先级（正本 §2.6【2026-11-17 修正案③】）：
 *   显式配置 dataRoot > $FASTI_HOME > 旧 $DSH_HOME/fasti（历史只读兼容）> ~/.fasti
 *
 *  - `$FASTI_HOME` 是中性数据根变量，值**直接就是数据根目录本身**，不再下拼子目录；
 *  - `$DSH_HOME` 是单宿主时代遗留名（旧语义为宿主基址，数据在其下的 fasti/），
 *    按修正案保留只读兼容，新接入一律走显式 dataRoot 或 FASTI_HOME；
 *  - 兜底默认根是家目录下的 .fasti；内核不再内置任何宿主命名的默认根，也不自动迁移
 *    任何存量目录——旧库经显式 dataRoot 或旧环境变量原样打开（只读兼容、绝不搬移）。
 *
 * 本模块不内置任何具体宿主通道 id：原文目录走哪个物理布局由装配方显式声明（见 rawDirOf）。
 */

import os from 'node:os';
import path from 'node:path';

/** 中性数据根环境变量：值即数据根目录本身。 */
const FASTI_HOME_ENV = 'FASTI_HOME';
/** 遗留宿主基址环境变量（历史兼容，集中具名；勿在新代码路径引用）。 */
const LEGACY_DSH_HOME_ENV = 'DSH_HOME';
/** 兜底默认数据根的家目录子目录名。 */
const DEFAULT_ROOT_DIRNAME = '.fasti';
/** 遗留宿主基址下的数据根子目录名（仅历史兼容路径使用）。 */
const LEGACY_DSH_SUBDIR = 'fasti';

export interface PathOptions {
  /** 显式配置的数据根（最高优先级）。 */
  dataRoot?: string | undefined;
  /** 进程环境（便于测试注入）。 */
  env?: NodeJS.ProcessEnv;
  /** 家目录（便于测试注入）。 */
  homeDir?: string | undefined;
}

/**
 * 无显式 dataRoot 时的数据根解析：
 * FASTI_HOME（直指根）> 旧 DSH_HOME/fasti（兼容）> ~/.fasti（兜底）。
 */
export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  const base = homeDir ?? os.homedir();

  const fastiHome = env[FASTI_HOME_ENV];
  if (fastiHome !== undefined && fastiHome !== '') {
    return path.resolve(fastiHome);
  }

  const legacyHome = env[LEGACY_DSH_HOME_ENV];
  if (legacyHome !== undefined && legacyHome !== '') {
    return path.resolve(legacyHome, LEGACY_DSH_SUBDIR);
  }

  return path.resolve(base, DEFAULT_ROOT_DIRNAME);
}

/**
 * 解析数据根。
 * 优先级：显式配置 > FASTI_HOME > 旧 DSH_HOME/fasti > ~/.fasti。
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
  /**
   * 原文层·遗留扁平布局目录（物理名沿用存量 raw-turns，宿主无关）。
   * 仅装配方显式声明为遗留扁平通道者落此目录，新通道一律走 raw/ 分区。
   */
  rawTurns: string;
  /** 原文层·通道分区统一格式：raw/<channel>/。 */
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

/**
 * 某通道的原文层目录。
 *
 * 内核不认识任何具体通道 id：默认所有通道都走分区布局 raw/<channel>/；
 * 只有当该通道被装配方显式列入 `flatRawChannels`（存量扁平原文目录，
 * 物理名 raw-turns/）时，才落到 layout.rawTurns。哪个通道用遗留扁平布局是装配事实，
 * 由对应适配器挂载时显式声明传进来，而不是在内核里写死通道名。
 */
export function rawDirOf(
  layout: DataLayout,
  channel: string,
  flatRawChannels: readonly string[] = [],
): string {
  return flatRawChannels.includes(channel)
    ? layout.rawTurns
    : path.join(layout.raw, channel);
}
