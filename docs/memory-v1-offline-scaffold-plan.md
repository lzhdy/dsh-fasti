# 记忆层 v1 实施技术方案（离线脚手架）

> 文档定位：本文是《记忆本关键词线索化方案评审稿》D1–D5 决策（见 `docs/memory-book-index-review.md` 附录 E.6）与《主流聊天/记忆框架落地差距分析》（`docs/framework-survey-landing-analysis.md`，下称《落地分析》）§3/§4 的下游第一步，把判定落成**可照图施工**的工程方案。读者按本文 §9 的提交划分即可逐块实现，无需再做设计决策。
>
> 基线：当前工作树 HEAD `eafe484`（事件层防御三连修之后，42 个测试文件、517 个用例全绿）；数据根 `/home/user/.dsh/fasti` 实测 252 条经历、10 个当前态全部 `closed` 且 `summary_quality='ready'` 的事件（2026-11-11 实测）。
>
> 阶段红线：本文获批前只允许存在本文件这一个新增 docs 文件；禁止改 `src/`、`tests/` 与任何产品代码，禁止 git add/commit/push，禁止预写脚手架代码。获批后的编码任务另行下发，边界以本文 §9/§11 为准。
>
> 体例：沿用【事实】【推断】【建议】分层；事实类引用带 `文件:行号` 或文档章节锚点。外部框架的易变数字沿用调研报告口径（核实于 2026-11）。

---

## 【当前状态裁决 · 2026-11-12】人工 seed 与锚点 remap 已整体下线

> 本裁决优先级高于下文一切历史描述。下文（尤其 §4.7、§7、§11.7、§11.9、§13.2、附录 A）关于人工种子卡、候选包/worksheet、`remap-anchors` 重映射、人工 G2 标注的内容，均为**已废止的历史设计存档**，不再对应任何现存代码。历史正文按 append-only 留痕原则原样保留、不逐句改写；判断系统现状以本节与当前工作树代码为准。

**下线结论。** 运行期记忆沉淀与决策的唯一主体是「她」（AI），代码中不得存在任何人向记忆库写卡、写别名或改锚点的通道。下列人工能力与文件已整体移除：

- 删除 `src/memory/seed.ts`（半自动 worksheet、候选包 `buildCandidatePacket`/`applySeedWorksheet`、`jaccardNeighbors`）、`src/memory/anchor-remap.ts`（路径 A 受控重映射、候选池 `candidateExperienceIds`、`computeRemapHash`）、`scripts/seed-memory-cards.ts`（人工建卡 CLI），以及对应测试 `seed.test.ts`、`anchor-remap.test.ts`、`dirty-root-fixture.test.ts` 与脏根夹具。
- 类型、台账、SQL 同步收窄，封死全部人工枚举（权威值见下）。
- builder 回退为纯悬空硬失败：事件锚点必须是存在于真值经历全集的 ULID，否则抛 `MemoryAnchorDanglingError`、整份零产物；不再保留候选池、remap 回放或任何人工兜底。

**收窄后的权威枚举值（与当前代码一致）。**

- 别名 `AliasRow.source` 与 `mem_alias` 的 SQL CHECK：仅 `'miss'`。
- 决策 `DecisionRecord.created_by`：仅 `'her'`；`action` 仅 `create-card / update-cues / tombstone-card / add-alias / invalidate`（删除 `remap-anchors` 及其两个留痕字段、候选包相关接口）。
- 修订 `RevisionRecord.slug`：`schema-init / build / rebuild / stamp`（删除 `seed-apply`）；`operator` 仅 `'offline-cli'`（删除 `seed-workflow`）。
- 审计/决策的规则版本标识统一为 `'rules-v1'`，不再有人工 `'human'` 标记。

**存量悬空锚点。** 真实根历史事件里的语义标签型锚点（34 个悬空）不会被代码消解，当前 build 按设计硬失败、零产物，且**不存在人工绕行**；其合规解法交给后续「#42 运行期自动建卡」专项（见 `docs/memory-anchor-governance-and-auto-card-proposal.md`；该立项文中把已删模块当作既存可复用能力的条目，同样以本裁决为准，须在收窄后的基线上重建候选池护栏）。

**验证基线。** 下线后 `npm run verify` 687 用例全绿（人工通道相关用例同步移除，由 755 净减 68）；变异反证证明注入任一人工枚举值在类型层即编译失败、在存储层被 SQLite CHECK 拒绝；生产 `dependencies` 仍为 `{}`，构建产物中无 seed/remap 残留。

---

## 目录

0. 一页结论摘要
1. 范围与边界
2. 设计基线、目标函数与指标
3. 独立投影：文件布局与表结构
4. 工作块分解与接口签名
5. 数据流向
6. 评测 harness 设计
7. 10 事件种子卡造法与验收
8. DoR / DoD
9. 分阶段提交计划
10. 外部机制吸收与「虽流行仍不做」登记
11. 实现期自证与审核配合
12. 风险与回滚
13. 返工守门点与实施前确认 checklist
- 附录 A：新增文件清单
- 附录 B：证据索引

---

## 0. 一页结论摘要

1. 【事实】本方案交付物是一套**离线脚手架**：只读真源（`experiences/`、`raw-turns/`）与事件二级真源（`events/`），在独立目录 `projection/memory-index/` 下产出极薄选择索引（独立 SQLite + 两份 JSONL 账本）、类型化轻卡与离线评测 harness。不接入实时摄入链路、不写 append-only 真源、不实现 erase/P8 judgment_ledger，运行时装配代码本期只写纯函数、不挂门面原语。
2. 【事实】选择索引物理独立：新库文件 `memory-index.sqlite` 与现有 L1 库 `projection/fasti.sqlite`（命名见 `src/projection/detect.ts:50-51`）平级隔离，**严禁向 event 二级真源表（DDL 见 `src/projection/event-schema.ts:14-42`）加列**；新模块全部落在新目录 `src/memory/`，`src/api/`、`src/event/`、`src/source/` 零改动，并由静态隔离测试守门。
3. 【建议】目标函数表述为**质量最大化 s.t. token/延迟预算**：三条质量红线拍经验初值——证据召回率 R1 ≥ 0.85、错误事件认定率 R2 ≤ 0.05（强断言/承诺/日期/原话/否定趋近 0）、叙事自我一致性 R3 ≥ 0.8；预算结构为工作窗口 700 字封顶、单轮至多一次补取、P95 只测装配路径。初值全部标注「待 harness 校准」，观测期只观测不卡发布（D2）。
4. 【事实】D5 五件套各有明确落点：平坦 BM25+IDF（FTS5 内置 `bm25()` + trigram/LIKE 回退，§4.4）、类型化轻卡零正文（§3.2）、`source_anchor` 锚真源经历 id、事件 UID 仅作解析缓存（§3.2/§4.7）、槽位制窗口（§4.8）、离线 sampled provenance 审计（§6.7）。生产 `dependencies` 维持 `{}` 现状（【事实】`package.json` 现为 `"dependencies": {}`），全部能力用 Node ≥22 内置 `node:sqlite`/`node:crypto` 实现，无需新增依赖（论证见 §1.4）。
5. 【建议】提交划分为 6 个离线提交 C1–C6（§9），每个提交自带测试与验证命令、不混入任何实时链路文件；实现期自证（§11）含临时目录隔离、真值只读（chmod 0500 反证）、12 项变异/反证测试与可独立运行的命令清单，供主 agent 逐项核对。回滚方式为停用并删除独立目录，内核零迁移、零残留影响（§12）。

---

## 1. 范围与边界

### 1.1 做什么 / 不做什么

【事实】本期范围严格对齐《落地分析》§3.1 六工作块判定与 D1–D5（`docs/memory-book-index-review.md` 附录 E.6）。

| 类别 | 内容 |
|---|---|
| 本期做（in） | ① 独立选择索引投影（零正文轻卡 + 三类线索字段 + 权重观测列）；② 离线构建器（只读真源/事件、指纹、幂等、原子换文件、迁移账本）；③ 平坦 BM25+IDF 检索与近因先验（参数观测化）；④ 槽位制窗口装配纯函数；⑤〔已下线，见文首 2026-11-12 裁决〕原 10 个 ready 事件的人工/半自动种子卡流程，由后续 #42 自动建卡取代；⑥ 离线评测 harness（金标、DRM 诱饵、自我一致性探针、holdout、provenance 抽样）与漏召埋点表结构；⑦ 三个离线 CLI 脚本 |
| 本期不做（out） | 实时对话链路接线与门面原语；写 append-only 真源或事件二级真源；erase 删除闭包（D4 仅做账本格式预对齐）；P8 judgment_ledger；向量/embedding、图库；常驻调度器/tick；在线校验器；运行时自动建卡/LLM 静默改写；叙事线实体倒排等演进项实现；三端/看板；媒体层 |
| 物理边界 | 只允许写 `projection/memory-index/` 与测试临时目录；`projection/fasti.sqlite`、`state/checkpoint.json`、`experiences/`、`events/`、`raw-turns/`、`channels.json` 对新模块只读（且实现上构建器根本不打开 fasti.sqlite，只读取 JSONL 真值，见 §4.6） |

【建议】out 清单中的演进项不在代码里留半成品抽象，只在本文 §10 登记表里写明触发条件；YAGNI，禁止「先建空表/空接口占位」（对应《落地分析》K9 概念满铺）。

### 1.2 现状基线（re-grounding 实测，2026-11-11）

【事实】以下均为本方案引用的当前代码事实，行号基于 HEAD `eafe484`：

- 测试规模：42 个 `*.test.ts`、517 个 `it/test` 用例；`src/` 共 12417 行。工作树干净。
- 数据根布局函数：`src/source/paths.ts:72-83`（`layoutOf` 给出 rawTurns/experiences/events/projection/state 等目录）；L1 库路径 `src/projection/detect.ts:50-51`（`path.join(projectionDir, 'fasti.sqlite')`），L2 目录为同级 `l2/`（`detect.ts:56`）。
- 现有四表：`experience`、`experience_fts`（FTS5 trigram）、`edge`（双时间四字段 `valid_ms/invalid_ms/created_ms/expired_ms`，DDL `src/projection/schema.ts:19-48`）、`event`（只存当前态+version，数组字段 JSON 文本，`src/projection/event-schema.ts:14-42`）。
- 原语契约 15 个名称见 `src/contract/primitives.ts:52-68`，其中 `ingestMedia/preserveMedia/getMedia/queryEntity` 抛 NotImplementedError（`primitives.ts:73`）；事件侧读原语 `queryEvents/getEvent/queryEventViews/listEventVersions` 与修正原语已在门面实现（`src/api/index.ts:925-1071`）。
- P1 修复后的接线事实：切分器 `resyncAfterCorrection()`（`src/event/segmenter.ts:278-286`）与 `deriveOpenStateFromLog()`（`segmenter.ts:292` 起）为五个修正入口统一复用，门面在 `api/index.ts:997/1007/1021` 等处调用；#36 组合原语 `closeAndReopenEvent` 在 `api/index.ts:1046`，设计依据 `docs/b-block-event-layer-design.md` §7.1.2（行 533-545）。
- P2 写边界修复：`parseExperience` write 模式走顶层字段白名单与递归红线检查（`src/contract/validate-experience.ts:73` 的 `assertKnownFields`、`:402-409` 红线调用）。
- 事件折叠可复用现成纯函数：`foldCurrentEvents`（`src/projection/event-row.ts:88`）、`toEventProjection`（同文件:53），新模块不得另写折叠逻辑。
- 实测数据：`events/2026-11.jsonl` 272 个版本行折叠为 10 个当前态事件，全部 `closed/ready`，指针数区间 2–51；`experiences/2026-11.jsonl` 252 行全部 `kind='dialogue'`，initiation 分布 her=115/user=103/environment=34；`state/checkpoint.json` 为 version1、tick=251、engine=L1、degraded=false、needs_rebuild=false、pending_events=0。
- 脚本纪律先例：`scripts/backfill-events.ts` 头部已立「默认试运行、`--apply` 才真写、沙箱临时目录、记录本只读、复用既有组件」四条属性，本方案三个 CLI 原样继承该风格。
- 测试基建可复用：`tests/helpers.ts:14-48` 提供 `makeTempRoot/cleanupTempRoot/withTempRoot`，另有 `listTree`（:68）、`countLines`（:88）；QA 类测试目录先例为 `tests/qa/qa-independent*.test.ts`。

### 1.3 命名与落点总览

【建议】文件名与模块名开工确认如下（沿用 docs 的 kebab-case 与 `*-plan.md` 后缀风格，对齐 `stage4-dsh-adapter-plan.md`）：

- 本方案文件：`docs/memory-v1-offline-scaffold-plan.md`（即本文件）。
- 新顶层模块目录：`src/memory/`（与 `src/projection/` 平级；它构建的是投影，但独立成模块以保证离线提交不触碰现有投影/实时代码，隔离测试见 §11 M6/M9）。
- 新数据落点：`<dataRoot>/projection/memory-index/`，含 `memory-index.sqlite`、`revisions.jsonl`、`decisions.jsonl` 三个文件（schema 与账本见 §3）。
- 新脚本：`scripts/build-memory-index.ts`、`scripts/run-memory-audit.ts`（`scripts/seed-memory-cards.ts` 人工建卡 CLI 已下线删除，见文首 2026-11-12 裁决）。
- 新测试：`tests/memory/` 下 8 个单测/集成测试文件 + `tests/qa/qa-memory-harness.test.ts` + `tests/fixtures/memory/` 金标夹具（完整清单见附录 A）。

### 1.4 依赖论证：生产 dependencies 维持空

【事实】`package.json` 当前 `"dependencies": {}`，仅有 devDependencies 中的 typescript 与 @types/node，peerDependencies 为宿主既有 cordis/dsh-llm。

【建议】本方案不新增任何 dependency/devDependency，理由：①存储用内置 `node:sqlite`（`DatabaseSync`，现有 L1 已验证可用，导入先例 `src/projection/sqlite.ts:13`）；②哈希用内置 `node:crypto`；③BM25 排序用 FTS5 内置 `bm25()` 聚合，trigram 分词器与现有 `experience_fts` 同款（`src/projection/schema.ts:33-35`）；④CLI 用 Node 22 类型剥离直跑（与 `scripts/backfill-events.ts` 相同运行方式）。若实现期发现某项能力内置库确实无法满足，必须单独提变更申请并在本文件追加论证，禁止顺手装包。

---

## 2. 设计基线、目标函数与指标

### 2.1 D1–D5 到本方案章节的映射

【事实】D1–D5 权威表述在 `docs/memory-book-index-review.md` 附录 E.6，映射如下，实现期不得偏离：

| 决策 | 要点 | 本方案落点 |
|---|---|---|
| D1 极薄选择索引投影 | 零正文、`source_anchor` 锚真源经历 id；selection+权重+display_cues/retrieval_aliases/discriminator 三类线索；可重建可回填、受删除闭包约束；禁并入 event 投影、禁独立完整记忆卡 | §3.2 `mem_card`；§4.6 构建器；§10 禁止项 |
| D2 先观测后硬阈值 | 占位红线只观测不卡发布；预算用结构性表达（700 字、至多一轮补取、P95 只测装配） | §2.2/§2.3；§6 测量协议；§4.8 |
| D3 叙事线与检索并列 | 第一人称仅限 `initiation='her'` 的 reflection；自我一致性探针一等化 | §4.8 槽位身份约束；§6.4 探针（v1 空置规则） |
| D4 台账方案② | 只存指针+内容哈希+模型版本+理由；双台账（内容台账随卡 tombstone、审计台账不可删）；删除闭包规范先于 P8；漏召埋点只存规范化词/哈希 | §3.4/§3.5；§4.10；erase 本期不实现 |
| D5 v1 五件套 | 平坦 BM25+IDF+近因先验、类型化轻卡锚真源无正文副本、source_anchor+事件 UID 缓存、槽位制窗口、离线 sampled provenance 审计；演进项数据触发 | §4.4/§3.2/§4.7/§4.8/§6.7；演进项登记 §10 |

### 2.2 目标函数与三条质量红线

【建议】正式表述（写入 harness 报告抬头与代码常量注释）：

> 在约束（工作窗口 ≤ 700 字、每轮补取 ≤ 1 次、装配路径 P95 延迟预算见 §2.3）下，最大化记忆选择与装配的质量；质量由三条红线度量。阈值是观测期经验初值，harness 未校准前不构成发布门禁、不写进任何自动拦截逻辑。

| 红线 | 定义（可计算口径） | 经验初值 | 测量方法（详见 §6） |
|---|---|---|---|
| R1 证据召回率 | 金标回放中，目标事件出现在检索 top-k（默认 k=3，可配）的比例；按冷启动分层分别报 | ≥ 0.85 | 时间切分金标回放，§6.1/§6.2 |
| R2 错误事件认定率 | DRM 诱饵对等近邻判别场景下选错卡的比例；其中强断言/承诺/日期/原话/否定五类高危断言错误率单独统计 | 总 ≤ 0.05；五类高危趋近 0（初值即 0 容忍，观测计数） | 诱饵探针 + provenance 抽样，§6.3/§6.7 |
| R3 叙事自我一致性 | 跨时间同主题提问对，装配线索支持的回答不互相矛盾的比例 | ≥ 0.8 | 自我一致性探针，§6.4；v1 无叙事线时按 N/A 规则空置，不许造数 |

【事实】D2 同时要求预算是结构性表达而非可调常数：700 字硬顶来自评审拍板（E.6），「单轮至多一轮补取」「P95 只测装配路径（不含宿主 LLM 网络耗时）」同为结构约束。

【建议】近因先验的衰减参数（§4.4 的 λ、半衰期）不是红线、也不允许拍脑袋固化：在 `bm25.ts` 中以具名常量给出经验初值并注释「观测值，harness 网格扫描后凭数据修订，修订走 §3.4 账本留痕」，harness 每期输出参数敏感性表。

### 2.3 指标体系与写侧 ROI

【建议】全部指标由离线 harness 计算并落 `mem_audit_run/mem_audit_item`（§3.2），运行时本期不采集、不上报（对齐 K13 无默认遥测）。

- 检索侧：R1 召回率（整体 + 冷启动/她引发/用户引发分层）、MRR、top-k 命中分布、零结果率、短词（<3 字符）回退命中率。
- 装配侧：窗口平均占用字数/700、保底槽触发率、补取轮触发率、装配 P95 毫秒数（纯本地函数，固定机测，记录 Node 版本与机器口径）、完整回合保持率（被裁回合数=0 的比例）。
- 质量侧：R2、R3、provenance 解析成功率（窗口内每张卡的 anchor 能被只读路径解析的比例，必须 100%，否则计缺陷）。
- 写侧 ROI（D 块成本意识，给位置不卡阈值）：单卡写入成本 = 人工分钟数 + 模型调用 token 估算 + 耗时（记于 `decisions.jsonl`）；卡生命周期命中 = `mem_card.hit_count/last_hit_ms`（v1 由离线回放与未来运行时只读装配回填，本期回放模拟）；派生指标「每次有效召回的写侧成本」= 累计写侧成本 / 累计命中卡次。harness 报告给数，不做自动淘汰（自动淘汰属演进项，§10）。

---

## 3. 独立投影：文件布局与表结构

### 3.1 目录与文件

【建议】构建器在 `layoutOf(root).projection` 下新建独立子目录（目录推导复用 `src/source/paths.ts:72-83` 的布局，不新增数据根解析规则）：

```
<dataRoot>/projection/memory-index/
├── memory-index.sqlite      # 选择索引库（表见 §3.2），原子 tmp+rename 落盘
├── revisions.jsonl          # 迁移/构建账本（append-only，§3.4）
└── decisions.jsonl          # 建卡/选择决策台账（append-only，D4 格式，§3.5）
```

【事实】该目录与 `fasti.sqlite`、`l2/` 平级、互不引用；构建器只以只读方式读 `experiences/`、`events/` 的 JSONL（复用 `src/projection/event-row.ts:88` 的折叠纯函数），不打开 `fasti.sqlite`、不读写 `state/`，因此即使宿主实例正在运行也不存在第二个写实例争抢（单实例纪律与验证见 §11）。

### 3.2 SQLite 表结构（照施工粒度 DDL）

【建议】新文件 `src/memory/schema.ts` 导出下列 DDL 常量与 `EXPECTED_*` 校验数组，风格对齐 `src/projection/schema.ts:19-96`（一表一常量 + 期望列数组供测试核对）。schema 版本从 1 起，迁移机制走 §3.4，禁止 ALTER 原地改历史行。

