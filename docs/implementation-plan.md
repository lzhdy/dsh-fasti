# A 块阶段 0–2 · 实现计划（模块拆分 + 测试计划）

> 依据：`docs/a-block-final-design.md`（定案稿，唯一架构依据）、`docs/reference/legacy-behavior-contract.md`、`docs/reference/a-block-implementation-audit.md`。
> 冲突时以定案稿为准；文档未写且属实现自定范围的，在本文「关键决策」中标注理由；需用户拍板的列在「待确认问题」。
> 本计划不含阶段 3 及之后；全部验证使用临时测试目录，不触碰任何真实数据目录。

---

## 1. 范围与非目标

| 阶段 | 交付 | 本次要做 | 明确不做 |
|---|---|---|---|
| 0 | 骨架 + 契约 | Experience schema、§9 全部原语签名契约、冻结面标识、单调 ULID | 记忆判断、主动系统、权限、身份、复盘 |
| 1 | 真源层 | 原文层（`raw-turns/` + `raw/<channel>/`）、结构层 `experiences/`、`channels.json`、单写者队列、tick | 资产层（除非 Q2 拍板需要）、转写脚本、DSH 适配器 |
| 2 | 最小投影 | `experience` / `edge` / `experience_fts` 三表 + 索引、L1→L2→L3 降级、增量更新、重建与对账 | P3 entity / P5 episode / P6 asset / P7 bla / P9 channel 等完整投影集 |

---

## 2. 环境结论（已实测，非推断）

| 项 | 实测结果 | 对实现的影响 |
|---|---|---|
| Node | v22.22.2（≥22 ✅） | 类型剥离可直接跑 `.ts` 测试 |
| `node:sqlite` | 可用，SQLite 3.51.2，**实验性 API**（会打 ExperimentalWarning） | 必须实现 L2/L3 降级路径（审计 §14） |
| FTS5 trigram | 可建表、可 MATCH | **trigram 需 ≥3 字符**：`MATCH '浏览器'` 命中，`MATCH '论文'`（2 字）**不命中**，`LIKE '%论文%'` 命中 → 见 Q1 |
| 事务 | `BEGIN/COMMIT/ROLLBACK` 正常 | 增量投影可在事务内回滚 |
| TypeScript | 5.9.3（`rewriteRelativeImportExtensions` 需 ≥5.7） | 源码用 `.ts` 扩展名导入，产物为 `.js` |
| `node --test <dir>` | **Windows 上失败**（被当作模块解析） | 测试脚本必须用 glob：`node --test "tests/**/*.test.ts"` |
| 裸 `node --test` | 会同时发现 `tests/**/*.test.ts` 与 `lib/**/*.test.js` → 重复执行 | `tsconfig` 只编译 `src`，测试不产出到 `lib` |

---

## 3. 目录结构与文件职责

仓库根 = 工作区根 `C:/Users/lizhenhui/WorkBuddy/2026-11-08-15-23-08`。

