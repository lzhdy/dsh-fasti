/**
 * 事件日志测试（技术基线 §3 · 任务卡 T2）。
 *
 * 覆盖：append-only 与版本推进、(id, version) 幂等、当前态 = 最大 version、
 * 退役态留痕、按月分片与 manifest、坏行抛 CorruptedError、重启后 reindex、
 * 冻结面自证（导出名与方法名均不触禁词、无删除能力）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConflictError, CorruptedError, NotFoundError } from '../../src/core/errors.ts';
import { isMutatingCapability } from '../../src/contract/frozen-surface.ts';
import { EVENT_SCHEMA_VERSION } from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import { EventLog } from '../../src/source/event-log.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { cleanupTempRoot, countLines, makeTempRoot } from '../helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const BASE_TIME = '2026-11-08T10:00:00.000Z';
const NEXT_MONTH = '2026-12-01T10:00:00.000Z';

/** 构造一条事件记录。 */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const base: EventRecord = {
    id: 'evt-1',
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'open',
    closed_reason: null,
    pointers: [{ id: 'exp-1', channel: 'dsh', shard: '2026-11', seq: 0 }],
    time_range: { started_at: BASE_TIME, ended_at: BASE_TIME },
    assembled_at: BASE_TIME,
    summary: null,
    key_points: [],
    anchors: [],
    topic_lines: [],
    summary_quality: 'pending',
    summary_source: null,
    summary_prompt_version: null,
    summary_model: null,
    created_by: 'system',
    created_at: BASE_TIME,
    channel: 'dsh',
    boundary_candidates: [],
  };
  return { ...base, ...overrides };
}

/** 事件目录（临时 dataRoot 下）。 */
function eventsDir(root: string): string {
  return layoutOf(root).events;
}

