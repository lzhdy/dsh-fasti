/**
 * 事件契约测试（技术基线 §2 · 任务卡 T1）。
 *
 * 覆盖：类型落定、write/read 双模、开放/封闭枚举、摘要口径（600 上限 + 只查非空）、
 * 红线自检（无「重要性」类字段、无「聊天前提」类字段、topic_lines 恒空、anchors 无消费者）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SchemaError } from '../../src/core/errors.ts';
import {
  EVENT_BOUNDARY_CANDIDATE_FIELDS,
  EVENT_CLOSED_REASONS,
  EVENT_CREATED_BY,
  EVENT_FIELDS,
  EVENT_POINTER_FIELDS,
  EVENT_SCHEMA_VERSION,
  EVENT_STATUSES,
  EVENT_TIME_RANGE_FIELDS,
  SUMMARY_MAX_CHARS,
  SUMMARY_QUALITIES,
  SUMMARY_SOURCES,
  parseEvent,
  summaryLengthOf,
} from '../../src/contract/event.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import {
  FORBIDDEN_CONVERSATION_FIELDS,
  FORBIDDEN_SEMANTIC_FIELDS,
  isForbiddenFieldName,
} from '../../src/contract/experience.ts';

/** 契约层：这两个字段名与形状的唯一来源（完全豁免）。 */
const CONTRACT_LAYER = 'src/contract/event.ts';

/**
 * 产出方 / 物化方白名单 —— 允许读写 `anchors` 与 `topic_lines` 的文件。
 *
 * 白名单不是免检区：这些文件仍不得写入**非空** `topic_lines`（第一期恒空）。
 * 新增产出方要显式登记，否则当场变红 → 逼出一次有意识的决定。
 */
const PRODUCERS = [
  'src/event/llm-port.ts', // LLM 端口类型声明（产出形状）
  'src/event/closure.ts', // 闭合管线回写新版本（产出落盘）
  'src/adapters/dsh/llm.ts', // 适配层调模型（产出 anchors）
  'src/projection/event-row.ts', // 投影物化事件行
  'src/projection/event-schema.ts', // 投影行 schema（建表/迁移）
  'src/projection/sqlite.ts', // sqlite 投影引擎物化事件行
  'src/projection/types.ts', // 投影行类型声明
  'src/event/correction.ts', // 修正层物化新事件
];

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/** 构造一条完整事件记录（尽量少填，调用方按需覆盖）。 */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const base: EventRecord = {
    id: '01J0000000000000000000000A',
    schema_version: EVENT_SCHEMA_VERSION,
    version: 1,
    status: 'open',
    closed_reason: null,
    pointers: [{ id: '01J0000000000000000000000B', channel: 'dsh', shard: '2026-11', seq: 0 }],
    time_range: { started_at: '2026-11-08T10:00:00.000Z', ended_at: '2026-11-08T10:30:00.000Z' },
    assembled_at: '2026-11-08T10:30:00.000Z',
    summary: null,
    key_points: [],
    anchors: [],
    topic_lines: [],
    summary_quality: 'pending',
    summary_source: null,
    summary_prompt_version: null,
    summary_model: null,
    created_by: 'system',
    created_at: '2026-11-08T10:30:00.000Z',
    channel: 'dsh',
    boundary_candidates: [],
    effective_chars: null,
    raw_chars: null,
  };
  return { ...base, ...overrides };
}

/** 逐字段删掉一个键，得到「缺该必填字段」的样例。 */
function withoutField(field: string): Record<string, unknown> {
  const raw = { ...makeEvent() } as unknown as Record<string, unknown>;
  delete raw[field];
  return raw;
}

