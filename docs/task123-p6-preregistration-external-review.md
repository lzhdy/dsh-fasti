# #123 P6 预注册方案 · 独立外部对抗评审报告

- 评审日期：2026-11-18
- 评审身份：独立外部评审，未参与 `docs/task123-p6-preregistration.md`（下称「方案」，73 行）撰写
- 评审方式：逐条重读权威正本与裁定原文、逐文件复核真实代码；所有结论附 `文件:行号` 证据；未引用 `docs/history/` 归档；未访问或写入真机数据根 `/home/user/.dsh/fasti`；全程只读，未改源码、未执行 git 写操作
- 权威来源（效力从高到低）：
  1. `docs/architecture-design-spec.md`（下称「正本」，1645 行）
  2. `docs/memory-retrieval-words-review-adjudication.md`（下称「裁定」，375 行）
  3. `tests/fixtures/memory/README.md`（下称「README」，39 行）
  4. `src/`、`scripts/`、`tests/` 下真实代码
- 标注约定：【权威】＝权威来源有明文；【建议参数】＝评审提出的冻结建议，三份权威无明文，须主控逐项签字，不得冒充权威口径。

---

## 一、总体结论：**有阻断项，不得按现稿冻结**

方案的路线定性（只评路线 A 在自身边界内的正确性）、对路线 B/C 的边界登记（方案 :9-11、:66）方向正确，且若干红线经代码复核**属实守住**：审计链路零向量/embedding 依赖、`CURRENT_RULES_VERSION` 唯一赋值仍为 `rules-v1`、布尔门对 like 弱通道构造性拒绝、夹具白名单与正文投毒红测存在、审计 CLI 对记忆索引库以只读方式打开（详见 §五「已守住项」）。

但现稿存在 **6 个阻断项**，核心是三个互相咬合的问题：

1. **判过规则不可计算**：方案一边把 R1=0.85 称为「观测值、非门禁」（方案 :34），一边又要求判「全过」（方案 :57），「趋零」「不得下结论」均无布尔闭环；且 `holdout ≥40` 与「95% CI 半宽 ≤0.05」在数学上不相容（§二 B1）。
2. **分层豁免的几何前提与现行代码错配**：方案 S3 赖以论证「结构不可达」的「trigram 下限 3」是**经历库投影侧**常量；记忆侧经 #124 已改为 bigram、准入阈值 3→2（正本 :921；`src/memory/bm25.ts:30-31`）。真正挡住 S2–S4 误命中的是「原文字段子串复核＋布尔门」，而把这条机制前置到夹具加载期的硬拒校验**一行代码都还不存在**（§二 B2、B3）。
3. **冻结口径依赖的统计与产物当前产不出来**：题级 iid bootstrap 无卡簇版本、LOEO 只有标签没有逐折回算、四态/弃权探针在 CLI 主链路根本未接线、现有合成 harness 手写 cue 而不走 key_points→cue 派生链（§二 B4–B6）。

按正本 :1563「任一条不满足，`rules-v1` 冻结继续生效」，上述阻断项整改并重新独立复核前，不得进入冻结/签字流程；整改后本预注册须带着 §七 的布尔判据重新走冻结。

---

## 二、阻断项（必须改，否则不得冻结）

### B1 ｜「全过」没有可在 holdout 上计算的布尔判据，且样本量与精度要求自相矛盾

- **R1/R2 软硬双标**。方案 :34「经验初值 0.85（观测值，非自动发布门禁）」，方案 :35 却把 R2 写成硬约束「总 ≤0.05」；方案 :57 又规定解冻前置＝「本预注册全过＋主控显式授权」。权威原文是：正本 :625「阈值为观测期经验初值，harness 校准前只观测、不卡发布、不写进任何自动拦截逻辑」；正本 :1235「R1／R2／R3 ≥0.85／≤0.05／≥0.8 观测经验初值，非发布门禁」；裁定 :174②「未校准阈值只作观测初值，不作硬拦截」；正本 :1563「P6 五层金标全过＋主控显式授权」。0.85/0.05 在 P6 离线门里到底是不是硬阈值、看点估计还是区间，现稿全部悬空，事后可朝两个相反方向解释。
- **「wrong-commit 趋零」无数值定义**。方案 :19、:21、:23、:36 反复使用「趋零」，但权威中唯一的 0 容忍明文是正本 :630 的「五类高危断言……趋近 0（0 容忍计数）」；R2≤0.05 的分母是「DRM 诱饵对等近邻判别选错卡比例」（正本 :630），不是 S2/S4 层内样本。三份权威对 S2/S4 普通 wrong-commit **没有**计数或比率上限。50 条样本里错 1 条还是 3 条算「趋零」，无分母、无整数上限，事后任意解释。
- **CI 闭环在「不得下结论」处中断**。方案 :38「95% CI 半宽 ≤0.05 才允许下结论，不足即『不得下结论』」，方案 :39 扩样至 ≥300/≥300 后即停笔；裁定 :215-216 同样只写到扩样上限。扩样封顶后半宽仍 >0.05 时冻结态结论是什么（不过/暂缓/放行），无明文。裁定 :215 括号指向的正本 §7.4（正本 :753-757、:1238「四态各 ≥200 条或 ≥2 周取晚者」）也没有这一处置。
- **holdout=40 与半宽 0.05 数学不相容**（评审按 Wald 正态近似实算，按事件簇重采样只会更宽）：p=0.85 时 95% 半宽在 n=40 为 **0.111**、n=50 为 0.099、n=200 为 0.0495、n=250 为 0.044、n=300 为 0.040；最保守 p=0.5、n=40 时半宽 0.155。裁定 :215 自证「按 p≈0.85 估算 n≈200」。若 40 条再按五层切分（每层约 8 条），层内半宽约 0.25，永远无法满足 ≤0.05。「终判只认 holdout」（方案 :28；裁定 :214）与「半宽 ≤0.05 方可下结论」（裁定 :215）在 holdout=40 的规模下不可能同时成立，必须在冻结时二选一化解（见 §七）。
- 证据：方案 :27-28、:34-39、:57、:70-71；正本 :625、:630、:1235、:1238、:1563；裁定 :174②、:214-216。

