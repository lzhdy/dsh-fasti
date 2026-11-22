# #158 前端对接任务书：FasTI 本机观测台 Web 界面

> 交付对象：承接前端开发的外部 AI / 前端工程师。
> 后端（本机 HTTP 观测 API 与静态托管）已冻结并通过全量测试，你只交付 `src/adapters/node/web/` 目录下的原生静态资产，**不允许修改任何后端文件**。
> 本文内所有 JSON 均取自后端真机响应（仅替换了 id/时间无关的示例值），字段名与嵌套结构即契约，请逐字对齐，不要自行改名或补层。

---

## 1. 这是什么产品

FasTI 是一个**本机优先、本地单用户**的 AI 记忆内核：node 后台进程只绑定 `127.0.0.1`，用户在本机浏览器打开同源页面，观察内核的写入链与读出链如何运转。它不是云服务、没有多用户、没有跨域调用。

你要做的是这个内核的**只读观测控制台**（含一个首屏启动仪式），满足甲方四条硬需求：

1. **首次启动加载动画/仪式感**；
2. **写入链与读出链全流程实时可见**（事件驱动，不是手动刷新）；
3. **五类数据详情可下钻**：真源原文（raw turns）、经历（experiences）、事件（events，含摘要与历史版本）、记忆卡片（cards）、投影（projection）；
4. **界面合理美观**（深色工程控制台风格，信息密度高但不拥挤）。

没有表单提交、没有编辑、没有删除——整个前端**只读**。

---

## 2. 硬约束（违反任一条直接验收不通过）

### 2.1 技术形态：零构建、零依赖、零外链

- 纯 **原生 ESM JavaScript**（`<script type="module">`）+ HTML + CSS。
- **禁止**任何框架（React/Vue/Svelte 等）、任何打包器（vite/webpack/rollup 等）、任何 `package.json`、`node_modules`、转译产物、`.ts` 文件。
- **禁止任何外链资源**：不得引用 CDN、外网字体、外网图片、分析脚本、polyfill 服务。所有资源同源自托管。
- 后端以**强 CSP** 托管 `/app/*`，并按资产类型给两套响应头：
  - **入口 HTML 文档**（`/app/index.html` 等 `.html`）：`script-src` 在 `'self'` 之外额外放行一个**每响应随机生成的 nonce**，后端据此注入唯一一个带该 nonce 的内联引导脚本（承载一次性 token，见 3.2）：

    ```
    Content-Security-Policy: default-src 'none'; script-src 'self' 'nonce-<每次响应随机>'; style-src 'self';
      img-src 'self' data:; font-src 'self'; connect-src 'self';
      base-uri 'none'; frame-ancestors 'none'
    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
    ```

  - **其余静态资产**（`.js/.mjs/.css/.svg/.png/.ico/.woff2/.json`）：维持严格 CSP，`script-src 'self'` **不带 nonce**，响应体字节原样返回、不会被注入任何内容。

  由此必然要求：
  - 全仓唯一允许的内联 `<script>` 是**后端注入的那段引导脚本**；你自己的代码仍不得写任何内联 `<script>`、内联 `<style>`、内联事件属性（`onclick="..."`），全部走独立文件 + `addEventListener`，也不要在 HTML 里手写或硬编码 nonce（nonce 由后端每响应现场生成、每次不同）；
  - JS 只能 `fetch` 同源地址（`connect-src 'self'`）；
  - 图片只允许同源或 `data:` URI；图标建议内联 SVG（作为独立 `.svg` 文件或 JS 里的 data URI）；
  - 不要用自定义在线字体，用系统字体栈（占位页已示范 `system-ui, -apple-system, "Segoe UI", sans-serif`）。

### 2.2 文件清单与放置路径

全部文件放进后端仓库的 `src/adapters/node/web/`，后端按白名单后缀托管。当前该目录已有三个**占位文件**（`index.html` / `styles.css` / `app.js`），由你整体替换或扩充。允许的后缀白名单**以后端代码为准、仅以下九种**：`.html` `.js` `.mjs` `.css` `.json` `.svg` `.png` `.ico` `.woff2`，其余后缀（含 `.jpg/.jpeg/.webp/.gif/.ttf/.woff` 等）请求一律 404。因此：图标优先用同源 `.svg` 或 data URI；不要交付 jpg/webp 位图与 ttf/woff 字体，字体直接用系统字体栈（见 2.1）。建议结构（可调整文件名，但入口必须是 `/app/index.html`、模块入口由它显式引用）：

