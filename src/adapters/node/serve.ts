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
import { createOpenAIAgentClient, createOpenAICompatLLMPort } from '../headless/index.ts';
import { readServeConfig, type ServeConfig } from './config.ts';
import { createChatHandler, type ChatHandler } from './chat.ts';
import { openNodeMemoryRuntime } from './memory-session.ts';
import { startHttpServer } from './http-server.ts';
import { startClosureLoop } from './loop.ts';
import { startProjectionLoop } from './projection-loop.ts';

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
          ...(config.openaiReasoningEffort === undefined
            ? {}
            : { reasoningEffort: config.openaiReasoningEffort }),
        })
      : null;

  // agent 回路与摘要端口同一份端点配置；未配端点时显式 null，/chat 路由回 503。
  const agentClient =
    config.openaiBaseURL !== undefined && config.openaiModel !== undefined
      ? createOpenAIAgentClient({
          baseURL: config.openaiBaseURL,
          model: config.openaiModel,
          apiKey: config.openaiApiKey,
          ...(config.openaiReasoningEffort === undefined
            ? {}
            : { reasoningEffort: config.openaiReasoningEffort }),
        })
      : null;

  const fasti = await Fasti.open({
    ...(config.dataRoot === undefined ? {} : { dataRoot: config.dataRoot }),
    llmPort,
    onDiagnostic: (level, message) => logger.warn(`${level}: ${message}`),
  });

  await fasti.registerChannel(descriptorOf(config.channel));

  // 记忆工具宿主：node 身体固定 on（mode 在 memory-session 内写死，无开关可翻）。
  // 索引库未建时 indexReady=false，门工具回 unavailable 信封、纯聊天不受影响（Q3 只开不建）。
  const memoryRuntime = openNodeMemoryRuntime({
    fasti,
    channel: config.channel,
    onWarning: (message) => logger.warn(message),
  });
  // DI 绑定第七法投影端口（窄柄不可用时为 null，门面短路 not-wired）。
  fasti.bindMemoryProjection(memoryRuntime.memoryProjection);

  // 组合根唯一装配点：聊天处理器在此接线（机制层只拿结构化函数，不引 headless）。
  const chat: ChatHandler | null =
    agentClient === null
      ? null
      : createChatHandler({
          fasti,
          channel: config.channel,
          client: agentClient,
          toolHost: memoryRuntime,
        });

  // 一次性 token：每次启动新生成、不落盘；进程重启即失效。
  const token = randomBytes(32).toString('base64url');

  const server = await startHttpServer(fasti, { port: config.port, token, channel: config.channel, chat, logger });

  // 闭合节拍：dsh 里由宿主 scheduler 周期调 checkSilenceClock + drainClosure，
  // 这里由启动器自己驱动——否则「模型接上了却永远不会被叫到」，摘要永远 pending。
  const closureLoop = startClosureLoop(fasti, {
    onError: (error, phase) => logger.warn(`闭合节拍 ${phase} 阶段失败：${error instanceof Error ? error.message : String(error)}`),
  });

  // 记忆投影节拍：独立 5s 轮询/60s 预算，把真源折叠进 memory-index，失败隔离不阻断闭合。
  const projectionLoop = startProjectionLoop(fasti, {
    onError: (error) => logger.warn(`记忆投影节拍失败（已隔离）：${error instanceof Error ? error.message : String(error)}`),
  });

  console.log(`[fasti-http] 已启动：${server.url}`);
  console.log(`[fasti-http] 数据根：${fasti.paths.root}`);
  console.log(`[fasti-http] 通道：${config.channel}　模型：${llmPort === null ? '未配置（摘要 pending、/chat 回 503）' : config.openaiModel}`);
  console.log('[fasti-http] 闭合节拍：每 5 秒一次（先闭合安静够久的事件，再补摘要）。');
  console.log(
    memoryRuntime.indexReady
      ? '[fasti-http] 记忆门：固定 on，记忆索引已就绪，六工具进程内可用。'
      : '[fasti-http] 记忆门：固定 on，但记忆索引未建（门工具回 unavailable）；建库：node scripts/build-memory-index.ts --data-root '
        + `${fasti.paths.root} --apply --yes，建后由投影节拍自动增量维护。`,
  );
  console.log('[fasti-http] 浏览器打开上面的地址即可（页面已内联本次 token）。');
  console.log(`[fasti-http] 命令行验证：curl -H "Authorization: Bearer ${token}" '${server.url}/experiences?channel=${config.channel}'`);

  return {
    url: server.url,
    async close() {
      closureLoop.stop();
      projectionLoop.stop();
      await server.close();
      await memoryRuntime.dispose();
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
