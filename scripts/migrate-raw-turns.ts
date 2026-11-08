/**
 * 阶段 3 一次性转写脚本 —— 旧根 RawTurn → 新根原文层 + 结构层 Experience + 投影全量重建。
 *
 * 依据：docs/a-block-final-design.md §4.2 / §4.5 / §7 / §9 / §12 / §18.5、
 *      docs/reference/legacy-behavior-contract.md、stage3-migration-task.md。
 *
 * 三条不可违背的属性：
 *  1. 不调任何 LLM、零判断、零提炼 —— 纯机械搬运；
 *  2. 正文一个字不改 —— raw_text 原样写入，content_hash 可校验；
 *  3. 幂等 —— 以 event_id 为主键，重跑只 skipped，不产生重复行。
 *
 * 运行（Node ≥ 22，类型剥离直跑，无需构建）：
 *   node scripts/migrate-raw-turns.ts --dry-run
 *   node scripts/migrate-raw-turns.ts --target <临时根>
 *   node scripts/migrate-raw-turns.ts --source <旧根> --target <新根>
 *
 * 纪律：
 *  - 旧根**全程只读**，永不写入；不删除、不改动旧目录；
 *  - 幂等主键是 event_id，**不是 content_hash**（同文不同事件是真实存在的：
 *    旧数据里有 11 条 assistant 空回复共用同一 hash，误用 hash 去重会删掉真实记录）；
 *  - 异常数据一律告警 + 明确处置，绝不静默伪造时间、绝不静默丢弃；
 *  - 本脚本**不执行删除**（删除是高危动作）—— 回滚只打印指令，由人手动执行。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultUlid } from '../src/core/ulid.ts';
import { contentHashOf } from '../src/core/hash.ts';
import { Fasti } from '../src/api/index.ts';
import { RawLog } from '../src/source/raw-log.ts';
import { layoutOf, rawDirOf } from '../src/source/paths.ts';
import type { DataLayout } from '../src/source/paths.ts';
import type { Experience } from '../src/contract/experience.ts';

// ── 常量 ──────────────────────────────────────────────────────────────────

/** 旧根默认位置。 */
const DEFAULT_SOURCE = path.join(os.homedir(), '.dsh', 'persona-innate');
/** 新根默认位置。 */
const DEFAULT_TARGET = path.join(os.homedir(), '.dsh', 'fasti');
/** 备份目录（与旧项目既有备份约定一致）。 */
const BACKUP_BASE = path.join(os.homedir(), '.dsh', '_backups');
/** 通道 id —— 本次仅转写 dsh 通道。 */
const CHANNEL = 'dsh';
/** 抽样指针解析的条数（首尾各一条 + 中间均匀取样）。 */
const SAMPLE_SIZE = 12;

// ── 类型 ──────────────────────────────────────────────────────────────────

/** 旧根的一条原文记录（8 字段，与旧项目一致）。 */
interface LegacyRawTurn {
  event_id: string;
  session_id: string;
  turn_id: string;
  speaker: string;
  raw_text: string;
  asserted_at: string;
  ingested_at: string;
  content_hash: string;
}

/** 一条告警。 */
interface Warning {
  event_id: string;
  field: string;
  reason: string;
  action: string;
}

/** 幂等扫描结果。 */
interface TargetState {
  /** 已有原文行的 event_id → 该行落点。 */
  rawByEventId: Map<string, { shard: string; seq: number }>;
  /** 已有 Experience 的 observation.text.id 集合。 */
  experienceEventIds: Set<string>;
}

/** 运行统计。 */
interface Stats {
  /** 源记录总数（成功解析的行）。 */
  sourceTotal: number;
  /** 源文件坏行数。 */
  sourceBadLines: number;
  /** 新增（原文 + 经历都写了）。 */
  added: number;
  /** 新增（仅补建经历，原文已存在）。 */
  addedExperienceOnly: number;
  /** 跳过（原文与经历都在）。 */
  skipped: number;
  /** 异常跳过。 */
  anomaliesSkipped: number;
}

/** 运行报告。 */
interface Report {
  mode: 'dry-run' | 'migrate';
  /** 源说明（目录模式为旧根路径；harness 模式为会话文件路径）。 */
  source: string;
  target: string;
  backupDir: string | null;
  stats: Stats;
  warnings: Warning[];
  reconciliation: unknown;
  verification: Record<string, unknown>;
}

// ── 工具 ──────────────────────────────────────────────────────────────────

function fail(message: string): never {
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
}

/** 读 UTF-8 文件。 */
function readText(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** 递归统计目录下的文件数与总字节。 */
function dirStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) {
    return { files, bytes };
  }
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** 递归拷贝目录（备份用）。 */
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

/** 时间戳（文件名安全）。 */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ── 参数解析 ──────────────────────────────────────────────────────────────

interface Options {
  source: string;
  target: string;
  dryRun: boolean;
  rollback: string | null;
  /** 跳过备份（仅用于临时根测试 —— 生产转写必须备份）。 */
  noBackup: boolean;
  /** harness 会话事件流文件（与 --source 互斥）。 */
  sessionFile: string | null;
  /** 仅解析并把结果以 JSON 打到 stdout（不写任何文件）—— 供自测断言解析细节。 */
  dumpParsed: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    source: DEFAULT_SOURCE,
    target: DEFAULT_TARGET,
    dryRun: false,
    rollback: null,
    noBackup: false,
    sessionFile: null,
    dumpParsed: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        fail(`参数 ${arg} 缺少取值`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--source':
        options.source = path.resolve(next());
        break;
      case '--target':
        options.target = path.resolve(next());
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--rollback':
        options.rollback = path.resolve(next());
        break;
      case '--no-backup':
        options.noBackup = true;
        break;
      case '--session-file':
        options.sessionFile = path.resolve(next());
        break;
      case '--dump-parsed':
        options.dumpParsed = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(usage());
        process.exit(0);
        break;
      default:
        fail(`未知参数 ${arg}\n${usage()}`);
    }
  }

  return options;
}