```sql
-- 0) 库内元信息（单行演进为键值表，stamp 与 revisions 账本对应）
CREATE TABLE IF NOT EXISTS schema_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL);

-- 1) 轻卡主表：零正文。禁止出现 summary/body/raw_text/emotion/mood/importance/session 等列（守门测试 M6）
CREATE TABLE IF NOT EXISTS mem_card(
  card_id            TEXT PRIMARY KEY,           -- 确定性派生 id，见 §4.6 公式
  event_id           TEXT NOT NULL,              -- 解析缓存（D.3：事件 UID 仅缓存，真锚点看 anchor_json）
  anchor_json        TEXT NOT NULL,              -- JSON 字符串数组：event.anchors 快照（真源经历 id 列表），权威锚点
  channel            TEXT NOT NULL,
  card_type          TEXT NOT NULL DEFAULT 'event',  -- 类型化轻卡；v1 仅 'event'，CHECK 约束取值域
  selection          TEXT NOT NULL DEFAULT 'selected', -- v1 仅 selected；预留 excluded 不建流程
  weight             REAL NOT NULL DEFAULT 0,    -- 观测列，初值中性 0；CHECK(weight BETWEEN 0 AND 1)
  display_cues_json  TEXT NOT NULL,              -- JSON 数组，1..3 个规范化短线索，json_array_length BETWEEN 1 AND 3
  aliases_json       TEXT NOT NULL DEFAULT '[]', -- JSON 数组 [{term, source, sensitive}]，与 mem_alias 同源快照
  discriminator      TEXT NOT NULL,              -- 消歧短句，码点长度 <=40，只写区别性信息不写叙事
  entity_hint_json   TEXT,                       -- v1 恒 NULL；实体倒排演进项预留，不允许填值（CHECK 为空或 NULL）
  occurred_ms        INTEGER NOT NULL,           -- 取自事件 time_range 起点
  ended_ms           INTEGER NOT NULL,
  valid_ms           INTEGER NOT NULL,           -- 双时间：选择索引内部失效管理（§3.3），不回写 edge 表
  invalid_ms         INTEGER,                    -- NULL=仍有效
  created_ms         INTEGER NOT NULL,
  expired_ms         INTEGER,                    -- 行作废时刻（tombstone 记账用），NULL=未作废
  status             TEXT NOT NULL DEFAULT 'active', -- active / invalid / superseded
  content_hash       TEXT NOT NULL,              -- 锚点+线索字段规范化后的 sha256，幂等与账本核对用
  hit_count          INTEGER NOT NULL DEFAULT 0, -- 写侧 ROI 观测列，v1 仅离线回放更新
  last_hit_ms        INTEGER,
  schema_version     INTEGER NOT NULL DEFAULT 1,
  CHECK (card_type IN ('event')),
  CHECK (selection IN ('selected','excluded')),
  CHECK (status IN ('active','invalid','superseded')),
  CHECK (entity_hint_json IS NULL),
  CHECK (length(discriminator) <= 40));
CREATE INDEX IF NOT EXISTS idx_memcard_event ON mem_card(event_id);
CREATE INDEX IF NOT EXISTS idx_memcard_time ON mem_card(occurred_ms);
CREATE INDEX IF NOT EXISTS idx_memcard_status ON mem_card(status, invalid_ms);

-- 2) 卡的 FTS：索引文本仅由 display_cues + 活跃 aliases 拼成，绝无正文/摘要
CREATE VIRTUAL TABLE IF NOT EXISTS mem_card_fts USING fts5(
  card_id UNINDEXED,
  cue_text,
  tokenize='trigram');

-- 3) 别名词表（词级命中统计与漏召回填用；与卡内 aliases_json 保持同一数据源）
CREATE TABLE IF NOT EXISTS mem_alias(
  term_norm   TEXT NOT NULL,                    -- 规范化词（小写/全半角/空白折叠），不存原始问句
  card_id     TEXT NOT NULL,
  source      TEXT NOT NULL,                    -- 仅 miss（2026-11-12 收窄：原 seed/manual 人工来源已下线，见文首裁决）
  sensitive   INTEGER NOT NULL DEFAULT 0,      -- 隐私标记：1 则不进 FTS 文本、仅精确匹配可用
  status      TEXT NOT NULL DEFAULT 'active',  -- active / tombstoned
  created_ms  INTEGER NOT NULL,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_ms INTEGER,
  PRIMARY KEY (term_norm, card_id),
  CHECK (source IN ('miss')),
  CHECK (sensitive IN (0,1)));
CREATE INDEX IF NOT EXISTS idx_alias_card ON mem_alias(card_id);

-- 4) 漏召观测（D4/D.7：只存规范化词/哈希+锚点+时间+统计，永远不存原始查询全文）
CREATE TABLE IF NOT EXISTS mem_miss(
  id                 TEXT PRIMARY KEY,          -- ULID（离线生成，沿用真源 ULID 同库工具）
  term_norm          TEXT NOT NULL,
  term_hash          TEXT NOT NULL,             -- sha256(term_norm)
  channel            TEXT NOT NULL,
  anchor_event_id    TEXT,                      -- 当时窗口上下文事件，可空
  anchor_json        TEXT,                      -- 上下文经历 id 快照，可空
  returned_count     INTEGER NOT NULL,          -- 当次检索返回数（0=纯漏召）
  observed_ms        INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_miss_time ON mem_miss(observed_ms);
CREATE INDEX IF NOT EXISTS idx_miss_hash ON mem_miss(term_hash);

-- 5/6) 离线审计运行与条目（harness 产出，观测-only）
CREATE TABLE IF NOT EXISTS mem_audit_run(
  run_id TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  sample_n INTEGER NOT NULL,
  probe_set_version TEXT NOT NULL,             -- 金标夹具版本
  model_tag TEXT,                               -- 回放所用规则/模型版本标识（统一 'rules-v1'；人工 'human' 标记已下线）
  metrics_json TEXT NOT NULL,                   -- §2.3 全量指标快照
  notes_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS mem_audit_item(
  run_id TEXT NOT NULL,
  item_no INTEGER NOT NULL,
  probe_type TEXT NOT NULL,                     -- gold / decoy / consistency / provenance
  expected_ref TEXT,
  returned_refs_json TEXT NOT NULL,
  passed INTEGER NOT NULL,                      -- 0/1；N/A 项不写本行、只在 run.notes 计数
  detail_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, item_no),
  CHECK (probe_type IN ('gold','decoy','consistency','provenance')),
  CHECK (passed IN (0,1)));
```

【事实】禁列纪律的代码依据：现有真源冻结能力清单 `src/contract/frozen-surface.ts:78-101` 已静态禁写情绪/重要度等能力；新表在其之外再加一层 schema 文本守门测试（§11 M6），任何 PR 向上述 DDL 加入正文副本、情绪数值、session 字段即测试失败。

【建议】零正文的判定口径写进 DoD：`mem_card` 任何文本列都不得包含事件 `summary/key_points/topic_lines` 原文或经历 `raw_text`；discriminator 与 cues 是人工/半自动产出的线索词，长度与来源受限，且每条都能经 anchor 回到真值核验。

### 3.3 双时间与纯函数失效（吸收 Graphiti，不照搬双时间列扩张）

【事实】`edge` 表已具备双时间四字段但当前 `invalid_ms/expired_ms/confidence` 恒 NULL（`src/projection/schema.ts:38-48`）；《落地分析》§3.2 要求 v1 失效逻辑先在选择索引内做轻量版，edge 表继续恒 NULL。

【建议】`src/memory/invalidate.ts` 只暴露**无 LLM、无 I/O 的纯函数**，规则表驱动（Graphiti 核心吸收点：失效是日期窗/锚点重叠的确定性函数，调研卡片见 `docs/chat-memory-frameworks-survey.md` Graphiti 节，基线 commit e911422）：

```ts
export type InvalidationReason =
  | 'anchor-superseded'      // 锚点事件被 merge/split 修正，按 merged_into/拆分组接力
  | 'duplicate-selection'    // 同一 anchor 集合出现第二张 selected 卡（构建期幂等拦截为主）
  | 'alias-conflict'         // 确定性规则：同 term_norm 指向两张 active 卡且 discriminator 无法区分
  | 'manual-tombstone';      // 她经 tombstone-card 决策显式作废（decisions 留痕；reasonCode 保留，原“种子流程”措辞已随 seed 下线，见文首裁决）

export interface InvalidationInput {
  card: MemoryCard;
  atMs: number;
  eventChange?: { kind: 'merged' | 'split' | 'reopened'; successorEventIds: string[] };
  aliasTable: readonly AliasRow[];
}
export interface InvalidationResult {
  status: 'active' | 'invalid' | 'superseded';
  invalidMs: number | null;
  reason: InvalidationReason | null;
  successorCardHints: string[]; // 仅给事件 id 提示，不自动迁卡
}
export function evaluateInvalidation(input: InvalidationInput): InvalidationResult;
/** as-of 谓词，与 edge 三条件同构：valid<=T 且 (invalid IS NULL 或 invalid>T) 且 created<=T */
export function isEffectiveAt(card: MemoryCard, atMs: number): boolean;
```

纪律：①函数只计算结果，写库由构建器在离线运行中统一执行并写 `decisions.jsonl`，实时链路无调用点；②事件被 merge 时不自动改卡——输出 successor 提示，按 B 块 §7.3「不自动改写记忆的指针」（`docs/b-block-event-layer-design.md:558-571`）等待她在后续复盘经 #42 自动建卡形成新决策（人工种子流程已下线，见文首裁决）；③`edge.invalid_ms` 本期保持恒 NULL，没有任何代码路径写它。

C3 裁决补充口径（G7–G11，记录见 §11.6）：

- `eventChange.kind='reopened'` 与 merged/split 同判：`status='superseded'`、`reason='anchor-superseded'`、`successorCardHints` 原样给 `successorEventIds`、不自动迁卡。依据：构建器只收 closed+ready（§4.6②），reopen 后事件退出卡来源，旧卡待下次离线种子流程人工重确认。
- `duplicate-selection` 本期**不在** `evaluateInvalidation` 纯函数内判定（恒不触发该 reason）：维持原注释「构建期幂等拦截为主」，由 builder 的确定性幂等（`deriveCardId`，§4.6）保证同 anchor 集合不产生第二张 selected 卡；`InvalidationInput` 不增字段（不扩冻结入参）。六类表驱动中该类以构建期拦截口径在 builder 侧测试覆盖。
- `manual-tombstone` 判据：`card.expiredMs !== null` 即判，`status='invalid'`、`invalidMs=card.expiredMs`（不取 atMs）。
- `alias-conflict` 可计算保守判据：`aliasTable` 中存在 `status='active'`、`termNorm` 相同（取自 `card.aliasesJson` 词集）、`cardId` 不同的行即冲突；「discriminator 无法区分」本期按恒成立处理（同词双卡即冲突，区分交她后续决策 / #42 自动建卡，无人工种子流程）。前置条件：`aliasTable` 由调用方保证只含 active 别名。
- 多 reason 优先级：`manual-tombstone` > `anchor-superseded` > `alias-conflict`；后两者 `invalidMs=atMs`，manual-tombstone 取 `expiredMs`；active 时 `invalidMs=null`、`reason=null`、`successorCardHints=[]`；`successorCardHints` 仅 eventChange 场景输出 `successorEventIds` 原样、不自动迁卡。

### 3.4 迁移/构建账本 revisions.jsonl（吸收 Cognee 最小四件套）

【建议】每行一个 JSON，append-only，字段固定如下（Cognee 双轨迁移的最小化吸收，调研基线 commit 8853378；禁止搬其 Alembic/图迁移重量设施）：

```ts
export interface RevisionRecord {
  revision: number;                 // 单调递增，1 起
  slug: string;                     // 动作标识：'schema-init' | 'build' | 'rebuild' | 'stamp'（'seed-apply' 已下线，见文首裁决）
  at_ms: number;
  schema_version: number;
  truth_fingerprint: string;        // 真值分片 sha256 的有序聚合哈希（experiences+events，含文件名）
  prior_revision: number | null;
  card_count: number;               // 本次落盘后 active 卡数
  alias_count: number;
  row_hash_sum: string;             // 全量 mem_card 规范化行哈希的聚合，幂等性核对用
  shadow_diff: { added: number; removed: number; changed: number }; // 影子库比对结果
  reason: string;                   // 触发原因（cli 参数/决策行 id）
  operator: 'offline-cli';          // 仅离线 CLI（'seed-workflow' 已下线，见文首裁决）
}
```

四件套对应：schema_version 入 `schema_meta`；append-only revisions 文件；每次构建先在临时库做影子 diff 再 stamp（写 `schema_meta.stamped_revision`）；卡片 id 与行哈希确定性派生保证重跑幂等（§4.6）。账本文件本身不可被构建器改写历史行，测试用 `countLines`（`tests/helpers.ts:88`）做前缀关系断言（方法学先例：backfill 脚本对事件分片的前缀自证）。

### 3.5 决策台账 decisions.jsonl（D4 格式预对齐，不是 P8）

【建议】每行记录一次选择/建卡/作废决策，**只存指针与哈希、不存正文**：

```ts
export interface DecisionRecord {
  decision_id: string;              // ULID
  at_ms: number;
  action: 'create-card' | 'update-cues' | 'tombstone-card' | 'add-alias' | 'invalidate';
  card_id: string | null;
  event_id: string;
  anchor_json: string;              // 经历 id 列表
  content_hash: string;             // 决策时锚点快照哈希
  model_tag: string;                // 规则/模型版本标识，统一 'rules-v1'（'human' 人工标记已下线，见文首裁决）
  reason: string;                   // 简短理由码+一句话，不复制原文
  created_by: 'her' | 'offline-operator';
}
```

【事实】D4 要求双台账：内容台账随卡 tombstone（由 mem_card.status 与 revisions 影子 diff 承担，卡可随删除闭包清理），审计台账不可删（本文件 append-only，永不被代码删除）。erase 与完整删除闭包本期不实现；`src/core/errors.ts` 的 DELETED 三态（present/deleted/never_existed）已为未来闭包预留，本方案不提前接线。

---

## 4. 工作块分解与接口签名

【事实】现有错误基类全集在 `src/core/errors.ts:19-123`（FastiError 及 SchemaError/NotFoundError/DeletedError/OutOfRangeError/IntegrityError/ConflictError/UnavailableError/NotImplementedError/CorruptedError）。新模块的错误类统一在 `src/memory/memory-errors.ts` 定义并继承这些基类，不自造错误码体系：`MemoryIndexStaleError extends CorruptedError`（真值指纹与 stamp 不符）、`MemoryAnchorDanglingError extends IntegrityError`（锚点解析不到真值）、`MemorySerialReferenceError extends NotFoundError`（候选序号越界）。

### 4.1 `src/memory/schema.ts`

- 输入：无（纯常量模块）。输出：§3.2 全部 `SQL_*` DDL 常量、`MEMORY_EXPECTED_TABLES/COLUMNS/INDEXES` 校验数组、`MEMORY_SCHEMA_VERSION = 1`。
- 复用风格：对齐 `src/projection/schema.ts:50-66` 的 MINIMAL_SCHEMA/EXPECTED 模式；建表在 store 打开时事务执行 `CREATE TABLE IF NOT EXISTS`。

### 4.2 `src/memory/types.ts`

【建议】定义并冻结下列接口（字段与 §3.2 列一一对应，注释标明单位与可空性）：`MemoryCard`、`AliasRow`、`MissObservationInput`、`AuditRunRecord`、`AuditItemRecord`、`RevisionRecord`（§3.4）、`DecisionRecord`（§3.5）、`SearchResultCard`、`CandidatePacket`、`SerialMap`、`WindowSpec`、`AssembledWindow`、`TruthFingerprint`、`SearchQuery`（C3 裁决 G1 增补，形状见下）。另导出常量类型：`CardType = 'event'`、`ProbeType = 'gold'|'decoy'|'consistency'|'provenance'`。

`SearchQuery` 冻结形状（C3 裁决 G1，记录见 §11.6；既有类型零改动）：

```ts
export interface SearchQuery { text: string; atMs: number; limit?: number; }
```

- `text` 为原始查询文本，规范化在检索函数内做（§4.4）；
- `atMs` 必填，是候选过滤与近因衰减的唯一注入时钟，检索函数内禁止 `Date.now()`；
- `limit` 可选、缺省不截断：top-k 是上层/harness 策略（§6.2 默认 k=3 由调用方传入），检索层不硬编码；
- `LAMBDA`/`HALF_LIFE_MS` 的覆盖不进 `SearchQuery`，作为 bm25 低层函数的独立可选 tuning 入参（§4.4），生产默认调用不传。

### 4.3 `src/memory/store.ts`（唯一持库柄，读写权限分柄）

```ts
export interface StorePaths { indexDir: string; }                    // 即 projection/memory-index/
export interface MemoryReadHandle {                                  // 未来运行时只拿只读柄
  getCard(cardId: string): MemoryCard | null;
  getCardByEvent(eventId: string): MemoryCard | null;
  search(query: SearchQuery): Promise<RankedCard[]>;                 // §4.4
  listEffective(atMs: number): MemoryCard[];
  verifyStampedFingerprint(current: TruthFingerprint): void;         // 不符抛 MemoryIndexStaleError
  close(): Promise<void>;
}
export interface MemoryWriteHandle extends MemoryReadHandle {        // 仅 builder 脚本可实例化（seed 脚本已下线，见文首裁决）
  transactionApply(changes: CardChangeSet, revision: RevisionRecord, decisions: DecisionRecord[]): void;
  recordMiss(input: MissObservationInput): void;
  writeAuditRun(run: AuditRunRecord, items: AuditItemRecord[]): void;
}
export function openMemoryRead(paths: StorePaths): MemoryReadHandle;
export function openMemoryWrite(paths: StorePaths): MemoryWriteHandle;
```

约束：①写柄不导出到 `src/memory` 之外的任何运行时模块（静态测试 M6 扫描 import 图）；②库文件以绝对路径打开，写入只允许发生在 `indexDir` 内（tmp 临时文件也在该目录，保证同盘 rename 原子）；③不封装任何指向 `experiences/events/raw-turns/state` 的写函数，从类型上杜绝越界。

C3 落地口径（裁决 G2，记录见 §11.6）：`search` 在只读实现类落地，委托 `bm25.ts` 导出的低层 `searchCards(db, query, tuning?)`；写柄经类继承获得该方法，写柄类不增加任何新逻辑，`openMemoryWrite` 单例、`transactionApply` 等写路径与工厂零改动。`bm25.ts` 只导出纯函数（规范化/近因评分）与接收库柄的低层检索，不自开连接，守住「唯一持库柄」。本批 authorized-changes 授权范围仅两个既有文件的最小改动：`types.ts` 仅新增 `SearchQuery`（其余零改动）；`store.ts` 仅 `MemoryReadHandle` 接口增 search 一行、只读实现类增委托方法及其 import。除这两个文件外其他既有文件零改动（`tests/contract/event.test.ts` 维持 C2 登记、不再触碰）。

### 4.4 `src/memory/bm25.ts`：平坦 BM25+IDF 与近因先验

【建议】零训练、零外部依赖的确定性检索：

1. 召回：查询词规范化（Unicode NFKC、ASCII 小写、空白折叠，复用 `src/projection/types.ts` 既有 `asciiLower` 同款口径）；≥3 字符走 `mem_card_fts MATCH` + FTS5 内置 `bm25(mem_card_fts)` 排序（IDF/长度归一由 FTS5 承担），<3 字符走 `mem_alias.term_norm` 精确/LIKE 回退——回退义务与现有 L1 同款（实测说明见 `src/projection/sqlite.ts:467-481`）。`sensitive=1` 的别名不进 FTS 文本，只在精确匹配路径命中。
2. 近因先验（纯函数、参数观测化）：`score = -bm25Raw + LAMBDA * recency(occurred_ms)`，`recency = exp(-ln2 * ageMs / HALF_LIFE_MS)`。具名常量初值 `LAMBDA=0.15`、`HALF_LIFE_MS=30*24*3600*1000`，常量注释强制标注「观测初值，凭 harness 敏感性表修订，修订记 revision」；两参数均可由函数入参覆盖以便网格扫描，生产调用不传参。
3. 平坦性：单层召回、无逐层路由（K10）、无查询分类器、无向量混排；返回 `RankedCard { card, scoreParts: {bm25:number; recency:number}; matchedTerms: string[] }`，分数构成可解释，provenance 审计直接消费 `scoreParts`。

C3 裁决补充口径（G12–G14，记录见 §11.6；低层入口 `searchCards(db, query, tuning?)`，tuning 为独立可选入参 `{ lambda?: number; halfLifeMs?: number }`，不进 `SearchQuery`，生产默认调用不传）：

4. 阈值与匹配单位：长度阈值按**规范化后**查询的码点长度测量（同 `MIN_TRIGRAM_LENGTH=3` 口径，`src/projection/sqlite.ts:39`）；v1 查询按单个规范化短语整串匹配——FTS 短语包裹 + 内部双引号转义（照 `src/projection/sqlite.ts:464-499` 先例），MATCH 后以 `matchesSubstring` 精确复核（trigram MATCH 是 ASCII 子串匹配的超集，L1 同款）；不做分词，分词列演进项。规范化后为空串的查询返回 `[]`（无检索意图）。
5. 回退路径：`mem_alias.term_norm` 精确（`term_norm = 规范化查询`）/LIKE（`%查询%`，转义 `\ % _` 并 `ESCAPE '\'`）；`sensitive=1` 别名只走精确路径，且精确路径对任意长度查询可达（FTS 文本恒不可见敏感词）。
6. 回退评分（G12）：回退路径 `scoreParts.bm25 = 0`、`score = LAMBDA * recency`，回退命中间按近因排序；FTS 路径 `scoreParts.bm25 = -bm25Raw`；`scoreParts.recency` 恒为 exp 衰减值本身，`ageMs = max(0, atMs - occurred_ms)`。M12 只断言两路径结果集合一致，不断言分数相等。
7. as-of 过滤（G13）：FTS/别名命中后按 as-of 三条件过滤候选，**直接复用** `invalidate.ts` 的 `isEffectiveAt` 纯函数（与 `listEffective` 同一 SQL 谓词同构，§3.3），禁止另写一套可能漂移的判定。
8. `matchedTerms` 定义（G14）：实际命中的规范化查询项/别名 `term_norm` 集合，返回卡的 `matchedTerms` 不得为空——FTS 路径为 `[规范化查询]`；精确路径为 `[term_norm]`；LIKE 路径为命中的别名 `term_norm` 集合（去重、按字典序确定性排列）。同卡同时经 FTS 与敏感精确命中时保留 FTS `scoreParts`，`matchedTerms` 取并集。
9. 排序与截断：score 降序；同分按 `occurred_ms` 降序、再按 `card_id` 升序（确定性 tie-break）；`limit` 在排序后截断，缺省不截断。

