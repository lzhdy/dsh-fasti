# 旧项目行为契约清单（供新仓库参考）

> **性质**：知识资产，不含实现。旧仓库 `dsh-persona-innate` 0.5.7（commit `4fed4a5`）退役后，本清单迁入新仓库 `docs/reference/`，作为新实现的验收参照。
>
> **纪律**：**只搬知识，不搬代码。** 左栏（保留）是可复用的行为结论；右栏（必弃）是不可复制的旧假设与已确认缺陷。
>
> 依据：`docs/a-block-final-design.md` §18.3。

---

## 一、保留：已验证的行为契约

### 1.1 原文捕获（新架构的真源层，全部保留）

| 行为 | 位置 | 说明 |
|---|---|---|
| 单一事件入口 `ctx.on('session/event')` | `index.ts` | 只有一处挂载，不分散监听 |
| `event_id` 取值规则 | `raw-turn.ts:141-149` | user 取 `data.id`；assistant 取 `data.message.id`；无则兜底 `rt-${makeId()}` |
| `session_id` 取值 | `raw-turn.ts` | `session.id`，缺失时为空串（不报错、不丢事件） |
| `asserted_at` | `raw-turn.ts` | 取 `event.time` 毫秒转 ISO；无则该字段留空，不伪造当前时间 |
| `ingested_at` | `raw-turn.ts` | 落盘时刻，系统维护 |
| `content_hash` | `raw-turn.ts` | `sha256(raw_text)`，供去重与完整性校验 |
| 分片与清单 | `raw-turn-log.ts` | 按 `YYYY-MM` 月度分片 + `manifest.json`；append-only |
| **append 无去重** | `raw-turn-log.ts` | 这是**有意设计**：原文层必须全量，去重责任在调用方；新架构同样如此 |
| 读失败抛出、不用空串覆盖 | `store.ts` | `appendText` 读失败必须抛，绝不用空内容覆盖既有数据 |

### 1.2 文本提取与块处理

| 行为 | 位置 | 说明 |
|---|---|---|
| assistant 文本提取语义 | `raw-turn.ts:74` | 从 `data.message.content`（回退 `data.content`）提取；此处曾是 P0 bug 修复点，语义不可随意简化 |
| 工具事件旁路 | `index.ts` | `observeToolEvent` 独立于对话路径，不混入用户/助手文本 |
| 指令性内容剥离 | `directive-strip.ts` | 剥离指令式措辞后再入记忆；新架构仍需（作用于派生，不作用于原文） |
| 斜杠命令不记为经历 | `extract.ts:142,219,419` | 以 `/` 开头为用户命令，不是她经历的内容 |

### 1.3 幂等与去重

| 行为 | 位置 | 说明 |
|---|---|---|
| 10 分钟去重窗口 | `index.ts:1072` | `dedupWindowMs = 10 * 60 * 1000` |
| 去重缓存上限 64 条 | `index.ts:1095-1097` | 超限时按窗口淘汰，防无界增长 |
| 去重键 | `index.ts:1203` | 基于事件标识而非文本，避免同文不同事件被误合并 |

### 1.4 时间

| 行为 | 位置 | 说明 |
|---|---|---|
| 本地日期口径 | `time.ts` / `review-cursor.ts:259` | `localDateString(startedAt)`，以本地日期为"会话日"边界 |
| 星期词覆盖 | `time.ts` | 曾因漏星期词导致解析失败（P2 修复），新实现必须覆盖星期表述 |
| 毫秒口径统一 | 投影层约定 | 与 BLA `d` 校准一致（4.22） |

### 1.5 数据目录与路径

| 行为 | 位置 | 说明 |
|---|---|---|
| 固定解析顺序 | `paths.ts:90` | 显式配置 > `$DSH_HOME` > `~/.dsh`；**不依赖进程 cwd**（P1 踩坑结论） |
| 数据目录与代码分离 | `paths.ts` | 代码仓库与数据目录物理独立，重写代码不影响她的数据 |

### 1.6 LLM 调用

| 行为 | 位置 | 说明 |
|---|---|---|
| 单次超时 90s | `index.ts:292` | `AbortSignal.timeout(90_000)`，仅覆盖单次调用 |
| `prepareCall` + `stream` 优先 | `index.ts:287-301` | 适配器优先走流式，失败回退 |
| 降级模式标记 | `review.ts` / `eval.ts` | LLM 不可用时明确标注降级，不静默产出 |

---

## 二、必弃：旧假设与已确认缺陷（新实现不得复制）

### 2.1 撞红线的旧假设

