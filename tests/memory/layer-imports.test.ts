/**
 * N1/N5 无环低层 import 门测试。
 *
 * 背景：content-hash.ts / fts.ts（以及后续 alias-write.ts）是从 builder/store 抽出的共享低层，
 * 必须保持依赖 DAG 单向无环——它们不得依赖 store/builder/bm25，也不得依赖任何**经传递能到达
 * store** 的 memory 模块，否则会重新引入 `leaf → … → store → leaf` 环（终审 N1/N5）。
 *
 * 口径：
 *  - 复用 schema.test.ts 的 extractImportSpecifiers，杜绝正则口径漂移；
 *  - 在 src/memory 真实 import 图上求“能到达 store.ts 的模块闭包”，leaf 的任一 memory 内依赖落在
 *    该闭包内即标红（覆盖直接与传递依赖，不只硬编码三个名字）；
 *  - 投毒自证用合成文本喂纯判定函数，绝不写入真实 src/、绝不运行时加载。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MEMORY_SRC = path.posix.join('src', 'memory');

/** 参与静态扫描的源文件。relPath 为仓库相对 POSIX 路径。 */
interface ScanFile {
  relPath: string;
  text: string;
}

/**
 * 提取 import/export specifier，与 schema.test.ts 的 M6 门**逐字同一正则口径**（覆盖 static/
 * import type/re-export/副作用 import/动态 import() 六种形态）。两处如需调整必须同步，避免漂移；
 * 此处刻意自带副本而不 import '*.test.ts'，以防跨测试文件连带重复注册对方的 test()。
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

/**
 * 受无环约束的低层模块（相对 src/memory 的文件名）。
 * gate.ts 为接收候选数组的纯函数，同样不得绕回 store，预先纳入以防止第二层接线成环；
 * alias-write.ts 已落地并纳入（N5 闭合点：不 import bm25/store/builder，规范化由写柄完成）；
 * shadow-write.ts（N16 影子 JSONL 窄写）同为无环低层：只依赖 core/errors、core/hash 与 types 纯类型，
 * 经 runtime 在上层引用，自身不得落回 store 闭包。
 * audit/shadow-read.ts（#114/S1 影子只读读取器）同样纳入：只依赖 core/errors、types 与 shadow-write 常量，
 * 是离线审计件，若将来被写柄/store 反向拉入即报红。
 */
const ACYCLIC_LEAF_FILES = [
  'content-hash.ts',
  'fts.ts',
  'gate.ts',
  'alias-write.ts',
  'shadow-write.ts',
  'audit/shadow-read.ts',
] as const;

/** 显式直接拉黑（闭包判定的双保险，意图清晰且不依赖图计算正确性）。 */
const FORBIDDEN_DIRECT_SPECS = new Set(['./store.ts', './builder.ts', './bm25.ts']);

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function readMemoryTsFiles(): ScanFile[] {
  const out: ScanFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push({ relPath: toPosix(path.relative(REPO_ROOT, full)), text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(path.join(REPO_ROOT, MEMORY_SRC));
  return out;
}

/** 把相对 import spec 解析为 src/memory 内的 POSIX 节点；指向 node 内置/其它目录则返回 null。 */
function resolveMemoryNode(fromRelPosix: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelPosix), spec));
  return target.startsWith(`${MEMORY_SRC}/`) ? target : null;
}

/** 纯判定：返回 leaf 上违规的 specifier 列表（直接黑名单 ∪ 落在“可达 store 闭包”内的依赖）。 */
export function findAcyclicViolations(
  leafRelPosix: string,
  specs: readonly string[],
  canReachStore: ReadonlySet<string>,
): string[] {
  const bad = new Set<string>();
  for (const spec of specs) {
    if (FORBIDDEN_DIRECT_SPECS.has(spec)) bad.add(spec);
    const node = resolveMemoryNode(leafRelPosix, spec);
    if (node !== null && canReachStore.has(node)) bad.add(spec);
  }
  return [...bad];
}

/** 在 memory import 图上求“沿 import 边能到达 store.ts”的所有节点（含 store 自身）。 */
function computeCanReachStore(files: readonly ScanFile[]): Set<string> {
  const storeNode = path.posix.join(MEMORY_SRC, 'store.ts');
  const adjacency = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  for (const file of files) {
    nodes.add(file.relPath);
    const edges = adjacency.get(file.relPath) ?? new Set<string>();
    for (const spec of extractImportSpecifiers(file.text)) {
      const node = resolveMemoryNode(file.relPath, spec);
      if (node !== null) edges.add(node);
    }
    adjacency.set(file.relPath, edges);
  }

  const reaches = (start: string): boolean => {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === storeNode) return true;
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  };

  const canReach = new Set<string>();
  for (const node of nodes) if (reaches(node)) canReach.add(node);
  return canReach;
}

test('N1/N5 无环低层：content-hash/fts 不依赖 store/builder/bm25 或任何传递到达 store 的模块', () => {
  const files = readMemoryTsFiles();
  const canReachStore = computeCanReachStore(files);

  // 门禁自证：若图算错导致闭包为空，leaf 会“假合规”。先确认三个高危模块确实在闭包内。
  assert.ok(canReachStore.has(path.posix.join(MEMORY_SRC, 'store.ts')), '前置失效：store 应能到达自身');
  assert.ok(canReachStore.has(path.posix.join(MEMORY_SRC, 'builder.ts')), '前置失效：builder 直接 import store');
  assert.ok(canReachStore.has(path.posix.join(MEMORY_SRC, 'bm25.ts')), '前置失效：bm25 直接 import store');

  const byRel = new Map(files.map((file) => [file.relPath, file]));
  for (const leafFile of ACYCLIC_LEAF_FILES) {
    const leafRel = path.posix.join(MEMORY_SRC, leafFile);
    const leaf = byRel.get(leafRel);
    assert.ok(leaf !== undefined, `无环低层模块缺失：${leafRel}（应先创建并保持无环）`);
    const violations = findAcyclicViolations(leafRel, extractImportSpecifiers(leaf.text), canReachStore);
    assert.deepEqual(violations, [], `${leafFile} 出现违规依赖，N1/N5 无环要求被破坏`);
  }
});

test('N1/N5 投毒自证：leaf 反向 import store/builder/bm25 或传递依赖 → 标红；合规依赖零误报', () => {
  const files = readMemoryTsFiles();
  const canReachStore = computeCanReachStore(files);
  const leafRel = path.posix.join(MEMORY_SRC, 'content-hash.ts');

  for (const forbidden of ['./store.ts', './builder.ts', './bm25.ts']) {
    const text = `import { x } from '${forbidden}';\n`;
    const violations = findAcyclicViolations(leafRel, extractImportSpecifiers(text), canReachStore);
    assert.ok(violations.includes(forbidden), `投毒未标红：${forbidden} → ${JSON.stringify(violations)}`);
  }

  // 合规样例：node 内置与 memory 纯类型模块（types.ts 不到达 store）不应误报。
  const clean = ["import { createHash } from 'node:crypto';", "import type { AliasRow } from './types.ts';"];
  for (const text of clean) {
    const violations = findAcyclicViolations(leafRel, extractImportSpecifiers(text), canReachStore);
    assert.deepEqual(violations, [], `合规依赖被误报：${text}`);
  }
  assert.equal(canReachStore.has(path.posix.join(MEMORY_SRC, 'types.ts')), false, 'types.ts 应为无环纯类型');
});
