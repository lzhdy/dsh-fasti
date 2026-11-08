/**
 * 旧项目行为契约 · 边界覆盖矩阵（审计第四节阶段 2 验收项：
 * 「node --test 全绿，覆盖 legacy-behavior-contract 第三节边界」）。
 *
 * 覆盖矩阵见 docs/implementation-notes.md。
 * 本文件只覆盖**阶段 0–2 范围内可落地**的边界；
 * 属阶段 4 / B 块的边界在下方以「归属」测试显式记录，不假装覆盖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Fasti } from '../../src/api/index.ts';
import { RawLog } from '../../src/source/raw-log.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const ID = '01J0000000000000000000000A';

/** 边界 1/3/4：空消息、纯空白、超长消息、极短消息、纯 emoji / 纯标点。 */
test('边界 1/3/4：任何形态的原文都原样落盘，不裁剪、不丢弃', async () => {
  const root = makeTempRoot();
  try {
    const rawLog = new RawLog('dsh', path.join(root, 'raw-turns'));
    const payloads: Array<[string, string]> = [
      ['空消息', ''],
      ['纯空白', '   \n\t  '],
      ['超长消息', 'x'.repeat(200_000)],
      ['极短消息', '短'],
      ['纯 emoji', '😀🎉🌊'],
      ['纯标点', '！！！？？'],
    ];

    payloads.forEach(([label, text], index) => {
      rawLog.append({
        event_id: `e${index}`,
        speaker: 'user',
        raw_text: text,
        ingested_at: '2026-11-15T12:00:00.000Z',
      });
      assert.ok(label.length > 0);
    });

    const rows = rawLog.readAll();
    assert.equal(rows.length, payloads.length, '不得因内容形态丢弃任何一行');
    payloads.forEach(([, text], index) => {
      assert.equal(rows[index]?.raw_text, text, `第 ${index} 条内容被改动`);
    });
  } finally {
    cleanupTempRoot(root);
  }
});

/** 边界 7：缺失 event.time / session.id / 消息 id。 */
test('边界 7：缺失 session.id / event.time 时留空，不报错、不丢事件、不伪造当前时间', async () => {
  const root = makeTempRoot();
  try {
    const rawLog = new RawLog('dsh', path.join(root, 'raw-turns'));
    rawLog.append({ event_id: 'e1', speaker: 'user', raw_text: '没有会话与时间' });

    const row = rawLog.readAll()[0];
    assert.equal(row?.session_id, '', 'session_id 缺失留空串');
    assert.equal(row?.asserted_at, '', 'asserted_at 缺失留空，不伪造当前时间');
    assert.notEqual(row?.ingested_at, '', 'ingested_at 由系统维护');
    assert.equal(rawLog.count(), 1, '不丢事件');
  } finally {
    cleanupTempRoot(root);
  }
});

/** 边界 10：重复事件 —— 原文层不去重（10 分钟去重窗口是调用方责任）。 */
test('边界 10：重复事件在原文层不去重（10 分钟窗口内外一律两行）', async () => {
  const root = makeTempRoot();
  try {
    const rawLog = new RawLog('dsh', path.join(root, 'raw-turns'));
    const same = { event_id: 'dup', speaker: 'user', raw_text: '重复的事件' };

    // 窗口内
    rawLog.append({ ...same, ingested_at: '2026-11-15T12:00:00.000Z' });
    rawLog.append({ ...same, ingested_at: '2026-11-15T12:05:00.000Z' });
    // 窗口外
    rawLog.append({ ...same, ingested_at: '2026-11-15T12:20:00.000Z' });

    assert.equal(rawLog.count(), 3, '原文层不去重是旧契约的有意设计');
  } finally {
    cleanupTempRoot(root);
  }
});

/** 边界 12：读失败与损坏文件必须抛出，不静默。 */
test('边界 12：损坏的分片与清单必须抛出，不静默跳过', async () => {
  const root = makeTempRoot();
  try {
    const dir = path.join(root, 'raw-turns');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-11.jsonl'), '{ 坏行 }\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ 坏清单 }\n', 'utf8');

    const log = new RawLog('dsh', dir);
    assert.throws(() => log.readShard('2026-11'), /JSONL 第 1 行解析失败/);
    assert.throws(() => log.shards(), /清单格式非法|JSON 解析失败/);
  } finally {
    cleanupTempRoot(root);
  }
});

