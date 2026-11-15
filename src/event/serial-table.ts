/**
 * L3 候选序号表 —— 事件层纯函数核心（定稿 `docs/task90-l3-final-spec.md` §3.1 / §4 /
 * §5.2 / §6）。
 *
 * 纪律：
 *  - 纯函数、零 I/O：不 import `node:fs`、不持 `ExperienceLog` 实例、不 `readAll`，
 *    也不 import `src/memory` 任何模块（M6 规则①；event→memory 依赖为静态活门）；
 *  - 一次 sortedMembers 派生全部：序号表、prompt 行、反馈范围、两处解析共用同一有序数组；
 *  - 锚点序号 fail-closed（落 append-only 真源、不可修复），候选序号 fail-soft（展示附带字段，
 *    可逐条丢弃）；字段纪律由错误代价决定，未来新增结构化字段须显式声明。
 */

import { SchemaError } from '../core/errors.ts';

// ── 类型面（端口契约同构 memory/serial，不引 memory 实现）─────────────────────

/** 表成员窄面：id + 世界轴毫秒 + 通道；不含正文 / 摘要 / 线索。 */
export interface SerialMember {
  readonly id: string;
  readonly channel: string;
  readonly occurredAtMs: number;
}

/**
 * 候选池成员数上限 M（定稿 §9）：工程期常量，禁运行期可调、禁静默截断。
 * 字数约束已由分段器在源头闭合，本常量防的是长列表选择质量退化；超限走
 * `l3-candidate-overflow` 确定性失败，事件保持 pending，由 correction 拆分后自然通过。
 */
export const MAX_SERIAL_POOL_MEMBERS = 64;

/** 结构化违例明细的冻结 kind 枚举（词表逐字对齐红测）。 */
export type SerialViolationKind =
  | 'non-array'
  | 'not-integer'
  | 'out-of-range'
  | 'duplicate'
  | 'missing-member';

/** 结构化违例明细（§5.2 反馈载荷内核侧形状），零经历正文。 */
export interface SerialViolation {
  readonly kind: SerialViolationKind;
  readonly index: number;
  /** 脱敏后的可回显值；非整数 / id 形态按规则不回显原文。 */
  readonly safeRaw?: string;
  readonly legalRange: { readonly min: number; readonly max: number };
}

/** 1..N 冻结序号表；prompt 行 / 反馈范围 / 两处解析共用同一实例。 */
export interface SerialTable {
  readonly size: number;
  /** 冻结有序数组：排序键 (occurredAtMs 升序, id 字典序升序)。 */
  readonly ordered: readonly SerialMember[];
  readonly ids: readonly string[];
  readonly bySerial: ReadonlyMap<number, string>;
}

// ── 错误类 ───────────────────────────────────────────────────────────────────

/**
 * 候选 / 锚点序号越界、非整数、重复或表成员缺失 —— 拒绝引用，禁止猜序号、禁止就近顶替。
 *
 * 继承既有 `SchemaError`（可重试标记，不代表数据永久不可修）；携带结构化 `violations`，
 * 供反馈渲染与失败明细复用。重取分支只捕获本类，与 L1/L2 错误类型 instanceof 区分。
 */
export class EventSerialReferenceError extends SchemaError {
  readonly violations: readonly SerialViolation[];
  readonly reason?: string;

  constructor(
    message: string,
    options?: { cause?: unknown; violations?: readonly SerialViolation[]; reason?: string },
  ) {
    super(message, options);
    this.violations = options?.violations ?? [];
    this.reason = options?.reason;
  }
}

/** 供上层降级判定：仅本错误类可触发「轮内重取一次」纪律（同构 memory/isSerialRefusable）。 */
export function isEventSerialRefusable(error: unknown): boolean {
  return error instanceof EventSerialReferenceError;
}

// ── 确定性排序 ───────────────────────────────────────────────────────────────

/**
 * 排序键：`(occurredAtMs 升序, id 字符串字典序升序)` 稳定全序；同毫秒靠 id 决胜，
 * 不使用 Date.now() / 墙钟决胜。返回新数组，不改入参。
 */
export function buildSortedMembers(members: readonly SerialMember[]): SerialMember[] {
  return [...members].sort((a, b) => {
    if (a.occurredAtMs !== b.occurredAtMs) {
      return a.occurredAtMs - b.occurredAtMs;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? -1 : 1;
  });
}

// ── 序号表 ───────────────────────────────────────────────────────────────────

const EMPTY_TABLE: SerialTable = {
  size: 0,
  ordered: [],
  ids: [],
  bySerial: new Map<number, string>(),
};

/**
 * 建 1..N 冻结映射；任一槽位 `undefined`（reader 取不到成员）整表 fail-closed，
 * 不跳过、不补位，reason `l3-serial-table-broken`，明细指向缺失下标。
 */
export function buildSerialTable(members: readonly (SerialMember | undefined)[]): SerialTable {
  const missing: readonly SerialViolation[] = members
    .map((member, index) => {
      if (member !== undefined) {
        return undefined;
      }
      const violation: SerialViolation = {
        kind: 'missing-member',
        index,
        legalRange: { min: 1, max: members.length },
      };
      return violation;
    })
    .filter((v): v is SerialViolation => v !== undefined);

  if (missing.length > 0) {
    throw new EventSerialReferenceError('l3-serial-table-broken: 序号表存在缺失成员，整表拒绝引用', {
      reason: 'l3-serial-table-broken',
      violations: missing,
    });
  }

  const ordered = buildSortedMembers(members as readonly SerialMember[]);
  if (ordered.length === 0) {
    return EMPTY_TABLE;
  }

  const ids = ordered.map((member) => member.id);
  const bySerial = new Map<number, string>();
  ordered.forEach((member, index) => {
    bySerial.set(index + 1, member.id);
  });

  return { size: ordered.length, ordered, ids, bySerial };
}

// ── 严格整数解析（fail-closed / fail-soft 共用判定）────────────────────────────

const ID_LIKE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_RAW_LENGTH = 64;

function legalRangeOf(table: SerialTable): { min: number; max: number } {
  return { min: 1, max: table.size };
}

/** 判断值是否为表内合法序号（safe integer 且 1..N）；不做类型宽容转换。 */
function isValidSerial(table: SerialTable, value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= table.size
  );
}

