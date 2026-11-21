/**
 * dsh 通道适配器的**宿主无关挂载面**（平台化步骤3）。
 *
 * 这一层把原 cordis 插件 `apply` 里"与具体宿主框架无关的纯编排"整体下沉：
 * 打开 Fasti、显式登记 dsh 通道、同步订阅 `session/event`、起闭合/记忆投影两个
 * 后台 worker、按需接六工具、卸载时关库——全部只认五个中性端口（logger /
 * lifecycle / scheduler / eventBus / toolHost）与外部造好传入的 LLMPort。
 *
 * 边界（刻意保持，勿越）：
 *  - **不 import cordis**：本文件不认识 Context / ctx.effect / ctx.inject / ctx.on，
 *    宿主怎么把自己的设施翻译成中性端口，是 plugin.ts 那层薄胶水的事；
 *  - **不认识 dsh-llm 模型路由**：摘要端口由外部 `createDshLLMPort(route)` 造好后
 *    经 options.llmPort 注入（null = 无模型，如实降级，绝不伪造），mount 不摸路由；
 *  - 它**仍是 dsh 适配器的一员**，而非内核：dsh 事件名 `session/event`、dsh 通道
 *    描述符、对话事件转换、六件记忆工具这些 dsh 领域知识都内聚在本目录，故保留
 *    `import type ToolDefinition`（dsh-tools 的工具形状），不把这些泄漏进内核。
 *
 * 时序红线（见 event-bus-port.ts 硬语义）：mountDshAdapter 是**同步函数**，
 * `eventBus.on(...)` 与两个 worker 的注册都在首个异步动作之前、于调用方同步栈内
 * 完成，装载与首个事件之间不留异步间隙；Fasti 实例的 open 在后台异步推进，靠
 * ready 信号让先到事件等待而非丢失。返回的句柄只暴露 `dispose()`，不提前造任何
 * 通用插件框架/注册中心（YAGNI：当前仅 dsh 一个真适配器，先立这一个具体形状）。
 */

import path from 'node:path';

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import { Fasti } from '../../api/index.ts';
import type { MemoryGateMode } from '../../assembly/memory-tools.ts';
import { createSourceLookupPort } from '../../assembly/source-lookup.ts';
import { startRecurringWorker } from '../../assembly/recurring-worker.ts';
import type { LLMPort } from '../../event/llm-port.ts';
import type { EventBusPort } from '../../ports/event-bus-port.ts';
import type { LifecyclePort } from '../../ports/lifecycle-port.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';
import type { SchedulerPort } from '../../ports/scheduler-port.ts';
import type { ToolHostPort } from '../../ports/tool-host-port.ts';
import { dshChannelDescriptor } from './channel-descriptor.ts';
import { convertSessionEvent } from './convert-event.ts';
import { initiationOf } from './initiation.ts';
import { DEFAULT_MEMORY_PROJECTION_BUDGET_MS } from './llm.ts';
import { wireMemoryTools, type MemoryWiring } from './memory-tool-bridge.ts';

/** 驱动一次 dsh 适配器挂载所需的五个中性端口（全部由宿主侧薄胶水构造）。 */
export interface MountDshAdapterPorts {
  readonly logger: LoggerPort;
  readonly lifecycle: LifecyclePort;
  readonly scheduler: SchedulerPort;
  readonly eventBus: EventBusPort;
  readonly toolHost: ToolHostPort<ToolDefinition>;
}

/** 挂载选项：只收纯标量配置与已构造好的端口，不含任何宿主对象/模型路由。 */
export interface MountDshAdapterOptions {
  /** 通道 id；调用方已完成缺省解析，mount 不内置任何具体通道默认字面。 */
  readonly channel: string;
  /**
   * 摘要端口 —— 外部按宿主模型路由造好注入；null 表示本环境无模型，
   * 闭合后摘要保持 pending + summary:null 如实标注，绝不伪造。
   */
  readonly llmPort: LLMPort | null;
  /** 数据根；缺省走 Fasti 四级解析。 */
  readonly dataRoot?: string | undefined;
  /** 摘要模型名，仅用于装载日志展示。 */
  readonly model?: string | undefined;
  /** 闭合 worker 轮询间隔（毫秒）；缺省 5 秒。 */
  readonly closureIntervalMs?: number | undefined;
  /** 单次摘要调用硬超时（毫秒），透给门面闭合管线；缺省走管线默认 60 秒。 */
  readonly closureTimeoutMs?: number | undefined;
  /** 记忆门三态；缺省 'off'（不注册任何工具，线上零变化）。 */
  readonly memoryGateMode?: MemoryGateMode | undefined;
}

