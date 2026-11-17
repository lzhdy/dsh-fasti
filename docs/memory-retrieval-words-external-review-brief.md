# 记忆检索词写入双路线外部评审送审材料

> 版本：2026-11-16 送审稿（自包含，可离线评审，不依赖访问代码仓库）
> 评审对象：两条互相关联、拟同步推进的检索词写入路线
> - 路线 A「保底 cue」：将事件已固化的 `key_points` 确定性物化到记忆卡的展示线索（cue）
> - 路线 B「#120 漏召别名建议器」：通道一落空后，由她自主回查目标卡并窄写一条精确别名
> 编号：A 拟取 **#123**（当前下一可分配空号，待主控确认取号）；B 为既有锁定号 **#120**（待立项）
> 基线：仓库 HEAD `d34a3bf`（**已推送至远端 main**，远端与送审基线同一 commit，行号一致）；真机 dataRoot `/home/user/.dsh/fasti`，记忆门 `memoryGateMode='on'`
> 代码：**https://github.com/lzhdy/dsh-fasti**（公开仓库，可匿名 clone；`git log -1` 应为 `d34a3bf`；无法访问代码时用附录 C 的原文摘录）
> 阅读方式：本文第 2 节给出全部所需事实与代码坐标，第 4、5 节给出两路线方案，第 8 节是待裁定问题清单
> 请评审者输出：对 **§8 的 Q1–Q10** 逐条给出「同意／反对／存疑」＋理由；若反对，请给出可替代的具体设计，不要只给方向性意见

---

## 0. 一句话总览

写入链路已修复并真机跑通（2 张卡建出、幂等、零报错），但**读取面物理为空**：卡上 cue 是空串、别名 0 条、任何查询词 0 命中。原因不是故障，而是"给卡产检索词"的三个口子当前全关：运行期自动抽词受冻结令禁止（587/K5）、反思/做梦通道未解冻（#93）、落空补别名未立项（#120）。

本材料把其中两条最接近可施工的路线一并送审：**A 走"已有真源字段的确定性投影"，B 走"落空后她的自主判断窄写"**。两者都作用于同一 FTS 检索面、都会改变"什么词能召回哪张卡"，因此必须合并评审；但两者在污染模型、可重建性、数据面依赖上完全不同，可分别裁定、分先后放量。

---

## 1. 背景

### 1.1 已修复：写入链路（#122）

真机曾出现"每轮 drain 正常空轮、永不建卡、零报错"，定位为两个串联断口：记忆工具层 `dataRoot` 未透传（`d70575d`）、web 宿主胶水白名单漏转 `memoryGateMode`（`4b470af`）。修复后真机建出 2 张 active 卡，revisions 新增 `reason='drain-projection'` 条目，多轮幂等、日志零错误。**写入侧不是本次评审对象。**

### 1.2 暴露：读取面为空

只读实测（真机库 `projection/memory-index/memory-index.sqlite`，mode=ro）：

| 事实 | 值 |
|---|---|
| `mem_card` | 2 行，均 `status='active'`、`display_cues_json='[""]'`、`aliases_json='[]'`、`discriminator=''` |
| `mem_card_fts` | 2 行，`cue_text` **均为空串** |
| `mem_alias` | **0 行** |
| `mem_miss` | **0 行**（on 拨档后尚无真实查询流量） |
| 查询实测 | 「荷花／池塘／翻倍／3 加 5 等于 8／会话记录」**全部 0 命中** |

卡片本身并非无内容：两个闭合事件带有 LLM 提炼好的 `key_points`，文本一：
`用户询问上次对话内容` / `助手称无法读取此前会话记录，只能看到当前对话` / `助手请用户提醒上次主题` / `用户随后要求一句话说明助手身份，未展开`；
文本二：`3 加 5 等于 8` / `荷花每天面积翻倍，第 30 天长满池塘` / `第 29 天荷花长到池塘一半`。

### 1.3 为什么这些词没进检索面

建卡取 cue 的唯一来源是经历上的 `observation.cue`（`src/memory/drain.ts:257`），而真机 7 条 dialogue 经历的 `observation` 结构上只有 `{text:{id,channel,shard,seq}}`、**没有 `cue` 字段**。于是 `src/memory/builder.ts:169-201` 按零正文纪律落 `[""]` 占位、`aliasesJson='[]'`、`discriminator=''`，`src/memory/derive.ts:107` 亦明确"期望态活卡不含 cues/别名等不可导残差"。

与此同时，`key_points` 在记忆侧**零消费**：全仓 grep 出现在事件契约（`src/contract/event.ts:149,509`）、闭合生产（`src/event/closure.ts:420`）、LLM 解析（`src/adapters/dsh/llm.ts:250,359`）、**L1 事件投影**（`src/projection/event-row.ts:38,67,206,239`、`src/projection/event-schema.ts:28,58`、`src/projection/sqlite.ts:361-420` 的 upsert 连同 `summary_model`/`summary_prompt_version`）、`src/audit/fixtures.ts:5`（拒收条款）、修正与分段（置空）——**没有任何代码把它桥接到记忆检索字段（cue／alias／discriminator）**。这一列举口径本轮已按外审更正值补全（原稿漏了 projection 与 audit 两处）；核心论断不变：检索面没有任何一条 `key_points` 的影子。

### 1.4 三个产词口当前都是关的

| 产词口 | 卡号 | 状态 |
|---|---|---|
| 运行期自动抽 cue/alias | 未立项（A 拟 #123） | 冻结令 587/K5 禁止；#42 §2.6 要求整卡立 charter |
| 反思/做梦产内联短线索 | #93 / #94 / #110 / #98 | #93 未解冻，判断类写入一律不发生 |
| 落空后自主回查补精确别名 | #120 | 已锁号待立项；数据口径 D-1 未定 |

---

## 2. 评审前置事实（数据模型、代码坐标、检索机制）

### 2.1 分层语义（本项目既有定义，评审必须以此为准）

| 层 | 载体 | 性质 |
|---|---|---|
| 原话真源 | `raw-turns/*.jsonl`（append-only） | 唯一存全文处 |
| 经历真源 | `experiences/*.jsonl` | 存 Pointer 引用 + 字数，不存正文；可带内联短 `cue`（反思/做梦用） |
| 事件二级真源 | `events/*.jsonl` | 写入即固化、不可由算法批量重建；含 `summary`／`key_points`／`anchors`／`topic_lines` |
| 记忆投影 | `memory-index.sqlite`（可整体丢弃重建） | 零正文轻卡：`display_cues`／`aliases`／`discriminator` + FTS |

