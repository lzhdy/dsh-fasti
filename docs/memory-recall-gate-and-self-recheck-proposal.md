# #44 召回侧证据门加严与落空自主回查 —— 外部评审提案（第一层 · 记忆内核）

- 状态：**v2.3 已获外部明确 PASS，待用户开工确认后进入 TDD**（v1 附条件 PASS → v2 布尔门 →
  v2.1 补 R 精度 → v2.2 闭合 N1–N4 → 终审明确 PASS 并附施工期护栏 N5；本版纳入 N5，仍零代码改动）
- 日期：2026-11-12
- 作者：内部（提出问题与方案、负责实现与自测）；外部独立对抗评审
- 本期施工范围：**仅第一层（src/memory 纯函数 + 读柄只读增量 + 离线 harness + 文档）**
- 硬纪律：不碰真实根、不碰实时链路与 M6 隔离门、不引依赖、`git` 不 add/commit/push；复审通过前零代码改动

---

## 0. v2 修订说明与评审意见逐条裁决

### 0.1 三处“事实错误”经回码核对为评审方工作树版本过期，v1 主张在拆除终态成立

评审方在其 Windows 工作树（路径时间戳 2026-11-11）看到人工通道拆除前的旧文件。本仓
`src/memory/` **整个目录在 git 中零跟踪（全部 untracked，`git ls-files src/memory` 计数为 0）**，
因此即使双方 HEAD 字符串同为 `eafe484`，untracked 工作树文件仍可不同。以内部当前拆除终态工作树
（#45–#50 已硬拆除人工 seed/anchor-remap 通道）逐条实测：

| 编号 | 评审方旧树所见 | 拆除终态工作树实测（本提案基准） | 裁决 |
|---|---|---|---|
| F1 | `CHECK(source IN ('seed','manual','miss'))`、类型三值 | `schema.ts:78` 为 `CHECK (source IN ('miss'))`；`types.ts:69` 为 `source: 'miss'`；全仓无 seed/manual 来源 | **v1 正确，请以拆除终态复核** |
| F2 | `created_by 'her'\|'offline-operator'` | `types.ts:178` 为 `created_by: 'her'`；`ledger.ts:32` `DECISION_CREATORS=['her']` | **v1 正确** |
| F3 | 全量 718 用例 | 当前树静态注册实测 **687**（`grep -rE '^\s*test\(' tests` 计数 687；其中 bm25=14、builder=26、miss=18、schema=16 等） | **v1 的 687 正确**；718 为拆除前旧树口径 |

附：评审方引用的 `src/memory/seed.ts`（含 `MAX_ALIASES=5`）在拆除终态**已不存在**（`ls src/memory`
无 seed.ts，全仓 grep 无 MAX_ALIASES）。故其 D7 所指“上限仅在 seed 校验”的具体锚点失效，但“别名
数量在 DB 与现存代码中无任何强制”这一问题在终态反而更彻底，本版仍予闭合（见 5.5 / D7）。
请评审方改用拆除终态工作树复审；本版所有行号均以该终态实测为准。

### 0.2 设计级意见裁决（D1–D12、S1–S5）

评审在设计层提出的多数问题独立成立、质量高，本版全部采纳并修法；最重要的两处调整是
**主设计由“连续证据分 + cutoff 网格标定”改为“确定性布尔通道门”（采纳 S2）**，从根上消解证据分
公式退化（D1）与小样本伪标定（D4）；连续证据分/统计标定登记为后续演进项。

| 项 | 评审意见要点 | 本版裁决与修法位置 |
|---|---|---|
| D1 | coverage=命中片段/查询长度，而三档都整串命中 q → 恒等于 1，乘法门退化为三档粗门 | **采纳，取消连续 coverage 公式**，改为布尔通道门（§5.2） |
| D2 | asciiBoundary 对中文/精确别名未定义，误取 0 会杀死中文与敏感精确召回 | **采纳**，明确 exact 恒过、CJK 边界 N/A 视为过、仅 ASCII 子串查边界（§5.2） |
| D3 | LIKE 拒绝若依赖 cutoff 取值则不牢靠 | **采纳且被布尔门吸收**：LIKE-only 按构造确定性拒绝，与任何阈值无关（§5.2） |
| D4 | 合成夹具仅 gold-l0=2/gold-l1=2/holdout=1/decoy=1（已实测属实），无法标定 0.05/0.85，且训练=验证泄漏 | **采纳**：第一层只做机制 + 占位策略 + 敏感性烟测，**不声称统计达标**；连续分与真实定值延后，另定可复现标定协议（§5.7） |
| D5 | writeAliases 为破坏性 upsert，可能覆盖来源/敏感级/命中统计 | **采纳（按终态修正措辞）**：终态 source 恒 'miss' 已无种子源可覆盖，但 sensitive 降级与 hit_count 重置风险仍在；改 INSERT-or-guard（§5.5） |
| D6 | 只写 mem_alias 不更新 mem_card.aliasesJson → 破坏“同源快照”，decoy 漏计、重建永久分歧 | **采纳**：采用同步方案，补别名时同事务更新 aliasesJson 并重算 contentHash、留 add-alias 决策（§5.5） |
| D7 | 别名上限无 DB/现存代码强制（seed.ts 已删） | **采纳**：新模块应用层强制每卡 active 别名上限（常量 5），溢出拒绝，不加 DB CHECK（§5.5） |
| D8 | store↔新模块可能 import 环 | **采纳**：新建无环低层模块 `alias-write.ts`，自带 SQL、不 import store，store 单向委托（§5.5） |
| D9 | gate 必须在 limit 截断前过滤全集 | **采纳**：gate 检索取 `limit=undefined` 全集→布尔过滤→再截断；旧函数保留原 limit 语义（§5.1/§5.2） |
| D10 | 高危“趋 0”不可判定 | **采纳**：硬约束写为评测集高危主动错认 **=0**，弃权不计、返回错卡才计（§5.7） |
| D11 | R2 拆分未指定如何接线、null 旧语义 | **采纳**：定义四态结果并映射度量，旧 r2 逐字保留并列（§5.7） |
| D12 | 网格/烟测不得在标定中写别名 | **采纳**：烟测全程只读、绝不调 applyMissAlias，补别名联动单独功能测试（§5.7） |
| S1 | matchKinds 用联合类型而非 string[] | **采纳**（§5.3） |
| S2 | 第一层改用确定性布尔通道门，连续分延后 | **采纳为主设计**（§5.2） |
| S3 | 空 accepted 仅在无近因/身份卡时才触发 empty-relevance，需澄清编排职责 | **采纳**，window 零改、nuance 写入编排约定（§5.6） |
| S4 | 零漂移须锁定 ftsOk 分支：LIKE 仅在查询<3 码点或 FTS 解析抛错时跑，非每次零命中 | **采纳**，补该两路快照测试（§8） |
| S5 | miss 别名跨重建 durable（builder 保留 mem_alias），但分歧由 D6 解决 | **确认并由 D6 同步方案闭合**（§5.5） |

### 0.3 第二轮 HOLD 的闭合：可核实性 + R-1..R-5 精度

第二轮评审诚实撤回了 F1/F2/F3 的“事实错误”定性，但因它的环境只有拆除前树与 v1 文档、物理上访问不到
本终态，给出 HOLD（不为看不见的树背书）。本版做两件事闭合：

