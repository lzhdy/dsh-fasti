// shell.js —— 外壳：顶栏、指标条、告警条、侧边导航、断连恢复覆盖层

import { el, icon, idChip, copyText } from './dom.js';
import { fmtNum, fmtDur } from './format.js';
import { store, on, memoryCounts } from './bus.js';
import { pingHealth } from './api.js';

let topbarStatus, strip, alertStrip, navEl;
let unsubs = [];
let connText, connBox, engineBox;
let uptimeEl;
let alertEls = null;

export function initShell() {
  topbarStatus = document.getElementById('topbar-status');
  strip = document.getElementById('status-strip');
  alertStrip = document.getElementById('alert-strip');
  navEl = document.getElementById('nav');

  renderTopbar();
  renderStrip();
  renderAlert();

  unsubs.push(
    on('status', () => { renderTopbar(); renderStrip(); }),
    on('memory', () => { renderTopbar(); renderStrip(); refreshNavBadges(); }),
    on('connection', () => renderTopbar()),
    on('activity', (a) => { if (a && a.kind === 'loop.error') renderAlert(); }),
  );

  // 告警条 5 分钟自动静默
  setInterval(renderAlert, 15000);
}

/** 心跳刷新顶栏运行时长（由 app.js 的 ticker 调用） */
export function updateUptime() {
  if (uptimeEl && store.startedAt) {
    uptimeEl.textContent = fmtDur(Date.now() - store.startedAt);
  }
}

export function destroyShell() {
  unsubs.forEach((u) => u());
  unsubs = [];
}

/* ---------------- 顶栏 ---------------- */

function renderTopbar() {
  const s = store.status;
  if (!topbarStatus.dataset.built) {
    topbarStatus.dataset.built = '1';
    engineBox = el('span', { class: 'engine-badge', text: '—' });
    connBox = el('span', { class: 'conn init' }, el('span', { class: 'conn-dot' }), (connText = el('span', { class: 'conn-text', text: '初始化' })));
    const bootItem = el('span', { class: 'tb-item' },
      el('span', { class: 'k', text: '实例' }),
      el('span', { class: 'v', id: 'tb-boot' }, '—'),
    );
    const uptimeItem = el('span', { class: 'tb-item' },
      el('span', { class: 'k', text: '运行' }),
      (uptimeEl = el('span', { class: 'v', text: '—' })),
    );
    topbarStatus.append(engineBox, connBox, bootItem, uptimeItem);

    // bootId 复制
    bootItem.querySelector('#tb-boot').addEventListener('click', async () => {
      if (store.bootId) await copyText(store.bootId);
    });
    bootItem.title = '点击复制 bootId';
  }

  const eng = s?.engine || {};
  engineBox.textContent = eng.level || '—';
  engineBox.classList.toggle('degraded', eng.degraded === true);
  engineBox.title = eng.degraded
    ? `引擎降级：${eng.reason || '未提供原因'}`
    : '引擎档位 ' + (eng.level || '—');

  const conn = store.connection;
  connBox.className = 'conn ' + conn;
  connText.textContent =
    conn === 'live' ? '实时连接' :
    conn === 'retrying' ? '重连中…' :
    conn === 'lost' ? '连接失效' : '初始化';

  topbarStatus.querySelector('#tb-boot').textContent = store.bootId || '—';

  if (store.startedAt) uptimeEl.textContent = fmtDur(Date.now() - store.startedAt);
}

/* ---------------- 指标条 ---------------- */

function metric(label, value, { cls = '', title = '', opt = false } = {}) {
  const m = el('span', { class: 'metric' + (opt ? ' opt' : ''), title });
  m.append(label + ' ');
  const b = el('b', { text: value });
  if (cls) b.className = cls;
  m.append(b);
  return m;
}

function renderStrip() {
  const s = store.status;
  const parts = [];

  const cp = s?.checkpoint;
  if (cp) {
    parts.push(metric('检查点', `tick ${fmtNum(cp.tick)}`, { title: `检查点 v${cp.version} · 引擎 ${cp.engine}${cp.needs_rebuild ? ' · 需要重建' : ''}` }));
    parts.push(metric('待投影', fmtNum(cp.pending_events), { cls: cp.pending_events > 0 ? 'warn-text' : '', title: 'checkpoint.pending_events' }));
    const rec = s.reconciliation;
    if (rec) {
      const tail = (rec.sourceMaxTick ?? 0) - (rec.lastProjectedTick ?? 0);
      parts.push(metric('投影尾差', fmtNum(tail), { cls: tail > 0 ? 'warn-text' : 'ok-text', title: 'sourceMaxTick − lastProjectedTick（投影是否落后真源）' }));
    }
  }
  parts.push(metric('待摘要', fmtNum(s?.pendingSummaryCount ?? 0), { cls: (s?.pendingSummaryCount || 0) > 0 ? 'warn-text' : '', opt: true }));

  const counts = s?.counts;
  if (counts) {
    const rawTotal = Array.isArray(counts.rawTurns)
      ? counts.rawTurns.reduce((acc, c) => acc + (c.count || 0), 0)
      : null;
    parts.push(metric('经历', fmtNum(counts.experiences ?? 0)));
    parts.push(metric('原文', fmtNum(rawTotal ?? '—')));
    parts.push(metric('事件', fmtNum(counts.events?.total ?? 0)));
  }

  const mem = memoryCounts(store.memory);
  parts.push(metric('卡片', mem ? fmtNum(mem.cards ?? 0) : '未就绪', {
    cls: mem ? '' : 'warn-text',
    title: mem ? `生效 ${mem.activeCards} · 失效 ${mem.invalidCards} · 被取代 ${mem.supersededCards}` : '记忆索引未就绪（503）',
    opt: true,
  }));
  parts.push(metric('别名', mem ? fmtNum(mem.aliases ?? 0) : '—', { opt: true, title: `敏感别名 ${mem ? mem.sensitiveAliases : '—'} · 未命中 ${mem ? mem.misses : '—'}` }));

  while (strip.firstChild) strip.removeChild(strip.firstChild);
  strip.append(...parts);
}

