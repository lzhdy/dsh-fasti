# 记忆召回第二层 · 实时接线与受控窄写 · 提案提纲 v0.6（WP4b 真机验收通过，tools 注入缺陷已按动态 inject 修复）

> 状态：v0.4 在 v0.3 抽查 PASS 基础上，依《WP4a 拆分与 N16 步骤2 裁决》（2026-11-13）做**契约同步修订**：
> 运行期窄柄由“恰五方法”演进为“恰六方法”（新增 N16 影子观测窄写，见 §5.2/§5.3/§8.2），并登记
> deferred 术语与三态影子观测语义；实现代码已按 TDD 落地（WP1–WP4a）。
> **v0.5（2026-11-13）：WP4b 原“真机挂载点未知”阻塞已解除** —— 在宿主包中发现真实工具注册 API
> `@deepseek-ai/dsh-tools`（`defineTool` + cordis `ctx.tools.register`），无需臆造任何宿主接口；
> 真机薄壳与 plugin 接线已按 TDD 落地并全量 809 tests / 809 pass / 0 fail / 0 skip，落地契约见 §7.1。
> 版本脉络：v0.1 外审附条件 PASS（N1–N10）→ v0.2 逐条闭合（§13 留对照）→ v0.2 复审附条件 PASS、
> **无运行期安全阻断项**，新增 N11–N15；v0.3 闭合两条必修（N11/N12）并登记 N13–N15，处置见 §13；
> v0.4 依设计裁决把 N16 预留窄原语落地为第六窄方法（裁决硬条件 a–d，对照见 §13）；
> v0.5 不改 WP4a 已认可三源码（sha 逐字复核不变），仅新增 assembly 工厂、adapter 薄壳并接通 plugin。
> **v0.6（2026-11-13）：真机验收暴露并修复 tools 服务注入缺陷** —— 真机 cordis 4.0.5 强制 inject 授权，
> 未注入直读 `ctx.tools` 抛 without-inject，致四工具不注册（离线根 Context 测试绕过了该授权，故 v0.5 未现）；
> 改用动态 `ctx.inject(['tools'], …)` 子 fiber 接线（默认 off 不注入、弱宿主缺服务静默降级），仅改 `plugin.ts`
> 与测试，全量 811 tests / 811 pass / 0 fail / 0 skip，变异反证 10/10 击杀，WP4a 三源码 sha 仍逐字不变；详见 §7.1（7）。
> 纪律延续：外部复审明确 PASS 且用户显式点头后才动代码；全程 git 零写、真实根零写。
> 上游事实：第一层（#44）已获外部**明确 PASS**，741 tests / 741 pass / 0 fail / 0 skip（Linux），
> 12 项变异全 PASS，真实根聚合 sha 恒定。所有“第一层已有”引用以主仓工作树为准。

## 1. 背景：两层的性质差异

第一层交付的是**离线零件**：无环纯函数（content-hash/fts/gate/alias-write）、bm25 零漂移 explained
检索、读柄只读增量（`getCardsByAnchor`）、写柄内仅离线可达的 `addMissAlias`、四态离线审计与只读烟测。
第一层全程未触实时链路：`src/api`/`src/event`/`src/source`/`src/adapters` 零改动，真实根零写，
`memory-index` 不存在，M6 静态隔离门零改动。

第二层要把零件接入她**真实运行的对话回路**，风险等级发生三个变化：

| 维度 | 第一层（已 PASS） | 第二层（本提纲） |
|---|---|---|
| 运行形态 | 离线脚本 / 临时根 harness | 实时会话链路 |
| 写权限 | 写柄方法仅离线测试与构建脚本可达 | 运行期开放**独立窄柄**：卡写仅 addMissAlias，另有 recordMiss 观测 |
| 宿主关系 | 零依赖、不 import 门面 | 经 cordis/dsh-llm 协议注册工具，依赖方向受 M6 约束 |
| 出错后果 | 测试红，真实数据零影响 | 可能影响每一次检索与记忆索引，需开关、影子与回退 |

## 2. 目标与非目标

### 2.1 目标（四个工作包 + 贯穿约束）

1. **WP1 实时检索接线**：门 outcome 进入真实检索回路，hit/abstain/no-match 成为运行时行为；
   读柄补 `searchExplained` 增量以提供可进门候选（N2/N11）。
2. **WP2 落空自主回查与运行期窄柄**：零命中/弃权时她下钻真源原文，找到则补 `source='miss'` 检索别名，
   找不到则 recordMiss 登记后认无；运行期经**独立窄柄工厂的委托包装对象**访问，类型、反射与静态测试
   三重限定（N1/N3/N13）。
3. **WP3 M6 受控修订**：在静态隔离门上“开门上锁”，允许指定装配层单向依赖 memory 的**显式枚举
   白名单导出（默认拒绝）**，扫描范围与投毒同步扩展（N1/N7/N13）。
4. **WP4 宿主协议适配**：按 cordis/dsh-llm 纪律注册四个工具，句柄生命周期、时钟/rng 注入、
   敏感 fail-safe 就位（N4/N14）。
5. **贯穿约束 D9′（全集进门）**：实时编排必须全集检索 → 门过滤 → 门内截断，且让预截断在装配 API
   的**类型层与对象字段层都不可表达**（N9/N11）。

### 2.2 非目标（第二层明确不做）

- 不引入向量检索、查询路由器、查询分类器（沿用第一层 K1 冻结项）。
- 不声明 R1≥0.85 / R2≤0.05 等统计达标（D4 延续）；只产出机制行为与可观测计数，统计定值另立协议。
- 不写真实根三份 jsonl（`raw-turns`/`events`/`experiences`，source-append-only 永不写）。
- 运行期**生产卡写**只允许落在 projection 下的 `memory-index`（当前不存在）；影子观测写与影子索引
  另落 `projection/memory-shadow/`，由**外部离线调度**产出，属显式豁免的独立写面（见 §8.2，N5/N12）。
- 不动 700 字工作记忆窗口（#43，用户已明确延后）；自动建卡主线（#42）与本层共用架构门、合并设计
  但不夹带实现。
- 不在 mem_card 增加正文/情绪/重要度/session 等列（M6 schema 禁列纪律不变）。
- 不设单纯机器审核岗；她仍是记忆与决策的唯一主体，回路零人工。

## 3. 多候选语义契约

一个关键词命中多件事是主轴情形，不是边角。第一层门的纯函数行为已实现并测试，第二层把它提升为
**接线契约**，防止装配时走样。

