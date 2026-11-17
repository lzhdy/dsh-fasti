# dsh-fasti 只读资产审计报告

审计日期：2026-11-16　审计员身份：只读（未修改、删除、生成任何代码或配置）

审计基线：

- 工作副本 HEAD = `b41ab21`，`git status` 跟踪文件 0 个 modified（本轮实测 `git status --porcelain | grep -c '^ M'` = 0）
- 全量测试本轮实测：`npm test` → tests 1231 / pass 1231 / fail 0 / duration 25584ms
- 真机数据根 `~/.dsh/fasti` 仅做文件级只读盘点（未打开 sqlite，未改任何文件）

判定原则：**有测试且测试通过、或真机有数据落地，才算"已跑通"**；仅"代码写完了"一律不计。

---

## 第 1 部分　实际资产清单

### 1.1 源码模块（`src/` 共 96 个 `.ts`）

| 层 | 目录 | 文件数 | 实际文件（按文件名逐个核对） |
|---|---|---|---|
| L0 契约 | `src/contract/` | 9 | experience / raw-turn / event / event-primitives / primitives / channel / frozen-surface / validate-experience / index |
| 零依赖核心 | `src/core/` | 7 | fsx / jsonl / hash / ulid / time / errors / deadline |
| L1 真源 | `src/source/` | 7 | paths / tick / writer-queue / raw-log / event-log / experience-log / channels |
| L3 投影 | `src/projection/` | 10 | schema / event-schema / sqlite / jsonl / event-row / edge / detect / rebuild / source-scan / types |
| L2 事件 | `src/event/` | 12 | params / segmenter / closure / correction / ingest-stage / backfill / backlog / convert / l3 / tool-typing 等（含 5.9 十模块） |
| L4 记忆 | `src/memory/` | 38 | 见 1.2 与 1.6；含 `audit/` 子目录 10 个文件 |
| L4.5 运行态 | `src/runtime/` | 1 | checkpoint |
| API 门面 | `src/api/` | 1 | index（class Fasti） |
| L5 装配 | `src/assembly/` | 4 | memory-tools / host-tool-runtime / source-lookup / index |
| L6 适配 | `src/adapters/dsh/` | 7 | plugin / llm / host-model-route / memory-tool-bridge / convert-event / host-glue / index |

`src/memory/` 38 个文件含 `audit/` 10 个：consistency / decoy / fixtures / four-state / gold / metrics / provenance / rates / readiness / shadow-read。

### 1.2 数据表

**记忆层 7 张表**（`src/memory/schema.ts`，`MEMORY_EXPECTED_TABLES` 常量逐字声明）：

| 表 | 关键字段（实测 DDL） |
|---|---|
| `schema_meta` | 版本台账 |
| `mem_card` | card_id(PK) / event_id / anchor_json / channel / card_type / selection / **weight REAL 0–1** / **display_cues_json** / aliases_json / discriminator / entity_hint_json（CHECK 恒 NULL） / occurred_ms / ended_ms / valid_ms / invalid_ms / created_ms / expired_ms / status / content_hash / hit_count / last_hit_ms / schema_version |
| `mem_card_fts` | 虚表 fts5(card_id UNINDEXED, cue_text, **tokenize='trigram'**) |
| `mem_alias` | 卡片别名词表（术语归一化列 term_norm） |
| `mem_miss` | 漏召观测表（term_norm / term_hash / observed_ms） |
| `mem_audit_run` | 离线审计运行台账 |
| `mem_audit_item` | 离线审计条目 |

`mem_card` 上的硬约束（实测）：`card_type IN ('event')`、`selection IN ('selected','excluded')`、`status IN ('active','invalid','superseded')`、`entity_hint_json IS NULL`、`weight BETWEEN 0 AND 1`、`json_array_length(display_cues_json) BETWEEN 1 AND 3`、`length(discriminator) <= 40`。

**投影层 3 表 + 1 虚表**（`src/projection/schema.ts`）：`experience`（idx_exp_time / idx_exp_kind / idx_exp_channel 三索引）、`experience_fts`（fts5 trigram）、`edge`（idx_edge_src / idx_edge_dst 两索引）。

**真源无表**：全部为 JSONL 分片 + manifest.json。

### 1.3 对外接口

**`Fasti` 类方法（`src/api/index.ts`）22 个**，其中 4 个为抛 `NotImplementedError` 的桩：