```
package.json            # dependencies 为空；devDependencies 仅 typescript + @types/node
tsconfig.json           # strict / NodeNext / ES2022 / declaration / outDir=lib（只含 src）
tsconfig.test.json      # 覆盖 src + tests，noEmit 类型检查
docs/
  a-block-final-design.md            # 定案稿副本
  reference/legacy-behavior-contract.md
  reference/a-block-implementation-audit.md
  implementation-plan.md             # 本文件
  implementation-notes.md            # 交付：实现说明（模块做了什么/关键决策/偏离/验证方式）
  acceptance-selfcheck.md            # 交付：逐条对照审计第四节验收清单，标注通过/未通过
src/
  contract/                # 阶段 0：契约层（先写死，无实现）
    experience.ts           # Experience / Pointer / Edge / MediaRef / Mark 类型 + 校验器
    raw-turn.ts             # RawTurn 8 字段类型 + 校验
    channel.ts              # ChannelDescriptor 类型 + 校验
    primitives.ts           # §9 全部 14 原语签名接口 FastiPrimitives + 逐条错误约定
    frozen-surface.ts       # 冻结面五条的代码级标识与断言辅助
    index.ts                # 契约层统一出口
  core/                    # 零依赖基础设施（仅 node: 内置）
    ulid.ts                 # 单调 ULID：48bit ms + 80bit 熵，同毫秒递增，时钟回拨不回退
    hash.ts                 # sha256（node:crypto）
    time.ts                 # ISO8601 ↔ ms、分片键、时钟抽象
    errors.ts               # 错误类型层级（契约级抛错约定的实现）
    jsonl.ts                # JSONL 严格读写：坏行抛错，绝不静默
    fsx.ts                  # 原子写 / append-only 追加 / manifest 维护
  source/                   # 阶段 1：真源层
    paths.ts                # 数据根三级解析 + 目录布局
    writer-queue.ts         # 单写者 Promise 串行队列
    raw-log.ts              # 原文层：raw-turns/ 与 raw/<channel>/ 同构、append-only、无去重
    experience-log.ts       # 结构层：experiences/YYYY-MM.jsonl + manifest，id 幂等
    channels.ts             # channels.json 注册表（预置 dsh，注册不破坏既有条目）
    tick.ts                 # tick 分配（真源 max(tick)+1 起步，自愈）
  projection/               # 阶段 2：投影层
    types.ts                # ProjectionEngine 统一接口 + 投影行类型
    schema.ts               # §7.1 三表 DDL（P1/P2/P4）与索引
    sqlite.ts               # L1 引擎（node:sqlite）
    jsonl.ts                # L2 引擎（JSONL：时间索引 / 通道索引 / 词法倒排）
    source-scan.ts          # L3 引擎（真源直读，惰性扫分片）
    detect.ts               # 引擎探测与降级选择（动态 import + 手动覆盖）
    rebuild.ts              # 重建协议（§7.3）+ 对账报告
    index.ts                # 投影门面：open / query / search / edges / rebuild
  runtime/
    checkpoint.ts           # 运行态检查点：tick 计数器、引擎级别、降级标注
  api/
    index.ts                # 对外原语实现（FastiApi），实现 contract/primitives.ts
tests/
  contract/  core/  source/  projection/  api/    # 与 src/ 同构
```

与定案稿 §18.4 的差异（均为**加法**，不改名不删文件）：新增 `contract/`（阶段 0 契约的落位）、`core/`（ULID/哈希/JSONL/原子写等共用原语）；`projection/fallback-jsonl.ts` 命名为 `projection/jsonl.ts` 以与 `sqlite.ts` / `source-scan.ts` 的引擎命名对齐（文档中该项标为「可由实现者自定」）。

---

## 4. 各阶段实现口径

### 阶段 0 · 契约

- **Experience schema**：字段与 §4.2 逐条对应（`id / schema_version / kind / scene / initiation / agent_meta / observation / action / outcome / occurred_at / recorded_at / tick / marks / pointers`）。`kind` / `scene.channel` / `initiation` / `action.type` / `edge.type` 均为开放枚举（含 `string`）；**不设** `importance` / `salience` / `priority` 类字段；**不设** `session_id` / `chat` / `conversation` 类前提字段（会话只以 `scene.ref` 承载）。未知字段原样保留、不丢弃（§10.4 C2）。
- **原语契约**：`contract/primitives.ts` 给出 §9 全部 14 个原语的入参 / 返回 / 同步异步 / 抛错约定；本阶段落地 10 个，未落地 4 个（`ingestMedia` / `preserveMedia` / `getMedia` / `queryEntity`）抛 `NotImplementedError` 并注明归属阶段，不静默返回空。
- **冻结面**：§10.1 五条在 `frozen-surface.ts` 中具名，并通过**代码结构**保证无绕过路径——真源层只导出追加/读取能力，不导出任何 update/delete/rewrite；投影写入只经投影门面。测试以静态扫描导出符号的方式验证。
- **ULID**：Crockford Base32，48bit 毫秒 + 80bit 熵；同毫秒内随机段单调递增；时钟回拨时沿用上次时间戳并继续递增随机段，保证「不产生比上一条更小的 id」。

