/**
 * dsh-fasti 宿主 LLM 胶水包（web profile 专用）。
 *
 * 职责只有一件事：等宿主的 llm / agentDefaultModel 两个服务就绪后，
 * 用仓库出厂的 createDshHostModelRoute 把 ctx.llm 包成 DshModelRoute，
 * 再带着它装载 dsh-fasti 适配器插件。内核与适配器逻辑全部在仓库内，
 * 本包不含业务逻辑、不碰凭据、不硬编码端点。
 *
 * 内核编译产物定位（可移植，2026-11-18 修）：按序尝试三个候选，全部失败即抛错并
 * 列出已试路径与修复指引，绝不静默降级。此前本行写死某台机器的绝对路径，导致
 * 任何 clone 后的干净安装都装不起来（路径不存在），且"从 GitHub 重装"仍会回头
 * 加载旧路径那份 lib，与平台独立化契约冲突。
 *   ① FASTI_LIB_DIR 环境变量显式指定 lib 目录（部署 / 多仓库并存首选）；
 *   ② 相对本文件推断 ../../lib（仓库内直跑、symlink 安装成立，保留"build 后即时生效"）；
 *   ③ 包名 dsh-fasti/lib（仓库本体作为依赖被安装时成立）。
 */

const LIB_ENTRY = 'adapters/dsh/index.js';

function libCandidates() {
  const list = [];
  const explicit = process.env['FASTI_LIB_DIR'];
  if (typeof explicit === 'string' && explicit !== '') {
    list.push(new URL(LIB_ENTRY, `file://${explicit.replace(/\/+$/, '')}/`).href);
  }
  list.push(new URL(`../../lib/${LIB_ENTRY}`, import.meta.url).href);
  list.push(`dsh-fasti/lib/${LIB_ENTRY}`);
  return list;
}

async function loadKernel() {
  const tried = [];
  for (const spec of libCandidates()) {
    try {
      return await import(spec);
    } catch (error) {
      tried.push(`  ${spec}\n    → ${error?.code ?? error?.message ?? String(error)}`);
    }
  }
  throw new Error(
    'dsh-fasti-dsh-glue: 找不到内核编译产物。请先在仓库根跑 `npm run build`，'
    + '或把 FASTI_LIB_DIR 指向该仓库的 lib 目录（例：FASTI_LIB_DIR=/path/to/dsh-fasti/lib）。'
    + `已尝试：\n${tried.join('\n')}`,
  );
}

const { default: fastiPlugin, createDshHostModelRoute } = await loadKernel();

/** 固定摘要路由允许显式给出的键（其余键一律不透传）。 */
const PINNED_ROUTE_KEYS = ['provider', 'model', 'reasoningEffort'];

/**
 * 转发给适配器的既有配置键（worker 节拍等常量仍以内核 params 单点为准）。
 *
 * memoryGateMode 必须在列：#122 真机放量实证，漏转它会让适配器恒取默认 'off'，
 * 记忆工具不注册、第七法端口不绑定，worker 每轮 not-wired 静默空轮。合法取值
 * （off/shadow/on）由适配器 parseAdapterConfig 兜底校验，本胶水只透传不二次校验。
 */
const FORWARD_KEYS = ['dataRoot', 'channel', 'model', 'memoryGateMode'];

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