### 4.5 `src/memory/invalidate.ts`

接口与规则已在 §3.3 冻结；本块只补充测试矩阵：无变化/同窗冲突/跨窗接力/事件 split 一对多/alias 冲突/manual tombstone 六类表驱动用例，断言纯函数同输入必同输出、不触库。

### 4.6 `src/memory/builder.ts`：离线构建器

```ts
export interface BuildOptions {
  dataRoot: string;                 // 必填；测试传 tmp 根
  dryRun: boolean;                  // 默认 true；true 时所有产物落 os.tmpdir() 影子目录
  sinceRevision?: number;           // 缺省全量；增量只影响 diff 报告，结果仍全量比对
  nowMs?: number;                   // 测试注入时钟
}
export interface BuildReport {
  revision: number | null;          // dryRun 时为 null
  fingerprint: TruthFingerprint;
  shadowDiff: { added: number; removed: number; changed: number };
  cards: number; aliases: number; misses: number;
  danglingAnchors: string[];        // 非空即失败、零写入
  outputDir: string;
}
export function deriveCardId(eventId: string, anchorIds: readonly string[]): string; // 'mc_'+sha256(规范化串).slice(0,32)
export function buildMemoryIndex(options: BuildOptions): Promise<BuildReport>;
```

数据流要点：①经 `resolveDataRoot`（`src/source/paths.ts:41-49`）定位真值，只读打开 events/experiences JSONL，事件折叠调用 `foldCurrentEvents`（`src/projection/event-row.ts:88`），严禁另写折叠；②只收 `status='closed' AND summary_quality='ready'` 的当前态事件作为卡来源（现状即 10 个，§1.2），open/pending 事件不建卡；③`anchor_json` 直接取事件 `anchors` 字段快照，并逐个回查经历文件验证存在性，任何悬空锚点抛 `MemoryAnchorDanglingError` 且零产物；④真值指纹 = 对真值分片相对路径排序后逐文件 `sha256(字节)` 再聚合；⑤产物写 `memory-index.sqlite.tmp-<ulid>` 后 fsync + rename，影子 diff 来自与现有库（若有）的全量行哈希比对；⑥幂等 DoD：同真值同决策连跑两次，`row_hash_sum` 与全部 `card_id/content_hash` 逐行相等（不要求 sqlite 文件字节相同，因页分配可能非确定）；⑦dryRun 不触碰真实 `indexDir`，报告 outputDir 指向临时影子目录。

### 4.7 `src/memory/seed.ts` 与 `src/memory/serial.ts`：种子工作流与候选序号化

> 【已废止 · 见文首 2026-11-12 裁决】本节所述 `seed.ts` 半自动 worksheet、候选包与人工填卡工作流及其 CLI 已整体删除；下文 `buildCandidatePacket`/`applySeedWorksheet`/`CandidatePacket` 及 H3–H14 等仅作历史存档，不对应现存代码。**`serial.ts` 候选序号化反幻觉机制仍然保留**，是 #42 自动建卡的可复用资产；自动建卡方案见 `docs/memory-anchor-governance-and-auto-card-proposal.md`。

【建议】吸收 Mem0 候选序号化反幻觉教训（调研基线 commit f1791da；其历史问题是 LLM 引用无序候选产生幻觉锚点），在检索返回与建卡 worksheet 两侧统一协议：

```ts
// serial.ts：请求级私有映射，不落库、不跨请求复用
export type SerialMap = ReadonlyMap<number, string>; // 1..n -> card_id
export function buildSerialMap(cards: readonly RankedCard[]): SerialMap;
export function resolveSerials(map: SerialMap, picked: readonly number[]): string[]; // 未知序号抛 MemorySerialReferenceError
export function isSerialRefusable(e: unknown): boolean;                               // 供上层降级判定
```

降级纪律：上层（未来 C 块）捕获 `MemorySerialReferenceError` 后**允许重新检索一次**，第二次仍失败则本轮放弃记忆引用、如实不带卡，禁止猜序号、禁止用相近 id 顶替；离线 harness 用反证测试 M2 固化。

`seed.ts` 负责半自动 worksheet：`buildCandidatePacket(eventsReady)` 产出离线 JSON 工作表（含事件 id、anchors、key_points 供人工阅读——工作表文件只落临时目录、不进数据根），`applySeedWorksheet(path)` 校验人工填写的 cues/aliases/discriminator（长度、数量、敏感标记、词规范化），生成 `DecisionRecord[]` 并调写柄事务落库。任何 worksheet 字段都不允许把事件 summary 原文复制进卡（校验器做包含式反查：cue/discriminator 文本不得是 summary 的连续 ≥20 码点子串）。

C4 裁决补充口径（H3/H5–H10/H13，记录见 §11.7；既有类型零改动，CandidatePacket/CandidatePacketRow 维持 C1 冻结形状）：

冻结签名（入参用 `EventProjection`，来自 `src/projection/types.ts:74`；折叠与 closed+ready 过滤在 CLI/编排层复用 `foldCurrentEvents`，本函数只做纯映射）：

```ts
// 纯函数、无 I/O：EventProjection(snake_case) → CandidatePacketRow(camelCase)；
// rows 排序定死 started_ms 升序 → id 升序；人工字段 displayCues/aliases/discriminator 留 undefined。
export function buildCandidatePacket(
  eventsReady: readonly EventProjection[],
  truthFingerprint: TruthFingerprint,
): CandidatePacket;

export interface SeedApplyOptions {
  worksheetPath: string;   // 人工填好的 CandidatePacket JSON 文件
  dataRoot: string;        // 必填（临时根纪律）
  dryRun?: boolean;        // 缺省 true：只校验零写入
  nowMs: number;           // 必填，唯一 apply 时钟，CLI 边界注入；函数内禁 Date.now/new Date
  elapsedMs?: number;      // H13 测量透传：CLI 进程启动→apply 确认差值，仅 CLI 边界测时
}
export interface SeedApplyReport {
  applied: boolean;        // dryRun=false 且校验通过才 true
  cards: number;
  aliases: number;
  decisions: number;
  revision: number | null; // dryRun 为 null
}
export function applySeedWorksheet(options: SeedApplyOptions): Promise<SeedApplyReport>;
```

- 分层（H3）：可测纯校验（行校验/词规范化/子串反查/H9 三关判定）抽成无 I/O 纯函数导出并表驱动单测；`applySeedWorksheet` 仅做读文件→纯校验→取写柄→事务的薄编排。文件缺失抛 `NotFoundError`、JSON 坏抛 `CorruptedError`（复用 `readFileStrict`/`parseJsonStrict`，`src/core/fsx.ts:50/110`）；校验失败整份拒绝零写入、抛 `IntegrityError` 且 message 带行号原因。不新增错误类，`memory-errors.ts` 零改动。
- 阈值（H5）：每条 cue trim 后非空、码点长度 ≤40、数量 1–3；alias 数量 0–5；discriminator ≤40 码点（trim 后非空）；卡初值 weight 统一 0，CandidatePacketRow 不设权重字段、禁止人工拍权重；任一超限/超量整份拒绝。
- 词规范化（H6）：复用 C3 冻结 `bm25.normalizeQuery`（NFKC+ASCII 小写+空白折叠，`src/memory/bm25.ts:38`）；规范化后为空拒绝；卡内规范化后重复 term 拒绝（mem_alias 主键 term_norm+card_id）；跨卡同词本期不拦截（交 invalidate alias-conflict 判定域）；source∈{seed,manual,miss}、sensitive∈{0,1} 按冻结枚举校验。卡 aliasesJson 与 mem_alias 同源存规范化 term。
- 正文子串反查（H7）：对每条 cue 与 discriminator，当 `[...text].length>=20` 且 `summary!==null` 且 `summary.includes(text)`（原始字面连续包含、不做规范化）即整份拒绝；方向固定「卡文本是 summary 的子串」；不足 20 码点跳过；summary 为 null 放行。测试须正反例。
- 陈旧守卫三关（H9）：①`packet.truthFingerprint===computeTruthFingerprint(dataRoot).aggregate`；②每行 eventId 仍在当前折叠 closed+ready 集且 row.anchors 与当前 event.anchors 深比较逐字一致；③anchors 逐 id 只读回查 experiences 存在性（builder.ts:275-285 同款），悬空抛既有 `MemoryAnchorDanglingError`。任一不过整份拒绝。卡 id 用当前 anchors 经 `builder.deriveCardId` 派生、contentHash 经 `builder.computeContentHash` 复用，禁止另写哈希/派生算法。
- 落账（H10）：revision slug='seed-apply'、operator='seed-workflow'，card_count/alias_count/row_hash_sum 取落库后全量，shadow_diff 对照 apply 前快照（added=新卡、changed=内容变化、removed=0），reason 记 CLI 旗标与决策行 id 摘要；decision 每行一条 action='create-card'、created_by='offline-operator'、model_tag='human'，anchor_json=当前 anchors 快照、content_hash=卡 contentHash。重复 apply 同一 worksheet 走主键 upsert + 账本 append-only（不拒绝不去重），随后 build 复算 shadowDiff=0 由 H9 与确定性派生保证。
- elapsed 透传（H13）：`elapsedMs` 为测量透传标量，不进入任何判定/校验/归并逻辑（与 G8 被否决的 otherActiveCards 改变失效输入域不同类）。若提供必须 `Number.isFinite && Number.isInteger && >=0`，非法整份拒绝抛 core 既有错误类。`decision.reason` 定死两种字面值之一：`elapsedMs===undefined` → `'seed-create'`；否则 `` `seed-create;elapsed_ms=<n>` ``（键名固定 elapsed_ms、等号后非负整数）；reason 守「不复制原文」，不夹带事件正文/原始查询/自由文本。undefined 分支只允许纯函数单测与非 CLI 调用；CLI 真写路径必须始终由边界测得并注入 elapsedMs，使每条落库 create-card 的 reason 含 elapsed_ms=<n>（测试固化 `/^seed-create;elapsed_ms=\d+$/`）。耗时口径照 §6.6 = CLI 进程启动→apply 确认时间戳差，仅 CLI 边界计时。
- 库柄与哈希复用（H3/H9）：旧库快照只读循 `builder.readExistingIndex` 先例（read-only DatabaseSync `SELECT *`，builder.ts:155/159；ReadHandle 无 listAll，不借 H1 给 store 加方法）；写仅经 `openMemoryWrite({indexDir})` + 既有 `transactionApply`，不新增写路径。逐行哈希 = `sha256(JSON.stringify(cardValues(card)))`（store.cardValues，store.ts:155；与 builder.ts:133 同式），row_hash_sum 复用 `builder.computeRowHashSum`，禁止另写哈希。

### 4.8 `src/memory/window.ts`：槽位制窗口（吸收 LlamaIndex waterfall）

```ts
export interface WindowSpec {
  hardCapChars: number;        // 不传默认 700（D2 结构常量，非观测值）
  maxRefetchRounds: 1;        // 字面量 1，类型层面固定
  startingCards: 3;           // 起点 3 卡 + 1 摘要位（摘要位 v1 留空常量）
}
export interface AssembledWindow {
  slots: ReadonlyArray<{ slot: 'guaranteed'|'recency'|'identity'|'relevance'|'obligation'; cardIds: string[] }>;
  totalChars: number;         // 码点口径，与真源 char_count 计数一致
  turnsWhole: boolean;        // 完整回合保持标记
  needRefetch: boolean;       // 至多一次；true 时带 reasonCode
  refetchReason?: string;
}
export function assembleWindow(candidates: readonly RankedCard[], spec?: Partial<WindowSpec>, identityEligible?: ReadonlySet<string>): AssembledWindow;
```

装配规则（具体到可测）：①槽位优先级 guaranteed（v1 空槽，仅保留接口与单测）→ recency → identity → relevance → obligation（v1 空槽）；②按优先级**降序装入、升序裁撤**，裁撤以卡为单位、卡内线索整组进退，保证 `turnsWhole`；③identity 槽只允许承载 anchor 事件中存在 `initiation='her'` 经历的卡（D3 第一人称纪律，数据现状 her=115 轮可支撑），user/environment 锚点不得进入身份槽；④`totalChars > 700` 时按裁撤顺序移除直到 ≤700，仍超限的单卡（极端情况）整体移出并置 `needRefetch=false`、记 reasonCode=`oversized-card`（卡本身超标是种子缺陷，harness 计数推动修卡而非放松预算）；⑤检索结果不足导致相关槽为空且无身份/近因卡时，`needRefetch=true, reason='empty-relevance'`，函数自身绝不二次检索（补取由未来调用方执行且仅一次）。摘要文本不进本函数：窗口只给 card_id 与预算占用，未来运行时凭只读柄+事件读原语现取摘要，杜绝正文副本（D.4 渲染缓存纪律）。

C3 裁决补充口径（G3–G6，记录见 §11.6）：

- identity 资格入参（G3 方案 A，方案 B 否决）：第三可选入参 `identityEligible?: ReadonlySet<string>` 为资格卡 cardId 集合，缺省 = 空集（identity 槽恒空）。资格数据源是经 `anchor_json` 经历 id 回查 experiences 的 `initiation='her'`，**不是** `event.anchors`；C3 不实现该回查（无运行时调用点），只定义入参契约并对「空集 / 显式集合」两种情形单测。不向已冻结的 `RankedCard` 加字段；window.ts 保持无 I/O 纯函数，不读 `event.anchors`、不写 `topic_lines`。
- 预算文本（G4）：每卡计入预算的文本 = 解析 `display_cues_json` 后 `[...displayCues, discriminator].join(' ')` 的码点数（`[...s].length`，与真源 `char_count` 同口径）；活跃别名 `term_norm` 属检索词表，不计入窗口预算。
- 起点与归槽（G5/G6）：`startingCards=3` 为首轮起点卡数，recency/identity/relevance 各至多 1 张起点；guaranteed/obligation v1 恒空；摘要位用具名空常量留痕、不占槽不占预算；`slots` 恒输出五槽。recency 槽 = `occurred_ms` 最大的 1 张；identity 槽 = 资格集内 `occurred_ms` 最大的 1 张且不得与 recency 重复；relevance 槽 = 其余候选按入参检索名次装入。
- 裁撤（G6）：裁撤顺序 obligation→relevance→identity→recency→guaranteed，槽内按装入逆序逐卡移出；卡为原子单位、卡内线索整组进退，`turnsWhole` 恒 true。单卡自身超预算时整体移出并置 `needRefetch=false`、`refetchReason='oversized-card'`；「相关槽为空且无身份/近因卡」置 `needRefetch=true`、`refetchReason='empty-relevance'`；两者同时成立时 oversized-card 优先（needRefetch=false）。

### 4.9 `src/memory/miss.ts`：漏召观测写入

【建议】`recordMiss(input)` 入参白名单只有 `termNorm/channel/anchorEventId/anchorIds/returnedCount/observedMs`；函数内部计算 `term_hash`，拒绝任何原始查询文本字段（类型里就不存在该字段，测试 M11 反证）。本期无运行时调用点，仅被 harness 与未来 C 块预留；CLI 提供 `scripts/build-memory-index.ts --replay-misses` 用回放方式从金标夹具灌观测数据验证表结构。

C4 裁决补充口径（H1/H2/H11，记录见 §11.7）：

- 命名与库柄（H1）：低层定名 `insertMissRow(db: DatabaseSync, input: MissObservationInput): string`（返回新行 id），避免与写柄类方法同名遮蔽自递归；写柄接口冻结方法名 `recordMiss(input): void` 不变（§4.3），`WriteHandle.recordMiss` 内部委托 `insertMissRow(this.require(), input)`。store.ts 仅增接口一行声明 + 委托实现 + import；只读柄/openMemoryWrite 单例/transactionApply/openMemoryRead 与工厂零改动。miss.ts 只导出纯函数/校验与接收库柄的 insertMissRow，不自开连接；store→miss 单向 import（miss 只依赖 core/errors、core/ulid、types，不反引 store），模块顶层仅字面量常量、零求值。
- 哈希与 id（H11）：`term_hash = sha256(termNorm)` 的 hex（全仓统一口径）；`id = ulid()`（core/ulid.ts:100）；`anchor_json = anchorIds===null ? null : JSON.stringify(anchorIds)`。
- 运行时严格白名单（H11）：`Object.keys(input)` 出现六字段（termNorm/channel/anchorEventId/anchorIds/returnedCount/observedMs）之外的键（如 rawQuery/text）即抛 `IntegrityError` 拒绝。字段校验：termNorm/channel 非空字符串、returnedCount 非负整数、observedMs 非负有限数、anchorEventId 为 string|null、anchorIds 为 readonly string[]|null。纯写入无检索，mem_miss 无 FTS（schema 冻结）。
- 纯函数单一口径（H2/H11）：导出纯 `validateMissInput(input): void` 与 `computeMissTermHash(termNorm): string` 供 dry-run 复用；`insertMissRow` 内部必须复用同一 validateMissInput，不得两套口径。
- M11 三层反证（H11）：类型层（`'rawQuery' extends keyof MissObservationInput` 编译期断言，tsc 守门）＋运行时 Object.keys 白名单拒收＋`PRAGMA table_info(mem_miss)` 列集冻结为 schema 既有八列；收尾包附「注入原始查询键/列必红→逐字节还原→回绿」变异证据。敏感 term 的 FTS 命中为空、精确命中正常。
- `--replay-misses <file>` 独立回放模式（H2）：file 为 `MissObservationInput` 的 UTF-8 JSON 数组，逐条过白名单校验。单独传入只做 dry-run 校验、打印将灌行数与 term_hash 集合摘要、零写入且不跑构建流；必须再加 `--apply`（且过该脚本既有二次确认 y/yes，`--yes` 仅跳过交互、预演先打印）才经写柄逐条 insertMissRow。幂等照 §6.5③：每行新 ulid、append-only、不去重，同输入重放行数倍增而 term_hash 集合一致。未传该旗标时构建流代码路径字节级不变（回归测试断言 dry-run/apply 报告与退出码不变）；脚本其余部分零改动。C5 金标夹具就位后同一旗标可直接灌夹具衍生观测文件。

### 4.10 `src/memory/audit/`：harness 逻辑层

【事实】六文件分两类：**四探针模块** `gold`/`decoy`/`consistency`/`provenance` 一一对应 `ProbeType` 四值（types.ts:13、schema.ts:121）；**两基建模块** `fixtures`（加载校验）/`metrics`（聚合 + 落库低层）。「五件套」是 §1 D5 方法论称谓（BM25/轻卡/锚点/窗口/provenance 审计），与文件数无关（I4，区分写明于 §9/§11.8）。

C5 裁决补充口径（I1–I16，记录见 §11.8）——冻结逐字签名如下。

**通用纪律.** 纯离线、无网络、不调 LLM（半自动模型只在种子 worksheet 阶段由宿主 glue 人工触发）；`search` 以注入回调传入且兼容 Promise（读柄 `search` 为 async）；`atMs` 必填、函数内禁 `Date.now`；随机源以 `rng` 入参注入、禁 `Math.random`；可测纯函数无 I/O 导出表驱动、编排薄层；复用 core `IntegrityError`/`NotFoundError`/`CorruptedError`，memory-errors.ts 零改动、不新增错误类。**I5 硬约束**：audit 六文件全文不得出现 `.anchors` 读取或 `anchors:` 形态（连注释亦避免 `anchors` 整词）——事件当前态折叠（`foldCurrentEvents`）、merge/split 接力映射、anchor 折叠当前态、冷启动判定、引发方分层一律在 `scripts/run-memory-audit.ts` 编排层完成，算成标量/Map/anchorJson 串/anchor id 数组后注入 audit 纯函数；provenance 只持 `card.anchorJson` 解析出的 id（命名用 `anchorJson`/`anchorId`/`anchorIds`，不访问 `EventProjection.anchors`，projection/types.ts:91）。audit 不 import 门面（I2/M6 规则②）、不反引 store（I1 单向 store→audit）；模块顶层仅字面量零求值。

