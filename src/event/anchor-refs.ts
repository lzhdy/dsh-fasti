/**
 * #90 批 A · L2 引用完整性闸纯函数核心（正本 `docs/task90-write-gate-final-spec.md` §2 / §5）。
 *
 * 头条口径：主判据是**成员包含性**——`anchors ⊆ 本事件 pointers 成员 id 集`，
 * 且每个 id 经注入 reader 点查存在；同通道 / 闭区间仅作只读诊断分桶，**任何诊断桶
 * 都不能推翻主谓词的拒收结论**。
 *
 * 内部顺序：L1 形态已由上游闸过 → 重复检测（显式拒收，禁止去重）→ 逐点存在性与
 * 成员判定 → 失败抛 `AnchorReferenceInvalidError`（detail 结构化、零经历正文）。
 *
 * 边界纪律（静态投毒守护）：
 *  - 零 IO 纯模块：不 import `node:fs`、不持 `ExperienceLog`、不做 `readAll` 全量枚举；
 *    reader 是注入的同步窄接口，点查 O(1)，窄 Ref 只含 `{ id, channel, occurredAtMs }`；
 *  - reader 抛出的基础设施错误（如 `CorruptedError`）**原样上抛**，不在本模块 catch 吞类，
 *    不归并成 not-found；`experience-store-broken` 语义由 closure 接线批在 failTask 侧归类；
 *  - detail 零经历正文 / 零摘要正文（禁 raw_text/body/summary/cue/key_points）。
 */

import { SchemaError } from '../core/errors.ts';
import { isoToMs } from '../core/time.ts';

/** reader 回传的经历引用面；刻意不含 cue/raw_text/summary 等正文字段。 */
export interface ReaderRef {
  readonly id: string;
  readonly channel: string;
  readonly occurredAtMs: number;
}

/** 经历点查窄接口（同步、单方法、返回 undefined 表示真源不存在）。 */
export interface ExperienceReader {
  readonly readExperience: (id: string) => ReaderRef | undefined;
}

/** §5.2 冻结 reason 词表（与 #42 同词表，anchor- 前缀）。 */
export type AnchorReferenceReason =
  | 'anchor-duplicate'
  | 'anchor-not-found'
  | 'anchor-cross-channel'
  | 'anchor-out-of-window'
  | 'anchor-not-in-event'
  | 'experience-store-broken';

/** 结构化失败明细（§3 Q3）：零经历正文 / 零摘要正文。 */
export interface AnchorReferenceDetail {
  readonly reason: AnchorReferenceReason;
  readonly anchor: string;
  readonly expected: string;
  readonly actual: string;
  readonly channel?: string;
  readonly window?: { readonly startedMs: number; readonly endedMs: number };
  readonly deltaMs?: number;
  readonly note?: string;
}

/** 事件侧诊断上下文（毫秒口径，内部使用；不参与主谓词放行判定）。 */
interface DiagnosticContext {
  readonly channel: string;
  readonly startedMs: number;
  readonly endedMs: number;
}

/**
 * 锚点引用无效（成员包含性 / 存在性校验失败）。
 *
 * 注意：此处 `SchemaError` 是**可重试标记**，不代表数据永久不可修；
 * 由 closure 接线批走既有 failTask 退避，耗尽前不写占位版本。
 */
export class AnchorReferenceInvalidError extends SchemaError {
  readonly detail: AnchorReferenceDetail;

  constructor(message: string, options?: { cause?: unknown; detail: AnchorReferenceDetail }) {
    super(message, options);
    this.detail = options?.detail as AnchorReferenceDetail;
  }
}

/**
 * 诊断分桶：id 存在但不在成员集时，把失败细分为通道 / 时间窗 / 兜底桶。
 *
 * 纯只读辅助：分桶结果只服务观测与维修明细，**绝不改变 fail-closed 结论**。
 * 时间串解析失败打 `time-unparseable` 标记；`deltaMs` / `window` 不允许出现
 * NaN / Infinity——解析不成就不折算，走兜底桶。
 */
