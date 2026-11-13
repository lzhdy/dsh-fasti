/**
 * 四态度量与弃权/噪声探针夹具测试（#44 第一层，#54；提案 §5.7/§8.4，闭合 D4/D10/D11/D12，N2 分母自证）。
 *
 * 纪律：
 *  - 纯函数表驱动：不触库、不触网络、无 Date.now/Math.random；
 *  - N2 硬自证：混排 hasGold 2×2 断言 G+NG=N、wc_G/wc_NG 不双计、各率分母正确、零分母 N/A；
 *  - 旧 r2 口径差并列（弃权在旧口径计错、新 falseCommitRate 不计弃权）；
 *  - abstain 夹具扩白名单：拒收任何正文字段，goldCardId 允许 null（hasGold=false）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { IntegrityError } from '../../src/core/errors.ts';
import {
  abstainHasGold,
  loadAbstainFixtures,
  validateFixtureFile,
} from '../../src/memory/audit/fixtures.ts';
import {
  classifyProbe,
  isNaEstimate,
  summarizeFourState,
} from '../../src/memory/audit/four-state.ts';
import type { FourStateProbeInput } from '../../src/memory/audit/four-state.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures', 'memory');

const probe = (over: Partial<FourStateProbeInput>): FourStateProbeInput => ({
  probeRef: 'p',
  hasGold: true,
  committed: true,
  top1IsGold: true,
  highRisk: false,
  ...over,
});

const isNa = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as { status?: string }).status === 'n-a';

// ── A. classifyProbe 表驱动（2×2 + 有金标题三分支）────────────────────────

test('classifyProbe：hasGold × committed 2×2 与 top1 判定表驱动', () => {
  const table: Array<[string, Partial<FourStateProbeInput>, string]> = [
    ['有金·认定·top1=金标', { hasGold: true, committed: true, top1IsGold: true }, 'correct-commit'],
    ['有金·认定·top1≠金标', { hasGold: true, committed: true, top1IsGold: false }, 'wrong-commit'],
    ['有金·弃权', { hasGold: true, committed: false, top1IsGold: false }, 'wrong-abstain'],
    ['无金·认定（无中生有）', { hasGold: false, committed: true, top1IsGold: false }, 'wrong-commit'],
    ['无金·弃权', { hasGold: false, committed: false, top1IsGold: false }, 'correct-abstain'],
  ];
  for (const [label, over, expected] of table) {
    assert.equal(classifyProbe(probe(over)), expected, label);
  }
});

test('classifyProbe：弃权时 top1IsGold 被忽略（不会因残留 true 误判为认对）', () => {
  assert.equal(classifyProbe(probe({ hasGold: true, committed: false, top1IsGold: true })), 'wrong-abstain');
  assert.equal(classifyProbe(probe({ hasGold: false, committed: false, top1IsGold: true })), 'correct-abstain');
});

// ── B. N2 分母自证：G+NG=N、wc 不双计、反例 ────────────────────────────────

test('N2：提案反例（1 条有金返回错卡 + 1 条无金返回卡）→ G=1/NG=1/N=2，旧错误公式会得 4', () => {
  const probes = [
    probe({ probeRef: 'g1', hasGold: true, committed: true, top1IsGold: false }),
    probe({ probeRef: 'n1', hasGold: false, committed: true, top1IsGold: false }),
  ];
  const summary = summarizeFourState(probes);
  assert.equal(summary.counts.wcG, 1);
  assert.equal(summary.counts.wcNG, 1);
  assert.equal(summary.counts.wc, 2, 'wc = wc_G + wc_NG');
  assert.equal(summary.counts.G, 1);
  assert.equal(summary.counts.NG, 1);
  assert.equal(summary.counts.N, 2);
  assert.equal(summary.counts.G + summary.counts.NG, summary.counts.N, '恒等式 G+NG=N');
});

test('N2：混排 2×2 五态计数与各率分母逐一正确', () => {
  // cc=2, wc_G=1, wa=1 → G=4；ca=2, wc_NG=1 → NG=3；N=7
  const probes = [
    ...Array.from({ length: 2 }, (_, i) => probe({ probeRef: `cc${i}` })),
    probe({ probeRef: 'wcg', hasGold: true, committed: true, top1IsGold: false }),
    probe({ probeRef: 'wa', hasGold: true, committed: false, top1IsGold: false }),
    ...Array.from({ length: 2 }, (_, i) =>
      probe({ probeRef: `ca${i}`, hasGold: false, committed: false, top1IsGold: false }),
    ),
    probe({ probeRef: 'wcng', hasGold: false, committed: true, top1IsGold: false }),
  ];
  const s = summarizeFourState(probes);
  assert.deepEqual(
    [s.counts.cc, s.counts.wcG, s.counts.wcNG, s.counts.wc, s.counts.wa, s.counts.ca],
    [2, 1, 1, 2, 1, 2],
  );
  assert.equal(s.counts.G, 4, 'G = cc + wc_G + wa');
  assert.equal(s.counts.NG, 3, 'NG = ca + wc_NG');
  assert.equal(s.counts.N, 7);
  assert.equal(s.counts.G + s.counts.NG, s.counts.N);

  // committed = cc + wc_G + wc_NG = 2+1+1 = 4
  assert.equal(s.rates.falseCommitRate, 2 / 4, 'falseCommitRate = wc/committed');
  assert.equal(s.rates.recallAfterGate, 2 / 4, 'recallAfterGate = cc/G');
  assert.equal(s.rates.wrongAbstainRate, 1 / 4, 'wrongAbstainRate = wa/G');
  assert.equal(s.rates.correctRejectRate, 2 / 3, 'correctRejectRate = ca/NG');
  assert.equal(s.rates.abstainRate, 3 / 7, 'abstainRate = (ca+wa)/N');
});

test('N2：零分母一律 N/A（不填 0），可算的仍给数', () => {
  // 空输入：全部 N/A。
  const empty = summarizeFourState([]);
  for (const key of ['falseCommitRate', 'recallAfterGate', 'wrongAbstainRate', 'correctRejectRate', 'abstainRate'] as const) {
    assert.ok(isNa(empty.rates[key]), `空输入 ${key} 应 N/A`);
  }
  assert.deepEqual(empty.counts.N, 0);

  // 只有无金标题且正确弃权：G=0 → recallAfterGate/wrongAbstainRate N/A；committed=0 → falseCommitRate N/A。
  const onlyNg = summarizeFourState([probe({ hasGold: false, committed: false, top1IsGold: false })]);
  assert.ok(isNa(onlyNg.rates.recallAfterGate));
  assert.ok(isNa(onlyNg.rates.wrongAbstainRate));
  assert.ok(isNa(onlyNg.rates.falseCommitRate));
  assert.equal(onlyNg.rates.correctRejectRate, 1);
  assert.equal(onlyNg.rates.abstainRate, 1, 'N>0 时 abstainRate 可算');

  // 只有有金标题且认对：NG=0 → correctRejectRate N/A。
  const onlyGold = summarizeFourState([probe({})]);
  assert.ok(isNa(onlyGold.rates.correctRejectRate));
  assert.equal(onlyGold.rates.falseCommitRate, 0, 'committed>0 且 wc=0 → 0');
  assert.equal(onlyGold.rates.recallAfterGate, 1);
});

// ── C. 高危双硬约束与旧 r2 口径差并列 ─────────────────────────────────────

test('高危：仅统计 highRisk 探针的 wrong-commit（弃权不计高危）', () => {
  const s = summarizeFourState([
    probe({ probeRef: 'h1', highRisk: true, hasGold: true, committed: true, top1IsGold: false }),
    probe({ probeRef: 'h2', highRisk: true, hasGold: true, committed: false, top1IsGold: false }),
    probe({ probeRef: 'h3', highRisk: false, hasGold: true, committed: true, top1IsGold: false }),
  ]);
  assert.equal(s.highRiskWrongCommits, 1, '仅高危错认计 1；高危弃权不计；非高危错认不计');
  assert.equal(s.counts.wcG, 2, '总体 wrong-commit 仍计 2');
});

test('旧 r2 并列：弃权在旧口径计错、在新 falseCommitRate 不计（口径差可见）', () => {
  // 有金 4 条：cc=2, wc_G=0, wa=2 → 旧 r2（错误率）= (0+2)/4 = 0.5；新 falseCommitRate = 0/2 = 0。
  const probes = [
    ...Array.from({ length: 2 }, (_, i) => probe({ probeRef: `cc${i}` })),
    ...Array.from({ length: 2 }, (_, i) => probe({ probeRef: `wa${i}`, committed: false, top1IsGold: false })),
  ];
  const s = summarizeFourState(probes);
  assert.equal(s.rates.recallAfterGate, 2 / 4);
  assert.equal(s.rates.falseCommitRate, 0, '弃权不计入主动认定 → 0');
  assert.ok(!isNaEstimate(s.legacyR2), '旧口径应有样本');
  assert.equal(s.legacyR2.point, 2 / 4, '旧 r2 为错误率：弃权计错');
  assert.equal(s.legacyR2.n, 4);
  assert.notEqual(s.legacyR2.point, s.rates.falseCommitRate, '两口径必须并列且可见差异');
});

test('旧 r2 判别：非对称与全错案例必须暴露错误率方向（N6 回归）', () => {
  // 对称例 cc2/wa2 两口径恰为 0.5，无法判别方向；下面两例可判别。
  const asym = summarizeFourState([
    ...Array.from({ length: 3 }, (_, i) => probe({ probeRef: `cc${i}` })),
    probe({ probeRef: 'wa', committed: false, top1IsGold: false }),
  ]);
  // 旧 r2 = (wc_G + wa)/G = (0+1)/4 = 0.25；若误成准确率则为 0.75。
  assert.ok(!isNaEstimate(asym.legacyR2));
  assert.equal(asym.legacyR2.point, 1 / 4, '旧 r2 须为错误率 0.25，而非准确率 0.75');
  assert.equal(asym.legacyR2.n, 4);

  const allWrong = summarizeFourState([
    ...Array.from({ length: 2 }, (_, i) => probe({ probeRef: `wcg${i}`, top1IsGold: false })),
    ...Array.from({ length: 2 }, (_, i) => probe({ probeRef: `wa${i}`, committed: false, top1IsGold: false })),
  ]);
  // 全错：旧 r2 = 4/4 = 1.0；若误成准确率则报 0.0（全错系统报零错，最严重）。
  assert.ok(!isNaEstimate(allWrong.legacyR2));
  assert.equal(allWrong.legacyR2.point, 1, '全错必须报错误率 1.0，不得报 0');
  assert.equal(allWrong.rates.falseCommitRate, 1, '新口径同为全错');
  assert.equal(allWrong.counts.cc, 0);
});

test('旧 r2：无有金探针时 N/A', () => {
  const s = summarizeFourState([probe({ hasGold: false, committed: false, top1IsGold: false })]);
  assert.ok(isNa(s.legacyR2));
});

// ── D. 纯函数纪律 ─────────────────────────────────────────────────────────

test('summarizeFourState：确定性、不突变输入、同输入两次逐字一致', () => {
  const probes = Object.freeze([
    Object.freeze(probe({ probeRef: 'a' })),
    Object.freeze(probe({ probeRef: 'b', committed: false, top1IsGold: false })),
  ]);
  const first = summarizeFourState(probes as readonly FourStateProbeInput[]);
  const second = summarizeFourState(probes as readonly FourStateProbeInput[]);
  assert.deepEqual(first, second);
  assert.notEqual(first, second, '返回新对象，不复用引用');
  assert.equal(first.counts.cc, 1);
});

// ── E. abstain 夹具扩白名单与独立加载 ─────────────────────────────────────

test('validateFixtureFile：abstain 层合法条目（goldCardId 允许 null）', () => {
  assert.doesNotThrow(() =>
    validateFixtureFile(
      {
        probeSetVersion: 'v1',
        layer: 'abstain',
        items: [
          { query: '库里没有的事', goldCardId: null, kind: 'unanswerable' },
          { query: '宽泛噪声', goldCardId: 'mc_real', kind: 'noise' },
        ],
      },
      'abstain',
      'abstain.json',
    ),
  );
});

test('validateFixtureFile：abstain 拒收正文字段与越界取值', () => {
  const bad = [
    { query: 'q', goldCardId: null, kind: 'unanswerable', summary: '正文副本' },
    { query: 'q', goldCardId: null, kind: 'noise', body: 'x' },
    { query: 'q', goldCardId: null, kind: 'bogus' },
    { query: '', goldCardId: null, kind: 'unanswerable' },
    { query: 'q', goldCardId: 5, kind: 'noise' },
    { query: 'q', goldCardId: null },
  ];
  for (const item of bad) {
    assert.throws(
      () => validateFixtureFile({ probeSetVersion: 'v1', layer: 'abstain', items: [item] }, 'abstain', 'f'),
      IntegrityError,
      JSON.stringify(item),
    );
  }
  // layer 不符 / 版本非法同样拒收。
  assert.throws(() => validateFixtureFile({ probeSetVersion: 'v1', layer: 'l0', items: [] }, 'abstain', 'f'), IntegrityError);
  assert.throws(() => validateFixtureFile({ probeSetVersion: '1', layer: 'abstain', items: [] }, 'abstain', 'f'), IntegrityError);
});

test('loadAbstainFixtures：读仓库合成 abstain.json，hasGold 由 goldCardId 判定', () => {
  const loaded = loadAbstainFixtures(fixturesDir);
  assert.ok(loaded.items.length >= 2, '至少一条不可答 + 一条噪声探针');
  const kinds = new Set(loaded.items.map((item) => item.kind));
  assert.ok(kinds.has('unanswerable') && kinds.has('noise'));
  for (const item of loaded.items) {
    assert.equal(abstainHasGold(item), item.goldCardId !== null, `${item.query}`);
  }
  assert.ok(loaded.items.some((item) => abstainHasGold(item) === false), '至少一条无金探针');
});

test('loadAbstainFixtures：缺文件抛错且不改动 loadFixtures 的四文件契约', () => {
  const root = makeTempRoot('abstain-missing-');
  try {
    assert.throws(() => loadAbstainFixtures(root), /不存在|Not Found|NotFound|读取/i);
    // 目录里只有四份金标/诱饵文件时，abstain 加载失败不应影响原 loadFixtures 契约（此处只验证文件缺失报错）。
    assert.ok(!fs.existsSync(path.join(root, 'abstain.json')));
  } finally {
    cleanupTempRoot(root);
  }
});