```
src/adapters/node/web/
├── index.html          # 唯一页面入口（SPA 单页，纯客户端渲染）
├── styles.css          # 全部样式
├── app.js              # ESM 入口：引导、路由、轮询编排
└── js/                 # 按域拆分的模块（api 客户端、脉冲、各视图渲染等）
```

### 2.3 兼容范围

只需兼容 **Chromium 内核桌面浏览器**（Chrome / Edge 当前主流版本）。可放心使用：原生 ESM、`fetch`、`AbortController`、CSS Grid/Flex、CSS 变量、`Intl` 时间格式化。不需要兼容 Safari/Firefox/IE，不需要响应式适配手机，但桌面窗口在 1280px–2560px 宽度下不得破版。

---

## 3. 鉴权与引导（重要）

### 3.1 鉴权纪律（已冻结）

- **数据面要 Bearer、静态面不要**：所有 `/api/*` 业务请求与写路由（`/chat`、`/channels/:id/turns`、`/experiences`）都必须带请求头 `Authorization: Bearer <token>`，缺失返回 `401`；但 `/app/*` 静态资产（HTML/JS/CSS 等，仅 GET）**免凭证即可直接打开**——静态前端代码不含任何秘密，匿名可读不构成数据泄漏。`GET /`（旧内联页）与 `GET /health` 同样免 token。
- 服务端还校验 `Host` 白名单（`localhost` / `127.0.0.1` / `[::1]` / `::1`），伪 Host 返回 `403`。你全程用同源相对路径请求即可，不要写死主机名。
- token 是每次进程启动随机生成的一次性密钥，**进程重启即失效、不落盘**。
- 浏览器无法给"打开 HTML 文档"以及 `<script src>`/`<link href>` 标签请求自定义 `Authorization` 头；该问题已由后端批 B 解决：入口 HTML 免凭证直开，后端在其响应体中内联注入一次性 token（见 3.2），随后的数据请求仍由你的代码凭该 token 附 Bearer。

### 3.2 你的代码如何消费 token

统一从一个引导对象读取，不要自己发明存储方案：

```js
// 后端已在 index.html 响应中注入（批 B 已交付；带当次随机 nonce 的合法内联引导，是全仓唯一的内联脚本例外）：
window.__FASTI_BOOTSTRAP__ = {
  token: "<一次性 Bearer token>",
  bootId: "<12 字符 hex，本次启动实例 id>",
  channel: "<默认通道 id>",
};
```

- 封装唯一的 `apiFetch(path)`：内部附加 `Authorization` 头、解析 JSON、集中处理 401（回到"连接失效"提示态）/503（记忆索引未就绪态）/其他错误。
- 所有调用走同源相对路径，如 `apiFetch('/api/status')`。

### 3.3 本地开发与同源联调

- **本地夹具驱动（推荐的离线开发方式）**：UI 开发优先用本文第 5 节的真机 JSON 样例做本地 mock（可把样例存为你自己模块内的 mock，**不要**放进会被托管的 `.json` 静态文件依赖流程），不依赖真实后端即可推进视图。
- **零配置同源联调（批 B 已交付，即当前现实）**：直接在浏览器打开 `/app/`（或 `/app/index.html`），后端已在入口 HTML 内联注入 `window.__FASTI_BOOTSTRAP__`，读取后即可同源联调，**无需手工复制 token、无需浏览器插件或任何调试注入**。若引导对象缺失（例如经非托管路径错误打开），你的代码必须显示明确的"引导未注入"错误态，而不是白屏。

---

## 4. 实时通道：长轮询脉冲（不是 SSE/WebSocket）

实时性通过轮询 `GET /api/pulse?after=<seq>` 实现。**为什么不用 SSE**：`EventSource` 不能携带 `Authorization` 请求头，会破坏 Bearer 鉴权纪律。请严格按下面的模型实现。

### 4.1 协议

- 请求带 token，`after` 为客户端已收到的最大 `seq`（首次启动传 `0`）。
- 服务端行为：
  - 若已有 `seq > after` 的缓冲事件，**立即返回**；
  - 否则挂起最长 **5 秒**，期间有新事件立即返回；5 秒无事件返回空活动列表（正常现象，不是错误）。
