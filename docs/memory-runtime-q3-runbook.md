# 记忆索引运行期细则（Q3 Runbook）· v1.4（隔离根离线首建 memory-index 后补齐 on/shadow 成功路径真机证据，随提纲 v0.6 同步）

> v1.4 注记：在全新隔离 `DSH_HOME` 经**离线窄写种子**首建 `memory-index`（运行期仍只开不建，首建属离线授权动作），
> 把 v1.3 标注 `[~]`/“离线覆盖”的真机项补成实测：影子六字段 JSONL 落盘、N14 白名单成功回显、on 门
> hit/abstain/no-match 三态、`serial-stale` 真机直证、on 态 `add_alias` 生产别名真写。on 档仅用于该隔离一次性
> 验收，主仓默认 off 不变、真实 `~/.dsh` 零写、验收后隔离环境删除。本轮无源码改动，811/811 基线不变。
>
> 对应：第二层提案提纲 v0.6 §7.1/§8.2/§8.3/§11 Q3、N12/N15/N16。
> 性质：运行期索引的**操作协议与判定口径**，约束 WP3/WP4 接线与离线调度；本文档只描述已实现事实与
> 待实现协议，不修改任何第一层冻结代码。机制文档只存仓库 docs/ 这一份。
> 路径一律以 `<dataRoot>` 占位，外发按 EVIDENCE §10 同口径去标识。

## 1. 角色与写面枚举

| 写面 | 路径 | 谁能写 | 纪律 |
|---|---|---|---|
| 真值源（只追加） | `<dataRoot>/{experiences,events,raw-turns}/*.jsonl` | 无人（本系统只读） | source-append-only，任何开关状态下永不写 |
| 生产记忆索引 | `<dataRoot>/projection/memory-index/` | 离线 builder（首建/重建）；运行期窄柄仅 miss 别名/观测窄写 | 运行期只开不建、不迁移 schema |
| 影子索引与观测 | `<dataRoot>/projection/memory-shadow/` | 外部离线调度重建；运行期仅观测追加 | 可丢弃/可重建，与生产物理隔离 |
| 决策/版本账本 | memory-index 内账本目录 | 离线 builder；运行期经窄柄 addMissAlias 内部追加 | 装配层不得直接引用账本函数 |

## 2. 首建协议（离线授权，运行期只开不建）

1. 生产索引首建只能由离线 CLI `build-memory-index.ts --apply`（既有 `--data-root/--yes` 纪律，显式人工
   授权）完成；运行期代码无任何建库/建表入口。
2. 已实现事实（WP2，`openMemoryRuntimeBackend`）：窄柄打开前以 `fsx.exists` 检查库文件，不存在即抛
   `NotFoundError`，**绝不进入 `openMemoryWrite` 的 ensureDir 建库路径**，不创建任何文件。
3. 库存在时才打开写柄；`CREATE TABLE IF NOT EXISTS` 对既有库为幂等 no-op，不改 schema、不做迁移
   （schema v1 无迁移协议，版本不符另立评审）。

## 3. 打开、写单例与只读降级（已实现）

- 写柄进程内单例（键=绝对 indexDir）。窄柄后端打开写柄若遇 `ConflictError`（离线构建正持有）：
  降级为独立只读连接，后端 `writable=false`、`writer=null`。
- 降级形态：读方法（searchExplained/getCardsByAnchor）照常；addMissAlias/recordMiss 调用抛
  `UnavailableError`，不抢锁、不排队阻塞、不留半写。runtime.test 已覆盖该路径。
- 关闭：窄柄 close 只关闭自己持有的连接；离线写柄生命周期不归窄柄管理。

## 4. 真值指纹漂移二分策略（N15）

### 4.1 冻结的硬原语

- `verifyStampedFingerprint`（store）保持“不符即抛 `MemoryIndexStaleError`”，不改写、不吞错。
- 指纹结构 `TruthFingerprint = { files: ReadonlyArray<{path, sha256}>, aggregate }`；
  既有纯函数 `computeTruthFingerprint(dataRoot)`（builder.ts 导出）枚举 experiences/events 分片，
  逐文件 sha256 后求有序聚合。判定只使用该现有结构，**不向真值或 schema 增加字段**。

### 4.2 策略层二分（在硬原语之外，不改原语）

运行期打开时重算当前真值指纹，与库内 stamped 指纹比对：

