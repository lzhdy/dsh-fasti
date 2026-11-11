# 聊天与记忆框架横向调研报告

- 报告版本：v1.0
- 调研与访问日期：2026-11-11（Asia/Shanghai）
- 调研性质：local-first 个人伴侣 AI 记忆层与 C 块（主动性、消息回复）实施方案的前置技术调研。只调研与写作，不写产品代码、不改动仓库既有文件、不执行 git 提交。
- 证据约定：所有源码结论来自对各仓库的本地浅克隆，逐文件 grep/Read 核实，并在文中标注具体 commit hash；源码链接尽量给出固定 commit 的 permalink。star、fork、版本、发版等易变数字一律标注"核实于 2026-11"，其中多数因 GitHub API 在本机共享 IP 限流，星标经仓库 HTML 页或第三方镜像页交叉核实，已在各卡片注明口径。
- 术语约定：与 `docs/memory-book-index-review.md`、`docs/a-block-final-design.md`、`docs/b-block-event-layer-design.md` 及 `src/` 现行契约保持一致。"真源"指 append-only 原文经历层；"二级真源"指写入即固化的事件层；"投影"指可从真源重建的一切派生记忆物；"冻结面"指 `src/contract/frozen-surface.ts` 承诺的五条冻结纪律。

---

## 1. 调研背景、入选门槛与对象名单

### 1.1 调研要回答的问题

本项目是 TypeScript + 单机本地 SQLite（`node:sqlite`、零生产依赖）的 local-first 个人伴侣系统，核心纪律是"真源 append-only 冻结、事件二级真源固化、其余皆为可重建投影"，且 C 块主动性与消息回复方案尚未动工。本次调研带着这套已定架构去深读业界主流项目的设计文档与真实源码，回答三类问题：

1. 记忆工程上，业界的分层存储、写入去重、检索融合、双时间失效、删除闭包、窗口装配、重建迁移、质量评测分别是怎么落地的，哪些与本项目同构、哪些是反面教材；
2. 主动性上，"她主动开口"在成熟系统里由什么触发模型、调度循环、防打扰机制支撑；
3. 回复管线上，从平台消息到发出回复的完整阶段如何切分，人格、关系、情感在架构上落在哪一层，哪些做法会污染真源。

### 1.2 入选硬门槛与最终名单

入选门槛：行业主流、有真实大规模采用（GitHub 高 star、被大量框架集成或有商业化落地）、许可证可查证、2026-11 仍在活跃维护；排除玩具项目、纯论文无工程落地、star 与活跃贡献者很少或已休眠的项目。经核实，最终深读九个对象，分三类：

| 类别 | 对象 | 一句话定位 |
|---|---|---|
| 记忆层/记忆服务 | Mem0 | 事实向量库路线知名度最高的开源记忆 SDK，Python/TS 双实现 |
| 记忆层/记忆服务 | Zep + Graphiti | 时序知识图谱引擎，双时间事实失效路线最完整的开源样板 |
| 记忆层/记忆服务 | Letta（前身 MemGPT） | 操作系统式记忆分页的开创者，2026 年已重构为 TS 的 MemFS 文件记忆 |
| 记忆层/记忆服务 | Cognee | 可插拔图+向量+关系三后端、MCP 生态的记忆/知识平台 |
| 框架内记忆子系统 | LangGraph + LangMem | 官方有状态编排框架的 Store/checkpointer 双持久化与官方记忆库 |
| 框架内记忆子系统 | LlamaIndex Memory | 短期 FIFO 队列 + 可组合 memory block 的显式分层 |
| 开源应用平台 | Dify | star 最高的开源 LLM 应用平台，工作流式回复编排代表 |
| 中文聊天框架 | AstrBot | 国内第一梯队多平台插件化聊天机器人框架 |
| 中文聊天框架 | MaiBot | 人格化陪伴框架，与本项目"伴侣/长期关系"气质最接近 |

另有两类补充材料，不做源码级深读：

- **OpenAI ChatGPT memory**：商业闭源产品、无源码，仅依据官方帮助中心与官方博客做产品形态对照，全文明确标注"无源码"；
- **高 star 但未深读项目**：Supermemory、Hindsight、Memary。排除理由见第 9 节（其中 Memary 已被第三方目录标注 Dormant、最后提交超过一年，触活跃度硬门槛）。

### 1.3 九个对象的入选客观依据（核实于 2026-11）

| 对象 | star（核实于 2026-11） | 许可证 | 调研时版本/commit | 活跃度与采用 |
|---|---|---|---|---|
| Mem0 | 68,772 | Apache-2.0 | Python 2.2.1 / TS 3.3.1，commit f1791da | YC S24，20 余向量后端适配，2026-04 V3 算法改版 |
| Graphiti | 约 31.3k（第三方镜像口径） | Apache-2.0 | commit e911422（2026-11-09） | Zep Cloud 开源底座；母仓 Zep CE 自 2025-04 弃用 |
| Letta | 老仓约 25.3k、新仓 letta-code 约 3.6–3.8k | Apache-2.0 | letta-code 0.34.51，commit c936963 | MemGPT 论文起源；2026-10 仓库重构，现行实现为 TS/Bun |
| LangGraph | 约 44.5k | MIT | Python 1.2 线，commit e5e37b5；JS commit 6dd190c | LangChain 官方编排框架，1.0 已发布 |
| LangMem | 约 1.7k | MIT | 0.0.30，commit 8620b98 | LangGraph 官方唯一指向的长期记忆参考实现，star 小但地位官方 |
| LlamaIndex | 52,868（框架级，记忆模块无独立 star） | MIT | llama-index-core 0.14.25，commit 5f95c79 | 主流 RAG/Agent 框架，记忆为内置子系统 |
| Dify | 160.9k | 修改版 Apache-2.0（禁多租户、禁去 LOGO） | v1.19.0（2026-11-04），commit 22ec8d4 | 开源 LLM 应用平台 star 第一梯队，工作流引擎拆为 graphon 子仓 |
| Cognee | 33.2k | Apache-2.0 | 1.6.7，commit 8853378 | 自带 cognee-mcp，双轨迁移体系，评测覆盖 BEAM/LoCoMo |
| AstrBot | 46.6k | AGPL-3.0-or-later | v4.29.4，commit 68acac9 | 插件市场宣称 1000+ 插件，18 个官方平台适配器 |
| MaiBot | 6,970 | GPL-3.0（内置 A_Memorix 为 AGPL-3.0 附 GPL 例外） | v1.4.3（2026-11-08），commit e539150 | 103 个 release，人格化陪伴垂直赛道代表 |

---

## 2. 横向对比总表（11 维）

表内为关键词级结论，完整证据见第 3 节各对象深读卡片。"不适用"表示该对象是纯被调用的记忆组件或库，经源码核实确无对应能力，不作硬凑。

| 对象 | 存储模型与纯本地门槛 | 写入/去重 | 检索 | 时序与事实失效 | 删除与隐私 | 工作记忆/窗口装配 | 可重建与迁移、评测 | 主动性机制 | 回复/人格/关系管线 |
|---|---|---|---|---|---|---|---|---|---|
| Mem0 | 向量集合+旁挂 SQLite history；默认 qdrant+OpenAI，全本地须换 faiss/qdrant embedded+本地模型，TS 版默认 better-sqlite3 | V3 八阶段纯 ADD 流水线，LLM 只抽取不决策；去重仅 md5 精确哈希，无语义阈值 | 语义过取 4 倍+BM25+实体 boost 加性融合，无 RRF；faiss 后端静默降级纯语义 | 仅 expiration_date 隐藏不删除；双时间/衰减是平台版，OSS 直接抛错 | 物理删向量但 history.db 留旧文，无墓碑；遥测默认开 | 无此层，上下文拼装全归调用方 | 无从原文重建索引工具、无迁移脚本；evaluation 目录为空，基准数字属托管平台 | 不适用：无调度器、无 hook，纯被动记忆库 | 不适用：chat() 仅一行转发，无人格/关系建模 |
| Zep/Graphiti | 节点+边属性向量+全文索引；Neo4j/FalkorDB/Neptune/Kuzu，唯一嵌入式 Kuzu 已弃用，默认外部 Neo4j | add_episode 串行写入，单条 5 次以上 LLM 往返；LLM 判重/判矛盾，Pydantic schema 强约束 | cosine/BM25/BFS 三路+标准 RRF+可选 cross_encoder | 最完整：valid_at/invalid_at+created_at+expired_at 双时间；LLM 挑矛盾、纯日期窗口函数置失效、旧边原地更新不删 | 裸 DETACH DELETE，删 episode 不级联派生边，无 tombstone | 无独立工作记忆层，最近 3 episode 作抽取上下文，token 预算归调用方 | 原文 EpisodicNode 为真源但重建非幂等（受 LLM 随机性与写入顺序影响）；无迁移框架；仓内接 LongMemEval | 不适用：无 cron/调度，强制串行被调服务 | 不适用：开源部分无对话/人格，Zep Cloud 能力闭源 |
| Letta | 现行 letta-code 为 git 跟踪的 markdown（MemFS）+JSON/JSONL，本地零服务仅需 Node+git；V1 归档版为 postgres+pgvector | V1 agent 调工具自改 block、block_history 留快照；现行用通用文件工具改 markdown 后 git commit，编辑下轮编译才生效 | V1 向量 archival+对话搜索；现行本地仅 transcript 关键词扫描，云端才有 hybrid/RRF | 无事实失效/双时间；版本历史 V1 靠 block_history、现行靠 git 提交链 | 现行本地删 agent 不清 MemFS 目录，存在残留 | V1 每轮 LLM 自主分页（额外往返）；现行滑动窗口 30% 阈值压缩+异步 recall subagent | 文件即存储，无 schema 迁移；无论文外可复现 benchmark | 进程内 cron：60 秒 tick+crons.json 租约+完整任务状态机；dreaming 反思默认由压缩事件触发、git worktree 隔离作业 | CLI 对话 loop 外包给厂商 coding-agent 运行时；persona.md 纯文本，无任何关系/情感建模 |
| LangGraph+LangMem | checkpointer（线程短期）与 Store（跨线程长期）两分；Python SqliteStore 依赖 sqlite-vec C 扩展，JS 侧无本地 SqliteStore（仅 Postgres/Redis/Mongo） | LangMem 工具默认 LLM 自由文本 put、uuid4 键、last-write-wins；三类记忆只存在于 prompt 文本 | Store 可选向量索引+JSON filter，无 BM25/trigram；pre-model hook 手动注入 | 无双时间、无 supersedes，INSERT OR REPLACE 覆盖不保留旧值；checkpointer 另有 parent 链版本历史 | store.delete 行级，SQLite 向量行 FK 级联但无 namespace 删除原语；checkpointer 与 Store 互不清 | 只给 messages reducer 原语，无 token 预算管理器 | checkpointer 为黑盒 BLOB 快照、序列化与类结构强耦合；Store 有正式迁移表；无记忆评测集 | OSS 无 cron：interrupt 是断点挂起需外部 Command(resume)，durable execution 解决崩溃续跑而非到点自驱，调度须外部触发 | react agent 状态机：agent/tools 条件边循环+preModelHook 注入挂点；人格即 system prompt 字符串，全仓无 emotion/relationship |
| LlamaIndex Memory | 新 Memory=SQLAlchemyChatStore（默认内存 SQLite，可换文件/PG）+Static/FactExtraction/Vector 三 block；Vector block 强制向量库+默认 OpenAI embedding | Fact block 每轮一次 LLM 抽事实，仅字符串全等去重，超 50 条 LLM 整表 condense 重写，无时间戳无锚点 | Vector block 纯向量 top_k，无 BM25；block 内容模板化注入 system 头 | 无时间字段、无失效，过时事实靠 condense 自由取舍 | areset() 只删会话消息，不清 facts 与向量库，删除闭包缺失 | 最成体系：token 预算 30000、历史占 70%，超限 10% 成批软归档并下沉 block，强制完整回合边界 | 消息表为真源但 block 内容不随 chat store 持久化、自定义 Memory 不可序列化；无官方记忆评测 | 不适用：库形态无调度器，agent.run() 被调才工作 | AgentWorkflow 状态机；persona 为裸 system_prompt；明确只抽 explicit fact、无情感/关系字段 |
| Dify | postgres+redis+sandbox+plugin_daemon 等 15+ 容器，生产零 SQLite，无单机本地模式 | "memory"只有 TokenBufferMemory（最近 500 条按 token 丢最旧）；会话变量是工作流 assigner 显式写的 KV，LLM 不直接抽事实 | 知识库 RAG 支持混合/RRF/rerank，但与用户记忆完全分离；记忆零检索直读 messages 表 | 变量无 TTL 无失效，错值驻留到会话被删 | 软删+Celery 异步级联 15+ 表+退避重试+兜底重扫，但无墓碑无审计、无用户数据导出 | LLM 节点 memory window 三件套（window size/role 前缀/query 模板），无摘要，注释自承平方级膨胀 | 248 个 Alembic 迁移；消息为真源但投影每轮实时物化、无独立物像层；无记忆评测 | trigger_schedule 走 DB claim_due 轮询跑批、webhook 纯被动，无面向终端用户的主动推送通道 | chatflow/workflow 节点化编排+SSE；persona 是应用级静态 pre_prompt；AgentSoulMemoryConfig 是空壳 schema 全仓零引用；无关系/情感 |
| Cognee | 图(ladybug/Kuzu/Neo4j 等)+向量(lancedb 等)+关系(sqlite)可插拔，默认三件套全嵌入式无服务进程，但 LLM/embedding 默认 OpenAI | cognify 双管道：无 LLM 索引+单次 LLM 批抽实体关系摘要；MD5 去重、冲突登记与结论退役、run/provenance 账本 | recall 有 21 种 SearchType，纯规则 5 条路由器兜底 HYBRID，CYPHER 禁自动路由；MCP 实测仅 5 个工具 | 有 Timestamp 节点与 TEMPORAL 重排，无双时间/supersedes，重抽即覆盖 | forget() 统一级联图/向量/关系/会话/历史，诚实披露 LanceDB 碎片不保证字节级擦除；支持 COGX 导出 | top_k/深度/chunk 预算参数化，keyless 模式只返回上下文不生成 | 双轨迁移：50 个 Alembic+8 步图/向量链，append-only slug、显式 stamp、幂等收敛；原始文件为真源可 memory_only 重建；有 BEAM/LoCoMo 评测 | 不适用：tasks 是数据处理管道，@agent_memory 是 pull-on-call 装饰器，无对话主动行为 | 不适用：MCP 仅工具暴露，无人格/对话管线，user preferences 子图属记忆层 |
| AstrBot | 单 SQLite 库 data_v4.db（SQLModel），可纯本地部署，LLM 推理走外部 API；知识库另用 faiss+BM25 | 对话历史整段 OpenAI 消息数组 JSON 列、每轮整行覆盖写（反面教材）；长期记忆非内核，靠 LivingMemory 等插件 | 历史整段装载后截断；知识库 faiss+BM25+rerank 融合；插件记忆走 LLM 工具化召回 | 内核无记忆失效/衰减，插件（LivingMemory）提供生命周期 | 删库行+回调级联，平台消息表与对话表不互级联；无墓碑 | 两段式上下文管理：先轮数硬截再 token 预算 LLM 压缩，摘要仅请求期注入不落库 | v3→v4 迁库脚本族；无任何评测 | 框架级一等能力：APScheduler 常驻 CronJobManager，active_agent 任务到期 wake_main_agent 把合成提醒轮投入主事件队列，复用同一 9 段管线；平台 capability flag+限流，但无独立免打扰时段 | 完整 9 段管线+20 余插件 hook+persona 表+工具循环+后处理分段发送；内核无情感字段（旧 mood_imitation 已废弃），关系/亲密度全在插件层 |
| MaiBot | 两套 SQLite：主库 SQLModel（schema v44）+A_Memorix 记忆库（约 50 表、schema v29），FAISS-SQ8+外部 OpenAI 兼容 embedding，依赖重 | 增量聊天摘要按消息数阈值触发、游标续跑、external_id 幂等、事实复核链；旧印象权重格式已冻结迁移 | FAISS 向量+图关系双路+BM25/FTS5 稀疏路+校准阈值；Planner LLM 自行决定何时 query_memory | 无数值情绪列；记忆生命周期 retention_strength/用进废退/归档 GC，原始消息流 append-only 不删 | 两段式删除：preview/execute/restore/purge+台账+向量异步清理回滚；会话可暂停不删史 | 内存 LRU 心流实例，重启按 60% 预算回灌并注入分档上下文恢复提示；超长压缩后裁下历史转后台学习 | 有序迁移+冻结 schema 快照；episode/向量均可重建、有一致性审计；212 个测试文件但无人格质量评测集 | 无 cron：LLM wait(秒/绝对时间) 超时自醒环+离线拟合 logit 回复概率门（1 小时窗口只收紧不放宽）+空闲指数退避；插件主动任务+桌宠周期思考（prompt 显式防机械） | 平台适配→落库→调度门→Planner 出"发言指导"→Replyer 二遍成文→表达选择→发送；人格是配置纯文本不入 DB；重写版已删除全部好感度/亲密度数值，关系靠自然语言画像 snapshot |