test('契约：完整事件记录在 read 与 write 两种模式下都解析成功', () => {
  const event = makeEvent();
  const read = parseEvent(event, 'read');
  const written = parseEvent(event, 'write');

  assert.equal(read.id, event.id);
  assert.equal(read.schema_version, EVENT_SCHEMA_VERSION);
  assert.equal(read.version, 1);
  assert.equal(read.status, 'open');
  assert.equal(read.pointers.length, 1);
  assert.equal(read.pointers[0]?.id, '01J0000000000000000000000B');
  assert.equal(read.time_range.started_at, '2026-11-08T10:00:00.000Z');
  assert.equal(read.time_range.ended_at, '2026-11-08T10:30:00.000Z');
  assert.equal(read.assembled_at, '2026-11-08T10:30:00.000Z');
  assert.equal(read.summary, null);
  assert.deepEqual(read.key_points, []);
  assert.deepEqual(read.anchors, []);
  assert.deepEqual(read.topic_lines, []);
  assert.equal(read.summary_quality, 'pending');
  assert.equal(read.summary_source, null);
  assert.equal(read.created_by, 'system');
  assert.equal(read.created_at, '2026-11-08T10:30:00.000Z');
  assert.equal(read.channel, 'dsh');
  assert.deepEqual(read.boundary_candidates, []);
  assert.deepEqual(written, read);
});

test('契约：退役指针 merged_into / split_into 可选且被保留', () => {
  const merged = parseEvent(makeEvent({ status: 'merged', merged_into: 'evt-other' }), 'write');
  assert.equal(merged.merged_into, 'evt-other');

  const split = parseEvent(makeEvent({ status: 'split', split_into: ['a', 'b'] }), 'write');
  assert.deepEqual(split.split_into, ['a', 'b']);
});

test('write 模式：禁字段名全部被拦截（复用 experience 口径的禁字段清单）', () => {
  const forbidden = [...FORBIDDEN_SEMANTIC_FIELDS, ...FORBIDDEN_CONVERSATION_FIELDS];
  assert.ok(forbidden.length > 0, '禁字段清单不应为空');

  for (const field of forbidden) {
    const raw = { ...makeEvent(), [field]: 1 } as unknown as Record<string, unknown>;
    assert.throws(
      () => parseEvent(raw, 'write'),
      SchemaError,
      `write 模式必须拦截禁字段 ${field}`,
    );
  }
});

test('read 模式：禁字段名只是普通未知字段 —— 不报错、原样保留', () => {
  const raw = { ...makeEvent(), importance: 7, session_id: 'x' } as unknown as Record<string, unknown>;
  const parsed = parseEvent(raw, 'read') as unknown as Record<string, unknown>;
  assert.equal(parsed['importance'], 7);
  assert.equal(parsed['session_id'], 'x');
});

test('write 模式：未知顶层字段被拦截；read 模式：未知字段原样保留', () => {
  const raw = { ...makeEvent(), future_field: 'x' } as unknown as Record<string, unknown>;
  assert.throws(() => parseEvent(raw, 'write'), SchemaError);

  const parsed = parseEvent(raw, 'read') as unknown as Record<string, unknown>;
  assert.equal(parsed['future_field'], 'x');
});

test('契约：必填字段缺失逐一报错', () => {
  const required = [
    'id',
    'schema_version',
    'version',
    'status',
    'pointers',
    'time_range',
    'assembled_at',
    'summary',
    'key_points',
    'anchors',
    'topic_lines',
    'summary_quality',
    'summary_source',
    'created_by',
    'created_at',
    'channel',
    'boundary_candidates',
  ];
  for (const field of required) {
    assert.throws(() => parseEvent(withoutField(field), 'write'), SchemaError, `缺 ${field} 必须报错`);
    assert.throws(() => parseEvent(withoutField(field), 'read'), SchemaError, `缺 ${field} 必须报错`);
  }
});

test('契约：封闭枚举越界 —— write 拦截、read 原样保留', () => {
  const closed: Array<[string, unknown]> = [
    ['status', 'not-a-status'],
    ['summary_quality', 'half'],
    ['summary_source', 'robot'],
    ['created_by', 'nobody'],
  ];
  for (const [field, value] of closed) {
    const raw = { ...makeEvent(), [field]: value } as unknown as Record<string, unknown>;
    assert.throws(() => parseEvent(raw, 'write'), SchemaError, `write 模式必须拦截 ${field}=${String(value)}`);

    const parsed = parseEvent(raw, 'read') as unknown as Record<string, unknown>;
    assert.equal(parsed[field], value, 'read 模式必须原样保留未知枚举值');
  }
});

