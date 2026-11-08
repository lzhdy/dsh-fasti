/**
 * 阶段 4 冻结面核验 —— 在**真实数据根的副本**上验证五条冻结面未被破坏。
 *
 * 纪律：
 *  - **绝不写真实数据根**。本脚本把 `~/.dsh/fasti` 复制到临时目录再操作，
 *    真实根只被读取；
 *  - 核验项与 `src/contract/frozen-surface.ts` 的五条一一对应；
 *  - 退出码非 0 表示有核验项失败。
 *
 * 用法：`node scripts/verify-stage4-frozen-surface.ts [--root <真实数据根>]`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Fasti } from '../src/api/index.ts';
import { convertSessionEvent } from '../src/adapters/dsh/convert-event.ts';
import { FROZEN_SURFACE } from '../src/contract/frozen-surface.ts';
import { isUlid } from '../src/core/ulid.ts';

// ── 参数 ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const SOURCE_ROOT =
  rootIndex >= 0 && args[rootIndex + 1] !== undefined
    ? path.resolve(args[rootIndex + 1]!)
    : path.join(os.homedir(), '.dsh', 'fasti');

// ── 小工具 ────────────────────────────────────────────────────────────────

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
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

/** 读 JSONL 文件的全部行。 */
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

/** 读某目录下全部 JSONL 的行。 */
function readAllJsonl(dir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.endsWith('.jsonl')) {
      out.push(...readJsonl(path.join(dir, name)));
    }
  }
  return out;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`真实数据根（只读源）：${SOURCE_ROOT}`);
  if (!fs.existsSync(SOURCE_ROOT)) {
    console.error('真实数据根不存在 —— 请用 --root 指定。');
    process.exit(2);
  }

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-stage4-verify-'));
  console.log(`工作副本（可写）：${workRoot}\n`);

  try {
    copyDir(SOURCE_ROOT, workRoot);

    const fasti = await Fasti.open({ dataRoot: workRoot });

    try {
      const before = {
        raw: readAllJsonl(path.join(workRoot, 'raw-turns')).length,
        exp: readAllJsonl(path.join(workRoot, 'experiences')).length,
      };
      console.log(`副本基线：原文 ${before.raw} 行 / 经历 ${before.exp} 条\n`);

      // ── 冻结面 ①：真源 append-only ───────────────────────────────────
      //     写入一条新数据后，原有行的内容与条数都不变（只增不改）。
      const originalRaw = readAllJsonl(path.join(workRoot, 'raw-turns'));
      const originalExp = readAllJsonl(path.join(workRoot, 'experiences'));

      const converted = convertSessionEvent(
        { id: 'session-verify-1' },
        {
          type: 'user/message',
          time: Date.parse('2026-11-08T12:00:00.000Z'),
          data: {
            id: 'verify-event-1',
            content: [{ type: 'text', text: '冻结面核验用的一句话' }],
            source: { kind: 'user' },
          },
        },
      );
      if (converted.input === null) {
        throw new Error('核验事件转换失败 —— 转换口径有问题');
      }
      const written = await fasti.ingestRawTurn('dsh', converted.input);

      const afterRaw = readAllJsonl(path.join(workRoot, 'raw-turns'));
      const afterExp = readAllJsonl(path.join(workRoot, 'experiences'));

      const rawUnchanged =
        afterRaw.length === originalRaw.length + 1 &&
        originalRaw.every((row, i) => JSON.stringify(row) === JSON.stringify(afterRaw[i]));
      const expUnchanged =
        afterExp.length === originalExp.length + 1 &&
        originalExp.every((row, i) => JSON.stringify(row) === JSON.stringify(afterExp[i]));

      check(
        '冻结面① 真源 append-only（只增不改）',
        rawUnchanged && expUnchanged,
        `原文 ${originalRaw.length} → ${afterRaw.length} 行、经历 ${originalExp.length} → ${afterExp.length} 条；` +
          '既有行逐字节未变',
      );

      // ── 冻结面 ②：ULID + 双定位指针 ─────────────────────────────────
      const pointer = written.observation.text;
      const resolved = await fasti.resolvePointer(pointer!);
      const pointerOk =
        isUlid(written.id) &&
        pointer?.id !== undefined &&
        pointer.channel !== undefined &&
        pointer.shard !== undefined &&
        pointer.seq !== undefined &&
        resolved.turns.length === 1 &&
        resolved.turns[0]?.raw_text === '冻结面核验用的一句话';

      check(
        '冻结面② ULID 稳定 id + 指针双定位',
        pointerOk,
        `id=${written.id}（ULID 合法）；指针 ${pointer?.channel}/${pointer?.shard}#${pointer?.seq} ` +
          `解析回原文「${resolved.turns[0]?.raw_text ?? ''}」`,
      );

      // ── 冻结面 ③：三段槽位 ──────────────────────────────────────────
      const slotsOk =
        typeof written.observation === 'object' &&
        written.observation !== null &&
        written.observation.text !== undefined;
      check(
        '冻结面③ 三段槽位（observation / action / outcome）',
        slotsOk,
        `observation.text 已填（指针）；action/outcome 留空属允许（形状不强制填满）`,
      );

      // ── 冻结面 ④：时间三轴 ──────────────────────────────────────────
      // 三轴各有其位：世界轴（occurred_at）与系统轴（recorded_at）**可以不同** ——
      // 实时摄入时事件时刻与落盘时刻本就是两个时刻，绝不能要求两者相等。
      // 故此处只核「三轴齐备且非空」，两者相等与否由下面的 axesEqual 单独判。
      const axesOk =
        written.occurred_at !== '' &&
        written.recorded_at !== '' &&
        typeof written.tick === 'number';
      const rawRow = afterRaw[afterRaw.length - 1] as { ingested_at?: string } | undefined;
      const axesEqual = rawRow?.ingested_at === written.recorded_at;
      check(
        '冻结面④ 时间三轴（occurred / recorded / tick）',
        axesOk && axesEqual,
        `occurred_at=${written.occurred_at}；recorded_at=${written.recorded_at}；tick=${written.tick}；` +
          `原文 ingested_at 与经历 recorded_at 严格相等=${axesEqual}`,
      );

      // ── 冻结面 ⑤：投影皆可从真源重建 ───────────────────────────────
      const rebuilt = await fasti.rebuildProjections();
      const afterRebuild = await fasti.query({ channel: 'dsh' });
      const rebuildOk =
        rebuilt.reconciliation.rawVsDialogueMatch &&
        afterRebuild.length === before.exp + 1;
      check(
        '冻结面⑤ 投影皆可从真源重建',
        rebuildOk,
        `重建后经历 ${rebuilt.experiences} 条；rawVsDialogueMatch=${rebuilt.reconciliation.rawVsDialogueMatch}；` +
          `通道对账一致=${rebuilt.reconciliation.channelsMatch}`,
      );

      // ── 幂等复核：重放同一事件不得产生新行 ─────────────────────────
      const beforeReplayRaw = readAllJsonl(path.join(workRoot, 'raw-turns')).length;
      const beforeReplayExp = readAllJsonl(path.join(workRoot, 'experiences')).length;
      const replayed = await fasti.ingestRawTurn('dsh', converted.input!);
      const afterReplayRaw = readAllJsonl(path.join(workRoot, 'raw-turns')).length;
      const afterReplayExp = readAllJsonl(path.join(workRoot, 'experiences')).length;
      check(
        '幂等复核：重放同一 event_id 零新增',
        beforeReplayRaw === afterReplayRaw &&
          beforeReplayExp === afterReplayExp &&
          replayed.id === written.id,
        `原文 ${beforeReplayRaw} → ${afterReplayRaw} 行、经历 ${beforeReplayExp} → ${afterReplayExp} 条；` +
          `返回同一经历 ${replayed.id === written.id}`,
      );

      // ── 完整性复核 ──────────────────────────────────────────────────
      const integrity = await fasti.verifyIntegrity();
      check(
        '完整性：content_hash = sha256(raw_text) 全绿',
        integrity.ok,
        `校验 ${integrity.checked} 行，不匹配 ${integrity.mismatched.length} 处`,
      );
    } finally {
      await fasti.close();
    }
  } finally {
    fs.rmSync(workRoot, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n冻结面清单（${FROZEN_SURFACE.length} 条）：`);
  for (const item of FROZEN_SURFACE) {
    console.log(`  - ${item.id}：${item.summary}`);
  }
  console.log(`\n核验结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('核验异常终止：', error);
  process.exit(2);
});
