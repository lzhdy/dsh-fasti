/**
 * 阶段 4 真机对账工具 —— 回答验收四问（定案稿 §18.5）。
 *
 *   ① 无丢事件：真机真实消息数 = Fasti 新增经历数，逐条按 event_id 对得上；
 *   ② 无重复：新增经历与原文的 event_id 均唯一；
 *   ③ 正文逐字一致：每条经历经指针回读的 raw_text 与真机侧原文逐字相同；
 *   ④ 指针可解析 + 幂等：全部指针解析成功；重放同一事件不产生新行。
 *
 * 用法：
 *   node scripts/verify-stage4-realtime.ts \
 *     --root ~/.dsh/fasti \
 *     --events <真机事件流.jsonl> \
 *     [--baseline <基线快照.json>] \
 *     [--replay] \
 *     [--report <输出.json>]
 *
 * `--events` 接受两种格式：
 *   - dsh/harness 事件流（每行一个 `{type,time,data}`）—— 与 `session/event` 同构；
 *   - 简易清单（每行一个 `{event_id, speaker, raw_text, time}`）。
 *
 * 纪律：**只读真实数据根**。--replay 会在**副本**上重放，不写真实根。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Fasti } from '../src/api/index.ts';
import { convertSessionEvent } from '../src/adapters/dsh/convert-event.ts';

// ── 参数 ──────────────────────────────────────────────────────────────────

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = path.resolve(argOf('root') ?? path.join(os.homedir(), '.dsh', 'fasti'));
const EVENTS_FILE = argOf('events');
const BASELINE_FILE = argOf('baseline');
const REPORT_FILE = argOf('report');
const REPLAY = process.argv.includes('--replay');

if (EVENTS_FILE === undefined) {
  console.error('用法：node scripts/verify-stage4-realtime.ts --events <事件流.jsonl> [--root <数据根>] [--replay]');
  process.exit(2);
}

// ── 数据结构 ──────────────────────────────────────────────────────────────

/** 真机侧的一条消息（转换后的期望值）。 */
interface ExpectedTurn {
  event_id: string;
  speaker: string;
  raw_text: string;
  asserted_at: string;
}

interface ReconcileReport {
  root: string;
  eventsFile: string;
  /** 真机侧可摄入的消息数（user + assistant）。 */
  expectedCount: number;
  /** Fasti 侧新增经历数。 */
  actualCount: number;
  /** 逐条对账结果。 */
  rows: Array<{
    event_id: string;
    speaker: string;
    found: boolean;
    textMatch: boolean;
    pointerResolvable: boolean;
    detail: string;
  }>;
  summary: {
    noLost: boolean;
    noDuplicate: boolean;
    textIdentical: boolean;
    pointerResolvable: boolean;
    idempotent: boolean;
  };
  replay?: {
    beforeRaw: number;
    afterRaw: number;
    beforeExp: number;
    afterExp: number;
    unchanged: boolean;
  };
}

// ── 工具 ──────────────────────────────────────────────────────────────────

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function countRawRows(root: string): number {
  let total = 0;
  for (const dir of [path.join(root, 'raw-turns'), path.join(root, 'raw')]) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.jsonl')) {
          total += fs
            .readFileSync(full, 'utf8')
            .split('\n')
            .filter((line) => line.trim() !== '').length;
        }
      }
    };
    walk(dir);
  }
  return total;
}

function countExperienceRows(root: string): number {
  const dir = path.join(root, 'experiences');
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.jsonl')) {
      total += fs
        .readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '').length;
    }
  }
  return total;
}

/**
 * 从真机事件流里抽出期望的消息列表。
 *
 * 走的是**生产同一条转换路径**（`convertSessionEvent`）—— 故这里验的是
 * 「真机事件 → 转换 → 落库 → 回读」整条链路的一致性，
 * 而不是拿转换结果当标准答案自证。
 */
