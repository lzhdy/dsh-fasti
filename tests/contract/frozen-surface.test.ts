/**
 * 冻结面测试（审计第四节阶段 0 验收项：
 * 「冻结面五条在代码结构上可识别、无被绕过的路径」）。
 *
 * 做法：对真源层模块做**静态扫描** —— 检查其导出能力中不存在修改既有记录的路径。
 * 这是「无被绕过的路径」的可执行形式：不靠注释承诺，靠导出面约束。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FROZEN_SURFACE,
  FROZEN_SURFACE_IDS,
  assertFrozenSurface,
  assertFrozenSurfaceOrThrow,
  isMutatingCapability,
} from '../../src/contract/frozen-surface.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

test('冻结面恰为五条，且各带条款出处', () => {
  assert.equal(FROZEN_SURFACE_IDS.length, 5);
  assert.equal(FROZEN_SURFACE.length, 5);
  for (const item of FROZEN_SURFACE) {
    assert.ok(item.clause.length > 0, `${item.id} 缺条款出处`);
    assert.ok(item.summary.length > 0, `${item.id} 缺说明`);
  }
  assert.deepEqual(
    [...FROZEN_SURFACE_IDS].sort(),
    [
      'projection-rebuildable',
      'source-append-only',
      'three-slot-shape',
      'three-time-axes',
      'ulid-and-dual-pointer',
    ],
  );
});

test('真源层导出面中没有修改既有记录的路径（静态扫描）', () => {
  const sourceDir = path.join(repoRoot, 'src', 'source');
  const files = fs.readdirSync(sourceDir).filter((name) => name.endsWith('.ts'));

  const exported: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
    // 顶层导出：export function / export class / export const
    for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z0-9_]+)/g)) {
      exported.push(match[1] as string);
    }
  }

  assert.ok(exported.length > 0, '未扫描到任何真源层导出');

  const mutators = exported.filter((name) => isMutatingCapability(name));
  assert.deepEqual(mutators, [], `真源层存在修改既有记录的路径：${mutators.join('、')}`);

  // 判据本身也要能识别出违规命名。
  assert.equal(isMutatingCapability('deleteExperience'), true);
  assert.equal(isMutatingCapability('rewriteShard'), true);
  assert.equal(isMutatingCapability('upsertExperience'), false, 'upsert 是幂等语义，不算修改既有内容');
});

test('assertFrozenSurface 对违规导出抛错', () => {
  const ok = assertFrozenSurface(['appendExperience', 'readAll', 'resolve']);
  assert.equal(ok.length, 5);
  assert.ok(ok.every((check) => check.ok));

  assert.throws(() => assertFrozenSurfaceOrThrow(['deleteExperience']), /冻结面被破坏/);
  assert.doesNotThrow(() => assertFrozenSurfaceOrThrow(['appendExperience']));
});

/**
 * 剥掉注释与字符串字面量 —— 扫描看的是**代码**，不是说明文字。
 *
 * 不剥的话，「注释里提到 `.delete(`」就会变红，而真正的调用反倒被淹没。
 */
function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, "''")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * 本文件里**声明为内存集合**的变量名（`X = new Map(...)` / `new Set(...)` 等）。
 *
 * 用途：`Map.delete` / `Set.delete` 是集合自身的方法，与「删真源里的记录」
 * 是两件事。白名单不手写，而是**从声明推导** —— 手写白名单会腐化
 * （新增一个集合忘了登记就误报），而推导出来的名单天然跟着代码走：
 * 一个名字只有在同一文件里被声明成 Map/Set 时，它的 `.delete()` 才被放行。
 * 真源对象（log / record / shard）永远不在这个名单里。
 */
function declaredCollectionNames(code: string): Set<string> {
  const names = new Set<string>();
  // 覆盖两种声明形态：
  //   局部/模块级  `const X = new Map(...)`
  //   类字段      `private readonly X = new Map(...)` / `private X: Map<..> = new Map()`
  const pattern =
    /^[ \t]*(?:(?:private|protected|public|static|readonly|declare)\s+)*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/gm;
  for (const match of code.matchAll(pattern)) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return names;
}

test('真源层与事件层没有「改既有记录」的调用（静态扫描；集合自身的 delete 除外）', () => {
  // m2：范围从 src/source 扩到 src/event —— 事件层是真源写入的唯一调用方，
  // 它能不能守住「只追加」，不该只靠自觉。
  const dirs = [path.join(repoRoot, 'src', 'source'), path.join(repoRoot, 'src', 'event')];
  const files = dirs.flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => path.join(dir, name)),
  );
  assert.ok(files.length > 0, '未扫描到任何文件');

  const call = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(update|delete|remove|rewrite|overwrite|truncate|unlink|rm)\s*\(/g;
  const violations: string[] = [];
  for (const file of files) {
    const code = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
    const collections = declaredCollectionNames(code);
    for (const match of code.matchAll(call)) {
      const receiver = match[1] ?? '';
      const verb = match[2] ?? '';
      const head = receiver.split('.').pop() ?? '';
      // 唯一豁免：本文件里声明成 Map/Set 的变量调 delete（内存集合自身的方法）。
      if (verb === 'delete' && collections.has(head)) {
        continue;
      }
      violations.push(`${path.relative(repoRoot, file)}: ${receiver}.${verb}()`);
    }
  }
  assert.deepEqual(violations, [], `出现修改既有记录的调用：${violations.join('、')}`);
});

test('投影层可整体重建（重建协议存在且从真源折叠）', () => {
  const rebuild = fs.readFileSync(path.join(repoRoot, 'src', 'projection', 'rebuild.ts'), 'utf8');
  assert.ok(rebuild.includes('export async function rebuildProjection'), '缺少重建入口');
  // 重建只折叠真源已有内容，不重新判断（不调 LLM）。
  // 先剥掉注释与字符串，避免把「不重新调 LLM」这类说明文字误判为调用。
  const code = rebuild
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const llmCalls = code.match(/\b(llm|openai|anthropic|completions|chatCompletion)\b/gi);
  assert.equal(llmCalls, null, `重建路径出现 LLM 调用：${String(llmCalls)}`);
});
