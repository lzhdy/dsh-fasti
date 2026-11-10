# dsh-fasti-dsh-glue

dsh-fasti 的宿主 LLM 胶水包，只用于 **web profile**（有凭据的交互式环境）。

## 它做什么

宿主的 LLM 运行时（`ctx.llm`）与 dsh-fasti 内核只认的 `DshModelRoute.complete()`
之间本来没有接线，导致事件闭合后摘要一直 `pending`。本包在两个 cordis 服务
（`llm`、`agentDefaultModel`）就绪后，用仓库出厂的 `createDshHostModelRoute()`
构造路由，再带着它装载 dsh-fasti 适配器。

- 不含任何密钥、端点或提供方假设：云端账号、API key、本地 OpenAI 兼容网关
  （dsh-llm-pi-ai 手工声明路由）都走宿主统一分发，本包与提供方无关。
- headless profile 不挂本包，继续保持无凭据的如实降级。

## 配置

bundle patch 默认只给 `dataRoot` / `channel`，此时摘要**跟随当前默认模型选择**
（模型选择器里切什么，摘要就走什么）。

需要「聊天走 A、摘要走 B」的分流时，在 patch 的 config 下加 `summaryRoute`，
三个键都可选，缺哪个回退哪个：

```yaml
config:
  dataRoot: '/home/user/.dsh/fasti'
  channel: 'dsh'
  summaryRoute:
    provider: 'deepseek-account'   # 或 pi-ai 手工声明的本地路由 id
    model: 'deepseek-flash'
    reasoningEffort: 'off'         # 取值须在该模型声明的能力目录内
```

## 部署约定

- `index.js` 引用仓库编译产物的绝对路径，与 `dsh-fasti-accept` 薄封装同一约定；
  仓库执行 `npm run build` 后无需重新安装本包即生效。
- 在 profile 的 `package.json` 里以 `file:` 依赖引入并替换 bundle 清单中的
  `dsh-fasti-accept` 条目；卸载/回滚只需换回旧条目，真源数据不被触碰。
- 摘要调用失败（额度、凭据、网络、空文本）统一由适配器端口转成退避重试，
  不会写入空摘要，也不阻断聊天主链路。