#42 定稿 §3.7 的双栏语义：投影 = **真源可导部分**（结构化卡、FTS、活卡映射、判断别名）+ **投影残差**（miss 别名、`hit_count`/`weight`、miss/影子观测）。**可导部分整库重建可精确复现；残差不可再生，重建归零。**

### 2.2 代码坐标（基于 HEAD `d34a3bf`；行号可能漂移，以符号名为准）

| 位置 | 内容 |
|---|---|
| `src/memory/drain.ts:257` | `cueByExperience.set(experience.id, experience.observation?.cue)` —— cue 唯一来源 |
| `src/memory/builder.ts:169-201` | `materializeDrainCardRow`；`:171` cues 取前 3；`:172` 空则 `[""]`；`:173` 别名恒 `[]`；`:174` discriminator 恒空 |
| `src/memory/derive.ts:107` | 期望态活卡"不含 cues/别名等不可导残差" |
| `src/memory/fts.ts:35` | `cueTextOf`：FTS 文本 = `display_cues` + 活跃且非敏感别名，**绝无正文/摘要** |
| `src/memory/schema.ts:51` | `CHECK (json_array_length(display_cues_json) BETWEEN 1 AND 3)` —— 卡面线索 1–3 条硬约束 |
| `src/projection/sqlite.ts:39` | `MIN_TRIGRAM_LENGTH = 3` |
| `src/memory/bm25.ts:114` | 查询规范化后码点 ≥3 才走 `mem_card_fts MATCH`；否则退 `mem_alias` 精确（整句等值）；LIKE 回退会被门构造性拒（`gate.ts:118-119` `like-only-weak-match`） |
| `src/memory/gate.ts:48` | `normalizeLexicalText`：NFKC + ASCII 小写 + 空白折叠 + 去首尾 |
| `src/contract/event.ts:149,509` | `key_points: string[]`，写入模式严格校验 |
| `src/event/closure.ts:420` | 闭合慢路径把 LLM 的 `keyPoints` 写入事件版本 |
| `src/adapters/dsh/llm.ts:250,359` | `key_points` 解析（非数组视作空数组） |
| `src/assembly/memory-tools.ts:249` | on 态唯一召回路径 `runGatedSearch` |
| `src/assembly/memory-tools.ts:253` | abstain／no-match 且词面非空 → `recordMissOrSwallow` 落案底 |
| `src/assembly/memory-tools.ts:267` | `addMissAlias`：非 on 态返回 `deferred/gate-not-on` |
| `src/memory/miss.ts:21,34` | `mem_miss` 七字段入参白名单；`anchor_event_id`/`anchor_json` 建表预留、v1 恒 `null` |
| `src/memory/alias-write.ts:27,170` | `MAX_MISS_ALIASES_PER_CARD = 5`；达上限返回 `alias-cap-exceeded` |
| `src/memory/store.ts:510` | `addMissAlias` 落库（决策行 provenance 见 §5.4） |

**代码获取**：仓库地址、分支、远端与送审基线的差异见 §11；即使无法访问仓库，附录 C 已摘录评审必需的代码原文，可独立完成 Q1–Q10。

### 2.3 检索三通道与语料来源

`src/memory/bm25.ts` 的命中顺序是 `exact-alias → fts-substring → like-fallback`，但门（`src/memory/gate.ts`）只接受前两条的命中，第三条是构造性拒绝的死通道：

1. **exact-alias**：`mem_alias.term_norm` 与**整条查询规范化后的全文**等值（`bm25.ts:105-111`，`q = normalizeQuery(query.text)`，任意长度）；
2. **fts-substring**：规范化查询码点 ≥3 时走 `mem_card_fts` trigram `MATCH`，且**整句查询必须是某卡 `cue_text` 的连续子串**（纯 ASCII 另加词边界，`gate.ts:107-117`），否则拒；
3. **like-fallback**：即使 LIKE 命中也被门一律拒为 `like-only-weak-match`（`gate.ts:118-119`，注释原文"构造性拒绝，与任何数值阈值无关"）——**LIKE 不构成召回通道**。

语料面：`cue_text` = `display_cues` ＋ `活跃且 sensitive===0 的别名`（`fts.ts:35-41`）。而运行期写出的 miss 别名**恒 `sensitive=1`**（`runtime.ts:106-113`，架构 §6.7 明言"包装层固定为 1，危险选项不可表达"），故别名只走通道 1，**永不进 FTS、永不走 LIKE**。**B 的实际语义 = 整句等值复现**，不是词级召回；`2 字词嵌长句不可召回`是当前检索面的系统级天花板。本节为本轮据外审更正的版本（原稿把 LIKE 列为召回通道之一，系失实）。

### 2.4 现有评测设施（离线、不依赖线上流量）

`src/memory/audit/` 九个模块均有实现：`gold.ts`（R1 金标召回回放）、`decoy.ts`（R2 诱饵误认，含 jaccard 近邻构造）、`metrics.ts`（bootstrap 重采样，`DEFAULT_RNG_SEED=20261111`、`BOOTSTRAP_RESAMPLES=1000`）、`four-state.ts`（门后四态分类）、`rates.ts`、`provenance.ts`（锚点解析率硬失败）、`consistency.ts`、`fixtures.ts`（夹具加载与校验）、`shadow-read.ts`（影子观测读取）。

**但夹具只有个位数合成数据**：`tests/fixtures/memory/` 内 gold-l0=2、gold-l1=2、decoy=1、abstain=2、holdout=1，仅够证明管线可跑，**不具备统计效力**。

---

## 3. 必须遵守的约束（方案已按此设计，请评审时一并核验）