```ts
// ── audit/metrics.ts：随机源 / bootstrap / 聚合 / 落库低层（I1-A/I8/I9/I12）──
import type { DatabaseSync } from 'node:sqlite';
import type { AuditRunRecord, AuditItemRecord } from '../types.ts';

export type Rng = () => number;                 // mulberry32 实例，返回 [0,1)
export const DEFAULT_RNG_SEED = 20261111;       // 具名常量种子（观测初值，写入 notesJson.rngSeed；校准后凭数据修订）
export const BOOTSTRAP_RESAMPLES = 1000;        // §6.1 结构常量
export const P95_REPEATS = 1000;                // I12 装配 P95 固定重复次数（编排层用）
export function mulberry32(seed: number): Rng;  // 确定性 PRNG，零依赖，同种子同输入逐字节一致

export interface RatioEstimate { point: number; ciLower: number; ciUpper: number; n: number; }
export interface NaEstimate { status: 'n-a'; reason: string; }   // 不填 0、不参与达标判定
// percentile 法：有放回重采样 resamples 次取 2.5%/97.5% 分位（v1 不做 BCa）；空数组→{0,0}
export function percentileCI(values: readonly number[], rng: Rng, resamples?: number): { ciLower: number; ciUpper: number };
export function ratioEstimate(indicators: readonly (0 | 1)[], rng: Rng): RatioEstimate;  // point=均值，CI 走 percentileCI

// §2.3 四组指标容器（比率类统一 RatioEstimate|NaEstimate；键名以本块为准。zeroResultRate/shortTermFallbackRate
// 需检索内部仪表，属运行时观测，C5 离线 MetricsJson 不含，留待实时阶段；其余 §2.3 指标按同构具名追加）
export interface MetricsJson {
  retrieval: {
    recallAtK: RatioEstimate | NaEstimate;      // k=3 主测
    recallAtK1: RatioEstimate | NaEstimate;     // 敏感性
    recallAtK5: RatioEstimate | NaEstimate;
    recallColdStart: RatioEstimate | NaEstimate;
    recallHer: RatioEstimate | NaEstimate;
    recallUser: RatioEstimate | NaEstimate;
    recallEnvironment: RatioEstimate | NaEstimate;
    mrr: number;
  };
  assembly: { avgWindowChars: number; guaranteedSlotRate: number; refetchRoundRate: number; turnsWholeRate: number; p95Ms: number; };
  quality: { r2: RatioEstimate | NaEstimate; r2HighRiskErrors: number; r3: RatioEstimate | NaEstimate; provenanceSuccess: RatioEstimate | NaEstimate; };
  roi: { perCardCost: number; expectedHitsPerThousand: number; costPerEffectiveRecall: number; };  // hit_count 仅模拟（I10）
}
export interface AggregateInput {
  gold: readonly GoldQuestionResult[];          // k=3 主测（见 gold.ts）
  goldK1: readonly GoldQuestionResult[];        // k=1 敏感性
  goldK5: readonly GoldQuestionResult[];        // k=5 敏感性
  decoy: readonly DecoyQuestionResult[];        // 见 decoy.ts
  consistency: ConsistencyResult;               // 见 consistency.ts
  provenance: ProvenanceResult;                 // 见 provenance.ts
  windows: readonly AssembledWindow[];          // 装配观测（window.ts 冻结类型）
  p95Ms: number;                                // 编排层 performance.now 测得（I12）
  roi: { writeCostMinutes: number; simulatedHits: number; cards: number };  // 写侧成本与模拟命中（I10，不回写卡）
}
export function aggregateMetrics(input: AggregateInput, options: { rng: Rng }): MetricsJson;

// 落库低层（I1-A：收库柄、不自开连接；store.ts 写柄 writeAuditRun 单事务委托此二函数）
export function insertAuditRun(db: DatabaseSync, run: AuditRunRecord): void;
export function insertAuditItem(db: DatabaseSync, item: AuditItemRecord): void;
```

```ts
// ── audit/fixtures.ts：金标夹具加载与版本校验（I3/I7）──────────────────────
export const PROBE_SET_VERSION_PATTERN = /^v\d+(\.\d+)*$/;   // 非空版本字符串
export type FixtureLayer = 'l0' | 'l1' | 'l2' | 'decoy';
export interface GoldL0Item {
  eventId: string; channel: string;
  queries: readonly string[];                   // 标准检索词 3–5
  aliases: ReadonlyArray<{ term: string; source: 'miss'; sensitive: 0 | 1 }>;   // source 已收窄为仅 miss（2026-11-12，见文首裁决）
  sensitiveTerms: readonly string[];
  discriminatorNeighborEventIds: readonly string[];
  expectedSlots: ReadonlyArray<'guaranteed' | 'recency' | 'identity' | 'relevance' | 'obligation'>;
}
export interface GoldL1Item {
  questionExperienceId: string; targetEventId: string;
  initiation: 'her' | 'user' | 'environment';   // system 已在编排层归并 environment（I16）
  coldStart: boolean;
}
export interface DecoyItem {
  pairCardIds: readonly string[]; discriminatorQuery: string; goldCardId: string;
  highRiskLabel?: 'strong' | 'promise' | 'date' | 'verbatim' | 'negation';
}
export interface LoadedFixtures {
  probeSetVersion: string;
  l0: readonly GoldL0Item[]; l1: readonly GoldL1Item[];
  l2: readonly GoldL1Item[];                    // holdout 与 l1 同形（提问轮）
  decoy: readonly DecoyItem[];
}
// 纯校验（表驱动）：版本正则/layer 枚举/条目形状/拒收任何正文字段（summary/body/raw_text 等）；坏夹具抛 core 基类
export function validateFixtureFile(raw: unknown, expectedLayer: FixtureLayer, fileLabel: string): void;
export function loadFixtures(fixturesDir: string): LoadedFixtures;   // 只读 gold-l0/gold-l1/holdout/decoy.json
```

```ts
// ── audit/gold.ts：R1 证据召回回放（I6/I16）────────────────────────────────
import type { SearchQuery, RankedCard } from '../types.ts';
export type SearchFn = (query: SearchQuery) => RankedCard[] | Promise<RankedCard[]>;
export interface GoldQuestion {
  queryText: string;                            // 原始问句（规范化在 search 内）；编排层从真值提取注入
  targetEventId: string; questionRef: string;   // questionRef=经历 id 或事件 id（detail 用）
  source: 'l0' | 'l1' | 'l2';
  initiation: 'her' | 'user' | 'environment'; coldStart: boolean;
}
export interface GoldQuestionResult {
  questionRef: string; targetEventId: string; resolvedEventId: string;   // 接力后当前态
  hit: boolean; rank: number | null;            // 1-based 位次，未命中 null
  scoreParts: { bm25: number; recency: number } | null;
  relayChain: readonly string[];                // 编排层注入的接力链（detail 留痕）
  initiation: 'her' | 'user' | 'environment'; coldStart: boolean; source: 'l0' | 'l1' | 'l2';
}
export interface GoldReplayOptions {
  atMs: number; k?: number;                     // k 缺省 3；敏感性 k=1/5 由调用方再跑
  relayMap: ReadonlyMap<string, string>;        // goldEventId→当前 eventId（编排层 foldCurrentEvents+successorCardHints 算得，I5/I16）
  relayChains?: ReadonlyMap<string, readonly string[]>;
}
export function replayGold(questions: readonly GoldQuestion[], search: SearchFn, options: GoldReplayOptions): Promise<GoldQuestionResult[]>;
```

```ts
// ── audit/decoy.ts：DRM 诱饵对生成与 R2（I6/I14）───────────────────────────
import type { MemoryCard } from '../types.ts';
import type { SearchFn } from './gold.ts';
export interface DecoyPair { cardId: string; neighborCardIds: readonly string[]; }   // 每卡 top2（不足取实际数）
export interface DecoyQuestionResult {
  goldCardId: string; topCardId: string | null; correct: boolean;   // top1 必须金标卡
  highRiskLabel?: 'strong' | 'promise' | 'date' | 'verbatim' | 'negation'; highRiskError: boolean;
}
// 共享集合纯函数：规范化 cue+alias term（复用 bm25.normalizeQuery）；Jaccard=|交|/|并|，空集对=0
export function cardTermSet(card: MemoryCard): Set<string>;
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number;
export function buildDecoyPairs(cards: readonly MemoryCard[]): DecoyPair[];   // 相似度降序→cardId 升序，纯确定性
export function scoreDecoy(items: readonly DecoyItem[], search: SearchFn, options: { atMs: number }): Promise<DecoyQuestionResult[]>;
// 防漂移：对等价 term 集合，buildDecoyPairs 的近邻序必须与 decoy 内置 Jaccard 实现一致（表驱动对照；原 seed.jaccardNeighbors 已随 seed 模块删除，见文首裁决）
```

```ts
// ── audit/consistency.ts：叙事自我一致性（I6/I9，v1 空置规则）──────────────
import type { AssembledWindow, AliasRow, MemoryCard } from '../types.ts';
export interface ReflectionPair { questionARef: string; questionBRef: string; }   // 跨时间同主题提问对
export interface ConsistencyResult {
  status: 'n-a' | 'evaluated'; reason?: string; pairs: number;
  consistent?: number; contradictory?: number;
}
export interface ConsistencyOptions { atMs: number; aliasTable: readonly AliasRow[]; cardsById: ReadonlyMap<string, MemoryCard>; }
export function consistencyPairKey(pair: ReflectionPair): string;   // `${questionARef}|${questionBRef}`（windowsByPair 键约定）
// 空样本→{status:'n-a', reason:'no-reflection-pair', pairs:0}（逐字，严禁填零造样）；
// 规则判定：两窗口卡经 evaluateInvalidation 无未决 alias-conflict 且 identity 槽卡一致→consistent
export function evaluateConsistency(
  pairs: readonly ReflectionPair[],
  windowsByPair: ReadonlyMap<string, readonly [AssembledWindow, AssembledWindow]>,
  options: ConsistencyOptions,
): ConsistencyResult;
```

```ts
// ── audit/provenance.ts：抽样溯源审计（I2/I5/I8，硬失败）──────────────────
import type { Pointer } from '../../contract/experience.ts';        // 契约层，M6 放行
import type { ResolvedPointer } from '../../contract/primitives.ts'; // 契约层，M6 放行
import type { MemoryCard } from '../types.ts';
import type { Rng } from './metrics.ts';
export type PointerResolver = (pointer: Pointer) => Promise<ResolvedPointer>;   // 必填、无缺省；内部只调回调
export interface ProvenanceOptions {
  rng: Rng; sampleRatio?: number;               // 缺省 0.2，按卡分层抽样（共用注入 rng）
  cacheDrift: ReadonlyMap<string, boolean>;     // cardId→缓存漂移（编排层 anchor 折叠当前态预计算，I5）
  ftsTextByCard: ReadonlyMap<string, string>;   // cardId→FTS cue_text（编排层只读 mem_card_fts 注入，溯源③）
}
export interface ProvenanceCardResult {
  cardId: string; anchorIds: readonly string[]; resolved: number; dangling: number;
  cacheDrift: boolean; ftsTraceable: boolean; ok: boolean;
}
export interface ProvenanceResult {
  total: number; sampled: number; results: readonly ProvenanceCardResult[];
  successRate: number; danglingCount: number; failed: boolean;   // successRate<1 || dangling>0 → failed（硬失败）
}
export function auditProvenance(cards: readonly MemoryCard[], resolver: PointerResolver, options: ProvenanceOptions): Promise<ProvenanceResult>;
// ①anchorJson 逐 id 经 resolver 解析（悬空计 dangling）；②cacheDrift 查注入 Map；③ftsTextByCard 词项须全部溯源到卡 cue/alias（零正文）
```

**store.ts 写柄增项（I1-A，authorized-changes，循 H1 同型）.** `MemoryWriteHandle` 接口增 `writeAuditRun(run: AuditRunRecord, items: AuditItemRecord[]): void;`（**逐字对齐 §4.3 第 373 行已冻结签名**，items 为 mutable 数组、非 readonly；一次调用单事务写 1 条 run 与其 items）；`WriteHandle.writeAuditRun` 委托 `insertAuditRun`/`insertAuditItem`（BEGIN→insert run→逐条 insert items→COMMIT，失败 ROLLBACK，循 transactionApply 事务模式）；import 增 `./audit/metrics.ts` 二低层函数与 AuditRunRecord/AuditItemRecord 类型。**只读柄/openMemoryRead/openMemoryWrite 单例/transactionApply/recordMiss/工厂零改动**；store→audit 单向、audit 不反引 store、顶层零求值。审计两表 DDL（schema.ts:99–123）与 AuditRunRecord/AuditItemRecord/ProbeType（types.ts:13/109–135）冻结零改动。

### 4.11 三个 CLI 脚本（继承 backfill 纪律）

【建议】脚本头部注释与参数风格对齐 `scripts/backfill-events.ts`（默认试运行、`--apply` 真写、`--data-root` 显式、`--json` 机器可读）：

| 脚本 | 职责 | 默认行为 |
|---|---|---|
| `scripts/build-memory-index.ts` | 全量/增量构建影子库并输出 diff；`--apply` 时 stamp 并原子换文件；`--replay-misses` 灌回放漏召 | dry-run，零写入 |
| `scripts/run-memory-audit.ts` | 跑全套探针、写 audit 表/打印 JSON 报告、打印三红线当期值与是否 N/A | 只读真值+写 audit（audit 写独立库，可 `--out <tmp>` 重定向） |

> 表中原有 `scripts/seed-memory-cards.ts` 人工建卡 CLI 已下线删除（见文首 2026-11-12 裁决），现存离线 CLI 仅 build 与 audit 两个。

C4 裁决补充口径（H2/H8/H12/H14，记录见 §11.7）：

> 【已废止 · 见文首裁决】以下从 `scripts/seed-memory-cards.ts` 旗标全集到 Jaccard 三时点表、`jaccardNeighbors` 的整段描述，均属已删除的人工 seed CLI 历史规格，保留仅为存档；当前代码中不存在该脚本与函数。

`scripts/seed-memory-cards.ts` 旗标全集（继承 build CLI 纪律逐条对齐）：

- `--data-root <目录>` 必填，缺省打印用法并退出码 2；`--json`/`--help` 同 build CLI；
- 默认生成模式（无 --apply-worksheet）：读真值→折叠 closed+ready→buildCandidatePacket；`--worksheet-out <tmp>` 写 worksheet JSON，缺省时不写文件、packet 打印 stdout（杜绝隐式落盘）；`--worksheet-out` 解析后若位于 dataRoot 之内则拒绝并退出码 2（工作表只落临时目录、不进数据根，§4.7）；
- `--apply-worksheet <file>`：默认 dry-run 只打印报告；加 `--apply` 才真写，二次确认 y/yes（`--yes` 跳过交互但预演报告先打印）——与 build CLI 同构；elapsed 仅 CLI 边界测时（H13）。

Jaccard 三时点打印表（H14，把 H12「仅生成模式」明确为「非 --apply 真写模式」）：

| 时点 | 行为 |
|---|---|
| ① 生成模式（worksheet 未填、--worksheet-out/缺省 stdout） | 允许调用 jaccardNeighbors；已填集为空时打印「无已填行」类空提示，不报错、不阻塞 |
| ② --apply-worksheet dry-run 预演（已填、真写前，§7 步骤 3/4） | 打印已填行 Jaccard 近邻对（该提示的主要落点） |
| ③ --apply 真写 | 不打印 Jaccard，保证真写输出与报告稳定可对账 |

纯函数 `jaccardNeighbors(rows)` 导出并表驱动单测：空集对=0、仅输出 >0 的对、相似度降序→eventId 对升序、不设阈值不截断；集合取规范化 cue + 规范化 alias term（规范化复用 bm25.normalizeQuery）。Jaccard 只进 stdout，不进 worksheet 文件、不进 CandidatePacket（冻结形状不加 neighbors 字段）。

`scripts/build-memory-index.ts --replay-misses <file>` 为独立回放模式（形状/幂等/回归保障见 §4.9）；未传该旗标时构建流字节级不变。

C5 裁决补充口径（I1-A/I2/I5/I11/I12，记录见 §11.8）：

`scripts/run-memory-audit.ts` 旗标全集与独立库纪律（继承 build CLI 风格）：

- `--data-root <目录>` **必填**，缺省打印用法并退出码 2；`--out <目录>` **必填**，缺省退出码 2；`--out` 解析后若**等于 dataRoot 或位于其之内**一律退出码 2（落根内守卫，从参数面杜绝误写生产索引）；`--json`/`--help` 同 build CLI；
- `--holdout` 缺省**不跑** L2，仅显式传入才解封 holdout 跑一次（§6.1）；`--dry-run` 只校验夹具/打印报告、**不落 audit 库**（CI 预检用）；
- 因写的是 dataRoot 之外的独立 `--out` 库、不触生产索引/真值，**默认即可写 audit 库，不需要 `--apply` 二次确认**（区别于 build）；
- **库柄纪律（I1-A）**：对 `--data-root` 恒以 `openMemoryRead` 只读打开（读真值 JSONL、卡、检索），**永不在该库取写柄**；写柄只开在 `--out` 指向目录（`openMemoryWrite`，以同一 `MEMORY_SCHEMA` 建库，卡/miss 表为空、仅审计两表落行）。**生产 memory-index.sqlite 在 C5 全程零字节写入**，真值 JSONL 从不写。builder 既有 `copyRows` 对 mem_audit_* 的搬运保持不动（兼容/防御，不在本批改）；
- **门面实例化（I2）**：`Fasti.open({ dataRoot })`（api/index.ts:254）只在本脚本与 tests/qa 出现，装配 resolver 注入 `auditProvenance`；src/memory/audit 不 import 门面。**resolver 翻译细节**：`card.anchorJson` 存的是经历 id，而门面 `resolvePointer` 按原文指针（raw turn event_id/shard/seq）解析，故编排层 resolver 先把经历 id 经只读真值映射到该经历的 `observation.text` 原文指针，再调 `fasti.resolvePointer(textPointer)`（经历不存在/无原文指针 → 抛 NotFoundError，provenance 计悬空）；audit 纯函数仍只调注入回调、签名不变；
- **编排层职责（I5）**：`foldCurrentEvents` 折叠当前态、merge/split 接力映射（复用 invalidate `successorCardHints`）、anchor 折叠当前态→缓存漂移 Map、冷启动判定、引发方分层（system→environment 归并）一律在本脚本算成标量/Map/anchorJson 串/anchor id 数组后注入 audit 纯函数；audit 六文件不读 `EventProjection.anchors`；
- **夹具定位**：默认读仓库相对 `tests/fixtures/memory/`（C5 合成夹具，I3）；qa 经程序化注入合成夹具目录/对象，不新增 CLI 旗标；
- **P95（I12）**：只测 `assembleWindow` 纯函数路径，`performance.now()` 仅在本编排层计时、固定重复 `P95_REPEATS=1000` 次取 P95，报告记 `process.version`/`process.platform`；纯函数内不计时；
- **退出码（I11/I13）**：provenance 硬失败（成功率<100%）/悬空锚点 → 非零；三红线观测项无论是否越线均 exit 0（红线只进报告、不卡退出码）；`--help`/无参/缺必填/落根内守卫 → 安全退出码（0 或 2）。

---

## 5. 数据流向

【建议】实现期按下列四条流布线，每条流的允许写入点是评审与测试的核对对象：

1. 离线构建流（无实时进程参与）：
   `experiences/*.jsonl + events/*.jsonl（只读）` → `builder.ts` 折叠/指纹/锚点校验 → 影子 sqlite（tmp）→ 影子 diff 对照旧库 → `--apply` 后 rename 为 `memory-index.sqlite` + 追加 `revisions.jsonl` 一行。任何一步失败：旧库保持在位、tmp 目录清理、出口码非零。
2. 〔已废止，见文首 2026-11-12 裁决〕原种子决策流（ready 事件 → `seed.ts` 候选 worksheet 人工/半自动填写 → 校验 → decisions 追加落卡）已随 seed 模块整体删除，当前无人工建卡数据流；其去向为 #42 自动建卡。
3. 未来运行时只读流（本期只实现函数不接线）：C 块检索请求 → `MemoryReadHandle.search` → `buildSerialMap` 私有序号 → `assembleWindow` 出引用与预算 → 调用方凭 card_id 经现有事件/指针读原语现取摘要原文注入 → 序号异常按 §4.7 降级。该流不产生对 memory-index 的写（hit_count 回填留待实时阶段另案评审）。
4. 漏召观测流（本期仅回放）：harness/未来 C 块 → `miss.recordMiss`（白名单字段）→ `mem_miss`；离线评审后经种子流把高频 norm term 提升为 alias（source='miss'），全过程无原始问句落盘。

【事实】四条流均不经过 `src/api/index.ts` 的写原语、不经过事件修正器与切分器；静态隔离测试（M6）断言 `src/api`、`src/event`、`src/source` 下不存在任何对 `../memory` 或 `../../memory` 的 import。

---

## 6. 评测 harness 设计

### 6.1 金标分层与小样本纪律

【事实】可用真值规模为 252 经历 / 10 ready 事件（§1.2），统计上属于小样本。【建议】金标分三层，夹具版本化存放 `tests/fixtures/memory/`，纳入 git（只含 id 引用与标注，不含正文副本）：

- L0 种子金标（10/10 覆盖）：对 10 个 ready 事件逐张人工标注：标准检索词 3–5 个、近义别名、敏感词标记、判别器近邻事件、应进入的窗口槽位。这是种子卡验收（§7）与 R1/R2 的基础集。
- L1 回放金标（从 252 经历挖）：规则初筛 + 人工确认「后文自发重提前文事件」的经历对（提问轮 → 目标事件 id），按引发方分层：她主动回忆（initiation='her'）/ 用户提问诱发 / 环境触发；冷启动样本定义为提问轮与目标事件间隔 >7 天且中间无同事件提及。
- L2 holdout（防过拟合的离线落法）：按时间轴**后 20% 日历周**的提问轮整体封存，构建器与卡调参过程禁止查看其标注，只在阶段评审时由 `run-memory-audit.ts --holdout` 解封存跑一次；holdout 的标注文件单独命名并在夹具 README 写明解封记录。样本不足以按周切分的极端情况（当前数据量可能触发），退化为留一事件交叉验证（LOEO，10 折），并在报告显式标注降级口径，不得伪装成独立 holdout。

【建议】所有比率类指标同时给点估计与 bootstrap 1000 次重采样的 95% 置信区间；区间跨红线时结论写「证据不足」而非达标/不达标。红线在 harness 校准前只出现在报告里，不进代码断言、不卡任何命令退出码（审计自身缺陷如悬空锚点除外，那是硬失败）。

### 6.2 R1 证据召回率测量协议

【建议】对每条金标提问：用提问轮规范化文本调 `bm25.ts` 检索（不使用任何未来信息），记录目标事件是否在 top-3、命中位次、scoreParts；分层汇总整体/冷启动/三引发方的 recall@3 与 MRR；同时跑 k=1/5 敏感性对照。判定目标事件以金标 `event_id` 为准；若金标事件后来被修正（merge/split），按 B 块 §7.3 接力规则映射到当前态后判定，并在 detail 记录接力链。R1 初值 0.85（§2.2）。

