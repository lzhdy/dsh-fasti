# #90 写入闸 P2（L2/L3）外部评审送审材料

> 版本：2026-11-15 送审稿
> 评审对象：任务卡 #90「写入闸 P2——补齐 L1/L2/L3 三层写入校验，非法经历挡在正本外」的**剩余批次 L2/L3**（L1 已作为前置卡 #119 落地）
> 阅读方式：本文自包含，不需要访问代码仓库即可评审；所有代码引用均给出文件路径与行号口径（基于主干 HEAD `a0dba64`，全量 1019 tests / 1019 pass / 0 fail）。
> 请评审者输出：逐条结论（同意／反对／存疑）＋理由＋若反对请给出可替代的具体设计，不要只给方向性意见。

---

## 1. 背景：为什么需要这张卡

### 1.1 病史：悬空锚点是怎么来的

系统在一段对话闭合时，由 LLM 产出事件摘要，其中包含 `anchors`（锚点）数组——语义是"本事件依据的原始经历记录 id"。经历 id 的合法形态是 26 位 Crockford ULID。

历史上 LLM 并不稳定输出 ULID，会写出 `web_search` 之类的自由文本语义标签、缩写、汉字标签。这类锚点：

- 形态上不是 ULID，引用完整性上指向不存在的记录（"悬空锚点"）；
- 一旦写进**真源**（append-only JSONL，只追加、不可原地改），即永久不可修复；
- 下游投影构建时在悬空锚点上硬失败，只能靠人工 remap 脚本补救（该人工通道后来已整体删除）。

空白重启前的真实数据里有 7 个事件版本携带 34 个语义标签悬空锚点、1 个空 anchors 事件。2026-11-15 真实数据根已整体清零（冷备留存可回滚），**存量问题消失，但增量复发条件仍在**：在写入闸全部落地前，摘要 LLM 仍可能产出自由文本锚点。

### 1.2 前置卡 #119（L1 形态闸）已随 #42 落地

#42「记忆卡运行期建卡通道」实施时，把三层闸中的 L1 切片独立取号 #119 提前落地（理由：append-only 真源不可修复，#42 的自动建卡批次不得早于形态闸）。当前状态：

- L1 已上线、全绿（8 个测试用例、23 条断言）；
- #42 已实现完成并推送（HEAD `a0dba64`）；
- **#90 本卡的剩余范围是 L2（引用完整性闸）与 L3（生产端反幻觉）**。

### 1.3 本卡要达成的目标

在"写进真源的大门口"分层设防，使未来 append 的每个事件版本满足：

1. 每个 anchor 形态合法（L1，已完成）；
2. 每个 anchor 指向的经历真实存在、属于同一通道、发生时间落在本事件时间窗闭区间内（L2，本卡批 A）；
3. 生产端从机制上无法自由生成 id，只能在系统下发的候选序号内选择（L3，本卡批 B，拟独立评审）。

---

## 2. 术语与数据模型（评审前置知识）

| 术语 | 含义 |
| --- | --- |
| experience（经历） | 最小原始记录，单通道、单条，有全局唯一 ULID `id`、`scene.channel`、`occurred_at`（ISO 字符串）。存于真源 `experiences/` JSONL |
| event（事件） | 同一通道一段连续对话切分闭合后的聚合单元，有 `channel`、`time_range.{started_at,ended_at}`、版本号 `version`、`anchors: string[]`、`summary` 等。存于真源 `events/` JSONL |
| anchor（锚点） | 事件版本上的字段，**证据指针**：标注本摘要所依据的经历 id。它不是"话题关联"或"联想"（详见 §5.1） |
| 真源（source of truth） | L1 层 JSONL，append-only，单写者队列；冻结面，schema 不允许加列 |
| 投影（projection） | L3 层 SQLite（可降级 JSONL），由真源确定性派生，可整体丢弃重建；含记忆卡表、FTS5 全文索引、别名表等 |
| 记忆卡（memory card） | 投影内从闭合事件确定性派生的检索单元，带 channel、时间窗、cues/aliases/discriminator 等检索词 |
| 通道（channel） | QQ／微信／网页／语音等交流渠道。事件与经历都归属单一通道；**所有通道的卡汇入同一个投影库与同一套 FTS 索引，召回不按通道隔离** |
| 闭合慢路径 | 后台 worker：摘成熟事件 → 调 LLM 出摘要 → 校验 → `appendVersion` 落真源。失败进 backlog 退避重试 |
| backlog | 闭合失败的内存重试队列（进程内、不落盘），`RETRY_MAX_ATTEMPTS = 8`，耗尽标 permanent 出队、事件保持 pending |
| ULID | 26 位 Crockford Base32 编码的全局可排序 id；项目内有纯函数 `isUlid()` |

