/**
 * dsh 适配器：说话者（speaker）→ 内核身份（initiation）映射单测。
 *
 * 该映射规则原位于内核门面 api/index.ts 的 initiationOf；H2-a 下沉到 dsh 适配器：
 * 「宿主怎么命名说话者」是宿主事实，中立内核只接收中性的 initiation，不再认得
 * assistant 这类宿主角色名。规则逐字搬迁，结果必须与旧表完全一致（含未知值透传）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initiationOf } from '../../../src/adapters/dsh/initiation.ts';

test('initiationOf：四个已知说话者按固定口径映射为内核身份', () => {
  assert.equal(initiationOf('user'), 'user');
  assert.equal(initiationOf('assistant'), 'her');
  assert.equal(initiationOf('system'), 'system');
  assert.equal(initiationOf('tool'), 'environment');
});

test('initiationOf：未知说话者原样透传（开放枚举，不报错、不丢事件）', () => {
  assert.equal(initiationOf('guest'), 'guest');
  assert.equal(initiationOf('some-future-role'), 'some-future-role');
});

test('initiationOf：空串等价透传，与旧内核实现逐字一致', () => {
  assert.equal(initiationOf(''), '');
});
