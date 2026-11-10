# 主动摄入接口草案（评估稿，未实施）

> 目的：把「她自己主动逛 B 站、写感想」这类**非对话轮**的经历，接进现有的记事本与事件层。
> 本稿只做现状核对与方案比较，不改任何代码；A 块冻结面一律不动。

## 1. 边界（先说清不做什么）

- **不内置调度器**。「什么时候她该主动去逛」是 C 块（主动性）的职责，内核不装定时器、
  不做唤醒决策——否则记事本就成了会自己行动的实体，违背「记录本」定位。
- **不注入人格**。她的动机、口吻、想不想逛，来自 C 块的人格侧；本稿只解决
  「她做了/想了什么之后，怎么如实落成一条经历」。
- **不新增原语**。`PRIMITIVE_NAMES` 是 A 块冻结面，加名字等于破契约。

## 2. 现状（代码实测，非推测）

| 入口 | 实际行为 | 能否表达「她主动逛并写感想」 |
|---|---|---|
| `ingestRawTurn(channel, input)` | 写原文层 + 写经历 + 折投影，一个原子操作 | **半可行**：`kind` 硬编码为 `'dialogue'`，她的感想会被记成一次对话 |
| `appendExperience(exp)` | 可写任意 `kind`（含 `reflection` / `perception` / `action`） | **半可行**：不写原文层，`observation.text` 指针无处可指；不带 `text` 就没有 event 幂等键 |
| `ingestMedia(bytes, meta)` | 抛 `NotImplementedError`（阶段 3+） | **不可行**：截图、封面、视频帧进不来 |
| `registerChannel` | 通道需显式注册；当前只有 `dsh` 一个 | 需先注册 `browser` 类通道 |

字段现状（可用部分）：

- `initiation` 由 `speaker` 映射：`user→user`、`assistant→her`、`system→system`、
  `tool→environment`，未知值原样保留 → **「她发起」这个语义已经存在**，无需新字段。
- `kind` 已知值含 `perception` / `action` / `reflection` → **「这是她的感知/动作/反思」
  这个语义也已经存在**，只是 `ingestRawTurn` 不给传。
- `action.type` 已知值含 `browse-step` / `tool-call` / `organize` → 浏览动作有词可用。
- `typeToolTurn(raw_text)` 只按载荷形状判工具轮（`name`+`arguments`+`callId` 的 JSON），
  其余一律 `dialogue`；它不会、也不该去猜「这句话是感想还是对话」。

## 3. 目标场景的字段级样例

她在某个下午自己打开 B 站看了一支科普视频，看完写下感想。应落成**两条**经历：

```jsonc
// ① 感知：她看到了什么（客观、可核对）
{
  "kind": "perception",
  "scene": { "channel": "browser", "ref": "browse-2026-11-10-a" },
  "initiation": "her",                 // 她自己发起的浏览
  "observation": { "cue": "B 站视频《xxx》，时长 12:34，播放至结尾" },
  "action": { "type": "browse-step" },
  "outcome": { "status": "success" },
  "occurred_at": "2026-11-10T14:20:00.000Z"
}

// ② 反思：她想到了什么（主观、是她的产物，非系统观测）
{
  "kind": "reflection",
  "scene": { "channel": "browser", "ref": "browse-2026-11-10-a" },
  "initiation": "her",
  "observation": { "text": { "id": "reflect-...", "channel": "browser", "shard": 0, "seq": 1 } },
  "action": { "type": "organize" },
  "occurred_at": "2026-11-10T14:26:00.000Z"
}
```

**自述与客观记录的界线**：同为 `initiation='her'`，靠 `kind` 分开 —— `perception`
是「她感知到的世界」，`reflection` 是「她自己产出的想法」。系统对她的观测走
`speaker='system'` / `'tool'`（→ `system` / `environment`），三种来源互不混淆。

## 4. 三条路径的试推结论

**路径一：只用现有 `ingestRawTurn`（不改代码）**
能落盘、能被切分、能出摘要，但 `kind` 恒为 `dialogue`，`action` 恒由载荷形状推断。
结果是事件层里她的浏览和聊天混成一类，后续按 kind 分类的读口全部失真。**不采纳**。

**路径二：先 `ingestRawTurn` 写原文，再 `appendExperience` 写 reflection**
会造出两条经历指向同一段原文，`eventIndex` 的 `(channel,event_id)` 幂等键也会撞车
（索引里存的 id 与 reflection 的 id 不一致）。**不采纳**。

**路径三：给 `ingestRawTurn` 加可选 `kind`（推荐）**
契约加一个**可选**字段，缺省 `'dialogue'`，行为与现在完全一致；传入时只影响
`kind` 取值，其余（原文层、tick、char_count、指针、投影）全不变。加可选字段不破
schema 只增不改的纪律，也不动 `PRIMITIVE_NAMES`。工作量：契约 + 校验 + 一条单测
+ 文档申明。**采纳**。

## 5. 路径三的最小改动清单（待批准后实施）

1. `src/contract/primitives.ts`：`IngestRawTurnInput` 加 `kind?: string`（缺省 `'dialogue'`）。
2. `src/api/index.ts`：`ingestRawTurn` 用它替代硬编码；`action`/`outcome` 的推断逻辑保持
   （`typeToolTurn` 只判工具轮，与 `kind` 互不覆盖）。
3. 校验：非字符串或空串按 `SchemaError` 拒绝，避免把空 kind 写进真源。
4. 单测（`tests/api/` 新增 3 条）：缺省仍为 `dialogue`；显式 `reflection` 正常落盘并被
   切分器当普通经历；非法 kind 抛错。
5. 重新 `registerChannel('browser', …)` 的实际注册由 C 块适配器负责，本稿只保证
   原语层面通道名可任意（现有实现已如此）。

## 6. 明确留到后续阶段

- **媒体资产层**（`ingestMedia` / `preserveMedia`）：她看到的封面、截图要存原图才谈得上
  「真的看过」。属阶段 3+，本稿不碰。
- **主动性调度**：谁在什么时刻唤醒她去逛、逛多久、逛完要不要写感想 —— C 块设计。
- **多通道适配器**（browser / qq / camera）：阶段 6，需按各平台的采集方式另做。

## 7. 需要你拍板的三点

1. **要不要现在就做路径三**（1 处契约字段 + 单测，约半小时）？还是等 C 块主动性设计
   一起定，避免过早定形？
2. `kind` 的取值要不要收紧到白名单（`dialogue/perception/action/reflection`）？
   现有契约是开放枚举，收紧会与「未知值原样保留」的纪律冲突，我倾向**不收紧**。
3. 她的浏览与感想是**两条经历**还是**一条带 action+outcome 的经历**（现在样例给的是两条）？
   两条更贴合「感知 ≠ 反思」，但会让事件层的指针数翻倍。

## 8. 决策记录

**2026-11-10：问题 1 暂缓，路径三不在本阶段实施。**

理由（用户拍板）：经历（`kind`）的种类很多，且包含**无法预先枚举的未知类型**，
在没想清楚类型体系之前，不宜仓促加字段把形态定死。本稿仅作为后续 C 块主动性
设计的输入保留，三个问题整体推迟到那时一并讨论。

随之挂起的相关决定：问题 2（白名单 vs 开放枚举）、问题 3（感知/反思拆条 vs 合并）
均不在现阶段定案。当前代码**不做任何改动**，`ingestRawTurn` 维持 `kind='dialogue'` 现状。
