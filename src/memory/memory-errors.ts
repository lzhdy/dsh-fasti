/**
 * 记忆层错误类 —— 统一继承 src/core/errors.ts 的既有基类，不自造错误码体系
 * （方案 §4 头部）。
 */

import { CorruptedError, IntegrityError, NotFoundError } from '../core/errors.ts';

/** 真值指纹与 stamp 不符 —— 索引过期，读操作拒绝服务（方案 §4 / M3）。 */
export class MemoryIndexStaleError extends CorruptedError {}

/** 锚点解析不到真值经历 —— 悬空锚点，构建零产物（方案 §4.6 / M1）。 */
export class MemoryAnchorDanglingError extends IntegrityError {
  /** 受控分类码：悬空锚点统一记 `anchor-not-found`（与 derive 三分口径对齐）。 */
  readonly reason_code: string;

  constructor(message: string, options?: { cause?: unknown; reasonCode?: string }) {
    super(message, options);
    this.reason_code = options?.reasonCode ?? 'anchor-not-found';
  }
}

/** 候选序号越界/失效 —— 拒绝引用，禁止猜序号（方案 §4.7 / M2）。 */
export class MemorySerialReferenceError extends NotFoundError {}