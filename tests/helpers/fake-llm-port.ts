/**
 * LLM 端口测试替身（#90 §11⑮：FakeLlmPort 进 tests/helpers）。
 *
 * 能力：
 *  1. **脚本化响应队列**：构造传入响应数组或按调用次数返回的函数；**无默认响应**——
 *     队列耗尽再被调用必须抛错，防止测试在脚本漏配时静默走占位结果；
 *  2. **调用计数**：`count` 为已发起 summarize 次数（成功 / 抛错各计一次）；
 *  3. **请求全文记录**：每次 summarize 的完整 Request（system / user / model /
 *     maxChars）与 options 入栈，供「request 全文零系统 ULID / 单列表 #i /
 *     重取轮反馈块」断言；
 *  4. 脚本函数可按调用次数返回不同响应，也可返回 `Error`（典型
 *     `UnavailableError`，模拟超时 / 端口不可用）——抛错原样上抛，不包一层。
 *
 * 纪律：
 *  - 本文件属测试基础设施，**src 禁止 import tests/helpers**（静态门由写者登记后
 *    测试侧补投毒断言；本注释先行固定口径）；
 *  - 线协议响应形已为 `anchor_serials: number[]`；本替身不承载 id 直注通道。
 */

import type {
  LLMPort,
  LLMSummarizeOptions,
  LLMSummarizeRequest,
  LLMSummarizeResponse,
} from '../../src/event/llm-port.ts';

/** 一次脚本化产出：响应 / 上抛错误 / 永不 resolve 的挂起态。 */
export type FakeLlmOutcome = LLMSummarizeResponse | Error | Promise<never>;

/** 永不 resolve 的挂起态（模拟模型挂住；配合超时闸使用，测试侧须 dispose 定时器）。 */
export function hangForever(): Promise<never> {
  return new Promise<never>(() => {});
}

/**
 * 脚本：
 *  - 数组：按调用下标逐个取响应 / 错误；耗尽再调即抛；
 *  - 函数：第 i 次调用返回 `script(i)`（i 从 0 起），可按轮次切响应或抛错。
 */
export type FakeLlmScript =
  | readonly (LLMSummarizeResponse | Error)[]
  | ((callIndex: number) => FakeLlmOutcome);

/** 一次被捕获的调用（请求全文 + 端口选项）。 */
export interface CapturedSummarizeCall {
  readonly request: LLMSummarizeRequest;
  readonly options: LLMSummarizeOptions | undefined;
}

/** 脚本队列耗尽时抛的错误名（测试侧可按 name 识别，不靠 message 文案）。 */
export const FAKE_QUEUE_EXHAUSTED = 'FakeLlmPortQueueExhausted';

function exhaustedError(callIndex: number): Error {
  const error = new Error(
    `FakeLlmPort: 脚本队列耗尽（第 ${callIndex + 1} 次调用无预设响应，防测试静默）`,
  );
  error.name = FAKE_QUEUE_EXHAUSTED;
  return error;
}

export class FakeLlmPort implements LLMPort {
  /** 已发起 summarize 次数（成功 / 抛错各计一次）。 */
  count = 0;
  /** 每次调用的完整请求与选项（栈顺序即调用顺序）。 */
  readonly calls: CapturedSummarizeCall[] = [];
  /** 成功返回的响应（按调用顺序；抛错的不入此栈）。 */
  readonly responses: LLMSummarizeResponse[] = [];
  /** 脚本指定上抛的错误（按调用顺序；未抛错的不入此栈）。 */
  readonly errors: Error[] = [];

  private readonly script: FakeLlmScript | undefined;

  constructor(script?: FakeLlmScript) {
    this.script = script;
  }

  private resolveOutcome(callIndex: number): FakeLlmOutcome {
    if (this.script === undefined) {
      throw exhaustedError(callIndex);
    }
    if (typeof this.script === 'function') {
      return this.script(callIndex);
    }
    const outcome = this.script[callIndex];
    if (outcome === undefined) {
      throw exhaustedError(callIndex);
    }
    return outcome;
  }

  async summarize(
    request: LLMSummarizeRequest,
    options?: LLMSummarizeOptions,
  ): Promise<LLMSummarizeResponse> {
    this.calls.push({ request, options });
    const outcome = this.resolveOutcome(this.count);
    this.count += 1;

    if (outcome instanceof Error) {
      this.errors.push(outcome);
      throw outcome;
    }
    if (outcome instanceof Promise) {
      return outcome;
    }
    this.responses.push(outcome);
    return outcome;
  }
}
