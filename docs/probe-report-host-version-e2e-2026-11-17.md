# 三探针报告：DSH 宿主断点 / rules 版本开关 / 端到端记忆链路

日期：2026-11-17　身份：只读审计（未改任何代码、配置、真根数据）
基线：HEAD `b41ab21`，`npm test` 1231 通过 / 0 失败（2026-11-16 实测）

---

## 探针 1　宿主断点

### 1.0 当前运行基线（实测）

| 项 | 实测结果 |
|---|---|
| DSH 进程 | 无（`ps aux` 空） |
| 3080 / 3081 端口 | 均空闲（`ss -lntp` 无记录） |
| 现存 profile | `fasti-accept` / `fasti-web` / `headless` / `persona-m0` / `web`，**隔离副本 `fasti-iso` 已不存在** |
| 装配可用性 | `dsh --profile fasti-web --dump-config` 成功组合，`id: fasti`（:1258）与 `id: llm-pi-ai`（:80）均在树中 |

装配树实测内容：
- `id: fasti` → `name: dsh-fasti-dsh-glue`，`config: dataRoot /home/user/.dsh/fasti`、`channel: dsh`、`memoryGateMode: 'on'`
- `id: llm-pi-ai` → `providers.scnet`，`apiKeyEnv: SCNET_API_KEY`、`baseURL: https://api.scnet.cn/api/llm/v1`、`defaultMaxTokens: 262144`

### 1.1 四条逐条判定

| # | 问题 | 当前是否仍存在 | 性质 | 解除条件 |
|---|---|---|---|---|
| ① | `MISSING_CREDENTIAL` | **仍存在（静态必然）** | 预期设计，非缺陷 | 提供 `SCNET_API_KEY` 值 |
| ② | GUI 新会话点击失效 | **无法确认**（原环境已删除） | 无法定性；可确认与 fasti 无关 | — |
| ③ | API 直连 401 / 404 | **仍存在（静态必然）** | 预期设计，非缺陷 | 走浏览器会话 / 加 `--trusted-host` |
| ④ | 换账号后无法新建会话 | **无法确认**（同 ②） | 无法定性 | — |

### 1.2 证据

**① 的闭链证据**：`@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2892` 的 `resolveApiKey`：

```
const ref = profile.apiKeyEnv;
if (ref === void 0) return void 0;
const credentials = ctx.get("credentials");
const hit = credentials !== void 0 ? (await credentials.resolve(ref))?.value
                                  : launchEnvironmentOf(ctx).get(ref)?.value;
if (hit !== void 0 && hit.length > 0) return assertUsableApiKey(...);
throw new LlmError(`... its profile resolves ${ref}, which is not set — store ${ref}
 through the credentials service (the web Models page writes it) or export it ...`,
 "MISSING_CREDENTIAL");
```

只有两个来源，实测两处都为空：
- `~/.dsh/.credentials.yaml` 的键名盘点（未打印任何值）只有 `client-connection/browser-session` 与 `deepseek-account-platform` 两类，**无 scnet 任何记录**
- `~/.bashrc`/`~/.profile`/`~/.bash_profile` 均无 `SCNET_API_KEY` export；当前进程环境无该变量

→ 下次启动必然复现。**源码中不存在任何"bundle 禁凭据"逻辑**，上轮把此条记为"bundle 意图性禁凭据"属误判，本报告更正。

**③ 的证据**：`@deepseek-ai/dsh-api-gateway/lib/index.js:673` `rejectRemoteStreamUpgrade(socket, status)` 注释原文 "authentication or browser-trust rejection status"，401/403 是 WebSocket upgrade 阶段的主动拒绝；同文件注释 "live Remote streams use the Gateway-owned WebSocket mux"，传输不是 REST 路由。web app 侧（`dsh-web-app/lib/startup.js:25`）提供 `--trusted-host` browser-trust fence 参数。

