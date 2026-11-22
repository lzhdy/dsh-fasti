// views/projection.js —— 投影观测：引擎/事件层/检查点/对账尾差/edges（通用键值渲染，不写死字段）

import { el, icon } from '../dom.js';
import { fmtNum, fmtTime, safeStr } from '../format.js';
import { fetchProjection } from '../api.js';
import { on } from '../bus.js';
import { loadingState, errorState, emptyState } from '../states.js';
import { kvRow } from '../kv.js';
import { viewHead } from './common.js';

let unsubs = [];
let bodyHost;
let currentRoot = null;

export default {
  id: 'projection',
  title: '投影',
  icon: 'proj',

  async mount(root) {
    currentRoot = root;
    root.append(viewHead('投影',
      '投影层把真源折叠/关联为可召回结构。本视图回答：投影现在是什么状态、是否落后真源（尾差）、当前折叠了哪些边（edges）。',
    ));

    const panel = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, icon('proj'), '投影状态', el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button' }, '刷新')),
    );
    const refreshBtn = panel.querySelector('button');
    refreshBtn.addEventListener('click', () => load());

    bodyHost = el('div', { class: 'panel-body' });
    panel.append(bodyHost);
    root.append(panel);

    unsubs.push(on('refetch', () => load()));
    await load();
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
    currentRoot = null;
  },

  applyFocus() {},
};

async function load() {
  setBody(loadingState('加载投影状态…'));
  try {
    const r = await fetchProjection();
    render(r);
  } catch (err) {
    setBody(errorState(err, { onRetry: load }));
  }
}

function setBody(node) {
  while (bodyHost.firstChild) bodyHost.removeChild(bodyHost.firstChild);
  if (node) bodyHost.append(node);
}

function render(r) {
  const eng = r.engine || {};
  const layer = r.eventLayer || {};
  const cp = r.checkpoint || {};
  const rec = r.reconciliation || {};
  const tail = (rec.sourceMaxTick ?? 0) - (rec.lastProjectedTick ?? 0);
  const edges = Array.isArray(r.edges) ? r.edges : [];

  const frag = document.createDocumentFragment();

  // 引擎 / 事件层 / 检查点 / 对账
  const grid = el('div', { class: 'ov-grid', style: { gridTemplateColumns: 'minmax(240px, 1fr) minmax(240px, 1fr)' } });
  grid.append(
    miniCard('引擎', [
      kvRow({ k: 'level', v: el('span', { class: 'engine-badge' + (eng.degraded ? ' degraded' : ''), text: eng.level || '—' }) }),
      kvRow({ k: 'degraded', v: eng.degraded ? statusWarn('已降级') : statusOk('正常') }),
      eng.degraded ? kvRow({ k: 'reason', v: eng.reason || '—' }) : null,
    ]),
    miniCard('事件层', [
      kvRow({ k: 'available', v: layer.available ? statusOk('可用') : statusWarn('不可用') }),
      layer.reason ? kvRow({ k: 'reason', v: layer.reason }) : null,
    ]),
    miniCard('检查点 checkpoint', [
      kvRow({ k: 'version', v: fmtNum(cp.version), mono: true }),
      kvRow({ k: 'tick', v: fmtNum(cp.tick), mono: true }),
      kvRow({ k: 'engine', v: cp.engine || '—', mono: true }),
      kvRow({ k: 'last_projected_tick', v: fmtNum(cp.last_projected_tick), mono: true }),
      kvRow({ k: 'pending_events', v: fmtNum(cp.pending_events), mono: true }),
      kvRow({ k: 'needs_rebuild', v: cp.needs_rebuild ? statusWarn('是') : statusOk('否') }),
    ]),
    miniCard('启动对账 reconciliation', [
      kvRow({ k: 'sourceMaxTick', v: fmtNum(rec.sourceMaxTick), mono: true }),
      kvRow({ k: 'lastProjectedTick', v: fmtNum(rec.lastProjectedTick), mono: true }),
      kvRow({ k: '尾差', v: el('span', { class: 'tail-badge' + (tail > 0 ? ' behind' : '') },
        el('span', { text: fmtNum(tail) }), el('span', { class: 'small', text: tail > 0 ? '投影落后真源' : '已同步' })) }),
      kvRow({ k: 'folded', v: fmtNum(rec.folded), mono: true }),
    ]),
  );
  frag.append(grid);

  // edges：通用键值表格化（不写死字段）
  const edgesPanel = el('div', { class: 'panel', style: { marginTop: '14px' } },
    el('div', { class: 'panel-head' }, icon('link'), `投影边 edges（${fmtNum(edges.length)}）`,
      el('span', { class: 'spacer' }),
      el('span', { class: 'head-hint', text: '后端硬顶 100 条 · 字段以真机返回为准做通用渲染' })),
    el('div', { class: 'panel-body' },
      edges.length ? edges.map(edgeCard) : emptyState('暂无投影边', 'edges 为空：投影层尚未折叠真源节点，或本刀后端暂未提供非空数据。这是正常现象，不是错误。'),
    ),
  );
  frag.append(edgesPanel);

  setBody(frag);
}

function miniCard(title, rows) {
  const card = el('div', { class: 'panel stat-card' },
    el('div', { class: 'sc-title' }, title),
  );
  const kv = el('div', { class: 'kv' });
  for (const r of rows) if (r) kv.append(r.node || r);
  card.append(kv);
  return card;
}

function edgeCard(edge, i) {
  const card = el('div', { class: 'edge-card' },
    el('div', { class: 'edge-idx' }, `edge #${i + 1}`),
  );
  const kv = el('div', { class: 'kv' });
  if (edge && typeof edge === 'object') {
    for (const [k, v] of Object.entries(edge)) {
      const val = (v !== null && typeof v === 'object')
        ? el('span', { class: 'mono', style: { wordBreak: 'break-all' }, text: safeStr(v) || '{}' })
        : el('span', { text: v === null || v === undefined || v === '' ? '—' : String(v) });
      kv.append(kvRow({ k, v: val, mono: typeof v === 'object' }));
    }
  } else {
    kv.append(kvRow({ k: 'raw', v: safeStr(edge) || '—', mono: true }));
  }
  card.append(kv);
  return card;
}

function statusOk(text) { return el('span', { class: 'chip chip-ok', text }); }
function statusWarn(text) { return el('span', { class: 'chip chip-warn', text }); }
