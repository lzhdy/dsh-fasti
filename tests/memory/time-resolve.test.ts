/**
 * #127 批 3（P2）整数日历求解器 + 闭合证明门红测（T2 / T3 / T4 / T8）。
 *
 * 口径（《最终推荐与实施细则》第三节 3.3/3.4 与第五节批 3）：
 *  - 纯整数民用日历（无宿主日期对象、无本地化能力、无 TZ 读取），1970 纪元天数换算；
 *  - 唯一读锚点处：把锚点毫秒折算成 Asia/Shanghai 的民用日（固定 UTC+8，无夏令时）；
 *  - 四态信封：NONE / UNCERTAIN(封闭 reason) / CANDIDATES(无首选字段) / WINDOW(带证明)；
 *  - WINDOW 只能由模块私有 proveClosure 造出；非法日历日期拒绝，绝不 clamp。
 *
 * 测试锚点：2026-11-19 12:00 Asia/Shanghai（周四，ISO weekday=4）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addCalendarDays,
  daysInMonth,
  isLeapYear,
  resolveTimeConstraint,
  timeConstraintAdmits,
} from '../../src/memory/time-resolve.ts';
import { TIME_ASSET_VERSIONS } from '../../src/memory/time-lexicon.ts';
import type { TimeAnchor, TimeConstraint } from '../../src/memory/types.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 2026-11-19 12:00 (+08:00)。 */
const ANCHOR_MS = 1_795_060_800_000;
/** 2026-11-19 00:00 (+08:00) —— 今天的窗起点。 */
const TODAY_START = 1_795_017_600_000;
/** 2026-11-16 00:00（周一）—— 本周起点。 */
const WEEK_START = 1_794_758_400_000;
const DAY_MS = 86_400_000;

const anchor: TimeAnchor = {
  epochMs: ANCHOR_MS,
  zoneId: 'Asia/Shanghai',
  weekStartsOn: 1,
  assets: TIME_ASSET_VERSIONS,
};

function resolve(text: string, withAnchor: TimeAnchor = anchor): TimeConstraint {
  return resolveTimeConstraint(text, withAnchor);
}

function windowOf(text: string): { startMs: number; endMs: number } {
  const c = resolve(text);
  assert.equal(c.kind, 'WINDOW', `「${text}」应为 WINDOW，实际 ${c.kind}`);
  if (c.kind !== 'WINDOW') throw new Error('unreachable');
  return { startMs: c.window.startMs, endMs: c.window.endMs };
}

// ===========================================================================
// T2 整数民用日历
// ===========================================================================

test('T2 闰年规则：4 年一闰、百年不闰、四百年再闰', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2025), false);
  assert.equal(isLeapYear(1900), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(1600), true);
  assert.equal(isLeapYear(1700), false);
  // 各月天数随闰年变化，2 月是唯一变量。
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2025, 2), 28);
  assert.equal(daysInMonth(1900, 2), 28);
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(2026, 4), 30);
  assert.equal(daysInMonth(2026, 7), 31);
});

test('T2 addCalendarDays：闰日、月末、跨年、跨世纪全部走整数日历，不用毫秒加日', () => {
  const cases: ReadonlyArray<[readonly [number, number, number], number, readonly [number, number, number]]> = [
    [[2024, 2, 28], 1, [2024, 2, 29]],
    [[2024, 2, 29], 1, [2024, 3, 1]],
    [[2025, 2, 28], 1, [2025, 3, 1]],
    [[1900, 2, 28], 1, [1900, 3, 1]],
    [[1900, 3, 1], -1, [1900, 2, 28]],
    [[2000, 2, 28], 1, [2000, 2, 29]],
    [[2026, 11, 30], 1, [2026, 12, 1]],
    [[2026, 12, 31], 1, [2027, 1, 1]],
    [[2026, 1, 1], -1, [2025, 12, 31]],
    [[2026, 11, 19], 7, [2026, 11, 26]],
    [[2026, 11, 19], -30, [2026, 10, 20]],
  ];
  for (const [[y, m, d], delta, expected] of cases) {
    const got = addCalendarDays(y, m, d, delta);
    assert.deepEqual([got.year, got.month, got.day], expected, `${y}-${m}-${d} ${delta >= 0 ? '+' : ''}${delta}`);
  }
});

