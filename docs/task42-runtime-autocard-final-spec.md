# 任务 #42「记忆卡运行期建卡通道」立项定稿（外部评审整合版）

| 项 | 内容 |
|---|---|
| 文档地位 | #42 的**立项定稿正本**。送审文档 `runtime-autocard-external-review-brief.md` 第 8 节七个开放问题，本文全部终裁；原立项书 `memory-anchor-governance-and-auto-card-proposal.md` 保留为背景与证据材料，与本文冲突处**以本文为准** |
| 代码基线 | git HEAD `8fbbb41`（2026-11-15），873 tests / 873 pass / 0 fail，双 tsc 0，静态门 47/47 |
| 输入 | 三份外部评审（DeepSeek 782 行；评审二《任务42…外部评审意见》；评审三 `task42-external-review-opinion.md`），评审者均无仓库访问权 |
| 方法 | 每条事实性主张先回代码实证再裁决；实证结论见第 1 节，主张级处置明细见第 6 节 |
| 纪律 | 定稿前不写生产代码；本文经主控终审后按第 4 节批次 TDD 开工；git 写操作逐次授权 |

---

## 0. 结论速览

1. **#42 先行成立**，两个硬前置：L1 锚点形态闸拆独立小卡先于 B2 落地；drain 悬空姿态改逐事件确定性隔离，不得继承 builder 整库 fail-fast。
2. **M6 规则①零放宽、值白名单零增项**：门面新增 `drainMemoryProjection` 委托注入端口，窄柄 `openMemoryRuntime` 返回句柄上加第七法 `drainProjection`（整轮 pull、预算化），构建/派生/落库全在 `src/memory/` 内。"在规则①墙上开门"判定为伪命题。
3. **增量机制采无状态 level-triggered reconcile**：不存任何权威水位/游标；每轮从真源全量 fold → 共用纯函数 derive 期望态 → 与现投影 diff → 单事务应用。进度从 `decisions.jsonl` 派生，仅作正确性内建、不落额外状态。
4. **失败分三级 F-A/F-B/F-C**；空 anchors 三分口径（合法 abstain／形态缺陷 quarantine／缺失畸形 F-B）；隔离与 abstain 观测写投影内专用 append-only 文件 `drain-observations.jsonl`，**永不进 decisions 台账、永不进真源、可整体删除后重算**。
5. **她的判断走 (a) 真源事件版本回放**；B3 的判断语法是真源契约扩展，冻结面评审独立立卡，不随本卡夹带；模型不获得任何新的决策直写路径。
6. **确定性收口**：decision_id 改内容派生、时间字段取该版本 `created_at` 的落盘时间（§3.5.1 实施裁定）；structural hash 承载全部结构派生输入快照、为结构变更判定唯一权威（content_hash 扩面延后，§3.5.2）；验收等价类重定义为"可查询态逐行相等＋台账可重放一致＋provenance 100%"，不再要求台账历史逐行相等。
7. **批次重切**：L1 前置小卡 → B0（门＋纯函数抽取＋确定性契约）→ B1（planner/diff 纯函数层＋流式等价红测，不接线）→ B2（IO 编排与 worker 接线，off/shadow 可验，on 随 #91）→ #90 L2/L3 → B3 → #91 解冻 on。

---

## 1. 外部评审事实核验总表（HEAD 8fbbb41 实证）

### 1.1 实证属实、纳入定稿的主张

| # | 主张（出处） | 代码实证 | 处置 |
|---|---|---|---|
| V-01 | decision_id 随机、at_ms 取墙钟，跨重建台账行不可逐行相等（三家共有） | `store.ts:456 decision_id: ulid()`；`builder.ts:223 nowMs ?? Date.now()`。现有幂等承诺仅覆盖 card_id/content_hash/row_hash_sum，不含 decisions 行 | 采纳，确定性派生改造见 §3.5 |
| V-02 | FTS 文本仅 cues＋活跃别名，无 cue 期自然语言检索面为空（DeepSeek P-3） | `fts.ts:32` 注释与 `cueTextOf` 实现明文：仅 display_cues＋活跃非敏感别名，绝无正文/摘要 | 采纳，本期 KPI 不承诺命中率（§5.3） |
| V-03 | builder 任一悬空即整份零产物，增量照搬会活锁（三家共有，P-1） | `builder.ts:264-270` readyEvents 循环内收集 dangling 后直接抛 `MemoryAnchorDanglingError` | 采纳，逐事件隔离见 §2.3 |
| V-04 | SQLite 事务与 JSONL 账本追加跨存储无原子性（DeepSeek N7） | `store.ts:403-432` 先 COMMIT，之后才 `appendRevision/appendDecision`；崩溃在两者之间留"有卡无决策"窗口，无对账机制 | 采纳，启动 reconcile 自检协议见 §3.6 |
| V-05 | L1 ULID 形态闸在写入侧缺位（评审二/三） | `event/closure.ts` 全文无 isUlid；`contract/event.ts:510` 仅 `requireStringArray`，只校验字符串数组 | 采纳，L1 独立前置卡见 §4.1 |
| V-06 | `addMissAlias` 模型可触达、决策行却落 `created_by='her'`，存在 provenance 张力（评审二 Q4） | `memory-tool-bridge.ts:184` 定义宿主工具 `fasti_memory_add_alias`、`:327` 注册进工具表；`memory-tools.ts:257` 仅 on 态放行；`store.ts:465` 硬编码 `'her'`。当前门 off/shadow 未激活 | 采纳，定性与处置见 §2.4 |
| V-07 | 投影"整体删除照真源重建"表述过宽，NL 残差不可重导（评审二 A.1／评审三风险 1） | `builder.ts:271-274` readDecisions＋readExistingIndex＋replayDecisions，旧库快照与决策台账携带别名残差；真源无对应物 | 采纳，残差语义写入正本 §3.7 |
| V-08 | JSONL 尾行 torn-read 可致读取崩溃（评审三风险 4/T17-8） | `jsonl.ts:60` appendFileSync 单行追加；`parseJsonl` 遇任意坏行抛 CorruptedError，无"末行不完整视为不可见"规则；真源读侧无快照隔离 | 采纳，尾行容错规则＋红测见 §3.6 |
| V-09 | 不可导累积字段真实存在，diff 不得重置（评审三风险 3） | `schema.ts:30 weight REAL`、`:43/:75 hit_count INTEGER` 均为实列 | 采纳，diff 范围铁律 §3.4 |
| V-10 | drainClosure 返回裸数字，0 兼表空队列/关停/跳过（评审二③） | `api/index.ts:650-680` 返回 `Promise<number>`，closed 与无活均返 0 | 采纳，新 drain 结构化轮报告 §3.3 |
| V-11 | B3 判断语法属真源契约扩展，有冻结面管辖（评审三风险 2） | `src/contract/frozen-surface.ts` 真实存在 | 采纳，B3 独立立卡走冻结面评审 |
| V-12 | content_hash 不含 channel/时间窗，版本修正可静默漂移（三家共有） | `content-hash.ts computeContentHash(anchorJson, cuesJson, aliasesJson, discriminator)` 四输入，确无 channel/window/eligibility | 采纳，hash 扩面 §3.5 |
| V-13 | 时钟回拨下游标类方案可漏处理（DeepSeek 独家） | `core/ulid.ts` 48 位墙钟＋随机单调；无水位方案下风险弱化为排序/去重问题 | 改写后采纳，红测 R-16 |
| V-14 | 最隐蔽的 M6 绕过是缩小 REALTIME_DIRS 与宿主工具表私增（评审二探针 #10/#11） | 现有门按目录枚举标红，但无"删目录项即红"恒定断言、无宿主工具表内容快照断言 | 采纳，探针 P-09/P-10 |

