# #124 记忆索引 bigram 化 · 立项 Charter v2（外审闭合修订稿）

> 状态：**主控已于 2026-11-17 签认冻结**；本文件随 11.4.0 台账追认同批入库；未写任何生产代码（编码开工另过授权四查）
> 冻结基线：HEAD `4844049`，全量测试 1231/1231 全绿
> 版本：v2。相对 v1 草稿的全部变更来自四份外审材料与《task124-外审处置裁定稿-2026-11-17》——阻塞项 B1–B9、建议项 S1–S13 已逐条织入正文，闭合映射见第 8 节
> 主控已裁定前提（2026-11-17）：窄卡范围／库级 schema 升 v3／聚焦外审／合成测试台施工零真机写入

---

## 0. 背景（自包含，外审者无需读其他文档）

**系统**：FasTI 是长期运行 AI 主体（"她"）的持久记忆层。对话经闭合流水线产出 1–3 条检索线索（cue），纯规则投影成记忆卡写入 SQLite；卡上可检索文本只由 cue 与非敏感别名拼成，正文不进索引。检索走 SQLite FTS5：BM25＋近因粗召回，末端确定性布尔门裁决，宁空勿错。

**问题**：现役 FTS5 固定 `tokenize='trigram'`（三字符切分）＋准入阈值 3 码点，任何 2 字中文词在索引中结构性不存在（城市、人名、品类全灭）。探针实测 oracle 短词召回 9/25。这是索引单位选错，不是参数问题。

**证据三方同向**：①NTCIR-4 CJK 定论 bigram 为亚洲文本标准索引单位、与最优分词统计无差异、零分词依赖；②本仓离线探针（生产码零改动）证实同一批真模型 cue 上 bigram 22/25、加 unigram 实验臂 23/25；③双路线裁定稿 Q5 已预留"查询切词新卡"，本卡即其填充。

### 0.1 预期管理红线（S1，签认前必读）

**本卡合并后，真人整句问法召回预期仍为 0/16（探针 B1 臂实测）。** 本卡唯一用户可感收益是"2 字短词可查"；整句问法的修复属后续拆句工卡。任何验收、汇报、签认不得把本卡表述为端到端召回修复。

### 0.2 硬约束（违反即方案不可行）

- 零外部依赖、零模型、零分类器（K10）；**"不引入外部 tokenizer、只用 SQLite 内置 unicode61＋应用层切分"入静态拓扑门机检断言**（R4/S13）；
- 纯确定性、可重放、同输入同输出；不新增真源字段、不新增表、不动 append-only 账本（K4/K5）；
- 布尔门 6.6、BM25 排序公式、三态语义、`CURRENT_RULES_VERSION` 一律不动；
- **经历库投影 `experience_fts` 及其 trigram 几何本卡一律不动**（B9，详见 1.4）；
- 归一化三侧同源（见 3.4）；重建只走影子库整库协议、禁止原地重灌（见 3.5）；
- 全程临时根/隔离 DSH_HOME 施工，真实数据根零写入（9.2）；TDD 先红后绿＋变异反证，`npm test` 为唯一门禁口径，旧断言不许删改放水（9.1）。

### 0.3 大白话版

档案柜原按"三字一组"建索引，两字词（发票、奶茶、成都）卡片上没有。本卡重抄成"两字一组、长词滑窗多片、英文整词、孤立单字打补丁"，探针实测短词 9 分→22 分（满分 25，实验环境最高 23）。本卡只重抄记忆卡索引，不雇拆句工、不动判断门、不动账本、不动旁边那个经历柜。

---

## 1. 现状实证（符号锚定，行号以基线为准会漂移）

