/**
 * WP4b DSH 真机工具注册薄壳（全仓唯一 import @deepseek-ai/dsh-tools 的运行时模块）。
 *
 * 薄壳不含任何记忆业务逻辑，只做宿主特定的形状映射与状态持有：
 *  1. 用 defineTool 把宿主无关的四方法 MemoryTools 包成 DSH 工具定义，并追加通道二回查两件套
 *     （共六个工具；字符串输出 + text 渲染，规避复杂对象 schema，模型侧只看 JSON 文本信封）；
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
import {
  isExperienceSummaryView,
  type SourceLookupPort,
} from '../../assembly/source-lookup.ts';

/** 六个模型可见记忆工具的注册名（snake_case，统一前缀避免与宿主/其它插件撞名）。 */
export const MEMORY_TOOL_NAMES = {
  gatedSearch: 'fasti_memory_search',
  cardsByAnchor: 'fasti_memory_cards_by_anchor',
  resolvePointer: 'fasti_memory_resolve_pointer',
  addMissAlias: 'fasti_memory_add_alias',
  experienceSummary: 'fasti_memory_experience_summary',
  rawText: 'fasti_memory_raw_text',
} as const;

/** 薄壳所需的最小工具注册面（ctx.tools 的结构化子集，便于离线假实现测试）。 */
export interface DshToolRegistry {
  register(definition: ToolDefinition): () => void;
}

export interface DshMemoryBridge {
  /** 六个 defineTool 产物（通道一四件套 + 通道二两件套），供 ctx.tools.register 逐个注册。 */
  readonly definitions: readonly ToolDefinition[];
  /** 关闭底层窄柄（幂等）。 */
  dispose(): Promise<void>;
}