**②④ 的证据**：原始现象仅出现于 3081 隔离副本，该 profile 目录与进程均已删除，当前无可复现环境。另据 `src/adapters/dsh/plugin.ts:47` 注释「本插件**只读监听**，不注入 session 服务」，实测 `ctx.inject` 仅用于 `['tools']`，**可确认新建会话失效不是 fasti 插件造成**。

### 1.3 最小操作步骤（让插件加载并完成一次真实会话）

会真实写入 `~/.dsh/fasti`。顺序不可颠倒。

1. `export SCNET_API_KEY=<key>`（同一 shell；替代路径：web 的 Models 页填一次，写入 credentials service）
2. `dsh --profile fasti-web --port 3080 --no-open`
3. 日志出现 `[dsh-fasti] 适配器已装载：通道=dsh，数据根=/home/user/.dsh/fasti，摘要模型=...`（`plugin.ts:375`）——这是插件真挂上的唯一凭据
4. 浏览器开 `http://localhost:3080`，选工作区 → 新建会话（此处即 ② 的复现点）
5. 发一条真实中文消息（插件靠 `ctx.on('session/event')` 收货，不发言不写任何东西）
6. 等闭合：闭合 worker 5s 一拍（`llm.ts:137`），静默时钟触发闭合产出 event；投影 worker 5s 一拍（`llm.ts:188`）跑 drain 建卡
7. 只读核验三处：`checkpoint.json` 的 `tick` 增大且 `pending_events=0`；`wc -l events/2026-11.jsonl` 增加；`tail -1 projection/memory-index/revisions.jsonl` 出现新 rebuild 行

已知不属配置错误的绊点：credentials 与环境变量并存时 credentials 优先；SCNet-Max 是推理型，`max_tokens` 过小会让 reasoning 吃光配额返回空串（profile 已设 262144）。

---

## 探针 2　rules 版本开关

### 2.1 结论：有意的发布闸门，不是遗漏

| 证据 | 内容 |
|---|---|
| `src/memory/cue-derive.ts:11-12` | 「本文件因此不引入任何 config flag」「**v1 零漂移**：当前 CURRENT_RULES_VERSION = rules-v1 不在启用集合内，派生结果恒为空」 |
| 同文件 `:35` | 「本批 rules_version 是否启用 cue 派生（**生产恒 false 直到发布 rules-v2**）」 |
| `docs/memory-retrieval-words-external-review-brief.md:175` | 「外审达标后**一次性解冻**：发布含 cue 派生的 `rules-v2`（**不翻配置开关**）＋ stampMeta 落章 ＋ 离线 `--apply` 重建回填存量」 |
| `docs/memory-cue-external-review-integration.md:79`（C8） | 「任何 rules-v2 翻转前必须先跑全库 dry-run diff 并记账」 |

闸门形态为"改常量 + 重建库"的版本发布，非运行期开关——`dsh --dump-config` 里 fasti 条目只有 `dataRoot / channel / memoryGateMode`，无 rulesVersion 键。

### 2.2 切换要改的位置

**开关唯一一处**：`src/memory/types.ts:19` `CURRENT_RULES_VERSION = 'rules-v1'`。`cue-derive.ts:26` 的白名单 `new Set(['rules-v2'])` 已含目标值。

**P1–P5 已补齐的五处（当前代码实存，非待办）**：

| 环节 | 位置 | 状态 |
|---|---|---|
| 派生入口 | `builder.ts:449` 按 `isCueDerivationEnabled(CURRENT_RULES_VERSION)` 分支 | 已有 |
| 期望态 | `derive.ts:169-170` `input.rulesVersion ?? CURRENT_RULES_VERSION`（支持外部传值） | 已有 |
| 比对面 | `planner.ts:109` `(prev.cuesHash ?? '') === (cur.cuesHash ?? '')` | 已有 |
| 物化 | `drain.ts:431` `cueEnabled` 分支 + `cuesHashOf` | 已有 |
| 落章 | `store.ts:288` `stampMeta` 四键含 `rules_version` | 已有 |

