# P6 出题任务书 v2 · 新合成世界（questions-v2，冻结稿）

> 版本：**v2 冻结稿 · 2026-11-24 外审终审通过即冻结**（对应预注册 v5；终审件 `rules-v2外审终审确认-2026-11-24.md`，冻结内容基线 commit `8ae063a`）。v1 已随旧卷 `probes-v1` 退役，不得混用两版配额。冻结后题面／配额／校验器口径若须改动，须与预注册 §9 同步走升版重审，不得就地改本任务书。
> 你是**独立出题人**。唯一输入是一份盲包 `blind-package.json` ＋ `world-manifest.json`；唯一产出是一套 JSON 考卷。本文自包含：**不读任何代码、不看任何系统内部文件、不看旧卷**，仅凭本文与盲包即可完成。

---

## 1. 背景（一分钟版）

一个虚构生活小镇：**500 个事件**，分属 **100 个题材族**，每族 5 个事件，每事件含 6 句一个人对 AI 说的原话＋1 句客观摘要。其中 **400 个封存事件**（id `syn-sealed-001..400`，终判用）与 **100 个调参事件**（id `syn-tuning-001..100`，只用于标定内部阈值，不进终判）。

与 v1 的三点关键不同，**必须理解，否则会出废题**：

1. **族间存在刻意安排的跨族撞词，但撞词不印在原话里**：有约 24 个 2 字高频生活词（预约／续费／上门／报价／改期／确认／到期／退换…）被刻意挂到**不同族**的答案侧要点上，制造跨主题"同名不同事"，不是笔误。这些撞词**不会出现在你拿到的盲包原话中**，而是由 `world-manifest.json` 的 `collisionWords` 清单显式交付（词＋承载族，见 §3.2）；你不会在 A 族、B 族原文里读到同一个"预约"，而是凭清单给的词与族去构造 §7.2 撞词题——两族真实内容本就是两件不同的事。**不要尝试从盲包原文自挖撞词**（挖不到，原因见预注册附录 A）。
2. **原话带口语噪声**：语气词、主语省略、句尾截断、错字、半角全角混用、句内空格都是**原话的一部分**，不是你写错了。S0 必须原样照抄（含这些噪声）。
3. **新增 S5 层**：有一类原话带"上次那个……"式指代，考系统能不能定位到正确的那个事件。

系统内部会为每个事件生成"记忆卡"，但**你看不到卡片、看不到答案要点（key_points）、看不到检索词（cue）、看不到别名、看不到检索规则**。你像一位只拿到课本、拿不到标准答案的命题老师。

收卷方只做**机械校验**，规则全部预先写死在本文；不过即整包退回并附规则编号。**收卷方不会替你改一个字。**

---

## 2. 铁律（违反任一即整包拒收）

1. **输入白名单**：只允许使用交付给你的 `blind-package.json` 与 `world-manifest.json`。禁止读取、索要、推测任何代码库、卡片库、派生规则、旧卷或本文之外的工程文档。
2. **禁止反推答案面**：key_points、cue、别名、判别词、卡片 id、规则版本等盲包中不存在的字段，不得以任何方式重建或猜测字面值。
3. **题面只许来自原话与摘要**：每条金标题必须能在对应事件的 `turns[*].rawText` 或 `summary` 定位到撰写源，禁止引入盲包中不存在的"事实"。**唯一例外（外审 F2 方案丁）**：`world-manifest.json` 的 `collisionWords` 撞词允许、且仅允许出现在 §7.2 `cross-family-collision` 诱饵题的 `discriminatorQuery` 中——撞词是答案侧族共享点、本就不在盲包文本里，属清单显式交付的设计词；该题其余成分（尤其 gold 的独有细节）仍必须能在 pair 事件原话定位。S0–S5 金标题与其他诱饵档不得使用任何盲包外成分。
4. **层归属一次性定格**：每条题在交付时写死属于 S0–S5 哪一层，不允许一题挂多层、不允许交付后口头改层。
5. **原样交付 JSON**：UTF-8、无 BOM、标准 JSON（无注释、无尾逗号）、2 空格缩进；字段名与枚举逐字照抄本文，**多一个字段都会被拒收**。
6. **全部中文题面**；只使用盲包中出现的虚构人名与场景，禁止真实个人信息，禁止政治、医疗诊断、色情等越界内容。
7. **不许调题**：收到退回意见后只按指出的规则编号修改，禁止顺手改动未被点名的条目。

