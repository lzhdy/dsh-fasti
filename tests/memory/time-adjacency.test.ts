/**
 * #128 批 A1 红测：L2 产生式必须遵守"原文邻接铁律"。
 *
 * 根因（e10 人工核对暴露，见仓库外《#128时间解析外部方案调研》第三节）：
 * tokenizeTimeText 对未命中汉字逐字跳过（time-expr.ts:190 起），而 matchParts 只按 tokens 数组
 * 下标相邻匹配，**从不校验相邻 token 在原文里是否真相邻**。于是"周"与六个字之后的"一"被拼成
 * "本周一"，凭空造出一个窗并把正确卡驳回。
 *
 * 外部依据：SynTime（ACL 2017）时间段扩张规则——向左不越前一个时间词、向右不越后一个时间词，
 * 且遇到逗号/连接词/非时间词即停止扩张（作者博士论文 2.2 节）。本批只落实"不许跨字硬拼"这一条。
 *
 * 本测自成体系：断言全部来自结构不变量（命中区间不得含"我们不认识的字"），不引用任何封存题面。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTimeExpressions, tokenizeTimeText } from '../../src/memory/time-expr.ts';
import type { TimeIR } from '../../src/memory/types.ts';

function irsOf(text: string): readonly TimeIR[] {
  return parseTimeExpressions(text);
}

function spansOf(text: string): readonly string[] {
  return irsOf(text).map((ir) => text.slice(ir.span[0], ir.span[1]));
}

test('A1-1 跨字硬拼必须消失："周"与远隔六字的"一"不得拼成星期几', () => {
  const text = '周会材料那事我一直挂着';
  const irs = irsOf(text);
  assert.equal(irs.length, 0, `「${text}」不应产出任何 TIR（实际命中：${JSON.stringify(spansOf(text))}）`);
});

test('A1-2 中间夹着实词的周偏移不得吞掉后面单字数字', () => {
  const text = '这周我一直在等消息';
  const spans = spansOf(text);
  assert.deepEqual(spans, ['这周'], `命中区间必须是「这周」，不得是「这周我一」（实际：${JSON.stringify(spans)}`);
  const first = irsOf(text)[0];
  assert.ok(first !== undefined);
  assert.equal(first.date?.kind, 'WEEK_OF');
  assert.equal(first.granularity, 'WEEK');
});

test('A1-3 中间夹着标点必须断开（逗号不许被跨过）', () => {
  const text = '上周，五个人都到齐了';
  const spans = spansOf(text);
  assert.deepEqual(spans, ['上周'], `命中区间必须是「上周」（实际：${JSON.stringify(spans)}`);
  assert.equal(irsOf(text)[0]?.date?.kind, 'WEEK_OF');
});

test('A1-4 中间夹着助词不得拼成「本周搞定」之外的假日期', () => {
  const text = '管接头必须本周搞定';
  const spans = spansOf(text);
  assert.deepEqual(spans, ['本周'], `命中区间必须是「本周」（实际：${JSON.stringify(spans)}`);
  const first = irsOf(text)[0];
  assert.ok(first !== undefined);
  assert.equal(first.date?.kind, 'WEEK_OF');
  assert.equal(first.evidence[0]?.matchedText, '本周');
});

test('A1-5 空白不是间隔：日期间留空格仍须正常拼出（回归锁）', () => {
  const text = '1 月 18 号交材料';
  const irs = irsOf(text);
  assert.equal(irs.length, 1, `空白应被允许跨越（实际 ${irs.length} 条）`);
  const first = irs[0];
  assert.ok(first !== undefined);
  assert.equal(first.date?.kind, 'MONTH_DAY');
  assert.equal(text.slice(first.span[0], first.span[1]), '1 月 18 号');
});

test('A1-6 真紧邻的星期几照常解析（不得因本改动误伤）', () => {
  const text = '上周五开会';
  const irs = irsOf(text);
  assert.equal(irs.length, 1);
  const first = irs[0];
  assert.ok(first !== undefined);
  assert.equal(first.date?.kind, 'WEEKDAY_OF_WEEK');
  assert.equal(first.evidence[0]?.matchedText, '上周五');
});

test('A1-7 结构不变量：命中区间内每个字都必须被某个已知 token 覆盖，不得留跳字空隙', () => {
  const samples = [
    '周会材料那事我一直挂着',
    '这周我一直在等消息',
    '上周，五个人都到齐了',
    '管接头必须本周搞定',
    '阳台封窗这周交给谁办',
    '第3周我一直在盯进度',
    '下周一给我准信',
  ];
  const isBlank = (ch: string): boolean => ch === ' ' || ch === '\u3000' || ch === '\t';
  for (const text of samples) {
    const tokens = tokenizeTimeText(text);
    for (const ir of irsOf(text)) {
      const hit = text.slice(ir.span[0], ir.span[1]);
      assert.ok(hit.length > 0, `「${text}」产出空区间`);
      assert.equal(ir.evidence[0]?.matchedText, hit, `证据切片与命中区间不一致：「${text}」`);
      for (let at = ir.span[0]; at < ir.span[1]; at += 1) {
        const covered = tokens.some((t) => t.span[0] <= at && at < t.span[1]);
        const ch = text[at] as string;
        assert.ok(covered || isBlank(ch), `「${text}」命中区间「${hit}」在第 ${at} 位含未被 token 覆盖的字「${ch}」`);
      }
    }
  }
});