### 1.2 前提失准或已被现有能力覆盖的主张

| # | 主张 | 实证结论 | 裁决 |
|---|---|---|---|
| X-01 | 现状 `card_id = f(event_id)`，锚点变化不影响 id（DeepSeek 5.6） | **失准**。`content-hash.ts deriveCardId(eventId, anchorIds)`＝`mc_`+sha256(canonical([eventId, sorted(anchorIds)]))，现状本就随锚点变 | 保留现行公式，不引入 generation 改造；其"别名/hit_count 随 id 丢失"的有效担忧改由 §3.7 残差按 event_id 重绑解决 |
| X-02 | content_hash"只哈希 anchors"（DeepSeek 4.5） | **部分失准**。现覆盖 anchors＋cues＋aliases＋discriminator 四字段，但确不含 channel/window（即 V-12） | 按 V-12 扩面，不按"只哈希 anchors"表述改写 |
| X-03 | 动态 import() 是静态扫描洞，需补能力（DeepSeek P2） | **能力已具备**。`schema.test.ts:379-385` 有 dynamic 正则，`:573`、`:682` 两条投毒用例专钉动态 import() | 不立新洞；仅在新模块探针矩阵中保留一条回归位 |
| X-04 | builder 对空 anchors 会 trivially 建出零锚点死卡（评审二/三） | **现状不会**。`builder.ts:280 old === undefined → continue`（未种子事件不建卡），空白库下零新卡；但 #42 planner 是首个真正自动建卡者，两侧口径必须同函数 | 担忧的未来风险成立，空锚三分口径 §2.3 同时约束 builder 与 drain |
| X-05 | miss 别名是"无 card 归属的空锚别名"（DeepSeek N8） | **概念混淆**。null 锚点的是 `mem_miss` **观测行**（`miss.ts:58-65` 允许 string|null）；`addMissAlias` 入参强制 cardId 非空，不存在无卡别名。回填消费规则未定义属实，已挂账 11.6/#116 | 命名空间问题转为观测行消费规则，写入 §2.3 与 #116 接口约定 |
| X-06 | serial.ts 应顺手迁出 memory（DeepSeek N10） | 方向对但不免费：`serial.ts:11-12` 依赖 memory-errors 与 memory 内部 types | 列为 B0 登记项，外迁须先拆依赖单独立项，不顺手改 |
| X-07 | 经历 ULID 重跑转换会漂移、属流沙地基（DeepSeek 5.7） | `api/index.ts:454 defaultUlid.next()` 确为摄取时随机铸造、非内容派生；但迁移脚本已随空白重启删除，实时摄取一次写定，重跑场景主要是历史路径 | 降级为不变量刻画测试 R-17，不阻塞 #42 |

---

## 2. 七个待裁决问题的终裁

### 2.1 问题 1：#42 与 #90 的顺序——#42 先行，两硬前置

**终裁：维持 11.5 排期 `#90 ← #42`，#42 先行。** 技术依据经评审补强：

1. 污染与 #42 无关：闭合慢路径今天就在写 anchors，#42 是纯消费者，#90 晚一天污染多积累一天，"#90 先人保洁净"的因果不成立；
2. #43/#116/#94 消费的是"卡存在"而非"锚点洁净度"，陪等无技术理由；#90 的 L2/L3 反而需要 drain 真实消费反馈才能验引用完整性；
3. 现行 builder 全局 fail-fast 意味着**第一颗幻觉 ULID 今天就能打穿离线全量重建**，#42 的逐事件隔离是在修复既有脆弱性。

**两个硬前置（写进验收，不是排期默契）：**

- **前置甲（独立小卡，先于 B2）**：#90 的 L1 切片——事件版本追加前的单记录 26 位 Crockford ULID 形态 fail-closed 断言，零新表/零 LLM/零常驻，落 `src/event/closure.ts` 写入路径；L2/L3 仍随 #90 本卡，不提前。
- **前置乙（B1 即落地，不等 B2）**：F-B quarantine 姿态与观测面在纯函数层就定义并测试，防止 B1 的锁竞争静默把脏数据一并吞掉。
- B2 验收断言：落地期间记忆门保持 off/shadow，**拒绝升 on 写成自动化红测**；on 态解冻仍随 #91。

### 2.2 问题 2：M6 门往哪开——C′ 方案，规则①零放宽、白名单零增项

**终裁：采纳评审二 C′ 与评审三 C 修正版的融合形态，否决 DeepSeek 候选 D 的白名单增项、否决 A 原生形态、否决 B。**

依赖方向（文字依赖图）：