test('契约：封闭枚举的已知取值全集被接受', () => {
  for (const status of EVENT_STATUSES) {
    assert.equal(parseEvent(makeEvent({ status }), 'write').status, status);
  }
  for (const quality of SUMMARY_QUALITIES) {
    assert.equal(parseEvent(makeEvent({ summary_quality: quality }), 'write').summary_quality, quality);
  }
  for (const source of SUMMARY_SOURCES) {
    assert.equal(parseEvent(makeEvent({ summary_source: source }), 'write').summary_source, source);
  }
  for (const createdBy of EVENT_CREATED_BY) {
    assert.equal(parseEvent(makeEvent({ created_by: createdBy }), 'write').created_by, createdBy);
  }
});

test('开放枚举：boundary_candidates[].kind 的未知值原样保留（write / read 都不拦）', () => {
  const event = makeEvent({
    boundary_candidates: [{ kind: '从未见过的信号', at_pointer_id: '01J0000000000000000000000B', marked_at: '2026-11-08T10:10:00.000Z' }],
  });
  for (const mode of ['write', 'read'] as const) {
    const parsed = parseEvent(event, mode);
    assert.equal(parsed.boundary_candidates[0]?.kind, '从未见过的信号');
  }
});

test('摘要：null 合法（后台未生成），空串与纯空白非法', () => {
  assert.equal(parseEvent(makeEvent({ summary: null }), 'write').summary, null);
  assert.throws(() => parseEvent(makeEvent({ summary: '' }), 'write'), SchemaError);
  assert.throws(() => parseEvent(makeEvent({ summary: '   \n ' }), 'write'), SchemaError);
});

test('摘要：硬上限 600 字 —— 600 通过、601 报错', () => {
  assert.equal(SUMMARY_MAX_CHARS, 600);
  assert.equal(parseEvent(makeEvent({ summary: '事'.repeat(600) }), 'write').summary?.length, 600);
  assert.throws(() => parseEvent(makeEvent({ summary: '事'.repeat(601) }), 'write'), SchemaError);
});

test('摘要：不设字数硬下限、也不做三要素规则检查（8 字摘要合法）', () => {
  const short = '她打开了一个网页';
  assert.equal(short.length, 8);
  const parsed = parseEvent(makeEvent({ summary: short, summary_quality: 'ready', summary_source: 'llm' }), 'write');
  assert.equal(parsed.summary, short);
});

test('嵌套结构：pointers / time_range / boundary_candidates 各自校验', () => {
  const badPointer = { ...makeEvent(), pointers: [{ channel: 'dsh' }] } as unknown as Record<string, unknown>;
  assert.throws(() => parseEvent(badPointer, 'write'), SchemaError);

  const badRange = { ...makeEvent(), time_range: { started_at: 'x' } } as unknown as Record<string, unknown>;
  assert.throws(() => parseEvent(badRange, 'write'), SchemaError);

  const badCandidate = {
    ...makeEvent(),
    boundary_candidates: [{ kind: '话题跳转' }],
  } as unknown as Record<string, unknown>;
  assert.throws(() => parseEvent(badCandidate, 'write'), SchemaError);
});

test('红线自检：事件契约不得出现「重要性」类与「聊天前提」类字段名', () => {
  const allFieldNames = [
    ...EVENT_FIELDS,
    ...EVENT_POINTER_FIELDS,
    ...EVENT_TIME_RANGE_FIELDS,
    ...EVENT_BOUNDARY_CANDIDATE_FIELDS,
  ];
  const forbiddenWords = [...FORBIDDEN_SEMANTIC_FIELDS, ...FORBIDDEN_CONVERSATION_FIELDS];

  for (const name of allFieldNames) {
    assert.equal(isForbiddenFieldName(name), false, `字段名 ${name} 命中禁字段清单`);
    for (const word of forbiddenWords) {
      assert.equal(name.includes(word), false, `字段名 ${name} 含禁词 ${word}`);
    }
  }
});