| 情形 | 判定条件（files 列表比对） | 处置 |
|---|---|---|
| 一致 | 路径集与全部 sha 相等 | 正常服务 |
| 预期漂移（append-only 增长） | stamped 旧路径集的每个 sha 全部不变，且当前仅**新增**路径 | 以最近 stamped 索引继续只读服务；暴露 staleness 指标；按计划离线重建，不拒服 |
| 意外不符/损坏 | 旧路径集中任一文件 sha 变化或消失；或库完整性校验失败 | fail-closed：拒服并告警，等待离线修复/重建 |
| 无法明确归类 | 任一比对项不能确定落入上述两类 | 按损坏处理（保守失败） |

理由：真值 jsonl 随每次对话只追加增长，两次重建间“仅新增”是常态，一律拒服会使记忆功能近乎永久
关闭；而旧文件内容被改动违反 append-only 不变量，必须拒绝。

### 4.3 staleness 观测口径

- 最小指标集：新增分片文件数、stamped 时间到当前的落后时长；可选追加未追平事件条数（由分片计数
  只读统计，不读正文语义）。
- 指标只观测、不参与门裁决；具体告警阈值与“转 on 门槛”一同在 Q4 评审拍板，代码不硬编码常数。

## 5. 重建周期与影子索引（N12/N16）

### 5.1 生产重建

- 由外部离线调度器/人工按周期调用同一 builder CLI；重建写临时产物并同盘原子 rename，授权纪律同首建。
- 周期建议（评审基线，非硬编码）：按日定时重建 + staleness 超阈值时追加一次；最终值 Q4 定。

### 5.2 影子重建

- CLI 新增 `--shadow-out <dir>` 选项（沿用现有 switch-case 参数风格），或重建到临时产物后经受控拷贝
  落 `<dataRoot>/projection/memory-shadow/`；影子重建是独立离线授权动作。
- 运行期代码**永不 import/调用 builder**：builder 不在装配白名单，WP3 投毒保证 assembly/adapters 引用
  builder 任意符号即红。
- 运行期对影子目录只有观测追加（v0.4 定案六字段：termHash/gatedStatus/legacyCount/acceptedCount/
  rejectedReasonCodes/observedMs，查询级聚合无 cardId、无 termNorm/原始查询/正文，详见 §5.3），不做索引
  构建；影子失败隔离，不阻断主链路；影子目录跨重启持久。

### 5.3 N16 执行者落点（保持装配层 fs-free）

- 影子观测追加与运行期真值指纹重算都需要文件能力，而装配层禁止 node:fs/node:sqlite 直开。
- 结论：落在 **memory 侧专用窄原语**（不经 adapters 直写）。
- **影子观测窄原语（v0.4 已实现，src/memory/shadow-write.ts）**：
  - 经窄柄第六方法 `recordShadowObservation` 到达，工厂按 indexDir 内部固定落点
    `projection/memory-shadow/shadow-observations.jsonl`，观测入参无任何路径形参，路径不泄露给装配层；
  - 沿用并收紧 miss.ts 白名单纪律：六字段键白名单、受控 GatedStatus/GateReasonCode 枚举、额外键当场
    IntegrityError；装配层只传规范化词面 termNorm，**term_hash 在 shadow-write 内部 sha256 计算、
    termNorm 与原始查询永不落盘**（比 mem_miss 留 term_norm 更严）；落盘行为查询级聚合、不带 cardId；
  - append-only（仅 appendFileSync，无更新/删除）、构造期不建目录首次写才 mkdir、写失败封装
    ok:false 不抛穿；与 sqlite 写柄物理隔离，窄柄降级只读时影子追加仍可用；
  - 装配层 M6 门显式拒绝直接 import shadow-write（投毒探针锁定），只能经窄柄第六方法；该文件入无环
    leaf 门，不依赖 store/builder/bm25 闭包。
- 指纹重算能力由 memory 内部原语包装 `computeTruthFingerprint` 暴露只读结果，装配层仍不 import
  builder（builder 整体在白名单之外）；**该指纹原语本批未实现，保持登记，后续独立评审**。
- 两原语均须经 WP3 白名单显式枚举与投毒，新增导出不会默认放行（影子原语以“窄柄方法 + 装配禁直接
  import”形态落地，而非给 assembly 开新值导入符号）。

