// feed.js —— 活动流时间线（实时插入 + 高亮动画 + 环形 200 条 + 链路过滤）

import { el, icon } from './dom.js';
import { fmtClock, fmtRel, safeStr, truncate } from './format.js';
import { on, kindMeta, store } from './bus.js';

const MAX_ENTRIES = 200;

let listEl, countEl, unsub = null, filter = 'all';
let unsubs2 = [];
/** 环形历史：跨视图切换保留最近 200 条（重挂载时回放，不重播动画） */
const history = [];

export function initFeed(container) {
  listEl = el('div', { class: 'feed-list', dataset: { filter: 'all' } });
  countEl = el('span', { class: 'head-hint', text: '0 条' });

  const seg = el('span', { class: 'seg' });
  const filters = [
    ['all', '全部'], ['write', '写入链'], ['read', '读出链'], ['system', '异常'],
  ];
  const segBtns = [];
  for (const [key, label] of filters) {
    const b = el('button', { type: 'button', text: label });
    b.addEventListener('click', () => {
      filter = key;
      listEl.dataset.filter = key;
      segBtns.forEach(([k, btn]) => btn.classList.toggle('active', k === key));
    });
    if (key === 'all') b.classList.add('active');
    segBtns.push([key, b]);
    seg.append(b);
  }

  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      icon('pulse'),
      '活动流',
      countEl,
      el('span', { class: 'spacer' }),
      seg,
    ),
    listEl,
  );

  container.append(panel);

  // 回放历史（无动画，倒序=最新在上）
  if (history.length) {
    for (let i = history.length - 1; i >= 0; i--) listEl.append(buildEntry(history[i], { replay: true }));
    countEl.textContent = `显示 ${listEl.children.length} 条 · 会话累计 ${sumSession()}`;
  } else {
    setEmpty();
  }

  unsub = on('activity', (a) => {
    insert(a);
  });
  // 内核重启：旧实例的活动历史随之失效
  unsubs2.push(on('restart', () => {
    history.length = 0;
    if (listEl) {
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      setEmpty();
    }
  }));

  return { setFilter };
}

export function destroyFeed() {
  if (unsub) { unsub(); unsub = null; }
  unsubs2.forEach((u) => u());
  unsubs2 = [];
}

export function setFilter(f) {
  filter = f;
  if (listEl) {
    listEl.dataset.filter = f;
    // 同步 seg 高亮
    const seg = listEl.parentElement?.querySelector('.seg');
    if (seg) {
      const idx = { all: 0, write: 1, read: 2, system: 3 }[f];
      [...seg.children].forEach((b, i) => b.classList.toggle('active', i === idx));
    }
  }
}

function setEmpty() {
  listEl.append(el('div', { class: 'feed-empty' },
    '等待活动…（后台节拍每 5 秒一轮；空轮不产生条目，属正常现象）',
  ));
}

function insert(a) {
  const empty = listEl.querySelector('.feed-empty');
  if (empty) empty.remove();

  history.push(a);
  while (history.length > MAX_ENTRIES) history.shift();

  const atTop = listEl.scrollTop <= 2;
  const before = listEl.scrollHeight;

  listEl.prepend(buildEntry(a));

  // 用户翻看历史时不抢滚动条
  if (!atTop) listEl.scrollTop += listEl.scrollHeight - before;

  while (listEl.children.length > MAX_ENTRIES) {
    listEl.removeChild(listEl.lastChild);
  }
  countEl.textContent = `显示 ${listEl.children.length} 条 · 会话累计 ${sumSession()}`;
}

function sumSession() {
  let n = 0;
  for (const v of Object.values(store.sessionCounts)) n += v;
  return n;
}

function buildEntry(a, { replay = false } = {}) {
  const meta = kindMeta(a.kind);
  const chain = meta ? meta.chain : 'other';
  const level = ['info', 'ok', 'warn', 'error'].includes(a.level) ? a.level : 'info';

  const entry = el('div', {
    class: 'feed-entry' + (replay ? '' : ' new-entry'),
    dataset: { chain, kind: a.kind || 'unknown' },
  });

  const dot = el('span', { class: `fe-dot ${level}` });
  const time = el('span', { class: 'fe-time', text: fmtClock(a.at) || '—' });
  const kindChip = el('span', {
    class: 'fe-kind',
    text: (meta ? meta.label : '') + ' ' + (a.kind || '未知'),
    title: meta ? meta.hint : '未知活动类型（兜底渲染）',
  });
  const msg = el('span', { class: 'fe-msg', text: a.message || '（无消息文本）' });
  const rel = el('span', { class: 'fe-rel', dataset: { ts: String(a.at) }, text: fmtRel(a.at) });

  entry.append(dot, time, kindChip, msg, rel);

  // 展开详情：数据字段 chips + 原始 JSON
  entry.addEventListener('click', () => {
    const open = entry.classList.toggle('open');
    if (open && !entry.querySelector('.fe-detail')) entry.append(buildDetail(a));
  });

  // 高亮动画只播一次（回放条目不播）
  if (!replay) setTimeout(() => entry.classList.remove('new-entry'), 1400);
  return entry;
}

function buildDetail(a) {
  const wrap = el('div', { class: 'fe-detail' });
  const data = a.data && typeof a.data === 'object' ? a.data : null;
  if (data) {
    const chips = el('div', { class: 'chips-wrap', style: { margin: '6px 0 2px' } });
    for (const [k, v] of Object.entries(data)) {
      const text = `${k}=${truncate(safeStr(v) ?? 'null', 42)}`;
      const tone = (k === 'ok' && v === false) ? 'err'
        : (k === 'ok' && v === true) ? 'ok'
        : (k === 'phase' || k === 'message') ? 'err'
        : '';
      chips.append(el('span', { class: 'chip' + (tone ? ` chip-${tone}` : ''), title: `${k} = ${safeStr(v)}`, text }));
    }
    wrap.append(chips);
  }
  wrap.append(el('pre', { class: 'json-pre', style: { margin: '6px 0 2px' } },
    JSON.stringify({ seq: a.seq, at: a.at, kind: a.kind, level: a.level, message: a.message, data: a.data ?? undefined }, null, 2),
  ));
  return wrap;
}
