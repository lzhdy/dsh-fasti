# #90 写入闸 P2 批 B（L3 生产端候选序号反幻觉）立项定稿

> 基线：HEAD `e67783a`（批 A L2 已封板推送，1058 tests 全绿、双 tsc 0、静态门 50/50）。
> 输入：`docs/task90-l3-external-review-brief.md`（13 问送审稿）＋四家外审回收（共 951 行，无仓库访问权）。
> 方法：每条裁定先回仓代码实证（E-x），失准意见驳回留证，采纳项落到模块/红测/reason 词表。
> 上游冻结：`docs/task90-write-gate-final-spec.md` §7 十条为本卡基线；本文对其中三处做**显式细化/勘误**（第 9 节），不另起炉灶。

---

## 0. 大白话摘要

模型现在给摘要配"证据出处"时是填空题：自己敲 26 位 id，敲错、编一个都有可能。本卡改成选择题：我们把事件里的真实材料排好序、编 1..N 号给它看，prompt 里一个真实 id 都不给；它只能回数字，内核再把数字翻译回 id 后落盘。回了超范围数字、字符串、重复编号，先带反馈让它重答一次，再错整轮失败，绝不替它猜、绝不允许空锚糊弄。连"话题跳转候选"那个原本能藏幻觉垃圾 id 的字段，也一并改成序号，内核翻译后才许落盘。

四家外审近乎一致地拍了方向（统一序号、就地破契约、独立观测通道、一次性夹具迁移），并帮我们抓到四个自己没堵上的实现缝：①旧解析器会把畸形响应悄悄吞成空数组；②解析若放 writeSummary 里会被既有 try/catch 直接判死、重取根本触发不了；③原文顺序和序号顺序若各排各的，会系统性张冠李戴；④"N=0 合法空选"在现状代码里根本走不到。本文逐条收口。

## 1. 头号裁定：统一序号协议（送审 Q1，采纳方案二）

**裁定**：anchors 与 boundary_candidates.at_pointer_id 统一走 1..N 序号；LLM 线上协议零裸 ULID；内核在 appendVersion 前把两类序号分别解析回 id；真源/契约/投影落盘形状不变（落盘仍是 id 字符串）。

四家全票（评审一高置信、评审二指其违反冻结口径 3、评审三证协议单一性、评审四揭出真实污染通道）。代码实证：

- E-1：`adapters/dsh/llm.ts:267-291` parseBoundaryCandidates 只校验字符串非空，**不做成员存在性校验**——今天模型编一个形态合法的悬空 ULID 填进 at_pointer_id 会永久落真源。方案二顺带关闭这条现存污染通道（评审四的校准成立：严重度低于 anchors，无生产消费者，但是 append-only 垃圾）。
- E-2：`closure.ts:586-598` userPrompt 现状下发裸 id 的唯一用途就是 at_pointer_id 对照；序号化后该对照表整体删除，prompt 改为单列表（见 §6）。
- E-3：C7 fail-soft 纪律不变，只换输入形状；契约字段 `contract/event.ts:116/269/457` 与投影 event-row.ts 透传形状不动。

**验收门槛**：①C7 回归套件证明候选 fail-soft 语义逐条不变（缺字段/坏序号逐条丢、摘要照常落盘、绝不触发重取）；②对完整 request 文本（含重取轮）跑 ULID 形态扫描，零命中（系统生成部分；原文自带的 26 位串是已知残余面，见 §8）；③退回方案一的路已封死——若实施中发现 C7 扩面不可行，必须回本卡重审并显式改写冻结口径 3，不许静默保留 id 表。

## 2. 端口契约：就地破立＋字段改名（Q2）

