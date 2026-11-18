/**
 * D3 红测：外部出题成品 → 最终夹具装配 → G3/G4 守卫 → G6 封存往返（v4 §8/§9 序9）。
 * 红测先于装配脚本落地；所有根均在 tmp 现建，不依赖任何仓库外目录。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildWorldPlan, sealedEvents } from '../../src/memory/audit/corpus/world-plan.ts';
import { sealFixtures, verifySeal } from '../../src/memory/audit/sealing.ts';
import { IntegrityError } from '../../src/core/errors.ts';
import { ingestWorld, seedDerivedCards } from '../../scripts/p6/build-synthetic-world.ts';
import {
  buildSynthIdMap,
  assembleSealedFixtures,
  assertAssembledGuards,
  writeAssembledFixtures,
  SEAL_LAYER_QUOTAS,
} from '../../scripts/p6/assemble-sealed-fixtures.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function verbatimS0(event: { eventId: string; turns: ReadonlyArray<{ rawText: string }>; sensitiveTerms: readonly string[] }) {
  return {
    eventId: event.eventId,
    channel: 'dsh',
    queries: [event.turns[0]!.rawText],
    aliases: [],
    sensitiveTerms: [...event.sensitiveTerms],
    discriminatorNeighborEventIds: [],
    expectedSlots: ['relevance'] as const,
    constructionLayer: 'S0' as const,
    sourceLocation: { source: 'raw-turn' as const, anchor: 'turns[0]' },
    arbitration: { adjudicator: 'independent-author', decision: 'LAYER-S0-VERBATIM' },
  };
}

test('D3 端到端：syn id 机械翻译、空 companion、G3/G4 守卫、G6 封存往返', async () => {
  const plan = buildWorldPlan();
  const root = tempDir('p6-d3-root-');
  const outDir = tempDir('p6-d3-out-');
  const sealDir = path.join(tempDir('p6-d3-seal-'), 'probes');
  try {
    const closed = await ingestWorld(plan, root);
    await seedDerivedCards(plan, root, closed);
    const idMap = buildSynthIdMap(root);
    const sealedList = sealedEvents(plan);
    const e1 = sealedList[0]!;
    const e2 = sealedList[1]!;
    const e3 = sealedList[2]!;

    const authored = {
      gold: {
        probeSetVersion: 'v1',
        layer: 'l0' as const,
        items: [verbatimS0(e1), verbatimS0(e2), verbatimS0(e3)],
      },
      decoy: {
        probeSetVersion: 'v1',
        layer: 'decoy' as const,
        items: [
          {
            pairEventIds: [e1.eventId, e2.eventId],
            goldEventId: e1.eventId,
            discriminatorQuery: '这两件事到底分别是哪桩',
          },
        ],
      },
      abstain: {
        probeSetVersion: 'v1',
        layer: 'abstain' as const,
        items: [
          { query: '深海热泉的管虫靠什么活着？', goldEventId: null, kind: 'unanswerable' as const },
          { query: '那桩事现在进展如何', goldEventId: e3.eventId, kind: 'noise' as const },
        ],
      },
    };

    // 1. 纯装配：id 全部翻译成系统 ULID / cardId
    const files = assembleSealedFixtures(authored, idMap);
    const m1 = idMap.get(e1.eventId)!;
    const m2 = idMap.get(e2.eventId)!;
    const m3 = idMap.get(e3.eventId)!;
    assert.equal(files.goldL0.items[0]!.eventId, m1.systemEventId, 'gold eventId 须翻译成系统事件 ULID');
    assert.equal(files.decoy.items[0]!.pairCardIds[0], m1.cardId);
    assert.equal(files.decoy.items[0]!.pairCardIds[1], m2.cardId);
    assert.equal(files.decoy.items[0]!.goldCardId, m1.cardId);
    assert.equal(files.abstain.items[0]!.goldCardId, null);
    assert.equal(files.abstain.items[1]!.goldCardId, m3.cardId);
    assert.deepEqual(files.goldL1, { probeSetVersion: 'v1', layer: 'l1', items: [] });
    assert.deepEqual(files.holdout, { probeSetVersion: 'v1', layer: 'l2', items: [] });
    for (const item of files.goldL0.items) {
      assert.ok(!item.eventId.startsWith('syn-'), '不得残留合成 id');
    }

    // 2. 真实加载器形状 + G3/G4 守卫全部通过
    assertAssembledGuards(files, idMap, plan);

    // 3. 落盘后封存，G6 往返核验通过
    writeAssembledFixtures(outDir, files);
    const manifest = sealFixtures({
      sourceDir: outDir,
      sealDir,
      probeSetVersion: 'v1',
      rulesVersion: 'rules-v1',
      rngSeed: 20261111,
      sealedAtMs: 1776330000000,
      sealedBy: 'test',
      layerQuotas: SEAL_LAYER_QUOTAS,
      decoyPairCount: 1,
    });
    assert.equal(manifest.files.length, 5, '封存五件套：gold-l0/gold-l1/holdout/decoy/abstain');
    assert.deepEqual(verifySeal(sealDir).errors, []);

    // 4. 篡改任一字节 → G6 核验失败
    const tampered = path.join(sealDir, 'abstain.json');
    fs.appendFileSync(tampered, ' ');
    assert.equal(verifySeal(sealDir).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(sealDir), { recursive: true, force: true });
  }
});

test('D3 守卫：悬空 id 硬拒；S4 换述题撞 key_points 3 码点片段触发 G4②', async () => {
  const plan = buildWorldPlan();
  const root = tempDir('p6-d3-guard-');
  try {
    const closed = await ingestWorld(plan, root);
    await seedDerivedCards(plan, root, closed);
    const idMap = buildSynthIdMap(root);
    const e1 = sealedEvents(plan)[0]!;

    assert.throws(
      () =>
        assembleSealedFixtures(
          {
            gold: { probeSetVersion: 'v1', layer: 'l0', items: [verbatimS0({ ...e1, eventId: 'syn-sealed-999' })] },
            decoy: { probeSetVersion: 'v1', layer: 'decoy', items: [] },
            abstain: { probeSetVersion: 'v1', layer: 'abstain', items: [] },
          },
          idMap,
        ),
      /无法映射|找不到|不存在/,
    );

    const bad = {
      gold: {
        probeSetVersion: 'v1',
        layer: 'l0' as const,
        items: [
          verbatimS0(e1),
          {
            eventId: e1.eventId,
            channel: 'dsh',
            // 直接照抄 key_points 词面，必撞 ≥3 码点片段
            queries: [`请问${e1.keyPoints[1]}后来怎么样了`],
            aliases: [],
            sensitiveTerms: [...e1.sensitiveTerms],
            discriminatorNeighborEventIds: [],
            expectedSlots: ['relevance'] as const,
            constructionLayer: 'S4' as const,
            sourceLocation: { source: 'summary' as const, anchor: 'summary' },
            arbitration: { adjudicator: 'independent-author', decision: 'LAYER-S4-SURFACE-VARIANT' },
          },
        ],
      },
      decoy: { probeSetVersion: 'v1', layer: 'decoy' as const, items: [] },
      abstain: { probeSetVersion: 'v1', layer: 'abstain' as const, items: [] },
    };
    const files = assembleSealedFixtures(bad, idMap);
    assert.throws(() => assertAssembledGuards(files, idMap, plan), IntegrityError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('D3 纪律：src 与 scripts 内不得硬编码封存目录名（路径只能由 CLI 注入）', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && full.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes('fasti-p6-sealed')) {
        offenders.push(path.relative(repoRoot, full));
      }
    }
  };
  walk(path.join(repoRoot, 'src'));
  walk(path.join(repoRoot, 'scripts'));
  assert.deepEqual(offenders, []);
});
