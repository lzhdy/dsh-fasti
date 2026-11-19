/**
 * L0 时间词表（#127 阶段 1.5）—— 数据面唯一真源，纯 TS const 数据模块。
 *
 * 设计纪律（主控 2026-11-19 拍板）：
 *  - 词表不是"正则定式匹配"：surface（自然语言说法）允许开放增删，
 *    但每个 surface 只能映射到封闭的语义原子 TimeLexiconAtom；
 *    文法/求解器只认原子、永不直接认字符串，穷举责任被限制在数据层且可审计；
 *  - 本模块零函数、零时钟、零 I/O、零依赖（除 ./types 的纯类型），
 *    是 layer-imports 无环门登记在册的 leaf 模块；
 *  - 批 1（P0）仅冻结资产版本常量与条目契约，数据表为空骨架；
 *    批 2（P1）按《最终推荐与实施细则》第四节封闭清单填充，
 *    任何增删都必须 bump LEXICON_VERSION 并同步 golden 夹具。
 */

import type { IsoWeekday, TimeFlag } from './types.ts';

/**
 * 时间资产版本三元组（批 1 冻结初值）。
 *
 * - lexicon：本文件词条/数字表增删时 bump；
 * - grammar：time-expr 文法规则增删时 bump（批 2 起用）；
 * - policy：时区/日界/周开篇等硬编码策略变更时 bump。
 * 三者随 TimeAnchor 注入并进入 replayKey，保证重放可对账。
 */
export const TIME_ASSET_VERSIONS = Object.freeze({
  lexicon: '1.0.0',
  grammar: '1.0.0',
  policy: '1.0.0',
} as const);

/**
 * 封闭语义原子：surface 开放、原子封闭。
 *
 * - REL_DAY：相对日（delta=0 今天，-1 昨天，+1 明天，首期封闭区间 -3..+3）；
 * - WEEK_OFFSET：周偏移词（上周/本周/下周…），与 WEEKDAY 原子组合成 WEEKDAY_OF_WEEK；
 * - WEEKDAY：星期序原子（1=周一…7=周日）；
 * - SHORT_CIRCUIT：短路词（疑问焦点/内容嫌疑/模糊/时长/周期/超资产范围触发词），
 *   携带对应 TimeFlag，文法层见即走 UNCERTAIN/NONE 路径，不进入日历求解；
 * - NUMERAL：汉字/全角数字归一（零〇○一壹两二…十廿卅），值即阿拉伯数值。
 */
export type TimeLexiconAtom =
  | { readonly kind: 'REL_DAY'; readonly delta: number }
  | { readonly kind: 'WEEK_OFFSET'; readonly offset: number }
  | { readonly kind: 'WEEKDAY'; readonly weekday: IsoWeekday }
  | { readonly kind: 'SHORT_CIRCUIT'; readonly flag: TimeFlag }
  | { readonly kind: 'NUMERAL'; readonly value: number };

/**
 * 词表条目：一条自然语言 surface 对应一个封闭原子。
 *
 * id 是稳定标识，解析证据 TimeEvidence.ruleId 直接引用；
 * id 一经发布不得复用（词条删除则 id 作废留痕，不换新词顶替旧 id）。
 */
export interface TimeLexiconEntry {
  readonly id: string;
  readonly surface: string;
  readonly atom: TimeLexiconAtom;
}

/**
 * L0 词表主数据。批 1 为空骨架（契约冻结用）；
 * 批 2 按封闭清单填充：REL_DAY(-3..+3)、WEEK_OFFSET(±2)×WEEKDAY、
 * 年月日数字归一、CONTENT_SUSPECT/QUESTION_FOCUS/VAGUE/DURATION/
 * RECURRING/OUT_OF_ASSET_RANGE 短路词。
 * 运行期只读，禁止任何模块 mutate（Object.freeze 深度冻结在批 2 填充时补齐）。
 */
export const TIME_LEXICON_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([]);
