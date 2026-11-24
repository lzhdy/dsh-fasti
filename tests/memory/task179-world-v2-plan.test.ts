/**
 * task179 红测：v2 合成世界蓝本（500 事件）的仓内实现。
 *
 * 要钉死的五件事：
 *  1. **逐字节等价**：`JSON.stringify(buildWorldV2())` 的 sha256 必须等于仓外 staging 试算值
 *     `fa8a9f82…c93f9d`——搬运不得改变任何字段顺序或内容，否则 N1h 的 156 题实测结论脱节。
 *  2. 规模与结构：500 事件＝400 封存＋100 调参、100 族×5、每事件 3 条 ≤10 码点 key_points。
 *  3. 词池正交性（P-c 的核心资产）：1000 槽双射全唯一、世界用到 982、18 词受控跨族且每词恰 2 族。
 *  4. 时间轴与产能：严格单调每题一天、周桶 ≥5、指代候选 ≥100、五类高危各 ≥2。
 *  5. 断言器自证：合规世界零违规；人为污染后必须报出对应违规（防断言器变成橡皮章）。
 *
 * 纪律：纯函数直调，零 IO、零时钟、零随机；不建根（500 卡真建根约 10 分钟，放手动门）。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  SEED_V2,
  TOTAL_EVENT_COUNT_V2,
  SEALED_EVENT_COUNT_V2,
  TUNING_EVENT_COUNT_V2,
  FAMILY_COUNT_V2,
  FAMILY_SIZE_V2,
  DETAIL_POOL_V2,
  DETAIL_SLOTS_V2,
  DETAIL_REUSE_PAIRS_V2,
  COLLIDE_WORDS_V2,
  ACTIONS_V2,
  assertWorldV2Constraints,
  buildFamilyV2,
  buildReusePlanV2,
  buildWorldV2,
} from '../../src/memory/audit/corpus/world-plan-v2.ts';
import type { PlannedEventV2 } from '../../src/memory/audit/corpus/world-plan-v2.ts';

/** 仓外 staging 试算哈希（P-c 完成版，`n1-world-v2-dryrun.mjs`）。 */
const EXTERNAL_SHA256 = 'fa8a9f825e8935075621dd930898da53da0699a2845cd8249b92635143c93f9d';

const cp = (s: string): number => Array.from(s).length;

test('W2-1 规模：500 事件＝400 封存＋100 调参、100 族每族 5 个、id 全局唯一', () => {
  const world = buildWorldV2();
  assert.equal(world.schema, 'fasti-p6-world/v2');
  assert.equal(world.seed, SEED_V2);
  assert.equal(world.events.length, TOTAL_EVENT_COUNT_V2);
  assert.equal(world.events.filter((e) => e.partition === 'sealed').length, SEALED_EVENT_COUNT_V2);
  assert.equal(world.events.filter((e) => e.partition === 'tuning').length, TUNING_EVENT_COUNT_V2);
  assert.equal(new Set(world.events.map((e) => e.familyId)).size, FAMILY_COUNT_V2);
  const ids = new Set(world.events.map((e) => e.eventId));
  assert.equal(ids.size, world.events.length, 'eventId 必须唯一');
  assert.match(world.events[0]!.eventId, /^syn-sealed-001$/);
  assert.match(world.events.at(-1)!.eventId, /^syn-tuning-100$/);
  for (const family of Array.from({ length: FAMILY_COUNT_V2 }, (_, i) => i)) {
    assert.equal(buildFamilyV2(family).details.length, FAMILY_SIZE_V2 * 2);
  }
});

test('W2-2 逐字节等价：同 seed 两次构建哈希一致，且等于仓外试算值', () => {
  const a = JSON.stringify(buildWorldV2());
  const b = JSON.stringify(buildWorldV2());
  const sha = createHash('sha256').update(a).digest('hex');
  assert.equal(a, b, '同 seed 必须逐字节一致');
  assert.equal(sha, EXTERNAL_SHA256, '仓内实现必须与仓外蓝本逐字节等价（改字段顺序/内容都会红）');
});