### 6.3 DRM 诱饵与 R2 错误认定率

【建议】decoy 探针自动生成：对每张卡，从其余卡中取 cue/alias 词面相似度最高的 1–2 张构成近邻对（相似度用规范化词 Jaccard，纯确定性），人工为每对补一条「只应命中其中一张」的判别提问（L0 阶段随种子金标一起产出）。harness 断言检索 top1 必须是金标卡，否则记一次错误认定；R2 = 错误数/诱饵提问总数，初值 ≤0.05。另设五类高危断言标签（强断言/承诺/日期/原话/否定），凡高危提问错误单独计数，初值目标 0、观测期出现一例即列入评审必修（不自动拦截发布，但名单不过夜）。「DRM 诱饵」的本意是防止错误记忆被当真：本探针只测选择与判别，不生成任何用户可见文本。

### 6.4 叙事自我一致性探针（R3，v1 空置规则）

【建议】探针结构先建：从金标中组织「跨时间同主题提问对」，比较两次装配窗口支持的卡集合是否互相矛盾（规则判定：两窗口的卡经失效函数评估不存在未决 alias-conflict，且身份槽卡一致）。v1 没有叙事线/实体投影，预期 reflection 对样本极少甚至为 0；此时 `mem_audit_run.notes` 记 `consistency: {status:'n-a', pairs:0}`，R3 不填数、不参与达标判定。待未来叙事线立项且样本 ≥20 对后启用 0.8 初值。禁止为凑指标把普通对话轮冒充 reflection 对。

### 6.5 漏召与隐私埋点的离线验证

【建议】用 L1 金标提问回放模拟零结果/错位结果，验证 `mem_miss` 落行：①字段白名单（M11 反证读库不得出现任何原始问句列）；②`term_hash` 可验、`term_norm` 只做规范化不做脱敏原文留存，敏感词经 L0 标记后其 norm 同样不入 FTS；③`--replay-misses` 幂等（同输入重放行数倍增但哈希集合一致）。隐私合规漏召的「只存规范化词/哈希」口径与 D4/D.7 一致，审计台账不可删由 revisions/decisions append-only 与前缀测试承担。

### 6.6 写侧 ROI 的测量位置

【建议】种子流程在 `decisions.jsonl` 记录每张卡的人工耗时（CLI 开始/确认时间戳差值）与模型 tag/token 估算（半自动路径由调用方显式传入，harness 不自行估算后默默写数）；`mem_card.hit_count` 由金标回放模拟累积（每次该卡在应命中提问的 top-k 即 +1），报告输出单卡成本、千轮预期命中、每次有效召回成本三张表。v1 不设自动淘汰阈值；「低命中卡清理」是演进项，触发条件登记 §10。

### 6.7 sampled provenance 审计（五件套之五）

【建议】每次 audit 按 20% 比例分层随机抽窗口装配结果（按卡分层、固定随机种子入 run 记录可复算），对窗口内每张卡执行：①`anchor_json` 每个经历 id 经门面只读路径可解析（`resolvePointer` 契约 `primitives.ts:262-263`，测试中用临时根真实实例）；②卡的 `event_id` 缓存与 anchor 折叠出的事件当前态一致，不一致即记「缓存漂移」缺陷；③FTS 命中词能回溯到具体 alias/cue 来源。成功率必须 100%，任一失败该 audit run 标记 failed（这是硬失败，区别于观测红线）。

### 6.8 C5 裁决补充口径（harness 观测纪律，I3/I7–I16，记录见 §11.8）

**RNG 与置信区间（I8，补 §6.1/§6.7）.** 自实现确定性 `mulberry32`（零依赖），具名常量种子 `DEFAULT_RNG_SEED=20261111`（写入 `notesJson.rngSeed` 可复算）；bootstrap 有放回重采样 `BOOTSTRAP_RESAMPLES=1000` 次、**percentile 法**取 2.5%/97.5% 分位（v1 不做 BCa）；同种子同输入逐字节一致，用「重复运行相等 + 小数组手算分位」表驱动反证；provenance 20% 分层抽样共用同一注入 `rng`。种子/算法属观测值，注释标明 harness 校准后凭数据修订。区间跨红线→结论「证据不足」（§6.1 原文）。

**指标容器与 N/A（I9，补 §2.3/§6.4）.** `metricsJson` 按 `retrieval`/`assembly`/`quality`/`roi` 四组（形状冻结见 §4.10 metrics.ts）；比率类统一 `{point,ciLower,ciUpper,n}`；N/A 项统一 `{status:'n-a',reason}`，**不填 0、不参与达标判定**。`notesJson` 记 `{consistency:{status,pairs}, holdout:{mode,folds,unsealedAt?}, rngSeed, sampleN, …}`。三红线只进报告、**不进代码断言、不卡命令退出码**；唯一硬失败是 provenance 成功率<100%/悬空锚点（I13）。consistency 空样本→`{status:'n-a',reason:'no-reflection-pair',pairs:0}`（§6.4 逐字），R3 不填数。

**hit_count 写边界（I10，补 §5 流3/§6.6）.** harness **只在内存/报告模拟** hit_count 累积以产 §6.6 写侧 ROI 三表，**不得产生任何 `UPDATE mem_card` 写路径**；生产卡 `hitCount` 恒 0、`lastHitMs` 恒 null。types.ts:58「v1 仅离线回放更新」据此解释为 **audit 报告/audit 库 item 的观测口径，绝非改生产卡**；真实回填留待实时阶段另案评审（§5 流3）。§6.6「模拟累积」= 报告口径，非落库口径。

**M7 投毒自证两通路（I13，补 §11.3 M7，勿混淆红线与硬失败）.** ①**硬失败通路**：造悬空 anchor/provenance 失败 → run 必须 `failed`、退出码非零；②**指标正确性通路**：向 decoy/gold 注入一条错标 `expected`/`goldCardId` → **不要求 run failed**，但断言 R2 精确捕获该注入错误（top1 不符被记、错误计数 ≥ 注入数，验证指标不漏报）。投毒后逐字节还原夹具（sha256 前后一致）→ 回绿，脚本与完整日志随收尾包。

**LOEO 降级（I15，补 §6.1 L2）.** 触发判据冻结为「**可覆盖日历周数 < 5**（切不出后 20% 完整周）→ LOEO」；当前 10 个 ready 事件，C5 合成与 C6 真实首跑均预期走 LOEO，**禁止伪装独立 holdout**。LOEO 留一事件交叉验证，折数 = 参与事件数（C6 为 10 折，C5 合成夹具折数 = 合成事件数并显式标注），`notesJson` 记 `holdout:{mode:'loeo',folds:n}`；解封记录 README 模板 C5 写、C6 真实解封填。

**接力/冷启动/分层（I16，补 §6.2）.** 接力映射复用 `foldCurrentEvents`（event-row.ts:88）取当前态 + invalidate `successorCardHints`（G11）给 successor 链，detail 记录接力链，**不新写映射**；冷启动 = 提问轮与目标事件 occurred 差 `> 7*24*3600*1000` ms 且其间无指向同一 event_id 的经历（只读真值计算）；引发方分层固定 `her`/`user`/`environment` 三类，经历 `initiation='system'` 归一到 `environment` 并在报告注明归并规则（`KNOWN_INITIATIONS` 四值 experience.ts:24，不增设第四分层）；k=3 主测，k=1/5 敏感性对照。上述折叠/接力/冷启动/分层计算一律在 scripts 编排层完成（I5），audit 纯函数只接收注入结果。

**合成夹具（I3/I7，补 §6.1）.** C5 只交付夹具 schema、版本校验与**合成临时根夹具**：qa 在 `withTempRoot` 内自建合成经历/事件→build→seed→audit，夹具 id 全部指向合成数据；`tests/fixtures/memory/` 放合成 gold-l0/gold-l1/holdout/decoy.json 与 README 模板，README 明文「真实 L0/L1/holdout 人工标注与真实 id 属 C6，本目录 C5 仅合成夹具与格式」。夹具用 UTF-8 `.json`，每文件含 `probeSetVersion`（`/^v\d+(\.\d+)*$/`）、`layer`（l0/l1/l2/decoy）与条目数组（字段冻结见 §4.10 fixtures.ts）；**只含 id 与标注，schema 不得含 summary/body/raw_text 等任何正文字段**，fixtures.ts 校验拒收，坏夹具抛 core 基类。C5 不碰真实根、不预填真实 id、夹具不含正文副本。

---

## 7. 10 事件种子卡造法与验收

> 【已废止整章 · 见文首 2026-11-12 裁决】本章的人工七步造法（worksheet、人工填 cues/aliases/discriminator、L0 人工标注与验收）随 seed 模块整体删除，不再对应任何代码或流程，正文仅作历史存档。10 事件乃至后续运行期的建卡统一改由 #42 自动建卡承接，决策主体是「她」，无人工填卡环节。

【事实】当前 10 个 ready 事件指针数 2–51 不等，字段全集含 anchors/key_points/summary/discriminator 所需素材（事件当前态字段实测见 §1.2）。

【建议】造法七步（全部由 `scripts/seed-memory-cards.ts` 支撑，人工是决策主体）：

1. 试运行生成 worksheet：每事件一行，带 event_id、anchors、key_points（仅供人工读，不进卡）、时间范围、指针数；输出到 `--worksheet-out` 指定的临时文件。
2. 人工为每事件填 1–3 个 display_cues（短词/短语，禁止整句）、0–5 条 retrieval aliases、一条 ≤40 码点 discriminator、敏感标记（涉及第三人隐私/原话引用的词标 sensitive=1）、初始 weight 统一 0（不允许人工拍权重）。
3. 近邻判别：worksheet 工具自动算 Jaccard 近邻对并提示，人工补 §6.3 的判别提问。
4. 校验器过闸：字段数量/长度/枚举/正文连续子串反查（§4.7）/anchor 存在性；任一不过整份 worksheet 拒绝、零写入并打印行号。
5. `--apply-worksheet` 在临时根演练通过后，对真实数据根执行（仍需显式 `--apply`），事务落卡 + 决策行。
6. 紧接跑 `build-memory-index.ts --apply` 做一次全量复算，验证 revisions 影子 diff 为 0 变动（除种子本身）。
7. 跑 `run-memory-audit.ts` 出首版基线报告，三红线照实填数或 N/A，作为后续校准对照点。

验收口径（DoD 的子集）：10 张卡全部 active、anchor 100% 可解析、零正文列扫描通过、FTS 可检出每张卡至少一个非敏感词、敏感词精确路径可达且 FTS 不可见、窗口装配在 10 卡全集上 700 字硬顶零违反、provenance 抽样 100% 通过、decisions/revisions 各 10 条与 1 条 build 记录可对账。

C4 可自动化验收子集（裁决 H1–H14，记录见 §11.7；全部在 tests/helpers 临时根，dataRoot 必填）：

- M11 三层反证：类型层编译期断言 + 运行时白名单拒收 + PRAGMA 列集冻结；附「注入原始查询键/列必红→逐字节还原→回绿」变异证据；敏感词 FTS 空/精确可达。
- 正文子串反查正反例（H7）：≥20 码点连续包含拒绝、<20 跳过、summary=null 放行、方向固定。
- 临时根 10 事件造卡全流程：生成→填→校验→apply→build 复算 shadowDiff=0；decisions 10 条、revisions 的 seed-apply 1 条加 build 1 条可对账。
- CLI 退出码实录：无参/缺 data-root（退出码 2）/取消/EOF（退出码 0 零写入）/dry-run 零写入；真实根写入必须显式 --apply。
- elapsed 落账固化（H13）：CLI --apply 真写产出的 decisions 逐行 reason 命中 `/^seed-create;elapsed_ms=\d+$/`；dry-run 零写入且不产生 decision 行。
- 纯函数表驱动（H3）：buildCandidatePacket 纯映射与各行校验/词规范化/子串反查/H9 三关判定可不碰库单测；jaccardNeighbors 表驱动（H14）。
- 回放幂等（H2）：--replay-misses 同输入重放行数倍增、term_hash 集合一致；未传旗标构建流回归不变。

---

## 8. DoR / DoD

### 8.1  Definition of Ready（每个工作块开工前）

1. 本方案已获用户显式拍板；实现任务边界单条下发，未拍板前仓库无任何 src/tests 改动（当前红线）。
2. 工作树基于含 eafe484 的主干、517 用例全绿；本机 Node ≥22.22（node:sqlite 3.51.2 口径见 `docs/implementation-notes.md` 环境实测）。
3. 工作块依赖的上游块已合入（依赖关系见 §9 拓扑）；新增标识符命名已在本方案冻结，无「届时命名」项。
4. 测试临时根工具（`tests/helpers.ts:14-48`）与金标夹具版本就位；真实数据根在任何 dry-run 中均不出现于写入路径。

### 8.2 Definition of Done（每个提交统一适用）

1. `npm run verify`（build + typecheck + 全量 node --test）绿，新增用例数在提交说明列明，原有 517 用例零回归。
2. 新模块单测行覆盖关键分支：纯函数表驱动用例、错误路径、幂等/原子/隔离反证（§11 M1–M12 中该块相关项全部落地）。
3. 静态隔离：无任何实时链路文件 import 新模块；新模块不 import 门面写原语；schema 禁列扫描通过。
4. 生产 dependencies 仍为 `{}`；无新依赖、无网络调用代码、无遥测默认开关。
5. 所有写操作在 dry-run 默认下不触真实数据根；CLI `--help` 与无参运行打印用法且退出码安全。
6. 文档与代码一致：若实现中发现本方案错误，先提方案修订（docs 另提交）再改码，禁止代码与方案 silently 分叉。

---

## 9. 分阶段提交计划

【建议】六个提交全部为离线性质，硬性规则：每个提交的 diff 文件只允许出现在 `src/memory/`、`scripts/`、`tests/memory/`、`tests/qa/`、`tests/fixtures/memory/` 与 docs；凡 diff 触及 `src/api/`、`src/event/`、`src/source/`、`src/adapters/`、`src/projection/`（除纯 import 只读复用外事实上零改动）、`package.json` 依赖节，一律驳回重切。提交顺序即依赖拓扑，每提交独立可回滚。

| 提交 | 内容 | 新增/改动文件（精确清单） | 入场条件与验证命令 |
|---|---|---|---|
| C1 骨架与 schema | memory-errors、types、schema DDL、store 开库/建表/只读查询、meta stamp | 新增 `src/memory/memory-errors.ts`、`types.ts`、`schema.ts`、`store.ts`；`tests/memory/schema.test.ts`、`store.test.ts` | `npm run verify`；schema 期望列测试；M6 禁列扫描；tmp 根开库/重开幂等 |
| C2 构建器与账本 | builder、指纹、折叠复用、影子 diff、原子换文件、revisions/decisions 读写 | 新增 `src/memory/builder.ts`、`ledger.ts`（两类 JSONL 追加/校验）；`tests/memory/builder.test.ts`、`ledger.test.ts`；`scripts/build-memory-index.ts` | M1/M3/M4/M8/M9；dry-run 默认零写真实根（listTree 快照）；`node scripts/build-memory-index.ts --data-root <tmp> --json` |
| C3 检索与窗口 | bm25、invalidate、serial、window 纯函数 | 新增 `src/memory/bm25.ts`、`invalidate.ts`、`serial.ts`、`window.ts`；`tests/memory/bm25.test.ts`、`invalidate.test.ts`、`serial.test.ts`、`window.test.ts` | M2/M5/M10/M12；700 字 property test；序号反证；短词回退一致性 |
| C4 种子工作流（seed 部分已下线删除，见文首裁决；仅 miss 白名单保留） | 原 seed worksheet 生成/校验/应用、seed CLI 已移除；miss 白名单写入仍在 | 现存 `src/memory/miss.ts`、`tests/memory/miss.test.ts`；`seed.ts`、`scripts/seed-memory-cards.ts`、`tests/memory/seed.test.ts` 已删除 | M11；正文子串反查等 seed 用例随模块移除；miss 相关测试保留 |
| C5 评测 harness | audit 六文件（四探针 gold/decoy/consistency/provenance + 两基建 fixtures/metrics）+ qa 测试 + 合成金标夹具 + audit CLI | 新增 `src/memory/audit/{fixtures,gold,decoy,consistency,provenance,metrics}.ts`；`scripts/run-memory-audit.ts`；`tests/qa/qa-memory-harness.test.ts`；`tests/fixtures/memory/{gold-l0,gold-l1,holdout,decoy,README}.*`；**授权既有** `src/memory/store.ts`（I1-A writeAuditRun，authorized-changes） | M7 两通路；N/A 规则测试；bootstrap 区间；provenance 硬失败；`node scripts/run-memory-audit.ts --data-root <tmp> --out <tmp>/audit --json` |
| C6 首跑与基线（人工种子已下线，见文首裁决） | 原“在真实数据根按 §7 执行人工种子”已取消、归 #42 自动建卡；离线 audit/重建工具保留（代码不再变；仅产物与一份 docs 基线记录） | 数据根产物（不进 git）；如需记录基线，仅新增 docs 下一份短报告（另案命名） | 真实根操作前主干全绿；操作后 `verifyIntegrity` 等现有校验不受影响；fasti.sqlite/checkpoint.json 修改时间不变 |

【事实】C6 之前所有自动化都在临时根完成；C6 是唯一面向 `/home/user/.dsh/fasti` 的运行，且其写入面只有新建的 `projection/memory-index/` 目录。任何 C1–C5 提交不得为「方便」而改实时模块，发现确需内核配合时停下走方案修订，这是《落地分析》§3.4 守门点在提交纪律上的落地。

【口径统一（I4，记录见 §11.8）】C5 新增 audit 模块为**六文件**：四探针 `gold`/`decoy`/`consistency`/`provenance` 一一对应 `ProbeType` 四值（types.ts:13、schema.ts:121），两基建 `fixtures`（加载校验）/`metrics`（聚合 + 落库低层）。「五件套」保留为 §1 D5 **方法论称谓**（BM25/轻卡/锚点/窗口/provenance 审计），与文件数无关；§6.7 标题「五件套之五」指方法论第五件（provenance 审计），非「第五个模块」。C5 授权既有文件仅 `store.ts`（I1-A）与本方案 md；`event.test.ts` 本批零触碰（I5，PRODUCERS 冻结现有 10 个）、memory-errors.ts 零改、其余既有文件零改动。

---

## 10. 外部机制吸收与「虽流行仍不做」登记

### 10.1 吸收清单（只取机制，不搬实现）

| 外部机制（调研出处） | 本方案落点 | 吸收边界/禁止照搬项 |
|---|---|---|
| Graphiti 双时序纯函数失效（commit e911422） | §3.3 `invalidate.ts` 无 LLM 日期窗/锚点规则；as-of 三条件同构 | 只在选择索引内生效；不写 edge.invalid_ms；不引图查询、不做实体边自动迁移 |
| Mem0 候选序号化（commit f1791da） | §4.7 serial.ts 请求级私有映射、未知序号拒绝+一轮重取 | 不搬其 ADD -only 事实堆（矛盾并存是其反面教材）；不做 LLM 自由文本事实写 |
| LlamaIndex 槽位 waterfall（commit 5f95c79） | §4.8 五槽/降序装升序裁/完整回合/3 卡起点 | 不搬向量 block、默认 OpenAI 依赖、50 条 LLM 整表 condense 重写 |
| Letta MemFS「编辑下轮编译生效」（letta-code c936963） | 语义对齐：卡/线索修订只在下次离线构建 stamp 后对只读柄生效，运行时不存在热改写 | 不搬常驻 cron tick、租约文件与进程内调度器（未来 C 块调度另案，信号严禁入真源） |
| Letta readOnlyFiles 冻结白名单（同上） | §11 M6 静态 import/禁列扫描，与现有 `frozen-surface.ts:78-101` 双层守门 | 不搬 agent 自由改写人格块的模式（违 D3/二级真源固化） |
| Cognee 迁移账本（commit 8853378） | §3.4 revisions 四件套、确定性 id、影子 diff、stamp | 不搬 Alembic 50 脚本/图数据迁移链/可插拔多后端重量设施 |
| AstrBot「主动=带来源标记合成轮走同一管线」（commit 68acac9） | 仅登记为 C 块预留：未来主动触发的检索走同一只读流，来源标记留在运行时事件、绝不入真源 | 本期不实现调度；不搬整段 JSON 覆盖写与会话一等前提 |
| MaiBot 概率门「只收紧不放宽」+退避（commit e539150） | C 块预留参数设计原则：打扰门限冷启动静态阈值、后续只能收紧；窗口/检索本期不引入概率门 | 不搬数值好感/亲密度列（现仓库已删除该模型，调研已证）；不做自然语言推断写真源 |

### 10.2 「虽流行仍不做」13 项（K1–K13，沿《落地分析》§2 编号）与重议触发条件

【建议】下表在方案级冻结，任何实现 PR 引入即驳回；重议必须先满足触发条件并走外审，不得因实现顺手而破线。