### 3.1 门的职责边界（已定，第一层事实）

- `applyGate` 对**完整候选数组逐卡裁决**，输出 `accepted`（可多张）、`rejected`（多张带原因码，不静默
  丢弃）与总状态（hit/abstain/no-match）。门只回答“哪些卡够格被看见”，**不回答“哪一张是本次答案”**。
- 多张过硬门的卡全部保序交出，消歧与选用由她的推理结合当前语境完成；门不做卡合并、不做二选一、
  不使用连续证据分替她拍板。
- 排序确定性沿用 bm25 三级 tiebreak：score 降序 → occurredMs 降序 → cardId 升序；过滤保序。
- 运行时检索已带 as-of 生效过滤（`isEffectiveAt`），失效卡不进候选，是多候选安全的既有前提。
- 离线四态以 top1 对金标度量 wrong-commit，仅是审计口径，不改变运行时可返回多张的事实。

### 3.2 D9′ 接线硬约束（N9+N11：让预截断在类型层不可表达）

正确顺序：

```text
runtimeHandle.searchExplained(runtimeQuery)       // 1. 入参类型不含 limit 键，取完整排序全集
  → applyGate({ qNorm, candidates, limit })       // 2. 全集逐卡布尔过滤
      → accepted.slice(0, limit)                  // 3. 过滤后才截断，弱尾不补位（唯一允许的切片）
```

- 第一层 `gate.test.ts` 已在纯函数层锁定该行为（两强三弱、limit=2，断言返两强、三弱全留 rejected）。
- **三道防线**：
  1. **入参类型防线（N11）**：窄柄检索入参为独立类型 `RuntimeSearchQuery = { readonly text: string;
     readonly atMs: number }`，**类型中不存在 limit 键**；不是给 SearchQuery 套 `Omit` 的局部签名，
     而是装配层可见的独立无 limit 类型，调用方构造带 limit 的对象在赋值处即 tsc 红（冗余属性校验，
     配 miss.test.ts 同款条件类型编译测试）。
  2. **委托不转发防线（N11）**：窄柄内部组装委托给 `searchCardsExplained` 的完整 SearchQuery 时
     **显式写死 `limit: undefined`**，从不读取/透传调用方对象的任何 limit 字段；即使上层绕过类型
     （any 强转）塞入 limit，运行时也不会生效。
  3. **行为静态自证（N9/N11）**：静态扫描装配层，`applyGate` 调用点之前对候选数组出现 `.slice(`/
     `.splice(` 即红；门内 `accepted.slice(0, limit)` 是全装配唯一允许的候选切片。正则防线可被变量
     绕过，故仅作第三道兜底，主防线是类型形状。
- 第一层 `gate-smoke.test.ts` 的 `gatedQuery` 把同一 limit 同时传给 bm25 与门；该模式**仅限 3 卡
  夹具**（limit=3 恰为全集，当前无害、741 全绿），v0.3 起在该函数处显式标注“离线夹具专用、禁止
  复制到装配层”，第二层另补接线反例测试。
- **接线反例测试必做**：构造超过 limit 的候选集，强通道卡故意排在弱尾，断言经真实装配编排后强卡
  仍被捞出；另补一条 any 强传 limit 的运行时用例，断言窄柄忽略该字段、返回全集进门。

### 3.3 歧义态（Q1 结论：不加，附 N10 观测条件）

- 多张卡同过硬门时不额外引入“歧义态”标记：serialMap 已提供稳定引用，提前加标记属过度工程。
- 条件（N10）：shadow 期必须统计 multi-accept 频率与 rejected 原因分布、定期跑 consistency 审计
  （`evaluateInvalidation` 目前仅离线审计消费）；宿主回应在 accepted>1 时须带 discriminator **全量
  呈现，不得静默只取 top-1**。证据显示歧义风险后再评估是否在第三层引入歧义态。

## 4. WP1 实时检索接线

- 装配层以 gate.ts 的无环 `normalizeLexicalText` 得到 qNorm（见 §6.2 白名单；不 import bm25），经窄柄
  `searchExplained`（入参无 limit 键）取全集 → `applyGate`，把 GatedSearchOutcome 经宿主工具返回；
  返回体保留 status、accepted（含 serialMap 序号）、rejected 原因码。
- 状态语义：`no-match/empty-query`、`no-match/zero-lexical-hit`、`abstain/all-rejected` 三类不得包装成
  “找到但不确定”的答复；运行期消费方必须能区分零命中与全拒，二者后续动作不同（见 §5.1）。
- **读柄增量 searchExplained（N2/N11，第二层首个只读增量）**：
  - 现状缺口：`searchCardsExplained` 收原始 DatabaseSync 且按 `query.limit` 截断（bm25.ts:176），
    而读柄 `search()` 只暴露剥离 explain 的零漂移薄封装；装配层按现行接口既拿不到 `matchKinds/cueText`
    ，又可能经 query 对象内 limit 发生预截断。
  - 修法：窄柄新增 `searchExplained(query: RuntimeSearchQuery): Promise<ExplainedRankedCard[]>`，
    内部先规范化、再构造 `{ text, atMs, limit: undefined }` 委托 `searchCardsExplained`；旧 `search()`
    薄封装零漂移不动，两者并存。
  - 先红后绿：零漂移快照（explained 与薄封装候选、名次、分值一致）、只读自证、limit 键编译红测试、
    any 强传 limit 运行时无效测试。
- `GatedRankedCard.evidence` 第一层恒 undefined 的约束延续：若未来附证据须另立字段评审，不得就地填充
  改变第一层冻结形状。
- 开关关闭时的退路明确为第一层零漂移薄封装 `searchCards`（门不介入），保证可一键回到接线前行为。

## 5. WP2 落空自主回查与运行期窄柄

### 5.1 回查回路

1. 门裁决为 zero-lexical-hit 或 all-rejected 时，由她在同一会话内触发真源宽通道下钻（只读）：
   经 `resolvePointer`/anchor 反查在三份只追加 jsonl 的投影上定位原文，不新增模糊召回通道。
2. 下钻找到对应记忆：经窄柄 `addMissAlias` 补一条 `source='miss'` 别名（只进 mem_alias 与
   aliases_json，**不碰 display_cues 等展示线索**），下一轮检索即可命中。
3. 下钻找不到：经窄柄 `recordMiss` 登记一次漏召观测（mem_miss，六字段白名单、term_hash 不落原文、
   append-only），本轮不认定、不编造、不产生别名写入。
