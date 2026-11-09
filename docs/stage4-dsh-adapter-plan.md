# 阶段 4 实施计划：dsh 通道适配器

> 状态：**已确认并执行完毕**（用户 2026-11-08 确认六步开工，Q1–Q5 全部认可）。
> 本文档作为实施依据存档；实际落地与本文的差异见 §11「执行结果与偏离」。
> 依据：任务书《stage4-dsh-adapter-task.md》、定案稿 `docs/a-block-final-design.md`、阶段 3 脚本 `scripts/migrate-raw-turns.ts`、旧项目 `dsh-persona-innate`（只读参考）。

---

## 0. 现状盘点（已核实的关键事实）

| 事实 | 核实结果 |
|---|---|
| 主仓库提交 | `18de976`（阶段 3 脚本已入库），基线 **125 pass / 0 fail** |
| 阶段 3 脚本 | `scripts/migrate-raw-turns.ts`（1324 行）、`scripts/selftest-migration.ts`（793 行） |
| 真实数据根 | `~/.dsh/fasti`：原文 247 行 = `kind='dialogue'` 经历 247 条，指针全可解析 |
| 事件口径 | 迁移脚本的 `readHarnessSession` 已逐字复刻旧项目 `joinTextBlocks` / `assistantTextFromBlocks` / `RUNTIME_CONTEXT_RE` |
| cordis API | `@deepseek-ai/cordis@4.1.0`：`ctx.plugin({apply})` / `ctx.effect(execute, label)` / `ctx.on()` / `ctx.logger` |
| schemastery | `3.19.0` 原生带 `~standard`，可直接作 cordis `Config` schema |

**已确认的三条前提**（用户 2026-11-08 答复）：
1. 阶段 3 的 98 项 selftest 是迁移专项，**不进默认 `npm run verify`**；阶段 4 不回归主力是 `tests/` 下的 node:test。
2. `appendExperience` 拆 `appendExperienceUnlocked` 私有方法，队列只包最外层。
3. `event_id` 幂等走**真源派生**的内存映射 `(channel, event_id) → experience.id`，不新建真源表、不改 sqlite 契约。

---

## 1. 目录结构

```
src/
  api/index.ts                    ← 改：拆 appendExperienceUnlocked，新增 ingestRawTurn
  contract/primitives.ts          ← 改：契约加 ingestRawTurn（第 15 项原语）
  adapters/                       ← 新增：适配器层（唯一依赖宿主包的地方）
    dsh/
      index.ts                    ← 改：导出 apply 入口 + 公开 API
      convert-event.ts            ← 新增：事件 → RawTurnInput 纯函数（不调 LLM）
      plugin.ts                   ← 新增：cordis apply + ctx.effect 生命周期
      event-types.ts              ← 新增：session/event 载荷的最小类型声明
tests/
  adapters/dsh/
    convert-event.test.ts         ← 新增：转换口径单测
    ingest-raw-turn.test.ts       ← 新增：原语单测（写入/指针/幂等）
    plugin.test.ts                ← 新增：cordis 集成测试
```

**分层纪律**：`src/adapters/` 之外**零改动**（除 `api/index.ts`、`contract/primitives.ts` 两处必要的开放面加法）。
A 内核（`core` / `source` / `projection` / `contract`）的生产依赖仍为空。

---

## 2. `ingestRawTurn` 原语

### 2.1 签名

```ts
// src/contract/primitives.ts
export interface IngestRawTurnInput extends RawTurnInput {
  /** 发生时刻（世界轴）。缺省取 asserted_at。 */
  occurred_at?: string | undefined;
}

/** src/api/index.ts —— Fasti 类方法 */
async ingestRawTurn(channel: string, input: IngestRawTurnInput): Promise<Experience>;
```

返回既有经历（幂等命中）或新建经历。**同步/异步**：异步（涉及文件 I/O + 队列）。

### 2.2 内部流程