| 编号 | 禁止项 | 违反的纪律/冻结面 | 重议触发条件（量化、数据说话） |
|---|---|---|---|
| K1 | 向量检索/embedding 硬依赖 | 零生产依赖；平坦 BM25 是 D5 定案 | harness 连续两个审计周期语义漏召率越 R1 红线且词法改造（别名/分词）收益已证穷尽 |
| K2 | 图数据库/实体图投影 | D5 数据规模判断；P3 实体表明示未建（`schema.ts:9-10`） | 卡量过千且多跳关系问题占比经金标量化 >30%，平坦结构查询无法满足 |
| K3 | 常驻调度器/进程内 cron | 无服务依赖；tick 去中心化备忘结论 | C 块立项且评审确认外部 tick 不可行，需附单实例锁方案 |
| K4 | 真源原地更新 | source-append-only 冻结面（`frozen-surface.ts:18-24`） | 不设触发条件：永不重议，只允许追加新版本 |
| K5 | LLM 静默改写已存事实/卡 | 二级真源「写入即固化、不可算法重算」 | 不设触发条件；任何 LLM 输出都不得静默改写已存事实，只能经她的决策留痕生成新决策行（原人工种子流已下线，出口为 #42 自动建卡，见文首裁决） |
| K6 | 黑盒检查点/状态快照 | checkpoint 白盒 JSON 纪律（现有 `state/checkpoint.json` 七字段可读） | 不设触发条件 |
| K7 | 情绪/心情/重要度数值入契约 | 无情绪字段纪律；`FORBIDDEN_SOURCE_CAPABILITIES` 已禁 | 情绪只可能进投影/外显且需独立外审；内核契约永不加列 |
| K8 | 在线校验器/摄入热路径 LLM 判定 | B 块 LLM 不进摄入热路径（设计稿 §6.1） | 离线 harness 证明离线延迟不可接受且有数据，不预设成立 |
| K9 | 概念满铺（先建 P3–P9 空表空接口） | YAGNI；schema.ts 已明示按需加表 | 每个新投影需独立立项+金标+重建协议，不批量预建 |
| K10 | 逐层路由器/查询分类器 | 平坦检索定案；可解释 scoreParts | 平坦检索召回红线连续失守且错误分析定位到路由缺失 |
| K11 | 周期性全量重算替换增量 | B 块「允许补齐不允许重建」（§7.4）；投影重建是人工/修复动作不是定时任务 | 指纹对账发现确定性损坏时的一次性修复，不做日程 |
| K12 | 会话字段进真源 | 真源只冻结原文层八字段；sessionId 不入库（host-model-route 现状无 sessionId） | 不设触发条件 |
| K13 | 默认遥测/埋点外发 | 无默认遥测纪律 | 漏召审计始终本地落库；任何外发需独立合规评审与显式开关 |

---

## 11. 实现期自证与审核配合

【事实】用户已确认实现阶段由本方案撰写方执行、主 agent 独立审核（回代码核实、不采信自述、跑全量验证与纪律把关）。下列命令与反证测试是审核时的逐项核对清单，全部可独立复跑。

### 11.1 可独立运行的命令

```bash
# 全量门禁（构建+类型+517 起逐增的全部用例）
npm run verify

# 仅记忆模块测试（开发内循环）
node --test "tests/memory/**/*.test.ts"
# QA/harness 测试
node --test "tests/qa/qa-memory-harness.test.ts"

# 离线 CLI 的安全运行形态（<tmp> 必须是 tests/helpers.ts 同款临时根，绝不填 /home/user/.dsh/fasti 的 dry-run；seed CLI 已下线，现存 build/audit 两个）
node scripts/build-memory-index.ts --data-root <tmp> --json            # 默认 dry-run，零写入 indexDir
node scripts/run-memory-audit.ts   --data-root <tmp> --out <tmp>/audit --json
# 真写需显式追加 --apply，脚本先打印真值指纹与 diff 并要求二次确认（人工 seed 真写路径已取消，见文首裁决）
```

### 11.2 临时目录隔离与单实例纪律

1. 所有测试经 `withTempRoot/makeTempRoot`（`tests/helpers.ts:14-48`）建隔离根，结束 `cleanupTempRoot`；断言中出现的路径必须位于临时根或测试自身输出目录，测试用例末尾用 `listTree`（同文件:68）做目录快照，证明真值目录零写入。
2. 构建器**不接受**默认数据根的隐式解析：`--data-root` 缺省时 CLI 打印用法并退出（退出码 2），从参数面杜绝误操作真实根；函数级 API 把 dataRoot 设为必填。
3. 构建器只读 JSONL 真值、从不打开 `fasti.sqlite`，因此不需要也不允许建立第二个会写的库柄；对 `memory-index.sqlite` 的写柄在进程内单例化，二次 `openMemoryWrite` 同目录直接抛 `ConflictError`（复用 `src/core/errors.ts:102`），防双写。
4. 反证隔离测试 M9：把临时真值目录 chmod 0500（只读）后跑完整构建，要求成功且输出正常；再对输出目录做构建前后树快照比对，证明 `indexDir` 之外无任何创建/修改。

### 11.3 变异/反证测试清单（守门点可机器核验）

| 编号 | 反证思路 | 期望行为 |
|---|---|---|
| M1 | 手工删掉/篡改某 anchor 指向的经历行后构建 | 抛 MemoryAnchorDanglingError，零产物、revisions 不增行 |
| M2 | 向 resolveSerials 传入越界/已失效序号 | 抛 MemorySerialReferenceError；模拟重取一次后再败，断言调用方放弃引用且无任何 id 猜测 |
| M3 | 改一个真值字节后直接开只读柄（不重新 stamp） | verifyStampedFingerprint 抛 MemoryIndexStaleError，读操作拒绝服务 |
| M4 | 同输入连跑两次构建并比对 | card_id/content_hash/row_hash_sum 全等；revisions 追加行 shadow_diff 全 0 |
| M5 | invalidate 六类表驱动用例 + 同输入重复 100 次 | 结果逐字节一致、无 I/O、无当前时间以外的副作用（atMs 注入） |
| M6 | 静态扫描 src/memory 与生成 schema：禁列词（summary/body/raw_text/emotion/mood/importance/session 等）、import 图（api/event/source/adapters 不得依赖 memory；memory 不得 import 门面写方法） | 扫描脚本测试化，命中即失败；另断言 package.json dependencies 节文本不变 |
| M7 | 运行全部 DRM 诱饵对，逐对检查 top1 | 错误数与 R2 落 audit；故意投毒一组金标时 harness 必须检出该 failed run |
| M8 | mock rename/fsync 在写入中途失败 | 旧 sqlite 仍可正常打开、tmp 文件被清理、revisions 无半行、出口码非零 |
| M9 | chmod 0500 真值目录 + 输出目录树快照 | 构建成功且索引目录外零改动（§11.2） |
| M10 | 随机生成 1–50 张随机长度卡做窗口 property test | totalChars 恒 ≤700、turnsWhole 恒 true、needRefetch 至多一次、空槽规则成立 |
| M11 | 反射校验 mem_miss 实际列与入参类型 | 不存在任何原始查询列；敏感 term 的 FTS 命中为空、精确命中正常 |
| M12 | 同一组词分别走 trigram MATCH 与 LIKE/精确回退 | 结果集合一致（对齐现有 L1 三档语义统一先例 `src/projection/types.ts` 头部注释） |

### 11.4 审核交接物

每个提交附：验证命令全文输出、新增/未改动文件清单（git diff --stat 与本文 §9 清单逐项对账）、该提交对应的 M 编号结果、如涉及阈值/常量则附 harness 数据行。主 agent 有权要求在其指定的全新临时目录复跑 C1–C5 全流程。

### 11.5 anchors 物化方白名单登记（C2 裁决记录）

**背景.** §4.6 数据流要点③（第 395 行）要求 `src/memory/builder.ts` 读取事件 `anchors` 字段：快照进 `anchor_json`、逐 id 回查经历文件验证存在性、参与 `deriveCardId` 派生。既有契约门禁 `tests/contract/event.test.ts` 的红线本体（第 282–283 行）规定「`topic_lines` 第一期恒空、`anchors` 无消费者（产出、落盘、透传允许）」，第 379–414 行对 src/ 全量扫描，未登记文件命中 anchors 读取形态即失败；产出方/物化方登记表 PRODUCERS 位于第 46–56 行，其机制自述（第 44 行）要求「新增产出方要显式登记，否则当场变红」。C2 实现完成后，builder 因未登记被该门禁判红（当批全量 verify 唯一失败项）。实现方按施工纪律停止编写：未改门禁、未绕判据、未删冻结接口要求的 anchors 读取，将冲突清单与一行提案补丁提交外部审查裁决。

**裁决与执行.** 审核方在 Linux / Node v22.23.2 隔离副本（基线 eafe484）独立核验：builder 对 `event.anchors` 仅三处使用——存在性回查（`src/memory/builder.ts:275`，悬空即抛 `MemoryAnchorDanglingError`，第 281–285 行，发生在任何写入之前）、确定性 id 派生（第 294 行 `deriveCardId`）、`JSON.stringify` 快照透传落 `anchor_json`（第 300 行）；无重要性/权重/筛选等语义判断，全文不出现 `topic_lines`。据此认定 builder 属门禁设计预期的「物化/透传方」，主理人批准登记。执行结果：`tests/contract/event.test.ts` 第 55 行在 PRODUCERS 追加 `'src/memory/builder.ts'` 一行及注释，与提案补丁逐字一致；判据正则、扫描范围、红线本体零改动。登记后全量 verify 通过：审核方 Linux 577 过 / 0 失败 / 0 跳过；实现方 Windows 576 过 / 0 失败 / 1 跳过（跳过项为 win32 M9，Linux 已实跑通过），退出码 0。

**红线仍有效.** 白名单不是免检区：PRODUCERS 成员依旧禁止写入非空 `topic_lines`（`tests/contract/event.test.ts:340-345` producer 档，判据 `hasNonEmptyArrayWrite` 第 322–329 行；判据自证用例第 371–373 行固化「producer 写非空 topic_lines 仍违规」）。变异反证事实：登记后向 builder 注入非空 `topic_lines` 写入，门禁仍判「topic_lines:非空写入」变红，逐字节还原后回绿——审核方 Linux 复核与实现方 Windows 复现均通过（复现脚本与完整输出见 C2 收尾包 evidence/topic-lines-mutation-evidence.ts 与 topic-lines-mutation.log）。

**后续口径.** C4 `src/memory/seed.ts` 的同类登记不在本次授权范围：C4 交付时须就 seed.ts 对 `event.anchors` 的真实用法单独提交登记申请，凭实际代码逐次报批；本批不得提前把 seed.ts 或任何其他文件加进 PRODUCERS。

### 11.6 C3 开工前冲突裁决记录

**背景.** C3 DoR（§8.1）研读阶段，实现方在新机器重建并全量对账通过后（基线 eafe484，577 项 = 576 过 / 0 失败 / 1 跳过，跳过项 win32 M9），发现方案存在未冻结项：结构性缺口三项——G1 `SearchQuery` 全仓库无定义（仅 §4.3 签名引用，§4.2 清单与 C1 types.ts 均无）；G2 search 挂只读柄需改 C1 既有文件，而 §9 C3 清单只列新增文件；G3 identity 槽资格在冻结签名下无输入通道（RankedCard/MemoryCard 无 initiation，纯函数无 I/O）——以及语义留白十一项（G4–G14）。实现方按红线 1 停止编写（C3 代码零行），提交《C3-冲突清单-开工前》逐项列明证据锚点与最小提案。审核方在隔离副本回码逐条核实（types.ts/store.ts/schema 与方案 §3.3/§4.2/§4.3/§4.4/§4.8/§8.2 原文），确认 G1–G3 为方案自身不一致、G4–G14 为合理留白，停工报批符合 DoD 第 6 条与红线纪律。

**裁决与执行.** 逐项结论如下（未列明者一律按方案原文，不得自行扩张）：G1 批准，`SearchQuery` 形状定死为 `{ text: string; atMs: number; limit?: number }`——text 原始文本、规范化在函数内；atMs 必填、唯一注入时钟、函数内禁 `Date.now()`；limit 缺省不截断、top-k 由调用方传入（§6.2 k=3 不硬编码）；LAMBDA/HALF_LIFE 覆盖走 bm25 低层独立 tuning 入参，不进 SearchQuery。G2 批准 types.ts/store.ts 最小授权改动（authorized-changes 模式，包内置顶完整 diff）：types.ts 仅新增 SearchQuery、既有类型零改动；store.ts 只读接口增 search 一行、只读实现类委托 bm25 低层 `searchCards(db, query, tuning?)`；写柄经类继承获得、写柄类零新增逻辑，openMemoryWrite 单例/transactionApply 写路径与工厂零改动；bm25 只导出纯函数与接收库柄的低层检索、不自开连接。G3 采方案 A、否决方案 B：`assembleWindow` 增第三可选入参 `identityEligible?: ReadonlySet<string>`（缺省空集、identity 槽恒空），不向已冻结的 RankedCard 加字段；资格数据源是经 anchor_json 经历 id 回查 experiences 的 initiation='her'，不是 event.anchors；C3 不实现该回查（无运行时调用点），只定义入参契约并对空集/显式集合两种情形单测。G4 每卡预算文本 = 解析 display_cues_json 后 `[...displayCues, discriminator].join(' ')` 的码点数（`[...s].length`），活跃别名属检索词表不计入。G5 startingCards=3 为首轮起点卡数（recency/identity/relevance 各至多 1 张起点），guaranteed/obligation v1 恒空，摘要位用具名空常量留痕、不占槽不占预算，slots 恒输出五槽。G6 recency=occurredMs 最大 1 张；identity=资格集内 occurredMs 最大 1 张且不与 recency 重复；relevance=其余候选按入参检索名次装入、受预算约束；裁撤顺序 obligation→relevance→identity→recency→guaranteed，槽内按装入逆序逐卡移出，卡为原子单位、卡内线索整组进退，turnsWhole 恒 true。G7 采 A：reopened 与 merged/split 同判 superseded + anchor-superseded，successorCardHints 原样给 successorEventIds、不自动迁卡（依据：构建器只收 closed+ready，reopen 后事件退出卡来源）。G8 改判采 B、不采 A：duplicate-selection 本期不在 evaluateInvalidation 纯函数内判定（恒不触发该 reason），维持「构建期幂等拦截为主」，由 builder 确定性幂等保证同 anchor 集合不产生第二张 selected 卡；InvalidationInput 不增 otherActiveCards 字段（不扩冻结入参）；六类表驱动中该类以构建期拦截口径在 builder 侧测试覆盖，§3.3 写明边界。G9 expiredMs 非空即判 manual-tombstone，status='invalid'、invalidMs=expiredMs（不取 atMs）。G10 alias-conflict 取可计算保守判据：aliasTable 存在 status='active'、同 termNorm、不同 cardId 的行即冲突；「discriminator 无法区分」本期按恒成立处理（同词双卡即冲突，区分交人工种子流程）；前置条件「aliasTable 由调用方保证只含 active 别名」写入函数注释与 §3.3。G11 优先级 manual-tombstone > anchor-superseded > alias-conflict（按 G8 收敛为三分支），后两者 invalidMs=atMs，manual-tombstone 取 expiredMs；active 时 invalidMs=null、reason=null、successorCardHints=[]；successorCardHints 仅 eventChange 场景输出 successorEventIds 原样。G12 回退路径 scoreParts.bm25=0、score=LAMBDA*recency、回退命中间按近因排序；FTS 路径 scoreParts.bm25=-bm25Raw；recency 恒为 exp 衰减值；M12 只断言两路径结果集合一致、不断言分数相等。G13 as-of 过滤直接复用 listEffective 同一 SQL 谓词或同一 isEffectiveAt 纯函数，禁止另写可能漂移的判定。G14 阈值按规范化后码点长度测量（同 MIN_TRIGRAM_LENGTH=3 口径）；v1 查询按单个规范化短语整串匹配（FTS 短语包裹+内部引号转义，照 src/projection/sqlite.ts:464-499 先例），不做分词、分词列演进；matchedTerms 定义为实际命中的规范化查询项/别名 termNorm 集合，不得留空。上述口径已先行增补至 §3.3/§4.2/§4.3/§4.4/§4.8（文档先行，DoD 第 6 条），代码按增补后方案 TDD 施工。

**白名单与纪律.** 本批允许改动：8 个新增文件（src/memory/{bm25,invalidate,serial,window}.ts 与 tests/memory/{bm25,invalidate,serial,window}.test.ts）＋ types.ts/store.ts 最小授权改动＋本方案修订；其余既有文件零改动，event.test.ts 维持 C2 登记（第 55 行）不再触碰。edge.invalid_ms 继续恒 NULL、无任何代码路径写它；不读 event.anchors、不写 topic_lines；生产 dependencies 保持 {}、零新依赖、无网络/子进程/eval/真实根字串；自动化只在 tests/helpers 临时根、dataRoot 必填；不 git add/commit/push、不启动 C4。M2/M5/M10/M12 反证与 700 字 property、序号反证、短词回退一致性按原工单全部落地；再遇方案未覆盖项停工报批。npm ERESOLVE 确认为基线既有 peer 口径问题（非 C3 引入），允许 `npm install --legacy-peer-deps --no-package-lock`，package.json 与 package-lock.json 零字节改动、dependencies 文本仍为 {}，并在 README 披露。serial.ts 不单独先行，随 C3 整批一次交付。打包沿用 C2 收尾包结构（new-files/authorized-changes/baseline-context/evidence/README）：new-files 内 C1/C2 文件与 C2 收尾包逐字节一致并附 sha256；authorized-changes 含 types.ts/store.ts 最小 diff、维持不变的 event.test.ts 与修订后方案；完成后待命，未放行不得进入 C4。

**行号锚点（增补后实测）.** §3.3 补充口径第 280–286 行；§4.2 SearchQuery 冻结形状第 347–356 行（interface 在第 350 行）；§4.3 C3 落地口径第 381 行；§4.4 补充口径第 391–398 行；§4.8 三参签名第 458 行、补充口径第 463–468 行；本节（§11.6）第 700–710 行。因 C3 增补整体下移：§11.5 由 C2 期第 653–661 行移至第 690–698 行（历史正文一字未动，其内部引用的行号为 C2 期实测）；§4.6 数据流要点③由第 395 行移至第 425 行。

**后续口径.** C4 seed.ts 的 anchors 登记仍按 §11.5 逐次报批，本裁决不预授权；C3 交付经外部审核放行前不进入 C4。

### 11.7 C4 开工前冲突裁决记录

**背景.** C4 DoR（§8.1）研读阶段，实现方在 C3 交付态（基线 eafe484，617 项 = 616 过 / 0 失败 / 1 跳过，跳过项 win32 M9；审核方 Linux 617/617 全绿放行）发现方案未冻结项：结构性缺口三项——H1 recordMiss 落写柄需改 C1 既有 store.ts 而 §9 C4 清单只列新增文件；H2 --replay-misses 需改 C2 冻结脚本 build-memory-index.ts 且旗标形状未冻结；H3 seed.ts 两函数签名仅散文描述无处冻结（与 serial.ts 有逐字签名不一致）——以及已知门禁流程项 H4（seed.ts 读 event.anchors 必触发 anchors 门禁，登记不预授权）与语义留白八项（H5–H12）。实现方按红线 1 停止编写（C4 代码零行），提交《C4-冲突清单-开工前》逐项列明证据锚点与最小提案。审核方在 C3 交付态只读视图回码逐条核实（store/schema/builder/event-row/ulid 与方案 §4.7/4.9/4.11/§5/§6.5/6.6/§7/§9/§11.5 原文），确认 H1–H3 为方案与文件清单的真实接缝、H4 门禁流程知悉、H5–H12 为合理留白，停工报批符合 DoD 第 6 条。文档落笔前实现方再报增补两项：H13 elapsed 注入通道与冻结入参形状的机械接缝、H14 Jaccard「仅生成模式」与 §7 步骤 3 已填行口径的读法；审核方回码核实（types.ts DecisionRecord、store.ts transactionApply、builder.readExistingIndex/cardValues 与 §6.6/§7 步骤 3 原文）确认事实链成立。

