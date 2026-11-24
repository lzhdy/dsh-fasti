/**
 * N3 红测：v2 考卷（fasti-p6-probes/v2）装配与守卫兼容（预注册 v5 §8.2 N3）。
 *
 * 覆盖：
 *  - 加载器认 v2 版本形态、S5 构造层、decoyKind 三分类、clarify 独立文件；
 *  - v1 原地零漂移（v1 版本/无 decoyKind 的旧条目照旧通过）；
 *  - G4② 扩到 S5、G4① 仍只对 S2–S4；
 *  - 纯装配：syn id 机械翻译、decoyKind 透传、clarify 翻成 pairCardIds、六件套落盘、G6 封存往返。
 *
 * 全部用 buildWorldV2() 纯蓝本构造假 idMap，不建 500 卡真根（真根实跑归批 4 证据）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildWorldV2 } from '../../src/memory/audit/corpus/world-plan-v2.ts';
import type { WorldPlanV2 } from '../../src/memory/audit/corpus/world-plan-v2.ts';
import { validateFixtureFile } from '../../src/memory/audit/fixtures.ts';
import { loadClarifyFixtures } from '../../src/memory/audit/fixtures.ts';
import { assertP6GoldItem } from '../../src/memory/audit/fixture-guard.ts';
import { sealFixtures, verifySeal } from '../../src/memory/audit/sealing.ts';
import { IntegrityError } from '../../src/core/errors.ts';
import {
  assembleSealedFixturesV2,
  assertAssembledGuardsV2,
  writeAssembledFixturesV2,
  SEAL_LAYER_QUOTAS_V2,
  PROBES_V2_VERSION,
} from '../../scripts/p6/assemble-sealed-fixtures-v2.ts';

const PLAN: WorldPlanV2 = buildWorldV2();
const SEALED = PLAN.events.filter((event) => event.partition === 'sealed');
const TUNING = PLAN.events.filter((event) => event.partition === 'tuning');

/** 纯假 idMap：只用蓝本事件 id，不触 sqlite。 */
function fakeIdMap(): Map<string, { synId: string; systemEventId: string; cardId: string; cues: readonly string[]; aliases: readonly { term: string; source: string; sensitive: 0 | 1 }[] }> {
  const map = new Map<string, { synId: string; systemEventId: string; cardId: string; cues: readonly string[]; aliases: readonly { term: string; source: string; sensitive: 0 | 1 }[] }>();
  for (const event of PLAN.events) {
    map.set(event.eventId, {
      synId: event.eventId,
      systemEventId: `sys-${event.eventId}`,
      cardId: `card-${event.eventId}`,
      cues: [...event.keyPoints],
      aliases: [],
    });
  }
  return map;
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function s0Item(eventId: string, rawText: string, sensitiveTerms: readonly string[]) {
  return {
    eventId,
    channel: 'dsh',
    queries: [rawText],
    aliases: [],
    sensitiveTerms: [...sensitiveTerms],
    discriminatorNeighborEventIds: [],
    expectedSlots: ['relevance'],
    constructionLayer: 'S0',
    sourceLocation: { source: 'raw-turn', anchor: 'turns[0]' },
    arbitration: { adjudicator: 'independent-author', decision: 'LAYER-S0-VERBATIM' },
  };
}

test('N3 加载器：v2 版本形态 + S5 层 + decoyKind 通过白名单', () => {
  const e = SEALED[0]!;
  const s5 = {
    ...s0Item(e.eventId, '那个阳台那道密封边，如今怎样了', e.sensitiveTerms),
    constructionLayer: 'S5',
    sourceLocation: { source: 'raw-turn', anchor: 'turns[5]' },
    arbitration: { adjudicator: 'independent-author', decision: 'LAYER-S5-CONTEXT-REFERENCE' },
  };
  validateFixtureFile({ probeSetVersion: PROBES_V2_VERSION, layer: 'l0', items: [s5] }, 'l0', 'gold-l0.json');

  validateFixtureFile(
    {
      probeSetVersion: PROBES_V2_VERSION,
      layer: 'decoy',
      items: [
        {
          pairCardIds: [`card-${SEALED[0]!.eventId}`, `card-${SEALED[1]!.eventId}`],
          goldCardId: `card-${SEALED[0]!.eventId}`,
          discriminatorQuery: '这两桩分别是什么',
          decoyKind: 'cross-family-collision',
        },
      ],
    },
    'decoy',
    'decoy.json',
  );
});

test('N3 加载器：v2 诱饵缺 decoyKind 或枚举非法即拒；v1 无 decoyKind 仍通过（零漂移）', () => {
  const decoy = (extra: Record<string, unknown>, version = PROBES_V2_VERSION) => ({
    probeSetVersion: version,
    layer: 'decoy',
    items: [
      {
        pairCardIds: [`card-${SEALED[0]!.eventId}`, `card-${SEALED[1]!.eventId}`],
        goldCardId: `card-${SEALED[0]!.eventId}`,
        discriminatorQuery: '这两桩分别是什么',
        ...extra,
      },
    ],
  });
  assert.throws(() => validateFixtureFile(decoy({}), 'decoy', 'decoy.json'), /decoyKind/);
  assert.throws(() => validateFixtureFile(decoy({ decoyKind: 'cross-theme' }), 'decoy', 'decoy.json'), /decoyKind/);
  // v1 旧条目无 decoyKind 必须照旧通过
  validateFixtureFile(decoy({}, 'v1'), 'decoy', 'decoy.json');
});

test('N3 加载器：clarify 独立文件校验与加载（形状/多余键/层名）', () => {
  const good = {
    probeSetVersion: PROBES_V2_VERSION,
    layer: 'clarify',
    items: [
      { pairCardIds: [`card-${SEALED[0]!.eventId}`, `card-${SEALED[1]!.eventId}`], detailWord: SEALED[0]!.keyPoints[1]!, expectedBehavior: 'clarify', query: '更换水管接头呢' },
    ],
  };
  validateFixtureFile(good, 'clarify', 'clarify.json');
  const dir = tempDir('p6-n3-clarify-');
  const sealDir = tempDir('p6-n3-clarify-seal-');
  try {
    fs.writeFileSync(path.join(dir, 'clarify.json'), `${JSON.stringify(good, null, 2)}\n`);
    const loaded = loadClarifyFixtures(dir);
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.probeSetVersion, PROBES_V2_VERSION);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sealDir, { recursive: true, force: true });
  }
  assert.throws(
    () =>
      validateFixtureFile(
        { probeSetVersion: PROBES_V2_VERSION, layer: 'clarify', items: [{ ...good.items[0]!, goldEventId: 'syn-sealed-999' }] },
        'clarify',
        'clarify.json',
      ),
    /非法字段|clarify/,
  );
});

