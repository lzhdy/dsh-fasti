/**
 * 平台化插件化步骤4 · 内核独立性架构守卫。
 *
 * 步骤1–3 已在事实上做到「内核本体不认识任何具体适配器/宿主，挂载 dsh 必须显式装插件，
 * 不装插件时内核自带 headless 直连即可独立运行」。本文件把这条已成立的边界**物理钉死、
 * 防回潮**，只做静态文本判定（不运行时加载、不写 src/、不依赖 node_modules 实际装包）：
 *
 *  规则 1：内核（src/adapters 之外）不得 import 任何适配器 —— 适配器只能由外部宿主装配，
 *          内核不得反向认识 adapters/ 下的 dsh/headless 等任何具体后端。
 *  规则 2：headless 直连适配器不得横向依赖 dsh 适配器（宿主包零依赖另由 host-boundary 专守，
 *          本处只补适配器之间不得互相耦合这道横向墙）。
 *  规则 3：内核不得出现引号包裹的具体宿主通道 id/默认根字面（'dsh' / '.dsh'）；
 *          P6 封存合成语料以 dsh 为模拟来源，其 channel 字段是**评测语料内容**而非内核
 *          宿主认知，按封存只读纪律列入显式白名单豁免。
 *  规则 4：package.json 生产 dependencies 恒为空对象（正本 9.5/11.13.2：零第三方运行时依赖，
 *          宿主能力一律走 peerDependencies＋端口注入）。
 *
 * 边界：本守卫只核验既有事实，不新增任何运行时能力；宿主无关启动器/CLI、插件加载器、
 * 新端口仍属 11.13/#72 未解冻事项，不在本文件授权范围。
 *
 * import 提取正则与 host-boundary.test.ts / layer-imports.test.ts 逐字同口径
 * （覆盖 static / import type / re-export / 副作用 / 动态 import()）；自带副本而非
 * import '*.test.ts'，防跨测试文件连带重复注册对方的 test()。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const ADAPTERS_PREFIX = path.posix.join('src', 'adapters') + '/';
const HEADLESS_PREFIX = path.posix.join('src', 'adapters', 'headless') + '/';

/**
 * P6 封存语料白名单：这两个文件里的 'dsh' 是合成世界/盲包对模拟来源通道的**数据内容**
 * （PlannedEvent/BlindEvent.channel），与封存 350 题强绑定、只读不改，不是内核运行时的
 * 宿主通道假设。除此之外的内核文件一律不得出现具体宿主通道字面。
 */
const CORPUS_LITERAL_ALLOWLIST: readonly string[] = [
  'src/memory/audit/corpus/world-plan.ts',
  'src/memory/audit/corpus/blind-package.ts',
  // #179：v2 蓝本同属封存语料（事件 channel 字面为 'dsh'，是语料事实而非内核默认值）。
  'src/memory/audit/corpus/world-plan-v2.ts',
  'src/memory/audit/corpus/blind-package-v2.ts',
  // task206：v3 调参世界蓝本同为封存合成语料，channel 'dsh' 是模拟来源数据内容。
  'src/memory/audit/corpus/world-plan-v3.ts',
  // task210：v3 盲包同为封存语料投影，BlindEventV3.channel 的 'dsh' 是数据内容而非内核默认。
  'src/memory/audit/corpus/blind-package-v3.ts',
];