```
ingestRawTurn(channel, input)
  └─ this.queue.run(async () => {          ← 唯一的队列入口
       ① 幂等查表
          key = `${channel}\u0000${input.event_id}`
          hit = this.eventIndex.get(key)
          if (hit) return this.experienceLog.get(hit)   ← 零新增、不报错
       ② 写原文
          log = this.rawLog(channel)                     ← 私有缓存实例，seq 连续
          loc = log.append({...input, ingested_at: input.ingested_at ?? nowIso()})
       ③ 构造经历（不传 tick，由 A 分配）
          id = defaultUlid.next()
          scene = { channel, ref: input.session_id ?? '' }
          initiation = mapInitiation(input.speaker)      ← user→'user' / assistant→'her'
          observation.text = { id: input.event_id, channel, shard: loc.shard, seq: loc.seq }
          occurred_at = input.occurred_at ?? input.asserted_at
          recorded_at = input.ingested_at ?? nowIso()
       ④ 写结构层 + 增量更新投影
          exp = await this.appendExperienceUnlocked(experience)   ← 不再排队
       ⑤ 更新幂等表
          this.eventIndex.set(key, exp.id)
          return exp
     })
```

**关键点**：

- **②→④ 全程在同一个 `queue.run` 内**，构成单写者下的原子操作；原文与经历不会错位。
- **④ 直接调 `appendExperienceUnlocked`**，`appendExperience` 公开签名与行为不变（仍 `queue.run` 包裹）。
- `appendExperienceUnlocked` 内部**不再进入队列**，但保留全部既有逻辑：幂等检查、`recorded_at` 缺省补当前时刻、tick 分配、`updateProjection` 增量更新、投影失败回滚标记 `needs_rebuild`、检查点同步。
- 原文写成功但经历写失败时：`appendExperienceUnlocked` 的真源写入不回滚（真源是权威），投影失败只标记需重建 —— 与现有语义一致。原文层多出的行会被下次幂等扫描识别为"半成品"，**本阶段不自动回滚**（回滚需改写真源，违反冻结面第 1 条）。

### 2.3 幂等索引（真源派生）

```ts
// Fasti 私有字段
private readonly eventIndex = new Map<string, string>();   // `${channel}\0${event_id}` → experience.id
```

- **构建时机**：`Fasti.open` 的构造函数里，`experienceLog.reindex()` 之后，遍历全部经历，取 `(experience.scene.channel, experience.observation.text.id)` 建立映射。
- **键必须带 channel**：`event_id` 仅在通道命名空间内唯一。
- **进程重启后自动恢复**：索引从真源派生，不是独立真源表，符合冻结面第 5 条（投影/索引皆可从真源重建）。
- **投影重建时无需额外动作**：`rebuildProjections` 只重建投影表，索引不变（映射的来源是真源经历，不是投影）。
- **L1/L2/L3 三档通用**：索引在 API 层，与投影引擎档位无关。

> 注：`observation.text.id` 可能为空（指针允许只有 shard/seq）。这类经历不进索引 —— 它们本来就没有 event_id 幂等键。

### 2.4 冻结面核验

| 冻结面 | 本次改动的影响 |
|---|---|
| ① 真源 append-only | 只增不改；`RawLog.append` 与 `appendExperienceUnlocked` 均不改既有行 |
| ② ULID + 双定位指针 | 新经历用 `defaultUlid.next()`；指针 `{id, channel, shard, seq}` 四元齐全 |
| ③ 三段槽位 | 新经历填 `observation.text`；`action`/`outcome` 不填（dsh 对话轮次无对应结构） |
| ④ 时间三轴 | `occurred_at` = 事件时刻，`recorded_at` = 落盘时刻，`tick` = A 分配 |
| ⑤ 投影可重建 | 索引从真源派生，非独立真源；`rebuildProjections` 仍能全量重建 |

---

## 3. 事件 → `RawTurnInput` 纯转换

### 3.1 位置与签名

```ts
// src/adapters/dsh/convert-event.ts
export interface ConvertResult {
  input: RawTurnInput | null;
  /** 跳过的原因（可观测，不静默吞事件）。 */
  skip?: { reason: string; detail?: string } | undefined;
  /** 非 text 内容块告警（多模态不处理，只告警）。 */
  warnings?: string[] | undefined;
}

export function convertSessionEvent(session: unknown, event: unknown): ConvertResult;
```

**纯函数**：不调 LLM、不读文件、不写盘、不取当前时间（`ingested_at` 留空，由 `ingestRawTurn` 补）。

### 3.2 口径表（与阶段 3 脚本 `readHarnessSession` 逐条对齐）