```text
src/adapters/dsh/llm.ts（worker 唯一心跳源，K3）
  ├─ Fasti.drainClosure(...)            既有，独立预算、先行
  └─ Fasti.drainMemoryProjection(budget) 新增；同 tick 串行排后、失败不阻断 closure
       ↓ api 经 src/source/ 读真源（api→source 既有合法边），以纯数据调注入端口
       ↓ api 本地声明 port 结构类型；不 import src/memory（含 import type 不需要）
src/assembly/index.ts（唯一例外目录；只做 DI 接线，不编排业务、不开 DB/文件）
       ↓ runtime.openMemoryRuntime（已在白名单，零新增值符号）
src/memory/runtime.ts 第七法 drainProjection(budget) → DrainRoundReport
       ↓ 内部：requireWriter() → drain.ts（IO 编排）→ derive.ts（纯函数）
       ↓ store.transactionApply / ledger.append* 全部留在 memory 内
projection/memory-index/（锁不可得 → UnavailableError → 整柄只读降级）
反向禁令维持：memory→api/assembly 禁止；event/source/adapters→memory 禁止
```

裁决理由：

1. K3 要求的是"可被调用一次的 drain 能力"而非"够得到纯函数"，纯函数留 memory 内、只让一次调用跨墙，规则①一个字不用改；按"开门"心智做会诱导不必要的放宽。
2. 候选 A 的装配层编排必然触 IO，而 assembly 禁止自开 DB/文件，结局仍是窄柄长方法——A 退化为"C＋额外编排代码＋白名单增项"，无剩余优势。
3. 候选 B 让 adapters 持构建函数，杀死"assembly 是唯一 memory 消费者"不变式，且每新增通道都要重接，否决。
4. DeepSeek 候选 D 的独立 `projection.ts` 思路保留为 **memory 内部实现拆分**（drain.ts/derive.ts），但其"白名单净增 openProjectionWriter 符号"否决：第七法挂在既有句柄上，值符号零增项可机器校验，增项即说明实现偏离设计。
5. **形状选整轮 pull 而非逐事件 push**：调用方只给预算、拿回结构化轮报告；水位/排序/隔离/预算全部留 memory 域内，防止脑裂。

**禁止跨墙清单（写进设计正本）**：`store.transactionApply`、`ledger.appendRevision/appendDecision`、`builder.buildAll` 带 IO 与写锁语义，永不入白名单；不为 api/adapters 新增规则①例外；不缩小 REALTIME_DIRS。

### 2.3 问题 3：失败姿态与空 anchors——三级失败、三分空锚、专用观测面

**失败分级（终裁）：**

| 级别 | 情形 | 姿态 | 台账/观测 |
|---|---|---|---|
| F-A 自愈类 | requireWriter 抛 UnavailableError（离线持锁）、closed 关停、预算耗尽、队列空 | 静默下拍重试，事务未开始、派生集不推进 | 不写观测行；轮报告必须区分 `skipped: 'writer-lock-held' \| 'closed' \| 'budget' \| null` |
| F-B 数据类永久失败 | 悬空（形态合法但经历全集不存在）、非 ULID、anchors 缺失/null/非数组、确定性派生输入不全 | permanent 隔离：不建卡、不重试、不进 applied 集、零字节进 cards/FTS；correction 新版本改变折叠态后自动解除 | 写 quarantine 观测行，reason 受控码 |
| F-C 系统类瞬时失败 | transactionApply 抛错、rename 失败、半轮崩溃、IO 错 | 退避重试；连续失败计数透传轮报告，由 worker 侧升级提示，内核不自理告警（K3） | 不写决策；单事务保证重试安全 |

**空 anchors 三分（终裁，替代送审文档的二选一）：**

1. `anchors: []` 字段存在且形态合法 → **合法 abstain**：不建卡、不写 create-card 决策、写 `empty-anchors` 观测行；零锚点卡两侧检索面都不可达，建卡即 K9 空铺；但不计入缺陷率，避免空白初期指标失真；
2. anchors 缺失/null/非数组/含非 ULID → **F-B quarantine**（`anchor-form-invalid`）；
3. 形态合法但经历全集不存在 → **F-B quarantine**（`anchor-not-found`）。
4. 同一纯函数规则同时约束 builder 与 drain，各配红测；drain 不得在任何输入类别上静默异于 builder。

**观测面落点终裁：投影内新增 append-only 文件 `drain-observations.jsonl`。** 对三家方案的裁决理由：

- 不进 `decisions.jsonl`：决策台账语义是"她的决策"（created_by 仅 'her'），系统观测混入即污染 provenance（评审三 V-2 成立）；
- 不扩 `mem_miss` 表：该表是检索漏召语义、列形状为 term_norm/term_hash/returned_count（`miss.ts:21-30`），drain 生命周期事件硬塞会扭曲两者语义，扩列还牵动既有 CHECK 与测试；
- 不采纳 DeepSeek 的权威 drain-log 水位：水位状态违反无状态对账（§2.4）；轮次时序只活在轮报告返回值与 worker 日志，不落内核状态；
- 文件每行内容键 `(event_id, version_ulid, reason_code)` 幂等 insert-if-absent，双跑不重复；**每行必须能由 foldCurrentEvents＋确定性校验重算出来**——它是可丢弃诊断缓存而非权威状态，删除投影后首轮重建自动重放，满足 projection-rebuildable；
- K9 合规性：四个真实消费者——流式等价 harness、T17 质量仪表、#90 落地移交清单、K11 维修通道的待修列表，非空铺。

**同时否决**：真源事件挂 pending（违反 source-append-only、超出只写投影范围）、新建失败队列表、自动追加修正版本、放宽 builder 悬空断言、drain 内调 LLM 补锚。

### 2.4 问题 4：她的判断——(a) 真源回放，B3 冻结面独立立卡

**终裁：采纳 (a)，否决 (b)。** (b) 三重冲突：created_by 联合类型仅 `'her'`，模型申请落账要么伪造 provenance 要么改冻结契约；开运行期模型→决策写路径直接违反 B3"不开模型可直写决策工具"；新裁决规则按 K9 须独立立项。

