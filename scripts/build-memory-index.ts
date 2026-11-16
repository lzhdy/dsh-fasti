/**
 * 记忆层离线构建 CLI —— 方案 §4.11 / §5 流 1（继承 backfill 纪律）。
 *
 * 五条不可违背的纪律：
 *  1. **--data-root 显式必填** —— 缺省打印用法并退出码 2（§11.2），
 *     从参数面杜绝隐式解析到真实数据根；
 *  2. **默认试运行** —— 不传 --apply 只构建影子库（落系统临时目录）并报告 diff，
 *     真实根与 indexDir 零写入；
 *  3. **--apply 二次确认** —— 先预演（dry-run）打印真值指纹与影子 diff，
 *     交互确认 y/yes 才真写；n / EOF / 其他输入一律取消（退出码 0、零写入）；
 *     --yes 供自动化跳过交互，但指纹与 diff 仍先打印（§11.1）；
 *  4. **真值只读** —— 只读 experiences/events 的 JSONL，从不打开 fasti.sqlite；
 *     写入只发生在 projection/memory-index/ 内（影子 tmp → fsync → rename → 账本追加）；
 *  5. **零正文** —— 构建器只搬运已种子卡的内容并回放决策，不生成任何线索文本。
 *
 * 运行（Node ≥ 22，类型剥离直跑，无需构建）：
 *   node scripts/build-memory-index.ts --data-root <临时根>              # 试运行（默认）
 *   node scripts/build-memory-index.ts --data-root <临时根> --apply      # 真写（二次确认）
 *   node scripts/build-memory-index.ts --data-root <临时根> --apply --yes # 真写（自动化）
 *   node scripts/build-memory-index.ts --data-root <临时根> --json       # 机器可读报告
 *   node scripts/build-memory-index.ts --data-root <临时根> --since-revision 3
 *
 * --replay-misses（回放漏召观测）随 C4 的 miss.ts 一起加入，本期不提前接线。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { buildMemoryIndex } from '../src/memory/builder.ts';
import type { BuildReport } from '../src/memory/builder.ts';
import { parseJsonStrict, readFileStrict } from '../src/core/fsx.ts';
import { computeMissTermHash, validateMissInput } from '../src/memory/miss.ts';
import { MEMORY_INDEX_FILE } from '../src/memory/store.ts';
import { openMemoryWrite } from '../src/memory/store.ts';
import type { MissObservationInput } from '../src/memory/types.ts';
import { layoutOf, resolveDataRoot } from '../src/source/paths.ts';

// ── 参数 ──────────────────────────────────────────────────────────────────

interface CliOptions {
  dataRoot: string | undefined;
  apply: boolean;
  yes: boolean;
  sinceRevision: number | undefined;
  replayMisses: string | undefined;
  dumpMiss: string | undefined;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dataRoot: undefined,
    apply: false,
    yes: false,
    sinceRevision: undefined,
    replayMisses: undefined,
    dumpMiss: undefined,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--data-root': {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error('参数 --data-root 缺少取值');
        }
        i += 1;
        options.dataRoot = value;
        break;
      }
      case '--apply':
        options.apply = true;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--since-revision': {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error('参数 --since-revision 缺少取值');
        }
        i += 1;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`参数 --since-revision 必须是 >=1 的整数（收到 ${value}）`);
        }
        options.sinceRevision = parsed;
        break;
      }
      case '--replay-misses': {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error('参数 --replay-misses 缺少取值');
        }
        i += 1;
        options.replayMisses = value;
        break;
      }
      case '--dump-miss': {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error('参数 --dump-miss 缺少取值');
        }
        i += 1;
        options.dumpMiss = value;
        break;
      }
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数 ${arg}`);
    }
  }
  return options;
}

function usage(): string {
  return [
    '用法：node scripts/build-memory-index.ts --data-root <目录> [选项]',
    '',
    '  --data-root <目录>      数据根（**必填**，无缺省 —— 杜绝隐式触碰真实根）',
    '  --apply                 真写：先预演打印真值指纹与影子 diff，二次确认（y/yes）后才写入；',
    '                          n / EOF / 其他输入一律取消（退出码 0、零写入）',
    '  --yes                   与 --apply 联用：跳过交互确认（自动化用；指纹与 diff 仍先打印）',
    '  --since-revision <n>    增量参考（只记入账本 reason，结果仍全量比对，§4.6）',
    '  --replay-misses <file>  独立回放模式：file 为 MissObservationInput 的 JSON 数组；',
    '                          默认 dry-run 只校验并打印行数/term_hash 摘要、零写入、不跑构建流；',
    '                          与 --apply 联用且经二次确认后才经写柄逐条灌入（§4.9）',
    '  --dump-miss <file>      裁剪前取证出口（#117 PF-1 配套）：只读导出 mem_miss 全表为 JSONL，',
    '                          零写库、不跑构建流；先 --dump-miss 再裁剪，才保得住事件级证据',
    '  --json                  输出 JSON 报告（机器可读）',
    '  --help                  本帮助',
    '',
    '纪律：真值只读（从不打开 fasti.sqlite）；写入只发生在 projection/memory-index/；',
    '      零正文 —— 只搬运已种子卡内容并回放决策，不生成线索文本；',
    '      任何一步失败：旧库保持在位、tmp 清理、退出码非零。',
    '',
  ].join('\n');
}

/** 人读的报告。 */
function formatReport(report: BuildReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('  记忆层 v1 · 离线构建报告（C2）');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push(`模式        ：${report.revision === null ? '试运行（真实根零写入）' : '真写'}`);
  lines.push(`输出目录    ：${report.outputDir}`);
  lines.push(`revision    ：${report.revision ?? '（试运行不记账）'}`);
  lines.push(`真值指纹    ：${report.fingerprint.aggregate}`);
  lines.push(`分片数      ：${report.fingerprint.files.length}`);
  lines.push('');
  lines.push('── 影子 diff ───────────────────────────────────────────────────');
  lines.push(`新增卡      ：${report.shadowDiff.added}`);
  lines.push(`移除卡      ：${report.shadowDiff.removed}`);
  lines.push(`变更卡      ：${report.shadowDiff.changed}`);
  lines.push('');
  lines.push('── 规模 ────────────────────────────────────────────────────────');
  lines.push(`卡行数      ：${report.cards}`);
  lines.push(`别名行数    ：${report.aliases}`);
  lines.push(`漏召观测行  ：${report.misses}`);
  const retention = report.missRetention;
  if (retention !== undefined) {
    lines.push('');
    lines.push('── 漏召留存对账（#117）──────────────────────────────────────────');
    lines.push(`观测行      ：${retention.totalBefore} → 保留 ${retention.kept}`);
    lines.push(`超龄淘汰    ：${retention.droppedAgeOut}（窗口 ${retention.windowDays} 天外，自然到期）`);
    lines.push(`窗内超顶裁  ：${retention.rowsDeletedWithinValidationPeriod}`);
    lines.push(`窗口压缩    ：${retention.windowCompressed ? '是（窗口语义已不等于 W 天）' : '否'}`);
    lines.push(`策略        ：${retention.policyVersion}（硬顶 ${retention.hardCapK}）`);
    if (retention.rowsDeletedWithinValidationPeriod > 0 || retention.windowCompressed) {
      lines.push('');
      lines.push(
        `⚠ 高亮：本次会删掉 ${retention.rowsDeletedWithinValidationPeriod} 条仍在验证窗口内的漏召观测` +
          '（已删即毁，不可从真源重导出）。',
      );
      lines.push('  先跑 --dump-miss 导出取证，再执行裁剪。');
    }
  }
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

/** 真写前预演报告：真值指纹 + 影子 diff + 目标 indexDir（§11.1 二次确认的前置打印）。 */
function formatPreview(preview: BuildReport, dataRoot: string): string {
  return [
    '',
    '── 真写前预演（dry-run，尚未写入任何内容）─────────────────────────',
    `真值指纹    ：${preview.fingerprint.aggregate}`,
    `分片数      ：${preview.fingerprint.files.length}`,
    `影子 diff   ：added=${preview.shadowDiff.added} removed=${preview.shadowDiff.removed} changed=${preview.shadowDiff.changed}`,
    `卡/别名/漏召：${preview.cards} / ${preview.aliases} / ${preview.misses}`,
    ...(preview.missRetention === undefined
      ? []
      : [
          `漏召留存    ：保留 ${preview.missRetention.kept}／超龄 ${preview.missRetention.droppedAgeOut}／` +
            `窗内超顶 ${preview.missRetention.rowsDeletedWithinValidationPeriod}` +
            (preview.missRetention.windowCompressed ? '（窗口被压缩）' : ''),
          ...(preview.missRetention.rowsDeletedWithinValidationPeriod > 0
            ? [
                `⚠ 本次真写会删掉 ${preview.missRetention.rowsDeletedWithinValidationPeriod} 条窗内观测；` +
                  '先 --dump-miss 导出取证再继续。',
              ]
            : []),
        ]),
    `目标 indexDir：${path.join(dataRoot, 'projection', 'memory-index')}`,
    '',
  ].join('\n');
}

// ── #117 裁剪前取证：--dump-miss（只读导出，零写库）──────────────────────────

interface DumpMissReport {
  mode: 'dump-miss';
  rows: number;
  file: string;
  indexDir: string;
  columnCount: number;
}

/**
 * 独立取证模式：只读打开库，把 mem_miss 全表按 (observed_ms, id) 升序导出为 JSONL。
 * 纪律：
 *  - 库只以 readOnly 打开，绝不写数据根；
 *  - 输出文件不得落在数据根内（防把取证产物混进真源目录，退出码 1）。
 */
function runDumpMisses(dataRoot: string, outFile: string, options: CliOptions): void {
  const indexDir = path.join(layoutOf(resolveDataRoot({ dataRoot })).projection, 'memory-index');
  const dbFile = path.join(indexDir, MEMORY_INDEX_FILE);
  const root = path.resolve(resolveDataRoot({ dataRoot }));
  const target = path.resolve(outFile);
  if (target.startsWith(`${root}${path.sep}`) || target === root) {
    process.stderr.write(`错误：--dump-miss 输出不得落在数据根内（${target}）\n`);
    process.exit(1);
    return;
  }
  if (!fs.existsSync(dbFile)) {
    process.stderr.write(`错误：记忆索引库不存在，无可导出内容：${dbFile}\n`);
    process.exit(1);
    return;
  }

  const db = new DatabaseSync(dbFile, { readOnly: true });
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare('SELECT * FROM mem_miss ORDER BY observed_ms ASC, id ASC').all() as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(target, rows.length === 0 ? '' : `${body}\n`, 'utf8');

  const report: DumpMissReport = {
    mode: 'dump-miss',
    rows: rows.length,
    file: target,
    indexDir,
    columnCount: rows[0] === undefined ? 0 : Object.keys(rows[0]).length,
  };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : [
          '',
          '── 漏召台账取证（--dump-miss，只读导出）─────────────────────────',
          `行数        ：${report.rows}`,
          `列数        ：${report.columnCount}`,
          `输出文件    ：${report.file}`,
          `来源库      ：${report.indexDir}${MEMORY_INDEX_FILE}`.replace(/\\/g, '/'),
          '库未被写入；该文件是裁剪前唯一的事件级证据留存。',
          '',
        ].join('\n'),
  );
}