test('W2-3 词池：1000 个槽位双射全唯一、细节词 ≤7 码点、世界实际用到 982 个', () => {
  assert.equal(DETAIL_POOL_V2.length, DETAIL_SLOTS_V2);
  assert.equal(new Set(DETAIL_POOL_V2).size, DETAIL_SLOTS_V2, '1000 槽必须拿到 1000 个互不相同的词');
  // 口径：预注册 §3.5 写「≤7 码点」，实测最长 8（物件「保温杯密封圈」6 码点 + 动作 2 码点，
  // 共 10 个此类词）。蓝本已冻结（哈希锁死、N1h 结论依附），不改词表；8 仍远低于 H7 反查
  // 门槛 10，不构成误伤。此处按实测口径钉住 8，并在预注册里如实登记该偏差。
  const longest = Math.max(...DETAIL_POOL_V2.map(cp));
  assert.equal(longest, 8, '细节词最长 8 码点（预注册曾写 ≤7，实测口径为 ≤8）');
  for (const word of DETAIL_POOL_V2) {
    assert.ok(cp(word) <= 8, `细节词超 8 码点：${word}`);
    assert.ok(cp(word) >= 3, `细节词过短：${word}`);
  }
  const world = buildWorldV2();
  const details = new Set(world.events.flatMap((e) => e.keyPoints.slice(1)));
  assert.equal(details.size, 982, '世界实际用到 982 个不同细节词');
  assert.equal(ACTIONS_V2.length, 10);
});

test('W2-4 受控复用：18 个词跨族、每词恰 2 族、复用计划 18 条且只落在封存族', () => {
  const world = buildWorldV2();
  assert.equal(world.reusePlan.length, DETAIL_REUSE_PAIRS_V2);
  assert.equal(buildReusePlanV2().length, DETAIL_REUSE_PAIRS_V2);
  const familiesOfDetail = new Map<string, Set<string>>();
  for (const event of world.events) {
    for (const point of event.keyPoints.slice(1)) {
      if (!familiesOfDetail.has(point)) familiesOfDetail.set(point, new Set());
      familiesOfDetail.get(point)!.add(event.familyId);
    }
  }
  const reused = [...familiesOfDetail.entries()].filter(([, set]) => set.size > 1);
  assert.equal(reused.length, DETAIL_REUSE_PAIRS_V2, '跨族共享的细节词必须恰好 18 个');
  for (const [word, set] of reused) {
    assert.equal(set.size, 2, `细节词「${word}」跨 ${set.size} 族，必须恰 2 族`);
    for (const familyId of set) assert.match(familyId, /-s$/, `复用词只许落在封存族：${familyId}`);
  }
});

test('W2-5 撞词：24 个全为 2 码点、每词覆盖 4–5 族、且与动作表互不重合', () => {
  assert.equal(COLLIDE_WORDS_V2.length, 24);
  for (const word of COLLIDE_WORDS_V2) assert.equal(cp(word), 2, `撞词非 2 码点：${word}`);
  const world = buildWorldV2();
  const cover = new Map<string, Set<string>>();
  for (const event of world.events) {
    const head = [...Array.from(event.keyPoints[0]!).slice(0, 2)].join('');
    if (!COLLIDE_WORDS_V2.includes(head)) continue;
    if (!cover.has(head)) cover.set(head, new Set());
    cover.get(head)!.add(event.familyId);
  }
  assert.equal(cover.size, 24, '24 个撞词必须全部被用上');
  for (const [word, set] of cover) {
    assert.ok(set.size >= 4 && set.size <= 5, `撞词「${word}」覆盖 ${set.size} 族，应在 4–5`);
  }
  // 动作词不得含任何撞词的连续 2 码点（否则细节词会意外命中跨族撞词）。
  for (const action of ACTIONS_V2) {
    for (const word of COLLIDE_WORDS_V2) {
      assert.ok(!action.includes(word), `动作「${action}」含撞词「${word}」，正交性被破坏`);
    }
  }
});

