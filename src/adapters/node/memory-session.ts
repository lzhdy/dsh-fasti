/**
 * node 身体的记忆工具宿主（对话第二刀：拿掉 dsh 后，FasTI node 身体自己的内存工具注册表）。
 *
 * 地位对应 dsh 的 memory-tool-bridge.ts，但**不 import 任何 @deepseek-ai/* 包**：
 *  - 六工具的门控、DTO 白名单、落空台账、采用计数全部复用宿主中立装配厂
 *    `openAssembledMemoryTools`（与 dsh 同一份内核，规则不复制）；
 *  - 本文件只做 OpenAI function 形状翻译、请求级会话状态（私有序号表/采用去重集）
 *    与稳定字符串信封，输出可直接喂给 headless openai-agent 客户端。
 *
 * 红线口径（主控 2026-11-21 拍板，正本 11.13.9 三）：
 *  - 记忆门在 node 身体**固定 on**：mode 字面量写死在本文件，入参没有 mode、全仓没有
 *    off/shadow 开关可翻；dsh 适配器三态是另一个身体，其代码不在此路径；
 *  - 模型侧 schema 一律不含 channel，通道由本模块盖章，rogue 键在白名单构造时剥离；
 *  - 工具只在进程内被 agent 回路调用，不开放任何 HTTP 工具路由。
 */

import path from 'node:path';

import type { Fasti } from '../../api/index.ts';
import {
  classifyHostMemoryError,
  openAssembledMemoryTools,
  projectCardForHost,
  type AssembledMemoryRuntime,
} from '../../assembly/host-tool-runtime.ts';
import type { GatedSearchView } from '../../assembly/memory-tools.ts';
import {
  createSourceLookupPort,
  isExperienceSummaryView,
  type SourceLookupPort,
} from '../../assembly/source-lookup.ts';

/** 六个模型可见工具名：与 dsh 桥逐字一致（snake_case 统一前缀），node 侧本地持有不横向引兄弟。 */
const TOOL_NAMES = {
  gatedSearch: 'fasti_memory_search',
  cardsByAnchor: 'fasti_memory_cards_by_anchor',
  resolvePointer: 'fasti_memory_resolve_pointer',
  addMissAlias: 'fasti_memory_add_alias',
  experienceSummary: 'fasti_memory_experience_summary',
  rawText: 'fasti_memory_raw_text',
} as const;

/** OpenAI function 工具描述符（headless agent 客户端结构兼容，此处本地定义不跨适配器引用）。 */
export interface NodeMemoryTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** agent 执行器入参（与 openai-agent 的 OpenAIAgentToolCall 同构）。 */
export interface NodeToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsText: string;
}

/** 一次 /chat 请求一个会话：序号表/采用去重集不跨请求，请求结束即弃。 */
export interface NodeMemoryToolSession {
  execute(call: NodeToolCall): Promise<string>;
}

export interface NodeMemoryRuntime {
  /** 窄柄是否成功打开（false 时门工具经内核 fail-closed 回 unavailable 信封）。 */
  readonly indexReady: boolean;
  /** 六个 OpenAI function 描述符（进程内共享，不含会话状态）。 */
  readonly tools: readonly NodeMemoryTool[];
  /** 第七法投影端口；窄柄不可用时为 null，供组合根 bindMemoryProjection。 */
  readonly memoryProjection: AssembledMemoryRuntime['memoryProjection'];
  /** 开一个请求级工具会话。 */
  createSession(): NodeMemoryToolSession;
  /** 关闭底层窄柄（幂等）。 */
  dispose(): Promise<void>;
}

export interface OpenNodeMemoryRuntimeInput {
  readonly fasti: Pick<Fasti, 'paths'> & Parameters<typeof createSourceLookupPort>[0];
  readonly channel: string;
  readonly now?: () => number;
  /** 留存哨兵/诊断出口；缺省静默。 */
  readonly onWarning?: (message: string) => void;
}

function envelopeOk(data: unknown): string {
  return JSON.stringify({ ok: true, data });
}

