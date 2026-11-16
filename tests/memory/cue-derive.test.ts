/**
 * #123 P1/P5 · cue 派生与规范化纯函数红测。
 *
 * 断言口径全部来自裁定稿：超 40 码点整条丢弃（不截断）、H7 双形态子串反查、
 * 去重保序取前 3、空集回落 `[""]` 占位、规则启用只认 rules_version。
 *
 * 纪律：零 IO、零 DB、零真根读写。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CUE_MAX_CODEPOINTS,
  CUE_MAX_COUNT,
  deriveCuesFromKeyPoints,
  isCueDerivationEnabled,
} from '../../src/memory/cue-derive.ts';
import { normalizeDisplayCues } from '../../src/memory/builder.ts';

test('#123 P1：只有 rules-v2 启用 cue 派生，v1 恒关', () => {
  assert.equal(isCueDerivationEnabled('rules-v1'), false);
  assert.equal(isCueDerivationEnabled('rules-v2'), true);
});

test('#123 P1：清洗 + 去重保序 + 保序取前 3', () => {
  const result = deriveCuesFromKeyPoints({
    keyPoints: ['  荷花  ', '池塘', '荷花', '翻倍', '第 29 天'],
    summary: null,
  });
  assert.deepEqual(result.cues, ['荷花', '池塘', '翻倍']);
  assert.equal(result.cues.length, CUE_MAX_COUNT);
  assert.equal(result.droppedTooLong, 0);
  assert.equal(result.droppedH7, 0);
});

test('#123 P1：超过 40 码点整条丢弃，不截断；40 码点保留', () => {
  const exactly = '甲'.repeat(CUE_MAX_CODEPOINTS);
  const tooLong = '乙'.repeat(CUE_MAX_CODEPOINTS + 1);
  const result = deriveCuesFromKeyPoints({ keyPoints: [exactly, tooLong, '丙'], summary: null });
  assert.deepEqual(result.cues, ['甲'.repeat(CUE_MAX_CODEPOINTS), '丙']);
  assert.equal(result.droppedTooLong, 1);
});

test('#123 P1：H7 —— ≥20 码点且被摘要字面包含则丢弃', () => {
  const longCue = '这段内容直接摘自摘要原文的二十个字符以上片段';
  const summary = `前置说明。${longCue}。后置说明。`;
  const result = deriveCuesFromKeyPoints({ keyPoints: [longCue, '荷花'], summary });
  assert.deepEqual(result.cues, ['荷花']);
  assert.equal(result.droppedH7, 1);
});

test('#123 P1：H7 —— 短于 20 码点不做子串反查', () => {
  const result = deriveCuesFromKeyPoints({ keyPoints: ['荷花'], summary: '荷花那题翻倍到 512' });
  assert.deepEqual(result.cues, ['荷花']);
  assert.equal(result.droppedH7, 0);
});

test('#123 P1：H7 —— summary 为 null 时不拦', () => {
  const longCue = '这段内容直接摘自摘要原文的二十个字符以上片段';
  const result = deriveCuesFromKeyPoints({ keyPoints: [longCue], summary: null });
  assert.deepEqual(result.cues, [longCue]);
});

test('#123 P1：空 key_points / 纯空白 → 空 cue 集', () => {
  assert.deepEqual(deriveCuesFromKeyPoints({ keyPoints: [], summary: null }).cues, []);
  assert.deepEqual(deriveCuesFromKeyPoints({ keyPoints: ['   ', '\t'], summary: null }).cues, []);
});

test('#123 P5：normalizeDisplayCues 单点收口 —— 清洗/去重/超长丢/取 3/空占位', () => {
  assert.deepEqual(normalizeDisplayCues(['  荷花 ', '池塘', '荷花', '翻倍', '第五']), [
    '荷花',
    '池塘',
    '翻倍',
  ]);
  assert.deepEqual(normalizeDisplayCues([]), ['']);
  assert.deepEqual(normalizeDisplayCues(['   ']), ['']);
  assert.deepEqual(normalizeDisplayCues(['甲'.repeat(CUE_MAX_CODEPOINTS + 1)]), ['']);
});