| 环节 | 口径 |
|---|---|
| 事件类型 | 只处理 `user/message`、`assistant/message`；其余（`turn`/`step`/`request`/`command`/`system/message`/`tool/*`）→ 跳过 |
| user 过滤 | 必须 `data.source.kind === 'user'`；`runtime-context`/`time-context`/`skill-catalog` 注入 → 跳过（正常形态，不告警） |
| event_id | user → `data.id`；assistant → `data.message.id`。缺失 → 跳过 + 告警（无法建立幂等键） |
| user 正文 | `joinTextBlocks(data.content)`：text 块用**单空格** join 后 `.trim()` |
| assistant 正文 | `assistantTextFromBlocks(data.message.content) ?? assistantTextFromBlocks(data.content)`：**从后往前**取首个非空 text 块，返回该块 `.trim()`（不 join） |
| 运行时上下文 | `RUNTIME_CONTEXT_RE = /^(current runtime context\|this snapshot supersedes)/i` 二次过滤 → 跳过 + 告警 |
| 非 text 块 | 只取 text 部分，**必须告警**（不落字节、不转述） |
| 空正文 | 提取不到非空 text → 跳过 + 告警（不写空、不伪造） |
| session_id | `session.id`（缺失 → 空串，不报错、不丢事件） |
| turn_id | `''`（不可得，显式空串，禁止伪造） |
| asserted_at | 事件顶层 `time`（毫秒）→ ISO。缺失/非有限 → 跳过 + 告警（不伪造时间） |
| ingested_at | **留空** —— 由 `ingestRawTurn` 在落盘时补 `nowIso()`。这是与阶段 3 迁移脚本的**唯一差异**（迁移是回填历史，必须保留历史时间；实时摄入应记真实落盘时刻） |
| content_hash | 留空，由 `parseRawTurn` 自动算 `sha256(raw_text)` |

### 3.3 与阶段 3 的差异说明

| 维度 | 阶段 3 迁移 | 阶段 4 适配器 | 理由 |
|---|---|---|---|
| `ingested_at` | = `asserted_at`（保留历史时间） | 落盘时刻 | 实时摄入应记真实落盘时刻（世界轴/系统轴分离，定案稿 §5） |
| `speaker` | 4 类（user/assistant/system/tool） | 2 类（user/assistant） | 任务书 §4.3 明确只处理两类；tool 事件不在本阶段范围 |
| 告警渠道 | `warnings[]` 数组，报告式 | `skip`/`warnings` 结构 + logger | 适配器是实时旁路，需即时可观测 |

---

## 4. cordis 插件入口与生命周期

### 4.1 入口

```ts
// src/adapters/dsh/plugin.ts
export interface DshAdapterConfig {
  /** 数据根；缺省走 Fasti 三级解析（显式 > $DSH_HOME/fasti > ~/.dsh/fasti）。 */
  dataRoot?: string | undefined;
  /** 通道 id；缺省 'dsh'。 */
  channel?: string | undefined;
}

export function apply(ctx: Context, config: DshAdapterConfig): void;
```

以 cordis **对象插件** 形式导出：`export default { name: 'dsh-fasti-adapter', apply }`。

### 4.2 生命周期（`ctx.effect`）

```
apply(ctx, config)
  └─ ctx.effect(async () => {
       ① fasti = await Fasti.open({ dataRoot: config.dataRoot })   ← 插件装载时打开
       ② 核对通道已注册：fasti.channels.has('dsh') 为真则继续；
          否则 ctx.logger.warn(...) 并放弃写入（不自动注册 —— 注册表纪律见 §4.5）
       ③ ctx.on('session/event', handler)                          ← 事件监听
       ④ 返回清理函数：await fasti.close()                        ← 卸载时关闭
     }, 'dsh-fasti-adapter')
```

- `ctx.effect(execute, label)` 的 `execute` 返回 `Promise<Disposable>` —— cordis 4.1 的 `Effect` 类型原生支持。
- 卸载时 disposer 被调用 → `fasti.close()` 释放 SQLite 句柄（Windows 上否则数据根无法删除）。
- `ctx.on` 的监听器由 cordis 随 fiber 自动释放。

### 4.3 事件处理（旁路捕获，不阻断主链路）

```ts
ctx.on('session/event', (session, event) => {
  void handleSessionEvent(session, event);   // 不 await，不阻断 dsh 主链路
});

async function handleSessionEvent(session, event) {
  try {
    const { input, skip, warnings } = convertSessionEvent(session, event);
    if (warnings?.length) for (const w of warnings) ctx.logger.warn('[dsh-fasti] %s', w);
    if (input === null) {
      if (skip) ctx.logger.debug('[dsh-fasti] 跳过事件：%s', skip.reason);
      return;                                   // 正常跳过，不算错误
    }
    await fasti.ingestRawTurn(channel, input);
  } catch (err) {
    ctx.logger.error('[dsh-fasti] 摄入失败：%s', String(err));   // 失败必须可观测
  }
}
```