/** 具体宿主通道 id / 旧默认根段的引号字面量（大写 DSH_HOME 环境变量名不匹配，不误伤）。 */
const HOST_LITERAL_RE = /["']dsh["']|["']\.dsh["']/;

interface ScanFile {
  relPath: string;
  text: string;
}

/** 与 host-boundary 同口径的 import/export specifier 提取（含动态 import()）。 */
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

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/** 递归收集 src 下全部 .ts（仅读文本）。 */
function readSrcTsFiles(): ScanFile[] {
  const out: ScanFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push({ relPath: toPosix(path.relative(REPO_ROOT, full)), text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

/** 判定 specifier 是否经相对路径指向任一适配器目录（src/adapters/...）。 */
function referencesAnyAdapter(spec: string): boolean {
  return spec.includes('/adapters/');
}

/**
 * 判定 headless（位于 src/adapters/headless/）的 import 是否指向 adapters 下的**兄弟适配器**：
 * `../<段>/...` 上一级正是 adapters/（如 `../dsh/x`）即违规；`../../` 出到 src 内核、
 * `./` 留在本目录互引，均合法。
 */
function referencesSiblingAdapter(spec: string): boolean {
  return /^\.\.[/\\](?!\.\.)[^/\\]+[/\\]/.test(spec);
}

test('步骤4 前置自证：扫描规模、适配器目录与语料白名单均真实就位（防假绿/防空挂白名单）', () => {
  const files = readSrcTsFiles();
  assert.ok(files.length > 50, `前置失效：应扫到大量 src 文件，实际 ${files.length}`);

  const dshFiles = files.filter((file) => file.relPath.startsWith(path.posix.join('src', 'adapters', 'dsh') + '/'));
  const headlessFiles = files.filter((file) => file.relPath.startsWith(HEADLESS_PREFIX));
  assert.ok(dshFiles.length >= 5, '前置失效：dsh 适配器目录应真实存在且含多个文件');
  assert.ok(headlessFiles.length >= 2, '前置失效：headless 目录应至少含工厂与桶出口');

  // 白名单文件必须真实存在且当前确实含宿主字面 —— 证明豁免仍被需要，杜绝死白名单。
  for (const rel of CORPUS_LITERAL_ALLOWLIST) {
    const hit = files.find((file) => file.relPath === rel);
    assert.ok(hit !== undefined, `前置失效：语料白名单文件不存在：${rel}`);
    assert.ok(
      HOST_LITERAL_RE.test(hit!.text),
      `前置失效：白名单文件已不含宿主字面，应同步移除其白名单条目：${rel}`,
    );
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: unknown;
  };
  assert.ok(Object.hasOwn(pkg, 'dependencies'), '前置失效：package.json 应有 dependencies 字段');
});

test('规则1：内核（src/adapters 之外）不得 import 任何适配器，投毒必标红', () => {
  const files = readSrcTsFiles();
  const violations: Array<{ relPath: string; spec: string }> = [];
  for (const file of files) {
    if (file.relPath.startsWith(ADAPTERS_PREFIX)) continue; // 适配器之间不受本规则管辖
    for (const spec of extractImportSpecifiers(file.text)) {
      if (referencesAnyAdapter(spec)) {
        violations.push({ relPath: file.relPath, spec });
      }
    }
  }
  assert.deepEqual(violations, [], `内核出现对适配器的反向 import：${JSON.stringify(violations, null, 2)}`);

  // 投毒反证：内核文件一旦回潮引入适配器（静态值导入/动态 import 两形态），必须被抓。
  const poisonStatic = "import { mountDshAdapter } from '../adapters/dsh/mount.ts';";
  const poisonDynamic = "const mod = await import('../../adapters/headless/openai-llm.ts');";
  assert.ok(extractImportSpecifiers(poisonStatic).some(referencesAnyAdapter), '静态投毒未标红');
  assert.ok(extractImportSpecifiers(poisonDynamic).some(referencesAnyAdapter), '动态投毒未标红');
  // 合规：内核模块之间的相对导入、node 内置不得误伤。
  for (const clean of ["import { Fasti } from '../../api/index.ts';", "import fs from 'node:fs';"]) {
    assert.equal(extractImportSpecifiers(clean).some(referencesAnyAdapter), false, `合规导入误伤：${clean}`);
  }
});

test('规则2：headless 直连适配器不得横向 import dsh 或任何适配器，投毒必标红', () => {
  const files = readSrcTsFiles().filter((file) => file.relPath.startsWith(HEADLESS_PREFIX));
  assert.ok(files.length >= 2, '前置失效：headless 目录为空，规则无从把守');

  const violations: Array<{ relPath: string; spec: string }> = [];
  for (const file of files) {
    for (const spec of extractImportSpecifiers(file.text)) {
      // headless 内部互引是 './openai-llm.ts'，引内核是 '../../core/...'，均不命中兄弟判定。
      if (referencesSiblingAdapter(spec)) {
        violations.push({ relPath: file.relPath, spec });
      }
    }
  }
  assert.deepEqual(violations, [], `headless 出现对其他适配器的横向依赖：${JSON.stringify(violations, null, 2)}`);

  const poison = "import { convertSessionEvent } from '../dsh/convert-event.ts';";
  assert.ok(extractImportSpecifiers(poison).some(referencesSiblingAdapter), 'headless 横向依赖投毒未标红');
  // 合规：同目录互引与出到 src 内核的相对路径不得误伤。
  for (const clean of ["export { x } from './openai-llm.ts';", "import { UnavailableError } from '../../core/errors.ts';"]) {
    assert.equal(
      extractImportSpecifiers(clean).some(referencesSiblingAdapter),
      false,
      `headless 合规导入误伤：${clean}`,
    );
  }
});

test('规则3：内核不得含引号宿主通道/根字面，仅封存语料白名单豁免，投毒必标红', () => {
  const files = readSrcTsFiles();
  const violations: string[] = [];
  for (const file of files) {
    // 整个适配器目录是宿主知识合法所在地；语料白名单是唯一的内核豁免。
    if (file.relPath.startsWith(ADAPTERS_PREFIX)) continue;
    if (CORPUS_LITERAL_ALLOWLIST.includes(file.relPath)) continue;
    if (HOST_LITERAL_RE.test(file.text)) {
      violations.push(file.relPath);
    }
  }
  assert.deepEqual(violations, [], `内核回潮出现具体宿主通道/根字面：${JSON.stringify(violations)}`);

  // 投毒反证：通道 id 与旧默认根段两种字面都必被抓。
  assert.match("const channel = 'dsh';", HOST_LITERAL_RE, '通道字面投毒未标红');
  assert.match("return path.join(base, '.dsh', 'fasti');", HOST_LITERAL_RE, '.dsh 根段投毒未标红');
  // 合规：大写历史环境变量名、中性通道名、裸注释里的产品讨论不触发。
  for (const clean of [
    "const LEGACY_ENV = 'DSH_HOME';",
    "const channel = 'standalone';",
    "resolve(root, '.fasti');",
  ]) {
    assert.doesNotMatch(clean, HOST_LITERAL_RE, `合规文本误伤：${clean}`);
  }
  // 白名单豁免逻辑自证：同样的字面出现在白名单文件里应当被放行。
  const allowlisted = files.find((file) => file.relPath === CORPUS_LITERAL_ALLOWLIST[0]);
  assert.ok(allowlisted !== undefined && HOST_LITERAL_RE.test(allowlisted.text), '白名单豁免前提失效');
});

test('规则4：生产 dependencies 恒为空对象（宿主能力只走 peerDependencies＋端口）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
  };
  assert.deepEqual(pkg.dependencies ?? {}, {}, '生产 dependencies 必须为空对象');
  // peerDependencies 是宿主能力的合法落点，应保持存在（否则端口注入无从挂载）。
  assert.ok(pkg.peerDependencies !== undefined && Object.keys(pkg.peerDependencies).length > 0, 'peerDependencies 应承载宿主包');

  // 判定反证：空对象通过、混入任一运行时依赖即拦。
  const isEmptyDeps = (deps: Record<string, unknown>): boolean => Object.keys(deps).length === 0;
  assert.equal(isEmptyDeps({}), true);
  assert.equal(isEmptyDeps({ someRuntimePkg: '1.2.3' }), false, '混入运行时第三方依赖必须被拦');
});
