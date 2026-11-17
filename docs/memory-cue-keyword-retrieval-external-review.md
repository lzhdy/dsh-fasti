# 记忆检索「cue 词面」外部评审材料

> 送审日期：2026-11-16
> 送审对象：外部独立评审（可交叉比对，不预设结论）
> 材料性质：实证为主、问题清单为辅，**不给结论式建议**，请评审方自行判断
> 代码基线：`dsh-fasti` 仓库 `main` 分支 `b41ab21`（10 文件 +576/−16）

---

## 0. 一页速览

系统用**确定性布尔门**做长期记忆检索：写入侧把事件摘要的 `key_points` 投影成 3 条以内的 `display_cues`，检索侧要求**用户查询句整句出现在 cue 文本里**才放行。

2026-11-16 用真模型（SCNet-Max）跑通全链路，8 段真实感对话产出的 19 条 cue，对 16 条"真人会怎么问"的查询：**整句等值命中 0，宽松包含命中 0**。同期真机已有 2 个真实事件，其 cue 同样对自然问法 0 命中。

用户在评审诉求上提出一个新设想：**cue 只存纯关键词（如"重庆出差"），命中后回给模型的不是关键词，而是完整叙述（"某人去重庆出差，发现酒店发票抬头写错"）**。

本材料把这条设想落到代码上拆成三个改动点，逐点给出现状、硬约束与风险，交由外部判断有没有更优路径。

---

## 1. 系统背景：五环写入线

```
记录本(raw turns) → 摘要环(LLM) → 事件(closed+ready) → 提关键词(cue 派生) → 记忆卡(mem_card)
```

| 环 | 代码锚点 | 要点 |
|---|---|---|
| ① 记录本 | `Fasti.ingestRawTurn`（`src/api/index.ts`） | append-only，不 await 后台 |
| ② 摘要环 | `src/event/closure.ts`（`ClosurePipeline`）+ `src/event/llm-port.ts` | 端口为 `null` 时事件**保持 pending，不伪造**；实现 `src/adapters/dsh/llm.ts::createDshLLMPort(route)` |
| ③ 事件 | `src/contract/event.ts::EventRecord` | 字段含 `summary` / `key_points` / `anchors` / `summary_quality`；多版本同 id，`foldCurrentEvents` 取最大 version |
| ④ 提关键词 | `src/memory/cue-derive.ts` | `deriveCuesFromKeyPoints({keyPoints,summary})`：NFKC 清洗 → 去重保序 → 超 `CUE_MAX_CODEPOINTS=40` 整条丢 → H7 过滤 → `slice(0, CUE_MAX_COUNT=3)` |
| ⑤ 记忆卡 | `src/memory/builder.ts` | `normalizeDisplayCues`（P5 单点收口）、`materializeDrainCardRow`、`computeContentHash` |

派生开关：`CUE_DERIVATION_RULES = new Set(['rules-v2'])`，生产常量 `CURRENT_RULES_VERSION='rules-v1'` → **派生当前处于关闭状态，运行期零漂移**。

---

## 2. 检索侧现状（这是问题的核心）

### 2.1 索引只由 cue+别名拼成

`src/memory/fts.ts::cueTextOf`：

```ts
const terms = aliases.filter(a => a.status === 'active' && a.sensitive === 0).map(a => a.termNorm);
return [...cues, ...terms].join(' ');
```

**摘要正文、原始对话文本永不进索引**（零正文纪律，`§3.2`）。

### 2.2 分词器是 trigram，2 字词不建索引

