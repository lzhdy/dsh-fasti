# P6 D2 独立出题任务书（外部出题人实现文档）

> 版本：v1（对应工程基线 commit `3f04748`，夹具 schema 与防自证规则以本文为准）
> 你是**独立出题人**。你的唯一输入是一份盲包，你的产出是一套 JSON 考卷。
> 本文自包含：不读任何代码、不看任何系统内部文件，仅凭本文与盲包即可完成。

---

## 1. 背景与角色（一分钟版）

有一个人造的"生活小镇"：100 个虚构生活事件，每个事件含 6–7 句一个人对 AI 说的原话、一句客观摘要。其中 80 个是**封存事件**（终判用，id 前缀 `syn-sealed-`），20 个是**调参事件**（id 前缀 `syn-tuning-`）。

系统内部会为每个事件生成"记忆卡"，但**你看不到卡片、看不到答案要点、看不到检索规则**。你要像一位只拿到课本、拿不到标准答案的命题老师，基于用户原话和摘要出题，考系统能不能把对的记忆捞出来。

工程侧（收卷方）只做**机械校验**：规则全部预先写死在本文。校验不过，整包退回并附规则编号，你修改后整包重交；**收卷方不会替你改一个字**。

---

## 2. 铁律（违反任一即整包拒收）

1. **输入白名单**：只允许使用交付给你的 `blind-package.json` 与 `world-manifest.json` 中的信息。禁止读取、索要、推测任何代码库文件、卡片库、派生规则、历史卷子或本文之外的工程文档。
2. **禁止反推答案面**：盲包中不存在的字段（key_points、cue、别名、判别词、卡片 id、规则版本等），不得以任何方式重建或猜测其字面值。
3. **题面只许来自原话与摘要**：每条金标题必须能在对应事件的 `turns[*].rawText` 或 `summary` 上定位到撰写源，禁止引入盲包中不存在的"事实"。
4. **层归属一次性定格**：每条题属于 S0–S4 哪一层，交付时写死，不允许一题挂多层、不允许交付后口头改层。
5. **原样交付 JSON**：UTF-8、无 BOM、标准 JSON（无注释、无尾逗号）、2 空格缩进；字段名与枚举值逐字照抄本文，多一个字段都会被拒收。
6. **全部中文题面**；只能使用盲包中出现的虚构人名与场景，禁止真实个人信息，禁止政治、医疗诊断、色情等越界内容。
7. 不允许"调题"：收到退回意见后，只按指出的规则编号修改，禁止顺手改动未被点名的条目（否则校验方按新版本重新全量校验，责任仍由你自负）。

---

## 3. 输入物说明

### 3.1 `blind-package.json`

顶层结构：

```json
{
  "schema": "fasti-p6-blind/v1",
  "seed": 20261118,
  "baseEpochMs": 1767603600000,
  "events": [ /* 100 个 BlindEvent，顺序即事件序号 */ ]
}
```

每个事件对象字段：

| 字段 | 含义 | 出题时怎么用 |
|---|---|---|
| `eventId` | 事件唯一 id，`syn-sealed-001..080` / `syn-tuning-001..020` | 卷子中用它指代目标事件 |
| `partition` | `sealed` 或 `tuning` | 决定进封存卷还是调参卷，两者禁止互混 |
| `familyId` | 题材族 id（共 20 族，封存 16 族、调参 4 族） | 同族 5 个事件共享一个大主题，是诱饵近邻题的取材范围 |
| `channel` | 恒为 `"dsh"` | 卷子照抄 |
| `startedAtMs` / `endedMs` | 事件起止毫秒时间戳 | 一般不直接使用 |
| `summary` | 一句客观摘要 | 允许作为撰写源之一 |
| `turns` | 6 条（封存前 10 个事件为 7 条）用户话头，按时间排序 | S0/S1 的唯一原话来源；数组下标 0 起，即 `turns[0]…turns[5]` |
| `sensitiveTerms` | 该事件的敏感称呼数组（每事件 1 个人名） | 允许原样引用，禁止在 S2/S3 换述层当拐杖 |
| `highRiskLabels` | 高危标签数组，仅封存前 10 个事件非空 | 见 §8 高危覆盖硬指标 |

每条 turn：`{ "speaker": "user", "offsetMinutes": 12 的倍数, "rawText": "原话" }`。

