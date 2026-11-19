/**
 * L0 时间词表（#127 阶段 1.5）—— 数据面唯一真源，纯 TS const 数据模块。
 *
 * 设计纪律（主控 2026-11-19 拍板）：
 *  - 词表不是"正则定式匹配"：surface（自然语言说法）允许开放增删，
 *    但每个 surface 只能映射到封闭的语义原子 TimeLexiconAtom；
 *    文法/求解器只认原子、永不直接认字符串，穷举责任被限制在数据层且可审计；
 *  - 本模块零解析逻辑、零时钟、零 I/O、零依赖（除 ./types 的纯类型），
 *    仅在构建期做 Object.freeze 装配；是 layer-imports 无环门登记在册的 leaf 模块；
 *  - 批 2（P1）按《最终推荐与实施细则》第四节封闭清单填充；任何增删都必须
 *    bump LEXICON_VERSION 并同步 time-expr.test.ts 的 T1/T5 表驱动断言。
 *
 * 边界（刻意不做，见细则第四节"清单之外的新说法：返回 NONE 或 UNCERTAIN，绝不猜"）：
 *  - 裸周偏移（"上周/下周/本周"）只是 WEEK_OFFSET 原子，必须与星期序组合才产日期原子；
 *  - 农历/节气/节假日/调休/工作日 全部只做 OUT_OF_ASSET_RANGE 短路，不建表；
 *  - 日内钟点（"下午三点"）不产窗：时段词走 VAGUE，疑问词走 QUESTION_FOCUS。
 */

import type { IsoWeekday, TimeFlag } from './types.ts';

/**
 * 时间资产版本三元组（批 2 起随词表/文法/策略实际改动递进）。
 *
 * - lexicon：本文件词条/数字表增删时 bump；
 * - grammar：time-expr 文法规则增删时 bump；
 * - policy：时区/日界/周开篇/两位年份等硬编码策略变更时 bump。
 * 三者随 TimeAnchor 注入并进入 replayKey，保证重放可对账。
 */
