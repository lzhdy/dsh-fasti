/**
 * #121 离线影子回放 CLI（影子观测端口的第一个调用方）。
 *
 * 读题库 JSONL，逐条调装配面 `rt.observeShadow({ text, atMs, limit })`，把无原文影子观测
 * 追加到 `<数据根>/projection/memory-shadow/shadow-observations.jsonl`。脚本自身不做任何门裁决、
 * 不复刻字段，全部经 #121 观测端口同一份实现，保证离线样本与线上 shadow 工具口径零漂移。
 *
 * 安全纪律（继承 build/audit CLI）：
 *  - --data-root / --questions 必填，缺省或参数非法打印用法并 exit 2；
 *  - 默认 dry-run：只校验题库与索引就绪、打印拟回放条数，**一条不写、不侧建影子目录**；
 *    必须显式 --apply 才落盘；
 *  - 只触投影层：读 memory-index（抄本）跑门、append 写 memory-shadow（抄本），
 *    正本 raw-turns/experiences/events/channels.json 一个字节不碰；
 *  - 时间强制显式：每题给 at(ISO)/atMs，或统一 --base-at 后按行号×--step-ms 确定性递增，
 *    脚本不读系统时钟，回放可逐字节复现；
 *  - 观测 append-only 不去重，同词同参再跑各追加一行。
 *
 * 题库每行一个 JSON 对象：
 *   {"text":"提问文本","at":"2026-11-16T09:00:00.000Z"}
 *   {"text":"提问文本","atMs":1763250000000,"limit":5}
 *
 * 运行（Node ≥ 22，类型剥离直跑）：
 *   node scripts/replay-shadow-observations.ts --data-root <根> --questions <题库.jsonl>
 *   node scripts/replay-shadow-observations.ts --data-root <根> --questions <题库.jsonl> \
 *     --base-at 2026-11-16T01:00:00.000Z --apply
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { openAssembledMemoryTools } from '../src/assembly/host-tool-runtime.ts';
import { readShadowObservations } from '../src/memory/audit/shadow-read.ts';
import { layoutOf } from '../src/source/paths.ts';

/** 行内缺时间且给了 --base-at 时，相邻题目的默认间隔（毫秒）。 */
export const DEFAULT_STEP_MS = 1000;

/**
 * 端口不写 mem_miss、也不消费 missChannel，此常量仅用于满足装配入参；
 * 固定取值并显式注释，避免在离线脚本里误引入通道字面量发散。
 */
const REPLAY_CHANNEL = 'dsh';

/** 归一后的单条回放题：text 原样、atMs 为毫秒、limit 可选。 */
export interface ReplayQuestion {
  readonly text: string;
  readonly atMs: number;
  readonly limit?: number;
}

/** 本次新增切片的三态计数与总量回执。 */
export interface ReplayStatusSummary {
  readonly appended: number;
  readonly totalRows: number;
  readonly byStatus: {
    hit: number;
    abstain: number;
    'no-match': number;
  };
}

export interface ReplayResult {
  readonly applied: boolean;
  readonly requested: number;
  readonly beforeRows: number;
  readonly indexReady: boolean;
  readonly summary?: ReplayStatusSummary;
}