4. 失败纪律：下钻异常时“多取一次”，仍失败则显式失败，禁止静默替换或猜测。

### 5.2 窄柄工厂：委托包装对象与独立窄类型（N1/N13）

- 现状越权路径（v0.1 缺陷，已亲验）：`openMemoryWrite` 返回完整 MemoryWriteHandle（含
  transactionApply/stampRevision/writeAuditRun 等全量写能力），模块粒度白名单一旦放行 store，
  装配层即可点名该工厂拿到全量写柄。
- 修法：memory 内新增**独立窄柄工厂**（定名 `openMemoryRuntime`）。该工厂内部打开
  完整柄但**绝不外泄**，返回一个全新构造的**委托包装对象**。v0.3 为五个方法；v0.4 依 N16 裁决增补
  第六个经评审窄能力 `recordShadowObservation`（影子 JSONL 窄写，非卡写、与 sqlite 物理隔离），
  其全部且仅有的六个方法为：

```text
searchExplained / getCardsByAnchor    // 只读
addMissAlias                         // 唯一卡写（mem_card/mem_alias），sensitive 内部固定 1
recordMiss                           // 观测写（mem_miss，非卡写）
recordShadowObservation              // N16 影子观测写（memory-shadow JSONL，非卡写，v0.4 第六窄方法）
close                                // 生命周期
```

- **实现形态硬约束（N13-i）**：返回值必须是只挂这六个方法的新对象字面量，每个方法以闭包委托内部
  完整柄（影子方法除外，它委托独立的 shadow-write 落点、不经 sqlite 写柄）；**禁止**把
  MemoryWriteHandle/MemoryReadHandle 经 `as RuntimeMemoryHandle` 类型断言后返回。
  静态标识符扫描挡不住字符串拼接键与运行时反射，包装对象保证即便反射（Object.keys/getOwnPropertyNames
  ）也只能看见六个窄方法。配反射测试：断言 `Object.keys(handle).sort()` 恰为六键、访问任何全量方法名
  得到 undefined；“窄柄能力扩大化”变异（注入第七方法/任一全量写方法）必须红。
- **N16 第六窄方法的封闭性（裁决硬条件 a）**：独立入参类型 `ShadowObservationInput`
  （termNorm/gatedStatus/legacyCount/acceptedCount/rejectedReasonCodes/observedMs 六字段），运行时键
  白名单与受控状态/原因码枚举校验，额外键当场 IntegrityError；**入参不含任何目录/路径形参**，影子目录
  由工厂按 indexDir 内部固定为 `projection/memory-shadow`，杜绝退化为通用文件写；term_hash 在 memory 侧
  内部 sha256 计算，termNorm 与原始查询永不落盘；append-only 无更新/删除；写失败隔离为 `ok:false`
  不阻断主检索；构造期不建目录，首次写才 mkdir。
- 窄类型在类型层不 extends MemoryWriteHandle、不包含其任何全量方法；装配层只持有窄类型引用。
- **导出粒度静态门（N1）**：扫描装配层 import 与标识符引用，出现 `openMemoryWrite`、`openMemoryRead`、
  `transactionApply`、`stampRevision`、`writeAuditRun`、`writeCards`、builder 相关命名即红；白名单按
  “可命名的导出符号”默认拒绝、显式枚举（完整清单见 §6.2）。
- **禁自开连接**：装配层 import `node:sqlite`、`new DatabaseSync`、任何文件打开调用即红（配投毒），
  所有库访问必须经窄柄，杜绝绕过库柄直接开库文件。
- **单例与冲突（N1 附带）**：窄柄工厂复用进程内连接单例登记表；库已被离线 builder 占用
  （ConflictError）时，窄柄**降级为只读**并留可观测日志，不与离线构建抢锁；只读降级可直接复用
  `openMemoryRead` 独立只读连接（store.ts 既有）。

### 5.3 运行期权限矩阵（静态测试对象）

| 能力 | 离线 builder/脚本 | 运行期窄柄 RuntimeMemoryHandle |
|---|---|---|
| searchExplained / getCardsByAnchor（只读） | 有 | 有 |
| addMissAlias（单事务、每卡上限 5、幂等、决策留痕、sensitive 固定 1） | 有 | **有（唯一卡写能力）** |
| recordMiss（mem_miss、term_hash、append-only） | 有 | **有（观测写，非卡写）** |
| recordShadowObservation（memory-shadow JSONL、term_hash、无原文、append-only、v0.4） | 无（离线不写活体影子） | **有（影子观测写，非卡写；仅 shadow 态；与 sqlite 物理隔离，只读降级仍可用）** |
| 建库 / 全量 rebuild / transactionApply / stampRevision / writeAuditRun / 删除 | 有 | **无，窄类型不含、包装对象无此键、静态扫描不可达** |
| 账本直写 appendDecision/appendRevision | 有（内部） | **无，白名单默认拒绝并配投毒（N13-ii）** |
| 写真实根 jsonl | 无 | **无，永不开放** |

- 复用第一层已测保证：`applyMissAlias` 同主键非 active fail-loud、仅 UPDATE aliases_json+content_hash
  两列、syncFts、失败 ROLLBACK；addMissAlias 提交后 appendDecision
  （action=add-alias、created_by=her、model_tag=rules-v1、reason=add-alias:miss-recheck）由内部完整柄
  完成，装配层不直接接触账本函数。
- 新增静态测试扫描装配层可达引用，越权即红（第一层 M10“读柄加写方法 typecheck 红”的运行期升级版；
  注意此为 #44 变异矩阵 M10，与方案 §11.3 的窗口 M10 是两套编号，引用处分别标注）。

### 5.4 sensitive fail-safe（N4/N14）

- 现状：第一层 `AddMissAliasRequest.sensitive` 由离线调用方显式给出（“不自动猜隐私”）；运行期若沿用
  该入参且误传 0，别名即进 FTS 宽路径（fts 仅滤 sensitive=1），写侧无运行期守卫。
- 修法（不可表达优先，N14 建议采纳）：窄柄卡写入参用独立类型
  `RuntimeAddMissAliasInput = { readonly term; readonly cardId; readonly atMs }`，**不含 sensitive
  形参**；包装对象内部委托时固定以 `sensitive: 1` 调第一层 addMissAlias。比“接受形参再钳制”更彻底，
  与 D9′/N11“让危险选项不可表达”同一哲学。第一层离线 `AddMissAliasRequest` 形状保持不动，sensitive=0
  仍仅能经离线决策流程（她的显式离线动作）到达，运行期无入口。