已实现 18：`Fasti.open`(static) / `ingestRawTurn` / `ingestStageFailures` / `checkSilenceClock` / `drainClosure` / `drainMemoryProjection` / `pendingSummaryCount` / `queryEvents` / `getEvent` / `queryEventViews` / `getEventView` / `listEventVersions` / `closeAndReopenEvent` / `query` / `search` / `queryEdges` / `readExperienceById` / `resolvePointer` / `rebuildProjections` / `close`

未实现 2 桩（抛错，属阶段 3+）：`ingestMedia`（:547）、`preserveMedia`（:554）、`queryEntity`（:1212）、`getMedia`（:1310）——按代码计数为 4 个桩。

**DSH 工具 6 个**（`src/adapters/dsh/memory-tool-bridge.ts`，全仓唯一 import `@deepseek-ai/dsh-tools` 的运行时模块）：
`fasti_memory_search` / `fasti_memory_cards_by_anchor` / `fasti_memory_resolve_pointer` / `fasti_memory_add_alias` / `fasti_memory_experience_summary` / `fasti_memory_raw_text`

**离线 CLI 8 项**（`scripts/`）：backfill-events.ts、build-memory-index.ts、replay-shadow-observations.ts、run-memory-audit.ts、simulate-realtime-session.ts、verify-mutation-44.sh、verify-stage4-frozen-surface.ts、verify-stage4-realtime.ts

### 1.4 第三方依赖

| 类别 | 实测内容 |
|---|---|
| `dependencies` | `{}` —— **生产零运行时依赖** |
| `devDependencies` | `@deepseek-ai/cordis` 4.1.0、dsh-llm / dsh-tools / dsh-agent / dsh-ptc-runtime / dsh-sandbox / dsh-scope / dsh-session / dsh-user-approval 均 0.2.1-rc.5、`@types/node`、`typescript` 5.9.3 |
| `peerDependencies` | cordis 4.0.1 / dsh-llm / dsh-tools |
| `engines` | node >=22；`"type": "module"` |
| 运行时内置 API | `node:sqlite`（Node 实验性 API，`docs/implementation-notes.md` §6 实测 SQLite 3.51.2 并记录会打 ExperimentalWarning） |

`integrations/dsh-host-glue/`（包名 `dsh-fasti-dsh-glue`）自身 peer 依赖仅 cordis ^4.0.1 与 dsh-llm 0.2.1-rc.5，通过 `dsh.bundle.patch: ./cordis.patch.yml` 注入宿主。

### 1.5 后台任务（全仓实测仅 3 处，`src` 内无 `setInterval`、无 `fs.watch`）

| 任务 | 文件 | 机制 |
|---|---|---|
| 事件闭合 worker | `src/adapters/dsh/llm.ts:132 startClosureWorker` | 一次性 `setTimeout` → 执行 → 再排下一轮；`intervalMs` 默认 **5000ms**；`ctx.effect` 卸载清定时器 |
| 记忆投影 worker | `src/adapters/dsh/llm.ts:183 startMemoryProjectionWorker` | 同上，独立于闭合 worker，默认 5000ms |
| 调用超时中止 | `src/core/deadline.ts:58-76` | `setTimeout` 触发 `controller.abort()` |

`llm.ts` 注释明确说明不用 `setInterval` 的原因："cordis 没有 `ctx.setInterval`，且固定间隔会堆积"。

### 1.6 真机数据落地（`~/.dsh/fasti`，只读盘点）

| 资产 | 实测状态 |
|---|---|
| `events/2026-11.jsonl` | 11 行（9605 字节），另有 manifest.json |
| `experiences/2026-11.jsonl` | 7 行（2727 字节），另有 manifest.json |
| `raw-turns/2026-11.jsonl` | 存在 |
| `projection/fasti.sqlite` | 存在，86016 字节 |
| `projection/memory-index/memory-index.sqlite` | 存在，106496 字节 |
| `projection/memory-index/revisions.jsonl` | 3 条：rev1 build(schema v1, cards=0)、rev2 rebuild(schema v2, cards=0)、rev3 rebuild(schema v2, **cards=2, aliases=0**)，均 operator=`offline-cli`，rev3 reason=`drain-projection` |
| `projection/memory-index/decisions.jsonl` | 2 条，action 全为 `create-card`；`model_tag` 字段实测值 **`rules-v1`** |
| `projection/memory-shadow/shadow-observations.jsonl` | 存在，2200 字节；样本行实测 `gatedStatus="no-match"`、`candidateCount=0`、`acceptedCount=0` |
| `state/checkpoint.json` | `tick=6`、`engine="L1"`、`degraded=false`、`last_projected_tick=6`、`pending_events=0` |
| `channels.json` | version 1，含通道 id `dsh` |

