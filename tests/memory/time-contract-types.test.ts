/**
 * #127 批 1（P0）时间硬约束冻结契约运行时测试。
 *
 * 本文件只锁"形状与资产纪律"：
 *  - 资产版本三元组存在、冻结、进锚点；
 *  - 词表骨架批 1 为空且冻结（批 2 填充时本断言同步改写，先红后绿）；
 *  - TimeConstraint 四态判别联合可穷尽、合法样例可构造、结构字段齐备。
 * 类型层面的"非法形态构造不出"由 time-contract.deny.ts 经 tsc 守门。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TIME_ASSET_VERSIONS, TIME_LEXICON_ENTRIES } from '../../src/memory/time-lexicon.ts';
import type {
  ClosednessProof,
  TimeAnchor,
  TimeConstraint,
  TimeIR,
  TimeWindow,
} from '../../src/memory/types.ts';

const anchor: TimeAnchor = {
  epochMs: 0,
  zoneId: 'Asia/Shanghai',
  weekStartsOn: 1,
  assets: TIME_ASSET_VERSIONS,
};

const proof: ClosednessProof = {
  dimensions: [
    { dim: 'YEAR', state: 'EXPLICIT', via: 'gram:year-month-day' },
    { dim: 'MONTH', state: 'EXPLICIT', via: 'gram:year-month-day' },
    { dim: 'DAY', state: 'EXPLICIT', via: 'gram:year-month-day' },
    { dim: 'ZONE', state: 'POLICY', via: 'policy:zone', policyVersion: TIME_ASSET_VERSIONS.policy },
    { dim: 'WEEK_START', state: 'POLICY', via: 'policy:week-start', policyVersion: TIME_ASSET_VERSIONS.policy },
    { dim: 'DAY_BOUNDARY', state: 'POLICY', via: 'policy:day-boundary', policyVersion: TIME_ASSET_VERSIONS.policy },
  ],
};

const windowSample: TimeWindow = {
  startMs: 1_763_491_200_000,
  endMs: 1_763_577_600_000,
  halfOpen: true,
  granularity: 'DAY',
};

const irSample: TimeIR = {
  span: [0, 13] as const,
  role: 'FILTER',
  date: { kind: 'YEAR_MONTH_DAY', year: 2025, month: 11, day: 19 },
  granularity: 'DAY',
  flags: [],
  evidence: [{ ruleId: 'gram:year-month-day', source: 'GRAMMAR', matchedText: '2025年11月19日' }],
};

function provenance(replayKey: string) {
  return {
    anchorEpochMs: anchor.epochMs,
    assets: TIME_ASSET_VERSIONS,
    replayKey,
  };
}

const fourStates: readonly TimeConstraint[] = [
  { kind: 'NONE', provenance: provenance('rk-none') },
  {
    kind: 'UNCERTAIN',
    reason: 'MISSING_YEAR',
    spans: [[0, 4] as const],
    provenance: provenance('rk-uncertain'),
  },
  {
    kind: 'CANDIDATES',
    windows: [windowSample, { ...windowSample, startMs: windowSample.startMs + 86_400_000 }],
    ambiguity: ['gram:weekday-residual', 'gram:weekday-residual'],
    provenance: provenance('rk-candidates'),
  },
  {
    kind: 'WINDOW',
    window: windowSample,
    closure: proof,
    provenance: provenance('rk-window'),
  },
];

test('P0 资产版本：三元组字段齐备且整体冻结，锚点直接引用同一对象', () => {
  assert.equal(typeof TIME_ASSET_VERSIONS.lexicon, 'string');
  assert.equal(typeof TIME_ASSET_VERSIONS.grammar, 'string');
  assert.equal(typeof TIME_ASSET_VERSIONS.policy, 'string');
  assert.ok(TIME_ASSET_VERSIONS.lexicon.length > 0);
  assert.equal(Object.isFrozen(TIME_ASSET_VERSIONS), true);
  assert.strictEqual(anchor.assets, TIME_ASSET_VERSIONS);
});

test('P0 词表骨架：批 1 主数据为空数组且冻结（批 2 填充时改写本断言）', () => {
  // 批 2 已按封闭清单填满：断言从"空"改判为"非空、全冻结、id 与 surface 全局唯一"。
  assert.ok(TIME_LEXICON_ENTRIES.length > 0, '批 2 起词表不得为空');
  assert.equal(Object.isFrozen(TIME_LEXICON_ENTRIES), true);

  const ids = new Set<string>();
  const surfaces = new Set<string>();
  for (const entry of TIME_LEXICON_ENTRIES) {
    assert.equal(ids.has(entry.id), false, `词条 id 重复：${entry.id}`);
    assert.equal(surfaces.has(entry.surface), false, `surface 重复：${entry.surface}`);
    ids.add(entry.id);
    surfaces.add(entry.surface);
    assert.equal(Object.isFrozen(entry), true, `词条未冻结：${entry.id}`);
    assert.equal(Object.isFrozen(entry.atom), true, `原子未冻结：${entry.id}`);
  }

  // 封闭区间边界：-3..+3 两端在册，区间外不建词。
  assert.ok(surfaces.has('大前天'));
  assert.ok(surfaces.has('大后天'));
  assert.equal(surfaces.has('大大后天'), false);
  // 裸周偏移只是词偏移原子，不产日期原子（组合责任在文法产生式）。
  assert.ok(surfaces.has('上上周'));
});

test('P0 四态信封：四种合法形态可构造，判别 switch 穷尽且各带 provenance', () => {
  assert.equal(fourStates.length, 4);
  const kinds = fourStates.map((c) => c.kind);
  assert.deepEqual([...kinds].sort(), ['CANDIDATES', 'NONE', 'UNCERTAIN', 'WINDOW']);
  for (const c of fourStates) {
    // 穷尽判别：联合若新增第五态，default 分支编译期报错（assertNever 守门）。
    switch (c.kind) {
      case 'NONE':
      case 'UNCERTAIN':
      case 'CANDIDATES':
      case 'WINDOW':
        assert.equal(c.provenance.assets, TIME_ASSET_VERSIONS);
        break;
      default:
        assertNever(c);
    }
  }
});

test('P0 WINDOW 契约：半开窗 endMs 严格大于 startMs，闭合证明六维度齐备', () => {
  const w = fourStates[3];
  assert.equal(w?.kind, 'WINDOW');
  if (w?.kind === 'WINDOW') {
    assert.equal(w.window.halfOpen, true);
    assert.ok(w.window.endMs > w.window.startMs);
    const dims = w.closure.dimensions.map((d) => d.dim).sort();
    assert.deepEqual(dims, ['DAY', 'DAY_BOUNDARY', 'MONTH', 'WEEK_START', 'YEAR', 'ZONE']);
    assert.ok(w.closure.dimensions.every((d) => d.state === 'EXPLICIT' || d.state === 'POLICY'));
  }
});

test('P0 CANDIDATES 契约：候选为同位数组、无首选语义；TIR 不含毫秒字段', () => {
  const c = fourStates[2];
  assert.equal(c?.kind, 'CANDIDATES');
  if (c?.kind === 'CANDIDATES') {
    assert.equal(c.windows.length, 2);
    assert.equal(c.ambiguity.length, c.windows.length);
    assert.equal('preferred' in c, false);
    assert.equal('score' in c, false);
    assert.equal('rank' in c, false);
    assert.equal('confidence' in c, false);
  }
  // TIR 日期原子只含 civil 整数，序列化结果不得出现 ms 字段。
  assert.equal('startMs' in irSample, false);
  assert.equal('endMs' in irSample, false);
  assert.equal('ms' in irSample, false);
});

function assertNever(value: never): never {
  throw new Error(`TimeConstraint 联合未穷尽：${JSON.stringify(value)}`);
}