**对现状 `fasti_memory_add_alias` 的定性与处置（V-06 的收口）：**

1. 书面定性：该工具是 #115 交付的**检索落空后的别名补记通道**，语义上是她发起、模型仅转写执行，且仅 on 态、仅能作用于检索返回的既有卡（sensitive=1 私域别名）；
2. 本期冻结其行为面：不扩动词、不扩可达卡范围、host-tool-runtime fail-closed 两层校验继续生效；B0 补宿主工具表内容快照探针（P-10），第七法永不进工具表；
3. B3 的真源判断通道落地后，评估将该工具收编为判断语法的转写前端，收编方案随 B3 卡评审，本卡不做；
4. 补红测 R-15：删除投影→全量重建→明示 miss 别名残差归零、可经 B3/补记通道重新积累，把残差语义变成可执行断言。

**B3 判断语法的设计约束（登记于本卡、实现随独立冻结面卡）：**

- correction 事件版本增可选结构化字段 `memoryJudgments[]`，走 `src/contract/frozen-surface.ts` 冻结面评审与契约层形状闸；
- 动词本期仅 `add-alias | invalidate`，target 本期仅 `'self'`（只作用于该事件当前派生卡），全部命中既有 action 枚举，**决策 action 零新增**（否决 DeepSeek 的 recompute-card：invalidate＋create 已表达）；
- 去重键 `(event_id, version_ulid, judgment_index, verb)`，别名目标先过 `gate.normalizeLexicalText` 再入键；
- 决策行 `model_tag='judgment-replay-v1'`、reason 带版本 ULID＋序号，形成"决策行→事件版本→她原话"三段链；未知 kind fail-closed 落观测而非默认忽略；
- 判断到达时该事件不出卡（隔离/abstain）→ 终态观测行 `judgment-unapplicable`，不设跨水位悬置；她的补救是再发一次 correction（append-only 世界重发即合法）。

### 2.5 问题 5：增量水位与重建——无状态 level-triggered reconcile

**终裁：不存任何权威水位/游标，采纳评审二/三的无状态对账；DeepSeek drain-log 的水位语义否决，其诊断价值由观测文件＋轮报告承接。**

每轮 drain 协议：

1. 从真源全量读 events/experiences（容忍尾行截断，§3.6），`foldCurrentEvents` 取 closed+ready 折叠态；
2. `deriveProjection(折叠态, 经历存在谓词, decisions 全量回放)` 产出**期望态**——与 builder 全量构建同一函数入口（B0 抽取 `derive.ts`，特征化测试锁零漂移）；
3. 已处理集从台账派生：`applied = Set<"event_id:structural_hash">`，**纯观测，不参与写路径决策**（实施裁定 §2.5.1），不落盘、不建表；
4. `diffProjection(现快照, 期望态)` 纯函数求差，经 `transactionApply` 单事务应用；空轮不追加 revision；
5. 规模依据：空白重启后活动库为 0，单用户年增长数千至十万行级，全量 fold 为毫秒级解析，个人规模下为水位付复杂度不成立。

**等价类重定义（替代"逐行相等"旧口径）：**

### 2.5.1 applied 集降为纯观测裁定（2026-11-15 主控，变异反证驱动）

实施期 MU-11（把决策行 `structural_hash` 写死为常量）**变异存活**，回代码实证后定位到两件事：

1. **该短路在正常路径不可达**：`plan` 动作由 DB 前后态 diff 派生，`create-card` 动作出现的前提就是"投影里没有这张卡"；DB 有卡时根本不会产生该动作，于是 `appliedSet.has(...) → continue` 的闸门落不到任何真实路径上。
2. **它可达时是有害的**：唯一能让该闸生效的情形是"台账有 applied 记录、但 DB 里卡不存在"（单卡行损坏、被误删、M6 恢复不完整）。此时闸门会把本该补建的卡**永久跳过**，日常轮次再也补不回来，只剩全量重建能救——直接违反 R-03「任意时刻 queryableImage 与离线全量逐行相等」。

故裁定：**删除该短路**，写盘决策一律由 diff/plan 决定，**台账不得抑制自愈**；`applied` 集降为轮报告观测值，代码注释写死"严禁再当写路径闸用"；若删后无任何消费者则整体删除，**不留装饰性死码**。配套三条钉死红测：单卡自愈（删一张卡行后一轮必须补回，当前代码下先红）、台账 `structural_hash` 与测试侧独立重算的六项哈希严格相等（这条是 MU-11 的摘红点）、预置历史 applied 行 + 空 DB 不得抑制重建。

原始设计的"applied 判 pending"意图（避免重复判定）在 DB 驱动的 plan 下**本来就由 diff 免费获得**，无需第二套判据；保留它只会引入"台账与投影不一致时互相打脸"的失败面。

**执行结果（裁决 10）**：删除短路后，`deriveAppliedSet`／`AppliedEntry` 被实证为"生产侧零调用、仅测试在调"的装饰性死码——它恰好是 MU-11 第一次能存活的温床（测试测的是一个没人调的东西），故连同其专属用例整体删除（全仓 grep 归零，-3 条断言）。**保留并钉死三条真护栏**：单卡自愈（删一张卡行后一轮必补回）、历史 applied 行不得抑制重建、以及台账 `structural_hash` 与测试侧独立重算六项哈希严格相等（后者为 MU-11 摘红钩子，变异后仅红此一条，全量 1019/1018/1）。


- **可查询态逐行相等**：活卡集合、aliases、FTS 虚表内容、event_id→活卡映射；
- **台账语义等价**：decisions replay 终态与 cards 一致、revisions 链校验通过、provenance 100%、每条 create-card 可被某 `(event_id, structural_hash)` 解释；
- 含修正版本时台账历史必然不同（全量只有 create(v2)，增量有 create(v1)＋invalidate(v1)＋create(v2)），旧"台账逐行相等"要求撤销。

**重算边界**：以 `(event_id, 全结构派生输入快照哈希)` 为单位；哈希变化则该 event 名下活卡整体 invalidate＋按新版本重建，不允许半组更新（不许半份坏版本）。