- 隐私两条声明分别贴准确标签（N14）：
  1. **“sensitive=1 仅精确路可达”= 第一层已实现事实**（fts.ts 过滤、bm25.ts 精确路不滤 sensitive、
     LIKE 路滤 sensitive=0）；
  2. **“敏感线索不进宿主回显”= 第二层装配义务（尚未实现）**，第一层无宿主装配，不得标注为已实现；
     WP4 须配专门装配测试（见 §9 类别 6）。
- D.6 文档约束表（“装配前强制过滤”）当前无运行期实现，本提纲不虚构其已落地；最小约束表若要实现，
  另立评审，不在本层夹带。

## 6. WP3 M6 受控修订（开门上锁）

### 6.1 现状（tests/memory/schema.test.ts 已实现，N7 计数纠正）

- 规则①：`src/api/`、`src/event/`、`src/source/`、`src/adapters/` 不得相对 import memory（import
  提取器覆盖六种形态）。
- 规则②：`src/memory/` 不得 import 门面（api）。
- 规则③：package.json `dependencies` 文本必须仍是 `{}`。
- 投毒探针实为 **7 个**：六种 import 形态（static/import type/re-export/export type/动态 import/
  副作用 import）+ 1 个 memory→门面；扩展时不得丢失门面探针。

### 6.2 开门方案（Q2 结论：独立装配目录 + 默认拒绝白名单）

- 采用方案 (a)：新增独立装配目录（暂定名 `src/assembly/`，最终命名评审定），仅该目录允许单向 import
  memory；REALTIME_DIRS 现有四目录禁令不变，`src/adapters/dsh` 继续只做宿主耦合。
- **白名单采用默认拒绝 + 显式枚举（N13-ii）**。装配层允许命名引用的导出符号全集为：
  1. 窄柄工厂 `openMemoryRuntime`；
  2. 纯类型（`import type`，编译擦除）：RuntimeMemoryHandle/RuntimeSearchQuery/RuntimeAddMissAliasInput
     及门/序号相关类型；
  3. `gate.ts` 的 `applyGate`、`normalizeLexicalText` 与门纯类型——gate.ts 依赖仅 projection/types 的
     纯函数、serial.ts 与 type-only import，**无环、不触 store/bm25**（已亲验 import 表）；
  4. `serial.ts` 三函数 `buildSerialMap`/`resolveSerials`/`isSerialRefusable`（仅依赖 memory-errors 与
     类型，无环，已亲验）。
- **显式排除（命名出现即红）**：`store` 模块全部导出（openMemoryRead/openMemoryWrite/两柄接口）、
  `bm25` 模块全部导出（**含 normalizeQuery**——装配侧规范化统一用 gate.ts 的 normalizeLexicalText，
  二者同构已由第一层规范化一致性测试锁定；bm25 依赖 store，整体不暴露以防经模块反射触库）、
  `ledger.ts` 的 **appendDecision/appendRevision**（收 indexDir 字符串、不经 node:sqlite 即可伪造
  账本，N13-ii）、builder 全部导出、`node:sqlite`、`node:fs` 直开与 `new DatabaseSync`。
- 其余硬条件：
  1. 现行 M6 扫描只覆盖 5 个目录，**必须把 `src/assembly/` 显式加入扫描范围**，否则新目录无人守门；
  2. assembly → memory 仅命中上述枚举，引用任何枚举外符号即红（默认拒绝，新增 memory 导出不会自动
     放行，必须先评审入单）；
  3. 规则②扩展：memory 反引 assembly 同门面一样判红；
  4. adapters → assembly 合法（规则①只禁直接 import memory），但“adapters 绕 assembly 直引 memory”
     仍由规则①判红，配投毒。
- 依赖方向恒为 装配 → memory（leaf/纯函数/窄柄），memory 不反引装配或门面；`src/api` 内核仍不直接
  依赖 memory。方案 (b)（adapter 内白名单文件）保留为备选，缺点不变。
- dependencies {} 规则③不改：cordis/dsh-llm 维持 peerDependency + devDependency，实测可保持。

### 6.3 投毒矩阵扩展（先红后绿）

- 保留现有 7 探针全红；新增投毒至少六类：
  1. api/event/source 直引 memory 仍红；
  2. assembly 引用枚举外导出（openMemoryWrite/openMemoryRead/transactionApply 等）即红；
  3. assembly 引用 bm25 任一符号（含 normalizeQuery）即红；
  4. assembly 引用 appendDecision/appendRevision 即红（账本写面，N13-ii）；
  5. memory 反引 assembly 即红；
  6. assembly import node:sqlite/node:fs 直开或 new DatabaseSync 即红。
- 另配行为/类型探针：RuntimeSearchQuery 带 limit 键编译红；窄柄 Object.keys 非五键即红；applyGate
  前出现候选切片即红。
- M6 扫描目录、白名单与投毒必须在同一改动内同步，禁止只改允许集不补探针。

## 7. WP4 宿主协议（cordis/dsh-llm）

- 在 `src/adapters/dsh` 注册四个宿主可调用工具：gatedSearch（带完整 gate outcome）、
  getCardsByAnchor（anchor 只读反查）、resolvePointer（真源下钻定位）、addMissAlias（窄写，经
  assembly 窄柄）；序号体系复用 `serial.ts`，不新造编号。
- 句柄打开/关闭走 cordis `ctx.effect` 生命周期；数据根三级解析与现有 plugin.ts 一致，不新增连接自开。
- 时钟（atMs）与随机源继续注入，函数内禁 `Date.now()`/`Math.random()`，保证线上行为可离线复现。
- 敏感纪律：运行期 miss 别名经窄柄固定 sensitive=1（§5.4），仅精确路可达、不进 FTS 宽路径；
  “敏感线索不进宿主回显”作为本层装配义务落地并测试，不冒充第一层事实。
- LLM 端口沿用 `llm.ts`/`host-model-route.ts` 最小形状，不硬编码凭据与 provider；本层不新增模型调用
  点，消歧仍由既有会话推理承担。

### 7.1 WP4b 落地实现注记（v0.5：真实 API 已证实，原阻塞解除）

v0.4 之前 WP4b 因“宿主真机工具挂载点未知”而挂起，且纪律要求确认前不臆造 API。v0.5 在宿主包内确证了
真实注册面，阻塞解除，落地遵循与 §7 完全相同的依赖方向（adapter → assembly → memory 单向，M6 规则不放宽）。

