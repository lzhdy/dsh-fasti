# 任务 #90「写入闸 P2——L2 引用完整性闸 / L3 生产端候选序号反幻觉」立项定稿

> 基线：主干 HEAD `a0dba64`（#42/#119 已推送，1019 tests 全绿，双 tsc 0，静态门 50/50）。
> 前置：L1 形态闸已随 #119 落地（`src/event/closure.ts` writeSummary 内 `assertAnchorsUlid`）。
> 本文件是四份外部评审（共 927 行）回收后的**立项定稿**，方法学沿用 #42：外审无仓库权限，其代码类断言一律回仓核验，核验结论逐条附文件证据；失准意见驳回留证，坐实意见进本定稿。
> 纪律不变：不新增守护进程/定时器/fs.watch/新表/真源字段/生产依赖；git 写操作逐次授权；真实数据根零写入。
> 行号均为 `a0dba64` 时点，实现前重新 grep 校准。

---

## 0. 评审索引

| 编号 | 文件 | 体量 | 风格 |
|---|---|---|---|
| 评审一 | task90-external-review-response.md | 139 行 | 6 项实施前裁定，方案甲乙 |
| 评审二 | 任务90-写入闸P2-L2L3-外部评审意见.md | 250 行 | 最严厉，R1–R14 红测/变异/自我否决 |
| 评审三 | task90-write-gate-external-review-response.md | 338 行 | 方案 B 输入集包含性，P-1/P-2/P-3 |
| 评审四 | task90-l2l3-external-review-opinion.md | 200 行 | 分区不变式，F-1–F-8、V-1–V-6 |

---

## 1. 代码实证结果（外审"待核实"项的终审结论）

| # | 待核实命题 | 实证结论 | 证据（HEAD a0dba64） |
|---|---|---|---|
| E-1 | 摘要模型输入集 == 同通道窗内经历全集？ | **成立，且输入集的精确表述是"事件 pointers 成员集"**。LLM 文本由 `textsOfEvent` 严格遍历 `event.pointers` 产出，不按窗口反查、无截断、无线程过滤；取不到原文的指针走 cue 兜底或跳过，不引入池外材料 | `src/api/index.ts:785-811`（textsOfEvent）、`:254`（注入 readTexts）、`closure.ts:350` buildRequest |
| E-2 | 分区不变式：成员集 ≡ 同通道窗内全集？ | **结构成立**。time_range 恒由成员 occurred_at 的 min/max 派生（分段器生长与修正重算同源）；同通道同时刻只允许一个 open 事件（`otherOpenOnChannel` 硬错），owner 归属索引保证一条经历至多属于一个当前事件；merge/split 保持指针不重不漏（`dedupePointers`） | `segmenter.ts:568-576`、`correction.ts:685-704` rangeOf、`:549-553`、`event-log.ts:248` ownerOf |
| E-3 | 存在"改 time_range/channel 却不重跑"的修正路径吗？ | **不存在**。merge(:322)/split(:391)/reviseBoundary(:451)/closeAndReopen 的闭合侧(:505)全部调 `requestRerun`；merge/split 产出版本 `summary_quality='pending'` 且 anchors 由契约补位为 `[]`；reviseBoundary 虽 `...current` 继承旧 anchors，但同版本置 pending 并立即 requestRerun，rerun 经闭合管线覆写；reopen 不改窗/道，rewriteSummary 不改窗/道 | `correction.ts:292-330、332-405、407-455、461-514、571+、724-726` |
| E-4 | 重启后 pending 是否重扫？attempts 是否持久化？ | **重扫，attempts 跨进程重置**。backlog 纯进程内不落盘；pending 真值在事件真源（`summary_quality='pending'`）；启动清道夫 `sweepPending` 扫"closed+pending+非 her 来源"重新入队，InMemoryBacklog 计数从 1 重新开始。故"permanent"语义是**单进程 8 次**，重启即获新一轮 8 次，不存在静默坟场；另有边界：`source='her'` 的 pending 不被清道夫重摘（防无限重跑），只靠修正当下的即时 enqueue | `closure.ts:281-307`、`backlog.ts:13-57`、`correction.ts:722` 注释 |
| E-5 | 契约时间戳是否强制时区？坏时间戳会不会 NaN 巧合？ | 真源由系统生成（`nowIso/msToIso` 恒为 UTC `Z`），契约 parse 层只做 `requireString`（无 ISO 正则），但唯一换算原语 `isoToMs` 对 `Date.parse` 为 NaN **显式抛 TypeError**，全仓无取反式区间谓词。本定稿主判据改为成员包含性后，L2 运行期**根本不做时间解析**（见 §2），该面进一步收窄 | `core/time.ts:29-36`、`contract/validate-experience.ts:426` |
| E-6 | JSONL 追加方式？尾行截断风险？ | `appendFileSync` 直追加（O_APPEND 语义，无 tmp+rename）。尾行瞬态不可见在 8 次指数退避窗口内可自愈，登记为已知瞬态，不新增加固 | `core/jsonl.ts:81` |
| E-7 | ExperienceLog.get 是线性扫描吗？ | **不是**。维护 `index: Map<id, location>`，has/get 均 O(1)，readAll 才是全量。L2 设计禁用 readAll，O(N²) 不成立；仍按外审建议加静态投毒防复发 | `source/experience-log.ts:73-97` |
| E-8 | #42 reason 码表与 serial 纪律现状？ | drain 侧受控码已含 `anchor-form-invalid / anchor-not-found / empty-anchors / judgment-unapplicable / drain-permanent-tx`（derive.ts:28-30、rates.ts:34-41）；`resolveSerials` 对未知/非整数序号**抛错不静默跳过**，且有 `isSerialRefusable` 一次重取判定，L3 直接沿用该纪律的经历级同构实现 | `memory/derive.ts`、`memory/audit/rates.ts`、`memory/serial.ts:24-36` |