**裁决与执行.** 逐项结论如下（未列明者一律按方案原文，不得自行扩张）：H1 批准 store.ts 最小授权改动，低层定名 insertMissRow(db,input):string（避免与类方法同名自递归），写柄接口 recordMiss(input):void 不变、WriteHandle 委托 insertMissRow(this.require(),input)；只读柄/单例/事务/工厂零改动；miss.ts 只导出纯函数/校验与接收库柄的 insertMissRow、不自开连接；鼓励 store→miss 单向 import（优于 C3 store↔bm25 循环）、模块顶层仅字面量零求值，收尾包回码验证单向性。H2 批准改 build-memory-index.ts，--replay-misses <file> 定死为 MissObservationInput 的 UTF-8 JSON 数组、独立回放模式：单独传入只 dry-run 校验 + 打印行数与 term_hash 集合摘要、零写入且不跑构建流；加 --apply 且过既有二次确认（--yes 仅跳过交互、预演先打印）才经写柄逐条 insertMissRow；幂等照 §6.5③ 每行新 ulid、append-only、不去重、重放行数倍增哈希集合一致；未传旗标构建流字节级不变（回归测试断言报告与退出码）；validateMissInput/computeMissTermHash 导出纯函数供 dry-run 复用、insertMissRow 内部复用同一校验不得两套口径。H3 冻结两签名并两处纠正：buildCandidatePacket 第一参改 readonly EventProjection[]（src/projection/types.ts:74，foldCurrentEvents 返回再经 closed+ready 过滤的当前态，与 builder.ts:268-269 同型），折叠与过滤在 CLI/编排层复用 foldCurrentEvents，本函数只做 snake_case→camelCase 纯映射无 I/O，rows 排序 started_ms 升序→id 升序，人工字段留 undefined；SeedApplyOptions.nowMs 改必填 number、取消缺省内部 Date.now，seed.ts 内禁任何 Date.now/new Date、时钟由 CLI 边界注入，dryRun? 缺省 true 保留；其余形状照提案（SeedApplyReport{applied,cards,aliases,decisions,revision}）；校验失败整份拒绝零写入抛 IntegrityError 带行号原因、文件缺失/JSON 坏抛 NotFoundError/CorruptedError，不新增错误类、memory-errors.ts 零改动；applySeedWorksheet 经 openMemoryWrite 取写柄复用 transactionApply 不新增写路径；可测纯校验抽成无 I/O 纯函数导出表驱动单测、applySeedWorksheet 仅薄编排；旧库快照循 builder.readExistingIndex（read-only DatabaseSync SELECT *，builder.ts:155/159）不借 H1 给 store 加 listAll。H4 知悉并确认 anchors 登记不预授权：event.test.ts 裁决前零触碰，交付时按 C2 模式另行提交冲突说明 + 一行登记补丁 + anchors 全部使用位置证据（仅快照/存在性回查/deriveCardId，无重要性判断、全文无 topic_lines），逐次报批通过后才登记并增方案记录、再做 topic_lines 注入变异反证与全量 verify。H5 批准并补全：cue trim 后非空、≤40 码点、数量 1–3；alias 数量 0–5；discriminator ≤40；卡初值 weight 统一 0、CandidatePacketRow 不设权重字段、禁人工拍权重；任一超限超量整份拒绝。H6 批准复用 bm25.normalizeQuery，规范化后为空拒绝、卡内规范化重复拒绝、跨卡同词本期不拦截（交 invalidate alias-conflict 域）、source/sensitive 按冻结枚举。H7 批准逐字实现：[...text].length>=20 且 summary!==null 且 summary.includes(text) 原始字面连续包含即整份拒绝，方向固定卡文本是 summary 子串，<20 跳过、summary=null 放行，测试正反例。H8 批准 Jaccard 仅 CLI 层打印 stdout、不进 worksheet/packet（冻结形状不加 neighbors），集合取规范化 cue+alias term、|交|/|并|、空集对=0、>0 对降序→eventId 对升序、不设阈值不截断。H9 批准三关陈旧守卫任一不过整份拒绝：①指纹相符②eventId 仍在当前 closed+ready 集且 anchors 深比较逐字一致③anchors 逐 id 只读回查存在性悬空抛 MemoryAnchorDanglingError；卡 id 用当前 anchors 经 builder.deriveCardId、contentHash 经 builder.computeContentHash 复用，禁另写哈希/派生。H10 批准落账：revision card_count/alias_count/row_hash_sum 取落库后全量、shadow_diff 对照 apply 前快照（added 新卡/changed 内容变化/removed=0）、reason 记 CLI 旗标与决策行 id 摘要；decision 每行一条 create-card、created_by='offline-operator'、model_tag='human'、operator='seed-workflow'、slug='seed-apply'、anchor_json 当前 anchors 快照、content_hash 卡 contentHash；重复 apply 主键 upsert + 账本 append-only（不拒绝不去重），随后 build shadowDiff=0 由 H9 与确定性派生保证。H11 批准 miss.ts：insertMissRow + 写柄 recordMiss 委托；term_hash=sha256(termNorm) hex、id=ulid()、anchor_json=anchorIds===null?null:JSON.stringify(anchorIds)；运行时严格白名单 Object.keys 六字段外即 IntegrityError；字段校验 termNorm/channel 非空字符串、returnedCount 非负整数、observedMs 非负有限数、anchorEventId string|null、anchorIds readonly string[]|null；纯写入无检索、mem_miss 无 FTS；M11 三层反证（类型层 'rawQuery' extends keyof MissObservationInput 编译期断言 tsc 守门 + 运行时白名单拒收 + PRAGMA table_info 列集冻结八列），收尾包附注入原始查询键/列必红→逐字节还原→回绿变异证据。H12 批准 seed CLI 旗标与落盘守卫逐条对齐 build CLI：--data-root 必填缺省用法退出码 2、--json/--help 同 build CLI、默认生成模式 --worksheet-out 缺省不写文件 packet 打印 stdout、--worksheet-out 位于 dataRoot 内拒绝退出码 2、--apply-worksheet 默认 dry-run 加 --apply 才真写二次确认 y/yes（--yes 跳过交互预演先打印）。H13 采方案 A 驳回 B/C：SeedApplyOptions 在四字段基础上增可选测量透传字段 elapsedMs?:number，DecisionRecord 零增字段、seed.ts 零 Date.now/new Date、不新增写路径；decision.reason 定死两种字面值（elapsedMs===undefined→'seed-create'，否则 `seed-create;elapsed_ms=<n>`，键名固定 elapsed_ms、等号后非负整数），reason 守不复制原文不夹带正文/原始查询/自由文本；elapsedMs 若提供必须 Number.isFinite&&Number.isInteger&&>=0，非法整份拒绝抛 core 既有错误类；undefined 分支只允许纯函数单测与非 CLI 调用，CLI 真写路径必须始终由边界测得并注入 elapsedMs 使每条落库 create-card 的 reason 含 elapsed_ms=<n>（测试固化 /^seed-create;elapsed_ms=\d+$/、dry-run 零写入不产生 decision 行）；耗时口径照 §6.6 = CLI 进程启动→apply 确认时间戳差仅 CLI 边界计时；驳回 B「仅 stdout 打印不落 decisions.jsonl」（与 §6.6 原文冲突，不得据此改判 §6.6）；该字段是测量透传标量、不进入任何判定/校验/归并逻辑，与 G8 被否决的 otherActiveCards（改变失效输入域的语义字段）不同类。H14 确认读法，把 H12「仅生成模式」明确为「非 --apply 真写模式」，§4.11 写成三时点确定表：①生成模式（未填）允许调用 jaccardNeighbors、已填集空时打印「无已填行」类空提示不报错不阻塞；②--apply-worksheet dry-run 预演（已填、真写前，§7 步骤 3/4）打印已填行 Jaccard 近邻对（主要落点）；③--apply 真写不打印 Jaccard 保证输出报告稳定可对账；jaccardNeighbors 纯函数导出表驱动（空集对=0、仅 >0 对、降序→eventId 对升序、不设阈值不截断、集合取规范化 cue+alias term 复用 normalizeQuery），Jaccard 只进 stdout 不进 worksheet/packet。上述口径已先行增补至 §4.7/§4.9/§4.11/§7（文档先行，DoD 第 6 条），代码按增补后方案 TDD 施工。

**白名单与纪律.** 本批允许改动：5 个新增文件（src/memory/seed.ts、miss.ts、scripts/seed-memory-cards.ts、tests/memory/seed.test.ts、miss.test.ts）＋三个授权既有文件（src/memory/store.ts、scripts/build-memory-index.ts、本方案 md）；event.test.ts 在 H4 anchors 登记获批前零触碰，获批后才允许一行 PRODUCERS 追加并随收尾包单独 diff；其余既有文件零改动。生产 dependencies 保持 {}、零新依赖、无网络/子进程/eval/真实根字串；自动化只用 tests/helpers 临时根、dataRoot 必填；edge.invalid_ms 恒 NULL、不写 topic_lines、除 H4 获批的 seed.ts 物化用法外不读 event.anchors 做判断；模块顶层零求值；不 git add/commit/push、未放行不得进入 C5。测试入场照报备：M11 三层反证（含注入原始查询键/列必红、逐字节还原回绿）、正文子串正反例、临时根 10 事件造卡全流程（生成→填→校验→apply→build 复算 shadowDiff=0，decisions 10 条、revisions seed-apply 1 条加 build 1 条可对账）、真实根写入必须显式 --apply 与无参/缺 data-root/取消/EOF/dry-run 退出码实录；buildCandidatePacket 纯映射与校验纯函数须可不碰库表驱动单测。打包沿用 new-files/authorized-changes/baseline-context/evidence/README：new-files 内 C1–C3 文件与 C3 收尾包逐字节一致并附 sha256；verify 如实标注平台 skipped；再遇方案未覆盖项停工报批。完成后待命。

**行号锚点（增补后实测）.** §4.7 补充口径第 443–479 行（冻结签名：buildCandidatePacket 第 450 行、SeedApplyOptions 第 455 行、applySeedWorksheet 第 469 行）；§4.9 补充口径第 512–519 行；§4.11 补充口径第 541–561 行（Jaccard 三时点表第 549 行）；§7 C4 可自动化验收子集第 631–641 行；本节（§11.7）第 789–801 行。因 C4 增补整体下移：§11.5 由 C3 期第 690–698 行移至第 767–775 行、§11.6 由 C3 期第 700–710 行移至第 777–787 行（历史正文一字未动，其内部引用的行号为 C3 期实测）；§4.6 数据流要点③仍在第 425 行（C4 增补均在其后，未移动）。

**后续口径.** H4 anchors 登记仍按 §11.5 逐次报批，本裁决不预授权；C4 交付经外部审核放行前不进入 C5。

**H4 执行段（C4 收尾审核批准后执行）.** C4 收尾包经审核方在干净 Linux（Node v22.23.2）隔离仓从零重建独立复核通过（未登记态 665 项 = 664 过 / 1 失败 / 0 跳过，唯一失败即 `src/memory/seed.ts:anchors:读取`，与 H4 申请文本逐字一致），H4 一行登记予以批准。执行结果：`tests/contract/event.test.ts` 第 56 行在 PRODUCERS 数组 `'src/memory/builder.ts'` 行之后追加且仅追加 `'src/memory/seed.ts'` 一行及注释（与批准提案逐字一致，numstat 恰 1 added / 0 removed，PRODUCERS 9→10，src/memory 登记为 builder、seed 两个）；判据正则、扫描范围、红线本体及其余任何文件零改动。seed.ts 对 anchors 的五处使用经审核方实质核对均为物化/透传——第 108 行快照进 worksheet、第 229 行 JSON 深比较、第 232 行逐 id 存在性回查（悬空抛 MemoryAnchorDanglingError）、第 405 行 deriveCardId、第 406 行 JSON.stringify 落 anchor_json，无重要性/权重/筛选，weight 恒 0、anchors 不参与打分，与 builder 同型，符合门禁设计预期。登记后 topic_lines 注入变异反证：向 seed.ts 注入非空 topic_lines（`topic_lines: ['probe-nonempty']`）→ 门禁仍判「src/memory/seed.ts:topic_lines:非空写入」变红（白名单不是免检区）→ 逐字节还原（sha256 前后一致）→ 回绿（证据 h4-topic-lines-mutation.log/.mjs）。登记后全量 verify：实现方 Windows 665 项 = 664 过 / 0 失败 / 1 跳过（跳过项 win32 M9，POSIX-only，断言保留不削弱）；审核方 Linux 665/665/0/0、exit 0（M9 实跑）；平台差异照实标注。审核方另亲手独立变异三处（seed.ts 注入非空 topic_lines、miss.ts MISS_INPUT_KEYS 加入 rawQuery 拆除运行时拒收、isForbiddenSummarySubstring 的 summary.includes 短路为 false）均 CAUGHT 并逐字节还原回绿、终态 665/0/0。C4 代码与 H4 登记到此放行；仍不 git add/commit/push（HEAD 保持 eafe484，C 系列代码统一在本轮全部完成后由用户一次性授权推送），不启动 C5/C6（开工时机由用户另行通知，收到通知前保持待命）。

### 11.8 C5 开工前冲突裁决记录

**背景.** C5 DoR（§8.1）研读阶段，实现方在 C4/H4 交付态（基线 eafe484，Windows 665 项 = 664 过 / 0 失败 / 1 跳过 win32 M9；审核方 Linux 665/665/0/0 放行，H4 登记 numstat 1/0、三处变异反证通过）发现方案未冻结项：结构性缺口四项——I1 writeAuditRun 归属与 audit 落库位置（store.ts:12 注释预期写柄、schema.ts:126–134 审计两表与卡同建、builder.ts:176–193 copyRows 同库搬运 vs §4.11:539「独立库」+§11.1:735 --out 三方 tension）；I2 provenance 沿门面 resolvePointer 核验与 M6 规则②（schema.test.ts:326–328 禁 src/memory import /api/）冲突；I3 L0 人工标注时序（C5 夹具 vs C6 真实标注）与夹具真值 id；I4 §9「五模块」vs 六文件措辞——以及已知门禁流程项 I5（audit 读 event.anchors 触发 anchors 门禁，登记不预授权）与语义留白十一项（I6–I16）。实现方按红线 1 停止编写（C5 代码零行），提交《C5-冲突清单-开工前》逐项列明证据锚点与最小提案。审核方在 C4/H4 交付态与主仓完整工作树回码逐条核实（store/schema/builder/types/bm25/window/serial/invalidate/seed/event-row/experience/primitives/api 与方案 §4.3/§4.10/§4.11/§5/§6/§9/§11.3/§11.5/§11.7 原文），确认事实链成立，停工报批符合 DoD 第 6 条。

**裁决与执行.** 逐项结论如下（与既有 G/H 裁决合并执行；未列明者一律按方案原文，不得自行扩张）：

I1 采读法 A（写柄 + --out 独立实例），驳回 B/C。授权 store.ts 最小改动循 H1 同型：写柄接口增 writeAuditRun（一次调用单事务写 1 条 run 与其 items，签名逐字对齐 §4.3 第 373 行已冻结 `writeAuditRun(run: AuditRunRecord, items: AuditItemRecord[]): void`）＋WriteHandle 委托；低层 insertAuditRun(db,…)/insertAuditItem(db,…) 置 src/memory/audit/metrics.ts，收库柄、不自开连接；store→audit 单向 import、audit 不反引 store、模块顶层仅字面量零求值；只读柄/openMemoryRead/openMemoryWrite 单例/transactionApply/recordMiss/工厂零改动；store.ts 入 authorized-changes 置顶完整 diff。run-memory-audit.ts 对 --data-root 恒以 openMemoryRead 只读打开（读真值 JSONL、卡、检索），永不在该库取写柄；写柄只开在 --out 指向目录（同一 MEMORY_SCHEMA 建库，卡/miss 表为空、仅审计两表落行）；生产 memory-index.sqlite 在 C5 全程零字节写入，真值 JSONL 从不写。--out 必填缺省 exit2，解析后等于 dataRoot 或位于其之内一律 exit2（仿 seed --worksheet-out 落根内守卫）；builder 既有 copyRows 对 mem_audit_* 搬运保持不动（兼容/防御，不在本批改）；审计两表 DDL 与 AuditRunRecord/AuditItemRecord/ProbeType 冻结零改动。

I2 批准 provenance 依赖注入、禁止 import 门面：provenance.ts 定义 `export type PointerResolver = (pointer: Pointer) => Promise<ResolvedPointer>`，Pointer 取 contract/experience.ts:43、ResolvedPointer 取 contract/primitives.ts:135（均契约层，M6 放行）；auditProvenance(cards, resolver, options) 的 resolver 必填无缺省、内部只调回调，不 import '../../api'、不实例化 Fasti。Fasti.open（私有构造 api/index.ts:177、static open:254、resolvePointer:1135）只允许出现在 scripts/run-memory-audit.ts（装配 (p)=>fasti.resolvePointer(p)）与 tests/qa（临时根真实实例，循 qa-independent-* 先例）；scripts/tests 不在 M6 扫描范围；provenance.ts 顶层零求值、无网络。

I3 采主提案（合成夹具），否决「真实 id 播种」备选：C5 只交付夹具 schema、版本校验与合成临时根夹具，qa 在 withTempRoot 内自建合成经历/事件→build→seed→audit，夹具 id 全部指向合成数据；tests/fixtures/memory/ 放合成 gold-l0/gold-l1/holdout/decoy 与 README 模板，README 明文「真实 L0/L1/holdout 人工标注与真实 id 属 C6，本目录 C5 仅合成夹具与格式」；C5 不碰真实根、不预填真实 id、夹具不含正文副本。

I4 口径统一：C5 新增 = src/memory/audit/ 六文件（fixtures/gold/decoy/consistency/provenance/metrics）＋ scripts/run-memory-audit.ts ＋ tests/qa/qa-memory-harness.test.ts ＋ tests/fixtures/memory/{gold-l0,gold-l1,holdout,decoy,README}.*；四探针模块 gold/decoy/consistency/provenance 对应 ProbeType 四值，fixtures（加载校验）与 metrics（聚合）是两个基建模块；「五件套」保留为 §1 D5 方法论称谓（BM25/轻卡/锚点/窗口/provenance 审计），与文件数无关，区分写明于 §9/§11.8；store.ts 随 I1-A 入 authorized，其余既有文件零改动。

I5 采「CLI 预计算 + DI」，本批不新增 PRODUCERS 登记：event.test.ts 本批零触碰，PRODUCERS 冻结现有 10 个；audit/ 六文件全文不得出现 .anchors 读取或 anchors: 形态（收尾包 grep 自证、审核方回码复扫）；事件当前态折叠（foldCurrentEvents）、merge/split 接力映射、anchor 折叠当前态一律在 scripts/编排层完成，算成标量/Map/anchorJson 字符串/anchor id 数组后注入 audit 纯函数；provenance 逐经历回查只持有 card.anchorJson 解析出的 id（用 anchorJson/anchorId 命名，不命中门禁 anchors 判据，miss/seed 已验证 anchor_json 不误伤），再调注入 resolver，不得在 audit 文件内访问 EventProjection.anchors（projection/types.ts:91）；若实现中确遇无法绕开的硬接缝，零行代码再报、逐次报批，禁止自行改 event.test 或登 PRODUCERS。

I6 六模块签名按提案原则冻结（逐字签名见 §4.10）：search 以注入回调传入且兼容 Promise（读柄 search 为 async）；atMs 必填、函数内禁 Date.now；随机源以 rng 入参注入、禁 Math.random；可测纯函数无 I/O 导出表驱动、编排薄层；复用 core Integrity/NotFound/Corrupted，memory-errors.ts 零改动、不新增错误类；纯离线、无网络、不调 LLM。

I7 夹具用 UTF-8 .json，每文件含 probeSetVersion:string、layer:'l0'|'l1'|'l2'|'decoy' 与条目数组；条目字段采提案（L0:eventId/channel/queries/aliases/sensitiveTerms/discriminatorNeighborEventIds/expectedSlots；L1:questionExperienceId/targetEventId/initiation/coldStart；decoy:pairCardIds/discriminatorQuery/goldCardId/highRiskLabel?）；夹具只含 id 与标注，schema 不得含 summary/body/raw_text 等任何正文字段，fixtures.ts 校验拒收；probeSetVersion 为非空版本字符串，正则冻结 `/^v\d+(\.\d+)*$/`；坏夹具抛 core 基类。

I8 RNG/CI：自实现确定性 mulberry32（零依赖），具名常量种子 DEFAULT_RNG_SEED=20261111（文档定死、写入 notesJson.rngSeed）；bootstrap 有放回重采样 1000 次、percentile 法取 2.5%/97.5% 分位（v1 不做 BCa）；同种子同输入逐字节一致，用「重复运行相等 + 小数组手算分位」表驱动反证；provenance 20% 分层抽样共用同一注入 rng；属观测值，注释标明 harness 校准后凭数据修订。

I9 metricsJson 按 retrieval/assembly/quality/roi 四组；比率类统一 {point,ciLower,ciUpper,n}；N/A 项统一 {status:'n-a',reason}，不填 0、不参与达标判定；notesJson 记 {consistency:{status,pairs},holdout:{mode,folds,unsealedAt?},rngSeed,sampleN,…}；三红线只进报告、不进代码断言、不卡命令退出码；唯一硬失败是 provenance 成功率<100%/悬空锚点（见 I13）。

I10 hit_count 不回写生产卡：harness 只在内存/报告里模拟 hit_count 累积以产 §6.6 写侧 ROI 三表，不得产生任何 UPDATE mem_card 写路径；生产卡 hitCount 恒 0、lastHitMs 恒 null（types.ts:58「仅离线回放更新」据此解释为 audit 报告/audit 库 item 的观测口径，绝非改生产卡）；真实回填留待实时阶段另案。

I11 audit CLI 旗标：--data-root 必填（缺省 exit2）；--out 必填（缺省 exit2）且不得位于 dataRoot 之内（exit2）；--json/--help 同 build CLI；--holdout 缺省不跑、仅显式传入才解封 L2；因写的是 dataRoot 外独立 --out 库、不触生产索引/真值，默认即可写 audit 库、不需要 --apply 二次确认；另提供 --dry-run 只校验/打印不落 audit 库（CI 预检用）；退出码：provenance 硬失败/悬空锚点非零，红线观测项无论是否越线均 exit0。

I12 P95：只测 assembleWindow 纯函数路径（不含检索 I/O、不含宿主 LLM/网络）；performance.now() 仅在 CLI/harness 编排层计时、纯函数内不计时；固定重复 N=1000 次取 P95（文档冻结 P95_REPEATS=1000），报告记录 process.version 与 process.platform；仅观测、不卡门禁。

I13 M7 投毒自证分两通路（勿混淆红线与硬失败）：①造悬空 anchor/provenance 失败 → run 必须 failed、退出码非零（硬失败通路）；②向 decoy/gold 注入一条错标 expected/goldCardId → 不要求 run failed，但断言 R2 精确捕获该注入错误（top1 不符被记、错误计数≥注入数，验证指标不漏报，属指标正确性通路）；投毒后逐字节还原夹具（sha256 前后一致）→ 回绿，脚本与完整日志随收尾包。

I14 decoy 近邻：不改 C4 已冻结 jaccardNeighbors 签名（入参 CandidatePacketRow）；在 decoy.ts 内对 term 集合实现同一 Jaccard 口径（规范化 cue+alias term、|交|/|并|、相似度降序→id 升序），抽共享集合纯函数或等价实现，并加表驱动测试：对等价 term 集合 decoy 结果必须与 jaccardNeighbors 一致以防口径漂移；每张卡取 top2 近邻（不足取实际可用数）；判别提问在合成 decoy.json 预置，真实 L0 判别提问归 C6。

