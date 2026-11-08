# A 块（底层架构）· 最终设计（定案稿）

> **文档状态：A 块定案稿，已整合两份外部讨论稿**
>
> - 本稿整合：①《A-block-research-and-draft.md》（调研 + 假设 H1–H15 + 取舍 T1–T13 + 不变式 I1–I8）；②《a-block-architecture-draft-v0.3.md》（分层 + Experience schema + 通道注册表 + 冻结面/开放面）。
> - 本稿相对 v0.3 的**新增与修正**集中在：SQLite 降级路径（§7.4）、最小投影集（§7.1）、ID 映射（§4.5）、删除成功标准（§11）、运行循环（§8）、schema 演进机制（§10.4）、tick 语义澄清（§5）。
> - **最高纪律：本稿仍未产生任何代码改动。** 用户确认后才允许写代码。
> - 确认后并入 `memory-architecture-redesign.md` 的 A 块章节，解除 4.10 / 4.16 / 4.18 三条 🔴，关闭 X10 / X11 / X12；正式实施稳定后，实施细节归 `mechanism-design.md`，本文件不再独立维护。
> - 对应代码版本：0.5.7（commit `4fed4a5`）；最后更新：2026-11-08。

---

## 0. 一句话总览

**把"对话插件的地基"换成"存在日志的地基"：她的一生是一条不可变的经历流（真源 = 原文层 + 结构层）；记忆本、自我模型、事件摘要、一切索引都是可重建的投影；时间三轴（发生 / 落盘 / 节拍）；通道与形状是两条正交的轴、全部注册制开放；媒体存引用、她可保存本地副本；投影引擎可替换、真源永不换。**

### 0.1 红线自检（判定标准，不是建议）

依据 `memory-architecture-redesign.md` §0.6，A 块两条红线：

| 红线 | 本稿落法 |
|---|---|
| ① 数据结构不能把"聊天"写成前提 | kind 是开放枚举且只描述形状，`dialogue` 只是六种形状之一、`dsh` 只是一个通道；轮级条目只是机械基线，记忆单位是投影层情景（episode） |
| ② 不能预设"什么重要" | 真源层无 importance 字段；机械显著度、BLA、她的判断在投影层分账；对流的"留意"只是标记（4.2），保存与否永远由她决定；高带宽通道默认关闭 |

认知科学对齐：Tulving 情景记忆 = 事件内容（what/where/when）+ 自觉意识（autonoetic consciousness，在主观时间中觉察自己持续存在）。经历条目（内容）+ 时间三轴（主观时间）即其存储化。

---

## 1. 设计目标与边界

### 1.1 目标升级

用户已明确：不只做一个记忆很好的聊天插件，而是**做一个完整的她**——不依赖对话历史、交流只是她能做的事之一、有身体可接入权限、能做她想做的事。

### 1.2 A 管什么

| 项 | 说明 | 对应问题 |
|---|---|---|
| A1 原子与数据模型 | "经历"作为最小可记录单位；动作、结果、动机、后果、来源场景；一条经历可挂 0..n 个载体引用且不预设类型；强度/证据/状态的可演化结构 | P1、P2、P6、P11 |
| A2 时间模型 | 真实时钟、她的节拍、多轨节奏；时间字段语义与查询 | P4、P8 |
| A3 存储与索引 | 全量加载改增量读取；记录库与内容库分离；分片/manifest；多维查询支撑 | P3、P12 |
| A4 运行态与当下状态 | "此刻在关注什么、在做什么"的容器（内容归 C） | P7、X12 |
| A5 溯源与记录基座 | 来源、发起、原文指针、载体引用与完整性校验、动作/后果记录、失败轮次标记、引用失效诚实状态、删除闭包元数据 | P5、P11 |
| A6 载体引用与内容库 | 引用最小结构、内容固化位置规则、去重与多引用、失效语义、新来源/媒介登记机制 | S1–S4 |

### 1.3 A 不管什么（只留挂载点，不实现）

| 归属 | 内容 | A 留的接口 |
|---|---|---|
| B | 切分规则、留意标记、重要性判断、复盘/做梦产出、facts/self-model 内容字段、跨通道实体统一 | marks 位、episode/status/confidence 投影列、反思经历通道 |
| C | 动机、节拍策略、当下状态内容、她的日历定义 | tick、action 经历落点、运行态容器 |
| D | 权限分级、审批流、审计细则、工具外壳、适配器权限面、高带宽授权流程 | action/outcome/error 字段、preserveMedia/getMedia 原语、采集策略声明、全程留痕 |
| E | 同一性判据、迁移流程细节、多设备同步 | ULID 稳定 id、相对路径、sha256、注册表随数据迁移、真源三目录整体可搬 |

---

## 2. 核心判断：从"对话插件"到"存在日志"

### 2.1 直接同类判断

**不存在五条同时满足的直接同类**（判据：① 不依赖对话历史连续存在；② 无角色卡、起点空白；③ 记什么由她判断；④ 原文可精确回读、可干净删除；⑤ 有身体、行动与后果归她）。

放宽到"长期记忆 + 自成长人格 + 主动行为"三件套，同类存在（OpenClaw、Mercury、Alicization、相续人格、Nuwa 等），但它们的人格几乎都来自可编辑人格文件（SOUL.md / 人物卡 / Genesis 初值），"什么值得记"由抽取器或容量规则决定——分别撞上本项目 1.3.1、1.6.3、1.3.2、1.3.4。

### 2.2 最接近对象的两面性（源码核验结论）

| 对象 | 可借鉴 | 不可复用 |
|---|---|---|
| 相续人格 `dsh-Xiangxu-Persona` | **资产层**：文本/字节分离、SHA 清单、源依赖删除、独立来源保留、清理失败如实上报；诚实失败面、程序不做重要度判定 | **记忆层**：把多媒体压成文本，类型/字段/文档名封闭枚举（`validateChat`/`validateDeepMemory` 全字符串；`documentKey` 正则白名单；"未知媒体字段"拒收） |
| Project Alicization | 透明失败面（失败轮次不进记忆与人格）、tombstone/来源撤销、自建 gold 评测、动作/后果审计 | `SOUL.md` 人设注入（与 1.3.1 冲突）；`conversation_turns + card_id + salience` 是地基；靠累积 `ALTER TABLE` 演进 |

**结论：可借鉴机制，不可复用数据模型。**