function envelopeFail(kind: { readonly code: string; readonly message: string }): string {
  return JSON.stringify({ ok: false, error: { code: kind.code, message: kind.message } });
}

function schemaFail(message: string): string {
  return envelopeFail({ code: 'schema', message });
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 六工具 JSON Schema：根 object、显式 additionalProperties:false、全部无 channel 键。 */
function buildToolDescriptors(): readonly NodeMemoryTool[] {
  const objectRoot = (
    properties: Record<string, unknown>,
    required: readonly string[],
  ): Record<string, unknown> => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required: [...required],
  });

  return [
    {
      name: TOOL_NAMES.gatedSearch,
      description:
        '在正确性门控下按关键词检索长期记忆。返回过门候选与私有序号：把序号交给 resolve 工具才能定位 card id；'
        + '无命中或门控弃权时返回对应状态空候选，不要自行编造记忆。',
      parameters: objectRoot(
        {
          text: { type: 'string', description: '检索关键词或短语。' },
          limit: { type: 'integer', description: '可选：候选条数上限。' },
        },
        ['text'],
      ),
    },
    {
      name: TOOL_NAMES.cardsByAnchor,
      description:
        '按经历 id 取锚定在该经历上的记忆卡安全详情视图；只回白名单展示字段，内部别名与敏感词永不出现。',
      parameters: objectRoot(
        { experienceId: { type: 'string', description: '要查询的经历/锚点 id。' } },
        ['experienceId'],
      ),
    },
    {
      name: TOOL_NAMES.resolvePointer,
      description:
        '把最近一次检索返回的私有序号解析为稳定 card id。序号仅本次检索情节有效，新检索后旧序号立即失效；'
        + '收到失效错误必须重新检索。',
      parameters: objectRoot(
        { serials: { type: 'array', items: { type: 'integer' }, description: '最近一次检索给的私有序号。' } },
        ['serials'],
      ),
    },
    {
      name: TOOL_NAMES.addMissAlias,
      description:
        '当检索没能召回某张已有卡时，为它补一个落空别名。仅对真实存在的 card id 有效，失败会返回稳定错误码。',
      parameters: objectRoot(
        {
          term: { type: 'string', description: '落空的别名说法。' },
          cardId: { type: 'string', description: '目标卡 id。' },
        },
        ['term', 'cardId'],
      ),
    },
    {
      name: TOOL_NAMES.experienceSummary,
      description:
        '通道二回查（第②跳）：按经历 id 读取定案经历摘要 DTO（固定白名单键集），不返回候选/别名/原文正文。',
      parameters: objectRoot(
        { experienceId: { type: 'string', description: '要查询的经历/锚点 id。' } },
        ['experienceId'],
      ),
    },
    {
      name: TOOL_NAMES.rawText,
      description:
        '通道二回查（第③跳）：按 Pointer（id/shard/seq；seq 为整数行号或 [起点,上界] 闭区间两整数数组）读取原文行，'
        + '返回带截断光标的七键信封。charOffset 是非负行内偏移，仅用于 midRow 续取，作用于本次结果首行。'
        + '续取映射：truncated=true 且 midRow=false 时，把信封 nextSeq 作为下一次的 seq 并保留原区间上界；'
        + 'midRow=true 时再把 nextCharOffset 作为下一次的 charOffset。信封里的 nextSeq/nextCharOffset 不是参数名，禁止直传。',
      parameters: objectRoot(
        {
          id: { type: 'string', description: '权威条目 id。' },
          shard: { type: 'string', description: "冗余加速分片 'YYYY-MM'，可省略。" },
          seq: {
            description: '行号整数（从 0 起），或恰好两个整数组成的闭区间数组。',
            oneOf: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }],
          },
          charOffset: { type: 'integer', minimum: 0, description: '可选行内偏移，仅 midRow 续取时传入。' },
        },
        ['id', 'seq'],
      ),
    },
  ];
}

/**
 * 打开 node 身体的记忆运行面。mode 写死 'on'：本身体不提供模式开关，
 * 索引库不存在时装配厂自行降级为窄柄 null（Q3 只开不建），门工具回 unavailable 而非启动失败。
 */
