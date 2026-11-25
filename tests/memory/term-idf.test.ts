/**
 * ORD-α term-idf 整数定点 IDF 冻结快照与加权和红测（215 §3.1/§五；198 §6 实测公式）。
 *
 * 本批只交付默认不接线的纯函数库存：gate.ts/rank.ts/bm25.ts 源码不得出现本模块名，
 * 生产 CURRENT_RULES_VERSION 仍 rules-v1。Math.log 只允许封闭在离线建表函数内，查询热路径
 * 只有查表与整数加乘。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  IDF_FIXED_POINT_Q,
  TERM_IDF_SCHEMA,
  buildTermIdfTable,
  lookupTermIdf,
  termIdfFieldWeights,
  termIdfQueryWeight,
  type FrozenTermIdfTable,
} from '../../src/memory/term-idf.ts';
import { normalizeQuery } from '../../src/memory/bm25.ts';

const q = (text: string): string => normalizeQuery(text);

test('TI-1 离线建表：手算 idf=floor(1000·ln(N/(df+1)))，N=字段文档总数', () => {
  // 四个字段文档切出的 bigram 与 df：
  //  甲乙丙→[甲乙,乙丙] 甲乙丁→[甲乙,乙丁] 甲丙子→[甲丙,丙子] 乙丁子→[乙丁,丁子]
  // df：甲乙=2、乙丁=2；乙丙/甲丙/丙子/丁子=1。N=4。
  const docs = ['甲乙丙', '甲乙丁', '甲丙子', '乙丁子'];
  const table = buildTermIdfTable({ fieldDocuments: docs });
  assert.equal(table.schema, TERM_IDF_SCHEMA);
  assert.equal(table.fieldDocumentCount, 4);
  assert.equal(table.fixedPointQ, 1000);
  // floor(1000·ln(4/3))=287；floor(1000·ln(4/2))=693。
  assert.equal(lookupTermIdf(table, '甲乙'), 287);
  assert.equal(lookupTermIdf(table, '乙丁'), 287);
  assert.equal(lookupTermIdf(table, '乙丙'), 693);
  assert.equal(lookupTermIdf(table, '丁子'), 693);
  // 权重数组按 bigram 字典序排列，保证快照序列化逐字节确定。
  const grams = table.weights.map((entry) => entry.gram);
  assert.deepEqual(grams, [...grams].sort());
});

test('TI-2 高 df 极限允许负 idf（忠实裸公式，不偷夹 0），行为钉死', () => {
  // 两个文档、同一 bigram 全覆盖：df=2、N=2 → ln(2/3)<0 → floor 为负。
  const table = buildTermIdfTable({ fieldDocuments: ['甲乙', '甲乙'] });
  const idf = lookupTermIdf(table, '甲乙');
  assert.ok(idf !== null && idf < 0, `全覆盖 bigram 应为负 idf，实得 ${String(idf)}`);
  assert.equal(idf, Math.floor(1000 * Math.log(2 / 3)));
});

test('TI-3 查询热路径：单元去重整数求和，未登录单元留痕不臆造权重', () => {
  const table = buildTermIdfTable({ fieldDocuments: ['甲乙丙', '甲乙丁', '甲丙子', '乙丁子'] });
  // 查询含重复 bigram（去重后各计一次）＋一个全库未登录单元。
  const result = termIdfQueryWeight(q('甲乙 甲乙 癸亥'), table);
  const matched = result.matchedUnits.find((entry) => entry.gram === '甲乙')!;
  assert.equal(matched.idf, 287);
  assert.equal(result.sum, 287);
  assert.deepEqual(result.unknownUnits, ['癸亥']);
});

test('TI-4 字段级加权和：逐字段独立累计，totalSum 为各字段和（与证据 sum 字段独立口径同构）', () => {
  const table = buildTermIdfTable({ fieldDocuments: ['甲乙丙', '甲乙丁', '甲丙子', '乙丁子'] });
  const fields = ['甲乙丙', '乙丁子'];
  const result = termIdfFieldWeights(q('甲乙丙 乙丁子'), fields, table);
  assert.equal(result.perField.length, 2);
  // 字段「甲乙丙」共有 bigram 甲乙(df2=287)、乙丙(df1=693) → 980。
  assert.equal(result.perField[0]!.sum, 287 + 693);
  // 字段「乙丁子」共有 乙丁(287)、丁子(693) → 980。
  assert.equal(result.perField[1]!.sum, 287 + 693);
  assert.equal(result.totalSum, (287 + 693) * 2);
});

test('TI-5 未登录查表返 null（idf 可为负，不用数字哨兵制造歧义）', () => {
  const table = buildTermIdfTable({ fieldDocuments: ['甲乙丙'] });
  assert.equal(lookupTermIdf(table, '不存在的bigram'), null);
});

test('TI-6 fail-loud：空语料/非法 N/错误 schema 一律抛错，绝不静默放行', () => {
  assert.throws(() => buildTermIdfTable({ fieldDocuments: [] }));
  const valid = buildTermIdfTable({ fieldDocuments: ['甲乙丙'] });
  // 故意构造运行时损坏快照（双重断言模拟 JSON 被篡改/版本不符的外部输入）。
  const broken = { ...valid, schema: 'fasti-term-idf/v999' } as unknown as FrozenTermIdfTable;
  assert.throws(() => termIdfQueryWeight(q('甲乙丙'), broken));
  assert.throws(() => lookupTermIdf(broken, '甲乙'));
});

test('TI-7 快照确定性：同语料两次构建 JSON 逐字节相等且 sha256 相同', () => {
  const input = { fieldDocuments: ['甲乙丙', '甲乙丁', '甲丙子', '乙丁子'] };
  const a = JSON.stringify(buildTermIdfTable(input));
  const b = JSON.stringify(buildTermIdfTable(input));
  assert.equal(a, b);
  assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'));
});

test('TI-8 热路径纯整数：加权函数体内无 Math/Date/random，浮点只封在建表函数', () => {
  assert.equal(termIdfQueryWeight.toString().includes('Math.'), false);
  assert.equal(termIdfFieldWeights.toString().includes('Math.'), false);
  assert.equal(termIdfQueryWeight.toString().includes('Date'), false);
  assert.equal(termIdfFieldWeights.toString().includes('random'), false);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = fs.readFileSync(path.join(repoRoot, 'src/memory/term-idf.ts'), 'utf8');
  // 全模块仅建表期允许出现一次 Math.log。
  assert.equal(src.match(/Math\.log/g)?.length, 1);
  assert.equal(src.includes('Math.random'), false);
  assert.equal(src.includes('Date.'), false);
  assert.equal(IDF_FIXED_POINT_Q, 1000);
});

test('TI-9 生产零接线：gate.ts/rank.ts/bm25.ts 源码不得出现 term-idf 模块名', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  for (const f of ['src/memory/gate.ts', 'src/memory/rank.ts', 'src/memory/bm25.ts']) {
    const source = fs.readFileSync(path.join(repoRoot, f), 'utf8');
    assert.equal(source.includes('term-idf'), false, `${f} 不得接线 ORD-α`);
    assert.equal(source.includes('termIdf'), false, `${f} 不得接线 ORD-α`);
  }
});

test('TI-10 全等输入不造伪序且无运行时调参口：同字段两卡结果逐字节相等', () => {
  const table = buildTermIdfTable({ fieldDocuments: ['甲乙丙', '甲乙丁'] });
  const a = termIdfFieldWeights(q('甲乙丙'), ['甲乙丙'], table);
  const b = termIdfFieldWeights(q('甲乙丙'), ['甲乙丙'], table);
  assert.deepEqual(a, b);
  // 函数签名只接受冻结表，不接收权重覆盖/调参入参（排序常数只能来自冻结快照）。
  assert.equal(termIdfFieldWeights.length, 3);
});
