/**
 * L3 整数日历求解器 + L4 闭合证明门（#127 阶段 1.5，休眠零件，不接线）。
 *
 * 职责：把 time-expr 产出的符号 TimeIR 折成四态信封（NONE / UNCERTAIN / CANDIDATES / WINDOW）。
 * **本模块是全栈唯一读取 TimeAnchor 的地方**：锚点毫秒由装配层注入，模块内不自取时钟、
 * 不读宿主时区、不用任何本地化能力，因此同输入同资产必逐字节同输出（T8）。
 *
 * 日历算术为什么自己写（不借宿主日期对象/本地化）：
 *  - 宿主日期对象的公历换算依赖 ICU 与 tzdata，Node 版本/编译选项/数据目录漂移会改变结果，
 *    跨机器重放对不上（盲审三家独立指出的 blocker）；
 *  - 这里只用整数：以 1970-01-01 为纪元的天序号做加法，闰年走"四年一闰、百年不闰、
 *    四百年再闰"的纯整数规则；前进一天是 addCalendarDays，不是毫秒加常数。
 *  - Asia/Shanghai 自 1991 起无夏令时，故策略固定 UTC+8、周一开篇（首期字面量唯一值）。
 *
 * 状态语义（宁空勿错）：
 *  - UNCERTAIN 一律**放行**不否决（不确定不等于无此事）；
 *  - CANDIDATES 类型上无首选字段，裁决按 OR 并集，禁直取候选数组首项；
 *  - WINDOW 只能由本模块私有的 proveClosure + makeWindow 造出，外部无法凭空拼一个窗。
 */

import { createHash } from 'node:crypto';

import { parseTimeExpressions } from './time-expr.ts';
import type {
  ClosednessProof,
  ClosureDimProof,
  ClosureState,
  RelativeSpanMode,
  TimeAnchor,
  TimeConstraint,
  TimeIR,
  TimeUncertainReason,
  TimeWindow,
} from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Asia/Shanghai 固定偏移（UTC+8，无夏令时）。 */
const ZONE_OFFSET_MS = 8 * 60 * 60 * 1000;

// ===========================================================================
// 整数民用日历（无宿主日期对象、无本地化）
// ===========================================================================

export function isLeapYear(year: number): boolean {
  if (year % 4 !== 0) return false;
  if (year % 100 !== 0) return true;
  return year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/** 民用日期 → 自 1970-01-01 起的天序号（纯整数，proleptic Gregorian）。 */
export function civilToDayIndex(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const monthShift = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * monthShift + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** 天序号 → 民用日期（civilToDayIndex 的逆）。 */
export function dayIndexToCivil(dayIndex: number): { readonly year: number; readonly month: number; readonly day: number } {
  const shifted = dayIndex + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPos = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPos + 2) / 5) + 1;
  const month = monthPos + (monthPos < 10 ? 3 : -9);
  return { year: year + (month <= 2 ? 1 : 0), month, day };
}

/**
 * 民用日历推进：唯一合法的"前进一天"途径（禁毫秒加日常数）。
 * 月份越界按天序号自然滚动，非法月日输入不修正、由调用方自行校验。
 */
export function addCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { readonly year: number; readonly month: number; readonly day: number } {
  return dayIndexToCivil(civilToDayIndex(year, month, day) + delta);
}

/** ISO 星期序：1=周一 … 7=周日（1970-01-01 是周四）。 */
function isoWeekdayOf(dayIndex: number): number {
  const remainder = (dayIndex + 3) % 7;
  return ((remainder + 7) % 7) + 1;
}

/** 锚点毫秒 → 当地民用日序号（唯一读锚点处）。 */
function localDayIndexOf(epochMs: number): number {
  return Math.floor((epochMs + ZONE_OFFSET_MS) / DAY_MS);
}