1. **随附“终态核验包”**：仅含开源机制代码（src/memory、tests/memory、tests/contract、
   tests/fixtures/memory 合成夹具、相关 scripts、docs、package/tsconfig 配置）与一份
   `EVIDENCE-terminal-state.md`（内部亲跑命令与输出）；**不含真实根、不含任何 .sqlite/.jsonl/.db、
   不含个人数据**——夹具全部为 `syn-` 前缀人造 id 与“合成线索/合成别名”等占位文本，无真实事件正文。
   评审方解压到其 workspace（如 `<workspace>/dsh-fasti-terminal/`）即可独立复跑下列对账：
   ```bash
   git ls-files src/memory | wc -l          # 期望 0（全 untracked）
   ls src/memory                            # 期望无 seed.ts
   grep -n "source IN" src/memory/schema.ts # 期望 CHECK (source IN ('miss'))
   grep -nE "source:|created_by:" src/memory/types.ts
   grep -n "DECISION_CREATORS" src/memory/ledger.ts   # 期望 ['her']
   grep -rn "MAX_ALIASES" src/memory        # 期望无输出
   grep -rhoE "^\s*(test|test.skip|test.todo)\(" tests | wc -l   # 期望 687
   ```
2. **R-1..R-5 精度全部落文**（详见 §5.2/§5.5/§5.7/§9）：词边界字符类与残余反例（R-2）、写面列与哈希
   逐字一致及双层守卫（R-3/R-4）、四态度量的 hasGold 与各率分母、高危双硬约束消歧（R-5）。评审方对
   R-1/R-3/R-5 的方向性认可记录在案，本版补齐其要求的可判定细节。

### 0.4 第三轮终审裁决与 N1–N4 闭合（本版）

外部在解压后的终态树上独立实跑，**正式撤回 F1/F2/F3**（确认系其拆除前旧副本误判），并独立
`npm run verify` 复跑：Linux **687 tests / 0 fail / 0 skipped**、build+typecheck 零错误（win32 为
686 pass/1 skip，M9 为 POSIX-only，与本仓口径一致）；R-3 重建链路、读柄零写方法、M6 门、dependencies
`{}` 等终态锚点逐条亲验通过，裁决“附条件 PASS”，仅余两项必修、两项建议。内部已回码再核四项均属实，
本版裁决：

| 项 | 外部发现 | 本版闭合 |
|---|---|---|
| N1（必修） | v2.1 称 alias-write“不 import store”却要复用 builder 的 computeContentHash（builder:41-50 import store）与 store 的 syncFts/cueTextOf，实成 `store→alias-write→builder→store` 三环或 store↔alias-write 二环，与“无环”自相矛盾 | 采纳其修法 (a)：抽两个**无环共享低层** content-hash.ts、fts.ts，函数只搬不改、零漂移回归；alias-write 只依赖无环模块+types，import DAG 无环可 grep 自证（§5.5） |
| N2（必修） | G=cc+wc+wa 与 NG=ca+wc 让 wc 双计，G+NG=N+wc≠N，recall/correctReject 分母失真 | 按 hasGold 拆 wc_G/wc_NG，G=cc+wc_G+wa、NG=ca+wc_NG、N=G+NG，并加 G+NG=N 表驱动断言（§5.7） |
| N3（建议） | 词边界 haystack 须与 matchesSubstring 同一规范化形，避免大小写/规范化口径错位 | 采纳：q 与 haystack 都先过 normalizeQuery，补规范化一致性测试（§5.2.1） |
| N4（建议→已收尾） | 核验包 package-lock.json 根 devDeps 缺 @deepseek-ai/dsh-llm，fresh `npm ci` EUSAGE（实测属实；该 lock 为 tracked 历史文件、相对 HEAD 无改动，非本任务产生） | #44 内不夹带；闭环后独立收尾已完成 lock 刷新（7→16 包，含 dsh-llm@0.2.1-rc.5 及传递依赖，registry 同域 npmjs.org），`npm ci --dry-run` 退出 0，741 回归全绿 |

### 0.5 终审明确 PASS 与施工期护栏 N5（本版纳入）

第四轮外部确认 v2.2 代码区与 v2.1 逐字节一致（未编辑任何 .ts）、N1–N4 逐项核验闭合、独立 verify
687/0/0，给出**明确 PASS，准予按 §11 进入 TDD**，并附一条不阻断起步、但 alias-write 落地前必须闭合
的强制护栏 N5。内部回码再核属实，本版采纳其推荐修法 (a)：

- **N5 事实（已核实）**：`normalizeQuery` 位于 `bm25.ts:38`，而 `bm25.ts:22` import store；若
  alias-write 为取规范化函数而 import bm25，将形成 `alias-write→bm25→store→alias-write` 环，N1 无环
  再度落空；原 §8 静态断言只禁 store/builder、未覆盖 bm25。
- **修法 (a)（对齐仓内 miss.ts 姊妹先例）**：alias-write 与 `miss.ts` 同款契约——低层**只接收已规范化
  的 termNorm**、仅校验其为非空字符串（参见 miss.ts:52-53），自身不 normalize、**不 import bm25**；
  规范化由应用/编排层在调用前完成。具体落点：store 写柄薄封装在委托 alias-write 前先调
  `normalizeQuery`（store→bm25 本就是既有合法依赖方向，不新增环），gate 的边界纯函数同样只收已
  规范化入参（见 §5.2.1 N3）。故不新增 normalize.ts、不搬动 normalizeQuery，零额外漂移面。
- **必做静态门**：import 图断言的禁依赖集扩到 **store、builder、bm25 及任何传递 import store 的模块**，
  对 content-hash.ts/fts.ts/alias-write.ts 三者生效，人为反向 import 即红（见 §8）。
- **时序**：content-hash/fts 抽取不涉及 normalize，可先行；N5 在 alias-write.ts 落地前闭合并由静态
  测试覆盖，否则视为违反已批准的 N1 无环要求。

---

## 1. 背景与问题（拆除终态代码事实，附文件锚点）

1. **检索只排序、不设“够不够格”的门。** `searchCards()`（`src/memory/bm25.ts:63`）对任何词面命中即收
   为候选，按 `score=-bm25Raw+λ·recency`（`LAMBDA=0.15` 见 :26、半衰期 30 天见 :29）排序截断，
   **无门槛、无弃权**，弱相关可能进窗口，正对 R2 红线（错误认定率上限 0.05）。
2. **LIKE 回退是最弱通道且触发条件特殊。** 仅当查询码点 `<3` 或 FTS `MATCH` 解析抛错（`!ftsOk`，
   `bm25.ts:92-123`）才走 `LIKE %q%`，该路径 `bm25` 恒 0、全靠近因排序；它**不是**每次零 FTS 命中
   都跑（零命中且 ftsOk=true 时不会回退）。
3. **落空只有空数组、语义不可分。** 空查询/零命中/有弱命中不敢认定当前都只能得到 `[]`；
   `window.ts:135-145` 仅有 `empty-relevance`/`oversized-card` 两种补取标记雏形。
4. **命中通道强弱不外露。** 精确别名/FTS 子串/LIKE 的差异只在 `searchCards` 内部，`RankedCard`
   （`types.ts:184`）仅含 `scoreParts{bm25,recency}` 与 `matchedTerms`。
5. **真源宽通道已在门面就绪，记忆库内缺锚点反查。** 门面有 `query/search/resolvePointer`
   （`src/api/index.ts`），可读 experiences 并解析 `raw_text`；读柄 `MemoryReadHandle`
   （`store.ts:46-54`）只有 getCard/getCardByEvent/search/listEffective/verify/close，缺按
   anchor_json 经历 id 反查卡的只读方法。
6. **补别名数据通道合法、写入口径不合运行期。** `mem_alias` CHECK 仅收 `source IN ('miss')`
   （`schema.ts:78`），决策 action 含 `add-alias`、`created_by` 唯一值 `'her'`（`types.ts:167/178`、
   `ledger.ts:25-32`）。但写操作都在仅 builder 可实例化的 `MemoryWriteHandle`，且 `transactionApply`
   强绑离线重建 `RevisionRecord`（operator 仅 'offline-cli'），不适合运行期轻写。
7. **R2 现状把弃权当错认。** `scoreDecoy()`（`decoy.ts:99-118`）以 `top1===goldCardId` 判 correct，
   top1 为 null 即计一次错误认定（:109）；加严后“正确弃权”需与“主动错认”分开度量。
