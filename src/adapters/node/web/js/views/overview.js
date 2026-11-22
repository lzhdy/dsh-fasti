// views/overview.js —— 实时总览：链路示意图 + 活动流 + 状态卡片

import { el, icon } from '../dom.js';
import { fmtNum, fmtTime } from '../format.js';
import { store, on, memoryCounts, kindMeta, KIND_META } from '../bus.js';
import { initPipeline, destroyPipeline } from '../pipeline.js';
import { initFeed, destroyFeed, setFilter } from '../feed.js';
import { relSpan } from '../states.js';
import { viewHead } from './common.js';

let unsubs = [];
let statCol;

export default {
  id: 'overview',
  title: '实时总览',
  icon: 'pulse',

  mount(root) {
    root.append(viewHead('实时总览',
      '内核写入链与读出链的实时观测：链路节点点亮、活动流时间线、运行状态卡片。数据经长轮询 /api/pulse 快照持续刷新。',
    ));

    const grid = el('div', { class: 'ov-grid' });
    statCol = el('div', { class: 'ov-col' });
    const feedCol = el('div', { class: 'ov-col' });
    const pipelineHost = el('div');
    const feedHost = el('div');
    feedCol.append(pipelineHost, feedHost);
    grid.append(statCol, feedCol);
    root.append(grid);

    initPipeline(pipelineHost, {
      onNodeClick: (kind) => {
        const meta = kindMeta(kind);
        if (meta && meta.chain === 'write') setFilter('write');
        else if (meta && meta.chain === 'read') setFilter('read');
        else setFilter('all');
      },
    });
    initFeed(feedHost);

    renderStats();
    unsubs.push(on('status', renderStats), on('memory', renderStats), on('restart', renderStats));
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
    destroyPipeline();
    destroyFeed();
  },

  applyFocus() { /* 总览不接收下钻焦点 */ },
};

/* ---------------- 左列状态卡片 ---------------- */

function statCard(title, iconName, ...body) {
  return el('div', { class: 'panel stat-card' },
    el('div', { class: 'sc-title' }, icon(iconName), title),
    ...body,
  );
}