### 2.3 关键假设（显式、可证伪）

| # | 假设 | 若被推翻 |
|---|---|---|
| H1 | 她的存在连续，会话只是观测/交互绑定，不是存储单位 | T4 与 A1/A3 的会话无关性作废 |
| H2 | "经历"是最小单位，不等于一轮对话，也不等于一段摘要；可含动作、结果、动机、后果、来源场景 | 整个 A1 与 B 的 4.18 重做依据作废 |
| H3 | 原文不可变、全量、可精确回读；一切派生可从原文重建 | T2/T5/T8 全部作废，4.25 干净删除无法实现 |
| H4 | 数据结构中不存在"系统判定的重要性"一等公民；强度/显著度只能由她在复盘产出并带证据 | 违反红线②，方案淘汰 |
| H5 | 真实时钟与她的节拍分离，节拍多轨（对话/浏览/行动/复盘/做梦各有节奏） | T3、T10 作废 |
| H6 | 任何动作（含失败、拒绝、中断、未知）都有可追溯记录；失败轮次不进入记忆与人格学习 | A5 与 1.3.4 底层保障作废 |
| H7 | 长期运行量级是几年 × 每天几十条，全量 load 不可行，必须增量读取与索引 | A3 作废 |
| H8 | 记录层只存引用、不存像素字节；字节若被她决定留存，落在独立内容库 | 违反 7.3 即淘汰 |
| H9 | 删除必须传播到所有派生闭包，不得出现假删除；删除后不得被回滚/重建复活 | 4.25 执行通道失效 |
| H10 | 自我模型结构必须可演化（倾向带 0–1 强度、证据、状态），固定 7 字段撑不住 | A1 强度结构作废，4.16 无法实施 |
| H11 | 权限档位与同一性判据不由 A 拍板，但 A 不能把它们写死到无法接入 | A 越界，回退到只留挂载点 |
| H12 | 经历来源不可枚举，A 不得为具体来源留专用字段或分表 | T4/T11/T12 作废 |
| H13 | 媒介类型不可枚举，A 不得用封闭枚举表达载体，不得让校验器拒收未知类型 | T1/T11 作废 |
| H14 | 引用是她可持有的一等能力；引用与内容分离，A 不解释内容，解码/转写/理解在 A 之外且标注为派生 | H8、T2/T5/T11 作废 |
| H15 | 引用会失效；失效是必须如实记录的状态，不得反噬经历本身；删除失败不得冒称成功 | A5 与 4.25 诚实保障作废 |

---

## 3. 分层总览

```
┌ 真源层（append-only，不可变；她的"一生"，唯一不可再生资产）
│   raw-turns/YYYY-MM.jsonl      原文层·DSH 对话（现有格式不动，兼容存量）
│   raw/<channel>/YYYY-MM.jsonl  原文层·新通道原文（含 reflection/dream 产出全文）
│   experiences/YYYY-MM.jsonl    结构层·经历条目（通道无关的统一形态）
│   channels.json                通道注册表（数据文件，随她迁移）
│   staging/YYYY-MM/… + ledger   资产层·暂存字节 + 采集台账
│   assets/YYYY-MM/…             资产层·她保存的长期副本
├ 投影层（全部可丢弃、可重建；默认 node:sqlite，可降级 JSONL）
│   experience 索引（含 channel 列）/ FTS5 / entity / edge（bi-temporal 邻接表）
│   episode（情景摘要）/ asset 索引 / bla / judgment_ledger / channel 投影
│   facts / self-model / 各类状态——内容归 B，容器与生命周期归 A
├ 运行态层
│   state 检查点（write-through）/ tick 计数器 / 各游标 / 当下状态容器
└ 接口层（A 对外的全部面）
    append 写入（通道无关）/ 通道注册 / 查询原语（时间·通道·形状·实体·边·关键词·as-of）
    指针与媒体解析 / 重建 / tick
```

**投影皆可弃**：换机型/版本/模型后投影整体重建；真源目录（raw + experiences + assets + channels.json）整体拷贝即迁移雏形（E）。

---

## 4. 真源层

### 4.1 真源 = 两类不可变日志

| 层 | 日志 | 内容 | 为什么是真源 |
|---|---|---|---|
| 原文层 | `raw-turns/`（DSH，格式不动）+ `raw/<channel>/`（新通道统一格式） | 她感知到的原始流 | 全量（按通道采集策略），删了不可再生 |
| 结构层 | `experiences/` | 经历条目：切分、场景、关系、规则层标记 | 切分与关系含判断，不能由原文确定性重建——删了就丢判断史 |

物理布局原则：**逻辑上单一原文层，物理上按通道命名空间**；指针经通道注册表解析到物理文件，通道间互不干扰，新增通道不加目录级逻辑。记事本（raw-turns）= 原文层中 DSH 通道的部分，其固有属性（全量、append-only、她管擦）全部继承。

### 4.2 经历条目 Experience schema（全字段）

