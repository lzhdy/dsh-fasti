/**
 * #132「时间结构识别扩面」批 1 端到端红测（先红后绿：本批 src 零改动，全部断言先对准失败）。
 *
 * 施工依据（仓库外，主控 2026-11-20 拍板）：
 *  - 《调研-相对时间端点口径.md》§4.2 公式 F1–F9、§4.3 不闭合 U1–U9、§5 四项裁决；
 *  - 《调研-不确定原因分类设计.md》§5.5 最小落地三枚新 reason、§7.2 MECE 映射。
 *
 * 锁定口径（D0＝锚点当地民用日，半开 [start,end)，右端恒次日零点）：
 *  - F1 前/过去 N 天 [D0-N,D0) 不含今天；F2 后 N 天 [D0+1,D0+1+N) 不含今天（与 F1 严格对称）；
 *  - F3 未来/接下来 N 天、F4 N 天之内/以内/内 [D0,D0+N) 含今天；
 *  - F5 N 天前 / F6 N 天后 为后置单点日窗；F7/F8/F9 为周单位滚动窗，折 7N 天、粒度一律 DAY；
 *  - 开放无界（裸方位、X 之后/以前、以来、这/那 N 天）→ OPEN_DIRECTIONAL_UNBOUNDED 留痕，绝不造窗；
 *  - 月/年粒度冻结 → GRAIN_NOT_SUPPORTED 留痕、禁 clamp 30 天；指代 → DEICTIC_REFERENCE 日历永不解；
 *  - 现行犯「周日之后」必须从误产 WINDOW 归位为 UNCERTAIN，不得退回单用「周日」造单日窗。
 *
 * 测试锚点：2026-04-17 17:00 Asia/Shanghai（周五），与 stage0/probe-131-gaps.ts 同一锚点。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTimeConstraint } from '../../src/memory/time-resolve.ts';
import { TIME_ASSET_VERSIONS } from '../../src/memory/time-lexicon.ts';
import type { TimeAnchor, TimeConstraint } from '../../src/memory/types.ts';

/** 2026-04-17 17:00 (+08:00)，probe-131-gaps 同一锚点。 */
const ANCHOR_MS = 1_776_416_400_000;
const DAY_MS = 86_400_000;
/** 锚点当天（D0）当地零点 = 2026-04-17 00:00 (+08:00)。 */
const D0_START = 1_776_355_200_000;

const anchor: TimeAnchor = {
  epochMs: ANCHOR_MS,
  zoneId: 'Asia/Shanghai',
  weekStartsOn: 1,
  assets: TIME_ASSET_VERSIONS,
};

function resolve(text: string): TimeConstraint {
  return resolveTimeConstraint(text, anchor);
}

/** 断言为 WINDOW 并返回半开窗端点与粒度。 */
function expectWindow(text: string): { startMs: number; endMs: number; granularity: 'DAY' | 'WEEK' } {
  const c = resolve(text);
  assert.equal(c.kind, 'WINDOW', `「${text}」应为 WINDOW，实际 ${c.kind}`);
  if (c.kind !== 'WINDOW') throw new Error('unreachable');
  return { startMs: c.window.startMs, endMs: c.window.endMs, granularity: c.window.granularity };
}

/** 断言为 UNCERTAIN 且 reason 精确匹配，返回 spans 条数。 */
function expectUncertain(text: string, reason: string): number {
  const c = resolve(text);
  assert.equal(c.kind, 'UNCERTAIN', `「${text}」应为 UNCERTAIN，实际 ${c.kind}`);
  if (c.kind !== 'UNCERTAIN') throw new Error('unreachable');
  assert.equal(c.reason, reason, `「${text}」reason 应为 ${reason}`);
  assert.ok(c.spans.length >= 1, `「${text}」UNCERTAIN 须带至少一条原文切片 spans`);
  return c.spans.length;
}

test('锚点自检：今天 的窗起点钉在 D0 零点，后续公式均以该基准表达', () => {
  const w = expectWindow('今天');
  assert.equal(w.startMs, D0_START);
  assert.equal(w.endMs, D0_START + DAY_MS);
});