function renderStats() {
  while (statCol.firstChild) statCol.removeChild(statCol.firstChild);
  const s = store.status;
  if (!s) {
    statCol.append(statCard('运行状态', 'gauge', el('div', { class: 'faint small', text: '等待快照…' })));
    return;
  }

  // 引擎与事件层
  const eng = s.engine || {};
  const layer = s.eventLayer || {};
  statCol.append(statCard('引擎 · 事件层', 'gauge',
    el('div', { class: 'kv' },
      row('引擎档位', engineBadge(eng)),
      row('降级', eng.degraded
        ? el('span', { class: 'chip chip-warn', text: '已降级' })
        : el('span', { class: 'chip chip-ok', text: '正常' })),
      eng.degraded && eng.reason ? row('降级原因', el('span', { class: 'warn-text', text: eng.reason || '—' })) : null,
      row('事件层', layer.available
        ? el('span', { class: 'chip chip-ok', text: '可用' })
        : el('span', { class: 'chip chip-err', text: '不可用' })),
      !layer.available && layer.reason ? row('不可用原因', el('span', { class: 'err-text', text: layer.reason || '—' })) : null,
      row('默认通道', el('span', { class: 'mono', text: s.channel || '—' })),
    ),
  ));

  // 检查点与对账
  const cp = s.checkpoint || {};
  const rec = s.reconciliation || {};
  const tail = (rec.sourceMaxTick ?? 0) - (rec.lastProjectedTick ?? 0);
  statCol.append(statCard('检查点 · 对账', 'db',
    el('div', { class: 'kv' },
      row('检查点版本', fmtNum(cp.version)),
      row('tick', el('span', { class: 'mono', text: fmtNum(cp.tick) })),
      row('最后投影 tick', el('span', { class: 'mono', text: fmtNum(cp.last_projected_tick) })),
      row('待投影事件', fmtNum(cp.pending_events)),
      row('启动折叠', fmtNum(rec.folded)),
      row('投影尾差', el('span', { class: 'tail-badge' + (tail > 0 ? ' behind' : '') },
        el('span', { text: fmtNum(tail) }), el('span', { class: 'small', text: tail > 0 ? '落后真源' : '同步' }))),
      row('needs_rebuild', cp.needs_rebuild
        ? el('span', { class: 'chip chip-warn', text: '需要重建' })
        : el('span', { class: 'chip chip-ok', text: '否' })),
    ),
  ));

  // 事件状态分布
  const ev = s.counts?.events || {};
  const evChips = [
    ['open', '开放中'], ['closed', '已闭合'], ['merged', '已合并'], ['split', '已拆分'], ['archived', '已归档'],
  ].map(([k, label]) => el('span', { class: 'chip', text: `${label} ${fmtNum(ev[k] ?? 0)}` }));
  statCol.append(statCard('事件分布', 'event',
    el('div', { class: 'chips-wrap' }, evChips),
    el('div', { class: 'small faint', style: { marginTop: '8px' } },
      `合计 ${fmtNum(ev.total ?? 0)} 件 · 待摘要 ${fmtNum(s.pendingSummaryCount ?? 0)}`),
  ));

  // 通道
  const channels = Array.isArray(s.channels) ? s.channels : [];
  statCol.append(statCard('通道', 'layers',
    ...channels.map((c) => el('div', { class: 'chan-row' },
      el('span', { class: 'chan-id', text: c.id || '—' }),
      c.ok ? el('span', { class: 'badge-dot', style: { background: 'var(--ok)' } }) : el('span', { class: 'badge-dot', style: { background: 'var(--err)' } }),
      el('span', { class: 'chan-note', text: c.notes || `${c.registered ? '已注册' : '未注册'} · 经历 ${fmtNum(c.experiences ?? 0)} · 原文 ${fmtNum(c.rawTurns ?? 0)}`, title: c.notes || '' }),
    )),
    channels.length ? null : el('div', { class: 'faint small', text: '无已注册通道' }),
  ));

  // 记忆索引
  const mem = memoryCounts(store.memory);
  statCol.append(statCard('记忆索引', 'brain',
    mem
      ? el('div', { class: 'kv' },
          row('卡片总数', fmtNum(mem.cards)),
          row('生效 / 失效', `${fmtNum(mem.activeCards)} / ${fmtNum(mem.invalidCards)}`),
          row('被取代', fmtNum(mem.supersededCards)),
          row('别名', fmtNum(mem.aliases)),
          row('敏感别名', fmtNum(mem.sensitiveAliases), { suffix: el('span', { class: 'faint small', text: '（原文恒为 null）' }) }),
          row('未命中', fmtNum(mem.misses)),
        )
      : el('div', {},
          el('div', { class: 'chips-wrap' }, el('span', { class: 'chip chip-warn', text: '未就绪（503）' })),
          el('div', { class: 'small faint', style: { marginTop: '8px' } },
            '记忆索引尚未建好，卡片观测暂不可用；就绪后本卡片与导航徽章会自动更新。'),
        ),
  ));

  // 会话活动计数（长轮询活动驱动）
  const kindRows = Object.keys(KIND_META).map((kind) => {
    const cnt = store.sessionCounts[kind] || 0;
    const at = store.lastAt[kind];
    return el('div', { class: 'chan-row' },
      el('span', { class: 'chip', text: kind }),
      el('span', { class: 'num', text: fmtNum(cnt) }),
      el('span', { class: 'chan-note' }, at ? relSpan(at) : '—'),
    );
  });
  statCol.append(statCard('会话活动计数', 'clock', ...kindRows));
}

function engineBadge(eng) {
  const b = el('span', { class: 'engine-badge' + (eng.degraded ? ' degraded' : ''), text: eng.level || '—' });
  return b;
}

function row(k, v, opts = {}) {
  if (opts.node) return opts.node;
  return el('div', { class: 'kv-row' },
    el('span', { class: 'kv-k', text: k }),
    el('span', { class: 'kv-v' }, v),
  );
}
