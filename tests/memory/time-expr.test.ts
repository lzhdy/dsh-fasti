/**
 * #127 批 2（P1）L1 词法 + L2 文法红测（T1 / T5 词法部分 / T10）。
 *
 * 口径（《最终推荐与实施细则》第四节封闭清单）：
 *  - T1 表驱动：每个原子与产生式断言完整 TimeIR（固定文本，不注入任何日期/毫秒）；
 *  - T5 词法部分：G 类内容型 / 疑问焦点 / 模糊 / 时长 / 周期 / 农历节假日挂起词逐类断言 flags 与 role；
 *  - T10 坏输入韧性：空串/纯标点/超长/重复都不抛错，且耗时随长度线性（无正则回溯）。
 *
 * 本批为休眠零件：L1/L2 不读 Anchor、不含毫秒、不 import gate/bm25/store。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTimeExpressions } from '../../src/memory/time-expr.ts';
import type { TimeIR } from '../../src/memory/types.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 断言单条 TIR，并返回该条便于进一步取字段。 */
function only(text: string): TimeIR {
  const irs = parseTimeExpressions(text);
  assert.equal(irs.length, 1, `「${text}」应产出恰好 1 条 TIR，实际 ${irs.length}`);
  const first = irs[0];
  assert.ok(first !== undefined);
  return first;
}

function dateOf(text: string): NonNullable<TimeIR['date']> {
  const date = only(text).date;
  assert.ok(date !== null, `「${text}」应产出日期原子`);
  return date;
}

test('T1 REL_DAY：相对日全部七档映射到封闭 delta，粒度 DAY，默认角色 FILTER', () => {
  const cases: ReadonlyArray<[string, number]> = [
    ['大前天', -3],
    ['前天', -2],
    ['昨天', -1],
    ['今天', 0],
    ['今儿', 0],
    ['今儿个', 0],
    ['明天', 1],
    ['后天', 2],
    ['大后天', 3],
  ];
  for (const [text, delta] of cases) {
    const date = dateOf(text);
    assert.equal(date.kind, 'REL_DAY', `${text} 类型`);
    if (date.kind === 'REL_DAY') assert.equal(date.delta, delta, `${text} delta`);
    assert.equal(only(text).granularity, 'DAY', `${text} 粒度`);
    assert.equal(only(text).role, 'FILTER', `${text} 角色`);
  }
  // 首期封闭区间 -3..+3 之外不建词，落 NONE（宁空勿错）。
  for (const outside of ['明早', '晚点', '过两天']) {
    const irs = parseTimeExpressions(outside);
    assert.equal(irs.filter((ir) => ir.date !== null).length, 0, `${outside} 应不产日期原子`);
  }
});

test('T1 长匹配优先：大后天/大前天不被后天/前天吞掉', () => {
  const d1 = dateOf('大后天');
  assert.equal(d1.kind === 'REL_DAY' ? d1.delta : null, 3);
  const d2 = dateOf('大前天');
  assert.equal(d2.kind === 'REL_DAY' ? d2.delta : null, -3);
});

test('T1 YEAR_MONTH_DAY：阿拉伯/汉字/全角/混写四种写法归一到同一 civil 三元组', () => {
  const cases: ReadonlyArray<[string, [number, number, number]]> = [
    ['2026年11月19日', [2026, 11, 19]],
    ['2026年11月19号', [2026, 11, 19]],
    ['二〇二六年十一月十九日', [2026, 11, 19]],
    ['二零二六年十一月十九日', [2026, 11, 19]],
    ['２０２６年１１月１９日', [2026, 11, 19]],
    ['２〇２6年11月19日', [2026, 11, 19]],
  ];
  for (const [text, [year, month, day]] of cases) {
    const date = dateOf(text);
    assert.equal(date.kind, 'YEAR_MONTH_DAY', `${text} 类型`);
    if (date.kind === 'YEAR_MONTH_DAY') {
      assert.deepEqual([date.year, date.month, date.day], [year, month, day], `${text} 三元组`);
    }
    assert.equal(only(text).granularity, 'DAY');
    assert.equal(only(text).role, 'FILTER');
  }
});

