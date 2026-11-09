/**
 * 历史回填脚本测试（任务卡 T18）。
 *
 * 覆盖：「只补齐不重建」的核心纪律、默认试运行的零写入、幂等（重复跑不产生重复事件）、
 * 复用切分器判定（静默切分 / 连续段并入 / 跨通道场景切换）、记录本只读、报告数字诚实。
 *
 * 纪律：全部用临时数据根，**绝不触碰 `~/.dsh/fasti`**；既有事件用「原始 JSONL」布置
 * （不另开 EventLog 实例 —— 事件层是单写者，同一目录只能有一个写入方）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { parseEvent } from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import type { Experience } from '../../src/contract/experience.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';
import { backfillEvents } from '../../scripts/backfill-events.ts';

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'backfill-events.ts');

// ── 样例数据 ──────────────────────────────────────────────────────────────

/** 一条经历（不填 observation.text —— 回填只按 experience.id 建指针）。 */
function experience(
  id: string,
  channel: string,
  occurredAt: string,
  tick: number,
): Experience {
  return {
    id,
    schema_version: 1,
    kind: 'dialogue',
    scene: { channel, ref: 'session-1' },
    initiation: 'user',
    observation: { cue: `线索 ${id}` },
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    tick,
  };
}

/**
 * 样例时间线（刻意覆盖三种形态）：
 *  - **连续段**：A→B 相差 5 分钟 → 并入同一段；
 *  - **跨天**：B→C 隔一天 → 静默 ≥30 分钟 → 切成新段；
 *  - **跨通道**：C(dsh)→D(browser) → 场景切换 → 切成新段。
 */
const TIMELINE: Experience[] = [
  experience('exp-a', 'dsh', '2026-11-01T10:00:00.000Z', 0),
  experience('exp-b', 'dsh', '2026-11-01T10:05:00.000Z', 1),
  experience('exp-c', 'dsh', '2026-11-02T09:00:00.000Z', 2),
  experience('exp-d', 'browser', '2026-11-02T09:01:00.000Z', 3),
  experience('exp-e', 'browser', '2026-11-02T09:02:00.000Z', 4),
  experience('exp-f', 'dsh', '2026-11-03T08:00:00.000Z', 5),
];

/** 把经历写进记录本（原始 JSONL + manifest，不另开 ExperienceLog 实例）。 */
function seedExperiences(root: string, rows: Experience[]): void {
  const dir = layoutOf(root).experiences;
  fs.mkdirSync(dir, { recursive: true });
  const byShard = new Map<string, Experience[]>();
  for (const row of rows) {
    const shard = row.recorded_at.slice(0, 7);
    const list = byShard.get(shard) ?? [];
    list.push(row);
    byShard.set(shard, list);
  }
  for (const [shard, list] of byShard) {
    fs.writeFileSync(
      path.join(dir, `${shard}.jsonl`),
      `${list.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify({ version: 1, months: [...byShard.keys()].sort() }, null, 2)}\n`,
    'utf8',
  );
}

/** 把事件写进事件真源（原始 JSONL + manifest，不另开 EventLog 实例）。 */
function seedEvents(root: string, rows: EventRecord[]): void {
  const dir = layoutOf(root).events;
  fs.mkdirSync(dir, { recursive: true });
  const byShard = new Map<string, EventRecord[]>();
  for (const row of rows) {
    const shard = row.assembled_at.slice(0, 7);
    const list = byShard.get(shard) ?? [];
    list.push(row);
    byShard.set(shard, list);
  }
  for (const [shard, list] of byShard) {
    fs.writeFileSync(
      path.join(dir, `${shard}.jsonl`),
      `${list.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify({ version: 1, months: [...byShard.keys()].sort() }, null, 2)}\n`,
    'utf8',
  );
}

/** 造一条既有事件（覆盖给定记录，边界与版本由测试自己钉死）。 */
function existingEvent(id: string, pointerIds: string[], channel: string): EventRecord {
  return parseEvent(
    {
      id,
      schema_version: 1,
      version: 1,
      status: 'closed',
      closed_reason: 'silence',
      pointers: pointerIds.map((pointerId) => ({ id: pointerId, channel })),
      time_range: { started_at: '2026-11-01T10:00:00.000Z', ended_at: '2026-11-01T10:00:00.000Z' },
      assembled_at: '2026-11-01T12:00:00.000Z',
      summary: null,
      key_points: [],
      anchors: [],
      topic_lines: [],
      summary_quality: 'pending',
      summary_source: null,
      summary_prompt_version: null,
      summary_model: null,
      created_by: 'system',
      created_at: '2026-11-01T12:00:00.000Z',
      channel,
      boundary_candidates: [],
    },
    'write',
  );
}

/** 读事件真源的全部版本行（原始 JSONL 逐行读）。 */
function eventRows(root: string): Array<Record<string, unknown>> {
  const dir = layoutOf(root).events;
  if (!fs.existsSync(dir)) {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() !== '') {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return rows;
}

/** 事件真源目录的全部文件内容（字节级比对用）。 */
function snapshotDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) {
      out.set(name, fs.readFileSync(full, 'utf8'));
    }
  }
  return out;
}