```ts
interface Experience {
  // ── 标识 ──
  id: string;                    // ULID：全局稳定、按时间有序、跨设备不变
  schema_version: 1;             // 真源格式版本；只增不改，未知字段原样保留

  // ── 双轴：形状 × 通道 ──
  kind: 'dialogue' | 'perception' | 'action' | 'reflection' | 'dream' | 'import' | string;
                                 // 形状：交互 / 单向感知 / 对外行动 / 内省 / 做梦 / 回填
                                 // 开放枚举：新形状 = 注册新值，旧读取器原样保留
  scene: {
    channel: string;             // 通道注册表 id：'dsh' | 'qq' | 'browser' | 'camera' | …（开放）
    ref: string;                 // 通道内场景标识：会话 id / 聊天 id / 页面 url+visit / 流 id / 复盘批 id
    detail?: Record<string, string>;   // 通道自定义键值（开放；如 QQ 群号、站点名）
  };
  initiation: 'user' | 'her' | 'system' | 'environment' | string;
                                 // 谁发起（三态 + environment：环境流如摄像头自检；继续开放）
  agent_meta?: {                 // 可选：她当时的载体（"她被升级了"也是一条经历；E 块同一性素材）
    model?: string;
    persona_version?: string;
  };

  // ── 三段槽位：发生了什么 / 做了什么 / 结果如何（冻结形状）──
  observation: {
    text?: Pointer;              // 原文指针 → 原文层行区间（正文一律不内联）
    media?: MediaRef[];          // 媒体引用（照片/语音/视频/文件/留意帧）
    cue?: string;                // 短触发线索内联（反思/做梦用；硬上限 200 字符）
  };
  action?: {
    type: string;                // 'reply' | 'browse-step' | 'tool-call' | 'preserve-media' | 'organize' | …（开放）
    tool?: string;               // 工具名（对齐 OTel gen_ai.tool.name）
    args?: Pointer | string;     // 大参数走指针，小参数内联
    thought?: Pointer | string;  // 行动前的判断过程——她的动机表达口（长文走指针）
  };
  outcome?: {
    text?: Pointer | string;     // 对方下一句 / 读到的内容 / 工具输出（长文走指针）
    status?: 'success' | 'failure' | 'partial' | 'unknown';
    error_type?: string;         // 对齐 OTel error.type
    duration_ms?: number;
    tokens?: { input?: number; output?: number };
  };

  // ── 时间三轴 ──
  occurred_at: string;           // ISO 8601：事情发生/被感知/被留意的时刻
  recorded_at: string;           // ISO 8601：进入真源的时刻，系统维护，永不回改
  tick: number;                  // 她的节拍序号：单调递增，摄入时由 A 分配

  // ── 关系与标记 ──
  marks?: Mark[];                // 规则层机械标记（只贴标签不否决；切分建议、疑似反馈、
                                 // 流的"可能值得留意"等都走这里）。Mark { type, by:'rule-layer', note? }
                                 // marks 永远不含"重要性"
  pointers?: Edge[];             // 摄入期结构关系；判断期关系存投影边表
}

interface Pointer {
  id?: string;                   // 权威定位：目标条目 id
  channel?: string;              // 原文所在通道命名空间（缺省按 id 索引解析）
  shard?: string;                // 冗余加速：'YYYY-MM'
  seq?: number | [number, number];   // 行号或行区间（含端点）
}

interface Edge {
  type: 'continues' | 'references' | 'about' | string;   // 摄入期结构关系；开放
  target: string;
  note?: string;
}

interface MediaRef {
  ref_id: string;                // ULID，全局稳定
  kind: 'image' | 'audio' | 'video' | 'file' | string;   // 开放枚举，内容类型无关
  mime: string;
  bytes?: number;                // reference-only 通道可无字节信息
  sha256?: string;               // 有字节时必填；完整性校验（迁移后验损）
  origin: {                      // 原始引用：核心只透传不解释，适配器自定义 host_ref 格式
    channel: string;             // 来自哪个通道
    host_ref: string;            // 通道内不透明引用（DSH 附件 id / QQ 文件 id / URL / 相机缓冲位 …）
    captured_at: string;
  };
  // 注意：不含 status / local —— 两者随时间变化，违反真源不可变；见 §6
}
```

**判断期关系为何不进 `pointers`**：真源不可变，而因果边（4.20）会更新、跨会话接续会重开。这些演化全部发生在投影边表；真源侧对应物是**反思经历**（复盘批作为 kind='reflection' 条目，产出全文进 `raw/<channel>/`）——她的每次判断本身就是一条经历，同时是 4.26 判断留痕的真源载体。judgment_ledger、因果边、facts 皆是"原始经历 + 反思经历"两个流的投影折叠。

### 4.3 形状（kind）× 通道填充示例

| kind | 通道例 | initiation 典型 | observation | action | outcome |
|---|---|---|---|---|---|
| dialogue 交互 | dsh / qq / 未来邮件 | user / her | text→raw 指针；media→图片/语音/文件 | reply | 对方下一句（指针） |
| perception 感知 | browser / camera / 未来屏幕·麦克风 | her / system / environment | 页面正文→raw 指针；media→留意帧/视频引用 | 可空（注视/翻页） | 读到/看到的内容 |
| action 行动 | 任一通道能力面（发帖/下单/控制设备） | her | cue（行动依据） | tool-call（tool+args） | status / error / 输出 |
| reflection 反思 | 内部（复盘批） | her / system | cue：本批输入经历清单 | organize | 复盘产出全文（指针） |
| dream 做梦 | 内部 | her | cue：触发线索+顺指针追踪集 | organize | 做梦产出（指针） |
| import 回填 | 任意源 | system | 指针（源文件） | — | — |

### 4.4 粒度与切分权

- **A 不内置任何切分逻辑**。条目粒度 = 调用方（适配器/规则层）决定；A 只保证一条目对应**一个场景内的一段连续内容**；
- 对话场景机械基线：一轮 = 一条 dialogue 经历（零判断、可确定性重建的回放基线）；记忆单位是投影层情景（episode）；
- 切分建议、留意分段都走 marks（B 规则层），她复盘时以情景投影聚合，**永不改真源**；
- 7.3 第二条"截断+游标跳走"彻底失效：流里没有会被跳过的东西。

### 4.5 ID 与指针规范（本稿新增 ID 映射）

- **ULID（单调变体防时钟回拨）**：真源四类对象（经历、媒体引用、资产副本、原文行）皆有稳定 id；按字典序即时间序；
- **存量兼容与 ID 映射**：现有 `RawTurn.event_id` 原样保留、无需迁移。但它属于**原文层 id**，新 `Experience.id`（ULID）属于**结构层 id**，两者不同源。转写脚本（§10）在建立"1 RawTurn → 1 dialogue experience"时，必须显式写入映射：`experience.observation.text.id = event_id`、`experience.id = 新 ULID`。该映射靠指针承载、不另建映射表——从任一经历可经 `observation.text` 回原文，从原文经投影反查经历；
- **指针双定位**：id 权威，channel+shard+seq 加速冗余；跨设备 id 永不变。

### 4.6 通道注册表与适配器契约

**通道描述符**（`channels.json`，数据文件，随她迁移）：

```ts
interface ChannelDescriptor {
  id: string;                    // 'dsh' | 'qq' | 'browser' | 'camera' | …（开放）
  label: string;                 // 人读名
  modalities: string[];          // 'text'|'image'|'audio'|'video'|'file'|'event'（开放）
  capture: 'full' | 'notice' | 'reference-only';   // 采集策略声明：可审计
  staging?: { retention_days?: number };   // 声明暂存缓冲能力与窗口
  counterpart?: 'user' | 'person' | 'group' | 'world' | 'system';   // 对端类型（B 用）
  adapter_version: string;
}
```

