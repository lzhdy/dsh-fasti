/**
 * 工具宿主端口 —— 适配器编排只认这个接口（平台化宿主中立 H1 切片 4）。
 *
 * 抽象"把工具能力注册进宿主"所需的授权接入，而不绑定任何具体宿主的依赖注入框架
 * （cordis 的 ctx.inject、其它宿主的直连注册表、headless 的内存注册表皆可实现）。
 *
 * 泛型 TToolDef 是宿主自己的"工具定义"形状。中立端口不 import 任何宿主包，故只用
 * 类型参数占位；工具到底长什么样由各适配器自行实参化（dsh 侧为 dsh-tools 的
 * ToolDefinition）。六工具的具体封装因此天然留在适配器内，不会泄漏进内核。
 */

/** 宿主工具注册表的最小面：注册一个工具定义，返回它的注销函数。 */
export interface ToolRegistry<TToolDef> {
  register(definition: TToolDef): () => void;
}

/** 一次授权工具接入回调收到的上下文。 */
export interface ToolRegistration<TToolDef> {
  /**
   * 工具注册表。
   *
   * 可能为 null：宿主宣告了工具能力、但运行面形状被裁撤或异常（没有可用 register）。
   * 接线方必须 fail-safe——跳过注册并可观测告警，绝不让主流程因此启动失败。
   */
  readonly registry: ToolRegistry<TToolDef> | null;
  /** 在本次工具接入作用域内登记清理；作用域卸载时由宿主保证执行。 */
  onDispose(cleanup: () => void): void;
}

export interface ToolHostPort<TToolDef> {
  /**
   * 申请接入宿主工具能力（同步发起注册，回调时机由宿主决定）。
   *
   * 宿主工具服务就绪后，在一个随宿主卸载自动回收的授权作用域内调用 handler；
   * 弱宿主始终不具备该服务时，handler 可以永不被调用，调用方不得据此让主流程失败
   * （对应 cordis inject 在依赖缺失时挂起子 fiber、不触发回调的语义）。
   */
  withTools(handler: (registration: ToolRegistration<TToolDef>) => void): void;
}