**（1）真实宿主 API（来自 `@deepseek-ai/dsh-tools`，非推测）**

- `defineTool({ name, description, parameters, output, execute })` 产出工具定义；扁平 `parameters` 在运行时
  编译为标准对象根 JSON Schema（属性级 `required` 收集到根 `required`）；`output.schema={type:'string'}`
  配合 `render: (_a,value)=>[{type:'text',text:value}]`，模型侧只收 JSON 文本信封。
- cordis 模块增强在类型层声明 `Context.tools: ToolRuntime`，`ctx.tools.register(definition): () => void`
  返回该工具的注销函数。但真机 cordis（实测 4.0.5）对服务访问强制 inject 授权：插件未声明依赖即在
  fiber 上下文读 `ctx.tools` 会抛 `cannot get property "tools" without inject`，`ctx.get('tools')` 亦返回
  `undefined`。故 v0.6 起改为在动态 `ctx.inject(['tools'], …)` 授权子 fiber 内取得 registry 后再接线，
  授权子上下文上仍保留“具备 `register` 函数才认”的结构化探测，形态异常即安全跳过（详见本节（7））。

**（2）三个落地文件与职责切分（WP4a 已认可三源码一字未改，sha 复核不变）**

| 文件 | 层 | 职责 |
|---|---|---|
| `src/assembly/host-tool-runtime.ts`（新增） | 宿主无关，零 `@deepseek` 引用 | `openAssembledMemoryTools` 装配 openMemoryRuntime + 四工具 + 影子 sink 映射；`projectCardForHost` N14 白名单投影；`classifyHostMemoryError` 稳定错误分类；缺库降级为不侧建文件的不可用句柄 |
| `src/adapters/dsh/memory-tool-bridge.ts`（新增） | 全仓**唯一** import `dsh-tools` 的运行时模块 | 四个 `defineTool` 形状映射、会话级私有 `serialMap`、JSON 信封与稳定错误码、`wireMemoryTools` 注册/注销编排 |
| `src/adapters/dsh/plugin.ts`（修改） | cordis 插件入口 | 新增 `memoryGateMode` 三态配置（手写校验，默认 `off`）；`ctx.effect` 内 `Fasti.open`，非 off 档经动态 `ctx.inject(['tools'], child=>…)` 授权子 fiber 接线（off 不发起注入），cleanup 先注销工具再关门面；宿主无 tools 时注入回调静默不触发、主功能照常（安全降级） |

**（3）四个模型可见工具注册名（snake_case，统一前缀防撞名）与入参**

| 模型方法 | 注册名 | 入参 |
|---|---|---|
| gatedSearch | `fasti_memory_search` | `text:string`（必填）、`limit:number`（可选） |
| getCardsByAnchor | `fasti_memory_cards_by_anchor` | `experienceId:string`（必填，窄柄先校验合法 ULID） |
| resolvePointer | `fasti_memory_resolve_pointer` | `serials:integer[]`（必填） |
| addMissAlias | `fasti_memory_add_alias` | `term:string`、`cardId:string`（均必填） |

**（4）信封、序号与错误码契约**

- 成功 `{ ok:true, data }`，失败 `{ ok:false, error:{ code, message } }`；message 为固定安全文案，
  **不回传原始异常 message、堆栈或内部绝对路径**。
- 稳定错误码：`serial-context-missing`（未检索即解析序号）、`serial-stale`（序号表已被新检索替换/失效，
  fail-closed 要求重新检索，绝不猜测顶替）、`unavailable`（索引未就绪/只读降级）、`internal`（其余兜底）。
- `serialMap` 为会话闭包私有态：模型只传序号，序号表不落库、不跨会话，每次新检索整体替换；
  检索回显中剔除该 Map（不可 JSON 且属内部态）。
- 卡详情逐张经 `projectCardForHost` 白名单投影，仅出 `cardId/anchorIds/displayCues/channel/cardType/
  discriminator`；别名明文与 `aliasesJson/sensitive/eventId/weight/contentHash/entityHintJson/validMs/
  hitCount` 等内部列永不回显（N14）。

**（5）依赖与 peer 兼容风险（已实测锁定）**

- 精确锁定 `0.2.1-rc.5`；`dsh-tools` 的 peer 声明要求 cordis `~4.0.5`，真机宿主自带 cordis 实测即为
  **4.0.5**（v0.6 复核更正：早期稿记为 4.1.0 系 devDependency 锁值，并非宿主实配），与 peer 区间吻合；
  本仓 devDependency 仍写 `^4.1.0`、插件 peer 写 `^4.0.1`，本地直接安装仍会因 dev/peer 区间错配触发
  ERESOLVE，须使用 `npm install --legacy-peer-deps`；同步锁文件用
  `npm install --package-lock-only --legacy-peer-deps`（不得再跑普通 install，否则空 `dependencies:{}`
  节会被 npm 省略而触发 M6 门失败）。真机隔离 profile 经宿主自带包运行，无 ERESOLVE、无 `ERR_MODULE_NOT_FOUND`。
- `dsh-tools` 运行时静态 import 六个 `@deepseek-ai/dsh-*` 对等包；它们仅装为 **devDependency**
  供类型与离线测试加载，生产运行时由全局宿主 dsh 自带的同名同版本包提供，本仓发布物 `dependencies`
  仍保持 `{}`、cordis/dsh-llm/dsh-tools 列入 `peerDependencies`，不把宿主包打成自身运行时依赖。

**（6）默认安全与静态门**

- 默认 `memoryGateMode:'off'`：**不打开桥接、不注册任何工具、不创建 `memory-index` 目录**，
  线上召回路径与现状字节级一致；仅显式切到 `shadow`/`on`（Q3 授权动作）才注册工具，
  shadow 主返回仍旧路、只旁路影子观测，on 才让门裁决生效（三态语义仍以 §8.1 表为准）。
- M6 新增宿主包边界静态门：扫 `src` 全域，仅 `src/adapters/dsh/` 允许 import `@deepseek-ai/*`，
  其余目录（含 memory/assembly）引用即红，附投毒样本自证与 `node:`/相对路径零误报。

**（7）v0.6 真机注入授权修订（动态 inject，TDD；只改 `plugin.ts` + 测试）**

