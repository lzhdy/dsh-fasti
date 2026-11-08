# 实现说明 —— A 块阶段 0–2

> 依据：`docs/a-block-final-design.md`（定案稿）、`docs/reference/legacy-behavior-contract.md`、`docs/reference/a-block-implementation-audit.md`。
> 实现范围：阶段 0（骨架 + 契约）、阶段 1（真源层）、阶段 2（最小投影）。不含阶段 3 及之后。
> 全部验证使用临时目录，**未读写任何真实数据目录**。

---

## 1. 各模块做了什么

### 1.1 `src/contract/` —— 阶段 0 契约层

| 文件 | 职责 | 关键点 |
|---|---|---|
| `experience.ts` | §4.2 全字段类型 + 开放枚举 + 禁止字段清单 | `kind`/`channel`/`initiation`/`action.type`/`edge.type` 均为「已知值 + 任意 string」；`FORBIDDEN_SEMANTIC_FIELDS`（importance 类）与 `FORBIDDEN_CONVERSATION_FIELDS`（chat/session 类）是把关红线 |
| `validate-experience.ts` | 校验器 | **读取路径未知字段原样保留**（§10.4 C2）；**写入路径拒绝禁止字段名**；cue 硬上限 200 字符 |
| `raw-turn.ts` | RawTurn 8 字段 + 归一化 | `session_id` 缺失→空串；`asserted_at` 缺失→空串（**不伪造当前时间**）；`content_hash=sha256(raw_text)` |
| `channel.ts` | ChannelDescriptor + 预置 dsh | `capture` 三值闭集（采集策略）、`modalities` 开放枚举 |
| `primitives.ts` | §9 全部 14 原语的签名 + 错误约定 | `PRIMITIVE_NAMES` 全集；`DEFERRED_PRIMITIVES` 标注阶段 3+ 的 4 个 |
| `frozen-surface.ts` | 冻结面五条 + 可执行判据 | 「真源只增不改」通过**扫描真源层导出面**判定，不靠注释承诺 |

### 1.2 `src/core/` —— 零依赖基础设施

`ulid.ts`（自实现单调 ULID）、`hash.ts`（sha256）、`time.ts`（ISO↔毫秒、本地日期、分片键）、`errors.ts`（错误层级）、`jsonl.ts`（严格 JSONL）、`fsx.ts`（原子写、append-only 追加）。

### 1.3 `src/source/` —— 阶段 1 真源层

| 文件 | 职责 |
|---|---|
| `paths.ts` | 数据根三级解析（显式 > `$DSH_HOME/fasti` > `~/.dsh/fasti`）+ 目录布局 |
| `writer-queue.ts` | 单进程 Promise 串行队列（单写者） |
| `raw-log.ts` | 原文层：`raw-turns/` 与 `raw/<channel>/` 同构、append-only、**不去重**、双定位指针解析 |
| `experience-log.ts` | 结构层：`experiences/YYYY-MM.jsonl` + manifest、**以 id 为幂等键**、真源 `max(tick)` |
| `channels.ts` | `channels.json` 注册表（预置 dsh、注册不破坏既有、同 id 不等价抛冲突） |
| `tick.ts` | tick 分配器（单调、与 ULID 相互独立） |

### 1.4 `src/projection/` —— 阶段 2 最小投影

| 文件 | 职责 |
|---|---|
| `schema.ts` | §7.1 三表 DDL 与索引，**逐字照抄定案稿**（含 `tokenize='trigram'`） |
| `sqlite.ts` | L1 引擎：真事务、FTS5 trigram + LIKE 回退 |
| `jsonl.ts` | L2 引擎：时间索引 / 通道索引 / 词法倒排三类索引（倒排按**字符三元组**建，与 L1 trigram 同构） |
| `source-scan.ts` | L3 引擎：真源直读（无投影存储，upsert 为 no-op） |
| `detect.ts` | 引擎探测与降级选择；损坏投影文件隔离 |
| `rebuild.ts` | 重建协议（清空 → 扫描真源折叠 → 对账）与结构化对账报告 |
| `types.ts` | 三档共用语义：ASCII 大小写不敏感子串匹配 |
| `edge.ts` | **边的唯一口径**：edge id 与边行的派生（增量写入 / 全量重建 / L3 直读三处共用） |

