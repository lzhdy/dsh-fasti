/**
 * 统一调参新卷 · 合成世界 v3 蓝本规划器（W2-1，202 号 dryrun 主档落地）。
 *
 * 定位：纯函数、零 IO、零时钟、零随机源——同一 seed 逐字节产出同一蓝本，sha256 由
 * task206 红测锁死。v1（world-plan.ts，100 事件）、v2（world-plan-v2.ts，500 事件）
 * 一字不动、可永久重放；本文件是并列第三份蓝本，不参数化、不互相引用。
 *
 * 相对 v2 的机制变更（理由见 201/202 号文书）：
 *  1. 规模 160 族 × 12 事件 = 1920；族大小 12 使每金标有 11 个同族对手，支撑 B5 密度 10。
 *  2. 分区改为 tuning-a（标定）/tuning-b（一次性确认），按 seed 哈希切分、物理不相交；
 *     v3 全程不承担权威终判，终判权仍在冻结 v2 卷。
 *  3. familyPoint 改二维分组命名：v2 线性轮转周期 lcm(24,40)=120，超过 120 族必撞名。
 *  4. 词表 24 动作 × 200 物件 = 4800 池，实占 3840 槽双射；受控复用仅落 A 区。
 *  5. 高危按分区×五类精确配额（每类 140＝A95＋B45，共 700），确定性哈希去重选取。
 */

