/**
 * 错误层级 —— 契约级抛错约定的实现。
 *
 * 纪律（定案稿 §9 / 审计口径 3）：缺指针、越界、坏哈希一律抛错，不返回空、不静默降级。
 * 所有错误继承 FastiError，携带稳定的 code，便于上层按类处理而不必匹配 message。
 */

export type FastiErrorCode =
  | 'SCHEMA'
  | 'NOT_FOUND'
  | 'DELETED'
  | 'OUT_OF_RANGE'
  | 'INTEGRITY'
  | 'CONFLICT'
  | 'UNAVAILABLE'
  | 'NOT_IMPLEMENTED'
  | 'CORRUPTED';

export class FastiError extends Error {
  readonly code: FastiErrorCode;

  constructor(code: FastiErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** 数据不符合契约（schema 校验失败、必填缺失、字段越界）。 */
export class SchemaError extends FastiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('SCHEMA', message, options);
  }
}

/** 指向的对象不存在（指针目标缺失、通道未注册、经历不存在）。 */
export class NotFoundError extends FastiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('NOT_FOUND', message, options);
  }
}

// ── G08 区块：已删 vs 从不存在的机器可判面 ──
/**
 * 目标已被删除 —— 与 NotFoundError 严格区分（B1-③ 语义预留）。
 *
 * 「已删除」是「曾经存在过、后来被删」，「从未存在」是「从来没有过」：
 * 两者对上层是**不同的事实**（悬空留痕 vs 从未有过），故必须机器可判 ——
 * 靠 code='DELETED' / instanceof 判定，不靠 message 文案匹配。
 *
 * 本期（B 一期）不实现删除工具，真源里还没有 tombstone，
 * 故这个错误类暂时只作为契约占位（删除闭包落地时才真正抛出）。
 */
export class DeletedError extends FastiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('DELETED', message, options);
  }
}

/**
 * 目标状态 —— 「在 / 已删除 / 从未存在」三态（B1-③ 语义预留）。
 *
 * 本期不实现删除工具 → 真源里没有 tombstone，实际只会出现
 * 'present' 与 'never_existed'；'deleted' 先在契约里占位，
 * 将来删除闭包落地时由 tombstone 判别，不再临时发明第二套语义。
 */
export type TargetState = 'present' | 'deleted' | 'never_existed';

/**
 * 「目标不在」的错误属于哪一态 —— 非此类错误返回 undefined。
 *
 * 机器可判：DeletedError → 'deleted'（曾经有过、现在没了）；
 * NotFoundError → 'never_existed'（从来没有过）。
 */
export function missingTargetState(
  error: unknown,
): 'deleted' | 'never_existed' | undefined {
  if (error instanceof DeletedError) {
    return 'deleted';
  }
  if (error instanceof NotFoundError) {
    return 'never_existed';
  }
  return undefined;
}

/** 越界（如 Pointer.seq 超出原文行范围）。 */
export class OutOfRangeError extends FastiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('OUT_OF_RANGE', message, options);
  }
}

/** 完整性校验失败（content_hash 不匹配、sha256 缺失或不符）。 */
export class IntegrityError extends FastiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('INTEGRITY', message, options);
  }
}

/** 与既有状态冲突（同一 id 重复注册但内容不同）。 */
export class ConflictError extends FastiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CONFLICT', message, options);
  }
}

/** 依赖不可用（node:sqlite 被禁用、文件锁失败等）。 */
export class UnavailableError extends FastiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('UNAVAILABLE', message, options);
  }
}

/** 阶段范围外的能力（阶段 3+ 才实现的原语）。 */
export class NotImplementedError extends FastiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('NOT_IMPLEMENTED', message, options);
  }
}

/** 存储损坏（坏行、坏 manifest、投影索引不可解析）。 */
export class CorruptedError extends FastiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CORRUPTED', message, options);
  }
}
