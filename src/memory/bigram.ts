/**
 * #124 记忆索引 bigram 几何纯函数（charter v2 §3.1）。
 *
 * 无环纪律（与 fts.ts/gate.ts 同层 leaf，tests/memory/layer-imports.test.ts 守护）：
 * 本模块只依赖 `projection/types.ts` 的 asciiLower 与字符串/正则全局，不 import 任何
 * 能到达 store 的 memory 模块，供 fts.ts（写入侧）与 bm25.ts（查询侧）共同引用。
 *
 * 切分口径（主控裁定读法 A）：
 *  - 连续 CJK 段长度 ≥2：相邻两字滑窗产出 bigram，不对长段逐字补 unigram；
 *  - 长度 1 的孤立 CJK 段：发射该字 unigram（服务多段查询中的孤立单字段）；
 *  - ASCII/数字连续段：整词保留，长度 ≥2 才发射；单字母查询由 LIKE 回退负责；
 *  - 标点与空白仅作分隔，不产出单元；码点口径＝Unicode code point（[...str]）。
 */

import { asciiLower } from '../projection/types.ts';

/** CJK 统一表意文字范围（扩展 A＋基本块＋兼容形，与 bigram 探针同口径）。 */
const CJK = /[㐀-䶿一-鿿豈-﫿]/;
/** 归一化后的拉丁/数字 token 字符。 */
const LATIN_CHAR = /[a-z0-9]/;

/**
 * 词面规范化：NFKC → ASCII 小写（不动中文）→ 空白折叠。
 * 与 gate.normalizeLexicalText、bm25.normalizeQuery 逐字同构（bigram.test 同构锁定）。
 */
export function normalizeBigramText(text: string): string {
  return asciiLower(text.normalize('NFKC')).replace(/\s+/g, ' ').trim();
}

export type TextRun =
  | { readonly kind: 'cjk'; readonly text: string }
  | { readonly kind: 'latin'; readonly text: string };

/** 语种分段：连续 CJK 为一段、连续拉丁/数字为一段，其余字符（标点空白）作分隔跳过。 */
export function segmentRuns(normalized: string): readonly TextRun[] {
  const runs: TextRun[] = [];
  const chars = [...normalized];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i] as string;
    if (CJK.test(ch)) {
      let j = i + 1;
      while (j < chars.length && CJK.test(chars[j] as string)) {
        j += 1;
      }
      runs.push({ kind: 'cjk', text: chars.slice(i, j).join('') });
      i = j;
    } else if (LATIN_CHAR.test(ch)) {
      let j = i + 1;
      while (j < chars.length && LATIN_CHAR.test(chars[j] as string)) {
        j += 1;
      }
      runs.push({ kind: 'latin', text: chars.slice(i, j).join('') });
      i = j;
    } else {
      i += 1;
    }
  }
  return runs;
}

/**
 * 索引/查询单元发射（两侧同函数，写入与查询天然同规约）。
 * 入参可为原文：函数内先做词面归一化，调用方无需自行 normalize（归一化幂等，重复调用安全）。
 * CJK 长段只发 bigram；孤立 CJK 段发 unigram；拉丁整词长度 ≥2 才发。
 */
export function emitUnits(text: string): string[] {
  const out: string[] = [];
  for (const run of segmentRuns(normalizeBigramText(text))) {
    if (run.kind === 'cjk') {
      const chars = [...run.text];
      if (chars.length === 1) {
        out.push(chars[0] as string);
      } else {
        for (let k = 0; k + 1 < chars.length; k += 1) {
          out.push(`${chars[k]}${chars[k + 1]}`);
        }
      }
    } else if ([...run.text].length >= 2) {
      out.push(run.text);
    }
  }
  return out;
}

/** FTS5 MATCH 短语：双引号包裹整体、内部引号双写转义；空数组由调用方决定不发起 MATCH。 */
export function ftsPhraseOf(units: readonly string[]): string {
  return `"${units.map((unit) => unit.replace(/"/g, '""')).join(' ')}"`;
}

/** FTS 文本列产物：规范化原文 → 单元序列 → 空格连接。 */
export function indexTextOf(normalized: string): string {
  return emitUnits(normalized).join(' ');
}
