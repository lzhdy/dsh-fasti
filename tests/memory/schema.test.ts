/**
 * C1 · schema 守门测试（方案 §3.2 / §4.1 / §11 M6）。
 *
 * 覆盖：
 *  - MEMORY_SCHEMA_VERSION 与期望表/列/索引数组同实际建库结果逐项一致；
 *  - 禁列纪律（M6）：DDL 文本与真实库列都不得出现 summary/body/raw_text/
 *    emotion/mood/importance/session 等正文/情绪/会话列；
 *  - CHECK 约束真能拦截违约行（card_type/selection/status/weight/
 *    discriminator 长度/entity_hint 恒 NULL/display_cues 数量）；
 *  - M6 静态扫描：实时链路不得 import memory；memory 不得 import 门面；
 *    package.json dependencies 节文本不变；
 *  - M6 投毒自证：六种违规形态 + 门面违规在临时目录合成探针各断言标红，
 *    合规样例（node: 内置 + ../core）断言零误报；门与自证共用纯函数。
 *
 * 纪律：全部在 tests/helpers 同款临时根运行，绝不触碰真实数据根。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  MEMORY_SCHEMA_VERSION,
  MEMORY_EXPECTED_TABLES,
  MEMORY_EXPECTED_INDEXES,
  MEMORY_EXPECTED_COLUMNS,
  MEMORY_SCHEMA,
  SQL_MEM_CARD,
} from '../../src/memory/schema.ts';
import { openMemoryWrite } from '../../src/memory/store.ts';
import { withTempRoot } from '../helpers.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 禁列词（方案 §3.2 / M6）—— 以列名口径匹配，不匹配注释。 */
const FORBIDDEN_COLUMNS = [
  'summary',
  'body',
  'raw_text',
  'emotion',
  'mood',
  'importance',
  'session',
];

/** 去掉 SQL 行注释（-- 至行尾），供文本扫描用。 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const at = line.indexOf('--');
      return at >= 0 ? line.slice(0, at) : line;
    })
    .join('\n');
}

/** 从 CREATE TABLE 语句提取列名（首个标识符；跳过约束行）。 */
function columnNamesOf(createSql: string): string[] {
  const body = createSql.slice(createSql.indexOf('(') + 1, createSql.lastIndexOf(')'));
  const names: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (/^(CHECK|PRIMARY|UNIQUE|FOREIGN|CONSTRAINT)\b/i.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

test('schema 版本从 1 起', () => {
  assert.equal(MEMORY_SCHEMA_VERSION, 1);
});

test('期望表/索引清单与方案 §3.2 一致', () => {
  assert.deepEqual([...MEMORY_EXPECTED_TABLES].sort(), [
    'mem_alias',
    'mem_audit_item',
    'mem_audit_run',
    'mem_card',
    'mem_card_fts',
    'mem_miss',
    'schema_meta',
  ]);
  assert.deepEqual([...MEMORY_EXPECTED_INDEXES].sort(), [
    'idx_alias_card',
    'idx_memcard_event',
    'idx_memcard_status',
    'idx_memcard_time',
    'idx_miss_hash',
    'idx_miss_time',
  ]);
});

test('临时根开库：实际表/列/索引与期望数组逐项一致', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const handle = openMemoryWrite({ indexDir });
    try {
      const db = new DatabaseSync(path.join(indexDir, 'memory-index.sqlite'), { readOnly: true });
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all()
          .map((row) => String((row as { name: string }).name))
          // FTS5 内部影子表（*_data/_idx/_content/_docsize/_config）不属方案表集。
          .filter((name) => !name.startsWith('mem_card_fts_'))
          .sort();
        assert.deepEqual(tables, [...MEMORY_EXPECTED_TABLES].sort());

        const indexes = db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
          .all()
          .map((row) => String((row as { name: string }).name))
          .sort();
        assert.deepEqual(indexes, [...MEMORY_EXPECTED_INDEXES].sort());

        for (const [table, expected] of Object.entries(MEMORY_EXPECTED_COLUMNS)) {
          const actual = db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => {
              const r = row as { name: string; type: string };
              return [r.name, r.type];
            });
          assert.deepEqual(actual, expected.map((col) => [col[0], col[1]]), `表 ${table} 列不符`);
        }
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
  });
});

