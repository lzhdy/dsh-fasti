/**
 * WP4b DSH 真机工具注册薄壳（全仓唯一 import @deepseek-ai/dsh-tools 的运行时模块）。
 *
 * 薄壳不含任何记忆业务逻辑，只做宿主特定的形状映射与状态持有：
 *  1. 用 defineTool 把宿主无关的四方法 MemoryTools 包成 DSH 工具定义（字符串输出 + text 渲染，
 *     规避复杂对象 schema，模型侧只看 JSON 文本信封）；
 *  2. 会话级私有 serialMap：模型只传回序号，序号表不落库、不跨会话，每次新检索整体替换，
 *     失效即 fail-closed（serial-stale）要求重新检索，绝不猜测序号；
 *  3. 内核错误经 classifyHostMemoryError 翻译成稳定安全码，不回传堆栈/内部路径；
 *  4. getCardsByAnchor 结果逐张过 N14 白名单投影。
 *
 * 依赖方向：本模块 → assembly（宿主无关）→ memory；绝不反向 import memory/*，
 * 以满足 M6 实时链路墙与 WP4b 宿主包边界门。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import {
  classifyHostMemoryError,
  openAssembledMemoryTools,
  projectCardForHost,
} from '../../assembly/host-tool-runtime.ts';
import type { GatedSearchView, MemoryGateMode } from '../../assembly/memory-tools.ts';
import type { SourceLookupPort } from '../../assembly/source-lookup.ts';

/** 四个模型可见记忆工具的注册名（snake_case，统一前缀避免与宿主/其它插件撞名）。 */
export const MEMORY_TOOL_NAMES = {
  gatedSearch: 'fasti_memory_search',
  cardsByAnchor: 'fasti_memory_cards_by_anchor',
  resolvePointer: 'fasti_memory_resolve_pointer',
  addMissAlias: 'fasti_memory_add_alias',
} as const;

/** 薄壳所需的最小工具注册面（ctx.tools 的结构化子集，便于离线假实现测试）。 */
export interface DshToolRegistry {
  register(definition: ToolDefinition): () => void;
}

export interface DshMemoryBridge {
  /** 四个 defineTool 产物，供 ctx.tools.register 逐个注册。 */
  readonly definitions: readonly ToolDefinition[];
  /** 关闭底层窄柄（幂等）。 */
  dispose(): Promise<void>;
}

export interface OpenDshMemoryBridgeInput {
  readonly indexDir: string;
  readonly mode: MemoryGateMode;
  readonly now?: () => number;
  /**
   * L6 注入的只读下钻端口（#114 E.4.1）。 additive 可选：通道二工具消费接线前缺省为 null；
   * 绑定后随装配运行面一同生命周期管理，不持额外资源。
   */
  readonly sourceLookup?: SourceLookupPort;
}

/** 统一成功信封（canonical 为字符串，output.schema=string）。 */
function envelopeOk(data: unknown): string {
  return JSON.stringify({ ok: true, data });
}

