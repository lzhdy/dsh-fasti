/**
 * cordis 插件入口（薄胶水）—— dsh 通道适配器（平台化步骤3 起）。
 *
 * 步骤3 把"与具体宿主框架无关的装配编排"整体下沉到同目录 `mount.ts` 的
 * `mountDshAdapter`：打开实例、登记 dsh 通道、订阅 `session/event`、起后台 worker、
 * 接记忆工具、卸载关库都在那里，只认五个中性端口 + 注入的 LLMPort，**不 import cordis**。
 *
 * 本文件因此只剩 cordis 这一层**薄胶水**的两件事：
 *  1. 解析/校验适配器配置（`parseAdapterConfig`，含宿主模型路由对象的形状校验）；
 *  2. 把 cordis Context 的设施薄插成五个中性端口、按路由造出摘要端口，再调用
 *     `mountDshAdapter` 拿到挂载句柄，并用 LifecyclePort 把句柄 dispose 挂到作用域。
 *
 * 这是 dsh 适配器里**唯一**直接 import cordis 类型的入口：
 *  - A 内核（core / source / projection / contract）零生产依赖不变；
 *  - cordis 只作 peerDependency（宿主提供）+ devDependency（类型与测试）。
 *
 * 时序要点（实测 cordis 4.1 的行为，红线由 mount.ts 与 event-bus-port.ts 把守）：
 *  - `mountDshAdapter` 是同步函数，`session/event` 监听器在其同步调用栈内经
 *    EventBusPort 完成注册（dsh 插头底层即 `ctx.on(...)`），装载与首个事件之间
 *    不留异步间隙；本函数同步调用它，等价改造前直接在 apply 内同步挂监听器。
 *  - Fasti 实例在 mount 内部后台打开，先到的事件经 ready 信号等待、不丢。
 */

import type { Context } from '@deepseek-ai/cordis';

import type { MemoryGateMode } from '../../assembly/memory-tools.ts';
import { createDshEventBus, type DshEventSink } from './event-bus.ts';
import { createDshLifecycle } from './lifecycle.ts';
import { createDshLogger } from './logger.ts';
import { createDshScheduler } from './scheduler.ts';
import { createDshToolHost, type DshInjectSink } from './tool-host.ts';
import { createDshLLMPort } from './llm.ts';
import type { DshModelRoute } from './llm.ts';
import { mountDshAdapter } from './mount.ts';

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
   * 缺省走 Fasti 的四级解析：显式配置 > `$FASTI_HOME` > 旧 `$DSH_HOME/fasti`（只读兼容）> `~/.fasti`。
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
   *  - 'shadow'：注册六工具（通道一四件套＋通道二回查两件套），检索主返回仍走旧路，仅旁路落无原文影子观测用于灰度比对；
   *  - 'on'：门裁决生效，召回以窄柄门结果为准。
   *
   * 切到 'shadow'/'on' 属 Q3 显式授权动作，运行期不得自行翻转。
   */
  memoryGateMode?: MemoryGateMode | undefined;
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
 * 插件入口 —— cordis 对象插件的 `apply`：只做宿主薄胶水，装配编排交给 mountDshAdapter。
 */
export function apply(ctx: Context, rawConfig?: DshAdapterConfig): void {
  const config = parseAdapterConfig(rawConfig);
  // T2 门：全链路唯一允许的缺省通道字面点；mount 只接收已解析的 channel，不内置默认值。
  const channel = config.channel ?? 'dsh';

  // 中立端口在入口处薄插宿主设施；mount 往下只认端口，不直接摸 ctx。
  const logger = createDshLogger(ctx.logger);
  const lifecycle = createDshLifecycle(ctx);
  const scheduler = createDshScheduler();
  // cordis 的 on 泛型把事件名约束为 keyof Events，中立端口则按普通字符串订阅事件名；
  // 这是适配器边界的类型桥接（运行时仍是同一个 ctx.on）；下文工具口的 inject 桥接同范式。
  const eventBus = createDshEventBus(ctx as unknown as DshEventSink);
  const toolHost = createDshToolHost(ctx as unknown as DshInjectSink);

  // 摘要端口在宿主侧造好：注入了路由才有模型，没注入就是 null（如实降级，不伪造）。
  // mountDshAdapter 不认识宿主模型路由，只接收造好的 LLMPort，保持挂载面对路由无感。
  const llmPort =
    config.modelRoute === undefined
      ? null
      : createDshLLMPort(config.modelRoute, {
          ...(config.model === undefined ? {} : { model: config.model }),
          ...(config.closureTimeoutMs === undefined ? {} : { timeoutMs: config.closureTimeoutMs }),
        });

  // 宿主无关的装配编排全部内聚在这一同步调用里：其内部已同步完成 session/event
  // 订阅与两个 worker 注册（不丢首事件），Fasti 实例在后台打开。
  const handle = mountDshAdapter(
    { logger, lifecycle, scheduler, eventBus, toolHost },
    {
      channel,
      llmPort,
      ...(config.dataRoot === undefined ? {} : { dataRoot: config.dataRoot }),
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.closureIntervalMs === undefined ? {} : { closureIntervalMs: config.closureIntervalMs }),
      ...(config.closureTimeoutMs === undefined ? {} : { closureTimeoutMs: config.closureTimeoutMs }),
      ...(config.memoryGateMode === undefined ? {} : { memoryGateMode: config.memoryGateMode }),
    },
  );

  // Fasti 实例的关闭挂到宿主作用域（替代原 ctx.effect 生命周期）。worker 的卸载清理
  // 已在 mount 内经同一 lifecycle 先登记，作用域逆序回收时本关闭先于 worker 撤销执行。
  // LifecyclePort 约定清理同步、不抛：dispose 内部已自吞错误记账，这里 void 触发即可。
  lifecycle.onDispose(
    () => {
      void handle.dispose();
    },
    'dsh-fasti-adapter',
  );
}

/** cordis 对象插件（宿主按对象插件形状加载）。 */
export const plugin = {
  name: 'dsh-fasti-adapter',
  apply,
};

export default plugin;
