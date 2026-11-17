# 记忆检索词双路线 · 外部评审整合裁定稿

- 评审对象：`docs/memory-retrieval-words-external-review-brief.md`（双路线合并送审稿，2026-11-16）
- 代码基线：`d34a3bf`（远端 `https://github.com/lzhdy/dsh-fasti` main，本地与远端零差异）
- 收件：四份独立评审意见（下文 R1–R4），全部逐字读完
- 裁定日期：2026-11-16
- 裁定口径：先回代码实证，再裁定；驳回必须给代码或原文依据；证据编号续接本稿新开 E-01…E-14
- 一句话结论：**方向通过、四家一致同意分别取号（A=#123、B=#120）；但 A 的现文不得进阶段 3——两家施工级前置（存量 cue 回填机制、rules_version 落章点）经实证确认为真；送审稿 7 处事实陈述失实，全部成立，已认账并回改。**

---

## 0. 结论摘要

1. **不越线（Q1）四家一致同意**：A 是"已固化真源字段的确定性投影"，不是"模型静默生成检索词"。但"同意不越线"≠"同意解冻"，解冻仍卡五维评测。
2. **两处 Blocker 实锤**（R1 称"阻塞缺口"、R3 称"实质缺口"、R4 称 Blocker，方向一致）：
   - **B-1**：`planner` 比对面不含 cue、`builder` 对存量卡原样搬运旧 cue ⇒ **A 上线后存量两卡仍为空，不会被回填**；
   - **B-2**：`stampMeta` 只写三键、全仓无 `rules_version` 写入点 ⇒ **改 `CURRENT_RULES_VERSION` 后 `rebuild-required` 永不触发**（现有红测是靠测试手工造戳过的，详见 E-09）。
3. **送审稿 7 处失实全部成立**，其中两处改变结论走向：B 的真实能力只剩"整句等值复现"（不是词级召回）；A 的"按结构变化重建"描述与代码相反。
4. **四处分歧已裁**：
   - Q4 超长 cue：**整条丢弃**（3:1，R1/R3 主张，采纳）；
   - Q8 二次落空：**不设硬门槛**，改"需求绑定 + 跨卡冲突 + 退役出口 + 反事实注入"（3:1，R2/R3/R4 主张，采纳）；
   - Q6 样本量：取 R4 的"每层 ≥50 / 总 ≥200 / 半宽 ≤0.05"，R2 的 ≥300 作为重采样后的扩样上限；
   - Q3 取舍规则：v1 保序前 3，R1 的包含式去重降为阶段 2 回放器对比项。
5. **两处"看似冲突"实不冲突**：R3 要求"A 生产不设独立 config flag"，R4 要求"B 加专属写入开关"——前者管 A（规则派生，必须同真源同规则同投影），后者管 B（判断类写入，观察期必须能关）。两条并存。
6. **动工建议**：A 可动工，但 charter 必须含 P1–P6（P1–P3 就是 B-1，P4 就是 B-2）；B 立项前必须按 E-01/E-03 重写命中面语义，并补 P7–P12。

---

## 1. 收件与核验口径