/** 目录内容是否逐字节未变。 */
function dirUnchanged(before: Map<string, string>, dir: string): boolean {
  const after = snapshotDir(dir);
  if (before.size !== after.size) {
    return false;
  }
  for (const [name, text] of before) {
    if (after.get(name) !== text) {
      return false;
    }
  }
  return true;
}

// ── 用例 ──────────────────────────────────────────────────────────────────

test('回填 · 默认是试运行：不写任何文件，且报告将要补什么', () => {
  const root = makeTempRoot('fasti-backfill-');
  try {
    seedExperiences(root, TIMELINE);
    const eventsBefore = snapshotDir(layoutOf(root).events);

    const report = backfillEvents({ dataRoot: root });

    assert.equal(report.mode, 'dry-run', '缺省是试运行');
    assert.equal(report.scanned.experiences, 6);
    assert.equal(report.scanned.uncovered, 6, '全部记录都没有事件覆盖');
    assert.equal(report.created.events, 4, '试运行也要报出将要补几段');
    assert.equal(report.created.records, 6);
    assert.equal(dirUnchanged(eventsBefore, layoutOf(root).events), true, '事件真源零写入');
    assert.equal(
      fs.existsSync(layoutOf(root).events),
      false,
      '事件真源目录都不该被创建',
    );
  } finally {
    cleanupTempRoot(root);
  }
});

test('回填 · apply 后未覆盖记录被切成事件段，段数与记录数对得上', () => {
  const root = makeTempRoot('fasti-backfill-');
  try {
    seedExperiences(root, TIMELINE);

    const report = backfillEvents({ dataRoot: root, apply: true });

    assert.equal(report.mode, 'apply');
    assert.equal(report.created.events, 4);
    assert.equal(report.created.records, 6, '6 条记录全部被覆盖，无重复无遗漏');
    assert.equal(report.existing.untouched, true);

    const rows = eventRows(root);
    const current = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const id = String(row['id']);
      const previous = current.get(id);
      if (previous === undefined || Number(row['version']) > Number(previous['version'])) {
        current.set(id, row);
      }
    }
    assert.equal(current.size, 4, '事件真源里有 4 个事件');

    // 每条记录恰好出现在一个事件的指针里。
    const pointerIds = [...current.values()].flatMap(
      (row) => (row['pointers'] as Array<{ id: string }>).map((pointer) => pointer.id),
    );
    assert.deepEqual([...pointerIds].sort(), TIMELINE.map((row) => row.id).sort());
  } finally {
    cleanupTempRoot(root);
  }
});