**纪律**：
- 失败**不抛给 dsh 主链路**（旁路捕获），但**必须 logger.error**（不静默吞事件）。
- 系统注入的正常跳过用 `debug` 级别，异常跳过用 `warn`。
- `session/event` 的类型通过模块增强声明（`declare module '@deepseek-ai/cordis'`）扩展 `Events` 接口 —— 旧项目同款做法。

### 4.4 并发与顺序

`ctx.on` 的回调是同步触发、异步写盘。多条事件快速到达时，`ingestRawTurn` 各自进 `queue.run` 排队，**写入顺序 = 到达顺序**，不乱序、不交叉（`WriterQueue` 单写者保证）。

### 4.5 通道注册纪律

`channels.json` 首次初始化已自动预置 dsh 描述符（`DEFAULT_DSH_DESCRIPTOR`）。适配器**只核对、不自动注册** —— 若描述符缺失则告警并停写，避免覆盖用户已改的注册表内容（开放面纪律：既有条目永不被改写）。

---

## 5. 依赖声明

```jsonc
// package.json
{
  "dependencies": {},                          // ← 仍为空（A 内核零生产依赖）
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",           // 宿主提供；与旧项目同口径
    "@deepseek-ai/schemastery": "^3.18.5"      // 仅当用 Schema 写 Config 时才需要
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/schemastery": "^3.18.5",
    "@types/node": "^22.20.5",
    "typescript": "^5.9.3"
  }
}
```

**关于 schemastery**：cordis 4.1 的 `Plugin.Base.Config` 走 `StandardSchemaV1`；schemastery 3.19 原生实现 `~standard`，可直接当 Config schema。但本阶段 config 只有两个可选字段，**可以先用轻量的手写校验**避免多一个 peer 依赖 —— 待定项，见 §8 Q3。

**`tsconfig` 影响**：`src/adapters/**` 会进 `tsc -p tsconfig.json` 构建范围，需要 cordis 类型 → devDependencies 已含 cordis，`npm run build` 可过。生产运行时由宿主提供 cordis。

---

## 6. 测试计划

### 6.1 转换函数单测（`tests/adapters/dsh/convert-event.test.ts`）

| 用例 | 断言 |
|---|---|
| user 正常 | `input.event_id` = `data.id`；正文 = text 块空格 join + trim |
| assistant 正常 | `event_id` = `data.message.id`；正文取**最后**一个非空 text 块（不 join） |
| assistant 回退 | 无 `data.message.content` 时用 `data.content` |
| 系统注入排除 | `source.kind='runtime-context'` → `input === null`，**不告警** |
| user 缺 `source` | `source.kind` 缺失 → 跳过（阶段 3 同口径：必须 `=== 'user'`） |
| 运行时上下文正则 | 正文以 `Current runtime context` 开头 → 跳过 + 告警 |
| 非 text 块 | 含 image 块 → 有告警，正文只取 text 部分 |
| 空正文 | text 块为空串 → 跳过 + 告警，不写空 |
| 缺 event_id | user 无 `data.id` → 跳过 + 告警 |
| 缺 time | 无 `time` 字段 → 跳过 + 告警（不伪造时间） |
| 非消息事件 | `type='turn/step'` → 跳过 |
| session_id 缺失 | `session.id` 缺失 → `session_id === ''` |
| 纯函数性 | 两次调用结果深相等；不读文件、不写盘 |

### 6.2 `ingestRawTurn` 单测（`tests/adapters/dsh/ingest-raw-turn.test.ts`）