---

## 3. 九个对象的深读卡片

每张卡片给出：定位与版本事实、十一维要点、源码级硬证据（文件/类/机制，链接固定到 commit）、文档宣称与代码实际的落差。完整论证与更长引文见各分片工作稿，本报告只保留可据以决策的结论。

### 3.1 Mem0：纯 ADD 化的事实向量库，去重与失效能力被高估

**版本事实**：mem0ai/mem0，commit `f1791da`（2026-11 核实），Apache-2.0，68,772 star。Python 包 2.2.1、TS SDK 3.3.1。2026 年 4 月 V3 记忆算法上线是近年最大架构变化。

**架构要点**：OSS 版是单层"事实向量集合 + 实体集合 + 旁挂 SQLite（`~/.mem0/history.db` 的 history/messages 两表）"，没有热温冷分层。默认栈 qdrant + OpenAI LLM + OpenAI embedding；纯本地需同时替换三件套（ollama/lmstudio、fastembed、faiss 或 qdrant embedded），且 faiss 后端未实现 keyword_search，混合检索会静默降级为纯语义并只打 warning；唯一兼得"全本地+混合检索"的是 qdrant embedded。TS 版默认向量库就是 better-sqlite3 本地存储，但无 faiss 适配、默认模型仍是 OpenAI 系。

**写入与去重（重点核查项）**：V3 主链 `Memory._add_to_vector_store` 是八阶段流水线，系统提示词 `ADDITIVE_EXTRACTION_PROMPT` 原文写明 "Your sole operation is ADD"，LLM 只抽取事实 JSON、不再做 ADD/UPDATE/DELETE 决策；旧的决策 prompt（`DEFAULT_UPDATE_MEMORY_PROMPT`）仍在源码中但全包零引用，是遗产代码。去重只有一道 `md5(text)` 精确哈希；语义重复是否跳过完全外包给 LLM 在 prompt 里的自觉，代码无相似度阈值兜底；矛盾事实（"住北京"后"搬到上海"）会作为新记忆永久并存，没有任何字段表达取代或失效。实体链接用 spaCy 规则抽取、语义归并阈值 0.95，与记忆正文去重是两套独立机制。

**检索**：默认 top_k=20、threshold=0.1；语义先过取（内部上限 max(4×limit,60)），BM25 分按查询长度 sigmoid 归一，实体 boost 上限 0.5，三路加性融合，无 RRF，rerank 默认关闭。流行说法"近因 0.3x–1.5x 衰减"在 OSS scoring 代码中不存在；`timestamp/reference_date/decay` 等 Temporal Reasoning 接口在 OSS 直接抛"平台版专属"错误。

**删除**：向量库物理删除+实体集合摘链+history 写 is_deleted 记录，但旧文本留在 SQLite，无墓碑、无级联抹除；telemetry 默认开启。没有任何从原始消息重建向量索引的工具，embedding 模型升级也无迁移脚本。README 的 LoCoMo 92.5、LongMemEval 94.4、单次约 7k token 等数字同页自认属于托管平台专有优化，OSS 的 evaluation 目录为空。

**文档 vs 代码落差**："智能判断 ADD/UPDATE/DELETE 合并事实"描述的是已废弃的旧架构；"图记忆"在 V3 已删除约 4000 行外部图驱动代码，只剩实体内链；"混合检索"在 faiss/chroma 后端静默失效；"删除即遗忘"与 history 残留不符。

**关键证据**（均基于 commit f1791da）：

| 事实 | 证据位置 |
|---|---|
| 八阶段纯 ADD 流水线、md5 唯一去重 | `mem0/memory/main.py` `_add_to_vector_store` L881、L1022-1026 |
| LLM 只抽取不决策 | `mem0/configs/prompts.py` `ADDITIVE_EXTRACTION_PROMPT` L468；遗产决策 prompt L176 |
| 加性融合无 RRF、无衰减 | `mem0/utils/scoring.py` L62-90 |
| 平台版能力在 OSS 抛错 | `main.py` L817/L1446 |
| 删除后 history 留旧文、遥测默认开 | `main.py` `_delete_memory` L2116；`telemetry.py` L14 |
| TS 与 Python 八阶段同构、默认 better-sqlite3 | `mem0-ts/src/oss/src/memory/index.ts` L840-1272；`config/defaults.ts` |
| 图驱动整包删除 | `docs/changelog/sdk.mdx` L398 |

### 3.2 Zep/Graphiti：双时间失效的工业样板，也是重型路线的成本标本

**版本事实**：getzep/graphiti commit `e911422`（2026-11-09），Apache-2.0，约 31.3k star。母仓 getzep/zep（commit `65b5205`）已重构为示例与集成集合，Zep Community Edition 自 2025-04 官方弃用，商业 Zep Cloud 用闭源 Konig 引擎，二者不可混淆。

**存储模型**：四类节点（Episodic/Entity/Community/Saga）+ 五类边；向量是节点边的属性而非独立库，全文索引靠图后端原生 FULLTEXT（BM25）。图后端枚举 Neo4j/FalkorDB/Neptune/Kuzu：进程内嵌入式的 Kuzu 已在 README 标注弃用（上游停维护），新补丁 falkordblite 需 Python 3.12+，官方推荐且默认仍是外部 Neo4j 服务。

**写入侧**：`add_episode` 串行执行（官方 docstring 明确禁止并发连续写入，矛盾判定依赖最新图状态），一次写入要经历节点抽取、节点去重、边抽取、逐边 LLM 判重判矛盾、时间戳抽取、属性抽取、摘要等 5 次以上 LLM 往返。`_dedupe_extracted_edge` 先做端点对+文本归一化短路，否则调 small 模型，prompt `dedupe_edges.resolve_edge` 返回结构化的 duplicate_facts 与 contradicted_facts 两组索引。

**双时间与失效（本项目最关心的机制）**：`EntityEdge` 带四个时间字段——`valid_at/invalid_at`（事实在现实中的生命期）、`created_at`（系统得知的事务时间）、`expired_at`（被矛盾事实失效的系统时间）。失效链路是两段式：LLM 先语义挑出"被新事实证伪的旧边"候选，随后 `_apply_temporal_invalidation`/`resolve_edge_contradictions` 做纯日期窗口比较——旧边 valid_at 早于新边且时间窗不重叠，就原地写 `invalid_at=新边 valid_at`、`expired_at=utc_now()`，落库用同 uuid 的 MERGE SET，**旧边不删、不新建版本边**。历史态查询不默认收敛，需调用方自己用 SearchFilters 的日期比较算子构造 as-of 过滤。

**检索**：cosine/BM25/BFS 三类检索方法与 RRF/node_distance/mmr/cross_encoder 五类重排器枚举化；RRF 是标准 `1/(i+rank_const)` 实现，BM25 与向量对等并列而非主补关系。

**删除（差距最大处）**：节点删除是裸 `DETACH DELETE`；删一个 episode 只删它自己和 MENTIONS 边，由它派生的实体节点与事实边原样保留、边的 episodes 数组残留已删 uuid，无级联、无墓碑、无"已删除≠从未存在"语义。

**重建与评测**：原文 episode 是真源、图理论可重建，但重建不幂等——抽取与去重要把"当前已有图状态"喂给 LLM，换序重放结果可能不同。`migrations/` 为空，无版本化迁移框架，靠幂等 DDL 叠加。仓内测试接 LongMemEval（非 LoCoMo），LoCoMo harness 在 Zep 仓且只对接闭源 Cloud。

**关键证据**（commit e911422）：

| 事实 | 证据位置 |
|---|---|
| EntityEdge 双时间四字段 | `graphiti_core/edges.py` L263-290 |
| LLM 分流 duplicate/contradicted | `graphiti_core/prompts/dedupe_edges.py` L44-114 |
| 纯日期窗口失效判定、原地 SET | `utils/maintenance/edge_operations.py` L715-783；`models/edges/edge_db_queries.py` L84-122 |
| RRF 标准实现 | `search/search_utils.py` L1786 |
| as-of 需手写 DateFilter | `search/search_filters.py` L166-288 |
| Kuzu 嵌入式但已弃用、默认 Neo4j | `driver/kuzu_driver.py` L153；`README.md` L212-217；`graphiti.py` L335 |
| 裸删不级联 | `graphiti_core/nodes.py` L111-167 |
| 强制串行写入 | `graphiti.py` L1411 docstring |

### 3.3 Letta：仓库级重构勘误——MemGPT 三层已退休，现行是 TS+MemFS

**版本事实（首要勘误）**：`letta-ai/letta` main 分支（commit `8816d3a`，2026-10-18）已只剩落地页，README 指出现行源码在 `letta-ai/letta-code`（TypeScript/Bun，npm 包 `@letta-ai/letta-code` 0.34.51，commit `c9369635`）；老 Python V1 整体进 `archive` 分支，且仓库 AGENTS.md 明令 archive 代码不得用于生产、benchmark 及与其他系统对比。外界"core/archival/recall+postgres+pgvector+core_memory_append"的说法全部描述 retired V1。两仓均 Apache-2.0。