### 1.5 `src/runtime/checkpoint.ts` 与 `src/api/index.ts`

检查点（tick 计数器、引擎档位、降级标注、需重建标记）与接口层（实现 `FastiPrimitives` 全部 14 原语）。

---

## 2. 关键决策

### 2.1 用户拍板项（2026-11-08）

| # | 结论 |
|---|---|
| Q1 | L1 = trigram 主路径 + LIKE 回退；L2/L3 = 词法倒排 + 子串匹配；三档统一「子串、ASCII 大小写不敏感」语义 |
| Q2 | 阶段 0–2 **不实现资产层**；对账中 media/asset 项显式标注 N/A |
| Q3 | `$DSH_HOME` 是 `~/.dsh` 的替代基址 → 根为 `$DSH_HOME/fasti` |
| Q4 | 降级手动触发：环境变量 `FASTI_PROJECTION_ENGINE` + API 参数 `projectionLevel` 双入口 |

### 2.2 实现者自定项

| # | 决策 | 理由 |
|---|---|---|
| D-1 | 仓库根 = 工作区根目录 | 交付要求「完整可运行仓库」 |
| D-2 | 源码用 `.ts` 扩展名导入 + `rewriteRelativeImportExtensions`；`npm run build` 产出 `lib/`，测试用 `node --test "tests/**/*.test.ts"` | 一套代码同时满足「build 通过」与「node --test 全绿」；规避 Windows 下 `node --test <目录>` 失效与裸跑重复执行 |
| D-3 | 分片键取**摄入月**（`ingested_at`/`recorded_at` 所在月，本地日期口径） | 摄入月单调、迟到条目自然落入当前月；沿用旧项目 `localDateString`（旧行为契约 1.4） |
| D-4 | 原文行身份 = `event_id`；`Pointer.id` 指向它 | §4.5 明确转写时 `experience.observation.text.id = event_id` |
| D-5 | 三档检索统一为「子串、ASCII 大小写不敏感」 | trigram 对 <3 字符不命中，需统一语义才能兑现「每级功能不丢」 |
| D-6 | tick 权威 = 真源 `max(tick)`；检查点仅作加速 | §8.1 允许检查点丢失后自愈 |
| D-7 | 同 id 重复注册通道：等价幂等、不等价抛 `ConflictError` | 「注册/追加不破坏既有条目」需可判定 |
| D-8 | 生产 `dependencies` 为空对象；`devDependencies` 仅 `typescript` + `@types/node` | 硬约束「生产 dependencies 保持为空」 |
| D-9 | 边的 id 由 `(src, predicate, dst)` 确定性派生 | 重建幂等：同一条关系永远同一 id |
| D-10 | FTS 行以 `experience.tick` 为 rowid | `tick` 是 UNIQUE 整数 → FTS ↔ experience 无需额外映射表，保持 §7.1「最小三表」不增表 |
| D-11 | edge id = `edge_<sha256(src \0 predicate \0 dst) 前 32 hex>`；边行由 `projection/edge.ts` 单点派生 | 审计 M1：id 只由边的三元组决定 → 重建前后恒定、三档逐字一致；用不可见分隔符而非 `_` 拼接 → predicate/dst 含下划线时不撞车 |
| D-12 | `queryEdges` 返回**边行**（含 valid_ms / invalid_ms / confidence / reason），不再是边的源经历 | 审计 Q1 澄清：as-of「她在 T 时刻相信什么」依赖边的有效期窗，只返回源经历会丢掉这些属性 |
| D-13 | `tick()` 返回**已分配的最大 tick**（空真源为 -1），不再是「下一个将分配的序号」 | 审计 Q2 澄清：名称叫「节拍序号」，语义应是「她当前所处的节拍」；写入一条 tick=0 的经历后返回 0 而非 1 |

---

## 3. 偏离定案稿之处

**无实质偏离。** 以下三处是对文档留白处的**收敛性解释**，已在本文件与代码注释中写明：