**适配器契约**——任何新来源接入三步，**零核心改动**：

1. 在 `channels.json` 注册描述符（声明模态与采集策略）；
2. 适配器把该通道原始事件翻写为统一 Experience（原文行进 `raw/<channel>/`，媒体走 `ingestMedia`）；
3. （可选）声明 staging 缓冲。

核心对通道的全部假设：**能产出 Experience、能给出 (id, occurred_at)**。核心不解释 origin.host_ref，不感知通道语义；B/C/D 只面对统一经历流。

### 4.7 流通道：采集策略与"留意分段"

**采集策略三级**（通道声明，进台账可审计）：

| 策略 | 典型通道 | 真源记录 | 字节 | 隐私姿态 |
|---|---|---|---|---|
| full 全量 | dsh、qq 文本 | 全量原文 | 媒体字节进 staging（默认 30 天，软上限提醒） | 对话全量是既有拍板；第三方隐私按 4.11 记录提醒 |
| notice 留意 | 摄像头、屏幕、麦克风、长视频流 | 仅"留意段"经历 | 仅留意段进 staging（窗口适配器声明，短） | **默认关闭**、显式授权才开启；策略与开关全程可审计 |
| reference-only 引用 | 外链、超大文件 | 引用与描述 | 不落字节 | 指向即记录；失效如实呈现 |

**留意分段机制**（连续流 → 离散经历）：

- **触发**：机械信号（运动/场景切换/关键词/音量）→ 规则层打 marks（"可能值得留意"——不否决不直录，4.2 从对话切分自然延伸到流）；她自己正在看（initiation=her）时段落自然成经历；
- **窗口**：适配器声明的环形缓冲保留期（N 分钟~N 小时，适配器自定）；期内她可 `preserveMedia`；过期即 decayed（缓冲是防丢失，不是判断）；
- **人类类比**：瞥见（缓冲）≠ 注意到（分段成经历）≠ 记住（保存进资产）。

---

## 5. 时间模型（本稿澄清 tick 语义）

| 轴 | 字段 | 语义 | 谁写 | 可否回改 |
|---|---|---|---|---|
| 世界轴 | `occurred_at` | 发生/被感知/被留意 | 摄入方 | 否 |
| 系统轴 | `recorded_at` | 进入真源 | A | 永不 |
| 节拍轴 | `tick` | 她的主观节拍序号 | A | 永不 |

**tick 语义澄清（本稿新增）**：tick 是**摄入序号**，按 append 顺序由 A 分配，**不保证与 occurred_at 顺序一致**。多通道并发或乱序到达时，先落库者先得 tick。它表达"这是她经历的第 N 件事"，不表达"这件事在世界时间上的先后"——世界时间顺序一律查 occurred_at。

- **valid/invalid 不进真源**：只进投影边表与 facts（bi-temporal；事实过期打失效标记不删除）；as-of 查询支持"她在 T 时刻相信什么"；
- **迟到/乱序**：append 友好；备案：recorded_at 主窗口 + occurred_at 排序呈现 + 迟到条目兜底清单；
- **她的日历**：tick 之上的投影（C 定义）；4.5 的 60/180 天、4.6 单日配额等所有"自然日"参数在她的日历上重定；
- **毫秒口径**：投影层时间列统一毫秒（与 BLA d 校准一致）；
- **跨通道时间**：各通道时钟可能不同步——occurred_at 记通道给的值，recorded_at 记本机真源时刻，偏差可审计（两轴分开的收益）；
- **回放/导入兼容**：4.23.1 注入 now/until 与三轴直接兼容。

---

## 6. 资产层（媒体字节）

**原则：真源存引用，字节进资产层；引用分两层——原始引用（origin，可失效、只记录不依赖、核心不解释）与本地副本（assets，她保存后唯一被长期依赖的位置）。**

### 6.1 生命周期（按采集策略适用）

| 阶段 | 动作 | 归谁 | 对应决策 |
|---|---|---|---|
| 摄入 | 文字进原文层；full/notice 通道媒体字节拷入 staging，MediaRef 写进携带它的经历 | 系统 | 4.3"系统管记"；防原始引用先烂 |
| 保存 | `preserveMedia(ref_id)`：staging → assets，**留一条 action 经历** | **只有她**（实时或复盘） | 1.3.2；系统永不自动长期保存 |
| 衰减 | 未采纳 staging 到期清除（台账记录），origin 独存 | 系统 | 4.5 默认遗忘；暂存是防丢失不是判断 |
| 删除 | assets 删除走 4.25 删除工具 | 只有她 | 4.25 全套 |

### 6.2 状态是折叠不是字段

`asset.status ∈ { origin-only, staged, preserved, decayed, lost }` = fold(MediaRef, 保存经历, 采集台账)。真源保持纯 append-only。origin-only = 通道从未有本地字节；lost = 原始也失效。

### 6.3 诚实边界（1.3.4）

注入时如实呈现：`preserved`→"照片（本地已保存）"；`decayed/lost`→"照片（原始已不可考，未保存副本）"；`origin-only`→"链接（未取回内容）"。**不允许假装还看得见**。她事后"看"媒体 = getMedia 载入上下文（D 包装为身体能力）；A 保证引用可解析、可校验。

### 6.4 两个"30 天"的区分（本稿新增，防混淆）

| 机制 | 是什么 | 到期 |
|---|---|---|
| **staging 30 天** | 未被她采纳的媒体字节的**暂存缓冲** | 清字节、保留 origin 引用与台账 |
| **垃圾桶 30 天** | 她**主动删除**的内容的**反悔窗口** | 清内容转痕（30–180 天留痕、180 天清除） |

两者完全独立：一个是"还没决定要不要"，一个是"已经决定不要"。

---

## 7. 投影层

### 7.1 表清单（本稿区分最小集与完整集）

**最小投影集（阶段一落地，3 张核心表 + FTS）：**