**V1（仅历史对照）**：core memory 是系统提示内的 Block（persona/human 标签、字符 limit 仅渲染进提示靠 LLM 自觉），archival 是带 embedding 的 passages 表+pgvector，recall 是对话历史；agent 每轮自主调 `core_memory_append/replace`、`archival_memory_insert/search` 等工具搬运记忆，每次编辑=一次额外 LLM 往返；block_history 表存快照支持 undo；默认 postgres，纯本地需 docker。

**现行 MemFS 架构**：记忆块物理投影为 git 跟踪的 markdown（`~/.letta/agents/<id>/memory/`，`<self>` 块即 persona.md），本地后端零 SQL/零向量、纯 JSON/JSONL 文件，云端才有 vector/fts/hybrid 对话搜索。专用记忆工具已被废除（名列 `removed-tools.ts`），写记忆=用通用文件工具改 markdown 再 git commit；pre-commit 钩子强制单文件不超过 20,000 字符、根块总量不超过 65,536 字符、目录深度不超过 2。关键语义：**记忆编辑当轮不生效，下次 prompt 编译才生效**，把写入与生效解耦。窗口溢出走滑动窗口压缩（默认阈值 30%），被截断消息由独立 LLM 出摘要。

**主动性（重点）**：`src/cron/scheduler.ts` 是进程内调度器，60 秒一个 tick，租约落 crons.json（丢租约即停），CronTask 带完整状态机（fire/missed/failed 计数、last_run_outcome、jitter），前提是常驻 listener 进程。三种跨时间机制：Monitor（事件反应）、Wake（对话内未来轮唤醒）、letta cron（独立新对话）；系统提示明文要求"成本敏感、默认最长间隔、状态检查一小时以上"。后台反思（dreaming，即论文 sleep-time compute）默认由压缩事件触发，以 memory subagent 在 MemFS 的 git worktree 隔离作业后合并，Windows 默认关闭。

**删除与人格**：本地 `deleteAgent` 删 agent JSON 与 conversations 但不清 MemFS git 目录，残留需人工处理。人格 = persona.md+human 模板+presets，纯文本；全系统无关系强度/情感状态/attachment 等结构化建模。

**关键证据**：

| 事实 | 证据位置 |
|---|---|
| main 只剩落地页、代码在 letta-code | letta 仓 README；commit 8816d3a |
| archive 禁止用于对比 | letta 仓 `AGENTS.md` Prohibited uses |
| MemFS 约束 20k/65,536/深度 2 | letta-code `src/memory-constraints.ts` L325-331 |
| 旧记忆工具已移除 | `src/tools/removed-tools.ts` |
| 编辑下轮编译生效 | `src/agent/prompts/letta_local_memfs.md` L44-46 |
| cron 60s tick+租约+状态机 | `src/cron/scheduler.ts`、`src/cron/cron-file.ts` L66-106 |
| dreaming 压缩事件触发+worktree 隔离 | `src/cli/helpers/memory-reminder.ts` L51；`reflection-launcher.ts` |
| 删 agent 残留 MemFS | `src/backend/local/local-store.ts` L482-514 |

### 3.4 LangGraph + LangMem：Store/checkpointer 边界清晰，但 TS 本地持久化是缺口

**版本事实**：langgraph Python commit `e5e37b5`、langgraphjs commit `6dd190c`、langmem commit `8620b98`，三仓均 MIT。LangGraph 约 44.5k star（Python 线 1.0 已发、现 1.2 线）；LangMem 仅约 1.7k star、版本 0.0.30 未到 1.0，但它是官方记忆文档唯一指向的参考实现。

**两套持久化的边界（最有参考价值处）**：checkpointer 存 thread 作用域的图 state（`checkpoints`+`writes` 两表，parent_checkpoint_id 串成版本历史，用于断点续跑与 time-travel）；BaseStore 存跨 thread 的长期记忆，按 namespace 元组（JS 为 string[]）分层，put/get/search/delete + 前缀检索。Python `SqliteStore` 用标准库 sqlite3 但向量能力强依赖 C 扩展 sqlite-vec；**JS/TS 侧根本没有 SqliteStore，持久化 Store 只有 Postgres/Redis/Mongo**，JS 的 checkpoint-sqlite 依赖 native better-sqlite3——两条本地路径都与本项目 node:sqlite 零依赖冲突，只能借 schema 不能借实现。

**LangMem 写入**：`create_manage_memory_tool` 默认 schema=str，LLM 自由写一段文本落 `{"content":...}`、键为随机 uuid4；后台 MemoryManager 做 insert/update/delete 抽取（默认禁 delete）。semantic/episodic/procedural 三分类只存在于 prompt 文本，代码无类型字段；条目只有 created_at/updated_at，无来源、无旧值快照、无审计字段。更新即同 key `INSERT OR REPLACE`，last-write-wins、不保留旧值。

**检索与注入**：向量索引是可选项，不传 index 时退化为按 updated_at 排序的 KV；无 BM25/trigram，filter 走 JSON 路径操作符在 SQL 层组合。记忆注入没有框架级自动 RAG，只是 pre-model 的一个 callable/`preModelHook` 节点，手动 search 后拼 `<memories>` 块进 system message。

**主动性边界**：`interrupt()` 是断点挂起（state 已落 checkpoint，等外部 `Command(resume=)`），是 human-in-the-loop 原语而非定时器；Python/JS core 全仓无 cron、无 scheduled run，官方文档明说定时要靠外部 cron 或应用逻辑，durable scheduled runs 是托管平台能力。durable execution 解决"崩了接着跑"，不解决"到点自己跑"。

**回复管线**：`create_react_agent` 就是 agent 节点与 tools 节点+`should_continue` 条件边的工具调用循环，prompt 支持 callable 作为人格与记忆的唯一装配挂点；LangMem 全仓 grep emotion/relationship/persona 零命中，人格即一段 system prompt 字符串。checkpoint BLOB 与序列化器强耦合、类结构变更后旧快照可能无法反序列化，且无对账机制，是黑盒快照路线的固有风险。

**关键证据**：

| 事实 | 证据位置 |
|---|---|
| namespace 元组与 Store 接口（Py） | `libs/checkpoint/langgraph/store/base/__init__.py` L708-1312 |
| JS 无 SqliteStore | langgraphjs 全仓 grep 无命中，持久化仅 checkpoint-postgres/redis/mongodb |
| SQLite Store 表+向量 FK 级联 | `libs/checkpoint-sqlite/langgraph/store/sqlite/base.py` L42-88 |
| checkpointer 两表与 parent 链（Py/JS schema 一致） | `checkpoint/sqlite/__init__.py` L147-168；JS `checkpoint-sqlite/src/index.ts` L186-208 |
| LangMem 自由文本工具、三分类仅在 prompt | langmem `knowledge/tools.py` L25-356；`knowledge/extraction.py` L185-206 |
| interrupt 断点非定时器、core 无 cron | `langgraph/types.py` L906；官方 memory.md L276 |
| 工具循环条件边与 hook 节点 | `prebuilt/chat_agent_executor.py` L831；JS `react_agent_executor.ts` L882 |

### 3.5 LlamaIndex Memory：waterfall 预算装配最干净，但事实层是失败示范

**版本事实**：run-llama/llama_index commit `5f95c79`，MIT，框架级 52,868 star，llama-index-core 0.14.25。记忆模块无独立 star。旧代 ChatMemoryBuffer/ChatSummaryMemoryBuffer/VectorMemory/SimpleComposableMemory 全部标注 Deprecated，但 AgentWorkflow 当前默认仍挂旧 ChatMemoryBuffer；新代 `Memory` 类需显式启用，文档"未来默认迁移"的说法尚未兑现。

**新架构**：`Memory` = SQLAlchemyChatStore 上 status=ACTIVE 的消息 FIFO 队列（默认内存 SQLite `:memory:`，可换文件 SQLite/Postgres）+ 可组合 memory blocks，预置三种：Static（静态文本、写入 no-op）、FactExtraction（LLM 抽事实字符串列表）、Vector（必填 vector_store、默认 OpenAI embedding 的语义块）。另有 llama-index-memory-mem0 等外部服务适配包。

**窗口装配（最值得借鉴处）**：整体 token_limit 默认 30000，短期历史占 70%；ACTIVE 消息超预算触发 waterfall：按总量 10%（token_flush_size=3000）成批把最旧消息置 ARCHIVED（行保留不物理删），并并发喂给所有长期 block 的 `aput()`；淘汰强制队列以 user 消息开头、不切断完整 user→assistant/tool 回合。block 按 priority 降序装配、升序裁剪，priority=0 保底永不裁；内容用 `<memory><块名>` 模板段前插到 system 或最新 user 消息。这是"先 FIFO 攒着、达阈值再成批下沉"的工业实现，与本项目"先观测后定阈值"同向。

**事实层（反面教材）**：FactExtraction 每轮一次 LLM 调用、正则解析 `<fact>` 标签；去重仅字符串完全相等，无语义去重、无时间戳、无来源锚点；超 max_facts=50 触发第二次 LLM 做 condense，prompt 明示返回列表将完全替换现表——这正是"算法批量重算记忆"的典型，历史事实不可追溯，仅靠"空响应不覆盖"防御静默清空。矛盾事实静默并存直到被 condense 合并。

**删除缺口**：`Memory.areset()` 只对 chat store 删消息，不清内存 facts、也不删 Vector block 背后的向量库，记忆级被遗忘权不成立。无任何官方记忆质量评测，tests 只验证 prompt 解析与 waterfall 触发等单元行为。库形态无调度器、无主动性、无人格/关系字段，FactExtraction prompt 自己要求"不要 opinion/summary，只要 explicit fact"。

**关键证据**（commit 5f95c79）：

| 事实 | 证据位置 |
|---|---|
| 默认内存 SQLite、表结构极简 | `core/storage/chat_store/sql.py` L31、L150-165 |
| 预算 30000/70%/10% waterfall | `core/memory/memory.py` L49-50、L696-797 |
| 全等去重+超限整表 condense | `core/memory/memory_blocks/fact.py` L145-166 |
| Vector block 强制向量库、默认 OpenAI | `memory_blocks/vector.py` L40-53 |
| reset 不清 blocks | `memory/memory.py` L843-845 |
| AgentWorkflow 默认仍用 deprecated buffer | `agent/workflow/base_agent.py` L296-301 |

### 3.6 Dify："长期记忆"名实不符的最主流应用平台

**版本事实**：langgenius/dify commit `22ec8d45`（2026-11-11），160.9k star，修改版 Apache-2.0（禁多租户商用、前端禁去 LOGO），最新发版 v1.19.0。通用工作流引擎已拆到子仓 graphon（commit `716d539`，主仓 pyproject 钉版引用），评估其能力必须两仓同读。

**部署成本**：docker compose 一次拉起 15+ 容器（api、worker、worker_beat、postgres、redis、sandbox、plugin_daemon、knowledge_fs 系列等）；生产代码零 SQLite（仅测试用），最小自托管也至少四个常驻外部服务，与单机零依赖路线不可调和。

**长期记忆的真实深度（防宣传带偏的核心结论）**：`api/core/memory/` 下只有一个 `token_buffer_memory.py`——从 messages 表倒序取最多 500 条、还原线程链、按默认 2000 token 从最旧逐条丢弃，无摘要、无事实抽取、无去重更新失效。会话变量是 2024-08 引入的 `workflow_conversation_variables` 表：会话级 KV 状态槽，只有 created_at/updated_at、无 TTL 无版本，必须由画布上的 variable_assigner 节点显式 OVER_WRITE/APPEND/SET，LLM 节点输出不会自动变记忆；引擎经 `NodeRunVariableUpdatedEvent` 与独立 persist layer 解耦落库。2026 新 Agent beta 的 `AgentSoulMemoryConfig` 在 schema 里预留了 scope/budget/artifacts，但全仓零引用、运行时无 memory 层实现，是宣传先行的空壳。知识库 dataset 是租户文档 RAG，与用户记忆两条数据链。结论：**截至调研时 Dify 不存在跨会话长期用户记忆产品**，错值会随会话存活到人工删除。

**删除**：会话删除走"软删标记→Celery 异步物理清理→指数退避重试→sweep 兜底重扫"，级联 15+ 张表（会话变量在级联清单内），是成熟的删除闭包工程范式；但无归档、无墓碑、无删除审计台账，也无面向终端用户的会话内容导出 API。

**主动性**：trigger_schedule 节点把 visual/cron 表达式编译后落 DB 任务行，worker_beat 周期 `claim_due` 领取执行——是服务器侧轮询跑批，不是实时定时器；工作流被触发后没有向终端用户外发消息的通道（无请求即无 SSE/WS 会话），webhook 纯被动。

**回复管线**：advanced-chat 从输入审核→加载会话变量→图节点（分类/知识检索/带 memory window 的 LLM/if-else/code/assigner/answer）→SSE 流式，节点化装配清晰；LLM 节点 memory window 三件套（window size、role 前缀、query 模板）可配置。人格是 AppModelConfig 里的静态 pre_prompt 列，无关系/情感建模。代码注释自承 Message.message 存全量历史提示词导致上下文平方级膨胀，是无摘要 buffer 路线的已知失败模式；248 个 Alembic 迁移文件反向印证 schema 不冻结的长期维护代价。