**规则版本协议**：drain 启动比对投影标记的 rules_version，不符则拒绝服务返回 `rebuild-required`，不做运行期静默巨变；规则升级唯一路径是离线 CLI `--apply` 一次性迁移（二次确认）；规则版本随决策行 model_tag 固化，重放按版本回放，杜绝按"生效时间"切换派生规则的隐式不可重建状态。

### 2.6 问题 6：检索词长期路线——charter 化，第三路线优先

**终裁：**

1. 本期零自动化红线不动；cue/alias 自动化**整卡立 charter**（含 schema、遥测、门禁、回滚的打包立项），不以"等样本"为由挂成无主事项；
2. 三家共识的结构性两难写明：零模型抽词与 FTS 现有内容高度重合、边际增益近零且治不了词汇失配；受约束模型候选的质量上限等于候选池召回上限；
3. 采纳评审三的第三路线为默认立场：**路线一保底 cue ＋ B3 她的 miss 驱动别名（#115 miss 表即数据面）优先积累**，模型候选路线降为条件触发项——仅当 miss 率在足够样本下进入平台期且缺口明确属换述类时启动评估；
4. 预注册"影子反事实回放器"为 #42 之后下一张投影侧小卡：本系统 FTS/BM25 是纯确定性引擎，可离线精确仿真"若注入该 cue，历史哪些 miss 会命中"，无需在线 A/B；只仿真不写检索、不建空表；
5. 考核五维补全（三家并集）：线上漏报与 miss 表联测、跨卡干扰排名、模型/prompt 变更快照 diff、预注册最小样本量与 CI 宽度、cue 膨胀噪声率；R1≥0.85/R2≤0.05 不再作为唯二门槛；
6. 解冻是工程期一次性批处理（配置翻转＋audit harness 全过），运行回路无"等人"状态；任何"每批次人点确认"设计否决；回滚＝按 model_tag 过滤重放，依赖 §3.5 的内容派生 id。

### 2.7 问题 7：过渡防污——L1＋宁空勿错＋仪表化，不建告警系统

1. L1 形态切片（前置甲）是性价比最高的单笔防护，#42-first 窗口的真源污染不可逆性由此收口；坚持不拆 L1 的唯一诚实退路是 11.6 挂账并永久接受一批不可建卡版本，该退路与既有 §5.3.3 冲突，不采纳；
2. 闭合摘要 prompt 增加"无把握输出空 anchors、绝不猜测 ULID"授权（指令不是闸门，不替代 L1 与引用完整性检查）；
3. 质量仪表零新设施：audit harness 读 `drain-observations.jsonl` 与真源事件数，产出 dangling/empty/malformed 三率可复算报告；隔离率阈值作为 gate 升 on 的确定性硬前置输入之一，阈值预注册、写为可配置常量而非硬编码经验值（DeepSeek 的 N=200/20% 不硬编码，经 shadow 数据标定）；
4. worker 侧滑动窗口告警是唯一告警位置（宿主状态不受 K3 约束），内核零定时器零告警；
5. #90 落地后隔离检查**永久保留为深防御不变式**（成本近零），只退役 worker 阈值；观测行不物理删除，"全量重建后 quarantine 集与真源重算集精确相等"转长期回归断言。

---

## 3. B0 依赖设计正本

### 3.1 模块清单与职责

| 模块 | 状态 | 职责 | 依赖约束 |
|---|---|---|---|
| `src/memory/derive.ts` | 新增 | 从 builder 抽取的纯函数层：fold 适配、悬空/形态谓词、空锚策略、structural hash、期望态派生、diff；零 IO | 仅依赖 types/content-hash 等无环低层；禁 node:fs/DB（探针 P-08） |
| `src/memory/drain.ts` | 新增 | IO 编排：读真源、调 derive、组织单事务、写观测行、产出轮报告；无定时器 | 可经 source 只读读取器；禁 import api/assembly/event/adapters |
| `src/memory/runtime.ts` | 改 | 句柄增第七法 `drainProjection(budget)`，内部经 requireWriter；既有六法签名不动 | 锁语义复用，不重实现 |
| `src/api/index.ts` | 改 | 增 `drainMemoryProjection` 与本地声明的 `MemoryProjectionDrainPort` 结构类型；未注入时返 `skipped:'not-wired'` | 零 memory 导入（含 type） |
| `src/assembly/index.ts` | 改 | 仅 DI 绑定函数，结构化适配句柄到端口 | 无业务编排、无 IO |
| `src/adapters/dsh/llm.ts` | 改 | worker 循环增一次调用，closure 先行、预算独立、失败不阻断 | 不出现任何 memory import |
| `src/memory/audit/` | 扩 | 三率报告、流式等价 harness、verify 对账复用既有 harness | 离线 dry-run 默认 |

B0 须在门注释中显式登记 memory→source 为**既有合法设计边**（builder 已有先例），防未来误判。

### 3.2 轮报告形状（终裁）

```ts
interface DrainRoundReport {
  scannedVersions: number;
  cardUpserts: number;
  invalidations: number;
  quarantined: number;        // F-B 本轮新增
  emptyAnchored: number;      // 合法 abstain 本轮新增
  applied: boolean;           // 是否发生事务提交
  skipped: 'writer-lock-held' | 'closed' | 'budget' | 'not-wired' | null;
  consecutiveFailures: number;
  rulesVersionMismatch: boolean;
  durationMs: number;
}
```

守恒断言（落自动化测试与 debug 断言）：`scannedVersions = cardUpserts + invalidations + quarantined + emptyAnchored + 已applied既留`，按实际口径在 B0 细化为可复算等式。

### 3.3 观测行形状（drain-observations.jsonl）

```ts
interface DrainObservation {
  id: string;                 // 内容键派生，非随机 ulid：见 §3.5
  event_id: string;
  version_ulid: string;
  reason_code: 'anchor-form-invalid' | 'anchor-not-found'
             | 'empty-anchors' | 'judgment-unapplicable' | 'drain-permanent-tx';
  snapshot_hash: string;      // 该版本全派生输入快照，隔离可重算的凭据
  at_ms: number;              // 取事件版本 ULID 时间，非墙钟
}
```

### 3.4 diff 范围铁律：不可导残差绝不触碰

