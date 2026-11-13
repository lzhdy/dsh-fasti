# AuroraBot 双对象模块化深度调研：框架愿景、同栈生产插件与 dsh-fasti 落地判断

> 调研对象：
> - **对象 A（两个代码实体，一个品牌名）**：文档站 https://www.aurorabot.org/ 描述的 agentic「Bot 生活环境」框架，及其文档指向的新内核；自建 Gitea 仓库 https://git.ayau.me/syntaxbullet/aurorabot 现存的 Bun/TypeScript Discord RPG bot。
> - **对象 B**：https://github.com/aureth-labs/dsh-aurabot-qq （旧入口 accomplish07zrh-eng 同名仓库经 GitHub 301 指向同一仓库），DeepSeek Harness（DSH）上的 cordis 生产插件，与 dsh-fasti 同技术栈。
>
> 取证日期：2026-11-11。外部易变数字（star、commit、版本等）均标注该核实日期。体例沿用【事实】【推断】【建议】分层；事实类结论带文档 URL/章节或源码 `文件:行号`/仓库路径锚点。本报告为只读调研产物，不改动任何产品代码。

## 目录

0. 一页结论摘要
1. 调研方法、可达性与证据局限
2. 首要勘误：「AuroraBot」是两代不同的东西
- 篇 A：aurorabot.org 框架愿景与 git.ayau.me 仓库现状
3. A-文档代：Python 新内核的模块/世界模型机制
4. A-仓库代：Bun RPG bot 的工程现状
5. A 的文档-代码对照与可信度结论
- 篇 B：dsh-aurabot-qq 同栈生产插件
6. 供应链安全核查（结论先行）
7. B 的模块系统：「一切皆模块」的真实形状
8. B 的宿主接线、并行工作链路与单主体
9. B 的聊天平台、安全模型、记忆与测试基建
- 篇 C：关系判定与 dsh-fasti 落地
10. 三个项目的关系判定
11. 与 dsh-fasti 现有架构的逐项同构/差异
12. 硬清单一：建议吸收项
13. 硬清单二：禁止照搬项
14. 硬清单三：模块化扩展与并行工作链路路线建议
- 附录 B：C 块模块化与并行链路立项评审 checklist（可勾选）
- 附录 A：证据索引

---

## 0. 一页结论摘要

1. 【事实】用户欣赏的「一切皆模块」在两个对象里是两套不同实现：aurorabot.org 文档代是 Python 3.12 组合微内核（`ModuleSpec/@module`、七阶段生命周期、贡献点声明、Assembly 冻结），但文档自己承认多个开发页仍在占位、且该代码在可访问的 Gitea 仓库中零实现；dsh-aurabot-qq 则是**已经在生产运行的同栈 cordis 插件**，在 cordis 之上自建了用户态模块内核（热重载快照、出错隔离、能力白名单、挂钩总线、模块市场），对 dsh-fasti 的参考价值远高于对象 A。
2. 【事实】供应链核查结论：`accomplish07zrh-eng/dsh-aurabot-qq` 与 `aureth-labs/dsh-aurabot-qq` 是同一仓库改名（GitHub 301 到同一 repository id，21 个分支 SHA 逐字一致，fork=false），上游 main@5eb5b94（v1.2.1，407 commits，580 star/91 fork，MIT，核实于 2026-11-11）无依赖、无安装钩子、无遥测外发等恶意特征；但第三方模块市场是真实信任边界，安装仍应以 aureth-labs 为准并核对 commit SHA、先 dry-run 观察。
3. 【事实】对象 A 的 Gitea 仓库（495 commits、0 star，核实于 2026-11-11）全部 7 个分支、1454 个文件中不存在 WorldJournal/AgentTree/MCP/console.input/声明式 Tool 的任何代码，它是一条 Kyoko→dev→monorepo→main 的 Discord 游戏机器人演化线（Bun+Postgres17+React19）；文档愿景是未落地（或未提交到该仓库）的另起项目。
4. 【建议】dsh-fasti 不需要重造容器：cordis 原生已提供对象插件、`inject` 服务依赖、`ctx.effect` 装载/卸载生命周期与 fiber 级监听清理（本仓 `src/adapters/dsh/plugin.ts` 的 apply 入口 :188、对象插件导出 :367-370、`ctx.on` :219、`ctx.effect` :251 已是示范，服务依赖清单 `inject:['llm','agentDefaultModel']` 则在 `integrations/dsh-host-glue/index.js:59`）。真正值得吸收的是 B 的**用户态模块治理纪律**（能力声明+白名单平面、默认关+dry-run、卸载逆序清理、市场 zip 安全清单）、**假宿主+平台模拟器 e2e 测试法**，以及 A 文档代的**保留事件防伪、能力端口读写分离、纯函数装配、节律只发启动请求不直接动作**等设计约束。
5. 【建议】明确撞线不搬：B 的 mood 5–100 标量与 memory.importance 撞 K7/禁情绪字段纪律；常驻 `api.every` 调度只能活在插件层、内核不引入（K3）；任何外部上报/遥测禁入（K13）；第三方进程内模块的同权限信任假设必须由 preset 分档与能力闸承接；向量能力 B 采用「默认关、用户自配端点」的形态，与 dsh 的 K1 重议条件相容但本期不开。
6. 【建议】排期：模块化扩展不得插入记忆层 v1（离线脚手架在外部实现中）；C 块立项前先做「扩展点冻结清单 + 假宿主测试替身」两件小事；主动链路严格走「信号不入真源、合成轮走同一管线、门限只收紧不放宽」；用户态模块加载器/热重载/市场列为 C 块之后的演进项，附量化触发条件。

---

## 1. 调研方法、可达性与证据局限

【事实】可达性与取证方式：

- 文档站为 VitePress v1.6.4 分页电子书，共 19 个页面（首页+18 页线性 Pager 链），已逐页走通读；实质内容集中在 architecture 六页与 develop/index，develop 下三个开发页为「文档编写中」占位。
- Gitea 匿名可读：经 `/api/v1/repos/.../git/trees/<branch>?recursive=true` 枚举全 7 分支 1454 个文件节点，main 分支关键源码逐文件直读，其余分支做路径级与代表性文件内容级关键词核查；该实例代码搜索 API 返回 404，结论以全路径枚举+强特征命名 grep 为基础。
- 对象 B 在调研工作区浅克隆（main，407 commits 完整历史）逐文件阅读，供应链另用 GitHub REST API（未认证）与 `git ls-remote` 双证；本报告作者对关键结论（package.json 无依赖、默认 dry-run、回环闸、mood 模块）在克隆上做了独立抽验。
- DSH 市场档案 https://www.dsh.so/zh/artifact/dsh-aurabot-qq/ 已抓取核实其静态扫描标注。

【事实】证据局限：①未对 dsh-aurabot-qq 做安装运行实测（与市场档案口径一致，静态阅读不等于运行背书）；②aurorabot.org 文档代指向的 Python 新内核仓（github.com/AuroraBot-Dev/Aurora）不仅本轮未做仓库级直读，截至 2026-11-11 以匿名 HTTP 请求实测该 URL 即返回 404、公开不可达（可能为改名、转私有或删除，具体原因无证据，不断言）；因此文档代机制只能作为「设计证词」、当前无任何公开代码可供核验，相关结论严格标注为「文档主张」而非代码事实；③三项目作者归属的公开证据不足，关系判定按存疑处理（§10）。

---

## 2. 首要勘误：「AuroraBot」是两代不同的东西

【事实】同一品牌名下存在两个技术代际，且不可混为一谈：

