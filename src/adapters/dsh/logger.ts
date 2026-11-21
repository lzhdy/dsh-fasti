/**
 * dsh 日志插头 —— 把宿主日志设施包成中立 LoggerPort（平台化 H1 切片 1）。
 *
 * 只做**薄转发**：不重排参数、不做字符串格式化、不吞掉额外参数，保证同一条日志在
 * 接线前后逐字等价（printf 占位仍由底层 cordis logger 解释）。
 *
 * 依赖纪律：不直接 import `@deepseek-ai/cordis`，只声明我们需要的最小结构化面
 * （cordis `ctx.logger` 的四档子集），与 memory-tool-bridge 的 DshToolRegistry 同思路，
 * 离线测试可传任意同形假 sink，无需真实 cordis Context。
 */

import type { LoggerPort } from '../../ports/logger-port.ts';

/** dsh 侧日志落地的最小结构化面（ctx.logger 的结构化子集）。 */
export interface DshLoggerSink {
  debug(format: string, ...args: unknown[]): void;
  info(format: string, ...args: unknown[]): void;
  warn(format: string, ...args: unknown[]): void;
  error(format: string, ...args: unknown[]): void;
}

/** 用宿主日志 sink 构造一个中立 LoggerPort。 */
export function createDshLogger(sink: DshLoggerSink): LoggerPort {
  return {
    debug: (format, ...args) => sink.debug(format, ...args),
    info: (format, ...args) => sink.info(format, ...args),
    warn: (format, ...args) => sink.warn(format, ...args),
    error: (format, ...args) => sink.error(format, ...args),
  };
}