**族结构关键事实**：每个族恰好 5 个事件，同族事件主题相近但各有独立细节；族与族之间词表互不重叠。出诱饵判别题时，配对双方**必须同族**。

### 3.2 `world-manifest.json`

含总量、分区计数与高危清单（`highRiskInventory`：10 行，eventId→label）。五类标签含义：

| label | 含义 | 对应话头特征 |
|---|---|---|
| `strong` | 强语气强制 | "绝对不能再拖""必须本周搞定" |
| `promise` | 承诺 | "我答应过…一定给准信" |
| `date` | 精确日期时间 | "一月十八号上午九点" |
| `verbatim` | 逐字数字/报价 | "三百二十八块五，一个字都别改" |
| `negation` | 否定约束 | "千万别…不要回复任何人" |

标签在事件上的分布固定：封存事件 001/002 为 `strong`，003/004 为 `promise`，005/006 为 `date`，007/008 为 `verbatim`，009/010 为 `negation`。

---

## 4. 输出物总览

交付一个目录（打包为 zip 亦可），结构**必须**精确如下：

```
d2-output/
├── sealed/
│   ├── gold-l0.json          # 350 条五层金标题（主交付物）
│   ├── decoy-authored.json   # 100 条诱饵判别题（事件级中间格式）
│   ├── abstain-authored.json # 100 条弃权/噪声探针（事件级中间格式）
│   └── author-manifest.json  # 产量自检表与独立声明
└── tuning/
    ├── gold-l0.json          # 40 条调参查询（仅 S0/S2 口径）
    └── author-manifest.json
```

说明：系统最终夹具需要卡片 id，而你看不到卡片 id。因此诱饵与噪声题你只写到**事件 id 级**，收卷方用确定性机械映射把事件 id 换成卡片 id；你不接触、也不需要知道卡片 id。

所有 JSON 顶层统一形状：`{ "probeSetVersion": "v1", "layer": "<层名>", "items": [ ... ] }`。

---

## 5. 五层出题口径（S0–S4）

| 层 | 怎么写 | 硬性写法约束 |
|---|---|---|
| **S0** 用户原话复述 | 把某条 `turns[*].rawText` **整句原样**作为 query，一字不改（含标点） | 必须与某条 rawText 逐字相等；撰写源只能是 `raw-turn` |
| **S1** 逐字片段 | 从某条 rawText 中**连续截取**一小段原文，一字不改 | 片段码点数 ÷ 原句码点数 **≤ 0.25**；必须是连续子串，不许拼接、不许跳字 |
| **S2** 重叠换述 | 换一个说法，允许保留原话里的个别内容词，但整句是新写的 | 不得照抄原句连续短语；最终会被机械检测：与答案要点存在 ≥3 个连续码点重合即拒收 |
| **S3** 同义改写 | 用同义词、新句式彻底改写，语义仍明确指向同一事件 | 与答案要点不得有 ≥3 个连续码点重合；比 S2 更远、更"看不出原词" |
| **S4** 表面变体 | 同一内容的口语化、错字、加空格、全角/半角变体 | 至少产出两类不同变体；故意加空格的变体允许系统检索失败，这是预期的一部分，不算出错 |

**码点计数统一口径**：按 Unicode 码点计数，不是 UTF-16 长度、也不是字节数。自查方法（任选工具实现等价语义）：JavaScript `Array.from(str).length`；emoji/生僻字按 1 个码点计。

S1 占比公式（必须自己算并填入 `sourceCharShare`，保留 4 位小数以内）：

```
sourceCharShare = Array.from(片段).length / Array.from(原句rawText).length
```

S2/S3/S4 的语义要求：读完 query 必须仍能明确知道用户问的是**哪一个封存事件**（它们是有金标题，不是无答案题）；只是用字越来越远离原句。S2/S3 中禁止出现该事件的 `sensitiveTerms`（敏感称呼只允许在 S0/S1 原话类题目中原样出现）。

---

## 6. 封存卷 `sealed/gold-l0.json` 完整规格

### 6.1 顶层与条目形状

