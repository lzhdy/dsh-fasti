# #117 mem_miss 留存上限：四份外部评审整合裁定（定稿）

> 基线 HEAD：`4690032`（无生产码改动，本文为只读实证＋规格裁定）。
> 输入：四份单轮外部评审原件（下称 R1 写入侧 FIFO 派／R2 drain 触发派／R3 rebuild-only 告警派／R4 哨兵升级条款派）。
> 方法：每条意见先回代码实证再裁定；驳回项必须给出代码依据，失准意见坐实后记录。新证据编号 E-12 起（E-1～E-11 见 charter 第 1 节）。
> 结论形态：**采纳／部分采纳／驳回**。本文件是 #107 的闭合产物，charter 第 7 节被改判之处以本文为准并已加注。

---

## 0. 一句话总览

四家在 80% 的点上收敛（纯函数语义、不读墙钟、台账纪律、换名不 VACUUM、拒 top-N、机制先行常数后定），唯一实质分裂是 **P-1 触发面四派各一**，另挖出两个 charter 未覆盖的硬伤：**PF-1 真源可重导出性**与 **N-1 gate_status 缺列**。回代码后裁定：

- **P-1 融合裁**：drain worker 挂裁为主触发（复用既有 5 秒宿主节拍，不犯 K13）＋rebuild 同纯函数对账＋进程内哨兵只告警＋rebuild 间隔运维契约＋预注册升级条款；**写路径 FIFO 不进 v1**，降级为升级条款的触发对象。
- **PF-1 驳回乐观分支**：代码实证 raw-turns 不收 tool 事件、不存工具调用块，mem_miss **当前不可从真源重导出，"已删即毁"为真**，窗口下界走硬档，裁剪前给离线导出出口。
- **N-1 采纳加列**：mem_miss 裁定为**投影面运行期观测表（非真源冻结面）**，ON 前加 `gate_status`，schema v1→v2，现空库零迁移成本；`returned_count` 规格写明恒 0 保留位。

---

## 1. 新代码实证（E-12 ～ E-20，2026-11-15）