// ===========================================================================
// F1–F4：天单位有限半开窗（含不含今天的对称口径）
// ===========================================================================

test('F1 前/过去 N 天：[D0-N,D0) 不含今天，窗长 N 天、粒度 DAY', () => {
  const cases: ReadonlyArray<[string, number]> = [
    ['前三天', 3],
    ['前一天', 1],
    ['过去三天', 3],
  ];
  for (const [text, n] of cases) {
    const w = expectWindow(text);
    assert.equal(w.startMs, D0_START - n * DAY_MS, `「${text}」起点`);
    assert.equal(w.endMs, D0_START, `「${text}」终点贴 D0 零点（不含今天）`);
    assert.equal(w.endMs - w.startMs, n * DAY_MS, `「${text}」窗长 N 天`);
    assert.equal(w.granularity, 'DAY', `「${text}」滚动段粒度一律 DAY`);
  }
});

test('F2 后 N 天：[D0+1,D0+1+N) 不含今天，与前 N 天以 D0 严格对称', () => {
  const cases: ReadonlyArray<[string, number]> = [
    ['后三天', 3],
    ['后一天', 1],
  ];
  for (const [text, n] of cases) {
    const w = expectWindow(text);
    assert.equal(w.startMs, D0_START + 1 * DAY_MS, `「${text}」起点为明天零点`);
    assert.equal(w.endMs, D0_START + (1 + n) * DAY_MS, `「${text}」终点`);
    assert.equal(w.endMs - w.startMs, n * DAY_MS, `「${text}」窗长 N 天`);
    assert.equal(w.granularity, 'DAY');
  }
});

test('F3/F4 未来/接下来 N 天、N 天之内/以内/内：[D0,D0+N) 含今天', () => {
  for (const text of ['未来三天', '接下来三天', '三天之内', '三天以内', '三天内']) {
    const w = expectWindow(text);
    assert.equal(w.startMs, D0_START, `「${text}」起点含今天零点`);
    assert.equal(w.endMs, D0_START + 3 * DAY_MS, `「${text}」终点`);
    assert.equal(w.endMs - w.startMs, 3 * DAY_MS, `「${text}」窗长 3 天`);
    assert.equal(w.granularity, 'DAY');
  }
});

test('F5/F6 后置 N 天前/后：锚到单个日子的一日窗，不是 N 天段', () => {
  const before = expectWindow('三天前');
  assert.equal(before.startMs, D0_START - 3 * DAY_MS);
  assert.equal(before.endMs, D0_START - 2 * DAY_MS);
  assert.equal(before.endMs - before.startMs, DAY_MS, '后置单点是一日窗');
  const after = expectWindow('三天后');
  assert.equal(after.startMs, D0_START + 3 * DAY_MS);
  assert.equal(after.endMs, D0_START + 4 * DAY_MS);
  assert.equal(after.endMs - after.startMs, DAY_MS);
});

// ===========================================================================
// F7–F9：周单位滚动窗（折 7N 天、粒度 DAY、不对齐周一）
// ===========================================================================

test('F7/F8/F9 周单位：滚动折 7N 天、粒度 DAY（不是 WEEK 整周），含不含今天同天单位口径', () => {
  const cases: ReadonlyArray<[string, number, number]> = [
    // [文本, 相对 D0 的起点偏移（天）, 窗长（天）]
    ['前两周', -14, 14],
    ['后两周', 1, 14],
    ['两周内', 0, 14],
  ];
  for (const [text, startOffset, lengthDays] of cases) {
    const w = expectWindow(text);
    assert.equal(w.granularity, 'DAY', `「${text}」滚动周窗粒度必须是 DAY，不得借 WEEK 传义`);
    assert.equal(w.startMs, D0_START + startOffset * DAY_MS, `「${text}」起点`);
    assert.equal(w.endMs - w.startMs, lengthDays * DAY_MS, `「${text}」窗长 7N 天`);
  }
  // 后两周从周六（D0+1）起算 14 天，横跨三个自然周，绝不是周一对齐的两个整周。
  const afterTwoWeeks = expectWindow('后两周');
  assert.equal(afterTwoWeeks.endMs, D0_START + 15 * DAY_MS);
});

