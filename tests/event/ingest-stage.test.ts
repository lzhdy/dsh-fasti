/**
 * 摄入后置 stage 契约与接线测试（技术基线 §4 · 任务卡 G01 / T5）。
 *
 * 覆盖：stage 顺序执行、失败隔离、失败可观测（明细 + 检查点计数）、
 * 接线到 ingestRawTurn（真源 append 成功 → 同一写队列任务内同步执行）、
 * stage 失败不阻断摄入、幂等早退不重复切、重启后从事件真源恢复 open 状态。
 *
 * 纪律：全部用临时数据根，**绝不读写真实数据目录**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Fasti } from '../../src/api/index.ts';
import { UnavailableError } from '../../src/core/errors.ts';
import { IngestStageRegistry } from '../../src/event/ingest-stage.ts';
import type { IngestStage, IngestStageContext } from '../../src/event/ingest-stage.ts';
import { layoutOf } from '../../src/source/paths.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

/** 固定的世界轴时刻（不依赖真实当前时间 → 结果确定）。 */
const T0 = '2026-11-08T10:00:00.000Z';
const T1 = '2026-11-08T10:01:00.000Z';
const T2 = '2026-11-08T10:02:00.000Z';

/** 构造一条原文行输入。 */
function turnInput(eventId: string, occurredAt: string) {
  return {
    event_id: eventId,
    session_id: 'session-1',
    speaker: 'user',
    raw_text: `内容 ${eventId}`,
    asserted_at: occurredAt,
    occurred_at: occurredAt,
  };
}

/**
 * 构造一条**长正文**的原文行输入 —— 用于触发 v1.4 的有效对话字数上限。
 *
 * v1.4 设计性改写（定案稿 §9「不做 20 条记录硬上限（退役）」+ 任务书 C3/C4）：
 * 旧用例靠「摄入 20 条 → 撞条数上限 → 事件闭合」来驱动后续断言；
 * 条数上限退役后该触发方式失效，改用**有效对话字数上限**（默认 7000）驱动。
 *
 * 每条正文固定 350 码点 → 每 20 条累计 7000 字，恰好在第 20 条闭合，
 * 与旧用例「每 20 条一个事件」的节奏完全一致，后续断言（事件数、待补计数、
 * 记录条数）无需改动。
 */
function longTurnInput(eventId: string, occurredAt: string) {
  return {
    event_id: eventId,
    session_id: 'session-1',
    speaker: 'user',
    // 固定 350 码点：'字'.repeat(350)。
    raw_text: '字'.repeat(350),
    asserted_at: occurredAt,
    occurred_at: occurredAt,
  };
}

/**
 * 事件真源的全部版本行。
 *
 * `skipMonths` 用于跳过测试自己塞进去的**故意损坏**的分片 ——
 * 那些文件不是 JSON，解析它只会让断言先炸在测试代码里。
 */
function eventRows(root: string, skipMonths: readonly string[] = []): Array<Record<string, unknown>> {
  const dir = layoutOf(root).events;
  if (!fs.existsSync(dir)) {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    if (skipMonths.includes(name.slice(0, -'.jsonl'.length))) {
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

/** 事件真源的当前态（按 id 取最大 version）。 */
function currentEvents(
  root: string,
  skipMonths: readonly string[] = [],
): Array<Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of eventRows(root, skipMonths)) {
    const id = String(row['id']);
    const previous = latest.get(id);
    if (previous === undefined || Number(row['version']) > Number(previous['version'])) {
      latest.set(id, row);
    }
  }
  return [...latest.values()];
}

/** 经历真源的行数（一级真源不该被 stage 影响）。 */
function experienceRows(root: string): number {
  const dir = layoutOf(root).experiences;
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

/** 检查点里的待补摘要数（门面把「读到的真源数字」写进这里；读不到就该原地不动）。 */
function checkpointPendingEvents(root: string): number | undefined {
  const file = path.join(layoutOf(root).state, 'checkpoint.json');
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { pending_events?: number };
  return parsed.pending_events;
}

/** 构造一份 stage 上下文。 */
function makeCtx(): IngestStageContext {
  return {
    experience: {
      id: 'exp-1',
      schema_version: 1,
      kind: 'dialogue',
      scene: { channel: 'dsh', ref: 'session-1' },
      initiation: 'user',
      observation: { cue: '测试线索' },
      occurred_at: T0,
      recorded_at: T0,
      tick: 0,
      char_count: null,
    },
    location: { shard: '2026-11', seq: 0 },
    channel: 'dsh',
    tick: 0,
  };
}

// ── stage 契约 ───────────────────────────────────────────────────────────

test('stage 契约 · 按注册顺序执行全部 stage', async () => {
  const registry = new IngestStageRegistry();
  const order: string[] = [];
  const stage = (name: string): IngestStage => ({
    name,
    run() {
      order.push(name);
    },
  });
  registry.register(stage('first'));
  registry.register(stage('second'));

  const failures = await registry.runAll(makeCtx());
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(failures, [], '全部成功 → 无失败明细');
  assert.equal(registry.list().length, 2);
});

test('stage 契约 · 某个 stage 失败不影响后面的 stage（失败隔离）', async () => {
  const registry = new IngestStageRegistry();
  const ran: string[] = [];
  registry.register({
    name: 'boom',
    run() {
      throw new Error('故意失败');
    },
  });
  registry.register({
    name: 'after',
    run() {
      ran.push('after');
    },
  });

  const failures = await registry.runAll(makeCtx());
  assert.deepEqual(ran, ['after'], '失败不阻断后续 stage');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.stage, 'boom');
});

test('stage 契约 · 失败明细可观测（stage 名 / 经历 id / 通道 / 错误文本）', async () => {
  const registry = new IngestStageRegistry();
  registry.register({
    name: 'boom',
    run() {
      throw new Error('故意失败');
    },
  });

  await registry.runAll(makeCtx());
  const failures = registry.failures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.stage, 'boom');
  assert.equal(failures[0]?.experience_id, 'exp-1');
  assert.equal(failures[0]?.channel, 'dsh');
  assert.equal(failures[0]?.error, '故意失败');
  assert.ok(failures[0]?.at !== undefined && failures[0].at !== '');
});