| 编号 | 事实 | 位置 |
|---|---|---|
| E-1 | 记忆卡 FTS 固定 `tokenize='trigram'` | schema.ts SQL_MEM_CARD_FTS |
| E-2 | 阈值常量 `MIN_TRIGRAM_LENGTH = 3`，**有两个消费点** | projection/sqlite.ts:39 定义；bm25.ts:114 与 sqlite.ts:473 消费 |
| E-3 | 查询码点 ≥3 走 FTS MATCH phrase；不足走 LIKE 回退 | bm25.ts searchCardsExplained |
| E-4 | FTS 命中后现对 FTS 文本列做 matchesSubstring 复核 | bm25.ts 同函数 |
| E-5 | 索引文本＝display_cues＋**sensitive=0** 活跃别名；敏感别名不进 FTS | fts.ts cueTextOf |
| E-6 | 库级 schema v2；卡行版本独立为 1（v2 先例：只改 mem_miss 也升库版本、卡行不跟） | schema.ts 版本注释 |
| E-7 | 探针验证应用层预切分＋`unicode61` 可行；SQLite 无内置 bigram tokenizer | bigram-probe.ts、学术稿 5.1 |
| E-8 | 探针各臂：trigram oracle 9/25；bigram（B3）22/25；bigram＋全 unigram（B4）23/25；整句 B1 0/16；片段枚举 B2′ 16/16 误召 2（**拆句工臂，非本卡口径**） | cue-arm-bench 日志 |
| E-9 | #123 P1–P5 已入库、P6 金标未达标、rules 仍 v1；接口面 display_cues_json 与本卡正交 | cue-derive.ts、types.ts |
| E-10 | 两条语义鸿沟（锁库/database is locked、长满一半/长到一半）词法永不可解，归向量或别名，不属本卡 | 学术稿 |
| E-11 | **归一化现状有缝**：`matchesSubstring`（projection/types.ts:209）仅 asciiLower、无 NFKC；门侧 `normalizeLexicalText`（gate.ts:48）含 NFKC＋asciiLower＋空白折叠，两道复核本就不同源 | 见 3.4 |
| E-12 | **重建协议现状**：影子库 rmSync→新建→单事务 BEGIN/COMMIT 建全套 DDL 并灌数→fsync→rename 原子替换（builder.ts:524-591）；失败删影子库抛出，旧库完好 | 见 3.5 |
| E-13 | **版本拒绝现成范式**：drain.ts:407-420 事务外只读比 rules_version，不符即 rebuild-required、动作全空零写入；错误型 MemoryIndexStaleError 已存在（store.ts:410） | 见 3.6 |
| E-14 | 离线重建 CLI 为既有工具（scripts/build-memory-index.ts，五纪律：显式 data-root、默认试运行、--apply 二次确认、真值只读、零正文），本卡不新增 CLI | Q-B 闭合 |
| E-15 | 探针 B4 的 unigram 实现是"全部 CJK 单字追加"（bigram-probe.ts:174，读法 B）；体积 239→467（1.95×）度量的是纯 bigram 臂、不含 unigram 表（探针 :181-182） | 见 3.1 |

### 1.4 助理独立补查：经历库是第二条检索链，常量必须拆（B9）

`projection/sqlite.ts:473` 的同一阈值常量服务经历预筛，其表 `experience_fts` 是独立 trigram 虚拟表（projection/schema.ts:34）。若把共享常量直接 3→2：2 字查询会对 trigram 表发 MATCH，trigram 对 ≤2 字符不产条目、**返回空集且不抛异常，LIKE 回退被跳过**，经历库现有 2 字 LIKE 能力反被打哑。故本卡新设记忆侧常量、projection 侧常量保留 3，两表几何彻底解耦；experience_fts 是否 bigram 化另案评估，不在本卡。

---

## 2. 目标、不变量与非目标

### 2.1 目标（逐条可验收）

