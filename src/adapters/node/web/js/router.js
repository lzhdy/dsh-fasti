// router.js —— hash 路由：#/overview #/raw #/experiences #/events #/cards #/projection #/settings
// 支持跨视图携带 focus（如「经历 → 原文」跳转定位），并集中管理抽屉关闭。

import { closeDrawer } from './drawer.js';
import { setActiveNav } from './shell.js';

import viewOverview from './views/overview.js';
import viewRaw from './views/raw.js';
import viewExperiences from './views/experiences.js';
import viewEvents from './views/events.js';
import viewCards from './views/cards.js';
import viewProjection from './views/projection.js';
import viewSettings from './views/settings.js';

/** 视图注册表（顺序即导航顺序） */
export const VIEWS = [viewOverview, viewRaw, viewExperiences, viewEvents, viewCards, viewProjection, viewSettings];

const ROUTES = Object.fromEntries(VIEWS.map((v) => [v.id, v]));

let mainEl = null;
let current = null;
let pendingFocus = null;

export function startRouter(main) {
  mainEl = main;
  window.addEventListener('hashchange', handle);
  handle();
}

/** 编程式导航；focus 由目标视图的 applyFocus 消费 */
export function navigate(id, focus) {
  if (focus) pendingFocus = focus;
  const target = '#/' + id;
  if (location.hash === target) handle();
  else location.hash = target;
}

function currentId() {
  const h = location.hash.replace(/^#\/?/, '');
  return h.split('?')[0] || 'overview';
}

function handle() {
  if (!mainEl) return;
  const id = currentId();
  const view = ROUTES[id] || ROUTES.overview;
  const focus = pendingFocus;
  pendingFocus = null;

  if (current === view) {
    closeDrawer();
    if (focus && view.applyFocus) view.applyFocus(focus);
    setActiveNav(view.id);
    return;
  }

  closeDrawer();
  if (current?.unmount) current.unmount();
  current = view;
  while (mainEl.firstChild) mainEl.removeChild(mainEl.firstChild);
  setActiveNav(view.id);
  view.mount(mainEl, focus);
}
