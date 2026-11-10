/**
 * dsh 通道适配器 —— 阶段 4 公开出口。
 *
 * 分层纪律（任务书 §4.1）：
 *  - A 内核（core / source / projection / contract）零生产依赖不变；
 *  - 宿主包（cordis 等）只在**本目录**使用，声明为 peer + dev 依赖；
 *  - `dependencies` 仍为空。
 *
 * 用法（宿主侧）：
 *
 * ```ts
 * import fastiAdapter from 'dsh-fasti/adapters/dsh';
 *
 * ctx.plugin(fastiAdapter, { dataRoot: '/path/to/root' });
 * ```
 */

export {
  apply,
  parseAdapterConfig,
  plugin,
  type DshAdapterConfig,
} from './plugin.ts';

export {
  assistantTextFromBlocks,
  convertSessionEvent,
  joinTextBlocks,
  RUNTIME_CONTEXT_RE,
  type ConvertResult,
  type SkipReason,
} from './convert-event.ts';

export type { ContentBlock, DshEvent, DshSession, MessageEventData } from './event-types.ts';

export {
  createDshLLMPort,
  startClosureWorker,
  type DshModelRoute,
} from './llm.ts';

export {
  createDshHostModelRoute,
  type DshHostModelContext,
  type DshHostRouteOptions,
  type HostModelSelection,
} from './host-model-route.ts';

export { default } from './plugin.ts';
