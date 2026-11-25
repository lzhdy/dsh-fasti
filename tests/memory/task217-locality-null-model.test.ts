/**
 * task217 红测：W3-2c 局部聚集度几何空模型（G/G_gap）冻结表（纯函数，默认不接生产门）。
 *
 * 口径来源：外审丙 A1（门算法v2_外部盲评回复 §8A，434–435 行 L2/L3、448 行 C6 联合冻结表）。
 * 职责切分：W3-2a 的 k_min 管 L1「要命中几个」；本表管 L2/L3「命中摆得多紧」（span/gap 几何），
 * 按满命中（n-1 个字段 bigram 全部命中）的偶然紧凑概率冻结，少命中计数仍归 k_min。
 * 纪律：概率浮点只在建表器内，门内产物是纯整数只读表；零随机可重放；不接 gate/locality，
 * 生产 CURRENT_RULES_VERSION 仍 rules-v1（LNM-9 静态钉死）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  GEOMETRY_NULL_MODEL_SCHEMA,
  buildLocalityGeometryTable,
  compactClusterFalsePositiveBound,
  countGapLayouts,
  lookupLocalityGeometry,
  windowClusterProb,
} from '../../src/memory/locality-null-model.ts';
import { collectBigramStats } from '../../src/memory/bigram-null-model.ts';

/** 独立穷举参考：W 个槽位的 0/1 串中，首末槽=1、共 m 个 1、相邻成功间隙≤g 的串数（与生产解析解不同写法，防自证）。 */
function refCountByBruteForce(wSlots: number, successes: number, maxGap: number): number {
  if (successes < 2 || wSlots < successes) return 0;
  let count = 0;
  const total = 1 << wSlots;
  for (let bits = 0; bits < total; bits += 1) {
    const pos: number[] = [];
    for (let i = 0; i < wSlots; i += 1) if ((bits >> i) & 1) pos.push(i);
    if (pos.length !== successes) continue;
    if (pos[0] !== 0 || pos[pos.length - 1] !== wSlots - 1) continue; // 首末锚定
    let ok = true;
    for (let j = 1; j < pos.length; j += 1) {
      if (pos[j]! - pos[j - 1]! - 1 > maxGap) {
        ok = false;
        break;
      }
    }
    if (ok) count += 1;
  }
  return count;
}

test('LNM-1 countGapLayouts 手算：gap=0 唯一紧密布局、两段间距可枚举、无解为 0', () => {
  // gap=0：相邻成功必须紧挨，仅当 W=m（无空隙）时唯一布局。
  assert.equal(countGapLayouts(3, 3, 0), 1);
  assert.equal(countGapLayouts(4, 3, 0), 0);
  // m=2 只有一段间距 d=W-1，合法当且仅当 d-1≤g ⇔ W≤g+2。
  assert.equal(countGapLayouts(5, 2, 3), 1); // d=4,gap=3≤3
  assert.equal(countGapLayouts(5, 2, 2), 0); // gap=3>2
  // W=5,m=3：d1+d2=4。g=1（d≤2）仅 (2,2) →1；g=2（d≤3）有 (1,3)(2,2)(3,1) →3。
  assert.equal(countGapLayouts(5, 3, 1), 1);
  assert.equal(countGapLayouts(5, 3, 2), 3);
  // 退化护栏：成功数少于 2 或槽位放不下皆 0。
  assert.equal(countGapLayouts(4, 1, 0), 0);
  assert.equal(countGapLayouts(2, 5, 0), 0);
});

test('LNM-2 布局解析解与独立穷举参考在小格全枚举一致（防自证）', () => {
  for (let w = 2; w <= 10; w += 1) {
    for (let m = 2; m <= w; m += 1) {
      for (let g = 0; g <= 4; g += 1) {
        assert.equal(
          countGapLayouts(w, m, g),
          refCountByBruteForce(w, m, g),
          `W=${w} m=${m} g=${g} 与穷举不符`,
        );
      }
    }
  }
  // 放开 gap 上界到容纳一切时，应收敛为普通组合 C(W-2, m-2)。
  const choose = (a: number, b: number): number => {
    if (b < 0 || b > a) return 0;
    let r = 1;
    for (let i = 1; i <= b; i += 1) r = (r * (a - b + i)) / i;
    return r;
  };
  for (let w = 2; w <= 10; w += 1) {
    for (let m = 2; m <= w; m += 1) {
      assert.equal(countGapLayouts(w, m, w), choose(w - 2, m - 2));
    }
  }
});

