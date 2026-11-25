/**
 * ORD-γ ordered-proximity 红测（215 §3.3/§五，外审 196 :267 SDM 收窄态）。
 *
 * 被测件 `src/memory/ordered-proximity.ts` 只产出「是否有序连续整段命中同一字段」的 0/1
 * 排序特征与逐字段整数留痕，本批默认不接线：gate.ts/rank.ts/bm25.ts 源码不得出现本模块名，
 * 生产 CURRENT_RULES_VERSION 仍 rules-v1，热路径零变化。
 *
 * 数学锚点（外审 §8A :422-426）：反向包含 ≡ (span=|f| ∧ gap=0)；而 m=n-1 且 gap=0 时
 * span=m+1=n，故「gap=0 且 bigram 满命中」与 reverseContainmentDetail 的计入字段集合严格同集。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  ORDERED_PROXIMITY_MIN_FIELD_CODEPOINTS,
  orderedProximityFeature,
} from '../../src/memory/ordered-proximity.ts';
import { normalizeQuery } from '../../src/memory/bm25.ts';
import { GATE_POLICY_V2, reverseContainmentDetail } from '../../src/memory/gate.ts';
import { localityDetail } from '../../src/memory/locality.ts';

const q = (text: string): string => normalizeQuery(text);

test('OP-1 gap=0 且 bigram 满命中 → 1：手算三元组与逐字段留痕', () => {
  const field = '更换电梯按钮'; // n=6，满命中 5 个 bigram
  const feature = orderedProximityFeature(q('请问更换电梯按钮怎么登记'), [field]);
  assert.equal(feature.value, 1);
  assert.equal(feature.fieldTraces.length, 1);
  assert.deepEqual(feature.fieldTraces[0], {
    fieldIndex: 0,
    n: 6,
    m: 5,
    gap: 0,
    orderedContiguous: 1,
  });
});

test('OP-2 散落命中与差字均为 0：中间插字产生 gap、尾字替换不满命中', () => {
  const field = '更换电梯按钮';
  // 尾字替换：localityDetail 给 m=4/gap=0（LOC-1 同口径），但 m≠n-1 → 非整段连续。
  const tail = orderedProximityFeature(q('更换电梯按甲'), [field]);
  assert.equal(tail.value, 0);
  assert.equal(tail.fieldTraces[0]!.orderedContiguous, 0);
  // 中间插字：best 退化为 m=1/span=2/gap=0，满命中条件同样不成立。
  const inserted = orderedProximityFeature(q('更换电梯的按钮'), [field]);
  assert.equal(inserted.value, 0);
  // 明显散落：两端各命中一点、中间大段缺失（gap>0）。
  const scattered = orderedProximityFeature(q('更换了楼层电梯又刷了按钮'), [field]);
  assert.equal(scattered.value, 0);
  assert.ok(scattered.fieldTraces.every((trace) => trace.orderedContiguous === 0));
});

test('OP-3 短于 3 码点的字段不参与特征：与门 minContainCodepoints 口径锁同值', () => {
  assert.equal(ORDERED_PROXIMITY_MIN_FIELD_CODEPOINTS, GATE_POLICY_V2.minContainCodepoints);
  // n=2 字段唯一 bigram 天然满命中且 gap 恒 0，但不得抬卡级 value，也不进留痕。
  const feature = orderedProximityFeature(q('甲子'), ['甲子']);
  assert.equal(feature.value, 0);
  assert.deepEqual(feature.fieldTraces, []);
});

test('OP-4 拉丁/空格/标点边界：规范化后整词连续出现仍为 1', () => {
  const latin = orderedProximityFeature(q('the bolt kit replacement'), ['bolt']);
  assert.equal(latin.value, 1);
  assert.equal(latin.fieldTraces[0]!.n, 4);
  // 查询侧标点断裂但词面仍连续：归一化后逐字符相邻。
  const punctuated = orderedProximityFeature(q('请问，bolt，如何处理'), ['bolt']);
  assert.equal(punctuated.value, 1);
});

test('OP-5 空查询/空字段/零命中一律 value=0 且不抛错', () => {
  assert.deepEqual(orderedProximityFeature(q(''), ['更换电梯按钮']), { value: 0, fieldTraces: [] });
  assert.deepEqual(orderedProximityFeature(q('更换电梯按钮'), []), { value: 0, fieldTraces: [] });
  const miss = orderedProximityFeature(q('完全无关的一句话'), ['更换电梯按钮']);
  assert.equal(miss.value, 0);
  assert.deepEqual(miss.fieldTraces, []);
});

test('OP-6 反向包含锚点：value 与 reverseContainmentDetail.max>0 逐题同真值', () => {
  const fieldSets: Array<readonly string[]> = [
    ['更换电梯按钮'],
    ['更换电梯按钮', '续费归档'],
    ['更换护栏油漆', '续费归档'],
    ['bolt'],
    ['甲子', '更换电梯按钮'],
  ];
  const queries = [
    '更换电梯按钮',
    '更换电梯按甲',
    '更换电梯的按钮',
    '更换了楼层电梯又刷了按钮',
    'the bolt kit',
    '毫不相干的问句内容',
    '请问，bolt，如何处理',
  ];
  for (const fields of fieldSets) {
    for (const queryText of queries) {
      const queryNorm = q(queryText);
      const feature = orderedProximityFeature(queryNorm, fields);
      const containment = reverseContainmentDetail(
        queryNorm,
        fields,
        GATE_POLICY_V2.minContainCodepoints,
      );
      assert.equal(
        feature.value,
        containment.max > 0 ? 1 : 0,
        `锚点分裂 q=${queryText} fields=${JSON.stringify(fields)}`,
      );
      // 逐字段同集：标 1 的字段恰好是门计入（n≥3 且被查询完整包含）的字段。
      const contiguousFields = feature.fieldTraces
        .filter((trace) => trace.orderedContiguous === 1)
        .map((trace) => trace.fieldIndex);
      const expectedIndexes = fields
        .map((field, index) => {
          const triple = localityDetail(queryNorm, field);
          return triple !== null &&
            triple.n >= GATE_POLICY_V2.minContainCodepoints &&
            triple.gap === 0 &&
            triple.m === triple.n - 1
            ? index
            : null;
        })
        .filter((index): index is number => index !== null);
      assert.deepEqual(contiguousFields, expectedIndexes);
    }
  }
});

test('OP-7 全等输入不制造伪序：同字段两卡特征逐字节相等，重复调用确定可重放', () => {
  const inputA = orderedProximityFeature(q('更换电梯按钮'), ['更换电梯按钮']);
  const inputB = orderedProximityFeature(q('更换电梯按钮'), ['更换电梯按钮']);
  assert.deepEqual(inputA, inputB);
  const once = JSON.stringify(orderedProximityFeature(q('the bolt kit'), ['bolt', 'kit']));
  const twice = JSON.stringify(orderedProximityFeature(q('the bolt kit'), ['bolt', 'kit']));
  assert.equal(once, twice);
});

test('OP-8 纯整数纪律：模块源码无浮点/时钟/随机入口', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = fs.readFileSync(path.join(repoRoot, 'src/memory/ordered-proximity.ts'), 'utf8');
  for (const banned of ['Math.', 'Date.', 'Math.random', 'parseFloat', 'Number.parseFloat']) {
    assert.equal(src.includes(banned), false, `热路径不得出现 ${banned}`);
  }
});

test('OP-9 生产零接线：gate.ts/rank.ts/bm25.ts 源码不得出现 ordered-proximity 模块名', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  for (const f of ['src/memory/gate.ts', 'src/memory/rank.ts', 'src/memory/bm25.ts']) {
    const source = fs.readFileSync(path.join(repoRoot, f), 'utf8');
    assert.equal(source.includes('ordered-proximity'), false, `${f} 不得接线 ORD-γ`);
    assert.equal(source.includes('orderedProximity'), false, `${f} 不得接线 ORD-γ`);
  }
});

test('OP-10 禁裸 hitFields：特征模块不得消费/产出裸命中字段计数', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = fs.readFileSync(path.join(repoRoot, 'src/memory/ordered-proximity.ts'), 'utf8');
  assert.equal(src.includes('hitFields'), false);
});
