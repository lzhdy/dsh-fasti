/**
 * L2 JSONL 降级档 —— D2 尾行容忍 + D1 开机按需压实（施工单：降级档压实与残行容忍 2026-11-28）。
 *
 * 覆盖六条：
 *  1. **D2·尾行容忍（experience 账）**：残行不阻断 open；upsert 后重开往返正常
 *     （终态：e-1 与 e-2 都在＋磁盘 2 行无拼行＋文件以换行收尾）；
 *  2. **D2·事件账尾行容忍**：残行不阻断 open，版本折叠（最大 version）不受影响；
 *  3. **D1·触发誊清（experience 账）**：130 行 / 3 id（比值 ≥2 且 ≥64）→ open 后恰 3 行、
 *     每行可 JSON.parse、重开内存态一致；
 *  4. **D1·不触发边界**：70 行 / 40 id（比值 1.75 < 2）与 63 行 / 3 id（<64）→ 文件字节级不变；
 *  5. **D1·事件账折叠誊清**：2 id 各 65 版本（130 行）→ 恰 2 行、各为最大 version；
 *     压实重开后 search() 仍命中（索引自 compacted 文件重建正常）；
 *  6. **L3-补1·写前残行切除**：残行→连续两次 upsert→重开全在、无 CorruptedError
 *     （钉死"残行与追加拼行 → 中间坏行"隐患已消）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { JsonlProjection } from '../../src/projection/jsonl.ts';
import { encodeEventRow } from '../../src/projection/event-row.ts';
import type { EventProjection, ExperienceProjection } from '../../src/projection/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const BASE_MS = 1_700_000_000_000;

/** 造一条经历投影行。 */
function makeExperience(id: string, tick = 0): ExperienceProjection {
  return {
    id,
    kind: 'note',
    channel: 'dsh',
    scene_ref: null,
    initiation: null,
    occurred_ms: BASE_MS + tick,
    recorded_ms: BASE_MS + tick,
    tick,
    status: 'active',
    shard: '2026-11',
    seq: tick,
  };
}

/** 造一条事件投影行（数组字段由 encodeEventRow 转 JSON 文本落盘）。 */
function makeEventProjection(id: string, version: number): EventProjection {
  return {
    id,
    version,
    status: 'closed',
    channel: 'dsh',
    started_ms: BASE_MS,
    ended_ms: BASE_MS + 100,
    assembled_ms: BASE_MS + 100,
    summary: null,
    summary_quality: 'pending',
    summary_source: null,
    summary_prompt_version: null,
    summary_model: null,
    key_points: [],
    anchors: [],
    topic_lines: [],
    boundary_candidates: [],
    pointer_count: 0,
    merged_into: null,
    split_into: [],
    created_by: 'system',
    created_at_ms: BASE_MS + 100,
    effective_chars: null,
    raw_chars: null,
  };
}

/** 账本文本：若干合法行 + 可选末尾残行（不带换行，模拟进程被 kill 的半行）。 */
function ledgerText(rows: readonly unknown[], tornTail = ''): string {
  const body = rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  return body + tornTail;
}

/** 账本非空物理行数。 */
function ledgerLines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

test('D2·尾行容忍：experience 账残行不阻断 open，upsert 后重开往返正常', async () => {
  const root = makeTempRoot();
  try {
    const dir = path.join(root, 'projection', 'l2');
    const file = path.join(dir, 'experience.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      ledgerText([makeExperience('e-1')], '{"id":"e-torn","occurred_ms":17'),
      'utf8',
    );

    const first = new JsonlProjection(dir);
    await first.open();
    assert.deepEqual(
      (await first.allExperiences()).map((row) => row.id),
      ['e-1'],
    );

    await first.upsertExperience(makeExperience('e-2', 1));
    await first.close();

    const second = new JsonlProjection(dir);
    await second.open();
    assert.deepEqual(
      (await second.allExperiences()).map((row) => row.id).sort(),
      ['e-1', 'e-2'],
    );
    await second.close();

    // 磁盘终态（L3-补1 ⑤）：恰 2 行、无拼行、以换行收尾。
    const lines = ledgerLines(file);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
  } finally {
    cleanupTempRoot(root);
  }
});

test('D2·事件账尾行容忍：残行不阻断 open，版本折叠取最大 version', async () => {
  const root = makeTempRoot();
  try {
    const dir = path.join(root, 'projection', 'l2');
    const file = path.join(dir, 'event.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      ledgerText(
        [encodeEventRow(makeEventProjection('evt-a', 1)), encodeEventRow(makeEventProjection('evt-a', 2))],
        '{"id":"evt-torn","version',
      ),
      'utf8',
    );

    const proj = new JsonlProjection(dir);
    await proj.open();
    const events = await proj.allEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, 'evt-a');
    assert.equal(events[0]?.version, 2);
    await proj.close();
  } finally {
    cleanupTempRoot(root);
  }
});

