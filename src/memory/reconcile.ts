/**
 * 启动 reconcile 自检（#42 正本 §3.6 / V-04）：SQLite 已提交全集 vs 账本回放全集的纯比较器。
 *
 * 边界纪律：
 *  - 纯函数、零 IO、零 DB 连接：DB 侧 card_id 全集与账本决策行都由编排层读入后注入；
 *  - 自检**不写真源**：只产出可序列化 finding 清单；补记账本行 / 全量对账触发归 B2 编排；
 *  - 不造 drain、不碰第七法；本模块只钉比较口径与 finding 形状（可进 audit 报告）。
 *
 * 两类漂移：
 *  - `db-committed-ledger-missing`：卡已在 DB 提交，账本 decisions 无对应行（事务与账本跨存储窗口）；
 *  - `ledger-entry-db-missing`：账本有决策行指向某卡，DB 投影中查无此卡。
 */

import type { DecisionRecord } from './types.ts';

/** 自检发现种类（受控码表）。 */
export type ReconcileFindingKind = 'db-committed-ledger-missing' | 'ledger-entry-db-missing';

/** 一条对账发现（纯数据，无函数/循环引用，可 JSON 序列化进 audit 报告）。 */
export interface ReconcileFinding {
  readonly kind: ReconcileFindingKind;
  /** 漂移对象引用：card_id。 */
  readonly ref: string;
  /** 一句话细节（不复制真源原文）。 */
  readonly detail: string;
}

/** 自检入参：两侧全集均由编排层注入。 */
export interface ReconcileInput {
  /** DB 侧已提交的 card_id 全集（含失效卡，对账不以 active 为限）。 */
  readonly dbCardIds: readonly string[];
  /** DB meta stamped_revision；无 meta 为 null。 */
  readonly dbStampedRevision: number | null;
  /** 账本回放得到的 decision 行。 */
  readonly decisions: readonly DecisionRecord[];
  /** 账本 revisions 末行 revision；无账本为 null。 */
  readonly ledgerRevision: number | null;
}

/** 自检报告：`clean` 零 finding；`mismatch` 附漂移清单。 */
export interface ReconcileReport {
  readonly status: 'clean' | 'mismatch';
  readonly findings: readonly ReconcileFinding[];
}

/**
 * 比较 DB 已提交全集与账本回放全集，归类双向漂移。
 *
 * 注：`dbStampedRevision` / `ledgerRevision` 为 §3.6 修订号对账的入参预留；本比较器当前
 * 只按 card_id 集合差集归类两类 finding（红测契约码表不含修订号漂移种类），修订号对齐
 * 策略待 B2 编排层补账/全量对账时接入。
 */
export function reconcileProjection(input: ReconcileInput): ReconcileReport {
  const dbIds = new Set(input.dbCardIds);
  const ledgerIds = new Set<string>();
  for (const decision of input.decisions) {
    if (decision.card_id !== null) {
      ledgerIds.add(decision.card_id);
    }
  }

  const findings: ReconcileFinding[] = [];

  // 已提交未记账：DB 有卡、账本无决策行。
  for (const cardId of input.dbCardIds) {
    if (!ledgerIds.has(cardId)) {
      findings.push({
        kind: 'db-committed-ledger-missing',
        ref: cardId,
        detail: `DB 已提交卡 ${cardId} 在账本 decisions 中无对应记录`,
      });
    }
  }

  // 有账无库：账本决策指向某卡、DB 投影查无此卡。
  for (const decision of input.decisions) {
    if (decision.card_id !== null && !dbIds.has(decision.card_id)) {
      findings.push({
        kind: 'ledger-entry-db-missing',
        ref: decision.card_id,
        detail: `账本决策 ${decision.decision_id} 指向 ${decision.card_id}，但 DB 投影中无此卡`,
      });
    }
  }

  return {
    status: findings.length === 0 ? 'clean' : 'mismatch',
    findings,
  };
}
