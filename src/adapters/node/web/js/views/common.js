// views/common.js —— 列表视图公共构件

import { el } from '../dom.js';

export function viewHead(title, desc, extra = null) {
  return el('div', { class: 'view-head' },
    el('div', { class: 'view-head-row' }, el('h1', { text: title }), extra),
    el('div', { class: 'view-desc', text: desc }),
  );
}

/**
 * 表格骨架。
 * @param {string} cls 列宽模板类（raw/exp/event/card）
 * @param {string[]} headCells 表头文案
 */
export function table(cls, headCells) {
  const head = el('div', { class: 'trow tbl-head' },
    headCells.map((h) => el('span', { class: 'tcell th', text: h })),
  );
  const body = el('div', { class: 'tbody' });
  const root = el('div', { class: `tbl ${cls}` }, head, body);
  return { root, body };
}

export function rowFlash(rowEl) {
  if (!rowEl) return;
  rowEl.classList.add('flash');
  setTimeout(() => rowEl.classList.remove('flash'), 1600);
}