/** 民用日序号 → 当日窗的毫秒起点（本地 00:00 的半开一日窗）。 */
function dayStartMsOf(dayIndex: number): number {
  return dayIndex * DAY_MS - ZONE_OFFSET_MS;
}

/** 锚点所在 ISO 周的周一（周一开篇策略）。 */
function weekStartDayIndexOf(anchorDayIndex: number): number {
  return anchorDayIndex - (isoWeekdayOf(anchorDayIndex) - 1);
}

// ===========================================================================
// L4 闭合证明（模块私有：外部拿不到 proveClosedness / makeWindow）
// ===========================================================================

const REQUIRED_DIMENSIONS: readonly ClosureDimProof['dim'][] = Object.freeze([
  'YEAR',
  'MONTH',
  'DAY',
  'ZONE',
  'WEEK_START',
  'DAY_BOUNDARY',
] as ClosureDimProof['dim'][]);

function policyDim(
  dim: ClosureDimProof['dim'],
  via: string,
  state: ClosureState,
  policyVersion: string,
): ClosureDimProof {
  return state === 'EXPLICIT'
    ? Object.freeze({ dim, state, via })
    : Object.freeze({ dim, state, via, policyVersion });
}

/** 闭合证明构造器：维度齐全性在此判定，不从 IR 文本猜任何东西。 */
function proveClosedness(ir: TimeIR, anchor: TimeAnchor): ClosednessProof {
  const date = ir.date;
  const policyVersion = anchor.assets.policy;
  const explicit = date !== null && date.kind === 'YEAR_MONTH_DAY';
  const ruleId = ir.evidence[0]?.ruleId ?? 'gram:unknown';
  const derivedVia =
    date !== null && (date.kind === 'WEEKDAY_OF_WEEK' || date.kind === 'WEEK_OF')
      ? 'policy:iso-week'
      : 'policy:relative-day';
  const yearState: ClosureState = explicit ? 'EXPLICIT' : 'POLICY';
  const dimensions: ClosureDimProof[] = [
    policyDim('YEAR', explicit ? ruleId : derivedVia, yearState, policyVersion),
    policyDim('MONTH', explicit ? ruleId : derivedVia, yearState, policyVersion),
    policyDim('DAY', explicit ? ruleId : derivedVia, yearState, policyVersion),
    policyDim('ZONE', 'policy:zone', 'POLICY', policyVersion),
    policyDim('WEEK_START', 'policy:week-start', 'POLICY', policyVersion),
    policyDim('DAY_BOUNDARY', 'policy:day-boundary', 'POLICY', policyVersion),
  ];
  return Object.freeze({ dimensions: Object.freeze(dimensions) });
}

/** 窗构造器：先验证明完整性再给窗；类型上外部也只能经四态信封拿到窗。 */
function makeWindow(startMs: number, endMs: number, granularity: 'DAY' | 'WEEK', proof: ClosednessProof): TimeWindow {
  if (!(endMs > startMs)) {
    throw new Error(`半开窗要求 endMs > startMs（${startMs}..${endMs}）`);
  }
  for (const dim of REQUIRED_DIMENSIONS) {
    if (!proof.dimensions.some((d) => d.dim === dim)) {
      throw new Error(`闭合证明缺维度 ${dim}，不得构造窗口`);
    }
  }
  for (const dim of proof.dimensions) {
    if (dim.state !== 'EXPLICIT' && dim.state !== 'POLICY') {
      throw new Error(`闭合证明出现非法状态 ${String(dim.state)}`);
    }
  }
  return Object.freeze({ startMs, endMs, halfOpen: true as const, granularity });
}

// ===========================================================================
// IR → 窗 / 不确定原因
// ===========================================================================