test('M6 禁列：DDL 文本（去注释）与真实库列均无禁列词', async () => {
  // 文本口径：任何一张表的列名都不得命中禁列词。
  for (const sql of MEMORY_SCHEMA) {
    const cleaned = stripSqlComments(sql);
    for (const stmt of cleaned.split(';')) {
      if (!/CREATE\s+TABLE/i.test(stmt)) continue;
      for (const name of columnNamesOf(stmt)) {
        assert.ok(
          !FORBIDDEN_COLUMNS.includes(name.toLowerCase()),
          `DDL 出现禁列 ${name}`,
        );
      }
    }
  }
  // 扫描器自证：投毒样本必须能被同一套规则检出（否则扫描器是摆设）。
  const poisoned = 'CREATE TABLE bad(summary TEXT, body TEXT, mood REAL);';
  const poisonedNames = columnNamesOf(poisoned).map((n) => n.toLowerCase());
  assert.ok(FORBIDDEN_COLUMNS.some((w) => poisonedNames.includes(w)));

  // 真实库口径：建库后逐表 PRAGMA 核对。
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const handle = openMemoryWrite({ indexDir });
    try {
      const db = new DatabaseSync(path.join(indexDir, 'memory-index.sqlite'), { readOnly: true });
      try {
        for (const table of MEMORY_EXPECTED_TABLES) {
          const cols = db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => String((row as { name: string }).name).toLowerCase());
          for (const word of FORBIDDEN_COLUMNS) {
            assert.ok(!cols.includes(word), `表 ${table} 出现禁列 ${word}`);
          }
        }
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
  });
});