test('T2 跨年周与周一开篇：本周起点落在周一，跨年时按 ISO 周推进', () => {
  // 2026-11-19 是周四 → 本周起点 2026-11-16（周一）。
  const w = windowOf('本周一');
  assert.equal(w.startMs, WEEK_START);
  assert.equal(w.endMs, WEEK_START + DAY_MS);
  // 跨年周：锚点换到 2027-01-01（周五），本周一应为 2026-12-28。
  const yearEnd: TimeAnchor = { ...anchor, epochMs: 1_798_776_000_000 };
  const crossYear = resolveTimeConstraint('本周一', yearEnd);
  assert.equal(crossYear.kind, 'WINDOW');
  if (crossYear.kind === 'WINDOW') {
    const civil = addCalendarDays(2027, 1, 1, -4);
    assert.deepEqual([civil.year, civil.month, civil.day], [2026, 12, 28]);
    assert.equal(crossYear.window.startMs, 1_798_387_200_000);
  }
});

// ===========================================================================
// T3 四态与 reason 精确匹配
// ===========================================================================

test('T3 NONE：无任何时间原子，与 UNCERTAIN 分别成态', () => {
  for (const text of ['帮我找找关于公园的记录', '', '   ']) {
    const c = resolve(text);
    assert.equal(c.kind, 'NONE', `「${text}」应为 NONE`);
    assert.ok(c.provenance.replayKey.length > 0, 'NONE 态亦须带 provenance/replayKey');
  }
});

test('T3 WINDOW：四类产窗原子各自闭合到精确的 [startMs,endMs) 日窗', () => {
  const cases: ReadonlyArray<[string, number]> = [
    ['今天', TODAY_START],
    ['昨天', TODAY_START - DAY_MS],
    ['前天', TODAY_START - 2 * DAY_MS],
    ['大前天', TODAY_START - 3 * DAY_MS],
    ['明天', TODAY_START + DAY_MS],
    ['后天', TODAY_START + 2 * DAY_MS],
    ['大后天', TODAY_START + 3 * DAY_MS],
    ['周六', WEEK_START + 5 * DAY_MS],
    ['周日', WEEK_START + 6 * DAY_MS],
    ['本周五', WEEK_START + 4 * DAY_MS],
    ['上周五', WEEK_START - 3 * DAY_MS],
    ['下周三', WEEK_START + 7 * DAY_MS + 2 * DAY_MS],
    ['上上周一', WEEK_START - 14 * DAY_MS],
    ['2026年11月19日', TODAY_START],
    ['2024年2月29日', 1_709_136_000_000],
  ];
  for (const [text, startMs] of cases) {
    const w = windowOf(text);
    assert.equal(w.startMs, startMs, `「${text}」窗起点`);
    assert.equal(w.endMs, startMs + DAY_MS, `「${text}」窗终点（半开一日）`);
    const c = resolve(text);
    if (c.kind === 'WINDOW') {
      assert.equal(c.window.halfOpen, true);
      assert.equal(c.window.granularity, 'DAY');
      // 证明六维齐全，且只认 EXPLICIT/POLICY。
      const dims = c.closure.dimensions.map((d) => d.dim).sort();
      assert.deepEqual(dims, ['DAY', 'DAY_BOUNDARY', 'MONTH', 'WEEK_START', 'YEAR', 'ZONE'], `「${text}」证明维度`);
      assert.ok(c.closure.dimensions.every((d) => d.state === 'EXPLICIT' || d.state === 'POLICY'));
    }
  }
});

test('T3 整周窗（主控拍板）：裸周偏移产 7 日半开窗，周一开篇、粒度 WEEK', () => {
  const cases: ReadonlyArray<[string, number, number]> = [
    ['本周', WEEK_START, WEEK_START + 7 * DAY_MS],
    ['这周', WEEK_START, WEEK_START + 7 * DAY_MS],
    ['上周', WEEK_START - 7 * DAY_MS, WEEK_START],
    ['上上周', WEEK_START - 14 * DAY_MS, WEEK_START - 7 * DAY_MS],
    ['下周', WEEK_START + 7 * DAY_MS, WEEK_START + 14 * DAY_MS],
    ['下下周', WEEK_START + 14 * DAY_MS, WEEK_START + 21 * DAY_MS],
  ];
  for (const [text, startMs, endMs] of cases) {
    const c = resolve(text);
    assert.equal(c.kind, 'WINDOW', `「${text}」应为 WINDOW，实际 ${c.kind}`);
    if (c.kind !== 'WINDOW') continue;
    assert.equal(c.window.startMs, startMs, `「${text}」起点`);
    assert.equal(c.window.endMs, endMs, `「${text}」终点`);
    assert.equal(c.window.granularity, 'WEEK', `「${text}」粒度`);
    assert.equal(c.window.halfOpen, true);
    // 整周窗同样带六维闭合证明。
    assert.equal(c.closure.dimensions.length, 6);
    assert.ok(c.closure.dimensions.every((d) => d.state === 'EXPLICIT' || d.state === 'POLICY'));
  }
  // "上周五" 仍然是单日窗，不被整周规则吞掉。
  const single = windowOf('上周五');
  assert.equal(single.endMs - single.startMs, DAY_MS);
});