/**
 * 红线自检的判据 —— 「产出」与「消费」分开判（主理人裁定）。
 *
 * **本体（不能放松）**：
 *  1. `topic_lines` 第一期恒为 `[]` —— 任何文件都不得写入**非空**值；
 *  2. `anchors` 无消费者 —— 不得有文件读它的值做判断（产出、落盘、透传允许）。
 *
 * **分两档**：
 *  - **契约层**（`src/contract/event.ts`）：字段名与形状的唯一来源，完全豁免；
 *  - **产出方 / 物化方白名单**：允许读写这两个字段（它们就是产出与物化的一环），
 *    但**仍受「不得写入非空 topic_lines」约束** —— 白名单不是免检区；
 *  - **其它文件**：不得写 topic_lines、不得读 topic_lines、不得读 anchors。
 *
 * 白名单是「谁可以碰这两个字段」的登记表：新增产出方要显式登记，
 * 否则当场变红 → 逼出一次有意识的决定（而不是默默写进去）。
 *
 * 只剥注释、**不剥字符串字面量** —— 下标读取形态 `x['anchors']` 本身就在字符串里，
 * 剥掉就抓不到了（判据变哑比误报更糟）。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 读取使用形态（= 消费）。 */
function hasReadUsage(text: string, field: string): boolean {
  const f = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\.\\s*${f}\\b(?!\\s*=[^=])`), // x.field（排除赋值 x.field = v）
    new RegExp(`\\[\\s*['"\`]${f}['"\`]\\s*\\]`), // x['field']
    new RegExp(`\\{[^}]*\\b${f}\\b[^}]*\\}\\s*=`), // const { field } = x
    new RegExp(`\\b${f}\\s*\\.`), // field.map(...) / field.length
  ].some((pattern) => pattern.test(text));
}

/** 写入形态（对象字面量键 / 成员赋值）。 */
function hasWriteUsage(text: string, field: string): boolean {
  const f = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\b${f}\\s*:`), // { field: ... } / 类型声明
    new RegExp(`\\.\\s*${f}\\s*=(?!=)`), // x.field = ...
  ].some((pattern) => pattern.test(text));
}

/** 写入非空数组字面量（能静态证明非空的写法）。 */
function hasNonEmptyArrayWrite(text: string, field: string): boolean {
  const f = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 排除 `[...x]` 展开写法：那是**拷贝**既有数组（其内容由上游不变量保证为空），
  // 不是「写入一个非空值」。
  return new RegExp(
    `\\b${f}\\s*:\\s*\\[\\s*(?!\\.\\.\\.)[^\\]\\s]|\\.\\s*${f}\\s*=\\s*\\[\\s*(?!\\.\\.\\.)[^\\]\\s]`,
  ).test(text);
}

/**
 * 判一条源码是否违反第一期红线。
 *
 * @param isProducer 产出方 / 物化方白名单成员：允许读写这两个字段，
 *   但仍不得写入非空 topic_lines（第一期恒空）。
 */
function findViolations(text: string, isProducer: boolean): string[] {
  const code = stripComments(text);
  const violations: string[] = [];
  if (isProducer) {
    if (hasNonEmptyArrayWrite(code, 'topic_lines')) {
      violations.push('topic_lines:非空写入');
    }
    return violations;
  }
  if (hasWriteUsage(code, 'topic_lines')) {
    violations.push('topic_lines:写入');
  }
  if (hasReadUsage(code, 'topic_lines')) {
    violations.push('topic_lines:读取');
  }
  if (hasReadUsage(code, 'anchors')) {
    violations.push('anchors:读取');
  }
  return violations;
}

test('红线自检：判据本身可判（正则失效会让门禁变哑，必须自证）', () => {
  // 读取 → 判为消费
  assert.deepEqual(findViolations('if (record.anchors.length > 0) {}', false), ['anchors:读取']);
  assert.deepEqual(findViolations('const { anchors } = record;', false), ['anchors:读取']);
  assert.deepEqual(findViolations("const a = record['topic_lines'];", false), ['topic_lines:读取']);

  // 非白名单文件写 topic_lines → 违规
  assert.deepEqual(findViolations("const rec = { topic_lines: [] };", false), ['topic_lines:写入']);
  assert.deepEqual(findViolations('rec.topic_lines = [];', false), ['topic_lines:写入']);

  // 白名单（产出方）允许读写这两个字段，但写非空 topic_lines 仍违规
  assert.deepEqual(findViolations('const next = { ...cur, anchors: response.anchors };', true), []);
  assert.deepEqual(findViolations('const next = { ...cur, topic_lines: [] };', true), []);
  assert.deepEqual(findViolations("const next = { ...cur, topic_lines: ['x'] };", true), [
    'topic_lines:非空写入',
  ]);

  // 纯类型声明不是读写 → 不违规
  assert.deepEqual(findViolations('readonly anchors: readonly string[];', false), []);
});

test('红线自检：topic_lines 第一期恒空、anchors 无消费者（src/ 内除契约层外无违规）', () => {
  const srcDir = path.join(repoRoot, 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }
  };
  walk(srcDir);

  const violations: string[] = [];
  for (const file of files) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    if (relative === CONTRACT_LAYER) {
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    for (const violation of findViolations(text, PRODUCERS.includes(relative))) {
      violations.push(`${relative}:${violation}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `第一期 topic_lines 恒空、anchors 无消费者：${violations.join('、')}`,
  );

  // 契约层是这两个字段的唯一来源：生产者据此补齐必填数组字段（第一期恒为 []）。
  assert.ok(EVENT_FIELDS.includes('anchors'));
  assert.ok(EVENT_FIELDS.includes('topic_lines'));
});