### B2 ｜ S3「trigram 下限 3 结构不可达」引用了错误子系统的几何，分层豁免前提悬空

- 记忆卡检索侧的最短查询码点是 **2**，不是 3：`src/memory/bm25.ts:30-31` 注释与常量明示「#124 bigram 几何；经历库 trigram 常量在 projection 侧独立保留」「`MIN_FTS_CODEPOINTS = 2`」，`:124` 以 `>= MIN_FTS_CODEPOINTS` 为 FTS 门槛；CJK 两字滑窗在 `src/memory/bigram.ts:75-77`。
- 「trigram 下限 3」真实位置是经历库 L1 投影：`src/projection/sqlite.ts:38-39`「trigram 预筛所需的最小查询长度」`MIN_TRIGRAM_LENGTH = 3`，`:473` 消费。裁定 :201 的同句结论本就标注在 `projection/sqlite.ts:39`，且裁定基线为 d34a3bf（裁定 :4），早于 #124。
- 正本 :921 台账明确登记 #124「应用层 CJK bigram……FTS tokenizer trigram→unicode61，记忆侧准入阈值 3→2（与经历库常量拆分、experience_fts 不动），命中复核改对原文」。
- 现行代码下 S2/S3 真正的结构性拒收机制是两道：① FTS 命中后对**原文字段**做子串复核，`src/memory/bm25.ts:141-144` 调 `matchesSubstring(normalizeQuery(field), q)`，其定义为 `haystack.includes(needle)`（`src/projection/types.ts:209-214`），即整条归一化查询必须被某条 cue/非敏感别名包含；② 布尔门 `src/memory/gate.ts:107-119`，fts-substring 需 ASCII 词边界（:113-116），仅剩 like-fallback 时无条件 `accept:false, reasons:['like-only-weak-match']`（:118-119）。
- 后果：方案 :20 用「无 ≥3 码点连续共享→trigram 不可达」论证 S3 整层 wrong-abstain 是系统天花板，**依据张冠李戴**；「无 3 码点共享」并不能推出 bigram 不相交（两段文本可共享一个 2 字 bigram 而无 3 字连续串）。方案 S2「共享 ≥1 个 2 字内容词但**非连续子串**」（方案 :19）字面上也存在张力——共享一个 2 字词就是共享 2 码点连续片段。结论方向（S2–S4 预期弃权）在现代码下可由「子串复核＋门」支撑，但方案冻结的**论证理由是错的**；陈旧痕迹还残留在 `src/memory/types.ts:240`（注释仍写「trigram FTS MATCH」）。更严重的是：能把该结论变成强制保证的「加载期连续子串硬拒」目前不存在（见 B3），即天花板豁免在代码上既无旧依据、也无新闸门。

### B3 ｜ §5 三条机械防自证硬校验全部未落地，「红测先行」当前不成立

- **连续子串硬拒：无实现、无红测**。方案 :43 要求「S2–S4 查询若是目标卡 `cue_text` 的连续子串，加载期硬拒」（裁定 :217 同文）。实测 `src/memory/audit/` 全目录无 substring/includes/重合类加载校验；纯校验器 `fixtures.ts` 刻意不 import store/门面（`fixtures.ts:8` 注释），条目只含 `eventId`/`targetEventId`（`fixtures.ts:28-40`），根本拿不到卡内 cue 文本，硬拒只能在编排层 join 后实现——该编排层代码不存在。
- **trigram 重合剔除：可建但未建，且「超阈」无阈值**。方案 :44 要求「与 key_points 的 trigram 重合率超阈条目剔除」，但未给阈值与分母（权威同样未给数值）。数据流经核实**可建**：投影折叠保留 key_points（`src/projection/event-row.ts:67`、`src/projection/types.ts:91`），运行时可经读柄取卡（`scripts/run-memory-audit.ts:405`），trigram 工具已存在于投影侧（`src/projection/jsonl.ts:51,58-65`），audit 目录未 import 它。落点必须在编排层而非 `fixtures.ts` 纯校验器，且冻结文本必须先写明阈值。
- **A 零别名：加载器不强制**。方案 :45 要求「A 评测零别名注入」；但 `fixtures.ts:146-158` 对 L0 aliases 只校验 `source∈{'miss'}` 与 `sensitive∈{0,1}`，**不禁止 A 夹具携带别名**。唯一的 sensitive 约束是测试文件内的 helper `assertMissAliasFixture`（`tests/memory/fixtures-discipline.test.ts:42-56`），它没有被加载器或 `run-memory-audit.ts` 调用（全文件 grep 无引用）；该测试文件仅 3 个用例（:58-62 证明能抓住旧口径、:64-69 放行 sensitive:1、:71-76 非 miss 不受限），无子串、重合、层 schema、零别名红测。
- **随库夹具仍是裁定要求作废的旧口径**。`tests/fixtures/memory/gold-l0.json:9` 与 `:18` 两条 miss 别名均为 `"sensitive": 0`，与裁定 :120-122（E-12）「生产 miss 别名恒 1……量到的是生产不存在的召回面」、裁定 :218「B 夹具必须 sensitive:1、A 零别名」直接冲突。方案 :45「现有 fixtures-discipline 已锁该反例」的措辞把「测试 helper 能抓旧口径」说成了「夹具口径已闭环」，属过度陈述。harness 合成根还在人手写 miss 别名（`tests/qa/qa-memory-harness.test.ts:958、:984-993`）。
- **裁定 :205 空格变体红测无代码落点**。裁定 :205 明文要求「`3 加 5 等于 8`(cue) 对 `3加5等于8`（用户输入）判 miss，进 S4 夹具」；在 `tests/` 全仓检索 `3加5`/`空格变体` 等零命中。现有规范化测试只验证函数输出形状（`tests/memory/bm25.test.ts:203-212`），而 `normalizeQuery` 是 `\s+→单空格` 而非删空格（`src/memory/bm25.ts:46-48`），两个串归一化后仍不相等——红测要求本身未被任何夹具/加载器锁定。
- **白名单只挡字段名，挡不住 queries 字符串正文回抄**。`fixtures.ts:102-108` 对越键字段抛 IntegrityError（投毒红测见 `qa-memory-harness.test.ts:328-336`，属实有效），但 `queries` 是合法字符串数组，照抄 key_points/summary 正文没有任何来源溯源字段可拦。方案 §6 的独立出题纪律在代码里没有强制落点。