| # | 文档留白 | 本实现 | 依据 |
|---|---|---|---|
| 1 | §9 说 `appendExperience`「分配 recorded_at/tick」，§12 又要求转写行 `recorded_at=ingested_at` | 调用方**未提供**时由 A 分配当前时刻；**显式提供**时予以保留。`tick` 始终由 A 分配 | 二者本可同时成立：§9 是常规路径，§12 是回填路径；落盘后一律永不改写（§5「系统轴永不」） |
| 2 | §7.1 的 `experience` 表无「投影行 ↔ 真源落点」的显式映射 | 投影行的 `shard`/`seq` 填**真源真实落点** | 双定位指针（冻结面第 2 条）要求「id 权威 + channel/shard/seq 冗余」可从投影反查真源 |
| 3 | §16-4「投影损坏自动检测周期与自动重建入口」未给实现 | 引擎档位变更或检查点标记需重建时，**启动即从真源重建**；L1 打开失败时隔离损坏文件（改名保留，不删除） | 投影是可丢弃资产、真源是权威；自动重建是「投影皆可从真源重建」的必然推论 |

---

## 4. 实现过程中发现并修复的实质缺陷

这些不是「顺手写的」，是测试逼出来的真问题，记录在此以便审计复核：

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 1 | **降级到 L2/L3 后投影为空** —— 新引擎的存储是空的，检索能力静默丢失 | 违反「任何降级都不影响数据完整性」（§7.4） | 引擎档位变更时**启动即从真源重建投影**（`api/index.ts` `initEngine`） |
| 2 | **投影库打开失败时 `DatabaseSync` 句柄泄漏** | 损坏文件被占用，Windows 上无法删除/替换 | `sqlite.ts` `open()` 失败时显式关闭句柄；`detect.ts` 隔离损坏文件 |
| 3 | **首个 tick 从 1 起跳** —— 空真源时 `maxTick()` 返回 0，`fromSource(0)+1=1` | 白白浪费一个节拍序号 | `maxTick()` 空目录返回 -1（语义：尚未分配过任何 tick） |
| 4 | **`tick` 在写入路径被强制校验** —— 而 tick 本就由 A 分配 | 调用方合法省略 `tick` 时被拒 | 写入路径允许缺省（占位 0，随后被 A 覆盖）；读取路径仍强制 |
| 5 | **清单损坏抛裸 `SyntaxError`** | 错误层级不一致 | 统一为 `CorruptedError` |
| 6 | **`recorded_at` 被无条件覆盖为当前时刻** | §12 转写行的系统轴会失真 | 见 §3-1 |
| 7 | **L2 漏掉「词内子串」查询** —— L2 倒排按整词建索引，`brows`（在 `browser` 内）查不到，而 L1/L3 命中 | 违反「每级功能不丢」（审计第四节阶段 2） | L2 倒排改为**字符三元组**建索引（与 FTS5 trigram 同构），给出真子串命中的超集，再由精确判定收口；新增 `tests/projection/parity.test.ts` 断言三档结果集完全一致 |

---

## 5. 0.1.0 代码审计报告的逐条处理

审计对象：`dsh-fasti-a-block-0.1.0.zip`（见 `docs/audit-response-0.1.0.md` 全文）。

