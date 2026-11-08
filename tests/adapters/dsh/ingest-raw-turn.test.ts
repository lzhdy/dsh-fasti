/**
 * ingestRawTurn 原语的单元测试。
 *
 * 覆盖：写入、指针可解析、三轴、幂等（含重启后）、跨通道隔离、并发安全、冻结面。
 *
 * 纪律：全部用临时数据根，**绝不读写真实数据目录**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Fasti } from '../../../src/api/index.ts';
import { isUlid } from '../../../src/core/ulid.ts';
import { cleanupTempRoot, makeTempRoot } from '../../helpers.ts';

/** 构造一条原文行输入。 */
function turnInput(overrides: Partial<{
  event_id: string;
  session_id: string;
  turn_id: string;
  speaker: string;
  raw_text: string;
  asserted_at: string;
  ingested_at: string;
  occurred_at: string;
}> = {}) {
  return {
    event_id: overrides.event_id ?? 'evt-1',
    session_id: overrides.session_id ?? 'session-1',
    turn_id: overrides.turn_id ?? '',
    speaker: overrides.speaker ?? 'user',
    raw_text: overrides.raw_text ?? '在吗',
    asserted_at: overrides.asserted_at ?? '2026-11-08T10:00:00.000Z',
    ...(overrides.ingested_at === undefined ? {} : { ingested_at: overrides.ingested_at }),
    ...(overrides.occurred_at === undefined ? {} : { occurred_at: overrides.occurred_at }),
  };
}

/** 数某通道的原文行数。 */
function rawLineCount(root: string, channel: string): number {
  const dir = channel === 'dsh' ? path.join(root, 'raw-turns') : path.join(root, 'raw', channel);
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    total += text.split('\n').filter((line) => line.trim() !== '').length;
  }
  return total;
}

/** 数经历条数。 */
function experienceCount(root: string): number {
  const dir = path.join(root, 'experiences');
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    total += text.split('\n').filter((line) => line.trim() !== '').length;
  }
  return total;
}

// ── 基本写入 ──────────────────────────────────────────────────────────────

test('ingestRawTurn：原文 + 经历一并写入', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const experience = await fasti.ingestRawTurn('dsh', turnInput());

    assert.equal(rawLineCount(root, 'dsh'), 1);
    assert.equal(experienceCount(root), 1);
    assert.equal(experience.kind, 'dialogue');
    assert.equal(experience.scene.channel, 'dsh');
    assert.equal(experience.scene.ref, 'session-1');
    assert.equal(experience.initiation, 'user');
    assert.ok(isUlid(experience.id), '经历 id 必须是合法 ULID');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：指针可解析，取回的正文逐字一致', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const text = '在吗在吗\n这是第二行，带标点！';
    const experience = await fasti.ingestRawTurn('dsh', turnInput({ raw_text: text }));

    const resolved = await fasti.resolvePointer(experience.observation.text!);
    assert.equal(resolved.turns.length, 1);
    assert.equal(resolved.turns[0]?.raw_text, text);
    assert.equal(resolved.turns[0]?.event_id, 'evt-1');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：指针的落点与原文层实际位置相符', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const first = await fasti.ingestRawTurn('dsh', turnInput({ event_id: 'evt-a' }));
    const second = await fasti.ingestRawTurn('dsh', turnInput({ event_id: 'evt-b' }));

    assert.equal(first.observation.text?.seq, 0);
    assert.equal(second.observation.text?.seq, 1);
    assert.equal(first.observation.text?.shard, second.observation.text?.shard);
    // 双定位：id 权威 + channel/shard/seq 冗余加速 —— 四元齐全。
    assert.equal(first.observation.text?.id, 'evt-a');
    assert.equal(first.observation.text?.channel, 'dsh');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：时间三轴各归其位（occurred/recorded/tick）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const experience = await fasti.ingestRawTurn('dsh', turnInput({
      asserted_at: '2026-11-08T10:00:00.000Z',
      occurred_at: '2026-11-08T09:59:59.000Z',
    }));

    // 世界轴 = 事件时刻
    assert.equal(experience.occurred_at, '2026-11-08T09:59:59.000Z');
    // 系统轴 = 落盘时刻（真实当下，不是事件时刻）
    assert.notEqual(experience.recorded_at, '2026-11-08T10:00:00.000Z');
    assert.ok(Date.parse(experience.recorded_at) > 0);
    // 节拍轴 = A 分配的摄入序号
    assert.equal(experience.tick, 0);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：occurred_at 缺省时取 asserted_at', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const experience = await fasti.ingestRawTurn('dsh', turnInput({
      asserted_at: '2026-11-08T10:00:00.000Z',
    }));
    assert.equal(experience.occurred_at, '2026-11-08T10:00:00.000Z');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：原文 ingested_at 与经历 recorded_at 严格相等（落盘时刻只算一次）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const experience = await fasti.ingestRawTurn('dsh', turnInput());

    const rawFile = path.join(root, 'raw-turns', '2026-11.jsonl');
    const rawRow = JSON.parse(
      fs.readFileSync(rawFile, 'utf8').split('\n').filter((l) => l.trim() !== '')[0] ?? '{}',
    ) as { ingested_at: string };

    assert.equal(rawRow.ingested_at, experience.recorded_at);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：显式传入 ingested_at 时原文与经历都用它', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const experience = await fasti.ingestRawTurn('dsh', turnInput({
      ingested_at: '2026-11-08T12:00:00.000Z',
    }));
    assert.equal(experience.recorded_at, '2026-11-08T12:00:00.000Z');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：speaker → initiation 映射（assistant → her）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const experience = await fasti.ingestRawTurn('dsh', turnInput({
      event_id: 'evt-a',
      speaker: 'assistant',
    }));
    assert.equal(experience.initiation, 'her');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