---

## 3. 输入物

### 3.1 `blind-package.json`

```json
{
  "schema": "fasti-p6-blind/v2",
  "seed": <由收卷方给定>,
  "baseEpochMs": <由收卷方给定>,
  "events": [ /* 500 个 BlindEvent，顺序即事件序号 */ ]
}
```

| 字段 | 含义 | 出题时怎么用 |
|---|---|---|
| `eventId` | 事件唯一 id，`syn-sealed-001..400` / `syn-tuning-001..100` | 卷子中用它指代目标事件 |
| `partition` | `sealed` 或 `tuning` | 决定进封存卷还是调参卷，**两者禁止互混** |
| `familyId` | 题材族 id（共 100 族：封存 80、调参 20） | 同族 5 个事件共享大主题，是**同族诱饵**取材范围 |
| `channel` | 恒为 `"dsh"` | 卷子照抄 |
| `startedAtMs` / `endedMs` | 事件起止毫秒 | 一般不直接使用 |
| `summary` | 一句客观摘要 | 可作撰写源之一 |
| `turns` | 6 条用户话头（高危事件为 7 条），按时间排序 | **S0/S1/S5 的唯一原话来源**；下标 0 起。**条数规则（务必按此读，别按 id 或标签猜）——四种组合只有两种条数：①无指代无高危＝6 条，`turns[5]` 是普通模板句；②有指代无高危＝6 条，`turns[5]` 是指代句；③无指代有高危＝7 条，`turns[5]` 是普通模板句、`turns[6]` 才是高危话头；④有指代有高危＝7 条，`turns[5]` 指代、`turns[6]` 高危。因此：**`turns.length===7` 只说明带高危，不说明带指代**；判定是否含指代只能看 `turns[5]` 是否以「上次说的那个」开头** |
| `sensitiveTerms` | 该事件敏感称呼（每事件 1 个人名） | 允许 S0/S1 原样引用；**S2/S3/S4/S5 禁止作拐杖** |
| `highRiskLabels` | 高危标签数组 | 见 §8 高危覆盖 |

每条 turn：`{ "speaker": "user", "offsetMinutes": 12 的倍数, "rawText": "原话" }`。

**族结构与撞词事实**：每族恰 5 个事件，同族主题相近、细节各异。跨族撞词是答案侧要点层（key_points/cue）的刻意共享，**只制造检索面上的"表面相似"，并不写进任何事件的 rawText**；撞词与其承载族一律以 `world-manifest.json` 的 `collisionWords` 为准（§3.2），在盲包原文里检索该词会扑空，请勿据此判为数据缺失。两件事的实际内容不同——**跨族诱饵题正是考这一点**（§7.2）。

### 3.2 `world-manifest.json`

含总量、分区计数、高危清单 `highRiskInventory`（封存前若干事件 eventId→label），以及 **`reusedDetailWords`（18 个跨族共享细节词清单，P-c 新增）**。清单里的词各自恰好被 2 个族共享，是 §7.3／§7.4 两类题的**唯一取材来源**；清单外的细节词都是唯一词，做不出这两档题。

另含 **`collisionWords`（24 项，外审 F2 新增）**：每项形如 `{ "word": "预约", "familyIds": ["f001-s", "f005-s", …] }`，给出每个 2 字设计撞词及其**封存族**映射（只给族 id、不给事件 id、不给 key_points/hasRef）。这些撞词只存在于系统答案侧、**不会出现在你拿到的盲包原话里**（自行从盲包挖跨族 2 字词会得到上千个无关串、挖不到这 24 个，故不要自挖），是 §7.2 跨族撞词题的**唯一取材来源**。

五类标签含义照 v1 不变：