| # | 审计条目 | 处理 | 落点 |
|---|---|---|---|
| **M1** | edge id 三处口径不统一 → 重建前后同一条边 id 变化；L3 与 L1/L2 不一致 | **已修**：edge id 与边行抽出为 `projection/edge.ts` 单一实现，三条路径共用 | `src/projection/edge.ts`；增量写入 `api/index.ts`、全量重建 `projection/rebuild.ts`、L3 直读 `projection/source-scan.ts` |
| m1 | 8 个零调用导出（死代码） | **已删**：`tickSource` / `scanShards` / `isExperienceShard` / `manifestExists` / `indexFilesPresent` / `detectJsonlCorruption` / `withCurrentSchemaVersion` / `resetSqliteCache`；连带清理未用 import | 8 个源文件 |
| m2 | 全项目同步文件 I/O，阻塞事件循环 | **本阶段保留**（阶段 0–2 数据量小，单写者串行队列下数据一致性安全）；登记为**阶段 3+ 性能复核项** —— 接入高频 notice 流或高并发通道前须评估改异步 I/O | 见 §6 复核项清单 |
| m3 | 默认新建 `UlidGenerator`，未复用 `defaultUlid` 单例 | **已澄清并落实**：查证 `this.ulid` 从未被读取 —— A 块门面**不铸造** ULID（`experience.id` 由调用方提供），故移除误导性的 `FastiOptions.ulid` 注入点；`defaultUlid` 单例保留为调用方与阶段 3+ 的进程级入口，并补断言锁定其跨实例全局单调 | `src/api/index.ts`（移除死注入点）、`src/core/ulid.ts`（单例口径注释）、`tests/core/ulid.test.ts`（新增单调性用例） |
| **Q1** | `queryEdges` 名义查边、实际返回源经历 | **已澄清**：返回**边行**（含 `valid_ms` / `invalid_ms` / `confidence` / `reason`）—— as-of 语义依赖边的有效期窗，只返回源经历会丢掉这些属性；需源经历内容时用返回行的 `src` 再调 `query` | `src/contract/primitives.ts`（新增 `EdgeView`）、`src/api/index.ts` |
| **Q2** | `tick()` 返回「下一个将分配值」而非「当前已分配最大值」 | **已澄清**：返回**已分配的最大 tick**（空真源为 -1）。写入一条 tick=0 的经历后返回 0（她所处的节拍），而非 1（下一个待分配序号） | `src/contract/primitives.ts`、`src/api/index.ts` |

### M1 的一致性断言（新增 `tests/projection/edge-id.test.ts`）

审计指出原缺陷在测试全绿时未被抓到，因为 parity 测试比的是**经历 id**（即 `src`）而非边表内部 id。故新增 5 条断言：

| 断言 | 锁住什么 |
|---|---|
| 增量写入与全量重建后 edge 内部 id 逐字一致 | M1 的核心症状（重建前后 id 变化） |
| 三档引擎对同一条边给出逐字相同的内部 id | 跨档一致性（原先比错了对象） |
| 边 id 只由 (src, predicate, dst) 决定 | 与写入顺序、写入路径、note 等可变字段无关 |
| 含下划线的 predicate / dst 不产生歧义 | 分隔符用不可见字符而非 `_`，杜绝拼接撞车 |
| 边 id 格式稳定：`edge_` + 32 位十六进制 | 格式回归 |

**断言有效性已实测**：把增量写入路径改回旧口径（与重建路径不一致）后，上述前三条断言**立即失败**；还原后全绿 —— 断言确实能捕获原缺陷，而非恒真。

---

## 6. 验证方式

```bash
npm run build      # tsc -p tsconfig.json → lib/（含 .d.ts 契约）
npm run typecheck  # tsc -p tsconfig.test.json（覆盖 src + tests）
npm test           # node --test "tests/**/*.test.ts"
npm run verify     # 以上三步串联
```

- 测试框架：`node:test` + `node:assert/strict`，**无任何测试依赖**。
- 全部用例使用 `os.tmpdir()` 下的临时目录，结束时清理；**不触碰真实数据目录**。
- 裸 `node --test`（审计第四节原文写法）同样全绿：`tsconfig.json` 只编译 `src`，`lib/` 下无测试文件，故不会重复执行。
- 编译产物已做冒烟验证：`lib/api/index.js` 可独立 `import` 并完成写入 → 查询 → 检索闭环。

### 环境实测结论（影响设计，非推断）

| 项 | 实测 |
|---|---|
| Node | v22.22.2 |
| `node:sqlite` | 可用，SQLite 3.51.2，**实验性 API**（会打 `ExperimentalWarning`）→ 故降级路径是必需品而非可选项 |
| FTS5 trigram | 可建表可 MATCH；**但需 ≥3 字符**（实测 `MATCH '论文'`（2 字）0 命中，`LIKE '%论文%'` 命中）→ Q1 的回退路径由此而来 |
| trigram 语义 | `MATCH` 折叠 Unicode 大小写，是 ASCII 子串匹配的**超集** → 可作快速预筛，再以统一语义精确收口 |
| `node --test <目录>` | **Windows 上失败**（被当作模块解析）→ 必须用 glob |
| TS | 5.9.3（`rewriteRelativeImportExtensions` 需 ≥5.7） |

