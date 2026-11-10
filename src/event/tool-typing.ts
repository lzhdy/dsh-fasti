/**
 * 阶段 0 · 工具轮类型化映射（定案稿 §5.0.2 / 任务书 C2c）。
 *
 * 解决的问题（§5.0.1）：工具调用的载荷本来就在 dsh 会话日志里，但摄入侧把
 * 它们一律写成 `kind:'dialogue'` —— 实测 34 个工具轮占了全部字符的 67.1%，
 * 于是「20 条记录上限」会被工具 JSON 7 分钟攒满，边界总落在 JSON 中间。
 *
 * 映射规则（§5.0.2，纯加法，**不改原文**）：
 *
 * | 载荷形状 | 类型化产物 |
 * |---|---|
 * | 调用步（含 `name` + `arguments` + `callId`，实测 17 条） | `action: { type:'tool-call', tool, args }`，`args` 走原文指针不内联 |
 * | 结果（含 `message.toolCallId` / `isError` / `content`，或外层 `error.code`，实测 17 条） | `outcome: { status, error_type?, duration_ms?, tokens? }`，结果正文走指针 |
 * | 普通 user/assistant 对话轮 | 维持 `kind='dialogue'`，不产生 action/outcome |
 *
 * 四条硬约束：
 *  1. **只补字段**：raw_text 与原文指针不动；
 *  2. **callId 只从载荷 JSON 提取**，不提升为 RawTurn 顶层字段（RawTurn 八字段是冻结面）；
 *  3. **映射不到就原样保留** —— 不丢弃、不猜字段，只记 warn、不阻断摄入；
 *  4. 工具/非工具的区分**只在事件累计时生效**，不改变逐记录 `char_count`（一律记全量）。
 *
 * 本模块是**纯函数**：输入载荷文本，输出类型化产物或「不是工具轮」。
 * 不引依赖、不引 tokenizer、不写语义规则检查器（纪律 5）。
 */

/** 工具轮的类型化产物。 */
export type ToolTurnTyping =
  | { readonly kind: 'dialogue' }
  | { readonly kind: 'call-step'; readonly tool: string; readonly callId: string }
  | {
      readonly kind: 'result';
      readonly callId: string | undefined;
      readonly status: 'success' | 'failure' | 'partial' | 'unknown';
      readonly errorType: string | undefined;
      readonly durationMs: number | undefined;
      readonly inputTokens: number | undefined;
      readonly outputTokens: number | undefined;
    };

/** 解析失败时的诊断信息（调用方记 warn，不阻断摄入）。 */
export interface ToolTurnDiagnostic {
  /** 载荷文本的片段（用于定位，不含全文 —— 全文可能很长）。 */
  readonly excerpt: string;
  readonly reason: string;
}

/**
 * 按载荷形状判定工具轮类型。
 *
 * 口径与冻结夹具生成器（`make-fixture.py` 的 `payload_kind`）**逐条对齐**：
 *  - 先试 JSON 解析，失败 → dialogue（普通对话轮不是 JSON）；
 *  - 顶层是对象且同时有 `name` 与 `arguments` → 调用步；
 *  - 顶层是对象且有 `message` → 结果；
 *  - 其余 → dialogue（未知形态原样保留）。
 *
 * @param rawText 该轮的原始载荷文本
 */
export function typeToolTurn(rawText: string): ToolTurnTyping {
  const payload = tryParseJson(rawText);
  if (payload === undefined) {
    return { kind: 'dialogue' };
  }
  if (!isPlainObject(payload)) {
    return { kind: 'dialogue' };
  }

  // 调用步载荷：`name` + `arguments`（+ `callId`）。
  if ('name' in payload && 'arguments' in payload) {
    const tool = typeof payload['name'] === 'string' ? payload['name'] : undefined;
    const callId = readCallId(payload['callId']);
    if (tool === undefined || callId === undefined) {
      // 形状像调用步但缺关键字段 → 不猜，按「不是工具轮」处理（原样保留）。
      return { kind: 'dialogue' };
    }
    return { kind: 'call-step', tool, callId };
  }

  // 结果载荷：`message`（含 toolCallId / isError / content）或外层 `error.code`。
  if ('message' in payload) {
    const message = payload['message'];
    const inner = isPlainObject(message) ? message : undefined;
    const callId = inner === undefined ? undefined : readCallId(inner['toolCallId']);
    const isError = inner !== undefined && inner['isError'] === true;
    const errorType = readErrorType(payload) ?? readErrorType(inner);
    const status = isError ? 'failure' : readResultStatus(inner);
    const durationMs = readNumber(inner?.['duration_ms']) ?? readNumber(payload['duration_ms']);
    const tokens = readTokens(inner) ?? readTokens(payload);
    return {
      kind: 'result',
      callId,
      status,
      errorType,
      durationMs,
      inputTokens: tokens?.input,
      outputTokens: tokens?.output,
    };
  }

  // 未知形态：原样保留（不产生 action/outcome，也不算工具轮）。
  return { kind: 'dialogue' };
}

/**
 * 结果轮的状态取值（§5.0.3 取值域）。
 *
 *  - `isError:true` → `failure`（在上游判定）；
 *  - 截断 → `partial`；
 *  - 无结果正文 → `unknown`；
 *  - 其余 → `success`。
 */
function readResultStatus(message: Record<string, unknown> | undefined): 'success' | 'partial' | 'unknown' {
  if (message === undefined) {
    return 'unknown';
  }
  const content = message['content'];
  const truncated = message['isPartial'] === true || message['truncated'] === true;
  if (truncated) {
    return 'partial';
  }
  if (content === undefined || content === null || content === '') {
    return 'unknown';
  }
  return 'success';
}

/** 错误码原样记录（不做翻译改写 —— §5.0.3）。 */
function readErrorType(obj: Record<string, unknown> | undefined): string | undefined {
  if (obj === undefined) {
    return undefined;
  }
  const error = obj['error'];
  if (typeof error === 'string' && error !== '') {
    return error;
  }
  if (isPlainObject(error)) {
    const code = error['code'];
    if (typeof code === 'string' && code !== '') {
      return code;
    }
  }
  const code = obj['error_code'];
  if (typeof code === 'string' && code !== '') {
    return code;
  }
  return undefined;
}

/** token 计数（载荷里带才记，不带就是「不知道」）。 */
function readTokens(
  obj: Record<string, unknown> | undefined,
): { input?: number; output?: number } | undefined {
  if (obj === undefined) {
    return undefined;
  }
  const tokens = obj['tokens'];
  if (!isPlainObject(tokens)) {
    return undefined;
  }
  const input = readNumber(tokens['input']);
  const output = readNumber(tokens['output']);
  if (input === undefined && output === undefined) {
    return undefined;
  }
  return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
}

/** callId 提取 —— 只接受非空字符串。 */
function readCallId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** JSON 解析 —— 失败返回 undefined（不抛，原样保留）。 */
function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** 是否是普通对象（非 null、非数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 数值读取 —— 非有限数一律视为「没有」。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
