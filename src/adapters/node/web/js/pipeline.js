// pipeline.js —— 写入链/读出链链路示意图（实时点亮 + 最近活动时间 + 会话累计）

import { el, icon } from './dom.js';
import { fmtRel } from './format.js';
import { store, on, WRITE_NODES } from './bus.js';

const RECENT_MS = 10_000;   // <10s 视为“点亮”
const WARM_MS = 60_000;     // <60s 视为“余温”

let nodes = new Map();      // key -> {root, dot, label, last, count}
let unsubs = [];
let onNodeClick = null;

const ARROW = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8h11M9.5 4.5 13 8l-3.5 3.5"/></svg>`;

export function initPipeline(container, { onNodeClick: clickCb } = {}) {
  onNodeClick = clickCb || null;
  nodes = new Map();

  const rows = el('div', { class: 'pipe-rows' });

  // 写入链
  const writeFlow = el('div', { class: 'pipe-flow' });
  WRITE_NODES.forEach((n, i) => {
    if (i > 0) writeFlow.append(el('span', { class: 'pipe-arrow', html: ARROW }));
    writeFlow.append(buildNode(n));
  });
  rows.append(el('div', { class: 'pipe-row' },
    el('div', { class: 'pipe-row-label' }, el('b', { text: '写入链' }), 'ingest → memory'),
    writeFlow,
  ));

  // 读出链
  const readFlow = el('div', { class: 'pipe-flow' });
  readFlow.append(buildNode({ key: 'tool', kind: 'tool.call', label: '工具调用' }));
  rows.append(el('div', { class: 'pipe-row' },
    el('div', { class: 'pipe-row-label' }, el('b', { text: '读出链' }), 'tool.call'),
    readFlow,
  ));

  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      icon('link'),
      '链路示意',
      el('span', { class: 'spacer' }),
      el('span', { class: 'head-hint', text: '节点点击可过滤活动流 · 空轮无活动属正常' }),
    ),
    el('div', { class: 'panel-body' }, rows),
  );

  container.append(panel);

  unsubs.push(
    on('activity', (a) => {
      if (!a || !a.kind) return;
      refreshStates();
    }),
    on('tick', () => refreshStates()),
    on('restart', () => refreshStates()),
  );
  refreshStates();
}

export function destroyPipeline() {
  unsubs.forEach((u) => u());
  unsubs = [];
}

function buildNode({ key, kind, label }) {
  const dot = el('span', { class: 'pn-dot' });
  const last = el('span', { text: '—' });
  const count = el('span', { text: '累计 0' });
  const root = el('button', { class: 'pipe-node', type: 'button' },
    el('span', { class: 'pn-top' }, dot, el('span', { class: 'pn-label', text: label })),
    el('span', { class: 'pn-kind', text: kind }),
    el('span', { class: 'pn-foot' }, last, count),
  );
  root.dataset.kind = kind;
  root.title = `${label}（${kind}）`;
  if (onNodeClick) {
    root.addEventListener('click', () => onNodeClick(kind));
  }
  nodes.set(key, { root, dot, last, count, kind });
  return root;
}

/** 依据 store.lastAt / sessionCounts 刷新全部节点状态 */
export function refreshStates() {
  const now = Date.now();
  for (const [, n] of nodes) {
    const at = store.lastAt[n.kind];
    const cnt = store.sessionCounts[n.kind] || 0;
    n.count.textContent = `累计 ${cnt}`;
    if (at) {
      n.last.textContent = fmtRel(at, now);
      const age = now - at;
      n.root.classList.toggle('lit', age < RECENT_MS);
      n.root.classList.toggle('warm', age >= RECENT_MS && age < WARM_MS);
      n.root.classList.toggle('err-lit', n.kind === 'loop.error');
    } else {
      n.last.textContent = '—';
      n.root.classList.remove('lit', 'warm');
    }
  }
}