**连带生效**：`drain.ts:508/535/559`、`store.ts:556` 的决策行 `modelTag` 全取 `CURRENT_RULES_VERSION`，改常量后决策行 `model_tag` 变 `rules-v2`。

**不需要改**：`schema.ts` 表结构。`CHECK (json_array_length(display_cues_json) BETWEEN 1 AND 3)` 与 `CUE_MAX_COUNT=3` 相容，`discriminator <= 40` 与 `CUE_MAX_CODEPOINTS=40` 相容，`MEMORY_SCHEMA_VERSION` 无需升版。

**已过时的文档**：brief:175 那段「按现状仅升版本**不会**回填——planner 不比 cue、builder 原样搬运、stampMeta 只写三键」描述的是 P1–P5 落地前状态；按现代码该判断已不成立，但文档未回写。

### 2.3 切前要补的验收（四项缺口）

1. **端到端 v2 链路测试不存在**：`grep rules-v2 tests/` 仅命中 `tests/memory/cue-backfill.test.ts`，验的是派生函数，**没有**"v2 建库 → FTS 索引 → 检索 → candidateCount"这一段
2. **C8 未落地**：真机 shadow 观测行实测只有 7 字段（`termHash / gatedStatus / candidateCount / countScope / acceptedCount / rejectedReasonCodes / observedMs`），**无 `GATE_POLICY.version`**，翻转前后观测不可区分
3. **翻转记账口径未定**：首建与重算在 `decisions.jsonl` 里都只有 `create-card` / `update-card`，无法区分（真机现有 2 条全是 `create-card`、`reason: create-card:drain-projection`）
4. **回滚验收未写死**：brief:285 提过「回滚后退 rules_version 并重建，红测断言 `row_hash_sum` 与解冻前逐字节相等」，红测不存在

### 2.4 切后 candidateCount 能否从 0 变非 0

**能，但自然问法不会变。** 判定树（`src/memory/bm25.ts` 实码）：

| 查询形态 | 走的路径 | candidateCount |
|---|---|---|
| < 3 码点（如"成都"） | 跳过 FTS（`MIN_TRIGRAM_LENGTH=3`），LIKE 回退**只查 `mem_alias`**（:134-144） | 真机 0 别名 → 必为 0 |
| ≥ 3 码点自然长句 | 整句包 phrase 做 `MATCH`（:114-133），要求整句连续出现在某条 cue 内 | 自然问法 → 仍为 0 |
| 恰好是某条 cue 的连续子串（≥3 字） | phrase 命中 | 非 0 |
| 命中 `mem_alias.term_norm` | exact-alias 等值查 | 有别名才非 0 |

真机现为 2 卡 / 0 别名，切 v2 后这 2 卡拿到从 `key_points` 派生的 cue（≤3 条 × ≤40 码点），故只有"查询字符串碰巧是那两段 cue 的连续子串"时才非 0。与离线七臂 bench 一致（整句 0/16、oracle 短词 9/25）。

**无法确认项**：真机那条 `termHash=c026547a...` 的原查询（sha256 不可逆），故"同一条观测切换后是否变非 0"无法回答，只能看切换后新产出的观测行。

### 2.5 不改代码前提下的验证步骤

硬约束：`CURRENT_RULES_VERSION` 是编译期常量，无 CLI 参数（`build-memory-index.ts` 只有 `--data-root / --apply / --yes / --json / --since-revision`），无配置项。**完全不改文件时无法在真机看到 v2 行为**，区别只在"改在哪棵树"。

