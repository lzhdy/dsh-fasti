/**
 * #42 · B1 第三批：纯 planner 结构红测（正本 §3.4 残差铁律、§3.5 R-06 别名重绑、
 * §2.5 rules 版本协议、§3.7 不碰 miss/影子观测）。
 *
 * 被测目标模块（写者落地，B1）：`src/memory/planner.ts` —— 纯函数规划层，
 * 不接 worker、不开运行期写路径、零 IO。plan 只产出「要做什么动作」，由 B2 编排落库。
 *
 * 登记给写者的 planner.ts 导出契约（类型/函数名以此为准；动作结构不得携带残差字段）：
 *  - `PLANNER_ACTION_TYPES`：动作类型封闭集合；
 *  - `planProjection(input)`：返回 `{ status, actions, revisionActions }`。
 *
 * 残差铁律（§3.4）：`hit_count`/`weight`/`last_hit_ms`（TS 侧 hitCount/weight/lastHitMs）
 * 属检索累积态残差，**不出现在任何 plan 动作结构里**；miss 行与影子观测也不进 plan 动作。
 * 本文件只写测试，绝不改 src/。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveCardId } from '../../src/memory/content-hash.ts';

// ── planner.ts 模块契约镜像（运行时动态加载，避免悬空静态 import）─────────────

type PlanActionType = 'create-card' | 'update-card' | 'invalidate-card' | 'migrate-aliases';

interface PlanCardRef {
  readonly eventId: string;
  readonly cardId: string;
  readonly anchors: readonly string[];
  readonly channel: string;
  readonly startedMs: number;
  readonly endedMs: number;
}

interface PlanAliasRef {
  readonly eventId: string;
  readonly cardId: string;
  readonly termNorm: string;
  readonly sensitive: 0 | 1;
  readonly hitCount: number;
  readonly lastHitMs: number | null;
}

interface PlanInput {
  readonly previous: readonly PlanCardRef[];
  readonly current: readonly PlanCardRef[];
  readonly aliases: readonly PlanAliasRef[];
  /** 本批派生规则版本（决策行 model_tag 固化口径）。 */
  readonly rulesVersion: string;
  /** 投影上一次 stamp 的规则版本；null = 空白投影。 */
  readonly projectionRulesVersion: string | null;
}

type MigratedAlias = {
  readonly termNorm: string;
  readonly sensitive: 0 | 1;
  readonly hitCount: number;
  readonly lastHitMs: number | null;
};

type PlanAction =
  | {
      readonly type: 'create-card';
      readonly eventId: string;
      readonly cardId: string;
      readonly anchors: readonly string[];
      readonly channel: string;
      readonly startedMs: number;
      readonly endedMs: number;
    }
  | {
      readonly type: 'update-card';
      readonly eventId: string;
      readonly cardId: string;
      readonly anchors: readonly string[];
      readonly channel: string;
      readonly startedMs: number;
      readonly endedMs: number;
    }
  | { readonly type: 'invalidate-card'; readonly eventId: string; readonly cardId: string }
  | {
      readonly type: 'migrate-aliases';
      readonly eventId: string;
      readonly fromCardId: string;
      readonly toCardId: string;
      readonly aliases: readonly MigratedAlias[];
    };

interface PlanResult {
  readonly status: 'ok' | 'rebuild-required';
  readonly actions: readonly PlanAction[];
  /** 空轮不追加 revision：本轮需落 revision 账本的动作数。 */
  readonly revisionActions: readonly PlanAction[];
}

interface PlannerModule {
  readonly PLANNER_ACTION_TYPES: readonly PlanActionType[];
  planProjection: (input: PlanInput) => PlanResult;
}

const PLANNER_URL = new URL('../../src/memory/planner.ts', import.meta.url);

async function loadPlanner(): Promise<PlannerModule> {
  const mod = (await import(PLANNER_URL.href)) as Partial<PlannerModule>;
  assert.equal(
    Array.isArray(mod.PLANNER_ACTION_TYPES),
    true,
    'planner.ts 须导出 PLANNER_ACTION_TYPES（动作类型封闭集合，结构断言用）',
  );
  assert.equal(typeof mod.planProjection, 'function', 'planner.ts 须导出 planProjection（纯规划）');
  return mod as PlannerModule;
}