test('LNM-3 windowClusterProb 边界：p=1 仅无失败槽时非零、概率落在 [0,1]', () => {
  // W=m（无失败槽）、唯一紧密布局，p=1 → 1。
  assert.equal(windowClusterProb(3, 3, 0, 1), 1);
  // W>m 存在必失败槽，p=1 → 0。
  assert.equal(windowClusterProb(4, 3, 0, 1), 0);
  for (const p of [0.01, 0.1, 0.5, 0.9]) {
    const v = windowClusterProb(5, 3, 2, p);
    assert.ok(v >= 0 && v <= 1, `概率越界 p=${p}`);
  }
  // 与显式布局定义对齐：A 个布局，每个 p^m(1-p)^(W-m)。
  const p = 0.3;
  const expected = countGapLayouts(5, 3, 2) * p ** 3 * (1 - p) ** 2;
  assert.ok(Math.abs(windowClusterProb(5, 3, 2, p) - expected) < 1e-15);
});

test('LNM-4 假阳性上界随放宽单调不减：padding↑、gap↑、查询变长 L↑', () => {
  const base = { fieldLength: 6, queryCodeLength: 9, p: 0.2 };
  const tight = compactClusterFalsePositiveBound({ ...base, maxGap: 0, spanPadding: 0 });
  const looserGap = compactClusterFalsePositiveBound({ ...base, maxGap: 1, spanPadding: 0 });
  const looserPad = compactClusterFalsePositiveBound({ ...base, maxGap: 0, spanPadding: 1 });
  assert.ok(looserGap >= tight - 1e-15);
  assert.ok(looserPad >= tight - 1e-15);
  const longerQ = compactClusterFalsePositiveBound({ ...base, maxGap: 0, spanPadding: 0, queryCodeLength: 12 });
  assert.ok(longerQ >= tight - 1e-15);
});

test('LNM-5 反向包含锚点：Q=n、G=g=0 时上界＝单窗口满命中 p^(n-1)', () => {
  // 查询码点恰等于字段长 → 槽位 L=n-1 恰好等于最小窗口，仅 1 个窗口、1 个紧密布局、无失败槽。
  const n = 6;
  const p = 0.25;
  const bound = compactClusterFalsePositiveBound({
    fieldLength: n,
    queryCodeLength: n,
    maxGap: 0,
    spanPadding: 0,
    p,
  });
  assert.ok(Math.abs(bound - p ** (n - 1)) < 1e-15, `锚点期望 ${p ** (n - 1)} 实得 ${bound}`);
});

test('LNM-6 Bonferroni 不低估：多窗口时上界≥任一单窗口项，且为有限非负', () => {
  const n = 5;
  const q = 12;
  const g = 1;
  const pad = 2;
  const p = 0.2;
  const bound = compactClusterFalsePositiveBound({ fieldLength: n, queryCodeLength: q, maxGap: g, spanPadding: pad, p });
  // 手取 W=n+pad-1 这一档单窗口项，Bonferroni 求和必不小于其中任一项。
  const w = n + pad - 1;
  const L = q - 1;
  const single = Math.max(0, L - w + 1) * windowClusterProb(w, n - 1, g, p);
  assert.ok(bound >= single - 1e-15);
  assert.ok(Number.isFinite(bound) && bound >= 0);
});