1. （零改动）`node --no-warnings --test tests/memory/cue-backfill.test.ts` —— 显式传 `rules-v2`，绕开常量验证派生
2. （零改动）`node scripts/build-memory-index.ts --data-root <临时根>` —— 默认 dry-run 落系统临时目录，锁住"v1 恒空"基线
3. （改在临时副本）`git worktree add /tmp/fasti-v2-probe b41ab21`，副本内改 `types.ts:19`，再 `--apply` 建到临时根，确认：revisions 新增一条、decisions 出现 `update-card`（因 cuesHash 变化）、`schema_meta.rules_version=rules-v2`
4. （同上副本）用该临时根跑三种查询（2 字词 / cue 片段 / 自然长句），对照 2.4 判定树
5. （跑全量测试，预期一条红）静态判定：唯一变红的是 `tests/memory/alias-write.test.ts:409` `assert.equal(d.model_tag, 'rules-v1')`——它断的是生产路径决策行 `model_tag`，来源即 `CURRENT_RULES_VERSION`。`builder.test.ts:197/718/730` 的 `'rules-v1'` 是测试自造输入不受影响；`cue-backfill.test.ts:132` 用变量不受影响
6. （真机切换，本轮不做）须同时满足 C8（全库 dry-run diff 记账）与 #55 备份演练（仍 pending）

体量事实：真机 2 张卡，即使切换也只能验证"链路走通"，不足以支撑任何召回率统计结论。

---

## 探针 3　端到端链路

假设探针 1（凭据）与探针 2（版本）问题解除，从一次真实对话到建卡、再到后续对话召回，逐环节标注。

| # | 环节 | 状态 | 判定证据 |
|---|---|---|---|
| 1 | 宿主加载插件（bundle 进 profile） | **已具备** | `dsh --dump-config` 实测组合出 `id: fasti`；`package.json` 的 `dsh.profile.bundles` 含 `dsh-fasti-dsh-glue` |
| 2 | 模型凭据可用 | **需配置** | `resolveApiKey` 两来源均空（见探针 1） |
| 3 | 插件装载与数据根打开 | **已具备** | `plugin.ts:375` info 日志；`plugin.ts:354` 打开失败有 error 分支 |
| 4 | 监听真实对话事件 | **已具备** | `plugin.ts:274` `ctx.on('session/event')` 只读监听；真机 `raw-turns/2026-11.jsonl` 有落地 |
| 5 | 摘要闭合（LLM 慢路径） | **已具备 + 需配置** | 闭合 worker 在（`llm.ts:132`）；摘要模型由 `agent-default-model` 提供（已配 `scnet/SCNet-Max`）。真机 `events` 11 行说明跑过 |
| 6 | 事件切分与落 `events/` | **已具备** | `tests/event/` 12 文件全绿；真机 events 11 行 |
| 7 | 经历转写落 `experiences/` | **已具备** | 真机 experiences 7 行 |
| 8 | 投影落 `fasti.sqlite` | **已具备** | 真机 86016 字节；`checkpoint.last_projected_tick = tick = 6` |
| 9 | drain 建卡（`mem_card`） | **已具备** | 真机 `revisions` rev3 `cards=2, aliases=0`、`reason: drain-projection`；`decisions` 2 条 `create-card` |
| 10 | **cue 派生（决定检索面有无内容）** | **需开发（切版本）** | `types.ts:19` `rules-v1` 不在白名单 `{'rules-v2'}`；真机 decisions `model_tag=rules-v1` → 生产 cue 恒空串 |
| 11 | FTS 索引写 `mem_card_fts` | **已具备（但文本为空）** | 表与 `syncFts` 在；索引文本 = cue + 别名（`fts.ts cueTextOf`），真机两者皆空 |
| 12 | 六工具注册进宿主工具表 | **已具备** | `memory-tool-bridge.ts` 6 个 `defineTool`；`ctx.inject(['tools'])` 注册（注释 :223-225 说明 cordis 4.0.5 授权约束） |
| 13 | 模型主动调用 `fasti_memory_search` | **需配置** | 工具 description 存在（英文，引导 search→resolve 两段）；但仓内无系统提示/工具使用指引，且 shadow 态工具恒返回 `observing` 空信封。真机 `memoryGateMode: 'on'` 已解此层 |
| 14 | 门裁决与候选生成 | **已具备** | `gate.ts judge` 方向为 `qNorm` 须在 `cueText` 内 `indexOf` 且过 ASCII 词边界；`applyGate` 返回 status/candidateCount/accepted/rejected |
| 15 | 序号反查为 cardId | **已具备** | `fasti_memory_resolve_pointer` 描述「serials are per-request and expire after any new search」 |
| 16 | **命中后回叙述（读回该卡内容）** | **需开发** | `GatedCardView`（`memory-tools.ts:62-68`）只有 `cardId / serial / anchorIds / displayCues / gateReasons`，**无摘要、无正文**；`GatedSearchView` 只有 `status / cards / reason / serialMap`。而 `fasti_memory_experience_summary` 与 `raw_text` 的 description 均自我定位为「**通道二回查**（第②跳 / 第③跳）」，即漏召回查用途，不是"命中后读回"。三跳之间无工具层面的串联指引 |
| 17 | 别名补写（miss → alias） | **已具备** | `fasti_memory_add_alias` 描述「Only effective when the gate mode is on」；`alias-write` 有 `MAX_MISS_ALIASES_PER_CARD` 上限 |
| 18 | 漏召观测 `mem_miss` | **已具备** | `miss.ts` + 6 个测试全绿；真机表存在（行数未验证，未开库） |
| 19 | 影子观测落 `memory-shadow/` | **已具备** | 真机 2200 字节有真实行；7 字段与设计一致 |
| 20 | 叙述回读的敏感标记机制 | **无法确认** | `projectCardForHost` 白名单 `cardId/anchorIds/displayCues/channel/cardType/discriminator` 不含 sensitive 语义位；`source-lookup` 的 `MAX_RAW_LOOKUP_CHARS=50000` 与 summary 白名单键集在，但"回叙述时如何标注敏感"在代码与文档中均未见实现 |