### B4 ｜ 卡簇 bootstrap 不存在、样本单位与「每层 50」不自洽，且 LOEO 只有标签没有交叉验证

- **现状仅题级 iid 重采样**。`src/memory/audit/metrics.ts:70-88` `percentileCI` 在 :79-85 对传入数组逐元素有放回抽样；聚合入参 `AggregateInput`（:131-141）无任何簇/事件分组字段，`aggregateMetrics`（:163-212）无按 eventId 归组逻辑。方案 :38「须补齐/核实按卡簇版本」的自述诚实，但这意味着裁定 :174③「bootstrap 重采样按卡簇做（同一事件的多条样本不独立）」当前**无代码承载**。
- **合成结构下簇级有效 n ＝事件数，而非题数**。harness 的 `makeAuditableRoot` 每轮造 1 经历/1 事件（`qa-memory-harness.test.ts:890-900`），`seedCards` 每事件 1 卡（:953），`writeSyntheticFixtures` 每事件 L0 仅 1 条 query（:1043）、每经历 L1 1 问（:1053），实测 10 事件只得 20 条 gold（:1232）。若每层凑 50 题却只来自十几个事件簇，簇级重采样下半宽 0.05 基本不可达（B1 的算术再乘上簇内相关设计效应）。方案没有冻结**最少事件簇数**与**每事件每层出题上限**，留下「题数达标、簇数不足」的凑数空间。
- **LOEO 名实不符，而 C5 预期主路径正是 LOEO**。`scripts/run-memory-audit.ts:471-477` 仅根据 `calendarWeeks < MIN_CALENDAR_WEEKS` 把 `notes.holdout.mode` 标成 `'loeo'`、`folds = truth.events.length`；全文件没有留一事件逐折剔除/重放循环，`replayGold` 是单遍全量回放（`src/memory/audit/gold.ts:53-87`）。README :29 明示「当前 10 个 ready 事件，C5 合成与 C6 真实首跑均预期走 LOEO」——预期采用的验收模式在代码里只是一个报告标签，数字仍是全量单遍结果，违反 README :28「禁止伪装独立 holdout」的同源纪律精神。

### B5 ｜ 构念效度风险：现有 harness 绕过 key_points→cue 派生链，P6 可能测的不是路线 A

- harness `seedCards` 直接人手写 `displayCuesJson`（`qa-memory-harness.test.ts:957`），而 A 的派生函数 `deriveCuesFromKeyPoints` 仅在 rules-v2 白名单启用时进入建卡路径（`src/memory/cue-derive.ts:26`；`src/memory/builder.ts:449-455`）；rules-v1 下沿用旧快照。若 P6 五层金标沿用「手写 cue」的合成方式，评测的就不是 #123 的确定性派生投影，而是出题人自编检索词，R1 不再回答「A 在自己边界内是否正确」。
- 审计 run 的 `modelTag` 硬编码 `'rules-v1'`（`scripts/run-memory-audit.ts:500`），离线临时根即使改走 rules-v2 派生，记录标签也不会自动反映，事后可凭标签口径解释结果。
- 冻结文本必须强制：C5 临时根的卡一律经 `deriveCuesFromKeyPoints` 由合成 key_points 真实派生（测试/临时根内允许的开关范围受裁定 C2 约束，见 I2），并把实际派生规则版本写入 run 信封；禁止手写 `displayCues` 充当 A 产物。

### B6 ｜ 四态与 correct-abstain 在 CLI 主链路未接线，冻结判据没有数据产物可算

- 方案 :36 要求四态「逐层出数」、弃权题要求 correct-abstain。但 `scripts/run-memory-audit.ts` 全文 grep 不到 `summarizeFourState`、`loadAbstainFixtures`、`computeRates` 任何调用：`four-state.ts:105-166` 的汇总纯函数与 `rates.ts:52-74` 在编排层无消费方；`loadAbstainFixtures` 仅被 `tests/memory/four-state.test.ts:244-253` 引用；README :23 规定独立加载的 `abstain.json` 在 CLI 路径从不加载。
- 即无金标题（hasGold=false）的 correct-abstain 分母在主报告中不存在，R2/四态的分母事后可被悄悄换成「仅有金标题子集」。冻结判据若包含 correct-abstain（理应包含），其采集链路必须先补齐并纳入加载契约，否则 §七 的布尔式无从计算。

---

## 三、重要项（应改）

### I1 ｜「只读审计 CLI、生产零字节写」的表述对 dataRoot 整体不成立

- 记忆索引库只读属实：`src/memory/store.ts:640-649` 以 `new DatabaseSync(file, { readOnly: true })` 打开；FTS 快照同样只读（`scripts/run-memory-audit.ts:303`）；`--out` 越出 dataRoot 守卫（:137-141、:585-589）、`--dry-run` 不写审计库（:506-514）均有效。
- 但 `runAudit` 在 :403 调用 `Fasti.open({ dataRoot })`，其启动序列执行 `reconcileOnStartup()`、`startEventLayer()`、`syncEventProjection()`、`startClosureSweeper()`（`src/api/index.ts:314-323`），`initEngine` 末尾无条件 `this.checkpoint.save()`（`src/api/index.ts:359-361`，落盘见 `src/runtime/checkpoint.ts:121` `writeFileAtomic`）；事件层 `sweepOrphanMarks` 存在 `appendVersion` 追加通路（`src/event/segmenter.ts:407-444`，:439）。`FastiOptions` 无 readOnly 开关（`src/api/index.ts:119-125`）。
- 现有「零写」测试只比对 `memory-index.sqlite` 单文件字节（`qa-memory-harness.test.ts:1086、:1107、:1231`），未哈希事件 JSONL、checkpoint、L1 投影。C5 合成根下无碍，但方案 :61「生产零字节写」若被理解为可对 C6 真根直接跑审计则有写入风险。须改为「记忆索引零字节写」，并在真根解封前提供只读门面或审计前后全根哈希比对。