| 编号 | 结论 | 代码依据 |
|---|---|---|
| E-12 | **mem_miss 不可从 L0/L1 真源重导出，"已删即毁"成立**。原文员只收 `user/message`、`assistant/message` 两类，tool/turn/step/command/system 事件整体 skip；assistant 侧只取 `type==='text'` 表达块，reasoning/tool_call 块剔除；RawTurn 契约仅 7 字段（speaker/raw_text/asserted_at 等），无工具名、调用参数、返回状态。门裁决状态（no-match/abstain）只存在于运行期门输出 | `src/adapters/dsh/convert-event.ts:115-122, 82-101`；`src/contract/raw-turn.ts:29-43` |
| E-13 | **drain worker 是既有的宿主节拍，不是新定时器**：`setTimeout` 自递归、间隔默认 5000ms、失败 catch 后排下一轮；plugin 在该节拍上挂 `drainMemoryProjection(budget)`。drain 自带 closed／writer-lock-held／not-wired／budget 四级短路，短路时事务不开、全不变。同一进程内 recordMiss 与 drain 共用唯一 writer 单例与同一个 `DatabaseSync` 连接（进程内单例，二次打开 ConflictError 降级只读），node:sqlite 同步 API 天然串行；writer-lock-held 仅在离线 builder 跨进程占单例时发生 | `src/adapters/dsh/llm.ts:183-213`；`src/adapters/dsh/plugin.ts:308-314`；`src/memory/drain.ts:75-91, 357-390`；`src/memory/store.ts:583-637`；`src/memory/runtime.ts:113-139` |
| E-14 | **builder 已经是"临时库→fsync→原子 rename"形态**：apply 产物落 indexDir 内 `*.tmp-<ulid>`，fsync 后 `renameSync` 覆盖活库，任何失败清 tmp、旧库完好。评审要求的新库换名规格**现状即满足**，新库不含被删页，VACUUM 永远不需要（"VACUUM 不能在事务内"的争议随换名模式消失） | `src/memory/builder.ts:11-12, 403-414, 466-478` |
| E-15 | **`--since-revision` 是名义增量、口径不变**：参数仅做 ≥1 整数校验并写进 reason 字符串；读旧库仍是 `SELECT * FROM mem_miss` 全量、copyRows 原样搬。裁剪若实现为 copyRows 前的纯函数过滤，全量与增量两种 rebuild 走同一路径，不存在"增量模式不裁剪"的退化 | `src/memory/builder.ts:276-279, 190-228, 382, 432` |
| E-16 | **decisions 是独立 jsonl 账本，不在 sqlite**：`decisions.jsonl` append-only，rebuild 时 `readDecisions` 读取回放而非经 copyRows 入库；其增长频率＝维护动作频率，与 mem_miss 行增长不同量级 | `src/memory/ledger.ts:21, 143-149`；`src/memory/builder.ts:335-337` |
| E-17 | **加 gate_status 数据侧零采集成本、属投影面 schema 变更**：on 态调用点 `outcome.status`（'abstain'｜'no-match'）就在作用域，当前 recordMiss 未透传；写入白名单 6 键、DDL 8 列，加列需白名单加键＋DDL 加列＋`MEMORY_SCHEMA_VERSION=1` 升版，drain 遇 rules mismatch 报 rebuild-required、rebuild 新库自然带新列；`anchor_event_id/anchor_json` 已是"建表预留、v1 恒 null"先例；`returned_count` 调用点写死 0 | `src/assembly/memory-tools.ts:202-209, 240-244`；`src/memory/miss.ts:20-30`；`src/memory/schema.ts:84-96, 137` |
| E-18 | **observing 不是 stub**：shadow 分支调用的 `runShadowObservation` 与 on 态**同参调同一个 runGatedSearch**，fact 的 gatedStatus／candidateCount／rejectedReasonCodes 全部取自真实门输出；现有测试已断言 shadow 观测能产出 `gatedStatus='hit'`，三态判别力在测试夹具层面已闭环，无需对真实数据根做带卡探针 | `src/assembly/memory-tools.ts:153-180, 233-236`；`tests/assembly/memory-tools.test.ts:183` |
| E-19 | **channel 单通道是当前事实而非结构限制**：值由 bridge 配置注入（现役 'dsh'），列本身可多值；mem_miss 行数顶当前按全局口径 | `src/adapters/dsh/memory-tool-bridge.ts:93`；`src/adapters/dsh/plugin.ts` 配置注入 |
| E-20 | **Q6 是当前代码事实**：on 态 recordMiss 唯一调用点是 gatedSearch 显式工具落空分支；自动窗口（#116）全仓零调用点。另实证崩溃窗现状为 rename 先（builder.ts:474）、revision 账本后 append（:494），存在"已换名无账本"窗口，需按 N-4 改序 | `src/assembly/memory-tools.ts:242-244`；`src/memory/builder.ts:466-494` |

---

## 2. 四家共识：直接采纳（无须再辩，落到实现规格）

以下十条四家观点一致或无实质冲突，全部采纳，TDD 阶段照此实现。

1. **双闸交集语义、单一纯函数唯一权威**。唯一生存集＝窗内行按 `(observed_ms DESC, id DESC)` 取最新 min(窗内行数, K)，与操作序无关；禁两条独立 DELETE，builder 与 drain 都调同一个纯函数。行数顶只吃窗内最旧行、**永不碰最新 K 行**；K 硬 W 软（冲突时牺牲回看深度保 rebuild 成本上界，反过来 K 形同虚设）。
2. **时钟显式注入**。纯函数入参带 `asOfMs`，自身禁读墙钟、禁 Date.now()，保证可重放、同日幂等；`policyVersion` 入每条台账。
3. **P-3 时序闸驳回不做**。影子期 mem_miss 恒空（charter E-10④），"验收前禁裁剪"是空条款。真保护改为：临时常数一律取偏大端＋dry-run 报告带 `rows_deleted_within_validation_period`＋runbook 要求首次 rebuild 人工过目 dry-run。
4. **台账不折叠、不周期合并**（折叠即断审计链），每次维护动作一条汇总、固定 schema、只含聚合量；**严禁嵌被删行 term_norm/term_hash**（R3-X-2 隐私点：否则隐私等于没删），红测延伸断言台账行无词面/哈希列。
5. **P-9 接受零 LLM 能力边界，一致否决 top-N 高频不删**（自强化焊死噪声、pinned 集无界破硬顶、频次本身是被污染判据）；语义降噪归 #120，本卡裁剪只认时间与序。
6. **P-8 收口为规格条款**："rebuild 输出必须临时文件＋fsync＋原子 rename，旧文件整体回收，任何失败旧库不动，永不 VACUUM"（E-14 证实代码已如此，规格把现状写成硬约束＋红测锁残留 tmp/-wal/-journal）。
7. **不推迟**：机制现在 TDD 定死（合成夹具），常数等影子期数据；影子期治的是设计不是数据，与 Q4 排布无冲突。
8. **P-5 非双重标准，一般条款化**："写入窗有界的证据面可延后留存设计；全生命周期写入的面必须在转 on 前有机制"。shadow jsonl 转 on 即停写（有界写入窗），转 on 后封存只读归档并立卡，**不是永久豁免**。
9. **P-4 窗口下界由消费者矩阵反推**，磁盘/性能只定上界；下界顶穿上界时 rollup（方案 D）才是必然出口。冻结评审必须交"消费者×最短窗×统计口径×可否 censored"矩阵。
10. **Q6 升格为 mem_miss 定义**："她显式检索而未得的意图案底"，并写明触发重标条款——#116 若改判自动裁决也写 mem_miss，增长率、K、换算契约必须联动重标。