test('mem_card CHECK 约束真能拦截违约行', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const handle = openMemoryWrite({ indexDir });
    try {
      const db = new DatabaseSync(path.join(indexDir, 'memory-index.sqlite'));
      try {
        const base: Record<string, unknown> = {
          card_id: 'mc_test',
          event_id: 'ev1',
          anchor_json: '["exp1"]',
          channel: 'dsh',
          card_type: 'event',
          selection: 'selected',
          weight: 0,
          display_cues_json: '["线索一"]',
          aliases_json: '[]',
          discriminator: '区别性短句',
          entity_hint_json: null,
          occurred_ms: 1,
          ended_ms: 2,
          valid_ms: 1,
          invalid_ms: null,
          created_ms: 1,
          expired_ms: null,
          status: 'active',
          content_hash: 'h',
          hit_count: 0,
          last_hit_ms: null,
          schema_version: 1,
        };
        const columns = Object.keys(base);
        const insert = db.prepare(
          `INSERT INTO mem_card(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        );
        const attempt = (overrides: Record<string, unknown>): void => {
          const row = { ...base, ...overrides };
          insert.run(...columns.map((c) => row[c] as string | number | null));
        };

        // 合法行可落库（随后清理，避免主键冲突）。
        attempt({});
        db.exec("DELETE FROM mem_card WHERE card_id='mc_test'");

        assert.throws(() => attempt({ card_type: 'note' }), /CHECK/);
        assert.throws(() => attempt({ selection: 'maybe' }), /CHECK/);
        assert.throws(() => attempt({ status: 'paused' }), /CHECK/);
        assert.throws(() => attempt({ weight: 1.5 }), /CHECK/);
        assert.throws(() => attempt({ weight: -0.1 }), /CHECK/);
        assert.throws(() => attempt({ entity_hint_json: '["x"]' }), /CHECK/);
        assert.throws(() => attempt({ discriminator: '字'.repeat(41) }), /CHECK/);
        assert.throws(() => attempt({ display_cues_json: '[]' }), /CHECK/);
        assert.throws(() => attempt({ display_cues_json: '["a","b","c","d"]' }), /CHECK/);

        // 边界：40 码点 discriminator 与 3 条 cues 合法。
        attempt({ card_id: 'mc_ok40', discriminator: '字'.repeat(40), display_cues_json: '["a","b","c"]' });
        // 码点口径：emoji（代理对）按 1 码点计，40 个 emoji 合法。
        attempt({ card_id: 'mc_okemoji', discriminator: '😀'.repeat(40) });
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
  });
});

test('mem_alias / mem_audit_item CHECK 约束生效', async () => {
  await withTempRoot(async (root) => {
    const indexDir = path.join(root, 'projection', 'memory-index');
    const handle = openMemoryWrite({ indexDir });
    try {
      const db = new DatabaseSync(path.join(indexDir, 'memory-index.sqlite'));
      try {
        const alias = db.prepare(
          'INSERT INTO mem_alias(term_norm, card_id, source, sensitive, status, created_ms, hit_count, last_hit_ms) VALUES (?,?,?,?,?,?,?,?)',
        );
        alias.run('词', 'mc1', 'miss', 0, 'active', 1, 0, null);
        assert.throws(() => alias.run('词2', 'mc1', 'auto', 0, 'active', 1, 0, null), /CHECK/);
        assert.throws(() => alias.run('词3', 'mc1', 'miss', 2, 'active', 1, 0, null), /CHECK/);

        const item = db.prepare(
          'INSERT INTO mem_audit_item(run_id, item_no, probe_type, expected_ref, returned_refs_json, passed, detail_json) VALUES (?,?,?,?,?,?,?)',
        );
        item.run('r1', 1, 'gold', null, '[]', 1, '{}');
        assert.throws(() => item.run('r1', 2, 'unknown', null, '[]', 1, '{}'), /CHECK/);
        assert.throws(() => item.run('r1', 3, 'gold', null, '[]', 2, '{}'), /CHECK/);
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
  });
});

// ── M6 import 门：纯函数（门测试与投毒自证共用，杜绝正则漂移）─────────────

/** 参与静态扫描的源文件。relPath 为仓库相对 POSIX 路径。 */
export interface ScanFile {
  relPath: string;
  text: string;
}

export interface ImportViolation {
  relPath: string;
  spec: string;
  rule: ImportRule;
}

/** M6 违规类别（第二层 v0.3 §6 扩展 assembly 白名单门）。 */
export type ImportRule =
  | 'realtime-to-memory'
  | 'memory-to-facade'
  | 'memory-to-assembly'
  | 'assembly-denied-import'
  | 'assembly-forbidden-native'
  | 'assembly-candidate-slice';

/** 实时链路目录（规则①作用域）。 */
const REALTIME_DIRS = ['src/api/', 'src/event/', 'src/source/', 'src/adapters/'];

/** 唯一允许单向白名单依赖 memory 的装配目录（v0.3 §6.2）。 */
const ASSEMBLY_DIR = 'src/assembly/';

/**
 * 装配层值导入白名单（默认拒绝、显式枚举；N13-ii）：
 * key=memory 模块 basename，value=该模块允许被 assembly 以值形式命名引用的符号集。
 * import type 整体编译擦除、不具运行时反射面，豁免命名校验；其余一切值导入默认拒绝。
 */
const ASSEMBLY_VALUE_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  runtime: new Set(['openMemoryRuntime']),
  gate: new Set(['applyGate', 'normalizeLexicalText']),
  serial: new Set(['buildSerialMap', 'resolveSerials', 'isSerialRefusable']),
};

/** 装配层禁止的内置模块（不得自开连接/直开文件，N1）。 */
const ASSEMBLY_FORBIDDEN_NATIVE = new Set(['node:sqlite', 'node:fs']);

interface ImportRecord {
  spec: string;
  typeOnly: boolean;
  namespace: boolean;
  sideEffect: boolean;
  names: string[];
}

/** 取 spec 指向的 memory 模块 basename（去 .ts）；非 memory 路径返回 null。 */
function memoryModuleOf(spec: string): string | null {
  if (!/(^|\/)memory\//.test(spec)) return null;
  const last = spec.split('/').pop();
  return (last ?? '').replace(/\.ts$/, '');
}

/**
 * 剥除 TS 行/块注释，供“代码形态”文本规则使用（禁自开连接/禁预切片只判可执行代码，
 * 不判解释纪律的注释文字；与禁列扫描先 stripSqlComments 同理念）。
 * 本仓受控源码无字符串内 // 或 /* 序列，逐行取首个 // 之前片段即可。
 */
function stripTsComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.split('//')[0] ?? '')
    .join('\n');
}

/**
 * 解析单文件 import 记录（门与投毒自证共用）：
 * 覆盖 static/import type/namespace/default/花括号命名/副作用/re-export；动态 import() 记为命名空间级依赖。
 */
export function extractImportRecords(text: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  const clause =
    /(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = clause.exec(text)) !== null) {
    const typeOnly = match[1] !== undefined;
    const binding = (match[2] ?? '').trim();
    const spec = match[3] as string;
    const namespace = /^\*|\sas\s+/.test(binding) || binding.startsWith('*');
    const names: string[] = [];
    const brace = /\{([\s\S]*?)\}/.exec(binding);
    if (brace?.[1] !== undefined) {
      for (const raw of brace[1].split(',')) {
        const cleaned = raw.trim().replace(/^type\s+/, '');
        const ident = /^[A-Za-z_$][\w$]*$/.exec(cleaned)?.[0];
        if (ident !== undefined) names.push(ident);
      }
    }
    records.push({ spec, typeOnly, namespace, sideEffect: false, names });
  }
  const sideEffect = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while ((match = sideEffect.exec(text)) !== null) {
    if (match[1] !== undefined) {
      records.push({ spec: match[1], typeOnly: false, namespace: false, sideEffect: true, names: [] });
    }
  }
  const dynamic = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamic.exec(text)) !== null) {
    if (match[1] !== undefined) {
      records.push({ spec: match[1], typeOnly: false, namespace: true, sideEffect: false, names: [] });
    }
  }
  return records;
}

/**
 * 提取 import/export specifier，覆盖六种形态：
 * static import / import type / re-export…from / export type…from /
 * 副作用 import（无 from）/ 动态 import()。
 */
export function extractImportSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dyn.exec(text)) !== null) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  return specs;
}

/**
 * 规则①：实时四目录不得相对 import memory；
 * 规则②：memory 不得 import 门面，也不得反向依赖 assembly（保持依赖单向，N13）；
 * 规则④：assembly 仅可按白名单值引用 memory，禁 node:fs/node:sqlite/自开连接/候选预切片（v0.3 §6）。
 */
export function findImportViolations(files: readonly ScanFile[]): ImportViolation[] {
  const violations: ImportViolation[] = [];
  const push = (relPath: string, spec: string, rule: ImportRule): void => {
    violations.push({ relPath, spec, rule });
  };
  for (const file of files) {
    const relPath = file.relPath.split('\\').join('/');
    const inRealtime = REALTIME_DIRS.some((dir) => relPath.startsWith(dir));
    const inMemory = relPath.startsWith('src/memory/');
    const inAssembly = relPath.startsWith(ASSEMBLY_DIR);

    // 规则①/②沿用六形态提取器，保证既有投毒零漂移。
    for (const spec of extractImportSpecifiers(file.text)) {
      if (inRealtime && spec.startsWith('.') && /(^|\/)memory(\/|$)/.test(spec)) {
        push(relPath, spec, 'realtime-to-memory');
      }
      if (inMemory) {
        if (spec.includes('/api/') || spec.endsWith('/api')) {
          push(relPath, spec, 'memory-to-facade');
        }
        if (/(^|\/)assembly(\/|$)/.test(spec)) {
          push(relPath, spec, 'memory-to-assembly');
        }
      }
    }

    // 规则④：assembly 白名单门（按 import 记录精细判定）。
    if (inAssembly) {
      for (const record of extractImportRecords(file.text)) {
        if (ASSEMBLY_FORBIDDEN_NATIVE.has(record.spec)) {
          push(relPath, record.spec, 'assembly-forbidden-native');
        }
        const mod = memoryModuleOf(record.spec);
        if (mod === null) continue;
        // import type 编译擦除，豁免值白名单；其余 memory 依赖一律按值面审查。
        if (record.typeOnly) continue;
        if (record.sideEffect || record.namespace) {
          push(relPath, record.spec, 'assembly-denied-import');
          continue;
        }
        const allowed = ASSEMBLY_VALUE_ALLOWLIST[mod];
        if (allowed === undefined) {
          push(relPath, record.spec, 'assembly-denied-import');
          continue;
        }
        for (const name of record.names) {
          if (!allowed.has(name)) push(relPath, `${record.spec} :: ${name}`, 'assembly-denied-import');
        }
      }
      // 双保险：即使绕过 import 形态，自开连接/门前进片切片同样标红（只判代码、不判注释）。
      const code = stripTsComments(file.text);
      if (/\bnew\s+DatabaseSync\b/.test(code)) {
        push(relPath, '<new DatabaseSync(...)>', 'assembly-forbidden-native');
      }
      if (/\.(slice|splice)\s*\(/.test(code)) {
        push(relPath, '<candidate pre-slice>', 'assembly-candidate-slice');
      }
    }
  }
  return violations;
}

function readTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('M6 静态扫描：实时链路不依赖 memory，memory 不依赖门面，dependencies 节文本不变', () => {
  // 与投毒自证共用同一套纯函数（extractImportSpecifiers / findImportViolations），杜绝正则漂移。
  const files: ScanFile[] = [];
  for (const dir of ['src/api', 'src/event', 'src/source', 'src/adapters', 'src/memory', 'src/assembly']) {
    for (const full of readTsFiles(path.join(REPO_ROOT, dir))) {
      files.push({
        relPath: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
        text: fs.readFileSync(full, 'utf8'),
      });
    }
  }
  assert.deepEqual(findImportViolations(files), [], 'M6 import 门出现违规');

  // ③ package.json dependencies 节文本必须仍是 {}。
  const pkgText = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  const match = /"dependencies"\s*:\s*\{[^}]*\}/.exec(pkgText);
  assert.ok(match !== null, 'package.json 缺少 dependencies 节');
  assert.equal(match[0].replace(/\s+/g, ''), '"dependencies":{}');
});

// ── M6 投毒自证 ───────────────────────────────────────────────────────────
// 探针在 withTempRoot 临时目录合成：relPath 是**合成的**仓库相对路径，
// 文件绝不写入真实 src/、绝不被运行时加载（只读文本做静态判定）。
// 六种违规形态各断言被标红；合规样例断言零误报。

/** 把探针写进临时根并读回（与真实扫描同口径：读文件文本）。 */
function probeFile(root: string, relPath: string, text: string): ScanFile {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
  return { relPath, text: fs.readFileSync(full, 'utf8') };
}

function assertFlagged(file: ScanFile, spec: string, rule: ImportViolation['rule']): void {
  assert.ok(extractImportSpecifiers(file.text).includes(spec), `未提取到 specifier：${spec}`);
  const violations = findImportViolations([file]);
  assert.equal(violations.length, 1, `应恰好标红一条：${JSON.stringify(violations)}`);
  assert.equal(violations[0]?.spec, spec);
  assert.equal(violations[0]?.rule, rule);
}

test('M6 投毒自证：static import 相对 memory → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/api/probe.ts',
      "import { openMemoryRead } from '../memory/store.ts';\n",
    );
    assertFlagged(file, '../memory/store.ts', 'realtime-to-memory');
  });
});

test('M6 投毒自证：import type 相对 memory → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/api/probe.ts',
      "import type { MemoryCard } from '../memory/types.ts';\n",
    );
    assertFlagged(file, '../memory/types.ts', 'realtime-to-memory');
  });
});

test('M6 投毒自证：re-export … from 相对 memory → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/event/probe.ts',
      "export { openMemoryRead } from '../memory/store.ts';\n",
    );
    assertFlagged(file, '../memory/store.ts', 'realtime-to-memory');
  });
});

test('M6 投毒自证：export type … from 相对 memory → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/source/probe.ts',
      "export type { MemoryCard } from '../memory/types.ts';\n",
    );
    assertFlagged(file, '../memory/types.ts', 'realtime-to-memory');
  });
});

test('M6 投毒自证：动态 import() 相对 memory → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/adapters/probe.ts',
      "async function load() {\n  return import('../memory/store.ts');\n}\n",
    );
    assertFlagged(file, '../memory/store.ts', 'realtime-to-memory');
  });
});

test('M6 投毒自证：副作用 import（无 from）相对 memory → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(root, 'src/api/probe.ts', "import '../memory/store.ts';\n");
    assertFlagged(file, '../memory/store.ts', 'realtime-to-memory');
  });
});

test('M6 投毒自证：memory 依赖门面（../api/）→ 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/memory/probe.ts',
      "import { facade } from '../api/index.ts';\n",
    );
    assertFlagged(file, '../api/index.ts', 'memory-to-facade');
  });
});

test('M6 合规样例：node: 内置 + ../core 引用 → 零误报', async () => {
  await withTempRoot(async (root) => {
    const text = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { IntegrityError } from '../core/errors.ts';",
      "export { ulid } from '../core/ulid.ts';",
      '',
    ].join('\n');
    const file = probeFile(root, 'src/api/compliant.ts', text);
    assert.deepEqual(extractImportSpecifiers(file.text), [
      'node:fs',
      'node:path',
      '../core/errors.ts',
      '../core/ulid.ts',
    ]);
    assert.deepEqual(findImportViolations([file]), []);
  });
});

// ── WP3：assembly 白名单门投毒自证（v0.3 §6.3，默认拒绝+显式枚举）────────────

/** assembly 探针断言：恰好一条且规则命中；specPart 给定时做包含校验。 */
function assertAssemblyFlagged(
  file: ScanFile,
  rule: ImportRule,
  specPart?: string,
): void {
  const violations = findImportViolations([file]);
  assert.equal(violations.length, 1, `应恰好一条违规：${JSON.stringify(violations)}`);
  assert.equal(violations[0]?.rule, rule);
  if (specPart !== undefined) {
    assert.ok((violations[0]?.spec ?? '').includes(specPart), `spec 未包含 ${specPart}：${violations[0]?.spec}`);
  }
}

test('WP3 投毒：assembly 引 store 工厂（openMemoryWrite）→ 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/assembly/probe.ts',
      "import { openMemoryWrite } from '../memory/store.ts';\n",
    );
    assertAssemblyFlagged(file, 'assembly-denied-import', '../memory/store.ts');
  });
});

test('WP3 投毒：assembly 引 bm25（含 normalizeQuery）→ 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/assembly/probe.ts',
      "import { normalizeQuery } from '../memory/bm25.ts';\n",
    );
    assertAssemblyFlagged(file, 'assembly-denied-import', '../memory/bm25.ts');
  });
});

test('WP3 投毒：assembly 引账本函数 appendDecision → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/assembly/probe.ts',
      "import { appendDecision } from '../memory/ledger.ts';\n",
    );
    assertAssemblyFlagged(file, 'assembly-denied-import', '../memory/ledger.ts');
  });
});

test('WP3 投毒：assembly 命名空间 import memory（绕过符号枚举）→ 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/assembly/probe.ts',
      "import * as memory from '../memory/runtime.ts';\n",
    );
    assertAssemblyFlagged(file, 'assembly-denied-import', '../memory/runtime.ts');
  });
});

test('WP3 投毒：assembly 动态 import() memory → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/assembly/probe.ts',
      "async function load() { return import('../memory/runtime.ts'); }\n",
    );
    assertAssemblyFlagged(file, 'assembly-denied-import', '../memory/runtime.ts');
  });
});

test('WP3 投毒：assembly 从白名单模块取枚举外符号（hasAsciiWordBoundary）→ 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/assembly/probe.ts',
      "import { hasAsciiWordBoundary } from '../memory/gate.ts';\n",
    );
    assertAssemblyFlagged(file, 'assembly-denied-import', 'hasAsciiWordBoundary');
  });
});

test('N16 投毒：assembly 直接引影子 fs 窄原语（openShadowObservationSink）→ 标红，只能经窄柄第六方法', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/assembly/probe.ts',
      "import { openShadowObservationSink } from '../memory/shadow-write.ts';\n",
    );
    assertAssemblyFlagged(file, 'assembly-denied-import', '../memory/shadow-write.ts');
  });
});

test('WP3 投毒：assembly import node:sqlite → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(root, 'src/assembly/probe.ts', "import { DatabaseSync } from 'node:sqlite';\n");
    assertAssemblyFlagged(file, 'assembly-forbidden-native', 'node:sqlite');
  });
});

test('WP3 投毒：assembly import node:fs → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(root, 'src/assembly/probe.ts', "import fs from 'node:fs';\n");
    assertAssemblyFlagged(file, 'assembly-forbidden-native', 'node:fs');
  });
});

test('WP3 投毒：assembly 无 import 也不得 new DatabaseSync → 标红', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(root, 'src/assembly/probe.ts', 'const db = new DatabaseSync(path);\n');
    assertAssemblyFlagged(file, 'assembly-forbidden-native', 'new DatabaseSync');
  });
});

test('WP3 投毒：assembly 门前进片 .slice/.splice → 标红（N11 防线③）', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(root, 'src/assembly/probe.ts', 'const head = candidates.slice(0, 1);\n');
    assertAssemblyFlagged(file, 'assembly-candidate-slice');
  });
});

test('WP3 投毒：memory 反向依赖 assembly → 标红（依赖单向）', async () => {
  await withTempRoot(async (root) => {
    const file = probeFile(
      root,
      'src/memory/probe.ts',
      "import { runGatedSearch } from '../assembly/index.ts';\n",
    );
    assertFlagged(file, '../assembly/index.ts', 'memory-to-assembly');
  });
});

test('WP3 合规样例：assembly 白名单值导入 + import type + node:path/core → 零误报', async () => {
  await withTempRoot(async (root) => {
    const text = [
      "import { openMemoryRuntime } from '../memory/runtime.ts';",
      "import { applyGate, normalizeLexicalText } from '../memory/gate.ts';",
      "import { buildSerialMap, resolveSerials, isSerialRefusable } from '../memory/serial.ts';",
      "import type { GatedSearchOutcome, ExplainedRankedCard } from '../memory/types.ts';",
      "import type { RuntimeMemoryHandle, RuntimeSearchQuery } from '../memory/runtime.ts';",
      "import path from 'node:path';",
      "import { UnavailableError } from '../core/errors.ts';",
      '// 纪律注释提及 new DatabaseSync(...) 与 candidates.slice( 不应被文本规则误判',
      '',
    ].join('\n');
    const file = probeFile(root, 'src/assembly/compliant.ts', text);
    assert.deepEqual(findImportViolations([file]), []);
  });
});

test('SQL_MEM_CARD 不含任何正文/情绪/会话列（单列口径复核）', () => {
  const cleaned = stripSqlComments(SQL_MEM_CARD);
  const names = columnNamesOf(cleaned.slice(cleaned.indexOf('CREATE TABLE'), cleaned.indexOf('CREATE INDEX')));
  assert.deepEqual(names, [
    'card_id',
    'event_id',
    'anchor_json',
    'channel',
    'card_type',
    'selection',
    'weight',
    'display_cues_json',
    'aliases_json',
    'discriminator',
    'entity_hint_json',
    'occurred_ms',
    'ended_ms',
    'valid_ms',
    'invalid_ms',
    'created_ms',
    'expired_ms',
    'status',
    'content_hash',
    'hit_count',
    'last_hit_ms',
    'schema_version',
  ]);
});

// ── WP4b 宿主包边界门（平台化前置）────────────────────────────────────────
// 宿主框架包（@deepseek-ai/*）只允许出现在 DSH 适配器目录 src/adapters/dsh/；
// 内核全域（core/memory/assembly/api/event/source/projection/contract/runtime）
// 任何形态（static/type/动态 import）引用宿主包都标红。这样 DSH 升级/更换框架时
// 冲击被物理限制在适配器一个目录，内核保持框架无关。复用 M6 同一 import 提取口径。

const HOST_PACKAGE_SCOPE = '@deepseek-ai/';
const HOST_PACKAGE_ALLOWED_PREFIX = 'src/adapters/dsh/';

interface HostPackageViolation {
  relPath: string;
  spec: string;
}

/** 纯判定：返回豁免目录之外、对宿主包的全部违规引用。 */
function findHostPackageViolations(files: readonly ScanFile[]): HostPackageViolation[] {
  const bad: HostPackageViolation[] = [];
  for (const file of files) {
    if (file.relPath.startsWith(HOST_PACKAGE_ALLOWED_PREFIX)) continue;
    for (const spec of extractImportSpecifiers(file.text)) {
      if (spec.startsWith(HOST_PACKAGE_SCOPE)) {
        bad.push({ relPath: file.relPath, spec });
      }
    }
  }
  return bad;
}

test('WP4b 宿主包边界：除 src/adapters/dsh 外，src 全域零 @deepseek-ai/* 引用', () => {
  const files: ScanFile[] = [];
  for (const full of readTsFiles(path.join(REPO_ROOT, 'src'))) {
    files.push({
      relPath: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
      text: fs.readFileSync(full, 'utf8'),
    });
  }
  assert.deepEqual(findHostPackageViolations(files), [], '内核出现宿主包引用，框架无关边界被破坏');
});

test('WP4b 投毒自证：内核引 @deepseek-ai/* 标红；adapters/dsh 豁免、node/相对引用零误报', async () => {
  await withTempRoot(async (root) => {
    const poisonedMemory = probeFile(
      root,
      'src/memory/probe.ts',
      "import { defineTool } from '@deepseek-ai/dsh-tools';\n",
    );
    const poisonedAssembly = probeFile(
      root,
      'src/assembly/probe.ts',
      "import type { Context } from '@deepseek-ai/cordis';\n",
    );
    const allowedAdapter = probeFile(
      root,
      'src/adapters/dsh/real.ts',
      "import { defineTool } from '@deepseek-ai/dsh-tools';\n",
    );
    const cleanNative = probeFile(root, 'src/core/probe.ts', "import fs from 'node:fs';\n");
    const cleanRelative = probeFile(root, 'src/memory/probe2.ts', "import { x } from './types.ts';\n");

    const violations = findHostPackageViolations([
      poisonedMemory,
      poisonedAssembly,
      allowedAdapter,
      cleanNative,
      cleanRelative,
    ]);
    const rels = violations.map((v) => `${v.relPath}:${v.spec}`).sort();
    assert.deepEqual(rels, [
      'src/assembly/probe.ts:@deepseek-ai/cordis',
      'src/memory/probe.ts:@deepseek-ai/dsh-tools',
    ]);
  });
});