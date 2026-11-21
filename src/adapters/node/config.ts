/**
 * node 启动器配置 —— 零依赖读环境变量（不引参数解析库，生产依赖保持空）。
 *
 * 与内核既有习惯一致：`FASTI_HOME` 复用路径中性化后的数据根解析；
 * 模型端点沿用 headless 适配器既定的 `OPENAI_*` 变量名。
 */

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
}

const DEFAULT_PORT = 8731;
const DEFAULT_CHANNEL = 'webdemo';

/** 解析并校验环境变量；非法即抛（启动期失败优于带病运行）。 */
export function readServeConfig(env: NodeJS.ProcessEnv = process.env): ServeConfig {
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

  return {
    dataRoot: env['FASTI_HOME']?.trim() || undefined,
    port,
    channel,
    openaiBaseURL: env['OPENAI_BASE_URL']?.trim() || undefined,
    openaiModel: env['OPENAI_MODEL']?.trim() || undefined,
    openaiApiKey: env['OPENAI_API_KEY']?.trim() || undefined,
  };
}