I15 LOEO 降级：触发判据冻结为「可覆盖日历周数 < 5（切不出后 20% 完整周）→ LOEO」；当前 10 个 ready 事件 C5 合成与 C6 真实首跑均预期走 LOEO，禁止伪装独立 holdout；LOEO 留一事件交叉验证，折数=参与事件数（C6 为 10 折，C5 合成夹具折数=合成事件数并显式标注），notesJson 记 holdout:{mode:'loeo',folds:n}；解封记录 README 模板 C5 写、C6 真实解封填。

I16 接力/冷启动/分层：接力映射复用 foldCurrentEvents（event-row.ts:88）取当前态 ＋ invalidate successorCardHints（G11）给 successor 链，detail 记录接力链、不新写映射；冷启动 = 提问轮与目标事件 occurred 差 > 7*24*3600*1000 ms 且其间无指向同一 event_id 的经历（只读真值计算）；引发方分层固定 her/user/environment 三类，经历 initiation='system' 归一到 environment 并在报告注明归并规则（KNOWN_INITIATIONS 四值 experience.ts:24，不增设第四分层）；k=3 主测，k=1/5 敏感性对照（§6.2）。

上述口径已先行增补至 §4.10（冻结逐字签名）/§4.11（独立库与旗标全集）/§6.8（RNG/CI/LOEO/分层/hit_count 边界/N-A/M7 两通路/合成夹具）/§9（六文件口径统一）（文档先行，DoD 第 6 条），代码按增补后方案 TDD 施工。

**白名单与纪律.** 本批新增仅：src/memory/audit/ 六文件、scripts/run-memory-audit.ts、tests/qa/qa-memory-harness.test.ts、tests/fixtures/memory/*；授权既有仅 store.ts（I1-A）与本方案 md；event.test.ts 本批零触碰（I5）、memory-errors.ts 零改、其余既有文件零改动。生产 dependencies 保持 {}、零新依赖、无网络/子进程/eval/真实根字串；自动化只用 tests/helpers 临时根、dataRoot 必填；edge.invalid_ms 恒 NULL、不写 topic_lines、模块顶层零求值；真值只读、审计不动卡（I10）。测试入场照报备：M7 两通路（悬空/provenance 硬失败→failed 退出非零；错标金标→R2 精确捕获）、N/A 规则、bootstrap 确定性、provenance 硬失败、LOEO 降级标注、hit_count 不回写（生产卡 hitCount 恒 0）；TDD 红→绿留日志，投毒变异反证（逐字节还原 sha256 一致回绿）随包。打包沿用 new-files/authorized-changes/baseline-context/evidence/README：new-files 内 C1–C4 文件与 C4 收尾包逐字节一致并附 sha256；store.ts authorized diff 置顶；verify 如实标注平台 skipped（win32 M9）。不 git add/commit/push（HEAD 保持 eafe484，统一本轮末一次性授权）；C5 未放行前不得进入 C6；再遇未覆盖项零行停工报批。完成后待命。

**行号锚点（增补后实测）.** §4.3 已冻结 writeAuditRun 签名第 373 行；§4.10 冻结签名块第 521–694 行（metrics mulberry32 第 538 行、aggregateMetrics 第 571 行、insertAuditRun 第 574 行、insertAuditItem 第 575 行；fixtures loadFixtures 第 607 行；gold replayGold 第 632 行；decoy buildDecoyPairs 第 647 行；consistency evaluateConsistency 第 663 行；provenance auditProvenance 第 690 行；store.ts 写柄增项第 694 行）；§4.11 C5 补充口径第 726 行起；§6.8 第 792–808 行；§9 C5 行第 868 行、I4 口径统一第 873 行；本节（§11.8）第 1000 行起。因 C5 增补整体下移：§11.5/§11.6/§11.7 历史正文一字未动，其内部引用的行号为各自交付期实测。

**后续口径.** I5 anchors 门禁本批不登记（采 CLI 预计算 DI 绕开），若实现遇硬接缝仍按 §11.5 逐次报批、不预授权；C5 交付经外部审核放行前不进入 C6。

### 11.9 C6 阶段 2.5 裁决记录：路径 A 投影层受控锚点重映射（remap-anchors）

> 【已废止 · 见文首 2026-11-12 裁决】本节记录的路径 A 受控重映射机制（`anchor-remap.ts`、`remap-anchors` 动作、候选池 `candidateExperienceIds`、人工 worksheet 指定映射、builder remap 回放与陈旧拒绝）已整体从代码移除，相关类型字段与测试一并删除。builder 现恢复为纯悬空硬失败，34 个语义标签锚点不再被代码消解、无人工绕行，合规解法归 #42 自动建卡。以下背景、取舍与五项闸口正文保留为历史裁决存档，**不代表现存行为**。

**背景与 34 悬空根因.** `foldCurrentEvents` 后 10 个 `closed + ready` 事件，实测分三类：2 个原生合规 26 位 ULID 锚点事件（锚点 13/13 落时间窗、0 窗外）；7 个纯语义标签事件（去重悬空标签 34 个、引用 37 次）；1 个空锚点事件（`anchors=[]`，窗内恰 2 个候选经历）。根因：事件 `anchors` 字段在生成期沉淀了自然语言标签、内部工具名或空集合，并非经历 ULID；既有 builder 第③关直接对原始锚点回查经历全集，标签必然触发悬空 fail-fast。标签本身不具经历身份，真值层事件 `anchors` 不得回写 ULID（真值只读、内核零改）。

**路径取舍（路径 A）.** 采路径 A：投影层受控锚点重映射。人工 worksheet 把标签/空锚点映射到候选池内真实经历 ULID；先记一条 `remap-anchors` 决策留痕，再建常规卡；builder 回放 remap 得到 `effectiveAnchors` 贯通派生。未采三条备选：①回写真值事件 `anchors`（突破真值只读与回滚边界，VETO 级）；②改内核 projection 锚点折叠口径（内核五目录零改）；③纯函数自动挑选最近/最相关候选（禁止；选择结果只能来自人工 worksheet 指定）。

**新 action 与台账字段（§3.5 修订）.**

- `DecisionRecord.action` 联合类型增 `'remap-anchors'`；增可选字段 `original_anchor_json?: string`、`remap_json?: string`（append-only 旧行无此字段，缺省合法；字段一旦出现即须非空字符串）。
- remap 行口径：`card_id=null`；`event_id` 合法；`anchor_json` 存 resolved 排序去重 ULID 数组 JSON；`original_anchor_json` 存 `JSON.stringify(原始 anchors 快照)`；`remap_json` 存规范化映射明细 JSON；`content_hash=computeRemapHash`；`model_tag='human'`；`created_by='offline-operator'`；`reason` 为受控短码（`seed-remap` 或 `seed-remap;elapsed_ms=N`），不复制正文。
- `CandidatePacketRow` 增可选 `anchorRemap?: { mappings: ReadonlyArray<{label, targetExpIds, dropped?, reasonCode?}>, supplementalAnchorIds? }`。
- ledger 白名单增 `'remap-anchors'`；该分支校验 `card_id===null`、两个留痕字段必填非空、`remap_json` 可解析为对象、`anchor_json` 为字符串数组；旧五类行原校验不变，新字段缺省合法、出现即校验。

**候选池闭区间强校验.**

- 池口径唯一实现 `candidateExperienceIds(event, experiences)`：同 channel 且 `Date.parse(occurred_at) ∈ [started_ms, ended_ms]`，窗界含端点；纯函数不按最近邻排序、不做语义匹配，池只作校验边界。
- 目标 id 三校验依次为：`isUlid`（26 位 Crockford）→ 属于经历全集 → 属于事件候选池；非 ULID 与池外抛 `IntegrityError`，经历不存在抛 `MemoryAnchorDanglingError`（`IntegrityError` 子类），任一违约整份拒绝、零产物。
- 标签集合逐字相等：worksheet 映射的 label 集合必须与原始锚点中的非 ULID 标签全覆盖、无多余、无重复。

**drop 与 reasonCode 枚举（v1 冻结最小集合）.**

- `CONTROLLED_DROP_REASON_CODES` 仅含 `'no-matching-experience'`：时间窗同通道内无匹配经历，该标签放弃锚定。
- `dropped=true`：`targetExpIds` 必须为空且 `reasonCode` 必填；非 dropped：`targetExpIds` 至少 1 个。枚举外字符串整份拒绝。
- 如需新增原因码，必须先在本节逐码登记口径，代码校验器才放行；代码中不得出现未登记字符串。

**空锚点补锚.**

- `anchors=[]` 事件：`mappings=[]`、原始快照 `[]`；`supplementalAnchorIds` 从候选池补入至少 1 个，同样过 ULID/存在/池内三校验；remap 行 `original=[]`、`resolved=补入 ULID`。
- 任何事件解析后 `resolved` 必须非空，否则不得建卡。

**seed / builder 编排（§4.6 / §4.7 修订）.**

- seed：`buildCandidatePacket` 的 anchors 保持事件原始快照；`validatePacketAgainstTruth` 第②关保留 `row.anchors` 与事件 `anchors` 逐字深比较（原始锚点陈旧检测，不被 remap 替换或放宽）；第③关经 anchor-remap 解析出有效锚点后再做存在性 + 候选池强校验。apply 循环对每个需重锚/补锚事件先 append 一条 `remap-anchors` 决策（`card_id=null`），再 append 常规 `create-card`；该卡 `deriveCardId(event.id, resolvedAnchorIds)`、`anchor_json=JSON.stringify(resolvedAnchorIds)`；原生 ULID 事件路径不变，只出 `create-card`。
- builder：步骤 4 悬空校验前 `readDecisions` 并 `replayAnchorRemaps`（同事件多条按台账顺序后者覆盖前者），先于 tombstone/invalidate 状态回放；每事件 `effectiveAnchors = remap.resolved ?? 规范化排序去重后的事件 anchors`；先校验 `remap.original_anchor_json` 与当前事件 `anchors` 逐字一致（不符抛 `IntegrityError` 陈旧拒绝，不覆盖），再对 `effectiveAnchors` 做悬空回查与候选池强校验；步骤 5 `deriveCardId`/`anchor_json`/内容哈希一律用 `effectiveAnchors`。同真值同决策下 seed↔build 的 `card_id/content_hash/anchor_json` 逐行相等，连跑幂等。
- 无 remap 决策时全部既有行为与阶段 1 逐字一致（718 基线零回归）。

**留痕面与零正文边界.** 中文标签、内部工具名只允许出现在 indexDir 内 `decisions.jsonl` 的 `original_anchor_json`/`remap_json` 留痕字段；`mem_card` 任何列、`mem_alias`、`mem_card_fts`、`mem_miss` 零标签零正文；FTS 派生逻辑零改；`hit_count/weight/lastHitMs/edge.invalid_ms/topic_lines` 既有冻结不变；seed 内不引入 `Date.now`/`new Date`（时钟仍由 CLI 边界注入）。

**审计漂移回放.** `run-memory-audit.ts` 缓存漂移判定：真值事件 `anchors` 映射优先；台账回放 remap 得到的 `resolved → eventId` 作为兜底（真值未登记时补入），使 remap 卡不被误判 drift。provenance 硬失败口径不变：成功率 <100% 或悬空锚点 >0 即失败。

**为何不改真源与内核 / 回滚边界.** 真值 JSONL、`channels/state`、`fasti.sqlite` 从无写路径；remap 状态只落 indexDir（`decisions.jsonl`/`revisions.jsonl`/`memory-index.sqlite`）。回滚仍为删除 `projection/memory-index/`，实时进程不读该目录、无需重启；删除索引目录后可从真值 + 底表候选重新推导，无第二处外部状态存储。内核五目录 `src/api`、`src/event`、`src/source`、`src/adapters`、`src/projection` 零改；`store.ts`、`schema.ts` 本轮零改；`tests/contract/event.test.ts` 零触碰；四配置与 `dependencies: {}` 不变。

**对既有章节的修订点.**

- §3.5：`DecisionRecord` action 增 `remap-anchors`；两个可选留痕字段；remap 行形状如上。
- §4.6：builder 回放 remap → `effectiveAnchors` → 贯通派生；陈旧守卫；池内强校验；幂等口径补 `anchor_json` 逐行相等。
- §4.7：seed 双锚点口径（worksheet anchors 原始深比较；建卡用 resolved）；候选池闭区间；remap 决策先于 create-card 落账。
- §7：10 事件验收细化为 2 个 ULID 直通 + 7 个标签映射 + 1 个空锚补锚；decisions 计数为 8 条 `remap-anchors` + 10 条 `create-card`（以副本实跑为准）；anchor 100% 可解析口径含补锚事件。
- §8：DoD 兼容项——无 remap 行行为逐字一致；旧五类决策行向后兼容；新增受控原因码须先文档登记。

**留痕哈希键序.** `computeRemapHash(originalAnchorJson, resolvedAnchorJson, remapJson) = sha256(JSON.stringify([originalAnchorJson, resolvedAnchorJson, remapJson]))`，三个入参均为 JSON 字符串，表冻结确定性。

**人工闸口说明.** 真实 `targetExpIds` 选择与 L0 标注属人工 G2 闸口；阶段 2.5 仅交付 `pending-human-review` 评审草稿（逐标签列底表候选、预留 L0 字段位），草稿不进入任何索引写路径。阶段 2.5 演练实测：verify 755 = 基线 718 + 新增 37；副本 e2e 悬空 34→0、10 卡 active、provenance 抽样成功率 1、`mem_miss=0`、独立审计库 `mem_card/mem_miss=0`；连跑 shadowDiff=0、业务列全等、revisions 链连续；真实根聚合哈希恒定 `f73f8ff9f25c55e96bee`，`projection/memory-index/` 始终不存在。

---

## 12. 风险与回滚

| 风险 | 触发形态 | 预防（设计内） | 回滚动作 |
|---|---|---|---|
| 离线库影响实时链路 | 意外 import/共享句柄 | M6 静态隔离 + 不打开 fasti.sqlite + 独立目录 | 删 `projection/memory-index/`，实时进程无需重启即无感知（其根本不读该目录） |
| 种子卡质量差/线索污染 | 金标召回不达预期、诱饵误认 | 先观测不卡发布、worksheet 校验、审计硬失败悬空锚点 | 卡可 tombstone（status+decisions 留痕）；decisions.jsonl 不删，整体停用某批卡只需重建时按决策过滤 |
| 真值修正导致锚点接力 | 事件 merge/split（§3.3） | 纯函数给 successor 提示不自动迁卡；缓存漂移审计 | 离线重跑种子流程确认新卡；旧卡置 superseded，无真源改动 |
| schema 演进失误 | 未来加列/改表 | schema_meta+revisions 账本、IF NOT EXISTS 起步、禁 ALTER 改历史行 | 新版本影子库构建失败则不 stamp，旧库继续服务；账本支持按 revision 重建指定版本 |
| 真实根误写 | 漏传 --apply 守卫或参数错误 | dry-run 默认、dataRoot 必填、写柄单例、M9 | 索引目录整体删除即可重建；真值与 fasti.sqlite 从无被写路径，无需数据修复 |
| 小样本误判红线 | 10 事件/少量金标下置信区间过宽 | bootstrap 区间、N/A 规则、holdout/LOEO 诚实降级 | 红线只观测不门禁，误判不产生任何自动动作，累计样本后再评审 |
| 范围蔓延（把演进项带进 v1） | PR 出现空表/向量/调度代码 | §10 表 + DoD 第 6 条 + 提交文件白名单 | 评审驳回；已合入则按提交整体 revert（六提交均独立可回滚） |

---

## 13. 返工守门点与实施前确认 checklist

### 13.1 《落地分析》§3.4 九条返工守门点的控制点映射

1. 选择索引独立成投影、严禁 event 表加列 → §3.1/§3.2 DDL + M6。
2. 零正文、无事实/情绪/会话字段 → §3.2 禁列 + 种子子串反查 + M6/M11。
3. 锚点锚真源经历 id、事件 id 仅缓存 → §3.2 anchor_json 权威位 + §6.7 缓存漂移检测。
4. 阈值观测化、不硬编码门禁 → §2.2 常量注释与审计只观测原则；700 字/一轮补取是结构约束不是调参。
5. 离线提交不混实时 → §9 文件白名单 + M6 import 扫描。
6. 不提前实现 erase/P8/调度 → §1.1 out 清单 + K3/K5/K9。
7. 外部机制只吸收语义不搬依赖 → §10.1 逐机制边界列。
8. 决策与迁移全程留痕、可重建可对账 → §3.4/§3.5 + M4。
9. P1 级内核缺陷在 C 块前清零——【事实】切分器接线类 P1 已由 eafe484 修复（`segmenter.ts:278-292`、门面接线 `api/index.ts:997-1021`），本方案不再阻塞；实现期若发现新内核问题，停手提缺陷而非在 memory 模块绕行。

### 13.2 实施前确认 checklist（拍板项）

- [ ] 文件名与模块落点确认（`docs/memory-v1-offline-scaffold-plan.md`、`src/memory/`、`projection/memory-index/`）。
- [ ] 三红线经验初值确认：R1 ≥0.85、R2 ≤0.05（高危五类 0 容忍观测）、R3 ≥0.8（v1 允许 N/A）。
- [ ] 近因先验初值 λ=0.15、半衰期 30 天确认其「仅观测、harness 修订」身份。
- [ ] 确认生产 dependencies 维持 `{}`，无新增依赖申请。
- [ ] 【已废止，无需确认】原“确认 C6 真实根运行的操作人与时间窗（……仍要求人工在场）”——人工 seed/真实根建卡通道已取消，不再有人工在场环节（见文首裁决）。
- [ ] 【已废止，无需确认】原“确认金标 L0 人工标注责任人与验收会议口径（§7 七步）”——L0 人工标注随 seed 一并取消，建卡判断主体改为「她」，由 #42 自动建卡承接。
- [ ] 确认六个提交边界与「方案先修订、代码后变更」的分叉处理规则。
- [ ] 确认 K1–K13 重议条件表冻结，未来重议走外审不在实现 PR 内讨论。

---

## 附录 A：新增文件清单（实现期总览，当前全部不存在）

> 现状更新（2026-11-12）：标注〔已删除〕的 seed 相关文件已随人工通道下线；阶段 2.5 引入的 `src/memory/anchor-remap.ts`、`tests/memory/anchor-remap.test.ts`、`tests/memory/dirty-root-fixture.test.ts` 与脏根夹具同期删除（见文首裁决）。未标注者为现存文件。

```
src/memory/
  memory-errors.ts          # C1
  types.ts                  # C1
  schema.ts                 # C1
  store.ts                  # C1
  ledger.ts                 # C2（revisions/decisions JSONL）
  builder.ts                # C2
  bm25.ts                   # C3
  invalidate.ts             # C3
  serial.ts                 # C3
  window.ts                 # C3
  seed.ts                   # C4〔已删除，见文首裁决〕
  miss.ts                   # C4
  audit/
    fixtures.ts gold.ts decoy.ts consistency.ts provenance.ts metrics.ts   # C5
scripts/
  build-memory-index.ts     # C2
  seed-memory-cards.ts      # C4〔已删除，见文首裁决〕
  run-memory-audit.ts       # C5
tests/memory/
  schema.test.ts store.test.ts builder.test.ts ledger.test.ts
  bm25.test.ts invalidate.test.ts serial.test.ts window.test.ts
  miss.test.ts             # 原 seed.test.ts 已删除（见文首裁决）
tests/qa/qa-memory-harness.test.ts                       # C5
tests/fixtures/memory/                                   # C5（gold-l0/gold-l1/holdout/decoy + README）
```

数据根产物（不进 git，C6 才出现）：`<dataRoot>/projection/memory-index/{memory-index.sqlite, revisions.jsonl, decisions.jsonl}`。

## 附录 B：证据索引

- 冻结面与禁写能力：`src/contract/frozen-surface.ts:18-24`、`:78-101`；测试先例 `tests/contract/frozen-surface.test.ts`。
- 现有投影 DDL：`src/projection/schema.ts:19-54`、`src/projection/event-schema.ts:14-42`；库路径 `src/projection/detect.ts:50-56`。
- 原语契约：`src/contract/primitives.ts:52-73`、`:207-286`；指针解析 `:262-263`。
- 数据根布局：`src/source/paths.ts:41-49`、`:72-83`；node:sqlite 用法 `src/projection/sqlite.ts:13`、trigram 回退说明 `:467-481`。
- 事件层当前态：门面读/修正原语 `src/api/index.ts:925-1071`；P1 接线 `src/event/segmenter.ts:278-292`；折叠纯函数 `src/projection/event-row.ts:53-98`；写边界白名单 `src/contract/validate-experience.ts:73`、`:402-409`。
- 错误基类：`src/core/errors.ts:19-123`；测试基建 `tests/helpers.ts:14-88`；脚本纪律先例 `scripts/backfill-events.ts` 头部注释。
- 设计文档：D1–D5《memory-book-index-review.md》附录 E.6；事件修正与不重建纪律《b-block-event-layer-design.md》§7.1.2（行 533-545）、§7.3（558-571）、§7.4（573-578）；《framework-survey-landing-analysis.md》§3/§4；《chat-memory-frameworks-survey.md》九卡片（外部 commit：Mem0 f1791da、Graphiti e911422、Letta/letta-code c936963、LlamaIndex 5f95c79、Cognee 8853378、AstrBot 68acac9、MaiBot e539150）。
- 运行态实测（2026-11-11）：252 经历、10 closed/ready 事件、checkpoint tick=251/L1 健康；HEAD `eafe484`、517 用例全绿。