function classifyValue(
  table: SerialTable,
  value: unknown,
  index: number,
): SerialViolation | undefined {
  const range = legalRangeOf(table);

  if (typeof value !== 'number') {
    // 非 number 即违约（任意字符串、含 ULID 形态）：不写 safeRaw，反馈只给类型级
    // 描述；ULID 形态的占位脱敏仅作用于渲染侧收到的 id 形态 safeRaw（见 displayRaw）。
    return { kind: 'not-integer', index, legalRange: range };
  }

  if (!Number.isInteger(value)) {
    return { kind: 'not-integer', index, legalRange: range };
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > table.size) {
    return { kind: 'out-of-range', index, legalRange: range, safeRaw: String(value) };
  }
  return undefined;
}

/**
 * 锚点序号解析（fail-closed）：字段必须存在且为数组；任一不符整份拒绝，
 * 不 filter、不半截、不 `Number()` coerce。返回按 picked 顺序解析出的 id 数组。
 */
export function resolveAnchorSerials(table: SerialTable, picked: unknown): string[] {
  const range = legalRangeOf(table);

  if (!Array.isArray(picked)) {
    const scalarKind: SerialViolationKind = typeof picked === 'number' ? 'not-integer' : 'non-array';
    throw new EventSerialReferenceError('锚点序号字段不是数组', {
      violations: [{ kind: scalarKind, index: 0, legalRange: range }],
    });
  }

  const violations: SerialViolation[] = [];
  const seen = new Set<number>();

  picked.forEach((value, index) => {
    const violation = classifyValue(table, value, index);
    if (violation !== undefined) {
      violations.push(violation);
      return;
    }
    const serial = value as number;
    if (seen.has(serial)) {
      violations.push({ kind: 'duplicate', index, legalRange: range, safeRaw: String(serial) });
      return;
    }
    seen.add(serial);
  });

  if (violations.length > 0) {
    throw new EventSerialReferenceError('锚点序号存在违约项，整份拒绝引用', { violations });
  }

  return picked.map((value) => table.bySerial.get(value as number) as string);
}

/**
 * 候选序号解析（fail-soft）：坏候选逐条丢弃并计数，不抛锚点类错误；
 * 空 / 非数组输入返回空 id 列表。重复序号在候选侧同样丢弃。
 */
export function resolveCandidateSerials(
  table: SerialTable,
  picked: unknown,
): { readonly ids: readonly string[]; readonly serials: readonly number[]; readonly dropped: number } {
  if (!Array.isArray(picked)) {
    return { ids: [], serials: [], dropped: 0 };
  }

  const ids: string[] = [];
  const serials: number[] = [];
  const seen = new Set<number>();
  let dropped = 0;

  for (const value of picked) {
    if (!isValidSerial(table, value) || seen.has(value)) {
      dropped += 1;
      continue;
    }
    seen.add(value);
    serials.push(value);
    ids.push(table.bySerial.get(value) as string);
  }

  return { ids, serials, dropped };
}

// ── 反馈渲染（固定模板 + JSON.stringify，确定性）──────────────────────────────

const MAX_FEEDBACK_ITEMS = 20;

function displayRaw(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (ID_LIKE_PATTERN.test(raw)) {
    return '<id-like value omitted>';
  }
  return raw.length > MAX_RAW_LENGTH ? `${raw.slice(0, MAX_RAW_LENGTH)}…` : raw;
}

function describeViolation(violation: SerialViolation): string {
  const position = `第 ${violation.index + 1} 项`;
  const raw = displayRaw(violation.safeRaw);
  switch (violation.kind) {
    case 'not-integer':
      return raw === undefined ? `${position}不是整数` : `${position}不是整数（${raw}）`;
    case 'out-of-range':
      return `${position}越界：${raw ?? '非整数'}`;
    case 'duplicate':
      return `${position}重复引用序号 ${raw ?? ''}`.trimEnd();
    case 'non-array':
      return '输入不是数组';
    case 'missing-member':
      return `${position}成员缺失`;
  }
}

/**
 * 纯函数渲染隔离反馈块：固定模板 + `JSON.stringify`，禁字符串拼抖动、禁墙钟。
 * 整数坏值照回显；非整数仅类型描述；id 形态值脱敏占位；不回显合法选择。
 * 条目数与单值长度有上限，防反馈膨胀 / 注入回路。
 */
export function renderFeedback(
  violations: readonly SerialViolation[],
  legalRange: { readonly min: number; readonly max: number },
  round: 'first' | 'retry',
): string {
  const items = violations.slice(0, MAX_FEEDBACK_ITEMS).map((violation) => ({
    index: violation.index,
    kind: violation.kind,
    detail: describeViolation(violation),
  }));

  const payload = {
    round,
    legalRange,
    range: `${legalRange.min}..${legalRange.max}`,
    violations: items,
  };

  return `[候选序号反馈] ${JSON.stringify(payload)}`;
}
