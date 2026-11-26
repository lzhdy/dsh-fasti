// app.js —— ESM 入口：启动仪式 → 外壳装配 → 路由 → 长轮询常驻
//
// 后端在 index.html 响应中注入带 nonce 的 window.__FASTI_BOOTSTRAP__（机制见正本 11.13.13），
// 前端零配置同源读取其中的一次性 token，仅存内存、不自行持久化。
// 引导缺失时给出明确的“引导未注入”错误态，绝不白屏。

import { el, icon } from './js/dom.js';
import { fmtRel } from './js/format.js';
import {
  initApi, pingHealth, fetchStatus,
  fetchRaw, fetchExperiences, fetchEvents, fetchCards, fetchProjection,
} from './js/api.js';
import { store, emit, on } from './js/bus.js';
import { startPulse, stopPulse } from './js/pulse.js';
import { initShell, renderNav, showReconnectOverlay, updateUptime } from './js/shell.js';
import { initDrawer } from './js/drawer.js';
import { startRouter, VIEWS } from './js/router.js';
import { loadAppearance } from './js/appearance.js';
import { playSplash } from './js/splash.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBootstrap() {
  const b = typeof window !== 'undefined' ? window.__FASTI_BOOTSTRAP__ : null;
  if (!b || typeof b !== 'object') return null;
  if (typeof b.token !== 'string' || !b.token) return null;
  return b;
}

/* ================= 启动覆盖层 ================= */

function buildBootOverlay() {
  const overlayRoot = document.getElementById('overlay-root');
  while (overlayRoot.firstChild) overlayRoot.removeChild(overlayRoot.firstChild);

  const stageRows = new Map();
  const list = el('div', { class: 'boot-stages' });
  const errorBox = el('div', { class: 'boot-error', hidden: true });

  const STAGE_DEFS = [
    ['health', '探测内核服务', 'GET /health（免令牌）'],
    ['boot', '校验引导令牌', 'window.__FASTI_BOOTSTRAP__'],
    ['status', '读取运行状态', 'GET /api/status'],
    ['prefetch', '预取观测数据', 'raw · experiences · events · cards · projection'],
  ];

  for (const [key, label, sub] of STAGE_DEFS) {
    const detail = el('span', { class: 'stage-detail', text: sub });
    const state = el('span', { class: 'stage-state' });
    const row = el('div', { class: 'boot-stage', dataset: { stage: key } },
      el('span', { class: 'stage-ico' }),
      el('span', { class: 'stage-label', text: label }),
      detail,
      state,
    );
    stageRows.set(key, { row, detail, state });
    list.append(row);
  }

  const box = el('div', { class: 'boot-box' },
    el('div', { class: 'boot-logo' },
      el('span', { class: 'ring' }), el('span', { class: 'ring r2' }), el('span', { class: 'ring r3' }),
      el('span', { class: 'core' }),
    ),
    el('div', { class: 'boot-title', text: 'FasTI 观测台' }),
    el('div', { class: 'boot-sub', text: 'LOCAL MEMORY KERNEL · OBSERVATORY' }),
    list,
    errorBox,
    el('div', { class: 'boot-foot', text: 'FASTI OBSERVATORY · BOOT SEQUENCE' }),
  );
  overlayRoot.append(el('div', { class: 'overlay' }, box));

  function setRow(key, mode, detailText) {
    const r = stageRows.get(key);
    if (!r) return;
    const ico = r.row.querySelector('.stage-ico');
    while (ico.firstChild) ico.removeChild(ico.firstChild);
    r.row.classList.remove('active', 'done', 'failed');
    if (mode === 'active') {
      r.row.classList.add('active');
      ico.append(el('span', { class: 'spinner' }));
    } else if (mode === 'done') {
      r.row.classList.add('done');
      ico.append(icon('ok'));
    } else if (mode === 'failed') {
      r.row.classList.add('failed');
      ico.append(icon('err'));
    }
    if (detailText !== undefined) r.detail.textContent = detailText;
  }

  function showError(title, desc, { reload = false } = {}) {
    errorBox.hidden = false;
    while (errorBox.firstChild) errorBox.removeChild(errorBox.firstChild);
    errorBox.append(
      el('div', { class: 'be-title' }, icon('err'), title),
      el('div', { text: desc }),
      el('div', { class: 'be-actions' },
        el('button', { class: 'btn primary', type: 'button', text: '重试启动序列', onclick: () => boot() }),
        el('button', { class: 'btn', type: 'button', text: '刷新页面', onclick: () => location.reload() }),
      ),
    );
    if (reload) { /* 保留手动出口，不做自动 reload，避免无限循环 */ }
  }

  async function stage(key, fn) {
    setRow(key, 'active');
    const startedAt = Date.now();
    let detailText = '';
    const report = (text) => {
      detailText = text;
      setRow(key, 'active', text);
    };
    try {
      const result = await fn(report);
      // 仪式感：每个成功阶段至少驻留 180ms，肉眼可辨
      const remain = 180 - (Date.now() - startedAt);
      if (remain > 0) await sleep(remain);
      setRow(key, 'done', detailText || (typeof result === 'string' ? result : '完成'));
      return result;
    } catch (err) {
      setRow(key, 'failed', detailText || (err && err.message) || '失败');
      throw err;
    }
  }

  return { stage, showError, finish: async () => {
    await sleep(250);
    const overlay = overlayRoot.querySelector('.overlay');
    if (overlay) overlay.classList.add('closing');
    await sleep(420);
    while (overlayRoot.firstChild) overlayRoot.removeChild(overlayRoot.firstChild);
  } };
}

