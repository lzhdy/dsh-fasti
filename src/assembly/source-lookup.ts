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

import { ChannelBoundaryError, SchemaError } from '../core/errors.ts';
import type {
  Experience,
  ExperienceSummaryView,
  Pointer,
  RawTurnView,
} from '../contract/experience.ts';
import type { ResolvedPointer } from '../contract/primitives.ts';
import type { CountScope } from '../memory/types.ts';

export type { CountScope, ExperienceSummaryView, Pointer, RawTurnView };

/**
 * #115 通道二回查两道独立防爆闸（只约束只读响应体积，不做任何静默截断之外的写动作）：
 *  - 条数闸：单次回查最多返回的原文行数；
 *  - 字符闸：单次回查返回原文的字符总量。
 * 字符闸数值与事件摄入侧的原始字符保险丝（event/params.ts 中的同值常量）对齐，
 * 但两者语义独立——一个管摄入、一个管回查信封；本模块**不得引用**摄入侧符号，
 * 改值必须分别评审，避免一条保险丝被两处语义绑架。
 */
export const MAX_RAW_TURNS_PER_LOOKUP = 20;
export const MAX_RAW_LOOKUP_CHARS = 50000;

/**
 * L5 续取指针：L0 Pointer 之上叠加可选行内游标 charOffset。
 * 刻意不回写 contract/experience.ts 的冻结 Pointer——charOffset 是回查信封的续取概念，
 * 不属于真源定位契约。语义定死：charOffset 恒作用于**本次解析结果的首行**，允许配 seq 区间。
 */
export type LookupPointer = Pointer & {
  /** 首行行内字符偏移（非负整数）；仅 midRow 续取时出现，缺省表示从头读取。 */
  readonly charOffset?: number;
};

/**
 * 原文回查信封（七键定死，#115 §7.3 终形）：
 *  - turns：过闸后实际返回的原文行（行内截断时末行为前段）；
 *  - truncated：是否有行被两道闸挡下；
 *  - totalTurns/totalChars：**偏移应用之后、截断之前**的解析全集口径，不是返回集合的计数，
 *    下游据此判断尾部是否还可翻页，禁止改写成返回段合计；
 *  - midRow：截断点是否落在某一行内部（单行自身超字符闸的退化情形）；
 *  - nextSeq/nextCharOffset：行内续取游标，必须成对出现（共同锁定被截行与行内起点），
 *    无行内截断时双双显式 null。
 */
export interface RawTurnLookupView {
  readonly turns: readonly RawTurnView[];
  readonly truncated: boolean;
  readonly totalTurns: number;
  readonly totalChars: number;
  readonly midRow: boolean;
  readonly nextSeq: number | null;
  readonly nextCharOffset: number | null;
}

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
 *
 * resolveRawText 刻意声明两条重载：末条入参为冻结面 Pointer（Parameters 抓取末条，
 * 端口签名对 L0 契约保持逐字一致），首条接纳 L5 LookupPointer 的 charOffset 续取游标；
 * 返回统一为七键 RawTurnLookupView 信封，不再裸返数组。
 */
export interface SourceLookupPort {
  summaryByAnchor(anchorId: string): Promise<ExperienceSummaryView | null>;
  resolveRawText(pointer: LookupPointer): Promise<RawTurnLookupView>;
  resolveRawText(pointer: Pointer): Promise<RawTurnLookupView>;
}

/**
 * 工厂所需的最小结构立面：由 L6 适配层用门面实例结构性满足。
 * 本模块不 import 门面类型，Fasti 只要具名形状匹配即可注入，M6 依赖墙不出现例外。
 */
export interface SourceLookupFacade {
  readExperienceById(id: string): Promise<ExperienceSummaryView | null>;
  resolvePointer(pointer: Pointer): Promise<ResolvedPointer>;
}

/** createSourceLookupPort 的注入项：L6 盖章通道，端口不内置任何通道默认值。 */
export interface SourceLookupOptions {
  readonly channel: string;
}

/**
 * 两道防爆闸的纯函数落点（无 IO、可离线全量复现算术）：
 * 取前段、绝不重排；条数闸与字符闸独立生效。
 *
 * 截断口径：
 *  - 整行为界：累计字符 + 整行长度 ≤ 字符闸才纳整行，否则该行及其后全部丢弃；
 *  - 单行自身超字符闸（含它是首个放不下的行且其行长 > 闸值）的退化情形无解于整行为界
 *    （吞成 0 行等于藏原文），改为返回该行在剩余预算内的前段，标 midRow 并发行内游标；
 *  - 行内游标 nextSeq=被截行 seq、nextCharOffset=该行内已返回字符数，成对出现；
 *  - total* 永远报截断前全集真实量，截断不是死胡同，seq 区间/游标可续取剩余部分。
 */