**实证总判断**：外审命中的两个真实增量——①主判据应锚定"模型实际输入集"而非窗口代理（评审三 P-1/方案 B、评审四分区不变式是同一前提的两面）；②修正改窗的继承锚点必须钉死"必 rerun"——在代码里**架构前提已成立、rerun 纪律已存在，缺的是显式不变式测试与定稿文字**，不需要新机制。其余大量"待核实"类担忧（O(N²)、静默坟场、NaN、8 次烧 LLM 等）经证伪或降级。

---

## 2. 头条裁定：L2 主判据改为「输入集成员包含性」，三条件降级为诊断分桶与管线自检

### 2.1 裁定内容

L2 运行期判据**不再以"同通道 + 时间窗闭区间"为主谓词**，改为：

> **anchors ⊆ 本次闭合事件的 pointers 成员 id 集，且每个 id 在经历真源中存在。**

- 成员 id 集就是模型实际被喂给的材料 id 集（E-1）：闸验证的命题从"这条经历在数据上属于本事件时空范围"收紧为"这条经历**进入过本事件的加工管线**"——这正是 provenance 的定义，也让 §5.1"锚点=证据出处"升级为不可被晚餐例子顶回的硬表述：**闸不裁定什么算证据，只裁定模型没有引用它没见过的材料**。
- 原三条件（存在/同通道/闭区间）不删除，分两处保留：
  1. **诊断分桶（只读、不参与放行判定）**：成员校验失败时，用 `readExperience` 尽力取经历，把失败细分为 `anchor-cross-channel`（存在且 channel 不同）/`anchor-out-of-window`（存在且不在 time_range）/`anchor-not-found`（真源不存在）/`anchor-not-in-event`（兜底桶）。分桶只服务观测与维修明细，**任何一桶的判定结果都不能推翻主谓词的拒收结论**；
  2. **管线不变式测试（批 A 红测，非生产闸）**：在合成语料上断言 `pool(channel,time_range) ≡ 事件成员集 ≡ readTexts 输入 id 集` 三者等价（吸收评审三方案 A 的等价性测试 + 评审四 F-3 分区不变式）。将来分段器被改坏，该测试先红；在不变式成立期间，主谓词与三条件数学等价。

### 2.2 为什么这样拍（对评审三方案 B 的修正性采纳）