`src/memory/schema.ts`：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS mem_card_fts USING fts5(card_id UNINDEXED, cue_text, tokenize='trigram');
```

后果：**2 个汉字的查询（如"成都""发票"）切不出三元组**，FTS 层直接无候选。

### 2.3 门的方向是「查询整句必须是 cue 的子串」

`src/memory/gate.ts::judge`：

- `exact-alias`（查询 == 别名）→ 直接放行
- `fts-substring` → 取 `candidate.cueText` 归一后，判断 `qNorm` 能否作为**子串**在 haystack 中出现，且满足 ASCII 词边界
- `like-fallback`（仅当 bm25=0 的 `%q%` 宽松子串）→ **构造性拒绝**，`like-only-weak-match`

即：**允许"查询比 cue 短"（短查询落在长 cue 内），不允许"查询比 cue 长"（长问句里含短 cue）**。

这与用户新设想的方向**正相反**。这条规则来自早前裁定的"宁空勿错"立场（`GATE_POLICY.version=1`），`GATE_POLICY` 注释明确写"不是逐请求入参、不进冻结的 SearchQuery"。

### 2.4 命中后模型拿到什么

`src/assembly/host-tool-runtime.ts::projectCardForHost`：

```ts
return { cardId, anchorIds, displayCues, channel, cardType, discriminator };
```

**白名单里没有叙述文本**。卡上有 `eventId`，事件行上有 `summary`，关联链路存在但未暴露。

现有 6 个模型可见记忆工具（`src/adapters/dsh/memory-tool-bridge.ts::MEMORY_TOOL_NAMES`）：

| 工具 | 作用 | 是否回叙述 |
|---|---|---|
| `fasti_memory_search` | 门控检索，返回带私有序号的候选 | 否（只有 displayCues） |
| `fasti_memory_resolve_pointer` | 序号 → cardId | 否 |
| `fasti_memory_cards_by_anchor` | 按经历 id 取卡详情 | 否（同上白名单） |
| `fasti_memory_experience_summary` | 按经历 id 取摘要 DTO | 否（白名单 `id/kind/scene/initiation/occurredAt/recordedAt/tick/cue`，**不含事件 summary**） |
| `fasti_memory_raw_text` | 按经历 id 取原文行 | 是（但取的是零散对话原文行，非事件级叙述） |
| `fasti_memory_add_alias` | 手动加别名 | — |

---

## 3. 实测证据

### 3.1 真机已有真实事件（生产库，历史遗留）

真根 `/home/user/.dsh/fasti/events/2026-11.jsonl` 只有 2 个 `closed+ready` 事件：

| # | 事件 id | 真 key_points | v2 派生 cue |
|---|---|---|---|
| 1 | `01M7GX8J89Q2D219RX1AY792YK` | 4 条（+96 码点摘要） | `用户询问上次对话内容` / `助手称无法读取此前会话记录,只能看到当前对话`（22 码点）/ `助手请用户提醒上次主题`；第 4 条 KP（19 码点）被 `CUE_MAX_COUNT=3` 截掉 |
| 2 | `01M7H396QK76HVMJGRQEEPF552` | 3 条（+71 码点摘要） | `3 加 5 等于 8` / `荷花每天面积翻倍,第 30 天长满池塘`（19 码点）/ `第 29 天荷花长到池塘一半`（14 码点） |

自然问法（如"你还记得上次聊了什么吗""荷花那个题答案是多少"）对这 7 条 cue：**0 命中**。

### 3.2 真模型全链路压测（2026-11-16，SCNet-Max）

方法：脚本 `tests/memory/iso-write-line.ts`，临时根，全部真实代码——`Fasti.open({dataRoot, llmPort: createDshLLMPort(scnetRoute)})` → 8 段多轮对话 `ingestRawTurn` → `checkSilenceClock` 真闭合 → `drainClosure` 真调模型 → 从事件真源读回 `summary/key_points` → `deriveCuesFromKeyPoints` → `materializeDrainCardRow`。8 事件全部 ready，`summary_model=SCNet-Max`，0 失败。

| 桥段 | 真 key_points（节选） | 最终 cues | 真人问法 | 整句等值 | 宽松包含 |
|---|---|---|---|---|---|
| b1 发票 | 上周去重庆出差 / 酒店发票抬头开成公司老名字 / 询问发票能否重开 / 要求简单说明（截） | `上周去重庆出差`、`酒店发票抬头开成公司老名字`、`询问发票能否重开` | 我那个重庆酒店的发票抬头写错了怎么办；上次说的发票重开 | 否 | 否 |
| b2 面积 | 12 人 / 每人 1.5 平方米 / 询问会议室所需面积 | `12 人`、`每人 1.5 平方米`、`询问会议室所需面积` | 12 个人开会要多大房间；那个会议室算出来多少平 | 否 | 否 |
| b3 sqlite | 线上记忆服务使用 SQLite 时频繁出现 database is locked（40 码点）/ 用户询问该问题是否由并发写入过多导致 | 同两条 | sqlite 锁库那个问题怎么解决的；记忆服务老是 locked | 否 | 否 |
| b4 排期 | 计划约王工在下周三下午过 Q4 技术方案 / 询问如何排期 | 同两条 | 跟王工约的 Q4 方案评审排到什么时候了；下周那个技术方案会 | 否 | 否 |
| b5 偏好 | 用户不喜冰饮 / 点奶茶时要求常温 | `用户不喜冰饮`、`点奶茶时要求常温` | 我奶茶要常温还是冰的；点奶茶有什么讲究 | 否 | 否 |
| b6 谜题 | 荷花数量每天翻倍 / 第 30 天长满整个池子 / 询问长到一半是在第几天 | 同三条 | 荷花那个题答案是多少；第几天长满一半 | 否 | 否 |
| b7 代码 | 提问内容：async 函数未使用 await 的潜在问题（28 码点，仅 1 条） | 同一条 | 那个没 await 的地方后来怎么改了；async 没 await 那段 | 否 | 否 |
| b8 行程 | 目的地：成都 / 行程时长：三天 / 时间：国庆期间 / 需求：大致行程安排（截） | `目的地:成都`、`行程时长:三天`、`时间:国庆期间` | 国庆成都那趟怎么安排的；带老人去成都的行程 | 否 | 否 |

汇总：cue 19 条，平均 2.38 条/卡；≥20 码点 3 条、12–19 码点 3 条；被 3 条上限截掉 2 条；H7 丢弃 0 条；**真人问法 16 条，整句等值 0、宽松包含 0**。

### 3.3 两个观察（值得评审注意）

1. **真模型本身倾向写短词**，不像仿真时那样爱写长叙述句：出现了 `目的地:成都`、`12 人`、`用户不喜冰饮` 这种半关键词形态，19 条里只有 3 条 ≥20 码点。所以"句子太长"不是唯一病根。
2. **即便 cue 已是短词，也依然 0 命中**：b8 的 cue 就是 `目的地:成都`，人问"带老人去成都的行程"仍不命中。原因在 §2.3 的门方向 + §2.2 的 trigram 2 字限制。

---

## 4. 问题点清单（逐条带代码锚点）

| # | 问题 | 代码事实 | 后果 | 是否已确认 |
|---|---|---|---|---|
| P-1 | 门方向要求"查询整句 ⊂ cue" | `gate.ts::judge` 的 `hasAsciiWordBoundary(qNorm, haystack)`+`indexOf` | 人问长句、cue 短 → 必拒 | 是 |
| P-2 | FTS trigram 不索引 2 字词 | `schema.ts` `tokenize='trigram'` | "成都""发票"级关键词进不了 FTS 候选 | 是 |
| P-3 | cue 最多 3 条 | `CUE_MAX_CODEPOINTS/CUE_MAX_COUNT`，`cue-derive.ts` + `builder.ts::normalizeDisplayCues` | 多主题事件丢关键点（实测被截 2 条） | 是 |
| P-4 | H7 阈值 20 码点 | `H7_MIN_CODEPOINTS=20`，规则是"KP 需在 summary 中双形态出现且 ≥20 码点" | 19 码点长 KP 不参与反查（真实事件 1 的第 4 条 19 码点即被丢） | 是 |
| P-5 | 命中后无叙述 | `projectCardForHost` 白名单只 6 个字段 | 模型拿到 `目的地:成都` 这种碎片，无上下文可解释 | 是 |
| P-6 | 别名通道只有手动 | 仅 `fasti_memory_add_alias` 一条手写通路；B 路线 P7–P12 六项安全机制（alias-no-demand / no-recorded-miss / alias-term-conflict / 退役）grep **零命中** | 无法自动补漏召 | 是 |
| P-7 | `created_by` 硬编码 | `src/memory/decision.ts`（`created_by` 仍固定 `'her'`） | 多来源细分不了 | 是 |
| P-8 | 只有整句等值一条有效路 | LIKE 是死通道（构造性拒绝） | 弱召回 | 是 |

---

## 5. 用户的设想与落到代码后的三个改动点

**设想**：cue 只存**纯关键词**（"重庆出差"）；人问句里含这个词即命中；命中后回给模型的是**完整叙述**（"某人去重庆出差，发现酒店发票抬头写错"），而不是关键词。

| 改动点 | 位置 | 现状 | 硬约束 / 风险 |
|---|---|---|---|
| ① 写入侧关键词化 | `cue-derive.ts` | 现在是把 `key_points` 原样（NFKC 后）取前 3 | 好改、孤立；但要定"关键词"的确定性抽取规则（剥"用户/助手/询问"模板词、去虚词）；若改成 LLM 抽词则违反"确定性投影"原则（派生必须纯函数、可复现） |
| ② 读出侧门方向反转 | `gate.ts::judge` | 只允许"查询 ⊂ cue" | **最大风险点**：允许"cue ⊂ 查询"等于放宽召回，直接冲击"宁空勿错"立场；且 `GATE_POLICY` 是具名冻结常量（`GATE_POLICY.version = 1`），改动需重评误召；2 字关键词还受 trigram 限制，可能要另起精确匹配通道 |
| ③ 返回面加叙述 | `host-tool-runtime.ts` / `source-lookup.ts` | `HostCardView` 无叙述；`experience_summary` DTO 白名单不含事件 `summary` | 需新增事件摘要 DTO（`eventId → summary`）+ 扩白名单；属契约面改动，且要过"零正文"纪律（summary 是模型生成的客观摘要，不是原文，是否算正文需评审确认） |

补充：卡上有 `eventId`，事件行有 `summary`，**技术上关联链路已存在，只差暴露口**。

---

## 6. 现有约束（评审方案不得违反）

1. **零正文**：索引只能由 cue + 非敏感别名拼成，摘要正文与原文永不进 FTS。
2. **派生确定性**：cue 派生是纯函数，不调模型、不读时钟、零随机，可用同一输入复现。
3. **宁空勿错**：宁可返回空，不返回可能错的卡；不引入需标定的连续分阈值。
4. **不伪造**：模型端口为 null 时事件保持 pending，绝不用假摘要顶替。
5. **无守护进程/定时器/fs.watch/新生产依赖**；不新增真源字段（新增字段需走契约变更）。
6. **测试纪律**：`npm test` 全绿、双 tsc、静态门（75 条契约断言）不得后退；现有 1231 个测试。
7. **契约定式**：`EventRecord` 等 schema 有写模式校验，加字段须过 `parseEvent` 与静态门。

---

## 7. 请外部评审回答的问题

**Q1** 门方向。允许"短 cue 出现在长查询里"命中，与"宁空勿错"是否必然冲突？有没有既不放弃精度、又能救回自然问法的确定性做法（例如：双向包含 + 词边界 + 长度比例约束 + 同卡多 cue 交叉确认）？

**Q2** 2 字关键词。trigram 分词下 2 字词无索引。是改用别的分词器（如 `unicode61` + 自定义词典）、另建精确匹配表、还是要求关键词最短 3 字？三者代价与漏召风险分别如何？

**Q3** 关键词抽取的确定性。不用模型的前提下，如何从中文 `key_points`（动宾叙述句）稳定抽出名词性关键词？有没有成熟的确定性方法（依存/规则/词表剪枝），能在中文上给出可复现结果？

**Q4** "关键词命中、回整段叙述"这个模式本身。检索学上这是**两段式（term → document）**，常见于 IR 的 posting list + doc store。在这个纯本地 SQLite、零依赖、强确定性约束下，是否就是最优解？有没有更简的替代（例如只存关键词 + 卡上直接冗余一份短句，跳过事件回查）？

**Q5** 精度评估口径。现有评测要求"每层 ≥50、总 ≥200 探针、诱饵 ≥100、holdout ≥40、Wilson 半宽 ≤0.05"。在只有几十条真实事件的早期系统里，这套门槛是否过重？有没有合适的**小样本**评估方法（如序贯检验、主动标注）能在 20–50 条规模上给出可用置信度？

**Q6** 别名通道的价值。当前别名只能人工写（`add_alias`），B 路线自动建议器未做（P7–P12 六项安全机制零实现）。在"关键词 cue"方案里，别名通道还有必要吗，还是可以完全放弃、只靠 cue 词面 + 门？

**Q7** 有没有第四条路。除"A 关键词派生 / B 别名自动补 / 现状整句等值"之外，是否存在更优机制（例如把检索做成"关键词倒排 + 事件摘要回读"两跳、或对 cue 做嵌入但保持确定性可复现的哈希近似、或引入用户侧一次性确认的轻交互）？

---

## 8. 复现方式（供评审核对）

```bash
# 全链路真模型压测（临时根，不碰真根）
SCNET_API_KEY=<key> node tests/memory/iso-write-line.ts

# 只读查看真机既有 2 个事件的 v2 派生结果
node tests/memory/real-cue-preview.ts
```

产出物：`tests/memory/iso-write-line.ts`（脚本）、`tests/memory/iso-write-line.real-run.log.txt`（本次完整输出）。均未入库（用户要求测试类产物不提交）。

---

## 9. 当前状态一句话

生产常量仍是 `rules-v1`（派生关闭、零漂移），1231 测试全绿、双 tsc/build 通过；本材料描述的实测均在临时根完成，**真根数据零写入**。等待外部评审意见后再决定是否动生产码。