| label | 含义 | 话头特征 |
|---|---|---|
| `strong` | 强语气强制 | "绝对不能再拖""必须本周搞定" |
| `promise` | 承诺 | "我答应过…一定给准信" |
| `date` | 精确日期时间 | "一月十八号上午九点" |
| `verbatim` | 逐字数字/报价 | "三百二十八块五，一个字都别改" |
| `negation` | 否定约束 | "千万别…不要回复任何人" |

标签在事件上的分布以 `world-manifest.json` 的 `highRiskInventory` 为准，**不要按 id 顺序猜**（v2 的世界结构与 v1 不同）。

---

## 4. 输出物总览

```
q2-output/
├── sealed/
│   ├── gold-l0.json          # 500 条金标题（主交付物）
│   ├── decoy-authored.json   # 200 条诱饵判别题（事件级中间格式）
│   ├── abstain-authored.json # 200 条弃权/噪声探针（事件级中间格式）
│   ├── clarify-authored.json # 18 条应澄清题（只含共享细节词，独立分母，P-c 新增）
│   └── author-manifest.json  # 产量自检表与独立声明
└── tuning/
    ├── gold-l0.json          # 200 条调参查询（S0 与 S2 各 100）
    └── author-manifest.json
```

系统夹具需要卡片 id，而你看不到卡片 id：诱饵与噪声题你只写到**事件 id 级**，收卷方用确定性机械映射换成卡片 id。你不接触、也不需知道卡片 id。

所有 JSON 顶层统一形状：`{ "probeSetVersion": "fasti-p6-probes/v2", "layer": "<层名>", "items": [ ... ] }`。
**注意**：v2 的 `probeSetVersion` 是 `fasti-p6-probes/v2`，不是 `v1`；写成 v1 整包拒收。

---

## 5. 六层出题口径（S0–S5）

| 层 | 怎么写 | 硬性约束 |
|---|---|---|
| **S0** 原话整句 | 把某条 `turns[*].rawText` **整句原样**作 query，一字不改（含标点、语气词、错字、空格） | 必须与某条 rawText 逐字相等；撰写源只能 `raw-turn` |
| **S1** 逐字片段 | 从某条 rawText **连续截取**一小段，一字不改 | 片段码点 ÷ 原句码点 **≤ 0.25**；必须连续子串，不许拼接跳字 |
| **S2** 重叠换述 | 换个说法，可保留个别内容词，整句新写 | 不得照抄原句连续短语；与答案要点 ≥3 连续码点重合即退回（G4-2） |
| **S3** 同义改写 | 同义词＋新句式彻底改写，语义仍唯一指向同一事件 | 与要点不得 ≥3 连续码点重合；比 S2 更远 |
| **S4** 表面变体 | 同一内容的口语化／错字／加空格／全半角变体 | 至少两类不同手法；**故意加空格的变体允许系统检索失败**，这是预期，不算出错 |
| **S5** 可解指代 | 取目标事件某条 turn 中带「限定词＋前序细节」的句子，如"上次说的那个胶条老化的事，后来你帮我留意了吗" | 必须能定位到 `turns[i].rawText`；必须含限定词（见 §5.1）；不得抄另一事件的独有细节；不得含 `sensitiveTerms`；与要点不得 ≥3 连续码点重合 |

**码点计数口径**：按 Unicode 码点计数（不是 UTF-16 长度、不是字节）。自查：JavaScript `Array.from(str).length`。

S1 占比公式（自己算并填 `sourceCharShare`，保留 4 位小数以内）：

```
sourceCharShare = Array.from(片段).length / Array.from(原句rawText).length
```

**S2/S3/S4/S5 的共同语义底线**：读完 query 必须仍能明确指出问的是**哪一个封存事件**（它们是有金标题，不是无答案题）；只是用字越来越远离原句。S2/S3/S4/S5 **禁止出现该事件的 `sensitiveTerms`**。