- 响应无论是否挂起都附带完整快照，形状：

  ```json
  {
    "ok": true,
    "seq": 0,
    "activities": [],
    "snapshot": { "...": "与 /api/status 主体同构的运行时快照" },
    "memory": null
  }
  ```

- 客户端编排要求：
  1. 收到响应后，用响应里的 `seq` 作为下一次请求的 `after`，**立即发起下一轮**长轮询（长连接常驻，不要做固定间隔定时器）；
  2. 用 `AbortController` 管理在途请求；网络错误/断连时按退避重试（如 300ms → 1s → 3s 封顶），恢复后自动续上；
  3. 进程重启后旧 `seq` 作废：以 `/api/status` 拿到的 `bootId` 为准，保存当前会话的 `bootId`，一旦发现 `bootId` 变化（或响应 `seq` 回退/错乱），重置游标为 `0` 并重新全量拉取各列表；
  4. 活动缓冲在服务端是**有界环形缓冲（容量 500）且只存在于进程内存**：服务重启后脉冲历史清空，历史数据要靠各分页端点重新拉，不要假设脉冲能补全历史；
  5. 空轮询（`activities: []`）不得在 UI 上产生噪音条目，仅用于维持连接与刷新快照区。

### 4.2 活动事件枚举（封闭集合，七种 kind）

每个活动对象形状：`{ seq, at, kind, level, message, data? }`。`at` 为毫秒时间戳；`message` 是已拼好的中文人类描述，可直接展示；`level` 四档 `info | ok | warn | error`，用于配色/图标。`kind` 只会是下列七种，建议前端做穷举映射并对未知 kind 保留兜底渲染：

| kind | 含义（链路位置） | level | `data` 字段 |
| --- | --- | --- | --- |
| `ingest.turn` | 写入链：一拍摄入完成（原文→经历→投影流水线尾部） | `ok` | `{ channel, tick, experienceId, shard, seq }`（**无正文**，正文走详情端点） |
| `closure.drain` | 写入链：闭合节拍闭合了安静事件 | `ok` | `{ closed: number }`，空轮不发射 |
| `summary.drain` | 写入链：摘要节拍处理了事件 | `ok` | `{ summaries: number }`，空轮不发射 |
| `memory.drain` | 写入链：记忆投影把真源折叠进卡片索引 | `ok` | `{ cardUpserts?, invalidations?, quarantined?, emptyAnchored? }`，仅非零键出现，无实质变更不发射 |
| `tool.call` | 读出链：模型一次工具调用结束 | `ok`/`warn` | `{ tool: string, ok: boolean, callId: string }`（只含元数据，不含检索词与正文） |
| `loop.error` | 后台节拍失败（已隔离，不阻断服务） | `error` | `{ phase: string, message: string }` |
| `chat.turn` | 枚举已保留，**第一刀后端不发射**，前端预留样式即可 | — | — |

### 4.3 实时视图要求

- 顶部或侧栏提供一条**活动流时间线**：新事件到达时插入并做短暂高亮/过渡动画，自动滚顶但用户正在翻看历史时不要抢滚动条；环形展示最近若干条（如 200），更早的不强行保留。
- 提供**写入链/读出链的链路示意**：把 `ingest.turn → closure.drain → summary.drain → memory.drain` 串成写入链流水线，把 `tool.call` 归入读出链；哪个环节最近有活动，就在示意图上点亮对应节点并附上最近一次时间与计数。这是需求②"全流程实时可见"的核心交付，不要只丢一个原始日志列表。
- 每次 pulse 响应里的 `snapshot` 可静默更新顶部状态区（引擎档位、检查点尾差、各计数），`memory` 为 `null` 时记忆卡片区显示 503 态（见 5.7）。

---

## 5. HTTP 端点契约（全部 GET、同源、Bearer）

通用约定：

- 所有业务响应为 JSON，成功响应顶层都有 `"ok": true`；错误响应为 `{ "error": { "code": string, "message": string } }`，**不**含 `ok`。
- 分页参数 `limit`（1–100，默认 50）、`offset`（非负整数，上限 10000）；越界/非整数返回 `400 bad-request`。
- 列表是否回显 `total/limit/offset` 各端点不一，**以各样例为准**，不要假设统一信封。
- 所有时间字段：活动 `at` 与卡片 `*Ms` 是**毫秒 epoch 数字**；真源/经历/事件里的 ISO 字符串是 **UTC ISO-8601**，展示时转为本地时区。

### 5.1 `GET /health`（免 token）