export interface OpenDshMemoryBridgeInput {
  readonly indexDir: string;
  readonly mode: MemoryGateMode;
  /**
   * L6 注入的通道名（#115 E.5）：取自 plugin 已校验的 config.channel，桥接层不内置默认值；
   * 模型侧工具 schema 不含 channel 键，该值只在装配链路内部向落空台账盖章。
   */
  readonly channel: string;
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
 * 构造六个 DSH 记忆工具定义（通道一四件套 + 通道二回查两件套）并打开底层宿主无关运行面。
 * 不直接触碰 cordis Context；注册动作见 registerMemoryToolDefinitions，由 plugin 接线。
 */
export function openDshMemoryBridge(input: OpenDshMemoryBridgeInput): DshMemoryBridge {
  const runtime = openAssembledMemoryTools({
    indexDir: input.indexDir,
    mode: input.mode,
    now: input.now ?? (() => Date.now()),
    missChannel: input.channel,
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

  // ── #115 通道二回查两件套：只读、fail-closed；schema 不暴露 channel，通道一律盖注入值 ──

  const experienceSummary = defineTool({
    name: MEMORY_TOOL_NAMES.experienceSummary,
    description:
      '通道二回查（第②跳）：按经历 id 读取定案经历摘要 DTO（固定白名单键集）。'
      + '仅用于通道二回查时核对锚点元信息，不返回卡片候选、别名或原文正文；端口未注入时返回 unavailable。',
    parameters: {
      experienceId: { type: 'string', required: true, description: 'The experience/anchor id to summarize.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (input.sourceLookup === undefined) {
        return envelopeFail('unavailable', '通道二回查端口未注入，经历摘要当前不可用。');
      }
      try {
        const summary = await input.sourceLookup.summaryByAnchor(String(args.experienceId));
        if (summary === null) {
          // 查无此经历（含异通道按未找到处理的 fail-closed 情形）与成功显式分形，避免模型误读空成功。
          return envelopeFail('not-found', '该经历 id 不存在或在本通道不可见，请核对 id 或重新检索。');
        }
        if (!isExperienceSummaryView(summary)) {
          // 键集守卫：多键/缺键/脏形状一律拒收，污染 DTO 不出桥，失败信封不夹带数据。
          return envelopeFail('internal', '经历摘要返回形状校验失败，请改用普通检索。');
        }
        return envelopeOk(summary);
      } catch (error) {
        const kind = classifyHostMemoryError(error);
        return envelopeFail(kind.code, kind.message);
      }
    },
  });

  const rawText = defineTool({
    name: MEMORY_TOOL_NAMES.rawText,
    description:
      '通道二回查（第③跳）：按 Pointer（id/shard/seq；seq 为整数行号或 [起点, 上界] 闭区间）读取原文行，'
      + '返回带截断光标的信封。charOffset 是行内偏移，恒作用于本次解析结果的首行。'
      + '注意信封里的 nextSeq/nextCharOffset 不是工具参数名，续取时必须做参数映射：'
      + 'truncated=true 且 midRow=false 时，把信封的 nextSeq 作为下一次调用的 seq，并保留原区间上界组成 seq 区间；'
      + 'midRow=true 表示截断落在单行内部，下一次调用把信封的 nextSeq 作为下一次调用的 seq、'
      + '把 nextCharOffset 作为下一次调用的 charOffset 传入，从该行行内继续取。'
      + '模型侧不传 channel，通道由宿主盖章；端口未注入时返回 unavailable。',
    parameters: {
      id: { type: 'string', required: true, description: '权威条目 id。' },
      shard: { type: 'string', description: "冗余加速分片 'YYYY-MM'，可省略。" },
      seq: {
        required: true,
        description: '行号整数（从 0 起）或闭区间 [起点, 上界] 两整数数组。',
        oneOf: [
          { type: 'integer' },
          { type: 'array', items: { type: 'integer' } },
        ],
      },
      charOffset: {
        type: 'integer',
        description: '可选行内偏移（非负整数），仅 midRow 续取时传入，作用于本次解析结果的首行。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (input.sourceLookup === undefined) {
        return envelopeFail('unavailable', '通道二回查端口未注入，原文回查当前不可用。');
      }
      // 显式白名单挑键：模型私传的 channel/未知键在构造 Pointer 时天然剥离，
      // 执行体永远只收到 L6 盖章通道（不依赖宿主框架的额外参数过滤）。
      const record = (args ?? {}) as Record<string, unknown>;

      // fail-closed 形状闸：键存在但形状非法时稳定码拒绝，禁止"悄悄不带这个键"式静默降级
      //（否则 charOffset:-5 会被当成从头读、坏 seq 会被当成无 seq，模型只会原地打转）。
      const isNonNegativeInteger = (value: unknown): boolean =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0;
      if (record.charOffset !== undefined && !isNonNegativeInteger(record.charOffset)) {
        return envelopeFail('schema', 'charOffset 必须是非负整数；非法参数不做静默降级，请修正后重试。');
      }
      const seqIsInteger = typeof record.seq === 'number' && Number.isInteger(record.seq);
      const seqIsInterval = Array.isArray(record.seq)
        && record.seq.length === 2
        && record.seq.every((entry) => typeof entry === 'number' && Number.isInteger(entry));
      if (!seqIsInteger && !seqIsInterval) {
        return envelopeFail('schema', 'seq 必须是整数行号，或恰好两个整数组成的闭区间数组。');
      }

      // 本地用可变形状累积白名单键，收口时结构可直接赋给只读 LookupPointer。
      const pointer: {
        channel: string;
        id?: string;
        shard?: string;
        seq?: number | [number, number];
        charOffset?: number;
      } = { channel: input.channel };
      if (typeof record.id === 'string') pointer.id = record.id;
      if (typeof record.shard === 'string') pointer.shard = record.shard;
      if (seqIsInteger) {
        pointer.seq = record.seq as number;
      } else {
        // 走到这里 seqIsInterval 已为真（形状非法的分支前面已 envelopeFail 退出）。
        const interval = record.seq as [number, number];
        pointer.seq = [interval[0], interval[1]];
      }
      if (record.charOffset !== undefined) {
        pointer.charOffset = record.charOffset as number;
      }
      try {
        const view = await input.sourceLookup.resolveRawText(pointer);
        return envelopeOk(view);
      } catch (error) {
        const kind = classifyHostMemoryError(error);
        return envelopeFail(kind.code, kind.message);
      }
    },
  });

  return {
    definitions: [gatedSearch, cardsByAnchor, resolvePointer, addMissAlias, experienceSummary, rawText],
    dispose: runtime.dispose,
  };
}

/**
 * 把六个工具定义注册到 DSH tools 服务，聚合返回的注销函数为单个 disposer。
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
  /** L6 通道名（#115 E.5）：plugin 传入 config.channel，逐层原样透传至落空台账。 */
  readonly channel: string;
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
 *  - 'shadow'/'on'：打开桥接并注册六工具；shadow 对外恒定 observing 空信封（仅旁路影子观测），
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
    channel: input.channel,
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