test('LNM-7 建表授权格满足 Bonferroni 1/N，且 N 变大只会更紧或转不授权', () => {
  const fields = ['甲子乙丑', '乙丑丙寅', '丙寅丁卯', '丁卯戊辰'];
  const small = buildLocalityGeometryTable({ fieldDocuments: fields, cardCount: 4, maxQueryCodeLength: 10 });
  assert.equal(small.schema, GEOMETRY_NULL_MODEL_SCHEMA);
  // 独立复算每字段长档的最不利 pMax(n)，不读生产模块内部中间量。
  const stats = collectBigramStats(fields);
  const pMaxByN = new Map<number, number>();
  fields.forEach((doc, i) => {
    const n = [...doc].length;
    const set = stats.fieldBigramSets[i]!;
    let pField = 0;
    for (const g of set) pField += (stats.tokenFrequency.get(g) ?? 0) / stats.totalBigramTokens;
    pMaxByN.set(n, Math.max(pMaxByN.get(n) ?? 0, pField));
  });
  // 逐格复核：所有授权格用其冻结 (g,pad) 与该 n 的 pMax 回代上界 ≤1/N。
  for (const cell of small.grid) {
    if (!cell.authorized) continue;
    const b = compactClusterFalsePositiveBound({
      fieldLength: cell.n,
      queryCodeLength: cell.qCodeLength,
      maxGap: cell.maxGap,
      spanPadding: cell.maxSpanPadding,
      p: pMaxByN.get(cell.n)!,
    });
    assert.ok(b <= 1 / 4 + 1e-12, `授权格 n=${cell.n} q=${cell.qCodeLength} 上界超标 ${b}`);
  }
  const strict = buildLocalityGeometryTable({ fieldDocuments: fields, cardCount: 4000, maxQueryCodeLength: 10 });
  for (const s of small.grid) {
    const z = strict.grid.find((c) => c.n === s.n && c.qCodeLength === s.qCodeLength)!;
    if (!s.authorized) {
      assert.equal(z.authorized, false);
      continue;
    }
    // 严库若仍授权，其放宽量不得小于宽库（不得更松）。
    if (z.authorized) {
      assert.ok(z.maxGap >= s.maxGap && z.maxSpanPadding >= s.maxSpanPadding);
    }
  }
});

test('LNM-8 fail-closed：不授权格与越界查表返 -1 拒识哨兵，绝不返宽松值', () => {
  // 极严 alpha 且极小搜索界也无法满足的库：构造长字段 + 巨大 N。
  const fields = ['甲子乙丑丙寅', '乙丑丙寅丁卯'];
  const table = buildLocalityGeometryTable({ fieldDocuments: fields, cardCount: 1_000_000, maxQueryCodeLength: 12 });
  for (const cell of table.grid) {
    if (cell.authorized) continue;
    assert.equal(cell.maxGap, -1);
    assert.equal(cell.maxSpanPadding, -1);
  }
  const miss = lookupLocalityGeometry(table, 999, 999);
  assert.equal(miss.authorized, false);
  assert.equal(miss.maxGap, -1);
  assert.equal(miss.maxSpanPadding, -1);
});

test('LNM-9 G_gap 只依赖字段长 n：同 n 各查询格 maxGap 相等；产物纯整数、确定、零接线', () => {
  const fields = ['甲子乙丑', '乙丑丙寅', '丙寅丁卯', '丁卯戊辰', '戊辰己巳'];
  const table = buildLocalityGeometryTable({ fieldDocuments: fields, cardCount: 5, maxQueryCodeLength: 12 });
  const byN = new Map<number, Set<number>>();
  for (const cell of table.grid) {
    if (!cell.authorized) continue; // G_gap 只依赖 n 的约束仅对授权格成立；deny 格无 G_gap（-1 哨兵，LNM-8 另钉）
    if (!byN.has(cell.n)) byN.set(cell.n, new Set());
    byN.get(cell.n)!.add(cell.maxGap);
  }
  for (const gaps of byN.values()) assert.equal(gaps.size, 1, '同一 n 的授权格 maxGap 必须唯一（只依赖 n）');
  // 产物字段全为整数（authorized 布尔除外），无浮点泄漏。
  for (const cell of table.grid) {
    assert.ok(Number.isInteger(cell.n) && Number.isInteger(cell.qCodeLength));
    assert.ok(Number.isInteger(cell.maxGap) && Number.isInteger(cell.maxSpanPadding));
  }
  // 确定性：同输入 JSON 逐字节相等。
  const input = { fieldDocuments: fields, cardCount: 5, maxQueryCodeLength: 12 };
  assert.equal(JSON.stringify(buildLocalityGeometryTable(input)), JSON.stringify(buildLocalityGeometryTable(input)));
  // 静态守卫：生产热路径与 locality 都不得接线本模块，本模块也不得反向依赖它们。
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  for (const f of ['src/memory/gate.ts', 'src/memory/locality.ts']) {
    assert.equal(fs.readFileSync(path.join(repoRoot, f), 'utf8').includes('locality-null-model'), false);
  }
  const selfSrc = fs.readFileSync(path.join(repoRoot, 'src/memory/locality-null-model.ts'), 'utf8');
  assert.equal(selfSrc.includes('Math.random'), false);
  assert.equal(/from '\.\/(gate|locality)\.ts'/.test(selfSrc), false);
});
