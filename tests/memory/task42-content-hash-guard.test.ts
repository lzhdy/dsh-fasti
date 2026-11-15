/**
 * #42 · B2 第五批：content_hash 护栏（正本 §3.5.2 / 裁决 5）。
 *
 * 铁律：
 *  - 「结构是否变化」的判定一律走 `structuralHash`（anchors/channel/时间窗/eligibility/
 *    rules_version 六项）；`content_hash` 只做卡片内容摘要的同公式同输入面自比；
 *  - content_hash 不参与 invalidation 判定、不跨输入面与 structuralHash 互比；
 *  - computeContentHash 生产调用面恒定两处：builder.ts（建卡自比）、alias-write.ts（别名写自比）。
 *
 * 静态 + 结构双断言：将来若有人把 content_hash 拿去判失效或跨面比较，本文件即红。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeContentHash } from '../../src/memory/content-hash.ts';
import { structuralHash } from '../../src/memory/derive.ts';
import { evaluateInvalidation } from '../../src/memory/invalidate.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = Date.parse('2026-11-08T02:13:20.000Z');
const DAY = 24 * 3600 * 1000;

interface ScanFile {
  readonly relPath: string;
  readonly text: string;
}

function readMemorySources(): ScanFile[] {
  const out: ScanFile[] = [];
  const memoryDir = path.join(REPO_ROOT, 'src/memory');
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push({
          relPath: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
          text: fs.readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(memoryDir);
  return out;
}

function stripTsComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.split('//')[0] ?? '')
    .join('\n');
}

/** 结构/失效判定路径上的模块：不得引用卡片内容摘要哈希。 */
const STRUCTURE_PATH_FILES = [
  'src/memory/invalidate.ts',
  'src/memory/planner.ts',
  'src/memory/derive.ts',
  'src/memory/drain.ts',
] as const;

test('护栏：invalidate / planner / derive / drain 结构路径不引用 content_hash 或 computeContentHash', () => {
  for (const relPath of STRUCTURE_PATH_FILES) {
    const full = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(full)) continue;
    const code = stripTsComments(fs.readFileSync(full, 'utf8'));
    for (const token of ['contentHash', 'content_hash', 'computeContentHash']) {
      assert.ok(!code.includes(token), `${relPath} 结构判定路径不得引用 ${token}`);
    }
  }
});

test('护栏：不存在 content_hash 与 structuralHash 跨输入面互比的代码行', () => {
  for (const file of readMemorySources()) {
    const code = stripTsComments(file.text);
    for (const line of code.split('\n')) {
      const hasContent = /contentHash|content_hash/.test(line);
      const hasStructural = /structuralHash|structural_hash/.test(line);
      if (hasContent && hasStructural && /===|!==|==|!=/.test(line)) {
        assert.fail(`跨输入面互比：${file.relPath}：${line.trim()}`);
      }
    }
  }
});

test('护栏：content_hash 生产调用面恒定两处（builder 建卡自比、alias-write 别名写自比）', () => {
  const callSites: string[] = [];
  for (const file of readMemorySources()) {
    if (file.relPath === 'src/memory/content-hash.ts') continue; // 定义点不计调用面
    const code = stripTsComments(file.text);
    if (/computeContentHash\s*\(/.test(code)) {
      callSites.push(file.relPath);
    }
  }
  assert.deepEqual(callSites.sort(), [
    'src/memory/alias-write.ts',
    'src/memory/builder.ts',
  ]);
});

test('护栏：evaluateInvalidation 入参结构不含内容摘要哈希（失效判定只看状态/事件/别名）', () => {
  const inputText = fs.readFileSync(path.join(REPO_ROOT, 'src/memory/invalidate.ts'), 'utf8');
  const inputBlock = /interface\s+InvalidationInput\s*\{([\s\S]*?)\}/.exec(inputText);
  assert.ok(inputBlock !== null, '须存在 InvalidationInput 接口');
  assert.ok(!/contentHash|content_hash/.test(inputBlock[1] ?? ''), 'InvalidationInput 不得携带 content_hash');
  // 函数体内不得读取卡片的 contentHash 字段参与判定。
  const fnBody = /evaluateInvalidation\([\s\S]*?\n\}/.exec(inputText);
  if (fnBody !== null) {
    assert.ok(!/contentHash/.test(fnBody[0]), 'evaluateInvalidation 函数体不得读取 contentHash');
  }
});

test('行为：structuralHash 六项结构输入任一变化必变；同输入确定性复现', () => {
  const base = {
    anchors: ['01J0000000000000000000000A'],
    channel: 'dsh',
    startedMs: T0,
    endedMs: T0 + DAY,
    eligibility: 'selected',
    rulesVersion: 'rules-v1',
  };
  assert.equal(structuralHash(base), structuralHash({ ...base }), '同输入两次哈希相等');

  const variants = [
    { ...base, anchors: ['01J0000000000000000000000B'] },
    { ...base, channel: 'web' },
    { ...base, startedMs: T0 + DAY },
    { ...base, eligibility: 'maybe' },
    { ...base, rulesVersion: 'rules-v2' },
  ];
  for (const variant of variants) {
    assert.notEqual(structuralHash(variant), structuralHash(base), '结构输入变化必须反映到 structuralHash');
  }
});

test('行为：computeContentHash 仅同输入面自比——同输入幂等，四输入之一变化即变', () => {
  const cues = '["线索一"]';
  const aliases = '[]';
  const base = computeContentHash('["01J0000000000000000000000A"]', cues, aliases, '区别短句');
  assert.equal(
    computeContentHash('["01J0000000000000000000000A"]', cues, aliases, '区别短句'),
    base,
    '同四输入幂等',
  );
  assert.notEqual(
    computeContentHash('["01J0000000000000000000000B"]', cues, aliases, '区别短句'),
    base,
    '锚点输入变化 → 摘要哈希变',
  );
  assert.notEqual(
    computeContentHash('["01J0000000000000000000000A"]', '["线索二"]', aliases, '区别短句'),
    base,
    '线索输入变化 → 摘要哈希变',
  );
});

test('行为：失效判定不依赖内容摘要哈希——同锚点/状态下 contentHash 差异不改变失效结果', () => {
  const card = {
    cardId: 'mc_guard',
    eventId: 'evt-guard',
    anchorJson: '["01J0000000000000000000000A"]',
    aliasesJson: '[]',
    expiredMs: null,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    contentHash: 'stale-hash-that-must-not-matter',
  } as Parameters<typeof evaluateInvalidation>[0]['card'];

  const result = evaluateInvalidation({ card, atMs: T0 + DAY, aliasTable: [] });
  assert.equal(result.status, 'active', '内容摘要哈希不参与失效判定：无事件/别名冲突即 active');
});