| 用例 | 断言 |
|---|---|
| 基本写入 | 原文层 1 行 + 经历层 1 条 + 投影可查 |
| 指针可解析 | `resolvePointer(exp.observation.text)` 取回的 `raw_text` 与输入逐字一致 |
| 落点一致 | 指针的 `shard`/`seq` 与原文层实际落点相符 |
| 三轴 | `occurred_at` = 输入时刻；`recorded_at` = 落盘时刻；`tick` 单调递增 |
| **幂等** | 同一 `event_id` 重跑 → 原文仍 1 行、经历仍 1 条、tick 不增长、返回同一 experience |
| **重启后幂等** | 关闭重开 Fasti（同 root）→ 再摄入同 `event_id` → 零新增 |
| 跨通道隔离 | 同 `event_id` 在 `dsh` 与 `qq` 两个通道 → 各自独立成条 |
| 并发安全 | 并发 50 条同 `event_id` → 只落 1 条 |
| 并发不交叉 | 并发 20 条不同 `event_id` → 20 条全落，seq 连续无洞 |
| 冻结面 | 新经历含 `observation.text`、不含 `importance` 类字段、`id` 是合法 ULID |
| 公开行为不变 | `appendExperience` 原有测试全绿（回归） |

### 6.3 cordis 集成测试（`tests/adapters/dsh/plugin.test.ts`）

用 dev 依赖的 cordis 真实构造 `Context`：

| 用例 | 断言 |
|---|---|
| 端到端 | `ctx.plugin({apply})` → `ctx.emit('session/event', session, event)` → 原文 + 经历各 +1 |
| 顺序 | 连续 emit user + assistant → 2 条经历，`initiation` 分别 `user`/`her` |
| 排除注入 | emit `runtime-context` 的 user 事件 → 零新增 |
| 生命周期 | 卸载插件 → `fasti.close()` 被调用（数据根可删，Windows 不报占用） |
| 失败可观测 | 摄入抛错 → 捕获异常、不崩 dsh 主链路 |
| 通道核对 | channels.json 无 dsh → 告警并停写 |

### 6.4 不回归

- `npm run verify`（build + typecheck + test）必须全绿，**125 基线 + 新增用例全部进 `tests/`**。
- 阶段 3 的 98 项 selftest **不进默认 verify**（按用户口径）；本阶段不修改 `scripts/`，其可移植改造已在远端。

---

## 7. 真机验收方案

### 7.1 验收口径（定案稿 §18.5：真机会话无丢事件、无重复）

**准备**：真机 dsh 宿主加载本适配器；记录本轮起始的原文行数 `N0` 与经历行数 `M0`。

**对话**：真机进行若干轮真实对话（建议 ≥ 3 轮 user + assistant，含 ≥ 1 轮纯文本、≥ 1 轮带非 text 块以验证告警路径）。

**对账四问**：

| # | 检查项 | 方法 | 通过标准 |
|---|---|---|---|
| 1 | **无丢事件** | 真机侧统计真实发生的 user/assistant 消息数 `R`；Fasti 侧新增经历数 `ΔM = M1 - M0` | `ΔM === R`，逐条可对上（`event_id` 一一对应） |
| 2 | **无重复** | 新增经历里 `event_id` 是否唯一；原文层 `event_id` 是否唯一 | 两侧均无重复 |
| 3 | **正文逐字一致** | 对每条新经历 `resolvePointer(observation.text)` 取回 `raw_text`，与真机侧原文逐字比对 | 全部逐字相同 |
| 4 | **指针可解析 + 幂等** | `resolvePointer` 全成功；手动重放同一事件（再次触发同一 `event_id`） | 指针全解析；重放后行数**不增长** |

**附加**：`verifyIntegrity()` 全绿（`content_hash` = `sha256(raw_text)`）；`rebuildProjections()` 后计数不变（投影可重建）。

### 7.2 证据形式

- 真机侧事件数统计 + Fasti 侧 `ΔM` 的对照表（按 `event_id` 逐条列出）；
- 逐条正文一致性抽验（建议全量，非抽样）；
- 幂等重放前后的行数对比（`before === after`）；
- `npm run verify` 输出（125 基线 + 新增 N 项全绿）。

### 7.3 我需要你配合的部分

真机跑 dsh 宿主、加载插件、进行真实对话 —— 这一步我在本机无法完成。我负责：适配器代码、自动化测试、以及一段**对账脚本/命令**（读 `~/.dsh/fasti` 现状 + 你提供的真机事件清单，输出对照表）。

---

## 8. 待确认问题