| 维度 | A-文档代（aurorabot.org，2026-08/09 更新） | A-仓库代（git.ayau.me syntaxbullet/aurorabot，main 停在 2026-04-10） |
|---|---|---|
| 运行时 | Python 3.12 + uv；Node 仅服务文档站/panel 子模块 | Bun 单进程 + TypeScript（TS 占比 97.7%） |
| 定位 | 为 Agent 提供「生活环境」的 agentic 框架 | Discord RPG 机器人（经济/背包/任务/棋牌/审核）+ HTTP API + React 面板 |
| 核心抽象 | WorldJournal、AgentTree、ModuleSpec、MCP App、声明式 Tool | service/view/interaction 文件约定、GamePlugin 房间游戏接口、EventEmitter 领域事件 |
| 持久化 | 文档声称 SQLite（SQLAlchemy+aiosqlite）append-only 世界流 | PostgreSQL17 + Drizzle，无 SQLite 适配 |
| 仓库证据 | 文档指向 github.com/AuroraBot-Dev/Aurora；Gitea 全分支零对应文件 | 495 commits 连续演化线，0 star（2026-11-11） |

【事实】跨分支核查为强结论：Gitea 全部分支的 package.json 无 `@modelcontextprotocol/*`、无任何 LLM/agent SDK；WorldJournal/AgentTree/console.input 内容级 grep 命中数为 0；`docs/` 目录唯一文件是面板视觉设计稿 `docs/new-design/DESIGN.md`，无架构内容。

【推断】文档站描绘的是与该 Bun 代码库不同源、尚未在可访问仓库落地的新项目（品牌延续、技术栈重启）。因此下文凡引用 aurorabot.org 的机制，一律视为「设计主张」而非「已验证实现」；工程可借鉴的是其设计约束本身，且优先以对象 B 的真实生产代码为落地参照。

---

# 篇 A：aurorabot.org 框架愿景与 git.ayau.me 仓库现状

## 3. A-文档代：Python 新内核的模块/世界模型机制

> 本章全部为文档主张取证（页面 URL 见附录），代码未在可访问仓库核实。

### 3.1 「一切皆模块」的真实含义：组合微内核，而非「一切皆 App」

【事实】文档语义里有两个层级，必须拆开：

- **Module（模块）**是通用能力单元：每个 `src/<pkg>` 在 `module.py` 自描述唯一 `MODULE`，声明 `provides/requires/contributes/consumes/declares`，以阶段为键注册钩子并以 `order` 约束顺序；内核提供 `ModuleSpec` 与 `@module` 装饰器、`Capabilities/ModuleContext`、只读 `Assembly`，启动期做依赖解析（冲突裁决、缺失依赖、可选跳过、环检测、拓扑排序），Assembly 在构造阶段后冻结（/architecture/system-overview「组合机制与门面」）。
- **App 特指 MCP App**：`apps.toml` 解析为类型化不可变 DTO，stdio 形态需 `working_dir+command`、Streamable HTTP 形态需 HTTPS URL，支持 enabled/timeout/环境变量白名单；「开发应用」页（/develop/app-development）是占位页，全站没有 App 开发代码示例。

【事实】固定生命周期七阶段：`prepare → construct → activate → ready → run → drain → close`，构造全先于运行、运行全先于关闭；模块发现有三个来源：随安装发布的 src 包、git 忽略的 `extensions/plugins/` 目录、`aurorabot_plugin` entry point；功能包之间运行时不得互相 import，兄弟能力只经契约端口（`src/contracts/pkgs/*.py` 里的 Protocol）注入。

【事实】扩展点不是开放散弹：贡献点身份由声明方在 `declares` 公开，引用未声明贡献点或重复声明都在启动前失败；Tool 是「第一个多值贡献点」，ToolRegistry 冻结后运行中不可替换，MCP 目录变化只记 `mcp.catalog.changed` 并报 `restart_required=true`。

【事实】隔离口径诚实而苛刻：「第三方模块在进程内与宿主同权限运行，这是有意的信任边界」；`src/sandbox` 是唯一保留的未实现包。stdio 子进程只拿到显式白名单环境变量、stdout 只承载 MCP、远程地址强制 HTTPS 不许明文降级。

【推断】这套设计的精髓不是「插件多」，而是**启动期把 wiring 全部验完再冻结、运行期不可变**：贡献点先声明后使用、失败在启动前爆炸、目录变更需重启。它用「无热加载」换了确定性，与对象 B 的用户态热重载路线形成鲜明对照。

### 3.2 WorldJournal 与 AgentTree：持久的只有世界，运行都是临时的

【事实】WorldJournal 是「连续世界事件流的唯一权威」：环境事实、终端输入、运行因果、工具请求与结果、对外发布全部进同一个只追加 SQLite 流；一条 `EnvironmentEvent` 至少含 `event_id, source, scope, kind, occurred_at, summary, data`，每个 scope 有独立单调 sequence，另有全局 insertion cursor，可 `stream(after, limit)` 连续拉取；world 侧只校验 scope、分配序号并保证 append-only，不替调用方推断 scope；WorldFrontier 是 scope→sequence 的不可变映射（/architecture/runtime-core「世界提交与观察前沿」）。

【事实】AgentTree 不持久化：「只保存世界提交，不归档 AgentTree」；console 文本、cadence 的 TreeLaunchRequest、delegate Tool 各自启动一棵树，root 记录 output.requested/committed 后树才完成；engine 不持有持久树，终端也不保存树。首页定调「一棵树只是一次运行，不是与她平行的另一个主体」。

【事实】端口按读写分离暴露：`WorldReader`（head/delta/commit/commits/stream/tree_index）与 `WorldWriter`（append_event/append_commit/append_commits）是两个独立 Protocol，组合根按需注入同一个单例。

### 3.3 一切输入都有媒介：统一事件与保留前缀防伪

【事实】事件来源统一枚举：`console.input`（scope `aurora:console`）、`cadence.tick`、`mcp.event.received`（source 固定 `mcp:<package>`）、`mcp.app.disconnected`、`mcp.catalog.changed`，以及 engine 因果事件 `tree/node/model.tool/output/world delta` 各阶段的 started/completed/failed 等。

【事实】防伪是硬协议：MCP 适配器**必须拒绝伪造** `engine.*、tool.*、output.*、cadence.*` 保留事件的载荷；MCP 连接协商失败只进日志、不形成世界提交；业务事件走固定 method `notifications/org.aurorabot/world-events/event` 且 capability 必须严格等于 `{"version":1}`；事件 best-effort、无重放队列、断线丢失「也不直接唤起 AgentTree」。

### 3.4 理解之后才决定：单循环、纯函数装配、Tool 三态

【事实】一次 tree turn 的最小循环是确定性的：选 ready node → `PromptAssembler.assemble(tree, node)` 纯函数产出四角色消息（全局人格+世界说明+node prompt 合为唯一 system 消息，model id 在节点创建时固化为节点事实）→ `Model.complete` → 无 Tool call 则按观察到的 world delta 封口；有 Tool call 则原子记录 tool.requested 再依序执行，`ToolOutput` 区分 `succeeded/failed/unknown`，unknown 原样交模型并记 `tool.unknown`，不降级、不自动重试；「任何结果不确定的外部效果都不得自动重试」。

【事实】首版调度明确克制：「深度优先、同级按创建顺序，同一时刻只调用一个 Model 或 Tool。并发、优先级、抢占、防抖和后台派发不是当前核心」；`aur.agent.delegate` 只是注册表里的普通 Tool，engine 校验 parent 的 child allowlist、深度与节点数后才建 child——委派是树内分支，不是第二个主体。

【事实】节律（cadence）的权力被刻意收窄：按 `tick_seconds` 提交 `cadence.tick`，但「只产生 TreeLaunchRequest，不得直接创建或修改节点」；「MCP App 被发现不得隐式启动时钟或心跳」；是否回应/行动最终由 Agent 判断，「运行时不做自动投递」，对外发言必须由 Agent 显式调用可见的发送 Tool。

【事实】测试哲学与 dsh 已选路线高度同构：测试以公开行为为主，fake Model/fake Tool/fake 时钟离线确定运行，只有 WorldJournal 用临时 SQLite 做集成测试；统一检查入口 `aurora check`（pytest+ruff+pyright）。

