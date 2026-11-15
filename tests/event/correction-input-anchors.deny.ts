/**
 * 类型护栏负例（§6.6）：六个修正 Input 携带 `anchors` 字段必须编译失败。
 *
 * 本文件被 tsconfig.test.json 收录；每条 `@ts-expect-error` 消费 excess-property 报错。
 * 若未来任一 Input 放开 anchors 字段，对应 expect-error 会变成「未使用」→ tsc 红。
 */

import type {
  CloseAndReopenInput,
  MergeInput,
  ReopenInput,
  ReviseBoundaryInput,
  RewriteSummaryInput,
  SplitInput,
} from '../../src/event/correction.ts';

// @ts-expect-error 合并入参不得携带 anchors（锚点只由闭合管线 rerun 覆写）
const denyMerge: MergeInput = { sourceIds: ['evt-a'], anchors: ['非法锚点'] };

// @ts-expect-error 拆分入参不得携带 anchors
const denySplit: SplitInput = { sourceId: 'evt-a', groups: [['exp-1']], anchors: ['非法锚点'] };

// @ts-expect-error 改边界入参不得携带 anchors
const denyReviseBoundary: ReviseBoundaryInput = { eventId: 'evt-a', anchors: ['非法锚点'] };

// @ts-expect-error 重开入参不得携带 anchors
const denyReopen: ReopenInput = { eventId: 'evt-a', anchors: ['非法锚点'] };

// @ts-expect-error 组合闭合/重开入参不得携带 anchors
const denyCloseAndReopen: CloseAndReopenInput = { closeId: 'evt-a', reopenId: 'evt-b', anchors: ['非法锚点'] };

// @ts-expect-error 重写摘要入参不得携带 anchors
const denyRewriteSummary: RewriteSummaryInput = { eventId: 'evt-a', summary: '她手写的摘要', anchors: ['非法锚点'] };

export default [
  denyMerge,
  denySplit,
  denyReviseBoundary,
  denyReopen,
  denyCloseAndReopen,
  denyRewriteSummary,
];
