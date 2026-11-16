/**
 * #123 P6（机械部分）· 评测夹具口径校验器。
 *
 * 背景：`gold-l0.json` 把 miss 别名标成 `sensitive: 0`，而生产运行期恒写 `sensitive: 1`
 * （runtime.ts）。用 sensitive=0 的夹具做 B 召回评测，等于在评一个生产里不存在的召回面。
 * 本文件提供一个可复用的校验函数，并证明它能抓住这种夹具。
 *
 * 五层语料本体（每层≥50、总≥200、诱饵≥100、holdout≥40）另立任务，不在此编造。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/memory',
);

interface FixtureAlias {
  readonly term?: unknown;
  readonly source?: unknown;
  readonly sensitive?: unknown;
}

interface FixtureCard {
  readonly aliases?: readonly FixtureAlias[];
}

interface FixtureDoc {
  /** gold-l0 等既有夹具用 `items`。 */
  readonly items?: readonly FixtureCard[];
  readonly cards?: readonly FixtureCard[];
}

/**
 * 校验一份夹具是否可用于 B（别名）召回评测：
 * 任何 `source = "miss"` 的别名必须 `sensitive === 1`，否则生产永远查不到它。
 */
export function assertMissAliasFixture(doc: FixtureDoc, name: string): void {
  const cards = doc.items ?? doc.cards ?? [];
  for (const [cardIndex, card] of cards.entries()) {
    for (const [aliasIndex, alias] of (card.aliases ?? []).entries()) {
      if (alias.source !== 'miss') {
        continue;
      }
      assert.equal(
        alias.sensitive,
        1,
        `${name} cards[${cardIndex}].aliases[${aliasIndex}] 的 miss 别名 sensitive 必须为 1（生产恒 1，0 则评测面不存在）`,
      );
    }
  }
}

test('#123 P6：校验器能抓住 gold-l0 的 sensitive=0 旧口径', () => {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, 'gold-l0.json'), 'utf8');
  const doc = JSON.parse(raw) as FixtureDoc;
  assert.throws(() => assertMissAliasFixture(doc, 'gold-l0.json'), /sensitive 必须为 1/);
});

test('#123 P6：sensitive=1 的夹具可通过校验', () => {
  const doc: FixtureDoc = {
    cards: [{ aliases: [{ term: '荷花', source: 'miss', sensitive: 1 }] }],
  };
  assertMissAliasFixture(doc, 'synthetic-rules-v2.json');
});

test('#123 P6：非 miss 来源的别名不受此约束（人工/种子别名不受影响）', () => {
  const doc: FixtureDoc = {
    cards: [{ aliases: [{ term: '种子词', source: 'seed', sensitive: 0 }] }],
  };
  assertMissAliasFixture(doc, 'synthetic-seed.json');
});
