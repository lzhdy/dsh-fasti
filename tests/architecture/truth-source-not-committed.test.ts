/**
 * 真源永不入库的红门（平台化 #72 配套安全护栏）。
 *
 * 动机是真实且不可逆的风险：本仓库是公开仓库，而真源（原文层 raw/、经历
 * experiences/、事件 events/、投影 projection/、运行态 state/、通道注册表
 * channels.json）里装的是**她本人的对话与生活信息**。这些东西一旦被 `git add`
 * 进历史，即使后续删除也已留在 Git 对象与远端引用里，撤不回来。
 *
 * 本门只查"已被 Git 跟踪的文件"（`git ls-files`），不查工作区里未跟踪的运行目录——
 * 后者是本地演示的正常产物，不该让 verify 变红。
 *
 * 三道：
 *  规则1 `.gitignore` 必须显式拦 `.fasti/`（默认兜底根的仓库内同名目录形态）；
 *  规则2 已跟踪文件里不得出现任何数据布局目录下的文件；
 *  规则3 前置自证＋投毒自证＋反误伤，防"扫描为空/路径写错"造成的假绿。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 数据根布局下的目录名（与 src/source/paths.ts 的 DataLayout 对应）。 */
const DATA_DIRS = ['raw', 'experiences', 'events', 'projection', 'state', 'trash'] as const;
/** 数据根内的文件级真源（非目录形态）。 */
const DATA_FILES = ['channels.json'] as const;
/** 默认兜底根目录名（家目录 `~/.fasti` 的仓库内同名形态）。 */
const DEFAULT_ROOT_DIRNAME = '.fasti';

/** 取出全部已跟踪文件（NUL 分隔，兼容含空格路径）。 */
function trackedFiles(): string[] {
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return raw.split('\0').filter((entry) => entry !== '');
}

/** 判定某已跟踪路径是否属于真源数据（根级数据布局目录，或仓库内默认根）。 */
function isTruthSourcePath(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join('/');
  if (normalized === DEFAULT_ROOT_DIRNAME || normalized.startsWith(DEFAULT_ROOT_DIRNAME + '/')) {
    return true;
  }
  for (const dir of DATA_DIRS) {
    if (normalized.startsWith(dir + '/')) {
      return true;
    }
  }
  for (const file of DATA_FILES) {
    if (normalized === file) {
      return true;
    }
  }
  return false;
}

test('真源红门·前置自证：git 可读且扫描规模真实（防空图假绿）', () => {
  const files = trackedFiles();
  assert.ok(files.length > 100, `已跟踪文件应 >100，实际 ${files.length}：扫描口径可能已失效`);
  // 锚定已知真实文件，证明 git 确实指向本仓库。
  assert.ok(files.includes('package.json'), '扫描结果缺 package.json，git 上下文可疑');
  assert.ok(files.some((file) => file.startsWith('src/')), '扫描结果无 src/，git 上下文可疑');
});

test('规则1：.gitignore 必须显式拦 .fasti/ 默认根目录形态', () => {
  const ignoreText = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  const rules = ignoreText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  const coversDefaultRoot = rules.some((rule) => {
    const cleaned = rule.replace(/^[/\s]+|\s+$/gu, '');
    return cleaned === '.fasti' || cleaned === '.fasti/' || cleaned === '/.fasti' || cleaned === '/.fasti/';
  });
  assert.ok(
    coversDefaultRoot,
    '`.gitignore` 未拦 `.fasti/`：默认兜底根一旦落进仓库工作区，有被 commit 进公开历史的现实风险',
  );

  // 投毒自证：把规则删掉后判定必须为 false（证明本断言不是恒真）。
  const poisonedRules = rules.filter((rule) => !rule.includes('.fasti'));
  const poisonedCovers = poisonedRules.some((rule) => {
    const cleaned = rule.replace(/^[/\s]+|\s+$/gu, '');
    return cleaned === '.fasti' || cleaned === '.fasti/' || cleaned === '/.fasti' || cleaned === '/.fasti/';
  });
  assert.equal(poisonedCovers, false, '投毒自证失败：删除规则后仍判定为已覆盖');
});

test('规则2：已跟踪文件里不得出现任何真源数据文件，投毒必标红', () => {
  const files = trackedFiles();
  const leaked = files.filter(isTruthSourcePath);
  assert.deepEqual(
    leaked,
    [],
    `真源数据已被 Git 跟踪，会随 push 永久留在公开历史：${leaked.join(', ')}`,
  );

  // 投毒自证：真实形态的数据路径必须被判为真源。
  for (const poison of [
    'experiences/2026-11.jsonl',
    'raw/webdemo/2026-11.jsonl',
    'events/2026-11.jsonl',
    'state/checkpoint.json',
    'channels.json',
    '.fasti/experiences/2026-11.jsonl',
  ]) {
    assert.ok(isTruthSourcePath(poison), `投毒未标红：${poison}`);
  }

  // 反误伤：仓库里合法的语料/示例文件不得被误判。
  for (const clean of ['examples/shadow-replay-questions.jsonl', 'src/api/index.ts', 'docs/STATUS.md']) {
    assert.equal(isTruthSourcePath(clean), false, `合规文件被误伤：${clean}`);
  }
});