## 6. 重置协议

- 终极重置 = **删索引 + 全量重建**，属高危操作：执行前须给出影响清单、冷备，并取得显式高危授权。
- 关键事实：rebuild 本身**保留** miss 别名（别名是索引数据，重建从真值+既有别名/账本恢复）；因此仅
  重建不会清除运行期写入的别名，必须先删库才能让其归零。
- 三份真值 jsonl 永不删除、永不改写；重置范围仅限 projection 下索引/影子。

## 7. 别名审计与撤销协议（登记项，v1 未实现撤销写入）

- 现状事实：`mem_alias.status` 枚举含 `'tombstoned'` 且预留作废时刻列，但全仓**无任何写入该状态的
  代码路径**；决策账本 action 联合为 create-card/update-cues/tombstone-card/add-alias/invalidate，
  **无别名级撤销码**；alias-write 注释亦明确“v1 不存在别名级 tombstone 写入路径”，同主键非 active
  一律 fail-loud。
- 回退语义（已在提纲 §8.3 锁定）：开关 off 只停门，已写别名继续在精确路生效，数据留存。
- 后续独立项（不在 WP1–WP4 实现）：离线别名审计报表（周期枚举 active miss 别名、来源、命中频次）+
  撤销动作（离线把指定别名置 tombstoned、账本新增对应 action、syncFts 重建），运行期窄柄不提供撤销。

## 8. 授权与全局纪律

- 所有对 memory-index/memory-shadow 的离线写、删、重建均须显式授权；真实根写/删另需影响清单+冷备。
- git 不 add/commit/stash/push；GitHub 推送前另做全历史泄露扫描并取当次授权（推送门当前关闭）。
- 本细则的数值（周期、阈值、样本量）均为评审基线，转 on 评审定量，代码与配置不得提前硬编码。

## 9. 实现状态对照

| 条款 | 状态 |
|---|---|
| 运行期只开不建、NotFound 不建库（§2） | 已实现（WP2，runtime 后端 exists 闸门） |
| 写单例 ConflictError 降级只读、写调用 UnavailableError（§3） | 已实现（WP2，runtime.test 覆盖） |
| 指纹硬原语 verifyStampedFingerprint / computeTruthFingerprint（§4.1） | 第一层既有，冻结复用 |
| 漂移二分策略与 staleness 口径（§4.2/4.3） | 协议已定，WP4 接线时实现策略层 |
| 影子 CLI `--shadow-out`、外部离线重建（§5.2） | 协议已定，离线 CLI 改造尚未做（活体影子之外的独立离线项） |
| N16 影子观测窄原语 + 窄柄第六方法（§5.3） | **已实现（WP4a 步骤2，shadow-write.ts/runtime 六方法，7 用例 + 窄柄/投毒/无环门）** |
| 运行期指纹重算窄原语（§5.3） | 协议登记，本批未实现，后续独立评审 |
| 重置、别名审计/撤销（§6/§7） | 协议登记，撤销为后续独立项 |
| WP4b 真机工具薄壳与 plugin 接线（提纲 §7.1） | **已实现并全绿（811/811）**：assembly 工厂 + dsh 薄壳 + `memoryGateMode` 默认 off；v1.3 经动态 `ctx.inject(['tools'])` 修复真机注入授权（见 §10.6） |
| WP4b 真机 function-calling 与宿主实配（§10） | **v1.4 隔离真机全项实测**：shadow/on 装载、四工具回调、gate 三态、序号成功与失效、N14 成功回显、影子六字段落盘、on 态别名真写均经真机取证（§10.1–§10.7）；on 档仅限隔离一次性验收，生产默认 off 不变 |

## 10. 真机验收清单（WP4b，离线测试无法替代的部分）

> 范围说明：薄壳的形状、信封、序号失效、N14 白名单、缺库降级、注册/注销幂等、三态行为已在离线
> node:test 全量覆盖（v1.3 起 811/811，含 v0.6 新增 2 个 inject 授权用例）。本节只列**必须在真实 dsh 宿主内**
> 才能证实的环节；v1.3 已在隔离 `DSH_HOME` + 临时数据根逐项取证，勾选与降级口径见各条注记；任一阻断项不过不得转 on。
>
> 前置纪律：优先用**演练/临时数据根**（`dataRoot` 显式指向临时目录）完成全部断言；任何对真实数据根
> `<dataRoot>` 的写、删、重建都须先出影响清单 + 冷备并取得显式高危授权，三份真值 jsonl 永不删改。
> 切换 `memoryGateMode` 到 shadow/on 本身即 Q3 显式授权动作，运行期不得自行翻转。