### I2 ｜ 裁定 C2/C3 两条硬条件全文漏登记

- C2（裁定 :166、正本 :1542-1543）：生产只认 `CURRENT_RULES_VERSION`，不设 A 专属运行期 flag，「flag 只允许存在于测试/临时根」。方案 §9（:66）只锁 gate/常量/版本，未锁运行期开关，留下「临时 flag 开第二种投影却不违反字面承诺」的口子。
- C3（裁定 :167）：A 生效后 closure 侧任何影响 key_points 风格的 prompt 改动都构成 A 的再触发条件、评测必须重跑。方案无任何重跑触发登记，prompt 漂移后可沿用旧解冻结论。

### I3 ｜ 四态归类规则、两类分母、零分母、hasGold 拆分未冻结（权威未定值）

- 哪些样本算 correct-commit（top1 还是 top-k=3）、wrong-commit 是否按有/无金标拆分、零分母记 0 还是 N/A、wrong-abstain 如何防止被用来刷低 R2，三份权威均无口径。必须在冻结时写死并落到统计校验器；尤其要隔离两个分母：R2 的诱饵判别分母（正本 :630）与 S2–S4 层内 wrong-commit 分母，禁止互相背书。

### I4 ｜ provenance「100% 硬失败」与 20% 抽样实现存在口径差

- 正本 :688 原文「抽样溯源，窗口内锚点解析率必须 100%，否则硬失败」；代码 `provenance.ts:50-83` 按通道分层 Fisher–Yates 抽样（默认 ratio 0.2），硬失败条件实际还包含 dangling=0、缓存无漂移、FTS 可溯源（:141、:153）。抽样比与「窗口内 100%」的字面关系、未抽卡如何计入口径，须在冻结文本写明；评审建议 C5 阶段全量核验锚点（见 §七）。

### I5 ｜ R3 未声明 N/A 空置

- 正本 :631「叙事线未建前按 N/A 空置，不许造数」；代码现状确为空置（`consistency.ts:62-64`；CLI 传空 pairs，`run-memory-audit.ts:428-434`，harness :1201-1212 锁定 n-a）。方案 §4 对 R3 只字未提，事后既可能补造 R3 数充门面，也可能被解释为「本门不考」。须显式写明 P6 阶段 R3=N/A、不参与达标合取。

### I6 ｜ 样本量构成关系未冻结

- 方案 :27-28 未写 holdout 40 是否含在总 200 内、诱饵 100 对是否计入总量、五层如何向 holdout 切配额。结合 B1 的半宽算术，若不冻结包含关系与分层配额，可把易样本留给 holdout、难样本留在调参集，或重复计数凑量。

### I7 ｜ 独立出题与 holdout 封存偏口号，缺工程强制

- 方案 :50-52 规定独立上下文、施工侧终判前不得读取 holdout 分布；工程上 `--holdout` 只是一个随时可传的旗标（`scripts/run-memory-audit.ts:266、:472`），无封存态文件、无内容哈希、无读取审计；README :30-34 的解封记录表（时间/操作人/夹具版本/模式/折数）C5 留空。冻结文本须列明：独立出题人角色、封存物清单与哈希算法、`probeSetVersion` 与夹具哈希、解封记录字段、施工侧访问隔离的具体手段，而非纪律宣誓。

### I8 ｜ 信息污染第四层「指纹核对」未进防自证清单，queries 无撰写源溯源

- 正本 :690-695 要求污染防护四层各有零件，第 4 层为「内容哈希与盖章指纹一致性核对」；方案 §5（:43-46）只覆盖子串、key_points 重合、别名、红测，未登记指纹核对，离线夹具与投影被调包时无拦截。与 B3 的 queries 字符串问题同源：夹具条目缺「撰写源（raw-turn/summary 定位）」溯源字段。

### I9 ｜ 数量可行性：现有 harness 产能与目标差约一个数量级，schema 缺口明确

| 目标（方案 :27-28） | 现 harness 单事件产出（代码实测） | 最低规模反推 | 缺口 |
|---|---|---|---|
| S0–S4 每层 ≥50 | 无层概念；L0 每事件 1 题（`:1043`，schema 允许 3–5） | 每层约需 50 个事件簇（若 1 题/事件）；五层共 ≥250 题 | `FixtureLayer` 仅 `l0/l1/l2/decoy/abstain`（`fixtures.ts:21`），无 s0–s4，题项无法挂层标 |
| 五层总 ≥200 | 10 事件→20 gold（`:1232`） | 建议 ≥50 事件簇以支撑簇级区间（B4） | 无多层/多变体生成器，现行为 1:1:1（`:890-900、:953`） |
| 诱饵对 ≥100 | harness  decoy 写空数组（`:1058`）；随库 `decoy.json` 仅 1 条 | 每卡最多 top2 近邻（`decoy.ts:89`），理论需 ≥50 张有正交集的卡；100 条 `discriminatorQuery` 须独立手写 | `buildDecoyPairs` 只产邻居 id 不产提问（`:69-93`）；jaccard 为短语级 term 集合（`:54-63`），小语料正交集稀少 |
| holdout ≥40 | harness holdout 写空（`:1057`） | ≥40 条 l2（与 l1 同形，`fixtures.ts:37、:229-231`） | 无封存/解封强制；且 40 条不满足半宽要求（B1） |
| 合成 id 纪律 | 实际用 `evt-${i}`（`:892`） | 方案要求 `syn-*`（方案 :30） | 无 `syn-*` 前缀校验 |
| S1 片段占比 ≤25% | 无对应字段 | — | schema 无比例口径，加载期无法校验 |