> **G4-2 出题端不可自检——如实声明（外审 F3）**：S2–S5 的「与 key_points ≥3 连续码点重合即退回（G4-2）」是一条**只有收卷方掌握答案侧、出题端无法自检**的规则：key_points 不在盲包，铁律 2 也禁止你反推。你不需要、也无法预判是否触线；**出题端唯一可执行的操作口径＝不照抄任何 rawText 的连续短语**（整句改写、换词、换句式，S1 的连续截取除外且受 0.25 约束）。是否真触线一律以收卷方校验器为准，触线按 G4-2 编号退回，属机械校验结果而非对你命题能力的否定。

### 5.1 S5 怎么识别（可操作判定）

只有**同时满足**下列三条的句子才是合格 S5 素材：

1. 句中出现指代标记词之一：`上次`／`前面`／`之前`／`那个`／`那事`／`还提到过`／`刚才说的`；
2. 指代之后**必须紧跟一个具体细节名词**（不能只是"那个呢""上次那个"这种裸指代）；
3. 该细节名词必须是**本事件自己**独有的内容（不是同族另一事件的细节）。

裸指代（如"那个呢""上次那个"）**不是 S5 素材**，也不得配金标——它们属于弃权探针的 `unanswerable`（§9）。

---

## 6. 封存卷 `sealed/gold-l0.json` 完整规格

### 6.1 顶层与条目形状

```json
{
  "probeSetVersion": "fasti-p6-probes/v2",
  "layer": "l0",
  "items": [
    {
      "eventId": "syn-sealed-014",
      "channel": "dsh",
      "queries": ["……"],
      "aliases": [],
      "sensitiveTerms": ["周房东"],
      "discriminatorNeighborEventIds": ["syn-sealed-013", "syn-sealed-015"],
      "expectedSlots": ["relevance"],
      "constructionLayer": "S5",
      "sourceLocation": { "source": "raw-turn", "anchor": "turns[3]" },
      "arbitration": { "adjudicator": "independent-author", "decision": "LAYER-S5-CONTEXT-REFERENCE" }
    }
  ]
}
```

一个 item ＝ **一个事件 × 一个构造层**；同事件同层只有 1 个 item，多条 query 放进 `queries` 数组。

### 6.2 逐字段规则

| 字段 | 规则 |
|---|---|
| `eventId` | 盲包中存在的 `syn-sealed-xxx`；禁出现 tuning id |
| `channel` | 恒 `"dsh"` |
| `queries` | 非空字符串数组；**每事件每层 ≤4 条**；条间不得重复（跨层重复也禁止） |
| `aliases` | **必须恒为 `[]`**，填任何别名整包拒收 |
| `sensitiveTerms` | 照抄盲包该事件的数组 |
| `discriminatorNeighborEventIds` | 0–4 个同族其他事件 eventId；S0/S1/S5 至少填 1 个同族事件，S2–S4 可填 `[]` |
| `expectedSlots` | 本题统一 `["relevance"]`，不得自创 |
| `constructionLayer` | 枚举 `S0`/`S1`/`S2`/`S3`/`S4`/`S5`，必填 |
| `sourceLocation` | 必填。`source` 枚举 `raw-turn`/`summary`；`anchor`：原话填 `"turns[下标]"`，摘要填 `"summary"`。S0/S1/S5 只允许 `raw-turn` |
| `highRiskLabel` | 可选；仅当该事件在高危清单中带同一标签时才可填 |
| `sourceCharShare` | **仅 S1 必填**，0..1 且 ≤0.25；其他层出现即拒 |
| `arbitration` | 必填，形状 `{ "adjudicator": "independent-author", "decision": "<裁定码>" }` |

裁定码固定六选一：

| constructionLayer | decision |
|---|---|
| S0 | `LAYER-S0-VERBATIM` |
| S1 | `LAYER-S1-FRAGMENT` |
| S2 | `LAYER-S2-OVERLAP-PARAPHRASE` |
| S3 | `LAYER-S3-SYNONYM` |
| S4 | `LAYER-S4-SURFACE-VARIANT` |
| S5 | `LAYER-S5-CONTEXT-REFERENCE` |

除上表字段外**禁止任何多余键**（白名单拒收）。