1. 新建 bigram 纯函数，**分两层**：run 切分（语种分段）＋单元发射（bigram/unigram 产出），为拆句工后续卡预留复用面（Q-D/S11）；
2. CJK 相邻两字滑窗、ASCII/数字整词保留；**unigram 仅对"长度 1 的孤立 CJK 段"发射（读法 A），长段不逐字补底**（B5）；
3. 写入侧 cueTextOf 产物经 bigram 化入 FTS 文本列；display_cues_json 原文一个字节不改；
4. FTS 表 tokenizer 换 `unicode61` 且参数显式声明（不依赖 SQLite 默认值）；库级 schema 升 v3，CARD_SCHEMA_VERSION 保持 1（E-6 先例）；
5. 查询同侧 bigram 化＋phrase 包裹；记忆侧新常量 `MIN_FTS_CODEPOINTS=2`，**与 projection 侧常量物理拆分**（B9）；
6. 命中复核靶改为**原始 display_cues_json＋非敏感活跃别名原文**，三侧统一归一化（3.4）；复核是 2 字查询的正确性前提而非收尾校验（B3）；
7. 版本窗口机械识别＋双向硬拒（3.6）；重建协议与验收按 3.5/第 6 节。

### 2.2 显式不变量

- **I-1（承重）**：FTS 永远是可弃抄本，真源 append-only 账本为唯一权威；任何把 FTS 列读回写卡契约/真源的改动视为违反本卡边界（S8）。
- **I-2（两卡共享）**：复核门不可绕过——后续拆句工卡的任何聚合策略都必须过原文复核，本卡为此立规（S11）。
- **I-3（隐私）**：sensitive=1 别名在 FTS 与复核两条路径均不可见，复核 haystack 只取非敏感活跃别名（S9）。

### 2.3 非目标

- 不做整句片段枚举/停用词/聚合策略（拆句工后续卡，待 P6 金标标定）；
- 不动 rules_version（维持 rules-v1）、gate 裁决、MatchKind、BM25＋0.15 近因排序与 tie-break；
- 不新增表/字段，CARD_SCHEMA_VERSION 保持 1；不动 experience_fts（1.4）；
- 不解决 E-10 语义鸿沟；不负责在制品入库与脱敏（挂账①）；
- 不把 FTS 准入阈值降到 1（纯单字查询维持 LIKE 路由，防止单字语义卷入场内）。

---

## 3. 机制设计

### 3.1 纯函数模块（建议 `src/memory/bigram.ts`，沿用 fts.ts 无环纪律）

- 两层 API：`segmentRuns(text)` 产出 CJK 段/ASCII 词段；`emitUnits(runs)` 产出索引/查询单元；
- CJK 段长度 ≥2：相邻两字滑窗；长度 1（孤立段）：发射该字 unigram；**不对长段逐字补 unigram**（读法 A，B5/洞2.3）；
- ASCII/数字：整词，长度门槛与清洗规则红测钉死；
- 码点口径写明＝Unicode code point（沿用 `[...str]` 语义，astral 字符天然正确）；
- 单元间连接用空格；连接符本身不可被查询侧误命中（红测覆盖）。

### 3.2 写入侧

`fts.ts::cueTextOf` 词表拼接后经同一纯函数产出单元序列写 cue_text；sensitive=1 不进 FTS 的隐私语义原样保留（I-3）。

### 3.3 表结构与常量

- FTS DDL 改 unicode61 并显式写参数；`MEMORY_SCHEMA_VERSION=3`，注释登记 v3＝#124 bigram 几何；CARD 版本不动；
- 常量拆分：记忆侧 `MIN_FTS_CODEPOINTS=2`（仅 bm25.ts 引用）；projection 侧保留独立常量 3（sqlite.ts:473 继续引用），全仓单一一处定义、禁止两处漂移（B9/报告2-1.3）。

### 3.4 查询侧与三侧归一化（B6）

