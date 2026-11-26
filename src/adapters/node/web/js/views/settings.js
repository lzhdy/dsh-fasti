// views/settings.js —— 外观设置（#240）：启动视频两槽位 + 壁纸 + 参数
//
// 纪律：本面板只写挂件私有目录（~/.dsh/fasti-ui），不触碰记忆内核与数据根；
// 不使用 localStorage/sessionStorage/cookie，全部状态来自 /ui/state 与内存。

import { el, icon } from '../dom.js';
import { viewHead } from './common.js';
import {
  fetchUiState, uploadSplash, deleteSplashSlot, uploadWallpaper, deleteWallpaperFile,
} from '../api.js';
import { getUiState, onAppearance, updateAppearance, setUiState } from '../appearance.js';
import { playSplash } from '../splash.js';

/** 滑块清单：全部有界、全部即时生效。 */
const SLIDERS = [
  { key: 'offsetX', label: '水平位置', min: -50, max: 50, unit: '%' },
  { key: 'offsetY', label: '垂直位置', min: -50, max: 50, unit: '%' },
  { key: 'zoom', label: '缩放', min: 100, max: 250, unit: '%' },
  { key: 'brightness', label: '亮度', min: 40, max: 160, unit: '%' },
  { key: 'contrast', label: '对比度', min: 40, max: 160, unit: '%' },
  { key: 'saturation', label: '饱和度', min: 0, max: 200, unit: '%' },
  { key: 'hue', label: '色相偏移', min: -180, max: 180, unit: '°' },
  { key: 'blur', label: '模糊', min: 0, max: 24, unit: 'px' },
  { key: 'grayscale', label: '灰度', min: 0, max: 100, unit: '%' },
  { key: 'scrim', label: '暗色遮罩', min: 0, max: 90, unit: '%' },
];

let unsub = null;
let refreshToken = 0;
const busy = new Set();

export default {
  id: 'settings',
  title: '外观设置',
  icon: 'gauge',

  mount(root) {
    const uiToken = ++refreshToken;
    const status = el('div', { class: 'ui-status', hidden: true });
    const body = el('div', { class: 'ui-body' });

    root.append(
      viewHead(
        '外观设置',
        '启动视频与壁纸都是本地挂件文件：只写挂件私有目录（~/.dsh/fasti-ui），不进 git、不进记忆内核，也不使用任何浏览器存储。换了机器，把文件下载到本地再上传即可。',
      ),
      status,
      body,
    );

    const notice = (text, kind = 'ok') => {
      status.hidden = false;
      status.className = `ui-status ${kind}`;
      status.textContent = text;
      window.setTimeout(() => { status.hidden = true; }, 2600);
    };

    const render = () => {
      if (refreshToken !== uiToken) return;
      const state = getUiState();
      while (body.firstChild) body.removeChild(body.firstChild);
      if (!state) {
        body.append(el('div', { class: 'empty-hint' }, icon('warn'), '外观状态未就绪：请确认内核服务正常后刷新页面。'));
        return;
      }
      body.append(
        splashSection(state, notice),
        wallpaperSection(state, notice),
        paramsSection(state),
      );
    };

    render();
    unsub = onAppearance((state, error) => {
      if (error) notice(`保存失败：${error.message || '未知错误'}`, 'err');
      else render();
    });
    if (!getUiState()) {
      void fetchUiState().then((state) => { setUiState(state); }).catch(() => {});
    }
  },

  unmount() {
    refreshToken++;
    if (unsub) { unsub(); unsub = null; }
  },
};

/* ---------------- 启动视频 ---------------- */

function splashSection(state, notice) {
  const files = state.splashFiles || {};
  const s = state.settings.splash;
  const rows = [
    ['full', '首次启动', '内核进程启动后的第一屏（大的那支）'],
    ['mini', '刷新 / 再开', '同进程内刷新或新开标签（小的那支）'],
  ];
  return el('section', { class: 'ui-card' },
    el('div', { class: 'ui-card-head' },
      el('h2', { text: '启动视频' }),
      el('span', { class: 'ui-hint', text: '仓库不含视频文件；上传后即落本地挂件目录' }),
    ),
    el('div', { class: 'ui-grid2' }, rows.map(([slot, title, desc]) => {
      const name = files[slot];
      const input = el('input', { type: 'file', accept: 'video/mp4,video/webm' });
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const key = `splash-${slot}`;
        if (busy.has(key)) return;
        busy.add(key);
        try {
          const next = await uploadSplash(slot, file);
          setUiState(next);
          notice(`${title}视频已更新：${file.name}`);
        } catch (err) {
          notice(`上传失败：${err.message || '未知错误'}`, 'err');
        } finally {
          busy.delete(key);
          input.value = '';
        }
      });
      const clearBtn = el('button', {
        class: 'btn', type: 'button', text: '清除',
        disabled: name ? null : '',
        onclick: async () => {
          const key = `splash-${slot}`;
          if (busy.has(key) || !name) return;
          busy.add(key);
          try {
            const next = await deleteSplashSlot(slot);
            setUiState(next);
            notice(`${title}视频已清除`);
          } catch (err) {
            notice(`清除失败：${err.message || '未知错误'}`, 'err');
          } finally {
            busy.delete(key);
          }
        },
      });
      const previewBtn = el('button', {
        class: 'btn', type: 'button', text: '试播',
        disabled: name ? null : '',
        onclick: () => { if (name) void playSplash(name, s.sound); },
      });
      return el('div', { class: 'ui-slot' },
        el('div', { class: 'ui-slot-title' }, icon('layers'), title),
        el('div', { class: 'ui-slot-desc', text: desc }),
        el('div', { class: 'ui-slot-file', text: name || '未上传（此槽位不播放）' }),
        el('div', { class: 'ui-actions' },
          el('label', { class: 'btn primary upload-btn' }, name ? '替换' : '上传', input),
          previewBtn,
          clearBtn,
        ),
      );
    })),
    el('div', { class: 'ui-switch-row' },
      switchBox('首次启动播放', s.full, (v) => updateAppearance({ splash: { full: v } }), state, notice),
      switchBox('刷新时播放', s.mini, (v) => updateAppearance({ splash: { mini: v } }), state, notice),
      switchBox('优先带声音', s.sound, (v) => updateAppearance({ splash: { sound: v } }), state, notice),
    ),
    el('div', { class: 'ui-note' },
      '浏览器规定：没有用户手势时带声音的自动播放可能被拦下，届时自动静音继续播、不弹任何提示；同一个地址开得越多，浏览器越会放行有声播放。播放中按 Esc 或空格可跳过。',
    ),
  );
}