### 6.3 配额与分布（冻结数字，一条不能少）

| 层 | query 总数 | 分布要求 |
|---|---:|---|
| S0 | **150** | 覆盖 ≥150 个不同封存事件，每事件 ≤2 条 |
| S1 | **150** | 同上；每条必带合规 `sourceCharShare` |
| S2 | **50** | 覆盖 ≥30 个不同封存事件，每事件 ≤4 |
| S3 | **50** | 同 S2 |
| S4 | **50** | 同 S2；每事件题面须含 ≥2 种变体手法 |
| S5 | **100** | **覆盖 ≥100 个不同封存事件，每事件 ≤1**（每族只有 2 条指代素材，不许同事件出多题） |
| 合计 | **500** | — |

每条 query 全局唯一（跨事件、跨层、跨文件都不得复用同一句）。S0 两条配额可来自同事件不同 turns。

> **金标并集覆盖（外审 F4 明文化）**：S0–S5 五层金标题的目标事件**并集必须覆盖全部 400 个封存事件**（`syn-sealed-001..400` 一个不漏）。`author-manifest.json` 里的 `goldEventsCovered: 400` 是这一硬要求的计数定值，不是可协商的下限。

---

## 7. 诱饵判别题 `sealed/decoy-authored.json`

考系统在两个高度相似的记忆间能否分清，分两类，独立分母。

顶层：`{ "probeSetVersion": "fasti-p6-probes/v2", "layer": "decoy", "items": [ ... ] }`

条目形状：

```json
{
  "pairEventIds": ["syn-sealed-001", "syn-sealed-003"],
  "goldEventId": "syn-sealed-001",
  "discriminatorQuery": "卫生间漏水那个水管接头到底要不要换？",
  "decoyKind": "same-family",
  "highRiskLabel": "strong"
}
```

| 字段 | 规则 |
|---|---|
| `pairEventIds` | 恰好 2 个不同封存事件 id |
| `goldEventId` | 必须是 pair 之一，指明正确答案 |
| `discriminatorQuery` | 非空中文；题意明确指向 gold 的**独有细节**，取材只许来自这两个事件的 turns/summary；禁止写对方独有细节 |
| `decoyKind` | 枚举：`same-family`（同族近邻）／`cross-family-collision`（跨族撞词）／`cross-family-detail-reuse`（跨族共享细节词，P-c 新增） |
| `highRiskLabel` | 可选；仅当 gold 在高危清单且题面确实考查该高危语义 |

### 7.1 同族近邻题（114 条）

- `decoyKind = "same-family"`，`pairEventIds` 二者 `familyId` **相同**；
- 判别落点必须是 gold 的专属细节，不能是两事件通用的空话；
- 覆盖 ≥100 个不同参与事件，**每参与事件 ≥1 对**（与 §11 第 10 条同口径；外审 F4 放宽、终审 §三.2 确认）。`≥1` 是**分布质量下限**，保证每个参与事件至少入一对、不出现空载事件；不要求每事件 ≥2 对，是为给 114 对在 ≥100 个事件上的分布留足出题自由度、避免为凑数牺牲配对自然度。注意这不是容量约束——114×2=228 ≥ 100×2=200，每事件 ≥2 在算术上本属可行，故放宽是质量取舍而非被迫；114 对总量与 ≥100 事件覆盖两项硬要求维持不变。

### 7.2 跨族撞词题（50 条，**v2 新增，重点**）

- `decoyKind = "cross-family-collision"`，`pairEventIds` 二者 `familyId` **必须不同**；
- 构造方法（外审 F2 定稿）：**不要从盲包文本自挖撞词**（挖不到，见 §3.2），改为从 `world-manifest.json` 的 `collisionWords` 取一个 `word`，在它的 `familyIds` 里任取**两个不同封存族**，再从这两个族各选一个事件组成 pair；
- `discriminatorQuery` 必须**同时**包含：①该共享撞词 `word`（铁律 3 的唯一豁免成分，允许不在原话中）；②gold 事件的**独有细节**，且这部分必须能在 gold 事件的 `turns/summary` 定位。**判别落点必须落在 gold 的独有细节上**——只靠共享撞词无法区分两族，必须给出更具体的细节才能选对（例如撞词「预约」＋gold 独有的「门锁锁芯」）；
- 覆盖 ≥50 个不同封存事件；`discriminatorQuery` 全局唯一。