export const TIME_ASSET_VERSIONS = Object.freeze({
  lexicon: '2.0.0',
  grammar: '4.0.0',
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

/** 构建期装配：单条词条 + 原子一次性深冻结（不是解析逻辑）。 */
function entry(id: string, surface: string, atom: TimeLexiconAtom): TimeLexiconEntry {
  return Object.freeze({ id, surface, atom: Object.freeze(atom) });
}

// --- 产窗原子：相对日（首期封闭区间 -3..+3，区间外不建词） ---------------------

const REL_DAY_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([
  entry('lex:rel-day:-3', '大前天', { kind: 'REL_DAY', delta: -3 }),
  entry('lex:rel-day:-2', '前天', { kind: 'REL_DAY', delta: -2 }),
  entry('lex:rel-day:-1', '昨天', { kind: 'REL_DAY', delta: -1 }),
  entry('lex:rel-day:+0:today', '今天', { kind: 'REL_DAY', delta: 0 }),
  entry('lex:rel-day:+0:jinr', '今儿', { kind: 'REL_DAY', delta: 0 }),
  entry('lex:rel-day:+0:jinrge', '今儿个', { kind: 'REL_DAY', delta: 0 }),
  entry('lex:rel-day:+1', '明天', { kind: 'REL_DAY', delta: 1 }),
  entry('lex:rel-day:+2', '后天', { kind: 'REL_DAY', delta: 2 }),
  entry('lex:rel-day:+3', '大后天', { kind: 'REL_DAY', delta: 3 }),
]);

// --- 产窗原子：周偏移（必须与星期序组合，裸说不产日期原子） ---------------------

const WEEK_OFFSET_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([
  entry('lex:week-offset:-2:shangshang', '上上周', { kind: 'WEEK_OFFSET', offset: -2 }),
  entry('lex:week-offset:-2:xingqi', '上上星期', { kind: 'WEEK_OFFSET', offset: -2 }),
  entry('lex:week-offset:-1:zhou', '上周', { kind: 'WEEK_OFFSET', offset: -1 }),
  entry('lex:week-offset:-1:xingqi', '上星期', { kind: 'WEEK_OFFSET', offset: -1 }),
  entry('lex:week-offset:0:ben', '本周', { kind: 'WEEK_OFFSET', offset: 0 }),
  entry('lex:week-offset:0:zhe', '这周', { kind: 'WEEK_OFFSET', offset: 0 }),
  entry('lex:week-offset:+1:zhou', '下周', { kind: 'WEEK_OFFSET', offset: 1 }),
  entry('lex:week-offset:+1:xingqi', '下星期', { kind: 'WEEK_OFFSET', offset: 1 }),
  entry('lex:week-offset:+2:xiaxia', '下下周', { kind: 'WEEK_OFFSET', offset: 2 }),
  entry('lex:week-offset:+2:xingqi', '下下星期', { kind: 'WEEK_OFFSET', offset: 2 }),
]);

// --- 短路词：内容嫌疑（G 类，仲裁非对称：命中即压过过滤信号） -------------------

const CONTENT_SUSPECT_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([
  entry('lex:short:content:ji-hao-le', '记好了', { kind: 'SHORT_CIRCUIT', flag: 'CONTENT_SUSPECT' }),
  entry('lex:short:content:ding-zai', '定在', { kind: 'SHORT_CIRCUIT', flag: 'CONTENT_SUSPECT' }),
  entry('lex:short:content:an-pai-zai', '安排在', { kind: 'SHORT_CIRCUIT', flag: 'CONTENT_SUSPECT' }),
  entry('lex:short:content:yue-zai', '约在', { kind: 'SHORT_CIRCUIT', flag: 'CONTENT_SUSPECT' }),
  entry('lex:short:content:gai-cheng', '改成', { kind: 'SHORT_CIRCUIT', flag: 'CONTENT_SUSPECT' }),
  entry('lex:short:content:ti-xing-wo', '提醒我', { kind: 'SHORT_CIRCUIT', flag: 'CONTENT_SUSPECT' }),
  entry('lex:short:content:bie-wang-le', '别忘了', { kind: 'SHORT_CIRCUIT', flag: 'CONTENT_SUSPECT' }),
]);

// --- 短路词：疑问焦点（问的是答案不是过滤窗） ---------------------------------

const QUESTION_FOCUS_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([
  entry('lex:short:question:ji-dian', '几点', { kind: 'SHORT_CIRCUIT', flag: 'QUESTION_FOCUS' }),
  entry('lex:short:question:shen-me-shi-hou', '什么时候', { kind: 'SHORT_CIRCUIT', flag: 'QUESTION_FOCUS' }),
  entry('lex:short:question:sha-shi-hou', '啥时候', { kind: 'SHORT_CIRCUIT', flag: 'QUESTION_FOCUS' }),
  entry('lex:short:question:na-tian', '哪天', { kind: 'SHORT_CIRCUIT', flag: 'QUESTION_FOCUS' }),
  entry('lex:short:question:ji-hao', '几号', { kind: 'SHORT_CIRCUIT', flag: 'QUESTION_FOCUS' }),
  entry('lex:short:question:duo-jiu', '多久', { kind: 'SHORT_CIRCUIT', flag: 'QUESTION_FOCUS' }),
]);

// --- 短路词：模糊（不猜具体窗） ----------------------------------------------

const VAGUE_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([
  entry('lex:short:vague:zui-jin', '最近', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:qian-xie-tian', '前些天', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:na-tian', '那天', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:you-yi-ci', '有一次', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:dang-shi', '当时', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:gai-tian', '改天', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:you-kong-de-shi-hou', '有空的时候', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:ling-chen', '凌晨', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:zao-shang', '早上', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:shang-wu', '上午', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:zhong-wu', '中午', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:xia-wu', '下午', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:bang-wan', '傍晚', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:wan-shang', '晚上', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:ban-ye', '半夜', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:zhou-mo', '周末', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:yue-di', '月底', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:yue-chu', '月初', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:zuo-you', '左右', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
  entry('lex:short:vague:da-gai', '大概', { kind: 'SHORT_CIRCUIT', flag: 'VAGUE' }),
]);

// --- 短路词：时长（说的是持续长度不是过滤窗） ---------------------------------

const DURATION_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([
  entry('lex:short:duration:chi-xu', '持续', { kind: 'SHORT_CIRCUIT', flag: 'DURATION' }),
  entry('lex:short:duration:lian-xu', '连续', { kind: 'SHORT_CIRCUIT', flag: 'DURATION' }),
]);

// --- 短路词：周期（不是单次事件，不产单窗；周期第五态归后续阶段） ---------------

const RECURRING_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([
  entry('lex:short:recurring:mei-tian', '每天', { kind: 'SHORT_CIRCUIT', flag: 'RECURRING' }),
  entry('lex:short:recurring:mei-wan', '每晚', { kind: 'SHORT_CIRCUIT', flag: 'RECURRING' }),
  entry('lex:short:recurring:mei-zhou', '每周', { kind: 'SHORT_CIRCUIT', flag: 'RECURRING' }),
  entry('lex:short:recurring:mei-yue', '每月', { kind: 'SHORT_CIRCUIT', flag: 'RECURRING' }),
  entry('lex:short:recurring:mei-nian', '每年', { kind: 'SHORT_CIRCUIT', flag: 'RECURRING' }),
  entry('lex:short:recurring:mei-ge', '每隔', { kind: 'SHORT_CIRCUIT', flag: 'RECURRING' }),
]);

// --- 短路词：超资产范围（农历/节气/节假日/调休首期全挂起，不建表） --------------

const OUT_OF_ASSET_RANGE_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([
  entry('lex:short:asset:nong-li', '农历', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:yin-li', '阴历', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:zheng-yue', '正月', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:la-yue', '腊月', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:jie-qi', '节气', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:li-chun', '立春', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:chun-fen', '春分', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:qiu-fen', '秋分', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:dong-zhi', '冬至', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:yuan-dan', '元旦', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:chun-jie', '春节', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:duan-wu', '端午', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:zhong-qiu', '中秋', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:qing-ming', '清明', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:guo-qing', '国庆', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:wu-yi', '五一', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:lao-dong-jie', '劳动节', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:jie-jia-ri', '节假日', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:tiao-xiu', '调休', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:gong-zuo-ri', '工作日', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
  entry('lex:short:asset:huang-jin-zhou', '黄金周', { kind: 'SHORT_CIRCUIT', flag: 'OUT_OF_ASSET_RANGE' }),
]);

// --- 数字归一原子：汉字数字（全角/阿拉伯数字由文法侧按码位直接归一） --------------

const NUMERAL_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([
  entry('lex:num:0:ling', '零', { kind: 'NUMERAL', value: 0 }),
  entry('lex:num:0:ling2', '〇', { kind: 'NUMERAL', value: 0 }),
  entry('lex:num:0:ling3', '○', { kind: 'NUMERAL', value: 0 }),
  entry('lex:num:1:yi', '一', { kind: 'NUMERAL', value: 1 }),
  entry('lex:num:1:yi-daxie', '壹', { kind: 'NUMERAL', value: 1 }),
  entry('lex:num:2:er', '二', { kind: 'NUMERAL', value: 2 }),
  entry('lex:num:2:er-daxie', '贰', { kind: 'NUMERAL', value: 2 }),
  entry('lex:num:2:liang', '两', { kind: 'NUMERAL', value: 2 }),
  entry('lex:num:3:san', '三', { kind: 'NUMERAL', value: 3 }),
  entry('lex:num:3:san-daxie', '叁', { kind: 'NUMERAL', value: 3 }),
  entry('lex:num:4:si', '四', { kind: 'NUMERAL', value: 4 }),
  entry('lex:num:4:si-daxie', '肆', { kind: 'NUMERAL', value: 4 }),
  entry('lex:num:5:wu', '五', { kind: 'NUMERAL', value: 5 }),
  entry('lex:num:5:wu-daxie', '伍', { kind: 'NUMERAL', value: 5 }),
  entry('lex:num:6:liu', '六', { kind: 'NUMERAL', value: 6 }),
  entry('lex:num:6:liu-daxie', '陆', { kind: 'NUMERAL', value: 6 }),
  entry('lex:num:7:qi', '七', { kind: 'NUMERAL', value: 7 }),
  entry('lex:num:7:qi-daxie', '柒', { kind: 'NUMERAL', value: 7 }),
  entry('lex:num:8:ba', '八', { kind: 'NUMERAL', value: 8 }),
  entry('lex:num:8:ba-daxie', '捌', { kind: 'NUMERAL', value: 8 }),
  entry('lex:num:9:jiu', '九', { kind: 'NUMERAL', value: 9 }),
  entry('lex:num:9:jiu-daxie', '玖', { kind: 'NUMERAL', value: 9 }),
  entry('lex:num:10:shi', '十', { kind: 'NUMERAL', value: 10 }),
  entry('lex:num:10:shi-daxie', '拾', { kind: 'NUMERAL', value: 10 }),
  entry('lex:num:20:nian', '廿', { kind: 'NUMERAL', value: 20 }),
  entry('lex:num:30:sa', '卅', { kind: 'NUMERAL', value: 30 }),
]);

/**
 * L0 词表主数据（批 2 已按封闭清单填满）。
 * 运行期只读：数组与每个条目、每个原子均在构建期 Object.freeze，
 * 任何模块 mutate 都会在严格模式下抛 TypeError。
 */
export const TIME_LEXICON_ENTRIES: readonly TimeLexiconEntry[] = Object.freeze([
  ...REL_DAY_ENTRIES,
  ...WEEK_OFFSET_ENTRIES,
  ...CONTENT_SUSPECT_ENTRIES,
  ...QUESTION_FOCUS_ENTRIES,
  ...VAGUE_ENTRIES,
  ...DURATION_ENTRIES,
  ...RECURRING_ENTRIES,
  ...OUT_OF_ASSET_RANGE_ENTRIES,
  ...NUMERAL_ENTRIES,
]);