function usage(): string {
  return [
    '用法：node scripts/migrate-raw-turns.ts [选项]',
    '',
    '  --source <旧根>     旧数据根（默认 ~/.dsh/persona-innate，只读）',
    '  --target <新根>     新数据根（默认 ~/.dsh/fasti）',
    '  --session-file <文件>  harness 会话事件流文件（与 --source 互斥）',
    '  --dry-run           只打印计划，不写任何文件',
    '  --rollback <备份目录>  打印还原指令（不执行删除）',
    '  --no-backup        跳过备份（仅限临时根测试；生产转写必须备份）',
    '  --dump-parsed      仅解析并输出 JSON（不写文件，供自测断言解析细节）',
    '',
  ].join('\n');
}

// ── 读取旧根 ──────────────────────────────────────────────────────────────

interface SourceRecord {
  turn: LegacyRawTurn;
  /** 源文件内行号（1 起算），用于稳定排序的次级键。 */
  lineNo: number;
}

/** 旧根原文层目录。 */
function sourceRawDir(source: string): string {
  return path.join(source, 'raw-turns');
}

/**
 * 读旧根全部原文记录。
 *
 * 坏行不静默丢弃 —— 记入 warnings 并计入 badLines。
 */
function readSource(source: string): { records: SourceRecord[]; badLines: number; warnings: Warning[] } {
  const dir = sourceRawDir(source);
  if (!fs.existsSync(dir)) {
    fail(`旧根原文层不存在：${dir}`);
  }

  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();

  const records: SourceRecord[] = [];
  const warnings: Warning[] = [];
  let badLines = 0;

  for (const name of files) {
    const file = path.join(dir, name);
    const lines = readText(file).split(/\r?\n/);

    lines.forEach((line, index) => {
      if (line.trim() === '') {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        badLines += 1;
        warnings.push({
          event_id: `${name}:${index + 1}`,
          field: '(整行)',
          reason: `JSON 解析失败：${(error as Error).message}`,
          action: '跳过该行（不写入原文、不建经历）',
        });
        return;
      }

      const turn = parsed as Partial<LegacyRawTurn>;

      if (typeof turn.event_id !== 'string' || turn.event_id === '') {
        badLines += 1;
        warnings.push({
          event_id: `${name}:${index + 1}`,
          field: 'event_id',
          reason: 'event_id 缺失或为空 —— 无法建立幂等键',
          action: '跳过该行',
        });
        return;
      }

      records.push({
        turn: {
          event_id: turn.event_id,
          session_id: typeof turn.session_id === 'string' ? turn.session_id : '',
          turn_id: typeof turn.turn_id === 'string' ? turn.turn_id : '',
          speaker: typeof turn.speaker === 'string' ? turn.speaker : '',
          raw_text: typeof turn.raw_text === 'string' ? turn.raw_text : '',
          asserted_at: typeof turn.asserted_at === 'string' ? turn.asserted_at : '',
          ingested_at: typeof turn.ingested_at === 'string' ? turn.ingested_at : '',
          content_hash: typeof turn.content_hash === 'string' ? turn.content_hash : '',
        },
        lineNo: index + 1,
      });
    });
  }

  return { records, badLines, warnings };
}

// ── harness 会话事件流 ───────────────────────────────────────────────────

/**
 * 运行时上下文注入的正文特征 —— 逐字复刻旧仓库 `src/raw-turn.ts` 的
 * `RUNTIME_CONTEXT_RE`。
 *
 * 即使 `source.kind === 'user'`，正文以此开头也判定为系统注入并跳过
 * （旧系统 buildRawTurn 的既定口径）。
 */
const RUNTIME_CONTEXT_RE = /^(current runtime context|this snapshot supersedes)/i;

/** 内容块（harness 的 content 数组元素）。 */
interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * content[] 中 type==='text' 块的 text join（user / system 共用）。
 *
 * 逐字复刻旧仓库 `src/raw-turn.ts` 的 `joinTextBlocks`：
 * **用单个空格连接**，再 `.trim()`。
 */
function joinTextBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) {
    return '';
  }
  return blocks
    .filter(
      (b): b is ContentBlock =>
        !!b && typeof b === 'object' && (b as ContentBlock).type === 'text',
    )
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join(' ')
    .trim();
}

/**
 * 助手正文提取 —— 逐字复刻旧仓库 `src/extract.ts` 的 `assistantTextFromBlocks`：
 * **从后往前**找第一条有非空 text 的块，返回**该块的 `.trim()`**（不 join）。
 *
 * 与 user 侧的 join 口径不对称 —— 这是旧系统的既定语义：助手末尾若有
 * reasoning / tool_call 等非表达块，只取最后一个表达块。
 */
function assistantTextFromBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) {
    return null;
  }
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i] as ContentBlock | undefined;
    if (!block) {
      continue;
    }
    const text = block.text;
    if (typeof text === 'string' && text.trim() !== '' && (block.type === 'text' || block.type === undefined)) {
      return text.trim();
    }
  }
  return null;
}