export function openNodeMemoryRuntime(input: OpenNodeMemoryRuntimeInput): NodeMemoryRuntime {
  const { fasti, channel } = input;
  const sourceLookup: SourceLookupPort = createSourceLookupPort(fasti, { channel });
  const runtime: AssembledMemoryRuntime = openAssembledMemoryTools({
    indexDir: path.join(fasti.paths.projection, 'memory-index'),
    dataRoot: fasti.paths.root,
    // 固定 on：node 身体唯一姿态，没有第二个取值，也不接受外部注入。
    mode: 'on',
    now: input.now ?? (() => Date.now()),
    missChannel: channel,
    sourceLookup,
    ...(input.onWarning === undefined ? {} : { onMissRetentionWarning: input.onWarning }),
  });
  const tools = buildToolDescriptors();

  return {
    indexReady: runtime.indexReady,
    tools,
    memoryProjection: runtime.memoryProjection,
    createSession(): NodeMemoryToolSession {
      // 请求级私有状态：模型只传回序号，序号表不落库、不跨请求，每次新检索整体替换。
      let serialMap: GatedSearchView['serialMap'] | null = null;
      let countedAnchors = new Set<string>();

      const parseArgs = (argumentsText: string): Record<string, unknown> => {
        const parsed: unknown = JSON.parse(argumentsText);
        if (!isRecord(parsed)) {
          throw new TypeError('工具参数必须是 JSON 对象');
        }
        return parsed;
      };

      const run = async (call: NodeToolCall): Promise<string> => {
        const record = parseArgs(call.argumentsText);

        switch (call.name) {
          case TOOL_NAMES.gatedSearch: {
            if (typeof record['text'] !== 'string' || record['text'].length === 0) {
              return schemaFail('text 必须是非空字符串。');
            }
            if (record['limit'] !== undefined && typeof record['limit'] !== 'number') {
              return schemaFail('limit 存在时必须是数字。');
            }
            const view = await runtime.tools.gatedSearch({
              text: record['text'],
              ...(record['limit'] === undefined ? {} : { limit: record['limit'] as number }),
            });
            // 每次检索整体替换私有序号表，旧序号立即失效；同步清空本检索情节采用去重集。
            serialMap = view.serialMap;
            countedAnchors = new Set();
            return envelopeOk({
              status: view.status,
              ...(view.reason === undefined ? {} : { reason: view.reason }),
              cards: view.cards,
            });
          }

          case TOOL_NAMES.cardsByAnchor: {
            if (typeof record['experienceId'] !== 'string' || record['experienceId'].length === 0) {
              return schemaFail('experienceId 必须是非空字符串。');
            }
            const cards = runtime.tools.getCardsByAnchor(record['experienceId']).map(projectCardForHost);
            return envelopeOk(cards);
          }

          case TOOL_NAMES.resolvePointer: {
            if (serialMap === null) {
              return envelopeFail({
                code: 'serial-context-missing',
                message: '本次对话还没有检索结果，请先调用 search 工具，再引用它返回的序号。',
              });
            }
            if (!Array.isArray(record['serials']) || record['serials'].some((value) => typeof value !== 'number')) {
              return schemaFail('serials 必须是整数数组。');
            }
            const resolved = runtime.tools.resolvePointer({
              serials: record['serials'] as number[],
              serialMap,
            });
            return envelopeOk({ cardIds: [...resolved.cardIds] });
          }

          case TOOL_NAMES.addMissAlias: {
            if (typeof record['term'] !== 'string' || record['term'].length === 0) {
              return schemaFail('term 必须是非空字符串。');
            }
            if (typeof record['cardId'] !== 'string' || record['cardId'].length === 0) {
              return schemaFail('cardId 必须是非空字符串。');
            }
            const view = runtime.tools.addMissAlias({ term: record['term'], cardId: record['cardId'] });
            return envelopeOk(view);
          }

          case TOOL_NAMES.experienceSummary: {
            if (runtime.sourceLookup === null) {
              return envelopeFail({ code: 'unavailable', message: '通道二回查端口未注入，经历摘要当前不可用。' });
            }
            if (typeof record['experienceId'] !== 'string' || record['experienceId'].length === 0) {
              return schemaFail('experienceId 必须是非空字符串。');
            }
            const summary = await runtime.sourceLookup.summaryByAnchor(record['experienceId']);
            if (summary === null) {
              return envelopeFail({
                code: 'not-found',
                message: '该经历 id 不存在或在本通道不可见，请核对 id 或重新检索。',
              });
            }
            if (!isExperienceSummaryView(summary)) {
              return envelopeFail({ code: 'internal', message: '经历摘要返回形状校验失败，请改用普通检索。' });
            }
            return envelopeOk(summary);
          }

          case TOOL_NAMES.rawText: {
            if (runtime.sourceLookup === null) {
              return envelopeFail({ code: 'unavailable', message: '通道二回查端口未注入，原文回查当前不可用。' });
            }
            if (typeof record['id'] !== 'string' || record['id'].length === 0) {
              return schemaFail('id 必须是非空字符串。');
            }
            if (record['charOffset'] !== undefined && !isNonNegativeInteger(record['charOffset'])) {
              return schemaFail('charOffset 必须是非负整数；非法参数不做静默降级。');
            }
            const seqIsInteger = typeof record['seq'] === 'number' && Number.isInteger(record['seq']);
            const seqIsInterval =
              Array.isArray(record['seq'])
              && record['seq'].length === 2
              && record['seq'].every((entry) => typeof entry === 'number' && Number.isInteger(entry));
            if (!seqIsInteger && !seqIsInterval) {
              return schemaFail('seq 必须是整数行号，或恰好两个整数组成的闭区间数组。');
            }

            // 显式白名单挑键：模型私传的 channel/任何 rogue 键在此天然剥离，盖章通道是唯一通道值。
            const pointer: {
              channel: string;
              id: string;
              shard?: string;
              seq: number | [number, number];
              charOffset?: number;
            } = { channel, id: record['id'], seq: seqIsInteger ? (record['seq'] as number) : (record['seq'] as [number, number]) };
            if (typeof record['shard'] === 'string') pointer.shard = record['shard'];
            if (record['charOffset'] !== undefined) pointer.charOffset = record['charOffset'] as number;

            const view = await runtime.sourceLookup.resolveRawText(pointer);

            // 第③跳采用记账：与 dsh 桥同构，一个检索情节一个锚点只记一次，异常隔离不阻断阅读。
            let adoptionNote: unknown;
            if (!countedAnchors.has(pointer.id)) {
              countedAnchors.add(pointer.id);
              try {
                const adoption = runtime.tools.recordAnchorAdoption({ anchorId: pointer.id });
                if ('deferred' in adoption) {
                  adoptionNote = { deferred: true, mode: adoption.mode, reason: adoption.reason };
                } else {
                  adoptionNote = {
                    ok: true,
                    matchedCards: adoption.matchedCards,
                    adoptedCount: adoption.adopted.length,
                    rejectedCount: adoption.rejected.length,
                  };
                }
              } catch {
                adoptionNote = { ok: false, reason: 'adoption-failed-isolated' };
              }
            }
            return envelopeOk(adoptionNote === undefined ? view : { ...view, adoption: adoptionNote });
          }

          default:
            return schemaFail(`未知工具名 ${call.name}，只能调用本次声明的六个记忆工具。`);
        }
      };

      return {
        async execute(call: NodeToolCall): Promise<string> {
          try {
            return await run(call);
          } catch (error) {
            // 参数 JSON 解析失败是模型侧形状问题，归 schema 而非 internal（dsh 宿主原本在
            // defineTool 层拦这一道；node 身体自己收 argumentsText，必须在此补齐）。
            if (error instanceof SyntaxError || error instanceof TypeError) {
              return schemaFail('工具参数不是合法 JSON 对象，请按工具 schema 修正后重试。');
            }
            return envelopeFail(classifyHostMemoryError(error));
          }
        },
      };
    },
    dispose: runtime.dispose,
  };
}