### I10 ｜「同输入逐字节复现」措辞须收窄

- 统计区间可复现属实：`DEFAULT_RNG_SEED=20261111`、`mulberry32` 确定性 PRNG、1000 次重采样（`metrics.ts:26-42`），同输入 JSON 锁定测试见 `qa-memory-harness.test.ts:835-839`。但 run 信封含 `runId=ulid()`（`run-memory-audit.ts:479`）、墙钟 `Date.now()`（:599）、解封时刻（:487），整库运行产物并非逐字节一致。方案 :38 应限定为「metrics/区间逐字节可复现」。

### I11 ｜ 层归属仲裁与 R1 冷启动分层缺失

- 同一条换述样本归 S2/S3/S4 哪一层、争议由谁仲裁、留痕位置均未定义（方案 :15 表头、:62 待补），存在把 A 召不回的样本事后改标 S3 天花板层的空间。
- 正本 :629 R1 口径含「按冷启动分层」，方案 :34 只写 top-k 比例，漏分层出数要求。

### I12 ｜ C6 真实标注与「解冻后观察窗」概念混用

- 方案 :30 把 C6 真实人工标注直接称为「解冻后观察窗」；README :5 界定 C6 是真实根上按 §7 种子与首版 audit 的产物，裁定 :174① 的「正式联测落解冻后观察窗」是另一回事。建议分列，本门只需冻结「真实根/真实标注不是 P6 前提」（README :6）。

---

## 四、建议项（可选）

1. 方案 :5 权威依据章节范围补全：provenance 依据在正本 §6.9（:688）而非所列 §6.4–6.6；:1235 位于附录 B。
2. 方案 :56「外审 C7」指针越出三份权威清单（其原文在 `docs/memory-cue-external-review-integration.md:78`），主张本身有裁定 :219 佐证，建议改挂裁定 :219、C7 仅作旁注。
3. 方案 :37 provenance 补写抽样覆盖范围；方案 :36 按 README :23 登记 abstain/noise 探针形状（`kind=unanswerable|noise`、`goldCardId=null`、独立加载）。
4. 冻结归档物建议写明：夹具 `probeSetVersion`＋夹具哈希、规则版本、RNG 种子、四层版本一致性记录（`fixtures.ts:252-254`）、结果与解封记录一并归档（对照 README :30-34）。
5. 更正陈旧代码注释：`src/memory/types.ts:240`、`src/memory/audit/provenance.ts:88` 仍写 trigram 时代措辞，与 #124 后 bigram 几何不符。
6. S4 规范化能力边界建议在方案中显式化：`normalizeQuery` 只折叠不删空格（`bm25.ts:46-48`），NFKC/全半角救回与空格变体 miss 的分界应给确定性判定表，避免「可救一部分」（方案 :21）被自由解释。

---

## 五、七个审查点逐项核对、遗漏要件分类与已守住项

### 5.1 审查点 1–7 结论矩阵

| 审查点 | 结论 | 关键证据 |
|---|---|---|
| 1 五层定义与分层预期是否忠实 | **部分不成立**：S0/S1/S2/S4 出题口径与裁定 :213 一致；S3 几何论证错配（B2）；未见把 A 职责内错误显式豁免，但错误的几何理由隐含豁免风险 | 方案 :17-23；裁定 :199-205、:213；正本 :921；`bm25.ts:30-31,141-144`；`gate.ts:107-119`；`projection/sqlite.ts:39` |
| 2 是否有事后无法糊弄的判过规则 | **没有**：双标、趋零、CI 闭环缺失、40 与 0.05 不相容（B1） | 方案 :34-39；正本 :625,630,1235,1563；裁定 :174②,215-216 |
| 3 机械防自证可否落地 | **可建但全部未建**；白名单字段拒收与投毒红测有效，但三硬校验、零别名加载断言、:205 红测均缺失（B3） | 裁定 :217-218,205；`fixtures.ts:8,28-40,102-108,146-158`；`fixtures-discipline.test.ts:42-76`；`gold-l0.json:9,18`；`qa-memory-harness.test.ts:328-336` |
| 4 统计口径 | 样本量数字照抄裁定 :214 无误；但 iid 与卡簇不符、LOEO 无实现、簇单位未冻结（B4） | 裁定 :174③,214-216；`metrics.ts:70-88,131-141`；`run-memory-audit.ts:471-477`；`gold.ts:53-87`；README :27-29 |
| 5 数量可行性 | 现 10 事件/20 题/空 holdout/空 decoy，距 ≥250 题、≥100 诱饵对、封存集差距约一个数量级，且无层 schema（I9） | `qa-memory-harness.test.ts:886-918,953,1035-1059,1220-1237`；`fixtures.ts:21`；`decoy.ts:69-93` |
| 6 遗漏要件 | C2/C3 漏登记（I2）；Q4/H7/C1/C4/Q3/Q8/Q7/Q9 属他卡，排除正确（见 5.2） | 裁定 :164-168,176-181,183-197,221-233,250,256-267 |
| 7 红线与边界 | 不夹带 C、不改版本常量属实；「零字节写」夸大（I1）；封存流程口号化（I7）；独立出题无代码强制（B3） | `types.ts:19`；grep 零向量依赖；`run-memory-audit.ts:403,506-514`；`api/index.ts:314-323,361` |

### 5.2 遗漏要件分类（「P6 必需」vs「属他卡、不应混入」）