### 10.1 装载与工具可见性

- [x] **默认 off 零变化**（v1.3 真机通过）：不配置 `memoryGateMode` 启动，模型可调用清单为 25 个内置工具、
  **无任何 `fasti_memory_*`**，`<dataRoot>/projection/memory-index` 不被创建；插件此档不发起 `ctx.inject`
  （离线新增用例锁定 inject 调用次数为 0）。
- [x] **shadow/on 注册可见**（v1.3 真机通过）：显式配置后四个注册名 `fasti_memory_search /
  fasti_memory_cards_by_anchor / fasti_memory_resolve_pointer / fasti_memory_add_alias` 均能被模型按名真实
  function-call（必填参数校验通过、`output.schema=string` 文本信封回灌）；“恰四项”由离线注册测试断言，
  真机侧模型枚举面只见这四个 `fasti_*`、无第五项。入参对象根、required 收敛在根由 `defineTool` 编译保证（离线覆盖）。
- [x] **无 tools 服务安全跳过**（v1.3 真机+诊断 bundle 通过，口径修订）：v0.6 起为动态 `ctx.inject(['tools'])`
  子 fiber，弱宿主不提供 tools 时该子 fiber 等待依赖、回调**静默不触发且不报错、进程 `exit 0`**，主适配器
  开库/摄入/影子照常（真机诊断实测注入不存在服务即此行为）。原“留一条 warn”的表述对应 bridge 内
  `registry===null` 分支，现仅在“tools 服务存在但形态异常（无 register 函数）”时触发；服务整体缺失由
  cordis 注入机制静默 pending，二者均为安全降级，离线 `shadow 无 tools 安全跳过` 用例持续覆盖。

### 10.2 function-calling 路由与信封

- [x] **回调贯通**（v1.3 真机通过，v1.4 补齐成功面）：四个工具在真机各被模型真实发起 tool call，宿主均路由到
  `register` 注入的 `execute`、`render` 文本回到模型上下文。v1.3 在无索引库时取齐 `search` 成功、`add_alias`
  deferred、`resolve_pointer` 错误、`cards_by_anchor` 回 `unavailable` 四类信封证明链路贯通；v1.4 离线首建后
  `cards_by_anchor` 真机走**成功路径**回显 N14 卡视图（见下条）。两类信封均无内部列或库内字段。
- [x] **三态返回来源**（v1.4 shadow 与 on 均真机直证）：shadow 下 `fasti_memory_search` 真机回
  `data.source==='legacy'`、`status='legacy-ok'`（对外零扰动，旁路另落影子观测）；on 下真机经模型 function-call
  分别直证 `source==='gate'` 的 `hit`（强通道 `exact-alias-pass`）、`abstain`（`all-rejected`，工具面不回泄被拒
  明细）、`no-match`（`zero-lexical-hit`，`cards:[]`）三态。真机所有回显均无 `serialMap` 字段（序号表只在工具内部持有）。
- [x] **稳定错误信封真机呈现**（v1.4 三码全部真机直证）：真机直证未检索即解析序号回
  `serial-context-missing`、无索引库回 `unavailable`、本次检索上下文内引用不存在序号（`serials:[99]`）回
  `serial-stale`，模型侧只见 `{ok:false,error:{code,message}}` 的中文安全文案，无原始异常堆栈、无内部绝对路径、
  无 `serialMap`；多轮“先检索再用被替换旧序号”的 fail-closed 分类另由离线路径用例锁定，与真机同一条
  `classifyHostMemoryError` 路径。
- [x] **N14 真机回显**（v1.4 真机成功路径通过）：离线首建后 `cards_by_anchor` 真机成功回显，投影恰为
  `cardId/anchorIds/displayCues/channel/cardType/discriminator` 六个白名单字段，`aliasesJson/sensitive/eventId/
  weight/contentHash/entityHintJson/hitCount` 等内部与敏感列**零出现**（实测 `leakedKeys=[]`）；含 `sensitive=1`
  别名的卡同样只回显安全视图。白名单剥离的字段级强断言仍由离线 N14 用例保留。