```sql
-- P1 经历索引（结构层全量折叠；channel 为一等查询维度）
CREATE TABLE experience(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  channel TEXT NOT NULL, scene_ref TEXT, initiation TEXT,
  occurred_ms INTEGER NOT NULL, recorded_ms INTEGER NOT NULL,
  tick INTEGER NOT NULL UNIQUE,
  status TEXT DEFAULT 'active',          -- G3 七态对齐（B 写）
  shard TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX idx_exp_time ON experience(occurred_ms);
CREATE INDEX idx_exp_kind ON experience(kind);
CREATE INDEX idx_exp_channel ON experience(channel, scene_ref);

-- P2 全文（FTS5 trigram，中文适配实施时评估）
CREATE VIRTUAL TABLE experience_fts USING fts5(text, tokenize='trigram');

-- P4 边表（邻接表 = ADR-1 落地；bi-temporal）
CREATE TABLE edge(
  id TEXT PRIMARY KEY,
  src TEXT NOT NULL, predicate TEXT NOT NULL, dst TEXT NOT NULL,
  valid_ms INTEGER, invalid_ms,
  created_ms INTEGER NOT NULL, expired_ms INTEGER,
  confidence REAL, reason TEXT,          -- 4.20 门槛与有界更新在投影层
  provenance TEXT);
CREATE INDEX idx_edge_src ON edge(src, predicate);
CREATE INDEX idx_edge_dst ON edge(dst, predicate);
```

**完整投影集（随能力需要逐步加，不预先建）：**

```sql
-- P3 实体（跨通道统一：QQ 上的他与 DSH 上的你在这一层是同一实体）
CREATE TABLE entity(id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, aliases TEXT);
CREATE TABLE experience_entity(experience_id TEXT, entity_id TEXT, role TEXT, source TEXT,
  PRIMARY KEY(experience_id, entity_id));

-- P5 情景摘要（"事件"的新位置；4.10 的投影形态）
CREATE TABLE episode(
  id TEXT PRIMARY KEY,
  title TEXT, summary TEXT NOT NULL,
  key_points TEXT, time_from_ms INTEGER, time_to_ms INTEGER,
  status TEXT, importance INTEGER, status_note TEXT);   -- 她的判断（投影层合法）
CREATE TABLE episode_member(episode_id TEXT, experience_id TEXT,
  PRIMARY KEY(episode_id, experience_id));

-- P6 资产索引
CREATE TABLE asset(
  ref_id TEXT PRIMARY KEY, kind TEXT, mime TEXT, bytes INTEGER, sha256 TEXT,
  status TEXT NOT NULL, staging_path TEXT, asset_path TEXT,
  description TEXT, experience_id TEXT, origin_channel TEXT);

-- P7 BLA 痕迹（4.22 Petrov 近似；只影响排序不改置信度）
CREATE TABLE bla(target_id TEXT PRIMARY KEY,
  last_k TEXT, use_count INTEGER, first_ms INTEGER);

-- P8 判断留痕（4.26 投影折叠；真源载体是反思经历）
CREATE TABLE judgment_ledger(
  id TEXT PRIMARY KEY, batch_id TEXT, decision TEXT,
  target TEXT, why TEXT, ts INTEGER);

-- P9 通道投影（channels.json 索引 + 各通道累计统计——"她在哪些世界生活"可查询）
CREATE TABLE channel(id TEXT PRIMARY KEY, label TEXT,
  capture TEXT, modalities TEXT, adapter_version TEXT,
  first_seen_ms INTEGER, experience_count INTEGER);
```

facts / self-model 同入投影库（表结构归 B，A 给容器与版本纪律）；facts 七态、self-model 倾向强度结构（7.2-21）在此层落，不再受固定文件格式限制。

### 7.2 关键纪律

- **投影确定性、幂等**；非确定部分（LLM 判断）只在真源（反思经历），投影只折叠真源已有内容——**重建时不重新调 LLM，只折叠已固化的反思经历**；
- **单写者**：所有真源 append 经同一写队列（多通道并发安全）；
- **G3**：激活扩散、使用频率只读写 bla/edge 排序信息，不改事实状态与置信度；
- **ADR-1/ADR-5**：边表是邻接表不是图库；向量是未来又一个投影（侧车从真源重放灌入，真源不动）。

### 7.3 重建协议

1. 停写或降级标注（沿 4.19 语义）；
2. 新建投影库，顺序扫描真源折叠；
3. 对账（RawTurn 数 = dialogue 经历数；media 数 = asset 数；各通道 experience_count 与 channels.json 一致）；
4. 原子换名。SQLite 文件即快照；年级别 <20 万条，分钟级。触发：schema 升级、损坏检测、手动。

### 7.4 投影引擎降级路径（本稿新增，关键）

**事实约束（已核）**：

- 插件 `package.json` 的生产 `dependencies` 为 **空**——刻意不引入运行时依赖，故不能使用 better-sqlite3 等原生模块；
- 当前 Node v22.23.2 的内置 `node:sqlite` 可用，但是**实验性 API（ExperimentalWarning，可能变化）**，且宿主可能禁用。

**三级降级（按可用性自动选择，对上层透明）：**

| 级别 | 引擎 | 触发条件 | 能力 |
|---|---|---|---|
| L1 | `node:sqlite`（默认） | 内置可用且宿主未禁用 | 完整投影：FTS5、多维索引、事务 |
| L2 | JSONL 索引（复用 `KVStore`） | node:sqlite 不可用/被禁用 | 自建倒排 + 时间/通道索引；无 FTS5，检索走词法（与现有 recall 同能力） |
| L3 | 真源直读 | 投影损坏且无法重建 | 惰性分片扫描真源，功能不丢、仅延迟上升，标注"降级运行" |

**核心保证：投影引擎可替换，真源永不换。** 任何降级都不影响数据完整性，只影响查询性能与功能丰富度——因为唯一不可再生资产是真源，投影始终是可丢弃的加速层。

---

## 8. 运行态层与运行循环（本稿新增）

### 8.1 运行态状态

| 状态 | 持久化 | 丢失后果（可接受性） |
|---|---|---|
| tick 计数器 | 检查点 | 无害：max(投影 tick)+1 自愈 |
| 复盘游标等 | 检查点（write-through） | 代价 = 重复复盘一段窗口，幂等可承受 |
| 当下状态容器（X12 存储侧） | 检查点 | 降级为"从零被唤醒"——比带错误状态好 |

### 8.2 运行循环："身份持续、计算按需"

她不是常驻进程；每次唤醒按统一循环恢复与挂起：

```
启动/唤醒
  → 读检查点（state + 各游标 + 当下状态）
  → 检查点损坏则从真源重算（§7.3）
  → 打开投影（L1/L2/L3）
  → 处理本轮触发（事件/通道/定时）
  → 变更经单写者 append 真源 + write-through 检查点
  → 刷新投影（或标记惰性）
挂起
  → 落检查点 → 释放进程
```