**关键证据**（commit 22ec8d45）：

| 事实 | 证据位置 |
|---|---|
| TokenBufferMemory 500 条/2000 token 截断 | `api/core/memory/token_buffer_memory.py` L142-258 |
| 会话变量表无 TTL 无版本 | `api/models/workflow.py` L1537-1578；迁移 2024_08_13_0633 |
| 事件化变量持久化 layer | `api/core/app/layers/conversation_variable_persist_layer.py` |
| AgentSoulMemoryConfig 空壳零引用 | `api/models/agent_config_entities.py` L815-818 |
| 删除级联 15+ 表+软删重试 | `api/tasks/delete_conversation_task.py` L72-99 |
| 定时=DB claim_due 轮询、无用户推送 | `services/trigger/schedule_store.py`；`nodes/trigger_schedule/entities.py` |
| 生产零 SQLite、15+ 容器 | grep 核实；`docker/docker-compose.yaml` |
| memory window 三件套 | graphon `prompt_entities.py` L23-40 |

### 3.7 Cognee：可插拔后端与双轨迁移的工程化标杆，MCP 工具数被以讹传讹

**版本事实**：topoteretes/cognee commit `8853378`（v1.6.7，2026-11-06），33.2k star，Apache-2.0，约 3000 个 Python 文件、1100+ 测试文件。

**存储模型**：图/向量/关系三类后端接口分离、按环境变量切换。默认三件套全部嵌入式无服务进程：图=ladybug（Kuzu 的改名重发行）、向量=lancedb、关系=sqlite；另可切换 Neo4j、pgvector、Postgres、Neptune、Turso 等。但 LLM 与 embedding 默认 provider 都是 OpenAI，首次 cognify 需 key 或自行切 ollama/fastembed；v1.6.0 起提供 keyless 降级（只返回拼装上下文不生成答案、improve 的 LLM 阶段跳过），不是开箱即用的全本地。

**写入管道**：`remember()` 分永久（add+cognify）与会话两模式；cognify 拆两条 DAG——无 LLM 的 indexing（分块、chunk 入库入向量，先保证可检索）与单次 LLM 批处理的 cognify（按约 100 chunk 一批，一次调用同时出实体关系三元组与摘要）。去重靠载荷 MD5；有独立 conflicts 模块登记冲突、在删除/编辑后退役旧结论；每个 run 落 pipeline_runs/operations 账本与 edge evidence provenance，崩溃后按文档级 stamp 恢复、不重抽已完成文档。

**检索与 MCP 勘误**：recall 有 21 个有效 SearchType；query_router 是纯规则五条有序路由（引号→词法、how many→BROAD、绝对日期→TEMPORAL 等）兜底 HYBRID，CYPHER 因只读安全检查被故意排除自动路由。**MCP server 实测只有 5 个工具**（remember/recall/forget/code_search/cognify_status，有测试断言锁数），improve 是内部 helper 不暴露；二手文章"14 工具/14 模式"是把 21 个检索模式误当工具数。

**时序与删除**：无真正双时间/supersedes，只有 Timestamp 节点与 TEMPORAL 候选重排，图实体重抽即覆盖。删除统一为 `forget()`，级联关系/图/向量/会话/历史，支持 memory_only（只删派生数据保留原文以便重新 cognify，直接印证其真源/投影分离）与 COGX 导出；但文档诚实披露 LanceDB 删除行留在 append-only 碎片等 compaction，不保证字节级擦除。

**迁移（亮点）**：双轨制——关系库 50 个 Alembic 脚本，图/向量数据另走 8 步迁移链；每个 dataset 记 append-only 不可变的 migration slug，启动逐库走链、每步盖章、幂等重跑收敛，`stamp` 提供数据漂移逃生门，cognee_version 列只审计不阻断。本体（prompt 配置）不随 schema 迁移、换本体即全量重抽。评测有 BEAM（100K 0.79）与 LoCoMo（约 91%）的仓内报告。无对话主动性、无人格管线，tasks 是数据管道而非调度器。

**关键证据**（commit 8853378）：

| 事实 | 证据位置 |
|---|---|
| 默认 ladybug/lancedb/sqlite 全嵌入 | `infrastructure/databases/graph/config.py` L47；`vector/config.py` L32；`relational/config.py` L22 |
| remember 双模式、improve 防抖桥接 | `api/v1/remember/remember.py` L1014 |
| 21 SearchType、5 条规则路由 | `modules/search/types/SearchType.py` L6-25；`api/v1/recall/query_router.py` L201-244 |
| MCP 恰 5 工具的测试断言 | `cognee-mcp/tests/test_mcp_server_hardening.py` L104-121 |
| forget 级联与字节擦除局限披露 | `api/v1/forget/forget.py` L23-100 |
| 双轨迁移与 append-only slug | `modules/migrations/README.md`；`cognee/alembic/versions/`（50 个） |
| 无 LLM indexing/单 LLM cognify | `api/v1/cognify/cognify.py` L700-813 |

### 3.8 AstrBot：插件化消息管线与框架级主动能力的成熟范本

**版本事实**：AstrBotDevs/AstrBot commit `68acac91`（2026-11-10），46.6k star，AGPL-3.0-or-later（另有 EULA，商用需注意传染性），v4.29.4，官方 18 个平台适配器、插件市场 1000+ 插件。可 uv/docker/桌面端纯本地部署，数据全在 `data/`，主库单文件 `data/data_v4.db`。

**存储与历史（反面教材并存）**：SQLModel 表群含 conversations、platform_message_history、personas、cron_jobs、preferences 等。会话（UMO 平台标识）与对话两层，一个对话一行，整段 OpenAI 消息数组以 JSON 列存 conversations.content，每轮"读整段 JSON→append→整行 UPDATE 覆盖写"，没有消息级 append-only。长期记忆不是内核能力：代表性实现全在插件生态（LivingMemory 靠 bge-m3 做语义召回与新鲜度衰减、Engram 是外部托管服务、Sylanne 做情绪与人格漂移），引用时必须标注"插件非内核"。知识库是独立子系统，faiss+rank-bm25+rerank+rank_fusion。

**上下文装配**：`ContextManager.process` 两阶段——先按轮数硬截（0.82 阈值丢最旧轮并修复 tool 配对），再按 token 预算决定是否调 LLMSummaryCompressor（保留最近 15% 精确上下文）；压缩摘要只在请求期注入、不落库，每步 LLM 调用前执行（日志 [BefCompact]/[AftCompact]）。personas 表存 system_prompt 与 begin_dialogs（后者标记 _no_save 不入库），人格 prompt 不占独立预算保护。

**主动性（C 块重点参考）**：框架把主动发起做成一等能力，四层结构。CronJobManager 封装 APScheduler，任务两型：basic 型内存回调不持久化，active_agent 型落 cron_jobs 表，到期构造 `<system_reminder>` 形式的合成 user prompt 调 `wake_main_agent`；wake 并不直接发消息，而是投一个 AgentWakeupEvent 进主事件队列——**主动消息走与用户消息完全相同的 9 段管线**（唤醒词/白名单/会话状态/限流/内容安全/预处理/处理/装饰/响应），这是它最重要的设计决策：主动=带来源标记的合成输入轮，不是旁路。内建 FutureTaskTool（LLM 自建定时）与 SendMessageToUserTool；平台用 `support_proactive_message` capability flag 声明（但默认 True，框架不校验平台真实政策）。防打扰复用用户消息限流器，没有独立免打扰时段。

**回复管线**：EventBus 异步队列按 UMO 路由，9 段 stage 顺序固定；插件 hook 总线暴露 20 余个装饰点（on_llm_request/response、agent_begin/done、decorating_result、after_message_sent 等），插件与内核同进程无 OS 沙箱；ProcessStage 内插件可返回 ProviderRequest 转交 LLM，默认走 tool_loop_agent_runner 的工具循环；回复后处理含 t2i、TTS、markdown 转平台格式、分段发送与流式增量。内核无情感情感字段：旧 mood_imitation_dialogs 已在 v4.0 废弃并强制置空，关系/亲密度全部是插件层的事。v3→v4 有完整迁库脚本族，无任何官方评测。

**关键证据**（commit 68acac91）：

| 事实 | 证据位置 |
|---|---|
| 整段 JSON 覆盖写历史 | `core/conversation_mgr.py` L357-390；`astr_agent_runtime/session.py` L139-150 |
| 9 段管线顺序 | `core/pipeline/stage_order.py` L3-13 |
| 两阶段上下文压缩、摘要不落库 | `core/agent/context/manager.py` L46-82；`compressor.py` L206-313 |
| 主动唤醒复用主管线 | `core/agent_wakeup.py` L10-54；`platform/agent_wakeup_event.py` L23 |
| CronJobManager 与 active_agent 合成 prompt | `core/cron/manager.py` L107-185、L442-486 |
| 平台主动能力声明与主动工具 | `core/platform/platform_metadata.py` L22；`main_agent/builder.py` L172-180 |
| 插件 hook 全集 | `core/star/register/star_handler.py` L76-771 |
| 情绪字段废弃 | `core/db/po.py` L618-633；`persona_mgr.py` L453 |

### 3.9 MaiBot：最贴近伴侣气质的对象，且现行版已自我否定数值好感路线

**版本事实（含谱系勘误）**：MaiM-with-u/MaiBot commit `e539150`（2026-11-08，v1.4.3），6,970 star，GPL-3.0；内置记忆子系统 A_Memorix（AGPL-3.0 附对 MaiBot 的 GPL 例外）。仓库 2025-02 创建，1.0.0 是 rc 测试期，稳定线已到 1.4.3；老经典版与当前版是同一愿景下的整体重写关系。

**存储模型**：两套 SQLite。主库 SQLModel（schema 已演进到 v44，并有 frozen_v2_schema 冻结快照防迁移脚本依赖漂移）：`mai_messages` 消息流水（msgpack 原文+纯文本+接收时间+当时回复频率快照，append-only）、chat_sessions、person_info（认识记录，旧 memory_points 权重字符串已冻结）、expressions/jargons（学来的句式黑话，带用进废退计数）等。A_Memorix 记忆库 schema v29、约 50 表：paragraphs、entities、relations（sp-o 三元组+confidence+完整生命周期列）、episodes、版本化 person_profile_snapshots、fact_claims/evidence/transitions、paragraph_ngrams、delete_operations 台账；向量为 FAISS SQ8 量化磁盘 mmap，embedding 走外部 OpenAI 兼容 API，依赖体积与零依赖路线相反。

**情绪/关系的关键事实**：全 src grep 不到 mood/affinity/intimacy/relationship_value 任何数值列——老经典版的数值好感模型在重写中被整体删除且无迁移保留。当前"关系"完全由自然语言承载：记忆层人物事实+版本化画像 snapshot（profile_text+evidence 指针+过期时间+手动 override），语气由 LLM 读自然语言现场推断，没有任何数值进入生成。仅剩的"状态数值"是三类调度/排序参数：回复频率（用户可配、快照在消息上）、记忆 retention_strength/access_count（检索遗忘权重）、已冻结的旧印象权重。

**写入与检索**：聊天摘要按消息数阈值增量触发、游标持久化防重、两轮复核，prompt 明确排除玩笑猜测传闻与提示注入、"机器人自述不能单独证明用户事实"、相对时间换算绝对日期、无增量返回空结构；external_id 幂等键、事实去重与复核/重验服务齐备。双路召回（FAISS 向量+图关系 pagerank/posterior）加 BM25/FTS5 稀疏路与校准阈值，何时检索由 Planner LLM 按语言信号决定；"当前印象"查询先让 LLM 写一段自然语言印象再做语义召回。

**主动性（重点，无 cron 的另一条路线）**：核心是 LLM 自主 wait 环——Planner 工具 `wait(seconds 或 until 绝对时间)`，运行时 asyncio 定时任务到时向内部队列投 timeout 唤醒重新决策，新消息可提前唤醒，reply 后还能选择 stop/continue/wait，连续 wait 有计数防空转。放行门是离线拟合的 logit 回复概率公式（被提及、问号、近期自己发言占比、距上次发言秒数等系数），叠加 1 小时滑动窗口的动态频率门（反馈调节只收紧不放宽，注释解释放宽会系统性话多）与空闲指数退避；全局/会话可暂停、平台白名单硬门槛。插件可经 `maisaka.proactive.trigger` 能力投主动轮（构造伪触发消息、不写消息库）；桌宠侧有唯一的周期性自主思考，prompt 显式写"不是主人发来的消息、不必每次都发消息、避免重复问候/机械报时/催促/自我循环、不把内部提示伪装成指令"。主动发言前强制回填最近真实用户消息作为可回复目标，防止对空气说话。全仓 grep 不到 apscheduler/crontab。