/** harness 事件流里的一条消息事件（只取用到的字段）。 */
interface HarnessMessageEvent {
  type?: unknown;
  time?: unknown;
  data?: {
    id?: unknown;
    content?: unknown;
    source?: { kind?: unknown };
    message?: { id?: unknown; content?: unknown };
  };
}

/**
 * 读 harness 会话事件流 → 标准 RawTurn 记录。
 *
 * 输出与 `readSource` **完全相同的 SourceRecord[] 结构**，
 * 使下游的排序、幂等扫描、写入、重建、对账逻辑零改动复用。
 *
 * 提取规则（与旧仓库 buildRawTurn / rawTextOf 同源）：
 *  - 只取 `user/message` 且 `source.kind === 'user'`、`assistant/message` 两类；
 *  - 明确跳过 runtime-context / time-context / skill-catalog 注入
 *    以及 turn/step/request/command 等所有非消息事件；
 *  - user 正文走 joinTextBlocks，assistant 正文走 assistantTextFromBlocks
 *    （优先 data.message.content，回退 data.content）；
 *  - `ingested_at` 与 `asserted_at` 同值 —— harness 只有一个时间戳，
 *    保留历史时间，不盖「转写当前时刻」、不伪造第二个时间。
 */
function readHarnessSession(file: string): {
  records: SourceRecord[];
  badLines: number;
  warnings: Warning[];
} {
  if (!fs.existsSync(file)) {
    fail(`harness 会话文件不存在：${file}`);
  }

  const warnings: Warning[] = [];
  const records: SourceRecord[] = [];
  let badLines = 0;

  /** 会话 id（来自首行 session 事件），带 `session-` 前缀原样保留。 */
  let sessionId = '';
  /** 已见 id → 首次出现的行号（用于重复检测）。 */
  const seenIds = new Map<string, number>();
  /** 提取成功但正文为空 → 异常跳过计数。 */
  let emptyTextSkipped = 0;

  const lines = readText(file).split(/\r?\n/);

  lines.forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }
    const lineNo = index + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      badLines += 1;
      warnings.push({
        event_id: `${path.basename(file)}:${lineNo}`,
        field: '(整行)',
        reason: `JSON 解析失败：${(error as Error).message}`,
        action: '跳过该行（不写入原文、不建经历）',
      });
      return;
    }

    const event = parsed as HarnessMessageEvent;
    const type = event.type;

    // 首行 session 事件 → 取会话 id（带前缀原样）。
    if (type === 'session') {
      const id = (event as { id?: unknown }).id;
      if (typeof id === 'string' && id !== '') {
        sessionId = id;
      }
      return;
    }

    // 只处理两类消息事件；其余（turn/step/request/command/agent-inbox…）跳过。
    if (type !== 'user/message' && type !== 'assistant/message') {
      return;
    }

    const data = event.data ?? {};

    // user：只取真实用户输入（source.kind === 'user'）；系统注入静默跳过
    // （那是 harness 的正常形态，不是异常，无需告警）。
    if (type === 'user/message' && data.source?.kind !== 'user') {
      return;
    }

    // 正文提取。
    let rawText: string | null;
    if (type === 'user/message') {
      rawText = joinTextBlocks(data.content);
    } else {
      rawText =
        assistantTextFromBlocks(data.message?.content) ?? assistantTextFromBlocks(data.content);
    }

    // 非 text 内容块（image/audio 等）：只取 text 部分，但必须告警 ——
    // 多模态内容未被转写，若静默丢弃就等于悄悄改了她的原话（任务书 4.3）。
    const blocks = type === 'user/message' ? data.content : (data.message?.content ?? data.content);
    if (Array.isArray(blocks)) {
      const nonText = blocks.filter(
        (b) => !(!!b && typeof b === 'object' && (b as ContentBlock).type === 'text'),
      );
      if (nonText.length > 0) {
        const kinds = [...new Set(nonText.map((b) => String((b as ContentBlock).type ?? '(无type)')))];
        warnings.push({
          event_id: `${path.basename(file)}:${lineNo}`,
          field: 'content',
          reason: `含 ${nonText.length} 个非 text 内容块（${kinds.join(', ')}）`,
          action: '只取 text 部分转写；多模态内容未处理（不落字节、不转述）',
        });
      }
    }

    if (rawText === null || rawText === '') {
      emptyTextSkipped += 1;
      warnings.push({
        event_id: `${path.basename(file)}:${lineNo}`,
        field: 'raw_text',
        reason: '消息提取不到任何非空 text',
        action: '跳过该条（不写空正文、不建经历、不伪造内容）',
      });
      return;
    }

    // 运行时上下文二次过滤（与旧系统一致）。
    if (RUNTIME_CONTEXT_RE.test(rawText)) {
      warnings.push({
        event_id: `${path.basename(file)}:${lineNo}`,
        field: 'raw_text',
        reason: '正文命中运行时上下文特征（current runtime context / this snapshot supersedes）',
        action: '跳过该条（与旧系统 buildRawTurn 同口径）',
      });
      return;
    }

    // event_id：user 取 data.id；assistant 取 data.message.id（裸 UUID）。
    const idCandidate = type === 'user/message' ? data.id : data.message?.id;
    if (typeof idCandidate !== 'string' || idCandidate === '') {
      warnings.push({
        event_id: `${path.basename(file)}:${lineNo}`,
        field: 'event_id',
        reason: `${type} 事件缺少 ${type === 'user/message' ? 'data.id' : 'data.message.id'} —— 无法建立幂等键`,
        action: '跳过该条',
      });
      return;
    }

    // 时间：事件顶层 time（毫秒）→ ISO。
    const time = event.time;
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      warnings.push({
        event_id: idCandidate,
        field: 'time',
        reason: '事件缺少有效 time —— 无法确定事件时刻',
        action: '跳过该条（不伪造时间）',
      });
      return;
    }
    const iso = new Date(time).toISOString();

    // 重复 id 检测（自检用；重复不阻断，但必须告警）。
    const firstSeen = seenIds.get(idCandidate);
    if (firstSeen !== undefined) {
      warnings.push({
        event_id: idCandidate,
        field: 'event_id',
        reason: `id 重复：首次出现在第 ${firstSeen} 行`,
        action: '仍然写入（幂等键唯一性由目标根扫描保证），但已告警',
      });
    } else {
      seenIds.set(idCandidate, lineNo);
    }

    records.push({
      turn: {
        event_id: idCandidate,
        session_id: sessionId,
        turn_id: '',
        speaker: type === 'user/message' ? 'user' : 'assistant',
        raw_text: rawText,
        asserted_at: iso,
        // harness 只有一个时间戳 —— 与 asserted_at 同值，保留历史时间。
        ingested_at: iso,
        content_hash: contentHashOf(rawText),
      },
      lineNo,
    });
  });

  // 解析后自检：交替性 / 时间单调性 / id 唯一性。
  if (records.length > 0) {
    // 时间单调性 —— 检查**事件流文件里的先后顺序**是否与事件时间一致。
    //
    // 注意：不能「先按时间排序再查相邻递减」—— 排序后必然非递减，该检查恒为 0（死代码）。
    // 这里比的是**文件顺序**（records 已按 lineNo 递增）与**时间顺序**的偏离。
    let outOfOrder = 0;
    for (let i = 1; i < records.length; i += 1) {
      const prev = records[i - 1];
      const cur = records[i];
      if (prev === undefined || cur === undefined) {
        continue;
      }
      if (Date.parse(cur.turn.asserted_at) < Date.parse(prev.turn.asserted_at)) {
        outOfOrder += 1;
      }
    }
    if (outOfOrder > 0) {
      warnings.push({
        event_id: '(整体)',
        field: 'asserted_at',
        reason: `事件时间与文件顺序不一致（逆序 ${outOfOrder} 处）`,
        action: '已告警；仍按 asserted_at 排序写入（时间序为准）',
      });
    }

    // 时间排序后的基准序列（供交替性检查使用）。
    const byTime = [...records].sort((a, b) => {
      const ta = Date.parse(a.turn.asserted_at);
      const tb = Date.parse(b.turn.asserted_at);
      return ta !== tb ? ta - tb : a.lineNo - b.lineNo;
    });

    // 严格 user/assistant 交替（按事件时间）。
    let alternationBreaks = 0;
    for (let i = 1; i < byTime.length; i += 1) {
      const prev = byTime[i - 1];
      const cur = byTime[i];
      if (prev === undefined || cur === undefined) {
        continue;
      }
      if (prev.turn.speaker === cur.turn.speaker) {
        alternationBreaks += 1;
      }
    }
    if (alternationBreaks > 0) {
      warnings.push({
        event_id: '(整体)',
        field: 'speaker',
        reason: `user/assistant 非严格交替（同方连续 ${alternationBreaks} 处）`,
        action: '已告警；仍按原样写入（不调整顺序、不补齐）',
      });
    }

    if (emptyTextSkipped > 0) {
      warnings.push({
        event_id: '(整体)',
        field: 'raw_text',
        reason: `共 ${emptyTextSkipped} 条消息提取不到非空 text`,
        action: '已跳过（不写空正文）',
      });
    }
  }

  return { records, badLines, warnings };
}

