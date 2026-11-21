/**
 * 平台化宿主中立（靶心一）H0 · 宿主包边界守卫。
 *
 * 目的：把"内核零宿主包依赖"这条已经成立的边界物理钉死、防回潮——
 * 除 `src/adapters/` 下的平台适配器外，src 任何模块都不得 import `@deepseek-ai/*`
 * （cordis / dsh-tools / dsh-llm 等一律算宿主耦合）。type-only 与动态 import 同样禁止：
 * 哪怕只在类型层认识宿主名词，也是边界泄漏。
 *
 * 口径：
 *  - 复用 layer-imports.test.ts / schema.test.ts 的 extractImportSpecifiers 同一正则口径
 *    （覆盖 static / import type / re-export / 副作用 import / 动态 import() 形态），
 *    两处如需调整必须同步，避免漂移；此处自带副本而不 import '*.test.ts'，
 *    防跨测试文件连带重复注册对方的 test()。
 *  - 只静态读源码文本做判定，不运行时加载任何模块、不写入真实 src/。
 *  - 豁免范围是整个 `src/adapters/` 目录：dsh 为当前真机适配器，允许宿主包；
 *    headless 直连适配器虽同在该目录、被本测试的内核面豁免，但 H3 已在本文件另立
 *    "headless 不得含任何 @deepseek-ai/* 宿主包"的反向子规则（见末尾独立用例），
 *    保证直连管道真正宿主中立、可独立接入云端/本地模型。
 *  - 前置自证防假绿：必须先确认扫描器真的读到了大量内核文件、且 dsh 适配器内确实存在
 *    宿主 import，再执行主断言，杜绝目录根写错/图为空导致的"零违规"假合规。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR = path.posix.join('src');
/** 豁免前缀：该目录下的平台适配器允许 import 宿主包。 */
const ADAPTERS_PREFIX = path.posix.join('src', 'adapters') + '/';
/** headless 直连适配器前缀：H3 反向子规则要求其下任何文件都不得含宿主包。 */
const HEADLESS_PREFIX = path.posix.join('src', 'adapters', 'headless') + '/';
/** 宿主包作用域：任何以此开头的 specifier 都算宿主耦合。 */
const HOST_SCOPE = '@deepseek-ai/';

/** 参与静态扫描的源文件。relPath 为仓库相对 POSIX 路径。 */
interface ScanFile {
  relPath: string;
  text: string;
}

/**
 * 提取 import/export specifier，与 layer-imports.test.ts 逐字同一正则口径。
 * 覆盖 static / import type / re-export / 副作用 import / 动态 import() 六种形态。
 */
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

/** 递归收集 src 下全部 .ts 源文件（仅读文本）。 */
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
  walk(path.join(REPO_ROOT, SRC_DIR));
  return out;
}

/** 是否落在适配器豁免目录。 */
function isAdapterPath(relPosix: string): boolean {
  return relPosix.startsWith(ADAPTERS_PREFIX);
}

/** 纯判定：specifier 是否指向宿主包作用域。 */
function isHostSpecifier(spec: string): boolean {
  return spec.startsWith(HOST_SCOPE);
}

/** 纯判定：从一组 specifier 中挑出全部宿主包引用。 */
export function findHostSpecifiers(specs: readonly string[]): string[] {
  return specs.filter(isHostSpecifier);
}

test('H0 边界：src/adapters 之外的任何内核模块都不得 import @deepseek-ai/*', () => {
  const files = readSrcTsFiles();

  // 前置自证①：扫描结果非空且达到合理规模，排除根路径写错读到空目录。
  assert.ok(files.length > 50, `前置失效：应扫到大量 src 文件，实际 ${files.length}，检查 REPO_ROOT/SRC_DIR`);

  // 前置自证②：豁免目录内确实存在宿主 import，且锚定已知耦合点，证明扫描器与口径有效。
  const adapterFilesWithHost = files.filter(
    (file) => isAdapterPath(file.relPath) && findHostSpecifiers(extractImportSpecifiers(file.text)).length > 0,
  );
  // H1 切片 2 后 llm.ts 已剥离 cordis（worker 下沉到 assembly 改吃端口），仍真实
  // import 宿主包的适配器文件收敛为 3 个；这是边界主动收紧，不是扫描漂移。
  assert.ok(adapterFilesWithHost.length >= 3, `前置失效：适配器目录应至少有 3 个含宿主包的文件，实际 ${adapterFilesWithHost.length}`);
  const byRel = new Map(files.map((file) => [file.relPath, file]));
  // 正向锚点：这些文件当前仍真实承担宿主耦合，必须继续被扫到，防口径漂移。
  for (const anchor of [
    'src/adapters/dsh/plugin.ts',
    'src/adapters/dsh/memory-tool-bridge.ts',
    'src/adapters/dsh/host-model-route.ts',
  ]) {
    const anchored = byRel.get(anchor);
    assert.ok(anchored !== undefined, `前置失效：已知适配器文件缺失：${anchor}`);
    assert.ok(
      findHostSpecifiers(extractImportSpecifiers(anchored.text)).length > 0,
      `前置失效：${anchor} 应含宿主 import，否则扫描口径可能已漂移`,
    );
  }

  // 反向防回潮锚点：llm.ts 在 H1 切片 2 已彻底剥离宿主包，谁再给它引回
  // @deepseek-ai/* 即判失败，把已取得的解耦成果钉死。
  const decoupled = byRel.get('src/adapters/dsh/llm.ts');
  assert.ok(decoupled !== undefined, '前置失效：已解耦文件 src/adapters/dsh/llm.ts 缺失');
  assert.deepEqual(
    findHostSpecifiers(extractImportSpecifiers(decoupled.text)),
    [],
    '防回潮：src/adapters/dsh/llm.ts 已在 H1 切片 2 剥离宿主包，不得重新 import @deepseek-ai/*',
  );

  // 主断言：逐个非适配器内核文件，宿主引用必须为空。
  const violations: Array<{ relPath: string; hosts: string[] }> = [];
  for (const file of files) {
    if (isAdapterPath(file.relPath)) continue;
    const hosts = findHostSpecifiers(extractImportSpecifiers(file.text));
    if (hosts.length > 0) violations.push({ relPath: file.relPath, hosts });
  }
  assert.deepEqual(violations, [], `内核出现宿主包泄漏：${JSON.stringify(violations, null, 2)}`);
});