**边界**：当下状态的**内容**归 C 定义、由她的经历与判断更新（1.6.3）；A 只提供容器与持久化机制。

---

## 9. 接口层（A 对外的全部原语）

| 组 | 原语 | 说明 |
|---|---|---|
| 注册 | `registerChannel(desc)` | 通道注册表写入（数据文件 + 投影同步）；接入新来源第一步 |
| 写入 | `appendExperience(entry)` | 追加真源（通道无关）；分配 recorded_at/tick；校验 schema_version |
| 写入 | `ingestRawTurn(channel, input)` | 摄入一轮原始对话：**写原文 → 构造经历 → 写经历 → 更新投影**封装为一个经单写者队列的原子操作；以 **(channel, event_id)** 为幂等键，重复摄入零新增（阶段 4 开放面扩展，见 `src/adapters/dsh/`） |
| 写入 | `ingestMedia(bytes?, meta)` | full/notice：字节进 staging 生成 MediaRef；reference-only：仅登记 origin |
| 写入 | `preserveMedia(ref_id)` | staging→assets；留 action 经历；**只有她可调** |
| 查询 | `query({time, kind, channel, scene, initiation, status})` | 经历流多维查询（channel 一等维度） |
| 查询 | `search(keyword)` | FTS5 全文（降级时走词法） |
| 查询 | `queryEntity / queryEdges({src,predicate,dst,asOf})` | 实体与边查询；as-of 支持"她在 T 时刻相信什么" |
| 查询 | `resolvePointer(ptr)` | 指针解析→原文行（4.10 复盘回读底层；跨通道经注册表寻址） |
| 查询 | `getMedia(ref_id)` | 媒体字节+元数据载入（D 包装成"看照片/看刚才"的身体能力） |
| 维护 | `tick() / rebuildProjections(scope?) / verifyIntegrity(ref_id?) / verifyChannel(ch?)` | 节拍、重建、哈希校验 |

4.18 激活扩散、她"主动查自己的记忆"（P5 根治）、C 块自驱动检索入口，共用同一套查询原语。

---

## 10. 演进纪律

### 10.1 冻结面（改动 = 伤筋动骨，须全块评审 + 用户确认）

1. 真源 append-only（原文层 + 结构层 + 资产台账）与 4.25 permanent 唯一例外；
2. ULID 稳定 id + 指针双定位；
3. 三段槽位形状（observation / action / outcome）；
4. 时间三轴（occurred / recorded / tick）；
5. 投影皆可从真源重建。

这五条是"存在日志"的本体论承诺，总量刻意压到最小。

### 10.2 开放面（加法演进，永不破坏既有数据与逻辑）

1. **开放枚举注册制**：kind / 通道 / modality / initiation / action.type / 边类型 / 采集策略外的通道属性——全部开放字符串 + 注册表；**旧读取器遇未知值必须原样保留、不得丢弃**；
2. 通道适配器契约（§4.6：注册 → 产出统一经历流 → 可选缓冲）；
3. 采集策略声明（§4.7）；
4. 投影 schema（可删可重建，加列加表自由）；
5. 全部参数（时限/上限/门槛）。

### 10.3 扩展配方（以后"加东西"的标准动作）

| 想加什么 | 动作 | 动核心吗 |
|---|---|---|
| 新来源（QQ/摄像头/未来 X） | 注册通道 + 写适配器产出 Experience | 否 |
| 新经历形态（情绪波动、她被升级） | 注册新 kind 值 | 否 |
| 新媒体类型 | modality/kind 开放枚举直接加 | 否 |
| 新查询维度 | 加投影表 + 重建逻辑 | 否 |
| 新时间概念（她的日历/节拍层级） | C 建 tick 上的投影 | 否 |
| 新记忆操作（遗忘策略/扩散算法） | B 在投影层实现 | 否 |

**验收标准**：任何扩展不得要求修改冻结面五条，不得要求迁移既有真源数据。

### 10.4 schema 演进机制（本稿新增）

- **真源不批量迁移**：`schema_version` 只影响新写入，旧记录保持原样、永不回改；
- **读取器兼容所有版本**：必须能识别历史全部 schema_version，遇到未知字段原样保留（C2）；
- **投影随版本重建**：schema 变化通过重放真源重建投影吸收，不在真源上做就地升级；
- **枚举只增不删**：开放枚举的旧值永久保留语义，新值不得复用旧标识。

---

## 11. 删除与擦除的成功标准（本稿新增）

`persona_forget`（删除工具）作用于原文层/结构层/资产文件，垃圾桶记双落点。"删除成功"必须可验证，分两层判定：

| 范围 | 成功标准 |
|---|---|
| 本地闭包 | 记录、派生、缓存、内容库字节**全部清理**，且经依赖闭包验证无残留；tombstone 防重新派生；**独立引用的那一份不得连带误删** |
| 外部副本 | 外部平台副本删不掉时，**只如实记录"未清理"状态，绝不冒称成功**（H15） |

**两条硬纪律**：

1. 删除后不得被回滚/重建复活（H9）；
2. 留痕不含被删内容（4.25：垃圾桶 30 天内除外，之后转痕、180 天清除）。

---

## 12. 迁移步骤（仅涉 dsh 通道）

> 前提：`captureRawTurn` 无条件执行（index.ts:1127），老对话原文已在 `raw-turns/`，无需重导正文；4.23 临时通道仅在"有导出会话文件但不在 raw-turns"时作为可选前置。

1. **备份**整个数据目录；
2. **转写**（scripts/ 一次性，幂等、content_hash 查重）：1 RawTurn → 1 条 dialogue 经历（channel='dsh'，机械基线零判断）；occurred_at=asserted_at、recorded_at=ingested_at；tick 按全时间序分配；不设排除标记；
3. **清空 review-state**（4.27）；
4. **老数据回放**（4.23/4.23.1，仅限测试、用完删）→ 反思经历与派生；
5. **投影全量重建**（§7.3）；
6. **核对**：条数对账、抽样指针解析、sha256 抽验、成长档案日期符合预期。

失败处置：整体从备份还原重跑，不在半成品上叠加。raw-turns 原文件保留为证，永不改写（除 4.25 通道）。

---

## 13. P1–P12 治愈对照

