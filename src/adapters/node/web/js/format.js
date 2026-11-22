// format.js —— 时间 / 数字 / 文本格式化（全部本地化，无 Intl 依赖外的运行时开销）

const p2 = (n) => String(n).padStart(2, '0');
const p3 = (n) => String(n).padStart(3, '0');

function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string') {
    // ISO-8601（UTC）或空串
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** 本地时间 YYYY-MM-DD HH:mm:ss(.mmm) */
export function fmtTime(v, { ms = false } = {}) {
  const d = toDate(v);
  if (!d) return null;
  const base = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return ms ? `${base}.${p3(d.getMilliseconds())}` : base;
}

/** 紧凑时间（活动流用）HH:mm:ss.mmm */
export function fmtClock(v) {
  const d = toDate(v);
  if (!d) return null;
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** 相对时间，用于 data-ts 自动刷新元素 */
export function fmtRel(v, now = Date.now()) {
  const t = toDate(v);
  if (!t) return '—';
  const diff = now - t.getTime();
  if (diff < 0) return '刚刚';
  if (diff < 10_000) return '刚刚';
  if (diff < MIN) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  return `${Math.floor(diff / DAY)} 天前`;
}

/** 运行时长 hh:mm:ss */
export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`;
}

export function fmtNum(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('zh-CN');
}

/** 截断长文本 */
export function truncate(s, n = 120) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/** 任意值为可展示字符串（对象折叠为 JSON，绝不输出 [object Object]） */
export function safeStr(v, { jsonStyle = 'compact' } = {}) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v, null, jsonStyle === 'compact' ? 0 : 2);
  } catch {
    return String(v);
  }
}

/** 事件状态 → 中文标签（未知值兜底原样展示） */
export const EVENT_STATUS_LABEL = {
  open: '开放中', closed: '已闭合', merged: '已合并', split: '已拆分', archived: '已归档',
};

/** 卡片状态 → 中文标签 */
export const CARD_STATUS_LABEL = {
  active: '生效', invalid: '失效', superseded: '被取代',
};

/** 别名状态 */
export const ALIAS_STATUS_LABEL = {
  active: '活跃', tombstoned: '墓碑',
};

/** 摘要质量档 */
export const SUMMARY_QUALITY_LABEL = {
  pending: '待摘要',
};