1. **冻结令（587 / K5）**：自然语言检索词（cue／alias）受约束，"不得让模型静默生成"；其自动化必须满足 6.4 数据门槛并通过外部评审后才**解冻**，解冻前字段留空。**这是 A 路线是否成立的先决问题（Q1）。**
2. **运行回路零人工**：不设任何运行期手动确认/审批按钮；人工 seed 通道与锚点 remap 生产代码已整体下线。解冻是工程期一次性批处理，不是每批次点确认。
3. **零正文纪律**：检索面不得含 raw 正文或 summary 长句；`mem_miss` **不落原始查询全文，但落规范化全文**——`miss.ts:33-34` 的 `INSERT` 同时写 `term_norm`（明文）与 `term_hash`，写入值为 `normalizeLexicalText(整条查询)`（`memory-tools.ts:205-211`）；中文 NFKC 近乎无损，故规范化等价于"查询内容在盘"。本条为本轮据外审更正（原稿括注"只存 term_hash"失实）；`term_norm` 正是 #120 离线分析与需求绑定守卫的基础。
4. **可重建性**：投影可整库丢弃重建；可导部分必须能精确复算，残差须显式登记（A 计划归入可导，B 归入残差）。
5. **单一写者 / append-only**：真源 append-only、单写者队列；`mem_miss`、`decisions.jsonl` 亦 append-only。
6. **依赖方向（M6 规则①）**：L4/L5 记忆层不得被事件链路反向依赖；不新增白名单符号与生产依赖。
7. **不新增**守护进程／定时器／`fs.watch`／真源字段／生产依赖；drain 内不得调 LLM（#42 明确否决）。

---

## 4. 路线 A：保底 cue（拟 #123）

### 4.1 语义定性

A 是**确定性投影规则**：读取事件上**已固化**的 `key_points`，经纯函数清洗后写入卡的 `display_cues`，不做任何生成、不调任何模型、不读正文。因此：

- 纳入"真源可导部分"：给定同一份 `events` 必产出同一份 cue，可随 `rules_version` 整库精确重算；
- 满足零正文：`key_points` 是事件摘要的要点句，非 raw 正文；
- 写入面仅 `display_cues`（1–3 条），由 `fts.ts:35` 自动并入 `cue_text`。

**争议点**：`key_points` 虽已固化，但词面由 LLM 产出；把它搬进检索面，是否仍属 587 所说"模型静默生成检索词"？若属，则须改走受约束模型候选或纯词法抽取（见 Q1、Q3）。

### 4.2 来源选择

| 候选来源 | 采用 | 理由 |
|---|---|---|
| `event.key_points` | **是** | 已是短要点数组、已固化、自然语言、语义贴近"这条记忆讲什么" |
| `event.summary` | 否 | 长句（真机 96／71 字），进 FTS 会触发 BM25 长度惩罚、稀释 trigram 精度；且接近正文摘要，越零正文边界 |
| `experience.observation.cue` | 保留原通道 | 反思/做梦产的内联短线索，现真机为空；A 不改变其优先级 |
| raw 正文 | 否 | 违反零正文 |

### 4.3 生成算法（纯函数 `deriveCuesFromKeyPoints`，建议置于 `src/memory/`）

1. **门控**：生产行为**只由 `CURRENT_RULES_VERSION` 决定**（`types.ts:19` 编译期常量）。同一 rules 版本下不存在"开/关两种 cue"；config flag 仅允许存在于测试与临时根，不得进入 on 态生产路径（否则"同真源同规则必同投影"与零漂移红测同时失守）。**本条为本轮按外审更正的版本**（原稿"开关默认 off"的设计已撤回）。
2. **候选集**：仅取 `event.key_points`（数组，可能为空）；
3. **逐条清洗**：丢弃非字符串/空白；每条过 `gate.ts:48 normalizeLexicalText`（NFKC 全角转半角、ASCII 小写、空白折叠、去首尾）；
4. **去重保序**：按清洗结果去重，保留首次出现顺序（无随机、无打分、无模型排序）；
5. **长度处理**：`[...cue].length > 40` → **整条丢弃**（不截断、不补省略号），超限条数进遥测。**本条为本轮按外审 3:1 裁定的版本**（原稿"按码点截断"已改：截断产物是真源不存在的词形，且碎片可能恰好落入 summary 触发 H7）；
6. **H7 子串反查（本轮补入，原稿遗漏）**：对每条候选检查 `[...cue].length >= 20 && summary !== null && summary.includes(cue)`（原始字面连续包含），**原始形态与 NFKC 形态双查**；命中即丢弃该条。H7 原口径为离线 worksheet"整份拒绝"，A 适配为"该条丢弃 + 遥测"——自动投影若整卡拒建会造成卡缺失，比少一条线索更糟；
7. **取前 3**：受 `schema.ts:51` 硬约束（1–3 条）；在**过滤之后**保序取前 3（先过滤后取 3，避免 H7 或超长拒掉一条后卡面缺位、第 4 条本可合法上位）；
8. **空集兜底**：无可用条目时回退 `[""]` 占位（维持 CHECK 与现行为，与 `llm.ts:359` 容错口径一致）；
9. **落库与幂等**：写 `display_cues_json`，FTS 由既有 `cueTextOf` 自动同步；**不写 `mem_alias`**（别名面专属 B）；同输入同输出，幂等可重算。

### 4.4 待定参数（若无异议按建议值）

| 参数 | 建议 | 说明 |
|---|---|---|
| 单条 cue 字符上限 | 40（码点），**超限整条丢弃** | 真机 7 条最长 22；上限只挡异常长句；超限进遥测（上游 prompt 漂移信号） |
| H7 子串反查 | 必须，原始/NFKC 双形态 | 冻结令 `:587`＋提案 `:126`；≥20 码点且被 summary 字面连续包含 → 丢该条 |
| 超 3 条取舍 | 保序取前 3 | 确定性；落选条目仍在事件真源，未丢失 |
| 来源优先级 | `observation.cue` 优先，缺失时用 `key_points` | 保留反思通道未来接入空间 |

### 4.5 实施阶段（门全程默认关，前两阶段零生产影响）

- **阶段 0**：取号立 charter（schema、门禁、遥测、回滚四要素）+ 本材料外审定稿；
- **阶段 1**：纯函数实现 + TDD；接入 drain/derive 后由 `rules_version` 控制——当前 `rules-v1` 不含 cue 派生，接入后行为与现状逐字节一致，**零漂移红测锁死**；仅在临时根验证；
- **阶段 2**：离线取证——扩充金标/诱饵夹具、跑五维指标、上"反事实回放器"（见 §7）；
- **阶段 3**：外审达标后一次性解冻：发布含 cue 派生的 `rules-v2`（**不翻配置开关**）＋ `stampMeta` 落 `rules_version` 章 ＋ 离线 `--apply` 重建回填存量。**注（本轮按代码更正）**：按现状仅升版本**不会**回填——`planner.sameShape` 不比 cue（`planner.ts:95-103`）、`builder` 对存量卡原样搬运 `old.displayCuesJson`（`builder.ts:405-430`）、`stampMeta` 只写三键且 `rules_version` 全仓无写入点（`store.ts:289-299`，`rebuild-required` 因此永不触发）。必须先补"期望态／比对面／物化／落章"四处，见 §4.6 第 2 条。