- 暴露的缺陷：v0.5 薄壳以属性探测 `resolveToolRegistry(ctx)` 直接读 `ctx.tools`。离线 `node:test` 在裸
  根 `new Context()` 上 `provide/set('tools')`，并不启用真机 loader 的 without-inject 访问限制，于是
  809 全绿却在真机 fiber 内被 cordis 拒读（`cannot get property "tools" without inject`），registry 取不到、
  四工具不注册；`Fasti.open`、事件摄入与数据根写入等主功能不受影响。
- 修法：默认 `off` 完全不发起注入（零变化、不侧建 `memory-index`）；`shadow`/`on` 在 `ctx.effect` 内
  `markReady` 之后改以动态可选注入 `ctx.inject(['tools'], child => { …wireMemoryTools… })` 承载接线，授权
  子上下文上做结构化探测取 registry；外层持 `MemoryWiring` 句柄与 `disposed` 标志处理“回调异步 vs 主 effect
  cleanup”时序，cleanup 先注销工具再 `fasti.close()`，子 fiber `child.effect` 注册幂等注销兜底。桥接层、
  四工具内核与 WP4a 三源码一字未动，M6 依赖方向不变。
- 不采用静态 `inject:['tools']` 的原因：cordis 数组式注入全部为**必需**依赖，弱宿主缺 tools 会使整个
  插件不加载，破坏“默认 off 零变化 + 缺工具也要让开库/摄入/影子照常”的安全降级契约。
- 真机四性质（临时诊断 bundle 实测，取证后已摘除）：不静态注入主插件正常装载；动态注入回调内
  `child.tools.register` 为可用函数；注入一个不存在的服务时回调静默不触发、无报错、进程 `exit 0`；
  子 effect 注销句柄正常执行。
- 测试与反证：新增 2 个插件测试（经 `ctx.inject(['tools'])` 授权才注册、默认 off 不发起注入），全量
  **811/811** 绿；变异反证由 8 条扩到 **10 条**（M4 锚点随重构迁移，新增 M9 破坏 inject 依赖声明、
  M10 破坏 off 不注入闸门），10/10 击杀且还原后基线复跑全绿。

## 8. 安全上线与回退

### 8.1 功能开关三态

config flag：`off`（默认，走旧 searchCards 薄封装）→ `shadow`（影子双跑，不写生产卡）→ `on`
（门与窄柄生效）。

**v0.4 三态写/观测语义显式化（裁决硬条件 c）**：

| 态 | 主检索返回 | 生产卡写 addMissAlias | 影子 JSONL（recordShadowObservation） | mem_miss（recordMiss） |
|---|---|---|---|---|
| off | 全走旧路，不触窄柄门 | 不写，返回 `deferred` | 不写（窄柄库未打开时连目录都不建） | 不写 |
| shadow | 仍旧路（对外零扰动），旁路跑门对照 | 不写，返回 `deferred` | **写**：唯一写活体影子 JSONL 的态，失败隔离不阻断主链路 | 不写 |
| on | 走门与窄柄 | **写**（sensitive 固定 1） | 不续写（门结果即生产行为，无需再影子对照） | 漏召登记走此通道 |

- **deferred 术语（v0.4 登记入契约）**：off/shadow 下卡写请求不触生产，工具统一返回
  `{ deferred: true, mode, reason: 'gate-not-on' }` 这一可观测结果，既不静默丢弃也不抢先落库；
  on 态才返回 `ok` 联合。该术语此前仅存在于实现，v0.4 起为提纲级冻结契约。
- **on 态漏召归 mem_miss、影子不续写**：on 态门已直接裁决生产召回，漏召事实经 `recordMiss` 入
  mem_miss（sqlite 观测表）；影子 JSONL 的职责是 shadow 期“旧路 vs 门”的双跑对照样本，on 后无对照
  对象，故不再追加，避免两写面重复记数。

### 8.2 影子写面分级与离线重建（N5/N12）

- 写面显式分两级：**生产卡写**仅 memory-index；**影子观测写与影子索引**落
  `<dataRoot>/projection/memory-shadow/`（projection 为可丢弃/可重建层），与生产索引物理隔离，不触真值。
- **影子索引重建只能由外部离线调度触发（N12）**：由系统级离线调度器或人工按周期调用**既有 builder
  CLI**，CLI 增加影子输出选项（如 `--shadow-out <dir>`），或重建到临时产物后经受控拷贝落
  memory-shadow；重建属离线授权操作，与生产首建同纪律（显式授权、临时文件同盘原子 rename）。
- **运行期代码永不触达 builder**：builder 不在 §6.2 白名单，assembly/adapters 引用 builder 任意符号
  即红（默认拒绝 + 投毒）；运行期对影子目录只做只读查询与观测追加，不做索引构建。
- 活体查询捕获点统一为 gatedSearch 钩子；影子侧失败做隔离处理，不阻断主链路。
- **观测日志落盘形状（v0.4 定案，修订 v0.3 “term_hash + cardId”表述）**：每行固定六字段
  `termHash / gatedStatus / legacyCount / acceptedCount / rejectedReasonCodes / observedMs`，
  为**一次门裁决的查询级聚合**，**不带 cardId**。理由：一次查询对应 0..n 张卡，聚合观测天然不绑定
  单卡；卡级事实（锚点、别名、漏召关联）归 mem_card/mem_alias/mem_miss，on 态漏召经 recordMiss 携带
  anchorIds 落 mem_miss，两写面职责不重叠。装配层只把**规范化词面 termNorm** 传到 memory 侧，
  term_hash 由 shadow-write 内部 sha256 计算，**termNorm 与原始查询文本永不落盘**（比 mem_miss 留存
  term_norm 更严，因影子承载活体查询）；原因码受 GateReasonCode 八值枚举约束，杜撰码 fail-closed。
  影子目录跨重启持久以支撑样本量评审，临时根仅用于测试。重建周期、新鲜度（staleness）观测口径登记于
  Q3 细则批。外发前按 EVIDENCE §10 同口径泛化。
- **cardId 口径变更显式登记（回应核验 minor）**：本条即为对 v0.3 §8.2「term_hash + cardId」与裁决 §2(a)
  入参示例措辞的**显式变更登记**——v0.4 起影子观测确定为不带 cardId 的查询级聚合，卡级关联统一归
  mem_miss（recordMiss 携 anchorIds）。该变更**不削弱 N10**：multi-accept（一次查询过门多卡）频率仍可
  直接由聚合行 `acceptedCount >= 2` 度量，弱尾/全拒分布由 gatedStatus 与 rejectedReasonCodes 度量，
  无需卡级 id 即可完成 Q4 转 on 所需的四态样本统计；需要下钻具体卡时另走 on 态 recordMiss/窄柄只读反查。