---

## 3. 关键裁决一：P-1 触发面四派融合

### 3.1 四方案与代码核对

| 派别 | 主张 | 代码核对结论 |
|---|---|---|
| R1 | 写路径 insertMissRow 同事务"插入＋删最旧一行"FIFO，给瞬时连续硬顶；辩称约束 4 禁的是大事务非单行 DELETE | 技术可行属实（同连接同步，store.ts:464 现为 autocommit 单 INSERT，包显式事务即可），但：①真正挡路的不是硬约束而是所有者已裁的 Q2-a/Q2-c（禁静默删除、每次维护一条台账），R1 自己也主张写入侧淘汰不逐行记账，实质是改判；②recordMiss 在对话返回前主链路（memory-tools.ts:243 同步），每次落空加 BEGIN/DELETE/COMMIT 是稳定写放大；③G-4 下增长率零数据，E-4 证明增长期无在线危害，连续硬顶的必要性尚未被证明 |
| R2 | 裁剪挂记忆投影 drain worker（5 秒既有节拍、慢路径），rebuild 为副；cutoff 按天取整使动刀 ≤1 次/天；自我否决主链路捎带 DELETE | 前提全部经 E-13 证实成立：节拍既有、四级短路、失败隔离、不犯 K13。需两处收口见 3.2 |
| R3 | rebuild-only 是"周期强界"可接受，补启动只读 COUNT 越界告警＋runbook；写路径 FIFO 仅作 Q6 改判后备 | 其只读 COUNT 告警便宜有效，吸收进哨兵；但"只在 rebuild 时才恢复不变量"不满足 R1 立的面上不变量原则，rebuild 漏跑时无任何强制力，不作为唯一面 |
| R4 | 保留 Q2-a，加进程内哨兵（打开 COUNT 播种＋递增＋0.7K warn，零删除）＋rebuild 间隔契约＋预注册升级条款；指 FIFO 与 Q2-c 正面冲突 | 三件套全部采纳，与 R2 主触发互补不冲突 |

### 3.2 裁定：drain 主触发 ＋ rebuild 对账 ＋ 哨兵 ＋ 契约 ＋ 升级条款

**v1 触发面（五件套）**：

1. **drain worker 为主触发（连续有界）**。在 drain 编排内、`transactionApply` 之外新增独立的 miss 保留集计算：每轮先用只读 `MIN(observed_ms)`/COUNT 类索引 seek 判断是否越界，**未越界不开任何写事务**（5 秒节拍下绝大多数轮次零写成本）；越界才调裁剪纯函数并在一个事务内完成范围 DELETE。cutoff 按 UTC 日界取整，保证同一天内任意多轮 drain 结果幂等、实际动刀 ≤1 次/天。
2. **rebuild 为对账/兜底面**。builder 调**同一个** `miss-retention` 纯函数后再 copyRows，保证日常裁剪与重建语义单一口径、可交叉对账；两种 rebuild（含 `--since-revision`，E-15）同路径。
3. **进程内哨兵（零删除）**。store 打开时一次 `COUNT(*)` 播种，recordMiss 后递增，越过 0.7K 发一条 warn（仅打开/越界时刻，不进每轮路径）。吸收 R3 的越界告警与 R4 的软阈哨兵。
4. **rebuild 间隔运维契约**。runbook 与 #91 转 on 检查单写明"转 on 后至多每 X 天一次 rebuild 或证明行数未越软阈"，X 由标定期日增 P95 反推使 X×P95 ≤ K/2。
5. **预注册升级条款（不现在做）**。哨兵连续两次启动都告警（＝两次启动间无人跑 rebuild 且 drain 裁剪未能压住），才立卡评估"写路径有界逐出＋聚合记账"，届时正式走 Q2-a/Q2-c 改判记录流程。R1 的 FIFO 在此挂起，不进 v1。