function switchBox(label, checked, onChange, state, notice) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => {
    try {
      onChange(input.checked);
    } catch (err) {
      notice(`保存失败：${err.message || '未知错误'}`, 'err');
    }
  });
  return el('label', { class: 'ui-switch' }, input, el('span', { text: label }));
}

/* ---------------- 壁纸 ---------------- */

function wallpaperSection(state, notice) {
  const w = state.settings.wallpaper;
  const list = Array.isArray(state.wallpapers) ? state.wallpapers : [];
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (busy.has('wallpaper')) return;
    busy.add('wallpaper');
    try {
      const next = await uploadWallpaper(file);
      setUiState(next);
      notice(`壁纸已上传：${file.name}`);
    } catch (err) {
      notice(`上传失败：${err.message || '未知错误'}`, 'err');
    } finally {
      busy.delete('wallpaper');
      input.value = '';
    }
  });

  const cards = list.length === 0
    ? [el('div', { class: 'empty-hint' }, icon('inbox'), '还没有壁纸。上传一张 png/jpg/webp 即可。')]
    : list.map((name) => {
      const isActive = w.active === name;
      return el('div', { class: `wall-card${isActive ? ' active' : ''}` },
        el('img', { class: 'wall-thumb', src: `/ui/media/w/${encodeURIComponent(name)}`, alt: name, loading: 'lazy' }),
        el('div', { class: 'wall-name', text: name }),
        el('div', { class: 'ui-actions' },
          el('button', {
            class: 'btn primary', type: 'button', text: isActive ? '已选中' : '选中',
            disabled: isActive ? '' : null,
            onclick: () => { updateAppearance({ wallpaper: { active: name, enabled: true } }); notice('壁纸已切换'); },
          }),
          el('button', {
            class: 'btn', type: 'button', text: '删除',
            onclick: async () => {
              try {
                const next = await deleteWallpaperFile(name);
                setUiState(next);
                notice('壁纸已删除');
              } catch (err) {
                notice(`删除失败：${err.message || '未知错误'}`, 'err');
              }
            },
          }),
        ),
      );
    });

  return el('section', { class: 'ui-card' },
    el('div', { class: 'ui-card-head' },
      el('h2', { text: '壁纸' }),
      el('span', { class: 'ui-hint', text: `共 ${list.length} 张 · 原图不压缩、本地直读` }),
    ),
    el('div', { class: 'ui-switch-row' },
      switchBox('启用壁纸', w.enabled, (v) => updateAppearance({ wallpaper: { enabled: v } }), state, notice),
      el('label', { class: 'btn primary upload-btn' }, '上传壁纸', input),
    ),
    el('div', { class: 'wall-grid' }, cards),
  );
}

/* ---------------- 参数 ---------------- */

function paramsSection(state) {
  const w = state.settings.wallpaper;

  const select = el('select', { class: 'ui-select' },
    [['cover', '填满裁切'], ['contain', '完整留边'], ['stretch', '拉伸铺满']].map(([value, text]) =>
      el('option', { value, text, selected: w.fit === value ? '' : null })),
  );
  select.addEventListener('change', () => updateAppearance({ wallpaper: { fit: select.value } }));

  const color = el('input', { type: 'color', class: 'ui-color', value: w.scrimColor });
  color.addEventListener('input', () => updateAppearance({ wallpaper: { scrimColor: color.value } }));

  const rows = SLIDERS.map((cfg) => {
    const value = Number(w[cfg.key]);
    const valueEl = el('span', { class: 'ui-slider-value', text: `${value}${cfg.unit}` });
    const input = el('input', {
      class: 'ui-slider', type: 'range',
      min: String(cfg.min), max: String(cfg.max), step: '1', value: String(value),
      'aria-label': cfg.label,
    });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      valueEl.textContent = `${v}${cfg.unit}`;
      updateAppearance({ wallpaper: { [cfg.key]: v } });
    });
    return el('div', { class: 'ui-row' },
      el('span', { class: 'ui-row-label', text: cfg.label }),
      input,
      valueEl,
    );
  });

  return el('section', { class: 'ui-card' },
    el('div', { class: 'ui-card-head' },
      el('h2', { text: '壁纸参数' }),
      el('span', { class: 'ui-hint', text: '全部即时生效；拖动结束自动落盘' }),
    ),
    el('div', { class: 'ui-row' },
      el('span', { class: 'ui-row-label', text: '填充模式' }),
      select,
      el('span', { class: 'ui-slider-value', text: '构图' }),
    ),
    rows,
    el('div', { class: 'ui-row' },
      el('span', { class: 'ui-row-label', text: '遮罩颜色' }),
      color,
      el('span', { class: 'ui-slider-value', text: '可读性' }),
    ),
  );
}