### 3.1 计数

20 个环节按三档归并，合计 20：

| 档 | 环节编号 | 数量 |
|---|---|---|
| **已具备** | 1、3、4、5、6、7、8、9、11、12、14、15、17、18、19 | 15 |
| **需配置** | 2（模型凭据）、13（模型侧调用意愿与门态） | 2 |
| **需开发** | 10（cue 派生未启用，需版本发布）、16（命中后回叙述无入口、三跳无串联指引）、20（回读敏感标记机制缺实现） | 3 |

其中两类需单独标注：
- 环节 5 计为已具备（摘要模型已在 profile 配好），但**本轮未复测真机模型可用性**，其实际可用性无法确认
- 环节 11 计为已具备但**空转**：表与 `syncFts` 都在，索引文本因环节 10 而恒为空

### 3.2 端到端最短闭环现状

按现有代码，**"发一句话 → 建卡成功"这条链路是通的**（真机 2 条 create-card 为证）。**"下一次对话能召回并读到内容"这条链路断在两处**：cue 为空（环节 10）使检索面无内容；即使命中，返回面只有 cue 与 cardId（环节 16），模型拿不到该卡讲了什么，且没有工具描述引导它去调 `experience_summary`。

---

## 三探针交叉结论（事实陈述）

1. 探针 1 的 ① 是**配置缺失**而非设计缺陷，源码无禁凭据逻辑，上轮结论需更正；②④ 因隔离环境已删而**无法确认**；③ 是 gateway 的 browser-trust 拒绝，属设计。
2. 探针 2 的 rules-v1 是**有意的发布闸门**（三处独立文档/注释证据），P1–P5 已把回填链路补齐到可用的程度，切前缺的是**端到端测试、C8 观测字段、翻转记账、回滚红测**四项验收。
3. 探针 3 的 20 个环节里 14 项已具备，缺口集中在**"检索面内容"（cue）与"返回面内容"（叙述）**两端——这也正是崩溃点在 candidateCount=0、且命中后模型无内容可读的原因。
4. 所有"需开发"项的判定均基于代码实存（字段白名单、工具 description 文本、常量白名单），未使用推断。