关键不变式：

- **双模解析惯例**：契约解析器有 write/read 两模式。write 模式 fail-closed 严格拒收；read 模式宽容（旧数据、未来版本字段可读）。新闸只约束未来 append，不得把读取历史真源打爆。
- **对话链路依赖方向（M6 规则①）**：L6 宿主→API→L2 事件链路不得 import 记忆层 L4/L5。反向（事件层读真源层）是合法依赖方向。
- 不新增生产依赖、不新增表、不新增定时器/守护进程、不新增真源字段。

---

## 3. 现状实证（均已回代码核对，HEAD `a0dba64`）

### 3.1 L1 形态闸（已落地，供评审者判断 L2 如何与之衔接）

- 落点：`src/event/closure.ts:382`，`writeSummary()` 内、`appendVersion` **之前**调用模块内函数 `assertAnchorsUlid(response.anchors)`（定义于同文件 :611）。
- 失败类型：`AnchorFormInvalidError extends SchemaError`（同文件 :95）。非数组／非字符串元素／形态不符整批拒绝，不写半份。
- 空数组 `[]` 放行（#42 定稿裁定：空锚是合法 abstain"暂无可引用经历"，下游按空锚三分处理）。
- 失败路径已包 try/catch 走 `failTask`（:421）：退避重试，`attempts >= 8` 记 exhausted 出队，事件保持 pending，真源无新版本。这是 #119 实施期修复的一个中危缺陷（此前 `writeSummary` 在 try/catch 外，坏锚点会抛穿管线造成 backlog `nextAttemptAtMs=0` 紧密重循环）。
- 测试：`tests/memory/task42-l1-closure-ulid.test.ts`，8 用例 23 断言，含投毒样本（自由标签／缩写／汉字标签全拦）、合法 ULID 零误伤、空数组放行、失败三态（失败明细含坏锚点原值／退避时间戳推进／耗尽出队且真源无新版本）。

### 3.2 投影侧既有的悬空硬失败（L2 的近亲，但在另一层）

`src/memory/builder.ts:310-328`：构建记忆卡时对来源事件每个 anchor 做 `isUlid`＋真源存在性校验，不通过即抛 `MemoryAnchorDanglingError`、**零产物**。

评审要点：这是投影侧（派生层）的兜底，不是写入侧（真源层）的闸。坏数据此时已经进了真源，只是污染不到投影。L2 要把同一类校验前移到写版本之前，并多出"同通道＋时间窗"两个投影侧没做的条件。

### 3.3 修正路径（correction）旁路核查结论

提案曾担心 `src/event/correction.ts` 的锚点刷新成为"闭合被拦、修正能写"的旁路。现状核查：

- `EventCorrector` 有 6 处直接 `this.log.appendVersion(next)`（:449/:477/:504/:587/:621/:679），但**全部通过 `...current` 继承既有字段，全文件不出现 `anchors` 标识符，不接收任何新锚点输入**；
- 需要重跑摘要/锚点的修正（merge/split/边界修订后的重跑）走注入的 `rerunner`，构造点 `src/api/index.ts:263-270` 明确 `rerunner: options.closure ?? this.t8Closure`，即复用闭合管线——L1/L2 闸自动覆盖；
- 结论：当前不存在锚点写入旁路，但这是"结构上恰好没有"，**没有测试钉死**。评审请判断：批 A 是否应补一组红测把"修正路径不可能引入新锚点"锁成显式契约（我方倾向补）。

### 3.4 L2 所需的依赖注入条件已具备

- 闭合管线依赖接口 `ClosureDeps`（`closure.ts:102`）当前含 `log: EventLog`、`port`、`backlog`、`readTexts` 等，**没有经历全集读取器**。
- 但构造点 `src/api/index.ts:250-258` 所在类**已持有 `this.experienceLog`**，且同文件 :264-265 已把 `readExperience: (id) => this.experienceLog.has(id) ? ...get(id) : undefined` 注入给修正器。
- `src/source/experience-log.ts` 提供 `has(id)`（:89）、`get(id)`（:80）、`readAll()`（:94）；经历契约含 `scene.channel` 与 `occurred_at`（`src/contract/experience.ts:172`）。
- 即 L2 新增一个只读依赖即可，不需要新建读取能力，也不需要事件层反向依赖记忆层。

