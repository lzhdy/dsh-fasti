/**
 * 原文层读取端口 —— 与 raw-turns 并列的回查通道（定案稿 §5.0.2 约束 4）。
 *
 * 用途：按 id/seq 回查一条记录的**原始轮次正文**。历史补齐（阶段 0 的 char_count /
 * action / outcome 离线回填，任务书 C11 显式可选能力）与任何「Experience 自身带不全、
 * 必须回原文」的判定都走本端口，不直接依赖宿主的 raw-turns 实现。
 *
 * 纪律（C2a，任务书）：
 *  - 本阶段只完成**端口定义与注入**，不接入任何摄入计数逻辑；
 *  - 读不到就返回 undefined —— 调用方按「char_count=null，不猜不编」处理
 *    （失败降级表第 1 行），端口自身绝不编造正文。
 */

/** 原文回查定位 —— 与 Pointer 双定位口径一致（id 权威，channel/shard/seq 冗余）。 */
export interface RawTurnRef {
  /** 权威：原文行 id（RawTurn.event_id / Experience.observation.text.id）。 */
  readonly id: string;
  /** 冗余加速：通道命名空间。缺失时实现方不得猜测（返回 undefined）。 */
  readonly channel?: string | undefined;
  /** 冗余加速：'YYYY-MM' 分片。 */
  readonly shard?: string | undefined;
  /** 冗余加速：行号。 */
  readonly seq?: number | undefined;
}

/**
 * 原文读取端口 —— 纯函数：定位 → 原始轮次正文。
 *
 * 返回 undefined = 读不到（指针悬空 / 通道未注册 / 历史轮次缺失），
 * 调用方据此走降级路径，**不猜不编**。
 */
export type RawTurnTextReader = (ref: RawTurnRef) => string | undefined;
