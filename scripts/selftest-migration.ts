/**
 * 阶段 3 转写脚本的自测套件（S1–S10）。
 *
 * 一次性验证脚本，不进 `npm run verify` 基线（与转写脚本同性质）。
 * 运行：node scripts/selftest-migration.ts
 *
 * 纪律：
 *  - 全部用例在**临时目录**完成，绝不触碰真实新根 `~/.dsh/fasti`；
 *  - 旧根**只读**，异常用例用**合成数据**构造，不污染她的历史；
 *  - 每条用例断言具体数值，不做模糊判断。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contentHashOf } from '../src/core/hash.ts';

const SCRIPT = path.join(import.meta.dirname, 'migrate-raw-turns.ts');
// 源旧根可由环境变量覆盖（便于在无 ~/.dsh/persona-innate 的环境指向一份只读副本）；
// 未设置时仍默认真机旧根。
const REAL_SOURCE =
  process.env['DSH_LEGACY_SOURCE'] ?? path.join(os.homedir(), '.dsh', 'persona-innate');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failed += 1;
    failures.push(`${name}${detail === '' ? '' : ` —— ${detail}`}`);
    process.stdout.write(`  ✗ ${name}${detail === '' ? '' : ` —— ${detail}`}\n`);
  }
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * 跑转写脚本，返回 { code, stdout, stderr }。
 *
 * 自测一律带 `--no-backup`：临时根测试不该在 `~/.dsh/_backups` 里堆备份。
 */
function runScript(args: string[]): { code: number; stdout: string; stderr: string } {
  // 可移植：显式指定了 legacy 源（DSH_LEGACY_SOURCE）时，给子进程补 --source；
  // 已用 --session-file（harness 模式，与 --source 互斥）或未指定时不加，保持真机默认行为。
  const sourceArg =
    process.env['DSH_LEGACY_SOURCE'] &&
    !args.includes('--source') &&
    !args.includes('--session-file')
      ? (['--source', REAL_SOURCE] as const)
      : [];
  const fullArgs = [...sourceArg, ...args];
  const withBackup =
    fullArgs.includes('--dry-run') || fullArgs.includes('--no-backup')
      ? fullArgs
      : [...fullArgs, '--no-backup'];
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...withBackup], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** 从脚本 stdout 里取某个 JSON 块的文本。 */
function extractJson(text: string, startMarker: string): string | null {
  const start = text.indexOf(startMarker);
  if (start < 0) {
    return null;
  }
  const from = text.indexOf('{', start);
  if (from < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(from, i + 1);
      }
    }
  }
  return null;
}

/** harness 解析结果（--dump-parsed 的输出结构）。 */
interface ParsedDump {
  records: Array<{
    turn: {
      event_id: string;
      session_id: string;
      turn_id: string;
      speaker: string;
      raw_text: string;
      asserted_at: string;
      ingested_at: string;
      content_hash: string;
    };
    lineNo: number;
  }>;
  badLines: number;
  warnings: Array<{ event_id: string; field: string; reason: string; action: string }>;
}

/** 跑转写脚本的解析模式，取回结构化结果。 */
function parseDump(args: string[]): { code: number; dump: ParsedDump | null; stderr: string } {
  const result = runScript([...args, '--dump-parsed']);
  if (result.code !== 0) {
    return { code: result.code, dump: null, stderr: result.stderr };
  }
  try {
    return { code: 0, dump: JSON.parse(result.stdout) as ParsedDump, stderr: '' };
  } catch (error) {
    return { code: 0, dump: null, stderr: `JSON 解析失败：${(error as Error).message}` };
  }
}

