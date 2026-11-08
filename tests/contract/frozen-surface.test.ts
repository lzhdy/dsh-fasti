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

test('真源层的写入原语确实只有 append（无 update/delete 同义入口）', () => {
  const sourceDir = path.join(repoRoot, 'src', 'source');
  const files = fs.readdirSync(sourceDir).filter((name) => name.endsWith('.ts'));

  const mutatingCalls: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
    for (const match of text.matchAll(/\.(update|delete|remove|rewrite|overwrite|truncate)\s*\(/g)) {
      mutatingCalls.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(mutatingCalls, [], `真源层出现修改既有记录的方法调用：${mutatingCalls.join('、')}`);
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