// ── 闭合原因（closed_reason）──────────────────────────────────────────────

test('闭合原因：封闭枚举取值为全集，null 表示未被机械信号闭合', () => {
  assert.deepEqual(
    [...EVENT_CLOSED_REASONS],
    [
      'silence',
      // v1.4：条数上限退役 → 仅保留为兼容值（新代码不再产生，写模式仍接受旧数据）。
      'max-records',
      'task-closure',
      'channel-switch',
      // v1.4 新增：有效对话字数上限 / 硬保险丝（定案稿 §5.2）。
      'max-dialogue-chars',
      'max-chars',
      // v1.5 纯加法：她显式操作闭合（非机械信号），是谁操作看 created_by。
      'manual',
    ],
    '闭合原因是封闭枚举：边界的机械事实，不含分数/权重/置信度',
  );

  for (const reason of EVENT_CLOSED_REASONS) {
    const parsed = parseEvent(makeEvent({ status: 'closed', closed_reason: reason }), 'write');
    assert.equal(parsed.closed_reason, reason);
  }

  const open = parseEvent(makeEvent(), 'write');
  assert.equal(open.closed_reason, null, 'open 事件的闭合原因为 null');
});

test('闭合原因：write 模式拦截越界值与缺字段；read 模式保留未知值原样', () => {
  assert.throws(
    () => parseEvent(makeEvent({ closed_reason: 'whatever' as unknown as EventRecord['closed_reason'] }), 'write'),
    SchemaError,
    '越界的闭合原因必须在写入边界拦住',
  );
  assert.throws(
    () => parseEvent(withoutField('closed_reason'), 'write'),
    SchemaError,
    '闭合原因是必填字段（缺失即契约违约）',
  );

  const parsed = parseEvent(
    makeEvent({ closed_reason: '未来的新原因' as unknown as EventRecord['closed_reason'] }),
    'read',
  );
  assert.equal(parsed.closed_reason, '未来的新原因', 'read 模式原样保留未知闭合原因');
});

test('闭合原因：字段名已登记进 EVENT_FIELDS（否则写入会被未知字段拦下）', () => {
  assert.ok(EVENT_FIELDS.includes('closed_reason'));
  assert.equal(isForbiddenFieldName('closed_reason'), false, '闭合原因不含「重要性」类语义');
});

// ── 摘要长度口径（码点）──────────────────────────────────────────────────