### 阶段 1 · 真源层

- **原文层**：`RawTurn` 8 字段（`event_id / session_id / turn_id / speaker / raw_text / asserted_at / ingested_at / content_hash`）。append-only、**不去重**（旧契约 1.1「原文层必须全量，去重责任在调用方」）。原文行身份 = `event_id`（通道命名空间内唯一），即 §4.5 指针 `id` 的目标。
- **结构层**：`experiences/YYYY-MM.jsonl` + `manifest.json`。append 以 `id` 为幂等键：重复 id 视为重试，返回既有条目、不二次写入、不报错。
- **channels.json**：首次初始化预置 `dsh` 描述符；`registerChannel` 追加不破坏既有条目；同 id 重复注册时等价→幂等，不等价→`ConflictError`。
- **tick**：权威来源是真源 `experiences` 的 `max(tick)+1`（投影不可用则直接扫分片），符合 §8.1「max+1 自愈」与审计口径 9；乱序到达时 tick 与 `occurred_at` 允许不一致（§5）。
- **单写者**：单进程 Promise 串行队列，所有真源写入经此队列；追加与 tick 分配在队列内原子完成。

### 阶段 2 · 最小投影

- **三表**：`experience`（含 `status TEXT DEFAULT 'active'`）、`experience_fts`（`fts5(text, tokenize='trigram')`）、`edge`（bi-temporal：valid/invalid/created/expired/confidence/reason/provenance），索引 `idx_exp_time / idx_exp_kind / idx_exp_channel / idx_edge_src / idx_edge_dst` 全部建立，字段与 §7.1 一致。
- **FTS 文本来源**：经 `observation.text` 指针**回原文**取正文 + 叠加 `observation.cue`，索引原文与线索，**不索引摘要**（审计口径 11）。
- **pointers → edge**：`src = experience.id`、`predicate = pointer.type`、`dst = pointer.target`、`valid_ms = occurred_ms`、`created_ms = recorded_ms`、`reason = pointer.note`、`provenance = 'experience.pointers'`（审计口径 12）。
- **增量更新**：写者队列内追加真源后同步增量更新投影，L1 用事务；失败回滚并置「需重建」标记，真源写入不回滚（真源是唯一权威）。
- **降级**：动态 `import('node:sqlite')` 包 try/catch，导入失败或运行期模块禁用 → L2；L2 索引损坏 → L3（真源直读）；降级状态写检查点并在状态接口标注（审计口径 14）。
- **重建与对账**：新建投影 → 顺序扫描真源折叠 → 对账 → 原子换名（§7.3）。对账产出结构化报告，不静默通过。

---

## 8. 用户拍板结论（2026-11-08）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | trigram 对 <3 字符中文不命中 | **L1 trigram + LIKE 回退**；L2/L3 用词法倒排 + 子串匹配；三档统一「子串、ASCII 大小写不敏感」语义，保证「每级功能不丢」 |
| Q2 | 阶段 0–2 是否实现资产层 | **不实现**；对账报告中 media/asset 一项显式标注「N/A（资产层属阶段 3+）」并说明依据，其余对账项照做 |
| Q3 | `$DSH_HOME` 语义 | **`$DSH_HOME/fasti`**（DSH_HOME 作为 `~/.dsh` 的替代基址，沿用旧 paths.ts:90 语义）；默认根 `~/.dsh/fasti` |
| Q4 | 原文层物理布局 | **dsh → `raw-turns/`，其余通道 → `raw/<channel>/`**；两处共用同一套 RawLog 实现、8 字段完全同构 |

## 9. 关键决策（文档未写，实现者自定，附理由）