export interface RunReplayOptions {
  readonly dataRoot: string;
  readonly questionsFile: string;
  /** 统一基准时间（毫秒）；题目未自带时间时必填。 */
  readonly baseAtMs?: number;
  readonly stepMs?: number;
  /** 题库未逐题给 limit 时的缺省门限。 */
  readonly limit?: number;
  readonly apply: boolean;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * 解析并校验题库（纯函数、零 IO 之外的副作用）。
 * 空行忽略；题号按有效题目从 1 起计，任何坏行 fail-loud 且信息带题号，绝不静默丢题。
 */
export function parseReplayQuestions(
  rawLines: readonly string[],
  baseAtMs: number | undefined,
  stepMs: number,
  defaultLimit: number | undefined,
): ReplayQuestion[] {
  const questions: ReplayQuestion[] = [];
  let questionIndex = 0;
  for (const raw of rawLines) {
    if (raw.trim() === '') continue;
    const questionNo = questionIndex + 1;
    const fail = (reason: string): Error => new Error(`第 ${questionNo} 题${reason}`);

    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw fail('不是合法 JSON');
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw fail('必须是 JSON 对象');
    }
    const record = obj as Record<string, unknown>;

    if (typeof record.text !== 'string' || record.text.trim() === '') {
      throw fail('text 必须是非空字符串');
    }
    const hasAt = Object.hasOwn(record, 'at');
    const hasAtMs = Object.hasOwn(record, 'atMs');
    if (hasAt && hasAtMs) {
      throw fail('at 与 atMs 只能给一个');
    }

    let atMs: number;
    if (hasAt) {
      if (typeof record.at !== 'string') {
        throw fail('at 必须是 ISO 时间字符串');
      }
      const parsed = Date.parse(record.at);
      if (!Number.isFinite(parsed)) {
        throw fail('at 不是合法 ISO 时间');
      }
      atMs = parsed;
    } else if (hasAtMs) {
      if (!isPositiveInteger(record.atMs)) {
        throw fail('atMs 必须是正整数毫秒');
      }
      atMs = record.atMs;
    } else {
      if (baseAtMs === undefined) {
        throw fail('未给 at/atMs，且未提供 --base-at');
      }
      atMs = baseAtMs + questionIndex * stepMs;
    }

    let limit = defaultLimit;
    if (Object.hasOwn(record, 'limit')) {
      if (!isPositiveInteger(record.limit)) {
        throw fail('limit 必须是正整数');
      }
      limit = record.limit;
    }

    questions.push(limit === undefined ? { text: record.text, atMs } : { text: record.text, atMs, limit });
    questionIndex += 1;
  }
  if (questions.length === 0) {
    throw new Error('题库为空：至少需要一条有效问题');
  }
  return questions;
}

/** 统计本次新增切片（beforeRows 之后的行）的三态分布与文件总量。 */
export function summarizeShadowRows(
  rows: readonly { gatedStatus: 'hit' | 'abstain' | 'no-match' }[],
  beforeRows: number,
): ReplayStatusSummary {
  const added = rows.slice(beforeRows);
  const byStatus = { hit: 0, abstain: 0, 'no-match': 0 };
  for (const item of added) {
    byStatus[item.gatedStatus] += 1;
  }
  return { appended: added.length, totalRows: rows.length, byStatus };
}

/** 主回放编排：装配一次、逐条观测、读回汇总；dry-run 不触 observeShadow。 */
export async function runReplay(options: RunReplayOptions): Promise<ReplayResult> {
  const stepMs = options.stepMs ?? DEFAULT_STEP_MS;
  if (!isPositiveInteger(stepMs)) {
    throw new Error('--step-ms 必须是正整数');
  }
  if (options.limit !== undefined && !isPositiveInteger(options.limit)) {
    throw new Error('--limit 必须是正整数');
  }

  const rawLines = fs.readFileSync(options.questionsFile, 'utf8').split('\n');
  const questions = parseReplayQuestions(rawLines, options.baseAtMs, stepMs, options.limit);
  const indexDir = path.join(layoutOf(options.dataRoot).projection, 'memory-index');
  // observeShadow 的 atMs 全部来自题库；此固定时钟仅满足装配入参，端口路径不读取它。
  const fixedNow = questions[0]!.atMs;

  const runtime = openAssembledMemoryTools({
    indexDir,
    // off 保证除显式 observeShadow 外不可能触发任何门工具副作用（端口本身与 mode 解耦）。
    mode: 'off',
    now: () => fixedNow,
    missChannel: REPLAY_CHANNEL,
  });
  let beforeRows = 0;
  try {
    if (!runtime.indexReady) {
      throw new Error(`记忆索引库未就绪（不存在或无法打开）：${indexDir}`);
    }
    beforeRows = readShadowObservations(indexDir).length;
    if (!options.apply) {
      return { applied: false, requested: questions.length, beforeRows, indexReady: true };
    }
    for (const question of questions) {
      await runtime.observeShadow({ text: question.text, atMs: question.atMs, limit: question.limit });
    }
  } finally {
    await runtime.dispose();
  }

  const afterRows = readShadowObservations(indexDir);
  const summary = summarizeShadowRows(
    afterRows.map((row) => ({ gatedStatus: row.gatedStatus })),
    beforeRows,
  );
  return {
    applied: true,
    requested: questions.length,
    beforeRows,
    indexReady: true,
    summary,
  };
}