| # | 病 | 治 |
|---|---|---|
| P1 | 原子是摘要文本，无动作/结果/动机 | 三段槽位 + thought 口 + 指针（§4.2） |
| P2 | 事件层无来源场景标识 | kind + scene 双轴（§4.2，通道一等公民） |
| P3 | 全量加载 | 启动只开投影，真源惰性分片读 |
| P4 | 单一复盘节奏 | 复盘 = 反思经历；多轨节拍是 B 的策略 |
| P5 | 记忆只能被注入 | 查询原语一等接口 |
| P6 | 固定 7 字段 | self-model = 版本化投影 |
| P7 | 无当下状态 | 运行态检查点容器 |
| P8 | 只有真实时钟 | 三轴 + tick + 她的日历 |
| P9 | 注入只承载短文本 | 媒体/长文走引用与按需载入（§6/§9） |
| P10 | "会话"是一等公民 | session 降级为 dsh 通道的 scene.ref |
| P11 | 无动作/结果类事件 | action/outcome 槽位 + status/error_type |
| P12 | 存储无索引 | 投影多维查询（时间/通道/形状/全文/实体/边） |

跨块落位：X10 → H5 + 通道化；X11 → §7；X12 → §8。

---

## 14. 与已拍板决策对齐（4.1–4.27）

| 决策 | 对齐说明 |
|---|---|
| 4.1 筛选权归复盘 | 她的判断 = 反思经历（真源留痕），judgment_ledger 为投影 |
| 4.2 规则层只标记 | marks（对话切分 + 流留意统一走此通道），永不否决、永不判重要性 |
| 4.3 记事本 | DSH 通道原文层全量 + rewrite 例外；full 策略把"全量"限定在正当场景 |
| 4.4 单一记忆 | 真源唯一，通道/形状只是字段 |
| 4.5 真遗忘 | 三轴与她的日历支撑 60/180 天重定；事实失效不删除；staging 衰减同构 |
| 4.8 污染防护 | 浏览 = perception×browser 语义不变；"视频讲了 X / 我觉得 X 有意思"照旧；可信度分级有 channel 投影可挂 |
| 4.10 记忆单元 | 升级为"经历条目 → 情景投影（episode）" |
| 4.13 做梦 | kind='dream'；"顺指针追踪" = 沿边表遍历 |
| 4.16 倾向火候 | 强度结构落 self-model 投影（7.2-21 兑现） |
| 4.18 读出侧 | 激活扩散跑边表；五槽、预算、G3 过滤全在投影层 |
| 4.20 因果边 | edge 表 + confidence/reason；有界更新在投影层 |
| 4.22 BLA | bla 表（最近 k 次 + 次数），毫秒口径 |
| 4.25 删除工具 | 作用原文层/结构层/资产文件；垃圾桶记双落点 |
| 4.26 复盘决策 | 真源 = 反思经历，投影 = judgment_ledger |
| 4.27 从零重建 | 与"投影皆可弃"同构 |

**原则类直接兼容**：4.7/4.11（资产索引 + 采集台账使"她存了什么、从哪存的"首次完全可审计）、4.12/4.14/4.15、4.17、4.19、4.21（证据/描述边界 = 真源/投影边界）、4.23/4.24、4.6。

**1.6 理念扩展落位**：1.6.1 行动归她 → action 经历 + 全程留痕；1.6.2 权限随价值长 → notice 通道默认关闭、显式授权开启（架构级默认姿态，D 细化）；1.6.4 全程可追溯 → 采集台账 + 行动经历。

---

## 15. 待确认与待真机清单

| # | 事项 | 建议 | 状态 |
|---|---|---|---|
| 1 | 高带宽通道默认姿态 | 默认关闭、显式授权、notice 采集、短缓冲（1.6.2 + Recall 教训） | ⏳ 待确认 |
| 2 | full 通道媒体暂存时限与磁盘代价 | 初始 30 天、软上限提醒 | ⏳ 待确认 |
| 3 | node:sqlite 在 DSH 宿主可用性（实验性、是否被禁用） | 真机核实；不可用走 §7.4 L2 | ⏳ 待真机 |
| 4 | tick 粒度 = 每条经历一个序号 | C 可建更高层节拍 | ⏳ 建议默认 |
| 5 | 复盘选材时间轴 | 倾向 recorded_at 主窗口 + 迟到清单，B 定 | ⏳ 备案 |
| 6 | 多进程写并发 | 单写者队列（单机）；跨设备归 E | ⏳ 建议默认 |

---

## 16. 开放问题（不阻塞定稿）

1. 分片上限与 compaction：按月沿用；单分片超阈值（建议 50MB）提醒归档；
2. FTS5 中文分词：trigram 实施时评估；
3. notice 通道缓冲具体窗口与触发信号清单（运动/场景切换/关键词）：适配器接入时逐通道定；
4. 投影损坏自动检测周期与自动重建入口；
5. `agent_meta` 记录粒度（每次 LLM 调用 vs 每条经历）——倾向每条经历，E 块定；
6. `dsh-attachment` 精确字段、附件保留期、`image/offload` 捕获——维持 7.2-6 推迟，真机取证后只填 dsh 适配器细节；
7. QQ 适配器等具体通道实现不在 A 块范围（A 只锁契约）；其权限面归 D。

---

## 17. 下一步（确认后）

1. 本稿并入 `memory-architecture-redesign.md`：新增"A 块定案"章节，解除 4.10/4.16/4.18 三条 🔴，关闭 X10/X11/X12，冻结面/开放面写入总设计文档开头（与 1.5 总纲并列作尺子）；
2. B 块回看：按新地基重审 27 条落点（4.5/4.6/4.13 自然日参数在她的日历上重定；4.8 浏览语义映射 perception×browser）；
3. D 块开工第一批适配器建议顺序：qq（验证跨平台文本）→ browser（验证 perception 与污染防护）→ camera（验证 notice 与授权流）——恰好覆盖三种采集策略各一，作为契约验收用例；
4. gold set 增加"通道混布"用例类（同一段经历跨 dsh/qq/browser 的检索与实体统一）。

---

## 18. 实施策略：从零新建仓库，旧项目只作参考

### 18.1 决策（用户拍板，2026-11-08）

**放弃在 0.5.7 代码库上翻新，新建仓库从零实现；旧项目（`dsh-persona-innate` 0.5.7 / `4fed4a5`）降级为只读参考，不搬代码、不维护、不做兼容层。**