/** 单条 IR 的不确定原因（null 表示可继续求窗）。 */
function uncertaintyOf(ir: TimeIR): TimeUncertainReason | null {
  if (ir.role === 'CONTENT' || ir.flags.includes('CONTENT_SUSPECT')) return 'CONTENT_TIME_SUSPECTED';
  if (ir.role === 'QUESTION_FOCUS' || ir.flags.includes('QUESTION_FOCUS')) return 'QUESTION_FOCUS';
  if (ir.flags.includes('OUT_OF_ASSET_RANGE')) return 'OUT_OF_ASSET_RANGE';
  if (ir.flags.includes('DURATION')) return 'DURATION_NOT_FILTER';
  if (ir.flags.includes('RECURRING')) return 'RECURRING_NOT_SINGLETON';
  if (ir.flags.includes('VAGUE')) return 'VAGUE_EXPRESSION';
  if (ir.flags.includes('INVALID_CALENDAR')) return 'INVALID_CALENDAR_DATE';
  if (ir.flags.includes('NOISE')) return 'UNPARSEABLE_NOISE';
  // #132 扩面三枚 TIR 事实 → 末端 reason（命名在文法事实之上显式"无界"）。
  if (ir.flags.includes('OPEN_DIRECTIONAL')) return 'OPEN_DIRECTIONAL_UNBOUNDED';
  if (ir.flags.includes('GRAIN_NOT_SUPPORTED')) return 'GRAIN_NOT_SUPPORTED';
  if (ir.flags.includes('DEICTIC_REFERENCE')) return 'DEICTIC_REFERENCE';
  if (ir.date === null) return 'UNPARSEABLE_NOISE';
  if (ir.date.kind === 'MONTH_DAY') return 'MISSING_YEAR';
  // 角色证据不足（UNKNOWN）与内容型同权：只降级不升级，宁空勿错。
  if (ir.role === 'UNKNOWN') return 'CONTENT_TIME_SUSPECTED';
  return null;
}

/** 符号日期原子 → 当地民用日序号；非法日期返回 null（绝不 clamp）。 */
function dayIndexForDate(ir: TimeIR, anchor: TimeAnchor): number | null {
  const date = ir.date;
  if (date === null) return null;
  switch (date.kind) {
    case 'REL_DAY':
      return localDayIndexOf(anchor.epochMs) + date.delta;
    case 'WEEKDAY_OF_WEEK': {
      const anchorDay = localDayIndexOf(anchor.epochMs);
      return weekStartDayIndexOf(anchorDay) + 7 * date.weekOffset + (date.weekday - 1);
    }
    case 'WEEK_OF': {
      const anchorDay = localDayIndexOf(anchor.epochMs);
      return weekStartDayIndexOf(anchorDay) + 7 * date.weekOffset;
    }
    case 'YEAR_MONTH_DAY': {
      if (date.month < 1 || date.month > 12) return null;
      if (date.day < 1 || date.day > daysInMonth(date.year, date.month)) return null;
      return civilToDayIndex(date.year, date.month, date.day);
    }
    case 'MONTH_DAY':
      return null;
    case 'RELATIVE_SPAN':
      // 跨度窗不走单日索引：resolveTimeConstraint 以 relativeSpanBounds 单独分流，
      // 此分支仅为 switch 穷尽性防御，正常路径不可达。
      return null;
  }
}

/**
 * #132 RELATIVE_SPAN → 半开整数日序号区间 [startDay,endDay)（D0＝锚点民用日）。
 *
 * 端点口径（主控 2026-11-20 拍板，调研公式 F1–F6，方位不含分界点）：
 *  - BACK 前/过去 N：[D0-Nu,D0)；FORWARD 后 N：[D0+1,D0+1+Nu)，二者以 D0 严格对称、不含 D0；
 *  - WITHIN 未来/之内 N：[D0,D0+Nu) 含 D0；
 *  - BEFORE_POINT/AFTER_POINT 后置 N 前/后：锚定单个日子的一日窗；
 *  - unit=WEEK 时 Nu=7·amount（滚动、不对齐周一），粒度统一记 DAY。
 * 纯整数加法，amount≥1 由文法层保证，故恒有 endDay>startDay。
 */