/** 挂载句柄：宿主作用域卸载时调用 dispose 关库停写；幂等、不向外抛错。 */
export interface DshAdapterHandle {
  dispose(): Promise<void>;
}

/** 日志前缀 —— 便于在宿主日志里一眼认出。 */
const LOG_PREFIX = '[dsh-fasti]';

/**
 * 「门面不可用 → 丢弃」的告警节奏（m6）。
 *
 * 逐条 warn 会刷屏（每个会话事件一条），完全静默更糟（出事几个月没人知道）。
 * 首条必告警，之后每 100 条再说一次，并带上累计数。
 */
const DROP_WARN_EVERY = 100;

/** 丢弃计数（本挂载实例内）。 */
interface DropCounter {
  count: number;
}

/** 记一次「门面不可用」的丢弃，按节奏告警（不刷屏、不静默）。 */
function noteDrop(logger: LoggerPort, drops: DropCounter, reason: string): void {
  drops.count += 1;
  if (drops.count === 1 || drops.count % DROP_WARN_EVERY === 0) {
    logger.warn('%s %s（累计 %d 条未写入）', LOG_PREFIX, reason, drops.count);
  }
}

/**
 * 在一套中性端口上挂载 dsh 适配器（不依赖任何具体宿主框架）。
 *
 * 同步返回句柄；Fasti 的打开在后台异步推进，事件经 ready 信号等待、不丢首事件。
 * 后台两个 worker 的卸载清理已自行登记到传入的 lifecycle；Fasti 实例本身的关闭由
 * 返回句柄的 dispose 负责（调用方通常再用 lifecycle.onDispose 把它挂到作用域上）。
 */
