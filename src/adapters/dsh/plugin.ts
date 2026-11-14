/**
 * cordis 插件入口 —— dsh 通道适配器（阶段 4）。
 *
 * 这是**唯一**与宿主包（cordis）耦合的地方：
 *  - A 内核（core / source / projection / contract）零生产依赖不变；
 *  - cordis 只作 peerDependency（宿主提供）+ devDependency（类型与测试）。
 *
 * 职责：
 *  1. 装载时打开 Fasti 实例（数据根走三级解析，config 可显式覆盖）；
 *  2. 核对 dsh 通道已注册（channels.json 已预置描述符）；
 *  3. 监听 `session/event`，把真实对话事件实时翻写为「原文 + 经历」写进 Fasti；
 *  4. 用 `ctx.effect` 管理生命周期：装载时 open，卸载时 close。
 *
 * 纪律（任务书 §4.4）：
 *  - **旁路捕获**：摄入失败**不阻断 dsh 主链路**；
 *  - 但失败**必须可观测**（logger 告警/报错），绝不静默吞事件。
 *
 * 时序要点（实测 cordis 4.1 的行为）：
 *  - `ctx.on(...)` **必须同步注册**。若放进异步的 `ctx.effect` 体内，
 *    监听器要等 Fasti 打开后才挂上，装载与首个事件之间会丢事件。
 *    故此处：**同步挂监听器**（cordis 自动把它挂到当前 fiber，卸载时移除），
 *    **effect 只管 Fasti 实例的生命周期**。
 *  - 监听器内部 `await ready`（Fasti 就绪信号）——事件先到也不丢，
 *    只是等实例就绪后再写入。
 */

import path from 'node:path';

import type { Context } from '@deepseek-ai/cordis';

import { Fasti } from '../../api/index.ts';
import type { MemoryGateMode } from '../../assembly/memory-tools.ts';
import { createSourceLookupPort } from '../../assembly/source-lookup.ts';
import { convertSessionEvent } from './convert-event.ts';
import { createDshLLMPort, startClosureWorker } from './llm.ts';
import type { DshModelRoute } from './llm.ts';
import { wireMemoryTools, type DshToolRegistry, type MemoryWiring } from './memory-tool-bridge.ts';

/**
 * dsh-session 广播的事件：会话日志追加（含 user/message / assistant/message）。
 *
 * 本插件**只读监听**，不注入 session 服务 —— 事件的第一参数已带 session 对象。
 *
 * 模块增强（declare module）把宿主事件面补到 cordis 的 `Events` 接口上，
 * 旧项目 `dsh-persona-innate` 用的是同款做法。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/event'(session: unknown, event: unknown): void;
  }
}

/** 插件配置。 */
export interface DshAdapterConfig {
  /**
   * 数据根 —— 显式指定即最高优先级。
   * 缺省走 Fasti 的三级解析：显式配置 > `$DSH_HOME/fasti` > `~/.dsh/fasti`。
   */
  dataRoot?: string | undefined;
  /** 通道 id；缺省 'dsh'。 */
  channel?: string | undefined;
  /** 摘要模型（D8：可与做梦模型分开、可用更便宜的模型）；缺省走宿主默认模型。 */
  model?: string | undefined;
  /**
   * 宿主模型路由 —— **注入后闭合摘要链路才真正可用**。
   *
   * 为什么是显式注入而不是从 ctx 里摸：宿主模型路由的入口形态在仓库内无从查证
   * （技术基线 §6.6「T7 开工前须在真机确认」），摸错了会在运行期静默拿不到模型。
   * 故这里只认**注入**：宿主（或真机验收脚本）把 `complete()` 塞进来。
   *
   * 未注入 = 本环境没有模型 → 事件闭合后摘要保持 `pending` + `summary: null`
   * 如实标注，**绝不伪造**；配置就绪下次开机由清道夫补齐。
   */
  modelRoute?: DshModelRoute | undefined;
  /** 闭合 worker 的轮询间隔（毫秒）；缺省 5 秒。 */
  closureIntervalMs?: number | undefined;
  /**
   * 单次摘要调用的硬超时（毫秒）；缺省 60 秒（设计稿 v1.1 §6.3.1 纪律①）。
   *
   * 调到分钟级以上等于把「一次挂死停掉整条队列」放回来 —— 不许调成无限。
   */
  closureTimeoutMs?: number | undefined;
  /**
   * 记忆门三态开关；缺省 'off'。
   *
   *  - 'off'（默认）：不注册任何记忆工具，线上召回路径与现状完全一致（零变化）；
   *  - 'shadow'：注册四工具，但检索主返回仍走旧路，仅旁路落无原文影子观测用于灰度比对；
   *  - 'on'：门裁决生效，召回以窄柄门结果为准。
   *
   * 切到 'shadow'/'on' 属 Q3 显式授权动作，运行期不得自行翻转。
   */
  memoryGateMode?: MemoryGateMode | undefined;
}

