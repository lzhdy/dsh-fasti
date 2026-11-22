// views/raw.js —— 真源原文（raw turns）：列表 → 详情（8 字段 + 哈希）→ 关联经历跳转

import { el, idChip, copyBtn } from '../dom.js';
import { fmtTime } from '../format.js';
import { fetchRaw, fetchExperiences } from '../api.js';
import { on } from '../bus.js';
import { Pager } from '../pager.js';
import { loadingState, errorState, emptyState } from '../states.js';
import { openDrawer, setDrawerBody } from '../drawer.js';
import { kvSection, kvRow, kvId, kvTime, actionRow, jumpBtn, statusChip } from '../kv.js';
import { navigate } from '../router.js';
import { viewHead, table, rowFlash } from './common.js';

const LIMIT = 25;
let unsubs = [];
let bodyEl, pager, offset = 0;
let actionsHost = null;

export default {
  id: 'raw',
  title: '真源原文',
  icon: 'raw',

  async mount(root, focus) {
    offset = 0;
    root.append(viewHead('真源原文',
      '写入链第 0 层：逐轮对话原文（raw turns）。每行含说话方、正文与分片坐标 shard/seq；正文与哈希在详情下钻中完整展示。',
    ));

    const panel = el('div', { class: 'panel' });
    const { root: tbl, body } = table('raw', ['说话方', '原文', '写入时间', '坐标 shard/seq']);
    bodyEl = body;
    pager = new Pager({ limit: LIMIT, onChange: (o) => { offset = o; load(); } });
    panel.append(tbl, el('div', { class: 'list-foot' },
      pager.root,
      el('span', { class: 'head-hint faint', text: '点击行查看全部 8 个字段与内容哈希' }),
    ));
    root.append(panel);

    unsubs.push(on('refetch', () => load()));
    await load();
    if (focus && focus.type === 'raw') locateAndOpen(focus.shard, focus.seq);
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
  },

  applyFocus(f) {
    if (f && f.type === 'raw') locateAndOpen(f.shard, f.seq);
  },
};

/* ---------------- 列表 ---------------- */

async function load() {
  setBody(loadingState('加载真源原文…'));
  try {
    const r = await fetchRaw({ limit: LIMIT, offset });
    const turns = Array.isArray(r.turns) ? r.turns : [];
    setBodyEmpty();
    if (!turns.length) {
      bodyEl.append(emptyState('暂无原文', '内核尚未摄入任何对话原文。等待写入链的 ingest.turn 活动。'));
    } else {
      for (const t of turns) bodyEl.append(buildRow(t));
    }
    pager.update({ offset, loaded: turns.length, total: typeof r.total === 'number' ? r.total : null });
  } catch (err) {
    setBody(errorState(err, { onRetry: load }));
  }
}

function setBody(node) {
  while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
  if (node) bodyEl.append(node);
}

function setBodyEmpty() {
  setBody(null);
}

function rowKey(t) {
  return `${t.shard}:${t.seq}`;
}

function buildRow(t) {
  const turn = t.turn || {};
  const row = el('div', { class: 'trow', dataset: { key: rowKey(t) } },
    el('span', { class: 'tcell' }, speakerChip(turn.speaker)),
    el('span', { class: 'tcell' }, el('span', { class: 'clamp2', text: turn.raw_text || '（空正文）' })),
    el('span', { class: 'tcell mono', text: fmtTime(turn.ingested_at) || '—' }),
    el('span', { class: 'tcell' }, coordChip(t.shard, t.seq)),
  );
  row.addEventListener('click', () => openRawDetail(t));
  return row;
}

function speakerChip(speaker) {
  const map = { user: 'accent', assistant: 'info', system: 'dim' };
  const tone = map[speaker] || '';
  return statusChip(speaker || '未知', tone, { dashed: !map[speaker] });
}

function coordChip(shard, seq) {
  return el('span', { class: 'chip', text: `${shard ?? '—'} / seq ${seq ?? '—'}` });
}

/* ---------------- 详情抽屉 ---------------- */

