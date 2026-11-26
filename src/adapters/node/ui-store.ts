/**
 * 挂件私有状态目录（网页观测台「外观设置」，#240）。
 *
 * 定位：网页端只是挂件。启动视频、壁纸、外观参数全是**挂件自己的装饰**，
 * 与记忆内核无关，因此落在仓库外、内核数据根之外的独立目录（默认
 * `~/.dsh/fasti-ui/`，与 `~/.dsh/fasti` 平级、不嵌套）。
 *
 * 三条纪律：
 *  1. 只读写本目录：任何路径解析都先经 `safeResolve` 圈定，绝不触达真源与投影；
 *  2. 只认白名单后缀：视频 mp4/webm，图片 png/jpg/jpeg/webp；其余一律拒绝；
 *  3. 写入原子化：设置文件先写临时名再 rename，断电不会留下半截 JSON。
 *
 * 依赖纪律：全部 node: 内置，零第三方依赖（与 http-server.ts 同一套架构门）。
 */

import { readFile, readdir, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** 视频后缀白名单（浏览器原生可播的两族）。 */
export const VIDEO_EXTS = ['.mp4', '.webm'] as const;

/** 图片后缀白名单。 */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

/** 启动视频槽位：full＝进程启动后首次开页，mini＝同进程刷新/再开。 */
export const SPLASH_SLOTS = ['full', 'mini'] as const;
export type SplashSlot = (typeof SPLASH_SLOTS)[number];

export type WallpaperFit = 'cover' | 'contain' | 'stretch';

/** 壁纸参数（全部有界、全部可关）。 */
export interface WallpaperSettings {
  readonly enabled: boolean;
  /** 选中的壁纸文件名；null＝不铺壁纸，回到主题底色。 */
  readonly active: string | null;
  readonly fit: WallpaperFit;
  /** 水平偏移，百分比 -50..50。 */
  readonly offsetX: number;
  /** 垂直偏移，百分比 -50..50。 */
  readonly offsetY: number;
  /** 缩放，百分比 100..250。 */
  readonly zoom: number;
  /** 亮度，百分比 40..160。 */
  readonly brightness: number;
  /** 对比度，百分比 40..160。 */
  readonly contrast: number;
  /** 饱和度，百分比 0..200。 */
  readonly saturation: number;
  /** 色相偏移，度 -180..180。 */
  readonly hue: number;
  /** 模糊，像素 0..24。 */
  readonly blur: number;
  /** 灰度，百分比 0..100。 */
  readonly grayscale: number;
  /** 可读性遮罩不透明度，百分比 0..90。 */
  readonly scrim: number;
  /** 遮罩颜色，仅 #rrggbb。 */
  readonly scrimColor: string;
}

/** 启动视频设置。 */
export interface SplashSettings {
  /** 首次启动（进程启动后第一屏）是否播放。 */
  readonly full: boolean;
  /** 同进程刷新/新开标签是否播放。 */
  readonly mini: boolean;
  /** 是否先尝试带声音播放（被浏览器拦则自动转静音并给「开启声音」）。 */
  readonly sound: boolean;
}

/** 全部挂件设置。 */
export interface UiSettings {
  readonly wallpaper: WallpaperSettings;
  readonly splash: SplashSettings;
}

/** 对前端可见的完整状态（设置 + 文件实况）。 */
export interface UiStatePayload {
  readonly settings: UiSettings;
  readonly splashFiles: { readonly full: string | null; readonly mini: string | null };
  readonly wallpapers: readonly string[];
}

/** 默认值：壁纸未选中、参数中性；启动视频两槽位默认都开、默认先试声音。 */
export const DEFAULT_SETTINGS: UiSettings = Object.freeze({
  wallpaper: Object.freeze({
    enabled: true,
    active: null,
    fit: 'cover',
    offsetX: 0,
    offsetY: 0,
    zoom: 100,
    brightness: 100,
    contrast: 100,
    saturation: 100,
    hue: 0,
    blur: 0,
    grayscale: 0,
    scrim: 55,
    scrimColor: '#05070d',
  }),
  splash: Object.freeze({ full: true, mini: true, sound: true }),
});

/** 挂件目录默认根：仓库外、内核数据根之外，与 ~/.dsh/fasti 平级。 */
export function defaultUiRoot(): string {
  return path.join(os.homedir(), '.dsh', 'fasti-ui');
}

/** 媒体子目录。 */
export const MEDIA_DIR = 'media';
/** 壁纸子目录。 */
export const WALLPAPER_DIR = 'wallpapers';
/** 设置文件名。 */
export const SETTINGS_FILE = 'settings.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickFit(value: unknown, fallback: WallpaperFit): WallpaperFit {
  return value === 'cover' || value === 'contain' || value === 'stretch' ? value : fallback;
}

function pickColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : fallback;
}

