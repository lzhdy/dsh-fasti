/**
 * 浏览器代开启动器（#240 B 方案）——node 挂件层能力，不碰记忆内核。
 *
 * 两种姿态（由主控拍板，见 docs/architecture-design-spec.md §11.13.20）：
 *  - `app`：Chromium `--app=<url>` 无边框应用窗，子进程**绑定** node 进程树，
 *    Ctrl+C 走 serve.close() 显式 kill、直接关终端由系统收走进程树，同生共死；
 *  - `fullscreen`：`--start-fullscreen <url>` 普通浏览器全屏，detached+unref 放飞，
 *    node 死后窗口留存，刷新页面自然显示未连接，启动器不管理它的身后事。
 *
 * 安全纪律：spawn 数组参数、永不启用 shell；找不到浏览器/拉起失败只回失败信封，
 * 由组合根记警告，绝不抛穿拖垮 HTTP 服务。零运行时依赖，仅用 node 内置模块。
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export type BrowserOpenMode = 'app' | 'fullscreen';

/** 组合根管理子进程所需的最小柄（只要能 kill；测试用假对象不必伪造事件接口）。 */
export interface ManagedBrowserChild {
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** 最小子进程柄形状（真实 ChildProcess 结构满足；测试可注入假柄）。 */
export interface BrowserChildLike extends ManagedBrowserChild {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  unref(): void;
}

export type BrowserSpawnFn = (file: string, args: string[], options: SpawnOptions) => BrowserChildLike;

export interface BrowserLaunchRequest {
  url: string;
  openMode: BrowserOpenMode;
  /** 显式浏览器可执行路径；给了就跳过候选探测（FASTI_BROWSER_PATH / --browser-path）。 */
  executablePath?: string;
}

export interface BrowserLaunchResult {
  ok: boolean;
  reason?: string;
  executable?: string;
  args?: string[];
  /** app 模式下组合根凭此柄在 close() 时收子进程；fullscreen 放飞后仍回传但不要求收。 */
  child?: ManagedBrowserChild;
}

/** 组合根可注入的启动器函数类型（测试缝；readServeConfig 永不产出此字段）。 */
export type BrowserLauncherFn = (req: BrowserLaunchRequest) => Promise<BrowserLaunchResult>;

/** 抑制 Chromium 首运行向导/默认浏览器弹窗，保证沉浸式起手。 */
const COMMON_FLAGS = ['--no-first-run', '--no-default-browser-check'];

/** 按模式构造命令行参数；url 只作为独立数组元素或 --app= 的值，绝不拼 shell 字符串。 */
export function buildBrowserArgs(openMode: BrowserOpenMode, url: string): string[] {
  if (openMode === 'app') {
    return [`--app=${url}`, ...COMMON_FLAGS];
  }
  return ['--start-fullscreen', ...COMMON_FLAGS, url];
}

/**
 * 各平台 Chromium 系候选可执行体：Windows 走 Program Files 固定路径，
 * macOS 走 .app 包内 MacOS 可执行体并附 PATH 裸名兜底，Linux 全靠 PATH 裸名。
 */
export function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const pf = env['PROGRAMFILES'];
    const pfX86 = env['PROGRAMFILES(X86)'];
    const local = env['LOCALAPPDATA'];
    const out: string[] = [];
    const push = (base: string | undefined, sub: string): void => {
      if (base !== undefined && base.trim() !== '') {
        out.push(path.join(base, sub));
      }
    };
    push(pf, path.join('Google', 'Chrome', 'Application', 'chrome.exe'));
    push(local, path.join('Google', 'Chrome', 'Application', 'chrome.exe'));
    push(pfX86, path.join('Google', 'Chrome', 'Application', 'chrome.exe'));
    push(pf, path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'));
    push(pfX86, path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'));
    // PATH 裸名兜底（chrome / msedge 已在 PATH 时）。
    out.push('chrome.exe', 'msedge.exe');
    return out;
  }
  if (platform === 'darwin') {
    const home = env['HOME'];
    const userApps = home === undefined ? [] : [path.join(home, 'Applications')];
    const appRoots = ['/Applications', ...userApps];
    const out: string[] = [];
    for (const root of appRoots) {
      out.push(
        path.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        path.join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
        path.join(root, 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'),
      );
    }
    // Homebrew/MacPorts 装在 PATH 内时的裸名兜底。
    out.push('google-chrome', 'chromium', 'microsoft-edge', 'brave-browser');
    return out;
  }
  return [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
    'brave-browser',
  ];
}

function isBareName(candidate: string): boolean {
  return !candidate.includes('/') && !candidate.includes('\\');
}

async function canExecute(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    // Windows 不靠 X 位判定，存在即可；POSIX 要求可执行位。
    await fs.access(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在候选清单中找到第一个真实可用的可执行体：
 * 含分隔符的按路径直判；裸名沿 PATH 逐目录解析，win32 自动补 PATHEXT 后缀。
 * 全部落空回 null（调用方据此降级为手动打开提示）。
 */
export async function resolveExecutable(
  candidates: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const pathEnv = platform === 'win32' ? (env['Path'] ?? env['PATH'] ?? '') : (env['PATH'] ?? '');
  const dirs = pathEnv.split(platform === 'win32' ? ';' : ':').filter((d) => d !== '');
  const exts = platform === 'win32'
    ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)
    : [''];

  for (const candidate of candidates) {
    if (!isBareName(candidate)) {
      if (await canExecute(candidate, platform)) {
        return candidate;
      }
      continue;
    }
    for (const dir of dirs) {
      for (const ext of exts) {
        const joined = path.join(dir, candidate + ext);
        if (await canExecute(joined, platform)) {
          return joined;
        }
      }
    }
  }
  return null;
}

const defaultSpawn: BrowserSpawnFn = (file, args, options) => nodeSpawn(file, args, options);

/**
 * 真正拉起子进程。app 模式留在同一进程树（detached:false、不 unref）；
 * fullscreen 独立会话并 unref，node 退出不带走它。error 事件转失败信封，不抛穿。
 */
export function spawnBrowser(
  executable: string,
  args: string[],
  openMode: BrowserOpenMode,
  spawnFn: BrowserSpawnFn = defaultSpawn,
): Promise<BrowserLaunchResult> {
  const options: SpawnOptions = {
    stdio: 'ignore',
    detached: openMode === 'fullscreen',
  };
  return new Promise((resolve) => {
    let settled = false;
    let child: BrowserChildLike;
    try {
      child = spawnFn(executable, args, options);
    } catch (error) {
      resolve({ ok: false, reason: `spawn-throw: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok: false, reason: `spawn-error: ${err.message}` });
    });
    child.on('exit', () => {
      // 窗口被用户手动关掉等事件不改变启动成功的事实；组合根只在 close() 时主动 kill app 窗。
    });
    if (openMode === 'fullscreen') {
      child.unref();
    }
    // 同步 spawn 成功先乐观挂起：Node 的 ENOENT 等异步错误走 nextTick、先于定时器阶段到达，
    // 故用 setTimeout(0) 兑现成功，让 error 事件有机会抢先把结果翻成失败（微任务会早于 error，不可用）。
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: true, executable, args, child });
      }
    }, 0);
  });
}

export interface BrowserLaunchDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: BrowserSpawnFn;
}

/** 组合根入口：探测（或采信显式路径）→ 构造参数 → 拉起；任何失败均回信封而非抛出。 */
export async function launchBrowser(
  request: BrowserLaunchRequest,
  deps: BrowserLaunchDeps = {},
): Promise<BrowserLaunchResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? defaultSpawn;

  let executable = request.executablePath?.trim();
  if (executable === undefined || executable === '') {
    const resolved = await resolveExecutable(browserCandidates(platform, env), env, platform);
    if (resolved === null) {
      return { ok: false, reason: 'browser-not-found' };
    }
    executable = resolved;
  }

  const result = await spawnBrowser(
    executable,
    buildBrowserArgs(request.openMode, request.url),
    request.openMode,
    spawnFn,
  );
  if (!result.ok) {
    return result;
  }
  return { ...result, executable, args: buildBrowserArgs(request.openMode, request.url) };
}