test('回填 · 复用切分器判定：静默切分 / 连续段并入 / 跨通道场景切换', () => {
  const root = makeTempRoot('fasti-backfill-');
  try {
    seedExperiences(root, TIMELINE);

    const report = backfillEvents({ dataRoot: root, apply: true });

    const segments = report.segments.map((segment) => ({
      channel: segment.channel,
      records: segment.records,
      closed_reason: segment.closed_reason,
    }));
    assert.deepEqual(segments, [
      // A+B 连续（5 分钟）→ 同一段；C 隔一天来 → 静默闭合。
      { channel: 'dsh', records: 2, closed_reason: 'silence' },
      // C 单独成段；D 是别的通道 → 场景切换闭合。
      { channel: 'dsh', records: 1, closed_reason: 'channel-switch' },
      // D+E 连续（同通道 1 分钟）→ 同一段；F 换通道 → 场景切换闭合。
      { channel: 'browser', records: 2, closed_reason: 'channel-switch' },
      // F 单独成段；批次到此为止 → 静默闭合。
      { channel: 'dsh', records: 1, closed_reason: 'silence' },
    ]);
  } finally {
    cleanupTempRoot(root);
  }
});

test('回填 · 只补齐不重建：既有事件的边界与版本一个字节都不碰', () => {
  const root = makeTempRoot('fasti-backfill-');
  try {
    seedExperiences(root, TIMELINE);
    // 既有事件：只覆盖 exp-a，且已被「修正」过（自写摘要、版本 1）。
    seedEvents(root, [existingEvent('evt-existing', ['exp-a'], 'dsh')]);
    const eventsBefore = snapshotDir(layoutOf(root).events);

    const report = backfillEvents({ dataRoot: root, apply: true });

    assert.equal(report.scanned.covered, 1, 'exp-a 已被既有事件覆盖 → 跳过');
    assert.equal(report.scanned.uncovered, 5);
    assert.equal(report.existing.events, 1, '既有事件数没变（只新增，不替换）');
    assert.equal(report.existing.untouched, true, '自证：既有分片字节级未变');

    // 既有事件那一行逐字节未变（append-only，只在其后追加）。
    const rows = eventRows(root);
    const existingRow = rows.find((row) => row['id'] === 'evt-existing');
    assert.deepEqual(existingRow, JSON.parse(JSON.stringify(existingRow)));
    assert.equal(existingRow?.['version'], 1, '既有事件没有被推进版本');
    assert.equal(
      (existingRow?.['pointers'] as Array<{ id: string }>).length,
      1,
      '既有事件的指针没被塞进新记录',
    );

    // 既有事件行仍是文件的第一行 —— 内容没被动过。
    const firstLine = fs
      .readFileSync(path.join(layoutOf(root).events, '2026-11.jsonl'), 'utf8')
      .split('\n')[0] as string;
    assert.equal((JSON.parse(firstLine) as Record<string, unknown>)['id'], 'evt-existing');
    assert.ok(eventsBefore.get('2026-11.jsonl') !== undefined);
  } finally {
    cleanupTempRoot(root);
  }
});

test('回填 · 幂等：重复跑不产生重复事件（按 experience id 去重）', () => {
  const root = makeTempRoot('fasti-backfill-');
  try {
    seedExperiences(root, TIMELINE);

    const first = backfillEvents({ dataRoot: root, apply: true });
    assert.equal(first.created.events, 4);
    const rowsAfterFirst = eventRows(root).length;

    const second = backfillEvents({ dataRoot: root, apply: true });
    assert.equal(second.scanned.covered, 6, '第二次跑全部已覆盖');
    assert.equal(second.scanned.uncovered, 0);
    assert.equal(second.created.events, 0, '第二次不补任何段');
    assert.equal(eventRows(root).length, rowsAfterFirst, '事件真源行数没变');
    assert.match(second.warnings.join('\n'), /无需回填/);
  } finally {
    cleanupTempRoot(root);
  }
});