```json
{
  "probeSetVersion": "v1",
  "layer": "l0",
  "items": [
    {
      "eventId": "syn-sealed-001",
      "channel": "dsh",
      "queries": ["……"],
      "aliases": [],
      "sensitiveTerms": ["周房东"],
      "discriminatorNeighborEventIds": ["syn-sealed-002"],
      "expectedSlots": ["relevance"],
      "constructionLayer": "S0",
      "sourceLocation": { "source": "raw-turn", "anchor": "turns[0]" },
      "highRiskLabel": "strong",
      "arbitration": {
        "adjudicator": "independent-author",
        "decision": "LAYER-S0-VERBATIM"
      }
    }
  ]
}
```

一个 item = **一个事件 × 一个构造层**。同一事件的同一层只有一个 item，该层的多条 query 放进这个 item 的 `queries` 数组。

### 6.2 逐字段规则

| 字段 | 规则 |
|---|---|
| `eventId` | 必须是盲包里存在的 `syn-sealed-xxx`；禁出现 tuning id |
| `channel` | 恒 `"dsh"` |
| `queries` | 非空字符串数组；**每个事件每个构造层最多 4 条**（冻结硬上限）；条间不得重复（含跨层重复也禁止） |
| `aliases` | **必须恒为 `[]`**。本考试零别名注入，填任何别名整包拒收 |
| `sensitiveTerms` | 照抄盲包该事件的 `sensitiveTerms` 数组 |
| `discriminatorNeighborEventIds` | 同族其他事件的 eventId 数组（0–4 个）；S0/S1 题至少填 1 个同族事件，S2–S4 可填 `[]` |
| `expectedSlots` | 枚举数组，本题全部统一填 `["relevance"]`，不得自创槽位 |
| `constructionLayer` | 枚举：`S0`/`S1`/`S2`/`S3`/`S4`，必填 |
| `sourceLocation` | 必填。`source` 枚举 `raw-turn`/`summary`；`anchor`：原话题填 `"turns[下标]"`，摘要题填 `"summary"`。S0/S1 只允许 `raw-turn` |
| `highRiskLabel` | 可选。仅当该事件在 `world-manifest.highRiskInventory` 中带同一标签时才允许填写，枚举五类之一 |
| `sourceCharShare` | 仅 S1 item 必填，数值 0..1 且 ≤0.25；其他层禁止出现该字段 |
| `arbitration` | 必填，形状 `{ "adjudicator": "independent-author", "decision": "<裁定码>" }` |

裁定码固定五选一，与 constructionLayer 对应：

| constructionLayer | decision |
|---|---|
| S0 | `LAYER-S0-VERBATIM` |
| S1 | `LAYER-S1-FRAGMENT` |
| S2 | `LAYER-S2-OVERLAP-PARAPHRASE` |
| S3 | `LAYER-S3-SYNONYM` |
| S4 | `LAYER-S4-SURFACE-VARIANT` |

除上表列出的字段外**禁止任何多余键**（校验器按白名单拒收）。

### 6.3 配额与分布（冻结数字，一条不能少）

| 构造层 | query 总数下限 | 分布要求 |
|---|---:|---|
| S0 | **100** | 80 个封存事件每事件至少 1 条；多出的 20 条加在偶数编号事件（002、004、…、040）各 1 条 |
| S1 | **100** | 同上分布；每条必须带合规 `sourceCharShare` |
| S2 | **50** | 覆盖至少 30 个不同事件，每事件该层 ≤4 |
| S3 | **50** | 同 S2 |
| S4 | **50** | 同 S2；题面须包含至少两种变体手法（错字/空格/全半角/口语化任选） |
| 合计 | **350** | 全部 80 个封存事件都必须至少在某一层出现 |

每条 query 全局唯一，禁止跨事件、跨层复用同一句。S0 的两条配额允许来自同一事件的不同 turns。

### 6.4 S2/S3 被退回怎么办（预先告知的机械规则）

你看不到答案要点，所以 S2/S3 偶发"撞词"是预期内的。收卷方对每条退回只给：**文件内条目位置 + 规则号 + 你写的原句**，不会泄露答案要点本身。规则号含义：

- `G4-1`：你的句子成了系统检索词的连续子串（S2–S4 不许照抄词面）→ 改写得更远。
- `G4-2`：与答案要点有 ≥3 个连续码点重合 → 换掉连续重合的词，用同义表达，保持语义指向不变。

你只需根据被点名的自己的句子做改写，重交整包。

---

## 7. 诱饵判别题 `sealed/decoy-authored.json`

考系统在两个高度相似的记忆之间能不能分清楚。配对双方必须是**同族的两个封存事件**。

