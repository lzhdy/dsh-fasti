/**
 * dsh 事件 → 原文行输入（RawTurnInput）的**纯转换**。
 *
 * 纪律（阶段 4 任务书 §4.3）：
 *  - **不调任何 LLM、零判断、零提炼** —— 纯机械映射；
 *  - **纯函数**：不读文件、不写盘、不取当前时间（`ingested_at` 留空，
 *    由 `ingestRawTurn` 在落盘时分配唯一落盘时刻）；
 *  - **不伪造**：缺 id、缺有效时间、提取不到正文 → 跳过并告警，绝不编造。
 *
 * 口径与阶段 3 迁移脚本 `scripts/migrate-raw-turns.ts` 的 `readHarnessSession`
 * **逐条对齐**（该脚本已逐字复刻旧项目 `dsh-persona-innate` 的
 * `buildRawTurn` / `rawTextOf` / `joinTextBlocks` / `assistantTextFromBlocks`）——
 * 保证「历史转写」与「实时摄入」对同一条事件产出一致的正文。
 *
 * 与阶段 3 的两处**有意差异**：
 *  1. `ingested_at` 留空（迁移是回填历史，必须保留历史时间；
 *     实时摄入应记真实落盘时刻 —— 世界轴与系统轴分离，定案稿 §5）；
 *  2. 只处理 user / assistant 两类事件（任务书 §4.3 明确范围；
 *     迁移脚本额外处理 tool / system 是历史数据的既有形态）。
 */

import type { RawTurnInput } from '../../contract/raw-turn.ts';
import type { ContentBlock, DshEvent, DshSession } from './event-types.ts';

/**
 * 运行时上下文注入的正文特征。
 *
 * 逐字复刻旧仓库 `src/raw-turn.ts` 的 `RUNTIME_CONTEXT_RE`，
 * 与阶段 3 迁移脚本同源 —— 即使 `source.kind === 'user'`，
 * 正文以此开头也判定为系统注入并跳过。
 */
export const RUNTIME_CONTEXT_RE = /^(current runtime context|this snapshot supersedes)/i;

/** 转换结果。 */
export interface ConvertResult {
  /** 转换成功 → 原文行输入；被跳过 → null。 */
  input: RawTurnInput | null;
  /** 跳过原因（可观测 —— 不静默吞事件）。 */
  skip: SkipReason | null;
  /** 告警列表（非 text 内容块等）。 */
  warnings: string[];
}

/** 跳过的原因分类。 */
export interface SkipReason {
  /** 分类：调用方据此决定日志级别。 */
  kind: 'not-message' | 'system-injection' | 'no-text' | 'no-event-id' | 'no-time' | 'runtime-context';
  /** 人读说明。 */
  detail: string;
  /** 事件 id（若能取到）；取不到则为 undefined。 */
  eventId?: string | undefined;
}

/**
 * content[] 中 type==='text' 块的 text join（user 侧）。
 *
 * 逐字复刻旧仓库 `joinTextBlocks`：**用单个空格连接**，再 `.trim()`。
 */
export function joinTextBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) {
    return '';
  }
  return blocks
    .filter(
      (b): b is ContentBlock =>
        !!b && typeof b === 'object' && (b as ContentBlock).type === 'text',
    )
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join(' ')
    .trim();
}

/**
 * 助手正文提取。
 *
 * 逐字复刻旧仓库 `assistantTextFromBlocks`：**从后往前**找第一条有非空 text 的块，
 * 返回**该块的 `.trim()`**（不 join）。
 *
 * 与 user 侧的 join 口径不对称 —— 这是旧系统的既定语义：
 * 助手末尾若有 reasoning / tool_call 等非表达块，只取最后一个表达块。
 */
export function assistantTextFromBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) {
    return null;
  }
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i] as ContentBlock | undefined;
    if (!block) {
      continue;
    }
    const text = block.text;
    if (
      typeof text === 'string' &&
      text.trim() !== '' &&
      (block.type === 'text' || block.type === undefined)
    ) {
      return text.trim();
    }
  }
  return null;
}

/**
 * 转换一条 dsh 广播事件 → 原文行输入。
 *
 * @param session dsh 的 session 对象（取 `id` 作会话标识；缺失 → 空串）
 * @param event   dsh 广播的事件
 */