### 3.5 A-文档代的工程边界（事实清点）

【事实】仅支持源码运行、目录变化需重启、无热加载/市场/分发包；模型统一经 LiteLLM 网关「不建立绕过网关的直连客户端」；日志是运行诊断不是世界事实，禁止日志写入 WorldJournal/transcript；独立费用库与独立记忆库文档明确「仍未定义」，MemorySnapshot 由 `MemoryReader.recall()` 显式注入；首版明确不定义 InputGateway/OutputSink 等七端口通用体系；外部工具位置（resolve_tool）页面自标「草案未实施」。

## 4. A-仓库代：Bun RPG bot 的工程现状

【事实】以下均为 Gitea main 分支代码事实（2026-11-11 直读）。

### 4.1 单进程装配与生命周期

- `bot/index.ts`（54 行）固定顺序：初始化 DB 配置 → `registerDomainEventListeners()` → 命令/事件加载与部署 → 同进程 `createWebServer()`（Bun.serve，:27-30）→ 最后 Discord login；SIGINT/SIGTERM 先停 web 再等事务关闭客户端。
- `api/src/server.ts:100` 起 `Bun.serve` 同进程承载 REST 与 `/ws`（cookie 鉴权、连接上限 200、16KB 载荷、60s 空闲超时）；生产镜像 CMD 仍是 `bun run bot/index.ts`，即一个进程一个主体。

### 4.2 它的「模块」是什么

【事实】是业务域文件夹约定而非可安装单元：`*.service.ts`（`shared/modules/*` 单例业务逻辑）/`*.view.ts`/`*.interaction.ts`/`*.types.ts`/`*.handler.ts`/`*.test.ts`（AGENTS.md:70-76）；交互路由是 `bot/lib/interaction.routes.ts:24-69` 的 7 条硬编码 predicate+动态 import 表；命令统一经 `CommandHandler.ts:14-80`（维护模式拦截、feature flag 鉴权、统一错误回嵌）；命令/事件按目录扫描加载。没有模块注册表、生命周期接口或 App 抽象。

### 4.3 事件总线与游戏插件的边界

【事实】`shared/lib/events.ts` 是进程内 `EventEmitter` 单例（61 行），扩展了 `emitAsync()` 顺序 await 监听者以保事务原子性；事件名分四组常量（DASHBOARD/ACTIONS/QUEST/DOMAIN），载荷多携带 Drizzle 事务对象；`eventWiring.ts` 用事件接线解开 economy→quest 的循环依赖。无持久化、无追加日志。

【事实】`shared/games/types.ts` 的 `GamePlugin<TState,TAction>` 是房间制回合游戏接口（createInitialState/handleAction/玩家视角/断线处理），`registry.ts` 是进程内 Map（重复 slug 抛错），全仓仅注册 chess、blackjack 两个插件；房间由 `RoomManager`（mitt 事件+内存 Map+15 分钟等待回收）管理。它与 agent 的声明式 Tool 不是同一抽象。

### 4.4 数据与工程栈

【事实】Postgres-only：`DrizzleClient.ts` 用 postgres-js 连接，无 SQLite/文件库适配；8 个 schema 模块覆盖 users/economy/quests/inventory/moderation/settings/flags，Discord ID 与货币/XP 全部 bigint，迁移 7 版；测试 mock 掉 DrizzleClient 不碰真库，CI 拉 postgres:17 服务；Docker 多阶段、生产非 root、健康检查打 /api/health；面板 React19+Vite+Tailwind，无任何 LLM 依赖。

## 5. A 的文档-代码对照与可信度结论

【事实】对照表（节选，完整证据表见分片取证）：

| 文档主张 | Gitea 核查 | 关键证据 |
|---|---|---|
| append-only WorldJournal | 不存在；最接近为内存 EventEmitter | shared/lib/events.ts:8-49 |
| 多棵 AgentTree、一次运行一棵树 | 不存在；无 agent 运行时/LLM 依赖 | 全分支 package.json 核查 |
| console.input/一切输入有媒介 | 不存在；输入只有 Discord 交互与 HTTP/WS | CommandHandler.ts、interaction.routes.ts:24-69 |
| MCP App/适配器 | 不存在；无 MCP SDK 依赖 | 全分支 grep 0 命中 |
| 声明式 Tool 与三态结果 | 不存在；GamePlugin 是游戏状态机 | shared/games/types.ts:1-22 |
| 七阶段模块内核 | 不存在；只有文件命名约定+硬编码路由 | AGENTS.md:70-76 |
| Discord RPG 全套业务 | 完全存在且是仓库全部内容 | README.md:1-3、bot/index.ts |

【建议】引用对象 A 时的纪律：设计哲学章节（§3.2-3.4 的约束）可作为「他山之石的设计证词」引用，但其工程实现细节、性能与可用性**不得作为已验证事实**写入任何 dsh 决策依据；需要代码级佐证的判断一律以对象 B 或本仓既有九框架调研报告（`docs/chat-memory-frameworks-survey.md`）中已核实的开源实现为准。

---

# 篇 B：dsh-aurabot-qq 同栈生产插件

> 对象 B 是本报告工程借鉴的主参照：它与 dsh-fasti 同为 DSH 宿主上的 cordis 插件（Node ≥22.13、peer 形态、数据目录 `~/.dsh/plugins-data/aurabot`），以下事实来自 main@5eb5b94（v1.2.1）克隆逐文件阅读与抽验。

## 6. 供应链安全核查（结论先行）

### 6.1 两个 URL 的关系：同一仓库改名，非 fork、非镜像

【事实】证据链：

1. GitHub API 对 `accomplish07zrh-eng/dsh-aurabot-qq` 返回 HTTP 301，跟随到 `/repositories/1431897471`，即 `aureth-labs/dsh-aurabot-qq`，元数据 `fork=false`、parent/source 均为 null。
2. 对两个 URL 分别 `git ls-remote`：全部 21 个分支（main/beta/release/hotfix 等）与 refs/pull 的 SHA 逐字一致，HEAD 同为 5eb5b9463f5f0ce14964a2c7d5dcba44ad67fabe。
3. 本地克隆 `rev-list --count` = 407，与标称一致；package.json 的 repository.url 已写 aureth-labs，而配套 mods 仓库 README 与 CI 仍在引用旧仓名，佐证「先有个人仓名、后组织改名，GitHub 保留重定向」。
4. DSH 市场档案页已挂「原仓库已改名」存档提示；其 v1.0.5 等行确为 L1–L3 静态扫描档（「未列出=未实测，不推定兼容」），v1.2.0-beta.1 有一次 L5 安装实测但 Web 冒烟失败。

【推断】当前不存在独立的冒充仓库，实际钓鱼风险低；但旧 URL 的重定向若未来被解除或同名被抢注，风险立即成立。安装口径：**只认 `aureth-labs/dsh-aurabot-qq`，核对 release tag 的 commit SHA，不认任何转发放心**。

### 6.2 上游静态扫描：未见恶意特征，攻击面在第三方模块市场

【事实】（本报告作者已抽验 package.json 与默认配置）

- package.json：无 dependencies、无 devDependencies、无 lockfile；scripts 只有 test，**无 preinstall/install/postinstall**；CI（pr-check.yml）仅 checkout+setup-node+npm test，不引 secrets。
- 网络端点：127.0.0.1 本地回环占 20 处；外网域名全是功能所需（QQ/OneBot、B站、网易云、抖音/小红书、火山 TTS、pollinations 生图、GitHub Releases 下载 SnowLuma/uv/ffmpeg 等），未发现 telemetry/beacon/analytics/webhook；模块市场索引走 raw.githubusercontent 且可用 `AURABOT_REGISTRY_URL` 覆盖（src/core/community.js:18,112）。
- 凭证面：注册脱敏器覆盖 webuiPassword/httpToken/wsToken/apiKey/bridge.token（src/core/redact.js，host.js:73），面板输出对 32 位以上 hex 令牌只留尾 4 位（host.js:746-754）；child_process 全为 spawn/execFile 本地工具，无 shell 拼接远程输入，无 eval/new Function/压缩混淆文件。