### 10.3 生命周期与句柄

- [x] **卸载注销**（v1.3 真机+离线）：真机每次 headless 一次性会话结束均 `exit 0`，
      `<dataRoot>/projection` 下无 `-wal/-shm/*.lock` 残留（SQLite 干净关闭、句柄释放），连续多次对同一数据根
      重复 open 不报写单例 ConflictError/`SQLITE_BUSY`。四个注销函数各触发一次、底层窄柄 `close()` 被调用的
      精确计数由离线生命周期用例与变异 M3 锁定（真机 fiber 内注销计数不对外暴露，离线可逐工具断言）。
- [x] **dispose 幂等**（v1.3 真机+离线）：动态注入子 fiber 的 `child.effect` 注销兜底与主 effect cleanup
      两路都会调用同一个幂等 `MemoryWiring.dispose()`，重复卸载只生效一次；离线重复 dispose 用例覆盖，真机
      重复装载/退出未见二次注销或二次关闭错误。

### 10.4 影子落盘与数据根边界

- [x] **影子文件**（v1.4 真机成功落盘；缺库降级 v1.3 已证）：v1.4 离线首建 `memory-index` 后，shadow 下一次
      `search` 即在 `<dataRoot>/projection/memory-shadow/shadow-observations.jsonl` 追加一行，真机逐字段校验
      **恰为六字段** `termHash/gatedStatus/legacyCount/acceptedCount/rejectedReasonCodes/observedMs`，无额外键；
      `termHash` 实测逐字等于 `sha256(规范化词面)`（64 位小写 hex），文件内 `termNorm/原始查询/正文/cardId`
      零出现（明文检索词 grep 不命中）；该次观测 `gatedStatus='hit'、acceptedCount=1、legacyCount=1`，体现 shadow
      旁路门裁决与旧路召回的对照。`memory-shadow/` 与 `memory-index/` 为 `projection/` 下两个物理独立目录。
      缺库降级口径仍成立：v1.3 无索引库时 `openMemoryRuntime` 抛 NotFound、`handle=null`，影子 sink 在
      `handle===null` 直接 return 不产生文件，主链路 `search` 仍 `legacy-ok`、召回不受阻。
      别名写两态对照：shadow 下 `add_alias` 回 `deferred/gate-not-on`、零生产写；**on 下 v1.4 真机直证
      `add_alias` 回 `{ok:true,changed:true}` 并物理写入窄柄库 `mem_alias`（重复调用幂等 `changed:false`）**。
- [x] **写不出工作区**（v1.3 真机通过）：审计真机全部运行期 fs 落点，仅
      `channels.json`、`events|experiences|raw-turns` 分片与 manifest、`projection/fasti.sqlite`、
      `state/checkpoint.json`，全部封闭在显式配置的隔离 `<dataRoot>` 内，无任何数据根外写入；三级解析中
      显式 `dataRoot` 最高优先级生效；真实 `~/.dsh/fasti` 全程 mtime 不变、零写入。

### 10.5 peer 版本实配

- [x] **宿主实配启动**（v1.3 真机通过，版本更正）：真机宿主 dsh `0.2.1-rc.5` 自带 cordis 实测为
      **4.0.5**（早期稿记 4.1.0 系本仓 devDependency 锁值，非宿主实配），与 `dsh-tools` peer `~4.0.5`
      吻合；隔离 profile 以 `file:` 挂载、pnpm 安装仅 peer 警告（无碍），插件加载无 ERESOLVE、运行期无
      `ERR_MODULE_NOT_FOUND`（六个 dsh-* 对等包均由宿主提供）。
- [x] **最小宿主能力面**（v1.3 真机通过）：薄壳运行只用到 Context 的 `logger/effect/on/inject` 基础能力，
      工具服务在 `inject(['tools'])` 授权子上下文的 `tools.register`，均为 cordis 4.0.x 已有 API，不依赖更高版本；
      真机 4.0.5 与本仓 peer 声明 cordis `^4.0.1` 兼容结论成立。

### 10.6 真机 tools 注入缺陷与动态 inject 修复（v1.3 新增）