存活探针，返回 200。可用于启动动画阶段探测后台是否已起来（轮询它直到 200，再进入引导）。

### 5.2 `GET /api/status` —— 启动检查项与全局状态总览（需求①的真实数据源）

真机响应：

```json
{
  "ok": true,
  "bootId": "1f7fadbe98f2",
  "startedAt": 1795322575170,
  "channel": "brief",
  "engine": { "level": "L1", "degraded": false, "reason": "" },
  "eventLayer": { "available": true, "reason": "" },
  "checkpoint": {
    "version": 1, "tick": 2, "engine": "L1", "degraded": false,
    "degraded_reason": "", "needs_rebuild": false,
    "last_projected_tick": 2, "pending_events": 0
  },
  "reconciliation": { "sourceMaxTick": 2, "lastProjectedTick": 2, "folded": 0 },
  "pendingSummaryCount": 0,
  "channels": [
    { "id": "brief", "registered": true, "experiences": 3, "rawTurns": 3,
      "ok": true, "notes": "已注册：经历 3 条、原文 3 行" }
  ],
  "counts": {
    "experiences": 3,
    "rawTurns": [ { "channel": "brief", "count": 3 } ],
    "events": { "total": 1, "open": 1, "closed": 0, "merged": 0, "split": 0, "archived": 0 }
  },
  "memory": null
}
```

要点：
- `engine.level` 取值 `L1 | L2 | L3`，`degraded=true` 时必须有降级视觉态并展示 `reason`；
- `reconciliation` 是启动对账快照，`folded`/尾差（`sourceMaxTick - lastProjectedTick`）是"投影是否落后真源"的直观指标；
- `memory` 为 `null` 表示记忆索引未就绪，记忆卡片入口置灰并解释，不要假装空数据。

### 5.3 `GET /api/raw?limit&offset&channel` —— 真源原文（第一类下钻）

`channel` 可选，缺省用默认通道。响应：

```json
{
  "ok": true,
  "channel": "brief",
  "total": 3,
  "turns": [
    {
      "shard": "2026-11",
      "seq": 0,
      "turn": {
        "event_id": "evt-brief-0",
        "session_id": "",
        "turn_id": "",
        "speaker": "user",
        "raw_text": "任务书采样第 1 句：记得我偏好深色界面。",
        "asserted_at": "",
        "ingested_at": "2026-11-22T04:42:49.389Z",
        "content_hash": "4f201d8f3ba3604d2037ca7c7075cb749651f5e4028d49f48c528875d47c77"
      }
    }
  ]
}
```

列表行展示 `speaker`、`raw_text`（长文本截断+展开）、`ingested_at`、定位坐标 `shard/seq`；详情下钻展示全部 8 个字段（含哈希，等宽字体）。

### 5.4 `GET /api/experiences?limit&offset&channel` 与 `GET /api/experiences/:id` —— 经历（第二类下钻）

列表响应：

```json
{
  "ok": true,
  "total": 3,
  "limit": 2,
  "offset": 0,
  "experiences": [
    {
      "id": "01M80S0RNF39RZEJ8ZQP8PX98D",
      "schema_version": 1,
      "kind": "dialogue",
      "scene": { "channel": "brief", "ref": "" },
      "initiation": "user",
      "observation": { "text": { "id": "evt-brief-0", "channel": "brief", "shard": "2026-11", "seq": 0 } },
      "occurred_at": "2026-11-22T04:42:49.389Z",
      "recorded_at": "2026-11-22T04:42:49.389Z",
      "tick": 0,
      "char_count": 21
    }
  ]
}
```

详情响应为 `{ "ok": true, "experience": { ...同形单对象... } }`；未知 id 返回 `404 { error: { code: "not-found", message: "经历不存在" } }`。经历通过 `observation.text` 的 `shard/seq` 与真源原文对应，下钻详情里应能让用户顺着这个坐标跳转到对应 raw turn。

### 5.5 `GET /api/events?limit` 与 `GET /api/events/:id` —— 事件＋摘要＋版本（第三、四类下钻）

列表：

