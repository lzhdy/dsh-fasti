/**
 * dsh 广播事件的最小类型面 —— 只声明用到的字段，其余一律宽容处理。
 *
 * 纪律：
 *  - 所有字段都是 `unknown`（外加几个可选的结构提示），
 *    真实载荷由 dsh 宿主决定，适配器不得假设某个字段一定存在；
 *  - 这里**不引入任何 cordis 类型** —— 纯数据结构声明，
 *    便于在无宿主环境下独立测试转换口径；
 *  - `session/event` 的 cordis 事件增强声明在 `plugin.ts`（那才是宿主耦合处）。
 */

/** 内容块 —— dsh 的 content 数组元素。 */
export interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

/** 消息事件的 `data` 面（只声明用到的字段）。 */
export interface MessageEventData {
  /** user/message 的事件 id。 */
  id?: unknown;
  /** user/system 的 content 数组。 */
  content?: unknown;
  /** 来源标记；`kind === 'user'` 才是真实用户输入。 */
  source?: { kind?: unknown } | undefined;
  /** assistant/message 的消息体（真实持久化结构）。 */
  message?: { id?: unknown; content?: unknown } | undefined;
}

/** 一条 dsh 广播事件。 */
export interface DshEvent {
  /** 事件类型，如 'user/message' / 'assistant/message'。 */
  type?: unknown;
  /** 毫秒时间戳（Date.now()）。 */
  time?: unknown;
  /** 事件载荷。 */
  data?: MessageEventData | undefined;
}

/** session 对象的最小面（`id` 为 getter → header.id string）。 */
export interface DshSession {
  id?: unknown;
}