- **缺陷根因（真机原始报错）**：v1.2 薄壳在未声明 inject 的插件 fiber 内直接读 `ctx.tools`，真机 cordis
  抛 `Error: cannot get property "tools" without inject`（at Fiber.execute），`ctx.get('tools')` 亦返回
  `undefined`；离线裸根 `new Context()` 测试直接 `set('tools')` 绕过了 loader 的注入授权，故 809 全绿仍漏检。
- **修复形态（仅改 `src/adapters/dsh/plugin.ts` + 测试）**：默认 off 不发起注入；shadow/on 在
  `ctx.effect` 开库成功后用动态可选注入 `ctx.inject(['tools'], child => …)` 承载 `wireMemoryTools`，授权子
  上下文取 registry；持 `MemoryWiring` 句柄与 `disposed` 标志理顺异步回调与主 cleanup 时序（先注销后
  `fasti.close`，`child.effect` 幂等兜底）。不使用静态必需注入，避免弱宿主缺 tools 拖垮整个插件。
- **真机诊断四性质（临时 bundle，取证后已摘除）**：不静态注入主插件正常装载；注入回调内
  `child.tools.register` 为 function；注入不存在的服务回调静默不触发、不报错、`exit 0`；子 effect 注销正常。
- **回归与反证**：全量 811/811 绿（新增 inject 授权、off 不注入 2 用例）；变异反证扩至 10 条，新增
  M9（破坏 inject 依赖声明）、M10（破坏 off 不注入闸门），M4 锚点随重构迁移，10/10 击杀、还原复跑全绿；
  WP4a 三源码 sha 逐字不变、`dependencies` 仍为 `{}`、M6 依赖方向不放宽。机制细节见提纲 v0.6 §7.1（7）。

### 10.7 离线首建后的 on/shadow 成功路径真机补验（v1.4 新增）

- **首建纪律**：运行期窄柄“只开不建”，本次 `memory-index` 由**仓外一次性离线脚本**经冻结窄写
  `openMemoryWrite(...).transactionApply(...)` 写入隔离 `<dataRoot>/projection/memory-index/`（与离线测试同一
  程序化 C4 种子形态），未新增或改动任何生产代码，运行期进程始终不持有建库路径；`--data-root` 类显式隔离与
  路径守卫保证不可能指向真实 `~/.dsh`。产物为 `memory-index.sqlite` + `revisions.jsonl`（另含空 `decisions.jsonl`）。
- **确定性卡集设计**（三张 active 卡精准映射三态，锚点为合法 26 位 ULID）：
  - `mc_cafe`：CJK `displayCues=['咖啡馆约会']` + `sensitive=1` 别名“咖啡馆” → 查“咖啡馆”走 `exact-alias`
    强通道 `hit`，并承载 N14 敏感列剥离验证；
  - `mc_hike`：第二张卡（“周末爬山路线”/普通别名“爬山”），承载多卡序号与 on 态别名写；
  - `mc_weak`：`displayCues=['concatenate plan notes']` 无别名，查纯 ASCII “cat” 触发 trigram `fts-substring`
    命中却被 ASCII 词边界复核拒绝（`ascii-no-word-boundary`），全集无强卡 → `abstain/all-rejected`；
  - 查库内零词面子串的生僻词 → `no-match/zero-lexical-hit`。
- **两类证据互补**：① 模型真实 function-call（隔离 headless + scnet 自定义 openai-completions 路由，密钥仅
  环境变量）取端到端信封，覆盖 shadow 的 legacy 主返回与影子落盘、on 的三态/resolve 成功/`serial-stale`/别名真写；
  ② 确定性 node 探针在同一真实窄柄 sqlite + 真实装配工具面上直接调用（不经 LLM 选词），锁定 abstain 的具体
  拒绝原因码、`isSerialRefusable` 分类、N14 `leakedKeys=[]`、别名幂等与物理落库——三态判定正确性仍以 gate.test
  离线锁定为准，探针只复现宿主内确定性参数。
- **边界复核（全部通过）**：真实 `~/.dsh/fasti` mtime 全程不变；隔离区与全部临时日志密钥 grep 零命中；
  多次 headless 进出均 `exit 0`、无 `-wal/-shm/*.lock`、无 ConflictError/`SQLITE_BUSY`、无残留进程；运行期 fs
  落点全封闭在隔离 `<dataRoot>`（含 `memory-index/`、`memory-shadow/`）。验收结束隔离 `DSH_HOME` 与临时物按授权删除。