test('T1 两位年份不闭合（主控拍板只认四位）：26 年回落 MONTH_DAY，待 L4 挂 MISSING_YEAR', () => {
  const date = dateOf('26年11月19日');
  assert.equal(date.kind, 'MONTH_DAY');
  if (date.kind === 'MONTH_DAY') assert.deepEqual([date.month, date.day], [11, 19]);
  // 四位年份证据里不得再出现两位年 policy（已删除）。
  assert.equal(only('26年11月19日').evidence.some((e) => e.ruleId === 'policy:two-digit-year'), false);
  const four = dateOf('２０２６年１１月１９日');
  assert.equal(four.kind, 'YEAR_MONTH_DAY');
});

test('T1 MONTH_DAY：无年份月日只产 MONTH_DAY 原子（补年归 L4 拒绝，不在此猜）', () => {
  for (const text of ['11月19日', '11月19号', '十一月十九日', '１１月１９日']) {
    const date = dateOf(text);
    assert.equal(date.kind, 'MONTH_DAY', `${text} 类型`);
    if (date.kind === 'MONTH_DAY') assert.deepEqual([date.month, date.day], [11, 19], `${text}`);
  }
});

test('T1 WEEKDAY_OF_WEEK：星期/礼拜/周 三前缀 × 周偏移 全组合，星期序 ISO 1..7', () => {
  const cases: ReadonlyArray<[string, number, number]> = [
    ['周一', 0, 1],
    ['周二', 0, 2],
    ['周三', 0, 3],
    ['周四', 0, 4],
    ['周五', 0, 5],
    ['周六', 0, 6],
    ['周日', 0, 7],
    ['周天', 0, 7],
    ['星期一', 0, 1],
    ['星期六', 0, 6],
    ['星期天', 0, 7],
    ['星期日', 0, 7],
    ['礼拜三', 0, 3],
    ['礼拜天', 0, 7],
    ['这周五', 0, 5],
    ['本周五', 0, 5],
    ['上周五', -1, 5],
    ['上星期五', -1, 5],
    ['下周三', 1, 3],
    ['下星期三', 1, 3],
    ['上上周一', -2, 1],
    ['下下周六', 2, 6],
    ['上周日', -1, 7],
    ['下下星期天', 2, 7],
  ];
  for (const [text, weekOffset, weekday] of cases) {
    const date = dateOf(text);
    assert.equal(date.kind, 'WEEKDAY_OF_WEEK', `${text} 类型`);
    if (date.kind === 'WEEKDAY_OF_WEEK') {
      assert.equal(date.weekOffset, weekOffset, `${text} weekOffset`);
      assert.equal(date.weekday, weekday, `${text} weekday`);
    }
    assert.equal(only(text).granularity, 'DAY', `${text} 粒度`);
  }
});

test('T1 裸周偏移整周（主控拍板）：上周/本周/下下周 产 WEEK_OF 原子、粒度 WEEK', () => {
  for (const text of ['上周', '下周', '本周', '这周', '上上周', '下下周', '上星期', '下下星期']) {
    const ir = only(text);
    assert.notEqual(ir.date, null, `「${text}」应产出日期原子`);
    assert.equal(ir.date?.kind, 'WEEK_OF', `「${text}」类型`);
    assert.equal(ir.granularity, 'WEEK', `「${text}」粒度`);
    if (ir.date?.kind === 'WEEK_OF') {
      const expected: Record<string, number> = { 上周: -1, 上星期: -1, 下周: 1, 本周: 0, 这周: 0, 上上周: -2, 下下周: 2, 下下星期: 2 };
      assert.equal(ir.date.weekOffset, expected[text], `「${text}」offset`);
    }
  }
  // 裸月（无日无年）仍不成原子。
  assert.equal(parseTimeExpressions('十一月').filter((ir) => ir.date !== null).length, 0);
});

test('T1 非法日历：13 月/2月30/4月31/45号 一律打 INVALID_CALENDAR，绝不 clamp', () => {
  const cases = ['2026年13月1日', '2026年2月30日', '2026年4月31日', '2026年1月45号', '11月31日'];
  for (const text of cases) {
    const ir = only(text);
    assert.ok(ir.flags.includes('INVALID_CALENDAR'), `「${text}」应打 INVALID_CALENDAR`);
    // 原文数字必须原样保留，不得被夹到 12/30/31。
    assert.ok(ir.evidence.some((e) => e.matchedText === text), `「${text}」证据须含原串`);
  }
  const d = dateOf('2026年13月1日');
  assert.equal(d.kind === 'YEAR_MONTH_DAY' ? d.month : null, 13, '13 月不得被夹成 12');
});