export const WORLD_SCHEMA_V3 = 'fasti-p6-world/v3';
export const SEED_V3 = 20261125;
export const BASE_EPOCH_MS_V3 = Date.UTC(2027, 0, 4, 9, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

export const FAMILY_SIZE_V3 = 12;
export const FAMILY_COUNT_V3 = 160;
export const TOTAL_EVENT_COUNT_V3 = FAMILY_COUNT_V3 * FAMILY_SIZE_V3; // 1920
/** A 标定区哈希切分阈值：pickIndex%100 < 70 入 A，其余入 B（实测 117 A 族 / 43 B 族）。 */
export const PARTITION_A_RATIO_V3 = 0.7;

export type CorpusPartitionV3 = 'tuning-a' | 'tuning-b';
export type HighRiskLabelV3 = 'strong' | 'promise' | 'date' | 'verbatim' | 'negation';

/** 24 个 2 码点跨族撞词（逐字继承 v2，与动作/后缀正交由断言器机检）。 */
export const COLLIDE_WORDS_V3: readonly string[] = [
  '预约', '续费', '报价', '改期', '确认', '到期', '退换', '签收',
  '催单', '开票', '试穿', '退订', '预留', '加急', '转单', '结算',
  '回访', '补差', '派送', '签章', '折扣', '赠品', '押金', '尾款',
];

/** 40 个 2 码点主题后缀（避开撞词与动作）。 */
const SUFFIXES_V3: readonly string[] = [
  '排期', '续期', '补货', '上门', '检修', '对账', '清点', '换新', '保养', '验收',
  '报修', '催办', '归档', '进货', '盘点', '缴费', '领取', '预订', '登记', '复核',
  '送货', '回收', '改造', '翻新', '查勘', '测价', '定损', '安装', '调试', '腾退',
  '封窗', '铺管', '接驳', '刷漆', '填缝', '贴膜', '裁切', '校准', '试装', '备案',
];

/** 200 个 ≤6 码点生活物件：前 100 逐字继承 v2，后 100 为 v3 新增。 */
export const OBJECTS_V3: readonly string[] = [
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
  '燃气灶台', '排烟管道', '水槽龙头', '浴室地漏', '阳台窗框', '入户门锁', '车库卷帘', '庭院围栏', '屋顶瓦片', '外墙水管',
  '空调外机', '地暖分水', '新风滤芯', '净水龙头', '智能门锁', '监控摄像', '可视门铃', '路由设备', '网线面板', '电视背板',
  '沙发靠垫', '衣柜挂杆', '鞋柜铰链', '橱柜拉篮', '调味瓶架', '刀架磁条', '烤箱旋钮', '洗碗盐仓', '消毒柜灯', '阳极镁棒',
  '比例阀门', '调压阀门', '止回阀门', '球阀手柄', '波纹软管', '过滤阀件', '膨胀螺栓', '化学锚栓', '防水卷材', '止水胶条',
  '玻璃胶枪', '美缝剂管', '瓷砖背胶', '自流平料', '隔音棉板', '阻尼片材', '保温棉管', '防凝露贴', '排烟铝箔', '止水角阀',
  '三角阀座', '生料带卷', '堵头管帽', '活接接头', '塑料弯头', '过桥弯管', '地插底盒', '空开回路', '漏电保护', '感应夜灯',
  '镜前灯座', '浴霸开关', '排风管件', '干手设备', '纸巾盒架', '置物层板', '隐形拉手', '反弹器件', '液压撑杆', '推拉吊轮',
  '平移轨道', '折叠铰链', '玻璃合页', '纱窗卷筒', '遮阳卷帘', '百叶叶片', '晾衣升降', '电动衣架', '除湿机器', '加湿滤芯',
  '空气净化', '扫地滚刷', '拖布模组', '洗地滚刷', '窗机密封', '门底胶条', '防撞角条', '防滑椅脚', '键盘托板', '主机托架',
  '插排固定', '线槽压条', '扎带固定', '热缩管材', '接线端子', '绝缘胶带', '万用表笔', '水平泡仪', '激光测距', '温感探头',
];

/**
 * 24 个 2 码点维修动作（v2 为 10 个）。全部不含撞词/后缀的任何连续 2 码点，
 * 「校准」因与后缀表重名被替换为「对中」（202 号 dryrun 抓出，断言器持续兜底）。
 */
export const ACTIONS_V3: readonly string[] = [
  '更换', '维修', '清洗', '疏通', '加固', '除锈', '紧固', '打胶', '除尘', '擦拭',
  '拆装', '对中', '润滑', '喷漆', '包扎', '替换', '补齐', '调校', '养护', '检测',
  '封堵', '引流', '钻孔', '镶贴',
];

/** 每个事件 2 个细节 → 世界总细节位置数（160 族 × 每族 24 槽）。 */
export const DETAIL_SLOTS_V3 = TOTAL_EVENT_COUNT_V3 * 2; // 3840
/** 词池总容量 24 动作 × 200 物件 = 4800，大于实占槽位、留 20% 余量。 */
export const DETAIL_POOL_SIZE_V3 = ACTIONS_V3.length * OBJECTS_V3.length; // 4800

/** 槽位 → 细节词双射：动作 = floor(slot/200) mod 24，物件 = slot mod 200。 */
function detailAtSlotV3(slot: number): string {
  return ACTIONS_V3[Math.floor(slot / OBJECTS_V3.length) % ACTIONS_V3.length]! + OBJECTS_V3[slot % OBJECTS_V3.length]!;
}

/** 全量细节词池（4800 个全局互不相同）；世界只取前 3840 槽。 */
const DETAIL_POOL_V3: readonly string[] = Array.from({ length: DETAIL_POOL_SIZE_V3 }, (_, s) => detailAtSlotV3(s));

const GENERIC_TEMPLATES_V3: readonly string[] = [
  '{a}那事我一直挂着，你帮我理一下头绪',
  '我想问清楚{a}的安排，{b}那边怎么配合',
  '之前提过的{a}，后来{b}有没有新消息',
  '{a}跟{b}是不是同一类问题，别给我搞混了',
  '帮我记着{a}这个情况，{b}先按兵不动',
];
const REF_TEMPLATE_V3 = '上次说的那个{a}的事，后来你帮我留意了吗';

const HIGH_RISK_LABELS_V3: readonly HighRiskLabelV3[] = ['strong', 'promise', 'date', 'verbatim', 'negation'];
const HIGH_RISK_TEMPLATES_V3: Readonly<Record<HighRiskLabelV3, string>> = {
  strong: '我把话放这儿，{a}这件事绝对不能再拖，{b}必须本周搞定',
  promise: '我答应过{n}，{a}这周一定给准信，{b}也一并承诺下来',
  date: '记好了，{a}定在一月十八号上午九点，{b}的截止日是同月二十号',
  verbatim: '逐字记住这句：{a}报价三百二十八块五，{b}工费另算，一个字都别改',
  negation: '千万别先动{b}，{a}没确认之前不要回复任何人',
};

/** 高危精确配额：每类 A 区 95、B 区 45，合计每类 140、全库 700。 */
export const HIGH_RISK_QUOTA_V3: readonly (readonly [HighRiskLabelV3, { readonly a: number; readonly b: number }])[] =
  HIGH_RISK_LABELS_V3.map((label) => [label, { a: 95, b: 45 }] as const);

const NOISE_PREFIX_V3: readonly string[] = ['我跟你说，', '那个，', '哎，'];
const NOISE_SUFFIX_V3: readonly string[] = ['啊', '嘛', '呗', '吧'];

/** 受控复用词对数（只在 A 区族间配对，每词最多跨 2 族）。 */
export const DETAIL_REUSE_PAIRS_V3 = 30;

/** 二维 familyPoint 命名的跨组后缀步长（与后缀表长 40 互素，同撞词跨组 40 组内不重）。 */
const SUFFIX_GROUP_STEP_V3 = 7;

export interface PlannedTurnV3 {
  readonly speaker: 'user';
  readonly offsetMinutes: number;
  readonly rawText: string;
}

export interface PlannedEventV3 {
  readonly eventId: string;
  readonly partition: CorpusPartitionV3;
  readonly familyId: string;
  readonly channel: 'dsh';
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  /** 固定 3 条：[族共享点, 事件专属点 A, 事件专属点 B]，全部 ≤10 码点。 */
  readonly keyPoints: readonly string[];
  readonly summary: string;
  readonly turns: readonly PlannedTurnV3[];
  readonly highRiskLabels: readonly HighRiskLabelV3[];
  readonly sensitiveTerms: readonly string[];
  /** 本事件是否承载同事件内指代句（w=1/3，每族恰 2 个事件）。 */
  readonly hasRef: boolean;
}

export interface FamilyPlanV3 {
  readonly familyId: string;
  readonly partition: CorpusPartitionV3;
  readonly fi: number;
  readonly familyPoint: string;
  readonly collide: string;
  readonly details: string[];
}

export interface ReusePairV3 {
  readonly fi: number;
  readonly fj: number;
  readonly slot: number;
}

export interface WorldPlanV3 {
  readonly schema: typeof WORLD_SCHEMA_V3;
  readonly seed: number;
  readonly baseEpochMs: number;
  readonly referenceNowMs: number;
  readonly events: readonly PlannedEventV3[];
  readonly reusePlan: readonly ReusePairV3[];
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}
function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function fill(template: string, a: string, b: string, n: string): string {
  return template.replaceAll('{a}', a).replaceAll('{b}', b).replaceAll('{n}', n);
}

/** 纯索引哈希，无 Math.random，跨机一致。 */
function pickIndex(seed: number, ...mods: number[]): number {
  let h = seed;
  for (const m of mods) h = (h * 1103515245 + 12345 + m * 7919) % 2147483647;
  return h;
}

/** A/B 哈希切分：确定性、与族序区间无关。 */
function partitionOfFamily(fi: number): CorpusPartitionV3 {
  return pickIndex(SEED_V3, fi, 7) % 100 < PARTITION_A_RATIO_V3 * 100 ? 'tuning-a' : 'tuning-b';
}

/**
 * 二维 familyPoint：撞词取 j=fi%24（每 24 族共享一撞词），后缀在组内随 j 错位、
 * 跨组叠加互素步长 7；同 j 跨组 40 组内不重，理论容量 24×40=960 族。
 */
function familyPointOf(fi: number): { readonly collide: string; readonly familyPoint: string } {
  const j = fi % COLLIDE_WORDS_V3.length;
  const group = Math.floor(fi / COLLIDE_WORDS_V3.length);
  if (group >= SUFFIXES_V3.length) throw new Error(`族序 ${fi} 超出二维命名容量 ${COLLIDE_WORDS_V3.length * SUFFIXES_V3.length}`);
  const collide = COLLIDE_WORDS_V3[j]!;
  const suffix = SUFFIXES_V3[(j + group * SUFFIX_GROUP_STEP_V3 + 11) % SUFFIXES_V3.length]!;
  return { collide, familyPoint: collide + suffix };
}

function buildFamiliesV3(): FamilyPlanV3[] {
  const families: FamilyPlanV3[] = [];
  for (let fi = 0; fi < FAMILY_COUNT_V3; fi += 1) {
    const partition = partitionOfFamily(fi);
    const { collide, familyPoint } = familyPointOf(fi);
    const details: string[] = [];
    for (let k = 0; k < FAMILY_SIZE_V3 * 2; k += 1) {
      details.push(DETAIL_POOL_V3[fi * (FAMILY_SIZE_V3 * 2) + k]!);
    }
    families.push({
      familyId: `v3-${partition === 'tuning-a' ? 'a' : 'b'}-f${pad3(fi + 1)}`,
      partition,
      fi,
      familyPoint,
      collide,
      details,
    });
  }
  return families;
}

/** 受控复用仅在 A 区族间配对：fj 的某槽改为 fi 原生细节词，每词恰跨 2 族。 */
function buildReusePlanV3(families: readonly FamilyPlanV3[]): ReusePairV3[] {
  const aFamilyIndexes = families.filter((f) => f.partition === 'tuning-a').map((f) => f.fi);
  const plan: ReusePairV3[] = [];
  const used = new Set<number>();
  let guard = 0;
  while (plan.length < DETAIL_REUSE_PAIRS_V3) {
    if (guard > 100000) throw new Error('v3 复用计划凑不满，检查切分与互素性');
    const x = pickIndex(SEED_V3, guard, 13) % aFamilyIndexes.length;
    const y = pickIndex(SEED_V3, guard, 29) % aFamilyIndexes.length;
    const fi = aFamilyIndexes[x]!;
    const fj = aFamilyIndexes[y]!;
    guard += 1;
    if (fi === fj || used.has(fi) || used.has(fj)) continue;
    used.add(fi);
    used.add(fj);
    const slot = plan.length % (FAMILY_SIZE_V3 * 2);
    families[fj]!.details[slot] = DETAIL_POOL_V3[fi * (FAMILY_SIZE_V3 * 2) + slot]!;
    plan.push({ fi, fj, slot });
  }
  return plan;
}

/** 高危：分区×五类精确配额，分区内确定性哈希去重选全局事件序，一事件至多一类。 */
function buildHighRiskAssignmentV3(): Map<number, HighRiskLabelV3> {
  const partGlobalIndexes: Record<CorpusPartitionV3, number[]> = { 'tuning-a': [], 'tuning-b': [] };
  for (let fi = 0; fi < FAMILY_COUNT_V3; fi += 1) {
    const partition = partitionOfFamily(fi);
    for (let w = 0; w < FAMILY_SIZE_V3; w += 1) partGlobalIndexes[partition].push(fi * FAMILY_SIZE_V3 + w);
  }
  const labelByGlobal = new Map<number, HighRiskLabelV3>();
  const partitions: readonly CorpusPartitionV3[] = ['tuning-a', 'tuning-b'];
  for (const [pCode, partition] of partitions.entries()) {
    const pool = partGlobalIndexes[partition];
    for (let li = 0; li < HIGH_RISK_LABELS_V3.length; li += 1) {
      const quota = HIGH_RISK_QUOTA_V3[li]![1][partition === 'tuning-a' ? 'a' : 'b'];
      if (quota * HIGH_RISK_LABELS_V3.length > pool.length) {
        throw new Error(`v3 高危配额超 ${partition} 区事件数`);
      }
      const chosen = new Set<number>();
      let k = 0;
      while (chosen.size < quota) {
        const idx = pool[pickIndex(SEED_V3, pCode, li, k, 97) % pool.length]!;
        if (!labelByGlobal.has(idx)) chosen.add(idx);
        k += 1;
        if (k > pool.length * 20) throw new Error(`v3 ${partition} 区高危选取凑不满`);
      }
      for (const idx of chosen) labelByGlobal.set(idx, HIGH_RISK_LABELS_V3[li]!);
    }
  }
  return labelByGlobal;
}

export function buildWorldV3(): WorldPlanV3 {
  const families = buildFamiliesV3();
  const reusePlan = buildReusePlanV3(families);
  const highRiskByGlobal = buildHighRiskAssignmentV3();

  const events: PlannedEventV3[] = [];
  const counters: Record<CorpusPartitionV3, number> = { 'tuning-a': 0, 'tuning-b': 0 };
  for (let fi = 0; fi < FAMILY_COUNT_V3; fi += 1) {
    const family = families[fi]!;
    for (let w = 0; w < FAMILY_SIZE_V3; w += 1) {
      const globalIndex = events.length;
      counters[family.partition] += 1;
      const eventId = `syn-v3${family.partition === 'tuning-a' ? 'a' : 'b'}-${pad4(counters[family.partition])}`;
      const a = family.details[w * 2]!;
      const b = family.details[w * 2 + 1]!;
      const hasRef = w === 1 || w === 3;

      const turns: PlannedTurnV3[] = [];
      for (let t = 0; t < 5; t += 1) {
        let text = fill(GENERIC_TEMPLATES_V3[t]!, a, b, '');
        const r = pickIndex(SEED_V3, globalIndex, t) % 3;
        if (r === 0) text = NOISE_PREFIX_V3[(globalIndex + t) % NOISE_PREFIX_V3.length]! + text;
        else if (r === 1) text = text + NOISE_SUFFIX_V3[(globalIndex * 2 + t) % NOISE_SUFFIX_V3.length]!;
        turns.push({ speaker: 'user', offsetMinutes: t * 12, rawText: text });
      }
      const sixth = hasRef
        ? fill(REF_TEMPLATE_V3, a, b, '')
        : fill(GENERIC_TEMPLATES_V3[GENERIC_TEMPLATES_V3.length - 1]!, a, b, '');
      turns.push({ speaker: 'user', offsetMinutes: 5 * 12, rawText: sixth });

      const highRiskLabels: HighRiskLabelV3[] = [];
      const hrLabel = highRiskByGlobal.get(globalIndex);
      if (hrLabel !== undefined) {
        highRiskLabels.push(hrLabel);
        turns.push({ speaker: 'user', offsetMinutes: turns.length * 12, rawText: fill(HIGH_RISK_TEMPLATES_V3[hrLabel], a, b, '周房东') });
      }

      const startedAtMs = BASE_EPOCH_MS_V3 + globalIndex * DAY + 10 * 60 * 60 * 1000;
      events.push({
        eventId,
        partition: family.partition,
        familyId: family.familyId,
        channel: 'dsh',
        startedAtMs,
        endedAtMs: startedAtMs + (turns.length - 1) * 12 * 60 * 1000,
        keyPoints: [family.familyPoint, a, b],
        summary: `关于${a}的客观摘要，涉及${b}，含待办与事实，不含情绪判断。`,
        turns,
        highRiskLabels,
        sensitiveTerms: ['周房东'],
        hasRef,
      });
    }
  }

  const referenceNowMs = BASE_EPOCH_MS_V3 + (TOTAL_EVENT_COUNT_V3 + 2) * DAY;
  return { schema: WORLD_SCHEMA_V3, seed: SEED_V3, baseEpochMs: BASE_EPOCH_MS_V3, referenceNowMs, events, reusePlan };
}

export interface WorldV3Constraints {
  readonly violations: string[];
  readonly stats: {
    readonly calendarWeeks: number;
    readonly totalEvents: number;
    readonly partitionEvents: Record<CorpusPartitionV3, number>;
    readonly uniqueDetailsUsed: number;
    readonly reusedWords: number;
    readonly refCandidates: number;
    readonly highRiskTotal: number;
    readonly sameFamilyRivals: number;
  };
}

/** 结构断言：收集全部违规不抛错（红测可断言具体违规，脚本可一次报全），合规世界须零违规。 */
export function assertWorldV3Constraints(world: WorldPlanV3): WorldV3Constraints {
  const violations: string[] = [];
  const codepoints = (s: string): number => Array.from(s).length;

  if (world.events.length !== TOTAL_EVENT_COUNT_V3) violations.push(`事件数 ${world.events.length} ≠ ${TOTAL_EVENT_COUNT_V3}`);
  const partitionEvents: Record<CorpusPartitionV3, number> = { 'tuning-a': 0, 'tuning-b': 0 };

  const ids = new Set<string>();
  for (const event of world.events) {
    partitionEvents[event.partition] += 1;
    if (ids.has(event.eventId)) violations.push(`eventId 重复：${event.eventId}`);
    ids.add(event.eventId);
    if (/^syn-(sealed|tuning)-/.test(event.eventId)) violations.push(`侵占 v2 命名空间：${event.eventId}`);
  }

  for (let i = 1; i < world.events.length; i += 1) {
    if (world.events[i]!.startedAtMs <= world.events[i - 1]!.startedAtMs) {
      violations.push(`时间轴非严格单调@${i}`);
      break;
    }
  }
  const calendarWeeks = new Set(
    world.events.map((e) => Math.floor((e.startedAtMs - world.baseEpochMs) / (7 * DAY))),
  ).size;
  if (calendarWeeks <= 5) violations.push(`日历周桶 ${calendarWeeks} ≤ 5`);

  for (const word of COLLIDE_WORDS_V3) if (codepoints(word) !== 2) violations.push(`撞词非 2 码点：${word}`);
  for (const obj of OBJECTS_V3) {
    if (codepoints(obj) > 6) violations.push(`物件超 6 码点：${obj}`);
    for (let i = 0; i < obj.length - 1; i += 1) {
      if (COLLIDE_WORDS_V3.includes(obj.slice(i, i + 2))) violations.push(`物件含撞词 bigram：${obj}`);
    }
  }
  for (const act of ACTIONS_V3) {
    if (COLLIDE_WORDS_V3.includes(act) || SUFFIXES_V3.includes(act)) violations.push(`动作与撞词/后缀重名：${act}`);
    for (let i = 0; i < act.length - 1; i += 1) {
      if (COLLIDE_WORDS_V3.includes(act.slice(i, i + 2))) violations.push(`动作含撞词 bigram：${act}`);
    }
  }

  const familyPoints = new Set(world.events.map((e) => e.keyPoints[0]));
  if (familyPoints.size !== FAMILY_COUNT_V3) violations.push(`familyPoint 唯一数 ${familyPoints.size} ≠ ${FAMILY_COUNT_V3}`);

  const byFamily = new Map<string, PlannedEventV3[]>();
  for (const event of world.events) {
    const list = byFamily.get(event.familyId);
    if (list === undefined) byFamily.set(event.familyId, [event]);
    else list.push(event);
  }
  if (byFamily.size !== FAMILY_COUNT_V3) violations.push(`族数 ${byFamily.size} ≠ ${FAMILY_COUNT_V3}`);
  for (const [familyId, events] of byFamily) {
    if (events.length !== FAMILY_SIZE_V3) violations.push(`族 ${familyId} 事件数 ${events.length} ≠ ${FAMILY_SIZE_V3}`);
    const collide = Array.from(events[0]!.keyPoints[0]!).slice(0, 2).join('');
    const details = events.flatMap((e) => e.keyPoints.slice(1));
    if (new Set(details).size !== details.length) violations.push(`族 ${familyId} 族内细节重复`);
    for (const d of details) {
      if (d.includes(collide)) violations.push(`族 ${familyId} 细节「${d}」含本族撞词「${collide}」`);
      if (codepoints(d) > 8) violations.push(`细节超 8 码点：${d}`);
    }
  }

  // 复用：每词最多 2 族、条数 30、仅 A 区。
  const detailFamilies = new Map<string, Set<string>>();
  for (const event of world.events) {
    for (const point of event.keyPoints.slice(1)) {
      if (!detailFamilies.has(point)) detailFamilies.set(point, new Set());
      detailFamilies.get(point)!.add(event.familyId);
    }
  }
  const reused = [...detailFamilies.values()].filter((s) => s.size > 1);
  if (reused.length !== DETAIL_REUSE_PAIRS_V3) violations.push(`复用词数 ${reused.length} ≠ ${DETAIL_REUSE_PAIRS_V3}`);
  if (reused.some((s) => s.size > 2)) violations.push('存在细节词跨 >2 族');
  if (world.reusePlan.some(({ fi }) => partitionOfFamily(fi) !== 'tuning-a')) violations.push('复用落到 B 区');

  // keyPoints 形状。
  for (const event of world.events) {
    if (event.keyPoints.length !== 3) violations.push(`${event.eventId} keyPoints 非 3 条`);
    for (const point of event.keyPoints) {
      if (codepoints(point) > 10 || codepoints(point) === 0) violations.push(`${event.eventId} keyPoint 越界：${point}`);
    }
  }

  // 高危精确配额与一事件一类。
  const hrTotal = Object.fromEntries(HIGH_RISK_LABELS_V3.map((l) => [l, 0])) as Record<HighRiskLabelV3, number>;
  const hrByPart = {
    'tuning-a': Object.fromEntries(HIGH_RISK_LABELS_V3.map((l) => [l, 0])) as Record<HighRiskLabelV3, number>,
    'tuning-b': Object.fromEntries(HIGH_RISK_LABELS_V3.map((l) => [l, 0])) as Record<HighRiskLabelV3, number>,
  };
  let highRiskTotal = 0;
  for (const event of world.events) {
    if (event.highRiskLabels.length > 1) violations.push(`${event.eventId} 承载多类高危`);
    for (const label of event.highRiskLabels) {
      hrTotal[label] += 1;
      hrByPart[event.partition][label] += 1;
      highRiskTotal += 1;
      if (event.turns.length !== 7) violations.push(`${event.eventId} 高危事件话头数 ≠ 7`);
    }
  }
  for (const [label, quota] of HIGH_RISK_QUOTA_V3) {
    if (hrTotal[label] !== quota.a + quota.b) violations.push(`高危 ${label} 总数 ${hrTotal[label]} ≠ ${quota.a + quota.b}`);
    if (hrByPart['tuning-a'][label] !== quota.a) violations.push(`高危 ${label} A 区 ${hrByPart['tuning-a'][label]} ≠ ${quota.a}`);
    if (hrByPart['tuning-b'][label] !== quota.b) violations.push(`高危 ${label} B 区 ${hrByPart['tuning-b'][label]} ≠ ${quota.b}`);
  }

  // 指代：每族恰 2 个事件、回指本事件 pointA。
  const refPerFamily = new Map<string, number>();
  for (const event of world.events) {
    if (!event.hasRef) continue;
    refPerFamily.set(event.familyId, (refPerFamily.get(event.familyId) ?? 0) + 1);
    const refTurn = event.turns.find((t) => t.rawText.startsWith('上次说的那个'));
    if (refTurn === undefined) {
      violations.push(`${event.eventId} hasRef 但找不到指代句`);
    } else if (!refTurn.rawText.includes(event.keyPoints[1]!)) {
      violations.push(`${event.eventId} 指代句未回指本事件 pointA`);
    }
  }
  if (refPerFamily.size !== FAMILY_COUNT_V3) violations.push(`承载指代的族 ${refPerFamily.size} ≠ ${FAMILY_COUNT_V3}`);
  for (const [familyId, n] of refPerFamily) if (n !== 2) violations.push(`族 ${familyId} 指代事件 ${n} ≠ 2`);
  const refCandidates = world.events.filter((e) => e.hasRef).length;

  return {
    violations,
    stats: {
      calendarWeeks,
      totalEvents: world.events.length,
      partitionEvents,
      uniqueDetailsUsed: detailFamilies.size,
      reusedWords: reused.length,
      refCandidates,
      highRiskTotal,
      sameFamilyRivals: FAMILY_SIZE_V3 - 1,
    },
  };
}