| 要件 | 权威位置 | 评审判定 |
|---|---|---|
| C1 H7 双形态反查（含 NFKC 双查）、C4 不复制 summary/不读 raw/不写 mem_alias | 裁定 :164、:168；正本 :1532-1536 | 属 P1 派生纯函数侧红测（正本 :1556），不混入 P6 正确；建议方案 §5 注明归属，避免误以为 P6 兜底 |
| C2 禁运行期 flag、C3 prompt 改动重跑 | 裁定 :166-167；正本 :1542-1543 | **本卡边界条款，漏登记（I2）** |
| Q4 超 40 码点整条丢弃 | 裁定 :183,191,197；正本 :1534 | P1 侧，排除正确（代码见 `cue-derive.ts:92`） |
| Q3 保序前 3、包含式去重 | 裁定 :176-181 | 阶段 2 回放器对比项；方案 :28 已将其排除出 holdout 调参，处理正确 |
| Q8 反事实注入 ΔR2≤+0.02 | 裁定 :250 | 属 #120（路线 B）P7–P12 验收，不混入正确；建议 §9 注明归属 |
| Q7 D-1 离线关联、Q9 B 基线/专属开关、Q10 退役出口 | 裁定 :221-233、:256-267、:269-275；正本 :917 | 均属未立项的 #120，方案 :11 仅登记归属，正确 |
| 向量/embedding、查询切词新卡 | 裁定 :203；正本 :823,831,1635-1641 | 路线 C 独立立项，方案 :11,:66 明确不夹带，正确 |
| 冻结后变更控制 | 方案 :4 有原则句 | 留痕对象不完整，缺夹具/规则版本、种子、C3 重跑触发（I7、建议 4） |

### 5.3 经代码复核已守住的红线（整改时不得破坏）

1. 无向量/embedding：`src/memory` 全量 grep `embed|cosine|tensor|vector` 零命中；唯一相似度参数 `src/event/params.ts:60,95` 无任何消费方；诱饵相似度是 Jaccard 集合运算（`decoy.ts:54-63`）。
2. 版本冻结：`CURRENT_RULES_VERSION` 唯一赋值在 `src/memory/types.ts:19`，值为 `'rules-v1'`，全仓无第二处；盖章点 `builder.ts:548`、`store.ts:495,531`。
3. 弱通道构造性拒绝：`gate.ts:118-119` like-only 无条件拒收，无数值分支可放行。
4. 夹具字段白名单与正文投毒红测有效：`fixtures.ts:102-108` 越键即 IntegrityError；`qa-memory-harness.test.ts:328-336` 对 summary/body/raw_text/key_points 四键投毒均断言抛错；现网夹具 JSON 实读无正文字段。
5. 审计产物隔离：`--out` 不得位于 dataRoot 内（`run-memory-audit.ts:137-141,585-589`），`--dry-run` 不打开写柄（:506-514），记忆索引与 FTS 快照只读打开（`store.ts:644`；script :303）。

---

## 六、可被事后糊弄的漏洞（专节）

1. **阈值软硬双标**：R1 写「非门禁」、R2 写「≤0.05」，0.85/0.05 是否硬门、看点还是看区间未布尔化（方案 :34-35；正本 :625,1235）。
2. **「趋零」修辞**：S2/S4 wrong-commit 无条数/比率/分母，50 题样本下错几条都能辩解（方案 :19,21,36；正本 :630 仅给高危 0 容忍）。
3. **CI 死循环出口**：「不得下结论」之后无判定，扩样到 300/300 仍宽时可拖成「证据不足但放行」（方案 :38-39；裁定 :215-216）。
4. **holdout 凑数**：40 条（层均约 8 条）在数学上达不到半宽 0.05，可被用来只交点估计、回避区间判据（B1 实算）。
5. **样本构成可挪移**：40/200/100 的包含关系与分层配额未冻结，难易样本可在调参集与封存集间布置（方案 :27-28）。
6. **层标签事后改标**：S2/S3/S4 无仲裁规则，A 召不回的样本可改贴 S3 天花板标签豁免（方案 :15；I11）。
7. **几何背书张冠李戴**：用经历库 trigram=3 论证记忆卡不可达；现记忆侧实为 bigram=2，真正的子串复核闸门未前置到加载期（B2、B3）。
8. **queries 夹带正文**：白名单只挡字段名，`queries[i]` 照抄 key_points/summary 无校验、无撰写源溯源（`fixtures.ts:102-108`）。
9. **合成题与 cue 同词对齐**：现 harness 用 `线索${i}` 对齐手写 cue（`:957,:1043`），沿此脚本扩产可人为抬高 R1；且根本没走 A 派生链（B5）。
10. **iid 假独立**：同事件多题被当独立样本重采样，CI 偏窄，题数达标可掩盖事件簇不足（`metrics.ts:79-85`；B4）。
11. **LOEO 贴标签**：报告可写 `{mode:'loeo',folds:n}` 但数字是全量单遍结果，无逐折回算（`run-memory-audit.ts:472-477`）。
12. **correct-abstain 无分母**：abstain 探针与四态汇总不进 CLI 主链路，弃权表现可被整体跳过（B6）。
13. **provenance 抽样盲区**：20% 分层抽样外的锚点不核验，硬失败只覆盖样本（`provenance.ts:50-83`）。
14. **封存靠自觉**：`--holdout` 随时可解封，无哈希、无读取审计、解封表空白（I7；README :32-34）。
15. **flag 暗门与标签脱节**：未照 C2 禁运行期 flag；run 信封 modelTag 硬编码 rules-v1，rules-v2 离线结果也可被标签解释（I2；script :500）。
16. **零字节写错觉**：零写断言只覆盖单文件，dataRoot 内 checkpoint/事件 JSONL/L1 投影的启动写入不在比对面（I1）。
17. **诱饵自产自销**：`buildDecoyPairs` 只给邻居 id，判别提问手写、jaccard 为短语级口径，小语料可凑近邻对，不代表真实难诱饵（`decoy.ts:54-93`；I9）。
18. **R3 两头解释**：未声明 N/A，事后可造数也可宣称不考（正本 :631；I5）。
19. **坏 id 晚暴露**：加载校验只看形状，eventId/targetEventId 等身份存在性到回放期才报错，坏夹具可先过加载（`fixtures.ts:206-233`）。
20. **夹具现状被说成已闭环**：「fixtures-discipline 已锁该反例」混淆 helper 存在与夹具达标，随库 gold-l0 仍是 sensitive:0（方案 :45；B3）。

