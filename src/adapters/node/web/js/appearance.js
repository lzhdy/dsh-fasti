// appearance.js —— 壁纸与外观参数的应用层（#240）
//
// 纯展示：把 /ui/state 里的参数翻译成 CSS（背景图 + filter + 遮罩）。
// 参数只落在挂件私有目录（settings.json），与记忆内核、与浏览器存储都无关。

import { fetchUiState, putUiSettings } from './api.js';

let state = null;
const listeners = new Set();
let saveTimer = 0;
let pendingPatch = null;

export function getUiState() {
  return state;
}

/** 订阅外观变化：cb(state, error?)。返回退订函数。 */
export function onAppearance(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(error) {
  for (const cb of listeners) cb(state, error);
}

/** 合并两层补丁（wallpaper/splash 各一层），避免连续拖动丢掉中间值。 */
function mergePatch(base, patch) {
  const out = { ...(base || {}) };
  for (const [group, values] of Object.entries(patch)) {
    out[group] = { ...(out[group] || {}), ...values };
  }
  return out;
}

/** 把参数落到 DOM 上（无壁纸时保持主题底色，一切皆可关）。 */
export function applyAppearance() {
  const layer = document.getElementById('wallpaper-layer');
  const scrim = document.getElementById('wallpaper-scrim');
  if (!layer || !scrim) return;
  const w = state?.settings?.wallpaper;
  if (!w || !w.enabled || !w.active) {
    layer.style.backgroundImage = 'none';
    layer.style.filter = 'none';
    layer.style.transform = 'none';
    scrim.style.opacity = '0';
    document.body.classList.remove('has-wallpaper');
    return;
  }
  const size = w.fit === 'stretch' ? '100% 100%' : w.fit === 'contain' ? 'contain' : 'cover';
  layer.style.backgroundImage = `url("/ui/media/w/${encodeURIComponent(w.active)}")`;
  layer.style.backgroundSize = size;
  layer.style.backgroundPosition = `calc(50% + ${w.offsetX}%) calc(50% + ${w.offsetY}%)`;
  layer.style.transform = `scale(${w.zoom / 100})`;
  layer.style.filter =
    `brightness(${w.brightness}%) contrast(${w.contrast}%) saturate(${w.saturation}%) `
    + `hue-rotate(${w.hue}deg) blur(${w.blur}px) grayscale(${w.grayscale}%)`;
  scrim.style.backgroundColor = w.scrimColor;
  scrim.style.opacity = String(w.scrim / 100);
  document.body.classList.add('has-wallpaper');
}

/** 首次装载：取一次挂件状态并应用；失败不影响控制台（外观只是装饰）。 */
export async function loadAppearance() {
  try {
    state = await fetchUiState();
  } catch {
    state = null;
  }
  applyAppearance();
  notify();
  return state;
}

/**
 * 本地乐观更新 + 250ms 防抖落盘。
 * PUT 回来后用服务端归一化结果覆盖本地（clamp 生效，前端滑块跟着回正）。
 */
export function updateAppearance(patch, { persist = true } = {}) {
  if (!state) return;
  state = {
    ...state,
    settings: {
      ...state.settings,
      wallpaper: { ...state.settings.wallpaper, ...(patch.wallpaper || {}) },
      splash: { ...state.settings.splash, ...(patch.splash || {}) },
    },
  };
  applyAppearance();
  notify();
  if (!persist) return;
  pendingPatch = mergePatch(pendingPatch, patch);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, 250);
}

async function flush() {
  const patch = pendingPatch;
  pendingPatch = null;
  if (!patch) return;
  try {
    state = await putUiSettings(patch);
    applyAppearance();
    notify();
  } catch (err) {
    notify(err);
  }
}

/** 外部拿到完整状态（上传/删除后服务端回包）直接覆盖。 */
export function setUiState(next) {
  state = next;
  applyAppearance();
  notify();
}
