/**
 * #42 · B2 第四批：api 记忆投影端口 + assembly DI + worker 接线 + 版本上下文统一注入。
 *
 * 被测 seam（写者在 B2 内落地，批内红→绿）：
 *  - `src/api/index.ts`：门面方法 `drainMemoryProjection(budgetMs)` + 本地结构类型
 *    `MemoryProjectionDrainPort`；`FastiOptions.memoryProjection` 注入口；端口未注入 →
 *    `skipped:'not-wired'` 且零写入；端口失败被隔离，不阻断 closure。
 *  - assembly 只做 DI：把端口绑到 `openMemoryRuntime` 返回的窄柄；不自开 DB/文件、不编排业务。
 *  - 决策版本上下文：create-card / invalidate / add-alias 三处从同一处注入 version +
 *    createdAtIso，add-alias 不得再硬编码 `version: 1`。
 *
 * 纪律：只写测试；临时 DSH_HOME，真实数据根零写入；不碰 src/docs；无 git 写操作。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Fasti, type FastiOptions } from '../../src/api/index.ts';
import { cleanupTempRoot, listTree, makeTempRoot } from '../helpers.ts';

// ── import 形态提取（与 schema.test.ts 同口径副本；不从 .test.ts 导入，避免用例重复注册）──

interface ImportRecord {
  readonly spec: string;
  readonly typeOnly: boolean;
  readonly namespace: boolean;
  readonly sideEffect: boolean;
  readonly names: string[];
}

function extractImportRecords(text: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  const clause = /(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
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

function extractImportSpecifiers(text: string): string[] {
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface ScanFile {
  readonly relPath: string;
  readonly text: string;
}

function readTsFiles(dir: string): ScanFile[] {
  const out: ScanFile[] = [];
  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push({
          relPath: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
          text: fs.readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(dir);
  return out;
}

function stripTsComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.split('//')[0] ?? '')
    .join('\n');
}

/** api→memory 独立规则码（P-04 只挡 assembly；本条专挡 api 端口层反向依赖 memory）。 */
const API_MEMORY_RULE = 'api-to-memory';

