/**
 * node 启动器组合根（平台化 #72 宿主无关启动器·第一刀入口）。
 *
 * 地位等同 dsh 的 `plugin.ts`：**唯一**实例化装配点——读配置、开门、造 LLM 端口
 * （仅当配了端点）、登记通道、生成一次性 token、起服务、接信号优雅关闭。
 * 机制（路由与安全）在 `http-server.ts`，本文件只管装配，方便静态守卫按
 * 「装配根白名单」精确豁免它引用 headless 适配器。
 *
 * 直跑：`node src/adapters/node/serve.ts`（或 `npm start`）。
 */

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { Fasti } from '../../api/index.ts';
import type { ChannelDescriptor } from '../../contract/channel.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';
import { createOpenAICompatLLMPort } from '../headless/index.ts';
import { readServeConfig, type ServeConfig } from './config.ts';
import { startHttpServer } from './http-server.ts';
import { startClosureLoop } from './loop.ts';

/** 最小 console 日志端口：前缀 + printf 占位。 */
function consoleLogger(): LoggerPort {
  const emit = (level: string) => (format: string, ...args: unknown[]) => {
    console.error(`[fasti-http] ${level} ${format}`, ...args);
  };
  return {
    debug: () => undefined,
    info: (format, ...args) => console.log(`[fasti-http] info ${format}`, ...args),
    warn: emit('warn'),
    error: emit('error'),
  };
}

/** 由配置派生通道描述符（中性、不含任何宿主字面）。 */
function descriptorOf(channel: string): ChannelDescriptor {
  return {
    id: channel,
    label: '本机网页直连通道',
    modalities: ['text'],
    capture: 'full',
    counterpart: 'user',
    adapter_version: 'node-http-0',
  };
}

/** 装配并启动；返回句柄供测试/嵌入复用。 */
export async function serve(config: ServeConfig): Promise<{ url: string; close(): Promise<void> }> {
  const logger = consoleLogger();

  const llmPort =
    config.openaiBaseURL !== undefined && config.openaiModel !== undefined
      ? createOpenAICompatLLMPort({
          baseURL: config.openaiBaseURL,
          model: config.openaiModel,
          apiKey: config.openaiApiKey,
        })
      : null;

  const fasti = await Fasti.open({
    ...(config.dataRoot === undefined ? {} : { dataRoot: config.dataRoot }),
    llmPort,
    onDiagnostic: (level, message) => logger.warn(`${level}: ${message}`),
  });

  await fasti.registerChannel(descriptorOf(config.channel));

  // 一次性 token：每次启动新生成、不落盘；进程重启即失效。
  const token = randomBytes(32).toString('base64url');

  const server = await startHttpServer(fasti, { port: config.port, token, channel: config.channel, logger });

  // 闭合节拍：dsh 里由宿主 scheduler 周期调 checkSilenceClock + drainClosure，
  // 这里由启动器自己驱动——否则「模型接上了却永远不会被叫到」，摘要永远 pending。
  const loop = startClosureLoop(fasti, {
    onError: (error, phase) => logger.warn(`闭合节拍 ${phase} 阶段失败：${error instanceof Error ? error.message : String(error)}`),
  });

  console.log(`[fasti-http] 已启动：${server.url}`);
  console.log(`[fasti-http] 数据根：${fasti.paths.root}`);
  console.log(`[fasti-http] 通道：${config.channel}　模型：${llmPort === null ? '未配置（摘要保持 pending）' : config.openaiModel}`);
  console.log('[fasti-http] 闭合节拍：每 5 秒一次（先闭合安静够久的事件，再补摘要）。');
  console.log('[fasti-http] 浏览器打开上面的地址即可（页面已内联本次 token）。');
  console.log(`[fasti-http] 命令行验证：curl -H "Authorization: Bearer ${token}" '${server.url}/experiences?channel=${config.channel}'`);

  return {
    url: server.url,
    async close() {
      loop.stop();
      await server.close();
      await fasti.close();
    },
  };
}

/** 直跑入口：仅当作为主模块执行时启动（被 import 时不启动，便于测试复用）。 */
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const config = readServeConfig();
  const handle = await serve(config);
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) {
      return;
    }
    closing = true;
    console.log(`[fasti-http] 收到 ${signal}，正在优雅关闭…`);
    void handle.close().then(
      () => {
        console.log('[fasti-http] 已关闭，进程退出。');
        process.exit(0);
      },
      (error: unknown) => {
        console.error('[fasti-http] 关闭失败：', error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}