// ── C4 漏召回放（H2，独立模式；方案 §4.9）─────────────────────────────────

interface ReplayReport {
  mode: 'replay-misses';
  dryRun: boolean;
  rows: number;
  termHashes: string[];
}

/** 读观测文件 → MissObservationInput[]（缺文件/坏 JSON/非数组/白名单外键 → 退出码 1）。 */
function readObservations(file: string): MissObservationInput[] {
  let raw: unknown;
  try {
    raw = parseJsonStrict(readFileStrict(file), file);
  } catch (error) {
    process.stderr.write(`错误：${(error as Error).message}\n`);
    return process.exit(1);
  }
  if (!Array.isArray(raw)) {
    process.stderr.write('错误：--replay-misses 文件必须是 MissObservationInput 的 JSON 数组\n');
    return process.exit(1);
  }
  const inputs = raw as MissObservationInput[];
  for (const [i, input] of inputs.entries()) {
    try {
      validateMissInput(input);
    } catch (error) {
      process.stderr.write(`错误：第 ${i + 1} 条观测非法：${(error as Error).message}\n`);
      return process.exit(1);
    }
  }
  return inputs;
}

function formatReplayReport(report: ReplayReport): string {
  return [
    '',
    '── 漏召观测回放（--replay-misses，独立模式）─────────────────────',
    `模式        ：${report.dryRun ? '试运行（零写入）' : '真写'}`,
    `行数        ：${report.rows}`,
    `term_hash 集：${report.termHashes.length} 个`,
    ...report.termHashes.map((hash) => `  ${hash}`),
    '',
  ].join('\n');
}

