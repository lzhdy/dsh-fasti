/**
 * #123 P6（机械部分）· B 路线别名纪律（G3）。
 *
 * 背景：`gold-l0.json` 曾把 miss 别名标成 `sensitive: 0`，而生产运行期恒写 `sensitive: 1`
 * （runtime.ts）。用 sensitive=0 的夹具做 B 召回评测，等于在评一个生产里不存在的召回面。
 * 该违规已于 v4 §9 序 7 订正（gold-l0 与 harness 全部改 1）；生产侧硬校验已升格为
 * `src/memory/audit/fixture-guard.ts` 的 `assertMissAliasesSensitive`，并由审计 CLI
 * fail-closed 调用，本文件只保留红测证明回潮会被抓住。
 *
 * 五层语料本体（每层≥50、总≥200、诱饵≥100、holdout≥40）另立任务，不在此编造。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadFixtures } from '../../src/memory/audit/fixtures.ts';
import { assertMissAliasesSensitive } from '../../src/memory/audit/fixture-guard.ts';
import type { GoldL0Item } from '../../src/memory/audit/fixtures.ts';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/memory',
);

function l0Item(over: Partial<GoldL0Item> = {}): GoldL0Item {
  return {
    eventId: 'evt-0',
    channel: 'dsh',
    queries: ['合成查询'],
    aliases: [],
    sensitiveTerms: [],
    discriminatorNeighborEventIds: [],
    expectedSlots: [],
    ...over,
  };
}

test('#123 P6：gold-l0 已订正 sensitive=1，生产守卫对真实夹具放行（v4 §9 序7）', () => {
  const fixtures = loadFixtures(FIXTURE_DIR);
  assert.doesNotThrow(() => assertMissAliasesSensitive(fixtures.l0));
});

test('#123 P6：回潮的 sensitive=0 miss 别名被生产守卫硬拒（红测不撤）', () => {
  const bad = l0Item({ aliases: [{ term: '荷花', source: 'miss', sensitive: 0 }] });
  assert.throws(() => assertMissAliasesSensitive([bad]), /sensitive 必须为 1/);
});

test('#123 P6：sensitive=1 的 miss 别名通过；零别名（A 路线形态）同样通过本守卫', () => {
  const ok = l0Item({ aliases: [{ term: '荷花', source: 'miss', sensitive: 1 }] });
  assert.doesNotThrow(() => assertMissAliasesSensitive([ok, l0Item()]));
});

test('#123 P6：磁盘上的 gold-l0.json 两个别名均为 sensitive=1（防文件被悄悄改回）', () => {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, 'gold-l0.json'), 'utf8');
  const doc = JSON.parse(raw) as { items?: Array<{ aliases?: Array<{ sensitive: number }> }> };
  for (const item of doc.items ?? []) {
    for (const alias of item.aliases ?? []) {
      assert.equal(alias.sensitive, 1);
    }
  }
});
