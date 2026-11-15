/**
 * #42 · B0-G3 红测：JSONL 尾行容错（R-12 / §3.6 V-04、V-08）+ 启动 reconcile 自检可测边界。
 *
 * 被测：
 *  - `src/core/jsonl.ts`：严格 / 尾行容忍两模式；末行半截 → 容忍模式返回前面全部记录、
 *    不抛错、不消费该条；严格模式抛 CorruptedError；中间行坏 → 两模式都硬失败。
 *  - `src/memory/reconcile.ts`（写者落地，B0）：DB 已提交 vs 账本回放的纯比较器
 *    （不造 drain；drain 编排归 B2）。自检结果为可序列化 finding 清单，可进 audit 报告。
 *
 * 纪律：临时数据根，真实根零写入；本文件只写测试，绝不改 src/。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { CorruptedError } from '../../src/core/errors.ts';
import { appendJsonl, countJsonlLines, parseJsonl, readJsonlFile } from '../../src/core/jsonl.ts';
import type { DecisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

/**
 * 待扩展签名接缝：writer 在 parseJsonl / readJsonlFile 上追加可选 `{ tolerant?: boolean }`。
 * 今日基线签名只有两参，这里本地收窄类型，避免测试侧 tsc 先报多余实参。
 */
const parseJsonlMode = parseJsonl as unknown as <T>(
  text: string,
  source: string,
  options?: { tolerant?: boolean },
) => T[];
const readJsonlFileMode = readJsonlFile as unknown as <T>(
  filePath: string,
  options?: { tolerant?: boolean },
) => T[];

// ═══════════════════════════════════════════════════════════════════════════
// R-12 · 尾行容错（§3.6 torn-read V-08）
// ═══════════════════════════════════════════════════════════════════════════

const VALID_A = { id: 'a', anchors: ['01J0000000000000000000000A'] };
const VALID_B = { id: 'b', anchors: ['01J0000000000000000000000B'] };
/** 末行半截 JSON（写中断开的对象字面量）。 */
const TORN_TAIL = '{"id":"c","anchors":[';
/** 中间行坏 JSON。 */
const MIDDLE_BAD = '{broken json';

test('R-12 严格模式：末行半截 JSON → 抛 CorruptedError', () => {
  const text = `${JSON.stringify(VALID_A)}\n${JSON.stringify(VALID_B)}\n${TORN_TAIL}\n`;
  assert.throws(
    () => parseJsonlMode<unknown>(text, 'strict-tail.jsonl'),
    (error: unknown) => {
      assert.ok(error instanceof CorruptedError, '必须是 CorruptedError');
      assert.equal((error as CorruptedError).code, 'CORRUPTED');
      return true;
    },
  );
});

test('R-12 容忍模式：末行半截 → 返回前面全部记录，不抛错', () => {
  const text = `${JSON.stringify(VALID_A)}\n${JSON.stringify(VALID_B)}\n${TORN_TAIL}\n`;
  const rows = parseJsonlMode<typeof VALID_A>(text, 'tolerant-tail.jsonl', { tolerant: true });
  assert.deepEqual(rows, [VALID_A, VALID_B]);
});

test('R-12 容忍模式：末行半截不被消费（文件原样保留，下一轮仍可见该残行）', () => {
  const root = makeTempRoot('task42-jsonl-');
  try {
    const file = path.join(root, 'events', '2026-11.jsonl');
    appendJsonl(file, VALID_A);
    appendJsonl(file, VALID_B);
    fs.appendFileSync(file, `${TORN_TAIL}\n`, 'utf8');

    const first = readJsonlFileMode<typeof VALID_A>(file, { tolerant: true });
    assert.deepEqual(first, [VALID_A, VALID_B]);
    // 残行仍在物理文件里：行数未被推进，第二轮读到的完整记录集合不变。
    assert.equal(countJsonlLines(file), 3, '残行未被消费，物理行数保持 3');
    const second = readJsonlFileMode<typeof VALID_A>(file, { tolerant: true });
    assert.deepEqual(second, [VALID_A, VALID_B]);

    // 同一份文件严格模式仍硬失败。
    assert.throws(
      () => readJsonlFileMode<unknown>(file),
      (error: unknown) => error instanceof CorruptedError,
    );
  } finally {
    cleanupTempRoot(root);
  }
});

test('R-12 中间行坏：严格模式抛 CorruptedError（硬失败）', () => {
  const text = `${JSON.stringify(VALID_A)}\n${MIDDLE_BAD}\n${JSON.stringify(VALID_B)}\n`;
  assert.throws(
    () => parseJsonlMode<unknown>(text, 'strict-middle.jsonl'),
    (error: unknown) => error instanceof CorruptedError,
  );
});

test('R-12 中间行坏：容忍模式同样抛 CorruptedError（只有末行可容忍）', () => {
  const text = `${JSON.stringify(VALID_A)}\n${MIDDLE_BAD}\n${JSON.stringify(VALID_B)}\n`;
  assert.throws(
    () => parseJsonlMode<unknown>(text, 'tolerant-middle.jsonl', { tolerant: true }),
    (error: unknown) => {
      assert.ok(error instanceof CorruptedError);
      assert.equal((error as CorruptedError).code, 'CORRUPTED');
      return true;
    },
  );
});