- **物理隔离与独立性**：影子 JSONL 写面不经 sqlite 写柄单例，运行期窄柄因离线 builder 占用而降级只读时，
  影子追加仍可用；shadow-write 入参无任何路径形参，落点由工厂内部固定，装配层经 M6 投毒禁止直接 import
  该 fs 原语，只能经窄柄第六方法到达。

### 8.3 回退语义（N6：门回退、数据写留存）

- off **不撤销**已写入的 miss 别名：旧路径 searchCards 同样读 mem_alias（精确路），别名在回退后继续
  生效；v1 无别名级 tombstone（action 集无 alias-revoke）。故“一键回退”的准确含义是**门关闭、
  数据写留存**，不得表述为“回到写入前状态”。
- 离线别名审计/撤销协议登记为后续独立项（与 Q3 首建协议同批成文）。
- 终极重置口径：**删索引 + 全量重建**；注意 rebuild 本身保留 miss 别名，故仅重建不会清除别名，
  必须先删库才能让别名归零。

### 8.4 真实根与上线纪律

- 任何开关状态下三份 jsonl 只读；写事务只允许命中 memory-index 或 memory-shadow（后者仅离线调度
  进程与观测追加），临时文件同盘 rename 原子性沿用第一层约束。
- 上线前重做全历史个人数据泄露扫描（工作树、打包物、日志），外发包路径泛化与差异声明延续。

## 9. TDD 与验收计划

- 先红后绿，不写无测试的接线代码；当前基线 741 只增不减，win32 的 M9 POSIX skip 继续如实标注。
- 新增测试类别：
  1. 读柄 searchExplained：零漂移快照、RuntimeSearchQuery 无 limit 键编译红、any 强传 limit 运行时
     无效、只读自证；
  2. 接线集成（临时根）：D9′ 弱尾强卡反例、门前进片切片静态红、三状态运行期语义、开关三态与回退
     （含“门 off 数据留存”断言）；
  3. 窄柄工厂：委托包装对象 Object.keys 恰六键（v0.4：含 recordShadowObservation）、全量方法名反射为
     undefined、禁类型断言实现、导出粒度静态门、node:sqlite/node:fs 禁入、单例冲突降级只读且影子写仍可用；
  4. M6 新投毒六类 + 扫描范围覆盖 assembly + 账本/bm25 枚举外引用红，v0.4 增补 assembly 越权 import
     shadow-write fs 原语探针（默认拒绝，只能经第六窄方法）；
  5. 影子：双跑确定性（同输入两次逐字节一致）、memory-shadow 不触生产索引、观测无原文（落盘行无
     termNorm/rawQuery、仅内部 term_hash）、封闭窄写（路径形参/额外键/杜撰原因码 fail-closed）、
     append-only 逐行一致、写失败 ok:false 隔离、运行期引用 builder 即红、离线 CLI 影子产物落点正确；
  6. 运行期端到端：窄柄 addMissAlias 入参无 sensitive 且落库恒为 1、recordMiss 落 mem_miss、下钻
     找不到不写别名、**敏感线索不进宿主回显装配测试（N14 第二条义务）**。
- 变异矩阵在 M1–M12 基础上扩展：运行期越权写、反射越权、开关短路、shadow 落盘、窄柄能力扩大化
  （v0.4 重定标：向包装对象注入第七方法/任一全量写方法必红，恰六键编译期+反射双守门）、sensitive 入参
  复活、limit 预截断、账本直引、影子封闭性（路径形参走私、白名单外键、非受控原因码、termNorm 落盘）
  等注入必红。
- 验收仍不报统计达标，只报功能正确性、四态计数、shadow 差异分布（含 multi-accept 频率、staleness）
  与变异反证。

## 10. 与 #42 / #43 的关系

- 与 #42（自动建卡替换人工 seed）共用“运行期访问/写 memory-index”的架构门：WP3 的 M6 修订与装配
  目录归属两案合并评审，避免两次改门；实现独立排期，本提纲不夹带建卡逻辑。
- #43（700 字窗口/槽位）继续延后，本层不引用窗口参数。

## 11. 开放问题与已收敛结论

| 编号 | v0.1 问题 | v0.3 结论 |
|---|---|---|
| Q1 | 是否引入显式歧义态 | **不加**；以 N10 影子观测 + accepted>1 全量呈现替代 |
| Q2 | M6 开门 (a)/(b) | **(a) 独立装配目录 + 默认拒绝显式枚举白名单** |
| Q3 | memory-index 首建/打开/重置/漂移协议 | 已收敛，见下“首建与漂移协议” |
| Q4 | 开关默认与转 on 门槛 | 默认 off；门槛为评审基线（非硬编码常数），见下 |
| Q5 | 影子观测存放 | **`projection/memory-shadow/`**，外部离线重建、term_hash 纪律、跨重启持久 |

**Q3 首建与漂移协议（细则，接线前成文）**：

1. 生产索引由离线 builder `--apply` 首建（既有 CLI，显式人工授权）；运行期窄柄工厂**只开不建**——
   库不存在（NotFoundError）时降级为 off 行为并留可观测日志。
2. **指纹漂移二分策略（N15，M3 原语冻结不改）**：`verifyStampedFingerprint` 保持“不符即抛
   MemoryIndexStaleError”的硬原语（store.ts:325-334）；运行期策略层捕获后，基于 TruthFingerprint 的
   files[路径+sha] 列表比对当前真值重算结果：
   - **预期漂移（append-only 增长）**：stamped 指纹中的旧文件路径集合 sha 全部不变、仅出现新增路径
     → 继续以最近 stamped 索引只读服务，暴露 staleness 指标（新增分片数/落后时长等），按计划由外部
     离线调度重建；不一律拒服。
   - **意外不符/损坏（fail-closed）**：旧集合内任一文件 sha 变化或消失、或库自身完整性校验失败
     （append-only 不变量被破坏）→ 拒服并告警，等待离线重建/修复。
   - 判定所需信息全部来自现有 TruthFingerprint 结构，不向真值加字段；无法明确归类时按损坏处理。
   具体 staleness 指标口径与重建周期在细则批量化登记。