```json
{
  "ok": true,
  "total": 1,
  "events": [
    {
      "id": "01M80S0RNNV8QGGQVZYDAH0XW7",
      "schema_version": 1,
      "version": 3,
      "status": "open",
      "closed_reason": null,
      "pointers": [
        { "id": "01M80S0RNF39RZEJ8ZQP8PX98D", "channel": "brief", "shard": "2026-11", "seq": 0 }
      ],
      "time_range": { "started_at": "2026-11-22T04:42:49.389Z", "ended_at": "2026-11-22T04:42:49.406Z" },
      "assembled_at": "2026-11-22T04:42:49.397Z",
      "summary": null,
      "key_points": [],
      "anchors": [],
      "topic_lines": [],
      "summary_quality": "pending",
      "summary_source": null,
      "summary_prompt_version": null,
      "summary_model": null,
      "effective_chars": 63,
      "raw_chars": 63,
      "created_by": "system",
      "created_at": "2026-11-22T04:42:49.410Z",
      "channel": "brief",
      "boundary_candidates": [],
      "marks": { "hasMedia": false, "crossChannel": false, "pendingMerge": false,
                 "orphan": false, "summaryStale": false }
    }
  ]
}
```

- `status` 枚举：`open | closed | merged | split | archived`，用不同色彩标签区分。
- **摘要不是独立端点**：`summary`（摘要正文）、`key_points`（要点）、`topic_lines`、`summary_quality`（`pending` 表示尚未摘要，配合 `summary.drain` 活动观察它如何从 pending 变就绪）、`summary_model`/`summary_source` 等都挂在事件对象上，事件详情即摘要下钻位。
- 详情端点响应为 `{ "ok": true, "event": { ... }, "versions": [ ... ] }`：`versions` 是该事件的全部历史版本数组（同构字段、按版本排列），用于展示事件如何被反复闭合/改写，**必须提供版本对比或至少版本时间线视图**。
- `pointers` 是事件到经历的权威锚点列表，详情页要能顺坐标下钻到经历。

### 5.6 `GET /api/cards?limit&offset` 与 `GET /api/cards/:id` —— 记忆卡片（第五类下钻）

列表响应信封**只有** `{ "ok": true, "cards": [ ... ] }`（注意：不回显 total/limit，分页控件靠你自行根据返回是否满页判断"可能还有下一页"）。单卡字段（`/api/cards/:id` 返回 `{ "ok": true, "card": { ... } }`）：

```json
{
  "cardId": "mc_obs_1",
  "eventId": "evt-mc-1",
  "anchorIds": ["01ANCHOR0001"],
  "channel": "brief",
  "cardType": "event",
  "selection": "selected",
  "weight": 0.5,
  "displayCues": ["线索"],
  "aliases": [
    { "termNorm": "深色界面", "source": "miss", "sensitive": false,
      "status": "active", "hitCount": 0 }
  ],
  "discriminator": "消歧",
  "occurredMs": 1700000000000,
  "endedMs": 1700000100000,
  "validMs": 1700000000000,
  "invalidMs": null,
  "createdMs": 1700000000000,
  "expiredMs": null,
  "status": "active",
  "contentHash": "hash",
  "hitCount": 0,
  "lastHitMs": null,
  "schemaVersion": 1
}
```

字段域事实（不要臆造取值）：
- `cardType` 当前封闭枚举只有 `"event"` 一种，预留未来扩展，未知值兜底展示；
- `selection` 为 `"selected" | "excluded"`；卡 `status` 为 `"active" | "invalid" | "superseded"`；别名 `status` 为 `"active" | "tombstoned"`；
- **隐私红线**：敏感别名（`sensitive: true`）的 `termNorm` 后端**恒为 `null`**，前端原样显示"（敏感词已隐藏）"，绝不要尝试补全或用其他字段拼出原文；
- `aliases[].source` 当前只有 `"miss"`；
- 详情页要展示别名列表（含命中次数、墓碑态）、有效期（`validMs/invalidMs/expiredMs`）、命中统计（`hitCount/lastHitMs`）、锚点 `anchorIds`。

### 5.7 记忆索引未就绪：503

当后端记忆索引未建好时，所有 `/api/cards*` 返回：

```json
{ "error": { "code": "memory-unavailable", "message": "记忆索引未就绪，卡片观测暂不可用" } }
```

HTTP 状态 `503`。卡片区整体显示独立空态（解释原因、禁用分页），**不能**用空列表冒充"没有卡片"。pulse 响应里的 `memory` 字段同理（就绪前为 `null`，就绪后为聚合计数对象，字段：`cards, activeCards, invalidCards, supersededCards, aliases, sensitiveAliases, misses`，均为数字）。