---

## 七、建议冻结文本：P6 冻结态布尔判过规则（可直接并入预注册）

> 用法：以下为评审建议的成文条款。标【权威】者有权威明文；标【建议参数】者权威未定值，须主控在冻结前逐项签字，签字后不得在看到结果后修改。所有比率仅在封存终判集上计算一次。

### 7.0 术语、分母与数据形状（冻结前提）

1. 四态：对每一道题输出唯一状态——`correct-commit`（有金标且 top-k=3 命中目标）、`wrong-commit`（commit 了非目标卡；含诱饵题选错卡）、`wrong-abstain`（有金标却弃权/落空）、`correct-abstain`（无金标题或弃权探针期望弃权且系统未 commit）。归类按 hasGold 拆分两组分母；零分母一律记 `N/A` 且该判据条目按「未满足」处理而非记 0【建议参数，填补 I3 空白】。
2. 重采样单位＝**事件 id（卡簇）**：同一事件派生的全部题属于同一簇，bootstrap 在簇层面有放回抽样 1000 次，RNG 种子固定 `20261111`（`metrics.ts:26,28`）；禁止题级 iid 口径出现在终判报告（裁定 :174③【权威】）。
3. 每个考核单元（层/诱饵集）要求**事件簇数 ≥30**且每事件每层题数上限写明（建议 ≤4）【建议参数】；题数达标而簇数不足时，状态为 `INCONCLUSIVE`，不得以题数替代。
4. R3 在 P6 阶段记 `N/A`，不进入合取，禁止造数（正本 :631【权威】）。

### 7.1 全局一票否决（任一不满足即 `NOT-PASSED`）

- G1 provenance：窗口内全部锚点解析率＝100%、dangling＝0、无缓存漂移、FTS 可溯源，否则硬失败（正本 :688【权威】；实现口径见 `provenance.ts:141,153`）。C5 建议全量核验、停用 20% 抽样默认；若保留抽样，抽样比与分层必须写死在本节【建议参数】。
- G2 五类高危（strong/promise/date/verbatim/negation）wrong-commit 计数＝0，0 容忍计数，不做比率推断（正本 :630【权威】；标签枚举见 `fixtures.ts:26`）。
- G3 A 评测零别名注入：A 夹具加载期出现任何 aliases 条目即硬拒；B 专用夹具 miss 别名必须 `sensitive=1`，否则硬拒（裁定 :218【权威】；现状缺口见 B3）。
- G4 加载期硬校验三条全部以确定性校验器＋先红后绿实现：① S2–S4 查询不得为任一目标卡 cue/别名归一化后的连续子串；② 撰写源仅限 raw-turns/summary 且条目带撰写源定位，与目标事件 key_points 的 trigram 重合率超过冻结阈值即剔除（阈值与重合率分母【建议参数，主控签字】）；③ 夹具白名单拒收正文/越键字段（已具备，`fixtures.ts:102-108`）。
- G5 生产侧零变更：不引入向量/embedding、不立查询切词卡、不改生产 gate 与检索常量、`CURRENT_RULES_VERSION` 保持 `rules-v1`、不设 A 专属运行期 flag（flag 仅限测试/临时根）；closure prompt 变更触发 P6 重跑（裁定 :166-167,203【权威】）。
- G6 封存完整性：终判集（含金标、诱饵、弃权探针、夹具版本、夹具哈希、规则版本、种子）在出题完成即封存，施工侧终判前无读取权限；解封记录按 README :32-34 字段留痕；未封存或封存哈希不符，结果无效。
- G7 评测对象效度：C5 临时根所有卡必须经 `deriveCuesFromKeyPoints` 由合成 key_points 真实派生，禁止手写 displayCues 替代；run 信封如实记录派生规则版本（针对 B5【建议参数】）。

### 7.2 分层判据（全部在封存终判集上一次性计算）

| 单元 | 召回类判据 | 乱命中判据 | 弃权类判据 |
|---|---|---|---|
| S0 原话复述 | R1 点估计 ≥0.85 且簇 bootstrap 95% CI 半宽 ≤0.05【0.85 数值源自正本 :629/:1235 观测初值；**将其提升为 P6 硬门是本预注册冻结动作，需主控签字**；半宽裁定 :215【权威】】 | 高危＝0（G2）；普通 wrong-commit 计入对应题分母，不得跨层稀释【建议参数】 | 有金标题 wrong-abstain 计入 R1 失败 |
| S1 逐字片段（≤25%，sanity） | 同 S0；「守 R1 下限」明确为同一 0.85 硬门，删除无数字的「守下限」措辞【建议参数】 | 同 S0 | 同 S0 |
| S2 重叠换述 | 不考 R1；wrong-abstain 登记为 B 接管面、不计 A 失败（裁定 :199,203【权威】） | **wrong-commit 计数＝0**【建议参数：方案 :23 自述「任何层 wrong-commit 都算安全事故」，冻结为零是唯一无歧义读法；若主控要保留错误预算，须在此写明整数上限与层分母，禁用「趋零」】；高危＝0 | 该层 correct-abstain 比率随层报告但不单独设门【建议参数】 |
| S3 同义改写 | 同 S2（系统天花板登记） | wrong-commit＝0（方案 :20 已自述为 0，升格为硬计数）；高危＝0 | 同 S2 |
| S4 口语/错字/空格/全半角 | 规范化救回计 correct-commit；裁定 :205 空格变体红测必须落地为夹具＋加载红测，救不回的计 wrong-abstain 不计失败 | 同 S2，wrong-commit＝0【建议参数】；高危＝0 | 同 S2 |
| DRM 诱饵集（≥100 对） | — | R2 点估计 ≤0.05 且 CI 半宽 ≤0.05（正本 :630【权威，数值定性同 R1 处理】）；高危＝0 | 诱饵题 correct-abstain/正确判别随 R2 分母统计 |
| 弃权/噪声探针 | — | noise 题 commit 诱饵卡即判 wrong-commit | unanswerable 题 correct-abstain 比率＝100%【建议参数，依据 README :23「期望弃权」】；探针须接入 CLI 主链路（B6） |