### 18.2 决策依据（已核代码得出）

| 维度 | 实测 | 结论 |
|---|---|---|
| 可原样复用 | 约 10%（`paths`/`store`/`time`/`llm-client`/`raw-turn-log`/`provenance`/`directive-strip`） | 占比过低，不足以支撑"翻新省事" |
| 必须重写或大改 | 约 65%（原子 `event-log`、固化 `review` 977 行、读出 `recall`/`assembler`、编排 `index.ts` 1642 行会话总线） | 翻新等于在旧骨架上重造大部分器官 |
| 改造 | 约 25% | — |
| 契约耦合 | `PersonaEvent` 13 文件 99 处；`index.ts` 以会话为中心组织 | 做兼容层会把新架构锁回旧假设 |
| 测试性质 | 8913 行 / 349 用例，全部内部模块级（`import '../lib/xxx.js'`） | 换实现必然重写测试，但用例与断言值是资产 |

**决定性理由**：`index.ts` 的会话总线若不拆，新的"通道 / 身体 / 多轨节拍"概念只能绕着它长，最终长成缝合怪——冲突是长期的、隐蔽的、会不断回潮的；重写是一次性的、可在测试环境可控的。

### 18.3 旧项目的正确用法（关键：参考什么、不参考什么）

**数据根口径（用户 2026-11-08 确认）**：

- 新代码**运行数据根**为 `~/.dsh/fasti/`，路径解析沿用三级：显式配置 > `$DSH_HOME` > 默认；日常运行只读写新根；
- `~/.dsh/persona-innate/` **不是运行依赖**，仅在阶段 3 由一次性转写脚本作为**数据来源**读取（老数据保留，见 §12）；转写并验证无误后旧目录整体保留为备份，不自动删除；
- **代码从零重写 ≠ 她的经历从零**：她的历史随转写进入新根。旧代码退役 ≠ 她的经历丢失。

| 参考（保留为行为契约） | 不参考（旧假设，复制即错） |
|---|---|
| 时区 / 星期词处理口径 | 一轮 = 一个事件（改为经历条目 + 情景投影） |
| 10 分钟 dedupCache 去重策略 | 规则层词表三档 AND 判定、`importance` 0.6/0.7/0.8 |
| 空消息 / 斜杠 / 短消息边界处置 | 少于 8 字直接跳过 |
| 指令性内容剥离（`directive-strip`） | 写死词表筛选、13.5% 入库率 |
| 附件块跳过与 `image/offload` 缺失的诚实标注 | 会话为一等公民、按 session 切片 |
| `event_id` 取值规则（user→`data.id` / assistant→`data.message.id` / 兜底 `rt-makeId`） | `imported: true` 排除在成长之外 |
| `content_hash` 查重、raw_turns 全量 append 无去重 | 截断 + 游标跳走 |
| LLM 单次 90s 超时（新架构需扩为管线级） | 五槽各至多一条、700 字符预算 |
| 349 用例覆盖的边界清单 | 固定 7 字段自我模型 |

**落地方式**：把左栏整理为《旧项目行为契约清单》放入新仓库 `docs/reference/`，作为新实现的验收参照——**只搬知识，不搬代码**。

### 18.4 新仓库初始结构（按 §3 分层）

```
docs/
  mechanism-design.md              # 总设计（从旧仓库择期并入，保留一份）
  a-block-design.md               # 本稿：A 块定案
  reference/
    legacy-behavior-contract.md    # 旧项目行为契约清单（§18.3 左栏）
    legacy-test-catalog.md         # 349 用例的边界清单（不含实现）
src/
  source/                          # 真源层
    raw-log.ts                     #   原文层（多通道命名空间）
    experience-log.ts              #   结构层 experiences
    channels.ts                    #   通道注册表
    assets.ts                      #   资产层 staging/assets
  projection/                      # 投影层
    sqlite.ts / fallback-jsonl.ts  #   引擎与降级（§7.4）
    schema.ts                      #   表定义与重建
    rebuild.ts                     #   重建协议
  runtime/                         # 运行态层
    checkpoint.ts                  #   检查点 / tick / 游标
  api/                             # 接口层（§9 原语，先写契约）
    index.ts
  adapters/
    dsh/                           # 第一个通道适配器
scripts/
  migrate-raw-turns.ts             # 一次性转写（§12，幂等）
tests/
```

### 18.5 实施顺序

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | 骨架 + 契约先写死（Experience schema、§9 原语签名、冻结面五条） | 契约评审通过，冻结面无歧义 |
| 1 | 真源层：原文层（沿用 raw-turns 格式）+ experiences + channels.json | append 幂等、分片、ULID、双定位指针 |
| 2 | 投影层最小集：`experience` / `edge` / FTS + 降级 L2 | 重建与真源对账一致 |
| 3 | 一次性转写 `raw_turns → experiences` + 投影全量重建 | 条数对账、抽样指针解析、sha256 抽验 |
| 4 | dsh 通道适配器：对话写入 experiences | 真机会话无丢事件、无重复 |
| 5 | B 块回看：复盘 / 读出接新地基 | 4.10/4.16/4.18 三条 🔴 解除 |
| 6 | 多通道验证：qq → browser → camera | 三种采集策略各一，零核心改动 |

**阶段 3 是分水岭**：在此之前新仓库不接触她的真实数据；转写与重建只在备份副本上验证通过后才指向真实目录。

### 18.6 阶段 0–2 实现口径（用户 2026-11-08 确认照建议走）

11 项实现口径按审计建议落，权威明细见 `docs/reference/a-block-implementation-audit.md` 第二节：

1. ULID 自实现单调变体（空依赖约束，不装第三方库）；
2. 原语补 `.d.ts` 级签名与抛错约定；
3. Pointer.seq 从 0 起算、区间闭区间、越界抛错；
4. schema_version 未知字段原样保留；
5. `raw/<channel>/` 沿用 RawTurn 8 字段；
6. experiences 以 `id` 为幂等键；
7. 初始 channels.json 预置 dsh 描述符；
8. tick 从真源 `max(tick)+1` 起步；
9. 单写者用单进程 Promise 串行队列（跨进程锁归 E）；
10. FTS 文本经指针回原文 + cue 灌入；pointers 折叠进 edge；投影增量更新、L1→L2→L3 降级检测。

阶段 0–2 验收以该审计文档第四节清单为准；代码审计分级与工作方式见其第六节。