---

## 7. 旧行为契约第三节 14 类边界 · 覆盖矩阵

| # | 边界 | 本阶段 | 落位 |
|---|---|---|---|
| 1 | 空消息 / 纯空白 / 超长消息 | ✅ 覆盖 | `tests/api/legacy-boundaries.test.ts` |
| 2 | 斜杠命令（`/` 开头） | ➖ 阶段 4 + B 块 | 规则层判定「这不是她经历的内容」，属 B 块；DSH 适配器属阶段 4 |
| 3 | 极短消息（1–7 字） | ✅ 覆盖 | 同上文件 |
| 4 | 纯 emoji / 纯标点 | ✅ 覆盖 | 同上文件 |
| 5 | 附件消息（`image/offload` 缺失） | ➖ 阶段 3+/4 | 字节落资产层（阶段 3+）、适配器捕获（阶段 4） |
| 6 | assistant `content` 形态差异 | ➖ 阶段 4 | 适配器翻写职责 |
| 7 | 缺失 `event.time` / `session.id` / 消息 id | ✅ 覆盖 | 留空不报错、不丢事件、不伪造当前时间 |
| 8 | 跨零点 / 跨月分片 | ✅ 覆盖 | 摄入月分片 |
| 9 | 星期词 / 相对时间表述 | ➖ B/C 块 | 复盘选材与「她的日历」 |
| 10 | 重复事件（10 分钟窗口内外） | ✅ 覆盖 | 原文层不去重（旧契约 1.1 有意设计） |
| 11 | 并发写入同一分片 | ✅ 覆盖 | 单写者队列 + 逐行可解析断言 |
| 12 | 读失败与损坏文件 | ✅ 覆盖 | 一律抛出，不静默、不用空串覆盖 |
| 13 | LLM 超时 / 非法 JSON / 返回空 | ➖ B 块 | 复盘调用 |
| 14 | 降级模式下的产出标记 | ✅ 覆盖 | 投影降级：检查点 + 状态接口标注 |

**9 类本阶段覆盖，5 类明确归属后续阶段 —— 不假装覆盖。** 归属断言见 `tests/api/legacy-boundaries.test.ts` 末条用例。

---

## 8. 阶段 0–2 之外、本次**未**实现的内容

资产层（staging/assets、`ingestMedia`/`preserveMedia`/`getMedia`）、实体表 P3、`queryEntity`、完整投影集其余表（P5 episode / P6 asset / P7 bla / P8 judgment_ledger / P9 channel）、转写脚本、DSH 适配器、B/C/D/E 块的一切行为。

上述内容在契约层**已声明签名并标注归属阶段**，调用时抛 `NotImplementedError`（不静默返回空）。

---

## 9. 阶段 3+ 性能复核项清单

本阶段刻意留下的技术债 —— 记录在此，避免被当成「已定方案」带进下一阶段。

| # | 复核项 | 现状 | 何时必须复核 |
|---|---|---|---|
| P-1 | **同步文件 I/O 阻塞事件循环** | `core/jsonl.ts`、`core/fsx.ts` 及 source/runtime 各模块统一用 `*Sync`；配合单写者串行队列，数据一致性安全，阶段 0–2 数据量小无实际影响 | 接入高频 notice 流通道、或出现多实例并发写同一数据根之前 |
| P-2 | **进程内 tick 计数器不跨进程** | tick 权威是真源 `max(tick)`（决策 D-6），检查点仅作加速；多进程共享同一数据根时，两进程各自从真源恢复的起点可能重叠 | 出现多进程写同一数据根的需求时（当前单写者模型下不会发生） |
| P-3 | **`Fasti` 门面不铸造 ULID** | `experience.id` 由调用方提供（阶段 4 的转写脚本负责写新 ULID）；门面侧不持有生成器，调用方应使用 `core/ulid.ts` 的 `defaultUlid` 单例以保进程内全局单调 | 阶段 3+ 媒体/资产 id 落地时确认调用方确实使用单例 |