1. **评审三方案 B 方向正确**，但其设想的成本（"closure 需把输入 id 列表带到 writeSummary，可能要改 readTexts 返回形状"）实证为零：writeSummary 手上本就有 `current` 事件，`current.pointers.map(p=>p.id)` 即是输入 id 集，无需改任何既有签名的返回形状。
2. 评审三宣称方案 B"消灭时钟问题"属实且收益即时兑现：L2 生产路径不解析任何时间字符串，评审一/二/四关于毫秒换算、闭区间、Na`N、取反谓词、时区的争议整体移出运行期（时间相关知识只在不变式测试与诊断分桶里出现，且诊断解析失败显式归入 `anchor-not-in-event` 并打 `time-unparseable` 标记，禁止 NaN 巧合放行）。
3. 同通道约束自动成立且更强：pointer 结构为 `{id 权威, channel 冗余}`（correction.ts:714 注释），同通道单 open 保证成员同通道；跨通道锚点因为不在成员集里必然被拒，且无法通过伪造 pointer.channel 字段绕过（判 id 不判冗余字段）。
4. 评审四担心的"窗内但非成员"假阳性（分段不变式破坏时模型引用没见过的材料）在主谓词下天然被拒；窗口池方案在该场景会误放行。主谓词对未来分段器演进是 fail-safe 的。
5. 与 L3 天然同构：批 B 候选序号表 = 成员集的确定性序列化（见 §7），"候选表"与"包含集"是同一个对象，两批之间不存在漂移面。

### 2.3 驳回与保留

- **驳回"第四条件（经历状态）"**（四家共识或不反对）：契约无字段、加字段违反冻结面；写时校验语义下未来退役不应追溯使既有证据失效；若将来要"经历失效"，正确形态是 append-only 真源新记录类型，独立立项。
- **驳回评审二的 ExperienceLite[] 纯快照注入形状**：快照需要缓存一致性纪律且仍要一个读取口兜底存在性，复杂于直接窄接口；采纳其"闸核心为纯函数、禁 import node:fs/ExperienceLog、禁缓存"的静态约束，不采纳快照数据形状。
- **驳回评审三的 `enumerate(channel,from,to)` 预留**：实证 L3 候选源是事件成员而非窗口查询，批 A 不预建未用方法（K9），批 B 也不需要窗口枚举口（详见 §7）。

---

## 3. 十问逐条裁定

### Q1 候选池三条件完备性 / 第四条件
按 §2 裁定：成员包含性为主判据，三条件降级，第四条件否决。另增**重复锚点显式裁定**（评审一 R5、评审二、评审四 F-4 三家收敛）：同一 ULID 在 anchors 出现多次 → 显式拒收，reason `anchor-duplicate`，**禁止静默去重**（去重等于改写模型输出）；[] 仍按 #42 裁定合法放行（空锚=abstain）。

### Q2 证据链 vs 语义关联 / 全局 FTS
论证成立并采纳评审三的更硬表述替换措辞（闸验证"没引用没见过的材料"，不做本体裁定）。两项必须写进正本：
- **负担转移声明**：跨通道语义连续性由全局 FTS 召回承担，质量取决于检索 k 值与融合策略，这是有意识的补偿机制，不是锚点闸的副作用；
- **空锚语义唯一性**：空锚 ⇔ 确实无证据，任何路径不得把失败洗成空锚（与 Q3/Q8 同源承重墙）。
未来"事件 B 显式接续事件 A"仍走独立字段+冻结面评审，校验只能是机械身份事实。

### Q3 闸位 / 错误类型 / 禁剥锚 / 失败分类
- 闸位：L1 之后、appendVersion 之前、**writeSummary 的 try/catch 之内**（评审三漏洞 1）。新增回归红测：L2 拒收时 backlog `nextAttemptAtMs` 严格递增、无紧密重循环（#119 修过 L1 同款 bug，错误类型不同必须独立钉）。
- 错误类：`AnchorReferenceInvalidError extends SchemaError`，与 L1 的 AnchorFormInvalidError 并列、可重试；注释写明"SchemaError 在此是可重试标记，不代表数据永久不可修"。
- 错误 detail 结构化（评审三漏洞 2）：`{ reason, anchor, expected, actual, channel?, window?, deltaMs?, note? }`，**零经历正文/摘要正文**（评审四 3b），消费者为观测分桶、重试反馈、事后诊断。
- **禁剥锚空锚降级：采纳，写成规范句**。部分有效（四锚三真一假）的唯一修复是整份重跑，禁止外科手术式改写。
- 基础设施错误分类（评审二 R3、评审三漏洞 3、评审四 F-1）：读取口抛 CorruptedError/读取器不可用时，**独立 reason `experience-store-broken`，禁止吞成 not-found**，原样上抛走 failTask 退避。**驳回"env-broken 不调 LLM"的专门重试状态机**：runTick 实证先 `readTexts` 后 `port.summarize`（closure.ts:194-220），读取侧损坏在调 LLM 之前就抛错，后续重试每轮都止于 readTexts，最多烧掉当轮 1 次 LLM 调用；新增失败类别计数/跳过逻辑违背最小面且引入有状态分类。红测钉死：损坏夹具下 LLM 端口 spy 调用次数为 0（首轮后）、真源零追加、错误类型不被归类为 anchor 类。
- 评审二 R11"基础设施错误不推进耗尽计数"**驳回**，同上理由；指数退避本身已限频，attempts 语义保持单一，不引入第二套计数。

### Q4 窄接口形状（四派分歧的拍板）
**收敛为单方法窄接口，复用既有适配器形状（采纳评审四，吸收评审一/三的窄化理由）**：

```ts
// src/event 侧声明，不泄漏 ExperienceLog 整体
interface ExperienceReader {
  readExperience(id: string): { id: string; channel: string; occurredAtMs: number } | undefined;
}
```

- 构造点 `api/index.ts:264-266` 已存在同形匿名适配器（EventCorrector 在用），L2 直接复用，接线一行；Ref 只含 id/channel/时间，**不含正文**（评审三 H7 姊妹风险）。
- 同步签名（has/get 现状同步）；按 anchor 逐个点查 O(1)（E-7），**禁 readAll**，以静态投毒测试钉死（闸模块 import ExperienceLog/node:fs/readAll 标识符即红）。
- 不做评审一的 `get→{channel,occurredAt}` 异形命名（与现有 readExperience 统一）；不做评审三双方法接口；不做评审二快照数组。
- 批 B 不新增窗口枚举口（§7），本接口即为最终形状，批 B 零接口变更。
- 纯函数核心放在事件层新文件（建议 `src/event/anchor-refs.ts`），表驱动、零 I/O，reader 作为依赖注入，测试直接用 Map 构造夹具。

### Q5 correction 旁路（四家共同命中的真实洞）
实证结论 E-3：结构上无洞（改窗/改道必经 rerunner），但**无测试即等于没钉**。批 A 交付：
1. **六处 appendVersion 用途清单写进正本**（本文件 §6.3 已给骨架，实现时逐处核对注释化）；
2. 红测 T-a：六类修正逐一夹具，非 rerun 产出版本 anchors 与当前版本 deep-equal（继承性钉子）；
3. 红测 T-b：rerun 产出锚点必经 L1+L2（坏锚样本经 rerun 被拒/闸 spy 断言）；
4. 红测 T-d（不变式钉子，评审三/四独立命中）：**任何改变 time_range 或 channel 的修正必须走 rerunner**——非 rerun 路径产出版本断言窗/道不变；构造 split/reviseBoundary 后继承锚点越窗的夹具，断言其以 pending 落盘且 rerun 覆写，投影在 ready 前不可见；
5. **类型级护栏（采纳评审三推荐项）**：全部修正 Input 类型 `Omit<..., 'anchors'>`，未来有人加 anchors 字段编译期即错；
6. 静态门：沿用 `tests/contract/event.test.ts:383` anchors 无消费者红线的登记表机制，correction 保持"全文件无 anchors 标识符"静态断言；同文件增 appendVersion 调用方白名单（closure＋correction，评审四 3c 可选项，成本极低，采纳）。
- **驳回在 appendVersion 存储原语加运行时语义闸**（四家自我否决一致）：存储层不持有经历读取器、不应决定证据语义；共享 `finalizeVersion()` 入口列为未来调用点扩散后的既定去向，写迁移触发判据（appendVersion 写者 >2 时 L1/L2 下沉契约 write-parse 或共享闸）。
- 评审一方案乙（correction 继承路径跑 L2）驳回：E-3 证明 pending 版本非权威且必被 rerun 覆写，加闸面翻倍只堵一个已被不变式排除的场景。

### Q6 时间口径
- 统一毫秒、闭区间、不追溯历史：三条件降级后这些不再是 L2 运行期规则，转为：①诊断分桶内的比较规则（闭区间，isoToMs 严格解析，解析失败显式标记不折算）；②不变式测试的断言口径。
- 闭区间的硬理由保留记录：time_range 由成员 min/max 派生，首尾成员恰落在边界上，开区间会稳定误杀最常见合法锚点。
- `occurred_at` 是时点而非区间的假设写进契约注释（未来区间语义需改区间重叠判定）。
- 评审四 6.3 的条件性绕闸漏洞由 T-d 红测封堵（见 Q5）。

### Q7 permanent 观测与解救
- **观测落点裁定（纠正送审稿"投影观测"措辞）**：L2 拒收发生在写之前，事件无新版本、保持 pending，#42 drain/投影侧**看不到**这类失败；事件层向投影层写观测违反 M6 规则①且永久失败事件真源零追加。定稿落点：①结构化错误 detail 进既有闭合失败内存明细；②经既有 `onClosureFailure` 宿主回调输出结构化日志（plugin.ts:329 已有 warn 通道，扩展字段而非新通道）；**不新增表、不新增投影文件、不写记忆投影**。reason 直方图由离线日志/harness 派生，近零成本。
- reason 词表与 #42 同词表（E-8）：`anchor-duplicate / anchor-not-found / anchor-cross-channel / anchor-out-of-window / anchor-not-in-event / experience-store-broken`，全部 anchor- 前缀；空锚率沿用 `empty-anchors`。
- **解救路径**：不建离线新工具。已存在的合法路径：重启清道夫重扫给新一轮机会（E-4）；她 correction→rerun 重发即修复（评审四立场，采纳——评审三"correction 救不了从未闭合事件"的说法对**直接 correction 追加版本**成立，但 requestRerun 重跑闭合正是为无版本事件设计的修复入口，实证存在，驳回该论点的悲观结论；同时把该入口形态写进正本消除歧义）。
- **驳回评审三的 50% 熔断阈值自动开关**：需要新状态位与扩面控制面，超出本卡最小面。替代：reason 分桶结构化日志 + runbook 挂账（cross-channel+out-of-window 占比异常时人工暂停扩面复核候选池定义），阈值常数不进生产码。
- 永久 pending 终态定义写死：单进程 8 次后退避停止、事件保 pending、真源零追加；跨重启由 sweepPending 重新入队、attempts 重置（E-4）；her 来源 pending 不被清道夫重摘的既有边界一并记录。
- 评审三第四节第 1 条"空锚三分处理落点悬案"：以 #42 定稿 `task42-runtime-autocard-final-spec.md` 既有裁定为准，本卡不重开；本卡只坚守空锚语义唯一性。

### Q8 L3 独立成批 / 一次重取 / 禁空锚
分批同意，接口在批 A 一次性定稿（§3 Q4），批 B 零接口变更。批 B 冻结口径见 §7。轮内 1 次即时重取**不计入 backlog attempts**（评审三主张，采纳——backlog 计的是闭合轮次，轮内重取本就不进 retry；单事件 LLM 调用上限 2×8=16 次写进成本声明，评审二接受该有界上限）。反馈载荷只含非法序号、合法范围 1..N、非法原值，**不含裸 ULID**（评审三/四一致）。二次仍败整轮失败、真源零追加，禁空锚降级。

### Q9 L1 不搬迁
同意不搬。采纳评审三/四的触发判据书面化：出现第二个 anchors 写入路径（非闭合、非修正继承）或 appendVersion 写者 >2 时，L1/L2 以下沉契约 write-parse 或共享 finalizeVersion 方式覆盖；反对现在双写（两处断言同一规则是新不一致源）。L1 既有测试文件留在 tests/memory 不搬。

### Q10 未覆盖失败模式（四家 F 系列的归并处置）
| 失败模式 | 处置 | 归口 |
|---|---|---|
| 晚到经历/快照漂移（评审三 F-1、评审二 Q10-3） | 主谓词用事件当前 pointers 而非实时窗口池，模型输入与闸同取 current 版本；boundarySnapshot 过期丢弃纪律已在 | 设计天然覆盖，加注释+红测 |
| 基础设施错误烧 LLM（评审三 F-2） | 证伪至多 1 次，见 Q3 | 红测+文档 |
| 重启丢 backlog（评审三 F-3、评审四 F-7 相关） | E-4 已明确，补重启语义红测 | 批 A 红测 |
| 重复锚点（评审四 F-4） | `anchor-duplicate` 拒收 | 批 A |
| 空锚率/系统性退缩（评审三 F-5、评审二最大洞） | 批 B 落非静默 abstain 观测（§7），批 A 不预建 | 批 B |
| 修正改窗继承（评审三 F-6、评审四 F-5） | T-d 红测 | 批 A |
| JSONL 尾行截断（评审四 F-2、评审二 Q10-7） | O_APPEND 实证，退避自愈，文档登记 | 文档 |
| 修正重跑她侧反馈（评审四 F-7） | 既有 onClosureFailure→宿主日志通道；红测断言 rerun 被拒时失败明细可达且真源零追加 | 批 A 红测 |
| L3 prompt 注入（评审四 F-8、评审二 Q10-4） | 序号协议+fail-closed 把损害上界压到一次重取；批 B 夹具收录注入用例 | 批 B |
| channel 字面量伪造（评审二 Q10-6） | 判 id 不判冗余 channel 字段，伪造面不存在 | 文档说明 |
| 冷备不可恢复运行态（评审二 F-4 冷备论点） | 冷备含 34 个悬空坏锚点、builder 零产物硬失败，只能审计查看不能恢复投影，写进总设计 11.x 挂账；物理删除仍待授权 | 挂账 |

---

## 4. 评审意见处置总表（驳回项留证）

### 4.1 采纳/部分采纳（进实现或文档）
- 评审一：R1 重复锚点拒收、R2 失败 reason 分类、R3 零正文明细、R4 改窗必 rerun 红测、R6 红测先于生产码、方案甲（改窗强制 rerunner，实证已存在补红测）。
- 评审二：R1 红测先行纪律、R4 纯函数+静态投毒、R5 变异自证、R6 白名单显式登记+投毒自证（措辞修正为"零隐式增项"，本卡显式登记 1 项 anchor-refs.ts）、R7 零正文、R8 重复锚点拒收、R9 序号冻结/整数解析/无裸 ULID/规模上限（转批 B）、R10 非静默 abstain（转批 B）、R12 事件层观测落点（其新建观测文件的形状驳回，落点裁定见 Q7）、R13 修正不碰 anchors、R14 红测清单。
- 评审三：P-1 方案 B 主判据（修正性采纳，见 §2）、P-2 事件级隔离与 drain 防线保留、P-3 reason 分桶（熔断自动开关驳回）、漏洞 1/2 全部、Q5 类型护栏、Q8 重取不占 attempts/反馈无 ULID、F-1 快照同版本、F-3 重启语义、F-4 重复锚点、迁移判据。
- 评审四：分区不变式测试、单方法 readExperience、T-a/T-b/T-d 红测、reason 码同词表、F-1 损坏传播、F-8 注入用例转批 B、V 系列自我否决全部认可、批 B 无裸 ULID/序号确定性、L2 验收双拆建议（转批 B 验收）。

### 4.2 驳回（附实证理由）
| 被驳条目 | 来源 | 驳回依据 |
|---|---|---|
| 三条件保留为主判据（方案 A 仅补等价测试） | 评审三退路、评审四原案 | E-1/E-2 下成员谓词与三条件等价但更 fail-safe、零成本且消灭运行期时间解析；三条件降为诊断+测试，方案 A 要求的等价性测试以更强形式保留 |
| env-broken 不调 LLM 的重试状态机 | 评审三漏洞3 | E-1 执行序：readTexts 先于 LLM，损坏轮根本到不了 LLM；新状态机违背最小面 |
| 基础设施错误不推进耗尽计数 | 评审二 R11 | 引入第二套有状态计数；退避已限频，重启语义已提供恢复 |
| 50% 熔断自动暂停开关 | 评审三 Q7 | 需新状态位/控制面超卡；改 runbook 挂账 |
| ExperienceLite[] 快照注入+禁缓存快照形状 | 评审二 Q4 | 窄接口直读 O(1) Map 已无缓存问题；纯函数静态约束采纳，数据形状驳回 |
| ExperiencePoolReader 预留 enumerate | 评审三 Q4 | L3 候选源是事件成员，窗口枚举口永不被调用，K9 |
| readCandidates 进 source 层 | 评审一备选、评审四否决 | 窗口语义属事件域；成员集已在 closure 手上 |
| appendVersion 加运行时锚点闸 | 评审一方案乙倾向、三家自我否决 | E-3 无真实洞、存储层分层破坏、pending 非权威 |
| correction 能/不能解救 permanent 的悲观表述 | 评审三 | requestRerun 即为无版本事件的重跑修复入口，实证存在 |
| 永久失败=静默坟场的暗示 | 评审二 Q10-2 | sweepPending+宿主日志+pending 真源态三重可见（E-4） |
| O(N²) 风险隐含需要有界枚举 | 评审三 Q4 | index Map O(1) 实证（E-7）；静态禁 readAll 作为防复发保留 |
| 测试目录随 L1 放 tests/memory | 评审二 | L2 是事件层闸，新测试落 tests/event/task90-*.test.ts（评审四主张，采纳）；L1 旧文件不搬，一行注释说明历史缘由 |
| 新建投影侧观测台账/JSONL | 送审稿原措辞、评审二文件形状 | M6 规则①+真源零追加；走 onFailure 宿主结构化日志 |
| 离线重放新工具 | 评审三可选 | sweepPending 已是该入口；新人工入口与人工通道删除方向相悖 |

---

## 5. 批 A（L2）定稿设计

### 5.1 新增/改动面（最小面）
1. 新增 `src/event/anchor-refs.ts`：纯函数核心（零 I/O、零 fs/ExperienceLog import，静态投毒守护）：
   - `assertAnchorRefs(anchors: readonly string[], memberIds: ReadonlySet<string>, reader: ExperienceReader): void`
   - 内部顺序：L1 已过形态 → 重复检测（anchor-duplicate）→ 逐点存在性与成员判定 → 失败抛 AnchorReferenceInvalidError（detail 结构化、零正文）；诊断分桶为纯辅助函数 `classifyAnchorFailure(...)`，时间解析失败显式标记不吞。
2. 新增 `src/event/anchor-errors.ts`（或并入 anchor-refs.ts）：AnchorReferenceInvalidError extends SchemaError，reason 字面量联合类型与 #42 词表对齐。
3. 改 `src/event/closure.ts`：ClosureDeps 增 `readExperience`（窄接口）；writeSummary 在 L1 之后、appendVersion 之前、try/catch 之内调用 assertAnchorRefs，memberIds 取 current.pointers；AnchorReferenceInvalidError 走既有 failTask。
4. 改 `src/api/index.ts`：复用 :264 既有匿名适配器形状注入 ClosureDeps（一行接线，不新写适配逻辑）。
5. 改 `src/event/correction.ts`：全部修正 Input 类型 Omit 'anchors'（类型护栏）；不引入运行时闸。
6. 测试 `tests/event/task90-*.test.ts`（新目录落点）；静态门两处登记：tests/contract/event.test.ts PRODUCERS/消费者登记表显式加 anchor-refs.ts 并配投毒自证；appendVersion 调用方白名单。
7. 零新表、零真源字段、零新依赖、零投影写入。

### 5.2 reason 词表（冻结）
`anchor-duplicate`、`anchor-not-found`、`anchor-cross-channel`、`anchor-out-of-window`、`anchor-not-in-event`（含 time-unparseable 标记位）、`experience-store-broken`。L1 既有 `anchor-form-invalid` 不动。全部 detail 零正文。

### 5.3 失败语义（冻结）
- 模型可修类（anchor-*）：failTask 指数退避，最多 8 轮/进程，轮内不做 L3 式重取（批 B 才有）；耗尽出队、事件 pending、真源零追加。
- 环境类（experience-store-broken）：同样 failTask 退避（限流），reason 独立、不上 LLM（执行序保证）、不吞类。
- 重启：sweepPending 重扫给新 8 轮；her 来源不重摘（既有边界文档化）。
- 任何失败禁止剥锚/空锚/占位版本。

### 5.4 观测（冻结）
闭合失败内存明细 + onClosureFailure 结构化字段（reason/anchor/expected/actual/deltaMs），宿主日志落地；不新增持久化面。离线 harness 从日志派生 reason 直方图与 empty_selection/空锚率。

### 5.5 不变式文档回写
- mechanism-design / architecture-design-spec 11.x：L2 主判据命题、分区不变式、重启/permanent 语义、冷备审计-only 挂账、熔断 runbook（人工阈值不进代码）、occurred_at 时点假设。
- 六处 appendVersion 用途清单作为正本附录（实现时逐处核对制表）。

---

## 6. 批 A 红测与变异自证清单（TDD 任务书骨架）

1. 纯函数表驱动：合法成员锚点全通过；[] 放行；not-found/cross-channel/out-of-window/not-in-event/duplicate 各一红测；detail 字段精确断言、零正文断言。
2. 分区不变式：合成语料每个事件成员 100% 通过闸；`pool ≡ 成员 ≡ readTexts 输入 id` 三方等价断言；构造窗内非成员样本，主谓词拒收（证明比三条件更严）。
3. 管线回归：L2 抛错在 try/catch 内，nextAttemptAtMs 严格递增无紧密循环（#119 同类回归）。
4. 损坏传播：CorruptedError 夹具→reason=experience-store-broken、真源零追加、不被吞成 not-found、后续重试 LLM spy 零调用。
5. T-a/T-b/T-d correction 三测（继承 deep-equal、rerun 过 L1+L2、改窗/改道必 rerun、pending 版本投影不可见）。
6. 类型护栏：修正 Input 出现 anchors 字段编译失败（tsc 红测形态）。
7. 重启语义：模拟 backlog 丢失后 sweepPending 重新入队、attempts 重置；her 来源不重摘。
8. 静态门：消费者登记表+1 投毒自证（未登记文件读 anchors 必红）；anchor-refs.ts 禁 import node:fs/ExperienceLog/readAll 投毒；correction 无 anchors 标识符；appendVersion 白名单。
9. 接线测试：api 构造点窄接口注入、Ref 无正文字段（类型层断言）。
10. 变异自证（沿用 #42 MU 纪律）：至少三变异——①成员谓词反转为窗口池谓词（窗内非成员夹具变红）；②detail 吞掉 reason（分桶断言变红）；③catch 块把 AnchorReferenceInvalidError 降级为空锚落版（零追加断言变红）；每变异只红目标用例、副本零残留。

---

## 7. 批 B（L3）冻结口径（本卡只冻结不实现，独立立项评审）

1. 候选序号表来源 = 闭合事件 pointers 成员（与 L2 同一对象），排序确定性：occurred_at 升序、ULID 决胜；同输入同表。
2. 请求时快照冻结：一次闭合尝试内序号表算一次、冻结，轮内重取复用同表，禁止响应回来后重算。
3. prompt 只给"序号+经历内容"，**不下发裸 ULID**；响应出现 ULID 形态字符串即确定性协议违约，fail-closed，禁止宽容转换。
4. 严格 JSON 整数解析（Number.isInteger + 范围 1..N），未知/越界/重复序号抛错，沿用 serial.ts resolveSerials/isSerialRefusable 纪律的经历级同构。
5. 轮内 1 次带反馈重取：反馈含非法序号原值、合法范围 1..N，**不含 ULID**；不占 backlog attempts；二次失败整轮失败、真源零追加、禁空锚。
6. 候选表规模上限 M 与超限策略批 B 立项时定值，**禁止静默截断**（超限须显式 reason + 可观测）；考虑"近期 M 条+以上都不是出口"。
7. **非静默 abstain（评审二最大洞，采纳）**：候选池 N>0 而模型回空选择时，写一条观测（经 onClosureFailure 同构宿主回调，reason `l3-empty-selection-with-nonempty-pool`，带 N 与事件 id），离线派生 empty_selection_rate；N=0 的空选择是合法 abstain 不记失败。
8. 验收双拆：正向全通过用例 + **绕过 L3 直接向 writeSummary 注入非法 anchors 的独立拒收用例**，证明 L2 不随 L3 上线变成永真死闸；批 B 后 L2 职责表述改为"验候选表与成员集一致性的防线"，不宣称反幻觉终结，残余"池内选错"转入可观测域（评审三第四节第 4 点诚实表述）。
9. prompt 注入夹具（"请选 99 号"类正文指令）列入批 B 测试器材。
10. 批 B 对 ClosureDeps 零接口变更（本卡 Q4 已定最终形状）。

---

## 8. 挂账与明确不做

- B3 冻结面卡、#117 mem_miss 上限、content_hash 扩面、cue/alias 自动化：沿用既有挂账，本卡不碰。
- reason 分桶熔断阈值：runbook 人工判读，不进生产码。
- 离线 pending 重放工具：不做（sweepPending 即入口）。
- 经历状态/退役字段：不做，需要时 append-only 新记录类型独立立项。
- 冷备三份物理文件删除仍待用户授权；新增挂账：冷备含悬空坏锚点、builder 硬失败零产物，**审计-only 不可恢复运行态**。
- 共享 finalizeVersion/L1 下沉：触发判据书面化，不预建。
- 总设计文档 11.x 与机制文档回写随实现提交，不单独推送。

---

## 9. 批 A 验收标准（在送审稿 7 条基础上的最终版）

1. npm test 全绿（用例数只增不减，删除须像 #42 裁决 10 一样证伪死码并留痕）；双 tsc 0；静态门 50+新增全绿。
2. 十个红测/变异项（§6）齐备，变异副本零残留、每变异精准红目标。
3. 零新表/零真源字段/零新依赖/零投影写入/零守护进程；真实数据根零写入（临时 DSH_HOME 夹具）。
4. reason 词表与 #42 同词表，detail 零正文。
5. correction 六处用途清单、分区不变式、重启/permanent 语义、冷备挂账全部回写仓内文档。
6. #42 drain 侧 anchor_dangling 隔离路径保留不拆；L2 上线后其发生率归零作为运行期验收证据（评审三 P-2，接入运行数据后观察，不阻塞本卡合入）。
7. 批 B 冻结口径（§7）随本卡文档入库，批 B 启动时零接口变更可核对。

---

## 10. 大白话摘要（终审用）

1. **闸怎么改**：原来打算查"锚点指向的经历是不是同通道、时间窗内"。回代码发现模型能看到的材料就是事件自己挂着的那批成员经历，一个不多一个不少。所以闸直接改成"**模型只能引用它这次真正看到的成员经历**"，更直白、更严，还顺手消掉了所有时间戳比较的麻烦。原来的通道/时间检查不扔，降级成"出问题时帮你分清是哪类错"的诊断，外加一条测试专门守住"成员=窗口内全部经历"这个架构前提。
2. **四家都 independently 指出的真洞**：她手动合并/拆分/挪边界后会重算时间窗，旧锚点可能对不上新窗。代码里这些操作其实都已经会触发重跑，缺的是把这条纪律用红测钉死、再加一道编译期护栏让以后谁都没法给修正接口塞锚点。
3. **几个被证伪的担心**：读经历有 Map 索引不是全库扫描；重启后会自动重扫 pending、重试次数刷新，不会静默烂尾；真源损坏时在调大模型之前就报错退避，不会白烧 8 次模型；坏时间戳现有原语本来就显式抛错，且新闸压根不比时间。
4. **观测不碰投影**：L2 拦住的失败事件连新版本都没有，记忆投影天然看不见，也不许让事件层往投影里写东西；失败明细走内存+宿主日志，离线再统计，不建新表。
5. **批 B（选择题反幻觉）**：先把规矩冻结——候选表就用成员集、请求内冻结、prompt 里不给真实 id、模型空选但候选非空要留痕、反馈里不许出现真实 id、上限不够不许偷偷截断。
6. **接口之争拍板**：就用仓库里已经存在的一个单方法小接口（按 id 读经历，只回 id/通道/时间不回正文），不提前造没人用的枚举方法，批 B 也不用再改接口。