### 3.5 L3 既存件

- `src/event/llm-port.ts:15-52`：`LLMSummarizeRequest`／`LLMSummarizeResponse`，响应里 `anchors: readonly string[]` 是自由字符串数组，端口契约目前不约束其来源。
- `src/memory/serial.ts:24` 已有纯函数 `resolveSerials(map, picked)`：候选序号 → ULID 列表的映射器，L3 可直接复用。
- 摘要实际适配在 `src/adapters/dsh/llm.ts`（L6 宿主层），prompt 拼装在 `closure.ts:502 userPrompt()` 一带。

### 3.6 当前质量基线

- `npm test`：1019 / 1019 / 0（唯一受信口径；`node --test --test-force-exit` 引号 glob 已实证会漏收测试，禁止使用）；
- `tsc -p tsconfig.json --noEmit` 与 `tsc -p tsconfig.test.json --noEmit` 双 0；
- 架构静态门 50/50（schema 34 ＋ topology-removal 16，含 anchors 消费者白名单与 import 图投毒自证）。

---

## 4. 设计提案（请评审的主体）

### 4.1 批 A：L2 引用完整性闸（纯内核，零 LLM）

**A1. 新增候选池纯函数（建议落 `src/event/` 下新文件，零 I/O，表驱动可测）**

输入：事件的 channel、`[started_at, ended_at]` 闭区间、anchors 列表、经历全集访问口。
对每个 anchor 依次校验，任一不过即整份拒绝：

1. **存在性**：经历全集 `has(anchor)` 为真；
2. **同通道**：该经历的 `scene.channel === event.channel`；
3. **闭区间**：`started_at <= occurred_at <= ended_at`（ISO 字符串同一时区口径下可字典序比较，或统一转毫秒比较——请评审者对比较口径发表意见）。

输出建议为分类结果而非布尔：`ok | { reason: 'not-found' | 'cross-channel' | 'out-of-window', anchor, detail }`，便于失败明细与观测 reason_code 复用。

**A2. 闸位**：在 `writeSummary()` 内、现有 `assertAnchorsUlid`（L1）之后、`appendVersion` 之前调用。L1 拦形态、L2 拦引用，形态不过无需读全集，短路节省 I/O。

**A3. 失败语义**：新增错误类型（建议 `AnchorReferenceInvalidError extends SchemaError`，与 L1 错误并列），抛给既有 `failTask`：按一次失败退避重试，耗尽 8 次标 permanent 出队、事件保持 pending、真源零追加。**不得用占位锚点糊过去、不得写半份坏版本、不得 fail-open 删锚点后照写。**

**A4. 双模纪律**：闸只在 write 追加路径生效；read 解析历史真源保持宽容，禁止在 read 模式抛 L2 错误。

**A5. correction 封旁路**：补红测钉死 §3.3 结论——六种修正产生的新版本 anchors 与当前版本一致（继承），重跑路径产出的新 anchors 必经 L1+L2；未来若有人给修正输入加 anchors 字段，测试必须变红阻止。

**A6. 依赖注入**：`ClosureDeps` 增加只读经历访问口（窄接口，只暴露候选池需要的 `has/get` 或一个 `readCandidates` 谓词，不把整个 `ExperienceLog` 泄漏给事件层），构造点用既有 `this.experienceLog` 适配。请评审者就"窄接口形状"发表意见。

**A7. 变异自证（强制验收项）**：
- 变异 1：摘掉 L2 存在性校验 → not-found 拒收红测必须变红；
- 变异 2：摘掉同通道条件 → cross-channel 拒收红测变红；
- 变异 3：闭区间改成开区间或删除 → out-of-window 红测变红；
- 逐字节还原后全量回绿。副本内变异、主仓零残留。

### 4.2 批 B：L3 生产端反幻觉（拟与批 A 分卡、独立评审）

核心机制：把填空题改成选择题。

1. 摘要请求内下发"窗内候选经历序号表"：由系统按事件 channel＋时间窗算出合法候选（与 L2 同一候选池纯函数的正向版本），序列化为 `1..N` 序号表随 prompt 下发；
2. LLM 响应只允许回候选序号（整数数组），不再直接回 ULID 字符串；
3. 系统用既有 `resolveSerials` 把序号映射回 ULID，再进入 L1/L2；
4. 未知序号／重复序号／非整数：允许**一次**重取；二次仍失败，本轮按失败处理（进 failTask 退避），**绝不**降级为"模型给什么写什么"；
5. 空选择 `[]` 合法（与 L1 空锚放行口径一致）。