### 4.6 与既有设计的冲突点（须评审裁定）

1. **`derive.ts:107` 明确"期望态不含 cues"**。A 若要让运行期 drain 建卡即带 cue，必须把 cue 纳入期望态与结构哈希，等于改写该条语义——这是本路线最大的实质改动面。
2. **内容哈希输入面 vs 增量比对面（原稿此处论断错误，本轮按代码更正）**：`content_hash` 确实覆盖 cues（`builder.ts:175`），但**不承担失效判定**（`types.ts` 注释）；运行期增量只比 `sameShape`（channel／startedMs／endedMs／anchors，`planner.ts:95-103`），`invalidate+create` 仅由 `cardId`（锚点）变化触发（`:140-152`）。因此 **cue 由空变非空不产生任何动作，存量两卡不会回填**；全量重建也不会——`builder` 对存量卡用 `old.displayCuesJson` 重算哈希（`builder.ts:405-430`），cue 原样搬运。回填必须改三处：期望态（`derive.ts:107` 扩 cues）＋比对面（`PlanCardRef`／`sameShape` 加 `cuesHash`）＋物化（重派生 cue，并让 `update-card` 落 `action='update-cues'` 决策行——该词已在 `types.ts:188`／`ledger.ts:27` 词表但从未被产出）。
3. **`structural_hash` 口径**（#42 §3.5 扩面含 channel／时间窗）与 cue 派生版本的关系需一并钉死，避免"同事件不同 cue 但哈希相同"。

### 4.7 已知天花板（须如实计入考核）

- **trigram ≥3 码点**：`MIN_TRIGRAM_LENGTH=3` 意味着「荷花」「池塘」「翻倍」这类 **2 字词走不了 FTS**；LIKE 被门构造性拒（`gate.ts:118-119`），别名又只走整句等值（§2.3），故 **2 字词只有"整条查询就是该词"时才可能命中**，嵌在长句中 A/B 均不可召回——登记为**系统级天花板**（本两路线内不解决，属"查询切词"新卡）；
- **同义换述**：trigram 是字符级子串，"荷塘" vs "荷花"不命中；
- **一句全收 vs 切片**：key_points 是整句要点（如"荷花每天面积翻倍，第 30 天长满池塘"），长句在 BM25 下有长度惩罚，可能弱于短词；
- **一次产出即全量生效**：LLM 那次 `key_points` 若有偏差，A 会把偏差一次性铺到检索面（不同于 B 的逐条判断）。

---

## 5. 路线 B：#120 漏召别名建议器

### 5.1 设计原文（设计文档 6.5「通道二·落空自主回查」，逐条）

1. 门返回 `abstain` 或 `no-match` 时，编排层必须把回查机会交给她，不得静默换成宽松结果硬凑；
2. 她的主动工具是只读的 `getCardsByAnchor`（按锚点翻卡）与 `resolvePointer`（序号反查后经宿主门面下钻真源原文）；
3. 她确认目标卡后，经唯一窄写 `addMissAlias` 补一条 `source='miss'` 别名（只进检索别名、不改展示线索），下次同一问题即可被通道一召回；同时 `recordMiss` 登记落空事实；
4. 她也查不到才算真没有：本轮不认定、不编造，按落空纪律留观测。

### 5.2 现有实现状态

- 六工具已注册（`memory-tool-bridge.ts:33-38`）：`fasti_memory_search`／`cards_by_anchor`／`resolve_pointer`／`add_alias`／`experience_summary`／`raw_text`；通道二回查两件套已可用；
- `addMissAlias` 仅 on 态可写（`memory-tools.ts:267`），off/shadow 返回 `deferred`；
- 卡内 miss 别名上限 5/卡（`alias-write.ts:27,170`），超限 `alias-cap-exceeded`；
- 定性（既有，本轮修正表述）：miss 别名是**检索索引层线索**，非记忆内容或价值判断；零正文。但它是 §3.7 明定的**残差**——重建归零（R-15），**不是"可整库重建"**；可重建的是投影整体，别名本身不会因重建而保留。影响面因此仅限于该卡的召回能力，可清零、可撤销，不进入价值判断层。原稿"可整库重建、故不适用多次印证"的论证链与 §2.1/§7.5 自相矛盾，已改。

### 5.3 D-1 数据面缺口（本路线立项的前置）

`mem_miss` 只记落空，不记命中；且**无 `card_id`**（`anchor_event_id`/`anchor_json` 为建表预留、v1 恒 `null`）。于是"这次落空该补到哪张卡"没有持久关联，只能靠她当轮自主回查。三个候选口径：

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **a** 内存态即时关联 | 不落库，她当轮回查得到 cardId 后直接调 `add_alias`；决策行带 `event_id` | 零 schema 变更、最小改动 | 盲区仅"回查了但没挂"；**已执行样本可离线重建**——`mem_miss.term_norm` 明文（`miss.ts:33-34`）＋ add-alias 决策行的 `event_id`／`card_id`／`dedupKey`（含 termNorm）＋时间窗即可 join。原稿"无法离线分析"低估了既有持久化，已改 |
| **b** 回填预留字段 | 她回查确认后，把 `anchor_event_id`/`anchor_json` 写入**当轮** miss 行 | 有持久关联，可离线统计 | `mem_miss` 是 append-only：回填=改行，需改为"确认后追加一条带锚的 miss 行"或另立关联表 |
| **c** 独立建议日志 | 新增 append-only `alias-suggestions.jsonl`（词、目标卡、依据、结果） | 不动 miss 表、可审计、可回放 | 新增一个投影面日志文件，须明确可重建性与隐私口径 |

### 5.4 污染与自增强风险