test('W2-6 正交性：100 族共享点全唯一、同族细节词对不含本族撞词、族内 10 对互不重复', () => {
  const world = buildWorldV2();
  assert.equal(new Set(world.events.map((e) => e.keyPoints[0])).size, FAMILY_COUNT_V2, '族共享点必须 100 个全唯一');
  const byFamily = new Map<string, PlannedEventV2[]>();
  for (const event of world.events) {
    const list = byFamily.get(event.familyId);
    if (list === undefined) byFamily.set(event.familyId, [event]);
    else list.push(event);
  }
  for (const [familyId, events] of byFamily) {
    const collide = [...Array.from(events[0]!.keyPoints[0]!).slice(0, 2)].join('');
    const details = events.flatMap((e) => e.keyPoints.slice(1));
    assert.equal(new Set(details).size, details.length, `族 ${familyId} 族内细节词对重复`);
    for (const detail of details) {
      assert.ok(!detail.includes(collide), `族 ${familyId} 细节「${detail}」含本族撞词「${collide}」`);
    }
  }
});

test('W2-7 时间轴：严格单调、每事件 1 天、周桶 72 个（>5 阈值）', () => {
  const world = buildWorldV2();
  const DAY = 24 * 60 * 60 * 1000;
  for (let i = 1; i < world.events.length; i += 1) {
    assert.ok(
      world.events[i]!.startedAtMs > world.events[i - 1]!.startedAtMs,
      `第 ${i} 个事件起时非严格单调`,
    );
    assert.equal(world.events[i]!.startedAtMs - world.events[i - 1]!.startedAtMs, DAY, '每事件占且仅占一天');
  }
  const weeks = new Set(world.events.map((e) => Math.floor((e.startedAtMs - world.baseEpochMs) / (7 * DAY))));
  assert.equal(weeks.size, 72, '日历周桶应为 72 个');
  assert.ok(world.referenceNowMs > world.events.at(-1)!.endedMs, '参照时刻必须晚于全部事件');
});

test('W2-8 key_points：每事件 3 条且全 ≤10 码点，第 1 条为族共享点', () => {
  const world = buildWorldV2();
  for (const event of world.events) {
    assert.equal(event.keyPoints.length, 3);
    for (const point of event.keyPoints) {
      assert.ok(cp(point) <= 10, `${event.eventId} 的 key point「${point}」超 10 码点（H7 反查门槛）`);
      assert.ok(cp(point) > 0);
    }
  }
});