// ── 幂等扫描 ──────────────────────────────────────────────────────────────

/**
 * 扫描目标根现状。
 *
 *  - rawByEventId：已有原文行的 event_id → 落点（供半成品恢复时补建经历）；
 *  - experienceEventIds：已有 Experience 的 observation.text.id 集合。
 */
function scanTarget(target: string): TargetState {
  const rawByEventId = new Map<string, { shard: string; seq: number }>();
  const experienceEventIds = new Set<string>();

  const layout = layoutOf(target);

  // 原文层：raw-turns/ 与 raw/<channel>/ 都要扫（幂等不能只看 dsh）。
  const rawDirs = [layout.rawTurns, path.join(layout.raw)];
  for (const dir of rawDirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((name) => name.endsWith('.jsonl'))
          .sort()
      : [];
    for (const name of files) {
      const shard = name.replace(/\.jsonl$/, '');
      const lines = readText(path.join(dir, name)).split(/\r?\n/);
      lines.forEach((line, seq) => {
        if (line.trim() === '') {
          return;
        }
        try {
          const row = JSON.parse(line) as Partial<LegacyRawTurn>;
          if (typeof row.event_id === 'string' && row.event_id !== '') {
            if (!rawByEventId.has(row.event_id)) {
              rawByEventId.set(row.event_id, { shard, seq });
            }
          }
        } catch {
          // 目标根里的坏行不阻断扫描 —— 幂等判定以能读出的 event_id 为准。
        }
      });
    }
  }

  // 结构层：experiences/*.jsonl
  if (fs.existsSync(layout.experiences)) {
    const files = fs
      .readdirSync(layout.experiences)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
    for (const name of files) {
      const lines = readText(path.join(layout.experiences, name)).split(/\r?\n/);
      for (const line of lines) {
        if (line.trim() === '') {
          continue;
        }
        try {
          const row = JSON.parse(line) as Partial<Experience>;
          const id = row.observation?.text?.id;
          if (typeof id === 'string' && id !== '') {
            experienceEventIds.add(id);
          }
        } catch {
          // 同上：坏行不阻断扫描。
        }
      }
    }
  }

  return { rawByEventId, experienceEventIds };
}