**裁定**：不设并存期、不开 v2。
- `LLMSummarizeResponse.anchors: readonly string[]` → **`anchor_serials: readonly number[]`**（线上字段改名改类型，编译器替我们清点全部读点）。
- 候选线协议字段 `at_pointer_id: string` → **`at_pointer_serial: number`**（仅线协议改名；落盘字段仍名 at_pointer_id、仍存 id 字符串）。
- `LLMSummarizeRequest` 的 system/user 字符串形状**不变**：重取反馈由内核纯函数渲染进 user 文本（见 §5.2），不新增线协议字段。
- 落盘 EventRecord.anchors / boundary_candidates 字段名与类型零变化。

代码实证（做法 A 前提核验，回应评审一/二/四的待核实项）：
- E-4：src 内消费 LLM 响应形状的仅 `closure.ts:427/433/455` 一处写路径；其余 `.anchors` 命中全部消费 EventRecord 真源字段（memory/ 与 projection/，本就是 id），不受线协议改名影响。
- E-5：`scripts/` 四个脚本无一 import llm-port（grep 零命中）；api/index.ts 与 adapters/dsh/index.ts 均无 LLMSummarize 类型的公共 re-export；不存在仓外消费者，双 tsc 可一次性兜全。
- regenerate=false（她手写摘要）路径走同一调用点、同一解析链，无独立契约面，随本批迁移；其"她的文本＋模型选出处"provenance 语义批 A 已存在，本批不恶化，仅在注释写明口径，不改代码。

**静态门增项**：contract/event.test.ts PRODUCERS 白名单显式登记新增的 serial-table.ts 与 llm-port 字段消费清单；新增一条"LLMSummarizeResponse 消费点全清单"断言，未登记读点拦截。

## 3. 序号模块：event 层新建，解析前移 runTick（Q3，本卡最高优先实现缝）

### 3.1 新模块 `src/event/serial-table.ts`（纯函数、零 IO）
- 职责：`buildSortedMembers`（确定性排序）、`buildSerialTable`（1..N 冻结映射，不缓存不落库）、`resolveAnchorSerials`（fail-closed）、`resolveCandidateSerials`（fail-soft 包装）、strict 整数判定。
- 与批 A 封板文件 `anchor-refs.ts`（L2）并列、不混写：L2 管"给定 id 是否合法成员"，L3 管"枚举与序号映射"；新文件同受零 IO 静态投毒（禁 node:fs/ExperienceLog 实例/readAll）。
- 错误类 **`EventSerialReferenceError extends SchemaError`**，携带 violations 结构化明细（kind/index/safeRaw/legalRange），供反馈与失败明细复用；它必须能被 runTick 与 L1/L2 错误类型区分（重取只捕获它）。

**驳回"复用 MemorySerialReferenceError"**：M6 规则①禁 event→memory 依赖，静态门是活门（批 A 投毒自证）。
**驳回"下沉 src/core/serial.ts 重构"（评审三方案，挂账）**：方向正确但要动 memory/serial.ts、assembly/host-tool-runtime.ts、memory-tools.ts 与 topology 白名单（E-6：serial 现被两个 assembly 文件 import），churn 超出本卡。替代防漂移：**同构属性测试**——一张行为表同时驱动 memory/serial 与 event/serial-table 两套实现（未知抛、非整数抛、不返半截、refusable 语义），漂移即红。core 下沉登记 §10 挂账。

### 3.2 解析时机：前移到 runTick，writeSummary 契约不变（评审二的关键抓错）
- E-7：`closure.ts:289-296` try{writeSummary}catch 直接 failTask。序号解析若放在 writeSummary 内，协议错误会被直接收编成退避失败，**轮内重取在结构上不可能触发**——送审稿原设想在此证伪。
- 定稿控制流：runTick 拿到响应后、sameBoundary 复检之后、writeSummary 之前，先用**本 tick 冻结表**做纯数据变换：anchor_serials→id[]、候选 serial→id/丢弃；协议错误在此捕获进重取分支。writeSummary 仍只收 id[] anchors，**L1/L2 代码与入参形状零改动**。
- 收益兑现：closure 级 L2 夹具无需迁序号（writeSummary 的 id 入参契约还在），批 A 绕过测试天然可复用。
- **同源单实例**：tick 开始构建一次冻结表对象，prompt 拼装、反馈范围、两处序号解析全部引用同一对象，禁止解析时重排/重读/逐 id 点查（E-8：readExperience 点查返回 undefined 表缺失，重读会破坏快照冻结）。对象同一性写进红测。
- **成员缺失 fail-closed（评审四补缝）**：建表时某成员 readExperience 返回 undefined（E-9：ReaderRef 契约 undefined=真源不存在），不得跳过该成员，整事件 failTask、独立 reason `l3-serial-table-broken`；探针只覆盖整库损坏，单成员缺失由建表处自守。

