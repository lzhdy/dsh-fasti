/**
 * 宿主无关记忆工具集内核（第二层 v0.3 §7/§8，WP4a；#114 拆除绕门支路后的唯一检索入口）。
 *
 * 这是四工具的**可离线测试纯内核**：不 import node:fs/node:sqlite、不持任何文件句柄，
 * 窄柄、影子落点、时钟全部经构造参数注入；真机 cordis/dsh-llm 注册（WP4b）只包薄壳。
 *
 * 三态灰度（v0.3 §8.1，#114 E.4.1 拆除后口径）：
 *  - off：接线层（wireMemoryTools）根本不注册工具，生产环境无任何 gatedSearch 调用路径；
 *    内核仍保留 fail-closed 兜底——若被离线直接构造并调用，抛 UnavailableError 而非返回候选；
 *  - shadow：注册工具以获得真实查询流量，但对外恒定返回形状定死的 observing 空信封
 *    （status='observing'、cards=[]、serialMap=空 Map，见设计正本 7.2），内部完整空跑一次
 *    门做对照，写一条无原文观测到注入影子落点；门或影子落点的任何异常都被隔离，绝不阻断主链路；
 *    窄柄未就绪（handle=null）时同样回 observing 空信封，只是不写观测、不抛错；
 *  - on：唯一召回路径走窄柄 + 布尔门；生产别名写仅在此态生效，off/shadow 的卡写返回 deferred。
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
  CountScope,
  GatedSearchOutcome,
  GatedStatus,
  MemoryCard,
  SerialMap,
} from '../memory/types.ts';
import type { RuntimeMemoryHandle, RuntimeSearchQuery } from '../memory/runtime.ts';

/** 功能开关三态（默认 off 由宿主配置决定，内核不内置默认值以外的状态分支）。 */
export type MemoryGateMode = 'off' | 'shadow' | 'on';

/**
 * 影子事实（内存态，传给注入落点）：带**已规范化**词面 termNorm 而非原始查询，
 * 以及客观计数/口径/原因码/时刻，无正文。装配层不计算哈希——term_hash 由 memory 侧窄原语内部计算。
 * 落点契约（N16）：实现方**不得持久化 termNorm 或原始查询**，只能用于内部 sha256 后丢弃。
 *
 * 注（#114 E.4.2 更名已落）：candidateCount 恒为门过滤前全集（outcome.candidateCount），
 * countScope 恒为 'gated-full'；被 limit 截断的旧计数来源已随旧路一并拆除，不再存在。
 */
export interface ShadowFact {
  readonly termNorm: string;
  readonly candidateCount: number;
  readonly countScope: CountScope;
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

/**
 * 工具统一返回形状（#114 拆除后单形态）：
 *  - on：门裁决状态 hit/abstain/no-match + 过门卡视图；
 *  - shadow：恒定 observing 空信封（7.2 DTO 定死，无 source 双形态键）。
 */
export interface GatedSearchView {
  readonly status: GatedStatus | 'observing';
  readonly cards: readonly GatedCardView[];
  readonly reason?: string;
  readonly serialMap: SerialMap;
}

/** 卡写回包：不回显 sensitive；门未开时为 deferred（生产未写）。 */
export type AddMissAliasView =
  | { readonly ok: true; readonly changed: boolean; readonly cardId: string; readonly termNorm: string }
  | { readonly ok: false; readonly reason: string; readonly cardId: string; readonly termNorm: string }
  | { readonly deferred: true; readonly mode: MemoryGateMode; readonly reason: 'gate-not-on' };

/** 序号解析结果：只返回经严格反查的 cardId，真源内容下钻走只读 sourceLookupPort（E.4.1）。 */
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
  /** 运行期窄柄；索引库未就绪时为 null（门工具显式不可用，shadow 回空信封、off 兜底抛错）。 */
  readonly handle: RuntimeMemoryHandle | null;
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
    status: outcome.status,
    cards,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    serialMap: outcome.serialMap,
  };
}

/**
 * shadow 态对外空信封（7.2 形状定死）：observing + 空卡 + 空序号表；
 * 不携带 source 键或任何候选，reason 留空（观测期检索不可用由工具 description 显式声明）。
 */
function observingView(): GatedSearchView {
  return { status: 'observing', cards: [], serialMap: new Map<number, string>() };
}

/**
 * 影子对照：跑一次与 on 态**同参**的门（含 limit），落一条无原文观测。
 * 传 limit 是口径要求：acceptedCount 必须与真实 on 响应一致（limit 只截断 accepted，
 * candidateCount 恒为门过滤前全集）；不传会让影子系统性高报过门数（S4 因果对照）。
 * 任何异常就地吞掉——影子是旁路，失败只意味着少一条观测，绝不影响主链路。
 */
async function runShadowObservation(
  deps: CreateMemoryToolsDeps,
  text: string,
  atMs: number,
  limit?: number,
): Promise<void> {
  if (deps.handle === null) {
    return;
  }
  try {
    const query: RuntimeSearchQuery = { text, atMs };
    const outcome = await runGatedSearch(deps.handle, query, limit);
    // 只传规范化词面；哈希与落盘归 memory 侧窄原语，装配层不持有哈希口径、也不接触文件系统。
    const fact: ShadowFact = {
      termNorm: normalizeLexicalText(text),
      // 口径：门过滤前全集长度（截断只作用于 accepted，见 gate.applyGate）。
      candidateCount: outcome.candidateCount,
      countScope: 'gated-full',
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
      throw new UnavailableError('记忆索引未就绪：门控检索工具暂不可用');
    }
    return deps.handle;
  };

  return {
    async gatedSearch(input: { text: string; limit?: number }): Promise<GatedSearchView> {
      const atMs = deps.now();

      // off 态工具在接线层即不注册；内核兜底 fail-closed，绝不构造任何候选返回。
      if (deps.mode === 'off') {
        throw new UnavailableError('记忆门处于 off 态：门控检索工具不接线，无召回结果可用');
      }

      // shadow：对外恒定 observing 空信封；内部空跑分流门并旁路写观测（窄柄缺失则只回空信封）。
      if (deps.mode === 'shadow') {
        await runShadowObservation(deps, input.text, atMs, input.limit);
        return observingView();
      }

      // on：门控检索是唯一召回路径。
      const handle = requireHandle();
      const outcome = await runGatedSearch(handle, { text: input.text, atMs }, input.limit);
      return toGateView(outcome);
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
