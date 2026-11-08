# dsh-fasti —— A 块阶段 0–2（底层架构）

Fasti 是 DSH 宿主插件。本仓库实现 A 块**阶段 0–2**：真源层 + 最小投影。

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
接口层 api/         §9 的 14 个原语
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
| `src/api/` | 接口层实现 |
| `tests/` | 与 `src/` 同构，125 个用例 |
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

本仓库**只含阶段 0–2**。资产层、实体表、转写脚本、DSH 适配器及 B/C/D/E 块的一切行为均未实现；
其原语签名已在契约层声明，调用时抛 `NotImplementedError`（不静默返回空）。
