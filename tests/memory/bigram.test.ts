/**
 * #124 bigram 索引几何 · 纯函数红测（charter v2 红测 1/2/5/6/7 的纯函数部分）。
 *
 * 口径锁定（task124-bigram-index-charter.md §3.1/3.4）：
 *  - CJK run 长度 ≥2：相邻两字滑窗；长度 1（孤立段）：发射单字 unigram（读法 A）；
 *    长段不逐字补 unigram；
 *  - ASCII/数字：整词，长度 ≥2 才发射；单字母不发射（纯单字查询走 LIKE 回退）；
 *  - 码点口径＝Unicode code point（[...str]）；
 *  - 归一化与 gate.normalizeLexicalText、bm25.normalizeQuery 三侧逐字同构。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { normalizeLexicalText } from '../../src/memory/gate.ts';
import {
  emitUnits,
  ftsPhraseOf,
  ftsOrExprOf,
  indexTextOf,
  normalizeBigramText,
  segmentRuns,
} from '../../src/memory/bigram.ts';

test('emitUnits: 2 字 CJK 产出单个 bigram', () => {
  assert.deepEqual(emitUnits('王工'), ['王工']);
});

test('emitUnits: 3/4 字 CJK 滑窗多片、且不逐字补 unigram', () => {
  assert.deepEqual(emitUnits('哈尔滨'), ['哈尔', '尔滨']);
  assert.deepEqual(emitUnits('通货膨胀'), ['通货', '货膨', '膨胀']);
  const units = emitUnits('哈尔滨');
  assert.ok(!units.includes('哈'));
  assert.ok(!units.includes('尔'));
  assert.ok(!units.includes('滨'));
});

test('emitUnits: 孤立单字段发射 unigram，多段句子里的单字也可达', () => {
  assert.deepEqual(emitUnits('冰'), ['冰']);
  // “蓉”为空格隔开的孤立单字段 → unigram；“的发票”是三字连续段 → 按滑窗出 bigram。
  assert.deepEqual(emitUnits('蓉 的发票'), ['蓉', '的发', '发票']);
});

test('emitUnits: 中英混排按语种切段，CJK 与拉丁互不跨界', () => {
  assert.deepEqual(emitUnits('用git提交'), ['用', 'git', '提交']);
  assert.deepEqual(emitUnits(normalizeBigramText('12 人')), ['12', '人']);
});

test('emitUnits: ASCII/数字整词保留、单字母不发射、大小写折叠', () => {
  assert.deepEqual(emitUnits('database is locked'), ['database', 'is', 'locked']);
  assert.deepEqual(emitUnits('iphone15'), ['iphone15']);
  assert.deepEqual(emitUnits('Q4'), ['q4']);
  assert.deepEqual(emitUnits('a'), []);
});

test('emitUnits: NFKC 全半角归一化后再切（Ｉｐｈｏｎｅ１５）', () => {
  assert.deepEqual(emitUnits(normalizeBigramText('Ｉｐｈｏｎｅ１５')), ['iphone15']);
});

test('emitUnits: 纯标点/空白输入产出空单元数组', () => {
  assert.deepEqual(emitUnits('，。！？'), []);
  assert.deepEqual(emitUnits('   '), []);
  assert.deepEqual(emitUnits(''), []);
});

test('emitUnits: 确定性双跑逐字节相等', () => {
  const sample = '王工 上周去重庆出差 iphone15 冰 ，会议室';
  assert.deepEqual(emitUnits(normalizeBigramText(sample)), emitUnits(normalizeBigramText(sample)));
});

test('segmentRuns: 语种段标注正确', () => {
  assert.deepEqual(segmentRuns('用git提交'), [
    { kind: 'cjk', text: '用' },
    { kind: 'latin', text: 'git' },
    { kind: 'cjk', text: '提交' },
  ]);
});

test('ftsPhraseOf: 单元序列短语包裹且转义内部双引号', () => {
  assert.equal(ftsPhraseOf(['哈尔', '尔滨']), '"哈尔 尔滨"');
  assert.equal(ftsPhraseOf(['a"b']), '"a""b"');
});

// #126 R-01 红测：OR 宽召回 MATCH 表达式（变异反证：改回 AND 相邻短语本测试必红）
test('ftsOrExprOf: 单元以 OR 连接、各自双引号包裹、空序列返空串、双引号转义', () => {
  assert.equal(ftsOrExprOf(['哈尔', '尔滨']), '"哈尔" OR "尔滨"');
  assert.equal(ftsOrExprOf(['咖啡', '啡馆', '馆约']), '"咖啡" OR "啡馆" OR "馆约"');
  assert.equal(ftsOrExprOf(['a"b']), '"a""b"');
  assert.equal(ftsOrExprOf([]), '');
});

test('indexTextOf: 索引文本为空格连接的单元序列', () => {
  assert.equal(indexTextOf(normalizeBigramText('哈尔滨冰')), '哈尔 尔滨 滨冰');
});

test('归一化三侧同构：normalizeBigramText 与 gate.normalizeLexicalText 逐字相等', () => {
  const samples = [
    'Ｉｐｈｏｎｅ１５  发票',
    'Q4 技术方案',
    'database is LOCKED',
    '成都　奶茶',
    '  留白首尾  ',
  ];
  for (const sample of samples) {
    assert.equal(normalizeBigramText(sample), normalizeLexicalText(sample));
  }
});

test('红测12 常量物理拆分：记忆侧阈值 2、经历库 trigram 常量保持 3 且 bm25 不再引用它', async () => {
  const { MIN_FTS_CODEPOINTS } = await import('../../src/memory/bm25.ts');
  const { MIN_TRIGRAM_LENGTH } = await import('../../src/projection/sqlite.ts');
  assert.equal(MIN_FTS_CODEPOINTS, 2, '记忆侧 bigram 最短 2 码点');
  assert.equal(MIN_TRIGRAM_LENGTH, 3, '经历库 experience_fts 的 trigram 阈值逐字不变');
  const bm25Source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/memory/bm25.ts'),
    'utf8',
  );
  assert.ok(
    !/from '\.\.\/projection\/sqlite\.ts'/.test(bm25Source),
    'bm25 不得再 import projection/sqlite（常量物理拆分，B9）',
  );
  assert.ok(
    !/import\s*(?:type\s*)?\{[^}]*MIN_TRIGRAM_LENGTH[^}]*\}\s*from/.test(bm25Source),
    'bm25 不得 import MIN_TRIGRAM_LENGTH（常量物理拆分，B9；注释性文字不受限）',
  );
});