test('T1 合法闰日：2月29 在文法层放行（闰年判定归 L3 求解器）', () => {
  const ir = only('2026年2月29日');
  assert.equal(ir.flags.includes('INVALID_CALENDAR'), false);
  const d = dateOf('2026年2月29日');
  assert.equal(d.kind === 'YEAR_MONTH_DAY' ? d.day : null, 29);
});

test('T5 内容型时间（G 类）：内容嫌疑词命中即压过过滤信号，非对称只降级', () => {
  for (const word of ['记好了', '定在', '安排在', '约在', '改成', '提醒我', '别忘了']) {
    const text = `${word}周五交表`;
    const irs = parseTimeExpressions(text);
    // 一句里同时有内容词与日期：一条短路 TIR 留证 + 一条日期 TIR（被降级为 CONTENT）。
    assert.equal(irs.length, 2, `「${text}」应产出短路＋日期两条 TIR`);
    const dateIr = irs.find((ir) => ir.date !== null);
    assert.ok(dateIr !== undefined, `「${text}」日期原子仍须保留作证据`);
    assert.equal(dateIr.role, 'CONTENT', `「${text}」日期 TIR 角色应为 CONTENT`);
    assert.ok(dateIr.flags.includes('CONTENT_SUSPECT'), `「${text}」应带 CONTENT_SUSPECT`);
  }
});

test('T5 疑问焦点：几点/什么时候/哪天 等走 QUESTION_FOCUS，不产过滤窗', () => {
  for (const word of ['几点', '什么时候', '啥时候', '哪天', '几号', '多久']) {
    const ir = only(`${word}开会`);
    assert.equal(ir.role, 'QUESTION_FOCUS', `「${word}」角色应为 QUESTION_FOCUS`);
    assert.ok(ir.flags.includes('QUESTION_FOCUS'), `「${word}」应带 QUESTION_FOCUS`);
    assert.equal(ir.date, null, `「${word}」不应产出日期原子`);
  }
});

test('T5 模糊/时段：最近/那天/周末/晚上 等走 VAGUE，不猜具体窗', () => {
  for (const word of ['最近', '前些天', '那天', '有一次', '当时', '改天', '凌晨', '早上', '上午', '中午', '下午', '傍晚', '晚上', '半夜', '周末', '月底', '月初', '左右', '大概']) {
    const ir = only(`${word}见面`);
    assert.ok(ir.flags.includes('VAGUE'), `「${word}」应带 VAGUE`);
    assert.equal(ir.date, null, `「${word}」不应产出日期原子`);
  }
});

test('T5 时长与周期：持续三天/每天/每隔 走 DURATION、RECURRING', () => {
  const duration = only('持续三天');
  assert.ok(duration.flags.includes('DURATION'), '持续 应带 DURATION');
  assert.equal(duration.granularity, 'DURATION');
  for (const word of ['每天', '每周', '每隔']) {
    const ir = only(`${word}跑步`);
    assert.ok(ir.flags.includes('RECURRING'), `「${word}」应带 RECURRING`);
    assert.equal(ir.granularity, 'RECURRING');
    assert.equal(ir.date, null, `「${word}」不应产出单次日期原子`);
  }
  // 周期词优先于星期解释：每周三 是周期不是本周三。
  const weekly = only('每周三跑步');
  assert.ok(weekly.flags.includes('RECURRING'));
  assert.equal(weekly.date, null);
});

test('T5 超资产范围：农历/节气/节假日/调休/工作日 一律 OUT_OF_ASSET_RANGE 挂起', () => {
  const cases = ['农历三月初一', '阴历八月十五', '正月十五', '腊月二十三', '立春', '春分', '秋分', '冬至', '国庆', '五一', '元旦', '春节', '端午', '中秋', '清明', '劳动节', '节假日', '调休', '工作日'];
  for (const text of cases) {
    const irs = parseTimeExpressions(text);
    assert.ok(irs.length >= 1, `「${text}」应至少产出一条 TIR`);
    assert.ok(
      irs.some((ir) => ir.flags.includes('OUT_OF_ASSET_RANGE')),
      `「${text}」应带 OUT_OF_ASSET_RANGE`,
    );
    for (const ir of irs) assert.equal(ir.date, null, `「${text}」不应产出日期原子`);
  }
});