- 阈值改引新常量；查询经 emitUnits 后 phrase MATCH；精确别名路径与 LIKE 回退路径语义不变；
- **归一化同源**：写入、查询、复核三侧统一调用既有 `normalizeLexicalText`（NFKC＋asciiLower＋空白折叠），禁止私造归一化；复核 needle 与 haystack 同规约后再 matchesSubstring，封堵全半角/大小写假阴性（E-11）；
- 复核 haystack＝display_cues_json 原文＋非敏感活跃别名原文，逐字段独立复核（与 cueTextOf 拼接方式对齐，跨界 bigram 伪命中的处置写死）；
- 纯单字（1 码点）查询：不进 FTS，维持 LIKE 回退，红测保证可命中；unigram 只服务多段查询中的孤立单字段（B5）；
- 空 units（纯标点/空白）：不构造 MATCH，出口固定为干净空结果（不允许 FTS 语法异常冒泡），红测钉死（S12）；
- 跨 cue 相邻命中登记为已知旁效、视为召回增强、不修（S12）。

### 3.5 重建协议（B1/S7）

1. 只准沿用 E-12 影子库整库协议：tmp 新库→单事务内执行全套 v3 DDL（含新建 unicode61 FTS 表）→灌数→stamp→COMMIT→fsync→rename 原子替换；**禁止在旧库上 DROP/删行重灌**；事务失败删影子库、旧库持续服务；
2. 重建验收（临时根合成库，全量）：①读 `sqlite_master` 断言 FTS 实际 `tokenize=` 含 unicode61；②卡行 row_hash_sum 逐字节相等；③FTS 文本列与 `cueTextOf→emitUnits` 重算产物逐字节相等；④提交前 MATCH 抽样可召回；
3. 真机重建（现 2 卡、代价近零）单列授权单：含冷备指针、影响清单；**合并≠部署**——v3 代码可先合并，真机生效必须与授权重建为同一次原子切换，切换前 v2 代码保持可运行（S6）；
4. 回滚判据：还原 commit＋回 v2＋离线重建后，必须复跑一次 FTS MATCH 端到端确认可召回，回滚才算完成。

### 3.6 版本窗口语义（B2）

- 复用 E-13 通道：开库读 schema_meta.schema_version 并读 sqlite_master 实际几何，任一不符即判定需重建；
- 语义写死：**卡片可读、检索硬拒，显式抛"需离线重建"错误，禁止静默返空**（防止把索引失效伪装成记忆缺失）；
- 双向矩阵红测：v2 库×v3 代码、v3 库×v2 代码两个方向都不得静默混用（Q-C）。

---

## 4. 时序

1. 本卡先于 #123 解冻：接口正交、零阻塞；**承诺 #123 解冻后对本卡红测集回归复跑一次**（洞3.2/S3）；本卡验收 cue 集另锁合成集，探针 25 词保留为独立回归基线（脱敏复现见挂账①）；
2. P6：**出题可与本卡编码并行、正式出分在本卡合并之后**（几何修复后出题才公平，S4）；返工通道（方案 B）：P6 出题若发现几何偏差，回退本卡修正、P6 暂停，不另立精度门（S2）；
3. 拆句工卡：本卡合并＋P6 达门槛后立项，吃同一纯函数与金标数据；
4. "真机现仅 2 卡、重建成本此刻最小、越晚越贵"作为本卡现在做的论据登记（S5）；
5. #116 窗口接线无耦合，维持原排期。

---

## 5. TDD 红测（13 条）与变异反证（5 点）

红测先红后绿，必测项只增不减：

1. 纯函数：2/3/4 字 CJK、孤立单字段、中英混排、ASCII 整词、标点空白、NFKC 全半角；读法 A 边界（长段不逐字补 unigram）；
2. 确定性双跑：同库两次重建 FTS 文本逐字节相等；同查询两次**结果集与顺序**相等（MATCH 计划仅作诊断信息、不入断言，防 flaky）；
3. 2 字词端到端可召回；3/4 字专名滑窗命中且不误撞含首片异卡；
4. **单 bigram 精度护栏**：2 字查询命中"含该字但非该词"异卡时，原文复核必须拒收（正反例，B3）；
5. 单字路由：纯单字查询走 LIKE 回退且可命中；多段查询孤立单字段经 unigram 命中（B5）；
6. 归一化矩阵四格：全/半角、大小写、2 字 ASCII、跨界 bigram，每格预期写死无"未定义"格（B6）；
7. 空 units 查询出口固定、无异常冒泡（S12）；
8. 隐私双路径：sensitive=1 别名在 FTS 与复核均不可见（S9）；
9. 版本门双向矩阵＋未重建硬拒显式错误语义、读卡路径可用（B2）；
10. 重建断言：sqlite_master tokenizer 实测值＋FTS 抄本重算逐字节比对＋提交前 MATCH 抽样（B1/S7）；
11. gate/rules 不变性：静态扫描确认不引用几何常量＋同 cue 集改前改后门裁决逐条相等（B8）；
12. experience_fts 预筛行为逐字不变（B9）；
13. 既有 1231 测试全绿、总数只增不减；任何旧断言改动须在本 charter 增补登记理由。

