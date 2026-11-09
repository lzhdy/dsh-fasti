# dsh-fasti —— A 块阶段 0–4（底层架构）

Fasti 是 DSH 宿主插件。本仓库实现 A 块**阶段 0–4**：真源层 + 最小投影 + dsh 通道适配器。

> 核心命题：把「对话插件的地基」换成「存在日志的地基」——
> 她的一生是一条不可变的经历流；记忆、自我模型、事件摘要、一切索引都是**可重建的投影**。

---

## 快速开始

```bash
npm install
npm run build      # tsc → lib/（含 .d.ts 契约）
npm test           # node --test "tests/**/*.test.ts"
npm run verify     # build + typecheck + test
```

无需任何环境变量即可运行；测试全部使用临时目录，不触碰真实数据目录。

---

## 分层

```
接口层 api/         §9 的 15 个原语
   ↓
真源层 source/      append-only、不可变 —— 唯一不可再生资产
   ↓
投影层 projection/  L1 sqlite / L2 JSONL / L3 真源直读 —— 可丢弃、可重建
   ↓
核心 core/          ULID、哈希、时间、JSONL、原子写（零运行时依赖）
   ↓
契约 contract/      Experience schema、原语签名、冻结面五条
```

## 目录

| 路径 | 内容 |
|---|---|
| `src/contract/` | 阶段 0 契约：Experience schema、§9 原语签名、冻结面 |
| `src/core/` | 零依赖基础设施（自实现单调 ULID 等） |
| `src/source/` | 阶段 1 真源层：原文层、结构层、通道注册表、单写者队列、tick |
| `src/projection/` | 阶段 2 最小投影：三表 DDL、L1/L2/L3 引擎、探测降级、重建对账 |
| `src/runtime/` | 运行态检查点 |
| `src/api/` | 接口层实现（§9 的 15 个原语） |
| `src/adapters/dsh/` | 阶段 4 适配器层：dsh 事件转换（纯函数）+ cordis 插件入口 |
| `scripts/` | 一次性工具与验收工具（不进 `src/`、不进 `lib/`） |
| `tests/` | 与 `src/` 同构，174 个用例 |
| `docs/` | 定案稿、依据文档、实现说明、验收自检 |

## 关键纪律

1. **真源是唯一权威**：append-only、不可变；投影整体可弃、可从真源重建。
2. **不把「聊天」写成前提**：`kind` 是开放枚举只描述形状；会话只是 `scene.ref` 的一种取值。
3. **不预设「什么重要」**：真源层无 importance 类字段；`marks` 只贴标签、不否决。
4. **规则层只标记**：机械标记不参与任何「是否记录」的判定。
5. **投影确定性、幂等**：同样的真源 → 同样的投影。
6. **降级不影响数据完整性**：L1 → L2 → L3 只降性能与丰富度，不丢数据。

## 文档

| 文件 | 内容 |
|---|---|
| `docs/a-block-final-design.md` | A 块定案稿（唯一架构依据） |
| `docs/stage4-dsh-adapter-plan.md` | 阶段 4 实施计划（已执行；§13 为真机验收结论与口径澄清） |
| `docs/b-block-event-layer-design.md` | B 块事件层设计（评审稿 v0.2，未定案） |
| `docs/reference/legacy-behavior-contract.md` | 旧项目行为契约清单 |
| `docs/reference/a-block-implementation-audit.md` | 实现审计与验收清单 |
| `docs/implementation-plan.md` | 模块拆分与实现计划 |
| `docs/implementation-notes.md` | 实现说明：模块做了什么、关键决策、偏离、验证方式 |
| `docs/acceptance-selfcheck.md` | 逐条对照验收清单的自检（17 通过 / 1 部分通过 / 0 未通过） |
| `docs/audit-response-0.1.0.md` | 0.1.0 代码审计报告的逐条处理结果（M1 / m1–m3 / Q1 / Q2） |

## 数据根

三级解析：`显式配置` > `$DSH_HOME/fasti` > `~/.dsh/fasti`。

```ts
const fasti = await Fasti.open({ dataRoot: '/path/to/root' });
```

## 阶段边界

本仓库**含阶段 0–4**：

- **阶段 0–2**：真源层 + 最小投影（A 内核，零生产依赖）；
- **阶段 3**：一次性转写脚本 `scripts/migrate-raw-turns.ts` + 专项自测 `scripts/selftest-migration.ts`；
- **阶段 4**：dsh 通道适配器（`src/adapters/dsh/`）—— 让真实对话事件实时写入。

**仍未实现**：资产层（媒体字节）、实体表，以及 B/C/D/E 块的一切行为（复盘读出、主动系统、权限、身份）。
这些原语的签名已在契约层声明，调用时抛 `NotImplementedError`（不静默返回空）。

阶段 3 的两个脚本是**一次性工具**，不进 `src/`、不进 `lib/`，也不进默认 `npm run verify`
（它们需要 legacy 源数据环境才能运行）。

## scripts 各自的性质

| 脚本 | 性质 | 什么时候用 |
|---|---|---|
| `migrate-raw-turns.ts` | 一次性转写（旧根 → 新根） | 迁移当次；事后可用于回查迁移口径 |
| `selftest-migration.ts` | 上述迁移脚本的专项自测（S1–S15） | 只在迁移当次；不进默认 verify |
| `simulate-realtime-session.ts` | 在数据根副本上模拟宿主事件流 | 对账工具链自检 + 宿主接法的可运行样例 |
| `verify-stage4-frozen-surface.ts` | 冻结面回归核验（7/7） | **长期**：改了 A 内核就跑一次 |
| `verify-stage4-realtime.ts` | 真机对账（验收四问 + 重放幂等） | **长期**：每次真机验收跑一次 |

两个 `verify-*` 是长期工具，前者守「冻结面没被破坏」，后者守「真机对话没丢没重」。
后三者都在临时目录/副本上作业，绝不写真实数据根。

## 阶段 4 真机验收

已在真实 dsh 宿主上跑通：headless 3 轮 + web 完整往返 1 轮，
四问全 PASS（含重放幂等）。结论与两条口径澄清见
`docs/stage4-dsh-adapter-plan.md` §13；验收日志只在本机、不入仓库。