## 4. 严格整数解析细则（Q7）

适配器侧新增严格解析（替换 anchors 路径上的 stringArray 静默 filter；key_points 继续用 stringArray，纪律不变）。统一判定式：字段必须存在且为数组，每元素 `typeof number && Number.isSafeInteger && 1≤v≤N`，无重复。任一不符整份拒绝、不 filter、不半截、不 coerce。

| 输入 | 裁定 | 备注 |
|---|---|---|
| `3.0`/`3.00` | 接受为 3 | JSON.parse 后同值，按值不按词法，契约测试钉死 |
| `3.5` | 拒绝重取 | 非整数 |
| `"3"` | 拒绝重取 | 禁 Number() 宽容转换 |
| 负数/0/N+1 | 拒绝重取 | 越界，反馈带 1..N |
| 重复 `[1,1]` | 拒绝重取 | 与 L1 现状对齐：E-10 anchor-refs.ts:193-201 anchor-duplicate 显式拒收不去重 |
| 显式 `[]` | 形状合法 | 首轮 N>0→abstain 观测；重取轮→失败（§5 R-1）；N=0 走不到 L3（§7） |
| 字段缺失/null/非数组 | 拒绝重取 | 旧 stringArray 把缺失洗成 [] 是静默绕过，必须消灭 |
| 混类型 `[1,"x"]` | 整份拒绝 | 禁止逐条过滤 |
| 超大整数 | 拒绝 | isSafeInteger 前置，范围检查兜底 |
| anchors 任意字符串（含 ULID 形态） | 整份拒绝重取 | 判"非 number 即违约"，不只查 ULID 形态 |
| 候选字段畸形/未知序号 | fail-soft 逐条丢 | 错误代价不对称原则见下 |

**纪律判据写进代码注释与设计正本**：字段纪律由错误代价决定——落 append-only 真源、不可修复的证据链字段 fail-closed；条目可弃、无生产消费者的展示附带字段 fail-soft。未来新增结构化字段必须显式声明纪律与代价依据，不许默认。候选 fail-soft 的边界条件：一旦 at_pointer_id 出现 event-row.ts 之外的生产消费者，fail-soft 立即升级 fail-closed（静态门加读取点守卫）。

## 5. 轮内重取控制流与反馈（Q4）

### 5.1 控制流（冻结口径 5 的实施形状）
1. 首次 summarize 带冻结序号表；只捕获 EventSerialReferenceError 触发重取——UnavailableError/超时/L1/L2 错误均为确定性失败，直接 failTask，不重取。
2. 重取在**同一 tick**：同一冻结表、同一 snapshot、同一 texts；不重跑 probeExperienceStore、不重读 readTexts、不重读 latest/不做第二次 sameBoundary（边界变化一律整轮丢弃不计数，杜绝"用表 A 解析响应 B"）。
3. 二次仍协议错误（含重取轮空选，见 R-1）→整轮 failTask，占 1 次 backlog attempt；重取本身不占 attempts；单事件 LLM 调用上限 2×8=**16 次**，FakeLlmPort 计数红测钉死。
4. **共享 tick 总预算**：tick 预算 = 2×closureCallTimeoutMs（默认 120000ms，与 params.ts 既有 DEFAULT_CLOSURE_ROUND_BUDGET_MS"两个调用超时"惯用语同形，不新增可调参数）；第二次调用只拿剩余时间，剩余不足直接 failTask 不发起重取。否决各自独立全量超时（最坏 tick 翻倍会吃满整个 drain 轮次）。

