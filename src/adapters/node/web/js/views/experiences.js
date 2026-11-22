// views/experiences.js —— 经历：列表 → 详情 → 顺 observation.text 坐标跳原文 / 反查所属事件

import { el, idChip } from '../dom.js';
import { fmtTime, fmtNum } from '../format.js';
import { fetchExperiences, fetchExperience, fetchEvents } from '../api.js';
import { on, store } from '../bus.js';
import { Pager } from '../pager.js';
import { loadingState, errorState, emptyState } from '../states.js';
import { openDrawer, setDrawerBody } from '../drawer.js';
import { kvSection, kvRow, kvId, kvTime, jumpBtn, statusChip } from '../kv.js';
import { navigate } from '../router.js';
import { viewHead, table, rowFlash } from './common.js';

const LIMIT = 25;
let unsubs = [];
let bodyEl, pager, offset = 0;
let actionsHost = null;

export default {
  id: 'experiences',
  title: '经历',
  icon: 'exp',

  async mount(root, focus) {
    offset = 0;
    root.append(viewHead('经历',
      '写入链第 1 层：内核对一拍对话的首次结构化（experience）。经 observation.text 的 shard/seq 坐标与真源原文一一对应。',
    ));

    const panel = el('div', { class: 'panel' });
    const { root: tbl, body } = table('exp', ['经历 id', '类型', '发起方', '发生时间', 'tick', '原文坐标']);
    bodyEl = body;
    pager = new Pager({ limit: LIMIT, onChange: (o) => { offset = o; load(); } });
    panel.append(tbl, el('div', { class: 'list-foot' },
      pager.root,
      el('span', { class: 'head-hint faint', text: '点击行查看详情；详情内可跳原文与所属事件' }),
    ));
    root.append(panel);

    unsubs.push(on('refetch', () => load()));
    await load();
    if (focus && focus.type === 'experience') openById(focus.experienceId);
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
  },

  applyFocus(f) {
    if (f && f.type === 'experience') openById(f.experienceId);
  },
};

/* ---------------- 列表 ---------------- */

async function load() {
  setBody(loadingState('加载经历…'));
  try {
    const r = await fetchExperiences({ limit: LIMIT, offset, channel: store.channel || undefined });
    const list = Array.isArray(r.experiences) ? r.experiences : [];
    setBody(null);
    if (!list.length) {
      bodyEl.append(emptyState('暂无经历', '内核尚未把任何原文折叠为经历。'));
    } else {
      for (const x of list) bodyEl.append(buildRow(x));
    }
    pager.update({ offset, loaded: list.length, total: typeof r.total === 'number' ? r.total : null });
  } catch (err) {
    setBody(errorState(err, { onRetry: load }));
  }
}

function setBody(node) {
  while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
  if (node) bodyEl.append(node);
}

function buildRow(x) {
  const obs = x.observation?.text || {};
  const row = el('div', { class: 'trow', dataset: { key: x.id } },
    el('span', { class: 'tcell' }, idChip(x.id, { shortAfter: 12, shortBefore: 4 })),
    el('span', { class: 'tcell' }, statusChip(x.kind || '未知', 'accent', { dashed: !x.kind })),
    el('span', { class: 'tcell' }, el('span', { class: 'chip', text: x.initiation || '—' })),
    el('span', { class: 'tcell mono', text: fmtTime(x.occurred_at) || '—' }),
    el('span', { class: 'tcell num', text: fmtNum(x.tick) }),
    el('span', { class: 'tcell' }, el('span', { class: 'chip', text: `${obs.shard ?? '—'} / seq ${obs.seq ?? '—'}` })),
  );
  row.addEventListener('click', () => openDetail(x));
  return row;
}

/* ---------------- 详情抽屉 ---------------- */

function openDetail(x) {
  const obs = x.observation?.text || {};
  const scene = x.scene || {};
  actionsHost = el('span', { class: 'chips-wrap' });

  const frag = document.createDocumentFragment();

  frag.append(kvSection('基本字段', [
    kvId('id', x.id),
    kvRow({ k: 'schema_version', v: fmtNum(x.schema_version), mono: true }),
    kvRow({ k: 'kind', v: statusChip(x.kind || '未知', 'accent', { dashed: !x.kind }) }),
    kvRow({ k: 'initiation', v: x.initiation || '—' }),
    kvRow({ k: 'tick', v: fmtNum(x.tick), mono: true }),
    kvRow({ k: 'char_count', v: fmtNum(x.char_count), mono: true }),
  ]));

  frag.append(kvSection('时间', [
    kvTime('occurred_at', x.occurred_at),
    kvTime('recorded_at', x.recorded_at),
  ]));

  frag.append(kvSection('场景 scene', [
    kvRow({ k: 'scene.channel', v: scene.channel || '—', mono: true }),
    kvRow({ k: 'scene.ref', v: scene.ref || null, mono: true }),
  ]));

  frag.append(kvSection('观测指针 observation.text', [
    kvId('text.id', obs.id),
    kvRow({ k: 'text.channel', v: obs.channel || '—', mono: true }),
    kvRow({ k: 'text 坐标', v: el('span', { class: 'chip', text: `${obs.shard ?? '—'} / seq ${obs.seq ?? '—'}` }) }),
  ], {
    extra: el('div', { class: 'd-actions' },
      jumpBtn('跳转到对应真源原文', 'link', () => {
        navigate('raw', { type: 'raw', shard: obs.shard, seq: obs.seq });
      }, { primary: true }),
      jumpBtn('反查所属事件', 'event', () => findEventFor(x.id)),
      actionsHost,
    ),
  }));

  openDrawer('experience', `经历 · ${shortId(x.id)}`, frag);
}

function shortId(id) {
  const s = String(id || '');
  return s.length > 16 ? s.slice(0, 12) + '…' + s.slice(-4) : s;
}

async function findEventFor(expId) {
  actionsHost.textContent = '';
  const status = el('span', { class: 'inline-loading' }, el('span', { class: 'spinner' }), '正在扫描事件指针反查所属事件…');
  actionsHost.append(status);
  try {
    const limit = 100;
    let hit = null;
    for (let off = 0; off < 10000; off += limit) {
      const r = await fetchEvents({ limit, offset: off });
      const list = Array.isArray(r.events) ? r.events : [];
      hit = list.find((ev) => Array.isArray(ev.pointers) && ev.pointers.some((p) => p.id === expId));
      if (hit) break;
      const total = typeof r.total === 'number' ? r.total : off + list.length;
      if (list.length < limit || off + limit >= total) break;
    }
    status.remove();
    if (hit) navigate('events', { type: 'event', eventId: hit.id });
    else actionsHost.append(el('span', { class: 'faint small', text: '当前数据范围内没有指针指向该经历的事件。' }));
  } catch (err) {
    status.remove();
    actionsHost.append(el('span', { class: 'small', style: { color: 'var(--err)' }, text: '反查失败：' + (err.message || '') }));
  }
}

/* ---------------- 跨域定位（事件指针 → 经历详情） ---------------- */

async function openById(id) {
  openDrawer('experience', `经历 · ${shortId(id)}`, loadingState('加载经历详情…', { compact: true }));
  try {
    const r = await fetchExperience(id);
    openDetail(r.experience);
    // 列表若在当前页包含该行，闪一下
    rowFlash(bodyEl.querySelector(`[data-key="${id}"]`));
  } catch (err) {
    setDrawerBody(errorState(err, {
      compact: true,
      title: err.notFound ? '经历不存在（404）' : undefined,
    }));
  }
}