---

## 第 2 部分　功能完成度表

| # | 功能 | 状态 | 判断证据（如何验证） |
|---|---|---|---|
| 1 | L0 契约与冻结面 | 已跑通 | `tests/contract/` 6 个测试文件全绿，含 `frozen-surface.test.ts`；1231 全量中通过 |
| 2 | L1 真源（events/experiences/raw-turns 分片写入） | 已跑通 | `tests/source/` 5 个测试全绿；真机三目录均有 2026-11.jsonl 实际落地 |
| 3 | L3 投影（sqlite 三表 + 重建） | 已跑通 | `tests/projection/` 7 个测试全绿（含 parity 三档结果集一致）；真机 `fasti.sqlite` 86KB 存在，checkpoint `last_projected_tick=6` 与 `tick=6` 相等 |
| 4 | L2 事件层（切分/闭合/修正/回填） | 已跑通 | `tests/event/` 12 个测试全绿；真机 events 11 行 |
| 5 | 模型摘要闭合（慢路径） | 已跑通（依赖外部模型） | worker 与 port 有测试；真机 events 有 summary 落地（事件闭合走通）。真机模型可用性本次未复测 → 部分无法确认 |
| 6 | 记忆索引构建（离线 CLI） | 已跑通 | `revisions.jsonl` 3 条真实台账，rev3 cards=2；`build-memory-index.ts` 存在 |
| 7 | 运行期建卡（drain 主触发） | 已跑通 | rev3 reason=`drain-projection`、`created_by="her"`、`model_tag=rules-v1` 三项同时存在，证明 drain 链路真实写过库 |
| 8 | **cue 派生（#123 P1–P5）** | **半成品：代码在、生产不生效** | `src/memory/cue-derive.ts:26` `CUE_DERIVATION_RULES = new Set(['rules-v2'])`；`src/memory/types.ts:19` `CURRENT_RULES_VERSION = 'rules-v1'`；`builder.ts:449` 以 `isCueDerivationEnabled(CURRENT_RULES_VERSION)` 分支 → 必走 else。真机 decisions 的 `model_tag=rules-v1` 复证。**生产 cue 恒为空串** |
| 9 | 检索（BM25 + FTS + 布尔门） | **半成品：单测绿、真实召回为 0** | `tests/memory/bm25.test.ts`、`gate.test.ts`、`gate-smoke.test.ts` 全绿；但真机 shadow 观测实测 `candidateCount=0`、`gatedStatus=no-match`。两者并存说明单测覆盖的是构造样本，未覆盖生产空 cue 形态 |
| 10 | 漏召观测 `mem_miss` | 半成品 | 表与写入代码在（`miss.ts`），`tests/memory/miss*.test.ts` 6 个全绿；真机 `mem_miss` 实际行数**未验证**（未打开库，无法确认） |
| 11 | 影子观测写入 | 已跑通 | 真机 `shadow-observations.jsonl` 2200 字节有真实行，字段全部为设计规定的 7 个无正文字段 |
| 12 | 通道二（#115 miss 编排） | 已跑通 | `tests/assembly/miss-orchestration.test.ts` 全绿；`src/memory/drain.ts` 有 cueEnabled 分支 |
| 13 | 三态开关 memoryGateMode | 已跑通 | glue 侧有 `apply` 透传测试；checkpoint 实测 engine=L1 非降级 |
| 14 | 六工具桥 | 已跑通 | `tests/adapters/dsh/memory-tool-bridge.test.ts` 全绿 |
| 15 | 审计 harness（R1/R2/R3） | 半成品 | 10 个模块有实现、`tests/memory/probe-readiness.test.ts` 与 `synthetic-readiness.test.ts` 绿；但真机 `mem_audit_run` / `mem_audit_item` 是否有运行记录**未验证**（未开库）。文档口径本身不一致（见第 5 部分） |
| 16 | 资产/媒体层 | 残缺 | `ingestMedia` / `preserveMedia` / `getMedia` 三处 `throw NotImplementedError`（api/index.ts:550/556/1312） |
| 17 | 实体查询 | 残缺（设计上禁止） | `queryEntity` 抛 NotImplementedError（:1214）；架构文档 K2 明令禁止实体图投影 |
| 18 | 备份与恢复演练（#55） | 未做 | 任务台账 #55 状态 pending；仓内无恢复演练执行记录 |
| 19 | 真机验收 T17（#56） | 未做 | 任务台账 #56 状态 pending |
| 20 | 叙述回读（命中后回整段原文） | 残缺 | `projectCardForHost`（assembly/host-tool-runtime.ts:105）为纯映射、无库柄；`source-lookup.ts` 有 `resolveRawText` 端口但仅在装配层编排，未接到"命中后回叙述"的返回面 |