变异反证（每处必须恰好打红对应红测）：①bigram 滑窗退回 trigram；②删孤立 unigram；③复核靶改回 FTS 切分序列；④阈值常量回 3；⑤去掉查询 phrase 包裹（S10）。

---

## 6. 验收口径

- `npm run verify` 干净、双 tsc 0、`npm test` 全绿且总数只增不减；静态拓扑门含"无外部 tokenizer 依赖"断言；
- **生产路径 mini-bench（门禁＋复核全开、隔离临时根）**：2 字 oracle 召回按生产语义重测取数（B3 臂 22/25 为参照基线，含单字项由 LIKE 路径单独计分；探针 23/25 标注为无门禁实验臂参考，不得冒充生产口径）；
- **门后错卡率＝0 容忍**（phrase＋原文复核构造保证，生产观察到 >0 按 bug 处理）；FTS 候选膨胀率仅观测记录、不设卡（B4/S2）；覆盖 CJK 2 字与 ASCII 2 字母两族；
- 体积：度量对象写死为 FTS cue_text 列 `sum(length)`、含空格分隔符、不含 unigram 追加；读法 A 下膨胀不大于纯 bigram 臂基线 1.95×（m-2/B5）；
- 重建幂等：row_hash_sum＋FTS 抄本比对双证据；
- **预期管理登记：真人整句问法合并后预期仍 0/16，如实记录不得修饰**（0.2/0.1）；
- 真机零写入证据：本卡全部提交不触碰 `~/.dsh/fasti`。

---

## 7. 风险、回滚与挂账

| 项 | 内容 |
|---|---|
| 过度匹配 | 常见 bigram 低 IDF：phrase 相邻有序＋原文复核＋BM25 IDF 加权＋门后零容忍红测四重处置；本卡口径不引用拆句工臂 B2′ 的误召数字 |
| 体积/性能 | ≤1.95× 文本膨胀；性能基线在合成 50 事件库留档，百卡量级留 shadow 观测 |
| 归一化假阴性 | 三侧同源＋四格矩阵红测（3.4/红测6） |
| 回滚 | 还原 commit＋schema 回 v2＋影子库重建＋MATCH 端到端复跑确认；真源零改动无数据迁移 |
| 挂账① | 11 项在制品 .ts 含示例真名，入库前统一脱敏；脱敏后探针语料复现基线随本卡验收重测（m-5/M-1） |
| 挂账② | #123 台账 11.4.0 追认（取号前置，签认栏单列） |
| 挂账③ | 拆句工后续卡、P6 金标填充、真机重建授权单（含合并≠部署条款） |

---

## 8. 外审闭合记录（11.2 表 C）

四份材料：聚焦外审评审稿、聚焦外审报告、第二意见复核、独立外部评审；处置总簿见《task124-外审处置裁定稿-2026-11-17》。无否决性意见。

