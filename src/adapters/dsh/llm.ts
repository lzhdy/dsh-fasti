/**
 * dsh 宿主的 LLM 端口实现（技术基线 §6.6）。
 *
 * 这是**唯一**调模型的地方 —— 内核（event / contract / source / core）只认
 * `src/event/llm-port.ts` 的接口，不认识宿主；本文件也不再 import 任何宿主包。
 *
 * 宿主纪律：**不硬编码 API key**，凭据来自宿主（OAuth 账号路由）。本文件只依赖
 * `DshModelRoute` 这层最小形状 —— 宿主怎么路由由宿主决定。
 *
 * 后台自管理循环（闭合 / 记忆投影两个 worker）已抽到宿主无关的
 * `src/assembly/recurring-worker.ts`，经 LifecyclePort / SchedulerPort / LoggerPort
 * 驱动；本文件只保留投影 drain 的轮询预算常量与模型端口本身。
 *
 * 摘要 JSON 的线协议 strict 解析是宿主无关的，平台化 H3 起收敛到
 * `src/event/llm-wire-parse.ts`，与 headless 直连管道共用同一份规则；本文件只 re-export
 * task90 seam 仍从本适配器路径取用的两个结构解析函数，导出名与路径不漂移。
 *
 * 已知宿主约束（阶段 4 文档 §13.3）：headless profile 的 bundle patch 显式
 * 禁用了凭据，`MISSING_CREDENTIAL` / `ACCOUNT_SIGN_IN_REQUIRED` 是必然结果 ——
 * **跑真实 LLM 必须走 web profile**。这是真机验收的事，不影响单元测试
 * （本文件对路由是注入的，测试用假路由）。
 */

import { withDeadline } from '../../core/deadline.ts';
import { UnavailableError } from '../../core/errors.ts';
import type {
  LLMPort,
  LLMSummarizeOptions,
  LLMSummarizeRequest,
  LLMSummarizeResponse,
} from '../../event/llm-port.ts';
import { parseSummaryPayload } from '../../event/llm-wire-parse.ts';
import { DEFAULT_CLOSURE_CALL_TIMEOUT_MS } from '../../event/params.ts';

// task90 seam / L3 线协议白名单仍按本适配器路径登记这两个结构解析函数；
// 实现已收敛到宿主无关的 llm-wire-parse，这里仅 re-export 保持名字与路径不漂移。
export { parseAnchorSerialsField, parseBoundaryCandidateSerials } from '../../event/llm-wire-parse.ts';

/** 补全结果（路由**可以**只返回正文，也可以多报一个模型名）。 */
export type DshCompletionResult = string | { readonly text: string; readonly model?: string };

/** 宿主模型路由的最小形状（由 dsh 侧提供，实现走 OAuth 账号，不硬编码 API key）。 */
export interface DshModelRoute {
  /**
   * 发起一次对话补全。
   *
   * `signal` 可选：路由**应当**在收到 abort 时中断底层请求。
   * 不理会它的路由也不会拖死队列（调用方自己有时限闸），只是会留一个悬挂连接。
   */
  complete(req: { system: string; user: string; model?: string; signal?: AbortSignal }): Promise<DshCompletionResult>;
}

/** 端口构造选项。 */
export interface DshLLMPortOptions {
  /** 摘要模型（缺省 = 宿主默认模型）。 */
  readonly model?: string | undefined;
  /**
   * 没有 `signal` 时的自带兜底超时（毫秒）。
   *
   * 生产路径上超时闸在闭合管线（它拿得到注入的参数、也是队列活性的责任方），
   * 此处的兜底只为「有人绕过管线直调端口」这一种情形 —— 同默认值，不再另造一个数字。
   */
  readonly timeoutMs?: number | undefined;
}

/**
 * 构造走宿主模型路由的摘要端口。
 *
 * 超时与取消（设计稿 v1.1 §6.3.1 纪律①）：
 *  - 调用方给 `signal` → 原样透给路由，abort 时底层请求被取消；
 *  - 调用方没给 `signal` → 本端口自带的 `timeoutMs` 兜底。
 * 两种情况超时都抛 `UnavailableError`（不新增错误码），交由调用方退避重试。
 */
export function createDshLLMPort(route: DshModelRoute, options?: DshLLMPortOptions): LLMPort {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLOSURE_CALL_TIMEOUT_MS;

  return {
    async summarize(
      request: LLMSummarizeRequest,
      callOptions?: LLMSummarizeOptions,
    ): Promise<LLMSummarizeResponse> {
      const model = request.model ?? options?.model;
      const external = callOptions?.signal;

      const call = (signal: AbortSignal): Promise<DshCompletionResult> =>
        route.complete({
          system: request.system,
          user: request.user,
          ...(model === undefined ? {} : { model }),
          signal,
        });

      let raw: DshCompletionResult;
      try {
        // 有上级 signal = 上级已经管着时限（管线那条路径）→ 只透传、不重复计时；
        // 没有上级 signal = 有人绕过管线直调端口 → 自带兜底时限，绝不无限等。
        raw =
          external === undefined
            ? await withDeadline(timeoutMs, call, {
                timeoutError: () =>
                  new UnavailableError(`宿主模型路由超时（>${timeoutMs}ms 未返回，已中断）`),
              })
            : await call(external);
      } catch (error) {
        // withDeadline 已经给出「超时」语义，原样上抛（别再包一层）。
        if (error instanceof UnavailableError) {
          throw error;
        }
        // 上级 abort（或路由自己抛 AbortError）也归到「没回来」——
        // 与「模型报错」的排查方向完全不同（一个是没返回，一个是返回了错）。
        if (isAbort(error) || external?.aborted === true) {
          throw new UnavailableError('宿主模型路由调用被中止（未返回结果）', { cause: error });
        }
        // 端口不可用 → 抛既有的 UnavailableError（不新增错误码），交由调用方退避重试。
        throw new UnavailableError(`宿主模型路由调用失败：${(error as Error).message}`, { cause: error });
      }
      const text = typeof raw === 'string' ? raw : raw.text;
      const reported = typeof raw === 'string' ? undefined : raw.model;
      const response = parseSummaryPayload(text);
      // 溯源：优先信路由**实际**报出来的模型名；它没报就填我们请求的那个；
      // 连请求都没指定（宿主默认）→ 不填 → 落库为 null（不知道就是不知道）。
      const actual = reported ?? model;
      return actual === undefined ? response : { ...response, model: actual };
    },
  };
}

/** 判断错误是否是 abort（DOMException 名 / 带 name 的普通错误都要认）。 */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** 记忆投影 drain 轮询预算（毫秒）：与闭合管线预算各自独立，互不复用。 */
export const DEFAULT_MEMORY_PROJECTION_BUDGET_MS = 60_000;