/** 读目标根的原文行。 */
function readRaw(root: string): Array<Record<string, unknown>> {
  const dir = path.join(root, 'raw-turns');
  if (!fs.existsSync(dir)) {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
      if (line.trim() !== '') {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return rows;
}

/** 读目标根的经历。 */
function readExperiences(root: string): Array<Record<string, unknown>> {
  const dir = path.join(root, 'experiences');
  if (!fs.existsSync(dir)) {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
      if (line.trim() !== '') {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return rows;
}

/** 读旧根的原文行。 */
function readSourceRows(): Array<Record<string, unknown>> {
  const dir = path.join(REAL_SOURCE, 'raw-turns');
  const rows: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
      if (line.trim() !== '') {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════

const sourceRows = readSourceRows();
const SOURCE_COUNT = sourceRows.length;

process.stdout.write('\n阶段 3 转写脚本自测套件\n');
process.stdout.write(`旧根：${REAL_SOURCE}（只读）\n`);
process.stdout.write(`源记录：${SOURCE_COUNT} 条\n\n`);

// ── S1 首次转写 ────────────────────────────────────────────────────────────
process.stdout.write('S1 首次转写（全新临时根）\n');
{
  const root = tempDir('fasti-s1-');
  const result = runScript(['--target', root]);

  check('退出码为 0', result.code === 0, `实际 ${result.code}`);
  check('新增 163 条', result.stdout.includes('新增（原文+经历） ：163'), '统计未匹配');
  check('跳过 0 条', result.stdout.includes('跳过（已存在）    ：0'), '统计未匹配');
  check('异常跳过 0 条', result.stdout.includes('异常跳过          ：0'), '统计未匹配');
  check('原文行数 = 163', readRaw(root).length === 163, `实际 ${readRaw(root).length}`);
  check('经历条数 = 163', readExperiences(root).length === 163, `实际 ${readExperiences(root).length}`);

  const recon = extractJson(result.stdout, '── 对账');
  if (recon === null) {
    check('对账块存在', false, '未找到对账 JSON');
  } else {
    const parsed = JSON.parse(recon) as { rawVsDialogueMatch?: boolean; channelsMatch?: boolean };
    check('rawVsDialogueMatch === true', parsed.rawVsDialogueMatch === true);
    check('channelsMatch === true', parsed.channelsMatch === true);
  }

  cleanup(root);
}

// ── S2 幂等重跑 ────────────────────────────────────────────────────────────
process.stdout.write('\nS2 幂等重跑（同一根再跑一次）\n');
{
  const root = tempDir('fasti-s2-');
  runScript(['--target', root]);
  const rawBefore = readRaw(root).length;
  const expBefore = readExperiences(root).length;

  const second = runScript(['--target', root]);

  check('第二次退出码为 0', second.code === 0, `实际 ${second.code}`);
  check('第二次新增 = 0', second.stdout.includes('新增（原文+经历） ：0'), '统计未匹配');
  check('第二次跳过 = 163', second.stdout.includes('跳过（已存在）    ：163'), '统计未匹配');
  check('原文行数未变', readRaw(root).length === rawBefore, `${rawBefore} → ${readRaw(root).length}`);
  check('经历条数未变', readExperiences(root).length === expBefore, `${expBefore} → ${readExperiences(root).length}`);

  // event_id 唯一性
  const ids = readExperiences(root).map((row) => (row['observation'] as Record<string, unknown>)['text'] as Record<string, unknown>);
  const eventIds = ids.map((pointer) => pointer['id'] as string);
  check('无重复 event_id', new Set(eventIds).size === eventIds.length, `唯一 ${new Set(eventIds).size} / 共 ${eventIds.length}`);

  // 双定位：id 权威路径与 shard/seq 冗余路径必须指向**同一行**
  const rawRows = readRaw(root);
  let dualMismatch = 0;
  for (const pointer of ids) {
    const seq = pointer['seq'] as number;
    const row = rawRows[seq];
    if (row === undefined || row['event_id'] !== pointer['id']) {
      dualMismatch += 1;
    }
  }
  check('双定位 id 与 seq 指向同一行', dualMismatch === 0, `${dualMismatch} 条不一致`);

  cleanup(root);
}

// ── S3 半成品恢复 ──────────────────────────────────────────────────────────
process.stdout.write('\nS3 半成品恢复（删掉经历后重跑）\n');
{
  const root = tempDir('fasti-s3-');
  runScript(['--target', root]);
  const rawBefore = readRaw(root).length;

  // 删掉 3 条经历，模拟「原文写成功、经历写失败」的中断
  const expFile = path.join(root, 'experiences', '2026-11.jsonl');
  const lines = fs.readFileSync(expFile, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  fs.writeFileSync(expFile, `${lines.filter((_, index) => index !== 5 && index !== 80).join('\n')}\n`, 'utf8');

  const recovery = runScript(['--target', root]);

  check('恢复退出码为 0', recovery.code === 0, `实际 ${recovery.code}`);
  check('仅补建 2 条经历', recovery.stdout.includes('新增（仅补建经历）：2'), '统计未匹配');
  check('未重写原文（新增原文 = 0）', recovery.stdout.includes('新增（原文+经历） ：0'), '统计未匹配');
  check('原文行数未变', readRaw(root).length === rawBefore, `${rawBefore} → ${readRaw(root).length}`);
  check('经历恢复至 163', readExperiences(root).length === 163, `实际 ${readExperiences(root).length}`);
  check('有半成品恢复告警', recovery.stdout.includes('半成品恢复'), '未出现告警');

  cleanup(root);
}

// ── S4 指针抽样 + S5 哈希 + S6 通道对账 + S7 单调 ─────────────────────────
process.stdout.write('\nS4–S7 指针 / 哈希 / 通道 / 单调性\n');
{
  const root = tempDir('fasti-s4-');
  const result = runScript(['--target', root]);

  const verification = extractJson(result.stdout, '── 验收');
  if (verification === null) {
    check('验收块存在', false, '未找到验收 JSON');
  } else {
    const parsed = JSON.parse(verification) as Record<string, Record<string, unknown>>;

    check('指针抽样无失配', parsed['pointerSample']?.['ok'] === true, JSON.stringify(parsed['pointerSample']));
    check(
      '指针 id 与目标行 event_id 独立一致',
      parsed['pointerIdConsistency']?.['ok'] === true,
      JSON.stringify(parsed['pointerIdConsistency']),
    );
    check(
      '指针 id 一致性覆盖 163 条',
      parsed['pointerIdConsistency']?.['checked'] === 163,
      String(parsed['pointerIdConsistency']?.['checked']),
    );
    check('哈希校验 ok', parsed['integrity']?.['ok'] === true, JSON.stringify(parsed['integrity']));
    check('哈希校验覆盖 163 条', parsed['integrity']?.['checked'] === 163, JSON.stringify(parsed['integrity']));

    const channel = parsed['channel'] as Record<string, unknown> | undefined;
    check('通道已注册', channel?.['registered'] === true);
    check('通道经历数 = 163', channel?.['experiences'] === 163, String(channel?.['experiences']));
    check('通道原文数 = 163', channel?.['rawTurns'] === 163, String(channel?.['rawTurns']));

    const mono = parsed['monotonic'] as Record<string, unknown>;
    check('tick 严格递增', mono?.['tickMonotonic'] === true);
    check('ULID 严格递增', mono?.['ulidMonotonic'] === true);
    check('occurred_at 非递减', mono?.['occurredNonDecreasing'] === true);
    check('tick 连续（无空洞）', mono?.['tickContiguous'] === true, JSON.stringify(mono));
  }

  cleanup(root);
}

// ── S8 异常数据处置（合成数据，不动真实旧根）──────────────────────────────
process.stdout.write('\nS8 异常数据处置（合成源）\n');
{
  // 构造合成旧根：正常 1 条 + 空时间 1 条 + 未知 speaker 1 条 + 坏 JSON 行 1 行
  const fakeSource = tempDir('fasti-s8-src-');
  const rawDir = path.join(fakeSource, 'raw-turns');
  fs.mkdirSync(rawDir, { recursive: true });

  const normal = {
    event_id: 'ev-normal',
    session_id: 'session-synthetic',
    turn_id: '',
    speaker: 'user',
    raw_text: '正常记录',
    asserted_at: '2026-11-05T10:00:00.000Z',
    ingested_at: '2026-11-05T10:00:01.000Z',
    content_hash: contentHashOf('正常记录'),
  };
  const noTime = {
    event_id: 'ev-notime',
    session_id: 'session-synthetic',
    turn_id: '',
    speaker: 'user',
    raw_text: '没有时间',
    asserted_at: '',
    ingested_at: '',
    content_hash: contentHashOf('没有时间'),
  };
  const unknownSpeaker = {
    event_id: 'ev-unknown',
    session_id: '',
    turn_id: '',
    speaker: 'alien',
    raw_text: '未知发起方',
    asserted_at: '2026-11-05T10:00:02.000Z',
    ingested_at: '2026-11-05T10:00:03.000Z',
    content_hash: contentHashOf('未知发起方'),
  };

  fs.writeFileSync(
    path.join(rawDir, '2026-11.jsonl'),
    `${[normal, noTime, unknownSpeaker].map((row) => JSON.stringify(row)).join('\n')}\n{ 坏 JSON 行\n`,
    'utf8',
  );

  const root = tempDir('fasti-s8-target-');
  const result = runScript(['--source', fakeSource, '--target', root]);

  check('退出码为 0', result.code === 0, `实际 ${result.code}`);
  check('坏 JSON 行被计数', result.stdout.includes('源文件坏行        ：1'), '统计未匹配');
  check('空时间被跳过', result.stdout.includes('异常跳过          ：1'), '统计未匹配');
  check('有「跳过该行」告警', result.stdout.includes('跳过该行'), '未找到坏行告警');
  check('有「不伪造时间」告警', result.stdout.includes('不伪造时间'), '未找到空时间告警');
  check('有未知 speaker 告警', result.stdout.includes('未知 speaker'), '未找到未知 speaker 告警');

  const raw = readRaw(root);
  const exps = readExperiences(root);
  check('只写入 2 条原文（正常 + 未知 speaker）', raw.length === 2, `实际 ${raw.length}`);
  check('只建 2 条经历', exps.length === 2, `实际 ${exps.length}`);
  check('空时间记录未被写入', !raw.some((row) => row['event_id'] === 'ev-notime'), '空时间记录被写入了');
  check(
    '未知 speaker 原样保留为 initiation',
    exps.some((row) => row['initiation'] === 'alien'),
    `initiation 值: ${exps.map((row) => row['initiation']).join(',')}`,
  );
  check(
    '空 session_id → scene.ref 为空串',
    exps.some((row) => (row['scene'] as Record<string, unknown>)['ref'] === ''),
    '未找到空 scene.ref',
  );

  cleanup(root);
  cleanup(fakeSource);
}

// ── S9 正文逐字未改（全量比对）────────────────────────────────────────────
process.stdout.write('\nS9 正文逐字未改（全量 163 条比对）\n');
{
  const root = tempDir('fasti-s9-');
  runScript(['--target', root]);

  const raw = readRaw(root);
  const sourceById = new Map(sourceRows.map((row) => [row['event_id'], row]));

  let mismatches = 0;
  for (const row of raw) {
    const original = sourceById.get(row['event_id']);
    if (original === undefined) {
      mismatches += 1;
      continue;
    }
    if (row['raw_text'] !== original['raw_text']) {
      mismatches += 1;
    }
    if (row['content_hash'] !== original['content_hash']) {
      mismatches += 1;
    }
  }

  check('原文行数 = 源记录数', raw.length === SOURCE_COUNT, `${raw.length} / ${SOURCE_COUNT}`);
  check('全部正文与哈希逐字符一致', mismatches === 0, `${mismatches} 处不一致`);

  cleanup(root);
}

// ── S10 dry-run 不写任何文件 ──────────────────────────────────────────────
process.stdout.write('\nS10 dry-run 只读性\n');
{
  const root = tempDir('fasti-s10-');
  const result = runScript(['--source', REAL_SOURCE, '--target', root, '--dry-run']);

  check('退出码为 0', result.code === 0, `实际 ${result.code}`);
  check('目标根未被创建', !fs.existsSync(root) || fs.readdirSync(root).length === 0, '目标根有残留内容');
  check('计划新增 163 条', result.stdout.includes('新增（原文+经历） ：163'), '统计未匹配');
  check('标记为试运行', result.stdout.includes('试运行（未写任何文件）'), '模式标记缺失');

  cleanup(root);
}

// ── S11–S14 harness 会话事件流 ───────────────────────────────────────────

/** 真实 harness 会话文件（用户导出）；可由环境变量 DSH_HARNESS_FILE 覆盖指向副本。 */
const HARNESS_FILE =
  process.env['DSH_HARNESS_FILE'] ??
  path.join(
    os.homedir(),
    '.doubao',
    'lark-chats',
    '2026-11-02',
    'new-chat',
    '打招呼-原始记录.jsonl',
  );

const harnessExists = fs.existsSync(HARNESS_FILE);

process.stdout.write('\nS11 harness 会话文件解析（真实文件）\n');
{
  if (!harnessExists) {
    check('harness 文件存在', false, `未找到 ${HARNESS_FILE}`);
  } else {
    const { code, dump } = parseDump(['--session-file', HARNESS_FILE]);
    check('解析退出码为 0', code === 0, `实际 ${code}`);

    if (dump !== null) {
      const records = dump.records;
      const users = records.filter((r) => r.turn.speaker === 'user');
      const assistants = records.filter((r) => r.turn.speaker === 'assistant');

      check('提取 84 条', records.length === 84, `实际 ${records.length}`);
      check('user 42 条', users.length === 42, `实际 ${users.length}`);
      check('assistant 42 条', assistants.length === 42, `实际 ${assistants.length}`);
      check('坏行 0', dump.badLines === 0, `实际 ${dump.badLines}`);
      check('无告警', dump.warnings.length === 0, `${dump.warnings.length} 条告警`);
      check(
        'session_id 带 session- 前缀原样',
        records.every((r) => r.turn.session_id === 'session-603cb08e-68b0-4e56-87fc-b393c8832eeb'),
        `唯一值: ${[...new Set(records.map((r) => r.turn.session_id))].join(',')}`,
      );
      check('turn_id 全为空串', records.every((r) => r.turn.turn_id === ''));
      check(
        'ingested_at === asserted_at（harness 只有一个时间戳）',
        records.every((r) => r.turn.ingested_at === r.turn.asserted_at),
      );
      check(
        'content_hash 全为 64 位 sha256',
        records.every((r) => /^[0-9a-f]{64}$/.test(r.turn.content_hash)),
      );
      check(
        'event_id 唯一',
        new Set(records.map((r) => r.turn.event_id)).size === records.length,
      );
      check(
        'lineNo 与源文件真实行号一致（首条应为 10）',
        records[0]?.lineNo === 10,
        `实际 ${records[0]?.lineNo}`,
      );
      check(
        '时间范围 11-02 → 11-04',
        (records[0]?.turn.asserted_at ?? '').startsWith('2026-11-02') &&
          (records[records.length - 1]?.turn.asserted_at ?? '').startsWith('2026-11-04'),
        `${records[0]?.turn.asserted_at} → ${records[records.length - 1]?.turn.asserted_at}`,
      );
    }
  }
}

process.stdout.write('\nS12 harness 系统注入排除\n');
{
  if (!harnessExists) {
    check('harness 文件存在', false, '跳过');
  } else {
    const { dump } = parseDump(['--session-file', HARNESS_FILE]);
    if (dump === null) {
      check('解析成功', false, 'dump 为空');
    } else {
      // 直接数源文件里的注入消息数，与解析出的条数对照。
      const lines = fs.readFileSync(HARNESS_FILE, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      let injected = 0;
      let realUser = 0;
      let assistant = 0;
      for (const line of lines) {
        const event = JSON.parse(line) as {
          type?: string;
          data?: { source?: { kind?: string } };
        };
        if (event.type === 'user/message') {
          if (event.data?.source?.kind === 'user') {
            realUser += 1;
          } else {
            injected += 1;
          }
        } else if (event.type === 'assistant/message') {
          assistant += 1;
        }
      }
      check('源文件注入消息 42 条', injected === 42, `实际 ${injected}`);
      check('源文件真实 user 42 条', realUser === 42, `实际 ${realUser}`);
      check('源文件 assistant 42 条', assistant === 42, `实际 ${assistant}`);
      check(
        '注入消息全部排除（提取数 = 42 + 42）',
        dump.records.length === realUser + assistant,
        `提取 ${dump.records.length} / 期望 ${realUser + assistant}`,
      );
      check(
        '提取的正文不含注入特征',
        dump.records.every(
          (r) => !/^(current runtime context|this snapshot supersedes)/i.test(r.turn.raw_text),
        ),
      );
    }
  }
}

process.stdout.write('\nS13 harness 解析健壮性（合成数据）\n');
{
  // 构造合成事件流：正常 2 条 + 坏行 + 空文本 + 非 text 块 + 多块消息 + 缺 id + 缺 time
  const dir = tempDir('fasti-s13-');
  const file = path.join(dir, 'synthetic.jsonl');

  const events: unknown[] = [
    {
      type: 'session',
      version: 4,
      id: 'session-synthetic-0001',
      createdAt: 1793635706046,
    },
    {
      type: 'user/message',
      seq: 8,
      time: 1793635716820,
      data: {
        content: [{ type: 'text', text: '第一条真实输入' }],
        source: { kind: 'user' },
        id: 'id-user-1',
      },
    },
    {
      type: 'user/message',
      seq: 9,
      time: 1793635717000,
      data: {
        content: [{ type: 'text', text: 'current runtime context: 注入内容' }],
        source: { kind: 'user' },
        id: 'id-runtime-1',
      },
    },
    {
      type: 'user/message',
      seq: 10,
      time: 1793635717100,
      data: {
        content: [{ type: 'text', text: '   ' }],
        source: { kind: 'user' },
        id: 'id-empty-1',
      },
    },
    {
      type: 'user/message',
      seq: 11,
      time: 1793635717200,
      data: {
        content: [
          { type: 'image', url: 'x.png' },
          { type: 'text', text: '带图片块的消息' },
        ],
        source: { kind: 'user' },
        id: 'id-multiblock-1',
      },
    },
    {
      type: 'user/message',
      seq: 12,
      time: 1793635717300,
      data: {
        content: [{ type: 'text', text: '缺 id 的消息' }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/message',
      seq: 13,
      time: 1793635717400,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '第一条回复' }],
          id: 'id-assistant-1',
        },
      },
    },
    {
      // 故意缺 time —— 应被跳过并告警
      type: 'assistant/message',
      seq: 14,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '缺 time 的回复' }],
          id: 'id-assistant-2',
        },
      },
    },
  ];

  const lines = events.map((e) => JSON.stringify(e));
  lines.splice(3, 0, '{ 这不是合法 JSON');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  const { code, dump } = parseDump(['--session-file', file]);
  check('退出码为 0', code === 0, `实际 ${code}`);

  if (dump !== null) {
    const ids = dump.records.map((r) => r.turn.event_id);

    check('坏行计入 badLines', dump.badLines === 1, `实际 ${dump.badLines}`);
    check('坏行有告警', dump.warnings.some((w) => w.reason.includes('JSON 解析失败')), '未找到告警');
    check('正常消息被提取', ids.includes('id-user-1'), `提取到 ${ids.join(',')}`);
    check('正常回复被提取', ids.includes('id-assistant-1'), `提取到 ${ids.join(',')}`);
    check(
      '运行时上下文被跳过',
      !ids.includes('id-runtime-1'),
      '运行时上下文不应被提取',
    );
    check('空文本被跳过', !ids.includes('id-empty-1'), '空文本不应被提取');
    check('空文本有告警', dump.warnings.some((w) => w.reason.includes('提取不到任何非空 text')));
    check(
      '缺 id 的被跳过并告警',
      dump.warnings.some((w) => w.field === 'event_id' && w.reason.includes('缺少')),
      '未见 event_id 缺失告警',
    );
    check('缺 time 的被跳过', !ids.includes('id-assistant-2'), '缺 time 不应被提取');
    check('缺 time 有告警', dump.warnings.some((w) => w.field === 'time'), '未见 time 告警');

    // 多块消息：非 text 块被忽略，只取 text 块。
    const multi = dump.records.find((r) => r.turn.event_id === 'id-multiblock-1');
    check('多块消息只取 text 部分', multi?.turn.raw_text === '带图片块的消息', `实际 ${JSON.stringify(multi?.turn.raw_text)}`);
    check(
      '非 text 块有告警',
      dump.warnings.some((w) => w.reason.includes('非 text 内容块')),
      '未见非 text 块告警',
    );

    check('session_id 原样', dump.records.every((r) => r.turn.session_id === 'session-synthetic-0001'));
    check('提取 3 条（正常 user + 多块 user + 正常 assistant）', dump.records.length === 3, `实际 ${dump.records.length}`);
  }

  cleanup(dir);
}

process.stdout.write('\nS14 harness 解析后自检告警\n');
{
  // 构造：同方连续（非交替） + 时间逆序 + id 重复
  const dir = tempDir('fasti-s14-');
  const file = path.join(dir, 'nonstrict.jsonl');

  const events = [
    {
      type: 'session',
      id: 'session-nonstrict-0001',
    },
    {
      type: 'user/message',
      time: 1793635717000,
      data: { content: [{ type: 'text', text: '第一条' }], source: { kind: 'user' }, id: 'dup-id' },
    },
    {
      type: 'user/message',
      time: 1793635716000,
      data: { content: [{ type: 'text', text: '第二条（同方连续，且时间更早）' }], source: { kind: 'user' }, id: 'dup-id' },
    },
  ];

  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');

  const { dump } = parseDump(['--session-file', file]);
  if (dump === null) {
    check('解析成功', false, 'dump 为空');
  } else {
    check('非交替有告警', dump.warnings.some((w) => w.reason.includes('非严格交替')), '未见交替性告警');
    check('时间逆序有告警', dump.warnings.some((w) => w.reason.includes('与文件顺序不一致')), '未见单调性告警');
    check('id 重复有告警', dump.warnings.some((w) => w.reason.includes('id 重复')), '未见 id 重复告警');
    check('重复 id 仍被提取（不静默丢弃）', dump.records.length === 2, `实际 ${dump.records.length}`);
  }

  cleanup(dir);
}

// ── S15 harness 转写端到端（临时根）───────────────────────────────────────
process.stdout.write('\nS15 harness 转写端到端（临时根）\n');
{
  if (!harnessExists) {
    check('harness 文件存在', false, '跳过');
  } else {
    const root = tempDir('fasti-s15-');
    const result = runScript(['--session-file', HARNESS_FILE, '--target', root, '--no-backup']);

    check('退出码为 0', result.code === 0, `实际 ${result.code}`);
    check('新增 84 条', result.stdout.includes('新增（原文+经历） ：84'), '统计未匹配');
    check('原文行数 = 84', readRaw(root).length === 84, `实际 ${readRaw(root).length}`);
    check('经历条数 = 84', readExperiences(root).length === 84, `实际 ${readExperiences(root).length}`);
    check('对账通过', result.stdout.includes('"rawVsDialogueMatch": true'), '对账未通过');
    check('通道对账通过', result.stdout.includes('"channelsMatch": true'), '通道对账未通过');
    check('哈希校验全过', result.stdout.includes('"ok": true'), '验收未全过');

    // 正文逐字符比对：目标根原文 vs 源文件解析结果。
    const { dump } = parseDump(['--session-file', HARNESS_FILE]);
    if (dump !== null) {
      const expected = new Map(dump.records.map((r) => [r.turn.event_id, r.turn.raw_text]));
      let mismatch = 0;
      for (const row of readRaw(root)) {
        const id = row['event_id'] as string;
        if (expected.get(id) !== row['raw_text']) {
          mismatch += 1;
        }
      }
      check('正文逐字符一致（84 条）', mismatch === 0, `${mismatch} 处不一致`);
    }

    // 幂等：重跑应全部 skipped。
    const second = runScript(['--session-file', HARNESS_FILE, '--target', root, '--no-backup']);
    check('重跑新增 = 0', second.stdout.includes('新增（原文+经历） ：0'), '统计未匹配');
    check('重跑跳过 = 84', second.stdout.includes('跳过（已存在）    ：84'), '统计未匹配');
    check('重跑后原文行数未变', readRaw(root).length === 84, `实际 ${readRaw(root).length}`);

    cleanup(root);
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
process.stdout.write('\n══════════════════════════════════════════════════════════════\n');
process.stdout.write(`  自测结果：通过 ${passed}，失败 ${failed}\n`);
if (failed > 0) {
  process.stdout.write('\n失败项：\n');
  for (const failure of failures) {
    process.stdout.write(`  · ${failure}\n`);
  }
}
process.stdout.write('══════════════════════════════════════════════════════════════\n');

process.exit(failed === 0 ? 0 : 1);
