// pulse.js —— 长轮询编排（不用 SSE：EventSource 无法携带 Authorization 头）
//
// 协议要点（与后端冻结契约对齐）：
//  - after = 客户端已收到的最大 seq；响应无论是否挂起都带完整快照；
//  - 收到响应后立即发起下一轮（常驻长连接，不做固定间隔定时器）；
//  - 网络失败退避重试 300ms → 1s → 3s 封顶，恢复后自动续上；
//  - bootId 变化 / seq 回退 → 重置游标为 0，并广播 refetch 让各列表全量重拉；
//  - 空轮（activities: []）不产生 UI 噪音，仅刷新快照。

import { fetchPulse } from './api.js';
import { store, emit, observeActivity } from './bus.js';

const BACKOFFS = [300, 1000, 3000];

let running = false;
let controller = null;
let maxSeq = -1; // 已观测的最大活动 seq，用于去重

export function startPulse() {
  if (running) return;
  running = true;
  maxSeq = -1;
  loop();
}

export function stopPulse() {
  running = false;
  try { controller?.abort(); } catch { /* 忽略 */ }
}

function setConnection(state) {
  if (store.connection !== state) {
    store.connection = state;
    emit('connection', state);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loop() {
  let cursor = 0;
  let fails = 0;

  while (running) {
    controller = new AbortController();
    let res;
    try {
      res = await fetchPulse(cursor, controller.signal);
    } catch (err) {
      if (!running || (err && err.name === 'AbortError')) return;
      if (err && err.authFailed) {
        // 令牌失效（内核重启后旧 token 必然失效）：交由外壳进入恢复态
        setConnection('lost');
        emit('auth-lost', err);
        return;
      }
      fails = Math.min(fails + 1, BACKOFFS.length);
      setConnection('retrying');
      await sleep(BACKOFFS[Math.min(fails - 1, BACKOFFS.length - 1)]);
      continue;
    }

    fails = 0;
    setConnection('live');

    // ---- 快照与内核重启检测 ----
    const snap = res && typeof res.snapshot === 'object' && res.snapshot !== null ? res.snapshot : null;
    const bid = snap && typeof snap.bootId === 'string' ? snap.bootId : null;

    if (store.bootId && bid && bid !== store.bootId) {
      // 内核已重启且令牌仍有效：重置游标、重拉全量
      store.bootId = bid;
      cursor = 0;
      maxSeq = -1;
      applySnapshot(snap, res.memory, true);
      emit('restart', { bootId: bid });
      emit('refetch', { reason: 'restart' });
      continue;
    }

    // ---- seq 完整性 ----
    if (typeof res.seq !== 'number' || res.seq < cursor) {
      cursor = 0;
      maxSeq = -1;
      emit('refetch', { reason: 'seq-reset' });
      continue;
    }
    cursor = res.seq;

    // ---- 活动分发（去重） ----
    const acts = Array.isArray(res.activities) ? res.activities : [];
    for (const a of acts) {
      if (!a || typeof a !== 'object' || typeof a.seq !== 'number') continue;
      if (a.seq <= maxSeq) continue; // 环形缓冲重叠时防重复
      maxSeq = a.seq;
      observeActivity(a);
      emit('activity', a);
    }

    // ---- 静默快照更新 ----
    applySnapshot(snap, res.memory, false);
  }
}

function applySnapshot(snap, memory, force) {
  if (!snap) return;
  let statusChanged = force;
  if (!store.status || JSON.stringify(store.status) !== JSON.stringify(snap)) {
    store.status = snap;
    statusChanged = true;
  }
  if (typeof snap.bootId === 'string') store.bootId = snap.bootId;
  if (typeof snap.startedAt === 'number') store.startedAt = snap.startedAt;
  if (typeof snap.channel === 'string' && snap.channel) store.channel = snap.channel;

  const mem = memory === undefined ? store.memory : (memory ?? null);
  if (JSON.stringify(mem) !== JSON.stringify(store.memory)) {
    store.memory = mem;
    emit('memory', mem);
  }
  if (statusChanged) emit('status', snap);
}