- 她本身是 LLM：若误认卡并挂别名，错误会固化进检索面，下次"命中"反而强化错误（自增强）。
- 现有定性认为 miss 别名不属记忆内容，故不适用 B 块"多次印证"。是否足够，请裁定（Q8）。
- provenance 现状（**本轮二次更正：我上一轮的"更正"本身是错的**）：`types.ts:206` 明确有 `created_by: 'her' | 'system'`（必填）；`decision.ts:129-152` 的 `castDecision` 把它**硬编码为 `'her'`**，连 drain 的 create-card／invalidate 这类纯机械决策也被标成"她的决策"。所以真实缺口不是"字段缺失"，而是"**常量填充让台账里的 created_by 全局无信息量、系统决策被错标**"；对 add-alias 而言 `'her'` 恰好准确（生产唯一写路径就是她的工具调用）。修法便宜：`DecisionCasterInput` 加可选 `initiator`（缺省 `'system'`），drain 传 `'system'`、add-alias 传 `'her'`，非 schema 变更（并入 Q8 裁定）。
  原稿这一条的错误成因如实说明：上一轮取证据时用了 `grep ... | head -20`，命中被截在 `contract/event.ts`，`types.ts`／`decision.ts` 的命中被切掉，据此下了"不含该字段"的结论——属工具使用不当导致的实证事故，本轮已以符号名重核。

### 5.5 与 A 的分工

| 查询形态 | A（cue 子串，≥3 码点） | B（别名，整句等值） |
|---|---|---|
| 整句是某条 cue 的连续子串（"长满池塘""第 29 天"） | 可命中 | 仅当别名恰等于整句时命中 |
| 2 字词嵌在长句（"荷花那题答案是多少"） | **不可命中** | **不可命中**（等值不成立）→ 系统级天花板 |
| 整条查询就是 2 字词（"荷花""翻倍"） | **不可命中**（<3 码点） | 可命中（若她挂过该词） |
| 同义换述（"荷塘…"） | **不可命中**（子串不成立） | 仅当别名恰等于整句时命中 |
| 完全无关词 | 否 | 否（abstain／no-match） |

结论（**本轮按代码重写**）：A 补"面上的连续子串覆盖"，B 补"整句逐字复现的点"。B 的覆盖面比原稿宣称的小一个量级——它只能救"用户下次原样重复同一问句"，**救不了"短词嵌长句"与"换述"**。两者仍不可互相替代，但不能把 B 当作短词与换述的解法。

---

## 6. 两条路线的相互作用（合并评审的核心理由）

### 6.1 共享同一作用面

A 写 `display_cues`、B 写 `mem_alias`，但二者**并不在 `cue_text` 里合流**：`cueTextOf` 只收 `display_cues` 与 `sensitive===0` 的别名（`fts.ts:35-41`），而运行期别名恒 `sensitive=1`（`runtime.ts:106-113`），故 B 的别名**不进 FTS、不参与 BM25 排序、不影响 A 的命中分布**；B 只在"整句等值"这一条独立通道上生效。二者真正的交集是**同一批查询的落空样本**（§6.2），不是同一份排序面。原稿"共用同一 BM25 排序"失实，已改。

### 6.2 干扰一：A 会吃掉 B 的样本

B 的数据面是"通道一落空"。A 一旦生效，原本落空的查询会有一部分变成命中 → `mem_miss` 变少 → B 的触发与累积被压缩。若同时上，**B 的基线会被 A 污染**，后续无法判断 B 的增益。

### 6.3 干扰二：重复与噪声（**该项不成立，本轮删除**）

原稿称"同一词既在 A 的 cue 又在 B 的别名、会在 `cue_text` 重复出现、影响 BM25 词频"——按代码不成立：别名恒 `sensitive=1`，不进 `cue_text`（§6.1），A／B 在物理上不可能重复占同一份检索语料。合并评审的理由因此只剩 **§6.1（共享落空样本面）** 与 **§6.2（A 吃掉 B 的样本）**，这两条已足以支持合并评审，不再依赖一个不存在的词频干扰。

### 6.4 建议的放量顺序（待裁定，见 Q9）

1. 两路线可**同步设计、同步实现**（本材料即为此）；
2. 放量建议 **A 先行**：A 是确定性、可回滚、覆盖存量；先让 A 的解冻观察期跑出四态与命中分布，B 再以"A 生效后的落空集"作为干净基线；
3. 若评审认为 B 更安全应先上，则须规定 A 解冻后对 B 的基线做重标（预注册重标规则）。

---

## 7. 评测与解冻方案

### 7.1 离线 harness（已有，见 §2.4）

金标 R1、诱饵 R2、四态、bootstrap CI 算法均具备；缺口在夹具规模与"考卷独立性"。

### 7.2 夹具缺口与自证风险（关键方法论问题，Q6）

- 现状：每个夹具 1–2 条合成数据，**无统计效力**；
- **自证陷阱**：若金标 `queries` 直接取自 `key_points`（与 cue 同源），则 A 必然"全命中"，R1 虚高而无意义；
- 需要独立构造线：真实用户复述、同义改写、错别字/简称、跨语言或口语化，分层统计；
- 需要负样本：内容相近但不应命中的诱饵卡（`decoy.json` 已有骨架）。

### 7.3 反事实回放器（#42 §2.6 已预注册）

本系统 FTS/BM25 是**纯确定性引擎**（无随机、无浮点漂移），因此可在只读副本上精确仿真："若给某卡注入这些 cue／别名，历史与夹具中的落空会如何变化、是否误伤其他卡"。只仿真、不写检索、不建空表；不需要在线 A/B。这是 A、B 共同的主要取证工具。

### 7.4 指标与样本量

- #42 §2.6 已裁定补全为五维：线上漏报与 miss 表联测、跨卡干扰排名、模型/prompt 变更快照 diff、预注册最小样本量与 CI 宽度、cue 膨胀噪声率；**R1≥0.85／R2≤0.05 不再是唯二门槛**；
- 置信区间用 `metrics.ts` bootstrap（1000 次重采样、固定种子可复现）；样本不足时区间自动变宽，作为"不得下结论"的客观依据。

### 7.5 解冻与回滚

- **A**：发布 `rules-v2` + `stampMeta` 落 `rules_version` 章 + 离线 `--apply` 一次性重建；回滚 = 退 `rules_version` 并重建，真源零改动，红测断言回滚后 `row_hash_sum` 与解冻前逐字节相等。属可导投影，回滚彻底。
- **B**：miss 别名是**不可再生残差**（重建归零，#42 R-15 已钉死断言）；需运维契约：重建前离线导出、重建后重积累；上限 5/卡是否足够需裁定（Q10）。

---

## 8. 待裁定问题（请逐条给结论）