说明：在半宽 ≤0.05 成立时，R1 点估计 ≥0.85 自动等价于 CI 下界 ≥0.80（0.85−0.05），无需另设 0.80 参数；禁止写成「CI 下界 ≥0.85」与「点估计 ≥0.85」两套可事后挑选的口径。

### 7.3 精度规则与处置闭环（替换现稿「不得下结论」悬空句）

1. 任一比率指标簇 bootstrap 95% CI 半宽 >0.05：该轮状态＝`INCONCLUSIVE`，**禁止判 PASSED、禁止解冻**（裁定 :215【权威】）。
2. 处置：按事件簇扩样（不得按题灌同一事件），每层与总量上限 ≥300/≥300（裁定 :216【权威】），扩样只允许一次，扩样决策与新样本量在揭盲前记录。
3. 封顶后半宽仍 >0.05：状态＝`NOT-PASSED`，`rules-v1` 冻结继续生效，直至另立修订版预注册重新冻结——依据正本 :1563「任一条不满足，rules-v1 冻结继续生效」【闭环处置为评审补全，原则有权威依据】。
4. 化解 holdout=40 的数学不相容（B1），二选一写入冻结文本【建议参数】：
   - 方案 A（推荐）：终判封存集按层配额每层 ≥50、总量 ≥250、诱饵 ≥100 对整体封存，调参/试跑使用不含封存 id 的独立构造集；CI 与点估计都在封存集上一次算出；
   - 方案 B：封存 holdout 维持 ≥40 仅用于点估计布尔门，CI 半宽门在同等分布、同样按簇的全量封存样本上计算并报告——但两层口径必须在跑数前写死，禁止揭盲后选择。
5. 日历周 <5 时：只有在留一事件逐折重放**实际实现**后才允许标注 `{mode:'loeo',folds:n}`（README :27-29【权威】）；未实现前该情形一律 `INCONCLUSIVE`，不得用全量单遍数字贴 LOEO 标签。

### 7.4 最终布尔合取式

```
PASSED ≡ G1 ∧ G2 ∧ G3 ∧ G4 ∧ G5 ∧ G6 ∧ G7
         ∧ L_S0 ∧ L_S1 ∧ L_S2 ∧ L_S3 ∧ L_S4
         ∧ DECOY(R2) ∧ ABSTAIN ∧ PRECISION
```

- 任一合取项 false → `NOT-PASSED`；任一比率精度不达标且未走完 7.3 闭环 → `INCONCLUSIVE`；不存在第三种「有条件通过」。
- 解冻动作（发布 rules-v2、改 `CURRENT_RULES_VERSION`）仅在 `PASSED` **且**主控显式授权后执行（正本 :1563【权威】）；解冻前生产零行为变化是验收条件而非可放宽项（正本 :1564【权威】）。
- 冻结后任何分层、阈值、样本量、校验器规则改动必须显式修订、升 `probeSetVersion` 并重新独立复核；C3 触发条件命中时本合取式自动失效、须重跑全部门。

---

## 附：本报告引用证据索引（按文件）

- 方案 `docs/task123-p6-preregistration.md`：:4-5、:9-11、:15、:17-23、:27-30、:34-39、:43-46、:50-52、:56-57、:61-62、:66、:70-71
- 正本 `docs/architecture-design-spec.md`：:625、:629-631、:661、:688、:690-695、:753-757、:823、:831、:917、:921、:1235、:1238、:1532-1536、:1542-1543、:1556、:1563-1564、:1635-1641
- 裁定 `docs/memory-retrieval-words-review-adjudication.md`：:4、:120-122、:164-168、:174、:176-181、:183-197、:199-205、:209、:213-219、:221-233、:250、:256-267、:269-275
- README `tests/fixtures/memory/README.md`：:5-6、:10-11、:19、:22-23、:27-34、:38-39
- 代码：`src/memory/types.ts:19,240`；`src/memory/bm25.ts:30-31,46-48,124,141-144`；`src/memory/bigram.ts:75-77`；`src/memory/gate.ts:107-119`；`src/memory/cue-derive.ts:26,92`；`src/memory/builder.ts:449-455,548`；`src/memory/store.ts:495,531,640-649`；`src/memory/schema.ts:63-67`；`src/memory/audit/fixtures.ts:8,21,26,28-40,102-108,146-158,206-233,252-254`；`src/memory/audit/metrics.ts:26-42,70-88,131-141,163-212`；`src/memory/audit/decoy.ts:54-93`；`src/memory/audit/four-state.ts:105-166`；`src/memory/audit/rates.ts:52-74`；`src/memory/audit/consistency.ts:62-64`；`src/memory/audit/provenance.ts:50-83,141,153`；`src/memory/audit/gold.ts:53-87`；`src/memory/audit/shadow-read.ts`；`src/projection/sqlite.ts:38-39,473`；`src/projection/types.ts:91,209-214`；`src/projection/event-row.ts:67`；`src/projection/jsonl.ts:51,58-65`；`src/event/params.ts:60,95`；`src/event/segmenter.ts:407-444`；`src/runtime/checkpoint.ts:121`；`src/api/index.ts:119-125,309-323,359-361`；`scripts/run-memory-audit.ts:137-141,266,303,403,405,428-434,471-477,479,487,500,506-514,585-589,599`；`tests/memory/fixtures-discipline.test.ts:42-76`；`tests/memory/four-state.test.ts:244-253`；`tests/memory/bm25.test.ts:203-212`；`tests/qa/qa-memory-harness.test.ts:328-336,835-839,890-900,953,957-958,984-993,1035-1059,1086,1107,1201-1212,1220-1237`；`tests/fixtures/memory/gold-l0.json:9,18`