### 5.2 反馈载荷：内核纯函数渲染、脱敏回显
- 反馈的数据形态为内核侧结构化对象 `{ violations: [{index,kind,safeRaw?}], legalRange:{min:1,max:N}, round:'retry' }`（仅内核内部类型，不进端口契约）；`renderFeedback()` 纯函数用固定模板＋JSON.stringify 确定性渲染成 user 末尾的隔离反馈块，禁止字符串拼接，适配器只接收最终 user 字符串、不参与语义；渲染纯函数独立可测。
- 回显规则（采纳评审一 R-2 与评审三脱敏交叉项）：整数坏值照回显；非整数项**不回显原文**，只给类型级描述（"第 k 项不是整数"）；ULID 形态值替换为 `<id-like value omitted>`；条目数与单值长度设上限，防反馈膨胀/注入回路。不回显合法选择、不做完整回显。
- **R-1 细化（对冻结口径 7 的显式收窄，主控批准）**：**重取轮返回 [] 按协议失败处理**（failTask＋观测 detail.round='retry'），首轮 N>0 返回 [] 仍是合法 abstain。理由：重取发生在"首轮已输出坏序号"之后，此时空选不是内容判断而是对纠错的规避；放行则存在"注入诱导坏序号→重取时空选→无卡闭合"的洗白通道。因此"空数组不被接受"的措辞**只出现在重取反馈块**，首轮 system prompt 永不禁止空数组——评审二/三/四担心的"胁迫硬选"在首轮不成立。

## 6. 确定性排序与 prompt 形状（Q8）

- 排序键：`(occurredAtMs 升序, id 全 ULID 字典序升序)` 稳定全序；同毫秒决胜不是摆设（批量/快速连发碰撞非零）。
- **一次 sortedMembers 派生全部**（评审二头号缺陷缝）：序号表、prompt 原文行、反馈 1..N、锚点解析映射、候选解析映射必须来自同一有序数组；禁止各自遍历 pointers。E-11：现状 userPrompt 原文按 textsOfEvent 遍历序（摄入序），与显式排序混用会导致"序号 k 与第 k 段原文不是同一条经历"，L1/L2 都发现不了。
- prompt 改**单列表**形态：每行固定机器格式 `#i | 发生时间 | 原文`，废除"原文列表＋id 对照表"双列表（方案二下 id 表已不存在，单列表同时消灭错位与伪造对照表向量）；不做 XML 包裹标签（效力不可验证，见 §8）。
- 红测：shuffle 不变性、同毫秒 ULID 决胜、N=0/1 边界、跨 tick 同成员集同表（防有人加 Date.now() 决胜）、prompt 第 i 行与序号 i 解析出的成员同一性。

## 7. 空选与观测体系（Q6），及 N=0 勘误

### 7.1 N=0 勘误（冻结口径 7 修正，三家外审共同指出）
- E-12：closure.ts:209-212 现状 readTexts 返回空数组即 failTask（UnavailableError"事件原文取不到（指针悬空）"），**根本不调 LLM**。"N=0 模型空选是合法 abstain"在现状不可达。
- 定稿：N=0 不进入 L3 选择协议，沿用既有 failTask 进失败缓冲，**不产生任何 L3 观测**；红测钉"N=0 时 summarize 调用 0 次、无 observation 回调"。若未来空 texts 控制流改变，须另卡评审。冻结口径 7 的"N=0 合法 abstain"表述据此勘误为口径性声明。

