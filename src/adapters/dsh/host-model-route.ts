/**
 * 宿主 LLM 服务 → `DshModelRoute` 的胶水工厂。
 *
 * 这是适配器层内部「宿主怎么路由」的默认实现：把内核只认的
 * `complete({system,user,model?,signal?})` 最小形状，翻译成宿主
 * `ctx.llm.prepareCall → stream → BlockAssembler` 的标准调用范式
 * （与宿主内置 dsh-session-title-llm 同一套消息装配纪律）。
 *
 * 设计要点：
 *  1. **与提供方无关**：本工厂不认识 deepseek / pi-ai，也不硬编码任何
 *     密钥与端点。provider 名来自路由选择，任何已在 ctx.llm 注册的适配器
 *     （云端账号、API key、本地 OpenAI 兼容网关）都能服务摘要调用。
 *  2. **两条路由来源**：显式配置了固定摘要路由（options）就恒定走它，
 *     聊天界面切默认模型不影响摘要；没配则每次调用现读
 *     `ctx.agentDefaultModel.currentSelection()`，跟随当前默认选择。
 *  3. **凭据属于宿主**：工厂只发请求，OAuth/API key/本地无密钥环境的
 *     凭据解析全部由宿主适配器负责。
 *  4. **错误原样上抛**：额度、凭据、网络、abort 等错误不在此吞掉或改写
 *     语义，交给 `createDshLLMPort` 统一包成 UnavailableError 后进退避重试；
 *     唯一的本地例外是「流正常结束但没有任何文本块」——这属于不可用而非
 *     合法空响应，直接抛 UnavailableError，避免端口层 JSON 解析出含糊报错。
 */

import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { LlmCallConfig, PreparedLlmCall } from '@deepseek-ai/dsh-llm';

import { UnavailableError } from '../../core/errors.ts';
import type { DshModelRoute } from './llm.ts';

/** 一次模型选择的最小结构（对齐宿主 agentDefaultModel.currentSelection()）。 */
export interface HostModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
}

/**
 * 工厂所需的宿主服务面（结构类型，不依赖具体服务类）。
 *
 * 只声明用到的两个方法：
 *  - `llm.prepareCall`：绑定一次具体路由，返回冻结配置与流式入口；
 *  - `agentDefaultModel.currentSelection`：同步读取当前默认模型选择。
 */
export interface DshHostModelContext {
  readonly llm: {
    prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>;
  };
  readonly agentDefaultModel: {
    currentSelection(): HostModelSelection;
  };
}

/**
 * 固定摘要路由的可选项。
 *
 * 三个字段都可选：给哪个钉哪个，没给的字段回退当前默认选择。
 * `reasoningEffort` 保持字符串透传，合法取值由被选中模型的能力目录决定
 * （宿主 prepareCall 负责校验，工厂不做静默裁剪或别名转换）。
 */
export interface DshHostRouteOptions {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** 文本块的结构判定（ContentBlock 是可扩展联合，只取 text）。 */
interface TextBlockShape {
  readonly type: string;
  readonly text?: unknown;
}

function isTextBlock(block: TextBlockShape): block is { readonly type: 'text'; readonly text: string } {
  return block.type === 'text' && typeof block.text === 'string';
}

/**
 * 构造一个走宿主 LLM 服务的 DshModelRoute。
 *
 * @param ctx 宿主上下文，需暴露 llm 与 agentDefaultModel 两个服务。
 * @param options 可选的固定摘要路由；省略时全程跟随当前默认模型。
 */
export function createDshHostModelRoute(
  ctx: DshHostModelContext,
  options?: DshHostRouteOptions,
): DshModelRoute {
  return {
    async complete(req): Promise<{ text: string; model: string }> {
      // 路由三级回退：内核显式 model → 固定路由 → 当前默认选择。
      const fallback = ctx.agentDefaultModel.currentSelection();
      const provider = options?.provider ?? fallback.provider;
      const model = req.model ?? options?.model ?? fallback.model;
      const reasoningEffort = options?.reasoningEffort ?? fallback.reasoningEffort;

      const route: LlmCallConfig = {
        provider,
        model,
        // 宿主的 effort id 是品牌字符串，经官方构造器收口，非法取值由 prepareCall 拒入。
        ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
      };

      // prepareCall 内部完成适配器能力校验与默认值物化；signal 透传上级时限。
      const call = await ctx.llm.prepareCall(route, req.signal);

      // 摘要为一次性 user 单轮 + 独立 system，不构造会话身份（无 sessionId），
      // 也不贴 purpose：宿主 purpose 词表只有 compaction/session-title，
      // 记忆摘要两者都不是，省略即按普通辅助调用处理。
      const message = createUserMessage({
        content: [{ type: 'text', text: req.user }],
        source: { kind: 'user' },
      });

      const assembler = new BlockAssembler();
      const stream = call.stream({
        ...call.config,
        messages: [message],
        system: req.system,
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });

      for await (const chunk of stream) {
        assembler.push(chunk);
      }

      // 只拼接可见文本块；reasoning 块即使存在也不进入摘要正文。
      const text = assembler
        .blocks()
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('')
        .trim();

      if (text === '') {
        throw new UnavailableError('宿主模型流正常结束但未产出任何文本块');
      }

      // 回报实际生效的模型名（prepareCall 可能物化了适配器默认值）。
      return { text, model: call.config.model };
    },
  };
}