function openRawDetail(t) {
  const turn = t.turn || {};
  actionsHost = el('span', { class: 'chips-wrap' });

  const frag = document.createDocumentFragment();

  const secText = kvSection('正文', []);
  secText.append(el('div', { class: 'text-block', text: turn.raw_text || '（空正文）' }));
  frag.append(secText);

  frag.append(kvSection('字段（全部 8 项）', [
    kvId('event_id', turn.event_id),
    kvId('session_id', turn.session_id),
    kvId('turn_id', turn.turn_id),
    kvRow({ k: 'speaker', v: speakerChip(turn.speaker) }),
    turn.asserted_at ? kvTime('asserted_at', turn.asserted_at) : kvRow({ k: 'asserted_at', v: null }),
    kvTime('ingested_at', turn.ingested_at),
    kvRow({ k: 'content_hash', v: el('span', { class: 'mono', style: { wordBreak: 'break-all' }, text: turn.content_hash || '—' }), copy: turn.content_hash }),
    kvRow({ k: '坐标', v: coordChip(t.shard, t.seq) }),
  ]));

  frag.append(kvSection('关联下钻', [], {
    extra: el('div', { class: 'd-actions' },
      jumpBtn('查看关联经历（顺 observation.text 坐标反查）', 'link', () => findExperienceFor(turn.event_id), { primary: true }),
      actionsHost,
    ),
  }));

  openDrawer('raw turn', `原文 · ${t.shard || '?'} #${t.seq ?? '?'}`, frag);
}

async function findExperienceFor(eventId) {
  if (!eventId) return;
  actionsHost.textContent = '';
  const status = el('span', { class: 'inline-loading' }, el('span', { class: 'spinner' }), '正在扫描经历列表反查引用…');
  actionsHost.append(status);
  try {
    const hit = await scanExperiencesByEventId(eventId);
    status.remove();
    if (hit) {
      navigate('experiences', { type: 'experience', experienceId: hit.id });
    } else {
      actionsHost.append(el('span', { class: 'faint small', text: '当前数据范围内未找到引用此原文的经历。' }));
    }
  } catch (err) {
    status.remove();
    actionsHost.append(el('span', { class: 'small', style: { color: 'var(--err)' }, text: '反查失败：' + (err.message || '') }));
  }
}

async function scanExperiencesByEventId(eventId) {
  const limit = 100;
  for (let off = 0; off < 10000; off += limit) {
    const r = await fetchExperiences({ limit, offset: off });
    const list = Array.isArray(r.experiences) ? r.experiences : [];
    const hit = list.find((x) => x.observation?.text?.id === eventId);
    if (hit) return hit;
    if (list.length < limit) return null;
  }
  return null;
}

/* ---------------- 跨域定位（经历 → 原文） ---------------- */

async function locateAndOpen(shard, seq) {
  const loading = el('div', { class: 'state compact' },
    el('span', { class: 'spinner' }),
    el('span', { class: 'state-desc', text: `正在定位原文 shard=${shard} seq=${seq}…` }),
  );
  openDrawer('raw turn', `定位原文 ${shard} #${seq}`, loading);

  const limit = 100;
  let found = null;
  try {
    for (let off = 0; off < 10000; off += limit) {
      const r = await fetchRaw({ limit, offset: off });
      const turns = Array.isArray(r.turns) ? r.turns : [];
      const idx = turns.findIndex((t) => t.shard === shard && t.seq === seq);
      if (idx >= 0) { found = { turn: turns[idx], index: off + idx }; break; }
      const total = typeof r.total === 'number' ? r.total : off + turns.length;
      if (turns.length < limit || off + limit >= total) break;
    }
  } catch (err) {
    setDrawerBody(errorState(err, { compact: true }));
    return;
  }

  if (!found) {
    setDrawerBody(el('div', { class: 'state warn-state compact' },
      el('span', { class: 'state-title', text: '未能定位该坐标的原文' }),
      el('span', { class: 'state-desc', text: `数据范围内没有 shard=${shard} seq=${seq} 的原文行。该原文可能尚未摄入，或对应分片已被清理。` }),
    ));
    return;
  }

  openRawDetail(found.turn);
  const pageOffset = Math.floor(found.index / LIMIT) * LIMIT;
  if (pageOffset !== offset) {
    offset = pageOffset;
    await load();
  }
  rowFlash(bodyEl.querySelector(`[data-key="${rowKey(found.turn)}"]`));
}