**回复管线（两阶段生成）**：平台适配→消息落库→调度收批/防抖/放行门→Planner（agent 循环，输出的是"发言指导"：回应什么、依据哪些事实、想要什么情绪画面，不直接写成文）→Replyer 第二遍 LLM 口语化成文→表达选择（学来的句式与表情包标签）→发送并回写历史。人格是配置文件 personality/behavior_style 两个纯文本字段，不入数据库、无版本化，一致性靠每轮系统提示重复与"聊天历史不能覆盖规则"的首条约束。重启后从消息流按 60% 预算回灌，并注入分档"上下文恢复"提示明确"不代表用户刚发消息"。删除是带台账的两段式（preview/execute/restore/purge）+向量异步清理与回滚钩子；212 个测试文件但无人格质量评测集。

**关键证据**（commit e539150）：

| 事实 | 证据位置 |
|---|---|
| wait 超时自醒环 | `src/maisaka/runtime.py` L1730-1784；`prompts/zh-CN/maisaka_chat.prompt` L19-21 |
| 拟合 logit 概率门与只收紧不放宽 | `turn_trigger/reply_likelihood.py` L22-31；`turn_trigger/dynamic_gate.py` L126-193 |
| 空闲指数退避 | `turn_trigger/idle_backoff.py` L31-44 |
| 全仓无情绪数值列 | 全 src grep mood/affinity/intimacy 零命中 |
| 记忆生命周期/用进废退 | `A_memorix/.../metadata_schema.py` relations；`memory_maintenance_service.py` L329-379 |
| FAISS+外部 embedding | `A_memorix/.../core/storage/vector_store.py`；`embedding/api_adapter.py` |
| 删除台账+向量回滚 | `A_memorix/.../delete_admin_service.py` L136-231 |
| 两阶段生成与人格纯文本 | `src/agent/planner.py`；`chat/replyer/maisaka_generator.py`；`chat_loop_service.py` L849-855 |
| 重启上下文回灌分档提示 | `src/maisaka/runtime.py` L439-509 |
| 桌宠防机械自主思考 prompt | `prompts/zh-CN/desktop_pet_proactive_wake.prompt` |

## 4. 五个关键机制的特别核查（代码证据汇总）

本章对任务点名的五个机制做跨对象复核，每条结论只认真实代码、不采信宣传口径。

### 4.1 Graphiti/Zep 的双时序与事实失效：成立，但 LLM 只负责候选、代码负责落库

- 字段层成立：`EntityEdge` 的 valid_at/invalid_at（现实生命期）与 created_at/expired_at（系统得知/失效时刻）双时间齐备，与本项目 `edge` 表 valid_ms/invalid_ms/created_ms/expired_ms 四字段语义同构。
- 机制层是两段式：LLM prompt（dedupe_edges.resolve_edge）只返回 contradicted_facts 的索引，真正写失效是 `_apply_temporal_invalidation` 的无 LLM 纯日期窗口函数；旧边同 uuid MERGE SET 时间戳、不物理删。这恰好演示了"LLM 出语义建议、确定性代码做可复算动作"的分界。
- 边界要清醒：as-of 历史态需调用方手写 DateFilter，框架不默认收敛；重建非幂等（LLM 判重依赖当前图快照）；官方靠大量否定式 prompt 约束抑制"把进展误判为矛盾"的假阳性，说明 LLM 候选这一步本身并不可靠，只能当建议不能当裁决。
- Zep Cloud 的 Context Lake/Konig 为闭源，无源码可对照，任何"Zep 能做到"的云端能力不能记到开源 Graphiti 账上。

### 4.2 Letta 的记忆分页、memory tools 与 block：V1 机制已退休，现行是文件+git+延迟生效

- MemGPT 论文式"LLM 每轮自主调 core_memory_append/replace 分页"只存在于 archive 分支的 V1，且官方 AGENTS.md 禁止拿 archive 做横向对比；现行 letta-code 已删除专用记忆工具，改为通用文件工具编辑 markdown 后 git commit。
- block 机制仍在但形态改变：系统提示中的可编辑记忆块受 pre-commit 硬约束（单文件 2 万字符、根块 6.5 万字符、深度 2），且编辑当轮不生效、下次编译生效——"写入与生效解耦"是现行版最重要的语义。
- 成本结论需要更新：V1"每轮一次额外工具往返"的分页成本在现行版被刻意改为"压缩事件触发+异步 recall/dreaming subagent"，同步成本转移为异步成本；这一变化本身印证每轮自主分页在工程上被作者自己判定为不经济。

### 4.3 Mem0 的 ADD/UPDATE/DELETE、图向量取舍与去重真实质量：宣传与代码落差最大的一项

- ADD/UPDATE/DELETE：V3 OSS 已是纯 ADD 架构，LLM 不做决策；UPDATE 仅剩人工 API 原地覆盖 payload，决策 prompt 是零引用遗产。
- 图+向量取舍：外部图数据库驱动约 4000 行已在 V3 删除，OSS 只剩 spaCy 规则实体倒链（0.95 归并阈值、检索 0.5 boost），默认向量库 qdrant、TS 默认 better-sqlite3；"图记忆"宣传词与代码现状不符。
- 去重质量：字面重复靠 md5 可靠拦截；语义重复与矛盾事实没有任何代码阈值兜底，完全依赖 LLM 单次 prompt 自觉，矛盾事实永久并存、无失效字段。结论：其去重质量上限就是当次 prompt 下的 LLM 判断力，不存在确定性保证；本项目"先离线观测再定阈值"的纪律正是针对这一缺口。
- 附加反证：OSS 无索引重建工具、删除后 history.db 残留、遥测默认开启、平台版 benchmark 数字不可在 OSS 复现。

### 4.4 LangGraph Store 的 namespace 与 checkpointer 边界：清晰，且可直接映射本项目两类数据

- 边界在代码与文档两侧都干净：Store 跨 thread 存长期记忆（namespace 元组前缀检索），checkpointer 存 thread 内 state 快照（parent 链版本历史、断点续跑），删 thread 不动 Store。
- 对本项目的映射几乎逐字对应：可重建投影（experience/event/edge 派生索引）对应 Store 类长期层，运行时唤醒挂起状态对应 checkpointer 类短期层；但 LangGraph checkpoint 是序列化黑盒 BLOB、无对账，本项目应坚持检查点也能从真源重算的白盒路线。
- TS 栈警示：langgraphjs 没有本地 SqliteStore，checkpoint-sqlite 依赖 native better-sqlite3，与 node:sqlite 零依赖不兼容，只可借鉴 schema 与边界、不可引实现。

### 4.5 Dify 长期记忆到底做到什么程度：只有会话窗口+会话变量，没有长期用户记忆

- 代码定论：唯一 memory 模块是 500 条/2000 token 的 TokenBufferMemory，无摘要无抽取；会话变量是开发者画布显式写入的会话级 KV，无 TTL、随会话级联删除、不跨会话积累；新 Agent 的 memory 配置是空壳 schema 零引用。
- 知识库是租户文档 RAG，与"AI 伴侣了解用户"无关，两条链不得混为一谈。
- 因此业界常说的"Dify 支持长期记忆"在 2026-11 的代码里不成立；它真正成熟的是工作流节点化装配、事件化持久化 layer 与软删异步级联工程，这些可以借，记忆能力本身不可借。

---

## 5. 对本项目全部已定架构的逐条映射

本章不只围绕记忆本 D1–D5，而是逐条对上 A 块真源冻结契约、B 块事件二级真源、投影层表结构与检索原语、运行时与契约枚举。每条判断标注外部设计能落到哪一层、是否破坏冻结面或二级真源。

### 5.1 映射 A 块：真源与冻结契约（frozen-surface 五条 + 删除例外）

**外部世界的总体反证**：九个对象中没有一个的原始数据层严格满足本项目冻结面。AstrBot 的对话历史是 JSON 列整行覆盖写；Dify 的 Message 存全量提示词且靠软删规避；LangMem/LlamaIndex 的记忆条目允许 LLM 原地 put 覆盖或整表 condense；Mem0 人工 update 原地改 payload；Graphiti/Cognee 让 LLM 抽取结果与可变图状态同库、重抽即覆盖。这反向证明本项目把 append-only 真源与可变投影物理分层是更严格而非更古怪的选择。

可直接借鉴：

1. **真源/投影分离的工程表达**——Cognee 的 memory_only 删除后可从原始 Data 重新 cognify、MaiBot 消息流水 append-only 而衰减只发生在记忆库、Mem0 的 messages 表与向量集合分库，都是"原文不可变、派生可重建"的同类实践，可印证 `experience` 真源表与 `experience_fts/edge/event` 投影表的切分；落点：投影层目录结构与重建脚本边界。
2. **来源锚点的序号化防幻觉**——Mem0 V3 在抽取前把候选旧记忆映射成"序号→UUID"反查表喂 LLM，防止模型编造 ID。本项目 D1 的 source_anchor 选择索引在任何 LLM 参与环节（摘要、未来选择权重生成）都应采用同样的候选序号化协议；落点：事件摘要管线与未来记忆选择索引的 LLM 接口。
3. **相对时间锚定**——Mem0 与 MaiBot 的抽取 prompt 都强制把"昨天/下周"按观察日换算成绝对日期。本项目事件摘要 prompt 可直接吸收该约束，与 occurred_ms 三轴时间互相校验；落点：B 块异步摘要 prompt 规范。
4. **只读白名单**——Letta MemFS 的 `.memfs.config.json` readOnlyFiles+人工批准变更，可对应冻结面写保护的配置化表达；落点：真源写入路径的权限边界。

冲突、不应照搬：

1. **任何形式的真源原地 UPDATE**：Mem0 payload 覆盖、LangMem INSERT OR REPLACE、LlamaIndex condense 整表重写、AstrBot JSON 整行改写，都违反 source-append-only 与删除唯一例外；这些操作只能出现在可重建投影表，绝不能进 experience。
2. **作用域/会话字段进入真源**：Mem0 把 user_id/agent_id/run_id 刻进每条记忆 payload、AstrBot 以会话 UMO 为一等前提，与契约禁用 session_id 类字段、会话仅为 scene.ref 一种取值直接冲突；多主体/场景区分只能在投影层做。
3. **LLM 输出直接成为可变事实**：Graphiti 把节点合并/边去重交给非确定性 LLM 且结果可变，Cognee 重抽即覆盖同名实体——二级真源若学此模式，"写入即固化、禁止算法批量重算"将名存实亡。LLM 在本项目只能生产事件摘要这一种固化文本，且摘要模型/prompt 版本必须留痕。

失败模式警惕：AstrBot 单行 JSON 随会话变长的读写放大与并发锁风险；LangGraph checkpoint BLOB 与类结构强耦合导致旧快照不可反序列化；Graphiti 串行写入吞吐瓶颈与并发 group 串扰 issue。真源 schema 冻结+投影白盒可重建正是规避这些的既定路线，不要因短期开发快而退回黑盒快照。

### 5.2 映射 B 块：事件二级真源（固化、闭合、异步摘要、anchors、topic_lines）

可直接借鉴：

1. **"LLM 候选、代码裁决"的两段式**（Graphiti 失效链路）：B 块未来若引入事实冲突提示，LLM 只能产出候选索引与理由，置失效/版本推进必须是确定性代码动作或人工修正，对应事件"只允许她手动修正与版本推进"的纪律；落点：edge 失效投影与未来 G3 facts 七态状态机。
2. **异步摘要的工程参数**：MaiBot 按消息数阈值触发+游标 checkpoint 续跑+两轮复核+空增量返回空结构，Mem0 只用"最近 10 条+top10 旧记忆"的小预算装配抽取上下文——本项目事件闭合后每事件一次 LLM 摘要、600 字上限、失败退避与批次预算的 worker 设计已有同类工业参数可参照；落点：`src/event/` worker 与 pending 队列可观测指标。
3. **摘要输入的取证纪律 prompt**：MaiBot 明确"机器人自述/动作/承诺不能单独证明用户事实"、排除提示注入与传闻、人物用 [U1] 标记不许自行合并；这与本项目客观第三人称摘要、anchors 锚真源经历 id 的要求同构，可直接进摘要 prompt 规范；落点：摘要 prompt 模板与离线 provenance 审计规则。
4. **网状话题线的轻量替代**：MaiBot 不建 topic 表，靠短期历史+重启恢复+一段自然语言"当前印象"做检索 query；本项目 topic_lines 在 v1 可同样克制，避免过早物化话题实体（实体投影 P3 本就在未建清单）。

冲突、不应照搬：

1. **LlamaIndex FactExtraction 式 condense**：超限后 LLM 整表重写且无旧值留存，是"算法批量重算二级真源"的反面标本，事件表绝不可提供整体重写入口，版本推进只能追加新版本行。
2. **摘要不落库的请求期压缩**（AstrBot LLMSummaryCompressor）：每轮重新摘要、旧摘要丢弃，既浪费又不可审计；本项目事件摘要写入即固化、带 summary_model/prompt_version 留痕，是刻意的反向选择。
3. **Graphiti 式每 episode 五次以上 LLM 往返**：与"每事件一次摘要、单轮至多一轮补取、700 字工作窗口"的成本纪律冲突，事件层保持单次 LLM、机械闭合零 LLM 的边界不能被功能诉求突破。

### 5.3 映射投影层：四表、三级降级、检索原语与未实现契约