---

## 第 3 部分　报错与修补台账

统计口径分两栏：**A 栏 = 仓内文档明确记载的条目**（可逐条回查原文档）；**B 栏 = 本次会话内已记录、但仓内 docs 未落条的环境/平台问题**。两栏不合并计数。

### 3.1 A 栏（仓内文档记载，共 19 条）

来源：`docs/implementation-notes.md` §4（7 条"实质缺陷"）、§5（6 条 0.1.0 审计处理）、§6（4 条环境实测）；`docs/v1.4-rectification-receipt.md`（P0、P2 两条）。

| 类别 | 条数 | 逐条内容与落点 |
|---|---|---|
| **数据模型** | **5** | ①降级到 L2/L3 后投影为空（`api/index.ts initEngine` 启动即重建）②首个 tick 从 1 起跳（`maxTick()` 空目录返回 -1）③清单损坏抛裸 `SyntaxError`（统一 `CorruptedError`）④`recorded_at` 被无条件覆盖（改为显式提供则保留）⑤edge id 三处口径不统一（抽出 `projection/edge.ts` 单一实现，新增 5 条断言） |
| **接口对接** | **5** | ①`tick` 在写入路径被强制校验（允许缺省占位 0）②`FastiOptions.ulid` 死注入点、`this.ulid` 从未被读取（移除注入点）③`queryEdges` 名义查边实际返回源经历（改返 `EdgeView`）④`tick()` 返回"下一个将分配值"（改为"已分配最大值"）⑤慢路径候选 `at_pointer_id` 可能越出本事件（`normalizeCandidates` 第 6 条硬约束直接丢弃） |
| **环境与部署** | **4** | ①`node:sqlite` 为实验性 API、会打 ExperimentalWarning ②FTS5 trigram **需 ≥3 字符**，实测 2 字 MATCH 0 命中、`LIKE` 命中 ③Windows 上 `node --test <目录>` 失败，必须用 glob ④TS 5.9.3（`rewriteRelativeImportExtensions` 需 ≥5.7） |
| **状态管理** | **3** | ①任务闭环信号被直接激活、违反 dormant 显式状态（`params.ts taskClosureActive` 默认 false + `segmenter.ts` 门控；变异测试复现 21 段/14 task-closure）②8 个零调用导出死代码（已删）③全项目同步文件 I/O（本阶段保留，登记为阶段 3+ 复核项） |
| **业务逻辑冲突** | **2** | ①L2 漏"词内子串"查询（`brows` 在 `browser` 内查不到），L2 倒排改字符三元组（`tests/projection/parity.test.ts` 锁三档一致）②P0 的同一根因在文档与夹具口径间冲突（`make-fixture.py` 头注"任务闭环 dormant 不参与"，实现里无门控） |
| 平台锁定 | 0 | 仓内 docs 无此类登记 |
| 其他 | 0 | — |

> 计数说明：P0 一条同时命中"状态管理"与"业务逻辑冲突"两类性质，本表按落点归入状态管理，冲突面向另记入业务逻辑（第 ②）。上表合计 5+5+4+3+2 = 19 条。

### 3.2 B 栏（本次会话内记录、仓内未落条，共 5 条）

| 类别 | 条数 | 内容 |
|---|---|---|
| **平台锁定** | **4** | ①headless 启动报 `MISSING_CREDENTIAL`（bundle 意图性禁凭据）②隔离 profile 3081 新会话 GUI 点击全部失效 ③同上环境 API 逆向 401/404 ④换账号路由后仍无法新建会话 |
| **接口对接** | **1** | SCNet-Max 推理型模型 `max_tokens=64` 时 reasoning_tokens 吃光配额、`content` 返回空串（设 512/1024 才正常） |

### 3.3 出现最多的两类

