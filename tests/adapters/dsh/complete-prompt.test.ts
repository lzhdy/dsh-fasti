/**
 * dsh complete system prompt 段测试（#154）。
 *
 * complete:true 段在宿主 assemble 时会成为唯一 system section（工具 schema 与
 * runtime context 不受影响）。#154 收口后 dsh 不再持有自己的提示词文本：
 * DSH_COMPLETE_PROMPT 必须就是契约层 SHARED_SYSTEM_PROMPT 同一引用，字面冻结与
 * 单点定义守卫统一在 tests/contract/system-prompts.test.ts，本文件只锁引用同一性、
 * 最小形态与 section 注册元数据。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SHARED_SYSTEM_PROMPT } from '../../../src/contract/system-prompts.ts';
import {
  DSH_COMPLETE_PROMPT,
  DSH_COMPLETE_SECTION_NAME,
  DSH_COMPLETE_SECTION_ORDER,
} from '../../../src/adapters/dsh/complete-prompt.ts';

test('complete 段与跨通道共享母本完全同一引用、同一段文本', () => {
  assert.equal(DSH_COMPLETE_PROMPT, SHARED_SYSTEM_PROMPT, 'dsh 侧必须直接引用共享母本，不得另写副本');
  assert.ok(Object.is(DSH_COMPLETE_PROMPT, SHARED_SYSTEM_PROMPT), '必须是同一常量引用（同一内存对象）');
});

test('complete 段最小形态：无身份句、无宿主工具纪律回流', () => {
  for (const banned of [
    'You are',
    'powered by',
    'bash',
    'web_fetch',
    'read tool',
    'edit',
    'glob',
    'grep',
    'subagent',
    'workflow',
  ]) {
    assert.ok(!DSH_COMPLETE_PROMPT.includes(banned), `complete 段不得回流工具/身份内容：${banned}`);
  }
});

test('section 注册元数据固定：名称带 fasti 前缀、order 为有限数', () => {
  assert.equal(DSH_COMPLETE_SECTION_NAME, 'fasti:complete-prompt');
  assert.ok(Number.isFinite(DSH_COMPLETE_SECTION_ORDER), '宿主要求 section order 必须是有限数');
});
