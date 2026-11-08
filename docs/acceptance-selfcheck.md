# 验收自检 —— 逐条对照审计第四节验收清单

> 尺子：`docs/reference/a-block-implementation-audit.md` 第四节「阶段 0–2 验收清单」。
> 判定口径：**通过** = 有对应实现且有自动化用例断言；**部分通过** = 已实现但该条目含本阶段范围外成分（已标注）；**未通过** = 未实现或无用例覆盖。
> 验证环境：Node v22.22.2；`npm run build` 通过；`npm test` **125/125** 全绿；裸 `node --test` 同样 125/125 全绿。

---

## 阶段 0 · 骨架与契约

| # | 验收条目 | 判定 | 实现落位 | 验证用例 |
|---|---|---|---|---|
| 0-1 | Experience schema 与定案稿 §4.2 字段逐一对应，无新增「重要性」类字段、无聊天前提字段 | ✅ 通过 | `src/contract/experience.ts`、`validate-experience.ts` | `tests/contract/experience.test.ts`（字段集合逐一比对；禁止字段清单逐项扫描；开放枚举、未知字段保留、cue 上限、marks 约束） |
| 0-2 | 原语 `.d.ts` 契约齐全（§9 全部原语），错误约定明确 | ✅ 通过 | `src/contract/primitives.ts`（14 原语签名 + 逐条抛错约定）、`src/api/index.ts` | `tests/contract/primitives.test.ts`（14 原语齐备 + 实现存在性 + 缺指针/越界抛错 + 阶段外原语抛 `NotImplementedError`）；`npm run build` 产出 `lib/contract/primitives.d.ts` |
| 0-3 | 冻结面五条在代码结构上可识别、无被绕过的路径 | ✅ 通过 | `src/contract/frozen-surface.ts`（五条具名 + 可执行判据） | `tests/contract/frozen-surface.test.ts`（**静态扫描真源层导出面**：无 update/delete/rewrite 类路径；真源层无修改既有记录的方法调用；重建路径无 LLM 调用） |
| 0-4 | ULID 单调变体实现 + 时钟回拨测试通过 | ✅ 通过 | `src/core/ulid.ts` | `tests/core/ulid.test.ts`（同毫秒严格递增、时钟回拨不产生更小 id、多次回拨仍递增、字典序 == 时间序、随机熵有效） |
| 0-5 | 数据根按拍板方案解析，三级路径优先级可验证 | ✅ 通过 | `src/source/paths.ts` | `tests/source/paths.test.ts`（显式 > `$DSH_HOME/fasti` > `~/.dsh/fasti`，逐级覆盖 + 优先级互斥） |

## 阶段 1 · 真源层

| # | 验收条目 | 判定 | 实现落位 | 验证用例 |
|---|---|---|---|---|
| 1-1 | 原文层：raw-turns 与 `raw/<channel>/` 同构（8 字段），append-only、无去重 | ✅ 通过 | `src/source/raw-log.ts`、`src/contract/raw-turn.ts` | `tests/source/raw-log.test.ts`（两处目录字段集合逐项相等且恰为 8；同 event_id 两次追加得两行；空/空白/超长/极短/emoji 全部原样落盘） |
| 1-2 | 结构层：experiences 按月分片 + manifest，append 以 id 幂等（重复 id 不二次写入） | ✅ 通过 | `src/source/experience-log.ts` | `tests/source/source-layer.test.ts`（分片 + manifest `{version, months}`；重复 id `created=false` 且条目数不变） |
| 1-3 | ULID 全局有序、双定位指针（id 权威 + channel/shard/seq 冗余）可解析 | ✅ 通过 | `src/core/ulid.ts`、`src/source/raw-log.ts` | `tests/core/ulid.test.ts`（全局有序）；`tests/source/raw-log.test.ts`（按 id 与按 `(shard, seq)` 解析到同一行；区间为闭区间）；`tests/api/fasti.test.ts`（`resolvePointer` 双路径一致） |
| 1-4 | channels.json 预置 dsh，注册/追加不破坏既有条目 | ✅ 通过 | `src/source/channels.ts` | `tests/source/source-layer.test.ts`（预置 dsh 且 capture=full；注册 qq 后 dsh 条目逐字不变；同 id 等价幂等 / 不等价抛 `ConflictError`） |
| 1-5 | tick 单调、乱序到达时 tick 与 occurred_at 允许不一致（§5 语义） | ✅ 通过 | `src/source/tick.ts`、`experience-log.ts` | `tests/source/source-layer.test.ts`（tick 严格递增；乱序到达时二者顺序相反仍成立）；`tests/api/fasti.test.ts`（同）；空真源时首个 tick 为 0 |
| 1-6 | 单写者队列下并发 append 无交叉写入、无分片损坏 | ✅ 通过 | `src/source/writer-queue.ts` | `tests/source/source-layer.test.ts`（50 个并发任务最大并发度 = 1、执行顺序 == 入队顺序；某任务失败不影响后续）；`tests/api/legacy-boundaries.test.ts`（60 次并发 append 后逐行 JSON 可解析、条数正确） |

## 阶段 2 · 最小投影

