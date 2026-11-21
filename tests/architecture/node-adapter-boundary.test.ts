/**
 * node 本地启动器适配器的架构边界门（平台化 #72 第一刀）。
 *
 * 四条红线，任何一条被后人改动都会当场红：
 *  规则1「机制层白名单」 http-server.ts 只许 node: 内置 + 内核相对路径；
 *                      禁宿主作用域包、禁兄弟适配器、禁第三方包。
 *  规则2「组合根唯一」   只有 serve.ts 可以 import 兄弟适配器，且只许 headless（
 *                      造 LLMPort）；其余 node 文件一律不许横向依赖——
 *                      这与 dsh 的 plugin.ts 是同一套纪律：装配只发生在一个点。
 *  规则3「只听回环」     机制层必须显式绑 '127.0.0.1'，全目录不得出现 0.0.0.0 / :: 外网字面。
 *  规则4「两道防线顺序」 Host 白名单校验必须先于 token 校验（DNS-rebinding 不能靠凭证兜）。
 *
 * 每条都带合成投毒自证与反误伤断言，避免"目录写错/图为空"的假绿。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** node 适配器目录（跨平台拼法，避免硬编码分隔符）。 */
const NODE_DIR = path.join(REPO_ROOT, 'src', 'adapters', 'node');
const NODE_PREFIX = path.posix.join('src', 'adapters', 'node') + '/';

const MECHANISM = 'http-server.ts';
const COMPOSER = 'serve.ts';

/** 宿主作用域前缀（拆段拼接，防断言字符串在本文件自指命中）。 */
const HOST_SCOPE = '@deepseek-' + 'ai/';

interface ScanFile {
  relPath: string;
  text: string;
}

/** 读取 node 目录全部 .ts 源文件。 */
function readNodeTsFiles(): ScanFile[] {
  if (!fs.existsSync(NODE_DIR)) {
    return [];
  }
  return fs
    .readdirSync(NODE_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => {
      const abs = path.join(NODE_DIR, name);
      const rel = path.posix.join('src', 'adapters', 'node', name.split(path.sep).join('/'));
      return { relPath: rel, text: fs.readFileSync(abs, 'utf8') };
    });
}