export function classifyAnchorFailure(
  anchor: string,
  ref: ReaderRef | undefined,
  context: { readonly channel: string; readonly startedAt: string; readonly endedAt: string },
): AnchorReferenceDetail {
  let startedMs: number | undefined;
  let endedMs: number | undefined;
  let note: string | undefined;

  try {
    startedMs = isoToMs(context.startedAt);
  } catch {
    note = 'time-unparseable';
  }
  try {
    endedMs = isoToMs(context.endedAt);
  } catch {
    note = note === undefined ? 'time-unparseable' : `${note};time-unparseable`;
  }

  const diagnostic: DiagnosticContext | undefined =
    startedMs !== undefined && endedMs !== undefined
      ? { channel: context.channel, startedMs, endedMs }
      : undefined;

  const detail = classifyRef(anchor, ref, diagnostic);
  if (note !== undefined && detail.note === undefined) {
    return { ...detail, note };
  }
  return detail;
}

/** 毫秒口径内部分桶（assertAnchorRefs 诊断上下文直接复用）。 */
function classifyRef(
  anchor: string,
  ref: ReaderRef | undefined,
  context: DiagnosticContext | undefined,
): AnchorReferenceDetail {
  if (ref === undefined) {
    return {
      reason: 'anchor-not-found',
      anchor,
      expected: 'experience present in source log',
      actual: 'not found',
    };
  }

  if (context !== undefined && ref.channel !== context.channel) {
    return {
      reason: 'anchor-cross-channel',
      anchor,
      expected: context.channel,
      actual: ref.channel,
      channel: ref.channel,
    };
  }

  if (context !== undefined) {
    const { startedMs, endedMs } = context;
    const occurred = ref.occurredAtMs;
    const outside = occurred < startedMs || occurred > endedMs;
    if (outside) {
      const deltaMs = occurred < startedMs ? occurred - startedMs : occurred - endedMs;
      return {
        reason: 'anchor-out-of-window',
        anchor,
        expected: `[${startedMs}, ${endedMs}]`,
        actual: String(occurred),
        channel: ref.channel,
        window: { startedMs, endedMs },
        deltaMs,
      };
    }
    return {
      reason: 'anchor-not-in-event',
      anchor,
      expected: 'member of event pointers',
      actual: 'not in member set',
      channel: ref.channel,
    };
  }

  // 时间窗不可解析：归兜底桶，标记位由调用方在 detail.note 上补 `time-unparseable`。
  return {
    reason: 'anchor-not-in-event',
    anchor,
    expected: 'member of event pointers',
    actual: 'not in member set',
    channel: ref.channel,
  };
}

/**
 * L2 引用完整性闸：校验锚点集合满足成员包含性，且每个 id 在经历真源中存在。
 *
 * - `[]` 合法放行（abstain，沿用 #42 空锚口径）；
 * - 同一 ULID 多次出现显式拒收 `anchor-duplicate`，**禁止静默去重**；
 * - reader 返 undefined → `anchor-not-found`；
 * - id 存在但不在 memberIds → 按诊断桶分类，主谓词仍拒收；
 * - reader 抛出的基础设施错误原样上抛，不 catch、不归类为 anchor 类。
 *
 * `context` 只供诊断分桶，不参与放行判定；缺省时非成员锚点归兜底桶。
 */
export function assertAnchorRefs(
  anchors: readonly string[],
  memberIds: ReadonlySet<string>,
  reader: ExperienceReader,
  context?: { readonly channel: string; readonly startedMs: number; readonly endedMs: number },
): void {
  const seen = new Set<string>();

  for (const anchor of anchors) {
    if (seen.has(anchor)) {
      throw invalidRef(anchor, {
        reason: 'anchor-duplicate',
        anchor,
        expected: 'each anchor appears once',
        actual: 'duplicate ULID in anchors',
      });
    }
    seen.add(anchor);

    // 基础设施错误不在此 catch：原样上抛（experience-store-broken 由接线批归类）。
    const ref = reader.readExperience(anchor);

    if (ref === undefined) {
      throw invalidRef(anchor, classifyRef(anchor, undefined, context));
    }

    // 主谓词唯一：成员包含性。通道 / 时间窗仅由诊断函数 classifyRef 分桶填 detail，
    // 不在本判定内引用其结论，生产闸运行期不解析时间。
    if (!memberIds.has(anchor)) {
      throw invalidRef(anchor, classifyRef(anchor, ref, context));
    }
  }
}

function invalidRef(anchor: string, detail: AnchorReferenceDetail): AnchorReferenceInvalidError {
  return new AnchorReferenceInvalidError(`anchor ref rejected: ${detail.reason} ${anchor}`, {
    detail,
  });
}