test('D1·触发誊清：experience 账 130 行/3 id → open 后恰 3 行且重开内存态一致', async () => {
  const root = makeTempRoot();
  try {
    const dir = path.join(root, 'projection', 'l2');
    const file = path.join(dir, 'experience.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    const ids = ['e-a', 'e-b', 'e-c'];
    const rows = Array.from({ length: 130 }, (_, i) => makeExperience(ids[i % 3] as string, i));
    fs.writeFileSync(file, ledgerText(rows), 'utf8');

    const proj = new JsonlProjection(dir);
    await proj.open();

    // 誊清后磁盘：恰 3 行、每行可 JSON.parse。
    const lines = ledgerLines(file);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    const firstState = await proj.allExperiences();
    await proj.close();

    // 重开内存态一致（同 id 后行覆盖前行 → 每 id 最终值）。
    const reopened = new JsonlProjection(dir);
    await reopened.open();
    assert.deepEqual(await reopened.allExperiences(), firstState);
    await reopened.close();
  } finally {
    cleanupTempRoot(root);
  }
});

test('D1·不触发边界：比值不足（70/40）或行数不足（63/3）→ 文件字节级不变', async () => {
  const root = makeTempRoot();
  try {
    // 70 行 / 40 个 id：比值 1.75 < 2（虽 ≥64）→ 不重写。
    const dirA = path.join(root, 'a', 'projection', 'l2');
    const fileA = path.join(dirA, 'experience.jsonl');
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(
      fileA,
      ledgerText(Array.from({ length: 70 }, (_, i) => makeExperience(`e-${i % 40}`, i))),
      'utf8',
    );
    const beforeA = fs.readFileSync(fileA, 'utf8');
    const projA = new JsonlProjection(dirA);
    await projA.open();
    await projA.close();
    assert.equal(fs.readFileSync(fileA, 'utf8'), beforeA);

    // 63 行 / 3 个 id：<64 → 不重写。
    const dirB = path.join(root, 'b', 'projection', 'l2');
    const fileB = path.join(dirB, 'experience.jsonl');
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(
      fileB,
      ledgerText(Array.from({ length: 63 }, (_, i) => makeExperience(`e-${i % 3}`, i))),
      'utf8',
    );
    const beforeB = fs.readFileSync(fileB, 'utf8');
    const projB = new JsonlProjection(dirB);
    await projB.open();
    await projB.close();
    assert.equal(fs.readFileSync(fileB, 'utf8'), beforeB);
  } finally {
    cleanupTempRoot(root);
  }
});

test('D1·事件账折叠誊清：2 id 各 65 版本 → 恰 2 行，search() 在压实重开后仍命中', async () => {
  const root = makeTempRoot();
  try {
    const dir = path.join(root, 'projection', 'l2');
    const eventFile = path.join(dir, 'event.jsonl');
    const docFile = path.join(dir, 'document.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    const rows = [
      ...Array.from({ length: 65 }, (_, i) => makeEventProjection('evt-a', i + 1)),
      ...Array.from({ length: 65 }, (_, i) => makeEventProjection('evt-b', i + 1)),
    ].map((row) => encodeEventRow(row));
    fs.writeFileSync(eventFile, ledgerText(rows), 'utf8');
    fs.writeFileSync(docFile, ledgerText([{ id: 'evt-a', text: 'alpha bravo charlie' }]), 'utf8');

    const proj = new JsonlProjection(dir);
    await proj.open();

    // 折叠誊清：恰 2 行、各为最大 version。
    const lines = ledgerLines(eventFile);
    assert.equal(lines.length, 2);
    const events = await proj.allEvents();
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.version, 65);
    }
    await proj.close();

    // 压实重开后索引自 compacted 文件重建，search 仍命中。
    const reopened = new JsonlProjection(dir);
    await reopened.open();
    const hits = await reopened.search('bravo');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, 'evt-a');
    await reopened.close();
  } finally {
    cleanupTempRoot(root);
  }
});

test('L3-补1·写前残行切除：残行→连续两次 upsert→重开全在（中间行隐患已消）', async () => {
  const root = makeTempRoot();
  try {
    const dir = path.join(root, 'projection', 'l2');
    const file = path.join(dir, 'experience.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      ledgerText([makeExperience('e-1')], '{"id":"e-torn","occurred_ms":17'),
      'utf8',
    );

    const proj = new JsonlProjection(dir);
    await proj.open();
    await proj.upsertExperience(makeExperience('e-2', 1));
    await proj.upsertExperience(makeExperience('e-3', 2));
    await proj.close();

    // 重开不得抛 CorruptedError（残行若与追加拼成中间坏行即抛），且三行全在。
    const reopened = new JsonlProjection(dir);
    await reopened.open();
    assert.deepEqual(
      (await reopened.allExperiences()).map((row) => row.id).sort(),
      ['e-1', 'e-2', 'e-3'],
    );
    const lines = ledgerLines(file);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    await reopened.close();
  } finally {
    cleanupTempRoot(root);
  }
});