### 5.8 `GET /api/projection` —— 投影观测

```json
{
  "ok": true,
  "engine": { "level": "L1", "degraded": false, "reason": "" },
  "eventLayer": { "available": true, "reason": "" },
  "checkpoint": { "...": "同 /api/status.checkpoint" },
  "reconciliation": { "sourceMaxTick": 2, "lastProjectedTick": 2, "folded": 0 },
  "edges": []
}
```

`edges` 为投影边列表，后端硬顶返回最多 100 条；为空时展示空态。该视图用于回答"投影层当前把哪些真源节点折叠/关联起来了"，配合 `reconciliation` 尾差与 `memory.drain` 活动呈现投影健康度。`edges` 内对象结构以真机返回为准做通用键值表格化渲染即可（后端不保证第一刀有非空数据，不要写死字段）。

### 5.9 错误码与边界行为速查

| 场景 | 状态码 | `error.code` |
| --- | --- | --- |
| 缺/错 token | 401 | 鉴权错误 |
| 伪造 Host 头 | 403 | — |
| `/api/*` 使用 GET 以外方法 | 405 | （无 body 依赖，前端只发 GET 即可） |
| 分页参数非法 | 400 | `bad-request` |
| 经历/卡片 id 不存在 | 404 | `not-found` |
| 记忆索引未就绪访问 cards | 503 | `memory-unavailable` |
| `/app` 路径穿越、非白名单后缀、不存在文件 | 404 | 统一 404，不区分文件是否存在 |

---

## 6. 信息架构与四条需求的验收口径（DoD）

### 6.1 需求① 首次启动加载动画/仪式感

- 打开页面后进入启动序列：轮询 `/health` → 拉取 `/api/status` 校验引导与后端状态 → 预取首批列表，期间展示明确的分阶段加载动画（建议轻量 SVG/CSS 动画，禁止外链 Lottie/图床），每个阶段有可读文案与真实进度（不是纯假进度条）；后端就绪后一次性过渡到主控制台。
- 失败要有出口：后端持续不可达、引导缺失、401 失效分别给可理解的错误态与重试入口，禁止白屏与无限转圈。
- 加载仪式只在首次进入时播放，后续视图切换不重播。

### 6.2 需求② 写入链与读出链实时可见

- 常驻长轮询（第 4 节），活动流时间线 + 链路示意图双表达；
- 写入链四节点（摄入/闭合/摘要/记忆投影）与读出链节点（工具调用）均可被实时点亮，显示最近活动时间与累计计数；
- `loop.error` 要有醒目但不打扰的告警呈现；
- 后台节拍每 5 秒一轮，**空轮没有活动是正常的**，UI 不得伪造心跳条目。

### 6.3 需求③ 五类数据详情可下钻

五个域都要做到"列表 → 详情 → 关联跳转"：

1. **真源原文**：raw turns 列表/全文/哈希/分片坐标；
2. **经历**：experience 详情，并顺 `observation.text` 坐标跳原文；
3. **事件**：event 详情含状态、标记位（`marks`）、指针；
4. **摘要**：事件详情内的 summary/key_points/质量档/模型溯源，以及 `versions` 历史版本视图；
5. **记忆卡片**：card 详情含别名（敏感词隐藏态）、有效期、命中、锚点；
6. 另设**投影**视图展示 checkpoint/对账尾差/edges。

分页统一支持上一页/下一页与页码/偏移显示，参数硬顶遵守第 5 节。

### 6.4 需求④ 合理美观

- 深色工程控制台基调，单一强调色体系（不要高饱和彩虹色），状态色语义稳定（成功/告警/错误/中性全局一致）；
- 等宽字体用于 id/哈希/JSON，正文用无衬线；数字与时间右对齐/等宽表格排布；
- 布局建议：顶部状态栏（引擎档/检查点/计数/连接状态）+ 左侧导航（五个域+实时流）+ 主内容区（列表与详情抽屉/面板）；
- 所有交互元素有 hover/focus 态，长 id 提供一键复制；空态、加载态、错误态三态齐全；
- 不允许引入 UI 组件库，手写 CSS（可使用 CSS 变量组织主题）。

### 6.5 明确挂账（第一刀不要做）

- 人工 FTS 全文搜索框：后端第一刀未提供搜索端点，**不做**，不要自己用前端模糊检索冒充；
- `chat.turn` 活动发射：后端枚举已保留但仍不发射，前端只留样式兜底即可（bootstrap nonce 注入已由后端批 B 交付，见 3.2/3.3，不再是挂账）；
- 任何写操作/设置页/多通道管理：后端冻结项，不做。