【事实】市场仓库 `dsh-aurabot-qq-mods` 已收录 30+ 模块，registry 分支带 index.json 与 revoked.json 撤回名单；插件端安装有 sha256 校验、手写 zip 解析（拒加密 zip、拒 `../`/盘符路径、store/deflate 限定、crc32 逐条、25MB/64MB 双上限）、两阶段原子落位与 `.old` 回滚（community.js:70-110,180-211）。

【推断】插件本体供应链干净，但第三方模块以源码 zip 在用户数据目录**同进程直接执行**，沙箱只是能力白名单而非真隔离（§7.4），这是该生态最大信任边界；本项目未来若做模块分发，整套校验清单可直接照搬，但「能力声明≠安全保证」必须在产品文案与安装确认中讲清。

## 7. B 的模块系统：「一切皆模块」的真实形状

### 7.1 加载、开关、替换与出错隔离

【事实】模块内核在 `src/core/modules.js`（865 行）：

- 双层来源：内置模块 `src/modules/`，用户模块数据目录 `modules/`；同名用户模块替换内置，配置 `modules.<id>.useBuiltin` 可切回（modules.js:502-507）；`enabled !== false` 才加载（:214-215），safeMode 完全跳过用户模块（:216,512）。
- 故障隔离：单模块 setup 抛错只记 error 并 stop 自身，不拖垮其他模块（:397-402,418-422）；用户替换版加载失败自动回退内置版（:558-562）。
- 热重载：每 3 秒扫描，stamp 取目录最大 mtime+文件数（:79-84,521）；重载用**整目录快照**——复制到 `.aurabot-cache/<stamp>/` 再 import 新路径，靠模块缓存键不同强制刷新，node_modules 不入快照但 Node 向上查找仍可用（:443-461）；在途异步 import 用 revisions 代际作废（:465,474,496）；start/stop 递增 generation，会话侧工具闭包据此重挂。
- 卸载即收口：模块定时器 `api.every/api.later` 全部 unref 并登记，stop 时按注册逆序清理（:301-313,432）；插件 dispose 链覆盖监听、路由、危险确认中继、hub、bridge、OneBot、SnowLuma 与全部模块（host.js:681-691，modules.js:588-596），并删 globalThis 上的全局柄。

### 7.2 挂钩总线：模块能改什么，以什么顺序改

【事实】模块 `export default { id, name, version, setup(api) }`（抽验 src/modules/mood/index.js 同形），通过 `api.on` 注册可改写挂钩，关键形状：

- 回话接管 `message`：多模块按序第一个返回 true 者胜（claim，:606-611）；
- 提示词 `prompt` filter 链、单段回复 `reply`、拆条后 `reply/items`、最终 OneBot 发送段 `send`；
- 选模型 `model` 为同步 filter，返回 `{provider,model,reasoningEffort}`（:625-636，host.js:302）；
- 人格/规则 `persona/rules`、群聊是否回话 `group/decide`（host.js:298）；
- 只读事件：activity/onebot/state/config/module 启停/song 等。

【推断】这是一套「消息进入中枢后、真正发出前」的责任链微内核：每个挂钩都有确定的时序语义（拦截型 claim、过滤型 filter、只读 observe），模块作者不需要碰宿主会话代码即可改变行为，但挂钩能触及的面被显式枚举，不是任意 monkey-patch。

### 7.3 模块市场与用户数据保护

【事实】安装时若目标文件夹存在且无 `.aurabot-source.json`（用户手写标志），拒绝安装并提示「不会覆盖」（community.js:231）；module.json 带 id/version/capabilities，安装前校验 api 版本、最低插件版本、撤回名单与依赖（:138-145）；API.md 与 aurabot.d.ts 每次启动同步到用户 modules 目录（modules.js:808-819），内置模块可 fork 到用户目录改写（:114-152）。

### 7.4 沙箱：白名单平面+原型链斩断，但不是真隔离

【事实】`scopeCoreForModule`（modules.js:165-198）给模块的 hub 是删去 runSubagentTurn/subagentFor 等敏感方法的白名单对象，外层 Proxy 的 getPrototypeOf 返回 null 防原型逃逸；能力靠 module.json capabilities 声明，子智能体委派本机工具时按声明把关（评审 #177）。

【事实】它与 aurorabot.org 文档代承认的是同一条现实：**进程内模块与宿主同权限，沙箱只能收敛 API 面，不能挡住已授权能力被滥用**。其补偿机制是 preset 分档（§8.2）而非沙箱本身。

### 7.5 「截获发送不真发」的模拟测试钩子

【事实】hub 用 AsyncLocalStorage 提供 captureStore（hub.js:67），`hub.capture()` 期间 sendSegments/sendFile 把消息写入 sent 记录而不真发（hub.js:626,807,2240-2242），面板 `/modules/simulate` 路由据此给模块作者做预览（host.js:1453-1479）。

## 8. B 的宿主接线、并行工作链路与单主体

### 8.1 cordis 挂载形状

【事实】host.js:42-43 声明 `name:'aurabot'`、`inject=['agents','sessions','webServer','timer','workspaceRegistry','attachments','systemPrompt','llm']`；人格经 systemPrompt 变量注入 preset（host.js:96-104）；经 `cordis.patch.yml` 挂到 `@deepseek-ai/dsh-agent-preset` 的 plugins 段，定义四个 preset（§9.2）。client/ 是 5102 行网页半边，经 DSH client 机制注入侧栏，后端约 90 个 `/aurabot/api/*` 精确路由。

### 8.2 与聊天并行的工作链路：独立 system 会话、同一个人格主体

【事实】主动搭话 speakup 用 `api.every(60_000)` 节拍（src/modules/speakup/index.js:15）；目的引擎 purpose 是纯逻辑层零 I/O（src/purpose/engine.js:1-27），保守节奏：白天 2.5–5 小时一次、每天最多 4 次、23:30–08:30 静默（engine.js:31-49）；晚安、空间日记、QZONE、桌宠、B站 duty 等都是模块定时器或 system 后台轮次。

【事实】后台轮次走**独立 system 会话**（hub.js:93 systemTurns，level 分 chat/social），但与全部聊天会话共享同一个工作区（WORKSPACE_TITLE='Aurora Bot · QQ'，hub.js:45,343-356）与同一套人格；子任务用 aurabot-subagent preset 经 runSystemTurn/subagentFor 派出。即「多条并行工作链路、一个主体」，没有第二个 agent 人格。

【事实】生命周期收口很硬：等待 QQ 确认的定时器故意不 unref（要撑住挂起的工具调用），dispose 时统一拒绝 pending（danger.js:508,556-559）；hub 的拆条暂停、慢工具提示、回复等待在 dispose 时立即结束（hub.js:167-170,202-218）。

## 9. B 的聊天平台、安全模型、记忆与测试基建

### 9.1 每聊天一个 DSH 会话与群聊插话策略

【事实】chatId→{sessionId,preset,level} 持久化在 sessions.json（hub.js:84-86,385-387），每个私聊/群用 sessionController 建独立 DSH 会话且同属一个工作区，主人可在 DSH 侧栏看思考、直接插话（hub.js:371-390,402-446）。

【事实】群聊策略（group-policy.js）是防打扰工程样板：被叫必回（@/引用/唤醒词/追问短问句 mode='must'，:82-85）；无人叫时基础插话概率 0.15，按兴趣词 0.3+记忆命中 0.5 加权最高 0.8，再经静默时段、每群每小时 6 次、90 秒冷却、5 分钟内至少 3 条消息、相关度 ≥0.25 一串闸门（:3-17,88-106）；engaged 窗口连聊有 6 次兜底并给模型「可回沉默」的自刹车提示（:93-95,129-132）；120 秒 8 条突发上限但不拦明确被叫（:79-81）；群消息先攒 40 条缓冲、整段 flush（hub.js:1358-1364,1536-1537）。