**这样如何回应 R1 对 rebuild-only 的根本批评**：R1 立的三条统一不变量（稳定序连续前缀、纯函数不读墙钟、上限是面上不变量而非周期动作）**全部采纳进规格**。drain 每 5 秒一轮的 level-triggered 检查使"生存集恒满足不变量"成为连续保证——不满足才修，而不是只在人工 rebuild 时才恢复；同时不碰对话主链路、不推翻静默删除纪律。R1 要的"面上不变量"由 worker 兑现，R1 要的"写路径硬顶"在零数据阶段属过度工程，挂升级条款。

**对 R2 的两处收口**：①裁剪不搭 `transactionApply` 的便车（无卡变化轮不进 apply），独立判定后单独开事务，但纯函数与 builder 共用；②R2-F-4 锁阻塞要求采纳为红测——E-13 证实同连接同步执行，drain 事务期间占用事件循环，故红测断言裁剪事务在 K 候选量级内的耗时上限（天级至多一次、千行量级应为毫秒级），超上限即设计回退信号。

**驳回记录**：R1 的写路径 FIFO 作为 v1 默认方案——**驳回**（依据：Q2 所有者裁定＋主链路写放大＋G-4 无数据支撑），其三条不变量与启动 COUNT 校准**采纳**。R3 的纯 rebuild-only——**部分驳回**（保留 rebuild 面但不作唯一触发）。

---

## 4. 关键裁决二：PF-1 真源可重导出性

R4 提出"已删即毁"是未证前提：若真源含完整工具调用与返回，mem_miss 是可离线重导出的缓存，窗口可更软。R1 持相反推断（rebuild 需 copyRows ⇒ 不可重放）。

**实证裁定（E-12）：R4 乐观分支驳回，R1 定性成立。** 原文员在入口就丢弃 tool 事件与 tool_call 块，她搜了什么词（工具参数）和门怎么判（工具返回）都不进 raw-turns；experience 是复盘折叠产物，也不含逐次门裁决。当前架构下 mem_miss 行是"某时刻索引态对某查询的裁决事实"，删后无法重建。

连带裁定：