// ── 字段映射 ──────────────────────────────────────────────────────────────

/**
 * speaker → initiation 映射。
 *
 * 开放枚举：未知值原样保留（不报错、不丢事件），只告警。
 * 用户已确认（2026-11-08）：tool 统一映射 environment，不区分 call / result。
 */
const INITIATION_BY_SPEAKER: Record<string, string> = {
  user: 'user',
  assistant: 'her',
  system: 'system',
  tool: 'environment',
};

function mapInitiation(speaker: string, warnings: Warning[], eventId: string): string {
  const mapped = INITIATION_BY_SPEAKER[speaker];
  if (mapped !== undefined) {
    return mapped;
  }
  warnings.push({
    event_id: eventId,
    field: 'speaker',
    reason: `未知 speaker「${speaker}」`,
    action: '原样保留为 initiation（开放枚举，不报错、不丢事件）',
  });
  return speaker;
}

/**
 * 事件的时刻 → occurred_at。
 *
 * asserted_at 优先；缺失时用 ingested_at 兜底；两者都空属异常数据 ——
 * 跳过该条，**不伪造时间**（旧行为契约 1.1：asserted_at 缺失时留空，不伪造当前时间）。
 */
function resolveOccurredAt(
  turn: LegacyRawTurn,
  warnings: Warning[],
): { occurredAt: string } | null {
  if (turn.asserted_at !== '') {
    return { occurredAt: turn.asserted_at };
  }
  if (turn.ingested_at !== '') {
    warnings.push({
      event_id: turn.event_id,
      field: 'asserted_at',
      reason: 'asserted_at 为空',
      action: '用 ingested_at 兜底作为 occurred_at（不伪造当前时间）',
    });
    return { occurredAt: turn.ingested_at };
  }
  warnings.push({
    event_id: turn.event_id,
    field: 'asserted_at/ingested_at',
    reason: 'asserted_at 与 ingested_at 均为空 —— 无法确定事件时刻',
    action: '跳过该条（不写原文、不建经历、不伪造时间）',
  });
  return null;
}

/**
 * 排序键：asserted_at → ingested_at → 源行号。
 *
 * 稳定排序 —— 同一毫秒内多条按原行号，保证重跑得到相同顺序。
 */
function sortKey(record: SourceRecord): { time: number; lineNo: number } {
  const iso = record.turn.asserted_at !== '' ? record.turn.asserted_at : record.turn.ingested_at;
  const ms = Date.parse(iso);
  return { time: Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms, lineNo: record.lineNo };
}

// ── 备份 ──────────────────────────────────────────────────────────────────

interface BackupResult {
  dir: string | null;
  details: Array<{ what: string; from: string; to: string; files: number; bytes: number }>;
}

function backup(source: string, target: string, options: { includeSource: boolean }): BackupResult {
  // 目录名带上目标根标识 —— 不同目标的备份不会混作一堆。
  const targetTag = path.basename(target) || 'target';
  const dir = path.join(BACKUP_BASE, `stage3-pre-migration-${targetTag}-${stamp()}`);
  fs.mkdirSync(dir, { recursive: true });

  const details: BackupResult['details'] = [];

  // 旧根：完整备份（含 raw-turns 与其它状态文件 —— 旧根只读，是数据来源也是证据）。
  // harness 模式下源是单个会话文件、不是旧根 → 不备份旧根。
  if (options.includeSource && fs.existsSync(source)) {
    const to = path.join(dir, 'persona-innate');
    copyDir(source, to);
    const stats = dirStats(to);
    details.push({ what: '旧根', from: source, to, files: stats.files, bytes: stats.bytes });
  }

  // 目标根：仅当已存在时备份（首次转写时不存在）。
  if (fs.existsSync(target)) {
    const to = path.join(dir, 'fasti');
    copyDir(target, to);
    const stats = dirStats(to);
    details.push({ what: '目标根', from: target, to, files: stats.files, bytes: stats.bytes });
  }

  return { dir, details };
}

// ── 转写主流程 ────────────────────────────────────────────────────────────