// ── 确定性夹具 ──────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-11-08T10:00:00.000Z');
const DAY = 24 * 3600 * 1000;

const ANCHOR_A = '01J0000000000000000000000A';
const ANCHOR_B = '01J0000000000000000000000B';
const EVENT_ID = 'evt-plan-1';

const OLD_CARD = deriveCardId(EVENT_ID, [ANCHOR_A]);
const NEW_CARD = deriveCardId(EVENT_ID, [ANCHOR_B]);

function cardRef(eventId: string, cardId: string, anchors: readonly string[]): PlanCardRef {
  return {
    eventId,
    cardId,
    anchors: [...anchors],
    channel: 'dsh',
    startedMs: T0,
    endedMs: T0 + DAY,
  };
}

/** 残差字段名（DB 列名 + TS 驼峰两种写法都拦）—— plan 动作键集合里不得出现。 */
const FORBIDDEN_RESIDUAL_KEYS = [
  'hit_count',
  'hitCount',
  'weight',
  'last_hit_ms',
  'lastHitMs',
  'miss',
  'observation',
  'observed_at',
  'audit',
] as const;

function assertNoResidualOrObservationFields(action: PlanAction, label: string): void {
  for (const key of Object.keys(action)) {
    assert.ok(
      !(FORBIDDEN_RESIDUAL_KEYS as readonly string[]).includes(key),
      `${label} 动作结构不得携带残差/观测字段：${key}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 残差铁律（§3.4 / R-09 结构位）：动作类型封闭；新建/更新是两种不同类型；
// 更新卡动作结构上不存在 hit_count/weight/last_hit_ms。
// ═══════════════════════════════════════════════════════════════════════════

test('残差铁律：动作类型集合恰为 create-card/update-card/invalidate-card/migrate-aliases', async () => {
  const planner = await loadPlanner();
  assert.deepEqual([...planner.PLANNER_ACTION_TYPES].sort(), [
    'create-card',
    'invalidate-card',
    'migrate-aliases',
    'update-card',
  ]);
  assert.ok(
    planner.PLANNER_ACTION_TYPES.includes('create-card'),
    '新建卡与更新卡必须是两种不同动作类型',
  );
  assert.ok(planner.PLANNER_ACTION_TYPES.includes('update-card'));
  assert.notEqual(
    planner.PLANNER_ACTION_TYPES.indexOf('create-card'),
    planner.PLANNER_ACTION_TYPES.indexOf('update-card'),
  );
});

test('残差铁律：所有 plan 动作键集合不含 hit_count/weight/last_hit_ms 与 miss/观测字段', async () => {
  const planner = await loadPlanner();
  // 锚点变化 → 旧卡 invalidate + 新卡 create + 别名迁移，四类动作尽量都覆盖到。
  const plan = planner.planProjection({
    previous: [cardRef(EVENT_ID, OLD_CARD, [ANCHOR_A])],
    current: [cardRef(EVENT_ID, NEW_CARD, [ANCHOR_B])],
    aliases: [
      {
        eventId: EVENT_ID,
        cardId: OLD_CARD,
        termNorm: '晚餐',
        sensitive: 0,
        hitCount: 5,
        lastHitMs: T0,
      },
    ],
    rulesVersion: 'rules-v1',
    projectionRulesVersion: 'rules-v1',
  });
  assert.ok(plan.actions.length > 0, '夹具应至少产出一个动作');
  for (const action of plan.actions) {
    assertNoResidualOrObservationFields(action, action.type);
  }

  // update-card 动作（若本轮产出）键集合精确不含残差三字段。
  for (const action of plan.actions) {
    if (action.type === 'update-card') {
      const keys = new Set(Object.keys(action));
      for (const forbidden of ['hit_count', 'hitCount', 'weight', 'last_hit_ms', 'lastHitMs']) {
        assert.ok(!keys.has(forbidden), `update-card 结构不得含残差字段 ${forbidden}`);
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// R-06 残差保留与重绑：锚点变化换 card_id 后，别名按 event_id 迁移到新卡；
// 旧卡别名不丢弃；hit_count 随 event_id 走（残差归属键 = event_id 内容键）。
// ═══════════════════════════════════════════════════════════════════════════

test('R-06：锚点变化换新 card_id，别名按 event_id 迁移到新卡，hit_count 随 event_id 走', async () => {
  const planner = await loadPlanner();
  const plan = planner.planProjection({
    previous: [cardRef(EVENT_ID, OLD_CARD, [ANCHOR_A])],
    current: [cardRef(EVENT_ID, NEW_CARD, [ANCHOR_B])],
    aliases: [
      {
        eventId: EVENT_ID,
        cardId: OLD_CARD,
        termNorm: '晚餐',
        sensitive: 0,
        hitCount: 5,
        lastHitMs: T0,
      },
    ],
    rulesVersion: 'rules-v1',
    projectionRulesVersion: 'rules-v1',
  });

  const invalidate = plan.actions.find((action) => action.type === 'invalidate-card' && action.cardId === OLD_CARD);
  assert.ok(invalidate, '旧卡须被 invalidate（锚点变化）');

  const create = plan.actions.find((action) => action.type === 'create-card' && action.cardId === NEW_CARD);
  assert.ok(create, '新卡须被 create-card');

  const migrate = plan.actions.find(
    (action): action is Extract<PlanAction, { type: 'migrate-aliases' }> =>
      action.type === 'migrate-aliases' && action.eventId === EVENT_ID,
  );
  assert.ok(migrate, '须有按 event_id 归属的 migrate-aliases 动作');
  assert.equal(migrate!.fromCardId, OLD_CARD, '别名从旧卡迁出');
  assert.equal(migrate!.toCardId, NEW_CARD, '别名迁入新卡');
  assert.equal(migrate!.aliases.length, 1, '旧卡别名不丢弃，随迁移带走');
  const moved = migrate!.aliases[0]!;
  assert.equal(moved.termNorm, '晚餐', '别名词原样迁移');
  assert.equal(moved.hitCount, 5, 'hit_count 随 event_id 重绑到新卡，不被重置');
  assert.equal(moved.lastHitMs, T0, 'last_hit_ms 随残差一并迁移');
});

// ═══════════════════════════════════════════════════════════════════════════
// 空轮：plan 为空时 revision 动作数为 0（不追加 revision 账本行）。
// ═══════════════════════════════════════════════════════════════════════════

test('空轮：前后态一致 → actions 为空、revisionActions 为 0，零写入动作', async () => {
  const planner = await loadPlanner();
  const current = [cardRef(EVENT_ID, OLD_CARD, [ANCHOR_A])];
  const plan = planner.planProjection({
    previous: current,
    current,
    aliases: [
      {
        eventId: EVENT_ID,
        cardId: OLD_CARD,
        termNorm: '晚餐',
        sensitive: 0,
        hitCount: 5,
        lastHitMs: T0,
      },
    ],
    rulesVersion: 'rules-v1',
    projectionRulesVersion: 'rules-v1',
  });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.actions.length, 0, '收敛空轮不产出卡动作');
  assert.equal(plan.revisionActions.length, 0, '空轮不追加 revision 账本');
});

// ═══════════════════════════════════════════════════════════════════════════
// R-18 rules 版本不符：返 rebuild-required，动作全空、零写入（不做运行期静默巨变）。
// ═══════════════════════════════════════════════════════════════════════════

test('R-18：投影 rules_version 与常量不符 → rebuild-required，动作全空、零写入', async () => {
  const planner = await loadPlanner();
  const plan = planner.planProjection({
    previous: [],
    current: [cardRef(EVENT_ID, NEW_CARD, [ANCHOR_B])],
    aliases: [],
    rulesVersion: 'rules-v2',
    projectionRulesVersion: 'rules-v1',
  });
  assert.equal(plan.status, 'rebuild-required', '版本不符拒绝服务，返 rebuild-required');
  assert.equal(plan.actions.length, 0, '版本不符不产出任何运行期动作');
  assert.equal(plan.revisionActions.length, 0, '版本不符零写入');
});