test('T3 整周窗裁决：窗内任意一天（含周日）命中，窗外不命中', () => {
  const c = resolve('上周');
  if (c.kind !== 'WINDOW') throw new Error('前置失效');
  assert.equal(timeConstraintAdmits(WEEK_START - DAY_MS, WEEK_START - DAY_MS, c), true, '上周日（窗最后一天）命中');
  assert.equal(timeConstraintAdmits(WEEK_START - 7 * DAY_MS, WEEK_START - 7 * DAY_MS, c), true, '上周一（窗起点）命中');
  assert.equal(timeConstraintAdmits(WEEK_START, WEEK_START, c), false, '本周一（窗终点）不命中');
});

test('T3 非法日历日期：拒绝且不 clamp（2025/2026 的 2 月 29、4 月 31）', () => {
  for (const text of ['2025年2月29日', '2026年2月29日', '1900年2月29日', '2026年4月31日', '2026年13月1日']) {
    const c = resolve(text);
    assert.equal(c.kind, 'UNCERTAIN', `「${text}」应为 UNCERTAIN，实际 ${c.kind}`);
    if (c.kind === 'UNCERTAIN') assert.equal(c.reason, 'INVALID_CALENDAR_DATE', `「${text}」reason`);
  }
  // 1900 不是闰年、2000 是：同一天 2/29 在两年里结论相反。
  assert.equal(resolve('2000年2月29日').kind, 'WINDOW');
});

test('T3 各路不确定原因精确匹配（G 类/疑问/模糊/时长/周期/资产范围/缺年）', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['提醒我周五交表', 'CONTENT_TIME_SUSPECTED'],
    ['周五几点开会', 'QUESTION_FOCUS'],
    ['农历三月初一', 'OUT_OF_ASSET_RANGE'],
    ['工作日', 'OUT_OF_ASSET_RANGE'],
    ['最近', 'VAGUE_EXPRESSION'],
    ['晚上见', 'VAGUE_EXPRESSION'],
    ['每天跑步', 'RECURRING_NOT_SINGLETON'],
    ['持续三天', 'DURATION_NOT_FILTER'],
    ['11月19日', 'MISSING_YEAR'],
    ['26年11月19日', 'MISSING_YEAR'],
  ];
  for (const [text, reason] of cases) {
    const c = resolve(text);
    assert.equal(c.kind, 'UNCERTAIN', `「${text}」应为 UNCERTAIN，实际 ${c.kind}`);
    if (c.kind === 'UNCERTAIN') assert.equal(c.reason, reason, `「${text}」reason`);
  }
});

test('T3 CANDIDATES：两个不同日子是两个同位候选，类型与运行期都无首选语义', () => {
  const c = resolve('周六和周日去公园');
  assert.equal(c.kind, 'CANDIDATES');
  if (c.kind !== 'CANDIDATES') return;
  assert.equal(c.windows.length, 2);
  assert.equal(c.ambiguity.length, 2);
  const starts = c.windows.map((w) => w.startMs).sort((a, b) => a - b);
  assert.deepEqual(starts, [WEEK_START + 5 * DAY_MS, WEEK_START + 6 * DAY_MS]);
  assert.equal('preferred' in c, false);
  assert.equal('score' in c, false);
  assert.equal('rank' in c, false);
  assert.equal('confidence' in c, false);
});

test('T3 同一日子说两遍仍是一个窗（并集去重，不制造候选）', () => {
  const c = resolve('今天和今天');
  assert.equal(c.kind, 'WINDOW');
});

test('T3 provenance：锚点毫秒、资产版本、replayKey 三件齐备且 replayKey 确定性', () => {
  const c = resolve('今天');
  assert.equal(c.provenance.anchorEpochMs, ANCHOR_MS);
  assert.strictEqual(c.provenance.assets, TIME_ASSET_VERSIONS);
  assert.ok(c.provenance.replayKey.length >= 16);
  assert.equal(c.provenance.replayKey, resolve('今天').provenance.replayKey);
  // 不同锚点必不同键（同文本）。
  const other: TimeAnchor = { ...anchor, epochMs: ANCHOR_MS + DAY_MS };
  assert.notEqual(resolve('今天').provenance.replayKey, resolveTimeConstraint('今天', other).provenance.replayKey);
});

// ===========================================================================
// T4 点包含与半开窗三条端点
// ===========================================================================