现状对照：本项目已有 experience/experience_fts(FTS5 trigram)/edge(双时间邻接表)/event 四表与 query/search/queryEdges/resolvePointer/queryEvents 原语，三级降级 L1 sqlite/L2 JSONL/L3 真源直读+重建对账+checkpoint；P3 entity、P5 episode、P6 asset、P7 bla、P8 judgment_ledger 未建，queryEntity/ingestMedia 等抛 NotImplementedError。

可直接借鉴：

1. **双时间失效纯函数**：Graphiti 的日期窗口比较可几乎原样改写为 TS 纯函数挂在 edge 投影上——同一 subject 的边集合内，新旧事实区间不重叠则共存，旧边早于新边则置 invalid_ms/expired_ms，绝不物理删；无 LLM、可单测、可重放，与投影可重建完全兼容，且不需要图数据库。
2. **融合检索的低成本路径**：Graphiti 与 Dify 知识库都用标准 RRF（1/(i+k)）合并多路召回；本项目 v1 虽只有 trigram 一路，未来向量作为演进项启用时，BM25(FTS) 与向量直接 RRF 即可，无需自研加权公式。Mem0"语义过取 4 倍→融合→threshold 先过门"的两阶段召回结构也可作平坦 BM25 阶段的召回参数参照。
3. **轻实体倒链的中间态**：Mem0 用 spaCy 规则（非 LLM）维护"实体→记忆 id"倒排、检索挂 0.5 加性 boost，落在本项目"类型化轻卡已做、实体倒排属演进项"的中间地带，其 0.95 入库/0.5 boost 阈值提供了先观测后调的初始标尺。
4. **迁移与对账机制**：Cognee 双轨迁移（schema 账本+派生数据链+append-only revision slug+stamp 逃生门+幂等收敛）、MaiBot frozen schema 快照防止迁移脚本依赖运行时最新模型，均可指导本项目投影 schema 版本化与三级降级对账的落地；落点：投影 checkpoint 与未来 migrations 目录约定。
5. **checkpoint 白盒化**：对照 LangGraph 黑盒 BLOB，本项目 worker 投影新鲜度检查点应保持"可从真源重算的派生状态"定位，不引入不可反序列化的运行时快照。

冲突、不应照搬：

1. **图数据库依赖**：Graphiti 的 Neo4j 默认栈、Cognee 的 ladybug（Kuzu 改名，而 Kuzu 在 Graphiti 侧已被弃用——嵌入式图库生态脆弱性的直接信号）、MaiBot 的 FAISS+50 表记忆子系统，对几百到低千张卡的单机规模都是过度工程；ADR-1"edge 是邻接表不是图库"与 D5 kill list 的判断被这些项目的运维成本反复验证，继续维持。
2. **向量成为默认硬依赖**：LlamaIndex Vector block 必填 vector_store、Mem0 默认 qdrant+OpenAI、MaiBot embedding 走外部 API——本项目 v1 无向量、trigram FTS 为唯一检索原语的约束不应被"业界都有向量"裹挟，向量启用必须等数据触发条件。
3. **把访问统计写进真源表**：MaiBot 将 last_accessed/access_count/retention_strength 写进 paragraphs/relations 正文表列，属于"投影冻结成真源"，重建时必然与事件流失真；本项目任何热度/权重统计只能进可重建投影或运行时状态，experience/event 契约保持零语义字段。

### 5.4 映射记忆层 D1–D5 五决策

**D1（零正文、挂 source_anchor 的极薄选择索引投影）**：业界没有等价物，最接近的是 Mem0 实体倒链（只存实体文本→记忆 id 列表，正文仍在向量集合一份）与 LangGraph namespace 索引化 KV。反例是 LlamaIndex facts 与 AstrBot conversations.content 的正文复制/整段冗余。结论：D1 的零正文纪律比所有主流项目都严，但 Mem0 的倒链形态证明"索引不复制正文"工程可行；selection/权重/三类线索字段应全部留在投影，事件摘要正文保持只存一份。

**D2（质量为目标、token/延迟为预算，先离线观测后定阈值）**：LlamaIndex waterfall（30000 预算、70% 历史、10% 成批下沉、回合边界保护）与 AstrBot 两阶段压缩（轮数硬截先行、token 兜底、失败降级丢最旧整轮）是最直接的槽位预算参照；Mem0 抽取只喂最近 10 条+top10 召回验证小预算装配的工业惯例。阈值方面，Mem0 无语义阈值的混乱、Mem0 实体 0.95/0.5 与 MaiBot logit 系数全部来自离线日志拟合而非拍脑袋，支持本项目"先观测、阈值进配置不进代码常量、留回归口径"的做法；工作窗口 700 字封顶、单轮至多一轮补取的克制在所有样本中属于最紧预算，与伴侣场景小数据量匹配，不需放松。

**D3（检索记忆与第一人称自我叙事线并列、语态分层）**：Letta 现行版"人格块编辑延迟生效+git 可审"与 MaiBot 版本化 person_profile_snapshots（evidence 指针+过期+override）证明叙事性自我文本需要独立载体与版本链，不能和客观档案混写；同时 Letta 允许 agent 自由重写 persona.md、MaiBot 人格一致性完全押在每轮 prompt 重复，都是漂移警告。本项目客观档案第三人称、第一人称仅限 reflection 产物的分层应坚持，叙事线作为独立投影类型与选择索引并列，且其写入只能来自她的 reflection 轮次。

**D4（删除部分不可重建态、台账只存指针+哈希、删除闭包先于 P8）**：外部成熟度参差正好给出验收清单。可借：Dify 软删→异步队列→退避重试→兜底重扫的流水线骨架、MaiBot preview/execute/restore/purge 两段式与向量清理回滚钩子、Cognee forget 的逐后端级联枚举与 memory_only 语义。必须坚持高于它们的部分：Graphiti 裸 DETACH DELETE 派生边残留、Mem0 history.db 留旧文、LlamaIndex reset 不清 facts/向量、Letta 删 agent 不清 MemFS、Cognee 自认 LanceDB 不保证字节擦除——这些都是本项目删除闭包测试要显式覆盖的反例；tombstone 防重新派生、独立引用不误删、DeletedError 三态（present/deleted/never_existed）在九个项目中无任何一家完整实现，是本项目的差异化能力，P8 judgment_ledger 之前先完成闭包验证的排序正确。

**D5（v1 五件套：平坦 BM25+IDF、类型化轻卡、锚真源指针、槽位窗口、离线 provenance 审计；向量/图谱/在线重写/实体倒排为演进项）**：样本数据全面支持该克制——Mem0 V3 自己删掉了图、Graphiti/Cognee 的图路线成本与非确定性如前述、Dify 160k star 平台的记忆也不过是 buffer+KV。可直接纳入 v1 的廉价工程件：BM25 类稀疏路（AstrBot rank-bm25+中文停用词、MaiBot paragraph_ngrams+FTS5）、provenance 留痕（Cognee edge evidence、MaiBot fact_claim/evidence 链、Mem0 history 事件流）。离线 provenance 审计在所有对象中均无现成产品（评测章节普遍空白），属于本项目必须自建、且能形成壁垒的能力。

### 5.5 映射删除与隐私、数据主权

- 级联枚举写法可参考 Cognee forget 的 docstring 逐后端清单与 Dify 的外键尊重顺序；本项目删除闭包测试应逐投影（fts 行、edge 行、event 派生索引、未来台账、文件资产）断言无残留，而不是只删 experience 行。
- 墓碑与审计是全员短板：仅 MaiBot 有 delete_operations 台账和回收站恢复，Dify 有软删但无墓碑语义；本项目台账只存指针+哈希不存正文的设计，在"可审计"与"不泄露已删内容"之间的平衡没有现成竞品，需要按 A 块 §11 的 persona_forget 闭包原则自建并补足测试。
- 导出能力：Cognee 的 COGX 导出（含 sha256 校验）是唯一成体系的可移植格式参考；Dify 仅导出应用 DSL 不含会话、Mem0 无导出 API。未来数据可携权设计可提前预留投影导出格式，但不阻塞 v1。
- 遥测默认值：Mem0 telemetry 默认 True、MaiBot PRIVACY.md 明示数据发第三方 API、Cognee 默认 OpenTelemetry——local-first 产品的所有外发遥测必须默认关闭并显式告知，这条写入实施约束。

### 5.6 映射运行时与契约枚举（host-model-route、worker、ingestRawTurn、tick、开放枚举）

1. **宿主模型路由**：所有框架的 LLM/embedding 默认指向外部 OpenAI 兼容 API，本地模型均为手工替换项；本项目 `src/adapters/dsh/host-model-route.ts` 的宿主路由、摘要调用无 session 身份的边界是正确姿态，实施时对标注"记忆调用"的摘要请求保持无身份透传，并借鉴 MaiBot/Letta 把模型与 prompt 版本写入每条产物（对应 summary_model/prompt_version 留痕）。
2. **worker 投影新鲜度**：Mem0 抽取失败静默吞异常（仅 logger）是明确反例，本项目 pending 摘要队列的退避、硬超时、批次预算、过期结果丢弃之外必须有失败计数与可观测告警；Cognee pipeline run 账本与 MaiBot 游标续跑可作新鲜度台账参考。
3. **ingestRawTurn 硬编码 kind=dialogue 与主动摄入暂缓**：AstrBot/MaiBot 的主动轮都以"合成输入消息"形式进入同一管线，验证了 kind/initiation 作为开放枚举的扩展位足够承载未来主动摄入，暂缓 kind 字段、先保持 dialogue 单路径不影响后续兼容——但主动轮入库时必须能区分来源（见第 6 节 source 标记模式），届时再扩枚举而非提前抽象。
4. **tick 单机 max+1**：Letta 的 60 秒常驻 tick+文件租约、AstrBot APScheduler 常驻、Dify worker_beat 轮询都依赖常驻进程，与本项目非常驻唤醒-检查点-挂起不兼容；可借的是它们的任务状态机字段（fire/missed/failed 计数、last_run_outcome、jitter）与 claim 模式的思想，数据结构本地化到 SQLite 任务表、由唤醒时刻驱动，不引入常驻调度器。多端同步前 max+1 时钟不去中心化的既定约束不变。
5. **开放枚举（KNOWN_KINDS/INITIATIONS/EDGE_TYPES）**：Graphiti 的 Pydantic edge_type 强约束（违规边可丢弃或改名）提示开放枚举也需要在写入边界做未知值校验；本项目枚举开放但契约类型收敛，新谓词/新 kind 的接入点应统一在 contract 层校验，避免投影各自容忍脏值。

---

## 6. 专节一：对 C 块主动性设计的借鉴与陷阱

本项目 initiation 枚举已含 user/her/system/environment，为"她主动（her）"留位，但 C 块尚未设计、tick 为单机 max+1、内核不内置调度器。九个对象呈现出四种清晰可辨的主动模式，加上纯记忆组件的集体空白，足以支撑模式选型而不必从零发明。

### 6.1 业界四种主动触发模型

| 模式 | 代表实现 | 机制本质 | 常驻进程依赖 |
|---|---|---|---|
| 常驻 cron+合成轮统一管线 | AstrBot | APScheduler 持久化 job，到期 wake_main_agent 投合成事件，复用全部 9 段主管线与限流安全 hook | 是 |
| 进程内 tick+租约任务状态机 | Letta | 60 秒 tick、crons.json 租约选主、CronTask 完整计数状态；dreaming 由压缩事件而非时钟触发 | 是 |
| LLM 自主 wait 自醒+概率门 | MaiBot | wait(秒/绝对时间)超时投递 timeout 唤醒、新消息可提前唤醒；拟合 logit 概率门+一小时窗口频率控制+指数退避，无 cron | 运行期常驻但无独立调度器 |
| 服务器轮询跑批 | Dify | schedule 行落库、worker_beat 周期 claim_due，能跑工作流但无用户侧推送通道 | 是（服务端） |

LangGraph 的 interrupt、Mem0/Graphiti/Cognee/LlamaIndex 经核实均无主动能力：interrupt 是被动断点，记忆组件是 pull-on-call。这个空白本身说明：**记忆层不需要、也不应该长出主动性，主动性是运行时/C 块的职责**，与本项目分层直觉一致。

### 6.2 可直接借鉴的具体设计