/* ---------------- loop.error 告警条 ---------------- */

function renderAlert() {
  const e = store.lastError;
  const fresh = e && (Date.now() - e.at < 5 * 60_000);
  const dismissed = e && e.seq <= store.alertDismissedSeq;
  if (!e || !fresh || dismissed) {
    alertStrip.hidden = true;
    return;
  }
  if (!alertEls) {
    alertEls = {};
    alertStrip.append(
      icon('warn'),
      el('span', { class: 'alert-title', text: '后台节拍异常' }),
      (alertEls.msg = el('span', { class: 'alert-msg' })),
      el('span', { class: 'spacer' }),
      (alertEls.view = el('button', { class: 'btn', type: 'button' }, '查看活动流')),
      (alertEls.dismiss = el('button', { class: 'btn danger-ghost', type: 'button' }, '忽略')),
    );
    alertEls.view.addEventListener('click', () => { location.hash = '#/overview'; });
    alertEls.dismiss.addEventListener('click', () => {
      store.alertDismissedSeq = store.lastError?.seq ?? -1;
      renderAlert();
    });
  }
  alertEls.msg.textContent = '';
  alertEls.msg.append(
    el('b', { text: e.phase }),
    ` ：${e.message} · 已发生 ${e.count} 次 · 最近 ${fmtNum(Math.round((Date.now() - e.at) / 1000))} 秒前`,
  );
  alertStrip.hidden = false;
}

/* ---------------- 侧边导航 ---------------- */

let navItems = new Map();

export function renderNav(views, activeId) {
  while (navEl.firstChild) navEl.removeChild(navEl.firstChild);
  navItems = new Map();
  for (const v of views) {
    const badgeEl = el('span', { class: 'nav-badge', text: '—' });
    const item = el('button', { class: 'nav-item', type: 'button' },
      icon(v.icon),
      el('span', { class: 'nav-label', text: v.title }),
      badgeEl,
    );
    item.dataset.route = v.id;
    item.addEventListener('click', () => { location.hash = '#/' + v.id; });
    navItems.set(v.id, { item, badgeEl });
    navEl.append(item);
  }
  navEl.append(el('div', { class: 'nav-foot' },
    '只读观测 · 无任何写操作',
    el('br'), '数据随内核进程驻留内存',
  ));
  setActiveNav(activeId);
  refreshNavBadges();
}

export function setActiveNav(activeId) {
  for (const [id, { item }] of navItems) {
    item.classList.toggle('active', id === activeId);
  }
}

export function refreshNavBadges() {
  const s = store.status;
  const counts = s?.counts;
  const rawTotal = Array.isArray(counts?.rawTurns)
    ? counts.rawTurns.reduce((acc, c) => acc + (c.count || 0), 0)
    : null;
  const values = {
    overview: null,
    raw: rawTotal,
    experiences: counts?.experiences ?? null,
    events: counts?.events?.total ?? null,
    cards: store.memory ? (store.memory.cards ?? 0) : '503',
    projection: null,
  };
  for (const [id, { badgeEl }] of navItems) {
    const v = values[id];
    badgeEl.textContent = v === null || v === undefined ? '' : String(v);
    badgeEl.classList.toggle('unavailable', v === '503');
    badgeEl.hidden = v === null || v === undefined || v === '';
  }
}

/* ---------------- 断连恢复覆盖层 ---------------- */

/**
 * 令牌失效（内核重启）后的恢复覆盖层：
 * 轮询 /health（免 token），恢复后自动重载页面以领取新引导。
 */
export function showReconnectOverlay() {
  const overlayRoot = document.getElementById('overlay-root');
  while (overlayRoot.firstChild) overlayRoot.removeChild(overlayRoot.firstChild);

  let attempts = 0;
  let statusEl;

  const box = el('div', { class: 'boot-box' },
    el('div', { class: 'boot-logo' },
      el('span', { class: 'ring' }), el('span', { class: 'ring r2' }), el('span', { class: 'ring r3' }),
      el('span', { class: 'core' }),
    ),
    el('div', { class: 'boot-title', text: '连接失效' }),
    el('div', { class: 'boot-sub', text: 'TOKEN INVALIDATED · KERNEL RESTARTED' }),
    el('div', { class: 'boot-error' },
      el('div', { class: 'be-title' }, icon('warn'), '访问令牌已过期'),
      el('div', {}, '内核令牌随进程一次性生成、不落盘：进程重启即失效。正在等待内核服务重新上线，'),
      el('div', {}, '恢复后将自动重新载入页面并领取新令牌。'),
      (statusEl = el('div', { class: 'small faint', style: { marginTop: '10px' }, text: '等待内核上线…' })),
      el('div', { class: 'be-actions' },
        el('button', {
          class: 'btn primary', type: 'button', text: '立即重载',
          onclick: () => location.reload(),
        }),
      ),
    ),
    el('div', { class: 'boot-foot', text: 'FASTI OBSERVATORY · RECONNECT' }),
  );

  const overlay = el('div', { class: 'overlay' }, box);
  overlayRoot.append(overlay);

  const timer = setInterval(async () => {
    attempts += 1;
    statusEl.textContent = `第 ${attempts} 次探测 /health …`;
    const ok = await pingHealth();
    if (ok) {
      clearInterval(timer);
      statusEl.textContent = '内核已上线，正在重新载入…';
      setTimeout(() => location.reload(), 400);
    }
  }, 1500);
}