test('T4 点事件 t∈[s,t)：起点命中、终点前一毫秒命中、终点不命中、起点前不命中', () => {
  const c = resolve('2026年11月19日');
  assert.equal(c.kind, 'WINDOW');
  if (c.kind !== 'WINDOW') return;
  const s = c.window.startMs;
  const t = c.window.endMs;
  assert.equal(timeConstraintAdmits(s, s, c), true, '点落在起点：命中');
  assert.equal(timeConstraintAdmits(s + 1, s + 1, c), true, '点落在窗内：命中');
  assert.equal(timeConstraintAdmits(t - 1, t - 1, c), true, '点落在终点前 1ms：命中');
  assert.equal(timeConstraintAdmits(t, t, c), false, '点落在终点：不命中（半开）');
  assert.equal(timeConstraintAdmits(s - 1, s - 1, c), false, '点落在起点前：不命中');
});

test('T4 区间卡 [o,e) 与窗 [s,t)：仅当 o<t 且 e>s 才命中（端点相接算不命中）', () => {
  const c = resolve('2026年11月19日');
  if (c.kind !== 'WINDOW') throw new Error('前置失效');
  const s = c.window.startMs;
  const t = c.window.endMs;
  assert.equal(timeConstraintAdmits(s - 10, s, c), false, '区间右端贴窗起点：不相交');
  assert.equal(timeConstraintAdmits(s - 10, s + 1, c), true, '区间右端越过窗起点 1ms：相交');
  assert.equal(timeConstraintAdmits(t, t + 10, c), false, '区间左端贴窗终点：不相交');
  assert.equal(timeConstraintAdmits(t - 1, t + 10, c), true, '区间左端在窗终点前 1ms：相交');
  assert.equal(timeConstraintAdmits(s - 100, t + 100, c), true, '完全包住窗：相交');
  assert.equal(timeConstraintAdmits(s + 1, t - 1, c), true, '完全落在窗内：相交');
});

test('T4 多候选按 OR 并集裁决：命中任一候选即命中，禁 windows[0] 单取', () => {
  const c = resolve('周六和周日去公园');
  assert.equal(c.kind, 'CANDIDATES');
  if (c.kind !== 'CANDIDATES') return;
  const second = c.windows[1];
  assert.ok(second !== undefined);
  assert.equal(timeConstraintAdmits(second.startMs, second.startMs, c), true, '第二个候选内的点应命中');
  const first = c.windows[0];
  assert.ok(first !== undefined);
  assert.equal(timeConstraintAdmits(first.startMs, first.startMs, c), true, '第一个候选内的点应命中');
  // 周六与周日在日历上相邻：周六窗终点即周日窗起点，故该毫秒仍命中（并集连续）。
  assert.equal(timeConstraintAdmits(first.endMs, first.endMs, c), true, '相邻两日的接缝仍命中');
  const last = c.windows[c.windows.length - 1];
  assert.ok(last !== undefined);
  assert.equal(timeConstraintAdmits(last.endMs, last.endMs, c), false, '最后一个候选终点之后不命中');
  // 反证：若实现偷懒只取 windows[0]，下面这条必红。
  assert.equal(timeConstraintAdmits(second.startMs + 1, second.startMs + 1, c), true);
});

test('T4 留痕放行：NONE 与 UNCERTAIN 一律不否决（不确定不等于无此事）', () => {
  for (const text of ['帮我找公园', '最近', '11月19日']) {
    const c = resolve(text);
    assert.equal(timeConstraintAdmits(1_700_000_000_000, 1_700_000_000_000, c), true, `「${text}」须放行`);
  }
});

// ===========================================================================
// T8 确定性
// ===========================================================================

test('T8 同输入百次字节相同；篡改 TZ 环境变量不影响结果；锚点是唯一时钟输入', () => {
  const baseline = JSON.stringify(resolve('周六和周日去公园'));
  for (let i = 0; i < 100; i += 1) {
    assert.equal(JSON.stringify(resolve('周六和周日去公园')), baseline, `第 ${i + 1} 次结果漂移`);
  }
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(JSON.stringify(resolve('周六和周日去公园')), baseline, '宿主 TZ 篡改后结果漂移');
    process.env.TZ = 'UTC';
    assert.equal(JSON.stringify(resolve('周六和周日去公园')), baseline, '宿主 TZ 篡改后结果漂移');
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
  // 静态：求解器不得自行读取时钟/本地化/TZ（锚点是唯一时钟输入）。
  const text = fs.readFileSync(path.join(REPO_ROOT, 'src/memory/time-resolve.ts'), 'utf8');
  for (const banned of ['Date.now', 'new Date', 'Math.random', 'Intl.', 'toLocale', 'process.env', 'performance.now']) {
    assert.equal(text.includes(banned), false, `time-resolve.ts 不得出现 ${banned}`);
  }
});