/** 独立回放：默认 dry-run 零写入且不跑构建流；--apply 经既有二次确认后经写柄逐条灌入。 */
async function runReplayMisses(dataRoot: string, file: string, options: CliOptions): Promise<void> {
  const inputs = readObservations(file);
  const termHashes = [...new Set(inputs.map((input) => computeMissTermHash(input.termNorm)))].sort();
  const indexDir = path.join(layoutOf(resolveDataRoot({ dataRoot })).projection, 'memory-index');
  const report: ReplayReport = {
    mode: 'replay-misses',
    dryRun: !options.apply,
    rows: inputs.length,
    termHashes,
  };

  if (!options.apply) {
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReplayReport(report)}\n`,
    );
    return;
  }

  // --apply：预演先打印，二次确认后才真写（沿用构建流确认纪律）。
  const previewStream = options.json ? process.stderr : process.stdout;
  const preview: ReplayReport = { ...report, dryRun: true };
  previewStream.write(`${formatReplayReport(preview)}\n目标 indexDir：${indexDir}\n`);

  if (!options.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: previewStream });
    let answer: string | null;
    try {
      answer = await new Promise<string | null>((resolve) => {
        rl.once('line', (line) => resolve(line));
        rl.once('close', () => resolve(null));
        previewStream.write('确认写入以上漏召观测？(y/N) ');
      });
    } finally {
      rl.close();
    }
    if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
      process.stderr.write('已取消：未写入任何内容。\n');
      return;
    }
  }

  const handle = openMemoryWrite({ indexDir });
  try {
    for (const input of inputs) {
      handle.recordMiss(input);
    }
  } finally {
    await handle.close();
  }
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReplayReport(report)}\n`,
  );
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`错误：${(error as Error).message}\n${usage()}`);
    process.exit(2);
    return;
  }

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  // §11.2：--data-root 缺省 → 用法 + 退出码 2（不做隐式真实根解析）。
  if (options.dataRoot === undefined) {
    process.stderr.write(`错误：必须显式指定 --data-root\n${usage()}`);
    process.exit(2);
    return;
  }

  const dataRoot = options.dataRoot;

  // #117：--dump-miss 取证模式 —— 只读导出，不跑构建流、零写库。
  if (options.dumpMiss !== undefined) {
    runDumpMisses(dataRoot, options.dumpMiss, options);
    return;
  }

  // C4（H2）：--replay-misses 独立回放模式 —— 只灌漏召观测，不跑构建流；未传则构建流字节级不变。
  if (options.replayMisses !== undefined) {
    await runReplayMisses(dataRoot, options.replayMisses, options);
    return;
  }

  const runBuild = async (dryRun: boolean): Promise<BuildReport> => {
    try {
      return await buildMemoryIndex({
        dataRoot,
        dryRun,
        sinceRevision: options.sinceRevision,
      });
    } catch (error) {
      process.stderr.write(`错误：${(error as Error).message}\n`);
      process.exit(1);
    }
  };

  let report: BuildReport;
  if (options.apply) {
    // §11.1：--apply 必须先预演、打印真值指纹与 diff，二次确认后才真写。
    const preview = await runBuild(true);
    // --json 模式：预演与确认走 stderr，stdout 保持纯 JSON。
    const previewStream = options.json ? process.stderr : process.stdout;
    previewStream.write(formatPreview(preview, dataRoot));
    fs.rmSync(preview.outputDir, { recursive: true, force: true });

    if (!options.yes) {
      const rl = readline.createInterface({ input: process.stdin, output: previewStream });
      let answer: string | null;
      try {
        // EOF（close）必须显式收敛为 null —— rl.question 在 stdin 关闭时不会 settle。
        answer = await new Promise<string | null>((resolve) => {
          rl.once('line', (line) => resolve(line));
          rl.once('close', () => resolve(null));
          previewStream.write('确认写入以上变更？(y/N) ');
        });
      } finally {
        rl.close();
      }
      if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
        process.stderr.write('已取消：未写入任何内容。\n');
        return;
      }
    }

    report = await runBuild(false);
  } else {
    report = await runBuild(true);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
}

// 仅在被直接执行时跑 CLI（被测试 import 时不自动执行）。
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}