// ── 幂等 ──────────────────────────────────────────────────────────────────

test('ingestRawTurn：同一 event_id 重跑零新增（幂等）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const first = await fasti.ingestRawTurn('dsh', turnInput());
    const tickAfterFirst = await fasti.tick();

    const second = await fasti.ingestRawTurn('dsh', turnInput());

    assert.equal(second.id, first.id, '幂等命中应返回既有经历');
    assert.equal(rawLineCount(root, 'dsh'), 1, '原文不得重复写');
    assert.equal(experienceCount(root), 1, '经历不得重复写');
    assert.equal(await fasti.tick(), tickAfterFirst, 'tick 不得增长');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：幂等命中不报错', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.ingestRawTurn('dsh', turnInput());
    await assert.doesNotReject(() => fasti.ingestRawTurn('dsh', turnInput()));
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：进程重启后幂等仍生效（索引从真源恢复）', async () => {
  const root = makeTempRoot();

  const first = await Fasti.open({ dataRoot: root });
  let originalId: string;
  try {
    const experience = await first.ingestRawTurn('dsh', turnInput());
    originalId = experience.id;
  } finally {
    await first.close();
  }

  // 重开同一个数据根 —— 索引必须从真源重建。
  const second = await Fasti.open({ dataRoot: root });
  try {
    const again = await second.ingestRawTurn('dsh', turnInput());
    assert.equal(again.id, originalId);
    assert.equal(rawLineCount(root, 'dsh'), 1, '重启后重放不得重复写原文');
    assert.equal(experienceCount(root), 1, '重启后重放不得重复写经历');
  } finally {
    await second.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：跨通道同 event_id 各自独立成条（键必须带 channel）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.registerChannel({
      id: 'qq',
      label: 'QQ',
      modalities: ['text'],
      capture: 'full',
      adapter_version: '0.1.0',
    });

    const a = await fasti.ingestRawTurn('dsh', turnInput({ event_id: 'shared-id' }));
    const b = await fasti.ingestRawTurn('qq', turnInput({ event_id: 'shared-id' }));

    assert.notEqual(a.id, b.id, '不同通道的同 event_id 应是两条经历');
    assert.equal(rawLineCount(root, 'dsh'), 1);
    assert.equal(rawLineCount(root, 'qq'), 1);
    assert.equal(experienceCount(root), 2);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

// ── 并发 ──────────────────────────────────────────────────────────────────

test('ingestRawTurn：并发摄入同一 event_id 只落一条', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await Promise.all(
      Array.from({ length: 50 }, () => fasti.ingestRawTurn('dsh', turnInput())),
    );

    assert.equal(rawLineCount(root, 'dsh'), 1);
    assert.equal(experienceCount(root), 1);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：并发摄入不同 event_id 全部落盘、seq 连续无洞', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const total = 20;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        fasti.ingestRawTurn('dsh', turnInput({ event_id: `evt-${i}` })),
      ),
    );

    assert.equal(rawLineCount(root, 'dsh'), total);
    assert.equal(experienceCount(root), total);

    // 落点 seq 必须连续（0..total-1），无交叉、无洞。
    const seqs = new Set<number>();
    for (const experience of await fasti.query({ channel: 'dsh' })) {
      const seq = experience.observation.text?.seq;
      seqs.add(typeof seq === 'number' ? seq : -1);
    }
    assert.equal(seqs.size, total);
    for (let i = 0; i < total; i += 1) {
      assert.ok(seqs.has(i), `seq ${i} 缺失`);
    }
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：不自锁（单写者队列内不再二次排队）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    // 若实现里在队列内又调 appendExperience（会再排一次队），这里必然永久挂起。
    const result = await Promise.race([
      fasti.ingestRawTurn('dsh', turnInput()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: 疑似队列自死锁')), 5000)),
    ]);
    assert.equal((result as { id: string }).id.length, 26);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

// ── 冻结面与纪律 ──────────────────────────────────────────────────────────

test('ingestRawTurn：产出的经历满足冻结面（三段槽位 / 三轴 / 双定位 / 无重要性字段）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const experience = await fasti.ingestRawTurn('dsh', turnInput());

    // 三段槽位：observation 存在（action/outcome 留空是允许的 —— 形状不强制填满）。
    assert.equal(typeof experience.observation, 'object');
    // 时间三轴齐全。
    assert.ok(experience.occurred_at !== '');
    assert.ok(experience.recorded_at !== '');
    assert.equal(typeof experience.tick, 'number');
    // 双定位指针四元齐全。
    const pointer = experience.observation.text;
    assert.ok(pointer?.id !== undefined);
    assert.ok(pointer?.channel !== undefined);
    assert.ok(pointer?.shard !== undefined);
    assert.ok(pointer?.seq !== undefined);
    // 无「重要性」类字段（定案稿红线 ②）。
    const forbidden = ['importance', 'salience', 'score', 'weight', 'priority', 'confidence'];
    for (const field of forbidden) {
      assert.ok(!(field in experience), `真源层禁止字段：${field}`);
    }
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：投影可查到该经历，且重建后仍在（冻结面第 5 条）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const experience = await fasti.ingestRawTurn('dsh', turnInput());

    const queried = await fasti.query({ channel: 'dsh', kind: 'dialogue' });
    assert.equal(queried.length, 1);
    assert.equal(queried[0]?.id, experience.id);

    const rebuilt = await fasti.rebuildProjections();
    assert.equal(rebuilt.experiences, 1);
    assert.equal(rebuilt.reconciliation.rawVsDialogueMatch, true);

    const after = await fasti.query({ channel: 'dsh' });
    assert.equal(after.length, 1);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：写入后完整性校验全绿（content_hash = sha256(raw_text)）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.ingestRawTurn('dsh', turnInput({ raw_text: '内容哈希校验' }));

    const report = await fasti.verifyIntegrity();
    assert.equal(report.ok, true);
    assert.equal(report.checked, 1);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：通道未注册时抛错（不静默写进未登记的命名空间）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await assert.rejects(
      () => fasti.ingestRawTurn('not-registered', turnInput()),
      /通道未注册/,
    );
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('ingestRawTurn：公开 appendExperience 行为不变（回归）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const experience = await fasti.appendExperience({
      id: '01J0000000000000000000000A',
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 'session-x' },
      initiation: 'user',
      observation: { cue: '线索' },
      occurred_at: '2026-11-08T10:00:00.000Z',
    });

    assert.equal(experience.tick, 0);
    assert.ok(experience.recorded_at !== '');

    // 同 id 重放 → 幂等返回既有，不重复写。
    const again = await fasti.appendExperience({
      id: '01J0000000000000000000000A',
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 'session-x' },
      initiation: 'user',
      observation: { cue: '线索' },
      occurred_at: '2026-11-08T10:00:00.000Z',
    });
    assert.equal(again.id, experience.id);
    assert.equal(experienceCount(root), 1);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