export function convertSessionEvent(session: unknown, event: unknown): ConvertResult {
  const warnings: string[] = [];
  const e = (event ?? {}) as DshEvent;
  const data = e.data ?? {};
  const type = e.type;

  // ① 只处理两类消息事件；其余（turn/step/request/command/tool/system…）跳过。
  if (type !== 'user/message' && type !== 'assistant/message') {
    return {
      input: null,
      skip: { kind: 'not-message', detail: `非消息事件（type=${String(type)}）` },
      warnings,
    };
  }

  // ② user：只取真实用户输入。系统注入（runtime-context / time-context /
  //    skill-catalog）是 harness 的正常形态 → 跳过，且**不算异常**（不告警）。
  if (type === 'user/message' && data.source?.kind !== 'user') {
    return {
      input: null,
      skip: {
        kind: 'system-injection',
        detail: `系统注入的 user 消息（source.kind=${String(data.source?.kind)}）`,
      },
      warnings,
    };
  }

  // ③ 正文提取。
  let rawText: string | null;
  if (type === 'user/message') {
    rawText = joinTextBlocks(data.content);
  } else {
    rawText =
      assistantTextFromBlocks(data.message?.content) ?? assistantTextFromBlocks(data.content);
  }

  // ④ 非 text 内容块（image/audio 等）：只取 text 部分，但**必须告警** ——
  //    多模态内容未被转写，若静默丢弃就等于悄悄改了她的原话。
  const blocks = type === 'user/message' ? data.content : (data.message?.content ?? data.content);
  if (Array.isArray(blocks)) {
    const nonText = blocks.filter(
      (b) => !(!!b && typeof b === 'object' && (b as ContentBlock).type === 'text'),
    );
    if (nonText.length > 0) {
      const kinds = [
        ...new Set(nonText.map((b) => String((b as ContentBlock).type ?? '(无type)'))),
      ];
      warnings.push(
        `含 ${nonText.length} 个非 text 内容块（${kinds.join(', ')}）；只取 text 部分，多模态内容未处理（不落字节、不转述）`,
      );
    }
  }

  // ⑤ 空正文 → 跳过，不写空、不伪造。
  if (rawText === null || rawText === '') {
    return {
      input: null,
      skip: { kind: 'no-text', detail: '消息提取不到任何非空 text' },
      warnings,
    };
  }

  // ⑥ 运行时上下文二次过滤（与旧系统 buildRawTurn 同口径）。
  if (RUNTIME_CONTEXT_RE.test(rawText)) {
    return {
      input: null,
      skip: {
        kind: 'runtime-context',
        detail: '正文命中运行时上下文特征（current runtime context / this snapshot supersedes）',
      },
      warnings,
    };
  }

  // ⑦ event_id：user 取 data.id；assistant 取 data.message.id。缺失 → 跳过
  //    （没有幂等键就不能安全摄入）。
  const idCandidate = type === 'user/message' ? data.id : data.message?.id;
  if (typeof idCandidate !== 'string' || idCandidate === '') {
    return {
      input: null,
      skip: {
        kind: 'no-event-id',
        detail: `${type} 事件缺少 ${type === 'user/message' ? 'data.id' : 'data.message.id'} —— 无法建立幂等键`,
      },
      warnings,
    };
  }

  // ⑧ 时间：事件顶层 time（毫秒）→ ISO。缺失 → 跳过，**不伪造时间**。
  const time = e.time;
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    return {
      input: null,
      skip: { kind: 'no-time', detail: '事件缺少有效 time —— 无法确定事件时刻', eventId: idCandidate },
      warnings,
    };
  }

  // ⑨ 会话 id：缺失 → 空串（不报错、不丢事件）。
  const sessionId = (session as DshSession | undefined)?.id;
  const sessionIdText = typeof sessionId === 'string' ? sessionId : '';

  return {
    input: {
      event_id: idCandidate,
      session_id: sessionIdText,
      // turn_id 在 dsh 事件里不可得 —— 显式空串，禁止伪造。
      turn_id: '',
      speaker: type === 'user/message' ? 'user' : 'assistant',
      raw_text: rawText,
      asserted_at: new Date(time).toISOString(),
      // ingested_at 留空 —— 落盘时刻由 ingestRawTurn 唯一分配。
    },
    skip: null,
    warnings,
  };
}