test('T5 角色非对称：内容嫌疑词压过疑问焦点（同一句两者共存时日期按内容处置）', () => {
  const irs = parseTimeExpressions('提醒我周五几点交表');
  const dateIr = irs.find((ir) => ir.date !== null);
  assert.ok(dateIr !== undefined, '日期原子须保留');
  assert.equal(dateIr.role, 'CONTENT', '内容信号压过疑问信号（只降级不升级）');
  assert.ok(dateIr.flags.includes('CONTENT_SUSPECT'));
  assert.ok(irs.some((ir) => ir.role === 'QUESTION_FOCUS'), '疑问焦点词仍须独立留痕');
});

test('T5 一句多时间：周六和周日 产出两条独立 TIR（多候选并集归 L4/gate）', () => {
  const irs = parseTimeExpressions('周六和周日去公园');
  assert.equal(irs.length, 2);
  const prefixes = irs.map((ir) => (ir.date?.kind === 'WEEKDAY_OF_WEEK' ? ir.date.weekday : null));
  assert.deepEqual([...prefixes].sort(), [6, 7]);
  for (const ir of irs) assert.equal(ir.role, 'FILTER');
});

test('T10 坏输入韧性：空串/纯标点/空白/超长重复都不抛错且无日期原子', () => {
  const bad = ['', '   ', '。，、！？', '的了呢啊', '🍜🍜🍜', '\u0000\u0001'];
  for (const text of bad) {
    assert.doesNotThrow(() => parseTimeExpressions(text), `「${text}」不应抛错`);
    assert.deepEqual([...parseTimeExpressions(text)], [], `「${text}」不应产出 TIR`);
  }
  const long = '今天'.repeat(20_000);
  assert.doesNotThrow(() => parseTimeExpressions(long));
  assert.ok(parseTimeExpressions(long).length > 0);
});

test('T10 耗时上限：10 万字符输入须在 400ms 内返回（无正则回溯、单趟线性扫描）', () => {
  const text = ('周六我去公园，昨天没去，2026年11月19日下雨，提醒我周五交表。').repeat(2_000);
  const start = process.hrtime.bigint();
  const irs = parseTimeExpressions(text);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  assert.ok(irs.length > 0);
  assert.ok(elapsedMs < 400, `耗时 ${elapsedMs.toFixed(1)}ms 超过 400ms 上限`);
});