| # | 决策 | 理由 |
|---|---|---|
| D-1 | 仓库根 = 工作区根目录 | 交付要求「完整可运行仓库」且工作区为空 |
| D-2 | 源码导入使用 `.ts` 扩展名 + `rewriteRelativeImportExtensions`；`npm run build` 产出 `lib/`，测试用 `node --test "tests/**/*.test.ts"` 直接跑 TS | 一套代码同时满足「build 通过」与「node --test 全绿」；规避 Windows 下 `node --test <dir>` 失效与裸跑重复执行 |
| D-3 | 分片键取**摄入月**（原文层 `ingested_at` 月 / 结构层 `recorded_at` 月） | 摄入月单调、迟到条目自然落入当前月，与 §5「recorded_at 主窗口 + 迟到清单」备案一致；`occurred_at` 乱序不影响分片稳定 |
| D-4 | 原文行身份 = `event_id`；`Pointer.id` 指向它，`channel/shard/seq` 为冗余加速 | §4.5 明确转写时 `experience.observation.text.id = event_id` |
| D-5 | 三档投影的检索语义统一为「子串匹配，ASCII 大小写不敏感」 | trigram 在 <3 字符时失效，统一语义才能兑现「每级功能不丢」 |
| D-6 | tick 权威 = 真源 `max(tick)+1`，检查点仅作加速 | §8.1 允许检查点丢失后自愈，真源才是唯一权威 |
| D-7 | `channels.json` 重复注册同 id：内容等价→幂等返回；不等价→`ConflictError` | 「注册/追加不破坏既有条目」需可判定 |
| D-8 | 生产 `dependencies` 为空对象，`devDependencies` 仅 `typescript` + `@types/node` | 硬约束「生产 dependencies 保持为空」 |

---

## 6. 测试计划（与审计第四节验收清单逐条对应）

| 验收条目 | 落位测试文件 | 断言要点 |
|---|---|---|
| Experience schema 逐字段对应、无重要性字段、无聊天前提 | `tests/contract/experience.test.ts` | 序列化键集合 === §4.2 字段表；无 importance/salience 类键；`kind='perception'` 亦成立 |
| 原语 `.d.ts` 契约齐全、错误约定明确 | `tests/contract/primitives.test.ts` | 14 原语签名齐备；缺指针/越界/坏哈希一律抛错不返回空 |
| 冻结面五条可识别、无绕过路径 | `tests/contract/frozen-surface.test.ts` | 真源层导出符号中无 update/delete/rewrite/mutate 类动词 |
| ULID 单调变体 + 时钟回拨测试 | `tests/core/ulid.test.ts` | 同毫秒严格递增；回拨后 id 不变小；字典序 == 时间序 |
| 数据根三级优先级可验证 | `tests/source/paths.test.ts` | 显式配置 > `$DSH_HOME` > 默认，逐级覆盖 |
| 原文层 raw-turns 与 raw/<channel> 同构、append-only、无去重 | `tests/source/raw-log.test.ts` | 8 字段一致；同 event_id 两次追加 → 两行都在 |
| 结构层分片 + manifest、append 以 id 幂等 | `tests/source/experience-log.test.ts` | 重复 id 不二次写入且返回既有条目；manifest 原子写 |
| ULID 全局有序、双定位指针可解析 | `tests/source/pointer.test.ts` | 按 id 与按 channel+shard+seq 均解析到同一行 |
| channels.json 预置 dsh、注册不破坏既有 | `tests/source/channels.test.ts` | 注册 qq 后 dsh 条目逐字不变 |
| tick 单调、乱序允许 | `tests/source/tick.test.ts` | tick 严格递增；`occurred_at` 逆序时二者可不一致 |
| 单写者并发无交叉写入、无分片损坏 | `tests/source/writer-queue.test.ts` | 并发 append 后逐行 JSON 可解析、条数正确、manifest 一致 |
| 三表 + 索引建立、字段与 §7.1 一致 | `tests/projection/sqlite.test.ts` | `PRAGMA table_info` 与索引名逐项比对 |
| FTS 文本来自原文回读 + cue、trigram 中文可命中 | `tests/projection/fts.test.ts` | 索引内容含原文片段与 cue、不含摘要；中文查询命中 |
| pointers 折叠进 edge、predicate 与来源一致 | `tests/projection/edge.test.ts` | edge 行 `src/predicate/dst/valid_ms/created_ms` 逐项比对 |
| 增量与真源事务内一致；强制失败后可触发重建 | `tests/projection/incremental.test.ts` | 注入故障 → 投影回滚、标记需重建、真源仍在 → 重建后一致 |
| L1→L2→L3 可手动触发、每级功能不丢、降级有标注 | `tests/projection/degrade.test.ts` | 手动切档后同一查询结果集一致；检查点记录降级与原因 |
| 全量重建后对账 | `tests/projection/rebuild.test.ts` | RawTurn 数 vs dialogue 经历数；通道 count vs channels.json；media/asset 见 Q2 |
| `npm run build` 通过、`node --test` 全绿 | 构建脚本 + 全部用例 | 见 §2 环境结论的调用方式 |
| 旧行为契约第三节 14 类边界 | `tests/api/legacy-boundaries.test.ts` | 覆盖矩阵见 §7 |

