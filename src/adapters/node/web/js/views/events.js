// views/events.js —— 事件＋摘要＋历史版本：列表 → 详情（指针/摘要/标记）→ 版本时间线与对比

import { el } from '../dom.js';
import { fmtTime, fmtNum, EVENT_STATUS_LABEL, SUMMARY_QUALITY_LABEL, safeStr, truncate } from '../format.js';
import { fetchEvents, fetchEvent } from '../api.js';
import { on } from '../bus.js';
import { Pager } from '../pager.js';
import { loadingState, errorState, emptyState } from '../states.js';
import { openDrawer, setDrawerBody } from '../drawer.js';
import { kvSection, kvRow, kvId, kvTime, jumpBtn, statusChip, markChips, chipRow } from '../kv.js';
import { navigate } from '../router.js';
import { viewHead, table, rowFlash } from './common.js';

const LIMIT = 25;
const MARK_LABEL = {
  hasMedia: '含媒体', crossChannel: '跨通道', pendingMerge: '待合并',
  orphan: '孤立', summaryStale: '摘要过期',
};
const STATUS_TONE = { open: 'accent', closed: 'ok', merged: 'info', split: 'warn', archived: 'dim' };

let unsubs = [];
let bodyEl, pager, offset = 0;
let offsetSupported = true; // 事件端点若拒绝 offset 则降级为“仅最近 N 条”

export default {
  id: 'events',
  title: '事件与摘要',
  icon: 'event',

  async mount(root, focus) {
    offset = 0;
    offsetSupported = true;
    root.append(viewHead('事件与摘要',
      '写入链第 2 层：事件（event）是经历的闭合窗口，摘要/要点/质量档挂在事件对象上；详情含指针、标记位与全部历史版本。',
    ));

    const panel = el('div', { class: 'panel' });
    const { root: tbl, body } = table('event', ['事件 id', '版本', '状态', '摘要质量', '时间范围', '指针 / 标记']);
    bodyEl = body;
    pager = new Pager({ limit: LIMIT, onChange: (o) => { offset = o; load(); } });
    panel.append(tbl, el('div', { class: 'list-foot' },
      pager.root,
      el('span', { class: 'head-hint faint', text: '摘要不是独立端点：summary / key_points / 质量档都在事件详情内' }),
    ));
    root.append(panel);

    unsubs.push(on('refetch', () => load()));
    await load();
    if (focus && focus.type === 'event') openById(focus.eventId);
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
  },

  applyFocus(f) {
    if (f && f.type === 'event') openById(f.eventId);
  },
};

/* ---------------- 列表 ---------------- */

async function load() {
  setBody(loadingState('加载事件…'));
  try {
    const params = offsetSupported ? { limit: LIMIT, offset } : { limit: LIMIT };
    const r = await fetchEvents(params);
    const list = Array.isArray(r.events) ? r.events : [];
    setBody(null);
    if (!list.length) {
      bodyEl.append(emptyState('暂无事件', '尚无事件窗口。等待写入链把经历闭合为事件。'));
    } else {
      for (const ev of list) bodyEl.append(buildRow(ev));
    }
    pager.update({ offset, loaded: list.length, total: typeof r.total === 'number' ? r.total : null });
  } catch (err) {
    if (err.status === 400 && offset > 0 && offsetSupported) {
      // 端点不支持 offset：降级为仅最近 LIMIT 条
      offsetSupported = false;
      offset = 0;
      pager.setNoOffsetMode(null);
      return load();
    }
    setBody(errorState(err, { onRetry: load }));
  }
}

function setBody(node) {
  while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
  if (node) bodyEl.append(node);
}

function statusChipFor(ev) {
  const st = ev.status || '未知';
  const label = EVENT_STATUS_LABEL[st] || st;
  return statusChip(label, STATUS_TONE[st] || 'dim', { dashed: !EVENT_STATUS_LABEL[st] });
}

function qualityChipFor(ev) {
  const q = ev.summary_quality || '未知';
  const label = SUMMARY_QUALITY_LABEL[q] || (q === 'pending' ? '待摘要' : q);
  if (q === 'pending') return statusChip(label, 'warn');
  if (!ev.summary) return statusChip('无摘要', 'dim');
  return statusChip(label, 'ok');
}

