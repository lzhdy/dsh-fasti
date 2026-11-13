/**
 * 宿主无关记忆工具集内核（第二层 v0.3 §7/§8，WP4a）。
 *
 * 这是四工具的**可离线测试纯内核**：不 import node:fs/node:sqlite、不持任何文件句柄，
 * 窄柄、旧路检索、影子落点、时钟全部经构造参数注入；真机 cordis/dsh-llm 注册（WP4b）只包薄壳。
 *
 * 三态灰度（v0.3 §8.1）：
 *  - off：主返回完全走注入的旧路检索，不触窄柄门、不写影子，行为与引入门前逐字一致；
 *  - shadow：主返回仍旧路（对外零扰动），旁路跑一次门做对照，写一条无原文观测到注入影子落点；
 *    门或影子落点的任何异常都被隔离，绝不阻断主链路；
 *  - on：主返回走窄柄 + 布尔门；生产别名写仅在此态生效，off/shadow 的卡写返回 deferred、不落生产。
 *
 * N14：对外 DTO 只投影安全字段（cardId/序号/锚点/线索/门原因），绝不回显 sensitive、
 * 内部别名列名、contentHash 或原始查询文本。
 * 时钟：atMs 只取注入的 now()，本文件不出现 Date.now()/Math.random()，线上行为可离线复现。
 */

import { UnavailableError } from '../core/errors.ts';
import { normalizeLexicalText } from '../memory/gate.ts';
import { resolveSerials } from '../memory/serial.ts';
import { runGatedSearch } from './index.ts';
import type {
  GatedSearchOutcome,
  GatedStatus,
  MemoryCard,
  SerialMap,
} from '../memory/types.ts';
import type { RuntimeMemoryHandle, RuntimeSearchQuery } from '../memory/runtime.ts';

/** 功能开关三态（默认 off 由宿主配置决定，内核不内置默认值以外的状态分支）。 */
export type MemoryGateMode = 'off' | 'shadow' | 'on';

/** 旧路检索命中（对齐既有 contract SearchHit 的最小安全形状）。 */
export interface LegacyHit {
  readonly id: string;
  readonly kind: string;
  readonly channel: string;
  readonly snippet: string;
}

/** 旧路检索端口（WP4b 由宿主绑定 Fasti.search，内核不 import 门面，避免反向依赖）。 */
export type LegacySearch = (query: {
  text: string;
  atMs: number;
  limit?: number;
}) => Promise<readonly LegacyHit[]>;

/**
 * 影子事实（内存态，传给注入落点）：带**已规范化**词面 termNorm 而非原始查询，
 * 以及客观计数/原因码/时刻，无正文。装配层不计算哈希——term_hash 由 memory 侧窄原语内部计算。
 * 落点契约（N16）：实现方**不得持久化 termNorm 或原始查询**，只能用于内部 sha256 后丢弃。
 */
export interface ShadowFact {
  readonly termNorm: string;
  readonly legacyCount: number;
  readonly gatedStatus: GatedStatus;
  readonly acceptedCount: number;
  readonly rejectedReasonCodes: readonly string[];
  readonly atMs: number;
}

/** 影子落点端口（WP4b 绑定窄柄 recordShadowObservation；其 JSONL 落 memory-shadow，termNorm 不落盘）。 */
export interface ShadowSink {
  record(fact: ShadowFact): void;
}

/** 对外安全卡视图（N14：白名单挑字段，无 sensitive/内部列/原文查询）。 */
export interface GatedCardView {
  readonly cardId: string;
  readonly serial: number;
  readonly anchorIds: readonly string[];
  readonly displayCues: readonly string[];
  readonly gateReasons: readonly string[];
}

/** 工具统一返回形状：source 标明来自旧路还是门。 */
export interface GatedSearchView {
  readonly source: 'legacy' | 'gate';
  readonly status: GatedStatus | 'legacy-ok';
  readonly cards: readonly GatedCardView[];
  readonly reason?: string;
  readonly serialMap: SerialMap;
}

/** 卡写回包：不回显 sensitive；门未开时为 deferred（生产未写）。 */
export type AddMissAliasView =
  | { readonly ok: true; readonly changed: boolean; readonly cardId: string; readonly termNorm: string }
  | { readonly ok: false; readonly reason: string; readonly cardId: string; readonly termNorm: string }
  | { readonly deferred: true; readonly mode: MemoryGateMode; readonly reason: 'gate-not-on' };

/** 序号解析结果：只返回经严格反查的 cardId，真源内容下钻留宿主门面（WP4b）。 */
export interface ResolvedPointers {
  readonly cardIds: readonly string[];
}

export interface MemoryTools {
  gatedSearch(input: { text: string; limit?: number }): Promise<GatedSearchView>;
  getCardsByAnchor(experienceId: string): MemoryCard[];
  resolvePointer(input: { serials: readonly number[]; serialMap: SerialMap }): ResolvedPointers;
  addMissAlias(input: { term: string; cardId: string }): AddMissAliasView;
}