diff/upsert 只作用于**可导结构子空间**（卡结构字段、FTS、活卡映射）。三类残差整体保留：

1. `hit_count`/`weight`（检索累积态，schema.ts 实列）：upsert 按 card 身份 merge 保留，禁止重置；
2. miss 行与影子观测（append-only 检索行为）；
3. 决策台账携带的检索词残差（#115 别名、未来 B3 判断别名）。

残差重绑规则（收口 X-01 的真实担忧）：别名/hit_count 的归属键从 card_id 改为 **event_id 内容键**重放——锚点变化衍生新 card_id 时，同一 event_id 名下活别名随回放迁移到新卡；B0 红测 R-06 钉死。

### 3.5 确定性契约改造

| 对象 | 现状 | 终裁 |
|---|---|---|
| decision_id | `ulid()` 随机（store.ts:456） | 内容派生 ULID：时间段取该版本 `created_at` 的 48 位 Base32 时间（`isoToMs`，实施裁定 §3.5.1），随机段取去重键 sha256 切片；同真源双跑逐行相等 |
| DecisionRecord.at_ms | 墙钟 Date.now | 取该版本 `created_at` 转毫秒（实施裁定 §3.5.1）；离线 RevisionRecord 的墙钟/operator 字段保留但明确**不纳入跨重建相等口径** |
| structural hash（新） | 无 | 新增全结构派生输入快照：anchors＋channel＋时间窗＋eligibility＋规则版本，作为重算与 applied 集键；**结构变更判定唯一权威** |
| content_hash | 四输入、缺 channel/window | 扩面**延后**（实施裁定 §3.5.2）：公式本轮不动，降格为"卡片内容摘要"同公式自比，不承担失效判定；不得跨输入面比较 |
| card_id | `deriveCardId(eventId, sorted anchors)` | **公式不动**（X-01）；锚点变即新 id，旧卡 invalidate，残差按 §3.4 重绑 |
| 观测行 id | 无（新文件） | 内容键 `sha256(event_id|version_token|reason_code)` 切片（version_token=`event_id#v{version}`，实施裁定 §3.5.1），双跑不倍增 |

### 3.5.1 版本时间与版本身份实施裁定（2026-11-15 主控，回代码实证）

原文"时间取版本 ULID 时间"的前提**不成立**：`contract/event.ts` 的 `EventRecord` 只有事件级 `id`（ULID，多版本共享）、`version: number`、`created_at`，**没有逐版本 ULID 字段**（新增字段属真源契约扩展，本卡禁止）。实证 `created_at` 字段注释为"该行写入时刻"，即逐版本落盘事实。故：
- `at_ms` 取**该版本** `created_at` 经 `isoToMs` 的毫秒值 —— 逐版本可区分、落盘可查、跨重建确定；
- 全文 `version_ulid` 一律改读为**版本身份复合键** `event_id#v{version}`（`versionToken`），用于观测内容键与去重键；
- `card_id` 公式不受影响（本就只依赖 eventId＋锚点）。

选 (a) 解码事件 `id` 的时间会让同一事件所有版本 `at_ms` 相同、丧失逐版本区分，选 (c) 新增字段违反本卡"零真源契约扩展"，二者均否。

### 3.5.2 content_hash 扩面延后裁定（2026-11-15 主控，回代码实证）

`computeContentHash` 生产调用面只有两处（`builder.ts:308`、`alias-write.ts:228`），且均为**同输入面自比**，不存在跨输入面比较路径，故延后不会产生假失效。但两条护栏必须成立：
1. **单一权威**：任何"结构是否变了"的判定一律走 `structuralHash`；`content_hash` 只作卡片内容摘要，不得参与 invalidation 判定、不得跨输入面比较（护栏断言已钉，不留注释）。
2. 公式扩面涉及签名 arity 变更，牵连种子夹具与别名自洽断言，须**单独立项评估离线迁移成本**后再动；扩面落地时按 `rules_version` 升级 + 离线 `--apply` 一次性迁移。

> 决策影响面：本条延后不改变验收等价类（"可查询态逐行相等＋台账可重放一致"由 structuralHash 与内容派生 id 承担），仅把"content_hash 输入面"这一项从本卡移到后续评估。

### 3.6 崩溃一致性与读取规则

1. **跨存储窗口（V-04）**：维持"SQLite COMMIT 后追加账本"顺序，新增启动 reconcile 自检：比对 DB meta 的 stamped_revision 与 revisions/decisions 末行，发现"已提交未记账"则按事务内容补记账本行、发现"有账无库"则触发全量对账；自检结果进 audit 报告；
2. **torn-read（V-08）**：drain 真源读取采用尾行容错语义——**仅文件最后一行** JSON parse 失败时视为截断不可见（不推进、下拍重读）；中间行 parse 失败仍抛 CorruptedError 硬失败；jsonl 读取器以严格/尾行容忍两模式实现，红测 R-12 钉边界；
3. 崩溃四切点注入（事务前/COMMIT 前/账本追加间/观测写入间）纳入 R-09；
4. 投影写锁多写者语义书面化：runtime 句柄单例为投影唯一写入口，未来 #43/#94 必须经同一句柄，禁止另开 writer；T17 覆盖旧 worker 未退干净的重启场景；
5. runbook 增一行"数据根禁止双机挂载"。

### 3.7 可重建语义的正本表述（替换旧过宽表述）

> 记忆投影 = **真源可导部分**（结构化卡、FTS、活卡映射、B3 判断别名）＋**投影残差**（#115 miss 别名、hit_count/weight、miss/影子观测、drain 观测）。
> 整体删除投影后：可导部分从真源无损重建；投影残差归零，经 miss 通道与 B3 判断重新积累，该损失是明示语义而非缺陷。任何新增能力必须先声明自己属于哪一侧；不可导残差类别只允许缩小、不允许无声扩大。

### 3.8 B0 必决清单的答案

评审三 10 项必决：①card_id 公式保留（§3.5）；②decision_id 内容派生（§3.5）；③空锚三分＋builder 同姿态（§2.3）；④观测 schema 与 reason 码表（§3.3）；⑤无状态对账（§2.5）；⑥残差保留（§3.4）；⑦B3 冻结面独立卡（§2.4）；⑧规则升级离线迁移（§2.5）；⑨双 drain 禁并发/closure 先行/预算分离（§3.1＋R-14）；⑩轮报告形状（§3.2）。

