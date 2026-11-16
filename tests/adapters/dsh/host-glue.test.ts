/**
 * dsh-host-glue 宿主胶水包配置透传测试。
 *
 * 背景（#122 真机放量实证）：web profile 在 cordis.patch.yml 配置了
 * memoryGateMode:'shadow'，但胶水 apply 用 FORWARD_KEYS 白名单挑键后再
 * ctx.plugin(适配器, ...)，白名单漏了 memoryGateMode，导致适配器恒收到
 * off、记忆工具不注册、第七法端口不绑定，worker 每轮 not-wired 空轮。
 *
 * 胶水包是 integrations/ 下无类型声明的纯 ESM .js（package.json 无 types），
 * 运行期由 node 直接加载；类型检查处用 @ts-expect-error 收口，不伪装宿主装载。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// @ts-expect-error dsh-host-glue 是无 .d.ts 的集成 .js 包，运行期由 node 直接加载
import { apply } from '../../../integrations/dsh-host-glue/index.js';

interface CapturedPluginCall {
  pluginRef: unknown;
  config: Record<string, unknown>;
}

/** 工厂返回惰性路由（complete 闭包不在 apply 期触碰宿主服务），故 ctx 只需能捕获 plugin 登记。 */
function makeCapturingCtx(): {
  ctx: { plugin: (pluginRef: unknown, config: Record<string, unknown>) => void };
  captured: () => CapturedPluginCall;
} {
  let call: CapturedPluginCall | null = null;
  return {
    ctx: {
      plugin(pluginRef, config) {
        call = { pluginRef, config };
      },
    },
    captured() {
      assert.ok(call !== null, 'ctx.plugin 应被调用一次');
      return call;
    },
  };
}

test('glue apply 透传 memoryGateMode 与 dataRoot/channel，并挂上 modelRoute', () => {
  const { ctx, captured } = makeCapturingCtx();

  apply(ctx, {
    dataRoot: '/home/user/.dsh/fasti',
    channel: 'dsh',
    memoryGateMode: 'shadow',
  });

  const { config } = captured();
  assert.equal(config.memoryGateMode, 'shadow');
  assert.equal(config.dataRoot, '/home/user/.dsh/fasti');
  assert.equal(config.channel, 'dsh');
  const modelRoute = config.modelRoute as { complete?: unknown };
  assert.equal(typeof modelRoute, 'object');
  assert.equal(typeof modelRoute.complete, 'function');
});

test('glue apply 白名单只透声明键：summaryRoute 不泄漏给适配器', () => {
  const { ctx, captured } = makeCapturingCtx();

  apply(ctx, {
    dataRoot: '/home/user/.dsh/fasti',
    channel: 'dsh',
    memoryGateMode: 'shadow',
    summaryRoute: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off' },
  });

  const { config } = captured();
  assert.equal(config.memoryGateMode, 'shadow');
  assert.equal('summaryRoute' in config, false);
});

test('glue apply 未给 memoryGateMode 时不臆造该键（默认 off 由适配器 parseAdapterConfig 决定）', () => {
  const { ctx, captured } = makeCapturingCtx();

  apply(ctx, { dataRoot: '/home/user/.dsh/fasti', channel: 'dsh' });

  const { config } = captured();
  assert.equal('memoryGateMode' in config, false);
  assert.equal(config.dataRoot, '/home/user/.dsh/fasti');
  assert.equal(config.channel, 'dsh');
});