/** 日志前缀 —— 便于在 dsh 日志里一眼认出。 */
const LOG_PREFIX = '[dsh-fasti]';

/**
 * 「门面不可用 → 丢弃」的告警节奏（m6）。
 *
 * 逐条 warn 会刷屏（每个会话事件一条），完全静默更糟（出事几个月没人知道）。
 * 首条必告警，之后每 100 条再说一次，并带上累计数。
 */
const DROP_WARN_EVERY = 100;

/** 丢弃计数（本插件实例内）。 */
interface DropCounter {
  count: number;
}

/** 记一次「门面不可用」的丢弃，按节奏告警（不刷屏、不静默）。 */
function noteDrop(ctx: Context, drops: DropCounter, reason: string): void {
  drops.count += 1;
  if (drops.count === 1 || drops.count % DROP_WARN_EVERY === 0) {
    ctx.logger.warn('%s %s（累计 %d 条未写入）', LOG_PREFIX, reason, drops.count);
  }
}

/**
 * 插件配置的手写校验（不引入 schemastery —— 两个可选字段不值得多一个 peer 依赖）。
 *
 * 坏配置**抛错**：插件装载失败必须显式，不能带着半截配置跑起来。
 */
export function parseAdapterConfig(raw: unknown): DshAdapterConfig {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-fasti 适配器配置必须是对象');
  }
  const obj = raw as Record<string, unknown>;

  const dataRoot = obj['dataRoot'];
  if (dataRoot !== undefined && typeof dataRoot !== 'string') {
    throw new TypeError('dsh-fasti 适配器配置 dataRoot 必须是字符串');
  }

  const channel = obj['channel'];
  if (channel !== undefined && (typeof channel !== 'string' || channel === '')) {
    throw new TypeError('dsh-fasti 适配器配置 channel 必须是非空字符串');
  }

  const model = obj['model'];
  if (model !== undefined && (typeof model !== 'string' || model === '')) {
    throw new TypeError('dsh-fasti 适配器配置 model 必须是非空字符串');
  }

  const modelRoute = obj['modelRoute'];
  if (modelRoute !== undefined) {
    // 路由是宿主注入的对象，不是 JSON —— 只校验它真的能发起补全，
    // 免得「配了但形状不对」在运行期静默降级成 no model。
    if (
      typeof modelRoute !== 'object' ||
      modelRoute === null ||
      typeof (modelRoute as DshModelRoute).complete !== 'function'
    ) {
      throw new TypeError('dsh-fasti 适配器配置 modelRoute 必须实现 complete(req) 方法');
    }
  }

  const closureIntervalMs = obj['closureIntervalMs'];
  if (
    closureIntervalMs !== undefined &&
    (typeof closureIntervalMs !== 'number' || !Number.isFinite(closureIntervalMs) || closureIntervalMs <= 0)
  ) {
    throw new TypeError('dsh-fasti 适配器配置 closureIntervalMs 必须是正数（毫秒）');
  }

  const closureTimeoutMs = obj['closureTimeoutMs'];
  if (
    closureTimeoutMs !== undefined &&
    (typeof closureTimeoutMs !== 'number' || !Number.isFinite(closureTimeoutMs) || closureTimeoutMs <= 0)
  ) {
    throw new TypeError('dsh-fasti 适配器配置 closureTimeoutMs 必须是正数（毫秒）');
  }

  const memoryGateMode = obj['memoryGateMode'];
  if (memoryGateMode !== undefined && (typeof memoryGateMode !== 'string' || !isMemoryGateMode(memoryGateMode))) {
    throw new TypeError('dsh-fasti 适配器配置 memoryGateMode 必须是 off / shadow / on 之一');
  }

  // 只保留显式给出的键 —— 缺省字段不占位（配置对象保持干净）。
  const config: DshAdapterConfig = {};
  if (dataRoot !== undefined) {
    config.dataRoot = dataRoot as string;
  }
  if (channel !== undefined) {
    config.channel = channel as string;
  }
  if (model !== undefined) {
    config.model = model as string;
  }
  if (modelRoute !== undefined) {
    config.modelRoute = modelRoute as DshModelRoute;
  }
  if (closureIntervalMs !== undefined) {
    config.closureIntervalMs = closureIntervalMs as number;
  }
  if (closureTimeoutMs !== undefined) {
    config.closureTimeoutMs = closureTimeoutMs as number;
  }
  if (memoryGateMode !== undefined) {
    config.memoryGateMode = memoryGateMode as MemoryGateMode;
  }
  return config;
}