---

## 4. 批次重切与红测清单

### 4.1 批次（替换原 B0-B3 线性切法，回应 K9 反空铺）

| 批次 | 内容 | 出口判据 | 生产写 |
|---|---|---|---|
| 前置卡 L1 | closure 写入前 ULID 形态 fail-closed；红测先行 | 投毒样本（web_search 类自由标签）全拦、合法 ULID 零误伤 | 仅真源写入路径加断言 |
| B0 | 本文正本评审入库；derive.ts 抽取零漂移；M6 探针加断言（含 P-09/P-10）；确定性契约改造（§3.5）；观测文件契约；reconcile/尾行容错；audit 三率骨架 | R-01/02/07/08/12/16/17（**R-10 移出 B0，见下注**） | 投影内新文件，默认无数据流 |
| B1 | 纯 planner：deriveProjection/diffProjection/applied 派生/隔离与 abstain 纯函数；**不接 worker、不开运行期写路径** | R-03/04/05/06/11/13/18 全绿，流式等价 harness 成形 | 零运行期接线 |
| B2 | drain.ts IO 编排＋第七法＋api 端口＋assembly DI＋worker 接线；off/shadow 真机浸泡 | R-09/14/15＋T17；**拒绝升 on 自动化断言** | off/shadow 可验，on 随 #91 |
| #90 L2/L3 | 引用完整性与序号反幻觉，本卡范围外 | 既有排期 | — |
| B3（独立冻结面卡） | memoryJudgments 契约＋回放＋addMissAlias 收编评估 | R-07 扩展、冻结面评审 | 真源契约扩展 |
| #91 | on 态解冻，阈值硬前置全部满足 | — | 首笔 on 态生产写 |

> **R-10 归属裁定（2026-11-15 主控，实施期回代码实证）**：R-10（离线持锁 → 返 `writer-lock-held`）原列在 B0 出口判据，但同段把 `drain.ts` 与第七法划给 B2 —— B0 没有 drain，就不存在"持锁返 `skipped`"的可绿路径。若强行留红，会让 `npm test` 跨批常红、污染批次交付信号。故 **R-10 随 B2 批次落红测、批内转绿**，B0 出口判据相应移除。这条是排期自洽修正，不改变 R-10 的断言内容与强度。

### 4.2 红测清单（三家去重合并，TDD 先行）

| 编号 | 红测 | 关键断言 |
|---|---|---|
| R-01 | derive 抽取特征化 | 同一合成真源下，抽取前后 builder 全量输出逐行不变 |
| R-02 | 双跑决策确定性 | 空投影连跑两次，decisions/revisions（相等口径内字段）逐行相等；直接证伪 V-01 旧风险 |
| R-03 | 流式等价（核心） | 随机预算/随机锁跳过/随机轮边界崩溃下 N 轮 drain，任意时刻 queryableImage 与离线全量逐行相等 |
| R-04 | 收敛幂等 | 收敛后再跑一轮：零 upsert、零新决策、零观测倍增 |
| R-05 | 删除重建 | 删投影重建：可导部分≡原态；观测集合与真源重算集精确相等；残差归零按 §3.7 明示 |
| R-06 | 残差保留与重绑 | 结构 upsert 后 hit_count/weight/miss 别名保留；锚点变更新 card_id 后别名按 event_id 迁移成功 |
| R-07 | 修正链三形态 | 锚点变→旧卡 invalidate＋新卡建；仅摘要文字变→不重算；时间窗/元数据变→必须重算（钉 V-12） |
| R-08 | 混合脏夹具 | 悬空/非 ULID/空/缺字段/未 ready/未 closed 混合：cards 零坏卡，abstain 与 quarantine 计数精确，观测可重算 |
| R-09 | 崩溃四切点 | transactionApply 前后、账本追加间、观测写入间注入故障：无半份、reconcile 自愈、终态相等 |
| R-10 | 离线持锁 | 持写锁时 drain 返 `writer-lock-held`、检索可用、释放后追赶等数 |
| R-11 | 空锚双侧同态 | 空 anchors 在离线 builder 与增量 drain 均 abstain，policy 单侧生效即红 |
| R-12 | 尾行容错 | 末行半截→不可见不报错且不推进；中间行坏→CorruptedError 硬失败 |
| R-13 | 隔离解除 | correction 新版本带合法锚点后原隔离事件自动出卡，无专门解除机制；离线重建复现同一隔离集 |
| R-14 | 双 drain 预算隔离 | 人造大批记忆 drain，closure drain 条数/延迟不受影响、记忆失败不阻断 closure |
| R-15 | 工具面冻结 | 宿主工具表快照：第七法不在表内；任何 build/apply/drain/derive 语义新工具名注册即红；addMissAlias 行为面冻结 |
| R-16 | 时钟回拨 | 注入墙钟回拨：fold 排序不漏不重、applied 派生集无误判、无游标可被污染 |
| R-17 | 经历 id 刻画 | 摄取路径 id 铸造形状/单调单测（X-07 廉价不变量） |
| R-18 | rules 版本 | 版本不符返 rebuild-required 且零写入；离线迁移后台账 model_tag 可按版本回放 |

### 4.3 M6 投毒探针（同 PR 改门＋补用例）

P-01 四实时目录 import 新模块 drain/derive/store 各一文件→拦；P-02 drain/derive import api/assembly/event/adapters→拦；P-03 assembly import 未白名单符号→拦；P-04 api import assembly→拦（DI 单向）；P-05 动态 import() 新模块回归位（沿用既有能力）；P-06 assembly 别名/解构/re-export 绕过命名校验→拦；P-07 memory import api/assembly→拦；P-08 derive.ts 出现 node:fs/DB→拦；P-09 **REALTIME_DIRS 删任一项→拦（恒定断言）**；P-10 **宿主工具表私增第七法→拦（内容快照）**；P-11 合法 fixture 白名单内调用→不拦（防一刀切）。

