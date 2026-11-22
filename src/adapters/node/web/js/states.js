// states.js —— 统一的三态（加载 / 错误 / 空）渲染

import { el, icon } from './dom.js';
import { fmtRel } from './format.js';

export function loadingState(label = '加载中…', { compact = false } = {}) {
  return el('div', { class: 'state' + (compact ? ' compact' : '') },
    el('span', { class: 'spinner' + (compact ? '' : ' big') }),
    el('span', { class: 'state-desc', text: label }),
  );
}

export function errorState(err, { onRetry, compact = false, title } = {}) {
  const t = title || errTitle(err);
  const desc = errDesc(err);
  const box = el('div', { class: 'state error' + (compact ? ' compact' : '') },
    el('span', { class: 'state-icon' }, icon('err')),
    el('span', { class: 'state-title', text: t }),
    el('span', { class: 'state-desc', text: desc }),
  );
  if (onRetry) {
    const btn = el('button', { class: 'btn', type: 'button' }, icon('refresh'), '重试');
    btn.addEventListener('click', () => onRetry());
    box.append(btn);
  }
  return box;
}

export function emptyState(title = '暂无数据', desc = '', { compact = false, iconName = 'inbox' } = {}) {
  return el('div', { class: 'state' + (compact ? ' compact' : '') },
    el('span', { class: 'state-icon' }, icon(iconName)),
    el('span', { class: 'state-title', text: title }),
    desc ? el('span', { class: 'state-desc', text: desc }) : null,
  );
}

/** 记忆索引未就绪（503）专用空态——绝不用“空列表”冒充 */
export function memoryUnavailableState({ compact = false } = {}) {
  return el('div', { class: 'state warn-state' + (compact ? ' compact' : '') },
    el('span', { class: 'state-icon' }, icon('warn')),
    el('span', { class: 'state-title', text: '记忆索引未就绪' }),
    el('span', { class: 'state-desc' },
      '记忆卡片观测暂不可用（后端返回 503 memory-unavailable）：内核的记忆索引尚未建好。',
      el('br'), '这不是“没有卡片”——待索引就绪后本视图会自动恢复，无需手动刷新。',
    ),
  );
}

export function errTitle(err) {
  if (!err) return '出错了';
  if (err.network) return '网络不可达';
  if (err.authFailed) return '鉴权失败（401）';
  if (err.memoryUnavailable) return '记忆索引未就绪（503）';
  if (err.notFound) return '记录不存在（404）';
  if (err.status === 400) return '请求参数被拒绝（400）';
  if (err.status === 403) return '来源被拒绝（403）';
  return `请求失败（HTTP ${err.status || '?'})`;
}

export function errDesc(err) {
  if (!err) return '';
  const msg = err.message || '';
  if (err.network) return '无法连接内核服务，可能进程已退出。长轮询正在自动重试，也可手动重试。';
  if (err.authFailed) return '访问令牌缺失或已失效（令牌随内核进程一次性生成，重启即失效）。';
  if (err.notFound) return '目标 id 不存在：可能已被折叠归档，或来自已重启的旧实例。';
  return msg || '请稍后重试。';
}

/** 相对时间自动刷新标记 */
export function relSpan(ts, { prefix = '' } = {}) {
  if (!Number.isFinite(ts)) return document.createTextNode('—');
  const s = el('span', { class: 'fe-rel', dataset: { ts: String(ts) }, text: prefix + fmtRel(ts) });
  return s;
}