8. **实时链路被 M6 物理隔离。** `tests/memory/schema.test.ts:295-365` 规定 api/event/source/adapters
   任何形态 import memory 判红，且 `package.json` dependencies 文本必须恰为 `{}`。实时接线归第二层。

## 2. 设计目标与非目标

### 2.1 目标（运行回路零人工，她是记忆与决策唯一主体）

- G-1 筛选员只做粗召回工具并加严，**正确性优先、宁空勿错**：弱相关不进窗口，证据不足明确弃权。
- G-2 落空（弃权/零命中）由她走真源宽通道自主回查、下钻原文确认，不新增人工环节。
- G-3 她确认目标后补一条 `source='miss'` 检索别名（只进检索别名、不改展示线索，概念基线 D.2），
  下次即可召回；她也查不到才算真没有，不编造。
- G-4 第一层**不拍任何连续常数、不做小样本伪标定**：交付确定性机制与可复现烟测，统计定值待真实数据。
- G-5 全部可在本仓离线 TDD 闭环，不触 M6、不依赖宿主、不连网络、不调模型。

### 2.2 非目标

- 不做实时对话接线/运行期写柄/M6 修订/宿主协议（第二层）；不引向量（K1）、不加路由器或查询分类器
  （K10）——布尔门是同层确定性策略，不是新召回层或模型分类。
- 不改真源三 jsonl 与 append-only；记忆库**不增表、不增列、不升 MEMORY_SCHEMA_VERSION**。
- 不改 700 字窗口参数/槽位（#43 延后），`window.ts` 零改动；连续证据分与阈值标定列演进项。
- 不设机器审核岗、不保留任何人工裁决入口。

## 3. 依据

- 本仓概念基线（`docs/memory-book-index-review.md`）：关键词仅粗召回、认定前下钻原文（§6 DRM）；
  检索分数不等于事实置信度（§8）；漏召回填只进 retrieval_aliases 不进 display_cues（D.2）；别名带来
  源/敏感级、约束词装配前过滤（D.6/D.9）；漏召只存哈希不存全文（D.7）；防过度工程、v1 最小闭环
  （D.10）。
- 业界旁证（摘要级，仅结构同构，不做实验背书）：本地确定性检索把“排序（raw BM25 随库漂移）”与
  “是否够格返回（稳定有界判定）”分离、精确负例硬拒、证据不足弃权、动态 top-k 不用弱尾凑数、噪声库
  盯精度与过召回（oh-my-experience retrieval-engine）；确定性 pre-LLM 置信门弃权（mind-mem）；
  证据缺口驱动迭代检索、阈值须按足量数据标定且近域近邻误判是残余难点（EviMem/IRIS、DEV 实测）。
  **这些资料同时警示：阈值在小样本上不可标定——直接支撑本版放弃第一层连续 cutoff、改布尔门。**

## 4. 总体架构与两层划分

```text
当前话题/查询
   │
   ▼
searchCardsExplained（bm25 同层召回；候选/排序/分值与旧 searchCards 零漂移，额外标注命中通道）
   │  以 limit=undefined 取完整排序全集（D9），过滤后再按调用方 limit 截断
   ▼
布尔通道门 evaluateGate（确定性策略 GatePolicy，无模型、无连续 cutoff、时钟无关）
   ├── 命中任一强通道（exact-alias；或满足词边界的 FTS 子串）→ status='hit'，accepted 装窗
   ├── 仅有弱通道（LIKE-only / ASCII 非边界子串）→ status='abstain'（带 rejected 原因），不装窗
   └── 空查询 / 零词面命中 → status='no-match'，不装窗
                              │  abstain / no-match 均触发她回查
                              ▼
        她自主回查（第二层接门面 query/search/resolvePointer；第一层备记忆库 anchor 反查）
            ├── 确认目标卡 → add-alias('miss', created_by='her')，同步别名快照，下次可召回
            └── 查无 → 真没有，本轮不认定、不编造，按 miss 纪律留观测
```

- **第一层（本提案）**：可解释检索重构（零漂移）、布尔门、类型增量、读柄 anchor 反查、无环别名低层
  写（仅离线/写柄可达）、harness 四态度量与只读烟测、文档。
- **第二层（只登记不实现）**：M6 受控修订与投毒、宿主工具注册、运行期只读+仅 add-alias 窄柄，与
  #42/#43 共用运行期访问/写 memory-index 的架构门，合并设计避免两次改门。

## 5. 文件级详细改动（第一层）

> 统一纪律：纯函数/低层收库柄、不自开连接、模块顶层仅字面量常量、时钟与随机源注入、零网络零依赖。

### 5.1 `src/memory/bm25.ts`：新增可解释检索，旧函数薄封装（行为零漂移）

- 新增命中通道联合类型 `type MatchKind = 'exact-alias' | 'fts-substring' | 'like-fallback'`（S1）与
  低层 `searchCardsExplained(db, query, tuning?)`：在现有三档召回上为每张卡额外记录 `matchKinds`
  （同卡多通道取并集，最强通道用于门判定）；as-of 过滤、`scoreParts`、`matchedTerms`、排序 tie-break
  与 limit 截断全部沿用现有逻辑。
- 现有 `searchCards` 改为其薄封装，剥离 explain 字段、返回仍为 `RankedCard[]`，候选集合/顺序/分值
  逐字节不变；`SearchQuery`、`SearchTuning` 零改动。
- 零漂移回归除覆盖常规路径外，**专门锁定 ftsOk 分支（S4）**：构造“查询<3 码点走 LIKE”与“FTS
  MATCH 抛错回退 LIKE”两路快照，并断言“FTS 零命中但 ftsOk=true 时不追加 LIKE 候选”。

### 5.2 新增 `src/memory/gate.ts`：确定性布尔通道门（本任务核心，采纳 S2，闭合 D1/D2/D3/D9）

不引入连续证据分与 cutoff，因此不存在会退化的 coverage 公式，也无需在小样本上标定常数。门策略为
具名常量 `GATE_POLICY`（观测策略、可经评审演进，但不是逐请求入参、不进冻结的 SearchQuery）。

1. 对**完整排序全集**（检索时 `limit=undefined`，D9）逐卡判定，强通道命中即 accept：
   - `exact-alias`：**恒过**。判定口径是**规范化后严格等值**（`normalizeQuery(query) === termNorm`，
     非子串、非前缀）；任意长度查询、sensitive=1 别名只走此路，故精确点名硬保证可达（D2/R-1）。
   - `fts-substring`：已经 `matchesSubstring` 复核；再按下文 `hasAsciiWordBoundary` 做词边界判定，
     CJK 查询边界 N/A 视为通过。
2. 弱通道按构造**确定性拒绝**，与任何数值阈值无关（D3）：仅 `like-fallback` 命中（bm25=0 的 `%q%`
   宽松子串）、或 ASCII 非边界 FTS 子串，不进 accepted；被拒卡保留在 `rejected` 并附原因码，供可解释
   与漏召统计，不静默丢弃。
3. 结果状态：规范化空查询 → `no-match/empty-query`；有查询零词面候选 → `no-match/zero-lexical-hit`；
   有候选但全落弱通道/非边界 → `abstain/all-rejected`；至少一卡过强通道 → `hit`，accepted 保持原
   score 排序后再按调用方 limit 截断（动态 top-k，不用弱尾凑数）。
4. 结果类型（新增，不改任何既有类型；预留可选 `evidence?` 使未来加连续分不破 API，第一层不填）：
   ```ts
   type MatchKind = 'exact-alias' | 'fts-substring' | 'like-fallback';
   type GatedStatus = 'hit' | 'abstain' | 'no-match';
   interface GatedRankedCard extends RankedCard {
     matchKinds: MatchKind[];
     gateReasons: string[];
     evidence?: number;   // 演进项占位，第一层恒 undefined
   }
   interface GatedSearchOutcome {
     status: GatedStatus;
     accepted: GatedRankedCard[];
     rejected: GatedRankedCard[];
     reason?: 'empty-query' | 'zero-lexical-hit' | 'all-rejected';
     serialMap: SerialMap;   // 复用 serial.ts 对 accepted 建 1..n 私有序号
   }
   ```