【事实】OneBot 客户端 HTTP+WS 双通道，断线 2s→30s 指数退避（client.js:4-5,198-203）；超时/不确定错误标 uncertain 不重试以防重复发送（:76-78,134-137）；SnowLuma 只管理用户自下载副本、不代同意 EULA、注入前核对机器人 QQ 号，不匹配就断开且不自动重连（manager.js:6-9，host.js:125-167）。

### 9.2 安全模型逐项（均有代码支撑）

【事实】默认姿态：总开关 `enabled:false`、试运行 `dryRun:true`（抽验 src/core/config.js:11），dry-run 全链路只记日志不真发；preset 工具分档——主人私聊挂 bash/pwsh/fs/web 等本机工具，群聊/陌生人 aurabot-social **零本机工具**，子智能体 preset 有人格隔离（cordis.patch.yml，access.js:27-39，hub.js:507）。

【事实】敏感操作多重闸：敏感配置默认仅 owner，执行前查「本轮说话者全是主人」（access.js:46-74）；危险命令经 tools/pre-execute 钩子拦截，要求在 QQ 回「确认/同意/放行/ok」，60 秒超时即 deny，且确认回复在进 hub 前被截走（danger.js:459-531，host.js:176-182）。

【事实】管理面三道闸（host.js:346-476）：默认仅本机回环（以 socket 地址为准，XFF 只在命中 trustedProxy 时采信最后一跳，fail-closed）；写方法过 CSRF（Sec-Fetch-Site/Origin 同源）；Host 白名单防 DNS rebinding；仅 /ext//asset//open/ 精确放行且 /open 走 Bearer 密钥。

【事实】数据侧：记忆按 chatId 隔离，社交视角看不到别的聊天条目、压缩分簇绝不跨 chatId 混簇（memory.js:181-214,510-527）；数据全本地，备份打 zip、恢复前旧文件留 backups/pre-restore-*（core/backup.js:1-50）；出口清洗 leak-guard 用归一化后 20/18 字 shingle 指纹挡人格/规则/记忆原文被原样复读。

### 9.3 记忆做法与明确撞线的 mood/importance

【事实】记忆库 node:sqlite WAL（memory.sqlite，items/gists/kv/meta 四表），SQLite 不可用时双写 JSON 兜底（memory-store.js:8-12,88-111）；召回默认是**纯本地 tokenize+倒排 similarity**（memory.js:120-187），向量索引默认关闭、需显式开关且 embedding 端点由用户自配、向量存本机（memory-vector.js:1,42-53）；遗忘曲线按「多久没想起+被想起天数+重要程度」衰减（:339-359），容量按 source 分档（:647）；面板可搜改删。

【事实】撞线点单独取证：mood 是 5–100 标量，存 mood.json（value/at/reason/history 200 条），按半衰期指数衰减回基线，observe 给不同来源加权（主人 1.5 倍、群里旁语 0.3），judge 可选模型判走向且 confidence<0.6 不计，effects 输出 sticker/voice/delay/chatty 四个乘子并以非 system 上下文行注入（companion.js:53-158，mood/index.js）；memory 条目另有独立 importance 字段（memory.js:600）。

【建议】对 dsh-fasti 这两项只分析不借鉴：数值情绪/重要度入内核是本仓 `FORBIDDEN_SOURCE_CAPABILITIES` 与 K7 明确禁止项；其「乘子影响外显频率」的思路若未来需要，只能落在投影/外显层且另行外审，契约列永不添加。

### 9.4 假宿主 e2e 测试法（高价值可迁移）

【事实】`test/helpers/fake-dsh.js`（172 行）按插件 inject 清单最小实现 DSH 服务（agents Map、sessionController、webServer 路由表、systemPrompt.variable、session/event）；`mock-onebot.js`（188 行）起**真实本地 HTTP+WS 服务器**模拟 OneBot v11，记录调用并可 push 事件；「模型」是脚本化 brain() 按提示词分支返回固定回复或工具桩；断言基于 mock.calls、fake.turns、variables 与工具注册痕迹；另有 60+ 单测覆盖 danger/csrf/泄漏/网关韧性等安全链路。

---

# 篇 C：关系判定与 dsh-fasti 落地

## 10. 三个项目的关系判定

【事实】可核验的归属信号：

- aurorabot.org 页脚署名「JuFireX | AuroraBot-Dev」，文档指向 github.com/AuroraBot-Dev/Aurora（Python 3.12+uv）；
- Gitea 仓库归属用户 syntaxbullet，README 演化线名为 Kyoko→Aurora，技术栈 Bun/TS，最后活动 2026-04-10；
- dsh-aurabot-qq 归属 aureth-labs，旧名账户 accomplish07zrh-eng（2026-09-24 注册），技术栈 Node/cordis，人格昵称「大肥鱼」。

【事实】三轮交叉检索未发现任何共享代码、互链致谢、共同组织成员或文档互引；通用网络检索只返回与三者无关的同名 PyPI/crates 包；文档代 Python 仓库本轮未直读成功，未取得作者层面证据。

【推断】判定：**证据不足，按「理念相近/撞名、未见同源」处理，禁止混为一谈**。三者运行时（Python/Bun/Node）、生态（独立框架/Discord 游戏 bot/DSH 插件）、持久化选型（SQLite 愿景/Postgres/node:sqlite）均不同。即便存在个人层面的互相了解，也不构成谱系证据。本报告所有跨对象引用均按独立项目对待。

## 11. 与 dsh-fasti 现有架构的逐项同构/差异

### 11.1 概念同构表

| A 文档代概念 | dsh-fasti 对应物 | 同构与差异判断 |
|---|---|---|
| WorldJournal：单一 append-only 世界事件流 | 双层：raw/experiences append-only 真源 + event 层二级真源（写入即固化、不可算法重算）+ 可重建投影（SQLite 四表） | 【推断】dsh 分层更严：A 把「原始经历」与「因果/修正事件」合一流，dsh 明确区分真源/二级真源/投影（frozen-surface.ts:18-24 五条冻结面），投影可重建而事件不可重算。A 的 per-scope sequence+全局 cursor 对应 dsh 的 ULID 双指针/三时间轴思路，但 dsh 已预留 HLC 去中心化（backlog-visualization-multidevice.md:25-28） |
| AgentTree：不持久化、一棵树只是一次运行 | 一次会话/运行的运行时态 + 白盒 checkpoint JSON | 【推断】同构：运行态不进真源、结束即弃；dsh 的检查点是可检查的白盒文件而非黑盒 checkpointer，纪律更硬 |
| EnvironmentEvent(source/scope/kind) 统一输入媒介 | 经历 initiation 三来源（她/对方/系统）+ channel/scene 槽位、工具轮类型化 | 【事实】方向一致：外部输入先成为带类型与来源标记的经历，理解后才决策；dsh 的来源枚举是契约枚举，外部链路不得伪造保留值，与 A 的保留前缀防伪同构 |
| MCP 不得伪造 engine.*/cadence.* 事件 | 合成轮必须带来源标记走同一管线；initiation 保留值只由内核写入 | 【建议】C 块直接采纳为测试守门点：适配器侧任何合成输入尝试写保留 initiation 值的用例必须失败 |
| 节律只发 TreeLaunchRequest、不直接建节点/不自动投递 | C 块主动性设计：tick 去中心化、主动=带来源标记的合成轮、门限只收紧不放宽 | 【建议】完全相容，作为 C 块边界条款写入设计 |
| ToolOutput 三态、unknown 不自动重试 | 工具轮结果类型化、失败可观测上报 | 【推断】同构；外部效果不确定不重试的条款应进入未来工具适配器约定 |
| PromptAssembler 纯函数 | v1 方案的 window 纯函数槽位装配 | 【事实】同构，已在 memory-v1 方案 §4 落地为无副作用装配函数 |
| WorldReader/Writer 端口分离 | v1 MemoryReadHandle/MemoryWriteWriteHandle 读写柄分离、写柄进程内单例 | 【事实】同构且 dsh 已更具体（写柄冲突抛 ConflictError） |