| 旧做法 | 为什么弃 |
|---|---|
| 一轮对话 = 一个 `PersonaEvent` | 把"聊天"写成前提（红线①）；应为经历条目 + 情景投影 |
| `imported: true` 且 4 处 `filter(e => !e.imported)` 排除在成长外 | 老数据被排除在她的成长之外 |
| `session_id` 参与身份与切片 | 会话降为 `scene.ref`（P10） |
| 固定 7 字段自我模型 + `version` 历史上限 10 | 撑不住可演化的强度结构（P6/H10） |
| 五槽各至多一条、700 字符预算、5 件事 | 事件化后需重标定（§7.1 / 4.18） |
| 章节式：`events/YYYY-MM.jsonl` 单一真源 | 缺原文层与结构层分离，派生不可重建 |

### 2.2 撞红线②的旧做法（规则层替她判断）

| 旧做法 | 位置 | 为什么弃 |
|---|---|---|
| 三档词表 AND 判定（事件词+时间/第一人称=0.8 等） | `extract.ts` | 用词表替她决定"该不该记" |
| `importance` 写死 0.6/0.7/0.8 | `extract.ts` | 重要性成为一等公民 |
| 少于 8 字直接跳过 | `extract.ts:143` | "我有点难过"被误伤；短句同样可能是重要经历 |
| `extractStyleFeedback` 独立识别器（8 条正则） | `extract.ts:194` | 与筛选员同病：死板、必遗漏；应统一走规则层标记 + 她识别 |
| `extractCandidate` 前置词表筛选 | `import-chat.ts:210` | 导入先被旧词表筛一遍，丢失原文 |

### 2.3 已确认的机制缺陷

| 缺陷 | 位置 | 为什么弃 |
|---|---|---|
| 截断后游标直接跳到现在 | `review-cursor.ts` / `selectReviewWindowDetailed` | `REVIEW_WINDOW_MAX=200` 截断后，被截断的最早事件**永久漏复盘** |
| 复盘输入只有一行 topic+summary，无原文可回读 | `review.ts:197/240/269` | 全文件无 `rawTurnLog` 引用；她只能在"别人端上来的菜里挑" |
| `lastRetrieved` 只写不读 | `memory.ts:279` | 检索痕迹未闭环 |
| 无 `status` 过滤（G3 缺口） | `recall.ts` / `memory.ts` | 只有 `traceableInferred`，事件层无状态位 |
| 图片/文件块被跳过、不捕获 `image/offload` | `index.ts` | 图片经历完全丢失（`grep` 无任何 `image/offload` 处理） |
| `ctx.setInterval` 在注释中被误写 | `index.ts:948` | cordis 无此能力，必须自管理 `setTimeout` + `ctx.effect` |
| `THREAD_EXPIRY_DAYS=30` 对 open 池兜底过期 | `memory-facts.ts` | open 池是"对用户的承诺"轨，30 天静默过期未告知她 |

### 2.4 扩展面缺陷（新架构必须避开）

| 缺陷 | 表现 |
|---|---|
| 载体类型靠封闭枚举 | 新增媒介需改校验逻辑 |
| 无通道概念 | 新来源无法进入，只能挤进"对话" |
| 真源无 schema 版本演进机制 | 就地改字段/`ALTER` 式演进 |
| 无投影层 | 查询只能线性扫描全量 JSONL |

---

## 三、349 用例覆盖的边界清单（不含实现）

新仓库应至少覆盖以下边界，取值可在旧测试中回查：

1. 空消息、纯空白、超长消息
2. 斜杠命令（`/` 开头）
3. 极短消息（1–7 字）
4. 纯 emoji / 纯标点
5. 附件消息（图片/文件块，含 `image/offload` 缺失）
6. assistant 消息的 content 形态差异（`data.message.content` vs `data.content`）
7. 缺失 `event.time`、缺失 `session.id`、缺失消息 id
8. 跨零点 / 跨月分片
9. 星期词、相对时间表述（昨天/上周/下周）
10. 重复事件（10 分钟窗口内/外）
11. 并发写入同一分片
12. 读失败与损坏文件（必须抛出，不静默）
13. LLM 超时、返回非法 JSON、返回空
14. 降级模式（LLM 不可用）下的产出标记

---

## 四、使用方式

1. 新仓库 `docs/reference/` 内保留本清单，作为实现验收尺子；
2. 需要查某个边界旧代码怎么处理时，回旧仓库对应行号（**只读**），不复制；
3. 若新实现决定偏离本清单"保留"栏，必须在 `docs/` 记录理由与影响——偏离是有意的，不是遗漏。
