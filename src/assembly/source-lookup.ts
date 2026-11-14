/**
 * sourceLookupPort —— 通道二只读下钻端口（#114 附录 E.4.1）。
 *
 * 取代被拆除的绕门 legacySearch，承接通道二第②③跳：
 *  ② anchor id → 经历摘要窄 DTO（ExperienceSummaryView，白名单投影，无原文）；
 *  ③ Pointer → 原文行窄 DTO（RawTurnView，复用门面既有 ResolvedPointer 契约）。
 *
 * 结构墙（与 topology-removal 红测一一对应）：
 *  - 本文件是端口消费的唯一宿主无关落点；memory-tools.ts 的 import 图不得出现本模块；
 *  - 不 import api/* 与任何宿主包：工厂只认结构型最小立面 SourceLookupFacade，由 L6 适配层把
 *    Fasti 实例结构性注入，依赖方向保持 L6→L5→契约，装配层永不反向依赖门面；
 *  - 不 import node:fs/node:sqlite、不自建数据库写柄、不做候选预切片（M6 门不放宽）；
 *  - 入参只有 anchor id 与 Pointer，不接受自由文本；DTO 与 GatedCardView 结构隔离、双向不可赋值。
 */

import type {
  Experience,
  ExperienceSummaryView,
  Pointer,
  RawTurnView,
} from '../contract/experience.ts';
import type { ResolvedPointer } from '../contract/primitives.ts';
import type { CountScope } from '../memory/types.ts';

export type { CountScope, ExperienceSummaryView, Pointer, RawTurnView };

/** 摘要 DTO 白名单键集（定死，isExperienceSummaryView 据此拒绝多余/缺失字段）。 */
const SUMMARY_KEYS = readonlyKeys([
  'id',
  'kind',
  'scene',
  'initiation',
  'occurredAt',
  'recordedAt',
  'tick',
  'cue',
]);

/** 原文行 DTO 白名单键集。 */
const RAW_TURN_KEYS = readonlyKeys(['channel', 'shard', 'seq', 'eventId', 'rawText']);

function readonlyKeys<const T extends readonly string[]>(keys: T): ReadonlySet<string> {
  return new Set<string>(keys);
}

/**
 * 经历 → 摘要窄 DTO 的纯投影：只挑白名单字段，cue 缺失归一为 null。
 * 不复制 observation/action/outcome/指针/char_count/marks 等任何槽位，无 IO、可离线复现。
 */
export function projectExperienceSummary(experience: Experience): ExperienceSummaryView {
  return {
    id: experience.id,
    kind: experience.kind,
    scene: experience.scene,
    initiation: experience.initiation,
    occurredAt: experience.occurred_at,
    recordedAt: experience.recorded_at,
    tick: experience.tick,
    cue: experience.observation.cue ?? null,
  };
}

/**
 * 运行期形状守卫：非对象/缺 id/键集不精确/字段类型不符一律拒绝，不静默放行。
 * 刻意要求键集与白名单逐字相等——多余字段（哪怕长得像 DTO）也是结构污染，挡在端口边界。
 */
export function isExperienceSummaryView(value: unknown): value is ExperienceSummaryView {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== SUMMARY_KEYS.size || keys.some((key) => !SUMMARY_KEYS.has(key))) return false;
  return (
    typeof record.id === 'string' &&
    typeof record.kind === 'string' &&
    isScene(record.scene) &&
    typeof record.initiation === 'string' &&
    typeof record.occurredAt === 'string' &&
    typeof record.recordedAt === 'string' &&
    typeof record.tick === 'number' &&
    (record.cue === null || typeof record.cue === 'string')
  );
}

function isScene(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const scene = value as Record<string, unknown>;
  return (
    typeof scene.channel === 'string' &&
    typeof scene.ref === 'string' &&
    (scene.detail === undefined ||
      (typeof scene.detail === 'object' && scene.detail !== null && !Array.isArray(scene.detail)))
  );
}

/** 门面 ResolvedPointer 的 snake_case 行 → 端口 camelCase 窄 DTO（单条原文行最小面）。 */
function projectRawTurn(turn: ResolvedPointer['turns'][number]): RawTurnView {
  return {
    channel: turn.channel,
    shard: turn.shard,
    seq: turn.seq,
    eventId: turn.event_id,
    rawText: turn.raw_text,
  };
}

/**
 * 端口立面：仅两项只读能力。
 * summaryByAnchor 返回 null 表示锚点无对应经历（不抛、不造空对象）；
 * 返回类型不含卡片/候选/别名，类型层封死"以下钻之名行召回之实"。
 */
export interface SourceLookupPort {
  summaryByAnchor(anchorId: string): Promise<ExperienceSummaryView | null>;
  resolveRawText(pointer: Pointer): Promise<readonly RawTurnView[]>;
}

/**
 * 工厂所需的最小结构立面：由 L6 适配层用门面实例结构性满足。
 * 本模块不 import 门面类型，Fasti 只要具名形状匹配即可注入，M6 依赖墙不出现例外。
 */
export interface SourceLookupFacade {
  readExperienceById(id: string): Promise<ExperienceSummaryView | null>;
  resolvePointer(pointer: Pointer): Promise<ResolvedPointer>;
}

/**
 * 由 L6 注入构造只读端口：第②跳直通门面窄 DTO；第③跳经门面既有原文解析后做纯字段投影。
 * 端口自身不持库柄、不打开文件、不缓存正文。
 */
export function createSourceLookupPort(facade: SourceLookupFacade): SourceLookupPort {
  return {
    summaryByAnchor(anchorId: string): Promise<ExperienceSummaryView | null> {
      return facade.readExperienceById(anchorId);
    },
    async resolveRawText(pointer: Pointer): Promise<readonly RawTurnView[]> {
      const resolved = await facade.resolvePointer(pointer);
      return resolved.turns.map(projectRawTurn);
    },
  };
}

// RAW_TURN_KEYS 供后续通道二接线测试/审计复用，显式标记为端口契约的一部分。
export const SOURCE_LOOKUP_CONTRACT = {
  summaryKeys: SUMMARY_KEYS,
  rawTurnKeys: RAW_TURN_KEYS,
} as const;