function pickActive(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || !isSafeName(value)) {
    return null;
  }
  return hasExt(value, IMAGE_EXTS) ? value : null;
}

/** 文件名只允许字母数字点横线下划线：拦住所有分隔符与穿越形态。 */
export function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) && !name.includes('..');
}

function hasExt(name: string, exts: readonly string[]): boolean {
  const ext = path.extname(name).toLowerCase();
  return exts.includes(ext);
}

/**
 * 归一化任意输入为合法设置：逐字段 clamp、未知字段丢弃、坏值回默认。
 * 不抛错——前端传什么都只会得到一份可用设置。
 */
export function normalizeSettings(raw: unknown): UiSettings {
  const base = DEFAULT_SETTINGS;
  if (!isRecord(raw)) {
    return base;
  }
  const wallRaw = isRecord(raw['wallpaper']) ? raw['wallpaper'] : {};
  const splashRaw = isRecord(raw['splash']) ? raw['splash'] : {};

  const wallpaper: WallpaperSettings = {
    enabled: pickBool(wallRaw['enabled'], base.wallpaper.enabled),
    active: pickActive(wallRaw['active']),
    fit: pickFit(wallRaw['fit'], base.wallpaper.fit),
    offsetX: clampInt(wallRaw['offsetX'], -50, 50, base.wallpaper.offsetX),
    offsetY: clampInt(wallRaw['offsetY'], -50, 50, base.wallpaper.offsetY),
    zoom: clampInt(wallRaw['zoom'], 100, 250, base.wallpaper.zoom),
    brightness: clampInt(wallRaw['brightness'], 40, 160, base.wallpaper.brightness),
    contrast: clampInt(wallRaw['contrast'], 40, 160, base.wallpaper.contrast),
    saturation: clampInt(wallRaw['saturation'], 0, 200, base.wallpaper.saturation),
    hue: clampInt(wallRaw['hue'], -180, 180, base.wallpaper.hue),
    blur: clampInt(wallRaw['blur'], 0, 24, base.wallpaper.blur),
    grayscale: clampInt(wallRaw['grayscale'], 0, 100, base.wallpaper.grayscale),
    scrim: clampInt(wallRaw['scrim'], 0, 90, base.wallpaper.scrim),
    scrimColor: pickColor(wallRaw['scrimColor'], base.wallpaper.scrimColor),
  };
  const splash: SplashSettings = {
    full: pickBool(splashRaw['full'], base.splash.full),
    mini: pickBool(splashRaw['mini'], base.splash.mini),
    sound: pickBool(splashRaw['sound'], base.splash.sound),
  };
  return { wallpaper, splash };
}

/** 建齐目录（幂等）。 */
export async function ensureUiDirs(root: string): Promise<void> {
  await mkdir(path.join(root, MEDIA_DIR), { recursive: true });
  await mkdir(path.join(root, WALLPAPER_DIR), { recursive: true });
}

/** 读设置：文件缺失/损坏一律回默认，绝不因外观配置炸挂件。 */
export async function readSettings(root: string): Promise<UiSettings> {
  try {
    const text = await readFile(path.join(root, SETTINGS_FILE), 'utf8');
    return normalizeSettings(JSON.parse(text));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** 写设置（先临时名再 rename，保证原子性）；返回落地后的完整设置。 */
export async function writeSettings(root: string, patch: unknown): Promise<UiSettings> {
  await ensureUiDirs(root);
  const current = await readSettings(root);
  const merged = {
    wallpaper: { ...current.wallpaper, ...(isRecord(patch) && isRecord(patch['wallpaper']) ? patch['wallpaper'] : {}) },
    splash: { ...current.splash, ...(isRecord(patch) && isRecord(patch['splash']) ? patch['splash'] : {}) },
  };
  const next = normalizeSettings(merged);
  const target = path.join(root, SETTINGS_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  return next;
}

/** 列出壁纸文件名（只回白名单后缀、按名升序）。 */
export async function listWallpapers(root: string): Promise<string[]> {
  try {
    const names = await readdir(path.join(root, WALLPAPER_DIR));
    return names.filter((name) => isSafeName(name) && hasExt(name, IMAGE_EXTS)).sort();
  } catch {
    return [];
  }
}

/** 找某个槽位的启动视频文件名；没有则 null。 */
export async function splashFile(root: string, slot: SplashSlot): Promise<string | null> {
  try {
    const names = await readdir(path.join(root, MEDIA_DIR));
    const hit = names.find((name) => name === `splash-${slot}${path.extname(name).toLowerCase()}`
      && isSafeName(name) && hasExt(name, VIDEO_EXTS));
    return hit ?? null;
  } catch {
    return null;
  }
}

/** 汇总给前端的状态。 */
export async function readUiState(root: string): Promise<UiStatePayload> {
  const settings = await readSettings(root);
  return {
    settings,
    splashFiles: {
      full: await splashFile(root, 'full'),
      mini: await splashFile(root, 'mini'),
    },
    wallpapers: await listWallpapers(root),
  };
}

/**
 * 按子目录 + 文件名解析绝对路径，并强制圈定在挂件根内。
 * 任何越界、非白名单后缀、非法文件名一律返回 null（调用方回 404）。
 */
export function safeResolve(root: string, subdir: string, name: string, exts: readonly string[]): string | null {
  if (!isSafeName(name) || !hasExt(name, exts)) {
    return null;
  }
  const base = path.resolve(root, subdir);
  const resolved = path.resolve(base, name);
  return resolved.startsWith(base + path.sep) ? resolved : null;
}

/** 探测文件魔数，判定真实类型；不认识返回 null。 */
export async function sniffKind(absPath: string): Promise<{ kind: 'video' | 'image'; ext: string } | null> {
  let head: Buffer;
  try {
    const data = await readFile(absPath);
    head = data.subarray(0, 16);
  } catch {
    return null;
  }
  if (head.length < 12) {
    return null;
  }
  // MP4/MOV 家族：偏移 4 处为 'ftyp'
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') {
    return { kind: 'video', ext: '.mp4' };
  }
  // WebM/Matroska：EBML 头 1A 45 DF A3
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { kind: 'video', ext: '.webm' };
  }
  // PNG
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { kind: 'image', ext: '.png' };
  }
  // JPEG
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { kind: 'image', ext: '.jpg' };
  }
  // WebP：'RIFF' + 偏移 8 'WEBP'
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { kind: 'image', ext: '.webp' };
  }
  return null;
}