test('摘要长度：按码点计（emoji 不算两个字），与契约层唯一实现一致', () => {
  // 600 个代理对字符 = 600 码点 / 1200 码元：码点口径放行、码元口径会误拒。
  const emoji = '😀'.repeat(600);
  assert.equal(emoji.length, 1200, 'UTF-16 码元数是码点数的两倍');
  assert.equal(summaryLengthOf(emoji), 600, '码点口径 = 600');
  assert.equal(
    parseEvent(makeEvent({ summary: emoji, summary_quality: 'ready', summary_source: 'llm' }), 'write')
      .summary?.length,
    1200,
    '落盘的仍是原文（长度校验按码点放行）',
  );

  // 601 个 emoji = 601 码点 → 超限，按码点口径必须拒收。
  const tooLong = '😀'.repeat(601);
  assert.equal(summaryLengthOf(tooLong), 601);
  assert.throws(
    () =>
      parseEvent(
        makeEvent({ summary: tooLong, summary_quality: 'ready', summary_source: 'llm' }),
        'write',
      ),
    SchemaError,
    '超过 600 码点必须拒收（否则闭合管线放行、落盘被拒 → 假故障）',
  );

  // 汉字不受影响（码点 == 码元）。
  assert.equal(summaryLengthOf('事'.repeat(600)), 600);
  assert.throws(() => parseEvent(makeEvent({ summary: '事'.repeat(601) }), 'write'), SchemaError);
});

// ── 溯源两字段（设计稿 v1.1 §3.2）──────────────────────────────────────

test('溯源：summary_prompt_version / summary_model 可空、可为字符串，非字符串一律拒收', () => {
  // 可空（她手写 / 未生成）
  const empty = parseEvent(
    makeEvent({ summary_prompt_version: null, summary_model: null }),
    'write',
  );
  assert.equal(empty.summary_prompt_version, null);
  assert.equal(empty.summary_model, null);

  // 有值
  const filled = parseEvent(
    makeEvent({ summary_prompt_version: 'v1', summary_model: 'dsh-pro' }),
    'write',
  );
  assert.equal(filled.summary_prompt_version, 'v1');
  assert.equal(filled.summary_model, 'dsh-pro');

  // 类型错（数字 / 对象）→ 拒收，不做隐式转换
  assert.throws(
    () => parseEvent({ ...makeEvent(), summary_prompt_version: 1 } as unknown as EventRecord, 'write'),
    SchemaError,
  );
  assert.throws(
    () => parseEvent({ ...makeEvent(), summary_model: { name: 'x' } } as unknown as EventRecord, 'write'),
    SchemaError,
  );
});

test('溯源：老行没有这两个键 → read 模式读成 null（不是报错、不是编造版本号）', () => {
  const raw = { ...makeEvent() } as Record<string, unknown>;
  delete raw['summary_prompt_version'];
  delete raw['summary_model'];

  const parsed = parseEvent(raw, 'read');
  assert.equal(parsed.summary_prompt_version, null, '「没有」读成「不知道」');
  assert.equal(parsed.summary_model, null);
});

test('红线：禁字段名递归查 —— 嵌在数组 / 对象里同样拦得住（m3）', () => {
  // 顶层偷偷塞
  assert.throws(
    () => parseEvent({ ...makeEvent(), score: 0.9 } as unknown as EventRecord, 'write'),
    /被禁止的字段名/,
  );
  // 藏在嵌套对象里（原来只查顶层 → 这里会静默通过）
  assert.throws(
    () =>
      parseEvent(
        {
          ...makeEvent(),
          boundary_candidates: [
            { kind: '话题跳转', at_pointer_id: 'r1', marked_at: '2026-11-08T10:00:00.000Z', importance: 3 },
          ],
        } as unknown as EventRecord,
        'write',
      ),
    /boundary_candidates\[0\]\.importance/,
    '错误信息要带路径，否则改起来只能靠猜',
  );
  // 藏在指针里
  assert.throws(
    () =>
      parseEvent(
        { ...makeEvent(), pointers: [{ id: 'r1', session_id: 's-1' }] } as unknown as EventRecord,
        'write',
      ),
    /pointers\[0\]\.session_id/,
  );
});
