/**
 * #127 批 1（P0）时间硬约束类型护栏负例。
 *
 * 本文件被 tsconfig.test.json 的 tests 全量 .ts 通配收录（仅 tsc 编译，不进 node --test）。
 * 每条 `@ts-expect-error` 消费一个真实编译错误；若未来类型被放开，
 * 对应 expect-error 会变成「未使用指令」→ typecheck 变红。
 *
 * 守门清单（《最终推荐与实施细则》第三节硬约束）：
 *  1. 非 WINDOW 态携带 window/closure 字段 → 红（判别联合禁混形）；
 *  2. WINDOW 态缺 closure → 红（没证明拿不到窗）；
 *  3. CANDIDATES 携带 preferred/score/rank/confidence → 红（类型上消灭首选）；
 *  4. 闭合证明出现 INFERRED 状态 → 红（只认 EXPLICIT/POLICY）；
 *  5. TimeWindow halfOpen=false、endMs<=startMs 形状逃逸 → 红；
 *  6. TimeAnchor 扩口别的时区/周开篇 → 红（首期字面量唯一值）；
 *  7. reason 自由字符串 → 红（封闭枚举）。
 */

import type {
  ClosednessProof,
  ClosureState,
  TimeAnchor,
  TimeConstraint,
  TimeUncertainReason,
  TimeWindow,
} from '../../src/memory/types.ts';

const prov = {
  anchorEpochMs: 0,
  assets: { lexicon: '1.0.0', grammar: '1.0.0', policy: '1.0.0' },
  replayKey: 'rk-deny',
};

const validWindow: TimeWindow = { startMs: 0, endMs: 1, halfOpen: true, granularity: 'DAY' };
const validProof: ClosednessProof = { dimensions: [] };

// 1a. NONE 态私带 window 字段必须编译失败。
// @ts-expect-error NONE 形态只有 kind/provenance，禁混窗字段
const denyNoneWithWindow: TimeConstraint = { kind: 'NONE', window: validWindow, provenance: prov };

// 1b. UNCERTAIN 态私带 closure 字段必须编译失败。
const denyUncertainWithClosure: TimeConstraint = {
  kind: 'UNCERTAIN',
  reason: 'VAGUE_EXPRESSION',
  spans: [],
  // @ts-expect-error UNCERTAIN 不得携带闭合证明
  closure: validProof,
  provenance: prov,
};

// 2. WINDOW 态缺 closure 必须编译失败。
// @ts-expect-error WINDOW 必带 ClosednessProof，缺证明构造不出窗
const denyWindowNoProof: TimeConstraint = { kind: 'WINDOW', window: validWindow, provenance: prov };

// 3a. CANDIDATES 携带 preferred 必须编译失败。
const denyPreferred: TimeConstraint = {
  kind: 'CANDIDATES',
  windows: [validWindow],
  ambiguity: ['x'],
  // @ts-expect-error CANDIDATES 类型上不存在首选字段
  preferred: 0,
  provenance: prov,
};

// 3b. CANDIDATES 携带 score/rank/confidence 必须编译失败。
const denyScore: TimeConstraint = {
  kind: 'CANDIDATES',
  windows: [validWindow],
  ambiguity: ['x'],
  // @ts-expect-error CANDIDATES 禁止任何打分/排序/置信字段
  score: 0.9,
  rank: 1,
  confidence: 0.5,
  provenance: prov,
};

// 4. 闭合证明状态只有 EXPLICIT/POLICY，INFERRED 必须编译失败。
// @ts-expect-error 不存在 INFERRED 闭合态（盲审收敛铁律）
const denyInferred: ClosureState = 'INFERRED';

// 5a. 半开窗标记不允许置 false。
// @ts-expect-error halfOpen 类型固定为字面量 true
const denyClosedWindow: TimeWindow = { startMs: 0, endMs: 1, halfOpen: false, granularity: 'DAY' };

// 5b. CLOCK 粒度窗首期不在 TimeWindow 联合内（契约冻结不接线）。
// @ts-expect-error 首期窗口粒度只有 DAY/WEEK
const denyClockWindow: TimeWindow = { startMs: 0, endMs: 1, halfOpen: true, granularity: 'CLOCK' };

// 6a. 锚点时区首期唯一合法值 Asia/Shanghai。
// @ts-expect-error 禁止扩口其它时区（跨时区 civilDateTime 已挂账）
const denyZone: TimeAnchor = { epochMs: 0, zoneId: 'UTC', weekStartsOn: 1, assets: prov.assets };

// 6b. 周开篇首期字面量固定 1。
// @ts-expect-error weekStartsOn 首期只接受字面量 1
const denyWeekStart: TimeAnchor = { epochMs: 0, zoneId: 'Asia/Shanghai', weekStartsOn: 0, assets: prov.assets };

// 7. UNCERTAIN reason 是封闭枚举，自由字符串必须编译失败。
// @ts-expect-error 禁止枚举外临时原因码，新增须 bump policy 版本并补夹具
const denyReason: TimeUncertainReason = 'SOMETHING_FUZZY';

export default [
  denyNoneWithWindow,
  denyUncertainWithClosure,
  denyWindowNoProof,
  denyPreferred,
  denyScore,
  denyInferred,
  denyClosedWindow,
  denyClockWindow,
  denyZone,
  denyWeekStart,
  denyReason,
];