1. **窗口 W 下界走硬档**：W ≥ max(K1 漏召率度量门最长回看期，#120 建议器最短有效观察窗，#92 趋势窗)，具体值由消费者矩阵盖章。
2. **裁剪前给离线导出出口**：dry-run 支持一次性 `--dump-miss` 导出到独立 `--out` 库（复用 run-memory-audit 独立库模式，不新增生产写面），不可重导出证据在删除前可人工保全。
3. **R4 P-6 的"真源哈希回验 ETL"部分驳回**：该 ETL 要求从真源工具参数取原查询重算 term_hash，但 E-12 证明词面不在真源，ETL 无米下锅。term_hash 一致性改由**共用纯函数单一口径**保证（`computeMissTermHash`，miss.ts:33，shadow jsonl 与 mem_miss 同函数），红测锁两面对同词面哈希相等。
4. **挂账新小卡（R4-N-9）**：mem_miss 在投影重建失败链上是孤儿，PF-1 实证后立"miss 事件真源归属"小卡，本卡不动其存储位置。
5. 留存未来翻案条件：若日后真源契约扩记工具调用参数/返回并经评审，PF-1 需重新实证，窗口档位可随之放宽。

---

## 5. 关键裁决三：N-1 gate_status 加列与 mem_miss 归类

**归类显式裁定（回应 R4 约束归属请求）：mem_miss 是投影面运行期观测表，不是 L0/L1 append-only 真源冻结面。** 依据：它位于投影库 memory-index.sqlite、与 mem_card 同库、builder rebuild 经 copyRows 全量搬运（E-15）、可由机制裁剪；真源冻结面是 raw-turns/experiences/events 的 jsonl。故给 mem_miss 加列**不触约束 2（禁新增真源字段）**，但属投影 schema 变更，走版本演进。

**采纳 R4-N-1（时点敏感，ON 前落地）**：

- DDL 加 `gate_status TEXT NOT NULL`（CHECK in 'no-match','abstain'），白名单加 `gateStatus` 键；on 态调用点把现成的 `outcome.status` 透传（E-17，零新增采集）；shadow jsonl 已有同名字段，两面口径对齐。
- schema v1→v2：drain 遇 rules mismatch 自然报 rebuild-required，rebuild 新库带新列；现役库为空，零数据迁移、零代际混合。ON 后再加才会产生旧行空值的混合 schema，这是必须赶在 ON 前的原因。
- 分拣价值（R4-P9）：abstain＝有候选被布尔门拒＝词面/别名缺口（addMissAlias 对症）；no-match＝零候选＝内容缺口（别名无用）。#120 建议器立项的分桶前提。
- **`returned_count` 裁决**：实证调用点恒写 0（E-17），规格明确写"保留位、v1 恒 0"，不在本卡语义化为 candidateCount（YAGNI；#120 确有需要再走版本）。
- 红测：CHECK 约束、白名单拒非法键、旧 schema 缺列拒写、静态门 schema 测试与契约快照同步更新。

**#120 数据面硬伤登记（R1 风险4／R3-X-4／R4-N-1 共同指向，本卡不代解）**：D-1 想要的"miss 事件↔命中 cardId 关联"在现结构不可能——mem_miss 无 card_id 列、只记落空不记命中、通道二零 recordMiss。#120 立项稿必须先书面澄清数据面与 #116 anchors 的衔接，再谈建议清单；gate_status 只解决缺口分拣，不解决命中关联。

---

## 6. 标定与冻结：G-4 两段式 ＋ P99.9 公式废止

R1（时序悖论最尖锐）与 R4（PF-3 统计不可估）会合点裁定如下，R3 的"机制/常数解耦"精神保留并显式化：

- **段一（现在～#91 验收）冻结构不冻数字**：冻结裁剪机制、schema v2、纯函数签名、台账固定 schema、结构上界形态；常数位放显式标注"待标定"的**偏大临时值**，红测锁其临时身份，禁止叙事成定稿、禁止进任何 SLA。
- **段二（转 on 后满一个观测窗）一次性工程复核**：用真实数据冻常数并固化 `policyVersion` 入台账；影子期 T0 须在重启后的启动日志固化时间戳（R1 风险11 采纳），≥2 周从 T0 起算。
- **废止 P99.9 公式（R4-PF-3/N-5 采纳，统计上成立）**：14～60 个日样本估 1/1000 分位教科书级不成立，是换皮拍脑袋。改为 **K ≥ 观测期 max 日增量 × 安全系数(≥2) × W 天**，宁大勿小——估小了在爆发期吃掉的恰是要分析的证据，估大了只让 rebuild 略贵，误差不对称。
- **标定采信前置＝结 S-8**（R4-N-8／R1 风险10）：YAML 1.1 把 `reasoningEffort: off` 解析为布尔 false 的陷阱未了结，错配置工况下整条行为链偏离稳态；未在启动日志确认实际取值前，影子期数据不得用于定标。
- **换算契约收窄（R4-P-6 采纳）**：`population := trigger=explicit ∧ gatedStatus ∈ {no-match, abstain}`，按 trigger 分桶，#116 通电后自动事件单独成桶并对混桶报警；shadow 观测行补 trigger 源字段与 #116 立项捆绑。
- **双 schema 体积标定（R3-X-1 采纳）**：#116 后 anchor_json 填充使单行变大，K/体积上界按空 anchor 与填充态两种行形分别标定；R3-X-4 建议器有效历史＝post-#116 填充行 ∩ 留存窗，转交 #120。

---

## 7. 其余新增点逐条裁定

| 编号 | 意见 | 裁定 | 落点 |
|---|---|---|---|
| N-2 | 盖章漏召口径＝通道一 gatedSearch 显式调用落空（单边案底，通道二零记账） | 采纳，写进规格与消费者契约 | 规格术语节 |
| N-3 | `--since-revision` 与裁剪交互未定义 | 实证见 E-15：口径本就不变，规格写明两模式均过同一裁剪纯函数，红测各覆盖一次 | 实现红测 |
| N-4 | 跨存储崩溃窗：台账须先 append、rename 后行，带 kept contentHash | 采纳且为必办。E-20 实证现状顺序相反（rename:474→append:494），实现时改序：台账先写（含 kept 集合 contentHash）→fsync→rename；下次打开 level-triggered 校验，容忍"台账多记未遂"，杜绝"已删无账"。#42 N7 同构 | 实现必办＋红测 |
| N-6 | channel 单列假设、多通道行数顶互踩 | 采纳：规格声明 v1 单通道 'dsh'、行数顶全局口径；多通道启用卡必须显式改分桶或声明互踩，不得静默 | 规格注记 |
| N-7 | rollup 丢 term_norm 与建议器"输出补什么词"冲突 | 采纳为 D 挂账反约束：方案 D 解除挂账时禁止丢弃 term_norm | charter D 块补注 |
| R1 风险9 | fasti-accept 与 fasti-web 共享数据根的并发写 | 实证两 profile patch 的 dataRoot 同为 `/home/user/.dsh/fasti`；跨进程有写单例 ConflictError→只读降级保护（store.ts:592-596），runbook 仍须明文禁止两身体同时对该根跑 `--apply` | runbook |
| R1 风险7/R2-F-2 | observing 短路是否真跑门裁决 | 实证 E-18：同一 runGatedSearch＋测试已覆盖 hit，疑虑闭环，不再造生产探针 | 闭环 |
| R2-F-1 | 可重放判据应是幂等＋台账可审计而非双跑逐行相等 | 部分采纳：函数确定性（同输入行集＋asOfMs＋policyVersion→同 survivor）与台账审计两者都要，不互相替代；因 E-12 不可重导出，"双跑逐行相等"本就不可行 | 规格 |
| R4 dry-run | 增验证期删除字段、window_compressed 高亮 | 采纳 | CLI 报告 |
| R4 自我否决5 | 不在影子期生产表试剪 | 采纳，机制验证只用合成夹具与临时 DSH_HOME | TDD 纪律 |

---

## 8. 裁定后的实现规格摘要（给 #106 TDD 的硬口径）

**纯函数（唯一语义权威，零 IO、不读墙钟）**：

```
computeMissRetention(rows, { asOfMs, windowDays, hardCapK, policyVersion })
  -> { survivors, droppedAgeOut, droppedOverflow, cutoffMs,
       windowCompressed, totalBefore, kept, keptContentHash }

cutoffMs         = floorToUtcDay(asOfMs) - windowDays * 86400000   // 日界取整，日内幂等
withinWindow     = rows.filter(r => r.observed_ms >= cutoffMs)
ordered          = withinWindow.sortBy(observed_ms DESC, id DESC) // 同毫秒 id(ULID) 决胜
survivors        = ordered.first(hardCapK)
droppedAgeOut    = rows - withinWindow                            // 归因第一顺位
droppedOverflow  = withinWindow - survivors                       // 归因第二顺位
windowCompressed = withinWindow.length > hardCapK                 // 显影字段
```

**台账固定 schema（decisions.jsonl 一条/维护动作，无词面无哈希）**：
`event='miss-retention', policyVersion, revision, atMs, asOfMs, cutoffMs, windowDays, hardCapK, totalBefore, droppedAgeOut, droppedOverflow, kept, windowCompressed, keptContentHash`。

**红测最小集**：0 行/恰满/越界一行；取 K 最旧→红；摘天数闸→红；摘 windowCompressed→红；同毫秒稳定序；asOfMs 注入（函数内无 Date.now）；drain 与 builder 两路同输入同 survivor；drain 未越界零写事务；裁剪事务耗时上限；台账无 term_norm/term_hash 列；N-4 崩溃序（模拟 rename 前失败见台账未遂、下次打开校验）；新库无 tmp/-wal/-journal 残留；gate_status CHECK 与白名单；schema v2 静态门。

**v1 不做清单**：写路径 FIFO 淘汰、top-N 保护、rollup/聚合表、运行库 VACUUM、独立 prune 入口、新定时器/守护进程、任何真源字段变更。

---

## 9. 对 charter 第 7 节改判的登记

| 原裁定 | 外审后状态 |
|---|---|
| Q2-a 删除面唯一（只随 rebuild） | **改判**：删除可由 drain worker 维护事务触发（3.2 五件套），rebuild 改为对账/兜底面；"禁止独立 prune 入口、禁止主链路捎带删除"维持 |
| Q2-b 默认不做 VACUUM | **升格**：换名模式下"永不 VACUUM"写成硬规格（E-14） |
| Q2-c 每次裁剪一条台账、禁静默删除 | **维持并加严**：固定 schema、只含聚合量、严禁词面/哈希、N-4 提交序改台账先行 |
| Q4 验收前冻常数 | **改写为两段式**：段一冻机制＋偏大临时值，段二满窗工程复核；P99.9 公式废止改 max 日增×≥2×W |
| Q1 双闸"谁先触发听谁" | **语义收口**：交集 survivor 纯函数、K 硬 W 软、稳定序与显影字段定死 |
| 范围五条 | 维持，增补 gate_status 加列为 v1 第 0 批结构变更（第 5 节） |