/* ================= 启动序列 ================= */

let booted = false;

/**
 * 启动视频层（#240 纯净播放）：槽位由引导字段 splash 决定（full＝进程首屏，mini＝刷新）。
 * 视频阶段画面里只有视频、不渲染任何程序 UI；播放器自身兜底全部失败路径，
 * 本 Promise resolve（播完/被收层/无文件略过）之后，调用方才构建启动序列卡片。
 */
async function startSplashLayer(appearanceReady) {
  const bs = readBootstrap();
  if (!bs) return;
  const state = await appearanceReady;
  if (!state) return;
  const slot = bs.splash === 'mini' ? 'mini' : 'full';
  const s = state.settings.splash;
  if (!s[slot]) return;
  const file = state.splashFiles ? state.splashFiles[slot] : null;
  if (!file) return;
  await playSplash(file, s.sound);
}

async function boot() {
  // ⓪ 引导 + 外观 + 启动视频（#240 纯净播放口径）：视频阶段画面里只有视频，
  //    不构建启动卡片、不跑探测序列；视频自然播完或被收层后，才 buildBootOverlay。
  //    播放器自带全部兜底（无文件/解码失败/硬超时），无视频时这里立即放行。
  const bs0 = readBootstrap();
  if (bs0) initApi(bs0.token);
  const appearanceReady = loadAppearance();
  const splashDone = startSplashLayer(appearanceReady);
  await splashDone;

  const overlay = buildBootOverlay();

  // ① 探测内核服务
  await overlay.stage('health', async (report) => {
    for (let i = 1; i <= 30; i++) {
      report(`第 ${i} 次探测…`);
      if (await pingHealth()) return '内核服务已响应';
      await sleep(1000);
    }
    throw new Error('内核服务持续不可达（已探测 30 次，约 30 秒）。请确认 node 后台进程已启动。');
  }).catch((err) => {
    overlay.showError('无法连接内核服务', (err && err.message) || '');
    throw new SilentBootAbort();
  });

  // ② 校验引导令牌
  await overlay.stage('boot', async () => {
    const bs = readBootstrap();
    if (!bs) {
      const err = new Error('boot-bootstrap-missing');
      err.userMessage = '引导对象未注入：window.__FASTI_BOOTSTRAP__ 缺失或 token 字段为空。'
        + '该对象由后端在 index.html 响应中随页面注入；请确认从 /app/ 入口正常打开，或刷新页面重新领取；若反复出现，请检查后端服务是否正常。';
      throw err;
    }
    initApi(bs.token);
    store.channel = typeof bs.channel === 'string' && bs.channel ? bs.channel : store.channel;
    return `bootId ${bs.bootId || '（未提供）'} · 通道 ${store.channel || '（未提供）'}`;
  }).catch((err) => {
    if (err instanceof SilentBootAbort) throw err;
    overlay.showError('引导未注入', err.userMessage || err.message);
    throw new SilentBootAbort();
  });

  // ③ 读取运行状态
  await overlay.stage('status', async () => {
    let s;
    try {
      s = await fetchStatus();
    } catch (err) {
      if (err && err.authFailed) {
        err.userMessage = '访问令牌无效（401）：令牌随内核进程一次性生成。内核可能已重启，刷新页面即可领取新令牌。';
      }
      throw err;
    }
    applyStatus(s);
    return `引擎 ${s.engine?.level || '—'} · tick ${s.checkpoint?.tick ?? '—'} · bootId ${s.bootId || '—'}`;
  }).catch((err) => {
    if (err instanceof SilentBootAbort) throw err;
    overlay.showError('读取运行状态失败', err.userMessage || err.message || '请稍后重试。');
    throw new SilentBootAbort();
  });

  // ④ 预取观测数据（失败不阻断进入控制台，视图内还有自己的错误态与重试）
  await overlay.stage('prefetch', async (report) => {
    const names = ['raw', 'experiences', 'events', 'cards', 'projection'];
    let done = 0;
    const results = await Promise.allSettled([
      fetchRaw({ limit: 25 }),
      fetchExperiences({ limit: 25 }),
      fetchEvents({ limit: 25 }),
      fetchCards({ limit: 25 }),
      fetchProjection(),
    ]);
    done = results.filter((r) => r.status === 'fulfilled').length;
    store.prefetch = Object.fromEntries(names.map((n, i) => [n, results[i].status === 'fulfilled' ? results[i].value : null]));
    const failed = names.filter((n, i) => results[i].status === 'rejected');
    if (done === 0) {
      throw new Error('五个列表全部预取失败：' + failed.join(', '));
    }
    return failed.length ? `${done}/5 成功（未就绪：${failed.join('、')}）` : '5/5 成功';
  }).catch((err) => {
    if (err instanceof SilentBootAbort) throw err;
    overlay.showError('预取观测数据失败', (err && err.message) || '全部列表不可用，请检查内核状态。');
    throw new SilentBootAbort();
  });

  // ---- 过渡到主控制台 ----
  // 视频已在进入启动序列前收层，这里只需等外观落定，再淡出启动卡片、放出主控台。
  booted = true;
  await appearanceReady;
  await overlay.finish();

  document.getElementById('app').hidden = false;
  initDrawer();
  initShell();
  renderNav(VIEWS, currentRouteId());
  startRouter(document.getElementById('main'));
  startPulse();
  startTicker();
}