### 7.2 独立观测通道（四家一致采纳方案②）
- ClosureDeps 增并列可选回调 `onClosureObservation`（与 onClosureFailure 分离；批 A 冻结的"零接口变更"指 readExperience 形状，本回调为本卡明示新增，不溯及既往）；内核同时维护内存环形缓冲（容量沿用 FAILURE_BUFFER_LIMIT 同款常量，不新增持久化面）。
- 观测词表（reason 冻结）：
  - `l3-empty-selection-with-nonempty-pool`（首轮空选，detail 带 n/eventId/round='first'）；
  - `l3-serial-retry`（触发重取，带 violation kinds）；`l3-serial-exhausted`（重取仍败，round='retry'，含重取轮空选）；
  - `l3-candidate-dropped`（候选 fail-soft 丢弃计数，评审一/三/四共同建议，零成本诊断金矿）；
  - `l3-pool-sampled`（每个进入 L3 的 tick 上报 n 与原文总字符数，常设、消费者=M 标定）。
- 静态投毒：src/event 内观测路径出现 node:fs/写投影即拦截；宿主 plugin.ts 仿 onClosureFailure（:329）接 warn 日志，**逐事件 warn、不设代码阈值**；三率（empty_selection/retry/overflow）派生公式与人工阈值进 runbook，不进生产码（与批 A 熔断驳回同口径）。
- 指标口径：empty_selection_rate 分母＝N>0 且发起首次 summarize 的 tick 数（不含重取，避免双计稀释），分子＝首轮空选 tick；另设 retry_round_empty 计数单列（R-1 配套）；overflow 走失败通道不进此率。

## 8. prompt 注入：损害上界与已知残余（Q10）

- **上界修正**（驳回"一次重取浪费"的乐观表述）：越界类注入最坏＝模型稳定遵从→每轮重取皆败→8 tick 共 16 次调用后 permanent pending、真源零追加；合法序号类注入→选中真实成员、结构全合法、零失败落盘——损害与"普通模型选错证据"同级，append-only 但经 correction 可修。
- "被注入选中"与"正常误选"机械上不可区分，接受为**已知残余**：机械闸守完整性（伪造存在性归零），统计审计守质量（R1/R2/诱饵域是其归宿）。设计正本禁止出现"反幻觉已完成"措辞，诚实表述为"不可验证的自由生成被消除，残余错误转入可观测域"。
- 不做 XML 分隔包装（不可验证、`</tag>` 闭合注入反成新洞）；#i 单列表机器格式即全部 prompt 卫生。**驳回评审二的注入模式检测器**：纯函数关键词启发式无标定数据、误报率未知，属统计审计层职责，登记 §10 挂账，不进本卡内核。
- 注入夹具五类（越界 99、合法号操纵、伪造序号表、冒充系统段、反馈回显注入），只断言行为（落盘/重取次数/零追加），不断言模型"理解"。

## 9. 上限 M（Q5）

- **M=64，命名工程期常量 `MAX_SERIAL_POOL_MEMBERS`，禁运行期可调、禁静默截断**。依据：①E-13 分段器已有 maxEffectiveCharsPerEvent=7000 字硬约束，prompt 规模的真实约束是字数且已结构性生效，M 防的是长列表选择质量退化而非上下文爆窗；②v1.4 曾退役 maxRecordsPerEvent=20 硬顶（params.ts 注释在案），M 必须明显高于现实分布以免重演"数据黑洞"，四家建议区间 30–64 取保守高端；③2 的幂便于夹具。
- 双约束说明：评审三建议"成员数＋原文字数"双闸——字数闸已由分段器在源头闭合，本卡不重复造闸，注释写明依赖关系。
- 超限策略（策略 a）：探针之后、readTexts/LLM 之前判定 N>M → 不构造 prompt、零 LLM 调用（红测钉 8 次退避内 summarize=0）、failTask、reason `l3-candidate-overflow`（detail 带 n/m/eventId，进失败缓冲而非观测回调——它是确定性任务失败）；事件保 pending，她可用 correction 拆分后自然通过，不发明立即 permanent 特例。
- 不建 shadow 临时代码：overflow reason 与 l3-pool-sampled 本身就是免费采样器，数据积累后按 P99.9×安全系数经设计正本修订 M；合成压测只验证边界机制（N=M/M+1/拒收/零追加）不标定数值。
- 分段器成员规模治本另卡（§10）。