5. 纯函数、无 I/O、无 `Date.now()`；门判定实现为“接收候选数组的纯函数”，便于单测与注入。
6. **演进项登记（本期不实现）**：连续有界证据分 + cutoff + 网格标定，待满足 §5.7 标定协议的足量数据
   后再立专项；届时布尔门作为其保守特例/安全兜底，`evidence?` 字段即用于承载该连续分。

#### 5.2.1 词边界纯函数的精确口径（闭合 R-2）

所有判定都在 `normalizeQuery` 之后的小写串上进行（NFKC→ASCII 小写、不动中文、空白折叠，见
`bm25.ts:38-40`）。**规范化一致性（N3）**：查询 q 与被查文本 haystack 必须先各自过同一个
`normalizeQuery` 再比较——haystack（cue_text 由规范化后的 cues+aliases 拼成）在门函数入口统一再
normalize 一次，保证词边界判定与 `matchesSubstring` 子串复核处于同一规范化形；补大小写/NFKC/全角
字符的一致性测试（如全角 `ＧＩＴ`、混大小写 `Git` 与小写 haystack 的判定一致）。新增纯函数
`hasAsciiWordBoundary(qNorm, haystackNorm): boolean`（入参约定均为已规范化串）：

1. **token 字符类**：`const TOKEN = /[a-z0-9_]/`（明确小写字母、数字、下划线算 token 内字符）。
2. **查询含任意非 ASCII 字符（中文/CJK 等）→ 直接返回 true（边界 N/A，不惩罚中文）**。
3. **纯 ASCII 查询**：用 `indexOf` 枚举 qNorm 在 haystackNorm 中的每一次出现，起点 `i`、终点
   `j=i+qNorm.length`；某次出现满足以下即判定边界成立——前邻字符不存在（`i===0`）或
   `!TOKEN.test(haystack[i-1])`，**且**后邻字符不存在（`j===len`）或 `!TOKEN.test(haystack[j])`。
4. **非 ASCII 邻居天然是边界**：中文等字符不匹配 TOKEN，故“用git提交”中的 `git` 前后邻均为中文 →
   边界成立、通过。
5. **多次出现取任一**：q 在文本中出现多处，只要一处边界成立即过。
6. **exact-alias 豁免**：严格等值命中不经过本函数，恒过。

**已知残余（登记并加反例测试，不在第一层强行收口）**：标点/连字符不是 TOKEN 字符，故 ASCII 边界
挡不住“标点分隔的后缀”，如 `v1⊂v1.2`、`cat⊂cat.log`、`git⊂git-flow`、`git⊂a-git-b` 都会判边界
成立而通过——它们语义不同却过门。第一层立场是**宁空勿错但拒绝过度工程**：引入标点/连字符分词词典
既会误伤又需维护，故将其登记为已知残余、列入反例表与未来连续分/真分词器演进项，不声称布尔门零
假阳。表驱动反例（期望如下，全部进 gate.test.ts）：

| 查询 q | 线索/别名文本 | 边界判定 | 说明 |
|---|---|---|---|
| `git` | `github` | 拒 | 后邻 `h` 属 TOKEN，非边界 |
| `git` | `用git提交` | 过 | 前后邻为中文（非 TOKEN），R-2 混排 |
| `github` | `用github提交` | 过 | 同上，中文邻居为边界 |
| `git` | `git hub` | 过 | 前邻串首、后邻空格，边界 |
| `git` | `a-git-b` | 过（残余） | `-` 非 TOKEN，登记已知残余 |
| `v1` | `v1.2` | 过（残余） | `.` 非 TOKEN，登记已知残余 |
| `cat` | `cat.log` | 过（残余） | 同上 |
| 任意 | 与某 active 别名 normalize 后严格相等 | 过 | exact-alias 豁免，含 sensitive=1 |

### 5.3 `src/memory/types.ts`：纯增量类型

仅新增 5.2 的门策略/结果类型（联合类型而非 string[]，S1）；`SearchQuery`、`RankedCard`、`WindowSpec`、
`AssembledWindow`、`MemoryCard`、`AliasRow`、`DecisionRecord` 等冻结类型一律不改。

### 5.4 `src/memory/store.ts`：读柄加只读反查；写柄仅加单向窄写委托（运行期读柄不扩权）

- 读柄新增 `getCardsByAnchor(experienceId: string): MemoryCard[]`：仅返回 active 且 `anchor_json`
  数组含该 ULID 的卡；入参先经 `isUlid` 校验；实现优先“逐条 `JSON.parse` 纯计算 + 参数化查询”，
  不拼 SQL、不依赖可能缺失的 SQL JSON 扩展；只读、确定性、不产生文件。
- `MemoryReadHandle` 不增加任何写方法；`openMemoryRead` 维持 `readOnly:true`（`store.ts:429`），底层
  对写操作天然拒绝。写柄经单向 import 委托新模块的别名窄写（见 5.5），单例纪律不变。

### 5.5 新增无环低层 `src/memory/alias-write.ts` + 写柄委托（闭合 D5/D6/D7/D8，细化 R-3/R-4）

- **无环依赖（D8/N1，采纳终审修法 a：抽共享低层，杜绝三环/二环）**。终审指出：computeContentHash
  现位于 builder.ts:98-105 而 builder:41-50 import store，syncFts/cueTextOf 位于 store，若 alias-write
  为复用它们而 import builder 或 store，就会形成 `store→alias-write→builder→store` 三环或
  `store↔alias-write` 二环，与“无环”矛盾。故先做**纯移动、不改逻辑**的低层抽取：
  - 新建 `src/memory/content-hash.ts`（只 import `node:crypto` + types）：把 builder 的 `sha256Hex`、
    `deriveCardId`、`computeContentHash` **原样搬入**（公式逐字不变），builder 改为从该模块 import
    （需要对外兼容处 re-export，保证既有 import 路径与测试不破坏）。
  - 新建 `src/memory/fts.ts`（只 import `node:sqlite` 类型 + types + 行映射纯函数）：把 store 的
    `cueTextOf`、`syncFts` 及其依赖的别名行映射 **原样搬入**，store/builder 改从该模块 import。
  - `alias-write.ts` 因此只需 import `node:crypto`/`node:sqlite` 类型、`types.ts`/`schema` 常量与上述
    两个**无环**模块，**不 import store、不 import builder**；store 写柄单向 import alias-write。
    依赖方向为 `store/builder/alias-write → {content-hash, fts}`（后者不再反向依赖前者），DAG 无环。
  - **零漂移回归硬要求**：抽取属移动非改写，落地后现有 builder/store/bm25 全部测试零改动全绿，并对
    contentHash 取值、FTS cue_text 文本、card_id 派生做前后快照全等；再以 grep/import 图检查自证
    “content-hash.ts/fts.ts/alias-write.ts 均不 import store、builder、bm25（及任何传递 import store
    的模块）”，把该断言沉淀为静态测试。
  - **规范化归属（N5，修法 a，对齐 miss.ts）**：alias-write **不 import bm25**、不自行 normalize，
    与 `miss.ts` 一样只接收**已规范化的 termNorm** 并校验非空；规范化在 store 写柄薄封装委托前用
    bm25.normalizeQuery 完成（store→bm25 为既有依赖方向，不新增环）。由此避开
    `alias-write→bm25→store→alias-write` 环；不新增 normalize.ts、不搬动 normalizeQuery。