// ── CLI 外壳 ─────────────────────────────────────────────────────────────────

interface CliOptions {
  dataRoot?: string;
  questions?: string;
  baseAt?: string;
  stepMs?: number;
  limit?: number;
  apply: boolean;
  help: boolean;
}

function usage(): string {
  return [
    '用法：node scripts/replay-shadow-observations.ts --data-root <目录> --questions <题库.jsonl> [选项]',
    '',
    '  --data-root <目录>  数据根（必填；只读记忆索引、只写影子抄本，不碰正本）',
    '  --questions <文件>  题库 JSONL（必填），每行 {"text","at"|"atMs"[,"limit"]}',
    '  --base-at <ISO>     题目未自带时间时的统一基准时间（与行号×--step-ms 组合）',
    '  --step-ms <整数>    缺省时间间隔毫秒，默认 1000',
    '  --limit <整数>      题库未逐题指定时的缺省门限',
    '  --apply             显式落盘；缺省为 dry-run，只校验不写入',
    '  --help              本帮助',
    '',
    '纪律：默认 dry-run 零写入；影子样本只进 projection/memory-shadow（可丢弃抄本）；',
    '      不读系统时钟，时间全部显式给定；append-only 不去重。',
    '',
  ].join('\n');
}

function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--data-root':
      case '--questions':
      case '--base-at': {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
        i += 1;
        if (arg === '--data-root') options.dataRoot = value;
        else if (arg === '--questions') options.questions = value;
        else options.baseAt = value;
        break;
      }
      case '--step-ms':
      case '--limit': {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
        i += 1;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`参数 ${arg} 必须是正整数`);
        if (arg === '--step-ms') options.stepMs = parsed;
        else options.limit = parsed;
        break;
      }
      case '--apply':
        options.apply = true;
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

const invokedAsMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]!).href;

if (invokedAsMain) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    if (cli.help) {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (cli.dataRoot === undefined || cli.questions === undefined) {
      throw new Error('必须显式指定 --data-root 与 --questions');
    }
    let baseAtMs: number | undefined;
    if (cli.baseAt !== undefined) {
      baseAtMs = Date.parse(cli.baseAt);
      if (!Number.isFinite(baseAtMs)) throw new Error('--base-at 不是合法 ISO 时间');
    }

    const result = await runReplay({
      dataRoot: path.resolve(cli.dataRoot),
      questionsFile: path.resolve(cli.questions),
      baseAtMs,
      stepMs: cli.stepMs,
      limit: cli.limit,
      apply: cli.apply,
    });

    if (!result.applied) {
      process.stdout.write(
        [
          `[dry-run] 题库校验通过，拟回放 ${result.requested} 条；索引就绪（indexReady=${result.indexReady}）。`,
          `影子日志当前 ${result.beforeRows} 行；本次未写入。确认无误后加 --apply 落盘。`,
          '',
        ].join('\n'),
      );
    } else {
      const s = result.summary!;
      process.stdout.write(
        [
          `已追加 ${s.appended} 条影子观测（请求 ${result.requested} 条）。`,
          `三态分布：hit=${s.byStatus.hit} abstain=${s.byStatus.abstain} no-match=${s.byStatus['no-match']}；` +
            `文件总行数 ${s.totalRows}（写前 ${result.beforeRows}）。`,
          '',
        ].join('\n'),
      );
    }
  } catch (error) {
    process.stderr.write(`错误：${(error as Error).message}\n\n${usage()}`);
    process.exit(2);
  }
}
