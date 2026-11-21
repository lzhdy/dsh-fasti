/**
 * 平台化宿主中立（靶心一）H2-a · 说话者映射边界守卫。
 *
 * 目的：把「speaker → initiation 是适配器职责、内核不认识宿主说话者」这条 H2-a
 * 收口的边界物理钉死、防回潮。
 *
 * 背景：speaker（user/assistant/system/tool）是原文层 RawTurn 的宿主事实字段，
 * initiation（user/her/system/environment）才是经历契约的中立身份。H2-a 之前
 * 内核门面 api/index.ts 自带 initiationOf 映射表；下沉后该映射只允许存在于
 * src/adapters/ 下的平台适配器，内核只接收显式传入的 initiation。
 *
 * 口径：
 *  - 只静态读源码文本做判定，不运行时加载模块、不写入真实 src/；
 *  - 豁免整个 src/adapters/（与 host-boundary.test.ts 同一豁免前缀）；
 *  - 注意不误伤：原文层 schema 的 `speaker: string` 字段（真源八字段，三不动）与
 *    中立的 `initiation` 字段都合法，守卫只锁「映射函数 initiationOf(」与门面
 *    对 `input.speaker` 的读取，不粗暴禁止 speaker 这个词；
 *  - 前置自证防假绿：先确认扫到大量 src 文件、适配器内确实存在 initiationOf 映射。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR = path.posix.join('src');
const ADAPTERS_PREFIX = path.posix.join('src', 'adapters') + '/';

interface ScanFile {
  relPath: string;
  text: string;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

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

function isAdapterPath(relPosix: string): boolean {
  return relPosix.startsWith(ADAPTERS_PREFIX);
}

/** 文本中是否出现 speaker→initiation 映射（函数定义或调用形态 initiationOf(）。 */
function hasInitiationMapper(text: string): boolean {
  return /\binitiationOf\s*\(/.test(text);
}

/** 门面摄入入口是否仍直接读取入参的宿主 speaker（经历身份只能取自 input.initiation）。 */
function facadeReadsSpeaker(text: string): boolean {
  return /\binput\.speaker\b/.test(text);
}

test('H2-a 边界：src/adapters 之外不得保留 speaker→initiation 映射，门面不得读 input.speaker', () => {
  const files = readSrcTsFiles();

  // 前置自证①：扫描规模合理，排除根路径写错读到空目录。
  assert.ok(files.length > 50, `前置失效：应扫到大量 src 文件，实际 ${files.length}，检查 REPO_ROOT/SRC_DIR`);

  // 前置自证②：适配器内确实存在该映射（dsh 说话者口径的唯一归属），证明扫描口径有效。
  const adapterMappers = files.filter(
    (file) => isAdapterPath(file.relPath) && hasInitiationMapper(file.text),
  );
  assert.ok(adapterMappers.length >= 1, `前置失效：适配器目录应至少有 1 个 initiationOf 映射文件，实际 ${adapterMappers.length}`);
  const byRel = new Map(files.map((file) => [file.relPath, file]));
  const mapperHome = byRel.get('src/adapters/dsh/initiation.ts');
  assert.ok(mapperHome !== undefined, '前置失效：映射归属文件 src/adapters/dsh/initiation.ts 缺失');
  assert.ok(hasInitiationMapper(mapperHome.text), '前置失效：initiation.ts 应定义 initiationOf 映射');

  // 主断言①：非适配器内核文件一律不得出现 initiationOf 映射。
  const kernelViolations = files
    .filter((file) => !isAdapterPath(file.relPath) && hasInitiationMapper(file.text))
    .map((file) => file.relPath);
  assert.deepEqual(kernelViolations, [], `内核残留 speaker→initiation 映射：${JSON.stringify(kernelViolations)}`);

  // 主断言②：经历摄入门面不得再从 input.speaker 推导身份（只能用 input.initiation）。
  const facade = byRel.get('src/api/index.ts');
  assert.ok(facade !== undefined, '前置失效：门面 src/api/index.ts 缺失');
  assert.equal(
    facadeReadsSpeaker(facade.text),
    false,
    '防回潮：门面不得读取 input.speaker，经历 initiation 必须由适配器显式传入',
  );
});

test('H2-a 投毒自证：映射回潮/门面读 speaker 必标红；原文层 schema 与中立 initiation 零误报', () => {
  // 投毒：映射被搬回内核、门面重新读 speaker，都必须被抓。
  assert.equal(hasInitiationMapper('const initiation = initiationOf(input.speaker);'), true);
  assert.equal(facadeReadsSpeaker('initiation: initiationOf(input.speaker),'), true);

  // 合规样例：原文层 speaker 字段（真源不动）、中立 initiation 字段与入参读取都不得误报。
  const clean = [
    '  speaker: string;',
    '  initiation: string;',
    '        initiation: input.initiation,',
    "    speaker: overrides.speaker ?? 'user',",
  ];
  for (const text of clean) {
    assert.equal(hasInitiationMapper(text), false, `合规代码被误判为映射：${text}`);
    assert.equal(facadeReadsSpeaker(text), false, `合规代码被误判为门面读 speaker：${text}`);
  }

  // 豁免判定：dsh 与未来 headless 都在适配器目录，不属本守卫管辖。
  assert.equal(isAdapterPath('src/adapters/dsh/initiation.ts'), true);
  assert.equal(isAdapterPath('src/adapters/headless/runtime.ts'), true);
  assert.equal(isAdapterPath('src/api/index.ts'), false);
  assert.equal(isAdapterPath('src/contract/raw-turn.ts'), false);
});