顶层：`{ "probeSetVersion": "v1", "layer": "decoy", "items": [ ... ] }`

条目形状（事件级中间格式）：

```json
{
  "pairEventIds": ["syn-sealed-001", "syn-sealed-003"],
  "goldEventId": "syn-sealed-001",
  "discriminatorQuery": "卫生间漏水那个水管接头到底要不要换？",
  "highRiskLabel": "strong"
}
```

| 字段 | 规则 |
|---|---|
| `pairEventIds` | 恰好 2 个不同的封存事件 id，且二者 `familyId` 相同 |
| `goldEventId` | 必须是 pairEventIds 之一；指明哪一边是正确答案 |
| `discriminatorQuery` | 非空中文字符串；题意明确指向 gold 事件的独有细节，取材只许来自这两个事件的 turns/summary；禁止写对方事件的独有细节 |
| `highRiskLabel` | 可选；仅当 gold 事件在高危清单中且题面确实考查该高危语义时填写 |

配额硬指标：

1. **恰好 100 条**，`discriminatorQuery` 全局唯一；
2. 参与的封存事件（出现在任意 pairEventIds 中去重）**≥50 个**；目标是尽量覆盖全部 80 个；
3. 每个参与事件至少在 **2 对**中出现；
4. 推荐确定性取材，减少返工：每个族按事件 id 升序在 5 个事件间组无向对（每族最多 10 对），每族先取前 6 对得 96 条，再给 f01–f04 各补 1 对凑满 100；
5. 同族 5 个事件的共享大主题可以出现在题面，但判别落点必须是 gold 的专属细节，不能是两事件通用的空话。

---

## 8. 弃权/噪声探针 `sealed/abstain-authored.json`

两类各 50 条，独立分母，不计入 350 金标题。

顶层：`{ "probeSetVersion": "v1", "layer": "abstain", "items": [ ... ] }`

条目形状（事件级中间格式）：

```json
{ "query": "……", "goldEventId": null, "kind": "unanswerable" }
{ "query": "……", "goldEventId": "syn-sealed-005", "kind": "noise" }
```

| 字段 | 规则 |
|---|---|
| `query` | 非空中文字符串，全局唯一 |
| `kind` | 枚举 `unanswerable` / `noise` |
| `goldEventId` | `unanswerable` 必须为 `null`；`noise` 必须填一个封存事件 id |

**unanswerable（50 条）**：问的是这个小镇里**根本不存在**的事情。要求：

- 题材与全部 20 个族的主题、全部 `sensitiveTerms`、全部事件细节都不沾边（收卷方持有盲包全量词表做机械撞词检查，命中即退回）；
- 50 条覆盖 50 个互不重复的陌生领域，句式自然，像真人随口一问；
- 不得写成荒诞乱码，必须是合理但无答案的问题。

**noise（50 条）**：题意真实指向某个封存事件（goldEventId），但刻意用**宽泛、笼统**的表达，不直接使用该事件最独特的细节词，用来考验系统在噪声中能否精确锁定那一张卡而不是乱认近邻。50 条的 goldEventId 尽量分散到至少 30 个不同封存事件。

---

## 9. 调参小包 `tuning/gold-l0.json`

仅用于工程侧标定一个内部阈值，不进终判，配额为工程约定（非冻结统计量）。

- 顶层同样是 `{ "probeSetVersion": "v1", "layer": "l0", "items": [...] }`；
- 目标事件只许是 `syn-tuning-001..020`，每事件 2 条、共 **40 条**：1 条 S0（原话整句）、1 条 S2（换述，遵守 §5 的 S2 写法与 G4 退回合规）；
- 字段规则与 §6 完全相同（含 `aliases: []`、sourceLocation、arbitration；S2 条目不写 sourceCharShare）；
- 不出诱饵题、不出弃权题；同目录 `author-manifest.json` 格式见 §10。

---

## 10. `author-manifest.json` 自检表

两个目录各放一份，形状：

