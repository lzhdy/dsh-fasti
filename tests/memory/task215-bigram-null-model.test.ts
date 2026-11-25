/**
 * task215 红测：W3-2a 随机查询空模型 k_min 冻结表（纯函数，默认不接生产门）。
 *
 * 口径来源：外审丙 A1 C6（门算法v2_外部盲评回复 §自适应门槛 + 448 行冻结表）。
 * 纪律：
 *  - 概率浮点只允许出现在建表器内部，门内消费的产物是纯整数只读表，运行时零概率、零随机；
 *  - 二项尾是安全侧上界（rarecount 种数 ≤ 命中次数 X，用 P(X≥k)≤1/N 定 k 只会更难放行）；
 *  - 不接 gate/locality，生产 CURRENT_RULES_VERSION 仍 rules-v1（NM-8 静态钉死）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  RARITY_BUCKET_COUNT,
  buildKMinTable,
  buildRarityBuckets,
  collectBigramStats,
  lookupKMin,
  rareBigramHitCount,
} from '../../src/memory/bigram-null-model.ts';

/** 独立参考二项尾 P(X≥k)，X~Binomial(n,p)：与生产实现不同写法，防自证。 */
function refBinomTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const logChoose = (a: number, b: number): number => {
    let s = 0;
    for (let i = 1; i <= b; i += 1) s += Math.log((a - b + i) / i);
    return s;
  };
  let tail = 0;
  for (let j = k; j <= n; j += 1) {
    const logP = logChoose(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p);
    tail += Math.exp(logP);
  }
  return tail;
}

test('NM-1 collectBigramStats 手算 df/词频/总量（CJK bigram）', () => {
  // 「甲乙甲乙」→ 甲乙×2、乙甲×1；「甲乙丙」→ 甲乙、乙丙
  const stats = collectBigramStats(['甲乙甲乙', '甲乙丙']);
  assert.equal(stats.totalBigramTokens, 5);
  assert.deepEqual(Object.fromEntries(stats.tokenFrequency), { 甲乙: 3, 乙甲: 1, 乙丙: 1 });
  assert.deepEqual(Object.fromEntries(stats.documentFrequency), { 甲乙: 2, 乙甲: 1, 乙丙: 1 });
  assert.equal(stats.fieldBigramSets.length, 2);
  assert.deepEqual([...stats.fieldBigramSets[0]!].sort(), ['乙甲', '甲乙']);
});

test('NM-2 稀有度桶：值域 0..K-1、df 越小越稀有（桶号越大）、同 df 同桶、边界为整数', () => {
  // 构造 df 从 1 到 8 各一个 bigram 的可控统计。
  const docs: string[] = [];
  const chars = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
  chars.forEach((c, i) => {
    for (let d = 0; d <= i; d += 1) docs.push(`${c}子`); // 「甲子」df=1 … 「辛子」df=8
  });
  const stats = collectBigramStats(docs);
  const buckets = buildRarityBuckets(stats.documentFrequency);
  assert.equal(buckets.cutpoints.length, RARITY_BUCKET_COUNT - 1);
  assert.ok(buckets.cutpoints.every((c) => Number.isInteger(c)));
  const bucketOf = buckets.bucketOf;
  for (const b of bucketOf.values()) assert.ok(b >= 0 && b < RARITY_BUCKET_COUNT);
  // df=1 最稀有，桶号必须大于 df=8 最高频。
  assert.ok(bucketOf.get('甲子')! > bucketOf.get('辛子')!);
  assert.equal(bucketOf.get('甲子'), bucketOf.get('甲子')); // 同词同桶（确定性）
});

test('NM-3 rareBigramHitCount 只数共有且达稀有桶下界的 bigram 种类', () => {
  const stats = collectBigramStats(['甲子', '乙丑', '丙寅', '丁卯']); // 四个 df=1 稀有 bigram
  const buckets = buildRarityBuckets(stats.documentFrequency);
  const rarest = RARITY_BUCKET_COUNT - 1;
  // 查询「甲子乙丑」的相邻 bigram 为 甲子/子乙/乙丑，与字段集交集中达稀有桶的是 甲子、乙丑 两个。
  assert.equal(rareBigramHitCount('甲子乙丑', ['甲子', '乙丑', '丙寅'], buckets.bucketOf, rarest), 2);
  // 降低 B_min 后仍只数字段与查询的交集。
  assert.equal(rareBigramHitCount('甲子', ['甲子', '乙丑'], buckets.bucketOf, 0), 1);
});

test('NM-4 k_min 与独立二项尾参考一致且满足 Bonferroni 1/N', () => {
  // 两张字段各含独立稀有 bigram 的小库，手工可算概率。
  const fields = ['甲子', '乙丑', '丙寅'];
  const N = fields.length;
  const table = buildKMinTable({ fieldDocuments: fields, cardCount: N, bMin: 0, maxQueryBigrams: 4 });
  // 库内 3 个等频 bigram，M=3；单字段占 1 个稀有 → 单次抽中该字段 bigram 的 p=1/3。
  const p = 1 / 3;
  for (const cell of table.grid) {
    const k = cell.kMin;
    // 选中的 k 必须使尾概率 ≤ 1/N；而 k-1（若存在）尾概率 > 1/N，即 k 是最小可行整数。
    assert.ok(refBinomTail(cell.qLen, k, p) <= 1 / N + 1e-12, `格 m=${cell.m} q=${cell.qLen} k=${k} 过松`);
    if (k >= 1 && k - 1 >= 1) {
      assert.ok(refBinomTail(cell.qLen, k - 1, p) > 1 / N - 1e-12, `格 m=${cell.m} q=${cell.qLen} 非最小 k`);
    }
  }
});

test('NM-5 卡数 N 越大（1/N 越严）门槛不得降低', () => {
  const fields = ['甲子', '乙丑', '丙寅', '丁卯'];
  const small = buildKMinTable({ fieldDocuments: fields, cardCount: 4, bMin: 0, maxQueryBigrams: 6 });
  const large = buildKMinTable({ fieldDocuments: fields, cardCount: 4000, bMin: 0, maxQueryBigrams: 6 });
  for (const s of small.grid) {
    const l = large.grid.find((c) => c.m === s.m && c.qLen === s.qLen)!;
    assert.ok(l.kMin >= s.kMin, `N 变大门槛反降 m=${s.m} q=${s.qLen}`);
  }
});

test('NM-6 fail-closed：未建模/越界查表返回拒识哨兵，绝不返 0 放行', () => {
  const table = buildKMinTable({ fieldDocuments: ['甲子', '乙丑'], cardCount: 2, bMin: 0, maxQueryBigrams: 2 });
  const sentinel = lookupKMin(table, 1, 999); // qLen 超出建表范围
  assert.ok(sentinel > 1, '越界应返回 >m 的拒识哨兵');
  assert.ok(lookupKMin(table, 0, 0) >= 1);
});

test('NM-7 确定性：同输入两次冻结表 JSON 逐字节相等', () => {
  const input = { fieldDocuments: ['甲子乙丑', '乙丑丙寅', '丙寅丁卯'], cardCount: 3, bMin: 0, maxQueryBigrams: 5 };
  assert.equal(JSON.stringify(buildKMinTable(input)), JSON.stringify(buildKMinTable(input)));
});

test('NM-8 生产零漂移：gate.ts 与 locality.ts 都不得 import 空模型模块', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  for (const f of ['src/memory/gate.ts', 'src/memory/locality.ts']) {
    const src = fs.readFileSync(path.join(repoRoot, f), 'utf8');
    assert.equal(src.includes('bigram-null-model'), false, `${f} 不得接线空模型`);
  }
});