- `buildMissAlias(input)` 纯校验/构造：
  - termNorm 经同一 `normalizeQuery` 规范化且非空；目标卡存在且 active；`source` 恒 `'miss'`；
  - `sensitive` 仅收 0|1 且由入参显式给出（第一层不自动猜隐私；敏感即不进 FTS、仅精确可达）；
  - 只产出别名、绝不产生 display_cues 变更（D.2）。
- **别名上限的定性与双层守卫（D7/R-4）**：
  - **为什么是 5**：`MAX_MISS_ALIASES_PER_CARD=5` 定性为**结构工程护栏**（防别名表与 FTS 无界膨胀、
    防单卡线索污染），**不是**从个人数据观测出的统计值；漏召回填是低频、需她下钻确认的动作，5 条/卡
    为 v1 已采用的保守初值，具名常量 + 注释，后续随真实使用经评审调整，不进 DB CHECK（schema 不动）。
  - **权威守卫点 + 防御纵深**：低层 `applyMissAlias` 内做**权威强制**（它是唯一窄写口，直接调低层
    也不能超限）；`buildMissAlias` 应用层先校验给友好错误。名额只数 `status='active'` 别名
    （tombstone 不占额）。
  - **溢出确定性拒绝且可观测、不静默**：第 6 个**不同** termNorm 返回显式结果
    `{ok:false, reason:'alias-cap-exceeded'}`，不写库、不淘汰旧别名；调用方据此仍可落一条 miss 观测
    （保留 term_hash 线索），harness 对该拒绝原因单独计数。表驱动：5 个 active 后第 6 个不同词拒、
    重复加已有 active 词幂等跳过且不占额、含 tombstone 时名额按 active 实算。
- `applyMissAlias(db, alias, decision)` 低层事务（收库柄、不自开连接）：
  - **INSERT-or-guard（D5）**：先 SELECT 同 `(term_norm,card_id)`——已 active 则整笔幂等跳过、不写
    （aliasesJson/contentHash 零 churn）；用专用 INSERT，**不复用会整行覆盖的 `writeAliases`
    upsert**；禁止改 sensitive（杜绝 1→0 泄入 FTS）、不重置 hit_count/last_hit_ms；变异反证覆盖
    clobber/降级/统计重置，必拒。
  - **同源快照同步（D6/R-3，方案 a，写面严格收窄）**：单事务内 ①INSERT mem_alias ②UPDATE mem_card
    **且仅允许改 `aliases_json` 与 `content_hash` 两列**——明确禁碰 `display_cues_json`、
    `discriminator`、`anchor_json`、`event_id`、`channel`、`weight`、`entity_hint_json`、
    `occurred_ms/ended_ms/valid_ms/invalid_ms/created_ms/expired_ms`、`status`、`hit_count`、
    `last_hit_ms`、`schema_version`（以 `schema.ts:28-52` 列清单为准，写语句只出现两个赋值位）；
    ③调共享模块 `fts.syncFts(该卡)`（内部 cueTextOf 仅收 active 且 sensitive=0，敏感词不进 FTS）。
  - **哈希逐字一致 + 确定性排序（R-3/N1）**：合入别名对象 `{term,source:'miss',sensitive}` 后，数组按
    `termNorm` 升序（次按 source、sensitive 兜底）确定性排序再 `JSON.stringify`，contentHash 调共享
    无环模块 content-hash.ts 的 `computeContentHash(anchorJson, displayCuesJson, aliasesJson,
    discriminator)`——该函数由 builder.ts:98-105 **原样搬入、公式逐字不变**
    （`sha256Hex(JSON.stringify([anchorJson, displayCuesJson, aliasesJson, discriminator]))`），
    builder 与 alias-write 共用同一实现，**不复制第二份公式**，杜绝哈希漂移。
  - **重建幂等链路（请评审在终态树亲验）**：builder 重建以 `...old` 展开卡、用 `old.aliasesJson` 重算
    contentHash（`builder.ts:312-317`），并把 existing.mem_alias 按存活卡过滤后经 `writeAliases`
    回写（:335/:385）。同步后 old.aliasesJson 已含 miss 别名，重算出同一 contentHash、mem_alias 同步
    保留，两源一致无 divergence、`decoy.cardTermSet`（读 aliasesJson，`decoy.ts:43`）不漏计。
  - **事务与账本**：mem_alias insert + mem_card update + syncFts 同一事务，失败回滚零半状态（变异
    反证）；DB 提交后再 `appendDecision`，记录 `action='add-alias'`、`created_by='her'`、
    `model_tag='rules-v1'`（规则版本，非模型/非人工）、reason 用受控码不复制原文。
- 不新增表/列（复用 mem_alias/decisions）；不新增 CLI（D44-5 评审已认可，运行期入口归第二层）。

### 5.6 `src/memory/window.ts`：零改动 + 编排约定（S3）

gate 拦空后向 `assembleWindow` 传空 accepted，即自然得 `needRefetch=true/'empty-relevance'`（已有
空候选测试锁定）；更细的 abstain/no-match 原因留在 `GatedSearchOutcome.reason` 由编排层消费，不往
冻结的 `AssembledWindow.refetchReason` 塞新值。**编排 nuance（S3）**：仅当 recency/identity 槽也无卡
时才出现 empty-relevance（`window.ts:135-136`），编排层须同时读 gate outcome 与窗口结果决定是否
回查，不能只看窗口标记。`serial.ts` 直接复用、零改动。

### 5.7 离线 harness：四态度量 + 只读敏感性烟测 + 未来标定协议（闭合 D4/D10/D11/D12）

- **新增弃权/噪声探针（夹具仍只含 id 与标注、拒收正文）**：不可答问句（库中无目标，期望弃权/空，
  不硬凑）与噪声库场景（一真卡混多张宽泛诱饵，期望真卡命中、诱饵弃权）；扩 `fixtures.ts` 白名单与
  版本校验，不改生产 schema。
- **每条探针显式暴露 `hasGold` 并构成可审计 2×2（R-5）**：decoy/gold 探针 `goldCardId` 存在则
  hasGold=true；不可答/噪声诱饵探针无目标则 hasGold=false。按 hasGold × 是否主动认定（status='hit'
  即认定）归四态：
  - 有金标题：`correct-commit`（返回且 top1=金标）、`wrong-commit`（返回但 top1≠金标）、
    `wrong-abstain`（弃权，计召回损失、不计错认，堵死靠弃权刷 R2）；
  - 无金标题：`correct-abstain`（正确弃权/空）、`wrong-commit`（无中生有返回卡，计错认）。
- **各率分母钉死（R-5/N2，零分母显式记 N/A 而非 0，防造假；wrong-commit 按 hasGold 拆分防双计）**。
  wrong-commit 既可能发生在有金标题（返回错卡 wc_G）也可能发生在无金标题（无中生有 wc_NG），令
  `wc = wc_G + wc_NG`。其余计数 cc（有金标题认对）、wa（有金标题弃权）、ca（无金标题正确弃权）：
  - 有金标题数 `G = cc + wc_G + wa`；无金标题数 `NG = ca + wc_NG`；**恒等式 `N = G + NG`**
    （= cc+wc_G+wa+ca+wc_NG = cc+wc+ca+wa）；表驱动测试必须断言 G+NG=N，杜绝 wc 双计；
  - 主动认定数 `committed = cc + wc`；
  - `falseCommitRate = committed>0 ? wc/committed : N/A`（主动认定中的错认比例）；
  - 门槛后召回 `recallAfterGate = G>0 ? cc/G : N/A`；弃权漏召回率 `wrongAbstainRate = G>0 ? wa/G : N/A`；
  - `correctRejectRate = NG>0 ? ca/NG : N/A`（无金标题上的正确拒绝比例）；
  - `abstainRate = N>0 ? (ca+wa)/N : N/A`（总弃权比例）。
  反例（须进测试）：1 条有金标题返回错卡(wc_G=1) + 1 条无金标题返回卡(wc_NG=1)，则 G=1、NG=1、N=2
  （旧错误公式会得 G=NG=2、G+NG=4≠2）。