| # | 问题 | 我的建议 |
|---|---|---|
| Q1 | `ingestRawTurn` 是否进 `FastiPrimitives` 契约（`PRIMITIVE_NAMES` 从 14 → 15）？ | **进**。任务书 §4.2 明确"需同步更新契约（`primitives.ts`）与契约测试"。但这会改 `tests/contract/primitives.test.ts` 里"14 项"的断言 —— 需同步改为 15 项。**这属于开放面加法，不碰五条冻结面。** |
| Q2 | `ingested_at` 在实时路径取"落盘时刻"（与阶段 3 迁移的"= asserted_at"不同） | **取落盘时刻**。世界轴记事件时刻、系统轴记落盘时刻，两轴分离是定案稿 §5 的设计。迁移路径保留历史时间是回填语义，实时路径不适用。 |
| Q3 | Config 校验是否引入 `schemastery`？ | **暂不引入**。config 只有 `dataRoot`/`channel` 两个可选字段，手写校验足够；少一个 peer 依赖。schemastery 留在 peer+dev 声明里备用（若你希望用 Schema 写 Config，我就用上）。 |
| Q4 | 适配器是否需要 `ctx.session` 服务（读 session 元数据）？ | **不需要**。`session/event` 的第一个参数已带 session 对象，`session.id` 从中取。旧项目也未注入 session 服务。 |
| Q5 | 是否需要把 `ingestRawTurn` 也加进 `docs/a-block-final-design.md` §9 原语表？ | **建议加**（一行表格 + 契约引用），保持定案稿与实现同步。定案稿是"唯一架构依据"，不更新会让 §9 与代码脱节。 |

---

## 9. 执行顺序（确认后）

1. 拆 `appendExperienceUnlocked` + 新增 `ingestRawTurn` + 契约更新（`primitives.ts` + 契约测试）→ 跑基线。
2. 写 `convert-event.ts` + 单测。
3. 写 `ingest-raw-turn` 单测（幂等 / 重启幂等 / 并发）。
4. 写 cordis 插件 + 集成测试。
5. `npm run verify` 全绿 + 更新文档（README / 定案稿 §9）。
6. 出对账工具，供真机验收。

---

## 10. 明确不做

- 不调任何 LLM；不改 Experience schema；不处理多模态字节（非 text 块只告警）。
- 不做 B/C/D/E 块（复盘、主动、权限、身份）；不迁移 profile/self-model。
- 不改 `src/core`、`src/source`、`src/projection`、`src/contract/{experience,raw-turn,channel,frozen-surface,validate-experience}.ts`。
- 不改 `scripts/`（阶段 3 资产，本阶段只读参照）。
- 不做跨进程锁（归 E 块）。
- 不动真实数据根 `~/.dsh/fasti`（真机验收时由宿主写入，非本阶段测试触碰）。

---

## 11. 执行结果与偏离（2026-11-08）

### 11.1 落地清单

| 计划 | 实际 | 状态 |
|---|---|---|
| `src/api/index.ts` 拆 unlocked + 加 ingestRawTurn | 已落地 | ✅ |
| `src/contract/primitives.ts` 14→15 | 已落地 | ✅ |
| `tests/contract/primitives.test.ts` 断言改 15 | 已落地 | ✅ |
| `src/adapters/dsh/convert-event.ts` | 已落地 | ✅ |
| `src/adapters/dsh/plugin.ts` + `event-types.ts` + `index.ts` | 已落地 | ✅ |
| `tests/adapters/dsh/` 三个测试文件 | 已落地（49 项） | ✅ |
| 定案稿 §9 补一行 | 已落地 | ✅ |
| schemastery 不引入、声明一并移除 | 已落地 | ✅ |

### 11.2 三处与计划的偏离（均为实测驱动的必要修正）

**① `ctx.on` 必须同步注册（计划 §4.2 写的是「在 effect 内注册」）。**

实测 cordis 4.1：`ctx.effect(async () => {...})` 的 effect 体是异步的，
`ctx.on` 若在其中注册，监听器要等 `Fasti.open()` 完成后才挂上 ——
**装载与首个事件之间会丢事件**（实测：3 个插件用例全部零写入）。

改为：`ctx.on` 在 `apply` 中**同步注册**（cordis 自动把它挂到当前 fiber，卸载时移除），
`ctx.effect` 只管 Fasti 实例的生命周期；事件侧 `await ready`（就绪信号），
事件先到也不丢，只是等实例就绪后再写入。

**② `parseAdapterConfig` 只保留显式给出的键。**

计划未细化。实现上返回 `{dataRoot?, channel?}` 的稀疏对象（缺省键不占位），
避免 `deepEqual(config, {})` 因多余 undefined 键而失败。

**③ 阶段 4 新增三个 `scripts/` 工具（计划未列，属交付必需）。**