### 11.2 B 与 cordis：是否重复造轮子

【事实】dsh-fasti 已经是 cordis 对象插件，但两个文件的职责要分清：`src/adapters/dsh/plugin.ts:188` 是对象插件的 `apply(ctx, rawConfig?)` 入口，文件尾 :367-370 导出 `export const plugin = { name: 'dsh-fasti-adapter', apply }`，仅含 name+apply、**不含 inject 字段，全文也没有任何 `ctx.inject()` 调用**（:341 的 system-injection 是 harness 跳过原因枚举，与依赖注入无关）；宿主服务依赖清单声明在胶水插件 `integrations/dsh-host-glue/index.js:59`，原文为 `inject: ['llm', 'agentDefaultModel'],`，其上 :56 注释为「对象插件：inject 保证装载时两个宿主服务已注册」。同一文件内：`:219` 的 `ctx.on('session/event', ...)` 是 fiber 级监听、插件卸载自动移除，`:251` 的 `ctx.effect` 包住 Fasti.open/close，`:233` 的 startClosureWorker 是一次性 setTimeout 链（全文件 setInterval 出现 0 次）而非常驻调度。这一分布恰好支撑结论：cordis 接线集中在适配层与胶水层，内核 src/ 其余部分保持宿主无关。

【推断】对照 B 的 modules.js，能力边界应这样划：

1. cordis 原生已覆盖：服务定位与 DI（inject）、插件装载/卸载生命周期、fiber 级监听随插件回收、context 继承与隔离。dsh 不需要、也不应在内核再写一套容器。
2. B 自建、cordis 不直接提供的增量：用户目录文件模块的 mtime 热重载与快照、模块 generation 代际、用户模块替换内置与失败回退、面向业务语义的挂钩总线（message/prompt/reply/model/group-decide）、模块市场安装安全链、模块级能力白名单平面。这些是**生态层/适配器层能力**，不是内核能力。
3. 结论：未来在 dsh 上开放「开发者注入新本领」，正确位置是 `src/adapters/` 之外的独立扩展面（或独立插件包），复用 cordis 卸载语义实现生命周期，把 B 的增量当作可选的开发者体验层按需建设；任何模块加载器都不得获得指向 experiences/events/raw-turns/state 的写函数（与 v1 方案对 memory store 的同一条纪律）。

### 11.3 「开辟与聊天并行的全新工作链路」在 dsh 的安全落点

【推断】综合 B 的 systemTurns 实践与 A 的主体哲学，安全落点为四条：

- **主体唯一**：并行链路只能以「同一她」的合成轮进入既有回复管线，禁止新建第二人格/第二决策主体；这与 B 的独立 system 会话+共享工作区+共享人格形状一致。
- **信号与事实分离**：定时器/cron 只允许产生一条带来源标记的输入事件（等价 A 的 TreeLaunchRequest），不得直接写投影结论、更不得碰真源；K3 未重议前节拍源留在宿主/插件层，内核不加调度器。
- **收口确定**：所有并行句柄必须有宿主卸载时的逆序清理登记（参照 B modules.js:301-313 与 host.js:681-691），dsh 侧落点是适配器 `ctx.effect` 的清理函数，不允许出现脱离 effect 生命周期的句柄。
- **打扰门限只收紧不放宽**：初始参数直接参考 B 的保守量级（静默时段、每日个位数次数、冷却+突发上限、相关度门槛），上线后只允许经数据评审收紧。

## 12. 硬清单一：建议吸收项

| # | 吸收项（来源） | dsh 落点 | 前置条件 | 量化重议/触发口径 |
|---|---|---|---|---|
| 1 | 贡献点先声明后使用、未声明接线启动即失败（A 文档代） | 未来扩展面的契约文件与启动校验，仅适配器/扩展层 | C 块扩展点冻结清单立项 | 出现第二个外部扩展接入需求时启动 |
| 2 | 保留事件前缀防伪：外部输入不得伪造 initiation 保留值（A 文档代） | 适配器输入校验 + 一条反证测试 | C 块设计启动 | 不设触发，属正确性基线，C 块必备 |
| 3 | 节律只发启动请求、不自动投递、unknown 外部效果不重试（A 文档代+B onebot uncertain） | C 块合成轮协议、工具适配器约定 | C 块立项 | 同上，设计条款 |
| 4 | 业务挂钩总线的责任链分类（claim 拦截/filter 改写/observe 只读）（B modules.js:606-636） | 独立扩展面的 hook 目录，先冻结小集合（消息进入/提示词/发送前/选模型） | cordis 原生能力复核通过；内核零改动 | 有明确第三方模块场景且过外审 |
| 5 | 用户态热重载快照+revision 作废+generation 重挂（B modules.js:443-496） | 扩展层模块加载器（非内核） | 第 4 项落地；先验证 cordis 卸载/重载能否满足，不满足才自建 | 开发者工作流实测：重载导致的会话闭包泄漏率必须为 0 才允许默认开启 |
| 6 | 模块能力白名单平面+原型链斩断（B modules.js:165-198） | 扩展层 sandbox 适配；配合 preset 工具分档 | 第 4 项 | 任何新能力入白名单需评审；文档必须写明「非真隔离」 |
| 7 | 市场 zip 安全链：sha256/路径防穿越/原子落位/不覆盖用户目录/撤回名单（B community.js） | 未来分发方案的验收 checklist 照搬 | 有分发需求时 | 不触发不建市场；触发时整条清单为 DoD |
| 8 | 默认关+dry-run、群聊零本机工具、本轮全主人确认、回环+CSRF+Host 白名单（B config/access/host） | dsh 任何对外平台适配器的安全基线 | 平台适配器立项 | 属基线无触发条件；dry-run 截获发送可复用 AsyncLocalStorage 形态（B hub.js:67） |
| 9 | 假宿主+真协议平台模拟器+脚本 brain+截获发送的 e2e 法（B test/helpers） | tests/ 下新增平台/宿主替身（不动现有 517 用例） | C 块或平台适配器开工前 | 替身接口按宿主 inject 清单最小实现，覆盖率门槛随该块 DoD 定 |
| 10 | 纯本地倒排召回、向量默认关+端点自配（B memory.js/memory-vector.js） | 与 v1 平坦 BM25 路线互相印证 | v1 上线后审计数据积累 | 直接沿用 v1 方案 K1 重议条件（连续两审计周期漏召越线且词法改造证穷尽） |
| 11 | 卸载逆序清理、危险确认 pending 统一拒绝（B host.js:681-691） | 适配器 effect 清理规范，补一条泄漏守门测试 | C 块并行链路设计 | 无，作为并行链路 DoR |
| 12 | 单进程同库、零生产依赖、CI 仅 test 的供应链姿态（B package.json） | 维持本仓 dependencies={} 纪律 | 无 | 任何新增依赖按 v1 方案 §13.2 单独论证 |

## 13. 硬清单二：禁止照搬项