---

## 7. 交付物与验收三关

### 7.1 交付形式

- 交付 `web/` 整目录的源文件（结构见 2.2），不含构建产物、`node_modules`、压缩包内隐藏系统文件；
- 交付说明里列出文件清单与每个 JS 模块职责、在主流 Chromium 下的自测清单（截图或步骤）；
- 交付渠道（粘贴/压缩包/分支）由甲方另行通知，文件放置路径固定为仓库 `src/adapters/node/web/`。

### 7.2 验收三关（后端负责人执行）

1. **后端零回归关**：放入资产后仓库 `npm run verify`（类型检查+全量 node:test 套件，当前 1612 条用例）保持全绿，架构守卫无告警；静态文件不参与 TS 编译但必须通过后端既有的静态安全门测试（双版本 CSP/后缀白名单/路径穿越/静态面免凭证与入口 nonce 注入契约）。
2. **真机链路关**：本地起服务后在 Chromium 实测：启动仪式走完；长轮询常驻且在后端产生摄入/节拍活动时界面实时点亮；五域列表→详情→关联跳转全部可用；503/401/404/断连重启各异常态表现正确；无任何外链请求（用 Network 面板核验，所有请求均为同源 `127.0.0.1`）。
3. **静态安全门**：View Source 核验你交付的源码自身无内联脚本/内联样式/事件处理器（入口 HTML 中后端注入的那段带当次 nonce 的 `window.__FASTI_BOOTSTRAP__` 引导脚本是唯一合法内联例外，由后端生成、非你编写，不计违规）；CSP 下无任何控制台违规告警；无外部字体/图片/分析请求；Network 面板零第三方域名请求；敏感别名处不出现原文。

### 7.3 自测最低清单（随交付物勾选回报）

- [ ] 断网 10 秒再恢复，长轮询自动续上且无重复/丢活动；
- [ ] 重启后端，前端能识别 `bootId` 变化并自动重置游标、重新拉取；
- [ ] 记忆索引未就绪时卡片区是 503 空态而非空列表；
- [ ] 未知 id、非法分页、缺 token 三类错误均有友好呈现；
- [ ] 1280px 与 2560px 窗宽下无横向滚动/破版；
- [ ] Network 面板零第三方域名请求；CSP 零违规；
- [ ] 所有渲染文本均来自接口字段或你自己的固定中文文案，无 `undefined`/`[object Object]` 泄漏到界面。

---

## 8. 附：后端现状一句话

后端为纯 ESM、TypeScript 唯一语言、零运行时第三方依赖的 node 进程；观测 API 全部为只读 GET，活动总线进程内有界缓冲、长轮询 5 秒挂起、断线自愈。你面对的是一个边界清晰的只读契约——**把冻结的 JSON 渲染好、把实时流编排稳、把五条数据下钻做全**，即完成本刀。

---

## 9. 验收签收（后端负责人，2026-11-22）

外部回交的 `src/adapters/node/web/`（24 文件）经本文件第 7 节三关验收**通过**，已入库 commit `c5e58b6`（origin/main，后端零改动）。

- **关 1 后端零回归**：放入资产后 `npm run verify` 1612/1612 全绿，架构守卫无告警，静态安全门（双版本 CSP/后缀白名单/路径穿越/静态免凭证/nonce 注入契约）测试通过。
- **关 2 真机链路**：独立临时数据根起服务，Chromium headless（146）实测启动四阶段走完进入控制台、长轮询常驻、六视图五域可切换渲染、cards 503/401/断连重启异常态表现正确；45 个请求全部同源 `127.0.0.1`、零第三方域名、无横向滚动。
- **关 3 静态安全门**：交付源码 View Source 零内联脚本/样式/事件（入口唯一内联为后端注入的 nonce 引导脚本，非前端编写）、CSP 零控制台违规、无外部字体/图片/分析请求、敏感别名 termNorm 为 null 时恒显示「（敏感词已隐藏）」不补全。

遗留（不阻断验收）：`app.js` 引导缺失异常路径的一处用户可见文案与注释仍含「阶段一/本地开发服务器临时注入」旧措辞，留待下次顺手订正；`dev/mock-server.mjs` 仅为联调夹具、不属交付物，未入库。