function buildRow(ev) {
  const pointers = Array.isArray(ev.pointers) ? ev.pointers.length : 0;
  const trueMarks = Object.entries(ev.marks || {}).filter(([, v]) => v === true);
  const range = `${fmtTime(ev.time_range?.started_at) || '—'} ～ ${fmtTime(ev.time_range?.ended_at) || '—'}`;

  const extra = el('span', { class: 'tcell' }, el('span', { class: 'chips-wrap' },
    el('span', { class: 'chip', text: `指针 ${pointers.length}` }),
    el('span', { class: 'chip', text: `有效 ${fmtNum(ev.effective_chars)} 字` }),
    ...trueMarks.map(([k]) => statusChip(MARK_LABEL[k] || k, 'warn')),
  ));

  const row = el('div', { class: 'trow', dataset: { key: ev.id } },
    el('span', { class: 'tcell' }, el('span', { class: 'idchip', text: shortId(ev.id), title: ev.id })),
    el('span', { class: 'tcell num', text: 'v' + fmtNum(ev.version) }),
    el('span', { class: 'tcell' }, statusChipFor(ev)),
    el('span', { class: 'tcell' }, qualityChipFor(ev)),
    el('span', { class: 'tcell', title: range }, el('span', { class: 'mono small', text: range })),
    extra,
  );
  row.addEventListener('click', () => openById(ev.id));
  return row;
}

function shortId(id) {
  const s = String(id || '');
  return s.length > 18 ? s.slice(0, 14) + '…' + s.slice(-4) : s;
}

/* ---------------- 详情抽屉 ---------------- */

async function openById(id) {
  openDrawer('event', `事件 · ${shortId(id)}`, loadingState('加载事件详情与历史版本…', { compact: true }));
  let r;
  try {
    r = await fetchEvent(id);
  } catch (err) {
    setDrawerBody(errorState(err, {
      compact: true,
      title: err.notFound ? '事件不存在（404）' : undefined,
    }));
    return;
  }
  renderDetail(r.event, Array.isArray(r.versions) ? r.versions : []);
  rowFlash(bodyEl?.querySelector(`[data-key="${id}"]`));
}

function renderDetail(ev, versions) {
  const frag = document.createDocumentFragment();

  frag.append(kvSection('基本', [
    kvId('id', ev.id),
    kvRow({ k: 'schema_version', v: fmtNum(ev.schema_version), mono: true }),
    kvRow({ k: 'version', v: 'v' + fmtNum(ev.version), mono: true }),
    kvRow({ k: 'status', v: statusChipFor(ev) }),
    kvRow({ k: 'closed_reason', v: ev.closed_reason || null }),
    kvRow({ k: 'channel', v: ev.channel || '—', mono: true }),
    kvRow({ k: 'created_by', v: ev.created_by || '—' }),
    kvRow({ k: 'effective_chars', v: fmtNum(ev.effective_chars), mono: true }),
    kvRow({ k: 'raw_chars', v: fmtNum(ev.raw_chars), mono: true }),
  ]));

  frag.append(kvSection('时间', [
    kvTime('started_at', ev.time_range?.started_at),
    kvTime('ended_at', ev.time_range?.ended_at),
    kvTime('assembled_at', ev.assembled_at),
    kvTime('created_at', ev.created_at),
  ]));

  frag.append(kvSection('标记 marks', [
    { node: el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: '标记位' }), el('span', { class: 'kv-v' }, markChips(ev.marks, MARK_LABEL))) },
  ].filter(Boolean)));

  // 指针（事件 → 经历的权威锚点）
  const pointers = Array.isArray(ev.pointers) ? ev.pointers : [];
  const ptrRows = pointers.map((p) => el('div', { class: 'kv-row' },
    el('span', { class: 'kv-k' }, '→ 经历'),
    el('span', { class: 'kv-v' }, jumpBtn(shortId(p.id) + `　${p.channel || ''} ${p.shard || ''}/seq ${p.seq ?? '?'}`, 'link', () => {
      navigate('experiences', { type: 'experience', experienceId: p.id });
    })),
  ));
  frag.append(kvSection(`指针 pointers（${pointers.length}）`, ptrRows.length ? ptrRows : [
    kvRow({ k: 'pointers', v: null }),
  ]));

  // 摘要（挂在事件对象上）
  const hasSummary = Boolean(ev.summary) || (Array.isArray(ev.key_points) && ev.key_points.length);
  frag.append(kvSection('摘要 summary', [
    kvRow({ k: 'summary_quality', v: qualityChipFor(ev) }),
    kvRow({ k: 'summary_model', v: ev.summary_model || null, mono: true }),
    kvRow({ k: 'summary_source', v: ev.summary_source || null, mono: true }),
    kvRow({ k: 'summary_prompt_version', v: ev.summary_prompt_version || null, mono: true }),
    { node: el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: 'summary 正文' }), el('span', { class: 'kv-v' },
      hasSummary && ev.summary
        ? el('div', { class: 'text-block', text: ev.summary })
        : el('span', { class: 'faint', text: '尚未摘要（summary 为 null）——观察 summary.drain 活动可看到它从 pending 变为就绪' })) ) },
    kvRow({ k: 'key_points', v: hasSummary && Array.isArray(ev.key_points) && ev.key_points.length
      ? el('ul', { style: { margin: '0', paddingLeft: '18px' } }, ev.key_points.map((k) => el('li', { text: k })))
      : null }),
    kvRow({ k: 'topic_lines', v: Array.isArray(ev.topic_lines) && ev.topic_lines.length
      ? el('div', { class: 'chips-wrap' }, ev.topic_lines.map((t) => statusChip(safeStr(t) || '—', 'dim')))
      : null }),
  ]));

  // 历史版本
  frag.append(buildVersionsSection(ev, versions));

  openDrawer('event', `事件 · ${shortId(ev.id)}`, frag);
}

