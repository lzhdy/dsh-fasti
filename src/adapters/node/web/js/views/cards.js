// views/cards.js —— 记忆卡片：503 未就绪态 / 无 total 分页 / 别名（敏感词隐藏）/ 有效期 / 命中统计

import { el } from '../dom.js';
import { fmtTime, fmtNum, CARD_STATUS_LABEL, ALIAS_STATUS_LABEL } from '../format.js';
import { fetchCards, fetchCard } from '../api.js';
import { on, store, memoryCounts } from '../bus.js';
import { Pager } from '../pager.js';
import { loadingState, errorState, emptyState, memoryUnavailableState } from '../states.js';
import { openDrawer, setDrawerBody } from '../drawer.js';
import { kvSection, kvRow, kvId, kvTime, statusChip } from '../kv.js';
import { viewHead, table, rowFlash } from './common.js';

const LIMIT = 25;
const CARD_STATUS_TONE = { active: 'ok', invalid: 'err', superseded: 'warn' };
const SELECTION_TONE = { selected: 'accent', excluded: 'dim' };

let unsubs = [];
let bodyEl, pager, offset = 0;
let unavailable = false;

export default {
  id: 'cards',
  title: '记忆卡片',
  icon: 'card',

  async mount(root, focus) {
    offset = 0;
    unavailable = false;

    root.append(viewHead('记忆卡片',
      '写入链终点：真源被折叠进卡片索引（projection / memory.drain）。敏感别名的 termNorm 后端恒为 null，界面只显示「敏感词已隐藏」。',
    ));

    const panel = el('div', { class: 'panel' });
    const { root: tbl, body } = table('card', ['卡片 id', '类型', '选择', '状态', '权重', '线索 / 别名', '创建时间']);
    bodyEl = body;
    pager = new Pager({
      limit: LIMIT,
      onChange: (o) => { offset = o; load(); },
      noTotalHint: 'cards 端点不回显 total，以满页推断下一页',
    });
    panel.append(tbl, el('div', { class: 'list-foot' },
      pager.root,
      el('span', { class: 'head-hint faint', text: '点击行查看别名、有效期与命中统计' }),
    ));
    root.append(panel);

    unsubs.push(
      on('refetch', () => load()),
      // 记忆索引从 null → 就绪时自动恢复
      on('memory', (m) => {
        if (m && unavailable) load();
        updateHeadCounts();
      }),
    );

    updateHeadCounts();
    await load();
    if (focus && focus.type === 'card') openById(focus.cardId);
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
  },

  applyFocus(f) {
    if (f && f.type === 'card') openById(f.cardId);
  },
};

function updateHeadCounts() {
  const mem = memoryCounts(store.memory);
  const head = document.querySelector('#main .view-head .view-head-row');
  if (!head) return;
  const old = head.querySelector('.mem-counts');
  if (old) old.remove();
  const wrap = el('span', { class: 'mem-counts chips-wrap' });
  if (mem) {
    wrap.append(
      el('span', { class: 'chip chip-accent', text: `卡片 ${fmtNum(mem.cards)}` }),
      el('span', { class: 'chip chip-ok', text: `生效 ${fmtNum(mem.activeCards)}` }),
      el('span', { class: 'chip chip-err', text: `失效 ${fmtNum(mem.invalidCards)}` }),
      el('span', { class: 'chip chip-warn', text: `被取代 ${fmtNum(mem.supersededCards)}` }),
      el('span', { class: 'chip', text: `别名 ${fmtNum(mem.aliases)}（敏感 ${fmtNum(mem.sensitiveAliases)}）` }),
      el('span', { class: 'chip', text: `未命中 ${fmtNum(mem.misses)}` }),
    );
  } else {
    wrap.append(el('span', { class: 'chip chip-warn', text: '记忆索引未就绪（503）' }));
  }
  head.append(wrap);
}

/* ---------------- 列表 ---------------- */