test('N3 守卫：S5 走 G4②（撞 keyPoints 3 码点即拒），合规 S5 通过；S2–S4 仍走 G4①', () => {
  const e = SEALED[0]!;
  const card = { eventId: e.eventId, cues: [...e.keyPoints], aliases: [] };
  const s5 = (query: string) => ({
    ...s0Item(e.eventId, query, e.sensitiveTerms),
    constructionLayer: 'S5' as const,
    sourceLocation: { source: 'raw-turn' as const, anchor: 'turns[5]' },
    arbitration: { adjudicator: 'independent-author', decision: 'LAYER-S5-CONTEXT-REFERENCE' },
  });
  // 直抄 keyPoints[1] 必撞 ≥3 码点 → 必须被 G4② 抓
  assert.throws(() => assertP6GoldItem(s5(`那个${e.keyPoints[1]}后来怎样了`) as never, card, e.keyPoints), IntegrityError);
  // 换述、不撞要点、带具体细节 → 通过
  assertP6GoldItem(s5('那个上次说过的密封边和顶灯，如今怎样了') as never, card, e.keyPoints);
});

test('N3 纯装配：syn id 机械翻译、decoyKind 透传、clarify 翻 pairCardIds、无 syn 残留', () => {
  const idMap = fakeIdMap();
  const e0 = SEALED[0]!;
  const e1 = SEALED[1]!;
  const e2 = SEALED[2]!;
  const authored = {
    gold: { probeSetVersion: PROBES_V2_VERSION, layer: 'l0', items: [s0Item(e0.eventId, e0.turns[0]!.rawText, e0.sensitiveTerms)] },
    decoy: {
      probeSetVersion: PROBES_V2_VERSION,
      layer: 'decoy',
      items: [{ pairEventIds: [e0.eventId, e2.eventId], goldEventId: e0.eventId, discriminatorQuery: '这两桩分别是什么', decoyKind: 'same-family' }],
    },
    clarify: {
      probeSetVersion: PROBES_V2_VERSION,
      layer: 'clarify',
      items: [{ pairEventIds: [e0.eventId, e2.eventId], detailWord: e0.keyPoints[1]!, expectedBehavior: 'clarify', query: `${e0.keyPoints[1]}呢` }],
    },
    abstain: { probeSetVersion: PROBES_V2_VERSION, layer: 'abstain', items: [{ query: '深海热泉管虫靠什么活着', goldEventId: null, kind: 'unanswerable' }, { query: '那桩事进展如何', goldEventId: e1.eventId, kind: 'noise' }] },
  };
  const files = assembleSealedFixturesV2(authored as never, idMap as never);
  assert.equal(files.goldL0.items[0]!.eventId, `sys-${e0.eventId}`);
  assert.deepEqual(files.decoy.items[0]!.pairCardIds, [`card-${e0.eventId}`, `card-${e2.eventId}`]);
  assert.equal(files.decoy.items[0]!.goldCardId, `card-${e0.eventId}`);
  assert.equal(files.decoy.items[0]!.decoyKind, 'same-family');
  assert.deepEqual(files.clarify.items[0]!.pairCardIds, [`card-${e0.eventId}`, `card-${e2.eventId}`]);
  assert.equal(files.abstain.items[0]!.goldCardId, null);
  assert.equal(files.abstain.items[1]!.goldCardId, `card-${e1.eventId}`);
  assert.deepEqual(files.goldL1, { probeSetVersion: PROBES_V2_VERSION, layer: 'l1', items: [] });
  assert.deepEqual(files.holdout, { probeSetVersion: PROBES_V2_VERSION, layer: 'l2', items: [] });
  assert.deepEqual(SEAL_LAYER_QUOTAS_V2, { S0: 150, S1: 150, S2: 50, S3: 50, S4: 50, S5: 100 });
  for (const item of files.goldL0.items) assert.ok(!item.eventId.startsWith('syn-'), '不得残留合成 id');
  assertAssembledGuardsV2(files as never, idMap as never, PLAN);
});

