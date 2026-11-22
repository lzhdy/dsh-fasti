// kv.js —— 详情抽屉的字段/区块渲染助手

import { el, icon, copyBtn, idChip } from './dom.js';
import { fmtTime, safeStr } from './format.js';

/** 详情区块：<h3>标题</h3> + 键值行（行可为已构建节点、{node} 包装或 {k,v} 描述对象） */
export function kvSection(title, rows, { extra } = {}) {
  const sec = el('div', { class: 'd-sec' }, el('h3', { text: title }));
  const kv = el('div', { class: 'kv' });
  for (const r of rows) {
    if (!r) continue;
    if (r instanceof Node) kv.append(r);
    else if (r.node) kv.append(r.node);
    else kv.append(kvRow(r));
  }
  sec.append(kv);
  if (extra) sec.append(extra);
  return sec;
}

/**
 * 一行键值。
 * k: 键名；v: 值（字符串/节点）；mono/copy/hash/id 控制形态；time: ISO 或 ms 自动本地化
 */
export function kvRow({ k, v, mono = false, copy = null, time = null, suffix = null }) {
  const val = el('span', { class: 'kv-v' + (mono ? ' mono-v' : '') });
  if (v instanceof Node) val.append(v);
  else if (time !== null) {
    const local = fmtTime(time, { ms: true }) || fmtTime(time);
    val.append(el('span', { text: local || '—' }));
    if (typeof time === 'string' && time) {
      val.append(' ', el('span', { class: 'faint small mono', text: `(${time.endsWith('Z') ? time : time + 'Z'})` }));
    }
  } else if (v === null || v === undefined || v === '') {
    val.append(el('span', { class: 'faint', text: '—' }));
  } else {
    val.append(String(v));
  }
  if (suffix) val.append(' ', suffix);
  if (copy) val.append(' ', copyBtn(copy));
  return el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: k }), val);
}

/** 长 id 行：缩短显示 + title + 复制 */
export function kvId(k, value) {
  if (value === null || value === undefined || value === '') {
    return kvRow({ k, v: null });
  }
  return el('div', { class: 'kv-row' },
    el('span', { class: 'kv-k', text: k }),
    el('span', { class: 'kv-v mono-v' }, idChip(value)),
  );
}

/** 时间行（ISO 字符串或 ms 数字） */
export function kvTime(k, value) {
  const local = fmtTime(value, { ms: typeof value === 'number' });
  const val = el('span', { class: 'kv-v mono-v', text: local || '—' });
  if (typeof value === 'string' && value) {
    val.append(' ', el('span', { class: 'faint small', text: 'UTC ' + value }));
  }
  return el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: k }), val);
}

/** JSON 展示块 */
export function jsonPre(value, { maxHeight } = {}) {
  const pre = el('pre', { class: 'json-pre', text: safeStr(value, { jsonStyle: 'pretty' }) ?? 'null' });
  if (maxHeight) pre.style.maxHeight = maxHeight;
  return pre;
}

/** chip 横排 */
export function chipRow(chips) {
  return el('div', { class: 'chips-wrap' }, chips);
}

/** 语义状态 chip（未知值兜底为虚线中性样式） */
export function statusChip(label, tone = 'dim', { dashed = false } = {}) {
  return el('span', {
    class: 'chip' + (tone && tone !== 'dim' ? ` chip-${tone}` : '') + (dashed ? ' chip-dashed' : ''),
    text: label,
  });
}

/** 布尔标记 chip 集合（marks 等）：只展示 true 项 */
export function markChips(marks, map) {
  const chips = [];
  if (marks && typeof marks === 'object') {
    for (const [key, label] of Object.entries(map)) {
      if (marks[key] === true) chips.push(statusChip(label, 'warn'));
      else if (marks[key] === false) chips.push(statusChip(label, 'dim'));
    }
  }
  if (!chips.length) return el('span', { class: 'faint', text: '无' });
  return chipRow(chips);
}

/** 操作按钮组 */
export function actionRow(buttons) {
  return el('div', { class: 'd-actions' }, buttons);
}

/** 跳转按钮（跨视图下钻） */
export function jumpBtn(label, iconName, onClick, { primary = false } = {}) {
  const b = el('button', { class: 'btn' + (primary ? ' primary' : ''), type: 'button' }, icon(iconName), label);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}