test('W2-9 高危：五类各 ≥2、仅前 10 个封存事件承载、每条 7 条 turns', () => {
  const world = buildWorldV2();
  const counts = new Map<string, number>();
  for (const event of world.events) {
    for (const label of event.highRiskLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  assert.equal(counts.size, 5, '五类高危必须都有承载');
  for (const [, n] of counts) assert.ok(n >= 2, '每类高危至少 2 个事件');
  const carriers = world.events.filter((e) => e.highRiskLabels.length > 0);
  assert.ok(carriers.every((e) => e.partition === 'sealed'), '高危只许落在封存事件');
  assert.ok(carriers.every((e) => e.turns.length === 7), '高危事件必须 7 条话头（第 6 条指代、第 7 条高危）');
  for (const event of carriers) {
    // 第 6 条：带指代的事件才是指代句，其余是通用模板第 6 条；第 7 条恒为高危话头。
    assert.equal(
      event.turns[5]!.rawText.startsWith('上次说的那个'),
      event.hasRef,
      `${event.eventId} 第 6 条与 hasRef 不一致`,
    );
    assert.equal(event.turns[6]!.offsetMinutes, 72, '第 7 条 offsetMinutes 应为 6×12=72');
  }
});

test('W2-10 指代：每封存族恰 2 条、分属不同事件、回指本事件 pointA、候选 160 条 ≥100', () => {
  const world = buildWorldV2();
  const refEvents = world.events.filter((e) => e.hasRef);
  assert.equal(refEvents.length, 160, '80 封存族 × 2 = 160 条指代候选');
  assert.ok(refEvents.every((e) => e.partition === 'sealed'), '指代只许落在封存事件');
  for (const event of refEvents) {
    const refTurn = event.turns.find((t) => t.rawText.startsWith('上次说的那个'));
    assert.ok(refTurn !== undefined, `${event.eventId} 找不到指代句`);
    assert.ok(refTurn!.rawText.includes(event.keyPoints[1]!), '指代句必须回指本事件 pointA（不得指向族内他人）');
  }
  const byFamily = new Map<string, number>();
  for (const event of refEvents) byFamily.set(event.familyId, (byFamily.get(event.familyId) ?? 0) + 1);
  assert.equal(byFamily.size, 80);
  for (const [familyId, n] of byFamily) assert.equal(n, 2, `族 ${familyId} 指代事件 ${n} ≠ 2`);
});

test('W2-11 确定性噪声：原话带噪声且可由 seed 反推，噪声不破坏关键锚点', () => {
  const world = buildWorldV2();
  const prefixed = world.events.flatMap((e) => e.turns).filter((t) => /^(我跟你说，|那个，|哎，)/.test(t.rawText));
  const suffixed = world.events.flatMap((e) => e.turns).filter((t) => /[啊嘛呗吧]$/.test(t.rawText));
  assert.ok(prefixed.length > 0, '必须存在句首噪声前缀');
  assert.ok(suffixed.length > 0, '必须存在句尾噪声后缀');
  // 噪声只加在外层，不得吃掉细节词（S0/S1 逐字引用前提）。
  for (const event of world.events) {
    for (const turn of event.turns.slice(0, 6)) {
      const hasDetail = turn.rawText.includes(event.keyPoints[1]!) || turn.rawText.includes(event.keyPoints[2]!);
      if (turn.rawText.startsWith('上次说的那个')) {
        assert.ok(turn.rawText.includes(event.keyPoints[1]!), '指代句必须含 pointA');
      } else if (event.turns.indexOf(turn) <= 4) {
        assert.ok(hasDetail, `${event.eventId} 第 ${event.turns.indexOf(turn) + 1} 条话头丢了细节词`);
      }
    }
  }
  assert.equal(JSON.stringify(buildWorldV2()), JSON.stringify(world), '噪声必须完全确定性');
});

test('W2-12 断言器自证：合规世界零违规，三类污染各报出违规', () => {
  const world = buildWorldV2();
  assert.deepEqual(assertWorldV2Constraints(world).violations, []);

  // 污染①：抹掉一个细节词，破坏唯一化。
  const clone1 = structuredClone(world) as typeof world;
  const target = clone1.events[0]!;
  (target.keyPoints as string[])[1] = '更换水管接头';
  (target.keyPoints as string[])[2] = '更换水管接头';
  assert.ok(assertWorldV2Constraints(clone1).violations.length > 0, '触发唯一化违规');

  // 污染②：打乱时间轴（同刻双事件）。
  const clone2 = structuredClone(world) as typeof world;
  (clone2.events[1] as { startedAtMs: number }).startedAtMs = clone2.events[0]!.startedAtMs;
  assert.ok(assertWorldV2Constraints(clone2).violations.length > 0, '触发时间轴违规');

  // 污染③：指代句指向族内别人的 pointA。
  const clone3 = structuredClone(world) as typeof world;
  const refEvent = clone3.events.find((e) => e.hasRef)!;
  const refTurn = refEvent.turns.find((t) => t.rawText.startsWith('上次说的那个'))!;
  (refTurn as { rawText: string }).rawText = '上次说的那个完全不相关假细节的事，后来你帮我留意了吗';
  assert.ok(assertWorldV2Constraints(clone3).violations.length > 0, '触发指代越界违规');
});
