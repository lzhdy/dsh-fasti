// dom.js —— 极简 DOM 构建助手与图标库
// 原则：所有来自接口的动态文本一律走 textContent（经 el 的 children 注入），
// innerHTML 仅用于本文件内写死的静态 SVG 模板，杜绝 XSS 面。

/**
 * 创建元素。
 * @param {string} tag
 * @param {object|null} attrs  class/text/html(仅静态)/style(对象,CSSOM)/dataset/on{事件}
 * @param {...(Node|string|Array|null|false|undefined)} children
 */
export function el(tag, attrs = null, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'html') node.innerHTML = String(v); // 仅限本模块静态模板调用
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, kids) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) { appendChildren(node, c); continue; }
    if (c instanceof Node) node.append(c);
    else node.append(document.createTextNode(String(c)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

/* ---------------- 图标库（静态内联 SVG） ---------------- */

const S = 'viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

const ICON_TPL = {
  logo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="3" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="7.5" stroke-opacity=".55"/><circle cx="16" cy="16" r="12" stroke-opacity=".25"/></svg>`,
  pulse: `<svg ${S}><path d="M1.5 8.5h3l2-5.5 3.5 11 2.5-6.5 1.5 3h1.5"/></svg>`,
  raw: `<svg ${S}><rect x="2.5" y="1.8" width="11" height="12.4" rx="1.6"/><path d="M5 5h6M5 8h6M5 11h3.5"/></svg>`,
  exp: `<svg ${S}><path d="M8 1.8 14 5 8 8.2 2 5z"/><path d="M2 8.5 8 11.7 14 8.5"/><path d="M2 11.8 8 15 14 11.8"/></svg>`,
  event: `<svg ${S}><circle cx="3.5" cy="3.5" r="1.6"/><circle cx="3.5" cy="12.5" r="1.6"/><circle cx="12.5" cy="8" r="1.6"/><path d="M5 4.2 10.9 7.2M5 11.8 10.9 8.8"/></svg>`,
  card: `<svg ${S}><rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.6"/><circle cx="5.4" cy="7" r="1.1"/><path d="M8.5 6h3.5M8.5 9.5h4M3 11h4.5"/></svg>`,
  proj: `<svg ${S}><circle cx="8" cy="3" r="1.7"/><circle cx="3" cy="12.5" r="1.7"/><circle cx="13" cy="12.5" r="1.7"/><path d="M6.9 4.5 4.2 11M9.1 4.5l2.7 6.5M4.7 12.5h6.6"/></svg>`,
  copy: `<svg ${S}><rect x="5.2" y="5.2" width="8.6" height="8.6" rx="1.4"/><path d="M10.8 5.2V3.4a1.4 1.4 0 0 0-1.4-1.4H3.4a1.4 1.4 0 0 0-1.4 1.4v6a1.4 1.4 0 0 0 1.4 1.4h1.8"/></svg>`,
  close: `<svg ${S}><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  refresh: `<svg ${S}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.8v2.8h-2.8"/></svg>`,
  warn: `<svg ${S}><path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.2M8 11.6v.1"/></svg>`,
  ok: `<svg ${S}><path d="M3 8.5 6.5 12 13 4.5"/></svg>`,
  err: `<svg ${S}><circle cx="8" cy="8" r="6.2"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg>`,
  dot: `<svg ${S}><circle cx="8" cy="8" r="2.2"/></svg>`,
  clock: `<svg ${S}><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.8"/></svg>`,
  chip: `<svg ${S}><rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/><path d="M6.5 1.8v2.7M9.5 1.8v2.7M6.5 11.5v2.7M9.5 11.5v2.7M1.8 6.5h2.7M1.8 9.5h2.7M11.5 6.5h2.7M11.5 9.5h2.7"/></svg>`,
  arrowR: `<svg ${S}><path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5"/></svg>`,
  lock: `<svg ${S}><rect x="3.5" y="7" width="9" height="6.5" rx="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`,
  inbox: `<svg ${S}><path d="M2 9.5h3.5L7 11.5h2l1.5-2H14"/><path d="M3.5 2.5h9L14 8v5.5H2V8z"/></svg>`,
  link: `<svg ${S}><path d="M6.5 9.5 9.5 6.5"/><path d="M8 4.5 9.8 2.7a2.4 2.4 0 0 1 3.4 3.4L11.4 7.9"/><path d="M8 11.5 6.2 13.3a2.4 2.4 0 0 1-3.4-3.4L4.6 8.1"/></svg>`,
  layers: `<svg ${S}><path d="M8 2.5 14 5.5 8 8.5 2 5.5z"/><path d="M2 11.5 8 14.5 14 11.5"/></svg>`,
  brain: `<svg ${S}><path d="M10 3.5a2.5 2.5 0 0 0-2.4 1.8A2.5 2.5 0 0 0 5 7.7a2.6 2.6 0 0 0 .4 4.7A2.4 2.4 0 0 0 7.8 14c1.6 0 2.3-1.2 2.3-2.4"/><path d="M10 3.5c1.4 0 2.6 1.1 2.6 2.5 1 .4 1.7 1.3 1.7 2.5 0 1.6-1.3 2.9-2.9 2.9h-1.3"/><path d="M8.5 7.5h3"/></svg>`,
  gauge: `<svg ${S}><path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="M8 11.5 11 7"/><circle cx="8" cy="11.5" r="1"/></svg>`,
  db: `<svg ${S}><ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9"/><path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/></svg>`,
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'icon' + (cls ? ' ' + cls : '');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICON_TPL[name] || ICON_TPL.dot;
  return span;
}

/* ---------------- 复制 ---------------- */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 一键复制按钮（用于长 id / 哈希） */
export function copyBtn(value, title = '复制') {
  const b = el('button', { class: 'copy-btn', type: 'button', title, 'aria-label': title });
  b.append(icon('copy', 'sm'));
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await copyText(value);
    b.classList.toggle('copied', ok);
    b.classList.toggle('copy-fail', !ok);
    b.title = ok ? '已复制' : '复制失败';
    setTimeout(() => { b.classList.remove('copied', 'copy-fail'); b.title = title; }, 900);
  });
  return b;
}

/** id 展示：缩短 + title 全文 + 复制按钮 */
export function idChip(value, { shortAfter = 10, shortBefore = 6 } = {}) {
  const wrap = el('span', { class: 'id-with-copy' });
  const s = String(value ?? '');
  const shown = s.length > shortAfter + shortBefore + 1
    ? s.slice(0, shortAfter) + '…' + (shortBefore ? s.slice(-shortBefore) : '')
    : s;
  const chip = el('span', { class: 'idchip short', text: shown, title: s });
  wrap.append(chip, copyBtn(s));
  return wrap;
}