**Q1（全案先决）** A 用已固化的 `event.key_points` 做 cue，是否触碰 587/K5「不得让模型静默生成检索词」？
- 我方倾向：A 不新增模型调用、只做确定性投影，且 `key_points` 已作为二级真源固化、可审计可重建，**倾向判定为不越线**；
- 但"检索面出现模型产出的自然语言词面"确有可能被认定为越线。若判越线，请给出替代：仅允许零模型词法抽取（如从 key_points 抽固定长度子串/分词），或改走受约束模型候选＋离线门禁。

**Q2** 若 A 合法，解冻判据采用哪套：R1/R2 唯二，还是 #42 §2.6 的五维？（我方倾向五维＋预注册样本量。）

**Q3** `key_points` 超 3 条时"保序取前 3"是否可接受？是否有更优的**确定性**取舍规则（不得引入模型排序）？落选条目不上卡面，是否影响可溯与"她记得什么"的完整性？

**Q4** 单条 cue 长度上限 40 码点是否合适？长句 cue 在 BM25 有长度惩罚，是否应改为"只收长度 ≤N 的条目、过长者丢弃"而不是截断？

**Q5** trigram≥3 的结构性天花板：2 字词（"荷花""翻倍"）不可召。A 是否需要配套"短词派生"？若需要，那已是模型生成、越过 A 边界——请裁定该类需求是否应全部归给 B（#120）。

**Q6** 金标如何避免自证？请裁定构造线与分层方案，以及"阶段 2 达到可下结论"所需的最小样本量与 CI 宽度。

**Q7** B 的 D-1 口径三选一（§5.3 的 a／b／c），哪个最小可行且不破 append-only、零正文与可重建边界？

**Q8** B 的自增强污染：仅靠"上限 5/卡 + 她当轮判断"是否足够？是否需要"同词两次落空命中同一卡才可挂"之类约束？请裁定并说明对"零人工"的影响。

**Q9** A、B 并存时的放量顺序与基线隔离：是否采纳"A 先行、B 以 A 生效后的落空集为干净基线"？若否，请给出重标规则。

**Q10** 回滚与残差契约：A 可 rebuild 彻底回退，B 重建归零。是否接受"B 需离线导出备份 + 重建后重积累"的运维契约？5/卡上限是否够？

---

## 9. 明确不做（请评审据此判断范围是否被偷扩）

- 不读写 raw 正文、不把 summary 长句进检索面；
- 不在 drain 内调 LLM，不为抽词新增模型调用；
- 不新增真源字段、不新增生产依赖、不新增表/守护进程/定时器/文件监听；
- 不做 top-N 高频统计、不做 rollup、不做后台自动做梦或反思；
- 不设任何运行期人工审核/确认按钮；
- 推送边界：本次送审基线的 4 个提交（`be350dd`／`d70575d`／`4b470af`／`d34a3bf`）经主控授权已推送至 `main`；后续任何推送仍须主控单独授权；
- 两路线在解冻前**不进入生产写路径**：A 由 `rules_version` 控制（当前 `rules-v1` 无 cue 派生，行为等同关闭）；B 需待建**专属写入开关**（默认关）——现状 `memoryGateMode='on'` 即可写 `addMissAlias`，观察期"她不挂别名"只靠 prompt，不可审计（本轮按外审补记）。

---

## 10. 回复格式要求

对 Q1–Q10 逐条：

```
Qn：同意 / 反对 / 存疑
理由：（回代码或回数据，不接受纯方向性表述）
若反对：可替代的具体设计（含落点、字段、校验与回滚）
```

另请单独回答一句：**这两条路线是否应合并为一张卡立项，还是分别取号？**

---

## 11. 代码获取与定位

### 11.1 仓库

```
仓库：https://github.com/lzhdy/dsh-fasti
默认分支：main
远端 HEAD = 送审基线 = d34a3bf（2026-11-16 已推送）
```

已实测该仓库可匿名拉取（`git-upload-pack` 返回 200），无需授权即可：

```bash
git clone https://github.com/lzhdy/dsh-fasti.git
cd dsh-fasti && git log --oneline -1        # 应为 d34a3bf
```

### 11.2 送审基线包含的 4 个提交（外审可能关心"这版比上一版多了什么"）

| commit | 内容 | 是否改行为 |
|---|---|---|
| `be350dd` | #121 取号与卡号台账（文档＋注释） | 否（33 增/11 删全为文档与注释） |
| `d70575d` | #122 透传 `dataRoot`，修复真机 drain 永久空轮 | **是**（+24 行功能代码，其余为测试） |
| `4b470af` | 宿主胶水白名单补传 `memoryGateMode` | **是**（+10/-2 行） |
| `d34a3bf` | #122 台账回写（文档） | 否（4 行文档） |

两处功能性修复的共性：此前 clone 或换机部署后，`dataRoot` 缺一截、`memoryGateMode` 被胶水吞掉，结果是 worker 每轮"正常空轮、零写入、零报错"、记忆工具不注册——**看起来在跑，实际什么都没发生**。两处均以可选参数方式补齐（`...(x === undefined ? {} : { x })`），缺省不传时行为与修复前完全一致，不影响既有调用方与离线回放路径。

这解释了材料 §1.1 的"写入链路已修复"与本 §11 的行号可信度：远端 `d34a3bf` 就是真机验证通过的那一版。

### 11.3 文件定位速查（按评审问题分组）

| 要看什么 | 路径 |
|---|---|
| cue 唯一来源、真源折叠 | `src/memory/drain.ts` `readSource` |
| 建卡物化（cue 落 1–3 条） | `src/memory/builder.ts` `materializeDrainCardRow` |
| FTS 文本构成（零正文） | `src/memory/fts.ts` `cueTextOf` |
| 三通道召回与 trigram 阈值 | `src/memory/bm25.ts` 检索主函数；`src/projection/sqlite.ts` `MIN_TRIGRAM_LENGTH` |
| 表约束（1–3 条、别名 schema） | `src/memory/schema.ts` `SQL_MEM_CARD`／`SQL_MEM_CARD_FTS`／`SQL_MEM_ALIAS` |
| 词面规范化与 ASCII 边界 | `src/memory/gate.ts` `normalizeLexicalText`／`hasAsciiWordBoundary` |
| 三态门与窄写 | `src/assembly/memory-tools.ts` search／`addMissAlias` |
| miss 落库白名单与列 | `src/memory/miss.ts` `MISS_INPUT_KEYS`／`INSERT_MISS_SQL` |
| 别名上限与元素形状 | `src/memory/alias-write.ts` `MAX_MISS_ALIASES_PER_CARD`／`buildMissAlias` |
| 别名决策行 | `src/memory/store.ts` `addMissAlias` |
| key_points 生产与解析 | `src/event/closure.ts` `writeSummary` 调用点；`src/adapters/dsh/llm.ts` `keyPoints` |
| 事件契约字段 | `src/contract/event.ts` `key_points`／`created_by` |

