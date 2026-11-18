/**
 * A1/A4 P6 夹具元数据 schema 测试（v4 §9 序 1、14）。
 *
 * 覆盖：S0–S4 构造层标、撰写源定位、五类高危标记、S1 占比、仲裁留痕字段的形状校验。
 * 纪律：字段可缺省（必填约束属 B 批加载器）；本文件只验形状与枚举闭合，不触库、无网络。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IntegrityError } from '../../src/core/errors.ts';
import { validateFixtureFile } from '../../src/memory/audit/fixtures.ts';

const l0Base = {
  eventId: 'syn-ev-0',
  channel: 'dsh',
  queries: ['合成线索零'],
  aliases: [{ term: '合成别名零', source: 'miss', sensitive: 1 }],
  sensitiveTerms: [],
  discriminatorNeighborEventIds: [],
  expectedSlots: ['relevance'],
};

const l1Base = {
  questionExperienceId: 'syn-q-0',
  targetEventId: 'syn-ev-0',
  initiation: 'user',
  coldStart: false,
};

function l0Doc(over: Record<string, unknown>) {
  return { probeSetVersion: 'v1', layer: 'l0', items: [{ ...l0Base, ...over }] };
}

function l1Doc(over: Record<string, unknown>) {
  return { probeSetVersion: 'v1', layer: 'l1', items: [{ ...l1Base, ...over }] };
}

test('A1：l0/l1 合法 P6 元数据全字段通过校验', () => {
  const meta = {
    constructionLayer: 'S1',
    sourceLocation: { source: 'raw-turn', anchor: 'turn-12' },
    highRiskLabel: 'promise',
    sourceCharShare: 0.2,
    arbitration: { adjudicator: 'independent-01', decision: 'S1 片段' },
  };
  assert.doesNotThrow(() => validateFixtureFile(l0Doc(meta), 'l0', 'gold-l0.json'));
  assert.doesNotThrow(() => validateFixtureFile(l1Doc(meta), 'l1', 'gold-l1.json'));
});

test('A1：无元数据的既有条目仍被容忍（向后兼容）', () => {
  assert.doesNotThrow(() => validateFixtureFile(l0Doc({}), 'l0', 'gold-l0.json'));
  assert.doesNotThrow(() => validateFixtureFile(l1Doc({}), 'l1', 'gold-l1.json'));
});

test('A1：constructionLayer 越界枚举拒收', () => {
  assert.throws(
    () => validateFixtureFile(l0Doc({ constructionLayer: 'S9' }), 'l0', 'f'),
    IntegrityError,
  );
});

test('A1：sourceLocation 形状/来源枚举/缺锚点拒收', () => {
  assert.throws(
    () => validateFixtureFile(l0Doc({ sourceLocation: { source: 'summary', anchor: '' } }), 'l0', 'f'),
    IntegrityError,
  );
  assert.throws(
    () => validateFixtureFile(l0Doc({ sourceLocation: { source: 'body', anchor: 'x' } }), 'l0', 'f'),
    IntegrityError,
  );
  assert.throws(
    () => validateFixtureFile(l0Doc({ sourceLocation: { source: 'raw-turn', anchor: 'x', extra: 1 } }), 'l0', 'f'),
    IntegrityError,
  );
});

test('A1：highRiskLabel 越界枚举拒收', () => {
  assert.throws(
    () => validateFixtureFile(l0Doc({ highRiskLabel: 'opinion' }), 'l0', 'f'),
    IntegrityError,
  );
});

test('A1：sourceCharShare 越界数值拒收（0..1）', () => {
  assert.throws(
    () => validateFixtureFile(l0Doc({ sourceCharShare: 1.5 }), 'l0', 'f'),
    IntegrityError,
  );
  assert.throws(
    () => validateFixtureFile(l0Doc({ sourceCharShare: '0.2' }), 'l0', 'f'),
    IntegrityError,
  );
});

test('A4：仲裁留痕缺字段/多余字段拒收', () => {
  assert.throws(
    () => validateFixtureFile(l0Doc({ arbitration: { adjudicator: 'a' } }), 'l0', 'f'),
    IntegrityError,
  );
  assert.throws(
    () =>
      validateFixtureFile(
        l0Doc({ arbitration: { adjudicator: 'a', decision: 'S0', note: 'x' } }),
        'l0',
        'f',
      ),
    IntegrityError,
  );
});
