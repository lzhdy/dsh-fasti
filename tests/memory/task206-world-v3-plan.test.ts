/**
 * task206 红测：v3 调参世界蓝本（1920 事件，统一调参新卷 W2-1）。
 *
 * 与 v2（task179，冻结件）的差异口径：
 *  - 规模 160 族 × 12 事件 = 1920（族大小 12 以支撑 B5 每题 10 个同族诱饵）；
 *  - 分区不再是 sealed/tuning，而是 A 标定/B 确认两个哈希切分、物理不相交的调参分区；
 *  - familyPoint 用二维分组命名（v2 线性轮转在 >lcm(24,40)=120 族必撞名，见 202 号文书）；
 *  - 词表 24 动作 × 200 物件 = 4800 池，实占 3840；高危按分区×五类精确配额（每类 140，A95/B45）。
 *
 * 纪律：纯函数直调，零 IO/时钟/随机；不建根；v2 蓝本与本测试并存、v2 哈希零漂移。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  WORLD_SCHEMA_V3,
  SEED_V3,
  FAMILY_COUNT_V3,
  FAMILY_SIZE_V3,
  TOTAL_EVENT_COUNT_V3,
  PARTITION_A_RATIO_V3,
  ACTIONS_V3,
  OBJECTS_V3,
  COLLIDE_WORDS_V3,
  DETAIL_POOL_SIZE_V3,
  DETAIL_SLOTS_V3,
  DETAIL_REUSE_PAIRS_V3,
  HIGH_RISK_QUOTA_V3,
  assertWorldV3Constraints,
  buildWorldV3,
} from '../../src/memory/audit/corpus/world-plan-v3.ts';
import type { PlannedEventV3 } from '../../src/memory/audit/corpus/world-plan-v3.ts';

/**
 * 仓内正式蓝本锁定哈希（2026-11-25 首跑生成并复核，同 v2 fa8a9f82 范式锁死）。
 * 与仓外 dryrun 的 run1.json 哈希不同：正式蓝本含完整 turns/summary 等字段，dryrun 仅精简结构。
 */
const LOCKED_SHA256 = '55fefea2979319c9a7c0362001e081b64b3fdd74e394b131ae76cf9f8ea7d976';

const cp = (s: string): number => Array.from(s).length;

test('V3-1 规模：1920 事件＝A1404＋B516、160 族每族 12、id 唯一且前缀独立', () => {
  const world = buildWorldV3();
  assert.equal(world.schema, WORLD_SCHEMA_V3);
  assert.equal(world.seed, SEED_V3);
  assert.equal(world.events.length, TOTAL_EVENT_COUNT_V3);
  assert.equal(TOTAL_EVENT_COUNT_V3, FAMILY_COUNT_V3 * FAMILY_SIZE_V3);
  const a = world.events.filter((e) => e.partition === 'tuning-a');
  const b = world.events.filter((e) => e.partition === 'tuning-b');
  assert.equal(a.length, 1404);
  assert.equal(b.length, 516);
  assert.equal(new Set(world.events.map((e) => e.familyId)).size, FAMILY_COUNT_V3);
  const ids = new Set(world.events.map((e) => e.eventId));
  assert.equal(ids.size, world.events.length, 'eventId 必须唯一');
  assert.ok(a.every((e) => /^syn-v3a-\d{4}$/.test(e.eventId)), 'A 区 id 前缀');
  assert.ok(b.every((e) => /^syn-v3b-\d{4}$/.test(e.eventId)), 'B 区 id 前缀');
  assert.equal(PARTITION_A_RATIO_V3, 0.7);
});

test('V3-2 与 v2 卡集命名空间零交集（隔离靠 id/分区，不靠词汇）', () => {
  const world = buildWorldV3();
  assert.ok(
    world.events.every((e) => !/^syn-(sealed|tuning)-/.test(e.eventId)),
    'v3 不得复用 v2 的 syn-sealed/syn-tuning 命名空间',
  );
  const famToPart = new Map<string, string>();
  for (const e of world.events) {
    const seen = famToPart.get(e.familyId);
    if (seen === undefined) famToPart.set(e.familyId, e.partition);
    else assert.equal(seen, e.partition, `族 ${e.familyId} 跨越 A/B 分区`);
  }
  assert.equal(famToPart.size, FAMILY_COUNT_V3, '160 个族各自归属唯一分区');
});

test('V3-3 逐字节可复现且锁定哈希', () => {
  const a = JSON.stringify(buildWorldV3());
  const b = JSON.stringify(buildWorldV3());
  assert.equal(a, b);
  const sha = createHash('sha256').update(a).digest('hex');
  assert.equal(sha, LOCKED_SHA256, '蓝本哈希必须锁死，改动任一字段/顺序即红');
});

