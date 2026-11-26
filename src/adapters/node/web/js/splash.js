// splash.js —— 启动视频层（#240）
//
// 口径（2026-11-26 修订为「纯净播放」）：
//  · 视频阶段只呈现视频本身：不放任何按钮、文案、暗角，也不响应点击，
//    启动序列卡片在视频收层之后才构建，画面里不出现任何程序元素；
//  · 视频是本地挂件目录里的文件，走 /ui/media/*（同源、免 Bearer；<video> 带不了请求头）；
//  · 槽位由后端引导字段 `splash` 决定：进程第一屏 `full`（大的），之后一律 `mini`（小的）；
//  · 声音：优先按设置尝试有声；被浏览器自动播放策略拦下时静默转静音继续播，不弹任何提示；
//  · 退出路径：视频自然播完；Esc / 空格为无界面的键盘应急退出（屏幕上不显示任何提示）；
//  · 没有视频、加载失败、4 秒解码看门狗、45 秒硬超时——一律收层，绝不白屏、绝不卡住启动。

import { el } from './dom.js';

/** 最长占用时长（毫秒）：到点强制收层，启动序列不被视频拖死。 */
const HARD_TIMEOUT_MS = 45_000;
/** 视频最小可播时长：太短的一闪而过反而扰人，至少留 1.2s 观感。 */
const MIN_VISIBLE_MS = 1_200;

/**
 * 播一支启动视频（纯净模式：无任何可视控件）。
 * @param {string|null} file /ui/media 下的文件名；null 直接略过
 * @param {boolean} sound 是否先尝试带声音
 * @returns {Promise<'skipped'|'played'|'blocked'|'failed'>} 收层后 resolve
 */
export function playSplash(file, sound) {
  const root = document.getElementById('splash-root');
  if (!root) return Promise.resolve('failed');
  if (!file) return Promise.resolve('skipped');

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timeoutId = 0;

    const layer = el('div', { class: 'splash-layer' });
    const video = el('video', {
      class: 'splash-video',
      playsinline: '',
      preload: 'auto',
      'aria-hidden': 'true',
      src: `/ui/media/${encodeURIComponent(file)}`,
    });
    layer.append(video);
    root.append(layer);
    document.body.classList.add('splashing');

    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('splashing');
      // 至少给一眼观感，再淡出
      const remain = MIN_VISIBLE_MS - (Date.now() - startedAt);
      window.setTimeout(() => {
        layer.classList.add('closing');
        window.setTimeout(() => {
          layer.remove();
          resolve(result);
        }, 260);
      }, Math.max(0, remain));
    };

    // 无界面应急退出：不渲染任何提示，仅保留键盘通路，避免长视频无法中断。
    const onKey = (ev) => {
      if (ev.key === 'Escape' || ev.key === ' ') {
        ev.preventDefault();
        cleanup('skipped');
      }
    };
    document.addEventListener('keydown', onKey);

    video.addEventListener('ended', () => cleanup('played'));
    video.addEventListener('error', () => cleanup('failed'));

    timeoutId = window.setTimeout(() => cleanup('blocked'), HARD_TIMEOUT_MS);
    // 解码看门狗：4 秒内没有拿到任何可播数据（机型缺 H.264 解码器、文件损坏、读不到盘）
    // 就立刻收层，绝不让启动序列陪着一支放不出来的视频干等。
    const readyTimer = window.setTimeout(() => {
      if (video.readyState < 2) cleanup('failed');
    }, 4_000);
    const clearReady = () => window.clearTimeout(readyTimer);
    video.addEventListener('loadeddata', clearReady);
    video.addEventListener('playing', clearReady);

    video.muted = !sound;
    // play() 被拒（NotAllowedError）＝自动播放策略拦了有声播放：
    // 官方不允许绕过，纯净模式下静默退到静音续播，不弹按钮、不做任何提示。
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => cleanup('failed'));
    });
  });
}
