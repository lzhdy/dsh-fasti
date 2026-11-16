/**
 * #121 离线影子回放 CLI 的纯函数与端到端纪律测试。
 *
 * 纯函数（题库解析/时间归一/汇总）fs-free 离线驱动；端到端用临时根建空库，
 * 验证 dry-run 零写入、--apply append-only 追加且不去重。真实数据根零接触。
 *
 * 纪律：时间一律显式给定（无 Date.now），临时根用例后即清。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_STEP_MS,
  parseReplayQuestions,
  runReplay,
  summarizeShadowRows,
  type ReplayQuestion,
} from '../../scripts/replay-shadow-observations.ts';
import { shadowObservationLogPath } from '../../src/memory/audit/shadow-read.ts';
import { openMemoryWrite } from '../../src/memory/store.ts';
import type { ShadowObservationReadRow } from '../../src/memory/audit/shadow-read.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const BASE = Date.parse('2026-11-16T01:00:00.000Z');

function row(status: ShadowObservationReadRow['gatedStatus'], observedMs: number): ShadowObservationReadRow {
  return {
    termHash: `h${observedMs}`,
    gatedStatus: status,
    candidateCount: 1,
    countScope: 'gated-full',
    acceptedCount: status === 'hit' ? 1 : 0,
    rejectedReasonCodes: [],
    observedMs,
  };
}

// ── 题库解析与时间归一（纯函数） ─────────────────────────────────────────────

test('parseReplayQuestions：支持 at(ISO) 与 atMs(毫秒) 两种时间写法', () => {
  const lines = [
    JSON.stringify({ text: '第一问', at: '2026-11-16T01:00:00.000Z' }),
    JSON.stringify({ text: '第二问', atMs: BASE + 5000 }),
  ];
  const qs = parseReplayQuestions(lines, undefined, DEFAULT_STEP_MS, undefined);
  assert.deepEqual(
    qs.map((q) => [q.text, q.atMs]),
    [
      ['第一问', BASE],
      ['第二问', BASE + 5000],
    ],
  );
});

test('parseReplayQuestions：行内无时间时按 base-at + 行号×step 确定性推导，空行忽略', () => {
  const lines = [
    '',
    '   ',
    JSON.stringify({ text: '甲' }),
    JSON.stringify({ text: '乙' }),
    JSON.stringify({ text: '丙' }),
  ];
  const qs = parseReplayQuestions(lines, BASE, 10_000, undefined);
  assert.deepEqual(
    qs.map((q) => q.atMs),
    [BASE, BASE + 10_000, BASE + 20_000],
  );
});

test('parseReplayQuestions：行内 atMs 优先于 base-at；limit 行内/缺省两级透传', () => {
  const lines = [JSON.stringify({ text: '甲', atMs: BASE + 999, limit: 5 }), JSON.stringify({ text: '乙' })];
  const qs = parseReplayQuestions(lines, BASE, DEFAULT_STEP_MS, 3);
  assert.equal(qs[0]!.atMs, BASE + 999);
  assert.equal(qs[0]!.limit, 5, '行内 limit 覆盖默认');
  assert.equal(qs[1]!.limit, 3, '缺省回落默认 limit');
});

test('parseReplayQuestions：各类坏输入 fail-loud 且报错带题号', () => {
  const bad: Array<{ name: string; lines: string[]; base?: number }> = [
    { name: '非法 JSON', lines: ['{不是 json'] },
    { name: '非对象', lines: ['42'] },
    { name: '缺 text', lines: [JSON.stringify({ atMs: BASE })] },
    { name: 'text 空白', lines: [JSON.stringify({ text: '   ' })] },
    { name: 'at 与 atMs 同给', lines: [JSON.stringify({ text: 'x', at: '2026-11-16T01:00:00.000Z', atMs: BASE })] },
    { name: '非法 ISO', lines: [JSON.stringify({ text: 'x', at: 'not-a-date' })] },
    { name: 'atMs 非有限数', lines: [JSON.stringify({ text: 'x', atMs: Number.NaN })] },
    { name: 'limit 非正整数', lines: [JSON.stringify({ text: 'x', atMs: BASE, limit: 0 })] },
    { name: '无行内时间且无 base-at', lines: [JSON.stringify({ text: 'x' })] },
  ];
  for (const c of bad) {
    assert.throws(
      () => parseReplayQuestions(c.lines, c.base, DEFAULT_STEP_MS, undefined),
      (error: unknown) => error instanceof Error && /第\s*\d+\s*题/.test(error.message),
      `应带题号报错：${c.name}`,
    );
  }
});

// ── 状态汇总（纯函数） ───────────────────────────────────────────────────────

test('summarizeShadowRows：仅统计本次新增切片并按三态计数', () => {
  const before = [row('hit', 1), row('abstain', 2)];
  const added = [row('no-match', 3), row('no-match', 4), row('hit', 5)];
  const all = [...before, ...added];
  const summary = summarizeShadowRows(all, before.length);
  assert.equal(summary.appended, 3);
  assert.equal(summary.totalRows, 5);
  assert.deepEqual(summary.byStatus, { hit: 1, abstain: 0, 'no-match': 2 });
});

// ── 端到端：临时空库 + dry-run/apply ─────────────────────────────────────────

function emptyIndex(root: string): string {
  const indexDir = path.join(root, 'projection', 'memory-index');
  const handle = openMemoryWrite({ indexDir });
  void handle.close();
  return indexDir;
}

function questionFile(root: string): string {
  const file = path.join(root, 'questions.jsonl');
  const lines = [
    JSON.stringify({ text: '完全不存在的冷词阿尔法', atMs: BASE + 1000 }),
    JSON.stringify({ text: '另一个无人提及的冷词贝塔', atMs: BASE + 2000 }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

test('runReplay：dry-run 一条不写、不侧建影子文件，返回 requested 不落盘', async () => {
  const root = makeTempRoot('replay-dry-');
  try {
    const indexDir = emptyIndex(root);
    const result = await runReplay({
      dataRoot: root,
      questionsFile: questionFile(root),
      stepMs: DEFAULT_STEP_MS,
      apply: false,
    });
    assert.equal(result.applied, false);
    assert.equal(result.requested, 2);
    assert.equal(result.beforeRows, 0);
    assert.ok(!fs.existsSync(shadowObservationLogPath(indexDir)), 'dry-run 不得创建影子日志');
  } finally {
    cleanupTempRoot(root);
  }
});

test('runReplay：--apply 对空库写两行 no-match；重复跑 append-only 追加不去重', async () => {
  const root = makeTempRoot('replay-apply-');
  try {
    const indexDir = emptyIndex(root);
    const qf = questionFile(root);
    const first = await runReplay({ dataRoot: root, questionsFile: qf, stepMs: DEFAULT_STEP_MS, apply: true });
    assert.equal(first.applied, true);
    assert.equal(first.summary?.appended, 2);
    assert.equal(first.summary?.byStatus['no-match'], 2);
    const logFile = shadowObservationLogPath(indexDir);
    assert.ok(fs.existsSync(logFile));

    const second = await runReplay({ dataRoot: root, questionsFile: qf, stepMs: DEFAULT_STEP_MS, apply: true });
    assert.equal(second.beforeRows, 2, '第二次跑前文件已有两行');
    assert.equal(second.summary?.appended, 2, '同词同参再跑仍各追加一行，append-only 不去重');
    assert.equal(second.summary?.totalRows, 4);
  } finally {
    cleanupTempRoot(root);
  }
});

test('runReplay：索引库不存在时 fail-loud 抛错而非静默造库', async () => {
  const root = makeTempRoot('replay-missing-');
  try {
    await assert.rejects(() =>
      runReplay({
        dataRoot: root,
        questionsFile: questionFile(root),
        stepMs: DEFAULT_STEP_MS,
        apply: true,
      }),
    );
  } finally {
    cleanupTempRoot(root);
  }
});

// 仅为类型引用占位，避免未使用告警在严格配置下噪音。
const _typeGuard: ReplayQuestion | null = null;
void _typeGuard;