| 编号 | 来源 | 核验通道 | 覆盖 | 已知局限 |
|---|---|---|---|---|
| R1 | 《记忆检索词写入双路线外部评审意见（Q1–Q10 逐条裁定）》 | GitHub API 读基线全量树 + 15 个源文件 | 代码级 | 未做运行时验证 |
| R2 | 《记忆检索词双路线-外审评审意见书-2026-11-16》 | 网络拦截，**无法 clone**，以附录 C 为据 | 有声明局限 | 未直接读代码，靠附录 C 摘录 |
| R3 | 《memory-retrieval-words-external-review-response.md》 | 匿名 clone 成功，`git log -1` = `d34a3bf` | §2.2 全 17 处坐标逐一回码 | 无 |
| R4 | 《Fasti-检索词双路线-外部评审意见书.html》（署名 AutoClaw） | `raw.githubusercontent.com` 逐文件全文 | src/memory 14 文件 + memory-tools | 未读 contract/event.ts、closure.ts、llm.ts、projection/*、tests/、接线层 |

行号会漂移，本稿一律**以符号名锚定**，行号仅作定位参考（与送审稿 §2.2 同一约定）。

---

## 2. 回代码实证（E-01…E-14）

### E-01 · miss 别名恒 `sensitive = 1`（改 B 能力边界）

`src/memory/runtime.ts:106-113`：窄柄 `addMissAlias` 构造入参时写死 `sensitive: 1`；同文件 `:11`、`:34`、`:47` 注释三处明言"包装层固定 1（N4/N14），入参类型不含 sensitive，危险选项不可表达"。

**后果**：`fts.ts:35-41` 的 `cueTextOf` 只收 `[...cues, ...活跃且 sensitive===0 的别名]` ⇒ miss 别名**永不进 cue_text、永不进 FTS**。这是有意的隐私设计，不是 bug。

### E-02 · LIKE 是死通道（双保险堵死）

- `bm25.ts:138` 的 LIKE 回退 SQL 带 `sensitive = 0` 过滤 ⇒ miss 别名永不走 LIKE；
- 更关键：`gate.ts:118-119` 对"仅 like-fallback 命中"直接 `return { accept: false, reasons: ['like-only-weak-match'] }`，注释原文"构造性拒绝，与任何数值阈值无关"。

**后果**：LIKE 连普通 cue 都召不回（会被门拒），我送审稿 §2.3 把 LIKE 列为"三通道之一"、§5.5 写"B 可命中（精确/LIKE）"，**两处都错**。

### E-03 · B 的唯一可达路径 = `term_norm` 整句等值

`bm25.ts:105-111`：先按 `term_norm = normalizeQuery(query.text)` 查 active 别名等值命中，其中 `q` 是**整条查询**规范化后的全文（`bm25.ts:77`）。

**后果**：别名「荷花」只有在用户下次**原样**发「荷花」时命中；「荷花什么时候长满池塘」这类长句、任何换述、任何 2 字词嵌长句，**A/B 都召不回**。送审稿 §5.5 分工表的"≥3 子串 / 同义换述 / 2 字词 LIKE"三行全部失实；§6.1"共用同一 BM25 排序"、§6.3"cue_text 重复、词频干扰"两段分析不成立（别名根本不进 cue_text）。

### E-04 · `created_by` 存在，且恒为 `'her'`

- `types.ts:206`：`created_by: 'her' | 'system';`（必填字段）；
- `decision.ts:129-152`：注释"其余字段原样落位，`created_by` 恒为 'her'"，`:150` 硬编码 `created_by: 'her'`。

**后果**：drain 的机械决策（create-card / invalidate）也被标成"她的决策"，台账里该字段**全局无信息量**。R3、R4 均指出此点；**我上一轮"回代码核实"得出的"决策行无 created_by"结论是错的**，成因见 §3 第 3 条。

### E-05 · `mem_miss` 落的是规范化全文，不是"只存 hash"

- `miss.ts:33-34`：`INSERT` 同时写 `term_norm`（明文）与 `term_hash`；
- `memory-tools.ts:205-211`：`termNorm = normalizeLexicalText(整条查询)`，`termHash = sha256(termNorm)`。

**后果**：对中文 NFKC 近乎无损 ⇒ **查询内容落在盘上**。送审稿 §3 约束 3 的括注"（只存 term_hash）"错。这不是 bug，是口径声明失实——而 `term_norm` 恰恰是 Q7 离线分析、Q8 需求绑定守卫的基础（对裁定是利好）。

### E-06 · H7 是硬约束，我材料漏了一整步

- 冻结令 `docs/architecture-design-spec.md:587` 原文：自然语言检索词"受 K5／**H7** 约束"；
- 锚点治理提案 `docs/memory-anchor-governance-and-auto-card-proposal.md:126`：路线一"从事件已有的 key_points 等字段确定性抽取，不调用 LLM、不复制 summary 整句（**仍过 H7 子串反查**）"；
- H7 定义原文 `docs/memory-v1-offline-scaffold-plan.md:502` 与裁决记录 `:1025`：`[...text].length>=20` 且 `summary!==null` 且 `summary.includes(text)`（**原始字面连续包含、不做规范化**）即**整份拒绝**；不足 20 码点跳过；summary 为 null 放行；方向固定"卡文本是 summary 的子串"。

**后果**：送审稿 §4.3 九步算法没有这一步。真机事件一第 2 条 key_point 是 22 码点，正落在高危区间 —— 这不是理论风险。

### E-07 · 增量 diff 不看 cue

`planner.ts:95-103` `sameShape` 只比 `channel / startedMs / endedMs / anchors`；`:140-152` 只有 `cardId`（锚点）变化才 invalidate+create；`:153-163` 否则 `sameShape` 判等即**零动作**。

**后果**：cue 由空变非空**不会触发任何动作**。送审稿 §4.6.2"cue 变化会改变哈希 → 存量两卡按结构变化重建"与代码相反。

### E-08 · 全量重建也不会重派生 cue

`builder.ts:405-430`：对存量卡 `{...old}` 展开，`contentHash` 用 `old.displayCuesJson` 重算——**cue 原文照抄**；`:410-412` 无旧卡直接 `continue`（"零正文纪律：未种子事件不建卡"）。

**后果**：A 阶段 3 写的"离线 CLI `--apply` 全量 rebuild 回填存量"**同样落空**。附带一个需登记的语义问题：从空库整库重建会产出零张卡，现行"整库重建"实际依赖 drain 自愈补卡——这与 R-15"重建归零"的字面理解不同，须在 charter 写明。

### E-09 · `rules_version` 全仓只有一个读者，没有作者（B-2 实锤）

- `store.ts:289-299` `stampMeta` 只 upsert 三键：`schema_version` / `stamped_revision` / `truth_fingerprint`，**签名里根本没有 rules_version**；
- 全仓 `grep rules_version`（排除 lib 构建产物）只有：`drain.ts:381` 读、`types.ts:16` 注释、`content-hash.ts:29` 注释、测试注释——**零写入点**；
- `drain.ts:127-135` `isRulesVersionMismatch(null, v)` 直接 `return false`；
- `planner.ts:110-116` 只有 `projectionRulesVersion !== null` 才比较。

**决定性证据**：`tests/memory/task42-drain-chain.test.ts:466-479` 的红测，是**测试自己** `INSERT OR REPLACE INTO schema_meta('rules_version','rules-v-stale')` 手工造戳，注释坦白"写柄故障注入面之外，测试直接操作投影库 meta"。也就是说：R-18 的红灯能亮，是因为测试给了假戳；**生产从来没盖过这个戳**。

**后果**：改 `CURRENT_RULES_VERSION` 常量后，`rebuild-required` 永不触发。R3 看到"planner 有 rebuild-required 分支"、R1 看到"sameShape + structuralHash"都属实，但只有 R4 顺着"谁写这个键"追到了底。**B-2 成立**。

### E-10 · 期望态本身不含 cue

`derive.ts:107` 注释原文"期望态活卡（可导结构子空间；**不含 cues/别名等不可导残差**）"。`structuralHash` 六输入为 anchors/channel/时间窗/eligibility/rules_version（`derive.ts:78-103`），确实不含摘要文字。`deriveCardId(event.id, anchors)` 也只由事件 id + 锚点派生（`derive.ts:182`）。

**后果**：要让 cue 进比较面，得同时改期望态（`ExpectedCard`）、比对面（`PlanCardRef`/`sameShape`）与物化（`builder`）三处，不能只改一处。

### E-11 · `key_points` 已在 L1 事件投影持久化

`projection/event-row.ts:38/67/206/239`、`projection/event-schema.ts:28/58`、`projection/sqlite.ts:361`（upsert 列表内）。送审稿 §1.3 的 grep 枚举不全（漏了 projection 与 audit）；但核心论断"**没有任何代码把 key_points 桥接到记忆检索字段**"仍成立——这恰好就是 A 要补的那座桥。

### E-12 · 评测夹具的别名是 `sensitive: 0`，与生产相反

`tests/fixtures/memory/gold-l0.json` 两处别名均为 `"sensitive": 0`。而生产 miss 别名恒 1（E-01）。

**后果**：用现有夹具评 B，量到的是**生产不存在的召回面**（sensitive=0 别名能进 FTS/LIKE），R1 会虚高。B 的评测夹具必须改成 `sensitive: 1`，否则评测结论没有外推价值。

### E-13 · 两个"预留但从未产出"的契约值

- `types.ts:188` 与 `ledger.ts:27` 的 action 词表含 `'update-cues'`，全仓无产出点 ⇒ 死词，A 的 cue 变更正好把它接活；
- `types.ts:78` 的 `status` 含 `'tombstoned'`，全仓无写入点（grep 仅此一处声明）⇒ 别名**没有退役路径**，cap 5 是"永久烧坑"。

### E-14 · `versionContext` 已有可选透传口

`runtime.ts:112`：`...(input.versionContext === undefined ? {} : { versionContext: input.versionContext })`。Q7-a 的离线关联与去占位化，不需要新增字段，只需编排层**强制传值**。

---

## 3. 送审稿勘误（7 处 + 2 处补充）

| # | 位置 | 原文（错） | 代码事实 | 来源 | 处置 |
|---|---|---|---|---|---|
| 1 | §5.5 分工表 / §6.1 / §6.3 | B 可命中"≥3 子串 / 同义换述 / 2 字词 LIKE"；A/B 共用 BM25 排序、cue_text 重复有词频干扰 | 别名恒 sensitive=1，只走整句等值（E-01/E-02/E-03） | R3 更正①⑤、R4 M-1 | 已重写：B = 整句等值复现；A/B 物理隔离 |
| 2 | §4.6.2 | cue 由空变非空 → 按结构变化重建（invalidate+create） | sameShape 不含 cue；cardId 不变即零动作（E-07） | R1 前置 1、R3 更正②、R4 B-1 | 已改为："必须扩比较面才可能回填，否则永不回填" |
| 3 | §5.4 | 决策行不含 `created_by`（我上一轮的"更正"） | `types.ts:206` 有该字段；`decision.ts:150` 恒填 `'her'`（E-04） | R3 更正③、R4 M-4 | 已改为："字段存在，但常量填充把系统决策也标成她"。**成因说明**：上一轮我用 `grep ... | head -20` 取证据，输出被截在 `contract/event.ts`，`types.ts`/`decision.ts` 的命中被切掉，据此下了错误结论——工具使用不当导致的实证事故，不是推断失误 |
| 4 | §3 约束 3 括注 | `mem_miss` 只存 `term_hash` | `miss.ts:33-34` 同时存 `term_norm` 明文（E-05） | R3 更正④、R4 M-3 | 已改为"规范化全文落盘、原始全文不落盘" |
| 5 | §4.3 九步算法 | 无 H7 检查 | 冻结令"K5／H7"、提案 :126 要求过 H7、H7 定义在 scaffold:502（E-06） | R3 更正⑥ | 已补为第 3.5 步（见 §4 Q1） |
| 6 | §1.3 | `key_points` 全仓 grep 仅出现在 3 处 | 另有 projection 四处 + event-schema 两处 + sqlite upsert + audit 拒收条款（E-11） | R3 更正⑦ | 已补全列举，结论不变 |
| 7 | §5.2 | miss 别名"零正文、可整库重建，故不适用多次印证" | 别名是残差，重建归零（R-15）；可重建的是投影整体，不是别名（E-08） | R2 §4-1、R3 §一末段 | 已改为"索引层线索、非记忆内容、影响面限于召回、可清零可撤销" |

补充两处（四家虽未列成"更正"，同样须记）：

8. §2.3 把 LIKE 列为召回通道之一 —— 实际被门构造性拒绝（E-02）；已改为"LIKE 不构成召回通道"。
9. §7.5/§4.5 隐含有"清空重建即恢复"的读法 —— 实际 builder 对无旧卡事件 `continue`，空库重建产出零卡，靠 drain 自愈（E-08）；已在阶段 3 口径中写明。

---

## 4. Q1–Q10 整合裁定

格式：四家立场 → 代码/原文实证 → 裁定 → 落点。

### Q1 全案先决：A 是否越 587/K5 线 —— **同意，附条件**（四家一致）

四家一致"不越线"，理由同构：K5 禁的是"LLM **静默**改写已存事实/卡"（spec:813），而 A 的词面来自闭合慢路径产出、随事件版本固化、带 model 留痕的 `key_points`，A 只是确定性投影（同 events 必得同 cues）。且 #42 §2.6 终裁 3 已采纳"路线一保底 cue"为默认立场，本次外审本身就是 :587 规定的解冻门禁，不是对合法性的重开。

**裁定：同意，但附四条硬条件（缺一不可）**：

- **C1 H7 子串反查必须补**（E-06，R3）：对最终落库 cue 逐条检查 `[...cue].length>=20 && summary!==null && summary.includes(cue)`，**原始形态与 NFKC 形态双查**（防规范化绕过，更严的确定性超集）。命中则该条丢弃。
  - 与 H7 原文"整份拒绝"的差异必须写明：原口径是离线 worksheet 场景的整份拒收；A 是自动投影，整卡拒建会造成卡缺失（比少一条钩子更糟），故适配为"该条丢弃 + 遥测计数"。这是**有意的口径收敛**，不是放宽。
- **C2 生产只认 `CURRENT_RULES_VERSION`，不设 A 专属运行期 flag**（R3 条件二）：`types.ts:19` 是编译期常量；若同一 `rules-v1` 下能用 flag 开关出两种 cue，"同真源同规则必同投影"与零漂移红测同时失守。flag 只允许存在于测试/临时根。
- **C3 封侧门**（R4）：A 生效后，closure 侧任何影响 `key_points` 风格的 prompt 改动都构成"借道生成检索词"，视为 A 的再触发条件，评测必须重跑。
- **C4 不复制 summary 整句、不读 raw、不写 mem_alias**（四家共同，材料已承诺）：charter 红测锁死。

### Q2 解冻判据 —— **同意五维 + 预注册样本量**（四家一致）

#42 §2.6 终裁 5 已裁定"五维补全，R1≥0.85/R2≤0.05 不再作唯二门槛"，本题在定稿中已关闭，本轮是程序性复核。

**裁定**：五维不变；补三条口径——①五维中的"线上漏报与 miss 联测"在解冻前只能离线回放/影子预演，**正式联测落解冻后观察窗，两层证据分开陈述**（R4）；②未校准阈值只作观测初值，不作硬拦截（R3）；③bootstrap 重采样按**卡簇**做（同一事件的多条样本不独立，R2）。

### Q3 取前 3 规则 —— **同意保序前 3；驳回包含式去重**

- 四家一致同意 v1 保序前 3：`key_points` 顺序在事件版本固化时即固定（`contract/event.ts:509` 严格校验），取前 3 是纯函数；落选条目的检索价值损失由事件真源 + 通道二回查补（R4 论点，成立）。
- **驳回 R1 的"包含式去重"**（取前 3 前先弃被另一条包含的子串）：它是纯词法、成本低，但会改变"前 3"的语义定义（变成"前 3 个互不包含的子串"），且无任何回放证据支持其收益；v1 不引入未验证的排序偏置。**处置**：列为阶段 2 回放器对比项（与"最短 3 / 最长 3 / 保序 3"同台比较），胜者预注册后才可改。
- 采纳 R4 的"终局取舍规则由回放器数据定"：阶段 2 交付物，不阻塞 v1。
- 红测锁死："第 4 条不上卡面、真源仍在、可经 `resolvePointer` 下钻"。

### Q4 超 40 码点处置 —— **整条丢弃**（3:1）

| 主张 | 来源 | 理由 |
|---|---|---|
| 丢弃 | R1、R3 | 截断产物是**真源不存在的词形**，逼近"生成"；碎片可能恰好成为 summary 子串而触发 H7 或制造误导词干；截到 40 仍是长句，BM25 长度惩罚不解决 |
| 标点软截断、无标点才丢 | R2 | 丢弃致覆盖归零 |
| 截断保留 | R4 | 保留连续子串（trigram 召回命脉），宁截勿丢 |

**裁定：丢弃**。依据：①E-06 让 H7 成为硬约束，任何"新造词形"都在给 H7 与 K5 争议留口实，这一条压过"覆盖"论；②真机 7 条最长 22 码点、40 上限触发率≈0，三方案今日行为逐字节相同，**本裁定的实质是防御性预注册**，不是当下性能取舍；③一旦触发，说明 closure 产出的不是要点而是摘要句——那是上游 prompt 回归信号，用遥测报警比默默截断更有价值（采纳 R4 的遥测点）。

**驳回 R2 标点软截断**：软截断依赖标点形态（全角/半角/无标点混排都不可控），规则复杂度上升而收益为 0；且"无标点才丢弃"仍保留截断产物的定性问题。

**驳回 R1 的"schema 加 cue 长度 CHECK"**：40 是**派生层**应用口径，不是人工字段契约；加 CHECK 需走 schema 迁移（新版本号、重建），成本高于收益。处置：40 作为预注册常量 + 红测断言 + 遥测，钉进 charter 防两处漂移。对比：`discriminator<=40` 的 CHECK 是人工字段约束，性质不同。

**顺序裁定（细化 R3）**：`规范化 → >40 丢弃 → H7 双形态过滤 → 保序取前 3 → 空集回退 [""]`。R3 建议"先取前 3 再查 H7"，本稿改为**先过滤后取 3**——否则 H7 拒掉一条后卡面会缺位，第 4 条本可合法上位。这是对 R3 的收窄而非推翻。

### Q5 短词/换述归属 —— **全部归 B；登记系统级天花板**（四家一致，附重写）

A 侧不做 2 字词派生：`normalizeLexicalText` 只做 NFKC + ASCII 小写 + 空白折叠（`gate.ts:48`），从要点句抽 2 字词属分词/判断，越过"纯投影"边界；`MIN_TRIGRAM_LENGTH=3` 是 FTS5 trigram 的结构性下限（`projection/sqlite.ts:39`），不为短词改 tokenizer。

**但 B 侧的预期必须按 E-01/E-03 重设**：B 只解决"整句等值复现"——用户单独发「荷花」能命中；「荷花那题答案是多少」不能。**"短词嵌长句不可召回"登记为系统级已知天花板**（R3/R4 一致），要填它属于"查询切词"新卡，**本轮不支持借 A/B 之手夹带**。

红测：`「3 加 5 等于 8」(cue) 对「3加5等于8」(用户输入)` 判 miss，进 S4 夹具（R4 m-3）。

### Q6 金标独立构造 —— **采纳 R4 方案为基线，R2 的更大样本作扩样上限**

四家都要求"金标独立构造、禁 key_points 出题、holdout 封存、夹具敏感位对齐生产"。分歧只在样本量。

**裁定口径（预注册，阶段 2 前冻结，之后不得看结果调阈值）**：

- **五层构造线**：S0 用户原话复述（raw-turns 用户问句，不经闭合模型）／S1 逐字片段（占比 ≤25%，只作 sanity）／S2 重叠换述（共享 ≥1 个 2 字内容词但非连续子串，源自 raw/summary）／S3 同义改写（无 ≥3 码点连续共享）／S4 口语·错字·空格·全半角变体。
- **量**：每层 ≥50、总量 ≥200；诱饵对 ≥100（jaccard 近邻）；holdout ≥40 独立封存，不参与任何调参（含 Q3 的规则对比），终判只认 holdout。
- **判据**：95% CI 半宽 ≤0.05 方可下结论；不足即"不得下结论"（`§7.4` 已有客观口径）。按 p≈0.85 估算 n≈200 与分层总量对齐（R4 推算成立）。
- **扩样备用**：若按卡簇重采样（R2）后 CI 仍宽，样本上限提到 ≥300/≥300（R2）；R3 的 n≥100 被 R4 的 n≥200 覆盖，不再单独采用。
- **机械防自证（写进夹具加载校验器，不靠自觉）**：S2–S4 的查询不得是目标卡 `cue_text` 的连续子串，加载期硬校验失败即拒；撰写源锁定 raw/summary；与 key_points 的 trigram 重合率超阈值条目剔除。
- **敏感位**：B 的评测夹具别名必须 `sensitive: 1`（E-12）；A 的评测**零别名注入**。
- 两层证据分开：夹具结论只对夹具分布有效，线上确认放解冻后观察窗。

### Q7 D-1 关联口径 —— **选 a，并修正"无法离线分析"的说法**（四家一致）

`mem_miss` 有 `term_norm` 明文（E-05）+ `gate_status` 分类 + `observed_ms` + append-only；`decisions.jsonl` 的 add-alias 行带 `event_id / card_id / anchors / termNorm`（`store.ts:545` dedupKey 编码）。

**裁定：a**。离线按 `miss.term_norm == alias.term_norm` + 时间窗重建"哪类落空补到哪张卡"，零新增写面。唯一盲区是"回查了但没挂"，由同 term_norm 的重复 miss 间接观测（R3/R4 一致）。

采纳三条落地要求：
- **`versionContext` 必须传真实事件版本**（E-14，R3），避免落 `LEGACY_ONLY_MISS_ALIAS_VERSION` 占位导致版本身份失真；
- 决策行 `reason` 带观测时刻：`add-alias:miss-recheck:<observedMs>`（R2/R3），把 miss↔alias 联接到台账；
- `computeMissTermHash = sha256(termNorm)` 写进 charter 作为联查键（R4）。

**驳回 b**（回填预留列 / 追加带锚 miss 行）：破坏 append-only、retention 会按窗口裁掉新行（R4 补充，比原论点更硬）、且同一次落空计两行会污染 miss 率。
**c 缓议**：新增投影面撞"不新增"约束，且与 decisions 审计面重叠；若观察期证明 a 的 join 不够用，再按 K9 立 c（R3）。

### Q8 二次落空门槛 —— **不设硬门；改"需求绑定 + 冲突拒绝 + 退役 + 反事实"**（3:1）

| 主张 | 来源 |
|---|---|
| 支持"同 term_norm 在 mem_miss ≥2 次才可挂"，默认开、预注册开关 | R1 |
| 反对：与 Q7-a 口径矛盾、推迟首次修复 | R2 |
| 反对：不证明选卡正确；改需求绑定守卫 | R3 |
| 反对：伪约束（miss 行无 card_id，同卡不可机检）+ 代价翻倍 | R4 |

**代码实证**：miss 表结构（E-05）无 `card_id` ⇒ R1 设想的后半段"两次落空命中同一卡"**不可机检**；前半段"同词 ≥2 次"可机检，但它不证明选卡正确（两次落空后她同样可能错认两回，R4 论点），且把首次修复从第 2 次提问推到第 3 次，正打掉 B 的核心价值（spec §5.1-3"下次同一问题即可被召回"）。

**裁定：不设硬门槛**，改四件套：
1. **需求绑定守卫 `alias-no-demand`**（R3）= R4 的"miss 前置校验"（同一机制的两种命名，统一取 `alias-no-demand`，charter 注同义）：`addMissAlias` 落库前同事务查 `SELECT 1 FROM mem_miss WHERE term_norm = ? LIMIT 1`（保留窗口内），不存在则拒。理由：由 E-03，别名只在整句等值生效，挂一个从未落空过的词是纯投机、零收益；该守卫不损失有效覆盖，还**免费获得 D-1 关联**（别名 ≡ 落空词）。
2. **跨卡冲突拒绝 `alias-term-conflict`**（R4）：`term_norm` 已 active 于其他卡 → 拒。同词多卡在 schema 上合法，但对"miss 补词"而言歧义几乎总是误认。
3. **退役出口**（见 P9）：没有出口的 cap 5 是单向烧坑（E-13）。
4. **反事实注入验收**（R2）：向夹具注入错误别名，要求 ΔR2 ≤ +0.02。这把"错挂会不会真的污染"变成可观测量。

**R1 的"两次落空"降为预注册观测项**：观察期经离线 replay 审计，错挂率 > 20%（R4 建议阈值）再升为硬门——用数据升级，不用直觉预设。

**provenance 顺手修（并入本题）**：`DecisionCasterInput` 加可选 `initiator`（缺省 `'system'`），drain 传 `'system'`、add-alias 工具路径传 `'her'`（E-04，R4）。非 schema 变更。架构 §6.2"created_by 只允许 her"的措辞需同步一行澄清（语境是她的判断写入，不覆盖机械投影行），按 M6 纪律走显式修订，不在实现 PR 偷改（R3）。

### Q9 放量顺序 —— **A 先行；补 B 解冻门 + B 专属开关**（四家一致）

**裁定：A 先行**。理由：A 确定性、可回滚、覆盖存量；B 的数据面（落空集）必须以 A 生效后的命中分布为基线，否则无法归因。

补三件（原材料缺）：
1. **基线切割口径**（R3）：B 的干净基线 = `mem_miss.observed_ms ≥ A 重建 revision 的 at_ms` 且投影 `schema_meta.rules_version` 已为 rules-v2 之后的行；切割点写进 charter，不得用混合期数据评 B。
2. **B 解冻门**（R4，预注册、时点不可事后挑）：A 解冻后，on 态真实门控检索累计 ≥30 次 **或** 观察窗 ≥14 天（孰先），且按 `term_hash` 去重的 miss 集连续 7 天无新增。
3. **B 专属写入开关**（R4 M-5，默认关）：现状 `memoryGateMode='on'` 即可写 `addMissAlias`（`memory-tools.ts` 只挡 off/shadow），观察期"她不挂别名"只靠 prompt，不可审计。加代码级开关是**工程期配置，不是审批按钮**，不违反"运行回路零人工"。

**注意两处"看似冲突"**：R3 要求"A 不设独立 config flag"、R4 要求"B 加专属开关"——两者管的是不同对象（A 的派生规则必须由 rules_version 唯一决定；B 的写入能力必须在观察期可关），**并存不矛盾**。

R2 的"检索 ≥200 次且 miss ≥50"不作解冻门，作**下结论的样本门槛**（与 Q6 同口径）；解冻门与分析门槛分开陈述，避免用"没样本"卡住解冻、或用"够解冻"冒充"够结论"。

### Q10 运维契约 —— **v1 默认重建归零；台账即备份；恢复是后续离线工具**

- **默认语义不改**：重建后 miss 别名归零（R-15、§3.7 残差侧），v1 不自动恢复（R1/R2 一致）。
- **台账即备份**（R3/R4）：`dedupKey` 已编码 `add-alias|eventId|cardId|termNorm`，`sensitive` 生产恒 1 ⇒ 无需新导出格式。
- **恢复工具**（后续立项，不阻塞本期）：离线 CLI 重放 `decisions.jsonl` 的 add-alias 行（需新增回放分支——现行 `replayDecisions` 只回放 tombstone/invalidate，`builder.ts:275-289`）；重放行必须走全部校验（需求绑定 + 冲突拒绝）并带 `reason='restore:<snapshotMs>'` 溯源（R2）；`hit_count/last_hit_ms` 归零并写进契约（R4）。
- **R-15 修订走 #42 流程**（R4）：若采纳"可经台账重放恢复"，是对 R-15 的**显式修订**，不得默默改断言。
- **5/卡保留**（四家一致）：配退役出口后 5 个槽位是"活跃别名滚动窗口"而非终身烧坑；以 `alias-cap-exceeded` 遥测频率决定是否上调（预注册 >5% 才立项扩上限）。

---

## 5. 前置清单（P1–P12）与归属

### A · #123（P1–P6；P1–P3 = B-1，P4 = B-2）

| 编号 | 事项 | 落点（符号） | 验收 |
|---|---|---|---|
| P1 | cue 派生纯函数：`normalize → >40 丢弃 → H7 双形态 → 保序前 3 → 空集 [""]` | 新建 derive 侧纯函数（不读 raw、不调 LLM） | 正反例红测含 22 码点真机样本；同 events 双跑逐字节相等 |
| P2 | 期望态与比对面扩 cue：`StructuralHashInput`/`ExpectedCard`/`PlanCardRef` 增 `cuesHash`，`sameShape` 比它 | `derive.ts` · `planner.ts` | "结构不变、cue 变" → 产出 `update-card` 动作（回滚到当前行为则红） |
| P3 | 物化重派生 cue + `update-card` 落 `action='update-cues'` 决策行（接活死词 E-13） | `drain.ts` · `builder.ts` | 存量两卡经一次 drain 后 `display_cues_json` 非空；决策行可见 |
| P4 | `stampMeta` 增第四键 `rules_version`，由 `transactionApply` / `--apply` 落章 | `store.ts` | "stamp 后改常量 → drain 拒跑"红测；不再依赖测试手工造戳（E-09） |
| P5 | cue 规范化收口到 `materializeDrainCardRow` 单点 | `builder.ts` | 未规范化入参被单点兜住（R4 m-1） |
| P6 | 评测：五层夹具、别名 `sensitive:1`、机械防自证、诱饵 ≥100、holdout ≥40 | `tests/fixtures/memory/` | 加载期校验拒收 S2–S4 子串样本；A 评测零别名 |

### B · #120（P7–P12）

| 编号 | 事项 | 落点 | 验收 |
|---|---|---|---|
| P7 | `alias-no-demand` 守卫（mem_miss 同 term_norm 存在性，同事务） | `alias-write.ts` · `store.ts` | 无落空记录的别名被拒；有记录放行；零新增表 |
| P8 | `alias-term-conflict` 跨卡拒绝 | 同上 | 同词已 active 于其他卡 → 拒 |
| P9 | 退役出口：离线 CLI 置 `tombstoned` + 词表追加 `'retire-alias'`（不复用 `tombstone-card`） | `alias-write.ts` · `decision.ts` · `ledger.ts` | 退役后可重挂；台账有行；契约变更入 charter |
| P10 | `castDecision` 加 `initiator`（缺省 `'system'`；drain=`'system'`、工具=`'her'`） | `decision.ts` · `store.ts` | drain 决策行为 `system`，add-alias 为 `her` |
| P11 | B 专属写入开关（默认关，独立于 gate 三态） | `memory-tools.ts` · `runtime.ts` | 门 on + 开关关 → `addMissAlias` 拒；开关开 → 放行 |
| P12 | `versionContext` 强制传 + `reason='add-alias:miss-recheck:<observedMs>'` + term_hash 联查键 | `runtime.ts` 编排层 | 决策行版本身份非占位；observedMs 可 join |

### 需修订的上游文档（不是代码）

- 架构 §6.2 关于 `created_by` 的措辞补一行机电/系统决策例外（P10 落地时同步，走 M6）。
- #42 §3.5/§3.7 关于"期望态不含 cues"的一句话修订（cue 是检索面派生物，与 summary 不同类），理由写进 #123 charter（R4 B-1 修法 i）。
- R-15 若采纳台账重放恢复，须显式修订（R4）。

---

## 6. 对四家的采纳/驳回台账

### R1（仓库级核验）

- 采纳：阻塞缺口定性（cue 不在比对面）、Q4 丢弃、H7 无关的三条件细化、`reason` 分型 `drain-projection:keypoints` / `:observation`（可观测来源，进 P1 遥测）、前置条件编号化。
- 部分采纳：schema 加 cue 长度 CHECK → 驳回（改应用层常量 + 红测）；包含式去重 → 降到阶段 2 对比项。
- 驳回：Q8 二次落空硬门（依据：E-05 无 card_id，后半段不可机检；推迟首次修复）。

### R2（网络受限，以附录 C 为据）

- 采纳：需求绑定预检（与 R3 合并为 P7）、证据必填、反事实注入 ΔR2≤+0.02、撤销/退役出口、`reason` 带 `observedMs`、按卡簇重采样、CI 双线判据、§4 勘误第 7 条（§5.2 自相矛盾）。
- 部分采纳：样本 ≥300/≥300 作"重采样后扩样上限"，不作基线。
- 驳回：Q4 标点软截断（规则复杂度上升、收益为零，且仍是新造词形）；Q10 导出审计+破窗恢复的"自动恢复"部分（v1 不自动恢复）。

### R3（clone 全核）

- 采纳：7 处更正中的 6 处（第 7 处措辞）、H7 补步、planner 比较面扩 `event.version`、A 不设运行期 flag、三哈希角色澄清、混合来源残差边界、空 key_points 口径、回滚红测 `row_hash_sum` 逐字节相等、需求绑定守卫、`versionContext` 强制、台账即备份。
- 部分采纳：H7 检查顺序改为"先过滤后取 3"（见 Q4）；`event.version` 与 R4 的 `cuesHash` 二选一 → 取 `cuesHash`（理由：version 单调但语义上是事件修订号，cuesHash 直接表达"派生结果变了"，且能覆盖 rules 不变仅 key_points 变的场景；两者可并存，v1 先用 cuesHash）。
- 驳回：无。R3 的"她可把任意词挂到任意卡"若不加守卫是真缺口，其提出的守卫本稿直接采纳为核心机制。

### R4（AutoClaw，raw 全文）

- 采纳：B-1 三处证据链与修法 i、B-2 与"stamp 后拒跑旧版本"红测、M-1 命中面重写、M-2 退役、M-3 口径、M-4 `initiator`、M-5 B 专属开关、m-1 规范化收口、m-3 空格变体、Q6 五层与机械防自证、Q9 解冻门、Q10 台账重放、`update-cues` 接活、封侧门。
- 部分采纳：`cuesHash` 进三处类型 → 采纳；"invalidate-all 重建"备选 → 不采用（噪声大，作为回退方案记录）；Q6 的 n≥200/半宽 0.05 → 采纳为基线。
- 驳回：Q4 截断保留（依据：E-06 H7 硬约束 + 新造词形定性问题；真机触发率≈0，无需为覆盖率牺牲定性）。

### 四家共同指出的、本文全部采纳的

- 分别取号（A=#123、B=#120），A 先行；
- 金标独立构造、禁 key_points 出题、holdout 封存；
- 夹具别名必须 `sensitive=1`；
- Q5 短词归 B、登记天花板；
- Q2 五维 + 预注册；
- "同意不越线 ≠ 同意解冻"。

---

## 7. 未决与需主控拍板

1. **取号**：A=#123 需主控按台账确认（`architecture-design-spec.md:905` 记"下一空号 #123"）；B=#120 锁号但立项仍 pending（#105）。
2. **A 是否立即动工**：本稿建议——**可以先动 P1–P5（纯函数 + 比较面 + 物化 + 落章）**，因为这五项不改变运行期行为（门不开就不生效），属于"把机制补成真的"；**解冻仍须等 P6 评测达标**。
3. **Q4/Q8 的最终确认**：本稿已按 3:1 裁定，若主控要保留少数派方案，需在 charter 里注明"少数派意见保留、以观测数据复核"。
4. **送审稿是否随裁定稿一起入库**：目前送审稿 untracked，裁定稿新增；提交需单独授权。
5. **`alias-no-demand` 与 `no-recorded-miss` 命名统一**：本稿取前者，charter 注同义，避免两处漂移。

---

## 8. 证据索引

| 编号 | 符号 | 文件:行 |
|---|---|---|
| E-01 | `addMissAlias` 窄柄 `sensitive: 1` | `src/memory/runtime.ts:106-113`、`:11/:34/:47` |
| E-02 | `like-only-weak-match` 构造性拒 | `src/memory/gate.ts:118-119`；`src/memory/bm25.ts:138` |
| E-03 | 别名等值通道 `term_norm = q` | `src/memory/bm25.ts:105-111`、`:77` |
| E-04 | `created_by` 恒 `'her'` | `src/memory/types.ts:206`；`src/memory/decision.ts:129-152` |
| E-05 | `mem_miss` 同写 `term_norm`/`term_hash` | `src/memory/miss.ts:33-34`；`src/assembly/memory-tools.ts:205-211` |
| E-06 | H7 原文与"仍过 H7" | `docs/memory-v1-offline-scaffold-plan.md:502`、`:865`、`:1025`；`docs/memory-anchor-governance-and-auto-card-proposal.md:103`、`:126`；`docs/architecture-design-spec.md:587` |
| E-07 | `sameShape` 四字段 | `src/memory/planner.ts:95-103`、`:140-163` |
| E-08 | 存量卡搬运旧 cue / 无旧卡 continue | `src/memory/builder.ts:405-430`、`:275-289` |
| E-09 | `stampMeta` 三键 / mismatch(null)=false / 测试手工造戳 | `src/memory/store.ts:289-299`；`src/memory/drain.ts:127-135`、`:381-382`；`src/memory/planner.ts:110-116`；`tests/memory/task42-drain-chain.test.ts:466-479` |
| E-10 | 期望态不含 cues / `deriveCardId` | `src/memory/derive.ts:107`、`:78-103`、`:182` |
| E-11 | `key_points` L1 投影持久化 | `src/projection/event-row.ts:38/67/206/239`；`src/projection/event-schema.ts:28/58`；`src/projection/sqlite.ts:361` |
| E-12 | 夹具别名 `sensitive: 0` | `tests/fixtures/memory/gold-l0.json` |
| E-13 | `update-cues` 死词 / `tombstoned` 无写入 | `src/memory/types.ts:188`、`:78`；`src/memory/ledger.ts:27` |
| E-14 | `versionContext` 可选透传 | `src/memory/runtime.ts:112` |