> 为什么新增：宽召回会把"字面相似但内容不同"的卡一起带进候选，这类题正是检验排序层能否顶住。旧卷没有这一类。

### 7.3 跨族共享细节词题（36 条，**P-c 新增**）

- `decoyKind = "cross-family-detail-reuse"`，`pairEventIds` 二者 `familyId` **必须不同**；
- 取材范围**严格限定**为盲包 `world-manifest.json` 的 `reusedDetailWords` 清单（18 个词）。清单外的词是唯一细节词，做不出这一档题；清单内每个词恰好被 2 个族共享，所以每词只有一对事件可选；
- 构造方法：`discriminatorQuery` 必须**同时包含**该共享细节词与 gold 事件的**另一条独有细节**（例如「清洗洗衣机带 那个 排水地漏 怎么办」）。只写共享词属于 §7.4 的澄清题，不属于本类；
- 每条 pair 出 2 题（分别以两族事件之一为 gold），18 词 × 2 ＝ 36 条；`discriminatorQuery` 全局唯一；
- 为什么单列：实测（N1h）这类题在两候选下证据可判别（证据三元组 18/18 全对），是三档诱饵里唯一真正考排序层能力的一档；同族近邻与撞词题考的是「族内／表面的相似」，本档考的是「同一个具体物件、两件不同的事」。
- **出题端须知（#178 已落地，`a206098`）**：证据三元组排序已是生产行为，不再是待实施设想——门控路径按「复盘标记 → exact → 总码点 → 字段数 → 最长字段」确定性定序、打平才回落记忆序，**没有任何随机**。所以本档 36 条按「线索充分即应选对」的严格标准出题即可，不必为随机性留容差；500 卡真根端到端对拍该档 18/18 全对、诱饵置顶 0。反之 §7.4 的澄清题**只写共享词**，不得掺入任何一方独有细节，否则会从澄清层串到判别层。

### 7.4 应澄清题（18 条，独立层 `sealed/clarify-authored.json`，**P-c 新增**）

- 顶层形状同 decoy，但 `layer` 填 `"clarify"`，字段为：`pairEventIds`（2 个共享细节词的封存事件）、`detailWord`（该共享词）、`expectedBehavior: "clarify"`；
- `query` **只写共享细节词本身**（可加语气词，不得加任何一方独有细节）；
- 覆盖全部 18 个 `reusedDetailWords`，每词 1 条；
- **不计入任何 top1／inSet 分母**，单独统计「是否输出澄清/低置信」；理由见 §7.3 与预注册 §3.6：这一档结构上不可判别，拿它当判别题计分等于判系统做不可能完成的题。

---

## 8. 弃权/噪声探针 `sealed/abstain-authored.json`

两类各 100 条，独立分母，**不计入 500 金标题**。

顶层：`{ "probeSetVersion": "fasti-p6-probes/v2", "layer": "abstain", "items": [ ... ] }`

```json
{ "query": "……", "goldEventId": null, "kind": "unanswerable" }
{ "query": "……", "goldEventId": "syn-sealed-005", "kind": "noise" }
```

| 字段 | 规则 |
|---|---|
| `query` | 非空中文，全局唯一 |
| `kind` | `unanswerable` / `noise` |
| `goldEventId` | `unanswerable` 必须 `null`；`noise` 必须填一个封存事件 id |

**unanswerable（100 条）**：问的是小镇里**根本不存在**的事。

- 与全部 100 族主题、全部 `sensitiveTerms`、全部事件细节都不沾边（收卷方持全量词表机械撞词，命中即退）；
- 100 条覆盖 100 个互不重复的陌生领域，句式自然，像真人随口一问；
- **至少 20 条为裸指代**（"那个呢""上次那个后来怎样"），这是真机高频形态、正确答案就是弃权；
- 不得写成荒诞乱码，必须是合理但无答案的问题。