- 三问裁定：Q1 升版口径**有条件采纳**→B1/B2/S7/S8 闭合；Q2 宽窄边界**有条件采纳**→B3/B4/B5/B6/S9 闭合；Q3 时序**有条件采纳**→S2/S3/S4/S5 闭合；
- 阻塞 9 项 B1–B9 全部落入第 3/5/6 节正文；建议 13 项 S1–S13 全部落入对应小节；
- 外审稿①三处自相矛盾（阻塞清单漏 2.1、洞3.1 误诊为环、R3 误延后）按第二意见复核版纠正；外审"2 字从查不到变易错"表述按代码核实修正为"LIKE 回退路径迁入 FTS 路径"（裁定稿第 3 节）；
- 助理独立补查 B9（experience_fts 常量拆分）为外审未覆盖项，已入 1.4/3.3/红测12。

### 附：探针方法学摘要（m-5 自包含要求）

8 个桥段由真模型 cue 派生流水线产 cue；25 个 oracle 短词为人工指定的桥段内确定性词面（含 1 个单字词"冰"）；16 条真人整句问法为原始口语问法；对照臂 T（trigram 生产现状）/B1（bigram 整句）/B3（bigram oracle）/B4（bigram＋全 unigram）/B2-B2′（片段枚举实验臂）。完整脚本 bigram-probe.ts、语料清单脱敏版随在制品脱敏同批入库。

---

## 9. 主控签认栏（五问闭环，逐格证据）

| 问 | 证据格 |
|---|---|
| ①分歧是否全部闭环 | 第 8 节映射表；四份外审无否决，29 条意见 28 采纳 1 修正 |
| ②反对意见闭环 | 无否决性意见；阻塞 9 项逐条入正文（B1–B9 索引） |
| ③红线红绿灯 | K10 机检断言（6 节）；K4/K5 影子库协议＋双比对（3.5）；gate/rules 行为红测（红测11）；真机零写入（6 节）；宁空勿错＝门后零容忍（6 节） |
| ④实测数据 | 生产路径 mini-bench 待编码后取数（召回/门后错卡 0/膨胀率/整句 0-of-16 预期）；现有探针基线 E-8/E-15 |
| ⑤最坏回滚 | 3.5 第 4 条：回滚＋MATCH 复跑判据；真源零改动 |
| 附 | 预期管理已对齐（0.1）；挂账②#123 追认在取号前完成；授权四查（临时根/回滚/测试数/最坏后果）编码阶段逐项过 |

主控裁定：＿＿＿＿（采纳 v2 冻结／退回修订，日期）

---

## 10. 编码施工增补（红测13 落地登记，段0–段3 收口）

> 红测13 要求：既有测试全绿、总数只增不减；任何旧断言改动须在本 charter 增补登记理由。
> 基线 1231（HEAD=72cefe7）→ 段3 收口 **1253 全绿、零 fail/skip、`npm run verify`（build+typecheck+test）干净**，净增 22 测，无删除、无放水。

### 10.1 新增测试（+22，只增不减）

| 文件 | 条数 | 对应红测 |
|---|---|---|
| tests/memory/bigram.test.ts | 13 | 红测1/2/6/7＋三侧归一化同构＋红测12 常量物理拆分静态守护 |
| tests/memory/geometry-window.test.ts | 4 | 红测9 版本窗口双向矩阵（v2 戳记/trigram 实际几何/戳记缺失/健康库） |
| tests/memory/bigram-recall.test.ts | 3 | 红测3（2字/3字/4字召回不误撞）、红测4（原文复核端到端拒收）、红测5（孤立 unigram 多段命中、纯单字 LIKE 冻结语义） |
| tests/memory/builder.test.ts 追加 | 1 | 红测10 影子库重建验收（unicode61 DDL＋FTS 列逐字节重算＋MATCH 抽样＋戳记/row_hash_sum 对账） |
| tests/memory/gate.test.ts 追加 | 1 | 红测11 静态扫描（gate 不引用几何常量/bigram/bm25）；同文件 N3 同构扩为 gate/bm25/bigram 三方 |

红测8 隐私双路径由 bm25.test 敏感词用例＋task42-derive R-01＋红测10 敏感单元缺席断言三处共同覆盖；红测12 经历库侧由 projection.test 既存 `experience_fts tokenize='trigram'` 几何断言（未改、全绿）与新增常量守护双向锁死。