async function migrate(options: Options): Promise<Report> {
  const warnings: Warning[] = [];

  // 源的显示标签：目录模式是旧根路径；harness 模式是会话文件路径。
  const sourceLabel =
    options.sessionFile !== null ? `harness 会话文件：${options.sessionFile}` : options.source;

  // 1. 读源数据 —— 目录模式（旧根 raw-turns）或 harness 会话事件流模式。
  //    两者产出相同的 SourceRecord[]，下游逻辑完全复用。
  const source =
    options.sessionFile !== null
      ? readHarnessSession(options.sessionFile)
      : readSource(options.source);
  warnings.push(...source.warnings);

  // 2. 全局排序（asserted_at → ingested_at → 源行号）。
  const sorted = [...source.records].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka.time !== kb.time) {
      return ka.time - kb.time;
    }
    return ka.lineNo - kb.lineNo;
  });

  // 3. 幂等扫描。
  const state = scanTarget(options.target);

  const stats: Stats = {
    sourceTotal: sorted.length,
    sourceBadLines: source.badLines,
    added: 0,
    addedExperienceOnly: 0,
    skipped: 0,
    anomaliesSkipped: 0,
  };

  // 4. dry-run：只算计划，不写任何文件。
  if (options.dryRun) {
    for (const record of sorted) {
      const turn = record.turn;
      if (resolveOccurredAt(turn, warnings) === null) {
        stats.anomaliesSkipped += 1;
        continue;
      }
      if (state.experienceEventIds.has(turn.event_id)) {
        stats.skipped += 1;
      } else if (state.rawByEventId.has(turn.event_id)) {
        stats.addedExperienceOnly += 1;
      } else {
        stats.added += 1;
      }
    }

    return {
      mode: 'dry-run',
      source: sourceLabel,
      target: options.target,
      backupDir: null,
      stats,
      warnings,
      reconciliation: null,
      verification: {},
    };
  }

  // 5. 备份（非 dry-run 必做；--no-backup 仅供临时根测试）。
  const backupResult = options.noBackup
    ? { dir: null, details: [] }
    : backup(options.source, options.target, { includeSource: options.sessionFile === null });

  // 6. 打开新根 —— 自动预置 dsh 通道、建目录。
  const fasti = await Fasti.open({ dataRoot: options.target });
  const layout: DataLayout = fasti.paths;
  const rawLog = new RawLog(CHANNEL, rawDirOf(layout, CHANNEL));

  try {
    // 实际写入目标根的 event_id（用于验收抽样 —— 异常跳过的记录没有原文，不该被抽样）。
    const writtenEventIds: string[] = [];

    for (const record of sorted) {
      const turn = record.turn;

      // 6.1 异常数据：空时间 → 跳过，不伪造。
      const occurred = resolveOccurredAt(turn, warnings);
      if (occurred === null) {
        stats.anomaliesSkipped += 1;
        continue;
      }

      // 6.2 幂等判定。
      if (state.experienceEventIds.has(turn.event_id)) {
        stats.skipped += 1;
        continue;
      }

      let location: { shard: string; seq: number };

      if (state.rawByEventId.has(turn.event_id)) {
        // 半成品恢复：原文已在（上次中断），只补建经历，**不重写原文行**。
        location = state.rawByEventId.get(turn.event_id) as { shard: string; seq: number };
        stats.addedExperienceOnly += 1;
        // tick 与 ULID 是摄入序号、append-only：已分配的永不回收，故补建记录排在序列末尾，
        // 与事件时间序脱节。这不是数据异常，但必须让操作者看见。
        warnings.push({
          event_id: turn.event_id,
          field: 'tick/ULID',
          reason: '该记录原文已存在但经历缺失（半成品恢复）',
          action: '只补建经历、不重写原文；其 tick/ULID 排在摄入序列末尾，与事件时间序脱节（append-only 语义，tick 不回收）',
        });
      } else {
        // 6.3 写原文层 —— 同一 RawLog 实例维护分片 seq 连续性。
        const rawInput = {
          event_id: turn.event_id,
          session_id: turn.session_id,
          turn_id: turn.turn_id,
          speaker: turn.speaker,
          raw_text: turn.raw_text,
          asserted_at: turn.asserted_at,
          ingested_at: turn.ingested_at,
          content_hash: turn.content_hash !== '' ? turn.content_hash : contentHashOf(turn.raw_text),
        };
        const loc = rawLog.append(rawInput);
        location = { shard: loc.shard, seq: loc.seq };
        stats.added += 1;
      }

      // 6.4 哈希一致性辅助校验（告警但不阻断 —— 真源只读，旧值照抄不改写）。
      const expectedHash = contentHashOf(turn.raw_text);
      if (turn.content_hash !== '' && turn.content_hash !== expectedHash) {
        warnings.push({
          event_id: turn.event_id,
          field: 'content_hash',
          reason: `旧记录 content_hash（${turn.content_hash}）与 sha256(raw_text)（${expectedHash}）不一致`,
          action: '按旧值原样写入，不改写她的历史；仅告警',
        });
      }

      // 6.5 构造并写入结构层 Experience（tick 由 A 分配，调用方不传）。
      const experience = {
        id: defaultUlid.next(),
        schema_version: 1,
        kind: 'dialogue',
        scene: {
          channel: CHANNEL,
          ref: turn.session_id,
        },
        initiation: mapInitiation(turn.speaker, warnings, turn.event_id),
        observation: {
          text: {
            id: turn.event_id,
            channel: CHANNEL,
            shard: location.shard,
            seq: location.seq,
          },
        },
        occurred_at: occurred.occurredAt,
        recorded_at: turn.ingested_at !== '' ? turn.ingested_at : occurred.occurredAt,
      };

      await fasti.appendExperience(experience);
      writtenEventIds.push(turn.event_id);
    }

    // 7. 投影全量重建 + 对账。
    const rebuilt = await fasti.rebuildProjections();

    // 8. 验收。
    const sourceTextByEventId = new Map(
      sorted.map((record) => [record.turn.event_id, record.turn.raw_text]),
    );
    const verification = await verify(fasti, writtenEventIds, sourceTextByEventId, warnings);

    return {
      mode: 'migrate',
      source: sourceLabel,
      target: options.target,
      backupDir: backupResult.dir,
      stats,
      warnings,
      reconciliation: rebuilt.reconciliation,
      verification,
    };
  } finally {
    await fasti.close();
  }
}

// ── 验收 ──────────────────────────────────────────────────────────────────