/** 边界 11：并发写入同一分片。 */
test('边界 11：并发写入同一分片，分片不损坏', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        fasti.appendExperience({
          id: `01J0000000000000000000${index.toString().padStart(4, '0')}`,
          schema_version: 1,
          kind: 'dialogue',
          scene: { channel: 'dsh', ref: `s-${index}` },
          initiation: 'user',
          observation: { cue: `线索 ${index}` },
          occurred_at: '2026-11-15T12:00:00.000Z',
        }),
      ),
    );

    assert.equal((await fasti.query({})).length, 60);

    const shardDir = path.join(root, 'experiences');
    const shardFile = path.join(shardDir, '2026-11.jsonl');
    const lines = fs.readFileSync(shardFile, 'utf8').split('\n').filter((line) => line.trim() !== '');
    assert.equal(lines.length, 60);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line) as unknown);
    }
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

/** 边界 14：降级模式下的产出标记。 */
test('边界 14：投影降级时产出被显式标注（不静默降级）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root, projectionLevel: 'L3' });
  try {
    assert.equal(fasti.isDegraded, true);
    assert.ok(fasti.degradationReason.length > 0, '降级必须有原因说明');

    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(root, 'state', 'checkpoint.json'), 'utf8'),
    ) as { degraded: boolean; degraded_reason: string; engine: string };
    assert.equal(checkpoint.degraded, true);
    assert.equal(checkpoint.engine, 'L3');
    assert.ok(checkpoint.degraded_reason.length > 0);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

/** 边界 8：跨零点 / 跨月分片。 */
test('边界 8：跨零点与跨月分片 —— 摄入月分片，迟到条目自然落入当前月', async () => {
  const root = makeTempRoot();
  try {
    const rawLog = new RawLog('dsh', path.join(root, 'raw-turns'));
    // 同一分钟内跨本地零点 → 仍落同一分片（分片按月，不按日）。
    rawLog.append({ event_id: 'a', speaker: 'user', raw_text: 'x', ingested_at: '2026-11-15T23:59:59.000Z' });
    rawLog.append({ event_id: 'b', speaker: 'user', raw_text: 'x', ingested_at: '2026-11-16T00:00:01.000Z' });
    assert.equal(rawLog.shards().length, 1, '跨零点不跨分片');

    // 跨月 → 落两个分片。
    rawLog.append({ event_id: 'c', speaker: 'user', raw_text: 'x', ingested_at: '2026-12-15T12:00:00.000Z' });
    assert.equal(rawLog.shards().length, 2, '跨月落两个分片');
  } finally {
    cleanupTempRoot(root);
  }
});

/**
 * 归属说明：以下边界属后续阶段，本阶段**不假装覆盖**。
 *
 * 旧行为契约清单第三节的 14 类边界，按阶段归属如下：
 *  2 斜杠命令            → 阶段 4（DSH 适配器；规则层 B）
 *  5 附件消息 image/offload → 阶段 3+（资产层）/ 阶段 4（适配器）
 *  6 assistant content 形态差异 → 阶段 4（适配器翻写）
 *  9 星期词 / 相对时间表述 → B/C 块（复盘选材、她的日历）
 *  13 LLM 超时 / 非法 JSON / 返回空 → B 块（复盘）
 */
test('归属说明：其余边界明确归属后续阶段，不在本阶段假装覆盖', () => {
  const deferred: Record<string, string> = {
    '斜杠命令': '阶段 4（DSH 适配器）+ B 块规则层',
    '附件消息 / image-offload': '阶段 3+（资产层）与阶段 4（适配器）',
    'assistant content 形态差异': '阶段 4（适配器翻写）',
    '星期词 / 相对时间表述': 'B/C 块（复盘选材、她的日历）',
    'LLM 超时 / 非法 JSON / 返回空': 'B 块（复盘）',
  };

  for (const [boundary, owner] of Object.entries(deferred)) {
    assert.ok(owner.length > 0, `${boundary} 必须写明归属阶段`);
  }

  // 本阶段已覆盖的 9 类：边界 1、3、4、7、8、10、11、12、14。
  const covered = ['1', '3', '4', '7', '8', '10', '11', '12', '14'];
  assert.equal(covered.length, 9);
  assert.equal(Object.keys(deferred).length, 5);
  assert.equal(covered.length + Object.keys(deferred).length, 14, '14 类边界全部有归属');
});