/** 记忆门三态字面量集合（手写校验，不引 schemastery）。 */
const MEMORY_GATE_MODES: readonly MemoryGateMode[] = ['off', 'shadow', 'on'];

function isMemoryGateMode(value: string): value is MemoryGateMode {
  return (MEMORY_GATE_MODES as readonly string[]).includes(value);
}

/**
 * 在**已获 tools 注入授权**的上下文上做结构化探测，取出工具注册服务。
 *
 * 调用前提：cordis 4.0.5 对服务访问强制授权，未先 `ctx.inject(['tools'], …)` 就读取
 * `ctx.tools` 会抛 "cannot get property tools without inject"。因此本函数只允许在该
 * inject 回调拿到的子上下文上调用；这里仍保留「具备 register 函数才认」的结构化校验，
 * 防范形态异常/被裁掉 tools 服务的弱宿主，缺失时返回 null 由接线层安全跳过。
 */
function resolveToolRegistry(ctx: Context): DshToolRegistry | null {
  const candidate = (ctx as unknown as { tools?: unknown }).tools;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof (candidate as DshToolRegistry).register === 'function'
  ) {
    return candidate as DshToolRegistry;
  }
  return null;
}

/**
 * 插件入口 —— cordis 对象插件的 `apply`。
 */
export function apply(ctx: Context, rawConfig?: DshAdapterConfig): void {
  const config = parseAdapterConfig(rawConfig);
  const channel = config.channel ?? 'dsh';

  /**
   * Fasti 就绪信号 —— resolve(fasti) 表示可写入，resolve(null) 表示不可写入。
   * 事件先到时在此等待，不会丢。
   */
  let markReady: (instance: Fasti | null) => void = () => undefined;
  const ready = new Promise<Fasti | null>((resolve) => {
    markReady = resolve;
  });

  /** 适配器运行态 —— 卸载后据此明确停写。 */
  const state = { closed: false };

  /** 门面不可用导致的丢弃计数（m6：首条 warn + 每 100 条一次）。 */
  const drops: DropCounter = { count: 0 };

  /**
   * 摘要端口 —— 宿主路由注入了才有模型；没注入就是 null（如实降级，不伪造）。
   */
  const port =
    config.modelRoute === undefined
      ? null
      : createDshLLMPort(config.modelRoute, {
          ...(config.model === undefined ? {} : { model: config.model }),
          ...(config.closureTimeoutMs === undefined ? {} : { timeoutMs: config.closureTimeoutMs }),
        });

  // 监听器**同步注册**（不放在异步 effect 体内 —— 见文件头时序要点）。
  ctx.on('session/event', (session: unknown, event: unknown) => {
    // 不 await —— 旁路捕获，不阻断 dsh 主链路。
    void handleSessionEvent(ctx, state, drops, ready, channel, session, event);
  });

  // ── 闭合 worker（T8/T9）──
  // 没有它就「事件照切、摘要永远不出」——闭合管线必须有人周期性地推。
  // 独立注册（不嵌在下面的 open effect 里）：两类生命周期互不依赖，
  // 卸载时无论谁先释放都不会碰到未初始化/已关闭的实例。
  //
  // **无条件启动**（不再要求 port !== null）：时钟静默检查（定案稿 C6）必须
  // 独立于 LLM 端口 —— 没有模型端口时，安静够久的 open 事件照样该闭合，
  // 只是摘要保持 pending。若把 worker 挂在 port 条件下，A6b 直接不成立：
  // 无端口 → 无 worker → 永不闭合。
  startClosureWorker(
    ctx,
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
    config.closureIntervalMs === undefined ? {} : { intervalMs: config.closureIntervalMs },
  );

  // 生命周期：装载时 open，卸载时 close（释放 SQLite 句柄）。
  ctx.effect(async () => {
    let fasti: Fasti;
    try {
      fasti = await Fasti.open({
        ...(config.dataRoot === undefined ? {} : { dataRoot: config.dataRoot }),
        // 端口注入门面：闭合后摘要由门面内部那条管线在后台做。
        llmPort: port,
        // 单次调用硬超时（与端口兜底同一个数，避免两处各调一套）。
        ...(config.closureTimeoutMs === undefined
          ? {}
          : { closureCallTimeoutMs: config.closureTimeoutMs }),
        // 摘要失败上报宿主日志（可观测性三处之一：内存明细 / 检查点 / 宿主日志）。
        onClosureFailure: (failure) => {
          ctx.logger.warn(
            '%s 摘要未生成（%s，已试 %d 次）：%s',
            LOG_PREFIX,
            failure.state,
            failure.attempts,
            failure.error,
          );
        },
        // 门面内部诊断（目前只有「待补摘要数读不出来」）—— 转给宿主日志。
        onDiagnostic: (level, message) => {
          if (level === 'warn') {
            ctx.logger.warn('%s %s', LOG_PREFIX, message);
          }
        },
      });
    } catch (error) {
      ctx.logger.error('%s 打开数据根失败：%s', LOG_PREFIX, String(error));
      markReady(null);
      return () => undefined;
    }

    // 通道核对：channels.json 首次初始化已预置 dsh 描述符。
    //
    // 纪律：只核对、**不自动注册** —— 注册表是「可增长的登记表」，
    // 既有条目永不被改写（定案稿 §10.2）。缺失则告警并停写，
    // 避免覆盖用户可能已调整的注册表内容。
    if (!fasti.channels.has(channel)) {
      ctx.logger.warn(
        '%s 通道「%s」未注册（channels.json 中无此 id）—— 本次会话不写入原文与经历；请先注册通道。',
        LOG_PREFIX,
        channel,
      );
      await fasti.close();
      markReady(null);
      return () => undefined;
    }

    ctx.logger.info(
      '%s 适配器已装载：通道=%s，数据根=%s，摘要模型=%s',
      LOG_PREFIX,
      channel,
      fasti.paths.root,
      port === null ? '未配置（摘要保持待生成）' : (config.model ?? '宿主默认'),
    );
    markReady(fasti);

    // ── WP4b 记忆工具接线（默认 off：不打开桥接、不注册任何工具，线上零变化）──
    // indexDir 固定落在本数据根 projection 下；旧路检索直接复用门面 search（字段天然对齐）。
    const gateMode = config.memoryGateMode ?? 'off';

    // 真机约束（cordis 4.0.5）：tools 是受 inject 保护的服务，未声明依赖直接读 ctx.tools
    // 会抛 "cannot get property tools without inject"。故仅在非 off 时用**动态可选注入**取服务：
    //  - 宿主提供 tools：授权子 fiber 回调内按门模式接线（shadow/on 才真正注册四工具）；
    //  - 宿主无 tools：该子 fiber 等待依赖、回调静默不触发，主适配器（开库/摄入/影子）照常运行，
    //    等价既有「弱宿主安全跳过」契约；不使用静态必需注入，以免缺服务时整个插件被挡在门外。
    let memoryWiring: MemoryWiring | null = null;
    let wiringClosed = false;
    if (gateMode !== 'off') {
      ctx.inject(['tools'], (toolCtx) => {
        if (wiringClosed) return;
        const wiring = wireMemoryTools({
          registry: resolveToolRegistry(toolCtx),
          mode: gateMode,
          indexDir: path.join(fasti.paths.projection, 'memory-index'),
          // L6 注入只读下钻端口（#114 E.4.1）：门面结构满足 SourceLookupFacade，装配层不反向 import 门面。
          sourceLookup: createSourceLookupPort(fasti),
          log: (message) => ctx.logger.warn('%s %s', LOG_PREFIX, message),
        });
        memoryWiring = wiring;
        if (wiring.registered) {
          ctx.logger.info('%s 记忆工具已注册：门模式=%s', LOG_PREFIX, gateMode);
        }
        // 子 fiber 卸载兜底；主 cleanup 已显式 dispose，wireMemoryTools 幂等故重复调用安全。
        toolCtx.effect(() => () => {
          void memoryWiring?.dispose();
        });
      });
    }

    return async () => {
      state.closed = true;
      wiringClosed = true;
      ctx.logger.info('%s 适配器卸载：注销记忆工具并关闭数据根', LOG_PREFIX);
      if (memoryWiring !== null) {
        await memoryWiring.dispose();
      }
      await fasti.close();
    };
  }, 'dsh-fasti-adapter');
}

