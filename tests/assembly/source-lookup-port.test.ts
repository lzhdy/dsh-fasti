/**
 * #114 sourceLookupPort 契约红测（附录 E.4.1 四规则 + 开放项 #12 DTO 终形）。
 *
 * 本文件在 src/assembly/source-lookup.ts 落地前**整体加载失败**（模块不存在）——这是预期红：
 * 绿相阶段该文件创建后，下列类型级与运行期断言必须一次通过，且不得放宽。
 *
 * 契约四规则：
 *  1. 仅 anchor id → 经历摘要窄 DTO；Pointer → raw_text 行 DTO；
 *  2. 签名不接受自由文本检索参数；
 *  3. 返回 DTO 结构上不含卡片/候选/别名，类型不可赋值给注入候选（编译期封死）；
 *  4. 端口只在 L6 注入，静态门保证 assembly/core 不 import 门面（见 topology-removal）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Pointer } from '../../src/contract/experience.ts';
import type { GatedCardView } from '../../src/assembly/memory-tools.ts';
import {
  isExperienceSummaryView,
  projectExperienceSummary,
  createSourceLookupPort,
  applyLookupCaps,
  MAX_RAW_TURNS_PER_LOOKUP,
  MAX_RAW_LOOKUP_CHARS,
} from '../../src/assembly/source-lookup.ts';
import type {
  CountScope,
  ExperienceSummaryView,
  LookupPointer,
  RawTurnView,
  RawTurnLookupView,
  SourceLookupFacade,
  SourceLookupPort,
} from '../../src/assembly/source-lookup.ts';
import { ChannelBoundaryError, SchemaError } from '../../src/core/errors.ts';
import { makeExperience } from '../helpers.ts';

// ── 编译期断言工具 ───────────────────────────────────────────────────────────

type Assert<T extends true> = T;
type IsExact<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2 ? true : false;
type NotAssignable<Sub, Super> = Sub extends Super ? false : true;

// ── 1. DTO 形状：摘要白名单定死，无原文无卡片字段 ────────────────────────────

type SummaryKeysExact = IsExact<
  keyof ExperienceSummaryView,
  'id' | 'kind' | 'scene' | 'initiation' | 'occurredAt' | 'recordedAt' | 'tick' | 'cue'
>;
type _summaryKeys = Assert<SummaryKeysExact>;

type RawTurnKeysExact = IsExact<keyof RawTurnView, 'channel' | 'shard' | 'seq' | 'eventId' | 'rawText'>;
type _rawTurnKeys = Assert<RawTurnKeysExact>;

type CountScopeExact = IsExact<CountScope, 'gated-full' | 'legacy-limited'>;
type _countScope = Assert<CountScopeExact>;

// ── 2. 结构隔离：两个 DTO 都不可赋值给注入候选，反向也不通 ───────────────────

type _summaryNotCard = Assert<NotAssignable<ExperienceSummaryView, GatedCardView>>;
type _cardNotSummary = Assert<NotAssignable<GatedCardView, ExperienceSummaryView>>;
type _rawNotCard = Assert<NotAssignable<RawTurnView, GatedCardView>>;
type _rawListNotCardList = Assert<NotAssignable<RawTurnView[], GatedCardView[]>>;

// ── 3. 端口签名：无自由文本入参 ───────────────────────────────────────────────

type SummaryArg = Parameters<SourceLookupPort['summaryByAnchor']>[0];
type _summaryArgIsId = Assert<IsExact<SummaryArg, string>>;

type RawArg = Parameters<SourceLookupPort['resolveRawText']>[0];
type _rawArgIsPointer = Assert<IsExact<RawArg, Pointer>>;

// 变异反证（类型层）：若端口被改成返回候选数组，此行无法通过编译。
type _portDoesNotReturnCards = Assert<NotAssignable<Awaited<ReturnType<SourceLookupPort['summaryByAnchor']>>, GatedCardView[]>>;

// ── 4. 运行期：纯投影与守卫 ───────────────────────────────────────────────────

test('projectExperienceSummary：只投影白名单字段，原文指针与一切内部字段不进 DTO', () => {
  const exp = makeExperience({
    observation: {
      cue: '排查门控召回漏召',
      text: { id: 'raw_1', channel: 'dsh', shard: '2026-11', seq: [12, 14] },
    },
  });
  const view = projectExperienceSummary(exp);

  assert.deepEqual(Object.keys(view).sort(), [
    'cue',
    'id',
    'initiation',
    'kind',
    'occurredAt',
    'recordedAt',
    'scene',
    'tick',
  ]);
  assert.equal(view.id, exp.id);
  assert.equal(view.kind, exp.kind);
  assert.equal(view.initiation, exp.initiation);
  assert.equal(view.occurredAt, exp.occurred_at);
  assert.equal(view.recordedAt, exp.recorded_at);
  assert.equal(view.tick, exp.tick);
  assert.equal(view.cue, '排查门控召回漏召');
  const json = JSON.stringify(view);
  for (const leaked of ['raw_text', 'rawText', 'observation', 'text', 'sensitive', 'contentHash']) {
    assert.ok(!json.includes(leaked), `摘要 DTO 泄漏非白名单字段：${leaked}`);
  }
});

test('projectExperienceSummary：无 cue 时输出 null 而非 undefined（DTO 形状稳定）', () => {
  const exp = makeExperience({ observation: {} });
  assert.equal(projectExperienceSummary(exp).cue, null);
});

test('isExperienceSummaryView：非对象/缺 id/多余字段一律拒绝，不静默放行', () => {
  const valid = projectExperienceSummary(makeExperience());
  assert.equal(isExperienceSummaryView(valid), true);
  assert.equal(isExperienceSummaryView(null), false);
  assert.equal(isExperienceSummaryView({ id: 'x' }), false);
  assert.equal(isExperienceSummaryView({ ...valid, rawText: '走私原文' }), false);
});

test('端口假实现冒烟：两跳只接受 id 与 Pointer，返回七键回查信封', async () => {
  const summary = projectExperienceSummary(makeExperience());
  const envelope: RawTurnLookupView = {
    turns: [{ channel: 'dsh', shard: '2026-11', seq: 1, eventId: 'e1', rawText: '原文只在此跳出现' }],
    truncated: false,
    totalTurns: 1,
    totalChars: 8,
    midRow: false,
    nextSeq: null,
    nextCharOffset: null,
  };
  const port: SourceLookupPort = {
    async summaryByAnchor(anchorId: string): Promise<ExperienceSummaryView | null> {
      return anchorId === summary.id ? summary : null;
    },
    async resolveRawText(_pointer: Pointer): Promise<RawTurnLookupView> {
      return envelope;
    },
  };

  assert.equal(await port.summaryByAnchor(summary.id), summary);
  assert.equal(await port.summaryByAnchor('missing'), null);
  const view = await port.resolveRawText({ id: 'raw_1' });
  assert.equal(view.turns[0]?.rawText, '原文只在此跳出现');
});

// ── #115 红相：通道边界纵深防御 + 两道独立防爆闸 + 截断信封 ──────────────────
//
// 说明：下列符号（ChannelBoundaryError / MAX_* 常量 / RawTurnLookupView / applyLookupCaps /
// 工厂第二参 channel）绿相才落地，红相 tsc 必报缺失、运行期必失败，属预期红。

// 类型层：截断信封键集定死，且与候选形状结构隔离。
// midRow/nextSeq/nextCharOffset 是"单行自身超字符闸"的可续取出口：行内剩余部分无法用 seq 表达，
// nextSeq 锁定被截行、nextCharOffset 锁定行内起点，成对出现，否则偏移指不清归属行。
type LookupViewKeysExact = IsExact<
  keyof RawTurnLookupView,
  'turns' | 'truncated' | 'totalTurns' | 'totalChars' | 'midRow' | 'nextSeq' | 'nextCharOffset'
>;
type _lookupViewKeys = Assert<LookupViewKeysExact>;
type _lookupViewNotCards = Assert<NotAssignable<RawTurnLookupView, GatedCardView[]>>;
type _portReturnsEnvelope = Assert<
  IsExact<Awaited<ReturnType<SourceLookupPort['resolveRawText']>>, RawTurnLookupView>
>;

function makeTurn(seq: number, text: string, channel = 'dsh'): RawTurnView {
  return { channel, shard: '2026-11', seq, eventId: `e${seq}`, rawText: text };
}

function makeSpyFacade(turns: Array<{ channel: string; shard: string; seq: number; event_id: string; raw_text: string }>) {
  const calls: Pointer[] = [];
  const facade: SourceLookupFacade = {
    async readExperienceById() {
      return projectExperienceSummary(makeExperience());
    },
    async resolvePointer(pointer: Pointer) {
      calls.push(pointer);
      return { turns } as Awaited<ReturnType<SourceLookupFacade['resolvePointer']>>;
    },
  };
  return { facade, calls };
}

test('S0 防爆闸常量冻结在 L5 装配边界：20 条 / 50000 字符（数值对齐保险丝、语义独立）', () => {
  assert.equal(MAX_RAW_TURNS_PER_LOOKUP, 20);
  assert.equal(MAX_RAW_LOOKUP_CHARS, 50000);
});

test('S1 通道闸：Pointer 缺 channel 必须 fail-closed 拒绝，且不触门面', async () => {
  const spy = makeSpyFacade([]);
  const port = createSourceLookupPort(spy.facade, { channel: 'dsh' });
  await assert.rejects(
    () => port.resolveRawText({ id: 'raw_1', shard: '2026-11', seq: 1 }),
    ChannelBoundaryError,
    '缺 channel 的 Pointer 等价全库读取器，必须在端口边界拒绝',
  );
  assert.equal(spy.calls.length, 0, '拒绝发生在门面调用之前，零跨通道 IO');
});

test('S2 通道闸：Pointer 携带异 channel 同样拒绝，错误类型稳定', async () => {
  const spy = makeSpyFacade([]);
  const port = createSourceLookupPort(spy.facade, { channel: 'dsh' });
  await assert.rejects(
    () => port.resolveRawText({ channel: 'other-channel', id: 'raw_1', seq: 1 }),
    ChannelBoundaryError,
  );
  assert.equal(spy.calls.length, 0);
});

test('S3 通道闸：同 channel 放行，门面收到的 Pointer 与入参一致', async () => {
  const turn = { channel: 'dsh', shard: '2026-11', seq: 1, event_id: 'e1', raw_text: '正文' };
  const spy = makeSpyFacade([turn]);
  const port = createSourceLookupPort(spy.facade, { channel: 'dsh' });

  const view = await port.resolveRawText({ channel: 'dsh', id: 'raw_1', shard: '2026-11', seq: 1 });

  assert.equal(spy.calls.length, 1);
  assert.equal(view.truncated, false);
  assert.equal(view.midRow, false, '整行未超闸时 midRow 恒 false，形状稳定');
  assert.equal(view.nextSeq, null, '未发生行内截断，续取行号显式 null（与 nextCharOffset 成对）');
  assert.equal(view.nextCharOffset, null, '无需行内续取时显式 null');
  assert.equal(view.turns.length, 1);
  assert.equal(view.turns[0]?.rawText, '正文');
  assert.equal(view.totalTurns, 1);
  assert.equal(view.totalChars, 2);
});

test('S9 摘要通道闸：异通道摘要按未找到返 null（不抛、不暴露异通道存在性），同通道放行，门面 null 原样透传', async () => {
  const foreignFacade: SourceLookupFacade = {
    async readExperienceById() {
      return projectExperienceSummary(makeExperience({ scene: { channel: 'other-channel', ref: 'session-x' } }));
    },
    async resolvePointer() {
      return { turns: [] };
    },
  };
  const foreignPort = createSourceLookupPort(foreignFacade, { channel: 'dsh' });
  assert.equal(
    await foreignPort.summaryByAnchor('leaked-id'),
    null,
    '锚点 id 经审计/日志泄露也读不到异通道摘要，外观与"不存在"完全一致',
  );

  const sameSpy = makeSpyFacade([]);
  const samePort = createSourceLookupPort(sameSpy.facade, { channel: 'dsh' });
  const summary = await samePort.summaryByAnchor('anchor-1');
  assert.ok(summary !== null);
  assert.equal(summary.scene.channel, 'dsh', '同通道摘要正常返回');

  const missingFacade: SourceLookupFacade = {
    async readExperienceById() {
      return null;
    },
    async resolvePointer() {
      return { turns: [] };
    },
  };
  const missingPort = createSourceLookupPort(missingFacade, { channel: 'dsh' });
  assert.equal(await missingPort.summaryByAnchor('no-such-id'), null, '门面 null 语义原样透传');
});

test('S4 条数闸：21 条短行（不触字符闸）→ 截前段 20 条，truncated 且 totalTurns 报真实原长', () => {  const rows = Array.from({ length: 21 }, (_unused, i) => makeTurn(i + 1, 'x'));
  const view = applyLookupCaps(rows);

  assert.equal(view.totalTurns, 21, 'totalTurns 必须是截断前真实条数');
  assert.equal(view.totalChars, 21);
  assert.equal(view.truncated, true);
  assert.equal(view.turns.length, 20);
  assert.deepEqual(view.turns.map((t) => t.seq), Array.from({ length: 20 }, (_u, i) => i + 1), '截断取前段');
  assert.equal(view.midRow, false, '条数闸整行截断，不发行内游标');
  assert.equal(view.nextSeq, null);
  assert.equal(view.nextCharOffset, null);
});

test('S5 字符闸：5 条各 12000 字（不触条数闸）→ 整行为界截断，totalChars 报 60000 真实原长', () => {
  const rows = Array.from({ length: 5 }, (_unused, i) => makeTurn(i + 1, 'a'.repeat(12000)));
  const view = applyLookupCaps(rows);

  assert.equal(view.totalTurns, 5);
  assert.equal(view.totalChars, 60000, 'totalChars 是截断前真实字符量，禁止只报返回段长度');
  assert.equal(view.truncated, true);
  assert.equal(view.turns.length, 4, '整行为界：4×12000=48000 可纳，第五行会越 50000');
  assert.equal(view.turns.reduce((sum, t) => sum + t.rawText.length, 0), 48000);
  assert.equal(view.midRow, false, '截断点落在行边界，不是行内截断');
  assert.equal(view.nextSeq, null, '非行内截断不发行内游标，下一页从被丢弃行的 seq 区间起取');
  assert.equal(view.nextCharOffset, null);
});

test('S6 边界 off-by-one：恰好 20 条短行不截断', () => {
  const rows = Array.from({ length: 20 }, (_unused, i) => makeTurn(i + 1, 'x'));
  const view = applyLookupCaps(rows);
  assert.equal(view.truncated, false, '等于上限不是越限');
  assert.equal(view.turns.length, 20);
  assert.equal(view.totalTurns, 20);
});

test('S5b 单行自身超闸（60000 字）：返回前段并标 midRow，报行内续取起点', () => {
  // 锁死 S5"整行为界"没覆盖的退化前提：单行 12000 < 闸值才能整行截；单行自身超闸时
  // 整行为界无解——吞掉 0 行等于藏原文，放整行等于闸失效。口径取"返回前段"，比吞掉好。
  const rows = [makeTurn(1, 'c'.repeat(60000)), makeTurn(2, 'x'), makeTurn(3, 'x')];
  const view = applyLookupCaps(rows);

  assert.equal(view.totalTurns, 3);
  assert.equal(view.totalChars, 60002, 'totalChars 仍是截断前全量真实字符');
  assert.equal(view.truncated, true);
  assert.equal(view.midRow, true, '截断点落在行中间必须显式标出，不得伪装成整行截断');
  assert.equal(view.turns.length, 1, '只给被截断的这一行，绝不静默吞成 0 行');
  assert.equal(view.turns[0]?.seq, 1);
  assert.equal(view.turns[0]?.rawText.length, MAX_RAW_LOOKUP_CHARS, '返回行内前 50000 字符');
  assert.equal(view.nextSeq, 1, 'nextSeq 锁定被行内截断的那一行，与 offset 成对才指得清归属');
  assert.equal(view.nextCharOffset, MAX_RAW_LOOKUP_CHARS, '同 seq 内剩余部分的续取起点，非死胡同');
});

test('S5c 单行恰等于字符闸：不标 midRow，属未越限', () => {
  const rows = [makeTurn(1, 'd'.repeat(50000))];
  const view = applyLookupCaps(rows);
  assert.equal(view.truncated, false, '恰等于闸值不算越限');
  assert.equal(view.midRow, false);
  assert.equal(view.nextSeq, null);
  assert.equal(view.nextCharOffset, null);
  assert.equal(view.turns[0]?.rawText.length, 50000);
});

test('S5d 区间 seq 中间行自身超闸：前段整行 + 截断行前段，nextSeq/offset 指向中间行', () => {
  // 防 nextCharOffset 失去行归属的歧义场景：被截的不是首行。
  const rows = [makeTurn(12, 'x'), makeTurn(13, 'c'.repeat(60000)), makeTurn(14, 'x')];
  const view = applyLookupCaps(rows);

  assert.equal(view.totalTurns, 3);
  assert.equal(view.totalChars, 60002);
  assert.equal(view.truncated, true);
  assert.equal(view.midRow, true);
  assert.equal(view.turns.length, 2, 'row12 整行纳下，row13 行内截断，row14 随其后丢弃');
  assert.equal(view.turns[0]?.seq, 12);
  assert.equal(view.turns[0]?.rawText, 'x');
  assert.equal(view.turns[1]?.seq, 13);
  assert.equal(view.turns[1]?.rawText.length, 49999, '预算 50000 已被 row12 占 1，row13 只能取前 49999');
  assert.equal(view.nextSeq, 13, '游标必须指到中间被截行而非首行');
  assert.equal(view.nextCharOffset, 49999, '续取从 row13 的第 49999 字符开始');
});

test('S5e 正向续取：charOffset 语义为"本次解析首行内偏移"，区间续取一次闭合截断行余段+其后各行', async () => {
  // 续 S5d：nextSeq=13、nextCharOffset=49999。保留原区间上界 14，从首行 13 的行内偏移起取。
  const continued = [
    { channel: 'dsh', shard: '2026-11', seq: 13, event_id: 'e13', raw_text: 'c'.repeat(60000) },
    { channel: 'dsh', shard: '2026-11', seq: 14, event_id: 'e14', raw_text: 'x' },
  ];
  const calls: Pointer[] = [];
  const facade: SourceLookupFacade = {
    async readExperienceById() {
      return projectExperienceSummary(makeExperience());
    },
    async resolvePointer(pointer: Pointer) {
      calls.push(pointer);
      return { turns: continued } as Awaited<ReturnType<SourceLookupFacade['resolvePointer']>>;
    },
  };
  const port = createSourceLookupPort(facade, { channel: 'dsh' });
  const pointer: LookupPointer = { channel: 'dsh', id: 'raw_1', seq: [13, 14], charOffset: 49999 };

  const view = await port.resolveRawText(pointer);

  assert.equal(calls.length, 1);
  assert.equal(view.turns.length, 2, 'row13 余段 + row14 整行，一次取完尾部，不再为尾巴发第二次请求');
  assert.equal(view.turns[0]?.seq, 13);
  assert.equal(view.turns[0]?.rawText.length, 10001, '首行应用行内偏移：60000−49999');
  assert.equal(view.turns[1]?.seq, 14);
  assert.equal(view.turns[1]?.rawText, 'x');
  assert.equal(view.totalTurns, 2, 'total* 口径=偏移后、截断前的解析全集，不是实际返回集（§7.3 同步写明）');
  assert.equal(view.totalChars, 10002, '同上：首行按偏移后长度 10001 计入，勿改成返回 envelope 的字符合计');
  assert.equal(view.truncated, false, '尾部一次闭合，不再挂截断游标');
  assert.equal(view.midRow, false);
  assert.equal(view.nextSeq, null);
  assert.equal(view.nextCharOffset, null);
});

test('S5f 负向：charOffset 形状前置拦截 + 无状态越界闸，均 SchemaError', async () => {
  // 前置校验：形状非法（负数/非整数）在门面取值之前就挡掉，不产生任何数据取回。
  const shapeSpy = makeSpyFacade([
    { channel: 'dsh', shard: '2026-11', seq: 13, event_id: 'e13', raw_text: 'c'.repeat(60000) },
  ]);
  const shapePort = createSourceLookupPort(shapeSpy.facade, { channel: 'dsh' });
  await assert.rejects(
    () => shapePort.resolveRawText({ channel: 'dsh', id: 'r', seq: 13, charOffset: -1 }),
    SchemaError,
    'charOffset 必须是非负整数',
  );
  await assert.rejects(
    () => shapePort.resolveRawText({ channel: 'dsh', id: 'r', seq: 13, charOffset: 1.5 }),
    SchemaError,
    '非整数偏移无法定位字符边界',
  );
  assert.equal(shapeSpy.calls.length, 0, '形状校验先于门面调用，零取回');

  // 越界一：偏移达到/超过单值行自身长度，没有可返回的字符（需门面取回首行后才能判长度）。
  const single = [
    { channel: 'dsh', shard: '2026-11', seq: 13, event_id: 'e13', raw_text: 'c'.repeat(60000) },
  ];
  const portSingle = createSourceLookupPort(makeSpyFacade(single).facade, { channel: 'dsh' });
  await assert.rejects(
    () => portSingle.resolveRawText({ channel: 'dsh', id: 'r', seq: 13, charOffset: 60000 }),
    SchemaError,
    'charOffset 必须落在首行实际长度内，等于行长即越界',
  );

  // 越界二：区间首行 12（长度 1）却带偏移 49999 的跳行读取。
  // 无状态越界闸只负责拦截 offset 超出首行长度；它不替代游标校验——
  // 精确续取点由信封 nextSeq/nextCharOffset 提供，差一格的合法偏移（如 49998）应放行。
  const intervalRows = [
    { channel: 'dsh', shard: '2026-11', seq: 12, event_id: 'e12', raw_text: 'x' },
    { channel: 'dsh', shard: '2026-11', seq: 13, event_id: 'e13', raw_text: 'c'.repeat(60000) },
    { channel: 'dsh', shard: '2026-11', seq: 14, event_id: 'e14', raw_text: 'x' },
  ];
  const spyInterval = makeSpyFacade(intervalRows);
  const portInterval = createSourceLookupPort(spyInterval.facade, { channel: 'dsh' });
  await assert.rejects(
    () =>
      portInterval.resolveRawText({ channel: 'dsh', id: 'r', seq: [12, 14], charOffset: 49999 }),
    SchemaError,
    '无状态越界闸：首行实际长度 1，偏移 49999 越界，拦截跳行读取',
  );
  assert.equal(spyInterval.calls.length, 1, '长度越界判定需要门面先解析首行，但错误信封绝不返回正文');
});

test('S7 边界 off-by-one：总长恰好 50000 字符（10×5000）不截断', () => {
  const rows = Array.from({ length: 10 }, (_unused, i) => makeTurn(i + 1, 'b'.repeat(5000)));
  assert.equal(rows.reduce((s, r) => s + r.rawText.length, 0), 50000);
  const view = applyLookupCaps(rows);
  assert.equal(view.truncated, false, '字符数恰等于保险丝值时必须全量返回');
  assert.equal(view.turns.length, 10);
  assert.equal(view.totalChars, 50000);
});

test('S8 截断不是死胡同：信封保留 total* 原长，配合 Pointer.seq 区间可翻页（工具话术在 bridge 红测锁）', () => {
  const rows = Array.from({ length: 40 }, (_unused, i) => makeTurn(i + 1, 'x'));
  const view = applyLookupCaps(rows);
  assert.equal(view.truncated, true);
  assert.equal(view.turns.length, MAX_RAW_TURNS_PER_LOOKUP);
  assert.equal(view.totalTurns, 40, '她能据真实总数决定下一页 seq 区间，而非面对静默短结果');
  assert.equal(view.totalChars, 40);
});