/* ---------------- 版本时间线 + 对比 ---------------- */

function buildVersionsSection(current, versions) {
  const sec = kvSection(`历史版本（${versions.length}）`, [], { extra: el('div', {}) });
  const host = sec.querySelector('div:last-child');

  if (!versions.length) {
    host.append(el('div', { class: 'faint small', text: '详情端点未返回版本数组。' }));
    return sec;
  }

  // 版本时间线 rail
  const rail = el('div', { class: 'ver-rail' });
  const panel = el('div', { style: { marginTop: '10px' } });
  let selected = versions[versions.length - 1];

  versions.forEach((v, i) => {
    if (i > 0) rail.append(el('span', { class: 'ver-link' }));
    const chip = el('button', { class: 'ver-chip', type: 'button' },
      el('span', { class: 'badge-dot', style: { background: versionDotColor(v) } }),
      el('span', { text: `v${v.version}` }),
      el('span', { class: 'small', text: EVENT_STATUS_LABEL[v.status] || v.status || '?' }),
    );
    chip.addEventListener('click', () => {
      selected = v;
      [...rail.children].forEach((c) => c.classList?.remove?.('active'));
      rail.children[i * 2].classList.add('active');
      renderSelected();
    });
    rail.append(chip);
  });
  rail.children[versions.length * 2 - 2]?.classList.add('active');

  const compareBtn = el('button', { class: 'btn', type: 'button' }, '与最新版本对比');
  const diffHost = el('div', {});

  function renderSelected() {
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    panel.append(kvSection(`版本 v${selected.version} 详情`, [
      kvRow({ k: 'status', v: statusChip(EVENT_STATUS_LABEL[selected.status] || selected.status || '未知', STATUS_TONE[selected.status] || 'dim') }),
      kvRow({ k: 'closed_reason', v: selected.closed_reason || null }),
      kvTime('started_at', selected.time_range?.started_at),
      kvTime('ended_at', selected.time_range?.ended_at),
      kvRow({ k: 'effective_chars', v: fmtNum(selected.effective_chars), mono: true }),
      kvRow({ k: 'pointers', v: fmtNum(Array.isArray(selected.pointers) ? selected.pointers.length : 0), mono: true }),
      kvRow({ k: 'summary', v: selected.summary ? truncate(selected.summary, 200) : null }),
      kvRow({ k: 'summary_quality', v: qualityChipFor(selected) }),
      kvTime('created_at', selected.created_at),
    ]));
  }

  compareBtn.addEventListener('click', () => {
    const open = diffHost.childElementCount > 0;
    if (open) {
      while (diffHost.firstChild) diffHost.removeChild(diffHost.firstChild);
      compareBtn.classList.remove('primary');
      compareBtn.textContent = '与最新版本对比';
      return;
    }
    const latest = versions[versions.length - 1];
    const diffs = shallowDiff(selected, latest);
    compareBtn.classList.add('primary');
    compareBtn.textContent = '收起对比';
    while (diffHost.firstChild) diffHost.removeChild(diffHost.firstChild);
    if (selected === latest) {
      diffHost.append(el('div', { class: 'diff-empty', text: '当前选中的就是最新版本，无对比意义。' }));
    } else if (!diffs.length) {
      diffHost.append(el('div', { class: 'diff-empty', text: '两版本字段完全一致。' }));
    } else {
      for (const d of diffs) {
        diffHost.append(el('div', { class: 'diff-row' },
          el('span', { class: 'diff-key', text: d.key }),
          el('span', { class: 'diff-from', text: oneLine(d.from) }),
          el('span', { class: 'diff-arrow', text: '→' }),
          el('span', { class: 'diff-to', text: oneLine(d.to) }),
        ));
      }
    }
  });

  host.append(rail, panel, el('div', { class: 'd-actions' }, compareBtn), diffHost);
  renderSelected();
  return sec;
}

function versionDotColor(v) {
  const tone = STATUS_TONE[v.status];
  return { accent: 'var(--accent)', ok: 'var(--ok)', info: 'var(--info)', warn: 'var(--warn)', dim: 'var(--faint)' }[tone] || 'var(--faint)';
}

/** 浅层字段对比（JSON 视角相等即视为未变） */
function shallowDiff(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out.push({ key: k, from: a?.[k], to: b?.[k] });
  }
  return out;
}

function oneLine(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v.length > 140 ? v.slice(0, 140) + '…' : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  } catch {
    return String(v);
  }
}