function relativeSpanBounds(
  anchorDayIndex: number,
  mode: RelativeSpanMode,
  amount: number,
  unit: 'DAY' | 'WEEK',
): { readonly startDay: number; readonly endDay: number } {
  const nu = unit === 'WEEK' ? 7 * amount : amount;
  switch (mode) {
    case 'BACK':
      return { startDay: anchorDayIndex - nu, endDay: anchorDayIndex };
    case 'FORWARD':
      return { startDay: anchorDayIndex + 1, endDay: anchorDayIndex + 1 + nu };
    case 'WITHIN':
      return { startDay: anchorDayIndex, endDay: anchorDayIndex + nu };
    case 'BEFORE_POINT':
      return { startDay: anchorDayIndex - amount, endDay: anchorDayIndex - amount + 1 };
    case 'AFTER_POINT':
      return { startDay: anchorDayIndex + amount, endDay: anchorDayIndex + amount + 1 };
  }
}

// ===========================================================================
// replayKey（重放对账键：把"同输入"钉死成可比较的字符串）
// ===========================================================================

function replayKeyOf(text: string, anchor: TimeAnchor): string {
  const material = JSON.stringify({
    text,
    epochMs: anchor.epochMs,
    zoneId: anchor.zoneId,
    weekStartsOn: anchor.weekStartsOn,
    assets: anchor.assets,
  });
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

// ===========================================================================
// 对外入口
// ===========================================================================

/** 不确定原因的仲裁优先级（越靠前越优先；命中多条时只报最高一条）。 */
const REASON_PRIORITY: readonly TimeUncertainReason[] = Object.freeze([
  'CONTENT_TIME_SUSPECTED',
  'QUESTION_FOCUS',
  'OUT_OF_ASSET_RANGE',
  'INVALID_CALENDAR_DATE',
  'MISSING_YEAR',
  'VAGUE_EXPRESSION',
  'DURATION_NOT_FILTER',
  'RECURRING_NOT_SINGLETON',
  'UNPARSEABLE_NOISE',
  // #132 三枚新因追加在末位冻结：旧九枚仲裁优先级全部更高，确保既有降级（如"月底之前"
  // 的 VAGUE）不被新开放因翻盘；新因之间按"无界→粒度→指代"排序。
  'OPEN_DIRECTIONAL_UNBOUNDED',
  'GRAIN_NOT_SUPPORTED',
  'DEICTIC_REFERENCE',
] as TimeUncertainReason[]);

/**
 * 解析并求解一句查询的时间约束，产出四态信封。
 *
 * 不平移、不合并语义：多个不同日子 → CANDIDATES（无首选），同一天重复 → 去重成单窗；
 * 只要出现任一条不确定，即整体降级为 UNCERTAIN（宁空勿错，不确定不参与过滤）。
 */
export function resolveTimeConstraint(text: string, anchor: TimeAnchor): TimeConstraint {
  const provenance = {
    anchorEpochMs: anchor.epochMs,
    assets: anchor.assets,
    replayKey: replayKeyOf(text, anchor),
  } as const;
  const irs = parseTimeExpressions(text);
  if (irs.length === 0) return { kind: 'NONE', provenance };

  const uncertaintySpans = new Map<TimeUncertainReason, Array<readonly [number, number]>>();
  interface WindowEntry {
    readonly window: TimeWindow;
    readonly rule: string;
    readonly proof: ClosednessProof;
  }
  const windows: WindowEntry[] = [];

  for (const ir of irs) {
    const reason = uncertaintyOf(ir);
    if (reason !== null) {
      const bucket = uncertaintySpans.get(reason);
      if (bucket === undefined) uncertaintySpans.set(reason, [ir.span]);
      else bucket.push(ir.span);
      continue;
    }
    // #132 相对跨度窗：独立的 [startDay,endDay) 半开区间，粒度一律 DAY（周滚动折 7N 天）。
    if (ir.date !== null && ir.date.kind === 'RELATIVE_SPAN') {
      const anchorDay = localDayIndexOf(anchor.epochMs);
      const bounds = relativeSpanBounds(anchorDay, ir.date.mode, ir.date.amount, ir.date.unit);
      const spanProof = proveClosedness(ir, anchor);
      windows.push({
        window: makeWindow(dayStartMsOf(bounds.startDay), dayStartMsOf(bounds.endDay), 'DAY', spanProof),
        rule: ir.evidence[0]?.ruleId ?? 'gram:unknown',
        proof: spanProof,
      });
      continue;
    }
    const dayIndex = dayIndexForDate(ir, anchor);
    if (dayIndex === null) {
      const bucket = uncertaintySpans.get('INVALID_CALENDAR_DATE');
      if (bucket === undefined) uncertaintySpans.set('INVALID_CALENDAR_DATE', [ir.span]);
      else bucket.push(ir.span);
      continue;
    }
    const startMs = dayStartMsOf(dayIndex);
    const proof = proveClosedness(ir, anchor);
    const windowLength = ir.granularity === 'WEEK' ? 7 * DAY_MS : DAY_MS;
    windows.push({
      window: makeWindow(startMs, startMs + windowLength, ir.granularity === 'WEEK' ? 'WEEK' : 'DAY', proof),
      rule: ir.evidence[0]?.ruleId ?? 'gram:unknown',
      proof,
    });
  }

  if (uncertaintySpans.size > 0) {
    let top: TimeUncertainReason = 'UNPARSEABLE_NOISE';
    for (const reason of REASON_PRIORITY) {
      if (uncertaintySpans.has(reason)) {
        top = reason;
        break;
      }
    }
    const spans = [...(uncertaintySpans.get(top) ?? [])].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return { kind: 'UNCERTAIN', reason: top, spans, provenance };
  }

  // 去重：同一日子说两遍仍是一个窗（并集语义），按起点排序保持确定性。
  const seen = new Set<number>();
  const unique: WindowEntry[] = [];
  for (const entry of windows) {
    if (seen.has(entry.window.startMs)) continue;
    seen.add(entry.window.startMs);
    unique.push(entry);
  }

  if (unique.length === 0) return { kind: 'NONE', provenance };
  if (unique.length === 1) {
    const only = unique[0];
    if (only === undefined) return { kind: 'NONE', provenance };
    return { kind: 'WINDOW', window: only.window, closure: only.proof, provenance };
  }
  const sorted = [...unique].sort((a, b) => a.window.startMs - b.window.startMs);
  return {
    kind: 'CANDIDATES',
    windows: sorted.map((item) => item.window),
    ambiguity: sorted.map((item) => item.rule),
    provenance,
  };
}

/**
 * 时间槽布尔裁决（预注册谓词，细则 3.4）：
 *  - 区间卡 [o,e)` 与窗 [s,t)：相交当且仅当 o < t 且 e > s；
 *  - 点事件 o=e=t0：命中当且仅当 s <= t0 < t（显式点包含，补 [t,t) 空集缺陷）；
 *  - 多候选：命中任一候选即命中（OR 并集），绝不直取候选数组首项；
 *  - NONE / UNCERTAIN：一律放行（不确定不等于无此事，宁空勿错但不误杀）。
 */
export function timeConstraintAdmits(occurredMs: number, endedMs: number, constraint: TimeConstraint): boolean {
  if (constraint.kind === 'NONE' || constraint.kind === 'UNCERTAIN') return true;
  const windowList = constraint.kind === 'WINDOW' ? [constraint.window] : constraint.windows;
  return windowList.some((window) =>
    occurredMs === endedMs
      ? window.startMs <= occurredMs && occurredMs < window.endMs
      : occurredMs < window.endMs && endedMs > window.startMs,
  );
}