async function load() {
  setBody(loadingState('加载记忆卡片…'));
  try {
    const r = await fetchCards({ limit: LIMIT, offset });
    unavailable = false;
    const list = Array.isArray(r.cards) ? r.cards : [];
    setBody(null);
    if (!list.length) {
      bodyEl.append(emptyState('暂无卡片', '记忆索引已就绪但还没有卡片。等待 memory.drain 活动把真源折叠进索引。'));
    } else {
      for (const c of list) bodyEl.append(buildRow(c));
    }
    pager.update({ offset, loaded: list.length, total: null });
  } catch (err) {
    if (err.memoryUnavailable) {
      // 503：整体空态，绝不用“空列表”冒充
      unavailable = true;
      offset = 0;
      pager.update({ offset, loaded: 0, total: null });
      pager.root.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      setBody(memoryUnavailableState());
      return;
    }
    setBody(errorState(err, { onRetry: load }));
  }
}

function setBody(node) {
  while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
  if (node) bodyEl.append(node);
}

function buildRow(c) {
  const aliasCount = Array.isArray(c.aliases) ? c.aliases.length : 0;
  const cues = Array.isArray(c.displayCues) ? c.displayCues : [];
  const row = el('div', { class: 'trow', dataset: { key: c.cardId } },
    el('span', { class: 'tcell' }, el('span', { class: 'idchip', text: c.cardId || '—', title: c.cardId })),
    el('span', { class: 'tcell' }, statusChip(c.cardType || '未知', 'accent', { dashed: c.cardType !== 'event' })),
    el('span', { class: 'tcell' }, statusChip(c.selection === 'excluded' ? '排除' : c.selection === 'selected' ? '入选' : (c.selection || '—'), SELECTION_TONE[c.selection] || 'dim', { dashed: !SELECTION_TONE[c.selection] })),
    el('span', { class: 'tcell' }, statusChip(CARD_STATUS_LABEL[c.status] || c.status || '—', CARD_STATUS_TONE[c.status] || 'dim', { dashed: !CARD_STATUS_TONE[c.status] })),
    el('span', { class: 'tcell num', text: c.weight ?? '—' }),
    el('span', { class: 'tcell' }, el('span', { class: 'chips-wrap' },
      ...cues.slice(0, 3).map((x) => statusChip(String(x), 'dim')),
      cues.length > 3 ? statusChip(`+${cues.length - 3}`, 'dim') : null,
      statusChip(`别名 ${aliasCount}`, 'info'),
    )),
    el('span', { class: 'tcell mono', text: fmtTime(c.createdMs, { ms: true }) || '—' }),
  );
  row.addEventListener('click', () => openById(c.cardId));
  return row;
}

/* ---------------- 详情抽屉 ---------------- */

async function openById(id) {
  openDrawer('card', `卡片 · ${id}`, loadingState('加载卡片详情…', { compact: true }));
  let r;
  try {
    r = await fetchCard(id);
  } catch (err) {
    setDrawerBody(errorState(err, {
      compact: true,
      title: err.memoryUnavailable ? '记忆索引未就绪（503）' : err.notFound ? '卡片不存在（404）' : undefined,
    }));
    return;
  }
  renderDetail(r.card);
  rowFlash(bodyEl?.querySelector(`[data-key="${id}"]`));
}