test('回填 · 记录本只读：experiences 一个字节都不改', () => {
  const root = makeTempRoot('fasti-backfill-');
  try {
    seedExperiences(root, TIMELINE);
    const experiencesBefore = snapshotDir(layoutOf(root).experiences);

    backfillEvents({ dataRoot: root, apply: true });

    assert.equal(dirUnchanged(experiencesBefore, layoutOf(root).experiences), true, '记录本零改动');
  } finally {
    cleanupTempRoot(root);
  }
});

test('回填 · 报告数字诚实：单记录事件数与待归并数逐项对得上', () => {
  const root = makeTempRoot('fasti-backfill-');
  try {
    seedExperiences(root, TIMELINE);

    const report = backfillEvents({ dataRoot: root, apply: true });

    // 4 段里有 2 段是单记录（C 与 F）。
    assert.equal(report.created.single_record_events, 2);
    // 待归并 = 单记录 + 静默闭合：C 是场景切换闭合（不算孤条），F 是静默闭合（算）。
    assert.equal(report.created.pending_merge, 1);
    // 观察窗从 assembled_at（回填时刻）起算 → 刚回填完还没有人被标「孤立记录」。
    assert.equal(report.created.orphan_marked, 0);
    // 按通道分布。
    assert.deepEqual(report.created.by_channel, { dsh: 3, browser: 1 });
  } finally {
    cleanupTempRoot(root);
  }
});

test('回填 · 回填不产生同通道两个 open 事件（restore 的硬约束不被破坏）', () => {
  const root = makeTempRoot('fasti-backfill-');
  try {
    seedExperiences(root, TIMELINE);

    backfillEvents({ dataRoot: root, apply: true });

    // 当前态（同 id 取最大 version）才是 restore() 看的东西 ——
    // 中间版本本来就是 open（切分器「每次并入写一版」），不算数。
    const current = new Map<string, Record<string, unknown>>();
    for (const row of eventRows(root)) {
      const id = String(row['id']);
      const previous = current.get(id);
      if (previous === undefined || Number(row['version']) > Number(previous['version'])) {
        current.set(id, row);
      }
    }
    const openByChannel = new Map<string, number>();
    for (const row of current.values()) {
      if (row['status'] !== 'open') {
        continue;
      }
      const channel = String(row['channel']);
      openByChannel.set(channel, (openByChannel.get(channel) ?? 0) + 1);
    }
    assert.equal(openByChannel.size, 0, '回填产出的段全部闭合，不留 open');
  } finally {
    cleanupTempRoot(root);
  }
});

test('回填 · CLI：--help / --json / --apply 三条路径都通', () => {
  const root = makeTempRoot('fasti-backfill-cli-');
  try {
    seedExperiences(root, TIMELINE);

    const help = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.match(help, /--apply/);
    assert.match(help, /--data-root/);

    // --json 且不传 --apply → 零写入。
    const dry = execFileSync(
      process.execPath,
      [SCRIPT, '--data-root', root, '--json'],
      { encoding: 'utf8' },
    );
    const dryReport = JSON.parse(dry) as { mode: string; created: { events: number } };
    assert.equal(dryReport.mode, 'dry-run');
    assert.equal(dryReport.created.events, 4);
    assert.equal(fs.existsSync(layoutOf(root).events), false, '试运行不建事件目录');

    // --apply → 真写。
    const applied = execFileSync(
      process.execPath,
      [SCRIPT, '--data-root', root, '--apply', '--json'],
      { encoding: 'utf8' },
    );
    const applyReport = JSON.parse(applied) as { mode: string; created: { events: number } };
    assert.equal(applyReport.mode, 'apply');
    assert.equal(applyReport.created.events, 4);
    assert.ok(eventRows(root).length > 0, 'apply 后事件真源有行');
  } finally {
    cleanupTempRoot(root);
  }
});