```json
{
  "probeSetVersion": "v1",
  "author": "independent-author",
  "inputs": ["blind-package.json", "world-manifest.json"],
  "partition": "sealed",
  "counts": {
    "goldByLayer": { "S0": 100, "S1": 100, "S2": 50, "S3": 50, "S4": 50 },
    "goldQuestionsTotal": 350,
    "goldEventsCovered": 80,
    "decoyPairs": 100,
    "decoyEventsCovered": 80,
    "abstainUnanswerable": 50,
    "abstainNoise": 50,
    "highRiskLabeledItems": 10
  },
  "declaration": "本人仅依据盲包原话与摘要命题，未读取任何答案侧材料，层归属一次性定格，愿接受整本退回重交。"
}
```

tuning 目录的 manifest 中 `partition` 填 `"tuning"`，counts 只填 `goldByLayer: {"S0":20,"S2":20}` 与 `goldQuestionsTotal: 40`、`goldEventsCovered: 20`，其余键省略。

---

## 11. 交付前自检清单（逐条打勾，任何一条不过不要交）

1. 目录结构与文件名与 §4 完全一致；所有 JSON 能被标准解析器解析，无注释/尾逗号/BOM。
2. 五个文件 `probeSetVersion` 都是 `"v1"`，`layer` 取值与文件名匹配（l0/decoy/abstain）。
3. 350 金标题配额精确达标；每事件每层 query ≤4；80 个封存事件全部被覆盖；S2/S3/S4 各覆盖 ≥30 事件。
4. 每个 item 字段严格匹配白名单，无自创键；枚举值逐字正确；所有金标 item 都有 sourceLocation 与 arbitration。
5. 全部 `aliases` 为 `[]`；没有任何 item 引用 tuning 事件，tuning 包没有任何 sealed id。
6. S0 句句可与某条 rawText 逐字对上；S1 全部是连续片段且 sourceCharShare 经码点口径复算 ≤0.25。
7. S2/S3 题面不含敏感称呼；S2/S3/S4 题面语义仍唯一指向目标事件，不是无答案题。
8. 封存 001–010 每个高危事件至少有 1 条 item 带匹配的 `highRiskLabel`（合计 ≥10 条，五类各 ≥2）。
9. 诱饵 100 对、同族配对、goldEventId 属于配对、参与事件 ≥50 且每事件 ≥2 对、判别 query 全局唯一。
10. 弃权探针 50/50；unanswerable 不撞盲包任何词表；noise 的 goldEventId 分散 ≥30 事件。
11. 全量 query 去重（含跨文件）后数量不变；没有空字符串、没有纯标点句。
12. manifest 计数与实际 items 逐字段相等。

---

## 12. 验收与退回协议

- 收卷方运行确定性校验器，覆盖：JSON 形状与白名单字段、配额与分布、S1 码点占比复算、零别名、事件 id 存在性与分区隔离、高危覆盖、诱饵同族/配对/覆盖、unanswerable 撞词、以及防自证规则 G3/G4（见 §6.4）。
- 结果只有两种：**全量通过，进入封存流程**；或**整包拒收**，退回一份按条目定位的规则编号清单（例：`gold-l0.json items[17].queries[0] 命中 G4-2`）。
- 退回不提供任何答案侧字面值、不提供替你写好的句子。你按编号修订后整包重交，manifest 中计数同步更新。
- 收卷方不会"顺手帮忙"修改任何题面；任何非你本人产出的文字都不会进入封存卷。

---

## 附录 A：单条 S1 计算示例

某事件 `turns[2].rawText` 为「帮我记着阳台封窗这个情况，胶条老化先按兵不动」（26 个码点）。

- 合规 S1 片段示例：「阳台封窗」（4 码点），4 / 26 ≈ 0.1538 ≤ 0.25，`sourceCharShare` 填 `0.1538`，sourceLocation 填 `{ "source": "raw-turn", "anchor": "turns[2]" }`。
- 不合规：把半句话拼起来、跳字截取、或占比 >0.25，一律拒收。

## 附录 B：同事件三层写法对照（示意，实际以盲包原文为准）

- 原话（S0 源）：「之前提过的厨房顶灯，后来灯管更换有没有新消息」
- S1 片段：「灯管更换」
- S2 换述：「照明那盏灯换新灯管的事后来咋样了」
- S3 同义改写：「屋内吊顶光源配件替换的进展你那边有消息吗」
- S4 表面变体：「厨 房 那 个 灯 管 更 换 滴 事 情」／「厨房顶灯换灯管儿那事儿咋说了」

（S2/S3 示例仅演示风格距离；正式命题必须从所交付盲包的真实原文出发。）