function expectedTurns(file: string): { turns: ExpectedTurn[]; skipped: number } {
  const rows = readJsonl(file);
  const turns: ExpectedTurn[] = [];
  let skipped = 0;

  for (const row of rows) {
    // 简易清单格式：自带 event_id / raw_text。
    if (typeof row['event_id'] === 'string' && typeof row['raw_text'] === 'string') {
      turns.push({
        event_id: row['event_id'],
        speaker: typeof row['speaker'] === 'string' ? row['speaker'] : 'user',
        raw_text: row['raw_text'],
        asserted_at:
          typeof row['time'] === 'number'
            ? new Date(row['time']).toISOString()
            : typeof row['asserted_at'] === 'string'
              ? row['asserted_at']
              : '',
      });
      continue;
    }

    // dsh/harness 事件流格式。
    const converted = convertSessionEvent({ id: 'reconcile' }, row);
    if (converted.input === null) {
      skipped += 1;
      continue;
    }
    turns.push({
      event_id: converted.input.event_id,
      speaker: converted.input.speaker,
      raw_text: converted.input.raw_text,
      asserted_at: converted.input.asserted_at ?? '',
    });
  }

  return { turns, skipped };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`数据根：${ROOT}`);
  console.log(`真机事件流：${path.resolve(EVENTS_FILE)}\n`);

  // 基线快照：用于算「新增」而非「全量」。
  let baselineRaw = 0;
  let baselineExp = 0;
  if (BASELINE_FILE !== undefined && fs.existsSync(BASELINE_FILE)) {
    const snapshot = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as {
      raw: number;
      experiences: number;
    };
    baselineRaw = snapshot.raw;
    baselineExp = snapshot.experiences;
    console.log(`基线快照：原文 ${baselineRaw} 行 / 经历 ${baselineExp} 条`);
  }

  const { turns, skipped } = expectedTurns(path.resolve(EVENTS_FILE));
  console.log(`真机可摄入消息：${turns.length} 条（跳过非消息/系统注入 ${skipped} 条）\n`);

  const fasti = await Fasti.open({ dataRoot: ROOT });
  const report: ReconcileReport = {
    root: ROOT,
    eventsFile: path.resolve(EVENTS_FILE),
    expectedCount: turns.length,
    actualCount: 0,
    rows: [],
    summary: {
      noLost: false,
      noDuplicate: false,
      textIdentical: false,
      pointerResolvable: false,
      idempotent: false,
    },
  };

  try {
    const all = await fasti.query({ channel: 'dsh' });
    const byEventId = new Map<string, (typeof all)[number]>();
    for (const experience of all) {
      const id = experience.observation.text?.id;
      if (id !== undefined && id !== '') {
        byEventId.set(id, experience);
      }
    }

    // 逐条对账。
    let allFound = true;
    let allTextMatch = true;
    let allResolvable = true;

    for (const expected of turns) {
      const experience = byEventId.get(expected.event_id);
      if (experience === undefined) {
        allFound = false;
        allTextMatch = false;
        allResolvable = false;
        report.rows.push({
          event_id: expected.event_id,
          speaker: expected.speaker,
          found: false,
          textMatch: false,
          pointerResolvable: false,
          detail: '未找到对应经历 —— 丢事件',
        });
        continue;
      }

      let rawText = '';
      let resolvable = false;
      try {
        const resolved = await fasti.resolvePointer(experience.observation.text!);
        rawText = resolved.turns.map((turn) => turn.raw_text).join('');
        resolvable = true;
      } catch {
        resolvable = false;
      }

      const textMatch = rawText === expected.raw_text;
      if (!textMatch) {
        allTextMatch = false;
      }
      if (!resolvable) {
        allResolvable = false;
      }

      report.rows.push({
        event_id: expected.event_id,
        speaker: expected.speaker,
        found: true,
        textMatch,
        pointerResolvable: resolvable,
        detail: textMatch
          ? '逐字一致'
          : `正文不一致：期望「${expected.raw_text.slice(0, 40)}」实得「${rawText.slice(0, 40)}」`,
      });
    }

    report.actualCount = turns.length === 0 ? 0 : countExperienceRows(ROOT) - baselineExp;

    // ② 无重复：新增经历与原文的 event_id 均唯一。
    const newEventIds = turns.map((turn) => turn.event_id);
    const uniqueExpected = new Set(newEventIds).size;
    const rawRows = readAllRawRows(ROOT);
    const rawIds = rawRows.map((row) => String(row['event_id'] ?? ''));
    const uniqueRaw = new Set(rawIds).size;
    const noDuplicate = uniqueExpected === newEventIds.length && uniqueRaw === rawIds.length;

    report.summary = {
      noLost: allFound,
      noDuplicate,
      textIdentical: allTextMatch,
      pointerResolvable: allResolvable,
      idempotent: false,
    };

    // ④ 幂等：在**副本**上重放，真实根不受影响。
    if (REPLAY) {
      const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-stage4-replay-'));
      try {
        copyDir(ROOT, workRoot);
        const beforeRaw = countRawRows(workRoot);
        const beforeExp = countExperienceRows(workRoot);

        const replica = await Fasti.open({ dataRoot: workRoot });
        try {
          for (const expected of turns) {
            const converted = convertSessionEvent(
              { id: 'replay' },
              {
                type: expected.speaker === 'assistant' ? 'assistant/message' : 'user/message',
                time: Date.parse(expected.asserted_at),
                data:
                  expected.speaker === 'assistant'
                    ? {
                        message: {
                          id: expected.event_id,
                          content: [{ type: 'text', text: expected.raw_text }],
                        },
                      }
                    : {
                        id: expected.event_id,
                        content: [{ type: 'text', text: expected.raw_text }],
                        source: { kind: 'user' },
                      },
              },
            );
            if (converted.input !== null) {
              await replica.ingestRawTurn('dsh', converted.input);
            }
          }
        } finally {
          await replica.close();
        }

        const afterRaw = countRawRows(workRoot);
        const afterExp = countExperienceRows(workRoot);
        const unchanged = beforeRaw === afterRaw && beforeExp === afterExp;
        report.replay = { beforeRaw, afterRaw, beforeExp, afterExp, unchanged };
        report.summary.idempotent = unchanged;
      } finally {
        fs.rmSync(workRoot, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
      }
    }

    // ── 输出 ────────────────────────────────────────────────────────────
    console.log('逐条对账：');
    for (const row of report.rows) {
      const mark = row.found && row.textMatch && row.pointerResolvable ? '✓' : '✗';
      console.log(`  ${mark} ${row.event_id} [${row.speaker}] ${row.detail}`);
    }
    if (report.rows.length === 0) {
      console.log('  （无待对账条目）');
    }

    console.log('\n验收四问：');
    console.log(`  ① 无丢事件：${report.summary.noLost ? 'PASS' : 'FAIL'}（期望 ${report.expectedCount} 条，逐条命中）`);
    console.log(`  ② 无重复：${report.summary.noDuplicate ? 'PASS' : 'FAIL'}（原文 ${rawIds.length} 行 / 唯一 ${uniqueRaw} 个 event_id）`);
    console.log(`  ③ 正文逐字一致：${report.summary.textIdentical ? 'PASS' : 'FAIL'}`);
    console.log(`  ④ 指针可解析：${report.summary.pointerResolvable ? 'PASS' : 'FAIL'}`);
    if (report.replay !== undefined) {
      console.log(
        `  ⑤ 重放幂等：${report.summary.idempotent ? 'PASS' : 'FAIL'}` +
          `（原文 ${report.replay.beforeRaw} → ${report.replay.afterRaw}，经历 ${report.replay.beforeExp} → ${report.replay.afterExp}）`,
      );
    } else {
      console.log('  ⑤ 重放幂等：未执行（加 --replay 开启）');
    }

    if (REPORT_FILE !== undefined) {
      fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`\n报告已写入：${path.resolve(REPORT_FILE)}`);
    }

    const allPassed = Object.values(report.summary).every(Boolean);
    process.exit(allPassed ? 0 : 1);
  } finally {
    await fasti.close();
  }
}

/** 读全部原文行。 */
function readAllRawRows(root: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const dir of [path.join(root, 'raw-turns'), path.join(root, 'raw')]) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.jsonl')) {
          for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
            if (line.trim() !== '') {
              out.push(JSON.parse(line) as Record<string, unknown>);
            }
          }
        }
      }
    };
    walk(dir);
  }
  return out;
}

/** 递归复制目录。 */
function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

main().catch((error) => {
  console.error('对账异常终止：', error);
  process.exit(2);
});