function renderDetail(c) {
  const frag = document.createDocumentFragment();

  frag.append(kvSection('基本', [
    kvId('cardId', c.cardId),
    kvId('eventId', c.eventId),
    kvRow({ k: 'cardType', v: statusChip(c.cardType || '未知', 'accent', { dashed: c.cardType !== 'event' }) }),
    kvRow({ k: 'channel', v: c.channel || '—', mono: true }),
    kvRow({ k: 'selection', v: statusChip(c.selection || '—', SELECTION_TONE[c.selection] || 'dim') }),
    kvRow({ k: 'status', v: statusChip(CARD_STATUS_LABEL[c.status] || c.status || '—', CARD_STATUS_TONE[c.status] || 'dim') }),
    kvRow({ k: 'weight', v: c.weight ?? '—', mono: true }),
    kvRow({ k: 'discriminator', v: c.discriminator || null }),
    kvRow({ k: 'schemaVersion', v: fmtNum(c.schemaVersion), mono: true }),
    kvRow({ k: 'contentHash', v: el('span', { class: 'mono', style: { wordBreak: 'break-all' }, text: c.contentHash || '—' }), copy: c.contentHash }),
    kvRow({ k: 'displayCues', v: Array.isArray(c.displayCues) && c.displayCues.length
      ? el('div', { class: 'chips-wrap' }, c.displayCues.map((x) => statusChip(String(x), 'dim')))
      : null }),
  ]));

  // 别名表（敏感词原样隐藏）
  frag.append(buildAliasesSection(c.aliases));

  // 有效期
  frag.append(kvSection('有效期（毫秒 epoch）', [
    kvTime('occurredMs', c.occurredMs),
    kvTime('endedMs', c.endedMs),
    kvTime('validMs', c.validMs),
    kvTime('invalidMs', c.invalidMs),
    kvTime('createdMs', c.createdMs),
    kvTime('expiredMs', c.expiredMs),
  ]));

  // 命中统计 + 锚点
  const anchors = Array.isArray(c.anchorIds) ? c.anchorIds : [];
  frag.append(kvSection('命中与锚点', [
    kvRow({ k: 'hitCount', v: fmtNum(c.hitCount), mono: true }),
    kvTime('lastHitMs', c.lastHitMs),
    { node: el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: 'anchorIds' }), el('span', { class: 'kv-v' },
      anchors.length
        ? el('div', { class: 'chips-wrap' }, anchors.map((a) => el('span', { class: 'chip', text: a })))
        : el('span', { class: 'faint', text: '无锚点' }))) },
    { node: el('div', { class: 'kv-row' }, el('span', { class: 'kv-k' }), el('span', { class: 'kv-v faint small' },
      '锚点 id 属内核内部索引，第一刀无对应下钻端点。')) },
  ]));

  openDrawer('card', `卡片 · ${c.cardId || ''}`, frag);
}

function buildAliasesSection(aliases) {
  const list = Array.isArray(aliases) ? aliases : [];
  const rows = [];

  rows.push(el('div', { class: 'alias-row head' },
    el('span', { class: '', text: '词条 termNorm' }),
    el('span', { text: '来源' }),
    el('span', { text: '敏感' }),
    el('span', { text: '状态' }),
    el('span', { class: 'num', text: '命中' }),
  ));

  for (const a of list) {
    const sensitive = a.sensitive === true;
    const hidden = sensitive && (a.termNorm === null || a.termNorm === undefined);
    rows.push(el('div', { class: 'alias-row' },
      el('span', { class: 'alias-term' + (hidden ? ' sensitive' : '') },
        hidden ? '（敏感词已隐藏）' : (a.termNorm || '—'),
        hidden ? el('span', { class: 'icon sm', style: { marginLeft: '5px', verticalAlign: '-2px' } }, lockIcon()) : null,
      ),
      el('span', { text: a.source || '—' }),
      el('span', {}, sensitive ? statusChip('敏感', 'warn') : el('span', { class: 'faint', text: '否' })),
      el('span', {}, statusChip(ALIAS_STATUS_LABEL[a.status] || a.status || '—', a.status === 'tombstoned' ? 'dim' : 'ok', { dashed: !ALIAS_STATUS_LABEL[a.status] })),
      el('span', { class: 'num', text: fmtNum(a.hitCount ?? 0) }),
    ));
  }

  const sec = kvSection(`别名 aliases（${list.length}）`, [], { extra: el('div', {}) });
  const host = sec.querySelector('div:last-child');
  if (!list.length) {
    host.append(el('div', { class: 'faint small', text: '该卡片暂无别名。' }));
  } else {
    host.append(el('div', { class: 'alias-tbl' }, rows));
    host.append(el('div', { class: 'small faint', style: { marginTop: '8px' } },
      '隐私红线：sensitive=true 的词条后端恒为 null，界面不尝试补全。墓碑态别名仅为历史痕迹，不参与召回。',
    ));
  }
  return sec;
}

function lockIcon() {
  const span = el('span', { class: 'icon sm' });
  span.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`;
  return span;
}
