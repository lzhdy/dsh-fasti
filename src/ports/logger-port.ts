/**
 * 日志端口 —— 内核只认这个接口（平台化宿主中立 H1 切片 1）。
 *
 * 定位：记忆内核（contract/source/event/projection/memory/assembly/api）不绑定任何
 * 具体宿主的日志设施，只声明"我需要一个能分级记录文本的出口"。日志最终写到 cordis
 * logger、控制台、静默收集器还是远端，是各适配器/后端自己的事，本文件不定输出目的地，
 * 也不 import 任何宿主包或 node I/O。
 *
 * 签名约定：沿用通用的类 printf 占位风格（`%s`/`%d`/`%j`，与 Node `util.format`
 * 及 cordis logger 同一口径）。这是语言无关的通用日志形态，不是某个平台的名词；
 * dsh 适配器据此可零格式转换地薄转发，headless/测试后端可用 util.format 自行落地。
 *
 * 电平集合固定为 debug/info/warn/error 四档，够用不扩张（YAGNI）。
 */
export interface LoggerPort {
  /** 最细粒度诊断信息，正常运行默认不可见。 */
  debug(format: string, ...args: unknown[]): void;
  /** 常规生命周期/进度信息。 */
  info(format: string, ...args: unknown[]): void;
  /** 可继续运行但需被看见的异常/降级。 */
  warn(format: string, ...args: unknown[]): void;
  /** 本轮失败/被旁路捕获的错误，不得静默吞掉。 */
  error(format: string, ...args: unknown[]): void;
}