async function verify(
  fasti: Fasti,
  writtenEventIds: string[],
  sourceTextByEventId: Map<string, string>,
  warnings: Warning[],
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  // 8.1 指针抽样解析 —— 取回的 raw_text 必须与旧记录逐字符相同。
  //
  // 抽样**只针对实际写入的记录**：异常跳过的记录（如空时间）本就没有原文，
  // 拿它去解析指针必然失败，会把「异常已正确处置」误判成「验收失败」。
  const total = writtenEventIds.length;
  const indexes = new Set<number>();
  if (total > 0) {
    indexes.add(0);
    indexes.add(total - 1);
    const step = Math.max(1, Math.floor(total / SAMPLE_SIZE));
    for (let i = 0; i < total; i += step) {
      indexes.add(i);
    }
  }

  let pointerChecked = 0;
  const pointerMismatches: Array<{ event_id: string; reason: string }> = [];

  for (const index of [...indexes].sort((a, b) => a - b)) {
    const eventId = writtenEventIds[index];
    if (eventId === undefined) {
      continue;
    }
    try {
      const resolved = await fasti.resolvePointer({ id: eventId, channel: CHANNEL });
      const text = resolved.turns.map((turn) => turn.raw_text).join('');
      if (text !== sourceTextByEventId.get(eventId)) {
        pointerMismatches.push({ event_id: eventId, reason: '取回的正文与旧记录不一致' });
      }
      pointerChecked += 1;
    } catch (error) {
      pointerMismatches.push({ event_id: eventId, reason: (error as Error).message });
    }
  }

  result.pointerSample = {
    sampled: pointerChecked,
    mismatches: pointerMismatches,
    ok: pointerMismatches.length === 0,
  };


  // 8.2 哈希抽验。
  const integrity = await fasti.verifyIntegrity();
  result.integrity = { checked: integrity.checked, mismatched: integrity.mismatched.length, ok: integrity.ok };

  // 8.3 通道对账。
  const channels = await fasti.verifyChannel(CHANNEL);
  result.channel = channels[0] ?? null;

  // 8.4 排序与单调性。
  const experiences = await fasti.query({ channel: CHANNEL, limit: 10_000 });

  // 8.1b 指针 id 与目标行 event_id 的**独立一致性**校验。
  //
  // 为什么不依赖「解析成功」就够了：双定位里 shard/seq 是冗余加速路径，
  // 即便 id 写错，seq 仍可能指向正确行 → 解析照样成功 → 缺陷被掩盖。
  // 这里显式比对「指针 id」与「取回行的 event_id」，确保 id 权威路径真的正确。
  const idMismatches: Array<{ pointer_id: string; row_event_id: string }> = [];
  let idChecked = 0;
  for (const experience of experiences) {
    const pointer = experience.observation.text;
    if (pointer === undefined || pointer.id === undefined) {
      continue;
    }
    try {
      const resolved = await fasti.resolvePointer({ id: pointer.id, channel: CHANNEL });
      const row = resolved.turns[0];
      if (row === undefined) {
        idMismatches.push({ pointer_id: pointer.id, row_event_id: '(未取到行)' });
        continue;
      }
      if (row.event_id !== pointer.id) {
        idMismatches.push({ pointer_id: pointer.id, row_event_id: row.event_id });
      }
      idChecked += 1;
    } catch (error) {
      idMismatches.push({ pointer_id: pointer.id, row_event_id: `(解析失败：${(error as Error).message})` });
    }
  }
  result.pointerIdConsistency = {
    checked: idChecked,
    mismatches: idMismatches.length,
    detail: idMismatches.slice(0, 5),
    ok: idMismatches.length === 0,
  };
  let tickMonotonic = true;
  let ulidMonotonic = true;
  let occurredNonDecreasing = true;
  for (let i = 1; i < experiences.length; i += 1) {
    const prev = experiences[i - 1];
    const cur = experiences[i];
    if (prev === undefined || cur === undefined) {
      continue;
    }
    if (cur.tick <= prev.tick) {
      tickMonotonic = false;
    }
    if (cur.id <= prev.id) {
      ulidMonotonic = false;
    }
    if (Date.parse(cur.occurred_at) < Date.parse(prev.occurred_at)) {
      occurredNonDecreasing = false;
    }
  }
  // tick 连续性：正常一次性转写与幂等重跑都应得到 0..N-1 的连续序列。
  // 只有「半成品恢复」才会出现空洞（被删的 tick 不回收）—— 那种情况由告警说明。
  const tickSet = new Set(experiences.map((experience) => experience.tick));
  let tickContiguous = tickSet.size === experiences.length;
  if (tickContiguous) {
    const sortedTicks = [...tickSet].sort((a, b) => a - b);
    for (let i = 0; i < sortedTicks.length; i += 1) {
      if (sortedTicks[i] !== i) {
        tickContiguous = false;
        break;
      }
    }
  }
  result.monotonic = { tickMonotonic, ulidMonotonic, occurredNonDecreasing, tickContiguous };

  // 8.5 正文逐字未改 —— 全量比对。
  const byEventId = sourceTextByEventId;
  let textCompared = 0;
  const textMismatches: string[] = [];
  for (const experience of experiences) {
    const expected = byEventId.get(experience.observation.text?.id ?? '');
    if (expected === undefined) {
      continue;
    }
    try {
      const resolved = await fasti.resolvePointer({
        id: experience.observation.text?.id,
        channel: CHANNEL,
      });
      const actual = resolved.turns.map((turn) => turn.raw_text).join('');
      if (actual !== expected) {
        textMismatches.push(experience.observation.text?.id ?? experience.id);
      }
      textCompared += 1;
    } catch {
      textMismatches.push(experience.observation.text?.id ?? experience.id);
    }
  }
  result.textUnchanged = {
    compared: textCompared,
    mismatches: textMismatches.length,
    ok: textMismatches.length === 0,
  };

  void warnings;
  return result;
}

