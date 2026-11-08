/**
 * 接口层端到端测试（审计第四节阶段 1、2 的行为验收）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Fasti } from '../../src/api/index.ts';
import { RawLog } from '../../src/source/raw-log.ts';
import { cleanupTempRoot, makeTempRoot, makeExperience } from '../helpers.ts';

const ID_A = '01J0000000000000000000000A';
const ID_B = '01J0000000000000000000000B';

test('append：分配 recorded_at 与 tick，经验落盘即不可变', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const stored = await fasti.appendExperience(
      makeExperience({ id: ID_A, recorded_at: '2026-11-15T12:00:00.000Z' }),
    );
    assert.equal(stored.id, ID_A);
    assert.equal(stored.recorded_at, '2026-11-15T12:00:00.000Z');
    assert.equal(typeof stored.tick, 'number');

    // 落盘内容与返回一致。
    const file = path.join(root, 'experiences', '2026-11.jsonl');
    const row = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as Record<string, unknown>;
    assert.equal(row['id'], ID_A);
    assert.equal(row['tick'], stored.tick);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('append：未提供 recorded_at 时由 A 分配当前时刻', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const before = Date.now();
    // 显式省略 recorded_at —— 由 A 分配当前时刻。
    const { recorded_at: _omitted, ...withoutRecordedAt } = makeExperience({ id: ID_A });
    const stored = await fasti.appendExperience(withoutRecordedAt);
    const after = Date.now();

    const ms = Date.parse(stored.recorded_at);
    assert.ok(ms >= before - 1000 && ms <= after + 1000, 'recorded_at 应为当前时刻');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('append：同 id 幂等（重试不重复写、不报错）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const first = await fasti.appendExperience(makeExperience({ id: ID_A }));
    const second = await fasti.appendExperience(makeExperience({ id: ID_A }));

    assert.equal(second.id, first.id);
    assert.equal(second.tick, first.tick, '幂等重试返回既有条目（含原 tick）');
    assert.equal((await fasti.query({})).length, 1, '不得二次写入');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('append：tick 单调递增，乱序到达时与 occurred_at 允许不一致', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const a = await fasti.appendExperience(
      makeExperience({ id: ID_A, occurred_at: '2026-11-15T12:00:00.000Z' }),
    );
    const b = await fasti.appendExperience(
      makeExperience({ id: ID_B, occurred_at: '2026-11-15T08:00:00.000Z' }),
    );

    assert.ok((b.tick as number) > (a.tick as number), 'tick 按摄入顺序递增');
    assert.ok(
      Date.parse(b.occurred_at) < Date.parse(a.occurred_at),
      'occurred_at 顺序与 tick 顺序相反 —— 允许',
    );
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('tick 原语：返回已分配的最大节拍序号（审计 Q2 澄清）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    // 空真源：尚未分配过任何 tick。
    assert.equal(await fasti.tick(), -1);
    await fasti.appendExperience(makeExperience({ id: ID_A }));
    // 写入一条（tick=0）后，她所处的节拍是 0 —— 不是「下一个将分配的序号 1」。
    assert.equal(await fasti.tick(), 0);
    await fasti.appendExperience(makeExperience({ id: ID_B }));
    assert.equal(await fasti.tick(), 1);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('query：多维过滤（kind / channel / scene / initiation / time）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience(
      makeExperience({
        id: ID_A,
        kind: 'dialogue',
        scene: { channel: 'dsh', ref: 's-1' },
        initiation: 'user',
        occurred_at: '2026-11-15T12:00:00.000Z',
      }),
    );
    await fasti.appendExperience(
      makeExperience({
        id: ID_B,
        kind: 'perception',
        scene: { channel: 'browser', ref: 'page-1' },
        initiation: 'her',
        occurred_at: '2026-11-15T14:00:00.000Z',
      }),
    );

    assert.equal((await fasti.query({ kind: 'dialogue' })).length, 1);
    assert.equal((await fasti.query({ channel: 'browser' })).length, 1);
    assert.equal((await fasti.query({ scene: 's-1' })).length, 1);
    assert.equal((await fasti.query({ initiation: 'her' })).length, 1);
    assert.equal(
      (await fasti.query({ time: { from: Date.parse('2026-11-15T13:00:00.000Z') } })).length,
      1,
    );
    assert.equal((await fasti.query({})).length, 2);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('search：全文命中并返回原文片段（非摘要）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const rawLog = new RawLog('dsh', path.join(root, 'raw-turns'));
    rawLog.append({
      event_id: 'raw-1',
      speaker: 'user',
      raw_text: '这是一段关于海边的记忆',
      ingested_at: '2026-11-15T12:00:00.000Z',
    });

    await fasti.appendExperience(
      makeExperience({
        id: ID_A,
        observation: { text: { id: 'raw-1', channel: 'dsh', shard: '2026-11', seq: 0 } },
      }),
    );

    const hits = await fasti.search('海边');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, ID_A);
    assert.ok((hits[0]?.snippet ?? '').includes('海边'));
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('resolvePointer：按 id 与按 (shard, seq) 都能定位原文行', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const rawLog = new RawLog('dsh', path.join(root, 'raw-turns'));
    rawLog.append({
      event_id: 'raw-1',
      speaker: 'user',
      raw_text: '第一行',
      ingested_at: '2026-11-15T12:00:00.000Z',
    });
    rawLog.append({
      event_id: 'raw-2',
      speaker: 'user',
      raw_text: '第二行',
      ingested_at: '2026-11-15T12:00:00.000Z',
    });

    const byId = await fasti.resolvePointer({ id: 'raw-2', channel: 'dsh' });
    assert.equal(byId.turns.length, 1);
    assert.equal(byId.turns[0]?.raw_text, '第二行');

    const bySeq = await fasti.resolvePointer({ channel: 'dsh', shard: '2026-11', seq: 0 });
    assert.equal(bySeq.turns[0]?.raw_text, '第一行');

    const byRange = await fasti.resolvePointer({ channel: 'dsh', shard: '2026-11', seq: [0, 1] });
    assert.equal(byRange.turns.length, 2);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('queryEdges：按 src / predicate / dst 查询，返回边行（审计 Q1 澄清）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience(
      makeExperience({
        id: ID_A,
        pointers: [{ type: 'references', target: 'target-x' }],
      }),
    );

    const bySrc = await fasti.queryEdges({ src: ID_A });
    assert.equal(bySrc.length, 1);
    // 返回的是**边本身**：src 指向源经历，dst 是目标，谓词是关系类型。
    assert.equal(bySrc[0]?.src, ID_A);
    assert.equal(bySrc[0]?.predicate, 'references');
    assert.equal(bySrc[0]?.dst, 'target-x');

    const byPredicate = await fasti.queryEdges({ predicate: 'references' });
    assert.equal(byPredicate.length, 1);

    const byDst = await fasti.queryEdges({ dst: 'target-x' });
    assert.equal(byDst.length, 1);

    const asOfBefore = await fasti.queryEdges({ asOf: Date.parse('2000-01-01T00:00:00.000Z') });
    assert.equal(asOfBefore.length, 0, 'as-of 在边生效前不应命中');

    const asOfAfter = await fasti.queryEdges({ asOf: Date.parse('2030-01-01T00:00:00.000Z') });
    assert.equal(asOfAfter.length, 1, 'as-of 在边生效后应命中');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('registerChannel：写入 channels.json，重复注册同内容幂等', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const registered = await fasti.registerChannel({
      id: 'camera',
      label: '摄像头',
      modalities: ['image', 'video'],
      capture: 'notice',
      staging: { retention_days: 3 },
      counterpart: 'world',
      adapter_version: '0.1.0',
    });
    assert.equal(registered.id, 'camera');

    const file = path.join(root, 'channels.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version: number;
      channels: Array<{ id: string }>;
    };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.channels.length, 2);
    assert.deepEqual(parsed.channels.map((c) => c.id).sort(), ['camera', 'dsh']);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('verifyIntegrity：校验原文行 content_hash', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const rawLog = new RawLog('dsh', path.join(root, 'raw-turns'));
    rawLog.append({ event_id: 'raw-1', speaker: 'user', raw_text: '正常内容' });

    const ok = await fasti.verifyIntegrity();
    assert.equal(ok.ok, true);
    assert.equal(ok.checked, 1);
    assert.deepEqual(ok.mismatched, []);

    // 篡改 content_hash → 必须被查出。
    const file = path.join(root, 'raw-turns', '2026-11.jsonl');
    const tampered = fs
      .readFileSync(file, 'utf8')
      .replace(/"content_hash":"[0-9a-f]{64}"/, `"content_hash":"${'0'.repeat(64)}"`);
    fs.writeFileSync(file, tampered, 'utf8');

    const bad = await fasti.verifyIntegrity();
    assert.equal(bad.ok, false);
    assert.equal(bad.mismatched.length, 1);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('verifyChannel：报告注册状态与计数', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience(makeExperience({ id: ID_A }));

    const all = await fasti.verifyChannel();
    const dsh = all.find((item) => item.id === 'dsh');
    assert.ok(dsh);
    assert.equal(dsh.registered, true);
    assert.equal(dsh.experiences, 1);

    const one = await fasti.verifyChannel('dsh');
    assert.equal(one.length, 1);

    const missing = await fasti.verifyChannel('nonexistent');
    assert.equal(missing[0]?.registered, false);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('投影与真源在重建后仍一致（增量 → 重建不丢数据）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.appendExperience(makeExperience({ id: ID_A }));
    await fasti.appendExperience(
      makeExperience({ id: ID_B, kind: 'perception', scene: { channel: 'qq', ref: 'g-1' } }),
    );

    assert.equal((await fasti.query({})).length, 2);

    const rebuilt = await fasti.rebuildProjections();
    assert.equal(rebuilt.experiences, 2);
    assert.equal((await fasti.query({})).length, 2, '重建后数据不丢');
    assert.equal((await fasti.query({ channel: 'qq' })).length, 1);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