test('事件日志：按 assembled_at 所在月分片 + manifest 登记', () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(eventsDir(root));
    log.appendVersion(makeEvent({ id: 'a' }));
    log.appendVersion(makeEvent({ id: 'b', assembled_at: NEXT_MONTH }));

    assert.deepEqual(log.shards(), ['2026-11', '2026-12']);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(eventsDir(root), 'manifest.json'), 'utf8'),
    ) as { version: number; months: string[] };
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.months, ['2026-11', '2026-12']);
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：版本推进 —— 同 id 共享、version 递增、当前态 = 最大 version', () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(eventsDir(root));
    const first = log.appendVersion(makeEvent({ id: 'e1', version: 1 }));
    const second = log.appendVersion(makeEvent({ id: 'e1', version: 2, status: 'closed' }));

    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.equal(first.location.shard, '2026-11');
    assert.equal(first.location.seq, 0);
    assert.equal(second.location.seq, 1, '同分片的下一行');

    assert.equal(log.currentOf('e1').version, 2);
    assert.equal(log.currentOf('e1').status, 'closed');
    assert.equal(log.readAllVersions().length, 2);
    assert.equal(log.readAll().length, 1, 'readAll 只给当前态');
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：幂等键是 (id, version) —— 同 id 同 version 重复追加不重写、不报错', () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(eventsDir(root));
    const first = log.appendVersion(makeEvent({ id: 'e1', version: 1 }));
    const again = log.appendVersion(makeEvent({ id: 'e1', version: 1 }));

    assert.equal(again.created, false, '幂等命中不得标记为新写入');
    assert.equal(again.location.shard, first.location.shard);
    assert.equal(again.location.seq, first.location.seq);
    assert.equal(countLines(log.shardFile('2026-11')), 1, '不得重复落盘');
    assert.equal(log.readAllVersions().length, 1);

    // 同 id 不同 version → 正常追加。
    const next = log.appendVersion(makeEvent({ id: 'e1', version: 2 }));
    assert.equal(next.created, true);
    assert.equal(countLines(log.shardFile('2026-11')), 2);
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：versionsOf 按 version 升序，未知 id 返回空数组', () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(eventsDir(root));
    log.appendVersion(makeEvent({ id: 'e1', version: 1 }));
    log.appendVersion(makeEvent({ id: 'e1', version: 2 }));
    log.appendVersion(makeEvent({ id: 'e1', version: 3 }));

    assert.deepEqual(log.versionsOf('e1').map((r) => r.version), [1, 2, 3]);
    assert.deepEqual(log.versionsOf('nope'), []);
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：listByStatus 只列当前态（历史行不算）', () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(eventsDir(root));
    log.appendVersion(makeEvent({ id: 'e1', version: 1, status: 'open' }));
    log.appendVersion(makeEvent({ id: 'e1', version: 2, status: 'closed' }));
    log.appendVersion(makeEvent({ id: 'e2', version: 1, status: 'open' }));

    assert.equal(log.listByStatus('open').length, 1);
    assert.equal(log.listByStatus('open')[0]?.id, 'e2');
    assert.equal(log.listByStatus('closed').length, 1);
    assert.equal(log.listByStatus('closed')[0]?.id, 'e1');
    assert.equal(log.listByStatus('merged').length, 0);
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：readAll 按 (shard, seq) 升序，count 是当前态计数', () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(eventsDir(root));
    log.appendVersion(makeEvent({ id: 'e1', version: 1 }));
    log.appendVersion(makeEvent({ id: 'e2', version: 1 }));
    log.appendVersion(makeEvent({ id: 'e1', version: 2 }));
    log.appendVersion(makeEvent({ id: 'e3', version: 1, assembled_at: NEXT_MONTH }));

    // 当前态按「当前态自己那一行」的落点排序：e1 的当前态是第 3 行（seq=2），
    // 排在 e2（seq=1）之后 —— 写入顺序即当前态的落点顺序。
    assert.deepEqual(log.readAll().map((r) => r.id), ['e2', 'e1', 'e3']);
    assert.equal(log.count(), 3, 'count 是当前态计数，不是历史行数（真源有 4 行）');
    assert.equal(log.readAllVersions().length, 4);
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：退役态留痕 —— merged / split 不删行', () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(eventsDir(root));
    log.appendVersion(makeEvent({ id: 'old', version: 1, status: 'open' }));
    log.appendVersion(makeEvent({ id: 'old', version: 2, status: 'merged', merged_into: 'new' }));
    log.appendVersion(makeEvent({ id: 'old2', version: 1, status: 'split', split_into: ['x', 'y'] }));

    assert.equal(log.readAllVersions().length, 3, '退役态不得删行');
    assert.equal(log.currentOf('old').status, 'merged');
    assert.equal(log.currentOf('old').merged_into, 'new');
    assert.deepEqual(log.currentOf('old2').split_into, ['x', 'y']);
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：坏行抛 CorruptedError（不静默跳过、不返回空）', () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(eventsDir(root));
    log.appendVersion(makeEvent({ id: 'e1' }));

    // 坏 JSON 行。
    fs.appendFileSync(log.shardFile('2026-11'), '{ 这不是 json\n', 'utf8');
    assert.throws(() => log.readAll(), CorruptedError);
    assert.throws(() => log.readAllVersions(), CorruptedError);
    assert.throws(() => log.count(), CorruptedError);
    assert.throws(() => log.reindex(), CorruptedError);

    // JSON 合法但不符合事件契约的行 —— 同样按存储损坏处理。
    fs.writeFileSync(log.shardFile('2026-11'), '{"foo":1}\n', 'utf8');
    assert.throws(() => log.readAll(), CorruptedError);
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：currentOf 对未知 id 抛 NotFoundError', () => {
  const root = makeTempRoot();
  try {
    const log = new EventLog(eventsDir(root));
    assert.throws(() => log.currentOf('nope'), NotFoundError);
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：reindex 后索引与幂等键恢复（进程重启场景）', () => {
  const root = makeTempRoot();
  try {
    const first = new EventLog(eventsDir(root));
    first.appendVersion(makeEvent({ id: 'e1', version: 1 }));
    first.appendVersion(makeEvent({ id: 'e1', version: 2 }));

    // 真实重启 = 旧实例已释放（单写者纪律：同一目录同时只能有一个活实例）。
    first.dispose();

    const restarted = new EventLog(eventsDir(root));
    restarted.reindex();
    assert.equal(restarted.currentOf('e1').version, 2);
    assert.deepEqual(restarted.versionsOf('e1').map((r) => r.version), [1, 2]);
    assert.equal(restarted.count(), 1);

    // 重启后幂等键仍然有效：同 (id, version) 不重写。
    const again = restarted.appendVersion(makeEvent({ id: 'e1', version: 2 }));
    assert.equal(again.created, false);
    assert.equal(countLines(restarted.shardFile('2026-11')), 2);

    // 新版本正常追加，seq 接续。
    const next = restarted.appendVersion(makeEvent({ id: 'e1', version: 3 }));
    assert.equal(next.created, true);
    assert.equal(next.location.seq, 2);
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：单写者纪律 —— 同一目录第二个实例直接抛错；dispose 后可再 new；open() 复用同一实例', () => {
  const root = makeTempRoot();
  try {
    const dir = eventsDir(root);
    const first = new EventLog(dir);

    // 第二次 new 同一目录 → 抛错（两个持有者在构造时就被挡住，不做静默复用）。
    assert.throws(() => new EventLog(dir), ConflictError, '同一目录只能有一个活实例');

    // 规范化：相对路径与绝对路径指向同一目录 → 同样被挡。
    assert.throws(() => new EventLog(path.relative(process.cwd(), dir)), ConflictError);

    // 显式复用出口：open() 拿到的是同一个实例。
    assert.equal(EventLog.open(dir), first, 'open() 是显式复用出口');

    // dispose 后可再次 new（释放 → 重新登记）。
    first.dispose();
    const second = new EventLog(dir);
    assert.notEqual(second, first);
    second.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：探针场景回归 —— 唯一实例下 evt-A / evt-B / evt-A@v2 读回仍是自己的行', () => {
  // 原缺陷：两个实例各写各的 → 第二个实例算出与第一个相同的 seq → 同一 (shard, seq) 落两行
  // → currentOf('evt-A') 静默返回 evt-B 的行。现在两个实例根本构造不出来，
  // 缺陷在根上被消除；这条用例钉住「唯一实例下读回的一定是自己的行」。
  const root = makeTempRoot();
  try {
    const dir = eventsDir(root);
    const log = new EventLog(dir);

    log.appendVersion(makeEvent({ id: 'evt-A' }));
    log.appendVersion(makeEvent({ id: 'evt-B' }));
    log.appendVersion(makeEvent({ id: 'evt-A2' }));

    assert.equal(log.currentOf('evt-A').id, 'evt-A', '必须读回自己的行');
    assert.equal(log.currentOf('evt-B').id, 'evt-B');
    assert.equal(log.currentOf('evt-A2').id, 'evt-A2');
    assert.equal(countLines(log.shardFile('2026-11')), 3, '三行、id 各不相同');
    log.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('事件日志：绕过 EventLog 的外来写入被检出（写前校验 + 读侧兜底），真源未损', () => {
  // 第一层防线（存储层）：内存索引与 nextSeq 都是实例内缓存 —— 任何**绕过 EventLog**
  // 的写入（旁路脚本、外来进程）都会让索引漂移。写前校验（字节数比对，O(1)）拦下写入，
  // 读侧兜底（落点必须仍是它自己）把「静默读到别人的行」变成响亮失败。
  const root = makeTempRoot();
  try {
    const dir = eventsDir(root);
    const log = new EventLog(dir);

    log.appendVersion(makeEvent({ id: 'evt-A' }));
    log.appendVersion(makeEvent({ id: 'evt-B' }));

    // ① 绕过 EventLog 改写真源，且**长度变了** → 字节数漂移 → 写前校验拦下（ConflictError）。
    const file = log.shardFile('2026-11');
    const rows = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    rows[0] = { ...rows[0], id: 'evt-XYZ-longer' };
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    assert.throws(() => log.appendVersion(makeEvent({ id: 'evt-A2' })), ConflictError);
    assert.equal(countLines(file), 2, '被拦下的写不得落盘');

    // ② 外来写入**长度相同**（只换内容）→ 字节数看不出漂移，但读侧兜底能抓到：
    //    索引指向的行不再是自己 → 抛错，不静默返回别人的行。
    const rows2 = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    rows2[0] = { ...rows2[0], id: 'evt-XYZ-long' };
    fs.writeFileSync(file, `${rows2.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    assert.throws(() => log.currentOf('evt-A'), CorruptedError);

    // ③ 真源未损：行数正确；reindex() 重建后索引与真源一致、读得对。
    assert.equal(countLines(file), 2);
    log.reindex();
    assert.equal(log.currentOf('evt-XYZ-long').id, 'evt-XYZ-long');
    assert.equal(log.currentOf('evt-B').id, 'evt-B');
    log.dispose();
  } finally {
    cleanupTempRoot(root);
  }
});

test('冻结面自证：事件日志的方法名与导出名都不触禁词、无删除能力', () => {
  const methodNames = Object.getOwnPropertyNames(EventLog.prototype);
  for (const name of methodNames) {
    assert.equal(isMutatingCapability(name), false, `方法名 ${name} 触冻结面禁词`);
  }

  const file = path.join(repoRoot, 'src', 'source', 'event-log.ts');
  const text = fs.readFileSync(file, 'utf8');
  const exported: string[] = [];
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z0-9_]+)/g)) {
    exported.push(match[1] as string);
  }
  assert.ok(exported.includes('EventLog'), '未扫描到 EventLog 导出');
  for (const name of exported) {
    assert.equal(isMutatingCapability(name), false, `导出名 ${name} 触冻结面禁词`);
  }

  // 基线裁定的九个方法名必须齐备。
  for (const expected of [
    'appendVersion',
    'currentOf',
    'versionsOf',
    'listByStatus',
    'readAll',
    'readAllVersions',
    'count',
    'shards',
    'shardFile',
    'reindex',
  ]) {
    assert.ok(methodNames.includes(expected), `缺少方法 ${expected}`);
  }
});

test('事件日志：落在数据根的 events/ 目录（记事本与记录本平级）', () => {
  const root = makeTempRoot();
  try {
    const layout = layoutOf(root);
    assert.equal(layout.events, path.join(root, 'events'));
  } finally {
    cleanupTempRoot(root);
  }
});