- `scripts/verify-stage4-frozen-surface.ts` —— 在真实数据根的**副本**上逐条核验五条冻结面 + 幂等 + 完整性；
- `scripts/verify-stage4-realtime.ts` —— 真机对账工具，逐条回答验收四问 + 重放幂等；
- `scripts/simulate-realtime-session.ts` —— 用真实 cordis 加载插件并 emit 事件流，供对账工具先在模拟环境演练。

### 11.3 自动化测试结果

```
npm run verify  →  build ✅  typecheck ✅  test ✅
174 tests / 174 pass / 0 fail
  = 125 基线（未回归）+ 49 阶段 4 新增
```

### 11.4 冻结面核验结果（真实数据根副本，真实根只读）

```
PASS  冻结面① 真源 append-only        原文 247→248 行、经历 247→248 条；既有行逐字节未变
PASS  冻结面② ULID + 双定位指针      指针 dsh/2026-11#247 解析回原文
PASS  冻结面③ 三段槽位                observation.text 已填
PASS  冻结面④ 时间三轴                原文 ingested_at 与经历 recorded_at 严格相等
PASS  冻结面⑤ 投影可重建              rawVsDialogueMatch=true、channelsMatch=true
PASS  幂等复核                        重放零新增、返回同一经历
PASS  完整性                          248 行 content_hash 全对
核验结果：7/7 通过
```

### 11.5 真机对账（模拟演练，已用真实 cordis 跑通全链路）

模拟 3 轮真实对话（6 条消息 + 1 条系统注入 + 1 条非消息事件）：

```
① 无丢事件：PASS（期望 6 条，逐条命中）
② 无重复：PASS（原文 253 行 / 唯一 253 个 event_id）
③ 正文逐字一致：PASS
④ 指针可解析：PASS
⑤ 重放幂等：PASS（原文 253 → 253，经历 253 → 253）
```

**注**：真机上的真实对话验收仍需用户在 dsh 宿主环境配合（跑真实对话、
导出真机事件流），届时用同一套 `verify-stage4-realtime.ts` 工具产出正式证据。

---

## 12. 审计意见处理（2026-11-08）

阶段 4 代码已独立审计（代码主体正确、174/174 全绿、冻结面 7/7、实时对账与重放幂等通过、
依赖边界与两处修正均落实）。审计提出 1 个必改 + 2 个建议 + 1 个登记项，处理如下。

### P1（必改）README 与实际状态脱节 —— 已修

| # | 问题 | 处理 |
|---|---|---|
| 1 | 分层图「§9 的 14 个原语」 | → **15 个原语** |
| 2 | 目录表「tests/ 125 个用例」 | → **174 个用例** |
| 3 | 阶段边界「只含阶段 0–2……DSH 适配器及 B/C/D/E 块的一切行为均未实现」 | 改为**「含阶段 0–4」**，逐阶段列明；B/C/D/E 仍未做的部分保留；并与文档表已列的「阶段 4 计划（已执行）」口径一致，消除自相矛盾 |
| 4 | 标题与开头「只含阶段 0–2」 | → **阶段 0–4**：真源层 + 最小投影 + dsh 通道适配器 |

顺带补全目录表：新增 `src/adapters/dsh/` 与 `scripts/` 两行。

### P2（建议）消除冗余死逻辑 —— 已修

`scripts/verify-stage4-frozen-surface.ts` 的 `axesOk` 表达式：

```ts
// 修复前：&& 优先级高于 ||，整个表达式等价于 A&&B&&C ——
//         前半段（含 recorded_at === occurred_at 的 D 判断）是永不生效的死逻辑。
const axesOk =
  written.occurred_at !== '' && written.recorded_at !== '' &&
  typeof written.tick === 'number' && written.recorded_at === written.occurred_at ||
  (written.occurred_at !== '' && written.recorded_at !== '' && typeof written.tick === 'number');
```

```ts
// 修复后：直接判断三轴齐备且非空。
const axesOk =
  written.occurred_at !== '' && written.recorded_at !== '' && typeof written.tick === 'number';
```

**语义澄清（顺带修正）**：世界轴（`occurred_at`）与系统轴（`recorded_at`）**本就可以不同** ——
实时摄入时事件时刻与落盘时刻是两个时刻，绝不能要求两者相等。
原表达式里那个 `recorded_at === occurred_at` 的判断不仅是死逻辑，语义上也是错的；
修复后三轴齐备性由 `axesOk` 判，而「原文 `ingested_at` 与经历 `recorded_at` 严格相等」
由既有的 `axesEqual` 单独判（那才是落盘时刻唯一性的正确判据）。