3. 写单例冲突（ConflictError）降级只读；schema v1 无迁移；终极重置=删库+全量重建（§8.3）。
4. 影子索引重建与生产重建共用同一外部离线调度与授权纪律，输出落点不同（§8.2）。

**Q4 转 on 门槛（评审基线，具体数值转 on 评审拍板）**：活体查询覆盖四态且各态足量（建议 ≥200 条或
≥2 周，取晚者）；影子差异分为“预期门拒”与“回归”，未解释回归为零；敏感路径探针与“不回显”装配测试
全过；新投毒全红→绿；开关短路/shadow 落盘/窄柄扩大化/反射越权变异反证通过；**显式人工授权**切 on；
一键 off 须有测试与变异。

## 12. 流程纪律（延续第一层，不变）

- 本提纲复审通过前不编辑任何 src 实现；批准后按 WP 顺序 TDD，每个 WP 独立可回滚。
- git 不 add/commit/stash/push；真实根写/删须影响清单 + 冷备 + 显式高危授权；GitHub 推送前另做
  泄露扫描并取当次显式授权（推送门当前关闭）。
- 机制文档只存仓库 docs/ 一份；外部评审材料去标识化并附差异声明，外发优先用可直接访问的 CDN 直链。

## 13. 修订对照（v0.1 N1–N10、v0.2 复审 N11–N15、v0.4 N16、v0.5 WP4b 关闭、v0.6 真机注入修复）

| 条目 | 级别 | 处置位置与结论 |
|---|---|---|
| N1 模块粒度白名单挡不住 openMemoryWrite 越权 | 必修 | 独立窄柄工厂 + 窄类型；导出粒度门；禁自开连接；单例冲突降级（§5.2/§6） |
| N2 装配层拿不到 explained 候选 | 必修 | 读柄增量 searchExplained，旧 search 零漂移（§4） |
| N3 矩阵漏 recordMiss | 必修 | 纳入 recordMiss（观测写），“唯一卡写能力”（§5.1/§5.3） |
| N4 sensitive 写侧无守卫 | 必修 | 窄柄入参去 sensitive、内部固定 1；隐私声明分贴标签（§5.4） |
| N5 shadow 写面矛盾 | 必修 | 写面分级 memory-index / memory-shadow（§8.2） |
| N6 off 不撤销别名 | 应修 | “门 off、数据留存”；撤销协议；删库+重建才归零（§8.3） |
| N7 投毒计数 | minor | 七探针（六形态+门面）（§6.1） |
| N8 M 编号双轨 | minor | 标注“#44 变异矩阵 M10”（§5.3） |
| N9 静态自证可被绕过 | 建议 | 类型形状为主、静态扫描为辅双防线（v0.3 升级为三道，§3.2） |
| N10 别名冲突仅离线审计 | 观察 | multi-accept 统计、定期 consistency、accepted>1 全量呈现（§3.3/§8.2） |
| N11 query 对象内 limit 仍可预截断 | 必修 | 独立无 limit 入参类型 + 委托写死 limit:undefined 不转发 + 编译红/运行时无效双测试 + 门前进片切片静态红（§3.2/§4/§6.3） |
| N12 影子重建触发者/落点未登记、运行期触 builder 破面 | 必修 | 外部离线调度调 CLI、`--shadow-out` 落点、运行期白名单无 builder 且引用即红、离线授权同首建（§8.2/Q3） |
| N13 断言实现反射越权 + 账本写面未点名 | 加固 | 窄柄须委托包装新对象禁断言、Object.keys 反射测试（v0.3 五键→v0.4 六键）；白名单默认拒绝显式枚举、bm25/ledger 全排除、账本投毒、v0.4 增 shadow-write 越权 import 探针（§5.2/§6.2/§6.3/§8.2） |
| N14 D.6 “已实现”标签不准 | minor | 两条分贴“第一层事实/第二层义务”标签；§9 补不回显装配测试；窄柄去 sensitive 形参（§5.4/§9） |
| N15 “漂移即拒服”在活体系统不可操作 | 应修 | M3 原语冻结；策略层按 files[sha] 比对二分预期漂移（续服+staleness+计划重建）与损坏（fail-closed 拒服告警），无法归类按损坏（Q3） |
| N16 活体影子观测落点/执行者未定（v0.3 登记的不阻断 minor） | v0.4 裁决附条件认可 | 落地为窄柄第六窄方法 recordShadowObservation + memory 侧 shadow-write 封闭窄原语：入参六白名单字段无路径形参、受控枚举 fail-closed、term_hash 内部计算 termNorm 永不落盘、append-only、失败隔离、与 sqlite 物理隔离降级仍可写；恰六方法编译期+反射双守门、M6 投毒、无环 leaf、三态仅 shadow 写、deferred 术语冻结、观测为无 cardId 查询级聚合（§5.2/§5.3/§8.1/§8.2/§9） |

**v0.4 阻断项：无新增。** N16 经 2026-11-13 设计裁决附硬条件 a–d 认可，WP1–WP4a 已按 TDD 实现并全绿。

**v0.5 状态：WP4b 原阻塞项关闭。** 真机工具注册面经宿主包 `@deepseek-ai/dsh-tools` 实证（§7.1），
未臆造任何宿主 API；assembly 工厂 + adapter 薄壳 + plugin 接线按 TDD 落地，全量
809 tests / 809 pass / 0 fail / 0 skip、`npm run verify` exit 0，WP4a 三源码 sha 逐字不变。
剩余仅为**真机环境验收**（离线无法替代的部分：模型对已注册工具的可见性与 function-calling 路由、
工作区外影子落盘策略、宿主 peer 实配），清单见 runbook，当前不构成代码阻断。

**v0.6 状态：真机验收完成，注入缺陷修复并回归通过。** 隔离 `DSH_HOME` + 临时数据根真机实测：默认 off 工具
枚举零 `fasti_*`、不侧建 `memory-index`；shadow 下四工具均可被模型真实 function-call，`search` 回
`source=legacy`、缺离线窄柄库时 `cards_by_anchor` 回稳定码 `unavailable`、未检索即解析回
`serial-context-missing`、`add_alias` 回 `deferred/gate-not-on` 且别名零生产写，错误信封无堆栈/内部路径；
进程 `exit 0`、无 SQLite WAL/锁残留、真实数据根零写、密钥仅经环境变量注入且隔离区零命中。根因与动态
inject 修法见 §7.1（7），全量 811 全绿、变异 10/10 击杀；逐项勾选与真机降级口径见 Runbook v1.3 §10。