- **高危双硬约束消歧（D10/R-5，不是“所有 wrong-commit=0”）**：未来足量数据上的验收线明确为两条
  并列硬约束——① 高危五类探针 `wrong-commit 数 = 0`（绝对硬，弃权不计高危、返回错卡才计）；
  ② 总体 `falseCommitRate ≤ 0.05`（硬目标）；在两者满足下最大化 recallAfterGate 并报 abstainRate。
  第一层小样本只烟测、不报达标（见下）。
- **旧 r2 逐字并列并标注口径差（D11）**：旧 `scoreDecoy/r2` 把 top1=null（含正确弃权）一律计错，新
  falseCommitRate 不计弃权；两版同列报告、不无声替换指标。
- **第一层只做机制烟测、不做统计达标背书（D4）**：现有合成夹具仅 gold-l0=2/gold-l1=2/holdout=1/
  decoy=1（已实测），粒度不足以支撑 0.05/0.85 定值，故本期只验证布尔门在这些样本上的**功能行为
  正确性与确定性**，报告各态计数与敏感性，**不得写“R1≥0.85/R2≤0.05 已达标”**。
- **烟测全程只读（D12）**：重放只调检索/门纯函数与 `--out` 独立临时库，绝不调 applyMissAlias、
  不污染索引；补别名联动用独立临时库做功能测试，与烟测隔离。
- **未来标定协议（登记，本期不执行）**：连续证据分立项前须先备足量合成/真实标注 corpus，按时间或
  id 划分 train/holdout（禁止同集标定与验收），公布样本量下限与可复现种子；在 falseCommitRate≤0.05、
  高危 wrong-commit=0 硬约束下最大化门槛后 R1 并报 abstainRate，阈值外审定值并记 revision。

## 6. 隐私与安全核对

- 五层默认拒绝语义延续：sensitive=1 别名不进 FTS、仅 exact-alias 精确路径可达且被门恒放行；宽召回
  找不出、她精确点名仍可找到，加严不削弱该语义（D2 正反例测试锁定）。
- miss/alias 不存原始查询：miss 六字段白名单与 term_hash 不动；新别名只存规范化词、source 恒 'miss'、
  带敏感级，符合 D.2/D.7/D.9。
- 第一层无运行期写柄：applyMissAlias 仅离线/写柄可达，实时链路只读、M6 零改动，杜绝运行期越权。
- 零网络、零模型、零新依赖，`package.json` dependencies 保持文本恰为 `{}`。

## 7. 冻结面 / 红线核对表

| 冻结/红线 | 第一层处理 |
|---|---|
| SearchQuery 形状（G1） | 零改动；门策略为独立具名常量，不逐请求传参 |
| BM25 评分排序（G12–G14） | searchCards 薄封装，候选/名次/分值零漂移，旧 14 个 bm25 用例零改动全绿 + ftsOk 两路快照 |
| 单层召回 K10、无向量 K1 | 布尔门为同层确定性策略，非路由器/分类器/向量 |
| M6 门 + dependencies:{} | 改动全在 src/memory 与 tests/scripts，不 import 门面/实时目录，M6 测试零改动 |
| 记忆库 schema | 不增表/列、不升版本；复用 mem_alias/decisions |
| 时钟纪律 | 纯函数、atMs/rng 注入，无 Date.now/Math.random |
| 真源 append-only | 只读，不碰三 jsonl；anchor 反查仅读 memory-index |
| 窗口 700 字/槽位（#43） | window.ts 零改动 |
| 写柄单例/仅 builder | 不新增运行期写柄；窄写仅挂既有写柄，新模块无环 |
| git 纪律 | 不 add/commit/push；工作树增量，可整包回滚 |

## 8. 测试与验收（TDD 先红后绿；关键项亲跑 + 变异反证）

1. 新增 `tests/memory/gate.test.ts`：强/弱通道分流、exact 恒过、CJK 边界 N/A、ASCII 非边界拒绝
   （git/github 反例）、LIKE-only 必弃权、空查询/零命中/全拒三态、全集过滤后再 limit 截断、动态
   top-k 不凑数、敏感精确可达、确定性与深冻结。
2. bm25 零漂移：现有 14 用例零改动通过 + explained/legacy 候选集合·名次·分值快照全等，含 S4 短查询
   与 FTS 抛错两路、及“ftsOk=true 零命中不回退 LIKE”反例。
3. `store.test.ts` 增 getCardsByAnchor（ULID 非法、active 过滤、包含判定、只读不产生文件）；新增
   `alias-write.test.ts`：上限 5 溢出拒绝、幂等跳过、INSERT-or-guard 不 clobber/不降级 sensitive/不
   重置 hit_count、aliasesJson 同源同步与 contentHash 重算、敏感不进 FTS、只补别名不碰 cue、决策
   形状、事务回滚零半状态、重建后两源一致。
   - **N1+N5 无环与零漂移自证**：content-hash.ts/fts.ts 抽取前后对 contentHash 取值、card_id、FTS
     cue_text 做快照全等；builder/store 既有测试零改动全绿；新增静态测试断言 content-hash.ts、
     fts.ts、alias-write.ts 三者均**不 import store、builder、bm25 及任何传递依赖 store 的模块**
     （grep import 图，禁依赖集含 bm25 以闭合 N5），人为反向 import 即红；另测 alias-write 收到未
     规范化/空 termNorm 的行为契约（只认已规范化非空入参，规范化由写柄层负责）。
4. harness：弃权/噪声探针单测、四态归类与旧 r2 并列对照、烟测只读且同种子逐字节一致。
   - **N2 分母自证**：混排 hasGold 的 2×2 表驱动断言 `G+NG=N`、wc_G/wc_NG 不双计、各率分母正确、
     零分母记 N/A；**N3** 补全角/大小写规范化下 q 与 haystack 边界判定一致性用例。
5. 变异反证矩阵（注入必红、逐字节还原回绿、留日志）：
   - 门关闭开关退化为旧“命中即返回”（证明可关、与现状连续）；门全开时弱通道全弃权；
   - 强造 LIKE-only 弱命中 → 必入 rejected；sensitive=1 别名尝试走 FTS → 必红，精确点名 → 可达回绿；
   - ASCII 关闭边界判定 → git/github 误命中被测试捕获；
   - applyMissAlias 尝试写 display_cues / source≠'miss' / clobber 既有别名 / sensitive 1→0 / 超第 6
   条别名 → 一律拒收；运行期读柄出现写方法 → 类型/静态检查红；
   - 烟测中出现任何写库调用 → 红（D12 只读自证）。
6. 全量 `npm run verify` 以拆除终态为基线全绿（当前 687 注册用例 + 本期新增；Linux 0 失败 0 跳过）。
   **本期不报告 R1/R2 统计达标，只报告功能正确性、四态计数与变异反证**；统计定值按 §5.7 协议另立。

## 9. 复审点与第二轮意见的落文对照（请在终态核验包上复核）