export function mountDshAdapter(
  ports: MountDshAdapterPorts,
  options: MountDshAdapterOptions,
): DshAdapterHandle {
  const { logger, lifecycle, scheduler, eventBus, toolHost } = ports;
  const channel = options.channel;
  const llmPort = options.llmPort;

  /**
   * Fasti 就绪信号 —— resolve(fasti) 表示可写入，resolve(null) 表示不可写入。
   * 事件先到时在此等待，不会丢。
   */
  let markReady: (instance: Fasti | null) => void = () => undefined;
  const ready = new Promise<Fasti | null>((resolve) => {
    markReady = resolve;
  });

  /** 适配器运行态 —— dispose 后据此明确停写。 */
  const state = { closed: false };

  /** 门面不可用导致的丢弃计数（m6：首条 warn + 每 100 条一次）。 */
  const drops: DropCounter = { count: 0 };

  // 监听器**同步注册**（不放进后台 open 流程 —— 见文件头时序红线）；
  // eventBus.on 是同步薄登记，这一行仍在 mountDshAdapter 同步调用栈内，
  // 装载与首事件之间不留异步间隙。
  eventBus.on('session/event', (session: unknown, event: unknown) => {
    // 不 await —— 旁路捕获，不阻断宿主主链路。
    void handleSessionEvent(logger, state, drops, ready, channel, session, event);
  });

  // ── 闭合 worker（T8/T9）──
  // 没有它就「事件照切、摘要永远不出」——闭合管线必须有人周期性地推。
  // 独立注册（不嵌进 open 流程）：两类生命周期互不依赖，卸载时无论谁先释放都不会
  // 碰到未初始化/已关闭的实例。
  //
  // **无条件启动**（不再要求 llmPort !== null）：时钟静默检查（定案稿 C6）必须
  // 独立于 LLM 端口 —— 没有模型端口时，安静够久的 open 事件照样该闭合，
  // 只是摘要保持 pending。若把 worker 挂在端口条件下，A6b 直接不成立：
  // 无端口 → 无 worker → 永不闭合。
  startRecurringWorker(
    { lifecycle, scheduler, logger },
    async () => {
      const fasti = await ready;
      if (fasti === null || state.closed) {
        // worker 是周期性的：门面没打开时不必告警（事件路径那侧已经记过账），
        // 只需安静返回 0，别在日志里每 5 秒刷一条。
        return 0;
      }
      // ① 时钟静默：与摘要无关，先跑 —— 闭合是「切」的事，摘要是「写」的事。
      fasti.checkSilenceClock();
      // ② 摘要 drain：端口为 null 时管线自己会记 permanent 失败并保持 pending。
      return fasti.drainClosure();
    },
    {
      label: 'dsh-fasti-closure-worker',
      failureLogFormat: '[dsh-fasti] 闭合 worker 本轮失败：%s',
      ...(options.closureIntervalMs === undefined ? {} : { intervalMs: options.closureIntervalMs }),
    },
  );

  // ── 记忆投影 worker（第七法）──
  // 调度点排在闭合 worker 之后：closure 先行，记忆 drain 本轮在后；两者轮次与预算独立，
  // 记忆 drain 失败在门面/worker 两层隔离，不阻断闭合管线。
  startRecurringWorker(
    { lifecycle, scheduler, logger },
    async () => {
      const fasti = await ready;
      if (fasti === null || state.closed) {
        return;
      }
      await fasti.drainMemoryProjection(DEFAULT_MEMORY_PROJECTION_BUDGET_MS);
    },
    {
      label: 'dsh-fasti-memory-projection-worker',
      failureLogFormat: '[dsh-fasti] 记忆投影 worker 本轮失败：%s',
    },
  );

  // 工具接线运行态：提到 mount 顶层，使 dispose 与晚到的 withTools 回调都能看到。
  let memoryWiring: MemoryWiring | null = null;
  let wiringClosed = false;
  /** open 成功后置位；open/登记失败保持 null，dispose 不重复关闭。 */
  let closeFasti: (() => Promise<void>) | null = null;

  // 后台打开实例（替代原 cordis ctx.effect 的 async 体）：不阻塞 mount 同步返回，
  // 成败都经 ready 信号通知事件路径；dispose 会 await 本 promise 再决定是否关库。
  const setupPromise = (async (): Promise<void> => {
    let fasti: Fasti;
    try {
      fasti = await Fasti.open({
        ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
        // 平台化 H2-b：内核不写死通道→物理目录，dsh 适配器挂载时显式声明本通道
        // 的原文落扁平目录 raw-turns/（存量物理布局）；不声明则内核默认走 raw/<channel>/。
        flatRawChannels: [channel],
        // 端口注入门面：闭合后摘要由门面内部那条管线在后台做。
        llmPort,
        // 单次调用硬超时（与端口兜底同一个数，避免两处各调一套）。
        ...(options.closureTimeoutMs === undefined
          ? {}
          : { closureCallTimeoutMs: options.closureTimeoutMs }),
        // 摘要失败上报宿主日志（可观测性三处之一：内存明细 / 检查点 / 宿主日志）。
        onClosureFailure: (failure) => {
          logger.warn(
            '%s 摘要未生成（%s，已试 %d 次）：%s',
            LOG_PREFIX,
            failure.state,
            failure.attempts,
            failure.error,
          );
        },
        // L3 观测逐事件 warn（不设代码阈值；三率派生与人工阈值进 runbook，定稿 §7.2）。
        onClosureObservation: (observation) => {
          logger.warn('%s 摘要观测：%s', LOG_PREFIX, JSON.stringify(observation));
        },
        // 门面内部诊断（目前只有「待补摘要数读不出来」）—— 转给宿主日志。
        onDiagnostic: (level, message) => {
          if (level === 'warn') {
            logger.warn('%s %s', LOG_PREFIX, message);
          }
        },
      });
    } catch (error) {
      logger.error('%s 打开数据根失败：%s', LOG_PREFIX, String(error));
      markReady(null);
      return;
    }

    // 通道登记：内核空白启动不预置任何宿主通道，dsh 通道由本次挂载**显式**登记。
    //
    // 纪律（定案稿 §10.2，注册表是「可增长的登记表」，既有条目永不被改写）：
    //  - 同 id 描述等价 → registerChannel 幂等沿用既有；
    //  - 同 id 描述不等价（用户手动改过注册表）→ 抛 ConflictError，绝不覆盖，
    //    本适配器 fail-closed：告警、关闭实例、标记未就绪，本次会话不写入。
    try {
      await fasti.registerChannel(dshChannelDescriptor(channel));
    } catch (error) {
      logger.error(
        '%s 通道「%s」登记失败（可能与 channels.json 既有描述冲突）—— 本次会话不写入原文与经历：%s',
        LOG_PREFIX,
        channel,
        String(error),
      );
      await fasti.close();
      markReady(null);
      return;
    }

    logger.info(
      '%s 适配器已装载：通道=%s，数据根=%s，摘要模型=%s',
      LOG_PREFIX,
      channel,
      fasti.paths.root,
      llmPort === null ? '未配置（摘要保持待生成）' : (options.model ?? '宿主默认'),
    );
    markReady(fasti);
    closeFasti = () => fasti.close();

    // ── WP4b 记忆工具接线（默认 off：不打开桥接、不注册任何工具，线上零变化）──
    // indexDir 固定落在本数据根 projection 下；旧路检索直接复用门面 search（字段天然对齐）。
    const gateMode = options.memoryGateMode ?? 'off';

    // 经工具宿主端口申请授权接入：弱宿主无工具服务时回调不触发、tools 形状残损时
    // registry 为 null，二者都由 wireMemoryTools 安全跳过，绝不让主流程启动失败。
    if (gateMode !== 'off') {
      toolHost.withTools(({ registry, onDispose }) => {
        if (wiringClosed) return;
        const wiring = wireMemoryTools({
          registry,
          mode: gateMode,
          indexDir: path.join(fasti.paths.projection, 'memory-index'),
          // #122：第七法 drain 只读折叠真源所需的数据根；取门面已解析的布局根（比可选
          // options.dataRoot 可靠），缺这一截会让运行期 worker 每轮 readSource 空集。
          dataRoot: fasti.paths.root,
          // #115 E.5：落空台账通道名复用上层已做非空校验的同一 channel 变量。
          channel,
          // L6 注入只读下钻端口（#114 E.4.1／#115 通道闸）：第二参盖章本通道，
          // 门面结构满足 SourceLookupFacade，装配层不反向 import 门面。
          sourceLookup: createSourceLookupPort(fasti, { channel }),
          log: (message) => logger.warn('%s %s', LOG_PREFIX, message),
          // #117 哨兵：跨过硬顶 70% 那一刻告警一次（走同一条宿主日志通道，不新增输出面）。
          onMissRetentionWarning: (message) => logger.warn('%s %s', LOG_PREFIX, message),
        });
        memoryWiring = wiring;
        // DI 绑定：把装配运行面的第七法端口挂到门面（端口未就绪时为 null，门面短路 not-wired）。
        void ready.then((instance) => {
          if (instance !== null) {
            instance.bindMemoryProjection(wiring.memoryProjection);
          }
        });
        if (wiring.registered) {
          logger.info('%s 记忆工具已注册：门模式=%s', LOG_PREFIX, gateMode);
        }
        // 工具接入作用域卸载兜底；主 dispose 已显式 dispose，wireMemoryTools 幂等故重复调用安全。
        onDispose(() => {
          void memoryWiring?.dispose();
        });
      });
    }
  })();

  // 句柄 dispose：幂等、吞错记账（符合 LifecyclePort「清理不向外抛」契约）。
  // 一进来就置停写/停止接线意图，再等后台 open 落定，避免与飞行中的打开竞争。
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    state.closed = true;
    wiringClosed = true;
    logger.info('%s 适配器卸载：注销记忆工具并关闭数据根', LOG_PREFIX);
    try {
      await setupPromise;
      if (memoryWiring !== null) {
        await memoryWiring.dispose();
      }
      if (closeFasti !== null) {
        await closeFasti();
      }
    } catch (error) {
      // 卸载错误不得变成 unhandledRejection 炸宿主：记账后安静收尾。
      logger.error('%s 适配器卸载异常：%s', LOG_PREFIX, String(error));
    }
  };

  return { dispose };
}

