/**
 * C2-甲：门后栈机械 PASSED 的弃权警告印（193/194 号文书）。
 *
 * 预注册 v5 §6.2 对 wrong-abstain 明示「登记、不设门」，且 R1 hit 取自 gold 回放通道、
 * 与门后是否实际提交解耦——合取式字面下「全对」与「全哑」可能同为 PASSED。本函数不碰
 * 任何判决逻辑，只在 PASSED 伴随错弃权时生成一行可读警告，供报告渲染与 JSON 留档，
 * 防止人和下游把诊断栈的机械 PASSED 误读为放行证据。
 */

export interface GatedCaveatInput {
  verdict: 'PASSED' | 'NOT-PASSED' | 'INCONCLUSIVE';
  /** 门后四态 wrong-abstain 计数（有金标但门未提交）。 */
  wrongAbstain: number;
  /** 有金标题分母 G（cc+wcG+wa）。 */
  answerableGold: number;
  /** 门后正确提交 cc。 */
  correctCommit: number;
}

export function gatedVerdictCaveat(input: GatedCaveatInput): string | null {
  if (input.verdict !== 'PASSED' || input.wrongAbstain <= 0) {
    return null;
  }
  const recall = input.answerableGold > 0 ? `${input.correctCommit}/${input.answerableGold}` : 'N/A';
  return (
    `警告（C2 弃权盲区）：本 PASSED 只担保错认类门（wc/高危/R2/ca），不覆盖弃权判别——` +
    `门后 wrong-abstain=${input.wrongAbstain}、门后召回=${recall}；「全哑」与「全对」在 v5 合取式下不可分，` +
    '门后弃权表现以四态汇总为准，本判决不得单独作为切换生产依据。'
  );
}