- **A 栏口径**：**数据模型 5 条** 与 **接口对接 5 条** 并列最多，合计占 19 条中的 10 条（52.6%）。
- **A+B 合并视角**：数据模型 5、接口对接 6、平台锁定 4 —— 接口对接仍居首，数据模型次之；平台锁定虽仅 4 条但全部集中在同一宿主（DSH）凭据与 GUI 链路上。

---

## 第 4 部分　平台锁定评估

逐项判定"一天内能否迁到其他平台"，只陈述耦合事实，不评估改造工作量之外的方案。

| 资产 | 实测耦合情况 | 一天内可迁移性判断 |
|---|---|---|
| **数据本身**（JSONL 分片 + 3 个 sqlite 库） | 纯文件；事件/经历/原文为 JSONL，投影与记忆索引为 SQLite 标准文件 | **可迁**。格式无私有封装，直接拷贝目录即可在其他平台读取 |
| **核心代码**（contract / core / source / projection / event / memory / runtime / api，共 84 个 `.ts`） | 仅依赖 Node 内置模块 + `node:sqlite`；`dependencies: {}` | **可迁，但受运行时约束**：`node:sqlite` 是 Node 22 实验性 API，迁到非 Node 运行时（其它 JS 运行时或无该内置模块的环境）需替换 sqlite 访问层。这是唯一硬约束 |
| **数据根解析** | `src/source/paths.ts`：显式 dataRoot > `$DSH_HOME/fasti` > `~/.dsh/fasti` | 可迁。三级优先级中有两个与 DSH 目录约定绑定，但显式 `dataRoot` 可覆盖 |
| **环境变量** | 全仓实测仅 2 个：`DSH_HOME`、`FASTI_PROJECTION_ENGINE` | 可迁。数量极少，无配置中心依赖 |
| **宿主适配层**（`src/adapters/dsh/` 7 文件中的 4 个） | `host-model-route.ts` → `@deepseek-ai/dsh-llm`（BlockAssembler / ReasoningEffortId / createUserMessage）；`llm.ts` 与 `plugin.ts` → `@deepseek-ai/cordis` Context 与模块声明合并；`memory-tool-bridge.ts` → `@deepseek-ai/dsh-tools` 的 `defineTool` | **不可迁**。需重写适配层 |
| **装配层**（`src/assembly/` 4 个文件） | 注释明确"不 import `@deepseek-ai/*` 宿主包，离线 node:test 即可完整验证"；实测仅 `source-lookup.ts` 有纯常量，无宿主 import | **可迁**。属宿主无关内核 |
| **部署配置** | `integrations/dsh-host-glue/cordis.patch.yml`：`insert: id: fasti / name: dsh-fasti-dsh-glue / config: dataRoot: '/home/user/.dsh/fasti'` | **不可迁**：bundle patch 机制是 DSH 专有；且 `dataRoot` 为绝对路径硬编码 |
| **工具协议面** | 6 个工具全部经 `defineTool` 注册进 DSH 工具表 | **不可迁**。换平台需按对方工具协议重新注册 |
| **业务契约** | `docs/architecture-design-spec.md` §2.4 定"单进程插件、宿主心跳、单写者"；后台节拍靠宿主 `ctx.effect` + `setTimeout` 链 | 与宿主生命周期绑定；脱离宿主后需自建调度（而 K3 明令禁止常驻调度器/进程内 cron，重议条件为"C 块立项且外部 tick 被证不可行"） |

**综合事实**：数据库与数据文件、核心逻辑、装配层与 2 个环境变量在一天内具备迁移条件；宿主适配层、部署 patch、工具注册面、心跳节拍四处与 DSH 强耦合，迁移需重写而非移动。真机数据根现状为 2 张卡、0 别名、tick=6，体量极小。

---

## 第 5 部分　文档与实现差异

对照对象：`docs/architecture-design-spec.md`（1499 行，权威设计正本）、`docs/memory-v1-offline-scaffold-plan.md`（1224 行）、`docs/implementation-notes.md`。

### 5.1 文档写了但代码没有

