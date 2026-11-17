# 平台耦合事实确认（只陈述现状，不含方案）

确认日期：2026-11-17　身份：只读核对（未改代码、未跑 git 写操作、真实数据根只读打开）
基线：HEAD `b41ab21`，`npm test` 本轮实测 1231 tests / 1231 pass / 0 fail；`src/` 96 个 `.ts`（其中非适配层 89）。

**范围声明**：本文只回答"现在被 DSH 绑住了哪些、绑得多紧"，不含迁移方案、不含工作量估算、不含排期。
按 `docs/architecture-design-spec.md:887` 与 `:972`，#72「平台化目标架构（C6）」仍处冻结、勿擅启；本文不构成对该卡的启动。

---

## 一、一句话现状

**数据与记忆逻辑基本不在 DSH 里，DSH 的绑定集中在"怎么被叫起来、怎么把工具递出去、什么时候跑一轮"这三件事上。**
可搬的是"记忆本身"，要重写的是"接入与节拍"。

---

## 二、耦合点逐项（每项给证据）

| # | 对象 | 实测耦合情况 | 证据 | 判定 |
|---|---|---|---|---|
| 1 | 数据与库文件 | 事件/经历/原文为 JSONL 分片；投影 `fasti.sqlite`、记忆索引 `memory-index/`、影子 `memory-shadow/` 均为标准文件 | 真实根 `~/.dsh/fasti` 当前 13 个文件，全部为该目录下的普通文件 | 可搬（拷贝目录即可读） |
| 2 | 核心代码 89 个 `.ts` | 全部只依赖 Node 内置模块；`package.json` `dependencies` 实测为 `{}` | `contract`9／`core`7／`source`7／`projection`10／`event`12／`memory`38／`runtime`1／`api`1／`assembly`4 | 可搬（受运行时约束） |
| 3 | SQLite 访问 | 直接 `new DatabaseSync(...)`，未走任何宿主抽象 | `src/memory/store.ts:607`、`src/memory/builder.ts:259`、`:531` | **唯一硬技术约束**：`node:sqlite` 为 Node 22 实验 API，换非 Node 运行时或禁用该内置模块的环境必须替换此层 |
| 4 | 装配层 `src/assembly/` | 注释即契约：不 import 宿主包、不自建数据库写柄 | `src/assembly/index.ts:8`、`memory-tools.ts:4`、`source-lookup.ts:12` | 可搬（宿主无关内核） |
| 5 | 数据根解析 | 三级：显式 `dataRoot` > `$DSH_HOME/fasti` > `~/.dsh/fasti` | `src/source/paths.ts:39-47` | 可搬：两个兜底层级绑 DSH 目录约定，显式 `dataRoot` 可完全覆盖 |
| 6 | 环境变量 | 全仓 `src` 实测仅 2 个 | `DSH_HOME`（`src/source/paths.ts:30`）、`FASTI_PROJECTION_ENGINE`（`src/projection/detect.ts:67`） | 可搬（无配置中心依赖） |
| 7 | 宿主适配层 `src/adapters/dsh/`（7 文件） | 三个宿主包各有硬引用：模型请求构造用 `BlockAssembler / ReasoningEffortId / createUserMessage`；工具注册用 `defineTool`；插件上下文用 cordis `Context` | `host-model-route.ts:24-25`、`memory-tool-bridge.ts:16-17`、`plugin.ts:29` | **需重写**，不是移动 |
| 8 | 工具协议面 | 6 个工具名与 schema 全部经 `defineTool` 注册进宿主工具表，注册入口是 `ctx.inject(['tools'], …)` 授权子上下文 | `memory-tool-bridge.ts:32-39`（六名）、`plugin.ts:396` | **需重写**：换平台须按对方工具协议重新注册，且要重做"未授权不得读 tools"的等价闸 |
| 9 | 部署方式 | bundle patch 为 DSH 专有机制；`dataRoot` 写死绝对路径 | `integrations/dsh-host-glue/cordis.patch.yml`（`insert: id: fasti`） | **需重写**：patch 结构无通用等价物 |
| 10 | 生命周期与节拍 | 关库走 `ctx.effect` cleanup；后台 worker 用"一次性 `setTimeout` → 执行 → 再排下一次"自管理链，卸载由 disposer 清定时器 | `plugin.ts:317`、`llm.ts:128-160`、`:181-191` | **需重写**：脱离宿主后要自建调度，而当前设计明文禁止常驻调度器（`architecture-design-spec.md:256` 单进程单实例；K3） |
| 11 | 写单例 | 同一数据根同时仅允许一个写实例，全部真源 append 过同一串行队列 | `src/source/writer-queue.ts:2-13`、`architecture-design-spec.md:256` | 与"宿主进程唯一"耦合：脱离宿主后单写者保障要自己重新成立 |

---

## 三、分界线（一句可记的版本）

- **可搬（4 类）**：数据文件、89 个核心/装配 `.ts`、显式 `dataRoot` 入口、2 个环境变量。
- **需重写（4 类）**：宿主适配层、六工具协议面、bundle patch 部署、生命周期与后台节拍。

---

## 四、"被平台锁住"的实测表现（来自 2026-11-16 审计）

`docs/audit-actual-assets-2026-11-16.md:148` 记 A 栏（仓内文档明确记载）平台锁定 **0 条**；同文 `:157` 记 B 栏（会话内实测环境问题）**4 条**，全部集中在同一宿主的凭据与界面链路上：

1. headless 启动报 `MISSING_CREDENTIAL`（bundle 意图性禁凭据）；
2. 隔离 profile 的会话界面点击全部失效；
3. 同环境 API 逆向 401/404；
4. 换账号路由后仍无法新建会话。

这 4 条的性质是**运行/凭据链**问题，不是数据或记忆逻辑问题——与第二节的分界一致。

---

## 五、当前真实资产体量（今日只读实测）

| 项 | 实测 |
|---|---|
| 真实根文件数 | 13（2026-11-14 时为 9，增量来自记忆索引与影子目录） |
| 记忆卡片 | 2 张（`memory-index/memory-index.sqlite`，只读打开） |
| 别名 | 0 条 |
| 落空记录 | 0 条 |
| 检查点 | `tick=6`、`engine=L1`、`degraded=false`、`pending_events=0` |

体量极小，意味着"迁移代价"的分子主要不是数据搬运，而是第二节第 7–11 项的重写。

---

## 六、本文未覆盖（避免被当作结论使用）

1. 未评估"非 Node 运行时"下的 SQLite 替代方案（只标出约束位置，未做选型）；
2. 未评估其他框架工具协议的注册成本与能力差（只确认当前 6 工具须重做）；
3. 未评估"脱离宿主后主动节拍如何成立"——该问题与 #99/#101/#72 同域，属冻结区；
4. 未做任何代码或配置改动；真实数据根仅只读打开两张 sqlite，未建 WAL、未写文件。

---

## 七、证据来源

| 材料 | 状态 |
|---|---|
| `docs/architecture-design-spec.md`（`:256` 单进程单实例、`:887` #72 挂起、`:972` 冻结项、`:976` 波次顺序） | 已入库 |
| `docs/audit-actual-assets-2026-11-16.md`（`:148` A 栏、`:157` B 栏、`:167` 第 4 部分平台锁定评估） | **未跟踪** |
| `docs/probe-report-host-version-e2e-2026-11-17.md`（宿主断点、rules 版本、端到端链路三探针） | **未跟踪** |
| 本文的代码行号与测试数字 | 2026-11-17 于 `b41ab21` 实测 |