| 复审点 | 第二轮结论 | v2.1 落文位置与补充精度 |
|---|---|---|
| R-1 布尔门默认、连续分延后 | 方向认可 | §5.2；钉死 exact 为规范化后**严格等值**、显式覆盖 sensitive 精确点名、保留 matchKinds/rejected 原因、预留可选 `evidence?` 不破未来 API、标定协议见 §5.7 |
| R-2 ASCII 词边界与中英混排 | 须补精度 | §5.2.1 给出 token 类 `[a-z0-9_]`、前后邻边界判据、非 ASCII 邻居即边界、多次出现任一、exact 豁免；标点分隔后缀（v1.2/cat.log/git-flow）登记为已知残余并附 8 行反例表 |
| R-3 别名快照同步方案 a | 方向认可，源依赖待验 | §5.5；写面只改 `aliases_json`+`content_hash` 两列并列出全部禁碰列、contentHash 逐字复用 builder 公式、按 termNorm 确定性排序、单事务零半状态、幂等零 churn、重建链路逐行锚点请在终态树亲验 |
| R-4 每卡上限 5、溢出拒绝 | 须补精度 | §5.5；5 定性为结构护栏非观测值、低层权威守卫 + 应用层纵深、只数 active、溢出返回 `alias-cap-exceeded` 可观测且仍可落 miss 观测、表驱动用例 |
| R-5 四态命名与归类 | 结构认可，分母/高危须消歧 | §5.7；每探针暴露 hasGold、2×2 归类、四个比率分母与零分母 N/A、高危 wrong-commit=0 与总体 falseCommitRate≤0.05 双硬约束、旧 r2 口径差标注 |

第三轮终审在终态树上撤回 F1/F2/F3、独立 verify 确认 687/0/0，并提出 N1–N4；v2.2 已按下表闭合，请
据此给**明确 PASS**：

| 终审项 | v2.2 落文 |
|---|---|
| N1 无环（必修） | §5.5 抽 content-hash.ts、fts.ts 两个无环共享低层（函数只搬不改+零漂移回归+import 图静态断言），alias-write 不 import store/builder，DAG 无环；R-3 哈希改调共享 content-hash.ts（公式逐字不变） |
| N2 分母双计（必修） | §5.7 拆 wc_G/wc_NG，G=cc+wc_G+wa、NG=ca+wc_NG、恒等 N=G+NG，附反例与表驱动断言 |
| N3 规范化一致性（建议） | §5.2.1 q 与 haystack 同过 normalizeQuery，补全角/大小写一致性测试 |
| N4 lock 陈旧（建议） | 见 §0.4；不改设计、不在 #44 改 tracked lock，复现用 `npm install` 或复用 node_modules，刷新 lock 列闭环后独立收尾 |

请评审方在解压后的终态树上：(1) 复跑 §0.3 命令对账 F1/F2/F3 与 687 基线；(2) 亲验 R-3 指向的终态
builder（`312-317/335/385-386`）同源与哈希处理，并预审 v2.2 的无环抽取边界是否认可；(3) 确认 N1/N2
修法与 N3/N4 处置后给明确 PASS。

## 10. 第二层衔接点（仅登记，本期不实现；与 #42/#43 共门）

1. M6 受控修订（adapter/新装配模块依赖 memory，src/api 内核仍不直接依赖），补六种 import 投毒自证
   与同级评审，评估 dependencies 保持 `{}` 的接入方式。
2. 运行期窄柄：只读 + 仅 applyMissAlias/recordMiss 的受控写路径，与 #42 worker 运行期写诉求合并。
3. 宿主 cordis/dsh-llm 工具注册：检索（带 gate outcome）/anchor 反查/resolvePointer 下钻/补别名，
   序号复用 serial.ts，失败“多取一次”不编造。
4. 隐私约束表与运行期 sensitive 判定对接（D.6 装配前强制过滤）。

## 11. 施工步骤与回滚（复审通过后）

1. 先写测试与探针（红）→ 实现 explained/布尔门/反查/无环别名写（绿）→ 只读烟测与变异反证 → 文档
   定稿（plan §4.4/§4.8/§4.9 以“2026-11-12 演进块”登记，不改写历史裁决原文）。
2. 增量为主：先做 N1 的无环抽取（新增 content-hash.ts、fts.ts，纯移动 builder/store 现有函数并保零
   漂移），再新增 gate.ts、alias-write.ts 与对应测试；bm25/store/audit 为受控增量，不删公开行为。
3. 不 git add/commit/stash/push、真实根零写。回滚 = 删新增文件并还原薄封装/读柄/harness 增量；
   schema 与真源未改结构，无需数据处理。

## 12. 附录：拆除终态代码索引（本版行号均经当前工作树实测）

- 检索：`src/memory/bm25.ts`（LAMBDA:26、HALF_LIFE:29、searchCards:63、精确:85-90、FTS:92-112、
  matchesSubstring:104、LIKE:113-123、评分排序:146-153）
- 窗口：`src/memory/window.ts`（assembleWindow:47、空槽判定:135-145）
- 漏召：`src/memory/miss.ts`（六字段白名单:20-27、insertMissRow:85）
- 库柄：`src/memory/store.ts`（读柄:46-54、写柄:57-69、cueTextOf:130、writeAliases:205-225、
  syncFts:228-242、ReadHandle:258、getCardByEvent:281、readOnly 打开:425-433）
- 表结构：`src/memory/schema.ts`（source CHECK('miss'):78、FTS trigram:59-64、schema v1:137）
- 类型/台账：`types.ts`（AliasRow:65-78、DecisionRecord:162-179、RankedCard:184、SearchQuery:200）、
  `ledger.ts`（ACTION:25-31、CREATORS=['her']:32、appendDecision:158）
- 重建：`builder.ts`（读全量别名:166、contentHash 用 old.aliasesJson:312-317、别名过滤:335、
  writeAliases:385、syncFts:386）
- 序号：`serial.ts`；离线审计：`audit/{metrics,decoy,gold,fixtures}.ts`、`scripts/run-memory-audit.ts`
  （openMemoryRead:402、search 注入:412、replay k=3/1/5:419-421、scoreDecoy:425）
- 隔离门：`tests/memory/schema.test.ts:295-365`；概念基线：`docs/memory-book-index-review.md`
- 夹具实测规模：tests/fixtures/memory 下 gold-l0=2、gold-l1=2、holdout=1、decoy=1 条
- 本期拟新增/抽取（复审 PASS 后才建）：`gate.ts`（布尔门纯函数）、`alias-write.ts`（无环 miss 别名
  窄写）、`content-hash.ts`（从 builder 原样搬入 sha256Hex/deriveCardId/computeContentHash）、
  `fts.ts`（从 store 原样搬入 cueTextOf/syncFts）；后两者为 N1 无环抽取，落地保零漂移。

## 13. 第一层施工完成记录与证据（2026-11-12，TDD 落地）

> 外部第四轮「明确 PASS、准予 TDD」后按 §11 顺序施工，N5 已在 alias-write 步骤闭合。以下为工作树实测事实。

### 13.1 落地模块（均在 `src/memory/`，untracked 增量，未改生产 schema/真源/M6）

| 文件 | 性质 | 关键口径 |
|---|---|---|
| `content-hash.ts` | N1 抽取（纯移动） | `sha256Hex`/`deriveCardId`/`computeContentHash` 逐字搬入，仅依赖 node:crypto |
| `fts.ts` | N1 抽取（纯移动） | `aliasFromRow`/`cueTextOf`/`syncFts` 逐字搬入，仅依赖 node:sqlite 类型 + AliasRow |
| `gate.ts` | 新增无环纯函数 | 布尔通道门；只 import projection/types + serial + types；exact 恒过、fts 过 ASCII 词边界、LIKE-only 构造性拒绝 |
| `alias-write.ts` | 新增无环窄写 | `buildMissAlias`/`applyMissAlias`；只 import node:sqlite 类型 + core/errors + content-hash + fts + types；**不 import store/builder/bm25**（N5） |
| `types.ts` | 纯增量 | MatchKind/ExplainedRankedCard/GatedStatus/GateReasonCode/GatedRankedCard/GatedSearchOutcome，冻结类型零改动 |
| `bm25.ts` | 受控增量 | `searchCardsExplained` 三通道标记 + `searchCards` 零漂移薄封装 |
| `store.ts` | 受控增量 | 读柄 `getCardsByAnchor`（只读、无写权）；写柄 `addMissAlias`（写柄内 normalizeQuery 后委托） |
| `audit/four-state.ts` | 新增无环纯函数 | 四态归类与各率；wc 拆 wc_G/wc_NG、G+NG=N fail-loud 自检；旧 r2（**错误率**）并列 |
| `audit/fixtures.ts` | 增量 | 新增 `abstain` 层白名单校验 + 独立 `loadAbstainFixtures`（`loadFixtures` 四文件契约零变化） |

