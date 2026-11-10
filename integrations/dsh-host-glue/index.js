/**
 * dsh-fasti 宿主 LLM 胶水包（web profile 专用）。
 *
 * 职责只有一件事：等宿主的 llm / agentDefaultModel 两个服务就绪后，
 * 用仓库出厂的 createDshHostModelRoute 把 ctx.llm 包成 DshModelRoute，
 * 再带着它装载 dsh-fasti 适配器插件。内核与适配器逻辑全部在仓库内，
 * 本包不含业务逻辑、不碰凭据、不硬编码端点。
 *
 * 路径约定与 dsh-fasti-accept 薄封装一致：re-export / 引用仓库编译产物的
 * 绝对路径，仓库 npm run build 后本包即时用上新代码。
 */

import fastiPlugin, { createDshHostModelRoute } from '/home/user/.doubao/agent_mode/workspace/.sessions/38450174529161986/agents/m_0cw3XAwneSK/dsh-fasti-repo/lib/adapters/dsh/index.js';

/** 固定摘要路由允许显式给出的键（其余键一律不透传）。 */
const PINNED_ROUTE_KEYS = ['provider', 'model', 'reasoningEffort'];

/** 转发给适配器的既有配置键（worker 节拍等常量仍以内核 params 单点为准）。 */
const FORWARD_KEYS = ['dataRoot', 'channel', 'model'];

function readPinnedRoute(rawConfig) {
  const pinned = rawConfig?.['summaryRoute'];
  if (pinned === undefined) {
    return undefined;
  }
  if (typeof pinned !== 'object' || pinned === null || Array.isArray(pinned)) {
    throw new TypeError('dsh-fasti-dsh-glue: summaryRoute 必须是对象');
  }
  const options = {};
  for (const key of PINNED_ROUTE_KEYS) {
    const value = pinned[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`dsh-fasti-dsh-glue: summaryRoute.${key} 必须是非空字符串`);
    }
    options[key] = value;
  }
  return options;
}

function apply(ctx, rawConfig) {
  const modelRoute = createDshHostModelRoute(ctx, readPinnedRoute(rawConfig));

  const forwarded = {};
  for (const key of FORWARD_KEYS) {
    if (rawConfig?.[key] !== undefined) {
      forwarded[key] = rawConfig[key];
    }
  }

  ctx.plugin(fastiPlugin, { ...forwarded, modelRoute });
}

/** 对象插件：inject 保证装载时两个宿主服务已注册。 */
const plugin = {
  name: 'dsh-fasti-dsh-glue',
  inject: ['llm', 'agentDefaultModel'],
  apply,
};

export default plugin;
export { apply, readPinnedRoute };