test('N3 纯装配：悬空 syn id 硬拒；非封存（调参）事件 id 亦拒', () => {
  const idMap = fakeIdMap();
  const e0 = SEALED[0]!;
  assert.throws(
    () =>
      assembleSealedFixturesV2(
        {
          gold: { probeSetVersion: PROBES_V2_VERSION, layer: 'l0', items: [s0Item('syn-sealed-999', 'x', [])] },
          decoy: { probeSetVersion: PROBES_V2_VERSION, layer: 'decoy', items: [] },
          clarify: { probeSetVersion: PROBES_V2_VERSION, layer: 'clarify', items: [] },
          abstain: { probeSetVersion: PROBES_V2_VERSION, layer: 'abstain', items: [] },
        } as never,
        idMap as never,
      ),
    /无法映射|找不到|不存在/,
  );
  // 调参事件出现在金标 → 守卫或装配须拒（本卷终判只用封存事件）
  assert.throws(
    () =>
      assertAssembledGuardsV2(
        assembleSealedFixturesV2(
          {
            gold: { probeSetVersion: PROBES_V2_VERSION, layer: 'l0', items: [s0Item(TUNING[0]!.eventId, TUNING[0]!.turns[0]!.rawText, TUNING[0]!.sensitiveTerms)] },
            decoy: { probeSetVersion: PROBES_V2_VERSION, layer: 'decoy', items: [] },
            clarify: { probeSetVersion: PROBES_V2_VERSION, layer: 'clarify', items: [] },
            abstain: { probeSetVersion: PROBES_V2_VERSION, layer: 'abstain', items: [] },
          } as never,
          idMap as never,
        ) as never,
        idMap as never,
        PLAN,
      ),
    /调参|封存/,
  );
  assert.ok(e0.eventId.startsWith('syn-sealed-'));
});

test('N3 落盘与封存：六件套、G6 往返、篡改即失验', () => {
  const idMap = fakeIdMap();
  const e0 = SEALED[0]!;
  const files = assembleSealedFixturesV2(
    {
      gold: { probeSetVersion: PROBES_V2_VERSION, layer: 'l0', items: [s0Item(e0.eventId, e0.turns[0]!.rawText, e0.sensitiveTerms)] },
      decoy: { probeSetVersion: PROBES_V2_VERSION, layer: 'decoy', items: [] },
      clarify: { probeSetVersion: PROBES_V2_VERSION, layer: 'clarify', items: [] },
      abstain: { probeSetVersion: PROBES_V2_VERSION, layer: 'abstain', items: [] },
    } as never,
    idMap as never,
  );
  const outDir = tempDir('p6-n3-out-');
  const sealRoot = tempDir('p6-n3-seal-');
  const sealDir = path.join(sealRoot, 'probes-v2');
  try {
    writeAssembledFixturesV2(outDir, files as never);
    assert.deepEqual(fs.readdirSync(outDir).sort(), ['abstain.json', 'clarify.json', 'decoy.json', 'gold-l0.json', 'gold-l1.json', 'holdout.json']);
    const manifest = sealFixtures({
      sourceDir: outDir,
      sealDir,
      probeSetVersion: PROBES_V2_VERSION,
      rulesVersion: 'rules-v1',
      rngSeed: 20261124,
      sealedAtMs: 1795000000000,
      sealedBy: 'test',
      layerQuotas: SEAL_LAYER_QUOTAS_V2,
      decoyPairCount: 200,
    });
    assert.equal(manifest.files.length, 6, '封存六件套');
    assert.equal(manifest.probeSetVersion, PROBES_V2_VERSION);
    assert.deepEqual(verifySeal(sealDir).errors, []);
    fs.appendFileSync(path.join(sealDir, 'clarify.json'), ' ');
    assert.equal(verifySeal(sealDir).ok, false);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(sealRoot, { recursive: true, force: true });
  }
});

test('N3 v1 零漂移：旧 v1 夹具（五层、无 decoyKind、无 clarify）仍原样通过校验', () => {
  validateFixtureFile(
    {
      probeSetVersion: 'v1',
      layer: 'l0',
      items: [
        {
          eventId: 'e-1',
          channel: 'dsh',
          queries: ['q'],
          aliases: [],
          sensitiveTerms: [],
          discriminatorNeighborEventIds: [],
          expectedSlots: ['relevance'],
          constructionLayer: 'S4',
          sourceLocation: { source: 'summary', anchor: 'summary' },
          arbitration: { adjudicator: 'independent-author', decision: 'LAYER-S4-SURFACE-VARIANT' },
        },
      ],
    },
    'l0',
    'gold-l0.json',
  );
});