### 13.2 测试与验收结果（亲跑，N6 修复后）

- 全量 `npm run verify` 退出码 0：**741 tests / 741 pass / 0 fail / 0 skip（Linux）**（拆除基线 687 +
  本期 54），两个 tsconfig 零错误；静态注册计数同为 741。
  win32 对应 **740 pass / 1 skip**（跳过为仅 POSIX 的 M9 chmod 用例，如实标注、不折算成通过）。
- 本期新增用例：gate 15、layer-imports 2、alias-write 13、bm25 explained +3、four-state 14、gate-smoke 6、
  builder 端到端 +1。
- **N2 分母自证**：`four-state.test.ts` 表驱动断言 G+NG=N、wc_G/wc_NG 不双计、五率分母正确、零分母 N/A；
  含提案反例（wc_G=1+wc_NG=1 → G=1/NG=1/N=2）。
- **旧 r2 并列（N6 修复后属实）**：`legacyR2` 为**错误率** `(wc_G+wa)/G`，与 `decoy.ts`/`metrics.ts` 的 r2
  同向；`falseCommitRate` 不计弃权。判别例（非对称 cc3/wa1 → 0.25；全错 cc0/wcG2/wa2 → 1.0）锁定方向，
  防止误成准确率（对称例 0.5 无法判别，故以判别例为准）。
- **N5 无环自证**：`layer-imports.test.ts` 对 `content-hash.ts`/`fts.ts`/`gate.ts`/`alias-write.ts` 断言
  不 import 能到达 store 的传递闭包（禁依赖集含 store/builder/bm25），反向 import 即红。
- **D12 只读烟测**：`gate-smoke.test.ts` 门后裁决前后库文件 sha256 逐字节一致；同输入两次 outcome 逐字节
  一致；静态自证查证区无别名写/写库调用（建库事务仅出现一次）。
- **§8.6 端到端**：`builder.test.ts` 追加「addMissAlias → rebuild」用例，断言只改两列、cue 不变、
  contentHash 可重算、决策 +1、重建 aliases=2 且 shadowDiff 全 0、两源一致、真源三 jsonl 哈希不变。
- **变异反证矩阵 12 项全 PASS**（脚本 `scripts/verify-mutation-44.sh`，日志
  `mutation-proof-44.log`）：门退化/门全拒/关 ASCII 边界/敏感词进 FTS/clobber 既有别名/sensitive 降级/
  上限失效/source 非 miss/写错列碰 display_cues/读柄加写方法（typecheck 红）/烟测写库（自证红）/
  旧 r2 口径反转（N6 回归）；
  每项注入后必红、以备份整体回拷还原、sha256 逐字校验一致、还原后回绿。

### 13.3 零写与红线自证

- 真实根 `/home/user/.dsh/fasti`：9 文件 mtime 全 ≤ 2026-11-10，全量聚合 sha
  `f73f8ff9f25c55e96bee0d2e6ec0bfc0221f55cd2558df4fe16a68f7bdcbb414` 全程不变；memory-index 不存在。
- git 全程零写（无 add/commit/stash/push）；唯一 tracked 改动仍为历史既有 `M tests/contract/event.test.ts`
  （本任务未触碰）。
- 检索 limit 缺省取全集→门过滤→再截断不凑弱尾；`GatedRankedCard.evidence` 第一层恒 undefined。
- 第一层只报机制行为与四态计数，**不报 R1≥0.85 / R2≤0.05 达标**（D4）。

### 13.4 已知残余（登记，不在本期修）

- ASCII 词边界对「标点/连字符衔接」不生效：`v1⊂v1.2`、`cat⊂cat.log`、`git⊂git-flow`、`git⊂a-git-b`
  仍可能过门（§5.2.1 已登记反例表，连续分词/边界扩展列为第二层演进项）。
- 同一 `git` 查询下 `github` 已被拒（ASCII 无边界），但上述标点残余仍需第二层处理。
- `package-lock.json` 与 `package.json` 的同步问题（原缺 `@deepseek-ai/dsh-llm`，tracked 历史问题）
  已在闭环后独立收尾中完成刷新：`npm install --package-lock-only --legacy-peer-deps`（registry 同域
  npmjs.org），lock 由 7 包增至 16 包，含 `dsh-llm@0.2.1-rc.5` 及其传递依赖；`npm ci --dry-run` 退出 0
  （不再 EUSAGE），741 测试回归全绿。该变更属安装层，不触代码/schema/机制。

### 13.5 外部 v2.3 评审 N6/N7 闭合记录（2026-11-13）

外部对 v2.3 给「附条件 PASS」，条件为 N6（审计层 legacyR2 口径反转，必须修）与 N7（验收数字不一致）。
两项均已亲验、修复并重跑：

- **N6（代码）**：原实现 `legacyR2.point = legacyHit/legacyN` 只累加 correct-commit，实为**准确率** `cc/G`；
  而旧 r2（`decoy.ts` `correct = top1===gold`、`metrics.ts` `mean(correct?0:1)`）是**错误率**
  `(wc_G+wa)/G`，二者互为补数，且与字段自身 doc 矛盾。外部三案例（对称 0.5/0.5 掩盖、非对称 0.25/0.75
  反转、全错 1.0/0.0 最严重）亲验属实。
  修复：`legacyHit` → `legacyError`，仅 `hasGold && cls !== 'correct-commit'` 累加，`point = legacyError/legacyN`；
  doc 同步更正为「错误率」。
- **N6（测试）**：新增判别用例（非对称 cc3/wa1 → 0.25；全错 cc0/wcG2/wa2 → 1.0），修前实得 0.75 / 0.0
  必红；`gate-smoke` 单认对例由错误断言 1 更正为 0。
- **N6（变异）**：矩阵补 M12「旧 r2 口径反转」（`cls !== 'correct-commit'` → `===`），注入后 four-state
  判别例必红、还原回绿。
- **N7（数字）**：§13.2 与 EVIDENCE §3 统一更正为 **741 tests / 741 pass / 0 fail / 0 skip（Linux）**，
  = 687 + 54（gate 15 + layer-imports 2 + alias-write 13 + bm25 +3 + four-state 14 + gate-smoke 6 +
  builder +1）；win32 如实标注 740 pass / 1 skip（M9 POSIX-only）。
- 复审口径：N6 三项（代码/判别例/变异）、N7（数字=实际值+平台标注）、回归 verify 全绿、真实根 sha 不变。

**外部复审判决：明确 PASS**（N6/N7 已闭合、无阻断项）。外部逐项实测：`four-state.ts` 的
`legacyError` 累加条件与 `point=legacyError/legacyN` 正确；四案例探针（对称 0.5、非对称 0.25、全错 1.0、
单认对 0）全对；新增判别例为**一个** test（13→14）；`gate-smoke` 断言已为 0；M12 还原 sha
`3acb2d2d…` 与交付 `four-state.ts` 实 sha 吻合；闭合 delta 仅 four-state.ts、两测试、一式脚本、一文档，
gate/bm25/alias-write/store/schema 零改动。
外部同时提两条**非阻断外发卫生建议**，均已处理：变异日志 67 处本机环境路径泛化为
`<REPO_ROOT>`/`<sid>/<aid>`/`<PROJECT_DIR>`/`<REAL_ROOT>`；§6 示例目录 `…/<会话片段>/…` 泛化为
`<workspace>/…`（EVIDENCE §10 已逐条声明）。
第二层（实时接线、M6 修订、运行期受控窄写、host cordis/dsh-llm 协议）不在本 PASS 范围，须另立方案与评审。

