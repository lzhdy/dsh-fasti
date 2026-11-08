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

import type { Context } from '@deepseek-ai/cordis';

import { Fasti } from '../../api/index.ts';
import { convertSessionEvent } from './convert-event.ts';

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
}

/** 日志前缀 —— 便于在 dsh 日志里一眼认出。 */
const LOG_PREFIX = '[dsh-fasti]';

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

  // 只保留显式给出的键 —— 缺省字段不占位（配置对象保持干净）。
  const config: DshAdapterConfig = {};
  if (dataRoot !== undefined) {
    config.dataRoot = dataRoot as string;
  }
  if (channel !== undefined) {
    config.channel = channel as string;
  }
  return config;
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

  // 监听器**同步注册**（不放在异步 effect 体内 —— 见文件头时序要点）。
  ctx.on('session/event', (session: unknown, event: unknown) => {
    // 不 await —— 旁路捕获，不阻断 dsh 主链路。
    void handleSessionEvent(ctx, state, ready, channel, session, event);
  });

  // 生命周期：装载时 open，卸载时 close（释放 SQLite 句柄）。
  ctx.effect(async () => {
    let fasti: Fasti;
    try {
      fasti = await Fasti.open(
        config.dataRoot === undefined ? {} : { dataRoot: config.dataRoot },
      );
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
      '%s 适配器已装载：通道=%s，数据根=%s',
      LOG_PREFIX,
      channel,
      fasti.paths.root,
    );
    markReady(fasti);

    return async () => {
      state.closed = true;
      ctx.logger.info('%s 适配器卸载：关闭数据根', LOG_PREFIX);
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