### 旧行为契约 14 类边界 · 覆盖矩阵

| # | 边界 | 阶段 0–2 归属 | 处置 |
|---|---|---|---|
| 1 | 空消息 / 纯空白 / 超长 | **本阶段覆盖** | 原文层原样落盘，不裁剪不丢弃 |
| 2 | 斜杠命令 | 阶段 4（DSH 适配器） | 记录归属，本阶段不实现 |
| 3 | 极短消息（1–7 字） | **本阶段覆盖** | 原文层不因长度丢弃任何一行 |
| 4 | 纯 emoji / 纯标点 | **本阶段覆盖** | 同上 |
| 5 | 附件消息（含 `image/offload` 缺失） | 资产层 / 阶段 4 | 依赖 Q2 结论 |
| 6 | assistant content 形态差异 | 阶段 4（适配器） | 原文层只做形状无关的字段容错 |
| 7 | 缺失 `event.time` / `session.id` / 消息 id | **本阶段覆盖** | `asserted_at` 缺失留空不伪造当前时间；`session_id` 缺失留空串不报错 |
| 8 | 跨零点 / 跨月分片 | **本阶段覆盖** | 摄入月分片 + 月边界用例 |
| 9 | 星期词 / 相对时间表述 | B / C 块 | 记录归属 |
| 10 | 重复事件（10 分钟窗口内外） | **本阶段覆盖** | 原文层不去重、重复即两行（旧契约 1.1 明文设计） |
| 11 | 并发写入同一分片 | **本阶段覆盖** | 单写者队列用例 |
| 12 | 读失败与损坏文件必须抛出 | **本阶段覆盖** | JSONL 坏行 / manifest 损坏一律抛错，不静默 |
| 13 | LLM 超时 / 非法 JSON / 返回空 | B 块 | 记录归属 |
| 14 | 降级模式下的产出标记 | **本阶段覆盖（投影降级）** | 降级状态写检查点并对外标注 |

---

## 7. 交付物

1. 完整可运行仓库（`npm run build` 通过、`npm test` 全绿、裸 `node --test` 亦全绿）。
2. `docs/implementation-notes.md`：各模块做了什么、关键决策、偏离文档之处及影响、验证方式。
3. `docs/acceptance-selfcheck.md`：逐条对照审计第四节验收清单，标注通过 / 未通过 / 部分通过（含依据）。
4. `docs/reference/` 下三份依据文档副本，保证仓库自包含。

---

## 8. 待确认问题（需拍板，见随附选项卡）

| # | 问题 | 倾向 |
|---|---|---|
| Q1 | trigram 对 <3 字符中文查询不命中，如何与「每级功能不丢」对齐 | L1 增加 LIKE 回退 + 三层统一子串语义 |
| Q2 | 阶段 0–2 是否实现最小资产层，以使「media 数 = asset 数」对账成立 | 不实现资产层，对账该项显式标注 N/A 并给出计数 |
| Q3 | `raw-turns/` 与 `raw/<channel>/` 的通道归属 | dsh → `raw-turns/`，其余 → `raw/<channel>/`，两处同构 |
| Q4 | 降级手动触发入口 | 环境变量 + API 参数双入口（测试用参数，宿主用环境变量） |
