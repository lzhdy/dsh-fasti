/**
 * dsh 工具宿主插头 —— 把中立 ToolHostPort 薄落到 cordis 的 inject(['tools']) 授权
 * 与子 fiber 生命周期（平台化 H1 切片 4）。
 *
 * 不直接 import cordis：只用最小结构化面描述 inject 回调拿到的子上下文（tools/effect），
 * 离线可传同形假 sink。dsh 工具定义类型 ToolDefinition 本就是 dsh-tools 的概念，
 * 在适配器内 import type 合规——六工具如何被 defineTool 封装仍归 memory-tool-bridge。
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { ToolHostPort, ToolRegistration, ToolRegistry } from '../../ports/tool-host-port.ts';

/** inject 授权回调里子上下文的最小结构化面（只取 tools 与 effect）。 */
export interface DshToolChildContext {
  tools?: unknown;
  effect(execute: () => unknown, label?: string): unknown;
}

/** ctx.inject 的最小结构化面：声明依赖，服务就绪后在子上下文上回调。 */
export interface DshInjectSink {
  inject(deps: readonly string[], callback: (child: DshToolChildContext) => void): unknown;
}

/**
 * 结构化探测子上下文的 tools 服务；残形/缺失返回 null（fail-safe，绝不抛）。
 * 与改造前 plugin 内 resolveToolRegistry 的判定逐字一致。
 */
function resolveToolRegistry(child: DshToolChildContext): ToolRegistry<ToolDefinition> | null {
  const candidate = child.tools;
  if (
    candidate !== null &&
    candidate !== undefined &&
    typeof candidate === 'object' &&
    typeof (candidate as { register?: unknown }).register === 'function'
  ) {
    return candidate as ToolRegistry<ToolDefinition>;
  }
  return null;
}

/** 用宿主上下文构造一个实参化为 dsh-tools 工具定义的 ToolHostPort。 */
export function createDshToolHost(ctx: DshInjectSink): ToolHostPort<ToolDefinition> {
  return {
    withTools(handler) {
      // 真机授权纪律：tools 是受 inject 保护的服务，未声明依赖直接读取会抛错，
      // 故统一在此声明 ['tools']；依赖缺失时 cordis 挂起子 fiber，handler 不触发。
      ctx.inject(['tools'], (child) => {
        const registration: ToolRegistration<ToolDefinition> = {
          registry: resolveToolRegistry(child),
          onDispose(cleanup) {
            child.effect(() => cleanup);
          },
        };
        handler(registration);
      });
    },
  };
}