### 11.4 对齐确认

远端已与送审基线为同一 commit（`d34a3bf`），无需再做版本对齐。附录 C 仍保留，供无法联网访问仓库的评审者离线核对——其内容与远端当前代码逐字一致。

---

## 附录 A：真机 `key_points` 原文（两事件共 7 条，评审剂量参考）

事件一（4 条）：
1. 用户询问上次对话内容
2. 助手称无法读取此前会话记录，只能看到当前对话
3. 助手请用户提醒上次主题
4. 用户随后要求一句话说明助手身份，未展开

事件二（3 条）：
1. 3 加 5 等于 8
2. 荷花每天面积翻倍，第 30 天长满池塘
3. 第 29 天荷花长到池塘一半

## 附录 B：真机只读实测命令口径（便于复现）

- 卡/别名/miss：`sqlite3 'file:<dataRoot>/projection/memory-index/memory-index.sqlite?mode=ro'` 查 `mem_card`／`mem_alias`／`mem_miss`／`mem_card_fts`；
- 事件折叠：按 `id` 取最大 `version`；
- 检索复核：`searchCards(db, {text, atMs, limit})` 只读打开，不写库。

## 附录 C：关键代码原文摘录（取自 `d34a3bf`，供无法访问仓库时独立评审）

标注格式为「文件 : 行号范围」。为控制篇幅，已略去与本问题无关的注释与相邻分支，**逻辑未改写**。

### C-1 `src/memory/drain.ts:247-270` —— cue 的唯一来源是真源经历上的 `observation.cue`

```ts
function readSource(dataRoot: string | null): SourceRead {
  const cueByExperience = new Map<string, string | undefined>();
  const folded = new Map<string, EventRecord>();
  if (dataRoot === null) {
    return { events: [], cueByExperience };
  }
  const layout = layoutOf(resolveDataRoot({ dataRoot }));
  for (const name of listFiles(layout.experiences, '.jsonl')) {
    for (const raw of readJsonlFile<unknown>(path.join(layout.experiences, name))) {
      const experience = parseExperience(raw, 'read');
      cueByExperience.set(experience.id, experience.observation?.cue);
    }
  }
  for (const name of listFiles(layout.events, '.jsonl')) {
    for (const raw of readJsonlFile<unknown>(path.join(layout.events, name))) {
      const event = parseEvent(raw, 'read');
      const previous = folded.get(event.id);
      if (previous === undefined || event.version > previous.version) {
        folded.set(event.id, event);
      }
    }
  }
  return { events: [...folded.values()], cueByExperience };
}
```

要点：`key_points` 在这条链上**完全没有出现**——这就是"卡上有内容、检索面却空"的直接代码原因。

### C-2 `src/memory/builder.ts:169-175` —— 建卡物化：取前 3、空则占位、别名恒空

```ts
export function materializeDrainCardRow(input: DrainCardRowInput): MemoryCard {
  const anchorJson = JSON.stringify([...input.anchors]);
  const cues = [...input.cues].slice(0, 3);
  const displayCuesJson = JSON.stringify(cues.length > 0 ? cues : ['']);
  const aliasesJson = '[]';
  const discriminator = '';
  const summaryHash = computeContentHash(anchorJson, displayCuesJson, aliasesJson, discriminator);
```

要点：`content_hash` 的四输入即 anchors／cues／aliases／discriminator；cue 由空变非空必然改哈希（对应 §4.6 冲突点 2）。

### C-3 `src/memory/fts.ts:31-41` —— FTS 文本只由 cue＋活跃非敏感别名构成

```ts
/**
 * FTS 索引文本 —— 仅由 display_cues + 活跃非敏感别名拼成，绝无正文/摘要（§3.2）。
 * sensitive=1 的别名不进 FTS（仅精确匹配路径可用，§4.4）。
 */
export function cueTextOf(displayCuesJson: string, aliases: readonly AliasRow[]): string {
  const cues = JSON.parse(displayCuesJson) as string[];
  const terms = aliases
    .filter((alias) => alias.status === 'active' && alias.sensitive === 0)
    .map((alias) => alias.termNorm);
  return [...cues, ...terms].join(' ');
}
```

要点：A 与 B 的写入在 `cue_text` 里**合并成同一串**，这是 §6 干扰分析的代码依据。

### C-4 `src/memory/bm25.ts:105-144` —— 三通道与 trigram 门槛

```ts
  // 精确路径：任意长度可达；sensitive=1 别名只走这条路。
  const exactRows = db
    .prepare("SELECT term_norm, card_id FROM mem_alias WHERE term_norm = ? AND status = 'active'")
    .all(q) as Array<{ term_norm: string; card_id: string }>;
  for (const row of exactRows) {
    addHit(row.card_id, row.term_norm, null, 'exact-alias');
  }

  let ftsOk = false;
  if ([...q].length >= MIN_TRIGRAM_LENGTH) {
    const phrase = `"${q.replace(/"/g, '""')}"`;
    try {
      const rows = db
        .prepare('SELECT card_id, bm25(mem_card_fts) AS bm25_raw FROM mem_card_fts WHERE mem_card_fts MATCH ?')
        .all(phrase) as Array<{ card_id: string; bm25_raw: number }>;
      const cueStmt = db.prepare('SELECT cue_text FROM mem_card_fts WHERE card_id = ?');
      for (const row of rows) {
        const cue = cueStmt.get(row.card_id) as { cue_text: string } | undefined;
        if (cue !== undefined && matchesSubstring(cue.cue_text, q)) {
          addHit(row.card_id, q, row.bm25_raw, 'fts-substring', cue.cue_text);
        }
      }
      ftsOk = true;
    } catch {
      // FTS5 语法解析失败 → LIKE 回退
    }
  }
  if (!ftsOk) {
    const escaped = q.replace(/[\\%_]/g, (char) => `\\${char}`);
    const likeRows = db
      .prepare(
        "SELECT term_norm, card_id FROM mem_alias WHERE term_norm LIKE ? ESCAPE '\\' AND status = 'active' AND sensitive = 0",
      )
      .all(`%${escaped}%`)
```

要点：`[...q].length < 3` 时**直接跳过 FTS**，2 字词只能靠别名；这就是 §4.7 天花板的代码依据。

### C-5 `src/memory/schema.ts:46-64` —— 硬约束

```sql
  CHECK (card_type IN ('event')),
  CHECK (selection IN ('selected','excluded')),
  CHECK (status IN ('active','invalid','superseded')),
  CHECK (entity_hint_json IS NULL),
  CHECK (weight BETWEEN 0 AND 1),
  CHECK (json_array_length(display_cues_json) BETWEEN 1 AND 3),
  CHECK (length(discriminator) <= 40));
