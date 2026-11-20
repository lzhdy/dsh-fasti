/**
 * L1 词法 + L2 声明式文法（#127 阶段 1.5，休眠零件，不接线）。
 *
 * 定位：把一句自然语言切成"封闭语义原子 + 数字 + 文法终结符"，再用声明式产生式表
 * 组合成不含毫秒的符号 TimeIR。**本模块不读时钟、不持有锚点、不 import gate/bm25/store**，
 * 因此同输入 + 同资产版本必逐字节同形（T1/T10 据此断言）。
 *
 * 为什么不是"正则定式匹配"（主控 2026-11-19 否决路线一的原话："无法穷尽所有可能的情况
 * 就不应该使用定式匹配"）：
 *  - 穷举责任被放在**数据**（time-lexicon 的 surface 表）而不是字符串模式里，
 *    增删说法＝加一条常量 + 一条夹具，不需要重写规则、不会互相打架；
 *  - 组合责任被放在**声明式产生式表**（PRODUCTIONS），规则是"序列模式 + 组合器"，
 *    不是整句模板；"上周五/上星期五/上周星期五" 三种写法共用同一组原子与产生式，
 *    而不是三条并列正则；
 *  - 没把握的形态不是靠正则兜住，而是**结构上产不出**：裸周偏移没有配套产生式，
 *    就只能落 NONE，宁空勿错。
 *  本文件刻意零正则字面量（T9 静态门禁），扫描是单趟线性、无回溯风险。
 *
 * 边界（细则第四节 + 主控 2026-11-19 两条拍板 + #132 扩面）：产窗原子为 REL_DAY /
 * WEEK_OFFSET×WEEKDAY / WEEK_OF（裸周偏移整周）/ YEAR_MONTH_DAY（仅四位年份）/ MONTH_DAY /
 * RELATIVE_SPAN（#132 方位＋数字＋天/周单位的有限半开跨度，周折 7N 天、粒度仍 DAY）；
 * #132 无界方位/月年冻结/指示只产 flag 留痕（date=null）不造窗，指代词不在日历通道；
 * 清单外说法一律 NONE 或 UNCERTAIN，绝不抛错、绝不猜、绝不补开放区间另一端；
 * 两位年份不闭合，回落 MONTH_DAY 走 MISSING_YEAR。
 */

import { TIME_LEXICON_ENTRIES } from './time-lexicon.ts';
import type { TimeDirectionSense, TimeLexiconAtom } from './time-lexicon.ts';
import type { IsoWeekday, RelativeSpanMode, TextSpan, TimeDateExpr, TimeEvidence, TimeFlag, TimeGranularity, TimeIR, TimeRole } from './types.ts';

// ===========================================================================
// 文法终结符（不在词表原子里、但文法必须认识的单字/词：单位与星期前缀）
// ===========================================================================

export type GrammarTerminal = 'NIAN' | 'YUE' | 'RI' | 'HAO' | 'XINGQI' | 'LIBAI' | 'ZHOU' | 'TIAN';

interface TerminalEntry {
  readonly surface: string;
  readonly term: GrammarTerminal;
}

/** 长词优先（星期/礼拜 先于 周，避免 "星期日" 被拆成 周 + 日 之外的多解）。 */
const GRAMMAR_TERMINALS: readonly TerminalEntry[] = Object.freeze([
  Object.freeze({ surface: '星期', term: 'XINGQI' as GrammarTerminal }),
  Object.freeze({ surface: '礼拜', term: 'LIBAI' as GrammarTerminal }),
  Object.freeze({ surface: '年', term: 'NIAN' as GrammarTerminal }),
  Object.freeze({ surface: '月', term: 'YUE' as GrammarTerminal }),
  Object.freeze({ surface: '日', term: 'RI' as GrammarTerminal }),
  Object.freeze({ surface: '号', term: 'HAO' as GrammarTerminal }),
  Object.freeze({ surface: '周', term: 'ZHOU' as GrammarTerminal }),
  Object.freeze({ surface: '天', term: 'TIAN' as GrammarTerminal }),
]);

/** 星期前缀终结符集合（"周五/星期五/礼拜五" 三种前缀同构）。 */
const WEEK_PREFIX_TERMS: readonly GrammarTerminal[] = Object.freeze(['XINGQI', 'LIBAI', 'ZHOU'] as GrammarTerminal[]);

/** 日单位终结符集合（"19日/19号" 同义）。 */
const DAY_UNIT_TERMS: readonly GrammarTerminal[] = Object.freeze(['RI', 'HAO'] as GrammarTerminal[]);