1. **主动=带来源标记的合成输入轮，走同一管线（AstrBot/MaiBot 共同验证）**：不建第二条发送旁路。未来 her 轮次构造为内部唤醒事件进入与 user 轮相同的回复管线，仅以 initiation=her 与来源字段区分；这与开放枚举 INITIATIONS 的预留位天然契合，且白名单、限流、内容安全、插件 hook（未来若有）全部自动复用。MaiBot 进一步要求主动轮发言前强制回填最近真实用户消息作为可回复目标，防止"对空气说话"，应照做。
2. **"要不要说"的两层决策分离（MaiBot）**：调度层只负责"现在到了一个可发言时机"（wait 超时/唤醒时刻），决策层用概率门回答"这次值不值得说"。其离线拟合 logit（被提及、问号、近期自己发言占比、距上次发言时长、待处理批大小）与"反馈只收紧不放宽"的频率门，是防打扰最有代码依据的一套；本项目可把同类系数做成离线观测产出的投影配置而非硬编码，契合 D2 先观测后阈值。
3. **冷却、静默检测与退避三件套**：MaiBot 收齐消息窗口防半批判断、空闲指数退避（base×2^n 封顶、高优先级消息旁路）、连续 wait 计数防空转；AstrBot 固定窗口限流 stall/discard。C 块最小实现应包含：每会话冷却、静默期判定、退避计数、总开关与会话级暂停（对照 MaiBot chat_pause_state）。
4. **任务状态机字段本地化**：Letta CronTask 的 fire_count/missed_count/failed_count/last_run_outcome/jitter 与 AstrBot cron_jobs 表给出了 SQLite 任务表的字段清单；本项目用唤醒时扫描到期任务表替代常驻 tick，只需状态机不需守护进程。
5. **话题从哪来**：MaiBot 由 Planner 在同一 LLM 决策里产生 wait 时长与发言意图，主动话题自然来自记忆检索与当前印象，不存在独立"话题库"；Letta dreaming 把反思产物在隔离 worktree 作业后合并——对应本项目，主动话题可由 reflection 投影与检索原语现场生成，不新增真源字段，隔离作业思想对应独立事务/临时投影，完成后再并入。
6. **反机械的 prompt 纪律（MaiBot 桌宠条款，价值被低估）**："内部思考事件不是用户消息、不必每次都发消息、避免重复问候/机械报时/催促回应/自我循环唤醒、不把内部提示伪装成主人指令"——这组条款应原样进入 her 轮的系统提示约束。
7. **成本敏感默认值（Letta）**：系统提示明示"默认最长间隔、状态检查一小时以上"；本项目 tick max+1 与非常驻模式下，主动检查粒度天然偏粗，应把"宁疏勿密"写成默认策略并允许用户调密。

### 6.3 在 append-only/真源纪律与 local-first 下的陷阱

1. **常驻进程陷阱**：AstrBot/Letta/Dify 的调度都假设 daemon 常驻，与唤醒-挂起模型冲突；不能为主动性引入常驻服务，正确姿态是外部唤醒（系统闹钟/宿主回调）驱动一次完整激活-扫描-挂起循环，任务表是唯一跨唤醒记忆。
2. **主动轮污染真源陷阱**：MaiBot 插件主动轮构造伪触发消息但不写消息库的做法值得注意——主动发起的"她的话"与被动回复同样是真实经历，最终应按正常 experience 追加（append-only 不区分主动被动），但内部调度信号、timeout 事件、概率门评分绝不能进真源，只能落运行时状态或可重建投影；ingestRawTurn 扩展时要保持这条线。
3. **时钟与多端一致性陷阱**：当前 tick=max+1 在多端下会冲突，任何主动任务表设计都不能假设全局单调时钟去中心化已解决；任务表结构预留 device 标识即可，不提前实现分布式选主（Letta 租约选主是常驻多实例场景的产物，不适用）。
4. **打扰失控陷阱**：AstrBot 没有独立免打扰时段、复用用户限流器，深夜 cron 可直接吵用户；平台 capability flag 默认 True 且不校验真实政策。C 块必须内置静默时段/免打扰配置与主动消息可观测日志（说了什么、因何触发、当时概率门分值），并提供一键全局关停。
5. **LLM 自定时的空转成本陷阱**：MaiBot wait 环若无连续计数与新消息唤醒会空转烧 token；本地宿主模型路由下每次唤醒都有真实成本，wait 时长需要下限约束与日预算封顶。
6. **拟人度与可靠性的权衡**：MaiBot 概率门系数来自自身日志拟合，本项目冷启动无拟合数据，早期应使用保守静态阈值+显式观测埋点，数据足够后再拟合，避免上线初期随机打扰。

## 7. 专节二：消息回复管线与人格/关系/情感注入的借鉴与纪律边界

### 7.1 五种管线形态对照

| 对象 | 管线骨架 | 人格载体 | 工具/规划 |
|---|---|---|---|
| LangGraph | 显式状态机：preModelHook 装配→agent 节点→条件边判断 tool_calls→tools 节点循环→END，checkpointer 保多轮 | prompt callable 返回的 system 字符串 | 状态机原生工具循环 |
| AstrBot | EventBus→9 段固定 stage（唤醒/白名单/会话/限流/安全/预处理/处理/装饰/响应），20 余插件 hook 可改写各阶段 | personas 表 system_prompt+begin_dialogs，按会话/对话/runner 优先级解析 | tool_loop runner+MCP+Skills，支持第三方 runtime |
| Dify | 画布工作流：审核→变量加载→分类/检索/LLM/分支/代码/assigner/answer 节点→SSE | 应用级静态 pre_prompt 列；新 AgentSoul 分槽 JSON | 节点即工具，插件守护进程 |
| MaiBot | 适配→落库→调度门→Planner 出"发言指导"→Replyer 二遍成文→表达选择（学来的句式/表情）→发送 | 配置纯文本 personality/behavior_style，不入 DB | Planner 工具集 reply/query_memory/wait/stop/subagent |
| Letta | CLI  loop 编译上下文后外包给厂商 coding-agent 运行时执行 LLM+工具循环，harness 负责注入/压缩/调度 | MemFS persona.md，编辑下轮生效 | 通用文件工具+subagent |

纯记忆组件（Mem0/Graphiti/Cognee/LlamaIndex 库形态）不拥有管线，只在管线的"记忆检索注入"阶段被调用，边界清晰。

### 7.2 可借鉴的管线设计

1. **阶段切分的最大公约数**：五个样本收敛出同一套阶段——平台适配/接收 → 上下文与记忆装配 → 规划/工具 → 生成 → 风格与安全后处理 → 发送/流式。本项目 C 块回复方案可直接按此六段定模块边界，记忆检索只作为装配段的一个原语调用（query/search/queryEdges/queryEvents），与 LangGraph preModelHook 的薄挂点思想一致：框架不替你决定拼什么，只给一个模型调用前的确定性装配函数位置。
2. **两遍生成（MaiBot Planner/Replyer）适合伴侣场景**：第一遍 LLM 只做"回应什么、依据哪些锚点事实、要什么情绪画面"的结构化发言指导，第二遍才口语化成文。好处是第一遍可挂 source_anchor 做 provenance 校验、可在成文前拦截无锚点编造，第二遍可换风格模型不动决策。这与本项目"客观档案第三人称、外显语态分层"兼容：事实决策与人格化表达物理分离。
3. **装配的槽位化与预算保护**：LlamaIndex 的 block priority 降序装配/升序裁剪/priority=0 保底、Dify LLM 节点 memory window 三件套、AstrBot truncator 保 system 与首条 user、修复 tool_calls 配对，都是槽位窗口（700 字工作窗口）的工程细节库；人格/系统指令应设为 priority=0 保底槽，记忆槽超预算时按权重裁剪而非挤占系统槽。
4. **平台适配抽象**：AstrBot 统一消息事件+消息链、18 个适配器收敛差异、主动能力用 capability flag 声明；本项目未来多端接入可照此分层，平台差异不进入内核契约。
5. **后处理与可观测 hook 点**：AstrBot 的 on_llm_request/response、agent_begin/done、after_message_sent  hook 顺序给出了无侵入埋点位置；本项目离线 provenance 审计与质量观测可挂等价节点，不改写消息本身。
6. **多轮状态的恢复语义**：MaiBot 重启按预算回灌+分档"上下文恢复"提示（明确告知模型这不是用户新消息），对非常驻唤醒-挂起模型直接适用；每次激活装配窗口时用显式系统标记区分恢复上下文与当前轮输入，防止模型把历史当新指令。

### 7.3 人格、关系、情感的纪律边界（本项目核心约束）

本项目纪律：契约里没有任何情绪/重要度/亲密度字段；事件摘要客观第三人称、不注入人格；第一人称仅限她自己 reflection 产物的叙事线；情绪/重要度只能作为可重建投影的排序权重或外显层。九个对象的实际情况为这条纪律提供了三组证据。

**证据一：数值化情感路线正在被从业者自己抛弃。** MaiBot 老经典版曾有完整好感度/亲密度数值模型，当前重写版将其整体删除、不留迁移，全仓零情绪列，改为自然语言画像+LLM 现场推断；AstrBot 内核的 mood_imitation_dialogs 字段在 v4.0 废弃强制置空，亲密度/情绪全部退到插件层。两个最"像伴侣"的框架都没有把情绪数值留在内核，与本项目契约纪律方向一致。

**证据二：仍想要情绪/关系效果，正确位置是投影与外显层，不是真源。** 可作为外显层借鉴的做法：MaiBot 的回复频率快照（运行调度参数、随消息流水记录但不是"感情分"）、记忆 retention_strength/access_count（检索遗忘权重）、版本化 profile snapshot（自然语言+evidence 指针+过期+手动 override）；AstrBot 插件层的情绪风格标签只作用于表达选择。这些都是"可重算、可丢弃、不改变客观事实"的派生量，本项目同类数值只能进投影表或运行时配置。

**证据三：任何把情绪/关系数值或人格文本注入客观记录的做法都与冻结面冲突。** 明确不可照搬：

- 让 LLM 自由重写人格块（Letta V1 rethink_memory、现行 persona.md 通用文件可改）——人格漂移不可审计，本项目人格化文本只能进外显配置与第一人称 reflection 叙事线，且叙事线是独立投影；
- 在事实抽取 prompt 里允许观点/情绪/总结（LlamaIndex 反而明确禁止 opinion/summary，是正面榜样）——本项目事件摘要 prompt 应延续客观第三人称，情绪画面只出现在 Replyer 第二遍的外显生成；
- 把可重算访问统计写进正文表列（MaiBot access_count/retention_strength 入 paragraphs/relations）——属投影冻结成真源，本项目权重列只许建在可重建投影；
- Sylanne 类插件的人格漂移/情绪引擎与内核同进程无沙箱——若未来支持插件，情绪外显插件的产物不得回写真源与事件层。

**人格一致性的工程答案**：样本里没有银弹。MaiBot 靠每轮系统提示重复+首条"历史不能覆盖规则"，Letta 靠延迟生效+git 可审+尺寸上限，Dify/LangGraph 靠静态 system prompt。本项目可组合：静态人设进保底系统槽（外显配置、可版本化但不进真源）、关系认知进第三人称客观档案与带锚点画像投影、第一人称自我叙事仅由 reflection 产生且独立成线——三层各司其职，避免任何一层承载全部人格负担。

### 7.4 幻觉控制与记忆组装的具体约束

- 候选序号化（Mem0）与发言指导锚点化（MaiBot）合并使用：装配进窗口的每条记忆带 source_anchor，Planner 输出必须引用锚点 id，无锚点事实不得进入成文。
- 矛盾事实处理不取 Mem0 的"永久并存谁分高谁赢"，也不取 LlamaIndex 的"LLM condense 静默合并"，而取 Graphiti 式"候选+确定性失效"+本项目双时间 edge：冲突先在投影标失效，真源与事件不动。
- 工具调用循环参考 LangGraph 条件边的显式状态机而非隐式 agent loop，便于在非常驻模型下断点恢复与步数封顶；D2 已定单轮至多一轮补取，工具循环同样需要步数/ token 双预算。

---

## 8. 产品形态补充：OpenAI ChatGPT memory（无源码）

声明：本节仅依据 OpenAI 官方帮助中心与官方博客，商业闭源、无源码可查，不做任何源码层面推断；访问日期 2026-11-11。

**现行形态（官方 FAQ）**：记忆来源包括过往聊天、saved memories、custom instructions、Library 文件与已连接应用；两套体验并存——现行主推的 Improved Memory 由后台持续综合一份 Memory summary（高层摘要视图而非逐条清单），与 Legacy saved memories 显式条目，可在设置切换。三个独立开关：Memory、Reference saved memories、Reference chat history；可对 summary 做文本纠正、片段高亮纠正、"Don't mention this again"（只影响引用不删源）、"Delete and turn off memory"；每条回复下 Sources 面板展示该回答引用的记忆/历史/文件并可就地删除。删除单条记忆不删对应聊天，删聊天不自动删独立记忆；关闭历史引用后提炼信息 30 天内删除，已删内容的安全/调试日志最长保留 30 天；Temporary Chat 不创建也不使用记忆，企业受监管工作区默认关闭并支持项目内记忆限定范围。

**官方时间线**：2024-02 博客宣布小范围测试；2024-04 上线 saved memories；2024-09 全量并加管理面板；2025-04 增加从全部历史自动提炼的 insights；2025-06 免费用户获得轻量版；2026-06-04 官方博客发布 Dreaming V3 后台异步"梦境式"综合，主打自动改写过时事实（例："7 月去新加坡"改写为"2026 年 7 月去过新加坡"），公布 carry forward / follow preferences / stay current over time 三条评测维度，并称计算成本下降约 5 倍。

**对本项目的可借鉴点（产品层而非代码层）**：