| # | 禁止项（来源） | 撞线位置 | 说明 |
|---|---|---|---|
| 1 | mood 5–100 标量、半衰期情绪、memory.importance 数值（B companion.js/memory.js:600） | K7；frozen-surface.ts:78-88 禁词体系；无情绪字段纪律 | 情绪表达只可能在投影/外显层另行外审，契约与真源永不加列 |
| 2 | 进程内常驻 cron/setInterval 节拍（B api.every 可在插件层存在，但不可入内核） | K3；backlog tick 去中心化/HLC 预留 | dsh 现有闭合 worker 已是一次性 setTimeout 链（plugin.ts:233）；内核调度器重议需 C 块外审+单实例锁方案 |
| 3 | 任何默认遥测/埋点/外发上报 | K13 无默认遥测 | B 自身无遥测是正面样本；其外网功能端点（B站/TTS/生图）属用户主动功能，不构成反例 |
| 4 | LLM 静默改写既有记忆/事实 | K5；append-only 真源唯一写出口 | B 的面板搜改删作用于其自有记忆库；dsh 真源禁 update/rewrite/patch 类能力（frozen-surface.ts:78-101） |
| 5 | 会话/平台字段写入真源 | K12；三槽位形状冻结面 | B 的 sessions.json 是插件运行态存储（可接受形态），但 chatId/preset 等不得进 dsh 经历真源列 |
| 6 | 向量/embedding 成为默认硬依赖 | K1 | B 的「默认关+自配端点」是可接受形态，但 dsh v1 定案平坦 BM25，重议条件已在方案 §10.2 量化 |
| 7 | 第三方进程内模块按同权限默认可信 | 供应链纪律+K13 | 能力声明只是缓解；必须 preset 分档（社交场景零本机工具）+显式安装确认，不允许「装了就有 bash/fs」 |
| 8 | 真源原地更新、DELETE 级联缺失式删除 | K4；九框架调研反面教材（Graphiti 裸 DELETE、Mem0 纯 ADD） | erase 本期不实现；二级真源写入即固化 |
| 9 | 在线热路径 LLM 判定/黑盒 checkpointer | K6/K8 及白盒检查点纪律 | B 的 mood.judge 是可选在线模型调用且只作用外显层，dsh 热路径不引入新 LLM 判定，检查点保持白盒 JSON |
| 10 | 把文档愿景当已验证实现引入决策 | 调研纪律 | A 文档代代码在可访问仓库零实现（§5），只借设计约束、不抄实现承诺 |

## 14. 硬清单三：模块化扩展与并行工作链路路线建议

【建议】按依赖顺序分四档，均不改变当前冻结面：

1. **当前档（不插队）**：记忆层 v1 离线脚手架在外部实现中，本仓只持有方案文档；模块化主题不产生任何代码动作，避免两条主线争用同一批投影/契约评审注意力。
2. **C 块预备档（两件小事，先于主动链路编码）**：
   - 产出《扩展点冻结清单》：枚举 dsh 愿意开放的最小 hook 集合与各自时序语义（参照本报告 §12 第 4 项的三类划分），逐条标注可触碰层（外显/投影/运行时），真源与二级真源层不出现任何扩展点；
   - 引入假宿主+平台模拟器测试替身（§12 第 9 项），先让「合成轮走同一管线」「保留来源不可伪造」「卸载无句柄泄漏」三个守门点有测试承载，再写主动逻辑。
3. **C 块实施档**：主动链路按 §11.3 四条落点建设；门限初值取 B 的保守量级并在文档标注为经验初值、待数据校准（与 v1 方案 R1/R2/R3 红线同一治理方式：只收紧不放宽）；节拍源留宿主侧，内核 tick 仅在 K3 重议通过后动。
4. **生态演进项（C 块之后，条件触发）**：用户态模块加载器/热重载、模块市场与分发安全链。触发条件：至少出现两个内部外部模块需求、扩展点清单经一轮外审冻结、cordis 原生卸载能力经实测确认边界；内核始终不获得模块运行时，所有模块能力经适配器 effect 生命周期收口。

【建议】与 v1/C 块的耦合关系显式登记：v1 的选择索引是独立投影、禁止加列入事件二级真源的纪律同样适用于未来任何模块自带存储——模块私有库可以建，写真源/二级真源的函数不对外开放；v1 harness 的 sampled provenance 审计方法将来可直接复用于主动链路的「合成轮来源标记正确率」审计，两者共用本地审计、不上报（K13）。

【建议】返工诱导守门提示：本报告不产生任何「趁手就先改内核」的条目；若后续设计中出现把 hook 注册伸进 src/core、src/event、src/projection 既有写路径，或给真源模块导出新 mutate 能力的方案，应按冻结面流程直接驳回，回到适配器/独立投影/外显层解决。

---

## 附录 B：C 块模块化与并行链路立项评审 checklist（可勾选）

> 本附录仅对正文第 11–14 章结论做重组与收敛，不引入新结论、新数字或新承诺；每条末尾标注论据来源（报告章节、本仓/外部源码锚点或 K 编号），数字口径以正文为准。立项评审时逐组过闸，G6 为命中即驳回的一票否决项。

### G0 立项前置 DoR

- [ ] 记忆层 v1 离线脚手架收尾前，模块化主题不产生代码动作、不插入并行主线（§14 第 1 档）
- [ ] 《扩展点冻结清单》先于主动链路编码产出，枚举最小 hook 集合、时序语义与可触碰层，真源与二级真源层不出现扩展点（§14 第 2 档；§12 第 4 项）
- [ ] 假宿主+平台模拟器测试替身先就位，先承载「合成轮走同一管线」「保留来源不可伪造」「卸载无句柄泄漏」三个守门点测试，再写主动逻辑（§9.4；§12 第 9 项；§14 第 2 档）

### G1 架构边界

- [ ] hook 注册不伸进 src/core、src/event、src/projection 既有写路径，违者按冻结面流程直接驳回（§14 返工诱导守门点）
- [ ] 不另造容器：服务 DI、装载/卸载生命周期、fiber 级监听回收一律复用 cordis；inject 清单在 integrations/dsh-host-glue/index.js:59，plugin.ts:188 为 apply 入口、:219 为 ctx.on fiber 级监听、:251 为 ctx.effect、:367-370 为仅含 name+apply 的对象插件导出（§11.2）
- [ ] 用户态模块加载器/热重载只允许落在适配器或独立扩展层，内核始终不获得模块运行时（§11.2；§14 第 4 档）
- [ ] 任何模块不得获得指向 experiences/events/raw-turns/state 的写函数（§11.2；§14 耦合登记）
- [ ] 模块私有存储只能独立成投影，禁止加列入事件二级真源（§14 耦合登记）
- [ ] 不向真源模块导出新的 mutate 能力（src/contract/frozen-surface.ts:78-101；§13 第 4、8 项）

### G2 扩展点纪律

- [ ] hook 最小集冻结，按责任链时序分为 claim 拦截、filter 改写、observe 只读三类，不开放任意 monkey-patch（§7.2；§12 第 4 项）
- [ ] 贡献点先声明后使用；引用未声明贡献点或重复声明均在启动前失败，运行期 Assembly 不可变（§3.1；§12 第 1 项）
- [ ] 保留来源反证测试为必备正确性基线：外部输入尝试伪造 initiation 保留值的用例必须失败（§3.3、§11.1；§12 第 2 项）
- [ ] 能力白名单每新增一项需单独评审，且产品与接口文档必须写明进程内模块「非真隔离」（§7.4；§12 第 6 项）

### G3 安全基线

- [ ] 默认姿态为 enabled:false + dryRun:true，试运行全链路只记日志不真发（src/core/config.js:11；§9.2；§12 第 8 项）
- [ ] 群聊/陌生人会话零本机工具，工具能力按四个 preset 分档，敏感本机能力仅主人私聊可达（cordis.patch.yml；src/chat/access.js:27-39；§9.2）
- [ ] 敏感操作要求「本轮说话者全是主人」，危险命令须 QQ 回确认、60 秒超时或中途关开关一律 deny（src/chat/access.js:67-74；src/security/danger.js:459-531；§9.2）
- [ ] 管理面默认仅本机回环，写方法过 CSRF，Host 白名单防 DNS rebinding，反代场景 fail-closed（src/host.js:346-476；§9.2）
- [ ] 所有句柄纳入卸载逆序清理，并配一条句柄/定时器泄漏守门测试（src/host.js:681-691；src/core/modules.js:301-313；§12 第 11 项）
- [ ] 模块市场为条件门：仅当出现真实分发需求时启用，落地须整条满足 sha256 校验、拒加密 zip 与路径穿越、25MB/64MB 大小上限、两阶段原子落位+.old 回滚、revoked 撤回名单、不覆盖用户手写目录（src/core/community.js:70-110,180-231；§6.2、§7.3；§12 第 7 项）