class SilentBootAbort extends Error { constructor() { super('boot-aborted'); } }

function applyStatus(s) {
  store.status = s;
  if (typeof s.bootId === 'string') store.bootId = s.bootId;
  if (typeof s.startedAt === 'number') store.startedAt = s.startedAt;
  if (typeof s.channel === 'string' && s.channel) store.channel = s.channel;
  if (s.memory !== undefined) store.memory = s.memory ?? null;
  emit('status', s);
  emit('memory', store.memory);
}

function currentRouteId() {
  const h = location.hash.replace(/^#\/?/, '');
  return h.split('?')[0] || 'overview';
}

/* ================= 心跳：相对时间与运行时长自动刷新 ================= */

function startTicker() {
  setInterval(() => {
    document.querySelectorAll('[data-ts]').forEach((n) => {
      const ts = Number(n.dataset.ts);
      if (Number.isFinite(ts)) n.textContent = fmtRel(ts);
    });
    updateUptime();
    emit('tick', Date.now());
  }, 1000);
}

/* ================= 会话期 401 → 恢复覆盖层 ================= */

on('auth-lost', () => {
  if (!booted) return;
  stopPulse();
  showReconnectOverlay();
});

/* ================= 启动 ================= */

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot());
  } else {
    boot();
  }
}