...
CREATE VIRTUAL TABLE IF NOT EXISTS mem_card_fts USING fts5(
  card_id UNINDEXED,
  cue_text,
  tokenize='trigram');
```

要点：`BETWEEN 1 AND 3` 决定了 A 的"取前 3 / 空则占位"是**被迫**而非偏好。

### C-6 `src/memory/gate.ts:48-50` —— 词面规范化

```ts
export function normalizeLexicalText(text: string): string {
  return asciiLower(text.normalize('NFKC')).replace(/\s+/g, ' ').trim();
}
```

要点：只做 NFKC＋ASCII 小写＋空白折叠，**不做同义词、不做分词、不做停用词**——A 若想"提纯 cue"将越过本函数边界。

### C-7 `src/assembly/memory-tools.ts:236-280` —— 三态门与窄写入口（节选）

```ts
      if (deps.mode === 'off') {
        throw new UnavailableError('记忆门处于 off 态：门控检索工具不接线，无召回结果可用');
      }
      if (deps.mode === 'shadow') {
        await observeShadowOnce(deps, input.text, atMs, input.limit);
        return observingView();
      }
      const handle = requireHandle();
      const outcome = await runGatedSearch(handle, { text: input.text, atMs }, input.limit);
      if (outcome.status === 'abstain' || outcome.status === 'no-match') {
        recordMissOrSwallow(handle, deps.missChannel, input.text, atMs, outcome.status);
      }
      return toGateView(outcome);
...
    addMissAlias(input: { term: string; cardId: string }): AddMissAliasView {
      if (deps.mode !== 'on') {
        return { deferred: true, mode: deps.mode, reason: 'gate-not-on' };
      }
      const outcome = requireHandle().addMissAlias({ term: input.term, cardId: input.cardId, atMs: deps.now() });
```

要点：落空才登记 `miss`，**命中不登记**（Q7 的直接代码依据）；`addMissAlias` 只在 on 态可写。

### C-8 `src/memory/miss.ts:19-34` —— 落库白名单与列

```ts
const MISS_INPUT_KEYS: readonly string[] = [
  'termNorm', 'channel', 'anchorEventId', 'anchorIds',
  'returnedCount', 'observedMs', 'gateStatus',
];
const MISS_GATE_STATUSES: readonly string[] = ['no-match', 'abstain'];
const INSERT_MISS_SQL =
  'INSERT INTO mem_miss(id, term_norm, term_hash, channel, anchor_event_id, anchor_json, returned_count, observed_ms, gate_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
```

要点：`anchor_event_id`／`anchor_json` 是**已存在但恒空**的列，这是 D-1 口径 b 的结构前提；白名单外的键（如原文）当场拒绝。

### C-9 `src/memory/alias-write.ts:27,167-183` —— 上限与元素形状

```ts
export const MAX_MISS_ALIASES_PER_CARD = 5;
...
  if (activeAliases.some((alias) => alias.termNorm === input.termNorm)) {
    return { ok: true, changed: false, reason: 'already-active' };
  }
  if (activeAliases.length >= MAX_MISS_ALIASES_PER_CARD) {
    return { ok: false, reason: 'alias-cap-exceeded' };
  }
  const alias: AliasRow = {
    termNorm: input.termNorm,
    cardId: input.cardId,
    source: 'miss',
    sensitive: input.sensitive,
    status: 'active',
    createdMs: input.createdMs,
    hitCount: 0,
    lastHitMs: null,
  };
```

要点：同一词重复挂是幂等跳过；`source` 硬编码 `'miss'`，无第二个来源值可混。

### C-10 `src/memory/store.ts:510-546` —— 别名决策行（节选）

```ts
  addMissAlias(request: AddMissAliasRequest): ApplyMissAliasOutcome {
    const termNorm = normalizeQuery(request.term);
    const outcome = applyMissAlias(this.require(), {
      termNorm, cardId: request.cardId, sensitive: request.sensitive, createdMs: request.atMs,
    });
    if (outcome.ok && outcome.changed) {
      const card = this.getCard(request.cardId);
      ...
      const decision: DecisionRecord = castDecision({
        eventId: card.eventId,
        ...
        action: 'add-alias',
        cardId: card.cardId,
        anchors,
        contentHash: outcome.contentHash,
        structuralHash: '',
        modelTag: CURRENT_RULES_VERSION,
        reason: 'add-alias:miss-recheck',
        dedupKey: `add-alias|${card.eventId}|${card.cardId}|${outcome.termNorm}`,
      });
```

要点：决策行的 `created_by` 由 `castDecision` 恒填 `'her'`（`types.ts:206` 定义字段、`decision.ts:150` 硬编码），写入方身份实际只能从 `reason`／`modelTag` 推断——**字段存在但无信息量**（对应 §5.4 本轮二次更正与 Q8 的 provenance 处置）。

### C-11 `src/event/closure.ts:415-423` —— `key_points` 由闭合慢路径写入事件版本

```ts
      this.writeSummary(
        latest,
        resolved.anchors,
        resolved.candidates,
        trimmedSummary,
        response.keyPoints,
        regenerate,
        response.model,
      );
```

### C-12 `src/adapters/dsh/llm.ts:248-253` —— `key_points` 解析（缺失不失败）

```ts
  return {
    summary,
    keyPoints: keyPoints_stringArray(obj['key_points']),
    anchor_serials: parseAnchorSerialsField(obj['anchor_serials']),
    ...(candidates.length === 0 ? {} : { boundary_candidates: candidates }),
  };
```

要点：非数组按空数组处理、缺字段不报错——所以 A 的"空集回退 `[""]`"必须保留，否则上游容错会直接打穿到 CHECK 约束。