function findApiMemoryViolations(files: readonly ScanFile[]): ScanFile[] {
  const bad: ScanFile[] = [];
  for (const file of files) {
    if (!file.relPath.startsWith('src/api/')) continue;
    const leaked = extractImportSpecifiers(file.text).filter((spec) => /memory\//.test(spec));
    if (leaked.length > 0) bad.push(file);
  }
  return bad;
}

/** 反射取门面方法（seam 未落地期不连坐类型检查；调用前断言函数形态）。 */
function methodOf(handle: object, name: string): (...args: unknown[]) => Promise<unknown> {
  const rec = handle as Record<string, unknown>;
  const fn = rec[name];
  assert.equal(typeof fn, 'function', `门面须暴露 ${name}`);
  return fn as (...args: unknown[]) => Promise<unknown>;
}

// ── 1. api 端口形状 ────────────────────────────────────────────────────────

test('api 端口：门面暴露 drainMemoryProjection 方法，本地声明 MemoryProjectionDrainPort 结构类型', () => {
  const methods = Fasti.prototype as unknown as Record<string, unknown>;
  assert.equal(
    typeof methods.drainMemoryProjection,
    'function',
    'Fasti 须挂记忆投影第七法门面方法 drainMemoryProjection',
  );

  const indexText = fs.readFileSync(path.join(REPO_ROOT, 'src/api/index.ts'), 'utf8');
  assert.match(
    indexText,
    /(interface|type)\s+MemoryProjectionDrainPort\b/,
    'api 须在本地声明结构类型 MemoryProjectionDrainPort（不得 import memory 类型）',
  );
  // 本地结构类型必须声明窄柄同形的 drainProjection 方法面。
  const typeBlock = /(?:interface|type)\s+MemoryProjectionDrainPort[^{]*\{([\s\S]*?)\}/.exec(indexText);
  assert.ok(typeBlock !== null, 'MemoryProjectionDrainPort 须为可解析的对象结构类型');
  assert.match(typeBlock[1] ?? '', /drainProjection\s*\(/, '端口类型须声明 drainProjection(budgetMs) 方法');
});

test('api 端口层零 memory 导入：static / import type / 动态 import() / re-export 全形态', () => {
  const apiFiles = readTsFiles(path.join(REPO_ROOT, 'src/api'));
  const violations = findApiMemoryViolations(apiFiles);
  assert.deepEqual(
    violations.map((v) => v.relPath),
    [],
    'api 端口层不得相对/动态/re-export 引用 memory（含 import type，编译擦除也不允许反向依赖）',
  );
});

test('api→memory 投毒自证：src/api/probe.ts 引 ../memory/store.ts 被门标红（证明门非恰好为空）', () => {
  const root = makeTempRoot('wiring-poison-');
  try {
    const probeRel = 'src/api/probe.ts';
    const probeFull = path.join(root, probeRel);
    fs.mkdirSync(path.dirname(probeFull), { recursive: true });
    fs.writeFileSync(probeFull, "import { openMemoryWrite } from '../memory/store.ts';\n", 'utf8');
    const file: ScanFile = { relPath: probeRel, text: fs.readFileSync(probeFull, 'utf8') };
    const flagged = findApiMemoryViolations([file]);
    assert.equal(flagged.length, 1, `投毒样本须恰好标红一条：${API_MEMORY_RULE}`);
    const specs = extractImportSpecifiers(file.text);
    assert.ok(specs.includes('../memory/store.ts'), '提取器须捕到该 specifier');
  } finally {
    cleanupTempRoot(root);
  }
});

// ── 2. 未注入端口 → not-wired 短路，零写入 ──────────────────────────────────

test('未注入记忆端口：drainMemoryProjection 返 skipped=not-wired，投影目录树前后不变', async () => {
  const root = makeTempRoot('wiring-notwired-');
  let fasti: Fasti | null = null;
  try {
    fasti = await Fasti.open({ dataRoot: root });
    const before = listTree(root);
    const drain = methodOf(fasti, 'drainMemoryProjection');
    const report = (await drain(60_000)) as Record<string, unknown>;
    assert.equal(report.skipped, 'not-wired', '端口未注入须短路 not-wired');
    assert.deepEqual(listTree(root), before, 'not-wired 短路零写入（不产生投影文件/不改台账）');
  } finally {
    await fasti?.close();
    cleanupTempRoot(root);
  }
});

test('记忆 drain 失败隔离：端口抛错不冒泡，closure 本轮照常完成（互不阻断、预算独立）', async () => {
  const root = makeTempRoot('wiring-isolated-');
  let fasti: Fasti | null = null;
  try {
    const failingPort = {
      drainProjection: async (): Promise<Record<string, never>> => {
        throw new Error('memory drain down（注入故障样本）');
      },
    };
    const options = { dataRoot: root, memoryProjection: failingPort } as unknown as FastiOptions;
    fasti = await Fasti.open(options);

    // 记忆 drain 抛错被端口层隔离：方法本身不得把故障抛到门面调用方。
    const drain = methodOf(fasti, 'drainMemoryProjection');
    const report = await drain(60_000);
    assert.equal(typeof report, 'object', '隔离后仍返回轮报告（不得上抛）');

    // closure 是独立链路：记忆 drain 故障不影响闭合管线本轮执行。
    const closure = methodOf(fasti, 'drainClosure');
    const processed = await closure(10, 1000);
    assert.equal(typeof processed, 'number', 'drainClosure 照常返回本轮处理条数');
  } finally {
    await fasti?.close();
    cleanupTempRoot(root);
  }
});

// ── 3. assembly 只做 DI：不自开连接/文件，不编排业务 ─────────────────────────

const ASSEMBLY_FORBIDDEN_NATIVE = ['node:fs', 'node:sqlite'] as const;
const ASSEMBLY_FORBIDDEN_BUSINESS_MEMORY = [
  'store.ts',
  'ledger.ts',
  'builder.ts',
  'alias-write.ts',
  'miss.ts',
  'planner.ts',
  'decision.ts',
  'derive.ts',
  'drain.ts',
  'observations.ts',
  'shadow-write.ts',
] as const;

test('assembly DI 门：无 node:fs/node:sqlite/DatabaseSync，不 import 业务编排 memory 模块', () => {
  const assemblyFiles = readTsFiles(path.join(REPO_ROOT, 'src/assembly'));
  for (const file of assemblyFiles) {
    const code = stripTsComments(file.text);
    for (const native of ASSEMBLY_FORBIDDEN_NATIVE) {
      assert.ok(
        !extractImportSpecifiers(file.text).includes(native),
        `${file.relPath} 不得自开内置 ${native}（IO 一律经注入窄柄）`,
      );
    }
    assert.ok(!/\bnew\s+DatabaseSync\b/.test(code), `${file.relPath} 不得 new DatabaseSync`);
    // import type 编译擦除、不具运行时反射面，沿用既有 assembly 白名单口径豁免值面审查。
    for (const record of extractImportRecords(file.text)) {
      if (record.typeOnly) continue;
      for (const business of ASSEMBLY_FORBIDDEN_BUSINESS_MEMORY) {
        assert.ok(
          !record.spec.endsWith(business),
          `${file.relPath} 不得直接装配业务模块 ${business}；DI 只绑 runtime 窄柄`,
        );
      }
    }
  }
});

// ── 4. 版本上下文统一注入 ───────────────────────────────────────────────────

test('版本上下文：add-alias 决策不再硬编码 version=1；castDecision 版本来自统一上下文入参', () => {
  const storeText = fs.readFileSync(path.join(REPO_ROOT, 'src/memory/store.ts'), 'utf8');
  const code = stripTsComments(storeText);

  // add-alias 决策块不得再写死版本号 1；版本/时间须由注入的事件版本上下文提供。
  const aliasCastBlock = /action:\s*'add-alias'[\s\S]*?\}/.exec(code);
  if (aliasCastBlock !== null) {
    assert.ok(
      !/version\s*:\s*1\b/.test(aliasCastBlock[0]),
      'add-alias 决策不得硬编码 version=1；版本上下文须与 create-card/invalidate 同一处注入',
    );
  }

  // 全部 castDecision 调用点：version 字段须绑定标识符（上下文），不得是数字字面量。
  const callSites = code.match(/castDecision\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(callSites.length > 0, 'store.ts 存在 castDecision 调用点可供口径复核');
  for (const site of callSites) {
    assert.ok(
      !/version\s*:\s*\d+\b/.test(site),
      `castDecision 调用点版本不得为数字字面量：${site.slice(0, 120)}`,
    );
  }
});

// ── 5. worker 调度顺序（边界登记）────────────────────────────────────────────

test('worker 接线边界：closure 调度点先于记忆 drain 调度点；api 侧两方法预算独立', () => {
  const pluginPath = path.join(REPO_ROOT, 'src/adapters/dsh/plugin.ts');
  if (!fs.existsSync(pluginPath)) return;
  const pluginText = fs.readFileSync(pluginPath, 'utf8');
  const closureIdx = Math.min(
    ...[pluginText.indexOf('checkSilenceClock'), pluginText.indexOf('drainClosure')].filter(
      (i) => i >= 0,
    ),
  );
  const memoryIdx = pluginText.indexOf('drainMemoryProjection');
  if (memoryIdx < 0) return; // 记忆 drain worker 点尚未接线：落地后本条起顺序拦截
  assert.ok(closureIdx >= 0, 'closure 调度点须存在');
  assert.ok(memoryIdx > closureIdx, 'worker 顺序：closure 先行，记忆 drain 在后；两者预算独立');
});