### 10.2 旧断言等价迁移登记（无一条静默放宽）

| 文件 | 旧断言 → 新断言 | 理由（#124 几何变更） |
|---|---|---|
| schema.test.ts | 库版本期望值 2 → 3 | MEMORY_SCHEMA_VERSION 升 3；卡行版本 MEMORY_CARD_SCHEMA_VERSION=1 未动 |
| store.test.ts | 开库幂等 meta 值 '2' → '3' | 同上，戳记随库级版本 |
| task42-derive.test.ts | R-01 FTS 列断言改为 `cue_text === indexTextOf(cueTextOf(...))` 并加强敏感别名 bigram 单元缺席检查 | 列内容由原文改为 bigram 单元序列；隐私口径收紧到单元级 |
| bm25.test.ts | trigram 几何旧断言批量等价迁移：复核收口改 latin 词首非 ASCII 脱落案例；短词回退断言通道不挂 fts-substring；敏感词改 bigram 列；M12 改 bigram 几何；limit 次序断言改集合比对（次序归排序专测）；explained 纯 LIKE 用例查询词改单字 '夜' | 通道从 trigram+LIKE 换为 unicode61 bigram+phrase＋原文复核；limit 用例因通道由 LIKE 零分换 FTS 带分导致次序变化，集合不变 |
| gate-smoke.test.ts / gated-assembly.test.ts | github/concatenate 词边界用例改断言"弱卡不出现门后集合＋物理 MATCH 不召回" | unicode61 整词 token 把 ASCII 词边界前置到召回层；gate 裁决规则本身未拆，gate.test:74/151/156 纯函数守护原样全绿 |
| builder.test.ts | apply 断言改 indexTextOf 精确等式＋隐私单元缺席 | 同 R-01，列口径变更 |
| audit/provenance.ts（生产）＋qa-memory-harness.test.ts | ftsTraceable 由"列词项⊆cardTermSet"重写为"cues＋非敏感别名经同一 emitUnits 重算 allowed 单元集，列单元单向∈allowed" | 旧谓词在 bigram 列下语义失效；新谓词与写入侧同一纯函数，可追溯性更强 |
| 20 处 RevisionRecord 测试夹具 `schema_version: 1 → 3` | 见 10.3 | 新几何版本窗口对测试库生效 |

### 10.3 夹具戳记批量修正的边界（20 处，三分类处置）

版本窗口上线后，测试经 `stampMeta`（upsert ON CONFLICT DO UPDATE）盖章的 RevisionRecord 手填 `schema_version: 1` 会把库戳记覆盖成 1，被新硬拒机制正确拦截。逐对象三分类处置：

- **RevisionRecord 索引盖章（实改 20 处 → 3）**：memory-tool-bridge、gated-assembly、host-tool-runtime、bm25、builder、gate-smoke、invalidate、ledger、runtime、store、task42-derive/drain/drain-chain/observations-io、qa-memory-harness、synthetic-pipeline。生产 builder.ts 盖章本就传 MEMORY_SCHEMA_VERSION 常量，生产无此问题，仅测试夹具过时。
- **MemoryCard 卡行（保持 1）**：MEMORY_CARD_SCHEMA_VERSION 冻结为 1（store.test cardFromRow、schema.test、v1.4-replay 等），与库级版本是两个版本号。
- **EventRecord/Experience 事件契约（保持 1）**：helpers.makeExperience、各 event/projection/api 测试、cue-backfill 的 stampMeta 任意入参用例，不经几何校验，逐字未动。

### 10.4 段4 验收取数（5 点变异反证＋生产路径 mini-bench，已闭合）

**变异反证（逐个注入生产码、跑对应红测、当场恢复；每处恰好打红对应红测）**