批 B 改动面：`llm-port.ts` 请求/响应契约、`closure.ts` 请求拼装与响应解析、`adapters/dsh/llm.ts` prompt 与解析。属摘要链（B 块）范畴，验收需要 LLM 行为夹具与契约测试，故提案原文即建议与 L1/L2 分批独立评审。

### 4.3 明确不做（冻结面）

- 不修改/删除任何既有 events/experiences 记录，只在新 append 链路上加闸；
- 不向真源加列、不新增表/水位/游标/守护进程/fs.watch；
- 不恢复任何已删除的人工通道模块（原 `src/memory/anchor-remap.ts`、`seed.ts` 已删，候选池纯函数在事件层重新实现，禁止 import 旧模块或恢复人工枚举）；
- 不放宽 M6 规则①与 anchors 消费者白名单；
- 不改 L1 现状（见 §5.3）；
- 不在本卡处理跨事件硬关系字段（见 §5.1 末段）。

---

## 5. 需要评审者重点挑战的设计口径

### 5.1 "同通道＋闭区间"是不是过度约束？——证据链与语义关联之分

已收到的真实疑问：用户与"她"在 QQ、微信、网页、语音等多渠道持续聊同一主题（晚餐），这些事语义上明明相连，为什么锚点不许跨通道？

我方论证（请评审者反驳）：

1. **锚点的语义是证据出处，不是话题关联。** 一个事件由其所在通道的原始经历切分闭合，它能引用的原料物理上只可能是同通道、时间窗内的经历。跨通道那条记录属于另一个事件，从来没有进入过本事件的加工管线；引用它等同于伪造出处。
2. **跨通道的语义连续性没有丢，而是由另一层承担。** 所有通道的记忆卡进入同一投影库、同一套 FTS 索引，召回全局进行、不按通道过滤。第三天语音问"前两天的晚餐"，检索层同时命中 QQ 卡与微信卡，综合回答在召回时完成，不需要在证据字段上硬连。
3. **闸门口只能机械验证身份事实**（存在/通道/时间），无法验证语义相关性；语义相关性是 LLM 摘要与召回的职责。把语义判断塞进机械闸，要么挡不住伪造（编一个合法号），要么误伤真实召回。
4. 若未来需要"事件 B 显式接续事件 A"的硬关系，正确做法是**新设独立字段并配独立校验规则、走冻结面评审**，而不是放宽锚点候选池——放宽后闸无法区分"真接续"与"瞎编号"。

请评审者评估：该论证是否成立？候选池三条件是否还缺（例如是否需要校验经历状态——已退役/归档经历可否被引用）？

### 5.2 闭区间边界与时间口径

- 边界相等（`occurred_at === started_at` 或 `=== ended_at`）应判合法（闭区间），请确认无异议；
- ISO 时间字符串比较口径：项目内时间同时存在 ISO 字符串与毫秒数两套表示，请评审者裁定比较前统一转毫秒，还是允许同口径字典序比较（我方倾向前者，避免时区/格式隐患）；
- 事件 `time_range` 在修正（merge/split/边界修订）后会变化，候选池校验发生在写新版本时刻、以**当时**的 time_range 为准——历史已落版锚点不追溯重验，请确认这一"新闸只管新 append"口径与双模纪律一致。

### 5.3 L1 落点是否需要从 closure 搬到 contract

原提案建议 L1 落 `src/contract/event.ts` 的 write 解析；实际 #119 落在 `closure.ts` 写版本前同位置。两者都在 append 之前、fail-closed 等价。我方建议**不搬**（搬移是无行为变化的 churn，扩大 diff 且要重写 23 条断言的 import），#90 验收时把 #119 卡"整卡落地后接管同位置断言并删重复代码"的备注改为"同位置保留"。请评审者就落点合规性发表意见。

### 5.4 L2 错误的 permanent 语义

L2 拒收意味着 LLM 产出了引用非法经历的摘要。退避 8 次期间重跑摘要可能得到不同结果（非确定性 LLM），所以重试有意义；但若模型稳定复现同一幻觉，8 次后 permanent 出队、事件永久 pending。请评审者评估：

- permanent 后是否需要专门的观测 reason_code（建议复用/新增受控码，落投影观测而非真源）？
- 是否需要为 L2 permanent 设计人工/离线解救路径（当前提案没有，事件留 pending 等 correction 或后续机制）？

### 5.5 L3 一次重取策略是否足够