test('所有相对跨度窗都走 POLICY 六维证明门，且半开 end>start', () => {
  for (const text of ['前三天', '后三天', '未来三天', '三天之内', '三天前', '后两周', '两周内']) {
    const c = resolve(text);
    assert.equal(c.kind, 'WINDOW', `「${text}」前置：应产 WINDOW`);
    if (c.kind !== 'WINDOW') continue;
    assert.ok(c.window.endMs > c.window.startMs, `「${text}」半开要求 end>start`);
    assert.equal(c.window.halfOpen, true);
    const dims = c.closure.dimensions.map((d) => d.dim).sort();
    assert.deepEqual(dims, ['DAY', 'DAY_BOUNDARY', 'MONTH', 'WEEK_START', 'YEAR', 'ZONE'], `「${text}」六维`);
    assert.ok(c.closure.dimensions.every((d) => d.state === 'POLICY'), `「${text}」相对跨度全 POLICY 闭合`);
  }
});

// ===========================================================================
// 开放无界方位：认出留痕，绝不造窗（含「周日之后」现行犯归位）
// ===========================================================================

test('开放方位裸用与 X 之后/以前：OPEN_DIRECTIONAL_UNBOUNDED 留痕、不造窗', () => {
  for (const text of ['之前', '之后', '以前', '以后', '以来', '三天以来', '三天以后', '三天之外']) {
    expectUncertain(text, 'OPEN_DIRECTIONAL_UNBOUNDED');
  }
});

test('现行犯归位：「周日之后」整体留痕，绝不退化成单用周日的单日 WINDOW', () => {
  const c = resolve('周日之后');
  assert.equal(c.kind, 'UNCERTAIN', '周日之后 不得产 WINDOW');
  if (c.kind === 'UNCERTAIN') {
    assert.equal(c.reason, 'OPEN_DIRECTIONAL_UNBOUNDED');
    assert.ok(c.spans.length >= 1, '须带原文切片，让"没接住"可见');
  }
  // 反证强度：孤立的「周日」现状仍是单日 WINDOW，证明差异确实来自方位词被接住。
  assert.equal(resolve('周日').kind, 'WINDOW');
});

test('指示词这/那 N 天方向语境依赖：首版留痕不硬选方向（不等同指代通道）', () => {
  for (const text of ['这三天', '那三天']) {
    expectUncertain(text, 'OPEN_DIRECTIONAL_UNBOUNDED');
  }
});

// ===========================================================================
// 月/年粒度冻结：结构认出但不造窗、禁 clamp
// ===========================================================================

test('月/年结构粒度冻结：GRAIN_NOT_SUPPORTED 留痕，绝不 clamp 成 30 天窗', () => {
  for (const text of ['上两个月', '上月', '上个月', '去年', '明年', '三月份']) {
    expectUncertain(text, 'GRAIN_NOT_SUPPORTED');
  }
});

// ===========================================================================
// 指代：日历通道永不解
// ===========================================================================

test('指代词：DEICTIC_REFERENCE 弱留痕归对话通道，日历永不产窗', () => {
  for (const text of ['上次', '刚才', '那会儿']) {
    expectUncertain(text, 'DEICTIC_REFERENCE');
  }
});

// ===========================================================================
// 不回退：既有正确降级与 NONE 真空分层
// ===========================================================================

test('既有降级不回退：月底之前仍 VAGUE、农历春节仍 OUT_OF_ASSET_RANGE', () => {
  expectUncertain('月底之前', 'VAGUE_EXPRESSION');
  expectUncertain('农历春节', 'OUT_OF_ASSET_RANGE');
});

test('NONE 真空分层：句中连时间性 token 都没有时维持纯净 NONE（不带 reason/spans）', () => {
  for (const text of ['帮我找找关于公园的记录', '那份材料放哪了']) {
    const c = resolve(text);
    assert.equal(c.kind, 'NONE', `「${text}」应为纯净 NONE`);
    if (c.kind === 'NONE') {
      assert.equal('reason' in c, false, 'NONE 不携带 reason');
      assert.equal('spans' in c, false, 'NONE 不携带 spans');
      assert.ok(c.provenance.replayKey.length > 0);
    }
  }
});
