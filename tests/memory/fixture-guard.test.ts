/**
 * P6 机械防自证加载守卫测试（v4 §6 / G3/G4，裁定 :205/:217/:218）。
 *
 * 红测先行：每条拒收路径都有对应反例，确保守卫不是摆设。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../../src/memory/content-hash.ts';
import { normalizeLexicalText } from '../../src/memory/gate.ts';
import { normalizeQuery } from '../../src/memory/bm25.ts';
import type { GoldL0Item } from '../../src/memory/audit/fixtures.ts';
import {
  assertAZeroAliases,
  assertMissAliasesSensitive,
  assertP6GoldItem,
  assertFixtureFingerprint,
  assertProvenanceFields,
  isCueOrAliasSubstring,
  sharesKeyPointFragment,
  S1_MAX_CHAR_SHARE,
} from '../../src/memory/audit/fixture-guard.ts';
import type { GuardCardRef } from '../../src/memory/audit/fixture-guard.ts';

function l0Item(over: Partial<GoldL0Item> = {}): GoldL0Item {
  return {
    eventId: 'evt-0',
    channel: 'dsh',
    queries: ['她提交了报销单吗'],
    aliases: [],
    sensitiveTerms: [],
    discriminatorNeighborEventIds: [],
    expectedSlots: [],
    ...over,
  };
}

const card: GuardCardRef = {
  eventId: 'evt-0',
  cues: ['她提交了报销单'],
  aliases: [{ term: '报销', source: 'miss', sensitive: 1 }],
};

test('G3-A：A 路线夹具零别名，出现任何 aliases 即硬拒', () => {
  assert.doesNotThrow(() => assertAZeroAliases([l0Item()]));
  const withAlias = l0Item({ aliases: [{ term: '报销', source: 'miss', sensitive: 1 }] });
  assert.throws(() => assertAZeroAliases([withAlias]), /A 路线夹具禁止注入任何别名/);
});

test('G3-B：miss 别名 sensitive=0 硬拒，sensitive=1 通过（E-12）', () => {
  const ok = l0Item({ aliases: [{ term: '报销', source: 'miss', sensitive: 1 }] });
  assert.doesNotThrow(() => assertMissAliasesSensitive([ok]));
  const bad = l0Item({ aliases: [{ term: '荷花', source: 'miss', sensitive: 0 }] });
  assert.throws(() => assertMissAliasesSensitive([bad]), /sensitive 必须为 1/);
});

test('G4①：查询是 cue/别名连续子串判命中；换述不命中', () => {
  assert.equal(isCueOrAliasSubstring('她提交了报销单', card), true, '整句照抄');
  assert.equal(isCueOrAliasSubstring('提交了报销单', card), true, '连续片段子串');
  assert.equal(isCueOrAliasSubstring('报销', card), true, '别名连续子串');
  assert.equal(isCueOrAliasSubstring('她记得自己填过费用申请没有', card), false, '同义换述非子串');
});

test('裁定:205 空格变体红测：「3 加 5 等于 8」(cue) 对「3加5等于8」(输入) 不构成子串、走 S4', () => {
  const spacedCard: GuardCardRef = { eventId: 'e', cues: ['3 加 5 等于 8'], aliases: [] };
  const cueNorm = normalizeLexicalText('3 加 5 等于 8');
  const inputNorm = normalizeQuery('3加5等于8');
  assert.notEqual(cueNorm, inputNorm, '规范化保留单空格，两串不相等');
  assert.equal(isCueOrAliasSubstring('3加5等于8', spacedCard), false, '去空格输入不是带空格 cue 的连续子串 → 门判 miss、进 S4');
});

test('G4②：与 key_points 有 ≥3 码点连续片段即重合；无共享则放行', () => {
  const keyPoints = ['她提交了报销单'];
  assert.equal(sharesKeyPointFragment('她记得自己提交过报销单吗', keyPoints), true, '共享「报销单」等 3 码点片段');
  assert.equal(sharesKeyPointFragment('那笔费用申请后来怎样了', keyPoints), false, '无 ≥3 码点连续共享');
});

test('G4③：P6 条目必须带源定位；S1 占比缺失/超 0.25 硬拒', () => {
  const s0 = l0Item({ constructionLayer: 'S0', sourceLocation: { source: 'raw-turn', anchor: 'exp-1#turn-2' } });
  assert.doesNotThrow(() => assertProvenanceFields(s0));
  const noSource = l0Item({ constructionLayer: 'S2' });
  assert.throws(() => assertProvenanceFields(noSource), /缺撰写源定位/);
  const s1Bad = l0Item({
    constructionLayer: 'S1',
    sourceLocation: { source: 'raw-turn', anchor: 'exp-1#turn-2' },
    sourceCharShare: S1_MAX_CHAR_SHARE + 0.01,
  });
  assert.throws(() => assertProvenanceFields(s1Bad), /超过冻结上限/);
  const s1Ok = l0Item({
    constructionLayer: 'S1',
    sourceLocation: { source: 'raw-turn', anchor: 'exp-1#turn-2' },
    sourceCharShare: 0.2,
  });
  assert.doesNotThrow(() => assertProvenanceFields(s1Ok));
});

test('assertP6GoldItem：S2 合格换述通过；抄词面/key_points 重合/悬空卡分别硬拒；无层标旧骨架跳过', () => {
  const good = l0Item({
    constructionLayer: 'S2',
    sourceLocation: { source: 'summary', anchor: 'evt-0#summary' },
    queries: ['那笔费用申请后来批了吗'],
  });
  assert.doesNotThrow(() => assertP6GoldItem(good, card, ['她提交了报销单']));

  const copy = l0Item({
    constructionLayer: 'S2',
    sourceLocation: { source: 'summary', anchor: 'evt-0#summary' },
    queries: ['提交了报销单'],
  });
  assert.throws(() => assertP6GoldItem(copy, card, ['她提交了报销单']), /G4①/);

  const overlap = l0Item({
    constructionLayer: 'S3',
    sourceLocation: { source: 'summary', anchor: 'evt-0#summary' },
    queries: ['她记得自己提交过报销单吗'],
  });
  assert.throws(() => assertP6GoldItem(overlap, card, ['她提交了报销单']), /G4②/);

  assert.throws(() => assertP6GoldItem(good, undefined, []), /金标悬空/);
  assert.doesNotThrow(() => assertP6GoldItem(l0Item(), card, ['她提交了报销单']), '无 constructionLayer 的旧骨架不做 G4 校验');
});

test('G6 指纹原语：原文被改一个字即与封存哈希不符', () => {
  const raw = JSON.stringify({ probeSetVersion: 'gold-l0/v1' });
  const declared = sha256Hex(raw);
  assert.doesNotThrow(() => assertFixtureFingerprint(raw, declared));
  assert.throws(() => assertFixtureFingerprint(`${raw} `, declared), /夹具指纹不符/);
});