/** 星期序=7 的两种写法（"星期日/礼拜天"）。 */
const WEEKDAY7_TERMS: readonly GrammarTerminal[] = Object.freeze(['RI', 'TIAN'] as GrammarTerminal[]);

/** #132 可闭合相对跨度的封闭单位：天/周（周滚动折 7N 天，仍产 DAY 窗）。 */
const SPAN_UNIT_TERMS: readonly GrammarTerminal[] = Object.freeze(['TIAN', 'ZHOU'] as GrammarTerminal[]);

/** #132 粒度冻结单位：年/月只认出留痕（GRAIN_NOT_SUPPORTED），不造窗、禁 clamp。 */
const FROZEN_GRAIN_TERMS: readonly GrammarTerminal[] = Object.freeze(['YUE', 'NIAN'] as GrammarTerminal[]);

// ===========================================================================
// 词表索引（构建期一次性装配，运行期只读；确定性排序保证重放同形）
// ===========================================================================

interface SurfaceHit {
  readonly surface: string;
  readonly atom: TimeLexiconAtom;
  readonly entryId: string;
}

const SURFACE_INDEX: readonly SurfaceHit[] = Object.freeze(
  TIME_LEXICON_ENTRIES.map((e) => Object.freeze({ surface: e.surface, atom: e.atom, entryId: e.id })).sort(
    (a, b) => b.surface.length - a.surface.length || (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0),
  ),
);

const NUMERAL_BY_CHAR: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const e of TIME_LEXICON_ENTRIES) {
    if (e.atom.kind === 'NUMERAL') map.set(e.surface, e.atom.value);
  }
  return map;
})();

// ===========================================================================
// L1：词法
// ===========================================================================

export type TimeToken =
  | { readonly kind: 'NUM'; readonly span: TextSpan; readonly value: number; readonly digits: string }
  | { readonly kind: 'ATOM'; readonly span: TextSpan; readonly atom: TimeLexiconAtom; readonly entryId: string }
  | { readonly kind: 'TERM'; readonly span: TextSpan; readonly term: GrammarTerminal };

/** 半角/全角阿拉伯数字 → 数值（全角按码位直接折算，不依赖任何宿主本地化能力）。 */
function asciiDigitValue(ch: string): number | null {
  const code = ch.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0xff10 && code <= 0xff19) return code - 0xff10;
  return null;
}

interface NumeralPart {
  readonly value: number;
  readonly char: string;
}

/** 数字串归一：十/廿/卅 走位值组合，纯数字走逐位拼接（"二〇二六"→2026）。 */
function computeNumeral(parts: readonly NumeralPart[]): { readonly value: number; readonly digits: string } {
  const hasTens = parts.some((p) => p.value >= 10);
  if (!hasTens) {
    const digits = parts.map((p) => String(p.value)).join('');
    return { value: Number(digits), digits };
  }
  const first = parts[0];
  if (first === undefined) return { value: 0, digits: '0' };
  let value = 0;
  let at = 0;
  if (first.value >= 10) {
    value = first.value;
    at = 1;
  } else {
    const marker = parts[1];
    if (marker === undefined || marker.value < 10) {
      const digits = parts.map((p) => String(p.value)).join('');
      return { value: Number(digits), digits };
    }
    value = first.value * marker.value;
    at = 2;
  }
  const unit = parts[at];
  if (unit !== undefined) {
    if (unit.value >= 10) {
      const digits = parts.map((p) => String(p.value)).join('');
      return { value: Number(digits), digits };
    }
    value += unit.value;
    at += 1;
  }
  if (at !== parts.length) {
    const digits = parts.map((p) => String(p.value)).join('');
    return { value: Number(digits), digits };
  }
  return { value, digits: String(value) };
}

interface NumeralRun {
  readonly value: number;
  readonly digits: string;
  readonly end: number;
}

function scanNumeralRun(text: string, start: number): NumeralRun | null {
  const parts: NumeralPart[] = [];
  let at = start;
  while (at < text.length) {
    const ch = text[at] as string;
    const arabic = asciiDigitValue(ch);
    if (arabic !== null) {
      parts.push({ value: arabic, char: ch });
      at += 1;
      continue;
    }
    const han = NUMERAL_BY_CHAR.get(ch);
    if (han === undefined) break;
    parts.push({ value: han, char: ch });
    at += 1;
  }
  if (parts.length === 0) return null;
  const computed = computeNumeral(parts);
  return { value: computed.value, digits: computed.digits, end: at };
}

