/**
 * P6 D 批 · 合成世界 v2 蓝本规划器（预注册 v5 §3，500 事件）。
 *
 * 定位：纯函数、零 IO、零时钟、零随机源——同一 seed 逐字节产出同一蓝本。
 * **与仓外 staging 试算脚本 `n1-world-v2-dryrun.mjs`（P-c 完成版）逐字节等价**：
 * `JSON.stringify(buildWorldV2())` 的 sha256 必须恒为
 * `fa8a9f825e8935075621dd930898da53da0699a2845cd8249b92635143c93f9d`（task179 W2-2 锁死）。
 * 任何字段顺序或内容改动都会让该哈希漂移，N1h 的 156 题实测结论随即脱节——故本文件
 * 视为「冻结蓝本」，改动须先升版并重跑实测。
 *
 * v1（`world-plan.ts`，100 事件）一字不动、可永久重放；本文件是并列的第二份蓝本，
 * 不参数化、不互相引用（预注册 Δ1）。
 */

export const WORLD_SCHEMA_V2 = 'fasti-p6-world/v2';
export const SEED_V2 = 20261124;
export const BASE_EPOCH_MS_V2 = Date.UTC(2026, 0, 5, 9, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

export const SEALED_FAMILIES_V2 = 80;
export const TUNING_FAMILIES_V2 = 20;
export const FAMILY_SIZE_V2 = 5;
export const FAMILY_COUNT_V2 = SEALED_FAMILIES_V2 + TUNING_FAMILIES_V2; // 100
export const TOTAL_EVENT_COUNT_V2 = FAMILY_COUNT_V2 * FAMILY_SIZE_V2; // 500
export const SEALED_EVENT_COUNT_V2 = SEALED_FAMILIES_V2 * FAMILY_SIZE_V2; // 400
export const TUNING_EVENT_COUNT_V2 = TUNING_FAMILIES_V2 * FAMILY_SIZE_V2; // 100

export type CorpusPartitionV2 = 'sealed' | 'tuning';
export type HighRiskLabelV2 = 'strong' | 'promise' | 'date' | 'verbatim' | 'negation';

/** 24 个 2 码点跨族撞词（与 SUFFIXES / ACTIONS 互不重合）。 */
export const COLLIDE_WORDS_V2: readonly string[] = [
  '预约', '续费', '报价', '改期', '确认', '到期', '退换', '签收',
  '催单', '开票', '试穿', '退订', '预留', '加急', '转单', '结算',
  '回访', '补差', '派送', '签章', '折扣', '赠品', '押金', '尾款',
];

/** 40 个 2 码点主题后缀（避开 COLLIDE_WORDS 与 ACTIONS）。 */
const SUFFIXES_V2: readonly string[] = [
  '排期', '续期', '补货', '上门', '检修', '对账', '清点', '换新', '保养', '验收',
  '报修', '催办', '归档', '进货', '盘点', '缴费', '领取', '预订', '登记', '复核',
  '送货', '回收', '改造', '翻新', '查勘', '测价', '定损', '安装', '调试', '腾退',
  '封窗', '铺管', '接驳', '刷漆', '填缝', '贴膜', '裁切', '校准', '试装', '备案',
];

/** 100 个 ≤5 码点生活物件。 */
const OBJECTS_V2: readonly string[] = [
  '水管接头', '门锁锁芯', '阳台胶条', '厨房顶灯', '冰箱抽屉', '排水地漏', '插座面板', '窗帘轨道', '热水阀芯', '空调滤网',
  '衣柜门铰', '地砖缝隙', '墙面腻子', '洗衣机带', '燃气软管', '防盗门镜', '马桶浮球', '吊柜拉手', '晾衣钢丝', '水表读数',
  '电表余额', '燃气表卡', '楼道声灯', '门禁读卡', '电梯按钮', '护栏油漆', '防盗窗扣', '纱窗卡扣', '洗衣机网', '油烟油盒',
  '水槽下水', '浴霸灯泡', '马桶圈盖', '淋浴花洒', '厨房龙头', '冰箱封条', '微波托盘', '电磁炉面', '电饭内胆', '儿童护栏',
  '抽屉滑轨', '阳台上水', '窗台石缝', '台面玻璃胶', '洗手溢水', '灶具点火针', '热水镁棒', '净水滤芯', '吸尘滚刷', '水箱盖板',
  '衣柜背板', '晾被横杆', '门吸缓冲', '鞋柜封边', '踢脚脱胶', '衣柜防潮', '插座防水', '水壶底座', '挂钟电池', '门帘滑轨',
  '餐椅坐垫', '书桌桌角', '窗帘挂环', '床垫护角', '沙发扶手套', '茶几玻璃面', '电视挂架', '鞋架层板', '雨伞架', '衣帽钩',
  '毛巾挂杆', '浴室置物架', '牙刷杯座', '牙膏挤压器', '马桶刷架', '拖把挂钩', '垃圾袋盒', '米箱密封圈', '调料拉篮', '锅盖支架',
  '砧板防滑垫', '保鲜盒扣', '饭勺挂钩', '水槽沥水篮', '碗碟架', '筷子筒', '烧水壶滤网', '保温杯密封圈', '便当袋拉链', '餐垫防滑',
  '桌布夹', '开瓶器', '量杯刻度', '围裙挂带', '隔热手套', '烤盘油纸', '锡纸盒', '厨房秤电池', '搅拌棒座', '煮蛋器架',
];

/**
 * 10 个 2 码点维修动作。动作表由 2 扩到 10：词典规模 2×100=200 时 1000 个细节位置
 * 必被压成每词 5 族（N1e 实测过门卡证据完全打平、排序器不可判别），故先把词典扩到
 * 与位置数等量，唯一化才可能成立。全部动作词均不含 COLLIDE_WORDS / SUFFIXES 的
 * 任何连续 2 码点（否则细节词会意外命中跨族撞词）。
 */
export const ACTIONS_V2: readonly string[] = ['更换', '维修', '清洗', '疏通', '加固', '除锈', '紧固', '打胶', '除尘', '擦拭'];

/** 每个事件 2 个细节 → 世界总细节位置数。 */
export const DETAIL_SLOTS_V2 = TOTAL_EVENT_COUNT_V2 * 2; // 1000

/** 槽位 → 细节词的双射：动作 = s/100，物件 = s%100。1000 槽拿到 1000 个互不相同的词。 */
function detailAtSlotV2(slot: number): string {
  return ACTIONS_V2[Math.floor(slot / OBJECTS_V2.length) % ACTIONS_V2.length]! + OBJECTS_V2[slot % OBJECTS_V2.length]!;
}

/** 细节词池：1000 个全局唯一细节（10 动作 × 100 物件），确定性且 ≤7 码点。 */
export const DETAIL_POOL_V2: readonly string[] = Array.from({ length: DETAIL_SLOTS_V2 }, (_, s) => detailAtSlotV2(s));

const GENERIC_TEMPLATES_V2: readonly string[] = [
  '{a}那事我一直挂着，你帮我理一下头绪',
  '我想问清楚{a}的安排，{b}那边怎么配合',
  '之前提过的{a}，后来{b}有没有新消息',
  '{a}跟{b}是不是同一类问题，别给我搞混了',
  '帮我记着{a}这个情况，{b}先按兵不动',
];
const REF_TEMPLATE_V2 = '上次说的那个{a}的事，后来你帮我留意了吗';

export const HIGH_RISK_LABELS_V2: readonly HighRiskLabelV2[] = ['strong', 'promise', 'date', 'verbatim', 'negation'];
const HIGH_RISK_TEMPLATES_V2: Readonly<Record<HighRiskLabelV2, string>> = {
  strong: '我把话放这儿，{a}这件事绝对不能再拖，{b}必须本周搞定',
  promise: '我答应过{n}，{a}这周一定给准信，{b}也一并承诺下来',
  date: '记好了，{a}定在一月十八号上午九点，{b}的截止日是同月二十号',
  verbatim: '逐字记住这句：{a}报价三百二十八块五，{b}工费另算，一个字都别改',
  negation: '千万别先动{b}，{a}没确认之前不要回复任何人',
};

/** 确定性噪声规则：仅在部分句首/句尾施加，可由 (seed, 事件序, turn 序) 全量反推。 */
const NOISE_PREFIX_V2: readonly string[] = ['我跟你说，', '那个，', '哎，'];
const NOISE_SUFFIX_V2: readonly string[] = ['啊', '嘛', '呗', '吧'];

export interface PlannedTurnV2 {
  readonly speaker: 'user';
  readonly offsetMinutes: number;
  readonly rawText: string;
}

export interface PlannedEventV2 {
  readonly eventId: string;
  readonly partition: CorpusPartitionV2;
  readonly familyId: string;
  readonly channel: 'dsh';
  readonly startedAtMs: number;
  readonly endedMs: number;
  /** 固定 3 条：[族共享点, 事件专属点 A, 事件专属点 B]，全部 ≤10 码点（H7 门槛）。 */
  readonly keyPoints: readonly string[];
  readonly summary: string;
  readonly turns: readonly PlannedTurnV2[];
  readonly highRiskLabels: readonly HighRiskLabelV2[];
  readonly sensitiveTerms: readonly string[];
  /** 本事件是否承载 S5 指代句。**答案侧**：禁止进入盲包（task179 违禁键表）。 */
  readonly hasRef: boolean;
}

export interface FamilyPlanV2 {
  readonly familyId: string;
  readonly partition: CorpusPartitionV2;
  readonly familyPoint: string;
  readonly collide: string;
  readonly details: string[];
}

export interface ReusePairV2 {
  readonly fi: number;
  readonly fj: number;
  readonly slot: number;
}

export interface WorldPlanV2 {
  readonly schema: typeof WORLD_SCHEMA_V2;
  readonly seed: number;
  readonly baseEpochMs: number;
  readonly referenceNowMs: number;
  readonly events: readonly PlannedEventV2[];
  readonly reusePlan: readonly ReusePairV2[];
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function fill(t: string, a: string, b: string, n: string): string {
  return t.replaceAll('{a}', a).replaceAll('{b}', b).replaceAll('{n}', n);
}

/** 纯索引哈希，无 Math.random，保证跨机一致（IEEE754 精度内确定性）。 */
function pickIndex(seed: number, ...mods: number[]): number {
  let h = seed;
  for (const m of mods) h = (h * 1103515245 + 12345 + m * 7919) % 2147483647;
  return h;
}

export function buildFamilyV2(familyIndex: number): FamilyPlanV2 {
  const isSealed = familyIndex < SEALED_FAMILIES_V2;
  // 撞词按族序轮转：100 族覆盖全部 24 词，每词 ≥4 族（跨族撞词保证）。
  const collide = COLLIDE_WORDS_V2[familyIndex % COLLIDE_WORDS_V2.length]!;
  // 后缀步长取 7（与 40 互质，且与 24 的最小公倍数 120 > 100）→ 100 族 familyPoint 全唯一。
  const suffix = SUFFIXES_V2[(familyIndex * 7 + 11) % SUFFIXES_V2.length]!;
  const familyPoint = collide + suffix;
  const details: string[] = [];
  // 槽位 = 族序×10 + k，与 detailAtSlotV2 双射配套 → 100 族 1000 槽全取唯一细节词。
  for (let k = 0; k < FAMILY_SIZE_V2 * 2; k += 1) {
    details.push(DETAIL_POOL_V2[familyIndex * (FAMILY_SIZE_V2 * 2) + k]!);
  }
  return {
    familyId: `f${String(familyIndex + 1).padStart(3, '0')}-${isSealed ? 's' : 't'}`,
    partition: isSealed ? 'sealed' : 'tuning',
    familyPoint,
    collide,
    details,
  };
}

/**
 * P-c 受控复用：唯一化会把过门卡压到恒 1 张（N1f 实测），多候选压力消失，排序能力
 * 就无从验证。故另设一小批细节词故意跨 2 族出现，专供「排序压力题」，与主线唯一化
 * 题库分开统计。
 *
 * 为什么是 2 族而不是 4–5 族：N1e 实测每词 4–5 族时过门卡证据完全打平（structuralTie
 * 59/60），任何排序器都不可判别；2 族时金标可靠 pointA+pointB 双命中把证据做厚、
 * 诱饵只命中单点，是可判别的。
 */
export const DETAIL_REUSE_PAIRS_V2 = 18;

/** 确定性复用计划：(fi 提供细节词, fj 被替换一槽, slot 槽位序号)。同一族只能出场一次。 */
export function buildReusePlanV2(): ReusePairV2[] {
  const plan: ReusePairV2[] = [];
  const used = new Set<number>();
  let i = 0;
  while (plan.length < DETAIL_REUSE_PAIRS_V2) {
    if (i > 1000) throw new Error('复用计划凑不满，检查步长互素性');
    // 只在封存族内配对：出题端只考封存卷，调参族保持绝对干净。
    const fi = (i * 7) % SEALED_FAMILIES_V2;
    const fj = (i * 13 + 3) % SEALED_FAMILIES_V2;
    i += 1;
    if (fi === fj || used.has(fi) || used.has(fj)) continue;
    used.add(fi);
    used.add(fj);
    plan.push({ fi, fj, slot: plan.length % (FAMILY_SIZE_V2 * 2) });
  }
  return plan;
}

export function buildWorldV2(): WorldPlanV2 {
  const families: FamilyPlanV2[] = [];
  for (let i = 0; i < FAMILY_COUNT_V2; i += 1) families.push(buildFamilyV2(i));

  // 施加受控复用：fj 的该槽改为 fi 的原生细节词（取 DETAIL_POOL 原值，不受其他替换影响）。
  const reusePlan = buildReusePlanV2();
  for (const { fi, fj, slot } of reusePlan) {
    families[fj]!.details[slot] = DETAIL_POOL_V2[fi * (FAMILY_SIZE_V2 * 2) + slot]!;
  }

  const events: PlannedEventV2[] = [];
  let sealedIndex = 0;
  let tuningIndex = 0;
  for (let familyIndex = 0; familyIndex < families.length; familyIndex += 1) {
    const family = families[familyIndex]!;
    for (let within = 0; within < FAMILY_SIZE_V2; within += 1) {
      const globalIndex = events.length;
      const eventId =
        family.partition === 'sealed'
          ? `syn-sealed-${pad3(++sealedIndex)}`
          : `syn-tuning-${pad3(++tuningIndex)}`;
      const a = family.details[within * 2]!;
      const b = family.details[within * 2 + 1]!;

      // 指代句：每封存族第 2、4 个事件（within=1、3）各 1 条，替换第 6 条通用模板位置。
      const hasRef = family.partition === 'sealed' && (within === 1 || within === 3);

      const turns: Array<{ speaker: 'user'; offsetMinutes: number; rawText: string }> = [];
      for (let t = 0; t < 5; t += 1) {
        let text = fill(GENERIC_TEMPLATES_V2[t]!, a, b, '');
        // 确定性噪声：约 1/3 的句子施加前缀或后缀。
        const r = pickIndex(SEED_V2, globalIndex, t) % 3;
        if (r === 0) text = NOISE_PREFIX_V2[(globalIndex + t) % NOISE_PREFIX_V2.length]! + text;
        else if (r === 1) text = text + NOISE_SUFFIX_V2[(globalIndex * 2 + t) % NOISE_SUFFIX_V2.length]!;
        turns.push({ speaker: 'user', offsetMinutes: t * 12, rawText: text });
      }
      const sixth = hasRef
        ? fill(REF_TEMPLATE_V2, a, b, '')
        : fill(GENERIC_TEMPLATES_V2[5] ?? GENERIC_TEMPLATES_V2[GENERIC_TEMPLATES_V2.length - 1]!, a, b, '');
      turns.push({ speaker: 'user', offsetMinutes: 5 * 12, rawText: sixth });

      // 高危：前 10 个封存事件，每 2 个承载一类，追加第 7 条。
      const highRiskLabels: HighRiskLabelV2[] = [];
      if (family.partition === 'sealed' && globalIndex < HIGH_RISK_LABELS_V2.length * 2) {
        const label = HIGH_RISK_LABELS_V2[Math.floor(globalIndex / 2)]!;
        highRiskLabels.push(label);
        turns.push({
          speaker: 'user',
          offsetMinutes: turns.length * 12,
          rawText: fill(HIGH_RISK_TEMPLATES_V2[label], a, b, '周房东'),
        });
      }

      const dayOffset = globalIndex;
      const startedAtMs = BASE_EPOCH_MS_V2 + dayOffset * DAY + 10 * 60 * 60 * 1000;
      events.push({
        eventId,
        partition: family.partition,
        familyId: family.familyId,
        channel: 'dsh',
        startedAtMs,
        endedMs: startedAtMs + (turns.length - 1) * 12 * 60 * 1000,
        keyPoints: [family.familyPoint, a, b],
        summary: `关于${a}的客观摘要，涉及${b}，含待办与事实，不含情绪判断。`,
        turns,
        highRiskLabels,
        sensitiveTerms: ['周房东'],
        hasRef,
      });
    }
  }
  const referenceNowMs = BASE_EPOCH_MS_V2 + (TOTAL_EVENT_COUNT_V2 + 2) * DAY;
  return { schema: WORLD_SCHEMA_V2, seed: SEED_V2, baseEpochMs: BASE_EPOCH_MS_V2, referenceNowMs, events, reusePlan };
}

export interface WorldV2Constraints {
  readonly violations: string[];
  /** 出题端与施工方共用的结构统计（**不进盲包**，只用于内部核对与文书）。 */
  readonly stats: {
    readonly refCandidates: number;
    readonly calendarWeeks: number;
    readonly collideFamiliesPerWord: { readonly min: number; readonly max: number; readonly avg: number };
    readonly collideCardsPerWord: { readonly min: number; readonly max: number };
    readonly uniqueDetails: number;
    readonly distinctDetailsInWorld: number;
    readonly reusedDetails: number;
    readonly maxFamiliesPerDetail: number;
  };
}

/** 结构断言：不抛错，把全部违规收集返回（红测可断言具体违规，脚本可一次性报全）。 */
export function assertWorldV2Constraints(world: WorldPlanV2): WorldV2Constraints {
  const violations: string[] = [];
  const cp = (s: string): number => Array.from(s).length;

  if (world.events.length !== TOTAL_EVENT_COUNT_V2) violations.push(`事件数 ${world.events.length} ≠ ${TOTAL_EVENT_COUNT_V2}`);
  const sealedEvents = world.events.filter((e) => e.partition === 'sealed');
  if (sealedEvents.length !== SEALED_EVENT_COUNT_V2) violations.push(`封存事件 ${sealedEvents.length} ≠ ${SEALED_EVENT_COUNT_V2}`);

  const ids = new Set(world.events.map((e) => e.eventId));
  if (ids.size !== world.events.length) violations.push('eventId 不唯一');

  for (let i = 1; i < world.events.length; i += 1) {
    if (world.events[i]!.startedAtMs <= world.events[i - 1]!.startedAtMs) violations.push(`时间非单调@${i}`);
  }
  const weeks = new Set(world.events.map((e) => Math.floor((e.startedAtMs - world.baseEpochMs) / (7 * DAY))));
  if (weeks.size < 5) violations.push(`日历周桶仅 ${weeks.size} < 5`);

  for (const event of world.events) {
    for (const point of event.keyPoints) if (cp(point) > 10) violations.push(`keyPoint 超 10 码点：${point}（${event.eventId}）`);
  }
  for (const word of COLLIDE_WORDS_V2) if (cp(word) !== 2) violations.push(`撞词非 2 码点：${word}`);
  if (COLLIDE_WORDS_V2.length !== 24) violations.push(`撞词数 ${COLLIDE_WORDS_V2.length} ≠ 24`);

  const familyPoints = new Set(world.events.map((e) => e.keyPoints[0]));
  if (familyPoints.size !== FAMILY_COUNT_V2) violations.push(`族共享点唯一数 ${familyPoints.size} ≠ ${FAMILY_COUNT_V2}（出现整族重名）`);

  // P-c ①：细节词池是与槽位等量的双射，1000 个词必须全唯一。
  if (DETAIL_POOL_V2.length !== DETAIL_SLOTS_V2) violations.push(`细节池 ${DETAIL_POOL_V2.length} ≠ ${DETAIL_SLOTS_V2}`);
  if (new Set(DETAIL_POOL_V2).size !== DETAIL_SLOTS_V2) {
    violations.push(`细节池唯一数 ${new Set(DETAIL_POOL_V2).size} ≠ ${DETAIL_SLOTS_V2}（双射破损）`);
  }

  // P-c ②：跨族复用时每个细节词最多 2 族，且恰好 DETAIL_REUSE_PAIRS 个词跨 2 族。
  const detailFamilies = new Map<string, Set<string>>();
  for (const event of world.events) {
    for (const point of event.keyPoints.slice(1)) {
      if (!detailFamilies.has(point)) detailFamilies.set(point, new Set());
      detailFamilies.get(point)!.add(event.familyId);
    }
  }
  const reused = [...detailFamilies.entries()].filter(([, set]) => set.size > 1);
  if (reused.length !== DETAIL_REUSE_PAIRS_V2) {
    violations.push(`跨族细节词 ${reused.length} ≠ ${DETAIL_REUSE_PAIRS_V2}（复用计划未按预期落地）`);
  }
  for (const [point, set] of reused) {
    if (set.size > 2) violations.push(`细节词「${point}」跨 ${set.size} 族 > 2（排序压力超上限）`);
  }
  if (world.reusePlan.length !== DETAIL_REUSE_PAIRS_V2) {
    violations.push(`复用计划条数 ${world.reusePlan.length} ≠ ${DETAIL_REUSE_PAIRS_V2}`);
  }

  const collideFamilies = new Map<string, Set<string>>();
  for (const event of world.events) {
    const head = Array.from(event.keyPoints[0]!).slice(0, 2).join('');
    if (!COLLIDE_WORDS_V2.includes(head)) continue;
    if (!collideFamilies.has(head)) collideFamilies.set(head, new Set());
    collideFamilies.get(head)!.add(event.familyId);
  }
  for (const word of COLLIDE_WORDS_V2) {
    const n = collideFamilies.get(word)?.size ?? 0;
    if (n < 2) violations.push(`撞词「${word}」仅覆盖 ${n} 族 < 2`);
  }

  const byFamily = new Map<string, PlannedEventV2[]>();
  for (const event of world.events) {
    const list = byFamily.get(event.familyId);
    if (list === undefined) byFamily.set(event.familyId, [event]);
    else list.push(event);
  }
  for (const [familyId, events] of byFamily) {
    const collide = Array.from(events[0]!.keyPoints[0]!).slice(0, 2).join('');
    for (const event of events) {
      for (const point of event.keyPoints.slice(1)) {
        if (point.includes(collide)) violations.push(`族 ${familyId} 细节「${point}」含本族撞词「${collide}」`);
      }
    }
    const details = events.flatMap((e) => e.keyPoints.slice(1));
    if (new Set(details).size !== details.length) violations.push(`族 ${familyId} 族内细节词对重复`);
  }

  // 指代句：每封存族恰 2 条、分属不同事件、含本事件 pointA（禁止指向族内他人）。
  for (const [familyId, events] of byFamily) {
    if (events[0]!.partition !== 'sealed') continue;
    const refs = events.filter((e) => e.hasRef);
    if (refs.length !== 2) violations.push(`族 ${familyId} 指代事件 ${refs.length} ≠ 2`);
    if (new Set(refs.map((e) => e.eventId)).size !== refs.length) violations.push(`族 ${familyId} 指代事件不互异`);
    for (const event of refs) {
      const refTurn = event.turns.find((t) => t.rawText.startsWith('上次说的那个'));
      if (refTurn === undefined) {
        violations.push(`族 ${familyId} 找不到指代句：${event.eventId}`);
        continue;
      }
      if (!refTurn.rawText.includes(event.keyPoints[1]!)) {
        violations.push(`族 ${familyId} 指代句未含本事件 pointA：${event.eventId}`);
      }
    }
  }

  const hrCount = new Map<HighRiskLabelV2, number>();
  for (const event of world.events) {
    for (const label of event.highRiskLabels) hrCount.set(label, (hrCount.get(label) ?? 0) + 1);
  }
  for (const label of HIGH_RISK_LABELS_V2) {
    const n = hrCount.get(label) ?? 0;
    if (n < 2) violations.push(`高危 ${label} 仅 ${n} < 2`);
  }

  const refEvents = sealedEvents.filter((e) => e.hasRef);
  if (sealedEvents.length < 150) violations.push('S0/S1 产能不足 150');
  if (refEvents.length < 100) violations.push(`S5 指代候选 ${refEvents.length} < 100`);

  const coverage = [...collideFamilies.values()].map((set) => set.size);
  const minFamiliesPerWord = coverage.length === 0 ? 0 : Math.min(...coverage);
  const maxFamiliesPerWord = coverage.length === 0 ? 0 : Math.max(...coverage);
  const avgFamiliesPerWord = coverage.length === 0 ? 0 : coverage.reduce((a, b) => a + b, 0) / coverage.length;

  return {
    violations,
    stats: {
      refCandidates: refEvents.length,
      calendarWeeks: weeks.size,
      collideFamiliesPerWord: { min: minFamiliesPerWord, max: maxFamiliesPerWord, avg: Number(avgFamiliesPerWord.toFixed(2)) },
      collideCardsPerWord: { min: minFamiliesPerWord * FAMILY_SIZE_V2, max: maxFamiliesPerWord * FAMILY_SIZE_V2 },
      uniqueDetails: new Set(DETAIL_POOL_V2).size,
      distinctDetailsInWorld: detailFamilies.size,
      reusedDetails: reused.length,
      maxFamiliesPerDetail: reused.length === 0 ? 1 : Math.max(...reused.map(([, set]) => set.size)),
    },
  };
}

/** 出题端清单：18 个跨族共享细节词（原样字符串，顺序即 reusePlan 顺序）。 */
export function reusedDetailWordsV2(world: WorldPlanV2 = buildWorldV2()): string[] {
  return world.reusePlan.map(({ fi, slot }) => DETAIL_POOL_V2[fi * (FAMILY_SIZE_V2 * 2) + slot]!);
}
