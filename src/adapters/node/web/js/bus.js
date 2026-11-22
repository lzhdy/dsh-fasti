// bus.js —— 应用级事件总线 + 全局状态仓库 + 活动枚举元数据

const listeners = new Map();

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}

export function off(evt, fn) {
  listeners.get(evt)?.delete(fn);
}

export function emit(evt, data) {
  const set = listeners.get(evt);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(data); } catch (err) { console.error('[bus]', evt, err); }
  }
}

/** 活动事件封闭枚举的元数据：链路归属、展示名 */
export const KIND_META = {
  'ingest.turn':   { label: '摄入',     node: 'ingest',  chain: 'write',  hint: '写入链 · 一拍摄入完成' },
  'closure.drain': { label: '闭合',     node: 'closure', chain: 'write',  hint: '写入链 · 闭合节拍' },
  'summary.drain': { label: '摘要',     node: 'summary', chain: 'write',  hint: '写入链 · 摘要节拍' },
  'memory.drain':  { label: '记忆投影', node: 'memory',  chain: 'write',  hint: '写入链 · 记忆投影' },
  'tool.call':     { label: '工具调用', node: 'tool',    chain: 'read',   hint: '读出链 · 工具调用结束' },
  'loop.error':    { label: '节拍异常', node: null,      chain: 'system', hint: '后台节拍失败（已隔离）' },
  'chat.turn':     { label: '对话轮',   node: null,      chain: 'reserved', hint: '枚举保留位（本刀不发射）' },
};

export function kindMeta(kind) {
  return KIND_META[kind] || null;
}

/** 写入链节点顺序（示意图用） */
export const WRITE_NODES = [
  { key: 'ingest',  kind: 'ingest.turn',   label: '摄入' },
  { key: 'closure', kind: 'closure.drain', label: '闭合' },
  { key: 'summary', kind: 'summary.drain', label: '摘要' },
  { key: 'memory',  kind: 'memory.drain',  label: '记忆投影' },
];

/** 全局状态 */
export const store = {
  /** 当前实例 id（bootId，重启即变） */
  bootId: null,
  /** 内核进程启动时间（ms epoch） */
  startedAt: 0,
  /** /api/status 快照（含 bootId/startedAt/engine/checkpoint/counts/...） */
  status: null,
  /** 记忆索引聚合计数；null = 未就绪（503） */
  memory: null,
  /** 引导对象里的默认通道 */
  channel: '',
  /** 连接状态：init | live | retrying | lost */
  connection: 'init',
  /** 会话内各 kind 计数与最近时间（由活动驱动，服务端环形缓冲之外的本会话观测） */
  sessionCounts: {},
  lastAt: {},
  /** 最近一次 loop.error：{ phase, message, count, at, seq } */
  lastError: null,
  /** 告警条是否被用户忽略（按 seq 记） */
  alertDismissedSeq: -1,
};

export function observeActivity(a) {
  if (!a || typeof a !== 'object') return;
  const kind = a.kind;
  store.sessionCounts[kind] = (store.sessionCounts[kind] || 0) + 1;
  store.lastAt[kind] = typeof a.at === 'number' ? a.at : Date.now();
  if (kind === 'loop.error') {
    const prev = store.lastError;
    store.lastError = {
      phase: a.data?.phase || 'unknown',
      message: a.data?.message || a.message || '',
      count: (prev?.count || 0) + 1,
      at: store.lastAt[kind],
      seq: typeof a.seq === 'number' ? a.seq : -1,
    };
  }
}

/** 记忆聚合字段是否齐备 */
export function memoryCounts(memory) {
  if (!memory || typeof memory !== 'object') return null;
  return {
    cards: memory.cards ?? null,
    activeCards: memory.activeCards ?? null,
    invalidCards: memory.invalidCards ?? null,
    supersededCards: memory.supersededCards ?? null,
    aliases: memory.aliases ?? null,
    sensitiveAliases: memory.sensitiveAliases ?? null,
    misses: memory.misses ?? null,
  };
}