### 4.4 变异反证（摘红必须变红，严禁放宽既有断言）

MU-1 删 REALTIME_DIRS 的 api 项→P-01/P-09 红；MU-2 白名单改 memory/* 通配→P-03 红；MU-3 摘悬空检查→R-08 红；MU-4 绕过 requireWriter→R-10 红；MU-5 F-B 时推进 applied 集→R-05/R-08 红；MU-6 hash 改回只含 anchors→R-07 红；MU-7 空锚放行建卡→R-11 红；MU-8 空锚策略只在单侧生效→R-03/R-11 红；MU-9 diff 重置 hit_count→R-06 红；MU-10 去掉决策内容键去重→R-02/R-04 红。

### 4.5 合成夹具与 T17

- 夹具：临时 DSH_HOME（真实根零写入）；确定性 ULID（固定时间戳＋计数器）；事件 v1/v2/v3 九种形态；dsh＋一个未来开放枚举通道；投影五态（空/已建好/持锁/revisions 篡改/decisions 插伪造行）；fake FS/SQLite 脚本化抛错；
- T17 真机八项：真实聊天 1–N 拍出卡；离线 CLI 真并发只读降级；kill 进程重启对账自愈；幻觉锚点会话隔离可感零错误；B3 端到端三段审计链；drain 中途关停无半份；数天浸泡三率稳定；读-写并发尾行容忍（Windows tmp/rename 与锁残留同批）。

---

## 5. 明确不做与挂账

**本卡明确不做**（沿用并补强）：cue/alias 运行期自动化（走 §2.6 charter）、erase（#95）、定时器/守护进程/文件监听、任何真源写（L1 断言除外）、情绪/重要度数值、向量/图库、常驻 AI 审核岗、模型直写决策工具、recompute-card 等新 action 枚举、drain 内 LLM 调用、权威水位表/失败队列表/独立质量表。

**本期 KPI 明示**：NL 字段全空下词法检索命中不会提升，验收指标是**非隔离出卡率、空锚率、quarantine 率、miss 累积量与等数对账通过率**，不是命中率；防止把"检索没变好"误判为失败。

**挂账联动**：11.6 空白重启记账保留，#42 不再背"消解 34 存量"义务但保留 #90 前增量复发风险提示；miss 锚点回填消费规则随 #116 与本文观测格式对齐；冷备与隔离区物理删除仍待另行授权；#55/#56 长期挂账不变。

---

## 6. 三家主张处置明细（主张级对账）

| 主张 | 出处 | 裁决 | 理由/落点 |
|---|---|---|---|
| 事件级 quarantine＋水位推进＋熔断 | DeepSeek | 改写采纳 | 隔离采纳；权威水位否决（§2.5）；熔断移 worker 侧且阈值预注册（§2.7） |
| 候选 D 独立 projection.ts、白名单增 1 符号 | DeepSeek | 部分采纳 | 内部模块拆分采纳（drain/derive），白名单增项否决（§2.2） |
| drain-log.jsonl 三行式水位 | DeepSeek | 否决权威部分 | 改 drain-observations.jsonl 纯观测、无水位语义（§2.3/§3.3） |
| F1-F8 失败分级 | DeepSeek | 合并采纳 | 与另两家合并为 F-A/B/C 三级（§2.3） |
| 确定性 decision_id/at_ms、provenance、recompute-card | DeepSeek | 前两项采纳，action 否决 | §3.5；recompute-card 由既有 invalidate＋create 表达 |
| 时钟回拨回看窗口、9 投毒探针 | DeepSeek | 改写采纳 | R-16；探针与另两家合并为 P-01..P-11 |
| B1/B2 合并反 K9 | DeepSeek | 采纳切法精神 | 重切为 B0/B1/B2，B1 交付纯函数可消费成果（§4.1） |
| "开门"是伪命题、零增项 C′、11 探针含缩目录/工具表 | 评审二 | 全盘采纳 | §2.2、P-09/P-10 |
| 失败判据看派生集推进、返回事务化分级 | 评审二 | 采纳 | §2.3/§3.2 |
| 复用 mem_miss 表承载隔离观测 | 评审二 | 否决 | 表形状与语义不符（§2.3 裁决理由） |
| 空锚三分、builder 同姿态 | 评审二 | 采纳 | §2.3（其"现会建死卡"推断按 X-04 纠正） |
| 台账逐行相等逻辑不可能、等价类重定义 | 评审二 | 采纳 | §2.5 |
| L1 切片提前且论证非提前实现 #90 | 评审二/三 | 采纳 | 前置甲 §2.1 |
| 无状态 level-triggered reconcile、行业范式辨析 | 评审三 | 采纳为核心机制 | §2.5 |
| 整轮 pull 反逐事件 push、A 退化论证 | 评审三 | 采纳 | §2.2 |
| 不可导残差铁律（hit_count/weight） | 评审三 | 采纳 | §3.4 |
| B3 冻结面独立卡、judgment-unapplicable 终态 | 评审三 | 采纳 | §2.4 |
| 第三路线＋反事实回放器预注册 | 评审三 | 采纳 | §2.6 |
| torn-read 尾行规则、双机 runbook、verify 模式 | 评审三 | 前两项采纳，verify 列可选 | §3.6；verify 模式不阻塞主线，挂 B2 后可选增强 |
| 双 drain 禁并发/先行/独立预算 | 评审二/三 | 采纳 | R-14 |

---

## 7. 后续动作与授权边界

1. 本文为文档交付，**不动任何生产代码**；主控终审通过后，按 §4.1 批次逐批 TDD 开工，每批 verify 后给 diff 摘要与 tsc 原始输出；
2. 前置 L1 卡与 B0 的取号、11.5 波次表回写、送审文档状态标注，在终审意见闭合后一并处理；
3. 本文与送审文档、原立项书、11.5/11.6 的措辞同步（含旧"逐行相等""整体删除重建"表述修订）随首个 docs 提交入库，提交/推送逐次显式授权；
4. 若主控对 §2.2（门形状）、§2.5（无水位）、§3.3（观测文件落点）三处核心裁决有异议，先回到本文档修订再开工，不在编码中临时变卦。