/**
 * 处理一条 `session/event` —— 转换 → 摄入。
 *
 * 失败**不抛给宿主主链路**，但必须 logger.error（失败可观测，不静默吞事件）。
 */
async function handleSessionEvent(
  logger: LoggerPort,
  state: { closed: boolean },
  drops: DropCounter,
  ready: Promise<Fasti | null>,
  channel: string,
  session: unknown,
  event: unknown,
): Promise<void> {
  try {
    const { input, skip, warnings } = convertSessionEvent(session, event);

    for (const warning of warnings) {
      logger.warn('%s %s', LOG_PREFIX, warning);
    }

    if (input === null) {
      // 系统注入是 harness 的正常形态 → debug 级别；其余异常形态 → warn。
      if (skip?.kind === 'system-injection' || skip?.kind === 'not-message') {
        logger.debug('%s 跳过事件：%s', LOG_PREFIX, skip?.detail ?? '未知原因');
      } else {
        logger.warn('%s 跳过事件：%s', LOG_PREFIX, skip?.detail ?? '未知原因');
      }
      return;
    }

    const fasti = await ready;
    if (fasti === null || state.closed) {
      // 卸载中（state.closed）是正常收尾，静默；门面没打开（fasti === null）则
      // 意味着**每条事件都白掉了** —— 首条 warn + 计数，不刷屏也不静默（m6）。
      if (fasti === null && !state.closed) {
        noteDrop(logger, drops, `门面未就绪，事件未写入（通道=${channel}）`);
      }
      return;
    }

    // 经历身份由 dsh 适配器映射（speaker→initiation）；input 其余字段作原文行原样落盘。
    await fasti.ingestRawTurn(channel, {
      ...input,
      initiation: initiationOf(input.speaker),
    });
  } catch (error) {
    // 旁路捕获：吞掉异常以免阻断宿主主链路，但必须留下可观测的记录。
    logger.error('%s 摄入失败：%s', LOG_PREFIX, String(error));
  }
}