/** 统一失败信封：仅稳定码 + 固定安全文案。 */
function envelopeFail(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

/**
 * 构造四个 DSH 记忆工具定义并打开底层宿主无关运行面。
 * 不直接触碰 cordis Context；注册动作见 registerMemoryToolDefinitions，由 plugin 接线。
 */
export function openDshMemoryBridge(input: OpenDshMemoryBridgeInput): DshMemoryBridge {
  const runtime = openAssembledMemoryTools({
    indexDir: input.indexDir,
    mode: input.mode,
    now: input.now ?? (() => Date.now()),
    ...(input.sourceLookup === undefined ? {} : { sourceLookup: input.sourceLookup }),
  });

  // 会话级私有序号表：仅短期闭包持有，不 JSON 化、不落库、不跨会话；每次 gatedSearch 整体替换。
  let serialMap: GatedSearchView['serialMap'] | null = null;

  const gatedSearch = defineTool({
    name: MEMORY_TOOL_NAMES.gatedSearch,
    description:
      'Search long-term memory with a keyword under the correctness gate. Returns gated candidates with private serial numbers; pass the serials to the resolve tool to pin card ids. '
      + '观测期检索不可用：影子试运行（shadow）态本工具恒定返回 observing 空信封，不产出任何候选，仅内部记录无原文观测。',
    parameters: {
      text: { type: 'string', required: true, description: 'Search keyword or phrase.' },
      limit: { type: 'number', description: 'Optional maximum number of candidates.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const view = await runtime.tools.gatedSearch({
          text: String(args.text),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        // 每次检索整体替换私有序号表，旧序号立即失效。
        serialMap = view.serialMap;
        return envelopeOk({
          status: view.status,
          ...(view.reason === undefined ? {} : { reason: view.reason }),
          // GatedCardView 本身已是白名单 DTO，不含 serialMap/敏感列；信封不再携带 source 双形态键。
          cards: view.cards,
        });
      } catch (error) {
        const kind = classifyHostMemoryError(error);
        return envelopeFail(kind.code, kind.message);
      }
    },
  });

  const cardsByAnchor = defineTool({
    name: MEMORY_TOOL_NAMES.cardsByAnchor,
    description:
      'Fetch the safe detail view of memory cards anchored to one experience id. Only whitelased display fields are returned; internal aliases and sensitive terms are never exposed.',
    parameters: {
      experienceId: { type: 'string', required: true, description: 'The experience/anchor id to look up.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const cards = runtime.tools.getCardsByAnchor(String(args.experienceId));
        const safe: unknown = cards.map(projectCardForHost);
        return envelopeOk(safe);
      } catch (error) {
        const kind = classifyHostMemoryError(error);
        return envelopeFail(kind.code, kind.message);
      }
    },
  });

  const resolvePointer = defineTool({
    name: MEMORY_TOOL_NAMES.resolvePointer,
    description:
      'Resolve private serial numbers from the latest search result into stable card ids. Serial numbers are per-request and expire after any new search; a stale serial means you must search again.',
    parameters: {
      serials: {
        type: 'array',
        required: true,
        description: 'Private serial numbers returned by the most recent search.',
        items: { type: 'integer' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (serialMap === null) {
        return envelopeFail(
          'serial-context-missing',
          'No candidate list in this session yet. Call the search tool first, then resolve the serials it returns.',
        );
      }
      try {
        const resolved = runtime.tools.resolvePointer({ serials: args.serials, serialMap });
        return envelopeOk({ cardIds: [...resolved.cardIds] });
      } catch (error) {
        const kind = classifyHostMemoryError(error);
        return envelopeFail(kind.code, kind.message);
      }
    },
  });

  const addMissAlias = defineTool({
    name: MEMORY_TOOL_NAMES.addMissAlias,
    description:
      'Record a missed alias term for an existing card when the search failed to surface it. Only effective when the gate mode is on; otherwise the request is deferred and changes nothing.',
    parameters: {
      term: { type: 'string', required: true, description: 'The alias term that missed.' },
      cardId: { type: 'string', required: true, description: 'The target card id.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const view = runtime.tools.addMissAlias({ term: String(args.term), cardId: String(args.cardId) });
        return envelopeOk(view);
      } catch (error) {
        const kind = classifyHostMemoryError(error);
        return envelopeFail(kind.code, kind.message);
      }
    },
  });

  return {
    definitions: [gatedSearch, cardsByAnchor, resolvePointer, addMissAlias],
    dispose: runtime.dispose,
  };
}

/**
 * 把四个工具定义注册到 DSH tools 服务，聚合返回的注销函数为单个 disposer。
 * 幂等：重复调用返回的 disposer 不会重复注销。
 */
export function registerMemoryToolDefinitions(
  registry: DshToolRegistry,
  definitions: readonly ToolDefinition[],
): () => void {
  const unregisterFns = definitions.map((definition) => registry.register(definition));
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const unregister of unregisterFns) unregister();
  };
}

/** plugin 接线入参：registry 为 null 表示宿主未装载 tools 服务（运行时可能缺失）。 */
export interface WireMemoryToolsInput {
  readonly registry: DshToolRegistry | null;
  readonly mode: MemoryGateMode;
  readonly indexDir: string;
  /** L6 只读下钻端口（#114 E.4.1）；透传至桥接与装配层，缺省 null。 */
  readonly sourceLookup?: SourceLookupPort;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/** 一次接线的生命周期句柄。 */
export interface MemoryWiring {
  /** 是否真正注册了工具（off 或无 tools 服务时为 false）。 */
  readonly registered: boolean;
  /** 先注销工具再关闭底层窄柄；幂等。 */
  dispose(): Promise<void>;
}

const noopWiringDispose: MemoryWiring['dispose'] = async () => undefined;

/**
 * plugin 生命周期内的记忆工具接线编排（宿主无关之外、与 cordis 接触的最后一公里）。
 *
 * 安全阶梯：
 *  - mode='off'（默认）：不打开桥接、不注册任何工具，未显式开启时线上行为零变化；
 *  - registry=null（宿主无 tools 服务）：安全跳过并留日志，门控工具不接线；
 *  - 'shadow'/'on'：打开桥接并注册四工具；shadow 对外恒定 observing 空信封（仅旁路影子观测），
 *    on 态门控召回才真正生效。
 */
export function wireMemoryTools(input: WireMemoryToolsInput): MemoryWiring {
  if (input.mode === 'off') {
    return { registered: false, dispose: noopWiringDispose };
  }
  if (input.registry === null) {
    input.log?.(
      '记忆门已配置开启但宿主未提供 tools 服务，本次跳过记忆工具注册（门控工具不接线）',
    );
    return { registered: false, dispose: noopWiringDispose };
  }

  const bridge = openDshMemoryBridge({
    indexDir: input.indexDir,
    mode: input.mode,
    ...(input.sourceLookup === undefined ? {} : { sourceLookup: input.sourceLookup }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const unregisterAll = registerMemoryToolDefinitions(input.registry, bridge.definitions);

  let disposed = false;
  return {
    registered: true,
    async dispose() {
      if (disposed) return;
      disposed = true;
      unregisterAll();
      await bridge.dispose();
    },
  };
}