**noise（100 条）**：题意真实指向某个封存事件，但用**宽泛笼统**的表达，不直接使用该事件最独特的细节词，考验系统在噪声中能否精确锁定那一张卡而不是乱认近邻。

- `goldEventId` 尽量分散到 ≥60 个不同封存事件；
- 禁止用裸指代（裸指代属 unanswerable）。

---

## 9. 调参小包 `tuning/gold-l0.json`

仅用于工程侧标定内部阈值，**不进终判**，配额为工程约定（非冻结统计量）。

- 顶层 `{ "probeSetVersion": "fasti-p6-probes/v2", "layer": "l0", "items": [...] }`；
- 目标事件只许 `syn-tuning-001..100`，每事件 2 条、共 **200 条**：1 条 S0（原话整句）、1 条 S2（换述，遵守 §5 与 G4 退回合规）；
- 字段规则与 §6 相同（`aliases: []`、sourceLocation、arbitration；S2 不写 `sourceCharShare`）；
- 不出诱饵、不出弃权；同目录 `author-manifest.json` 见 §10。

---

## 10. `author-manifest.json`

```json
{
  "probeSetVersion": "fasti-p6-probes/v2",
  "author": "independent-author",
  "inputs": ["blind-package.json", "world-manifest.json"],
  "partition": "sealed",
  "counts": {
    "goldByLayer": { "S0": 150, "S1": 150, "S2": 50, "S3": 50, "S4": 50, "S5": 100 },
    "goldQuestionsTotal": 500,
    "goldEventsCovered": 400,
    "decoyPairs": 200,
    "decoySameFamily": 114,
    "decoyCrossFamily": 50,
    "decoyDetailReuse": 36,
    "clarifyItems": 18,
    "decoyEventsCovered": 200,
    "abstainUnanswerable": 100,
    "abstainNoise": 100,
    "highRiskLabeledItems": 10
  },
  "declaration": "本人仅依据盲包原话与摘要命题，未读取任何答案侧材料，层归属一次性定格，愿接受整本退回重交。"
}
```

tuning 目录 `partition` 填 `"tuning"`，counts 只填 `goldByLayer: {"S0":100,"S2":100}`、`goldQuestionsTotal: 200`、`goldEventsCovered: 100`。

> **模板计数与正文「≥」的关系（外审 F4）**：本模板 `counts` 里写的是**交付时必须恰好相等的目标定值**（收卷方逐字段核对，§11 第 13 条）；正文各档出现的「≥N」是**分布下限约束**（允许超过、不得低于），两者不矛盾。其中 `goldEventsCovered: 400`、`decoyEventsCovered: 200`、`highRiskLabeledItems: 10` 三个值同时也是下限即目标值，理由分别见 §6.3（金标并集覆盖全部封存事件）、§7（诱饵参与事件 ≥200）、§8 高危清单（五类各 ≥2、共 10）。

---

## 11. 交付前自检清单（任何一条不过不要交）

