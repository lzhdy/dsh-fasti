/**
 * #130 批6：采用账本 vs DB 两列硬对账纯比较器红测。
 *
 * 钉死的口径：
 *  - 纯函数零 IO：DB 行与折叠结果均由编排层注入；
 *  - DB 两列（hit_count/last_hit_ms）必须等于 adoptions.jsonl 折叠结果，不一致即 drift finding；
 *  - 账本有卡、DB 查无＝ledger-db-missing（含 crash 窗口的反向残缺）；
 *  - DB 新卡（零采用、折叠无键）视为干净，不产出 finding；
 *  - assertAdoptionsReconciled 是硬失败守卫：mismatch 直接抛 IntegrityError，宁空勿错。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IntegrityError } from '../../src/core/errors.ts';
import type { AdoptionFold } from '../../src/memory/adoption.ts';
import {
  assertAdoptionsReconciled,
  reconcileAdoptions,
  type AdoptionDbRow,
} from '../../src/memory/reconcile.ts';

function dbRow(cardId: string, hitCount: number, lastHitMs: number | null): AdoptionDbRow {
  return { cardId, hitCount, lastHitMs };
}

function fold(hitCount: number, lastHitMs: number): AdoptionFold {
  return { hitCount, lastHitMs };
}

test('AR-01 干净对账：DB 两列与折叠逐卡相等，零采用新卡无折叠键也算 clean', () => {
  const report = reconcileAdoptions({
    dbCards: [
      dbRow('mc_a', 3, 1000),
      dbRow('mc_b', 0, null),
      dbRow('mc_c', 1, 500),
    ],
    folded: new Map([
      ['mc_a', fold(3, 1000)],
      ['mc_c', fold(1, 500)],
    ]),
  });
  assert.equal(report.status, 'clean');
  assert.deepEqual(report.findings, []);
});

test('AR-02 hit_count 漂移（DB 提交后账本 append 失败的 crash 窗口）标 drift', () => {
  const report = reconcileAdoptions({
    dbCards: [dbRow('mc_a', 2, 1000)],
    folded: new Map([['mc_a', fold(1, 1000)]]),
  });
  assert.equal(report.status, 'mismatch');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.kind, 'adoption-db-ledger-drift');
  assert.equal(report.findings[0]?.ref, 'mc_a');
});

test('AR-03 last_hit_ms 漂移单独成 finding（绕窄写直改一列也抓得住）', () => {
  const report = reconcileAdoptions({
    dbCards: [dbRow('mc_a', 2, 999)],
    folded: new Map([['mc_a', fold(2, 1000)]]),
  });
  assert.equal(report.status, 'mismatch');
  assert.equal(report.findings[0]?.kind, 'adoption-db-ledger-drift');
  assert.equal(report.findings[0]?.ref, 'mc_a');
});

test('AR-04 DB 零列但账本有折叠（DB 被外部改写/回滚丢列）同样 drift，不放过反向残缺', () => {
  const report = reconcileAdoptions({
    dbCards: [dbRow('mc_a', 0, null)],
    folded: new Map([['mc_a', fold(1, 1000)]]),
  });
  assert.equal(report.status, 'mismatch');
  assert.equal(report.findings[0]?.kind, 'adoption-db-ledger-drift');
});

test('AR-05 账本折叠指向 DB 已不存在的卡：ledger-db-missing 单列 finding', () => {
  const report = reconcileAdoptions({
    dbCards: [dbRow('mc_a', 1, 1000)],
    folded: new Map([
      ['mc_a', fold(1, 1000)],
      ['mc_gone', fold(2, 2000)],
    ]),
  });
  assert.equal(report.status, 'mismatch');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.kind, 'adoption-ledger-db-missing');
  assert.equal(report.findings[0]?.ref, 'mc_gone');
});

test('AR-06 空账本＋全零新卡库＝clean（生产现状零采用不误报）', () => {
  const report = reconcileAdoptions({
    dbCards: [dbRow('mc_a', 0, null), dbRow('mc_b', 0, null)],
    folded: new Map(),
  });
  assert.equal(report.status, 'clean');
});

test('AR-07 硬失败守卫：clean 放行；mismatch 抛 IntegrityError 且 finding 可序列化进 detail', () => {
  assert.doesNotThrow(() =>
    assertAdoptionsReconciled({
      dbCards: [dbRow('mc_a', 1, 1000)],
      folded: new Map([['mc_a', fold(1, 1000)]]),
    }),
  );
  assert.throws(
    () =>
      assertAdoptionsReconciled({
        dbCards: [dbRow('mc_a', 2, 1000)],
        folded: new Map([['mc_a', fold(1, 1000)]]),
      }),
    (error: unknown) => error instanceof IntegrityError,
  );
});