/**
 * 处理一条 `session/event` —— 转换 → 摄入。
 *
 * 失败**不抛给 dsh 主链路**，但必须 logger.error（失败可观测，不静默吞事件）。
 */
async function handleSessionEvent(
  ctx: Context,
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
      ctx.logger.warn('%s %s', LOG_PREFIX, warning);
    }

    if (input === null) {
      // 系统注入是 harness 的正常形态 → debug 级别；其余异常形态 → warn。
      if (skip?.kind === 'system-injection' || skip?.kind === 'not-message') {
        ctx.logger.debug('%s 跳过事件：%s', LOG_PREFIX, skip?.detail ?? '未知原因');
      } else {
        ctx.logger.warn('%s 跳过事件：%s', LOG_PREFIX, skip?.detail ?? '未知原因');
      }
      return;
    }

    const fasti = await ready;
    if (fasti === null || state.closed) {
      // 卸载中（state.closed）是正常收尾，静默；门面没打开（fasti === null）则
      // 意味着**每条事件都白掉了** —— 首条 warn + 计数，不刷屏也不静默（m6）。
      if (fasti === null && !state.closed) {
        noteDrop(ctx, drops, `门面未就绪，事件未写入（通道=${channel}）`);
      }
      return;
    }

    await fasti.ingestRawTurn(channel, input);
  } catch (error) {
    // 旁路捕获：吞掉异常以免阻断 dsh 主链路，但必须留下可观测的记录。
    ctx.logger.error('%s 摄入失败：%s', LOG_PREFIX, String(error));
  }
}

/** cordis 对象插件（宿主按对象插件形状加载）。 */
export const plugin = {
  name: 'dsh-fasti-adapter',
  apply,
};

export default plugin;
