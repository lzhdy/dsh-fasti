/**
 * #115 通道二实时接线 · 落空编排红测（附录 E.5、#44 提案 G-2/G-3）。
 *
 * 红相契约：本文件只引用**现存**模块，但 createMemoryTools 的 missChannel 入参与
 * "abstain/no-match 即经窄柄 recordMiss 留一笔"的编排钩子尚未落地——下列行为断言今天
 * 必须如实报红，绿相接线后逐条转绿，断言不得放宽。
 *
 * 定稿口径（主控 2026-11-14 裁定）：
 *  - 仅 on 态、且 termNorm 非空的 abstain/no-match 触发 recordMiss，恰一次；hit 不登记；
 *  - 入参恰白名单六字段：termNorm（归一化词面，非原文）、channel（L6 注入值原样透传）、
 *    anchorEventId/anchorIds v1 恒 null（#116 启用锚点回填前的登记缺口）、
 *    returnedCount 恒 0、observedMs 取注入时钟；
 *  - shadow/off 态 miss 写 deferred（豁免条件③：生产写仅 on 产生）；
 *  - recordMiss 失败只入案底，绝不阻断 gatedSearch 主链路；
 *  - append-only 不去重：每次落空各记一行（落盘层"行数倍增"已由 miss.test.ts 锁，本文件锁编排层不压重）。
 *
 * 纪律：fs-free 假窄柄、注入时钟、临时通道名（故意不用 'dsh'，证透传而非默认值）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { UnavailableError } from '../../src/core/errors.ts';
import { createMemoryTools } from '../../src/assembly/memory-tools.ts';
import type {
  MemoryGateMode,
  ShadowFact,
  ShadowSink,
} from '../../src/assembly/memory-tools.ts';
import { normalizeLexicalText } from '../../src/memory/gate.ts';
import type {
  ExplainedRankedCard,
  MemoryCard,
  MissObservationInput,
} from '../../src/memory/types.ts';
import type {
  RuntimeAddMissAliasInput,
  RuntimeMemoryHandle,
  RuntimeSearchQuery,
} from '../../src/memory/runtime.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const fixedNow = (): number => NOW;
// 故意区别于任何内置默认值：只有原样透传才能得到这个通道名。
const INJECTED_CHANNEL = 'channel-alpha';

let seq = 0;
function mkExplained(cardId: string, matchKinds: ExplainedRankedCard['matchKinds']): ExplainedRankedCard {
  seq += 1;
  const n = seq;
  const card: MemoryCard = {
    cardId,
    eventId: `evt_${n}`,
    anchorJson: JSON.stringify([`exp_${n}`]),
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson: JSON.stringify([]),
    aliasesJson: JSON.stringify([]),
    discriminator: '',
    entityHintJson: null,
    occurredMs: NOW - 1000,
    endedMs: NOW,
    validMs: NOW - 2000,
    invalidMs: null,
    createdMs: NOW - 2000,
    expiredMs: null,
    status: 'active',
    contentHash: `hash_${n}`,
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  return { card, scoreParts: { bm25: 0, recency: 0 }, matchedTerms: [], matchKinds };
}

interface FakeOpts {
  explained?: ExplainedRankedCard[];
  missCalls: MissObservationInput[];
  missThrows?: Error;
}

function makeHandle(opts: FakeOpts): RuntimeMemoryHandle {
  return {
    async searchExplained(_query: RuntimeSearchQuery): Promise<ExplainedRankedCard[]> {
      return opts.explained ?? [];
    },
    getCardsByAnchor(): MemoryCard[] {
      return [];
    },
    addMissAlias(input: RuntimeAddMissAliasInput) {
      return {
        ok: true as const,
        changed: true,
        cardId: input.cardId,
        termNorm: input.term,
        aliasesJson: '[]',
        contentHash: 'h',
      };
    },
    recordMiss(input: MissObservationInput): void {
      if (opts.missThrows !== undefined) throw opts.missThrows;
      opts.missCalls.push(input);
    },
    recordShadowObservation() {
      return { ok: false as const, reason: 'orchestration-red-uses-injected-sink' };
    },
    async close(): Promise<void> {},
  };
}

function makeSink(): { records: ShadowFact[]; sink: ShadowSink } {
  const records: ShadowFact[] = [];
  return { records, sink: { record: (fact) => records.push(fact) } };
}

function build(mode: MemoryGateMode, handle: RuntimeMemoryHandle | null) {
  const sinkBox = makeSink();
  const tools = createMemoryTools({
    mode,
    now: fixedNow,
    handle,
    sink: sinkBox.sink,
    missChannel: INJECTED_CHANNEL,
  });
  return { tools, sinkBox };
}

// ── R1 on 态 no-match：恰一笔落空台账，六字段白名单锁死 ──────────────────────

test('R1 on/no-match：recordMiss 恰一次，入参恰白名单六字段且锚点 v1 恒 null', async () => {
  const opts: FakeOpts = { explained: [], missCalls: [] };
  const { tools } = build('on', makeHandle(opts));

  const view = await tools.gatedSearch({ text: '猫' });

  assert.equal(view.status, 'no-match');
  assert.equal(opts.missCalls.length, 1, '零词法命中必须留一笔落空台账');
  const row = opts.missCalls[0]!;
  assert.deepEqual(Object.keys(row).sort(), [
    'anchorEventId',
    'anchorIds',
    'channel',
    'observedMs',
    'returnedCount',
    'termNorm',
  ]);
  assert.equal(row.termNorm, normalizeLexicalText('猫'), '记归一化词面而非原始查询文本');
  assert.equal(row.channel, INJECTED_CHANNEL, '通道值取 L6 注入，内核不内置字面量');
  assert.equal(row.anchorEventId, null, 'v1 缺口：窗口锚点随 #116 回填，本卡恒 null');
  assert.equal(row.anchorIds, null);
  assert.equal(row.returnedCount, 0, '落空对外返回为空，returnedCount 恒 0');
  assert.equal(row.observedMs, NOW, '时刻取注入时钟');
});

// ── R2 on 态 abstain（粗召回有、门全拒）同样登记 ────────────────────────────

test('R2 on/abstain：候选被门全拒时同样留一笔（与 no-match 同走落空编排）', async () => {
  const opts: FakeOpts = {
    explained: [mkExplained('mc_weak_a', ['like-fallback']), mkExplained('mc_weak_b', ['like-fallback'])],
    missCalls: [],
  };
  const { tools } = build('on', makeHandle(opts));

  const view = await tools.gatedSearch({ text: 'cat' });

  assert.equal(view.status, 'abstain');
  assert.equal(view.cards.length, 0);
  assert.equal(opts.missCalls.length, 1);
  assert.equal(opts.missCalls[0]!.returnedCount, 0);
  assert.equal(opts.missCalls[0]!.termNorm, 'cat');
});

// ── R3 hit 不登记 ───────────────────────────────────────────────────────────

test('R3 on/hit：过门命中时不写落空台账', async () => {
  const opts: FakeOpts = {
    explained: [mkExplained('mc_strong', ['exact-alias'])],
    missCalls: [],
  };
  const { tools } = build('on', makeHandle(opts));

  const view = await tools.gatedSearch({ text: 'cat' });

  assert.equal(view.status, 'hit');
  assert.equal(opts.missCalls.length, 0, '命中不是落空，不得污染 miss 台账');
});

// ── R4 空查询不登记（空串永不落库）──────────────────────────────────────────

test('R4 on/empty-query：termNorm 归一后为空串时不登记，避免空词污染台账', async () => {
  const opts: FakeOpts = { explained: [], missCalls: [] };
  const { tools } = build('on', makeHandle(opts));

  const view = await tools.gatedSearch({ text: '   ' });

  assert.equal(view.status, 'no-match');
  assert.equal(view.reason, 'empty-query');
  assert.equal(opts.missCalls.length, 0, '空查询没有可归一的词面，不得产生 mem_miss 行');
});

// ── R5 shadow：miss 写 deferred，影子观测照常 ───────────────────────────────

test('R5 shadow：abstain/no-match 下 recordMiss 零调用（deferred），影子 sink 仍写一条', async () => {
  for (const explained of [[] as ExplainedRankedCard[], [mkExplained('w', ['like-fallback'])]] ) {
    const opts: FakeOpts = { explained, missCalls: [] };
    const { tools, sinkBox } = build('shadow', makeHandle(opts));

    const view = await tools.gatedSearch({ text: 'cat' });

    assert.equal(view.status, 'observing', 'shadow 对外恒空信封');
    assert.equal(opts.missCalls.length, 0, '豁免条件③：shadow 态 miss 生产写 deferred');
    assert.equal(sinkBox.records.length, 1, '影子旁路观测不受 miss deferred 影响');
  }
});

// ── R6 off：fail-closed 且零 miss 写 ────────────────────────────────────────

test('R6 off：内核 fail-closed 抛 UnavailableError，落空台账零写入', async () => {
  const opts: FakeOpts = { missCalls: [] };
  const { tools } = build('off', makeHandle(opts));

  await assert.rejects(() => tools.gatedSearch({ text: '猫' }), UnavailableError);
  assert.equal(opts.missCalls.length, 0);
});

// ── R7 记账失败不阻断主链路 ─────────────────────────────────────────────────

test('R7 recordMiss 抛 UnavailableError（只读降级）时 gatedSearch 仍正常返回视图', async () => {
  const opts: FakeOpts = {
    explained: [],
    missCalls: [],
    missThrows: new UnavailableError('记忆索引正被离线任务占用，运行期窄柄已降级只读'),
  };
  const { tools } = build('on', makeHandle(opts));

  const view = await tools.gatedSearch({ text: '猫' });

  assert.equal(view.status, 'no-match', '旁路台账失败只入案底，不阻断对话主链路');
  assert.equal(view.cards.length, 0);
});

// ── R8 静态：通道名零字面量、编排点不持文件/账本句柄 ────────────────────────

test('R8 静态：通道名零字面量、编排点不持文件/账本句柄，miss 内核 import 图不碰只读端口', () => {
  for (const rel of [
    'src/assembly/memory-tools.ts',
    'src/assembly/host-tool-runtime.ts',
  ]) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.ok(!/['"]dsh['"]/.test(text), `${rel} 不得硬编码通道字面量，通道只能由 L6 注入`);
    assert.ok(!/from\s+['"]node:fs['"]/.test(text), `${rel} 不得直开 node:fs`);
    assert.ok(!/from\s+['"]node:sqlite['"]/.test(text), `${rel} 不得持有 sqlite 句柄`);
    assert.ok(!/new\s+DatabaseSync/.test(text), `${rel} 不得自建账本连接`);
  }
  // 结构墙只约束 miss 编排内核：host-tool-runtime 是承载端口透传的装配面，允许引用端口类型。
  const memoryToolsSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'src/assembly/memory-tools.ts'),
    'utf8',
  );
  assert.ok(!/source-lookup/.test(memoryToolsSrc), 'memory-tools 不得 import 端口消费模块（结构墙）');
  assert.ok(memoryToolsSrc.includes('missChannel'), 'missChannel 必须是显式声明的注入依赖');
});

// ── R9 通道值原样透传（独立成例，区别于 R1 的形状断言）──────────────────────

test('R9 透传：注入任意非默认通道名，落账 channel 与注入值逐字相等', async () => {
  const opts: FakeOpts = { explained: [], missCalls: [] };
  const { tools } = build('on', makeHandle(opts));
  await tools.gatedSearch({ text: 'dog' });
  assert.equal(opts.missCalls[0]!.channel, 'channel-alpha');
  assert.notEqual(opts.missCalls[0]!.channel, 'dsh');
});

// ── R10 幂等口径：每次落空各记一行，编排层不压重 ────────────────────────────

test('R10 同 termNorm 连续两次 no-match：recordMiss 被调两次且负载逐字相同（不去重）', async () => {
  const opts: FakeOpts = { explained: [], missCalls: [] };
  const { tools } = build('on', makeHandle(opts));

  await tools.gatedSearch({ text: '猫' });
  await tools.gatedSearch({ text: '猫' });

  assert.equal(opts.missCalls.length, 2, 'append-only：两次落空各记一行，禁止编排层压重');
  assert.deepEqual(opts.missCalls[0], opts.missCalls[1], '同刻同词负载逐字一致，去重/分化都在落盘层之下');
  // 落盘层"行数倍增、id 各异、term_hash 相同"由 tests/memory/miss.test.ts 既有断言承接。
});
