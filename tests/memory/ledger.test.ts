/**
 * C2 账本测试 —— revisions.jsonl / decisions.jsonl（方案 §3.4 / §3.5）。
 *
 * 纪律：append-only、单调 revision 链、前缀关系自证（countLines + startsWith）、
 * 坏行抛 CorruptedError、形状违约抛 IntegrityError。全部在临时目录。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { CorruptedError, IntegrityError } from '../../src/core/errors.ts';
import { ulid } from '../../src/core/ulid.ts';
import {
  DECISIONS_FILE,
  REVISIONS_FILE,
  appendDecision,
  appendRevision,
  readDecisions,
  readRevisions,
} from '../../src/memory/ledger.ts';
import type { DecisionRecord, RevisionRecord } from '../../src/memory/types.ts';
import { cleanupTempRoot, countLines, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');

function revision(overrides: Partial<RevisionRecord> = {}): RevisionRecord {
  return {
    revision: 1,
    slug: 'build',
    at_ms: T0,
    schema_version: 1,
    truth_fingerprint: 'fp-1',
    prior_revision: null,
    card_count: 0,
    alias_count: 0,
    row_hash_sum: 'rhs-1',
    shadow_diff: { added: 0, removed: 0, changed: 0 },
    reason: 'test',
    operator: 'offline-cli',
    ...overrides,
  };
}

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    decision_id: ulid(),
    at_ms: T0,
    action: 'create-card',
    card_id: 'mc_00000000000000000000000000000000',
    event_id: '01J0000000000000000000000E',
    anchor_json: '["01J0000000000000000000000A"]',
    content_hash: 'ch-1',
    model_tag: 'rules-v1',
    reason: 'fixture: 测试',
    created_by: 'her',
    ...overrides,
  };
}

test('revisions：追加/读取往返，链 1→2→3 单调且 prior 相接', () => {
  const dir = makeTempRoot('ledger-test-');
  try {
    appendRevision(dir, revision());
    appendRevision(dir, revision({ revision: 2, prior_revision: 1, slug: 'rebuild' }));
    appendRevision(dir, revision({ revision: 3, prior_revision: 2, slug: 'stamp' }));
    const rows = readRevisions(dir);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.revision),
      [1, 2, 3],
    );
    assert.deepEqual(
      rows.map((r) => r.prior_revision),
      [null, 1, 2],
    );
    assert.equal(rows[1]?.slug, 'rebuild');
  } finally {
    cleanupTempRoot(dir);
  }
});

test('revisions：跳号（1 之后直接 5）拒绝，文件不增行', () => {
  const dir = makeTempRoot('ledger-test-');
  try {
    appendRevision(dir, revision());
    assert.throws(
      () => appendRevision(dir, revision({ revision: 5, prior_revision: 1 })),
      IntegrityError,
    );
    assert.equal(countLines(path.join(dir, REVISIONS_FILE)), 1);
  } finally {
    cleanupTempRoot(dir);
  }
});

test('revisions：prior_revision 断链拒绝', () => {
  const dir = makeTempRoot('ledger-test-');
  try {
    appendRevision(dir, revision());
    assert.throws(
      () => appendRevision(dir, revision({ revision: 2, prior_revision: null })),
      IntegrityError,
    );
    assert.throws(
      () => appendRevision(dir, revision({ revision: 2, prior_revision: 99 })),
      IntegrityError,
    );
    assert.equal(countLines(path.join(dir, REVISIONS_FILE)), 1);
  } finally {
    cleanupTempRoot(dir);
  }
});

test('revisions：首行必须 revision=1 且 prior=null', () => {
  const dir = makeTempRoot('ledger-test-');
  try {
    assert.throws(() => appendRevision(dir, revision({ revision: 2 })), IntegrityError);
    assert.throws(
      () => appendRevision(dir, revision({ revision: 1, prior_revision: 0 })),
      IntegrityError,
    );
    assert.equal(countLines(path.join(dir, REVISIONS_FILE)), 0);
  } finally {
    cleanupTempRoot(dir);
  }
});

test('revisions：slug / operator 越界拒绝', () => {
  const dir = makeTempRoot('ledger-test-');
  try {
    assert.throws(
      () => appendRevision(dir, revision({ slug: 'drop-table' as RevisionRecord['slug'] })),
      IntegrityError,
    );
    assert.throws(
      () => appendRevision(dir, revision({ operator: 'runtime' as RevisionRecord['operator'] })),
      IntegrityError,
    );
    assert.equal(countLines(path.join(dir, REVISIONS_FILE)), 0);
  } finally {
    cleanupTempRoot(dir);
  }
});

test('revisions：append-only 前缀关系（旧文本是新文本的前缀，行数只增不改）', () => {
  const dir = makeTempRoot('ledger-test-');
  try {
    const file = path.join(dir, REVISIONS_FILE);
    appendRevision(dir, revision());
    const before = fs.readFileSync(file, 'utf8');
    appendRevision(dir, revision({ revision: 2, prior_revision: 1 }));
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.startsWith(before), '追加后必须以追加前文本为前缀');
    assert.equal(countLines(file), 2);
  } finally {
    cleanupTempRoot(dir);
  }
});

test('decisions：追加/读取往返；action / created_by / ULID 违约拒绝', () => {
  const dir = makeTempRoot('ledger-test-');
  try {
    const d1 = decision();
    const d2 = decision({ action: 'tombstone-card', created_by: 'her' });
    appendDecision(dir, d1);
    appendDecision(dir, d2);
    const rows = readDecisions(dir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.decision_id, d1.decision_id);
    assert.equal(rows[1]?.action, 'tombstone-card');
    assert.equal(rows[1]?.created_by, 'her');

    assert.throws(
      () => appendDecision(dir, decision({ action: 'erase' as DecisionRecord['action'] })),
      IntegrityError,
    );
    assert.throws(
      () => appendDecision(dir, decision({ created_by: 'llm' as DecisionRecord['created_by'] })),
      IntegrityError,
    );
    assert.throws(() => appendDecision(dir, decision({ decision_id: 'not-a-ulid' })), IntegrityError);
    assert.equal(countLines(path.join(dir, DECISIONS_FILE)), 2);
  } finally {
    cleanupTempRoot(dir);
  }
});

test('账本坏行：读时抛 CorruptedError（不静默跳过）', () => {
  const dir = makeTempRoot('ledger-test-');
  try {
    appendRevision(dir, revision());
    fs.appendFileSync(path.join(dir, REVISIONS_FILE), '{坏行\n', 'utf8');
    assert.throws(() => readRevisions(dir), CorruptedError);

    appendDecision(dir, decision());
    fs.appendFileSync(path.join(dir, DECISIONS_FILE), '{坏行\n', 'utf8');
    assert.throws(() => readDecisions(dir), CorruptedError);
  } finally {
    cleanupTempRoot(dir);
  }
});

test('账本缺文件：读取返回空数组，不创建文件', () => {
  const dir = makeTempRoot('ledger-test-');
  try {
    assert.deepEqual(readRevisions(dir), []);
    assert.deepEqual(readDecisions(dir), []);
    assert.equal(fs.existsSync(path.join(dir, REVISIONS_FILE)), false);
    assert.equal(fs.existsSync(path.join(dir, DECISIONS_FILE)), false);
  } finally {
    cleanupTempRoot(dir);
  }
});