// drawer.js —— 右侧详情抽屉（全局单例）：标题 + 内容，Esc/遮罩关闭

import { el, icon } from './dom.js';

let root, backdrop, titleEl, bodyEl, closeBtn;
let opened = false;
let escHandler = null;

export function initDrawer() {
  root = document.getElementById('drawer');
  backdrop = document.getElementById('drawer-backdrop');
  titleEl = document.getElementById('drawer-title');
  bodyEl = document.getElementById('drawer-body');
  closeBtn = document.getElementById('drawer-close');
  closeBtn.append(icon('close'));

  closeBtn.addEventListener('click', () => close());
  backdrop.addEventListener('click', () => close());
  escHandler = (e) => {
    if (e.key === 'Escape' && opened) close();
  };
  window.addEventListener('keydown', escHandler);
}

export function drawerIsOpen() {
  return opened;
}

/**
 * 打开抽屉。
 * @param {string} kindLabel 抽屉左上角的小字类型（如 raw / experience）
 * @param {string} title 标题
 * @param {Node} content 内容节点
 */
export function openDrawer(kindLabel, title, content) {
  titleEl.textContent = '';
  titleEl.append(el('span', { class: 'drawer-kind', text: kindLabel ? kindLabel + ' · ' : '' }), String(title));
  setBody(content);
  root.classList.add('open');
  backdrop.hidden = false;
  opened = true;
}

/** 只替换内容（保持打开状态） */
export function setDrawerBody(content) {
  setBody(content);
}

export function closeDrawer() {
  root.classList.remove('open');
  backdrop.hidden = true;
  opened = false;
  setBody(document.createDocumentFragment());
}

function setBody(content) {
  while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
  if (content instanceof DocumentFragment || content instanceof Node) bodyEl.append(content);
  else bodyEl.append(String(content));
}