test('T9 静态纪律：time-lexicon/time-expr 零正则零时钟零 I/O（词表是数据不是定式）', () => {
  for (const rel of ['src/memory/time-lexicon.ts', 'src/memory/time-expr.ts']) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const banned of ['RegExp', 'Date.now', 'new Date', 'Math.random', 'Intl.', 'toLocale', 'process.env', 'readFileSync', '86400000']) {
      assert.equal(text.includes(banned), false, `${rel} 不得出现 ${banned}`);
    }
    // 正则字面量：形如 `= /.../` 或 `(/.../)`；本模块的穷举责任在数据表不在正则。
    assert.equal(/(^|[=(,:]\s*)\/(?![/*])/.test(text), false, `${rel} 不得使用正则字面量`);
  }
});

// ===========================================================================
// #132 时间结构识别扩面：RELATIVE_SPAN 符号原子与三类留痕的 TIR 层表驱动夹具
// （只断言不含毫秒的 TIR shape/flag/ruleId；半开毫秒窗在 time-relative-span.test 断言）
// ===========================================================================

test('#132 T1 RELATIVE_SPAN：方位＋数字＋天/周单位归一到封闭 mode/amount/unit，粒度 DAY、FILTER', () => {
  const cases: ReadonlyArray<[string, string, number, 'DAY' | 'WEEK', string]> = [
    ['前三天', 'BACK', 3, 'DAY', 'gram:span-back'],
    ['过去三天', 'BACK', 3, 'DAY', 'gram:span-back'],
    ['后三天', 'FORWARD', 3, 'DAY', 'gram:span-forward'],
    ['未来三天', 'WITHIN', 3, 'DAY', 'gram:span-within-pre'],
    ['接下来三天', 'WITHIN', 3, 'DAY', 'gram:span-within-pre'],
    ['三天之内', 'WITHIN', 3, 'DAY', 'gram:span-within-post'],
    ['三天内', 'WITHIN', 3, 'DAY', 'gram:span-within-post'],
    ['三天前', 'BEFORE_POINT', 3, 'DAY', 'gram:point-before'],
    ['三天后', 'AFTER_POINT', 3, 'DAY', 'gram:point-after'],
    ['前两周', 'BACK', 2, 'WEEK', 'gram:span-back'],
    ['后两周', 'FORWARD', 2, 'WEEK', 'gram:span-forward'],
    ['两周内', 'WITHIN', 2, 'WEEK', 'gram:span-within-post'],
  ];
  for (const [text, mode, amount, unit, ruleId] of cases) {
    const ir = only(text);
    assert.equal(ir.role, 'FILTER', `「${text}」角色`);
    assert.equal(ir.granularity, 'DAY', `「${text}」滚动跨度 IR 粒度统一 DAY`);
    assert.equal(ir.date?.kind, 'RELATIVE_SPAN', `「${text}」TIR 类型`);
    if (ir.date?.kind === 'RELATIVE_SPAN') {
      assert.equal(ir.date.mode, mode, `「${text}」mode`);
      assert.equal(ir.date.amount, amount, `「${text}」amount`);
      assert.equal(ir.date.unit, unit, `「${text}」unit`);
    }
    assert.equal(ir.evidence[0]?.ruleId, ruleId, `「${text}」规则 id`);
    assert.equal(ir.evidence[0]?.source, 'GRAMMAR');
    assert.deepEqual(ir.flags, [], `「${text}」可闭合结构不带留痕 flag`);
  }
});

test('#132 T1 单纯方位 vs 合成方位：三天后闭合、三天以后开放（sense 不同产不同 TIR）', () => {
  const closed = only('三天后');
  assert.equal(closed.date?.kind, 'RELATIVE_SPAN');
  const open = only('三天以后');
  assert.equal(open.date, null, '合成方位"以后"无界，不产日期原子');
  assert.ok(open.flags.includes('OPEN_DIRECTIONAL'));
  assert.equal(open.evidence[0]?.ruleId, 'gram:open-post-span');
});

test('#132 T5 开放方位留痕：裸用/星期后/指示词 都 date=null 且带 OPEN_DIRECTIONAL', () => {
  const bare: ReadonlyArray<[string, string]> = [
    ['之前', 'gram:open-direction-bare'],
    ['之后', 'gram:open-direction-bare'],
    ['以来', 'gram:open-direction-bare'],
    ['周三之后', 'gram:open-after-prefix-weekday'],
    ['这三天', 'gram:open-demonstrative'],
    ['那三天', 'gram:open-demonstrative'],
  ];
  for (const [text, ruleId] of bare) {
    const ir = only(text);
    assert.equal(ir.date, null, `「${text}」无界不得产日期原子`);
    assert.ok(ir.flags.includes('OPEN_DIRECTIONAL'), `「${text}」flag`);
    assert.equal(ir.evidence[0]?.ruleId, ruleId, `「${text}」规则 id`);
  }
  // 现行犯：周日之后整体一条开放 TIR（最长匹配压过单用"周日"），不拆成两条。
  const afterWeekday = only('周日之后');
  assert.equal(afterWeekday.date, null);
  assert.ok(afterWeekday.flags.includes('OPEN_DIRECTIONAL'));
  assert.equal(afterWeekday.evidence[0]?.ruleId, 'gram:open-after-weekday7');
  // 孤立"周日"仍是可闭合星期 TIR，证明差异来自方位词被接住。
  assert.equal(only('周日').date?.kind, 'WEEKDAY_OF_WEEK');
});

test('#132 T5 月年粒度冻结与指代：GRAIN/DEICTIC 留痕、date=null，词表短路与文法产生式分路', () => {
  // 文法 T9：方向（＋数）＋年/月，邻接成立才命中。
  const grainGrammar = only('上月');
  assert.equal(grainGrammar.date, null);
  assert.ok(grainGrammar.flags.includes('GRAIN_NOT_SUPPORTED'));
  assert.equal(grainGrammar.evidence[0]?.ruleId, 'gram:grain-frozen-direction');
  // 数据层整词（含分类词"个"的不进文法、年粒度词）走 LEXICON 短路。
  for (const text of ['上两个月', '上个月', '去年', '明年', '三月份']) {
    const ir = only(text);
    assert.equal(ir.date, null, `「${text}」冻结粒度不产日期原子`);
    assert.ok(ir.flags.includes('GRAIN_NOT_SUPPORTED'), `「${text}」flag`);
    assert.equal(ir.evidence[0]?.source, 'LEXICON', `「${text}」整词来自词表短路`);
  }
  for (const text of ['上次', '刚才', '那会儿']) {
    const ir = only(text);
    assert.equal(ir.date, null, `「${text}」指代日历永不解`);
    assert.ok(ir.flags.includes('DEICTIC_REFERENCE'), `「${text}」flag`);
  }
});