function longestSurfaceAt(text: string, at: number): SurfaceHit | null {
  for (const hit of SURFACE_INDEX) {
    if (text.startsWith(hit.surface, at)) return hit;
  }
  return null;
}

function longestTerminalAt(text: string, at: number): TerminalEntry | null {
  for (const entry of GRAMMAR_TERMINALS) {
    if (text.startsWith(entry.surface, at)) return entry;
  }
  return null;
}

/**
 * 单趟线性扫描：最长词表命中 → 数字串 → 文法终结符 → 逐字符跳过。
 * 无正则、无回溯；未命中字符（标点/空白/任意噪声）直接跳过，因此坏输入不抛错。
 *
 * 注意（#128 A1）：本函数产出的 tokens 数组"下标相邻"不代表原文相邻，
 * 中间可能隔着被跳过的整句话。L2 拼装前必须再验一次原文邻接（见 isContiguous）。
 */
export function tokenizeTimeText(text: string): readonly TimeToken[] {
  const tokens: TimeToken[] = [];
  let at = 0;
  while (at < text.length) {
    const hit = longestSurfaceAt(text, at);
    if (hit !== null && hit.atom.kind === 'NUMERAL') {
      const run = scanNumeralRun(text, at);
      if (run !== null) {
        tokens.push({ kind: 'NUM', span: [at, run.end], value: run.value, digits: run.digits });
        at = run.end;
        continue;
      }
    }
    if (hit !== null) {
      tokens.push({ kind: 'ATOM', span: [at, at + hit.surface.length], atom: hit.atom, entryId: hit.entryId });
      at += hit.surface.length;
      continue;
    }
    const arabic = asciiDigitValue(text[at] as string);
    if (arabic !== null) {
      const run = scanNumeralRun(text, at);
      if (run !== null) {
        tokens.push({ kind: 'NUM', span: [at, run.end], value: run.value, digits: run.digits });
        at = run.end;
        continue;
      }
    }
    const terminal = longestTerminalAt(text, at);
    if (terminal !== null) {
      tokens.push({ kind: 'TERM', span: [at, at + terminal.surface.length], term: terminal.term });
      at += terminal.surface.length;
      continue;
    }
    at += 1;
  }
  return tokens;
}

// ===========================================================================
// L2：声明式产生式（序列模式 + 组合器，不是整句模板）
// ===========================================================================

interface NumPart {
  readonly type: 'NUM';
  readonly optional?: boolean;
  /** 允许的十进制位数（年份区分 4 位/2 位，星期序只允许 1 位）。 */
  readonly digitLen?: readonly number[];
  readonly min?: number;
  readonly max?: number;
}

interface TermPart {
  readonly type: 'TERM';
  readonly optional?: boolean;
  readonly terms: readonly GrammarTerminal[];
}

interface AtomPart {
  readonly type: 'ATOM';
  readonly optional?: boolean;
  readonly atomKinds: readonly TimeLexiconAtom['kind'][];
  /** #132：当 atomKinds 含 DIRECTION 时，可进一步限定封闭方位 sense（不填则任意 sense）。 */
  readonly sense?: TimeDirectionSense;
}

type Part = NumPart | TermPart | AtomPart;

interface ProductionResult {
  /** #132 起文法留痕产生式可只产 flag、date=null（开放方位/月年冻结/指示），交由 L3 降级。 */
  readonly date: TimeDateExpr | null;
  readonly granularity: TimeGranularity;
  readonly flags: readonly TimeFlag[];
  readonly extraEvidence: readonly TimeEvidence[];
}

interface Production {
  readonly id: string;
  readonly parts: readonly Part[];
  readonly build: (matched: readonly TimeToken[], text: string) => ProductionResult | null;
}