test('V3-4 词池：4800 池双射全唯一、实占 3840、细节 ≤8 码点、动作 24 个且正交', () => {
  assert.equal(ACTIONS_V3.length, 24);
  assert.equal(OBJECTS_V3.length, 200);
  assert.equal(DETAIL_POOL_SIZE_V3, 24 * 200);
  assert.equal(DETAIL_SLOTS_V3, TOTAL_EVENT_COUNT_V3 * 2);
  assert.equal(DETAIL_SLOTS_V3, 3840);
  const world = buildWorldV3();
  const used = world.events.flatMap((e) => e.keyPoints.slice(1));
  assert.equal(used.length, DETAIL_SLOTS_V3, '细节槽位总数仍为 3840（每事件 2 个）');
  // 30 个受控复用把 B 方槽位原生词顶替掉（同 v2 的 1000→982 机理），故世界实际 distinct 细节 = 3840-30 = 3810。
  assert.equal(new Set(used).size, DETAIL_SLOTS_V3 - DETAIL_REUSE_PAIRS_V3, '世界用到 3810 个不同细节，同族内无重复（双射+受控复用）');
  for (const word of used) {
    assert.ok(cp(word) <= 8, `细节超 8 码点：${word}`);
    assert.ok(cp(word) >= 3, `细节过短：${word}`);
  }
  const collideBg = new Set(COLLIDE_WORDS_V3);
  for (const action of ACTIONS_V3) {
    assert.ok(!collideBg.has(action), `动作与撞词重名：${action}`);
    for (let i = 0; i < action.length; i += 1) {
      const bg = action.slice(i, i + 2);
      if (bg.length === 2) assert.ok(!collideBg.has(bg), `动作「${action}」含撞词 bigram「${bg}」`);
    }
  }
});

test('V3-5 受控复用：30 词跨族、每词恰 2 族、复用计划 30 条且只落 A 区', () => {
  const world = buildWorldV3();
  assert.equal(world.reusePlan.length, DETAIL_REUSE_PAIRS_V3);
  assert.equal(DETAIL_REUSE_PAIRS_V3, 30);
  const famOf = new Map<string, Set<string>>();
  for (const e of world.events) {
    for (const p of e.keyPoints.slice(1)) {
      if (!famOf.has(p)) famOf.set(p, new Set());
      famOf.get(p)!.add(e.familyId);
    }
  }
  const reused = [...famOf.values()].filter((s) => s.size > 1);
  assert.equal(reused.length, 30);
  for (const s of reused) {
    assert.equal(s.size, 2, '复用词每词恰 2 族');
    for (const fid of s) assert.match(fid, /^v3-a-/, `复用只许落 A 区：${fid}`);
  }
});

test('V3-6 撞词：24 个全 2 码点、每词覆盖 6–7 族、familyPoint 160 全唯一', () => {
  const world = buildWorldV3();
  assert.equal(COLLIDE_WORDS_V3.length, 24);
  for (const w of COLLIDE_WORDS_V3) assert.equal(cp(w), 2);
  const cover = new Map<string, Set<string>>();
  for (const e of world.events) {
    const head = cp(e.keyPoints[0]!) >= 2 ? Array.from(e.keyPoints[0]!).slice(0, 2).join('') : '';
    if (!COLLIDE_WORDS_V3.includes(head)) continue;
    if (!cover.has(head)) cover.set(head, new Set());
    cover.get(head)!.add(e.familyId);
  }
  assert.equal(cover.size, 24);
  for (const [, s] of cover) assert.ok(s.size >= 6 && s.size <= 7, `撞词覆盖族数应 6–7，实得 ${s.size}`);
  assert.equal(new Set(world.events.map((e) => e.keyPoints[0])).size, FAMILY_COUNT_V3, 'familyPoint 必须 160 全唯一');
});

test('V3-7 族内正交：每族 24 细节互不重复且不含本族撞词，同族对手 11 个（B5 密度10）', () => {
  const world = buildWorldV3();
  const byFamily = new Map<string, PlannedEventV3[]>();
  for (const e of world.events) {
    const list = byFamily.get(e.familyId);
    if (list === undefined) byFamily.set(e.familyId, [e]);
    else list.push(e);
  }
  assert.equal(byFamily.size, FAMILY_COUNT_V3);
  for (const [fid, events] of byFamily) {
    assert.equal(events.length, FAMILY_SIZE_V3);
    const collide = Array.from(events[0]!.keyPoints[0]!).slice(0, 2).join('');
    const details = events.flatMap((e) => e.keyPoints.slice(1));
    assert.equal(new Set(details).size, details.length, `族 ${fid} 细节重复`);
    for (const d of details) assert.ok(!d.includes(collide), `族 ${fid} 细节含本族撞词 ${collide}`);
    assert.equal(events.length - 1, 11, '每族金标外同族对手 = 11 ≥ 10');
  }
});

