/**
 * 通道描述符 —— 定案稿 §4.6。
 *
 * 接入新来源三步、零核心改动：
 *  1. 在 channels.json 注册描述符（声明模态与采集策略）；
 *  2. 适配器把该通道原始事件翻写为统一 Experience；
 *  3. （可选）声明 staging 缓冲。
 *
 * 核心对通道的全部假设：能产出 Experience、能给出 (id, occurred_at)。
 */

export const CAPTURE_STRATEGIES = ['full', 'notice', 'reference-only'] as const;
export type CaptureStrategy = (typeof CAPTURE_STRATEGIES)[number];

export const KNOWN_MODALITIES = ['text', 'image', 'audio', 'video', 'file', 'event'] as const;

export const KNOWN_COUNTERPARTS = ['user', 'person', 'group', 'world', 'system'] as const;
export type Counterpart = (typeof KNOWN_COUNTERPARTS)[number];

/** 通道描述符。 */
export interface ChannelDescriptor {
  /** 'dsh' | 'qq' | 'browser' | 'camera' | …（开放）。 */
  id: string;
  /** 人读名。 */
  label: string;
  /** 'text'|'image'|'audio'|'video'|'file'|'event'（开放）。 */
  modalities: string[];
  /** 采集策略声明：可审计。 */
  capture: CaptureStrategy;
  /** 声明暂存缓冲能力与窗口。 */
  staging?: { retention_days?: number };
  /** 对端类型（B 用）。 */
  counterpart?: Counterpart;
  adapter_version: string;
}

/** 首次初始化时预置的 dsh 描述符（审计口径 8）。 */
export const DEFAULT_DSH_DESCRIPTOR: ChannelDescriptor = {
  id: 'dsh',
  label: 'DSH 对话',
  modalities: ['text', 'image', 'file', 'event'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: '0.1.0',
};

/** 校验通道描述符。 */
export function parseChannelDescriptor(raw: unknown, at = 'channel'): ChannelDescriptor {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError(`${at} 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;

  const id = obj['id'];
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`${at}.id 必须是非空字符串`);
  }

  const label = obj['label'];
  if (typeof label !== 'string' || label === '') {
    throw new TypeError(`${at}.label 必须是非空字符串`);
  }

  const modalities = obj['modalities'];
  if (!Array.isArray(modalities) || modalities.some((m) => typeof m !== 'string')) {
    throw new TypeError(`${at}.modalities 必须是字符串数组`);
  }

  const capture = obj['capture'];
  if (typeof capture !== 'string' || !(CAPTURE_STRATEGIES as readonly string[]).includes(capture)) {
    throw new TypeError(`${at}.capture 必须是 ${CAPTURE_STRATEGIES.join(' | ')} 之一`);
  }

  const adapterVersion = obj['adapter_version'];
  if (typeof adapterVersion !== 'string' || adapterVersion === '') {
    throw new TypeError(`${at}.adapter_version 必须是非空字符串`);
  }

  const descriptor: ChannelDescriptor = {
    id,
    label,
    modalities: modalities as string[],
    capture: capture as CaptureStrategy,
    adapter_version: adapterVersion,
  };

  const staging = obj['staging'];
  if (staging !== undefined) {
    if (typeof staging !== 'object' || staging === null || Array.isArray(staging)) {
      throw new TypeError(`${at}.staging 必须是对象`);
    }
    const retention = (staging as Record<string, unknown>)['retention_days'];
    if (retention !== undefined) {
      if (typeof retention !== 'number' || !Number.isFinite(retention) || retention < 0) {
        throw new TypeError(`${at}.staging.retention_days 必须是非负数`);
      }
      descriptor.staging = { retention_days: retention };
    }
  }

  const counterpart = obj['counterpart'];
  if (counterpart !== undefined) {
    if (typeof counterpart !== 'string' || !(KNOWN_COUNTERPARTS as readonly string[]).includes(counterpart)) {
      throw new TypeError(`${at}.counterpart 必须是 ${KNOWN_COUNTERPARTS.join(' | ')} 之一`);
    }
    descriptor.counterpart = counterpart as Counterpart;
  }

  return descriptor;
}