| 变异 | 打红条目 | 结论 |
|---|---|---|
| ①滑窗退回 trigram | 7 条（emitUnits 2/3/4 字、孤立单字段、中英混排、indexTextOf、红测3/红测5 端到端） | 有效 |
| ②删孤立单字 unigram | 3 条（红测5 端到端、emitUnits 孤立段、中英混排） | 有效；顺手补强"纯 unigram 双单字卡"使端到端必红 |
| ③复核靶退回 FTS 切分序列 | 2 条（红测4 端到端、bm25 原文字段复核专测） | 有效 |
| ④阈值常量回 3 | 3 条（红测3 2 字召回、红测5、红测12 常量守护） | 有效 |
| ⑤去掉 phrase 双引号包裹 | 2 条（ftsPhraseOf 纯函数、红测3 物理相邻守护） | 有效；端到端另有原文复核纵深兜底 |

注：初版红测5 与红测3 只靠纯函数测守护变异，已补两条端到端/物理层断言使其独立打红，避免"改坏代码但端到端仍绿"的假安全。

**生产路径 mini-bench（tests/memory/bigram-mini-bench.ts）**

数据：`iso-write-line.real-run.log.txt` 的 8 个真实桥段（真模型 cues 逐字照抄）＋ 16 条真人问法逐字照抄，经生产 `writeCards + syncFts` 写入内存库。

| 指标 | 实测 | 口径 | 判定 |
|---|---|---|---|
| 真人整句直打 | 候选归零 16/16、正确卡 0/16 | 收益只在短词，整句 0/16 不变（预期管理已对齐） | 与本卡目标一致 |
| 短词直打（2–4 字，13 条） | 候选归零 1/13、**正确卡命中 12/13** | 结构性 0 召回已解除；唯一未命中「锁库」属词法语义鸿沟（cue 只有 sqlite/locked） | PASS |
| 门后错卡 | 整句 0、短词 0 | 红线零容忍 | PASS |
| FTS 体积 | 463/239 字符＝**1.937×** | 上限 1.95× | PASS（余量仅 0.013，样本仅 8 卡，真机整库复测须留意拉丁密集 cue） |

**仍挂账（不在本卡编码范围）**：两份 gitignore 锁死的 *.log.txt 旧名由段4 探针重跑刷新或显式授权删除；冷备 tar 补做＋sha256；真机 v3 原子切换为独立第三道授权门；untracked 在制品入库范围须显式授权。本卡编码全程真实数据根零写入。

### 10.5 真机 v3 原子切换记录（2026-11-17，主控授权后执行）

| 项 | 结果 |
|---|---|
| 冷备 | `/home/user/.dsh/fasti-reset-20261117.tar.gz`（15.5 KB，13 文件全收）；sha256 `8cf3c6c2d0bb4690f51ed0fa3de70f130f8b0dc4750c5b8424691dd9937c703b`，切换前 `sha256sum -c` 通过 |
| 切换前旧库 | schema_version=2、tokenizer=trigram |
| 切换动作 | `build-memory-index.ts --data-root /home/user/.dsh/fasti --apply --yes`，影子库单事务＋fsync＋rename 原子替换；revision 4、slug=rebuild、shadowDiff 全 0 |
| 切换后新库 | schema_version=3、tokenizer=unicode61、卡 2 / 别名 0 / FTS 行 2；新代码 `assertGeometryCurrent` 放行并检索成功 |
| 真源影响 | events/experiences 全部零写入（mtime 复核 0 处变化），旧库由原子替换单点覆盖 |
| 回滚路径 | 解包冷备 tar 覆盖 `projection/memory-index/` 即回到 v2 可运行态 |

**体积红线口径变更（重要）**：切换时真机库内 2 张卡的 cue 文本均为空串，体积算式为 `0/0`，**真机无从实测**。故 1.95× 红线由"切换前实测"改为**"切换后首周随真实数据增长复测"**并挂账：一旦真实 cue 写入，须在真机整库复跑体积比（生产路径 mini-bench 现有 1.937× 仅来自 8 卡合成样本，不作上线背书）。此项列入 #123/#124 后续复盘清单。

