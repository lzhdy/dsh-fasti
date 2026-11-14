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
} from '../../src/assembly/source-lookup.ts';
import type {
  CountScope,
  ExperienceSummaryView,
  RawTurnView,
  SourceLookupPort,
} from '../../src/assembly/source-lookup.ts';
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

test('端口假实现冒烟：两跳只接受 id 与 Pointer，返回窄 DTO', async () => {
  const summary = projectExperienceSummary(makeExperience());
  const port: SourceLookupPort = {
    async summaryByAnchor(anchorId: string): Promise<ExperienceSummaryView | null> {
      return anchorId === summary.id ? summary : null;
    },
    async resolveRawText(_pointer: Pointer): Promise<readonly RawTurnView[]> {
      return [{ channel: 'dsh', shard: '2026-11', seq: 1, eventId: 'e1', rawText: '原文只在此跳出现' }];
    },
  };

  assert.equal(await port.summaryByAnchor(summary.id), summary);
  assert.equal(await port.summaryByAnchor('missing'), null);
  const turns = await port.resolveRawText({ id: 'raw_1' });
  assert.equal(turns[0]?.rawText, '原文只在此跳出现');
});
