/**
 * #117 批 2 红测：drain 主触发的留存维护（pruneMissRows + 台账）。
 *
 * 口径：docs/task117-external-review-response.md §3.2 五件套第 1 件与 §8 红测最小集。
 * 纪律：未越界零写事务；台账先行（N-4）；台账只放聚合量；日界幂等；事务耗时上限。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeTempRoot, cleanupTempRoot } from '../helpers.ts';
import { openMemoryWrite } from '../../src/memory/store.ts';
import { DECISIONS_FILE } from '../../src/memory/ledger.ts';
import { MEMORY_INDEX_FILE } from '../../src/memory/store.ts';
import { computeKeptContentHash } from '../../src/memory/miss-retention.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 86_400_000;

function policy(overrides: Record<string, unknown> = {}) {
  return {
    asOfMs: T0,
    windowDays: 30,
    hardCapK: 5,
    policyVersion: 'test-v1',
    ...overrides,
  };
}

function indexDirOf(root: string): string {
  return path.join(root, 'projection', 'memory-index');
}

function seed(handle: ReturnType<typeof openMemoryWrite>, observedList: number[]): void {
  for (const [i, observedMs] of observedList.entries()) {
    handle.recordMiss({
      termNorm: `漏召词-${i}`,
      channel: 'dsh',
      anchorEventId: null,
      anchorIds: null,
      returnedCount: 0,
      observedMs,
      gateStatus: i % 2 === 0 ? 'no-match' : 'abstain',
    });
  }
}

function decisionsText(root: string): string {
  const file = path.join(indexDirOf(root), DECISIONS_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

test('pruneMisses：空表 → empty、零写（不建 decisions 文件）', async () => {
  const root = makeTempRoot('miss-prune-');
  try {
    const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
    try {
      const outcome = handle.pruneMisses(policy());
      assert.equal(outcome.applied, false);
      assert.equal(outcome.reason, 'empty');
      assert.equal(outcome.kept, 0);
      assert.equal(decisionsText(root), '', '未动刀不得产生台账行');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('pruneMisses：窗口内且未越顶 → within-limit、零写事务', async () => {
  const root = makeTempRoot('miss-prune-');
  try {
    const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
    try {
      seed(handle, [T0, T0 - DAY, T0 - 2 * DAY]);
      const outcome = handle.pruneMisses(policy({ hardCapK: 5 }));
      assert.equal(outcome.applied, false);
      assert.equal(outcome.reason, 'within-limit');
      assert.equal(outcome.kept, 3);
      assert.equal(decisionsText(root), '', '未越界不得开写事务');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('pruneMisses：越硬顶 → 删到 K、台账一行、keptContentHash 与库内行一致', async () => {
  const root = makeTempRoot('miss-prune-');
  try {
    const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
    try {
      seed(handle, [0, 1, 2, 3, 4, 5, 6].map((i) => T0 - i * DAY));
      const outcome = handle.pruneMisses(policy({ hardCapK: 5 }));
      assert.equal(outcome.applied, true);
      assert.equal(outcome.kept, 5);
      assert.equal(outcome.droppedOverflow, 2);
      assert.equal(outcome.droppedAgeOut, 0);
      assert.equal(outcome.windowCompressed, true);

      const text = decisionsText(root);
      const lines = text.trim().split('\n').filter((line) => line !== '');
      assert.equal(lines.length, 1, '一次维护恰一条台账');
      const record = JSON.parse(lines[0]!) as Record<string, unknown>;
      assert.equal(record['action'], 'miss-retention');
      assert.equal(record['created_by'], 'system');
      const aggregate = record['missRetention'] as Record<string, unknown>;
      assert.equal(aggregate['kept'], 5);
      assert.equal(aggregate['droppedOverflow'], 2);
      assert.equal(aggregate['windowCompressed'], true);
      assert.equal(aggregate['hardCapK'], 5);
      assert.equal(aggregate['windowDays'], 30);
      assert.equal(aggregate['policyVersion'], undefined);
      assert.equal(record['model_tag'], 'test-v1', '策略版本落在 model_tag 位');

      // 库里实际保留行 == 台账口径的 kept 集合哈希。
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(indexDirOf(root), MEMORY_INDEX_FILE), { readOnly: true });
      try {
        const rows = db
          .prepare('SELECT * FROM mem_miss ORDER BY observed_ms DESC, id DESC')
          .all() as Array<Record<string, unknown>>;
        assert.equal(rows.length, 5);
        const hash = computeKeptContentHash(
          rows.map((row) => ({ ...row, id: String(row['id']), observedMs: Number(row['observed_ms']) })),
        );
        assert.equal(hash, String(aggregate['keptContentHash']), '台账 keptContentHash 必须可由库行重算');
        const keptMs = rows.map((row) => Number(row['observed_ms']));
        assert.deepEqual(keptMs.sort((a, b) => b - a), [T0, T0 - DAY, T0 - 2 * DAY, T0 - 3 * DAY, T0 - 4 * DAY]);
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('pruneMisses：超龄行按第一顺位裁掉（窗口软闸）', async () => {
  const root = makeTempRoot('miss-prune-');
  try {
    const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
    try {
      seed(handle, [T0, T0 - 31 * DAY, T0 - 40 * DAY]);
      const outcome = handle.pruneMisses(policy({ hardCapK: 10, windowDays: 30 }));
      assert.equal(outcome.applied, true);
      assert.equal(outcome.kept, 1);
      assert.equal(outcome.droppedAgeOut, 2);
      assert.equal(outcome.droppedOverflow, 0);
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('pruneMisses：台账行不含词面/哈希明细（只有聚合量）', async () => {
  const root = makeTempRoot('miss-prune-');
  try {
    const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
    try {
      seed(handle, [0, 1, 2].map((i) => T0 - i * DAY));
      handle.pruneMisses(policy({ hardCapK: 1 }));
      const text = decisionsText(root);
      assert.ok(!text.includes('漏召词'), '台账不得出现任何词面');
      const record = JSON.parse(text.trim()) as Record<string, unknown>;
      for (const key of ['term_norm', 'termNorm', 'term_hash', 'termHash', 'anchor_ids', 'anchorIds']) {
        assert.ok(!(key in record), `台账不得携带 ${key}`);
      }
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('pruneMisses：日界幂等——同日第二轮零写（实际动刀 ≤1 次/天）', async () => {
  const root = makeTempRoot('miss-prune-');
  try {
    const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
    try {
      seed(handle, [0, 1, 2, 3].map((i) => T0 - i * DAY));
      const first = handle.pruneMisses(policy({ hardCapK: 2, asOfMs: T0 + 1000 }));
      assert.equal(first.applied, true);
      const before = decisionsText(root);
      const second = handle.pruneMisses(policy({ hardCapK: 2, asOfMs: T0 + 6 * 3600 * 1000 }));
      assert.equal(second.applied, false, '同日第二轮不得再动刀');
      assert.equal(decisionsText(root), before, '也不得再写台账');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('pruneMisses：千行量级裁剪事务耗时上限（超上限即设计回退信号）', async () => {
  const root = makeTempRoot('miss-prune-');
  try {
    const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
    try {
      const observed: number[] = [];
      for (let i = 0; i < 1200; i += 1) {
        observed.push(T0 - i * 60_000);
      }
      seed(handle, observed);
      const outcome = handle.pruneMisses(policy({ hardCapK: 1000 }));
      assert.equal(outcome.applied, true);
      assert.equal(outcome.kept, 1000);
      assert.equal(outcome.droppedOverflow, 200);
      assert.ok(outcome.durationMs < 500, `千行裁剪应毫秒级，实际 ${outcome.durationMs}ms`);
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('pruneMisses：删除事务失败时台账仍在、数据未被删（N-4 崩溃窗只容许"多记未遂"）', async () => {
  const root = makeTempRoot('miss-prune-');
  try {
    const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
    try {
      seed(handle, [0, 1, 2, 3].map((i) => T0 - i * DAY));

      // 失败注入：另一连接装一个 BEFORE DELETE 触发器，让删除事务在 DELETE 处 ABORT。
      const { DatabaseSync } = await import('node:sqlite');
      const dbFile = path.join(indexDirOf(root), MEMORY_INDEX_FILE);
      const side = new DatabaseSync(dbFile);
      try {
        side.exec(
          "CREATE TRIGGER block_miss_delete BEFORE DELETE ON mem_miss BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
        );
      } finally {
        side.close();
      }

      assert.throws(() => handle.pruneMisses(policy({ hardCapK: 2 })), /blocked/);

      // 台账已在事务前落盘（多记未遂），数据因回滚原样保留（绝无"已删无账"）。
      const lines = decisionsText(root).trim().split('\n').filter((line) => line !== '');
      assert.equal(lines.length, 1, '删除失败前台账已先行写入');
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const count = db.prepare('SELECT COUNT(*) AS n FROM mem_miss').get() as { n: number };
        assert.equal(count.n, 4, '事务回滚，行数不变');
      } finally {
        db.close();
      }

      // 撤掉触发器后下一轮可正常收敛（level-triggered 重试）。
      const cleanup = new DatabaseSync(dbFile);
      try {
        cleanup.exec('DROP TRIGGER block_miss_delete');
      } finally {
        cleanup.close();
      }
      const retried = handle.pruneMisses(policy({ hardCapK: 2 }));
      assert.equal(retried.applied, true);
      assert.equal(retried.kept, 2);
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});

test('pruneMisses：策略非法即拒绝（不写台账、不动数据）', async () => {
  const root = makeTempRoot('miss-prune-');
  try {
    const handle = openMemoryWrite({ indexDir: indexDirOf(root) });
    try {
      seed(handle, [T0, T0 - DAY]);
      assert.throws(() => handle.pruneMisses(policy({ windowDays: 0 })), /windowDays/);
      const text = decisionsText(root);
      assert.equal(text, '', '非法策略不得产生台账');
    } finally {
      await handle.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});