/** 各月天数上限；2 月按 29 放行（闰年判定归 L3 求解器，文法层不猜年份）。 */
const MAX_DAY_OF_MONTH: readonly number[] = Object.freeze([0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

function isValidCivilMonthDay(month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const maxDay = MAX_DAY_OF_MONTH[month];
  if (maxDay === undefined) return false;
  return day >= 1 && day <= maxDay;
}

function numToken(token: TimeToken | undefined): Extract<TimeToken, { kind: 'NUM' }> | null {
  return token !== undefined && token.kind === 'NUM' ? token : null;
}

function atomToken(token: TimeToken | undefined): Extract<TimeToken, { kind: 'ATOM' }> | null {
  return token !== undefined && token.kind === 'ATOM' ? token : null;
}

function textOf(token: TimeToken, text: string): string {
  return text.slice(token.span[0], token.span[1]);
}

function weekOffsetOf(token: TimeToken | undefined): number {
  const atom = atomToken(token);
  return atom !== null && atom.atom.kind === 'WEEK_OFFSET' ? atom.atom.offset : 0;
}

function weekdayOfNum(token: TimeToken | undefined): IsoWeekday | null {
  const num = numToken(token);
  if (num === null) return null;
  if (num.value < 1 || num.value > 7) return null;
  return num.value as IsoWeekday;
}

/** 构造期冻结（保留对象字面量的上下文类型推导，避免 Object.freeze 把联合类型拓宽）。 */
function production(p: Production): Production {
  return Object.freeze(p);
}

/** #132 封闭单位终结符 → RELATIVE_SPAN 单位（年/月不在此列，返回 null）。 */
function spanUnitOf(token: TimeToken | undefined): 'DAY' | 'WEEK' | null {
  if (token === undefined || token.kind !== 'TERM') return null;
  if (token.term === 'TIAN') return 'DAY';
  if (token.term === 'ZHOU') return 'WEEK';
  return null;
}

/** #132 构造 RELATIVE_SPAN 符号原子；amount 必须正整数、单位仅天/周，否则结构不成立。 */
function relativeSpanResult(
  mode: RelativeSpanMode,
  numTok: TimeToken | undefined,
  unitTok: TimeToken | undefined,
): ProductionResult | null {
  const num = numToken(numTok);
  const unit = spanUnitOf(unitTok);
  if (num === null || unit === null || num.value < 1) return null;
  return {
    date: { kind: 'RELATIVE_SPAN', mode, amount: num.value, unit },
    granularity: 'DAY',
    flags: [],
    extraEvidence: [],
  };
}

/** #132 只认出不造窗的留痕结果（date=null，L3 按 flag 裁决到对应新 reason）。 */
function flaggedResult(flag: TimeFlag): ProductionResult {
  return { date: null, granularity: 'DAY', flags: [flag], extraEvidence: [] };
}

const PRODUCTIONS: readonly Production[] = Object.freeze([
  // 1. 完整年月日（主控拍板：只认四位年份；两位年份在本产生式落不了，回落 gram:month-day）
  production({
    id: 'gram:year-month-day',
    parts: [
      { type: 'NUM', digitLen: [4] },
      { type: 'TERM', terms: ['NIAN'] },
      { type: 'NUM' },
      { type: 'TERM', terms: ['YUE'] },
      { type: 'NUM' },
      { type: 'TERM', terms: DAY_UNIT_TERMS },
    ],
    build: (m, text) => {
      const yearTok = numToken(m[0]);
      const monthTok = numToken(m[2]);
      const dayTok = numToken(m[4]);
      if (yearTok === null || monthTok === null || dayTok === null) return null;
      const year = yearTok.value;
      const flags: TimeFlag[] = [];
      if (!isValidCivilMonthDay(monthTok.value, dayTok.value)) flags.push('INVALID_CALENDAR');
      const extraEvidence: TimeEvidence[] = [];
      return {
        date: { kind: 'YEAR_MONTH_DAY', year, month: monthTok.value, day: dayTok.value },
        granularity: 'DAY',
        flags,
        extraEvidence,
      };
    },
  }),
  // 2. 无年份月日：11月19日 —— 只产 MONTH_DAY 原子，补年归 L4 拒绝
  production({
    id: 'gram:month-day',
    parts: [
      { type: 'NUM' },
      { type: 'TERM', terms: ['YUE'] },
      { type: 'NUM' },
      { type: 'TERM', terms: DAY_UNIT_TERMS },
    ],
    build: (m) => {
      const monthTok = numToken(m[0]);
      const dayTok = numToken(m[2]);
      if (monthTok === null || dayTok === null) return null;
      const flags: TimeFlag[] = [];
      if (!isValidCivilMonthDay(monthTok.value, dayTok.value)) flags.push('INVALID_CALENDAR');
      return {
        date: { kind: 'MONTH_DAY', month: monthTok.value, day: dayTok.value },
        granularity: 'DAY',
        flags,
        extraEvidence: [],
      };
    },
  }),
  // 3. 周偏移 + 星期前缀 + 星期序：上周星期五
  production({
    id: 'gram:offset-prefix-weekday',
    parts: [
      { type: 'ATOM', atomKinds: ['WEEK_OFFSET'] },
      { type: 'TERM', terms: WEEK_PREFIX_TERMS },
      { type: 'NUM', digitLen: [1], min: 1, max: 7 },
    ],
    build: (m) => {
      const weekday = weekdayOfNum(m[2]);
      if (weekday === null) return null;
      return {
        date: { kind: 'WEEKDAY_OF_WEEK', weekOffset: weekOffsetOf(m[0]), weekday },
        granularity: 'DAY',
        flags: [],
        extraEvidence: [],
      };
    },
  }),
  // 4. 周偏移 + 星期序：上周五 / 上上周一
  production({
    id: 'gram:offset-weekday',
    parts: [
      { type: 'ATOM', atomKinds: ['WEEK_OFFSET'] },
      { type: 'NUM', digitLen: [1], min: 1, max: 7 },
    ],
    build: (m) => {
      const weekday = weekdayOfNum(m[1]);
      if (weekday === null) return null;
      return {
        date: { kind: 'WEEKDAY_OF_WEEK', weekOffset: weekOffsetOf(m[0]), weekday },
        granularity: 'DAY',
        flags: [],
        extraEvidence: [],
      };
    },
  }),
  // 5. 星期前缀 + 星期序：周五 / 星期五 / 礼拜三
  production({
    id: 'gram:prefix-weekday',
    parts: [
      { type: 'TERM', terms: WEEK_PREFIX_TERMS },
      { type: 'NUM', digitLen: [1], min: 1, max: 7 },
    ],
    build: (m) => {
      const weekday = weekdayOfNum(m[1]);
      if (weekday === null) return null;
      return {
        date: { kind: 'WEEKDAY_OF_WEEK', weekOffset: 0, weekday },
        granularity: 'DAY',
        flags: [],
        extraEvidence: [],
      };
    },
  }),
  // 6. [周偏移] + 星期前缀 + 星期日/天：周日 / 星期天 / 礼拜日 / 上星期日
  production({
    id: 'gram:prefix-weekday7',
    parts: [
      { type: 'ATOM', optional: true, atomKinds: ['WEEK_OFFSET'] },
      { type: 'TERM', terms: WEEK_PREFIX_TERMS },
      { type: 'TERM', terms: WEEKDAY7_TERMS },
    ],
    build: (m) => {
      const hasOffset = atomToken(m[0]) !== null;
      return {
        date: { kind: 'WEEKDAY_OF_WEEK', weekOffset: hasOffset ? weekOffsetOf(m[0]) : 0, weekday: 7 },
        granularity: 'DAY',
        flags: [],
        extraEvidence: [],
      };
    },
  }),
  // 7. 周偏移 + 星期日/天：上周日 / 下下星期天
  production({
    id: 'gram:offset-weekday7',
    parts: [
      { type: 'ATOM', atomKinds: ['WEEK_OFFSET'] },
      { type: 'TERM', terms: WEEKDAY7_TERMS },
    ],
    build: (m) => ({
      date: { kind: 'WEEKDAY_OF_WEEK', weekOffset: weekOffsetOf(m[0]), weekday: 7 },
      granularity: 'DAY',
      flags: [],
      extraEvidence: [],
    }),
  }),
  // 8. 裸周偏移整周（主控拍板："上周"默认周一到周日一整周，粒度 WEEK）。
  // 放在所有带星期序的周规则之后、由最长匹配兜底——"上周五" 仍走 gram:offset-weekday。
  production({
    id: 'gram:week-of',
    parts: [
      { type: 'ATOM', atomKinds: ['WEEK_OFFSET'] },
    ],
    build: (m) => {
      const atom = atomToken(m[0]);
      if (atom === null || atom.atom.kind !== 'WEEK_OFFSET') return null;
      return {
        date: { kind: 'WEEK_OF', weekOffset: atom.atom.offset },
        granularity: 'WEEK',
        flags: [],
        extraEvidence: [],
      };
    },
  }),
  // 9. 相对日：今天/明天/大后天
  production({
    id: 'gram:rel-day',
    parts: [{ type: 'ATOM', atomKinds: ['REL_DAY'] }],
    build: (m) => {
      const atom = atomToken(m[0]);
      if (atom === null || atom.atom.kind !== 'REL_DAY') return null;
      return {
        date: { kind: 'REL_DAY', delta: atom.atom.delta },
        granularity: 'DAY',
        flags: [],
        extraEvidence: [],
      };
    },
  }),

  // ===========================================================================
  // #132 时间结构识别扩面：方位＋数字＋封闭单位的声明式产生式（F1–F9 + 留痕）
  // 可闭合者只产符号 RELATIVE_SPAN（无毫秒），端点半开公式在 L3 整数日历落地；
  // 无界/冻结粒度/指示只产 flag、date=null，宁空勿错，绝不造开放区间、绝不 clamp。
  // ===========================================================================

  // 10. 前置往过去段 F1/F7：前/过去/上 N 天·周 → [D0-Nu,D0) 不含今天。
  production({
    id: 'gram:span-back',
    parts: [
      { type: 'ATOM', atomKinds: ['DIRECTION'], sense: 'BEFORE' },
      { type: 'NUM', min: 1 },
      { type: 'TERM', terms: SPAN_UNIT_TERMS },
    ],
    build: (m) => relativeSpanResult('BACK', m[1], m[2]),
  }),
  // 11. 前置往未来段 F2/F8：后/下 N 天·周 → [D0+1,D0+1+Nu) 不含今天。
  production({
    id: 'gram:span-forward',
    parts: [
      { type: 'ATOM', atomKinds: ['DIRECTION'], sense: 'AFTER' },
      { type: 'NUM', min: 1 },
      { type: 'TERM', terms: SPAN_UNIT_TERMS },
    ],
    build: (m) => relativeSpanResult('FORWARD', m[1], m[2]),
  }),
  // 12. 前置含今未来段 F3：未来/接下来 N 天·周 → [D0,D0+Nu) 含今天。
  production({
    id: 'gram:span-within-pre',
    parts: [
      { type: 'ATOM', atomKinds: ['DIRECTION'], sense: 'AFTER_INCLUSIVE' },
      { type: 'NUM', min: 1 },
      { type: 'TERM', terms: SPAN_UNIT_TERMS },
    ],
    build: (m) => relativeSpanResult('WITHIN', m[1], m[2]),
  }),
  // 13. 后置界内段 F4/F9：N 天·周 之内/以内/内 → [D0,D0+Nu) 含今天。
  production({
    id: 'gram:span-within-post',
    parts: [
      { type: 'NUM', min: 1 },
      { type: 'TERM', terms: SPAN_UNIT_TERMS },
      { type: 'ATOM', atomKinds: ['DIRECTION'], sense: 'WITHIN' },
    ],
    build: (m) => relativeSpanResult('WITHIN', m[0], m[1]),
  }),
  // 14. 后置单点 F5：N 天·周 前（单纯方位词，非"之前"）→ D0-N 单日窗。
  production({
    id: 'gram:point-before',
    parts: [
      { type: 'NUM', min: 1 },
      { type: 'TERM', terms: SPAN_UNIT_TERMS },
      { type: 'ATOM', atomKinds: ['DIRECTION'], sense: 'BEFORE' },
    ],
    build: (m) => relativeSpanResult('BEFORE_POINT', m[0], m[1]),
  }),
  // 15. 后置单点 F6：N 天·周 后（单纯方位词，非"以后"）→ D0+N 单日窗。
  production({
    id: 'gram:point-after',
    parts: [
      { type: 'NUM', min: 1 },
      { type: 'TERM', terms: SPAN_UNIT_TERMS },
      { type: 'ATOM', atomKinds: ['DIRECTION'], sense: 'AFTER' },
    ],
    build: (m) => relativeSpanResult('AFTER_POINT', m[0], m[1]),
  }),
  // 16. 裸方位无界 U1：之前/之后/以前/以后/以来… 单说只留痕，不补另一端。
  production({
    id: 'gram:open-direction-bare',
    parts: [{ type: 'ATOM', atomKinds: ['DIRECTION'], sense: 'OPEN' }],
    build: () => flaggedResult('OPEN_DIRECTIONAL'),
  }),
  // 17. 后置合成方位无界 U2/U4：N 天·周 以后/之后/以来/之外…（与单纯"前/后"单点严格区分）。
  production({
    id: 'gram:open-post-span',
    parts: [
      { type: 'NUM', min: 1 },
      { type: 'TERM', terms: SPAN_UNIT_TERMS },
      { type: 'ATOM', atomKinds: ['DIRECTION'], sense: 'OPEN' },
    ],
    build: () => flaggedResult('OPEN_DIRECTIONAL'),
  }),
  // 18a. 星期序7＋开放方位 U2：周日之后（整体留痕，最长匹配压过单用"周日"造窗）。
  production({
    id: 'gram:open-after-weekday7',
    parts: [
      { type: 'TERM', terms: WEEK_PREFIX_TERMS },
      { type: 'TERM', terms: WEEKDAY7_TERMS },
      { type: 'ATOM', atomKinds: ['DIRECTION'], sense: 'OPEN' },
    ],
    build: () => flaggedResult('OPEN_DIRECTIONAL'),
  }),
  // 18b. 星期前缀＋数字星期序＋开放方位：周三之后、礼拜五以前。
  production({
    id: 'gram:open-after-prefix-weekday',
    parts: [
      { type: 'TERM', terms: WEEK_PREFIX_TERMS },
      { type: 'NUM', digitLen: [1], min: 1, max: 7 },
      { type: 'ATOM', atomKinds: ['DIRECTION'], sense: 'OPEN' },
    ],
    build: () => flaggedResult('OPEN_DIRECTIONAL'),
  }),
  // 19. 指示限定 T6：这/那 N 天·周方向靠语境，首版开放留痕、不硬选方向（区别于指代通道）。
  production({
    id: 'gram:open-demonstrative',
    parts: [
      { type: 'ATOM', atomKinds: ['DEMONSTRATIVE'] },
      { type: 'NUM', min: 1 },
      { type: 'TERM', terms: SPAN_UNIT_TERMS },
    ],
    build: () => flaggedResult('OPEN_DIRECTIONAL'),
  }),
  // 20. 月/年粒度冻结 T9：方向（＋数）＋年/月 只认出留痕，不引"个"、不建 MONTH/YEAR 窗、禁折算。
  production({
    id: 'gram:grain-frozen-direction',
    parts: [
      { type: 'ATOM', atomKinds: ['DIRECTION'] },
      { type: 'NUM', optional: true, min: 1 },
      { type: 'TERM', terms: FROZEN_GRAIN_TERMS },
    ],
    build: () => flaggedResult('GRAIN_NOT_SUPPORTED'),
  }),
]);

function consumePart(part: Part, tokens: readonly TimeToken[], at: number): { token: TimeToken; next: number } | null {
  const token = tokens[at];
  if (token === undefined) return null;
  if (part.type === 'NUM') {
    if (token.kind !== 'NUM') return null;
    if (part.digitLen !== undefined && !part.digitLen.includes(token.digits.length)) return null;
    if (part.min !== undefined && token.value < part.min) return null;
    if (part.max !== undefined && token.value > part.max) return null;
    return { token, next: at + 1 };
  }
  if (part.type === 'TERM') {
    if (token.kind !== 'TERM') return null;
    if (!part.terms.includes(token.term)) return null;
    return { token, next: at + 1 };
  }
  if (token.kind !== 'ATOM') return null;
  if (!part.atomKinds.includes(token.atom.kind)) return null;
  if (part.sense !== undefined) {
    if (token.atom.kind !== 'DIRECTION' || token.atom.sense !== part.sense) return null;
  }
  return { token, next: at + 1 };
}

function matchParts(parts: readonly Part[], tokens: readonly TimeToken[], at: number, index: number, acc: TimeToken[]): TimeToken[] | null {
  if (index === parts.length) return acc;
  const part = parts[index];
  if (part === undefined) return null;
  if (part.optional === true) {
    const withPart = consumePart(part, tokens, at);
    if (withPart !== null) {
      const greedy = matchParts(parts, tokens, withPart.next, index + 1, [...acc, withPart.token]);
      if (greedy !== null) return greedy;
    }
    return matchParts(parts, tokens, at, index + 1, acc);
  }
  const consumed = consumePart(part, tokens, at);
  if (consumed === null) return null;
  return matchParts(parts, tokens, consumed.next, index + 1, [...acc, consumed.token]);
}

// ===========================================================================
// 对外入口：产 TimeIR（不含毫秒、不读锚点）
// ===========================================================================

function shortCircuitIr(token: Extract<TimeToken, { kind: 'ATOM' }>, text: string): TimeIR {
  if (token.atom.kind !== 'SHORT_CIRCUIT') throw new Error('shortCircuitIr 只接受短路原子');
  const flag = token.atom.flag;
  const role: TimeRole =
    flag === 'CONTENT_SUSPECT' ? 'CONTENT' : flag === 'QUESTION_FOCUS' ? 'QUESTION_FOCUS' : 'UNKNOWN';
  const granularity: TimeGranularity = flag === 'DURATION' ? 'DURATION' : flag === 'RECURRING' ? 'RECURRING' : 'DAY';
  return {
    span: token.span,
    role,
    date: null,
    granularity,
    flags: [flag],
    evidence: [{ ruleId: token.entryId, source: 'LEXICON', matchedText: textOf(token, text) }],
  };
}

function hasShortFlag(tokens: readonly TimeToken[], flag: TimeFlag): boolean {
  return tokens.some((t) => t.kind === 'ATOM' && t.atom.kind === 'SHORT_CIRCUIT' && t.atom.flag === flag);
}

/**
 * 空白判定（不用正则：本模块零正则纪律）：半角空格/Tab/全角空格/换行都算空白。
 * 空白是排版噪声，允许被跨越；任何其他字符（含标点、实词）都不许跨。
 */
function isGapBlank(text: string, from: number, to: number): boolean {
  for (let at = from; at < to; at += 1) {
    const code = text.charCodeAt(at);
    const blank = code === 0x20 || code === 0x09 || code === 0x3000 || code === 0x0a || code === 0x0d;
    if (!blank) return false;
  }
  return true;
}

/**
 * 原文邻接铁律（#128 A1）：相邻 token 必须在原文里真相邻（或只隔空白）。
 *
 * 为什么必须有这一条：tokenizeTimeText 对未命中汉字逐字跳过（见其上方注释），
 * 于是 tokens 数组里"相邻"的两个 token 在原文里可能隔着一整句话；若产生式仍按数组下标
 * 拼装，就会凭空造出日期（"周会材料那事我一直挂着"里的"周"＋"一"被拼成"本周一"）。
 * 外部同构做法见 SynTime（ACL 2017）：时间段扩张不得越过相邻时间词，遇逗号/连接词/非时间词即停。
 */
function isContiguous(matched: readonly TimeToken[], text: string): boolean {
  for (let index = 1; index < matched.length; index += 1) {
    const prev = matched[index - 1];
    const next = matched[index];
    if (prev === undefined || next === undefined) return false;
    if (next.span[0] < prev.span[1]) return false;
    if (!isGapBlank(text, prev.span[1], next.span[0])) return false;
  }
  return true;
}

/**
 * 解析一句自然语言，产出零到多条 TimeIR（按原文位置升序）。
 *
 * 角色仲裁（非对称，只降级不升级）：内容嫌疑词命中 → CONTENT（压过过滤与疑问信号）；
 * 否则疑问焦点词命中 → QUESTION_FOCUS；否则默认 FILTER。
 *
 * 邻接铁律（#128 A1）：产生式只在"原文相邻（或只隔空白）"的 token 序列上成立，
 * 不满足者视同没匹配上，让位给更短的合法匹配。
 */
export function parseTimeExpressions(text: string): readonly TimeIR[] {
  if (text.length === 0) return [];
  const tokens = tokenizeTimeText(text);
  if (tokens.length === 0) return [];

  const contentSuspect = hasShortFlag(tokens, 'CONTENT_SUSPECT');
  const questionFocus = hasShortFlag(tokens, 'QUESTION_FOCUS');

  const irs: TimeIR[] = [];
  for (const token of tokens) {
    if (token.kind === 'ATOM' && token.atom.kind === 'SHORT_CIRCUIT') irs.push(shortCircuitIr(token, text));
  }

  let at = 0;
  while (at < tokens.length) {
    let best: { readonly production: Production; readonly matched: readonly TimeToken[] } | null = null;
    for (const production of PRODUCTIONS) {
      const matched = matchParts(production.parts, tokens, at, 0, []);
      if (matched === null) continue;
      if (!isContiguous(matched, text)) continue;
      if (best === null || matched.length > best.matched.length) best = { production, matched };
    }
    if (best === null) {
      at += 1;
      continue;
    }
    const built = best.production.build(best.matched, text);
    if (built !== null) {
      const first = best.matched[0];
      const last = best.matched[best.matched.length - 1];
      if (first !== undefined && last !== undefined) {
        const role: TimeRole = contentSuspect ? 'CONTENT' : questionFocus ? 'QUESTION_FOCUS' : 'FILTER';
        const flags: TimeFlag[] = [...built.flags];
        if (contentSuspect && !flags.includes('CONTENT_SUSPECT')) flags.push('CONTENT_SUSPECT');
        if (!contentSuspect && questionFocus && !flags.includes('QUESTION_FOCUS')) flags.push('QUESTION_FOCUS');
        irs.push({
          span: [first.span[0], last.span[1]],
          role,
          date: built.date,
          granularity: built.granularity,
          flags,
          evidence: [
            { ruleId: best.production.id, source: 'GRAMMAR', matchedText: text.slice(first.span[0], last.span[1]) },
            ...built.extraEvidence,
          ],
        });
      }
    }
    at += best.matched.length;
  }

  irs.sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1]);
  return irs;
}