test('R-12 空文本 / 全有效行：两模式行为一致', () => {
  assert.deepEqual(parseJsonlMode<unknown>('', 'empty.jsonl'), []);
  assert.deepEqual(parseJsonlMode<unknown>('', 'empty.jsonl', { tolerant: true }), []);
  const clean = `${JSON.stringify(VALID_A)}\n${JSON.stringify(VALID_B)}\n`;
  assert.deepEqual(parseJsonlMode<typeof VALID_A>(clean, 'clean.jsonl'), [VALID_A, VALID_B]);
  assert.deepEqual(parseJsonlMode<typeof VALID_A>(clean, 'clean.jsonl', { tolerant: true }), [VALID_A, VALID_B]);
});

// ═══════════════════════════════════════════════════════════════════════════
// §3.6 启动 reconcile 自检：DB 已提交 vs 账本回放 纯比较器（可测边界）
// 不造 drain：编排/补记账本/全量对账触发归 B2；这里只钉比较口径与 finding 形状。
// ═══════════════════════════════════════════════════════════════════════════

type FindingKind = 'db-committed-ledger-missing' | 'ledger-entry-db-missing';

interface ReconcileInput {
  /** DB 侧已提交的 card_id 全集（含失效卡，对账不以 active 为限）。 */
  readonly dbCardIds: readonly string[];
  /** DB meta stamped_revision；无 meta 为 null。 */
  readonly dbStampedRevision: number | null;
  /** 账本回放得到的 decision 行。 */
  readonly decisions: readonly DecisionRecord[];
  /** 账本 revisions 末行 revision；无账本为 null。 */
  readonly ledgerRevision: number | null;
}

interface ReconcileFinding {
  readonly kind: FindingKind;
  readonly ref: string;
  readonly detail: string;
}

interface ReconcileReport {
  readonly status: 'clean' | 'mismatch';
  readonly findings: readonly ReconcileFinding[];
}

interface ReconcileModule {
  reconcileProjection: (input: ReconcileInput) => ReconcileReport;
}

const RECONCILE_URL = new URL('../../src/memory/reconcile.ts', import.meta.url);

async function loadReconcile(): Promise<ReconcileModule> {
  const mod = (await import(RECONCILE_URL.href)) as Partial<ReconcileModule>;
  assert.equal(
    typeof mod.reconcileProjection,
    'function',
    'reconcile.ts 须导出 reconcileProjection（§3.6 自检纯比较器）',
  );
  return mod as ReconcileModule;
}

function decision(cardId: string, decisionId: string): DecisionRecord {
  return {
    decision_id: decisionId,
    at_ms: 1_772_000_000_000,
    action: 'create-card',
    card_id: cardId,
    event_id: 'evt-1',
    anchor_json: '[]',
    content_hash: 'hash',
    model_tag: 'rules-v1',
    reason: 'fixture',
    created_by: 'her',
  };
}

test('§3.6 自检：DB 与账本对齐 → status clean，零 finding', async () => {
  const reconcile = await loadReconcile();
  const report = reconcile.reconcileProjection({
    dbCardIds: ['card-1'],
    dbStampedRevision: 1,
    decisions: [decision('card-1', '01J0000000000000000000001D')],
    ledgerRevision: 1,
  });
  assert.equal(report.status, 'clean');
  assert.deepEqual(report.findings, []);
});

test('§3.6 自检：SQLite 已提交但账本未追加 → db-committed-ledger-missing', async () => {
  const reconcile = await loadReconcile();
  const report = reconcile.reconcileProjection({
    dbCardIds: ['card-1'],
    dbStampedRevision: 1,
    decisions: [],
    ledgerRevision: null,
  });
  assert.equal(report.status, 'mismatch');
  assert.equal(report.findings.length, 1);
  const [finding] = report.findings;
  assert.equal(finding?.kind, 'db-committed-ledger-missing');
  assert.equal(finding?.ref, 'card-1');
  // finding 可序列化进 audit 报告（纯数据，无函数/循环引用）。
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('§3.6 自检：有账无库 → ledger-entry-db-missing', async () => {
  const reconcile = await loadReconcile();
  const report = reconcile.reconcileProjection({
    dbCardIds: [],
    dbStampedRevision: null,
    decisions: [decision('card-2', '01J0000000000000000000002D')],
    ledgerRevision: 1,
  });
  assert.equal(report.status, 'mismatch');
  assert.equal(report.findings.length, 1);
  const [finding] = report.findings;
  assert.equal(finding?.kind, 'ledger-entry-db-missing');
  assert.equal(finding?.ref, 'card-2');
});

test('§3.6 自检：双向漂移各自归类（已提交未记账 + 有账无库 同批识别）', async () => {
  const reconcile = await loadReconcile();
  const report = reconcile.reconcileProjection({
    dbCardIds: ['card-db-only'],
    dbStampedRevision: 2,
    decisions: [decision('card-ledger-only', '01J0000000000000000000003D')],
    ledgerRevision: 1,
  });
  assert.equal(report.status, 'mismatch');
  const kinds = report.findings.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['db-committed-ledger-missing', 'ledger-entry-db-missing']);
});
