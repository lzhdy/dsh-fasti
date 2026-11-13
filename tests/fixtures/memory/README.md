# 记忆层金标夹具（C5 合成样例 + 格式）

> **范围声明（裁决 I3，方案 §6.1/§6.8/§11.8）**：本目录在 C5 仅存放**合成临时根夹具与格式模板**。
> 所有 id（`syn-ev-*` / `syn-exp-*` / `syn-mc-*`）均指向**合成数据**，不对应任何真实经历/事件。
> **真实 L0/L1/holdout 人工标注与真实 id 属 C6**（在真实数据根按 §7 执行种子与首版 audit 时产出）。
> C5 不碰真实根、不预填真实 id。

## 纪律

- 夹具**只含 id 与标注**，**绝不含有正文副本**（`summary`/`body`/`raw_text`/`key_points` 等正文字段一律由
  `src/memory/audit/fixtures.ts` 白名单校验拒收）。
- 每文件含 `probeSetVersion`（须匹配 `/^v\d+(\.\d+)*$/`）、`layer`（`l0`/`l1`/`l2`/`decoy`）与 `items` 数组。
- 四文件 `probeSetVersion` 须一致；坏夹具抛 core 基类（Integrity/NotFound/Corrupted）。

## 文件

| 文件 | layer | 用途 |
|---|---|---|
| `gold-l0.json` | l0 | 种子金标：每事件标准检索词 3–5、别名、敏感标记、判别近邻、应进入窗口槽位 |
| `gold-l1.json` | l1 | 回放金标：提问轮经历 id → 目标事件 id，引发方分层（her/user/environment）、冷启动标记 |
| `holdout.json` | l2 | holdout 封存层（与 l1 同形）；`run-memory-audit.ts --holdout` 才解封跑一次 |
| `decoy.json` | decoy | DRM 诱饵：近邻卡对 + 判别提问 + 金标卡 + 可选高危标签（strong/promise/date/verbatim/negation） |
| `abstain.json` | abstain | 弃权/噪声探针（#44 §5.7）：`kind=unanswerable` 期望弃权、`kind=noise` 一真卡混宽泛诱饵；`goldCardId=null` 表示无金标（hasGold=false）。独立加载（`loadAbstainFixtures`），不并入 `loadFixtures` 四文件契约 |

## holdout / LOEO 解封记录（I15）

- 触发判据：可覆盖日历周数 < 5（切不出后 20% 完整周）→ 退化为 **LOEO**（留一事件交叉验证），
  折数 = 参与事件数；报告 `notesJson.holdout` 记 `{mode:'loeo', folds:n}`，**禁止伪装独立 holdout**。
- 当前 10 个 ready 事件，C5 合成与 C6 真实首跑均预期走 LOEO。
- **解封记录**：C5 本模板留空；C6 真实解封时在此填写解封时间、操作人、所用夹具版本与折数。

| 解封时间 | 操作人 | 夹具版本 | 模式 | 折数 | 备注 |
|---|---|---|---|---|---|
| （C6 填写） | | | | | |

## 自动化口径

- `tests/qa/qa-memory-harness.test.ts` 在 `withTempRoot` 内自建合成经历/事件→build→seed→audit，
  夹具 id 全部指向该合成数据；本目录合成样例仅供 CLI 默认加载与格式参照。
- 引发方分层固定 her/user/environment 三类；经历 `initiation='system'` 由编排层归并到 environment（I16）。