1. Sources 级逐条溯源与就地管理，印证 source_anchor/ provenance 的产品价值——用户需要知道"你为什么这么说"，本项目离线 provenance 审计未来可外化为用户可见的引用面板。
2. 记忆控制的粒度分层（总开关、保存开关、历史引用开关、单条删、一键清、临时模式）是用户预期的完整控制面，本地产品的数据主权控制面至少应做到同等粒度且全部本地生效。
3. "Don't mention this again"（屏蔽引用但不删源）是介于保留与删除之间的有用产品语义，可在投影层实现为屏蔽标记，不触碰真源。
4. Dreaming 代表的"后台自动综合改写"方向与本项目二级真源固化纪律相反，只可作为竞品动态知晓：其过时事实自动更新能力对应的是本项目 edge 失效投影+人工/确定性版本推进，而非后台 LLM 静默改写；官方三维评测指标（延续、偏好跟随、时效更新）可直接借为本项目离线评测的指标框架。

## 9. 高热度但未深读项目的排除说明

三个项目 star 不低但未进入深读，理由均经核实，避免幸存者偏差。

| 项目 | star 与许可证（核实于 2026-11） | 形态 | 不深读理由 |
|---|---|---|---|
| Supermemory（supermemoryai/supermemory） | 约 31.5k，MIT | 本地单二进制+云双轨，内置图引擎与本地 embedding、自研 learner-1 模型，向量-图混合检索带 context fencing 与时间衰减，MCP server | 工程上偏"产品包装"，核心机制（混合检索、图+向量、MCP 暴露）已被 Mem0/Cognee 两个深读对象覆盖；其本地优先方向值得关注，但其云双轨与专有模型对零依赖决策的增量信息有限。来源：github.com/supermemoryai/supermemory、docs.supermemory.ai、memoryatlas.dev/frameworks/supermemory（2026-11-01） |
| Hindsight（vectorize-io/hindsight） | 约 18.7k，MIT | 仅支持 Postgres（docker 内嵌 PostgreSQL），四层记忆网络，Retain/Recall/Reflect API+MCP | 强制 Postgres 容器、无 SQLite/嵌入式选项，与单机零依赖前提直接冲突；API 形态与 Mem0/Cognee 重叠。来源：hindsight.vectorize.io、blog.streamwriter.io（2026-07）、dev.to/ken_lu |
| Memary（kingjulio8238/Memary） | 2,663，MIT | ReAct 路由+Neo4j/FalkorDB 知识图谱+Memory Stream/Entity Knowledge Store 双记忆 | 第三方目录已标注 Dormant/Deprecated，最后提交超过一年（libhunt 与 memoryatlas，2026 年中），触发活跃度硬门槛；其 KG 路线亦由 Graphiti/Cognee 更深覆盖。某开发者调查中其出现率较高但样本仅 176 人，不构成活跃度证据。来源：memoryatlas.dev/frameworks/memary（2026-11-01）、libhunt.com/r/memary |

## 10. 跨对象综合结论：给实施方案的输入清单

### 10.1 可直接借鉴的十项具体设计（含落点模块）

| # | 借鉴项 | 来源 | 落到本项目哪里 |
|---|---|---|---|
| 1 | 双时间事实失效的纯日期窗口纯函数（LLM 只出候选、代码裁决、旧边原地置失效不删） | Graphiti | edge 投影失效逻辑，可单测可重放，支撑未来 G3 facts 七态 |
| 2 | LLM 候选列表序号→真实 ID 映射防幻觉 | Mem0 V3 | 事件摘要与未来选择索引的所有 LLM 接口 |
| 3 | token 预算 waterfall：保底槽+成批下沉+完整回合边界保护 | LlamaIndex、AstrBot 两阶段截断 | 槽位窗口装配器（700 字工作窗口）与未来补取预算 |
| 4 | 主动=带 initiation 标记的合成轮、主管线统一处理+发言前回填真实用户消息 | AstrBot、MaiBot | C 块 her 轮入口与 ingestRawTurn 枚举扩展 |
| 5 | 主动决策两层分离+拟合 logit 概率门+只收紧不放宽+指数退避+静默时段 | MaiBot | C 块防打扰子系统（早期保守静态阈值+观测埋点） |
| 6 | 本地任务表状态机字段（fire/missed/failed/last_outcome/jitter），唤醒扫描替代常驻 tick | Letta、AstrBot、Dify claim_due | 非常驻运行时的 SQLite 任务表，不引入 daemon |
| 7 | 两遍生成：发言指导（带锚点）→口语成文，事实决策与人格表达分离 | MaiBot | 未来回复管线 Planner/Replyer 分层与幻觉拦截 |
| 8 | 双轨迁移+append-only revision slug+stamp 逃生门+冻结 schema 快照 | Cognee、MaiBot | 投影 schema 版本化、三级降级对账与迁移目录约定 |
| 9 | 删除流水线骨架：软标记→异步级联→退避重试→兜底重扫，加本项目台账/tombstone | Dify、MaiBot、Cognee | 删除闭包（先于 P8）与逐投影残留测试 |
| 10 | 反机械主动 prompt 条款与"记忆引用不删源"的屏蔽语义 | MaiBot、ChatGPT 产品 | her 轮系统提示、投影层屏蔽标记与未来用户控制面 |

### 10.2 明确不应照搬的八项（含违反的纪律）

1. 真源层任何原地 UPDATE/整行覆盖/整表 condense（违反 source-append-only；反例：AstrBot、LangMem、LlamaIndex、Mem0 update）。
2. LLM 自由写并静默改写长期事实（违反二级真源固化不可批量重算；反例：LangMem put、LlamaIndex condense、Graphiti 可变图、ChatGPT Dreaming 闭源模式）。
3. 情绪/亲密度/重要度数值进入真源契约（违反冻结面禁字段；行业证据：MaiBot/AstrBot 已自行下线内核情绪数值）。
4. 现阶段引入图数据库或向量为硬依赖（违反 D5 数据触发原则与零依赖；反例：Neo4j 运维成本、Kuzu 嵌入式被弃用、FAISS+外部 embedding 重依赖）。
5. 常驻调度器/守护进程假设（违反非常驻唤醒-挂起；Letta/AstrBot/Dify 均不适用，只借数据结构）。
6. 会话成为一等前提字段（违反 scene.ref 抽象与 session_id 禁令；AstrBot UMO、Mem0 scope payload）。
7. 请求期摘要不落库、每轮重算（违反事件固化与留痕；AstrBot 压缩器）。
8. 黑盒检查点 BLOB 与序列化强耦合（违反投影白盒可重建可对账；LangGraph checkpointer）。

### 10.3 需要长期警惕的复杂度陷阱

- **LLM 写记忆的非确定性**：凡是让 LLM 决定合并/失效/重写的系统（Graphiti、Cognee、LlamaIndex）都暴露了假阳性、重放不一致、静默丢事实问题；本项目允许 LLM 的位置应始终收敛为"一次性固化文本（事件摘要）+只进投影的候选建议"。
- **配置面膨胀**：Cognee 数十个环境变量、Dify 15+ 容器与 248 个迁移是规模不经济的两端表现；local-first 的卖点是零配置可信运行，后端抽象预留但默认路径必须一条且全本地。
- **静默失败**：Mem0 抽取 JSON 解析失败仅 logger、faiss 混合检索静默降级纯语义、Dify schema 先行实现空壳——所有降级与失败都需要显式状态与用户可见信号。
- **删除的长尾残留**：向量碎片、history 旧文、孤立派生边、记忆目录残留是普遍问题，删除闭包必须以测试逐投影锁死，而非依赖人工记忆。
- **宣传与代码的时差**：本次调研发现 Letta 仓库重构、Mem0 V3 纯 ADD、Dify 空壳 memory、Cognee MCP 工具数、MaiBot 版本号五处文档落后于代码，选型与实施引用外部项目时一律以固定 commit 代码为准、不采信二手文章数字。
- **评测普遍缺失**：九个对象无一拥有可一键复现的记忆质量回归（基准多属托管平台或外部数据集），本项目离线 provenance 审计与质量观测没有现成替代品，应作为实施方案的独立工作包而非附带事项。

### 10.4 对 v1 范围的最终支持结论

深读结果没有动摇 D5 的 v1 五件套，反而从外部工程证据上加强了它：平坦 BM25+IDF（trigram FTS 已在）、类型化轻卡、锚真源指针、槽位窗口、离线审计足以覆盖伴侣场景的早期数据量；向量、知识图谱、在线重写校验、实体倒排继续列为数据触发演进项，并预置好 RRF 融合、可插拔后端抽象、双轨迁移账本三个接口形状。C 块主动性与回复管线虽未动工，但模式选型已有充分依据：非常驻任务表+合成轮统一管线+两层防打扰决策+六段式管线+两遍生成，且全程不突破真源冻结面与二级真源固化纪律。

---

## 11. 来源清单（访问日期均为 2026-11-11）

### 11.1 深读对象源码（本地浅克隆，permalink 前缀含 commit hash）

- Mem0：https://github.com/mem0ai/mem0 （commit f1791daa86d469249c9b002f62644d58a1eb96a0；含 mem0-ts）；发布页 https://github.com/mem0ai/mem0/releases ；评测仓 https://github.com/mem0ai/memory-benchmarks
- Graphiti：https://github.com/getzep/graphiti （commit e911422602068a0dc28e72a1961698269e9aefb2）；Zep 示例仓 https://github.com/getzep/zep （commit 65b52058b7d034ba05623c85a909e82a8d1ac2ef）；Zep CE 弃用说明 https://help.getzep.com/faq
- Letta：https://github.com/letta-ai/letta （main commit 8816d3a；archive 分支 56ba9c25）；现行实现 https://github.com/letta-ai/letta-code （commit c9369635cc07cfd7b8d23526f79ffd6a6068ad33）；npm https://registry.npmjs.org/@letta-ai/letta-code ；论文 https://arxiv.org/abs/2310.08560 、https://arxiv.org/abs/2504.13171
- LangGraph：https://github.com/langchain-ai/langgraph （commit e5e37b5d70dbfd93c7006bd90a658c6179a95946）；JS https://github.com/langchain-ai/langgraphjs （commit 6dd190c558f9dc4012cdf6aaf142788ae7dbc444）；LangMem https://github.com/langchain-ai/langmem （commit 8620b986af5b0c7593e6b7fbece2998690d22d15）
- LlamaIndex：https://github.com/run-llama/llama_index （commit 5f95c79fc38ba6f0e301ff29803449ce7ecb094b）；PyPI https://pypi.org/project/llama-index-core/
- Dify：https://github.com/langgenius/dify （commit 22ec8d45beab8fd810e4529a3ed17b2d8974731e）；引擎子仓 https://github.com/langgenius/graphon （commit 716d539db6bd6785eb05739afa74ec26aef3119b）；发布页 https://github.com/langgenius/dify/releases
- Cognee：https://github.com/topoteretes/cognee （commit 8853378eae5366addb064e758e560a456146ae1a）
- AstrBot：https://github.com/AstrBotDevs/AstrBot （commit 68acac91b1ab92c2ac4cfd811c0898913a1391c8）；文档站 https://docs.astrbot.app/ ；插件市场 https://cloud.astrbot.app/ ；LivingMemory 插件文档 https://lxfight-s-astrbot-plugins.github.io/astrbot_plugin_livingmemory/ ；Sylanne https://github.com/ayleovelle/astrbot_plugin_sylanne
- MaiBot：https://github.com/MaiM-with-u/MaiBot （commit e5391507531706a8bfce011d55ed94628039f2de）；发布 https://github.com/MaiM-with-u/MaiBot/releases ；文档站 https://docs.maibot.chat

### 11.2 官方产品与无源码材料

- ChatGPT Memory FAQ：https://help.openai.com/en/articles/8590148-memory-faq
- OpenAI 记忆功能发布博客（2024-02，含后续更新）：https://openai.com/index/memory-and-new-controls-for-chatgpt/
- OpenAI Dreaming V3 博客（2026-06）：https://openai.com/index/chatgpt-memory-dreaming/

### 11.3 未深读项目与第三方核实页（易变数字交叉来源，均核实于 2026-11）

- Supermemory：https://github.com/supermemoryai/supermemory ；https://www.memoryatlas.dev/frameworks/supermemory ；https://docs.supermemory.ai/
- Hindsight：https://hindsight.vectorize.io/ ；https://blog.streamwriter.io/ ；https://dev.to/ken_lu
- Memary：https://www.memoryatlas.dev/frameworks/memary ；https://www.libhunt.com/r/memary
- 星标/排行交叉核实：memoryatlas.dev、vuncloud.com、memnexus.ai、gstars 等第三方页面；GitHub API 在本机共享 IP 限流，凡未经仓库 HTML 页直接确认的数字（如 Graphiti 约 31.3k、Letta 两仓星标、LangMem 约 1.7k）均在文中以"约"与第三方口径标注。
- 行业调查参照：Stack Overflow 2026 AI 工具调查（样本 176 人，仅作趋势旁证不作为入选依据）。

> 本报告所有源码级论断均可由 11.1 中固定 commit 的仓库快照复现；各文件行号基于调研时 commit，后续主干可能漂移，复核请优先使用 commit permalink 而非分支 HEAD。