/** 上传落地结果。 */
export interface CommitResult {
  readonly kind: 'video' | 'image';
  readonly name: string;
}

/**
 * 把已收完的临时文件转正：按魔数定真实类型与后缀，再原子改名。
 * 类型与用途不匹配（如往启动视频槽位塞图片）或认不出类型 → 删临时件、抛错。
 */
export async function commitUpload(
  root: string,
  target: { kind: 'splash'; slot: SplashSlot } | { kind: 'wallpaper' },
  tmpPath: string,
): Promise<CommitResult> {
  await ensureUiDirs(root);
  const sniffed = await sniffKind(tmpPath);
  if (sniffed === null) {
    await rm(tmpPath, { force: true });
    throw new UiMediaError('unrecognized-media', '文件不是可识别的视频或图片');
  }
  if (target.kind === 'splash') {
    if (sniffed.kind !== 'video') {
      await rm(tmpPath, { force: true });
      throw new UiMediaError('media-kind-mismatch', '启动视频槽位只接受 mp4/webm 视频');
    }
    // 同槽位旧文件（另一种后缀）先清掉，保证一个槽位只有一个文件。
    await deleteSplash(root, target.slot);
    const finalName = `splash-${target.slot}${sniffed.ext}`;
    const dest = path.join(root, MEDIA_DIR, finalName);
    await rename(tmpPath, dest);
    return { kind: 'video', name: finalName };
  }
  if (sniffed.kind !== 'image') {
    await rm(tmpPath, { force: true });
    throw new UiMediaError('media-kind-mismatch', '壁纸槽位只接受 png/jpg/webp 图片');
  }
  // 壁纸名带内容哈希，避免同名互相覆盖、也便于浏览器缓存失效。
  const digest = createHash('sha256').update(await readFile(tmpPath)).digest('hex').slice(0, 12);
  const finalName = `w-${digest}${sniffed.ext}`;
  const dest = path.join(root, WALLPAPER_DIR, finalName);
  await rename(tmpPath, dest);
  return { kind: 'image', name: finalName };
}

/** 删除某个槽位的启动视频（两种后缀都清）。 */
export async function deleteSplash(root: string, slot: SplashSlot): Promise<void> {
  for (const ext of VIDEO_EXTS) {
    await rm(path.join(root, MEDIA_DIR, `splash-${slot}${ext}`), { force: true });
  }
}

/** 删除一张壁纸；名非法直接忽略（调用方另行回 404）。 */
export async function deleteWallpaper(root: string, name: string): Promise<boolean> {
  const abs = safeResolve(root, WALLPAPER_DIR, name, IMAGE_EXTS);
  if (abs === null) {
    return false;
  }
  try {
    const info = await stat(abs);
    if (!info.isFile()) {
      return false;
    }
  } catch {
    return false;
  }
  await rm(abs, { force: true });
  return true;
}

/** 挂件媒体错误：只有「文件不可用」一种语义，统一映射 400/415。 */
export class UiMediaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UiMediaError';
    this.code = code;
  }
}

/** 上传临时文件名（与目标同目录，rename 才是同盘原子操作）。 */
export function tempUploadPath(root: string, tag: string): string {
  return path.join(root, `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.upload`);
}