// ── 报告输出 ──────────────────────────────────────────────────────────────

function printReport(report: Report): void {
  const out = process.stdout;
  out.write('\n══════════════════════════════════════════════════════════════\n');
  out.write('  阶段 3 转写运行报告\n');
  out.write('══════════════════════════════════════════════════════════════\n');
  out.write(`模式      ：${report.mode === 'dry-run' ? '试运行（未写任何文件）' : '转写'}\n`);
  out.write(`源        ：${report.source}\n`);
  out.write(`新根      ：${report.target}\n`);
  out.write(`备份目录  ：${report.backupDir ?? '（试运行未备份）'}\n`);
  out.write('');
  out.write('── 统计 ────────────────────────────────────────────────────────\n');
  out.write(`源记录总数        ：${report.stats.sourceTotal}\n`);
  out.write(`源文件坏行        ：${report.stats.sourceBadLines}\n`);
  out.write(`新增（原文+经历） ：${report.stats.added}\n`);
  out.write(`新增（仅补建经历）：${report.stats.addedExperienceOnly}\n`);
  out.write(`跳过（已存在）    ：${report.stats.skipped}\n`);
  out.write(`异常跳过          ：${report.stats.anomaliesSkipped}\n`);
  out.write('');
  out.write('── 告警 ────────────────────────────────────────────────────────\n');
  if (report.warnings.length === 0) {
    out.write('（无）\n');
  } else {
    for (const warning of report.warnings) {
      out.write(`  [${warning.field}] ${warning.event_id}：${warning.reason}\n`);
      out.write(`      处置：${warning.action}\n`);
    }
  }
  out.write('');

  if (report.reconciliation !== null) {
    out.write('── 对账 ────────────────────────────────────────────────────────\n');
    out.write(`${JSON.stringify(report.reconciliation, null, 2)}\n`);
    out.write('');
  }

  if (Object.keys(report.verification).length > 0) {
    out.write('── 验收 ────────────────────────────────────────────────────────\n');
    out.write(`${JSON.stringify(report.verification, null, 2)}\n`);
    out.write('');
  }
}

// ── 回滚（只打印指令，不执行删除）─────────────────────────────────────────

function printRollback(backupDir: string): void {
  const out = process.stdout;
  out.write('\n══════════════════════════════════════════════════════════════\n');
  out.write('  还原指令（**不会自动执行** —— 删除是高危动作，需人工确认）\n');
  out.write('══════════════════════════════════════════════════════════════\n');
  out.write(`\n备份目录：${backupDir}\n\n`);
  out.write('请逐条人工执行（Windows PowerShell）：\n\n');
  out.write(`  # 1. 把目标根移到一边（不删除，保留现场）\n`);
  out.write(`  Move-Item -Path "${DEFAULT_TARGET}" -Destination "${DEFAULT_TARGET}.broken-$(Get-Date -Format yyyyMMdd-HHmmss)"\n\n`);
  out.write(`  # 2. 从备份恢复目标根\n`);
  out.write(`  Copy-Item -Path "${path.join(backupDir, 'fasti')}" -Destination "${DEFAULT_TARGET}" -Recurse\n\n`);
  out.write(`  # 3. 旧根是被转写脚本只读的，通常无需还原；如需还原：\n`);
  out.write(`  Copy-Item -Path "${path.join(backupDir, 'persona-innate')}" -Destination "${DEFAULT_SOURCE}" -Recurse\n\n`);
  out.write('确认现场已保全后，再手工删除 .broken-* 目录。\n\n');
}

// ── 入口 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.rollback !== null) {
    if (!fs.existsSync(options.rollback)) {
      fail(`备份目录不存在：${options.rollback}`);
    }
    printRollback(options.rollback);
    return;
  }

  // --source 与 --session-file 互斥：给了会话文件就走 harness 解析，忽略目录模式。
  if (options.sessionFile !== null && process.argv.includes('--source')) {
    fail('--source 与 --session-file 互斥 —— 请只给其中一个');
  }

  if (options.sessionFile === null && !fs.existsSync(options.source)) {
    fail(`旧根不存在：${options.source}`);
  }

  // 仅解析：把解析结果与告警以 JSON 输出，不写任何文件（供自测断言）。
  if (options.dumpParsed) {
    const parsed =
      options.sessionFile !== null
        ? readHarnessSession(options.sessionFile)
        : readSource(options.source);
    process.stdout.write(
      `${JSON.stringify(
        {
          records: parsed.records,
          badLines: parsed.badLines,
          warnings: parsed.warnings,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const report = await migrate(options);
  printReport(report);

  // 退出码：验收全过为 0，否则为 1（便于 CI / 人工核对）。
  if (report.mode === 'migrate') {
    const reconciliation = report.reconciliation as
      | { rawVsDialogueMatch?: boolean; channelsMatch?: boolean }
      | null;
    const verification = report.verification as Record<string, { ok?: boolean }>;
    const allOk =
      reconciliation?.rawVsDialogueMatch === true &&
      reconciliation?.channelsMatch === true &&
      verification['pointerSample']?.ok === true &&
      verification['pointerIdConsistency']?.ok === true &&
      verification['integrity']?.ok === true &&
      verification['textUnchanged']?.ok === true;

    if (!allOk) {
      process.stderr.write('\n验收未全部通过 —— 请按 §5.5 从备份整体还原后重跑，不要在半成品上叠加。\n');
      process.exit(1);
    }
  }
}

await main();