| # | 文档声明 | 代码实况 | 判定 |
|---|---|---|---|
| 1 | 附录 B（:1211）"检索 top-k 默认 3 \| 常量 \| 审计 harness" | `src/memory/audit/gold.ts:50` 注释仅说"用注入 search 取 top-k"，未见值为 3 的常量；`runtime.ts` 的 `searchExplained` 反而"入参类型没有 limit 键"（§6.7 规定预截断在类型层不可表达） | **无法确认该常量存在**。两处口径方向相反 |
| 2 | 附录 B（:1204-1205）"孤立观察窗 7 天"、"话题线锚点窗 最近 10 个事件" | 未在 `src/event/params.ts` 导出常量中定位到对应字段的显式默认值 | **无法确认**（`DEFAULT_*` 对象字段未逐项核完） |
| 3 | §6.3（:593）"记忆索引入口目录三件：memory-index.sqlite / revisions.jsonl / decisions.jsonl" | 数据侧 `~/.dsh/fasti/projection/memory-index/` 三件**全部实存**；源码侧在 `src/memory/` | **非差异**。§6.3 描述的是数据布局，附录 C（:1221）描述的是源码目录 `src/memory/`，两处指向不同对象，不矛盾。此条列入仅为纠正常见误读 |

### 5.2 代码有但文档没写

| # | 代码实况 | 文档状况 | 判定 |
|---|---|---|---|
| 1 | `src/memory/audit/` 实有 **10** 个文件 | §6.9（:674-680）逐个点名 **7 件**（fixtures / gold / decoy / consistency / provenance / four-state / metrics）；`docs/memory-retrieval-words-external-review-brief.md:110` 又写"**九个**模块"。多出的 `readiness.ts`、`rates.ts`、`shadow-read.ts` 中，`shadow-read.ts` 在 §11.11（:1329）与 `task117-miss-retention-charter.md` 有登记，`rates.ts` 在 `task90-write-gate-final-spec.md` 有登记，**`readiness.ts` 在架构正本中无任何登记** | **三处口径互不一致（7 / 9 / 10）**，且 1 个模块完全缺登记 |
| 2 | `src/memory/drain-observations.ts`（观测写入 `drain-observations.jsonl`） | 在 §11.10（#117 落地登记）内有口径登记 | 已登记，非缺失 |
| 3 | `src/assembly/source-lookup.ts`（`SUMMARY_KEYS` 8 键、`RAW_TURN_KEYS` 5 键、`MAX_RAW_LOOKUP_CHARS=50000`） | 附录 C 只列 `memory-tools / host-tool-runtime / index` **三件**，未列 `source-lookup.ts`；§6.10 同样只说三件 | **代码多出 1 个装配模块未在附录 C 登记**（其功能在附录 E.4.1 有描述性记载，但模块清单未更新） |

### 5.3 两边说法不一致

| # | 文档说法 | 代码/实现说法 | 性质 |
|---|---|---|---|
| 1 | 附录 C（:1221）创记忆层"`audit/` 七件" | 实际 10 件；brief 文档称九件 | 数字不一致，见 5.2-1 |
| 2 | 附录 B（:1198-1213）"规定出处模块"一栏逐项写 `event/params.ts` | `src/event/params.ts` 中独立 `export const` 仅 3 个（`SUMMARY_PROMPT_VERSION='v2'`、`DEFAULT_CLOSURE_CALL_TIMEOUT_MS=60_000`、`DEFAULT_CLOSURE_ROUND_BUDGET_MS=120_000`）；其余 7000 / 50000 / 0.7 / dormant 等均为 `DEFAULT_*` **对象的字段**（params.ts:49-98） | 数值一致、**声明形式不一致**（"常量"vs"对象字段"）。属形式差异 |
| 3 | §6.9（:674）"`consistency.ts`（R3 一致性探针，未就绪前空置规则）" | `consistency.ts` 实现存在且在测试中被消费 | 措辞为"未就绪前空置"，与"已有实现"并存，语义边界模糊 |
| 4 | `docs/implementation-notes.md` §3 声明"**无实质偏离**" | 同文件 §3 表格自身列出 3 处"文档留白处的收敛性解释"（recorded_at 分配、投影行落点映射、投影损坏自动重建） | "无实质偏离"与"3 处解释"并列，判定为**措辞口径差异**，非事实冲突 |

### 5.4 本次审计的收口陈述

- 与"文档声称"相反、但经代码/真机双证的事实共 3 条：生产 cue 恒空（rules-v1 未进启用集合）、真机检索候选恒 0（shadow 观测实测）、4 个 API 方法为抛错桩。
- 因未打开 sqlite 而**无法确认**的项 3 条：`mem_miss` 实际留存行数、`mem_audit_run`/`mem_audit_item` 是否已有运行记录、`mem_card` 的 `display_cues_json` 实际值（仅从 `CHECK` 约束与 decisions 推断为 `[""]`，未开库读取）。