export interface CreateMemoryToolsDeps {
  readonly mode: MemoryGateMode;
  /** 注入时钟（毫秒）；内核不直接读系统时钟。 */
  readonly now: () => number;
  /** 运行期窄柄；索引库未就绪时为 null（旧路仍可用，门工具显式不可用）。 */
  readonly handle: RuntimeMemoryHandle | null;
  readonly legacySearch: LegacySearch;
  readonly sink: ShadowSink;
}

function parseStringArray(json: string): readonly string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as string[]) : [];
}

/** 门结果 → 安全 DTO（逐字段白名单投影）。 */
function toGateView(outcome: GatedSearchOutcome): GatedSearchView {
  const serialOf = new Map<string, number>();
  for (const [serial, cardId] of outcome.serialMap) {
    serialOf.set(cardId, serial);
  }
  const cards: GatedCardView[] = outcome.accepted.map((gated) => ({
    cardId: gated.card.cardId,
    serial: serialOf.get(gated.card.cardId) ?? 0,
    anchorIds: parseStringArray(gated.card.anchorJson),
    displayCues: parseStringArray(gated.card.displayCuesJson),
    gateReasons: [...gated.gateReasons],
  }));
  return {
    source: 'gate',
    status: outcome.status,
    cards,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    serialMap: outcome.serialMap,
  };
}

/** 旧路命中 → 同一 DTO 形状（无锚点/线索/门原因，序号按返回次序 1..n 私有编排）。 */
function toLegacyView(hits: readonly LegacyHit[]): GatedSearchView {
  const cards: GatedCardView[] = hits.map((hit, index) => ({
    cardId: hit.id,
    serial: index + 1,
    anchorIds: [],
    displayCues: [],
    gateReasons: [],
  }));
  const serialMap: SerialMap = new Map(hits.map((hit, index) => [index + 1, hit.id]));
  return { source: 'legacy', status: 'legacy-ok', cards, serialMap };
}

/**
 * 影子对照：跑一次全集门（不传 limit，观测门的完整裁决），落一条无原文观测。
 * 任何异常就地吞掉——影子是旁路，失败只意味着少一条观测，绝不影响主链路。
 */
async function runShadowObservation(
  deps: CreateMemoryToolsDeps,
  text: string,
  atMs: number,
  legacyCount: number,
): Promise<void> {
  if (deps.handle === null) {
    return;
  }
  try {
    const query: RuntimeSearchQuery = { text, atMs };
    const outcome = await runGatedSearch(deps.handle, query);
    // 只传规范化词面；哈希与落盘归 memory 侧窄原语，装配层不持有哈希口径、也不接触文件系统。
    const fact: ShadowFact = {
      termNorm: normalizeLexicalText(text),
      legacyCount,
      gatedStatus: outcome.status,
      acceptedCount: outcome.accepted.length,
      rejectedReasonCodes: outcome.rejected.flatMap((gated) => gated.gateReasons),
      atMs,
    };
    deps.sink.record(fact);
  } catch {
    // 失败隔离：刻意不重抛、不静默伪造数据；宿主若需可观测性由其 sink 实现自行记录。
  }
}

export function createMemoryTools(deps: CreateMemoryToolsDeps): MemoryTools {
  const requireHandle = (): RuntimeMemoryHandle => {
    if (deps.handle === null) {
      throw new UnavailableError('记忆索引未就绪：门工具暂不可用，旧路检索不受影响');
    }
    return deps.handle;
  };

  return {
    async gatedSearch(input: { text: string; limit?: number }): Promise<GatedSearchView> {
      const atMs = deps.now();

      if (deps.mode === 'on') {
        const handle = requireHandle();
        const outcome = await runGatedSearch(handle, { text: input.text, atMs }, input.limit);
        return toGateView(outcome);
      }

      // off 与 shadow 的主返回都是旧路（shadow 额外旁路对照）。
      const legacyHits = await deps.legacySearch({ text: input.text, atMs, limit: input.limit });
      if (deps.mode === 'shadow') {
        await runShadowObservation(deps, input.text, atMs, legacyHits.length);
      }
      return toLegacyView(legacyHits);
    },

    getCardsByAnchor(experienceId: string): MemoryCard[] {
      return requireHandle().getCardsByAnchor(experienceId);
    },

    resolvePointer(input: { serials: readonly number[]; serialMap: SerialMap }): ResolvedPointers {
      // 复用 serial.ts 严格解析：坏序号抛 MemorySerialReferenceError，禁止猜测/顶替。
      return { cardIds: resolveSerials(input.serialMap, input.serials) };
    },

    addMissAlias(input: { term: string; cardId: string }): AddMissAliasView {
      if (deps.mode !== 'on') {
        return { deferred: true, mode: deps.mode, reason: 'gate-not-on' };
      }
      const outcome = requireHandle().addMissAlias({
        term: input.term,
        cardId: input.cardId,
        atMs: deps.now(),
      });
      if (outcome.ok) {
        return { ok: true, changed: outcome.changed, cardId: outcome.cardId, termNorm: outcome.termNorm };
      }
      return { ok: false, reason: outcome.reason, cardId: outcome.cardId, termNorm: outcome.termNorm };
    },
  };
}