核验脚本修复后仍 **7/7 通过**。

### P3（入库前）统一行尾 —— 已做

- 新增 `.gitattributes`：`* text=auto eol=lf` + 各类文本扩展名显式 `text eol=lf` + 二进制资源 `binary`。
- 工作区全部文本文件统一为 LF（11 个含 CRLF 的文件已转换，含基线遗留的 9 个）。
- `git add --renormalize .` 一次性把索引里的历史 CRLF blob 归一。

**关于 diff 噪音的实测**：归一后 9 个基线 CRLF 文件在 diff 中显示为「整文件重写」
（如 `tests/api/fasti.test.ts` 346/346），但 `git diff --ignore-all-space` 显示其
**真实改动量为 0** —— 那是纯行尾噪音，归一一次后**永久消失**。
`.gitattributes` 从此保证后续提交不再产生行尾漂移。

### P4（登记项，本阶段不改）

`src/projection/sqlite.ts` 第 221 行 `const db = this.require();` 未被使用 ——
经比对基线 `18de976` **就存在**、非本阶段引入，且本阶段 `src/projection/` 零改动。
按审计意见**只登记不修**，留待后续清理（避免扩大本阶段改动范围）。

## 13. 真机验收结果（2026-11-09，通过）

本节只记录**结论与口径**；验收日志、事件流、对账明细与备份**全部只在本机**，
不入仓库、不含任何真实对话内容。

### 13.1 环境

- dsh `0.2.1-rc.5`，插件以 `file:` 形式装入两个临时 profile（`fasti-accept` / `fasti-web`），
  与既有 profile、既有数据根 `~/.dsh/persona-innate` 完全隔离。
- 真实数据根指向 `~/.dsh/fasti`（当时 247 条原文 / 247 条经历 / tick 246）。

### 13.2 验收结果

| 组 | 场景 | 结果 |
|---|---|---|
| A | headless profile，真实宿主跑 3 轮对话 | ΔM = R = 3，逐条 event_id 对得上 |
| B | web profile，真实 LLM 完整往返 1 轮 | ΔM = R = 2（user + assistant），逐字一致 |
| C | 重放幂等（同一事件流再喂一次） | 原文 250 → 250、经历 250 → 250 |

四问逐条：① 无丢事件 PASS ② 无重复 PASS（250 行 / 250 唯一 event_id）
③ 正文逐字一致 PASS（指针回读 `raw_text` 与宿主事件逐字比对）
④ 指针可解析 PASS ⑤ 重放幂等 PASS。

### 13.3 两个口径澄清（写进本节，避免后人重踩）

**① headless 组合无法使用 OAuth 账号路由 —— 是设计，不是故障**

dsh 有两条 deepseek 接入：`dsh-llm-deepseek-api-key`（PROVIDER `deepseek-official`，需 API key）与
`dsh-llm-deepseek-account`（PROVIDER `deepseek-account`，用登录态）。`dsh-base` 的
`agent-default-model` 默认指前者；而 `dsh-headless` 的 bundle patch 显式写了
`credentials / authorization: disabled: true`（一次性任务只认启动环境变量）。

因此 headless 下必然 `MISSING_CREDENTIAL` 或 `ACCOUNT_SIGN_IN_REQUIRED`。
**要跑真实 LLM 必须走 web profile**（`dsh-base` + `dsh-web-app` + 本插件）。

**② assistant 的幂等键取 `data.message.id`，不是 `data.id`**

- `user/message` → `data.id`
- `assistant/message` → `data.message.id`（`data.id` 为 null）
- 缺失即 `skip: no-event-id`，**不伪造**

实测该字段是宿主真实 message id，故重放确定性命中；对账工具早期误判「无 id」，
是探针只读了 `data.id`，代码本身正确。

### 13.4 数据纪律

- 验收产生的测试经历已全部清除，数据根回到 247 / tick 246 / 投影 247-247-0；
- 清理前快照留在本机备份目录；
- 仓库 `git status` 干净，远程仍为阶段 4 提交。

### 13.5 未覆盖（登记，不属本阶段）

- 非 text 块（图片/文件附件）路径：真机上未构造该场景，仅由单元测试覆盖；
- 多通道（qq / browser / camera）：阶段 6 验证。