test('H0 投毒自证：内核路径上四种宿主 import 形态必标红；合规导入零误报；适配器目录正确豁免', () => {
  // 投毒：type-only / 静态值 / 动态 / 副作用四种形态都必须被抓。
  const poisoned = [
    "import type { Context } from '@deepseek-ai/cordis';",
    "import { defineTool } from '@deepseek-ai/dsh-tools';",
    "const mod = await import('@deepseek-ai/dsh-llm');",
    "import '@deepseek-ai/some-side-effect';",
  ];
  for (const text of poisoned) {
    const hosts = findHostSpecifiers(extractImportSpecifiers(text));
    assert.equal(hosts.length, 1, `投毒未标红：${text} → ${JSON.stringify(hosts)}`);
    const hit = hosts[0];
    assert.ok(hit !== undefined && hit.startsWith(HOST_SCOPE), `命中项不在宿主作用域：${text}`);
  }

  // 合规样例：相对路径、node 内置、普通第三方裸包都不得误报（规则只盯 @deepseek-ai 作用域）。
  const clean = [
    "import { Fasti } from '../../api/index.ts';",
    "import fs from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    "import somePkg from 'some-unrelated-package';",
  ];
  for (const text of clean) {
    const hosts = findHostSpecifiers(extractImportSpecifiers(text));
    assert.deepEqual(hosts, [], `合规导入被误报：${text}`);
  }

  // 豁免判定：dsh 与 headless 都在适配器目录（isAdapterPath=true），不属内核面本用例管辖；
  // 内核路径必须为 false。headless 的宿主中立性由下方 H3 反向子规则单独把守。
  assert.equal(isAdapterPath('src/adapters/dsh/plugin.ts'), true);
  assert.equal(isAdapterPath('src/adapters/headless/openai-llm.ts'), true);
  assert.equal(isAdapterPath('src/api/index.ts'), false);
  assert.equal(isAdapterPath('src/memory/store.ts'), false);
});

test('H3 反向边界：headless 直连适配器的任何文件都不得 import @deepseek-ai/*（宿主中立硬钉死）', () => {
  const files = readSrcTsFiles();
  const headlessFiles = files.filter((file) => file.relPath.startsWith(HEADLESS_PREFIX));

  // 前置自证：headless 目录已真实落地且含预期文件，排除目录缺失/根写错造成的"零违规"假绿。
  assert.ok(
    headlessFiles.length >= 2,
    `前置失效：src/adapters/headless 应至少含工厂与桶出口两个文件，实际 ${headlessFiles.length}`,
  );
  const byRel = new Map(headlessFiles.map((file) => [file.relPath, file]));
  for (const expect of ['src/adapters/headless/openai-llm.ts', 'src/adapters/headless/index.ts']) {
    assert.ok(byRel.get(expect) !== undefined, `前置失效：headless 预期文件缺失：${expect}`);
  }

  // 主断言：headless 下所有文件的宿主包引用必须为空（type-only / 动态 / 副作用形态同口径）。
  const violations: Array<{ relPath: string; hosts: string[] }> = [];
  for (const file of headlessFiles) {
    const hosts = findHostSpecifiers(extractImportSpecifiers(file.text));
    if (hosts.length > 0) violations.push({ relPath: file.relPath, hosts });
  }
  assert.deepEqual(violations, [], `headless 直连管道出现宿主包泄漏：${JSON.stringify(violations, null, 2)}`);

  // 投毒自证：在真实 headless 文件文本上内存拼接两类宿主 import，扫描必须当场标红，
  // 证明这条反向规则不是空转（不写盘、不改源文件）。
  const probe = byRel.get('src/adapters/headless/openai-llm.ts');
  assert.ok(probe !== undefined);
  for (const poison of [
    "import type { Context } from '@deepseek-ai/cordis';",
    "const mod = await import('@deepseek-ai/dsh-llm');",
  ]) {
    const hosts = findHostSpecifiers(extractImportSpecifiers(`${probe!.text}\n${poison}`));
    assert.equal(hosts.length, 1, `headless 投毒未标红：${poison} → ${JSON.stringify(hosts)}`);
    assert.ok(hosts[0]!.startsWith(HOST_SCOPE));
  }
});