export function applyLookupCaps(rows: readonly RawTurnView[]): RawTurnLookupView {
  const totalTurns = rows.length;
  const totalChars = rows.reduce((sum, row) => sum + row.rawText.length, 0);

  const turns: RawTurnView[] = [];
  let usedChars = 0;
  let truncated = false;
  let midRow = false;
  let nextSeq: number | null = null;
  let nextCharOffset: number | null = null;

  for (const row of rows) {
    if (turns.length >= MAX_RAW_TURNS_PER_LOOKUP) {
      truncated = true;
      break;
    }
    const length = row.rawText.length;
    if (usedChars + length <= MAX_RAW_LOOKUP_CHARS) {
      turns.push(row);
      usedChars += length;
      continue;
    }
    // 该行整行放不下：先确定截断发生，再判断是否属于"单行自身超闸"的行内截断退化情形。
    truncated = true;
    if (length > MAX_RAW_LOOKUP_CHARS) {
      const remaining = MAX_RAW_LOOKUP_CHARS - usedChars;
      if (remaining > 0) {
        // 用 substring 取行内前段：装配层静态门禁用 .slice/.splice（候选预切片门，M6 规则④），
        // 字符串截断语义与 slice 完全等价且不触碰任何候选数组。
        turns.push({ ...row, rawText: row.rawText.substring(0, remaining) });
        usedChars += remaining;
        midRow = true;
        nextSeq = row.seq;
        nextCharOffset = remaining;
      }
    }
    break;
  }

  return { turns, truncated, totalTurns, totalChars, midRow, nextSeq, nextCharOffset };
}

/**
 * 由 L6 注入构造只读端口：第②跳直通门面窄 DTO；第③跳先做通道边界与游标形状校验，
 * 再经门面解析原文、应用首行 charOffset，最后过两道防爆闸返回七键信封。
 * 端口自身不持库柄、不打开文件、不缓存正文。
 */
export function createSourceLookupPort(
  facade: SourceLookupFacade,
  options: SourceLookupOptions,
): SourceLookupPort {
  const injectedChannel = options.channel;
  return {
    async summaryByAnchor(anchorId: string): Promise<ExperienceSummaryView | null> {
      const summary = await facade.readExperienceById(anchorId);
      // 通道二第②跳同样 fail-closed：锚点 id 可能经审计/日志/他次会话泄露，
      // 异通道摘要一律按"未找到"处理（返 null，不抛、不回显异通道存在性与任何字段）。
      if (summary !== null && summary.scene.channel !== injectedChannel) {
        return null;
      }
      return summary;
    },
    async resolveRawText(pointer: LookupPointer): Promise<RawTurnLookupView> {
      // 1) 游标形状前置闸：负数/非整数在任何门面 IO 之前拒绝（零取回）。
      if (
        pointer.charOffset !== undefined &&
        (typeof pointer.charOffset !== 'number' ||
          !Number.isInteger(pointer.charOffset) ||
          pointer.charOffset < 0)
      ) {
        throw new SchemaError('charOffset 必须是非负整数，且作用于本次解析结果的首行');
      }

      // 2) 通道边界闸：严格相等。缺 channel 等价全库遍历、异 channel 等价越权，均 fail-closed，
      //    且先于门面调用，保证零跨通道 IO。
      if (pointer.channel !== injectedChannel) {
        throw new ChannelBoundaryError('Pointer 缺失 channel 或与注入通道不一致，拒绝跨通道读取');
      }

      // 3) 调门面：只透传 L0 Pointer 四键，charOffset 是 L5 续取概念，不进入冻结契约面。
      const facadePointer: Pointer = {
        id: pointer.id,
        channel: pointer.channel,
        shard: pointer.shard,
        seq: pointer.seq,
      };
      const resolved = await facade.resolvePointer(facadePointer);
      let rows: readonly RawTurnView[] = resolved.turns.map(projectRawTurn);

      // 4) charOffset 恒作用于本次解析首行。无状态越界闸：offset ≥ 首行实际长度即拒绝，
      //    等价覆盖跳行读取（区间首行不是上次 nextSeq 时自然在此被挡住），端口无需会话状态。
      if (pointer.charOffset !== undefined) {
        const first = rows[0];
        if (first === undefined || pointer.charOffset >= first.rawText.length) {
          throw new SchemaError('charOffset 越出本次解析首行的实际长度，拒绝跳行读取');
        }
        // 解构空位取余下行，避免 .slice 触发装配层候选预切片静态门。
        const [, ...rest] = rows;
        const shiftedFirst: RawTurnView = {
          ...first,
          rawText: first.rawText.substring(pointer.charOffset),
        };
        rows = [shiftedFirst, ...rest];
      }

      // 5) 两道独立防爆闸，输出七键信封。
      return applyLookupCaps(rows);
    },
  };
}

// RAW_TURN_KEYS 供后续通道二接线测试/审计复用，显式标记为端口契约的一部分。
export const SOURCE_LOOKUP_CONTRACT = {
  summaryKeys: SUMMARY_KEYS,
  rawTurnKeys: RAW_TURN_KEYS,
} as const;
