/**
 * #130 批2 红测：adoptions 采用账本纯函数层。
 * 覆盖：内容键派生 id、行形状 fail-closed 校验、折叠 hitCount/lastHitMs、
 * 同内容键幂等去重、乱序无关、坏行不静默。纯函数层不碰 fs/DB/墙钟。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex } from '../../src/memory/content-hash.ts';
import {
  buildAdoptionRecord,
  foldAdoptions,
  validateAdoption,
  type AdoptionRecord,
} from '../../src/memory/adoption.ts';

const CARD_A = 'mc_11111111111111111111111111111111';
const CARD_B = 'mc_22222222222222222222222222222222';
const HASH_A = 'sha-content-a';
const HASH_B = 'sha-content-b';
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function row(partial: Partial<AdoptionRecord> & Pick<AdoptionRecord, 'card_id' | 'at_ms'>): AdoptionRecord {
  return buildAdoptionRecord({
    cardId: partial.card_id,
    atMs: partial.at_ms,
    contentHash: partial.content_hash ?? HASH_A,
  });
}

test('A1 buildAdoptionRecord：内容键 id 确定性派生，同输入同 id、异 at_ms 异 id', () => {
  const r1 = buildAdoptionRecord({ cardId: CARD_A, atMs: T0, contentHash: HASH_A });
  const r2 = buildAdoptionRecord({ cardId: CARD_A, atMs: T0, contentHash: HASH_A });
  const r3 = buildAdoptionRecord({ cardId: CARD_A, atMs: T0 + 1, contentHash: HASH_A });
  assert.deepEqual(r1, r2);
  assert.notEqual(r1.id, r3.id);
  const expectedId = sha256Hex([CARD_A, String(T0), HASH_A].join('|')).slice(0, 32);
  assert.equal(r1.id, expectedId);
  assert.match(r1.id, /^[0-9a-f]{32}$/);
});

test('A2 行形状封闭：只有 id/card_id/at_ms/content_hash 四字段，类型上无查询词/原文位', () => {
  const r = buildAdoptionRecord({ cardId: CARD_A, atMs: T0, contentHash: HASH_A });
  assert.deepEqual(Object.keys(r).sort(), ['at_ms', 'card_id', 'content_hash', 'id']);
  assert.equal(r.card_id, CARD_A);
  assert.equal(r.at_ms, T0);
  assert.equal(r.content_hash, HASH_A);
});

test('A3 build 入参 fail-closed：空 cardId/空 contentHash/非法 atMs 一律抛错不落行', () => {
  assert.throws(() => buildAdoptionRecord({ cardId: '', atMs: T0, contentHash: HASH_A }));
  assert.throws(() => buildAdoptionRecord({ cardId: CARD_A, atMs: T0, contentHash: '' }));
  assert.throws(() => buildAdoptionRecord({ cardId: CARD_A, atMs: -1, contentHash: HASH_A }));
  assert.throws(() => buildAdoptionRecord({ cardId: CARD_A, atMs: 1.5, contentHash: HASH_A }));
  assert.throws(() => buildAdoptionRecord({ cardId: CARD_A, atMs: Number.NaN, contentHash: HASH_A }));
});

test('A4 validateAdoption：合法行原样放行，形状/类型越界逐个拒', () => {
  const good = buildAdoptionRecord({ cardId: CARD_A, atMs: T0, contentHash: HASH_A });
  assert.equal(validateAdoption(good), good);
  const bad: Array<[string, unknown]> = [
    ['非对象', null],
    ['数组', []],
    ['id 缺失', { card_id: CARD_A, at_ms: T0, content_hash: HASH_A }],
    ['id 空串', { id: '', card_id: CARD_A, at_ms: T0, content_hash: HASH_A }],
    ['card_id 空', { id: 'x', card_id: '', at_ms: T0, content_hash: HASH_A }],
    ['content_hash 非串', { id: 'x', card_id: CARD_A, at_ms: T0, content_hash: 42 }],
    ['at_ms 小数', { id: 'x', card_id: CARD_A, at_ms: 1.2, content_hash: HASH_A }],
    ['at_ms 负整数', { id: 'x', card_id: CARD_A, at_ms: -3, content_hash: HASH_A }],
    ['at_ms NaN', { id: 'x', card_id: CARD_A, at_ms: Number.NaN, content_hash: HASH_A }],
    ['at_ms 字符串', { id: 'x', card_id: CARD_A, at_ms: String(T0), content_hash: HASH_A }],
  ];
  for (const [label, candidate] of bad) {
    assert.throws(() => validateAdoption(candidate), `应拒：${label}`);
  }
});

test('A5 foldAdoptions：按卡计数、lastHitMs 取最大、空账本空 Map', () => {
  const folded = foldAdoptions([
    row({ card_id: CARD_A, at_ms: T0 }),
    row({ card_id: CARD_A, at_ms: T0 + DAY, content_hash: HASH_A }),
    row({ card_id: CARD_A, at_ms: T0 + 2 * DAY, content_hash: HASH_B }),
    row({ card_id: CARD_B, at_ms: T0 + 5 * DAY }),
  ]);
  assert.deepEqual([...folded.keys()].sort(), [CARD_A, CARD_B]);
  assert.deepEqual(folded.get(CARD_A), { hitCount: 3, lastHitMs: T0 + 2 * DAY });
  assert.deepEqual(folded.get(CARD_B), { hitCount: 1, lastHitMs: T0 + 5 * DAY });
  assert.equal(foldAdoptions([]).size, 0);
});

test('A6 折叠幂等：同内容键重复行（重放/重试）只计一次，不同事件分别计', () => {
  const once = buildAdoptionRecord({ cardId: CARD_A, atMs: T0, contentHash: HASH_A });
  const again = buildAdoptionRecord({ cardId: CARD_A, atMs: T0, contentHash: HASH_A });
  const next = buildAdoptionRecord({ cardId: CARD_A, atMs: T0 + DAY, contentHash: HASH_A });
  const folded = foldAdoptions([once, again, next]);
  assert.deepEqual(folded.get(CARD_A), { hitCount: 2, lastHitMs: T0 + DAY });
});

test('A7 折叠与行序无关：打乱输入，每卡计数/lastHitMs 逐字节相等', () => {
  const rows = [
    row({ card_id: CARD_A, at_ms: T0 + 3 * DAY }),
    row({ card_id: CARD_B, at_ms: T0 }),
    row({ card_id: CARD_A, at_ms: T0 }),
    row({ card_id: CARD_B, at_ms: T0 + DAY }),
    row({ card_id: CARD_A, at_ms: T0 + DAY }),
  ];
  const shuffled = [rows[2]!, rows[4]!, rows[1]!, rows[0]!, rows[3]!];
  const a = foldAdoptions(rows);
  const b = foldAdoptions(shuffled);
  const snapshot = (m: Map<string, { hitCount: number; lastHitMs: number | null }>) =>
    JSON.stringify([...m.entries()].sort(([x], [y]) => (x < y ? -1 : 1)));
  assert.equal(snapshot(b), snapshot(a));
});

test('A8 折叠遇坏行 fail-loud 抛错，绝不静默跳过', () => {
  const good = row({ card_id: CARD_A, at_ms: T0 });
  const broken = { id: 'x', card_id: CARD_B, at_ms: 'not-a-number', content_hash: HASH_A } as unknown as AdoptionRecord;
  assert.throws(() => foldAdoptions([good, broken]));
});
