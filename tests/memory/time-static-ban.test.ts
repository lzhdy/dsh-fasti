/**
 * #127 批 4（P3）T9 静态禁令门：时间三模块（L0 词表 / L1-L2 文法 / L3-L4 求解器）
 * 不得出现任何自取时钟、宿主本地化、随机数、环境时区、毫秒日加常数、候选首项直取、
 * 置信度阈值等违禁形态（《最终推荐与实施细则》§3.5）。
 *
 * 口径：剥除注释后扫描可执行代码（纪律性注释不受误伤）；另带投毒自证，
 * 每条违禁词喂合成文本都必须被抓住，防止扫描器本身空转。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_TARGETS = ['time-lexicon.ts', 'time-expr.ts', 'time-resolve.ts'] as const;

/** 剥块注释与行注释（只留可执行代码形态）。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.split('//')[0] ?? '')
    .join('\n');
}

/** 违禁子串表（字面量匹配，不用宽松正则，新增禁令须显式登记）。 */
const BANNED_TOKENS = [
  'Date.now',
  'new Date',
  'Math.random',
  'Intl.',
  'toLocale',
  'process.env.TZ',
  '86400000',
  'windows[0]',
  'confidence',
] as const;

function findBannedTokens(code: string): ReadonlyArray<{ token: string; index: number }> {
  const hits: Array<{ token: string; index: number }> = [];
  for (const token of BANNED_TOKENS) {
    const at = code.indexOf(token);
    if (at >= 0) hits.push({ token, index: at });
  }
  return hits;
}

test('T9 时间三模块可执行代码零禁令子串（时钟/本地化/随机/日加常数/首项直取/置信度）', () => {
  for (const name of SCAN_TARGETS) {
    const file = path.join(REPO_ROOT, 'src', 'memory', name);
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const hits = findBannedTokens(code);
    assert.deepEqual(hits, [], `${name} 出现静态禁令违禁形态`);
  }
});

test('T9 投毒自证：每种违禁形态的合成毒文本都必须被扫描器捕获', () => {
  const poisons: ReadonlyArray<[string, string]> = [
    ['const t = Date.now();', 'Date.now'],
    ['const d = new Date(epochMs);', 'new Date'],
    ['const r = Math.random();', 'Math.random'],
    ['const z = Intl.DateTimeFormat();', 'Intl.'],
    ['const s = x.toLocaleString();', 'toLocale'],
    ['const z = process.env.TZ;', 'process.env.TZ'],
    ['const tomorrow = today + 86400000;', '86400000'],
    ['const first = constraint.windows[0];', 'windows[0]'],
    ['if (score > confidence) {}', 'confidence'],
  ];
  for (const [poison, expectedToken] of poisons) {
    const hits = findBannedTokens(stripComments(poison));
    assert.ok(
      hits.some((h) => h.token === expectedToken),
      `投毒未被捕获：${poison}`,
    );
  }
  // 合规形态不误报：整数日历推进与注释文本。
  const clean = ['const tomorrow = today + 24 * 60 * 60 * 1000;', '// 注释里提到 Date.now 不算违规\nconst x = 1;'];
  for (const sample of clean) {
    assert.deepEqual(findBannedTokens(stripComments(sample)), [], `合规形态被误报：${sample}`);
  }
});
