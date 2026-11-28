/**
 * 字符计数与切片原语 —— 全仓唯一码点（code point）口径实现。
 *
 * 为什么只此一份：摄入侧 char_count 与回查侧字符闸/游标必须同口径对账
 * （问题清单 C10，拍板记录 L0-1），散写 Array.from(...).length 会出现第二份口径。
 * 本文件不 import 任何其他 src 模块，零依赖（与 core 全家纪律一致）。
 */

/** 文本的码点长度（等价 Array.from(text).length，但语义自说明）。astral 字符计 1。 */
export function codePointLengthOf(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/**
 * 按码点下标取子串。start/end 均钳制到 [0, 码点数]；start ≥ end 返回空串。
 * 与 String.prototype.substring 的差异：不做 start>end 隐式交换（调用点闸负责合法性）。
 * 码点下标永不劈开代理对。
 */
export function codePointSlice(text: string, start: number, end?: number): string {
  const cps = Array.from(text);
  const s = Math.max(0, Math.min(start, cps.length));
  const e = Math.max(0, Math.min(end ?? cps.length, cps.length));
  if (s >= e) return '';
  return cps.slice(s, e).join('');
}