test('V3-8 时间轴：严格单调、每事件 1 天、周桶 275（>5）', () => {
  const world = buildWorldV3();
  const DAY = 24 * 60 * 60 * 1000;
  for (let i = 1; i < world.events.length; i += 1) {
    assert.ok(world.events[i]!.startedAtMs > world.events[i - 1]!.startedAtMs, `非单调@${i}`);
    assert.equal(world.events[i]!.startedAtMs - world.events[i - 1]!.startedAtMs, DAY);
  }
  const weeks = new Set(world.events.map((e) => Math.floor((e.startedAtMs - world.baseEpochMs) / (7 * DAY))));
  assert.equal(weeks.size, 275);
  assert.ok(world.referenceNowMs > world.events.at(-1)!.endedAtMs);
});

test('V3-9 keyPoints：每事件 3 条全 ≤10 码点，首条为族共享点', () => {
  for (const e of buildWorldV3().events) {
    assert.equal(e.keyPoints.length, 3);
    for (const p of e.keyPoints) {
      assert.ok(cp(p) <= 10 && cp(p) > 0, `${e.eventId} keyPoint 越界：${p}`);
    }
  }
});

test('V3-10 高危精确配额：五类各 140（A95/B45）、总 700、一事件至多一类、高危事件 7 turns', () => {
  const world = buildWorldV3();
  const total = new Map<string, number>();
  const byPart = { A: new Map<string, number>(), B: new Map<string, number>() };
  const carriers = [];
  for (const e of world.events) {
    assert.ok(e.highRiskLabels.length <= 1, `${e.eventId} 承载多类高危`);
    for (const l of e.highRiskLabels) {
      total.set(l, (total.get(l) ?? 0) + 1);
      const bucket = e.partition === 'tuning-a' ? byPart.A : byPart.B;
      bucket.set(l, (bucket.get(l) ?? 0) + 1);
      carriers.push(e);
    }
  }
  for (const [l, q] of HIGH_RISK_QUOTA_V3) {
    assert.equal(total.get(l), q.a + q.b, `高危 ${l} 总数须精确 ${q.a + q.b}`);
    assert.equal(total.get(l), 140);
    assert.equal(byPart.A.get(l), 95);
    assert.equal(byPart.B.get(l), 45);
  }
  assert.equal(carriers.length, 700);
  assert.ok(carriers.every((e) => e.turns.length === 7), '高危事件 7 条话头');
});

test('V3-11 指代：每族恰 2 条共 320、分属不同事件、回指本事件 pointA', () => {
  const world = buildWorldV3();
  const refs = world.events.filter((e) => e.hasRef);
  assert.equal(refs.length, FAMILY_COUNT_V3 * 2);
  const perFam = new Map<string, number>();
  for (const e of refs) {
    perFam.set(e.familyId, (perFam.get(e.familyId) ?? 0) + 1);
    const t = e.turns.find((x) => x.rawText.startsWith('上次说的那个'));
    assert.ok(t !== undefined, `${e.eventId} 缺指代句`);
    assert.ok(t!.rawText.includes(e.keyPoints[1]!), '指代须回指本事件 pointA');
  }
  assert.equal(perFam.size, FAMILY_COUNT_V3);
  for (const [, n] of perFam) assert.equal(n, 2);
});

test('V3-12 确定性噪声存在且不吞细节，两次构建完全一致', () => {
  const world = buildWorldV3();
  const allTurns = world.events.flatMap((e) => e.turns);
  assert.ok(allTurns.some((t) => /^(我跟你说，|那个，|哎，)/.test(t.rawText)), '须有句首噪声');
  assert.ok(allTurns.some((t) => /[啊嘛呗吧]$/.test(t.rawText)), '须有句尾噪声');
  assert.equal(JSON.stringify(buildWorldV3()), JSON.stringify(world));
});

test('V3-13 断言器自证：合规零违规，三类污染各被报出', () => {
  const world = buildWorldV3();
  assert.deepEqual(assertWorldV3Constraints(world).violations, []);

  const c1 = structuredClone(world) as typeof world;
  (c1.events[0]!.keyPoints as string[])[2] = c1.events[0]!.keyPoints[1]!;
  assert.ok(assertWorldV3Constraints(c1).violations.length > 0, '细节重复须报违规');

  const c2 = structuredClone(world) as typeof world;
  (c2.events[1] as { startedAtMs: number }).startedAtMs = c2.events[0]!.startedAtMs;
  assert.ok(assertWorldV3Constraints(c2).violations.length > 0, '时间轴破坏须报违规');

  const c3 = structuredClone(world) as typeof world;
  const ref = c3.events.find((e) => e.hasRef)!;
  const turn = ref.turns.find((t) => t.rawText.startsWith('上次说的那个'))!;
  (turn as { rawText: string }).rawText = '上次说的那个毫不相干假细节的事，后来你帮我留意了吗';
  assert.ok(assertWorldV3Constraints(c3).violations.length > 0, '指代越界须报违规');
});
