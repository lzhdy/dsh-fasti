// api.js —— 唯一的 API 客户端：注入 Bearer、同源相对路径、集中错误分类

let TOKEN = '';

export class ApiError extends Error {
  /**
   * @param {number} status 0 表示网络层失败
   * @param {object|null} body 服务端 JSON（可能为 null）
   */
  constructor(status, body) {
    const e = (body && typeof body === 'object' && body.error) || {};
    super(e.message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof e.code === 'string' ? e.code : '';
    this.body = body;
    this.network = status === 0;
    this.memoryUnavailable = status === 503 && e.code === 'memory-unavailable';
    this.notFound = status === 404;
    this.authFailed = status === 401;
  }
}

export function initApi(token) {
  TOKEN = String(token || '');
}

function qs(params) {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    out.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return out.length ? `?${out.join('&')}` : '';
}

async function request(path, signal) {
  let res;
  try {
    res = await fetch(path, {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, { error: { code: 'network', message: '网络错误或服务不可达' } });
  }
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { /* 非 JSON 错误体 */ }
    throw new ApiError(res.status, body);
  }
  try { return await res.json(); } catch (err) {
    throw new ApiError(res.status, { error: { code: 'bad-json', message: '响应不是合法 JSON' } });
  }
}

/** /health 存活探针：免 token */
export async function pingHealth(signal) {
  try {
    const r = await fetch('/health', { cache: 'no-store', signal });
    return r.ok;
  } catch {
    return false;
  }
}

/* ---------- 业务端点（全部 GET、同源、Bearer） ---------- */

export const fetchStatus   = (signal) => request('/api/status', signal);
export const fetchRaw      = ({ limit, offset, channel } = {}, signal) => request(`/api/raw${qs({ limit, offset, channel })}`, signal);
export const fetchExperiences = ({ limit, offset, channel } = {}, signal) => request(`/api/experiences${qs({ limit, offset, channel })}`, signal);
export const fetchExperience  = (id, signal) => request(`/api/experiences/${encodeURIComponent(id)}`, signal);
export const fetchEvents   = ({ limit, offset } = {}, signal) => request(`/api/events${qs({ limit, offset })}`, signal);
export const fetchEvent    = (id, signal) => request(`/api/events/${encodeURIComponent(id)}`, signal);
export const fetchCards    = ({ limit, offset } = {}, signal) => request(`/api/cards${qs({ limit, offset })}`, signal);
export const fetchCard     = (id, signal) => request(`/api/cards/${encodeURIComponent(id)}`, signal);
export const fetchProjection = (signal) => request('/api/projection', signal);
export const fetchPulse    = (after, signal) => request(`/api/pulse?after=${encodeURIComponent(String(after))}`, signal);

/* ---------- 挂件私有面（/ui/*；只动外观设置，不碰内核，皆 Bearer） ---------- */

/** 带请求体的同源写请求：JSON patch 传对象、上传传 File/Blob。 */
async function send(method, path, body) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  let payload;
  if (body instanceof Blob) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, cache: 'no-store' });
  } catch {
    throw new ApiError(0, { error: { code: 'network', message: '网络错误或服务不可达' } });
  }
  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch { /* 非 JSON 错误体 */ }
    throw new ApiError(res.status, errBody);
  }
  try { return await res.json(); } catch {
    throw new ApiError(res.status, { error: { code: 'bad-json', message: '响应不是合法 JSON' } });
  }
}

export const fetchUiState       = () => request('/ui/state');
export const putUiSettings      = (patch) => send('PUT', '/ui/state', patch);
export const uploadSplash       = (slot, file) => send('POST', `/ui/splash/${encodeURIComponent(slot)}`, file);
export const deleteSplashSlot   = (slot) => send('DELETE', `/ui/splash/${encodeURIComponent(slot)}`);
export const uploadWallpaper    = (file) => send('POST', '/ui/wallpaper', file);
export const deleteWallpaperFile = (name) => send('DELETE', `/ui/wallpaper/${encodeURIComponent(name)}`);
