/**
 * L2 窄接口类型负例（Q4）：`ReaderRef` 只允许 `{ id, channel, occurredAtMs }`，
 * 携带任何正文 / 摘要 / 线索字段必须编译失败。与运行期 ownKeys 三面断言成对。
 *
 * 每条 `@ts-expect-error` 消费 excess-property 报错；将来窄面放开正文字段时
 * 对应 expect-error 会变成「未使用」→ tsc 红。
 */

import type { ReaderRef } from '../../src/event/anchor-refs.ts';

// @ts-expect-error Ref 不得含 raw_text 正文字段
const denyRawText: ReaderRef = { id: 'exp-1', channel: 'dsh', occurredAtMs: 1, raw_text: '用户原文' };

// @ts-expect-error Ref 不得含 body 正文字段
const denyBody: ReaderRef = { id: 'exp-1', channel: 'dsh', occurredAtMs: 1, body: '用户原文' };

// @ts-expect-error Ref 不得含 summary 摘要字段
const denySummary: ReaderRef = { id: 'exp-1', channel: 'dsh', occurredAtMs: 1, summary: '摘要' };

// @ts-expect-error Ref 不得含 cue 线索字段
const denyCue: ReaderRef = { id: 'exp-1', channel: 'dsh', occurredAtMs: 1, cue: '线索' };

export default [denyRawText, denyBody, denySummary, denyCue];
