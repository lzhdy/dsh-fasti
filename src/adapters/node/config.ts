/**
 * node 启动器配置 —— 零依赖读环境变量与极简 argv（不引参数解析库，生产依赖保持空）。
 *
 * 与内核既有习惯一致：`FASTI_HOME` 复用路径中性化后的数据根解析；
 * 模型端点沿用 headless 适配器既定的 `OPENAI_*` 变量名。
 *
 * #240 B 方案新增浏览器代开两档（默认缺省 = 保持只打印 URL 的老行为）：
 *  - 环境变量 `FASTI_OPEN_BROWSER=app|fullscreen|off`、`FASTI_BROWSER_PATH=<可执行体>`；
 *  - 直跑 argv `--open=<mode>` / `--open <mode>`、`--browser-path=<p>`，argv 优先级高于 env。
 */

import type { BrowserLauncherFn, BrowserOpenMode } from './browser-launcher.ts';

/** 生效配置。 */
export interface ServeConfig {
  /** 数据根；缺省 = 内核默认根（`.fasti`）。 */
  readonly dataRoot: string | undefined;
  /** 监听端口。 */
  readonly port: number;
  /** 默认通道 id。 */
  readonly channel: string;
  /** 模型端点（无则纯词法、摘要 pending）。 */
  readonly openaiBaseURL: string | undefined;
  /** 模型名。 */
  readonly openaiModel: string | undefined;
  /** 模型密钥。 */
  readonly openaiApiKey: string | undefined;
  /**
   * 可选推理档位（#154，环境变量 OPENAI_REASONING_EFFORT）：透传为请求体 reasoning_effort。
   * 缺省/空白 = undefined，两端口都不发该键（吃模型端点默认档）。
   */
  readonly openaiReasoningEffort: string | undefined;
  /** 浏览器代开模式；undefined = 不代开（老行为）。 */
  readonly openBrowser?: BrowserOpenMode;
  /** 显式浏览器可执行体路径；undefined = 走平台候选自动探测。 */
  readonly browserPath?: string;
  /**
   * 测试注入缝：组合根默认用 browser-launcher 的真实实现，红测注入假启动器断言接线；
   * readServeConfig 永不产出本字段，编程式嵌入方可显式传。
   */
  readonly browserLauncher?: BrowserLauncherFn;
}

const DEFAULT_PORT = 8731;
const DEFAULT_CHANNEL = 'webdemo';
const OPEN_MODES: readonly BrowserOpenMode[] = ['app', 'fullscreen'];

/** 读取 `--name=value` 或 `--name value` 两种形式；未出现回 undefined。 */
function readArg(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === name) {
      return argv[i + 1];
    }
    if (token.startsWith(`${name}=`)) {
      return token.slice(name.length + 1);
    }
  }
  return undefined;
}

/** 校验模式取值并收窄类型；fromArgv 决定报错文案指 argv 还是环境变量。 */
function normalizeMode(raw: string, fromArgv: boolean): BrowserOpenMode | undefined {
  const value = raw.trim();
  if (value === '' || value === 'off') {
    return undefined;
  }
  if (!OPEN_MODES.includes(value as BrowserOpenMode)) {
    throw new Error(
      fromArgv
        ? `--open 只接受 app 或 fullscreen（off/缺省=不代开），实际收到：${value}`
        : `FASTI_OPEN_BROWSER 只接受 app、fullscreen 或 off，实际收到：${value}`,
    );
  }
  return value as BrowserOpenMode;
}

/** 解析并校验环境变量与 argv；非法即抛（启动期失败优于带病运行）。 */
export function readServeConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): ServeConfig {
  const portRaw = env['FASTI_HTTP_PORT']?.trim();
  let port = DEFAULT_PORT;
  if (portRaw !== undefined && portRaw !== '') {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`FASTI_HTTP_PORT 必须是 1–65535 的整数，实际收到：${portRaw}`);
    }
    port = parsed;
  }

  const channel = env['FASTI_CHANNEL']?.trim() || DEFAULT_CHANNEL;
  if (channel === '') {
    throw new Error('FASTI_CHANNEL 不能为空白');
  }

  const argvMode = readArg(argv, '--open');
  const openBrowser = argvMode !== undefined
    ? normalizeMode(argvMode, true)
    : normalizeMode(env['FASTI_OPEN_BROWSER'] ?? '', false);

  const browserPathRaw = (readArg(argv, '--browser-path') ?? env['FASTI_BROWSER_PATH'] ?? '').trim();
  const browserPath = browserPathRaw === '' ? undefined : browserPathRaw;

  return {
    dataRoot: env['FASTI_HOME']?.trim() || undefined,
    port,
    channel,
    openaiBaseURL: env['OPENAI_BASE_URL']?.trim() || undefined,
    openaiModel: env['OPENAI_MODEL']?.trim() || undefined,
    openaiApiKey: env['OPENAI_API_KEY']?.trim() || undefined,
    openaiReasoningEffort: env['OPENAI_REASONING_EFFORT']?.trim() || undefined,
    ...(openBrowser === undefined ? {} : { openBrowser }),
    ...(browserPath === undefined ? {} : { browserPath }),
  };
}