/** 提取 import/export specifier（static / import type / re-export / 副作用 / 动态 import()）。 */
function extractImportSpecifiers(text: string): string[] {
  const re = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  const out: string[] = [];
  for (const match of text.matchAll(re)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  for (const match of text.matchAll(dyn)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** 是否指向兄弟适配器（`../<名>/…` 形态；`../../` 出到内核不算）。 */
function referencesSiblingAdapter(spec: string): boolean {
  return /^\.\.[/\\](?!\.\.)[^/\\]+[/\\]/.test(spec);
}

/** 是否含宿主作用域包。 */
function referencesHostScope(spec: string): boolean {
  return spec.includes(HOST_SCOPE);
}

/** 是否第三方（非 node: 内置、非相对路径）。 */
function referencesThirdParty(spec: string): boolean {
  const isBuiltin = spec.startsWith('node:');
  const isRelative = spec.startsWith('.') || spec.startsWith('/');
  return !isBuiltin && !isRelative;
}

/** 机制层违规原因；合规返回 undefined。 */
function mechanismViolation(spec: string): string | undefined {
  if (referencesHostScope(spec)) return '宿主作用域包';
  if (referencesSiblingAdapter(spec)) return '兄弟适配器';
  if (spec.includes('/adapters/')) return '适配器路径';
  if (referencesThirdParty(spec)) return '第三方包';
  return undefined;
}

test('node 启动器前置自证：四个源文件真实就位（防目录写错/图为空）', () => {
  const files = readNodeTsFiles();
  assert.ok(files.length >= 4, `node 目录源文件应 ≥4，实际 ${files.length}`);
  for (const expected of [MECHANISM, COMPOSER, 'config.ts', 'index.ts']) {
    const hit = files.find((file) => file.relPath === NODE_PREFIX + expected);
    assert.ok(hit !== undefined, `缺少 ${expected}`);
    assert.ok(hit.text.length > 100, `${expected} 内容过短，疑似空壳`);
  }
  // 机制层必须真的引用内核门面类型，否则"白名单"是在空目录上通过的。
  const mechanism = files.find((file) => file.relPath === NODE_PREFIX + MECHANISM);
  assert.ok(mechanism !== undefined, '机制层缺失');
  assert.ok(
    extractImportSpecifiers(mechanism.text).includes('../../api/index.ts'),
    '机制层应 import 内核门面类型（../../api/index.ts）',
  );
});

test('规则1：机制层（http-server.ts）导入白名单——禁宿主包/兄弟适配器/第三方，投毒必标红', () => {
  const mechanism = readNodeTsFiles().find((file) => file.relPath === NODE_PREFIX + MECHANISM);
  assert.ok(mechanism !== undefined, '机制层缺失');
  for (const spec of extractImportSpecifiers(mechanism.text)) {
    const reason = mechanismViolation(spec);
    assert.equal(reason, undefined, `机制层违规导入 ${spec}（${reason ?? ''}）`);
  }

  // 投毒自证：四种违规形态各一，必须判红。
  const poisonHost = "import type { Context } from '@deepseek-" + "ai/cordis';";
  const poisonSibling = "import { convertSessionEvent } from '../dsh/convert-event.ts';";
  const poisonHeadless = "import { createOpenAICompatLLMPort } from '../headless/openai-llm.ts';";
  const poisonThird = "import { z } from 'zod';";
  assert.ok(extractImportSpecifiers(poisonHost).some((spec) => mechanismViolation(spec) !== undefined), '宿主包投毒未标红');
  assert.ok(extractImportSpecifiers(poisonSibling).some((spec) => mechanismViolation(spec) !== undefined), '兄弟适配器投毒未标红');
  assert.ok(extractImportSpecifiers(poisonHeadless).some((spec) => mechanismViolation(spec) !== undefined), 'headless 横向投毒未标红');
  assert.ok(extractImportSpecifiers(poisonThird).some((spec) => mechanismViolation(spec) !== undefined), '第三方投毒未标红');

  // 反误伤：内置模块与内核相对路径必须放行。
  for (const clean of ['node:http', 'node:crypto', '../../api/index.ts', '../../ports/logger-port.ts', './config.ts']) {
    assert.equal(mechanismViolation(clean), undefined, `合规导入被误伤：${clean}`);
  }
});

test('规则2：组合根唯一——只有 serve.ts 可横向引用兄弟适配器，且只许 headless', () => {
  const files = readNodeTsFiles();
  for (const file of files) {
    const isComposer = file.relPath === NODE_PREFIX + COMPOSER;
    for (const spec of extractImportSpecifiers(file.text)) {
      if (!referencesSiblingAdapter(spec)) {
        continue;
      }
      assert.ok(isComposer, `${file.relPath} 不得横向依赖兄弟适配器（只有 ${COMPOSER} 是装配点）：${spec}`);
      assert.ok(
        spec.includes('headless'),
        `组合根只允许通过 headless 造模型端口，实际引用了 ${spec}`,
      );
    }
  }

  // 前置：组合根确实引用了 headless（否则本规则空转）。
  const composer = files.find((file) => file.relPath === NODE_PREFIX + COMPOSER);
  assert.ok(composer !== undefined, '组合根缺失');
  assert.ok(
    extractImportSpecifiers(composer.text).some((spec) => spec.includes('headless')),
    '组合根应引用 headless 适配器（造 LLMPort）',
  );

  // 投毒自证 + 反误伤。
  assert.ok(referencesSiblingAdapter('../dsh/convert-event.ts'), '兄弟投毒未标红');
  assert.ok(referencesSiblingAdapter('../headless/index.ts'), 'headless 投毒未标红');
  assert.equal(referencesSiblingAdapter('../../api/index.ts'), false, '内核路径被误伤');
  assert.equal(referencesSiblingAdapter('./config.ts'), false, '同目录互引被误伤');
});

test('规则3：只听回环——机制层显式绑 127.0.0.1，全目录无 0.0.0.0 / :: 外网字面', () => {
  const files = readNodeTsFiles();
  const mechanism = files.find((file) => file.relPath === NODE_PREFIX + MECHANISM);
  assert.ok(mechanism !== undefined, '机制层缺失');
  assert.ok(mechanism.text.includes("'127.0.0.1'"), '机制层必须显式绑定 127.0.0.1');

  for (const file of files) {
    // 只查码面字面，注释里的说明不算：逐行剔除行注释后再判。
    const codeLines = file.text
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/u, '').replace(/\/\*[\s\S]*?\*\//gu, ''));
    const joined = codeLines.join('\n');
    assert.ok(!joined.includes('0.0.0.0'), `${file.relPath} 出现外网监听字面 0.0.0.0`);
    assert.ok(!/listen\([^)]*\)\s*,\s*['"]::['"]/u.test(joined), `${file.relPath} 出现 IPv6 通配监听`);
  }

  // 投毒自证：合成一段绑 0.0.0.0 的代码，字面检测必须命中。
  const poison = "server.listen(8731, '0.0.0.0', () => {});";
  assert.ok(poison.includes('0.0.0.0'), '外网监听投毒未标红');
});

test('规则4：两道防线顺序——Host 白名单校验必须先于 token 校验', () => {
  const mechanism = readNodeTsFiles().find((file) => file.relPath === NODE_PREFIX + MECHANISM);
  assert.ok(mechanism !== undefined, '机制层缺失');
  const text = mechanism.text;

  // 两道防线都必须在（否则顺序断言无意义）。
  assert.ok(text.includes('ALLOWED_HOSTS'), '缺少 Host 白名单常量');
  assert.ok(text.includes('timingSafeEqual'), 'token 比较必须用常量时间比较');
  assert.ok(text.includes("'Bearer '"), '缺少 Bearer 凭证解析');

  const hostIndex = text.indexOf('forbidden-host');
  const tokenIndex = text.indexOf("'unauthorized'");
  assert.ok(hostIndex >= 0, '缺少 forbidden-host 拒绝分支');
  assert.ok(tokenIndex >= 0, '缺少 unauthorized 拒绝分支');
  assert.ok(
    hostIndex < tokenIndex,
    `Host 校验（偏移 ${hostIndex}）必须先于 token 校验（偏移 ${tokenIndex}）：DNS-rebinding 请求不带有效凭证，靠 token 兜不住`,
  );
});
