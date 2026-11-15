/**
 * §2.7 三率骨架：读观测行 + 真源事件版本数，产出 dangling / empty / malformed 可复算报告。
 *
 * 边界：
 *  - 离线 dry-run 纯函数，不接运行期、不落告警设施、不碰真源写入；
 *  - 比率分母为真源事件版本数；版本数为 0 时比率一律 0，不除零、不伪造；
 *  - 隔离率阈值作为 gate 升 on 的硬前置输入，阈值预注册在编排层，本模块只给计数与比率。
 */

import type { DrainObservation } from '../observations.ts';

/** 分类计数：dangling=悬空、empty=合法空锚、malformed=形态缺陷、other=其余受控码值。 */
export interface AuditCounts {
  readonly dangling: number;
  readonly empty: number;
  readonly malformed: number;
  readonly other: number;
}

/** 三率（分母为真源事件版本数）。 */
export interface AuditRates {
  readonly counts: AuditCounts;
  readonly rates: {
    readonly danglingRate: number;
    readonly emptyRate: number;
    readonly malformedRate: number;
  };
  readonly totalEventVersions: number;
}

/** reason_code → 三率桶映射（§2.7 / §3.3 码表）。 */
function bucketOf(reasonCode: string): keyof AuditCounts {
  switch (reasonCode) {
    case 'anchor-not-found':
      return 'dangling';
    case 'empty-anchors':
      return 'empty';
    case 'anchor-form-invalid':
      return 'malformed';
    default:
      // judgment-unapplicable / drain-permanent-tx 及任何未登记码值归入 other。
      return 'other';
  }
}

/**
 * 由观测行集合与真源事件版本数计算三率。
 *
 * @param observations 投影内观测行（调用方已读入）
 * @param totalEventVersions 真源事件版本总数（分母；0 时比率为 0）
 */
export function computeRates(
  observations: readonly DrainObservation[],
  totalEventVersions: number,
): AuditRates {
  const mutable: Record<keyof AuditCounts, number> = { dangling: 0, empty: 0, malformed: 0, other: 0 };
  for (const row of observations) {
    mutable[bucketOf(row.reason_code)] += 1;
  }
  const finalCounts: AuditCounts = { ...mutable };

  const denominator = totalEventVersions > 0 ? totalEventVersions : 0;
  const ratio = (count: number): number => (denominator === 0 ? 0 : count / denominator);

  return {
    counts: finalCounts,
    rates: {
      danglingRate: ratio(finalCounts.dangling),
      emptyRate: ratio(finalCounts.empty),
      malformedRate: ratio(finalCounts.malformed),
    },
    totalEventVersions: totalEventVersions,
  };
}