1. 目录结构与文件名同 §4；所有 JSON 可被标准解析器解析，无注释／尾逗号／BOM。
2. 五个文件 `probeSetVersion` 都是 `fasti-p6-probes/v2`，`layer` 与文件名匹配。
3. 500 金标题配额精确达标；每事件每层 ≤4；S0/S1 各覆盖 ≥150 事件、S5 覆盖 ≥100 事件且每事件 ≤1；S2/S3/S4 各覆盖 ≥30 事件。
4. 每个 item 字段严格匹配白名单、无自创键；枚举逐字正确；金标 item 均有 sourceLocation 与 arbitration。
5. 全部 `aliases` 为 `[]`；无 item 引用 tuning id；tuning 包无 sealed id。
6. S0 句句能与某条 rawText 逐字对上（含语气词、错字、空格）；S1 全部为连续片段且 `sourceCharShare` 经码点口径复算 ≤0.25。
7. S2/S3/S4/S5 题面不含敏感称呼；语义仍唯一指向目标事件，不是无答案题。
8. S5 条条满足 §5.1 三条件（有指代标记词、后接具体细节名词、细节属本事件）。
9. 封存高危事件每个至少有 1 条带匹配 `highRiskLabel`（合计 ≥10，五类各 ≥2）。
10. 诱饵 200 对：同族 114（`same-family`）＋跨族撞词 50（`cross-family-collision`，撞词与 pair 族必须取自 manifest `collisionWords`、query 含该撞词且含 gold 独有细节）＋跨族共享细节词 36（`cross-family-detail-reuse`，取材只用 `reusedDetailWords` 18 词、每词 2 方向）；goldEventId 属于配对；参与事件 ≥200 且每事件 ≥1 对；判别 query 全局唯一。
11. 弃权 200：unanswerable 不撞盲包任何词表、含 ≥20 条裸指代；noise 的 goldEventId 分散 ≥60 事件。
12. 澄清 18：`clarify-authored.json` 覆盖 18 个共享细节词各 1 条，query 只含该共享词、不含任何一方独有细节；不计入任何判别分母。
13. 全量 query 去重（含跨文件）后数量不变；无空串、无纯标点句。
14. manifest 计数与 items 逐字段相等。

---

## 12. 退回协议

- 收卷方跑确定性校验器，覆盖：JSON 形状与白名单、配额与分布、S1 码点复算、零别名、id 存在性与分区隔离、高危覆盖、诱饵两类同族／跨族判定与覆盖、unanswerable 撞词、防自证 G3/G4，以及外审 F1 补齐的下列三项**全量机检**（不再抽查）：
  - **C-7.3 线索充分性**（§7.3 专用）：每条 `cross-family-detail-reuse` 的 `discriminatorQuery` 必须含 **≥1 个仅出现在 gold 事件、且不属于该 pair 共享细节词的 token**；只含共享词即判串层到 §7.4，整项退回。校验口径：以盲包 token 集合与 `reusedDetailWords` 清单机械比对，无需答案侧材料。
  - **C-7.4 澄清纯度**（§7.4 专用）：每条 clarify 的 `query` **不得含 pair 任一方事件的独有 token**（语气词除外）；混入任一方独有细节即判串层到 §7.3，整项退回。
  - **C-7.2 撞词合规**（§7.2 专用）：`cross-family-collision` 的 pair 两族必须都在该 `word` 的 manifest `collisionWords.familyIds` 内且互不相同；`discriminatorQuery` 须含该 `word`，并含 ≥1 个可在 gold 事件原话定位、不在另一族事件出现的独有 token；撞词只能取自 `collisionWords`，自造撞词整项退回。
  - **C-S5 三条件全量检**：对全部 100 条 S5 逐条机检 §5.1 三条件（含封闭的 6 个指代标记词之一、后接具体细节名词、该细节属本事件）。标记词表封闭（§5.1 实列 **7 个**：上次／前面／之前／那个／那事／还提到过／刚才说的；外审意见作「6 词」系计数偏差，以本任务书词表为准）、全量成本极低，故不再保留抽查口径。
- 结果只有两种：**全量通过并封存**；或**整包拒收**，退回按条目定位的规则编号清单（例：`gold-l0.json items[17].queries[0] 命中 G4-2`）。
- 退回不提供任何答案侧字面值、不提供替你写好的句子。按编号修订后整包重交，manifest 同步更新。

---

## 附录：同事件多层对照（示意）

- 原话（S0 源）：`那个…卫生间漏水的事我跟你说，水管接头必须这周弄好`
- S1 片段：`水管接头必须这周弄好`
- S2 换述：`洗手间漏水那个接头这周到底弄不弄`
- S3 同义改写：`屋内水管接驳处渗水的处理进度怎么样了`
- S4 表面变体：`卫 生 间 漏 水 的 事 儿 咋 说`／`卫生间漏水那事儿这周弄好没`
- S5 可解指代：`上次说的那个水管接头的事，后来你帮我盯着了吗`

（仅演示风格距离；正式命题必须从所交付盲包的真实原文出发。）