| # | 验收条目 | 判定 | 实现落位 | 验证用例 |
|---|---|---|---|---|
| 2-1 | experience / edge / experience_fts 三表 + 索引建立，字段与 §7.1 一致 | ✅ 通过 | `src/projection/schema.ts`（逐字照抄 DDL）、`sqlite.ts` | `tests/projection/projection.test.ts`（`sqlite_master` 核对表名与 5 个索引名；`PRAGMA table_info` 与期望列**逐项逐类型**比对；FTS5 + `tokenize='trigram'` 核对） |
| 2-2 | FTS 文本来自原文回读 + cue（非摘要），trigram 中文可命中 | ✅ 通过 | `src/api/index.ts` `documentTextOf`、`src/projection/sqlite.ts` `prefilter` | `tests/projection/projection.test.ts`（索引内容含原文片段与 cue、不含 summary/摘要；3 字中文命中；**2 字中文经 LIKE 回退同样命中**） |
| 2-3 | experience.pointers 正确折叠进 edge，predicate 与来源一致 | ✅ 通过 | `src/projection/edge.ts` `toEdgeRow`（唯一口径，三条路径共用） | `tests/projection/projection.test.ts`（`src`/`dst`/`predicate`/`valid_ms=occurred`/`created_ms=recorded`/`reason`/`provenance` 逐项比对） |
| 2-4 | 增量投影与真源在事务内一致；强制失败后可触发重建 | ✅ 通过 | `src/projection/types.ts` `transaction`、`sqlite.ts` 真事务、`api/index.ts` | `tests/projection/transaction.test.ts`（**事务内中途失败 → 整体回滚，零残留**；增量后经验/边/文档三者齐备；投影失败时真源不回滚且标记需重建；标记后重开自动从真源重建） |
| 2-5 | L1→L2→L3 降级可手动触发验证，每级功能不丢、仅性能/丰富度下降，降级有标注 | ✅ 通过 | `src/projection/detect.ts`、`api/index.ts` | `tests/projection/parity.test.ts`（**三档检索 / 多维查询 / 边查询结果集逐项相等**，覆盖 ASCII 词内子串、中文双字与单字、Unicode、无命中；边查询比的是**边内部 id**）；`tests/projection/edge-id.test.ts`（增量写入与全量重建后边 id 逐字一致、三档边 id 一致）；`tests/projection/projection.test.ts`（手动切档 + 降级标注写检查点）；`tests/api/legacy-boundaries.test.ts`（边界 14） |
| 2-6 | 全量重建后对账：RawTurn 数 = dialogue 经历数；media 数 = asset 数；各通道 count 与 channels.json 一致 | ⚠️ **部分通过** | `src/projection/rebuild.ts` `reconcile` | `tests/projection/projection.test.ts`（RawTurn 数 == dialogue 经历数 == 1；通道 count 与 channels.json 一致；**media/asset 项显式标注 N/A**） |
| 2-7 | `npm run build` 通过；`node --test` 全绿，覆盖 legacy-behavior-contract 第三节边界 | ✅ 通过 | `package.json` `scripts` | `npm run build` 通过（产出 `lib/` 与 `.d.ts`）；`npm test` 与裸 `node --test` 均 **125/125 全绿**；边界覆盖矩阵见 `docs/implementation-notes.md` §7（9 类覆盖 + 5 类明确归属） |

### 2-6 项「部分通过」的具体说明

审计条目原文为「media 数 = asset 数」。本阶段**未实现资产层**（用户拍板 Q2），因此：

- 对账报告的 `mediaVsAsset` 字段显式标注 `applicable: false`、`assets: null`，
  并在 `reason` 字段写明「资产层属阶段 3+，本项显式标注 N/A，不作通过判定」；
- 该项**不**被计为通过，也**不**被静默跳过 —— 报告结构中显式可见；
- 待资产层落地后，该项自然转为可判定（`applicable: true`），无需改动对账代码。

其余三项（RawTurn �� = dialogue 经历数、各通道 count 与 channels.json 一致）均已通过。

---

## 汇总

| 阶段 | 条目数 | 通过 | 部分通过 | 未通过 |
|---|---|---|---|---|
| 阶段 0 · 骨架与契约 | 5 | 5 | 0 | 0 |
| 阶段 1 · 真源层 | 6 | 6 | 0 | 0 |
| 阶段 2 · 最小投影 | 7 | 6 | 1（2-6） | 0 |
| **合计** | **18** | **17** | **1** | **0** |

**未通过项：0。**

### 硬约束自检

| 约束 | 状态 | 验证方式 |
|---|---|---|
| 生产 `dependencies` 为空 | ✅ | `package.json` 中 `"dependencies": {}`；运行时依赖仅 Node 内置（`node:crypto` / `node:fs` / `node:sqlite`） |
| ULID 等全部自实现 | ✅ | `src/core/ulid.ts` 无第三方 import |
| TypeScript strict / NodeNext / ES2022 | ✅ | `tsconfig.json`；`npm run typecheck` 通过（含 `noUncheckedIndexedAccess`） |
| 测试用 Node 内置 `node:test`，不引测试框架 | ✅ | `devDependencies` 仅 `typescript` + `@types/node` |
| Node ≥ 22 | ✅ | `engines.node: ">=22"`；实测 v22.22.2 |
| 数据结构不把「聊天/对话」写为前提 | ✅ | `tests/contract/experience.test.ts` 扫描禁止字段清单；会话只以 `scene.ref` 承载 |
| 无系统判定的「重要性」字段 | ✅ | 同上；且写入路径主动拒绝此类字段名 |
| 规则层只标记、不否决 | ✅ | `marks.by` 必须为 `rule-layer`；`marks` 不参与任何是否记录的判定 |
| 真源 append-only、不可变 | ✅ | `tests/contract/frozen-surface.test.ts` 静态扫描真源层导出面 |
| 投影确定性、幂等、可从真源重建 | ✅ | 重建两次结果一致；**边 id 由内容确定性派生且重建前后恒定**（`tests/projection/edge-id.test.ts`）；引擎档位变更时自动重建 |
| 激活/频率只影响排序，不改事实状态 | ✅ | 本阶段无激活/频率机制；`experience.status` 恒为 `'active'`，投影无任何改写事实状态的路径 |
| 不读写任何真实数据目录 | ✅ | 全部用例使用 `os.tmpdir()` 临时目录 |