请评审者判断"未知序号允许一次重取、二次失败按失败处理"是否合理；重取是带错误反馈的二次调用还是无反馈原样重试（我方倾向带反馈：告知非法序号清单）；以及批 B 是否应允许"二次失败但摘要正文可用时，剥掉 anchors 落一个空锚版本"这种降级，还是必须整轮失败（我方倾向后者，禁止静默降级，但欢迎反驳）。

### 5.6 测试组织与命名

沿用 #42 约定：红测文件统一 `tests/memory/task90-*.test.ts`（或 `tests/event/`，请评审者就归属目录发表意见），表驱动正反例：合法落版／not-found／cross-channel／out-of-window 整份拒绝且真源零追加；read 模式读旧数据不报错；L1+L2 联动短路顺序；backlog 退避三态。

---

## 6. 验收标准草案（批 A）

1. 全量 `npm test` 绿、双 tsc 0、静态门 50/50 不下降，白名单零增项（若确需新增消费者，按 #42 先例逐行登记注释）；
2. 候选池纯函数三条件各有独立红测，正反例表驱动，拒收时真源零字节追加、backlog 退避与耗尽行为有断言；
3. 三组变异自证全部按预期变红、还原回绿，变异过程主仓零残留；
4. correction 旁路红测钉死；read 模式宽容性有回放测试；
5. 真实数据根零写入，测试只用临时 `DSH_HOME`；
6. 无新表/新定时器/新真源字段/新生产依赖；
7. 总设计文档 11.x 与本卡状态同步回写（随实现提交，不单独推送）。

批 B 的验收标准待其独立立项时另定，核心将包含：端口契约测试、prompt 夹具测试、重取/失败路径测试、L1/L2 对 L3 产物的全链路拒收测试。

---

## 7. 请评审者回答的问题清单（可直接按编号回复）

1. 候选池三条件（存在/同通道/闭区间）是否完备？要不要增加经历状态等第四条件？
2. §5.1 的"证据链 vs 语义关联"论证是否成立？跨通道主题连续性由全局 FTS 召回承担，是否足够？
3. L2 闸位（L1 之后、append 之前）与错误类型设计有无漏洞？失败即 failTask、禁止剥锚降级，是否同意？
4. `ClosureDeps` 新增只读窄接口的形状建议（只暴露候选池谓词）是否妥当？有无更优边界？
5. correction 路径"结构上无旁路但无测试"，是否同意补红测钉死而非加运行时闸？
6. 时间比较口径（统一转毫秒）、闭区间边界、不追溯历史版本，三点是否同意？
7. L2 permanent 后的观测与解救路径应如何设计？本卡不做是否可接受？
8. L3 独立成批评审是否同意？一次重取＋二次整轮失败（禁止空锚静默降级）是否合理？
9. L1 落点维持 closure.ts 不搬迁，是否同意？
10. 是否存在本材料未覆盖的失败模式（例如经历全集自身损坏/尾行截断时 L2 如何表现——请注意真源 JSONL 已有末行截断容错、中间坏行抛 CorruptedError 的既有机制）？

---

## 附录 A：相关文件索引

| 文件 | 与本卡关系 |
| --- | --- |
| `src/event/closure.ts` | L1 现状（:95/:382/:421/:611）、L2 拟落点、failTask 退避 |
| `src/event/correction.ts` | 修正路径旁路核查对象（6 处 appendVersion） |
| `src/event/backlog.ts` | `RETRY_MAX_ATTEMPTS=8`、重试队列契约 |
| `src/event/llm-port.ts` | L3 端口契约改造对象 |
| `src/source/experience-log.ts` | 经历全集读取（has/get/readAll） |
| `src/contract/experience.ts` | 经历契约（channel/:172 occurred_at） |
| `src/contract/event.ts` | 事件契约与双模解析惯例 |
| `src/memory/builder.ts:310-328` | 投影侧悬空硬失败（L2 的下游近亲） |
| `src/memory/serial.ts:24` | L3 可复用的序号→ULID 映射器 |
| `src/api/index.ts:250-270` | 管线构造点，experienceLog 已在场 |
| `tests/memory/task42-l1-closure-ulid.test.ts` | L1 既有红测，L2 测试的风格基准 |
| `docs/memory-anchor-governance-and-auto-card-proposal.md` §2.2 | 三层闸原始提案 |
| `docs/task42-runtime-autocard-final-spec.md` | #42/#119 定稿（L1 口径与空锚三分裁定来源） |
| `docs/architecture-design-spec.md` 11.4 | #90/#119 卡面与依赖链 |
