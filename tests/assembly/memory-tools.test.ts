/**
 * 第二层 WP4a · 宿主无关记忆工具集内核测试（提纲 v0.3 §7/§8/§9 类别 2/5/6；#114 拆除后口径）。
 *
 * 本文件只测 fs-free 的装配内核（src/assembly/memory-tools.ts）：四工具、off/shadow/on 三态分流、
 * shadow 门空跑确定性与失败隔离、observing 定死空信封、N14 安全 DTO（不回显 sensitive/内部别名
 * 字段/原始查询）、序号严格解析与注入时钟。窄柄/影子落点全部以端口注入，用假对象离线驱动，
 * 不触真机、不触 sqlite、不触文件系统；真机 cordis/dsh-llm 注册属 WP4b，不在本文件。
 *
 * 纪律：now 固定注入（无 Date.now/Math.random）；断言只认客观字段与原因码，无情绪措辞。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemorySerialReferenceError } from '../../src/memory/memory-errors.ts';
import type { ApplyMissAliasOutcome } from '../../src/memory/alias-write.ts';
import { isSerialRefusable } from '../../src/memory/serial.ts';
import type {
  ExplainedRankedCard,
  GatedStatus,
  MemoryCard,
  MissObservationInput,
} from '../../src/memory/types.ts';
import type {
  RuntimeAddMissAliasInput,
  RuntimeMemoryHandle,
  RuntimeSearchQuery,
} from '../../src/memory/runtime.ts';
import { createMemoryTools } from '../../src/assembly/memory-tools.ts';
import type {
  MemoryGateMode,
  ShadowFact,
  ShadowSink,
} from '../../src/assembly/memory-tools.ts';
import { UnavailableError } from '../../src/core/errors.ts';

const NOW = Date.parse('2026-11-10T08:00:00.000Z');
const fixedNow = (): number => NOW;

let seq = 0;
function mkExplained(cardId: string, matchKinds: ExplainedRankedCard['matchKinds'], cue?: string): ExplainedRankedCard {
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
    displayCuesJson: JSON.stringify(cue === undefined ? [] : [cue]),
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
  return {
    card,
    scoreParts: { bm25: 0, recency: 0 },
    matchedTerms: [],
    matchKinds,
    ...(cue === undefined ? {} : { cueText: cue }),
  };
}

interface FakeHandleOpts {
  explained?: ExplainedRankedCard[];
  anchorCards?: MemoryCard[];
  addOutcome?: ApplyMissAliasOutcome;
  addCalls: RuntimeAddMissAliasInput[];
  missCalls: MissObservationInput[];
}

function makeFakeHandle(opts: FakeHandleOpts): RuntimeMemoryHandle {
  return {
    async searchExplained(_query: RuntimeSearchQuery): Promise<ExplainedRankedCard[]> {
      return opts.explained ?? [];
    },
    getCardsByAnchor(_experienceId: string): MemoryCard[] {
      return opts.anchorCards ?? [];
    },
    addMissAlias(input: RuntimeAddMissAliasInput): ApplyMissAliasOutcome {
      opts.addCalls.push(input);
      return (
        opts.addOutcome ?? {
          ok: true,
          changed: true,
          cardId: input.cardId,
          termNorm: input.term,
          aliasesJson: '[]',
          contentHash: 'h',
        }
      );
    },
    recordMiss(input: MissObservationInput): void {
      opts.missCalls.push(input);
    },
    recordShadowObservation() {
      // 装配内核测试用独立注入的假 sink 驱动影子，假窄柄的第六方法在此不被触达，仅满足契约形状。
      return { ok: false as const, reason: 'fake-handle-uses-injected-sink' };
    },
    async close(): Promise<void> {},
  };
}

function makeSink(): { records: ShadowFact[]; sink: ShadowSink; failOnce: boolean } {
  const records: ShadowFact[] = [];
  const state = { failOnce: false, records };
  const sink: ShadowSink = {
    record(fact: ShadowFact): void {
      if (state.failOnce) {
        state.failOnce = false;
        throw new Error('影子落点暂时不可写');
      }
      state.records.push(fact);
    },
  };
  return { records, sink, get failOnce(): boolean { return state.failOnce; }, set failOnce(v: boolean) { state.failOnce = v; } };
}

function strongThenWeak(): ExplainedRankedCard[] {
  // 强通道 exact-alias 卡 + 仅 like 弱命中卡（弱卡在数组前位，验证门后取强不靠排序）。
  return [
    mkExplained('mc_weak', ['like-fallback']),
    mkExplained('mc_strong', ['exact-alias']),
  ];
}

function build(mode: MemoryGateMode, handle: RuntimeMemoryHandle | null) {
  const sinkBox = makeSink();
  const tools = createMemoryTools({
    mode,
    now: fixedNow,
    handle,
    sink: sinkBox.sink,
  });
  return { tools, sinkBox };
}

// ── 三态分流 ────────────────────────────────────────────────────────────────

test('off：内核 fail-closed 抛 UnavailableError，不触窄柄检索、不写影子观测、不返回任何候选', async () => {
  const opts: FakeHandleOpts = { addCalls: [], missCalls: [] };
  const handle = makeFakeHandle(opts);
  const { tools, sinkBox } = build('off', handle);

  await assert.rejects(
    () => tools.gatedSearch({ text: '猫', limit: 3 }),
    UnavailableError,
    'off 态生产环境靠不注册保证零变化；内核直调必须 fail-closed 而非造候选',
  );
  assert.equal(sinkBox.records.length, 0);
  assert.equal(opts.missCalls.length, 0, 'off 态不触窄柄任何写入');
});

test('shadow：对外恒定 observing 空信封，旁路跑门并写一条无原文观测，门/落点异常被隔离', async () => {
  const handle = makeFakeHandle({ explained: strongThenWeak(), addCalls: [], missCalls: [] });
  const { tools, sinkBox } = build('shadow', handle);

  const view = await tools.gatedSearch({ text: 'cat', limit: 2 });
  assert.equal(view.status, 'observing', '影子态对外只回 observing，不装配门裁决结果');
  assert.deepEqual(view.cards, [], '空信封候选恒为空');
  assert.deepEqual(view.serialMap, new Map(), '空信封序号表恒为空 Map');
  assert.ok(!('source' in view), '信封不再携带 source 双形态键');
  assert.equal(sinkBox.records.length, 1);
  const obs = sinkBox.records[0];
  assert.ok(obs);
  assert.equal(obs.gatedStatus, 'hit');
  assert.equal(obs.candidateCount, 2, '门过滤前全集：两候选（含被拒弱卡）都要计数');
  assert.equal(obs.countScope, 'gated-full', '新写样本口径恒为全集');
  assert.equal(obs.acceptedCount, 1, '旁路门裁决：仅强卡过门（limit=2 不参与候选计数）');
  assert.ok(obs.rejectedReasonCodes.includes('like-only-weak-match'));
  assert.equal(obs.termNorm, 'cat', '装配只传规范化词面，哈希下沉 memory 侧窄原语');
  assert.equal(obs.atMs, NOW);
  // 内存事实无任何原始查询文本之外的字段，且不含哈希（哈希是落盘侧职责）。
  assert.deepEqual(Object.keys(obs).sort(), [
    'acceptedCount',
    'atMs',
    'candidateCount',
    'countScope',
    'gatedStatus',
    'rejectedReasonCodes',
    'termNorm',
  ]);

  // 失败隔离：sink 抛错不得阻断主链路，对外仍是 observing 空信封。
  sinkBox.failOnce = true;
  const view2 = await tools.gatedSearch({ text: 'cat', limit: 2 });
  assert.equal(view2.status, 'observing');
  assert.deepEqual(view2.cards, []);
});

test('shadow 双跑确定性：同输入两次观测逐字节一致', async () => {
  const h1 = makeFakeHandle({ explained: strongThenWeak(), addCalls: [], missCalls: [] });
  const h2 = makeFakeHandle({ explained: strongThenWeak(), addCalls: [], missCalls: [] });
  const r1 = build('shadow', h1);
  const r2 = build('shadow', h2);
  await r1.tools.gatedSearch({ text: 'cat', limit: 2 });
  await r2.tools.gatedSearch({ text: 'cat', limit: 2 });
  assert.equal(r1.sinkBox.records.length, 1);
  assert.equal(r2.sinkBox.records.length, 1);
  assert.deepEqual(r1.sinkBox.records[0], r2.sinkBox.records[0]);
});

test('shadow：窄柄库未就绪（handle=null）时回 observing 空信封、跳过影子不报错', async () => {
  const { tools, sinkBox } = build('shadow', null);
  const view = await tools.gatedSearch({ text: '猫' });
  assert.equal(view.status, 'observing');
  assert.deepEqual(view.cards, []);
  assert.deepEqual(view.serialMap, new Map());
  assert.equal(sinkBox.records.length, 0);
});

test('on：唯一召回路径走门，弱卡被拒、唯一席位给强卡，DTO 带请求级序号', async () => {
  const handle = makeFakeHandle({ explained: strongThenWeak(), addCalls: [], missCalls: [] });
  const { tools, sinkBox } = build('on', handle);

  const view = await tools.gatedSearch({ text: 'cat', limit: 1 });

  assert.equal(view.status, 'hit');
  assert.ok(!('source' in view), '拆除后信封单形态，无 source 键');
  assert.equal(sinkBox.records.length, 0, 'on 态不写影子观测');
  assert.deepEqual(view.cards.map((c) => c.cardId), ['mc_strong']);
  const only = view.cards[0];
  assert.ok(only);
  assert.equal(only.serial, 1);
  assert.ok(only.gateReasons.includes('exact-alias-pass'));
  assert.ok(Array.isArray(only.anchorIds));
  assert.equal(view.serialMap.get(1), 'mc_strong');
});

test('N14：任何态返回 DTO 与卡写回包均不含 sensitive/内部别名/原始查询字段', async () => {
  const handle = makeFakeHandle({ explained: strongThenWeak(), addCalls: [], missCalls: [] });
  const on = build('on', handle);
  const view = await on.tools.gatedSearch({ text: 'cat', limit: 1 });
  const json = JSON.stringify(view);
  for (const leaked of ['sensitive', 'term_norm', 'termNorm', 'aliasesJson', 'contentHash', 'rawQuery']) {
    assert.ok(!json.includes(leaked), `门 DTO 泄漏内部字段：${leaked}`);
  }

  const writeView = on.tools.addMissAlias({ term: 'cat', cardId: 'mc_strong' });
  assert.ok('ok' in writeView && writeView.ok);
  assert.ok(!JSON.stringify(writeView).includes('sensitive'));
});

// ── 写方法三态：生产别名写仅 on ──────────────────────────────────────────────

test('addMissAlias：on 态经窄柄写且调用入参本身无 sensitive 键；off/shadow 延迟不写生产', async () => {
  const onOpts: FakeHandleOpts = { addCalls: [], missCalls: [] };
  const onTools = build('on', makeFakeHandle(onOpts)).tools;
  const onResult = onTools.addMissAlias({ term: 'cat', cardId: 'mc_strong' });
  assert.ok('ok' in onResult);
  if ('ok' in onResult) assert.equal(onResult.ok, true);
  assert.equal(onOpts.addCalls.length, 1);
  assert.deepEqual(Object.keys(onOpts.addCalls[0]!).sort(), ['atMs', 'cardId', 'term']);
  assert.equal(onOpts.addCalls[0]?.atMs, NOW, 'atMs 取注入时钟，不调 Date.now');

  for (const mode of ['off', 'shadow'] as MemoryGateMode[]) {
    const opts: FakeHandleOpts = { addCalls: [], missCalls: [] };
    const tools = build(mode, makeFakeHandle(opts)).tools;
    const result = tools.addMissAlias({ term: 'cat', cardId: 'mc_x' });
    assert.ok('deferred' in result && result.deferred === true, `${mode} 态应延迟写入`);
    assert.equal(opts.addCalls.length, 0, `${mode} 态不得写生产别名`);
  }
});

// ── 序号严格解析与锚点反查 ──────────────────────────────────────────────────

test('resolvePointer：合法序号经 serial 严格解析为 cardId；坏序号抛可重取错误', async () => {
  const handle = makeFakeHandle({ explained: strongThenWeak(), addCalls: [], missCalls: [] });
  const tools = build('on', handle).tools;
  const view = await tools.gatedSearch({ text: 'cat' });

  const resolved = tools.resolvePointer({ serials: [1], serialMap: view.serialMap });
  assert.deepEqual(resolved.cardIds, ['mc_strong']);

  assert.throws(
    () => tools.resolvePointer({ serials: [99], serialMap: view.serialMap }),
    MemorySerialReferenceError,
  );
  try {
    tools.resolvePointer({ serials: [99], serialMap: view.serialMap });
    assert.fail('应抛错');
  } catch (error) {
    assert.ok(isSerialRefusable(error));
  }
});

test('getCardsByAnchor：透传窄柄只读反查；handle 未就绪抛 UnavailableError', async () => {
  const anchor: MemoryCard = mkExplained('mc_a', ['exact-alias']).card;
  const ready = build('on', makeFakeHandle({ anchorCards: [anchor], addCalls: [], missCalls: [] })).tools;
  assert.equal(ready.getCardsByAnchor('exp_1')[0]?.cardId, 'mc_a');

  const none = build('off', null).tools;
  assert.throws(() => none.getCardsByAnchor('exp_1'), UnavailableError);
});

test('GatedStatus 三态观测口径：空查询在 on 态归 no-match/empty-query', async () => {
  const handle = makeFakeHandle({ explained: [], addCalls: [], missCalls: [] });
  const tools = build('on', handle).tools;
  const view = await tools.gatedSearch({ text: '   ' });
  assert.equal(view.status, 'no-match');
  assert.equal(view.reason, 'empty-query');
  assert.equal(view.cards.length, 0);
});
