/**
 * #114/S1 影子观测只读读取器红测（src/memory/audit/shadow-read.ts，模块落地前整体加载失败）。
 *
 * 设立原因：拆旧后运行期只写影子、全仓无读取主体，Q4「四态各 ≥200 条、只取 gated-full 同口径段」
 * 将无数据来源。读取器是 audit 离线只读模块，不进实时链路、无定时器、无守护进程（K13）。
 *
 * 契约：
 *  - 新行（含 countScope）原样读；旧行（仅 legacyCount）**读时**补 countScope='legacy-limited'，
 *    candidateCount 置 null——旧 legacyCount 是 fasti.search(text, limit) 截断后的条数，与"门过滤前
 *    全集"不同源，禁止同名字下混用（legacy-limited 段天然不可用于全集统计）；严禁回写 JSONL；
 *  - 文件缺失返回空数组（影子期未运行不是错误）；坏行 fail-loud 抛 IntegrityError；
 *  - 提供按 countScope 分段的分组能力，供 Q4 只统计 gated-full 段；
 *  - 模块源码只允许 read 系原语，测试侧另做读后内容哈希不变证明。
 *
 * 纪律：临时根、零真实数据根接触。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { shadowDirFromIndex, SHADOW_DIRNAME, SHADOW_LOG_FILE } from '../../src/memory/shadow-write.ts';
import { IntegrityError } from '../../src/core/errors.ts';
import type { CountScope } from '../../src/memory/types.ts';
import {
  groupShadowByCountScope,
  readShadowObservations,
} from '../../src/memory/audit/shadow-read.ts';
import type { ShadowObservationReadRow } from '../../src/memory/audit/shadow-read.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-10T08:00:00.000Z');

function layout(root: string): { indexDir: string; logFile: string } {
  const indexDir = path.join(root, 'projection', 'memory-index');
  const shadowDir = shadowDirFromIndex(indexDir);
  fs.mkdirSync(shadowDir, { recursive: true });
  assert.equal(path.basename(shadowDir), SHADOW_DIRNAME);
  return { indexDir, logFile: path.join(shadowDir, SHADOW_LOG_FILE) };
}

test('读取器：旧行读时补 legacy-limited、新行保持 gated-full，candidateCount 两跳口径一致', () => {
  const root = makeTempRoot();
  try {
    const { indexDir, logFile } = layout(root);
    const legacyRow = {
      termHash: 'h1',
      gatedStatus: 'abstain',
      legacyCount: 3,
      acceptedCount: 0,
      rejectedReasonCodes: ['all-rejected'],
      observedMs: T0,
    };
    const newRow = {
      termHash: 'h2',
      gatedStatus: 'hit',
      candidateCount: 5,
      countScope: 'gated-full',
      acceptedCount: 2,
      rejectedReasonCodes: [],
      observedMs: T0 + 1,
    };
    fs.writeFileSync(logFile, `${JSON.stringify(legacyRow)}\n${JSON.stringify(newRow)}\n`, 'utf8');

    const rows = readShadowObservations(indexDir);
    assert.equal(rows.length, 2);
    const [oldRead, newRead] = rows as [ShadowObservationReadRow, ShadowObservationReadRow];

    assert.equal(oldRead.countScope, 'legacy-limited', '旧行只能在读时被标注，不得回写');
    assert.equal(oldRead.candidateCount, null, '旧截断值不得映射进全集计数；null 区别于真实的 0 候选');
    assert.ok(!('legacyCount' in oldRead), '归一后对外不得再暴露旧字段名');
    assert.equal(newRead.countScope, 'gated-full');
    assert.equal(newRead.candidateCount, 5);

    const groups = groupShadowByCountScope(rows);
    assert.deepEqual(Object.keys(groups).sort(), ['gated-full', 'legacy-limited']);
    assert.equal(groups['gated-full']?.length, 1);
    assert.equal(groups['legacy-limited']?.length, 1);

    // Q4 分段谓词可用且类型收窄正确。
    const q4Segment: readonly ShadowObservationReadRow[] = groups['gated-full'] ?? [];
    assert.equal(q4Segment.every((row) => row.countScope === ('gated-full' as CountScope)), true);
  } finally {
    cleanupTempRoot(root);
  }
});

test('读取器：观测文件缺失时返回空数组，不建目录、不抛错', () => {
  const root = makeTempRoot();
  try {
    const indexDir = path.join(root, 'projection', 'memory-index');
    fs.mkdirSync(indexDir, { recursive: true });
    assert.deepEqual(readShadowObservations(indexDir), []);
    assert.ok(!fs.existsSync(path.join(root, 'projection', SHADOW_DIRNAME)), '读取不得创建影子目录');
  } finally {
    cleanupTempRoot(root);
  }
});

test('读取器：坏行 fail-loud 抛 IntegrityError，绝不静默丢弃观测', () => {
  const root = makeTempRoot();
  try {
    const { indexDir, logFile } = layout(root);
    fs.writeFileSync(logFile, '{not-json\n', 'utf8');
    assert.throws(() => readShadowObservations(indexDir), IntegrityError);
  } finally {
    cleanupTempRoot(root);
  }
});

test('读取器：读取前后文件内容哈希逐字节不变（append-only，只读兼容无回写）', () => {
  const root = makeTempRoot();
  try {
    const { indexDir, logFile } = layout(root);
    fs.writeFileSync(
      logFile,
      `${JSON.stringify({
        termHash: 'h',
        gatedStatus: 'no-match',
        legacyCount: 0,
        acceptedCount: 0,
        rejectedReasonCodes: [],
        observedMs: T0,
      })}\n`,
      'utf8',
    );
    const before = crypto.createHash('sha256').update(fs.readFileSync(logFile)).digest('hex');
    const rows = readShadowObservations(indexDir);
    const after = crypto.createHash('sha256').update(fs.readFileSync(logFile)).digest('hex');
    assert.equal(rows.length, 1);
    assert.equal(after, before, '读取动作不得改写 JSONL（含不得"顺手补字段"）');
  } finally {
    cleanupTempRoot(root);
  }
});