### G4 主动并行链路

- [ ] 主体唯一：并行链路只能以同一她的合成轮进入既有回复管线，禁止第二人格或第二决策主体（§8.2；§11.3）
- [ ] 信号与事实分离：定时器/节律只允许产生带来源标记的输入事件，不得直接写投影结论或碰真源；节拍源留宿主/插件层，内核调度器须待 K3 重议通过且附单实例锁方案后方可动（§3.4；§11.3；K3）
- [ ] 收口确定：并行句柄全部挂适配器 ctx.effect 生命周期逆序清理，不允许脱离 effect 的游离句柄（§11.3；src/adapters/dsh/plugin.ts:251）
- [ ] 打扰门限只收紧不放宽；经验初值（标注待数据校准）：静默时段 23:30-08:30、白天 2.5-5 小时一次且每日最多 4 次、群聊插话基础概率 0.15 加权封顶 0.8、每群每小时 6 次上限、90 秒冷却、120 秒 8 条突发上限、话题相关度门槛 0.25（§8.2 src/purpose/engine.js:31-49；§9.1 src/chat/group-policy.js；§11.3、§14）
- [ ] 外部效果不确定不自动重试，unknown 结果原样交模型处理（§3.4；§9.1 src/onebot/client.js:76-78）

### G5 记忆与依赖

- [ ] 维持纯本地平坦 BM25 召回；向量能力默认关闭、embedding 端点由用户自配，任何启用讨论走 K1 量化重议条件（§9.3；§12 第 10 项；K1）
- [ ] 生产 dependencies 保持空集；确需新增依赖按 docs/memory-v1-offline-scaffold-plan.md §13.2 单独论证（§12 第 12 项）
- [ ] 质量与漏召审计本地落库、不上报，无默认遥测或埋点外发（K13；§12 第 12 项；§14 耦合登记）

### G6 一票否决红线（命中即驳回，对应第 13 章十项）

- [ ] 情绪/心情/重要度数值进入契约或真源列（mood 标量、memory.importance 同类）→ 驳回（K7；§13 第 1 项）
- [ ] 进程内常驻 cron/setInterval 节拍进入内核 → 驳回（K3；§13 第 2 项）
- [ ] 任何默认遥测、埋点或外发上报 → 驳回（K13；§13 第 3 项）
- [ ] LLM 静默改写既有记忆/事实 → 驳回（K5；src/contract/frozen-surface.ts:78-101；§13 第 4 项）
- [ ] 会话/平台字段写入真源 → 驳回（K12；§13 第 5 项）
- [ ] 向量/embedding 成为默认硬依赖 → 驳回（K1；§13 第 6 项）
- [ ] 第三方进程内模块按同权限默认可信、无 preset 分档与显式安装确认 → 驳回（供应链纪律；§13 第 7 项）
- [ ] 真源原地更新、无级联的裸 DELETE 类删除路径 → 驳回（K4；§13 第 8 项）
- [ ] 在线热路径新增 LLM 判定或引入黑盒 checkpointer → 驳回（K6/K8；§13 第 9 项）
- [ ] 把 aurorabot.org 文档愿景当作已验证实现引入决策（其 Python 仓当前匿名访问 404、无公开代码可核验）→ 驳回（§1、§5、§13 第 10 项）

### G7 演进项触发门

- [ ] 用户态热重载在默认开启前，须有实测证明重载导致的会话闭包/工具闭包泄漏率为 0（§12 第 5 项）
- [ ] 模块加载器/市场立项须同时满足三项：至少出现两个内部或外部模块需求、扩展点冻结清单经过一轮外审冻结、cordis 原生卸载能力边界经实测确认（§14 第 4 档）

---

## 附录 A：证据索引

### A-文档代（aurorabot.org，2026-11-11 通读，均为文档主张）

- 首页与设计哲学：https://www.aurorabot.org/ ；系统总览/组合机制门面、世界提交与观察前沿、运行核心（PromptAssembler/Tool 三态/调度）、MCP 适配器与保留事件协议、Tool 定位与验收标准、参考 FAQ：站点 /architecture/* 与 /reference/* 共 18 个 Pager 页；占位页 /develop/app-development、/develop/kernel-development。
- 文档指向的新内核仓库：https://github.com/AuroraBot-Dev/Aurora （截至 2026-11-11 匿名 HTTP 实测返回 404、公开不可达，取证方式为匿名请求状态码；改名/私有/删除原因均无证据，不断言；本轮无任何公开代码可核验，代码结论存疑，仅作设计证词引用）。

### A-仓库代（Gitea，main@222f32d9，2026-11-11）

- 仓库：https://git.ayau.me/syntaxbullet/aurorabot ；raw 形式 `https://git.ayau.me/syntaxbullet/aurorabot/raw/branch/main/<路径>`。
- 关键文件：bot/index.ts、bot/lib/BotClient.ts、bot/lib/handlers/CommandHandler.ts、bot/lib/interaction.routes.ts、shared/lib/events.ts、shared/lib/eventWiring.ts、shared/games/types.ts 与 registry.ts、shared/db/DrizzleClient.ts 与 schema/*、api/src/server.ts、api/src/games/RoomManager.ts、docs/new-design/DESIGN.md、AGENTS.md。

### B（github.com/aureth-labs/dsh-aurabot-qq，main@5eb5b946/v1.2.1，2026-11-11）

- 上游 https://github.com/aureth-labs/dsh-aurabot-qq ；旧名入口（301 同仓）https://github.com/accomplish07zrh-eng/dsh-aurabot-qq ；市场仓 https://github.com/aureth-labs/dsh-aurabot-qq-mods ；DSH 档案 https://www.dsh.so/zh/artifact/dsh-aurabot-qq/ 。
- 关键文件：package.json、cordis.patch.yml、src/core/modules.js、src/core/community.js、src/core/config.js、src/core/redact.js、src/host.js、src/chat/hub.js、src/chat/group-policy.js、src/chat/access.js、src/onebot/client.js、src/security/danger.js、src/features/memory.js、memory-store.js、memory-vector.js、src/modules/mood/index.js、src/features/companion.js、src/purpose/engine.js、test/helpers/fake-dsh.js、test/helpers/mock-onebot.js。
- 行号证据以上游 main@5eb5b946 为准；本报告作者已对 package.json、config.js:11、host.js:346、modules/mood/index.js 在本地克隆独立抽验。

### dsh-fasti 本仓锚点（HEAD=eafe484）

- src/contract/frozen-surface.ts:18-24（五条冻结面 ID）、:78-101（禁词能力与判定）；src/adapters/dsh/plugin.ts:188（apply 入口）、:219（ctx.on fiber 级监听）、:233（startClosureWorker，一次性 setTimeout 链）、:251（ctx.effect 包 Fasti.open/close）、:367-370（仅含 name+apply 的对象插件导出，不声明 inject）；src/adapters/dsh/llm.ts:142；integrations/dsh-host-glue/index.js:56-60（:59 为 `inject: ['llm', 'agentDefaultModel']`）；docs/backlog-visualization-multidevice.md:25-29；docs/memory-v1-offline-scaffold-plan.md §10.2（K1–K13 重议条件表，:581 起）；docs/chat-memory-frameworks-survey.md、docs/framework-survey-landing-analysis.md。

*本调研全程只读：外部 git 操作仅 clone/ls-remote/log，本仓未改动任何既有文件、未执行任何 git 写操作。*

