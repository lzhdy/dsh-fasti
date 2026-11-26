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
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Fasti } from '../../api/index.ts';
import type { ChannelDescriptor } from '../../contract/channel.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';
import { createOpenAIAgentClient, createOpenAICompatLLMPort } from '../headless/index.ts';
import { readServeConfig, type ServeConfig } from './config.ts';
import { ActivityBus } from './activity-bus.ts';
import { createObservationStage } from './observe-stage.ts';
import { createChatHandler, type ChatHandler } from './chat.ts';
import { openNodeMemoryRuntime } from './memory-session.ts';
import { startHttpServer } from './http-server.ts';
import { startClosureLoop } from './loop.ts';
import { startProjectionLoop } from './projection-loop.ts';
import { launchBrowser, type ManagedBrowserChild } from './browser-launcher.ts';

/** 前端静态资产目录（与本文件同目录的 web/，编译后 lib 镜像同构路径仍成立）。 */
const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url));

/**
 * 启动句柄。token 随句柄返回是给编程式调用/测试复用的引导口：
 * 直跑姿态下它本来就会打印到本机控制台，并不因此扩大暴露面；HTTP 鉴权纪律不变。
 */
export interface ServeHandle {
  readonly url: string;
  /** 实际监听端口（port=0 由内核分配时用于回读）。 */
  readonly port: number;
  /** 本次启动的一次性 Bearer token（进程重启即失效、不落盘）。 */
  readonly token: string;
  close(): Promise<void>;
}

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
/** 防御式对象 narrowing：节拍报告是 unknown 入参，非对象形状直接丢弃。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** 防御式数字读数：缺失或类型不符一律按 0（观测面不得因报告演进炸节拍）。 */
function numberField(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

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
export async function serve(config: ServeConfig): Promise<ServeHandle> {
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

  // #157 进程内活动总线：写入链（观测 stage）、两个节拍、读出链（聊天工具）统一汇入。
  const bus = new ActivityBus();
  fasti.registerIngestStage(createObservationStage(bus));

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
          onToolActivity: (activity) => {
            try {
              bus.emit(
                'tool.call',
                activity.ok ? 'ok' : 'warn',
                `工具 ${activity.tool} 调用${activity.ok ? '成功' : '失败'}`,
                { tool: activity.tool, ok: activity.ok, callId: activity.callId },
              );
            } catch {
              // 总线故障不反噬聊天主流程。
            }
          },
        });

  // 一次性 token：每次启动新生成、不落盘；进程重启即失效。
  const token = randomBytes(32).toString('base64url');
  // 本次启动实例 id：前端识别「后端重启、脉冲游标作废」的依据。
  const bootId = randomBytes(6).toString('hex');

  const server = await startHttpServer(fasti, {
    port: config.port,
    token,
    channel: config.channel,
    chat,
    logger,
    bus,
    observation: memoryRuntime.observation,
    bootId,
    webRoot: WEB_ROOT,
  });

  // 闭合节拍：dsh 里由宿主 scheduler 周期调 checkSilenceClock + drainClosure，
  // 这里由启动器自己驱动——否则「模型接上了却永远不会被叫到」，摘要永远 pending。
  const closureLoop = startClosureLoop(fasti, {
    onError: (error, phase) => {
      logger.warn(`闭合节拍 ${phase} 阶段失败：${error instanceof Error ? error.message : String(error)}`);
      safeBusError('closure-loop', error);
    },
    onReport: ({ closed, summaries }) => {
      // 空轮不刷活动流：只有真的闭合/摘要了事件才上报。
      if (closed > 0) {
        safeEmit('closure.drain', 'ok', `闭合 ${closed} 条安静事件`, { closed });
      }
      if (summaries > 0) {
        safeEmit('summary.drain', 'ok', `摘要处理 ${summaries} 条`, { summaries });
      }
    },
  });

  // 记忆投影节拍：独立 5s 轮询/60s 预算，把真源折叠进 memory-index，失败隔离不阻断闭合。
  const projectionLoop = startProjectionLoop(fasti, {
    onError: (error) => {
      logger.warn(`记忆投影节拍失败（已隔离）：${error instanceof Error ? error.message : String(error)}`);
      safeBusError('projection-loop', error);
    },
    onReport: (report) => {
      // 报告形状属记忆内核（MemoryProjectionDrainReport），组合根只做防御式读数：
      // skipped 非空表示本轮没干活；只有真有卡片折叠/失效/隔离/空锚才发活动。
      const data = asRecord(report);
      if (data === null || typeof data.skipped === 'string') {
        return;
      }
      const cardUpserts = numberField(data, 'cardUpserts');
      const invalidations = numberField(data, 'invalidations');
      const quarantined = numberField(data, 'quarantined');
      const emptyAnchored = numberField(data, 'emptyAnchored');
      const total = cardUpserts + invalidations + quarantined + emptyAnchored;
      if (total > 0) {
        safeEmit('memory.drain', 'ok', `记忆投影折叠 ${total} 项变更`, {
          ...(cardUpserts === 0 ? {} : { cardUpserts }),
          ...(invalidations === 0 ? {} : { invalidations }),
          ...(quarantined === 0 ? {} : { quarantined }),
          ...(emptyAnchored === 0 ? {} : { emptyAnchored }),
        });
      }
    },
  });

  function safeEmit(kind: 'closure.drain' | 'summary.drain' | 'memory.drain', level: 'ok', message: string, data: Record<string, number>): void {
    try {
      bus.emit(kind, level, message, data);
    } catch {
      // 观测故障不影响节拍。
    }
  }
  function safeBusError(phase: string, error: unknown): void {
    try {
      bus.emit('loop.error', 'error', `后台节拍失败（${phase}）`, {
        phase,
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // 总线自身故障时无处可报，静默。
    }
  }

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

  // #240 B 方案：按需代开浏览器。默认缺省不代开、老行为不变；
  // 失败只警告不抛穿（浏览器缺失/被拦都不得影响 HTTP 服务）。
  let appWindow: ManagedBrowserChild | undefined;
  if (config.openBrowser !== undefined) {
    const launcher = config.browserLauncher ?? launchBrowser;
    try {
      const launched = await launcher({
        url: `${server.url}/app/`,
        openMode: config.openBrowser,
        ...(config.browserPath === undefined ? {} : { executablePath: config.browserPath }),
      });
      if (launched.ok) {
        console.log(`[fasti-http] 已代开浏览器（${config.openBrowser}）：${launched.executable ?? ''}`);
        if (config.openBrowser === 'app') {
          appWindow = launched.child;
        }
      } else {
        console.warn(`[fasti-http] 浏览器代开未成功（${launched.reason ?? 'unknown'}），请手动打开上面的地址。`);
      }
    } catch (error) {
      console.warn('[fasti-http] 浏览器代开抛错（已隔离，不影响服务）：', error);
    }
  }

  return {
    url: server.url,
    port: server.port,
    token,
    async close() {
      // app 应用窗与服务同生共死：优雅关闭路径（Ctrl+C/编程 close）先收子进程；
      // 直接关终端的硬终止路径由操作系统收走整棵进程树，不经过这里。
      if (config.openBrowser === 'app' && appWindow !== undefined) {
        try {
          appWindow.kill();
        } catch {
          // 子进程已自行退出时 kill 无果属正常，不阻断关闭。
        }
      }
      closureLoop.stop();
      projectionLoop.stop();
      // 先释放总线上所有长轮询等待，避免 pulse 请求悬挂到 server 强制关闭。
      bus.dispose();
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