## 10. 挂账与驳回总表

| 项 | 处置 | 去向/理由 |
|---|---|---|
| serial 协议下沉 src/core 共享 | 挂账 | 本卡用同构属性测试防漂移；下沉动 assembly 白名单，独立重构卡 |
| 注入模式纯函数检测器 | 挂账 | 归统计审计层（R1/R2），启发式未标定不进内核 |
| 分段器成员上限治本 | 挂账（#117 邻近项） | 500 成员事件是分段器失败不是 L3 问题 |
| XML/分隔符包装 | 驳回 | 不可验证、闭合注入新洞；单列表机器格式替代 |
| 反馈"完整回显上次选择" | 驳回 | token/注入面翻倍、纠错价值近零 |
| 双字段并存/summarizeV2/兼容 shim | 驳回 | 无过渡对象的双协议＝永久死面（K9） |
| 分层表/"以上都不是"出口 | 驳回 | 证据可见性静默截断、与 abstain 语义重叠 |
| shadow 拦截模式 | 驳回 | 临时代码面；overflow 观测即采样器 |
| 空选/三率内核自动熔断 | 驳回 | 逐事件 warn＋runbook 人工阈值，批 A 口径延续 |
| 内核自动分段超限事件 | 驳回 | 内核改写真源事件结构属越权，分段是她的修正权 |
| 测试专用内核窄入口 | 驳回 | writeSummary 保留 id 入参后绕测入口天然存在 |
| worker 侧阈值 warn（代码内阈值） | 驳回 | 降级为逐事件 warn＋runbook 阈值，不留运行期魔数 |

## 11. 验收清单（红测先行，变异自证，用例只增不减）

**L3 正向**：①合法序号全链路落 id、JSONL 零裸序号/无 anchor_serials 字段；②request 全文（含重取轮）零系统生成 ULID；③单列表原文-序号同一性；④同实例/跨 tick 稳定性/shuffle/同毫秒四组纯函数；⑤候选序号解析为 id 落盘、坏候选逐条丢不重取；⑥16 调用上限与 attempts 口径；⑦反馈载荷（脱敏、无 ULID、无原文回显、重取轮空选失败）；⑧N=0 零调用零观测；⑨overflow 零 LLM 调用＋零追加；⑩五注入夹具行为断言。
**绕过/变异**：⑪批 A L2 纯函数套件全留（id 入参直注 not-found/cross-channel/out-of-window/duplicate 仍拒收）；⑫变异摘 L2→绕过套件变红；⑬变异摘越界检查/放开 coerce→协议套件变红；⑭strict parser 接管后 stringArray 旧反模式不得在 anchors 路径存活（grep 级断言）。
**工程**：⑮FakeLlmPort 进 tests/helpers（脚本化响应/调用计数/请求全文记录三能力，无默认响应、src 禁 import 投毒）；29 处 anchors 夹具＋11 个假端口一次性迁移、逐条映射留痕、用例只增不减；⑯PRODUCERS 白名单登记 serial-table.ts 与新消费点、静态门 50→只增；⑰双 tsc 0、npm test 全绿、真实数据根零写入。

## 12. 模块改动预告（派工边界，非实现许可）

- 新增：src/event/serial-table.ts；tests/event/task90-serial-table*.test.ts、task90-l3-closure*.test.ts；tests/helpers 内 FakeLlmPort。
- 修改：llm-port.ts（响应类型破立，Request 形状不变）、adapters/dsh/llm.ts（strict 整数解析替换 anchors 路径 stringArray、候选序号解析不入适配器）、closure.ts（建表/前移解析/重取循环/观测/overflow）、api/index.ts（onClosureObservation 接线）、plugin.ts（warn）、params 旁新增 M 常量；contract 白名单与静态门；测试夹具机械迁移。
- 零改动：anchor-refs.ts（L2 封板）、contract 落盘形状、event-schema、投影、memory/serial.ts、correction.ts。
- 任何 git add/commit/push 仍逐次显式授权。