test('stage 契约 · 失败明细是环形缓冲（只留最近 100 条）', async () => {
  const registry = new IngestStageRegistry();
  registry.register({
    name: 'boom',
    run() {
      throw new Error('总是失败');
    },
  });

  for (let i = 0; i < 105; i += 1) {
    await registry.runAll(makeCtx());
  }
  assert.equal(registry.failures().length, 100, '只保留最近 100 条');
});

// ── 接线（ingestRawTurn → stage → 切分器）────────────────────────────────

test('接线 · ingestRawTurn 经 stage 驱动切分器（事件真源出现事件）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.ingestRawTurn('dsh', turnInput('evt-1', T0));

    const events = currentEvents(root);
    assert.equal(events.length, 1, '一条经历 → 一个 open 事件');
    assert.equal(events[0]?.['status'], 'open');
    assert.equal(events[0]?.['channel'], 'dsh');
    assert.equal((events[0]?.['pointers'] as unknown[]).length, 1);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('接线 · stage 失败不阻断摄入（真源仍落盘、失败可观测、检查点计数）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    fasti.registerIngestStage({
      name: 'boom',
      run() {
        throw new Error('故意失败');
      },
    });

    const experience = await fasti.ingestRawTurn('dsh', turnInput('evt-1', T0));

    // 真源照常落盘（stage 失败不回滚 append-only 日志）。
    assert.equal(experienceRows(root), 1);
    assert.equal(experience.id.length > 0, true);

    // 失败看得见。
    const failures = fasti.ingestStageFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, 'boom');
    assert.equal(failures[0]?.experience_id, experience.id);
    assert.equal(failures[0]?.error, '故意失败');

    // 持久计数进检查点（跨重启可见）。
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(root, 'state', 'checkpoint.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(checkpoint['stage_failures'], 1);
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('接线 · 幂等早退不重复切（重放同一 raw turn 不再切一刀）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const first = await fasti.ingestRawTurn('dsh', turnInput('evt-1', T0));
    const second = await fasti.ingestRawTurn('dsh', turnInput('evt-1', T0));

    assert.equal(second.id, first.id, '同 id 视为重试');
    assert.equal(currentEvents(root).length, 1, '不产生第二个事件');
    assert.equal(eventRows(root).length, 1, '不产生第二个版本行');
    assert.equal(
      (currentEvents(root)[0]?.['pointers'] as unknown[]).length,
      1,
      '事件里只有一条记录（没被切第二刀）',
    );
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('接线 · 重启后从事件真源恢复 open 状态（不重建已切好的事件）', async () => {
  const root = makeTempRoot();
  const first = await Fasti.open({ dataRoot: root });
  try {
    await first.ingestRawTurn('dsh', turnInput('evt-1', T0));
    await first.ingestRawTurn('dsh', turnInput('evt-2', T1));
  } finally {
    await first.close();
  }

  // 重启：open 状态只能来自事件真源。
  const second = await Fasti.open({ dataRoot: root });
  try {
    await second.ingestRawTurn('dsh', turnInput('evt-3', T2));

    const events = currentEvents(root);
    assert.equal(events.length, 1, '恢复后并入原事件，而不是从头切一遍');
    assert.equal((events[0]?.['pointers'] as unknown[]).length, 3);
    assert.equal(Number(events[0]?.['version']), 3, '新建 1 版 + 两次并入各 1 版');
  } finally {
    await second.close();
    cleanupTempRoot(root);
  }
});

// ── 事件层降级（真源损坏不得让整个门面开不起来）──────────────────────────

test('降级 · 事件真源损坏 → 门面照常打开、事件层明确不可用，记录本不受影响', async () => {
  const root = makeTempRoot();
  // 先在 events/ 里放一个**已登记**的坏分片（模拟真源损坏）。
  const eventsDir = layoutOf(root).events;
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.writeFileSync(
    path.join(eventsDir, 'manifest.json'),
    `${JSON.stringify({ version: 1, months: ['2026-11'] }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(eventsDir, '2026-11.jsonl'), '{ 这不是 JSON }\n', 'utf8');

  // 事件是二级真源：坏的是它，不该让整个数据根打不开（记录本才是唯一权威）。
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    const status = fasti.eventLayerStatus();
    assert.equal(status.available, false, '事件层必须明确不可用（绝不静默）');
    assert.ok(status.reason.length > 0, '必须给出原因');

    // 记录本照常读写。
    const experience = await fasti.ingestRawTurn('dsh', turnInput('evt-1', T0));
    assert.ok(experience.id.length > 0);
    assert.equal(experienceRows(root), 1);

    // 事件相关原语抛 UnavailableError（不是空、不是静默降级）。
    assert.throws(() => fasti.requireEventLog(), UnavailableError);

    // 失败可观测：stage 明细里能看到「事件层不可用」。
    const failures = fasti.ingestStageFailures();
    assert.ok(failures.length >= 1, '降级必须留下可观测的失败明细');
    assert.ok((failures[0]?.error ?? '').includes('事件层不可用'));
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

// ── m5：诊断计数失败既不静默、也不刷屏 ────────────────────────────────────

test('诊断 · 待补摘要数读取失败 → 首次告警、之后不刷屏，且不毁一级真源（m5）', async () => {
  const root = makeTempRoot();
  const warnings: string[] = [];

  const fasti = await Fasti.open({
    dataRoot: root,
    onDiagnostic: (_level, message) => warnings.push(message),
  });
  try {
    // 阶段一：一切正常时，摄入 20 条把第一个事件关掉 → 待补计数刷新成功。
    for (let index = 0; index < 20; index += 1) {
      await fasti.ingestRawTurn('dsh', longTurnInput(`evt-a-${index}`, T0));
    }
    assert.equal(warnings.length, 0, '正常路径不该有任何告警');
    // 刷新成功过：第一个闭合事件的待补数已经写进检查点（这是后面「没再写进去」的基准）。
    assert.equal(checkpointPendingEvents(root), 1, '正常路径下检查点要跟上真源');

    // 阶段二：制造真源损坏 —— 塞一个**已登记**的坏分片。
    // 注意必须挑一个**不正在写**的分片：碰正在写的那个会先撞「索引漂移」写入闸，
    // 那样测到的是另一条纪律，不是 m5 的诊断告警。
    const eventsDir = layoutOf(root).events;
    fs.writeFileSync(path.join(eventsDir, '2019-01.jsonl'), '{ 这不是 JSON }\n', 'utf8');
    const manifestFile = path.join(eventsDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { months: string[] };
    manifest.months.push('2019-01');
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    // 阶段三：再摄入 20 条 → 第二个事件闭合 → 刷新待补数时读到坏分片。
    for (let index = 0; index < 20; index += 1) {
      await fasti.ingestRawTurn('dsh', longTurnInput(`evt-b-${index}`, T0));
    }
    assert.equal(warnings.length, 1, `首次失败必须告警一次（实际 ${warnings.length} 次）`);
    assert.match(warnings[0] ?? '', /待补摘要数读取失败/);
    assert.match(warnings[0] ?? '', /第 1 次/, '要带上累计次数，否则看不出「一直在坏」');
    // 证明这条路径真的走了「读失败」：第二个事件也闭合了，但检查点没跟上（还是 1，不是 2）。
    // 没有这一条，下面「不刷屏」的断言可能是空过（比如事件压根没闭合、压根没刷新）。
    assert.equal(checkpointPendingEvents(root), 1, '读失败时不得把过期的计数写进检查点');

    // 阶段四：继续坏 → 不刷屏（第 2 次起不再逐次告警）。
    for (let index = 0; index < 20; index += 1) {
      await fasti.ingestRawTurn('dsh', longTurnInput(`evt-c-${index}`, T0));
    }
    assert.equal(warnings.length, 1, '同一故障重复发生时不该逐次刷屏');
    assert.equal(checkpointPendingEvents(root), 1, '第二次失败同样不该写计数');

    // 诊断计数不得毁掉一级真源（裁定 11）：即使待补数读不出来，摄入照常落盘。
    assert.equal(experienceRows(root), 60);
    // 事件层自身也照常（坏的是那个外来分片，不牵连正在写的分片）。
    assert.equal(currentEvents(root, ['2019-01']).length, 3, '三个事件都该真的落盘');
    assert.equal(fasti.eventLayerStatus().available, true, '这里坏的是旁路分片，不是打开时的自检');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
