/**
 * WP4b 宿主无关记忆工具装配工厂（assembly 层）。
 *
 * 这是 DSH（及其它未来宿主）薄壳与记忆内核之间唯一的编排点，本身不 import 任何
 * `@deepseek-ai/*` 宿主包，离线 node:test 即可完整验证。职责：
 *  1. 打开运行期窄柄；索引库不存在时降级为 handle=null（门工具显式不可用），其余错误照常抛出；
 *  2. 把固定时钟与影子 sink 交给 createMemoryTools（#114 拆除后无旁路检索端口，召回只走门）；
 *  3. 影子 sink 做 ShadowFact→窄柄入参的字段改名（atMs→observedMs），且失败隔离不冒泡；
 *  4. 提供模型回显卡的 N14 白名单投影 projectCardForHost，剥离全部内部/敏感列；
 *  5. 统一、幂等的 dispose。
 *
 * 依赖纪律：对 memory 的值导入仅 openMemoryRuntime（M6 assembly 白名单），其余为编译擦除的
 * type-only 导入；不直接打开 sqlite/fs（N1）。
 */

import { NotFoundError, UnavailableError } from '../core/errors.ts';
import { openMemoryRuntime } from '../memory/runtime.ts';
import type { RuntimeMemoryHandle } from '../memory/runtime.ts';
import { isSerialRefusable } from '../memory/serial.ts';
import type { ShadowObservationInput } from '../memory/shadow-write.ts';
import type { GateReasonCode, MemoryCard } from '../memory/types.ts';
import { createMemoryTools } from './memory-tools.ts';
import type { SourceLookupPort } from './source-lookup.ts';
import type {
  MemoryGateMode,
  MemoryTools,
  ShadowFact,
  ShadowSink,
} from './memory-tools.ts';

/** 打开装配工厂所需的宿主无关入参。 */
export interface OpenAssembledMemoryToolsInput {
  /** 记忆索引目录（.../projection/memory-index），由宿主用其路径门面拼好后传入。 */
  readonly indexDir: string;
  readonly mode: MemoryGateMode;
  /** 注入时钟；宿主侧默认 () => Date.now()，测试可固定。 */
  readonly now: () => number;
  /** L6 注入的只读下钻端口（#114 E.4.1）；拆除批完成前可为缺省，运行面以 null 暴露。 */
  readonly sourceLookup?: SourceLookupPort;
}

/** 装配产物：四方法工具集 + 窄柄就绪标志 + 幂等关闭。 */
export interface AssembledMemoryRuntime {
  readonly tools: MemoryTools;
  /** 窄柄是否成功打开（false 表示门工具显式报不可用，shadow 仍回 observing 空信封）。 */
  readonly indexReady: boolean;
  /** L6 只读下钻端口；未注入时为 null。本批只完成绑定，工具消费随通道二接线卡切换。 */
  readonly sourceLookup: SourceLookupPort | null;
  dispose(): Promise<void>;
}

/**
 * 模型可见的卡安全投影（N14）：只回显身份、锚点、线索与消歧等展示字段，
 * 绝不包含 aliasesJson/sensitive/eventId/weight/contentHash 等内部或敏感列。
 */
export interface HostCardView {
  readonly cardId: string;
  readonly anchorIds: string[];
  readonly displayCues: string[];
  readonly channel: string;
  readonly cardType: MemoryCard['cardType'];
  readonly discriminator: string;
}

/** 把 JSON 字符串数组安全解析为 string[]；非数组/非字符串元素一律剔除。 */
function toStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/**
 * N14 白名单投影：从内部 MemoryCard 抽取可对模型回显的最小安全字段。
 * 纯函数、无 IO，宿主薄壳与任何未来适配器共用同一投影口径。
 */
export function projectCardForHost(card: MemoryCard): HostCardView {
  return {
    cardId: card.cardId,
    anchorIds: toStringArray(card.anchorJson),
    displayCues: toStringArray(card.displayCuesJson),
    channel: card.channel,
    cardType: card.cardType,
    discriminator: card.discriminator,
  };
}

/** 宿主薄壳可据以分支处理的稳定错误码（不暴露内部类名/堆栈/路径）。 */
export interface HostMemoryErrorKind {
  readonly code: 'serial-stale' | 'unavailable' | 'internal';
  readonly message: string;
}

/**
 * 把内核抛出的未知错误归类为稳定、可对模型回显的安全码与固定文案。
 * 序号错误复用 serial.ts 的 isSerialRefusable（M6 assembly 值白名单内）；
 * 不回传原始 message，避免内部路径/实现细节经工具结果外泄。
 */
export function classifyHostMemoryError(error: unknown): HostMemoryErrorKind {
  if (isSerialRefusable(error)) {
    return { code: 'serial-stale', message: '候选序号已失效或非法，请重新检索后引用最新序号。' };
  }
  if (error instanceof UnavailableError) {
    return { code: 'unavailable', message: '记忆门工具当前不可用，请稍后重试或检查门控状态。' };
  }
  return { code: 'internal', message: '记忆工具调用失败，请重试或改用普通检索。' };
}

/**
 * 打开宿主无关记忆工具运行面。
 * 缺库（NotFoundError）降级为 handle=null 并置 indexReady=false；其它打开错误向上抛，
 * 由宿主决定生命周期处理，避免静默掩盖真实故障。
 */
export function openAssembledMemoryTools(input: OpenAssembledMemoryToolsInput): AssembledMemoryRuntime {
  let handle: RuntimeMemoryHandle | null = null;
  let indexReady = false;
  try {
    handle = openMemoryRuntime({ indexDir: input.indexDir });
    indexReady = true;
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    handle = null;
    indexReady = false;
  }

  // 影子 sink：字段改名 + 失败隔离。窄柄缺失时直接跳过；窄柄自身已 try/catch，
  // 这里再包一层确保任何意外都不影响召回主路径（影子永不阻塞召回）。
  const sink: ShadowSink = {
    record(fact: ShadowFact): void {
      if (handle === null) return;
      try {
        const observation: ShadowObservationInput = {
          termNorm: fact.termNorm,
          gatedStatus: fact.gatedStatus,
          candidateCount: fact.candidateCount,
          countScope: fact.countScope,
          acceptedCount: fact.acceptedCount,
          // ShadowFact 为保持 assembly 对 memory 内部联合的最小耦合而把原因码宽化为 string[]；
          // 这些值唯一来源是内核 gate 输出，本就属 GateReasonCode，在此边界恢复类型。
          // 窄柄 recordShadowObservation 另有 GATE_REASON_VALUES 运行时白名单兜底。
          rejectedReasonCodes: fact.rejectedReasonCodes as readonly GateReasonCode[],
          observedMs: fact.atMs,
        };
        handle.recordShadowObservation(observation);
      } catch {
        // 影子观测失败只可观测、不可阻塞召回；吞错并保持门控结果/空信封照常返回。
      }
    },
  };

  const tools = createMemoryTools({
    mode: input.mode,
    now: input.now,
    handle,
    sink,
  });

  let closed = false;
  const dispose = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (handle !== null) {
      await handle.close();
      handle = null;
    }
  };

  return { tools, indexReady, sourceLookup: input.sourceLookup ?? null, dispose };
}
