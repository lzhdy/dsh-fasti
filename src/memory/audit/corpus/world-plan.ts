/**
 * P6 D 批 · 合成世界蓝本规划器（v4 §9 序8、§10：C5 合成根路径）。
 *
 * 定位：纯函数、零 IO、零时钟、零随机源——同一 seed 逐字节产出同一蓝本，
 * 供 scripts/p6/build-synthetic-world.ts 摄入真链路建根，也供红测直接断言结构。
 *
 * 关键设计：
 *  - 100 事件＝80 封存（16 族×5）＋20 调参（4 族×5），族内 5 事件共享同一条 family key_point，
 *    经真派生后每张卡至少有 4 个 Jaccard>0 近邻（诱饵对 100+ 的产能保证，D2 才出题）；
 *  - key_points 全部 ≤10 码点（H7 ≥20 码点子串反查不可能误伤）、每事件固定 3 条（cue 上限 3）；
 *  - 时间轴 100 个事件顺排 100 天（UTC，每 block 10 天、共 10 block），覆盖约 15 个自然周桶，
 *    日历周 holdout 必触发（阈值 5 桶，见 run-memory-audit.ts:72,330），且跨事件间隔以天计、
 *    严格单调，实时切分器的 30 分钟静默规则只会按计划边界切分；
 *  - 五类高危素材与敏感词只在蓝本登记库存，D2 独立出题人才决定如何落成题。
 */

export const WORLD_SCHEMA = 'fasti-p6-world/v1';
export const WORLD_SEED = 20261118;
export const SEALED_FAMILY_COUNT = 16;
export const TUNING_FAMILY_COUNT = 4;
export const FAMILY_SIZE = 5;
export const SEALED_EVENT_COUNT = SEALED_FAMILY_COUNT * FAMILY_SIZE; // 80
export const TUNING_EVENT_COUNT = TUNING_FAMILY_COUNT * FAMILY_SIZE; // 20
export const TOTAL_EVENT_COUNT = SEALED_EVENT_COUNT + TUNING_EVENT_COUNT; // 100
export const CALENDAR_WEEK_COUNT = 10;

/** 固定纪元：2026-01-05 周一 UTC；全部时间戳确定性生成，不读墙钟。 */
export const WORLD_BASE_EPOCH_MS = Date.UTC(2026, 0, 5, 9, 0, 0);
/** 审计/建卡参照时刻：最后一个事件结束之后固定 7 天，脚本以它为 validMs/nowMs。 */
// 末事件落在第 99 天，参照「现在」取第 102 天，严格晚于全部话头（全轴跨 100 天、约 15 个自然周桶）。
export const WORLD_REFERENCE_NOW_MS = WORLD_BASE_EPOCH_MS + (CALENDAR_WEEK_COUNT * 10 + 2) * 24 * 60 * 60 * 1000;

export type CorpusPartition = 'sealed' | 'tuning';
export type HighRiskLabel = 'strong' | 'promise' | 'date' | 'verbatim' | 'negation';
export const HIGH_RISK_LABELS: readonly HighRiskLabel[] = ['strong', 'promise', 'date', 'verbatim', 'negation'];

export interface PlannedTurn {
  readonly speaker: 'user';
  /** 相对事件起点的分钟偏移（脚本换算绝对 asserted_at）。 */
  readonly offsetMinutes: number;
  readonly rawText: string;
}

export interface PlannedEvent {
  readonly eventId: string;
  readonly partition: CorpusPartition;
  readonly familyId: string;
  readonly channel: 'dsh';
  readonly startedAtMs: number;
  readonly endedMs: number;
  /** 固定 3 条：[族共享点, 事件专属点 A, 事件专属点 B]，全部短于 H7 码点门槛。 */
  readonly keyPoints: readonly string[];
  readonly summary: string;
  readonly turns: readonly PlannedTurn[];
  readonly highRiskLabels: readonly HighRiskLabel[];
  readonly sensitiveTerms: readonly string[];
}

export interface WorldPlan {
  readonly schema: typeof WORLD_SCHEMA;
  readonly seed: number;
  readonly baseEpochMs: number;
  readonly referenceNowMs: number;
  readonly events: readonly PlannedEvent[];
}

interface FamilySpec {
  readonly id: string;
  readonly familyPoint: string;
  readonly sensitiveName: string;
  /** 每个元素＝一个事件：[专属点 A, 专属点 B]。 */
  readonly subjects: ReadonlyArray<readonly [string, string]>;
}

/**
 * 20 个题材族：16 封存＋4 调参。族间词表刻意互不复用，避免跨族撞出意外近邻；
 * 族内 5 事件共享 familyPoint 形成稠密近邻子图。
 */
const FAMILY_CATALOG: readonly FamilySpec[] = [
  { id: 'f01-rent-repair', familyPoint: '房东维修', sensitiveName: '周房东', subjects: [
    ['卫生间漏水', '水管接头'], ['厨房顶灯', '灯管更换'], ['阳台封窗', '胶条老化'], ['门锁卡顿', '锁芯润滑'], ['墙面返潮', '腻子修补'],
  ]},
  { id: 'f02-commute', familyPoint: '公交通勤', sensitiveName: '吴师傅', subjects: [
    ['早班快线', '站牌时刻'], ['换乘优惠', '公交卡充值'], ['末班车时间', '夜间接驳'], ['限行绕路', '临时改道'], ['雨天打车', '排队加价'],
  ]},
  { id: 'f03-grocery', familyPoint: '厨房采买', sensitiveName: '郑姐', subjects: [
    ['白萝卜炖汤', '牛腩切块'], ['绿叶菜保鲜', '冰箱收纳'], ['调料补货', '生抽瓶口'], ['早饭粥品', '杂粮搭配'], ['餐具替换', '木筷更换'],
  ]},
  { id: 'f04-work-report', familyPoint: '周报汇报', sensitiveName: '张经理', subjects: [
    ['项目进度条', '风险标注'], ['数据口径表', '同比列'], ['周会材料', '投屏备份'], ['客户回访', '纪要措辞'], ['季度目标', '拆解排期'],
  ]},
  { id: 'f05-parcel', familyPoint: '驿站取件', sensitiveName: '冯老板', subjects: [
    ['取件码短信', '货架编号'], ['拒收退回', '运费承担'], ['生鲜包裹', '冷藏暂存'], ['代签授权', '身份核验'], ['破损拍照', '理赔工单'],
  ]},
  { id: 'f06-broadband', familyPoint: '宽带缴费', sensitiveName: '蒋客服', subjects: [
    ['套餐续费', '年费优惠'], ['路由器红灯', '光猫重启'], ['移机办理', '地址变更'], ['网速实测', '晚高峰丢包'], ['发票抬头', '电子账单'],
  ]},
  { id: 'f07-hospital', familyPoint: '医院挂号', sensitiveName: '沈医生', subjects: [
    ['口腔科号源', '放号时间'], ['体检预约', '空腹项目'], ['报告打印', '自助机位置'], ['医保结算', '门诊统筹'], ['复诊加号', '诊间预约'],
  ]},
  { id: 'f08-bank', familyPoint: '银行手续', sensitiveName: '韩经理', subjects: [
    ['卡片解冻', '柜台取号'], ['手机号变更', '预留信息'], ['流水打印', '盖章页数'], ['理财到期', '赎回确认'], ['外币兑换', '现钞预约'],
  ]},
  { id: 'f09-cleaning', familyPoint: '周末打扫', sensitiveName: '许阿姨', subjects: [
    ['油烟机清洁', '重油污喷剂'], ['床品换洗', '晾晒时段'], ['地漏疏通', '毛发清理'], ['书柜除尘', '干抹布静电'], ['垃圾分类', '投放时段'],
  ]},
  { id: 'f10-cat', familyPoint: '养猫照料', sensitiveName: '林室友', subjects: [
    ['猫砂结团', '豆腐砂补货'], ['疫苗加强', '宠物医院预约'], ['干粮换粮', '七日过渡'], ['抓板磨损', '剑麻替换'], ['耳螨观察', '滴药剂量'],
  ]},
  { id: 'f11-social', familyPoint: '人情往来', sensitiveName: '程同学', subjects: [
    ['婚礼份子', '高铁班次'], ['满月酒帖', '赴宴人数'], ['乔迁温锅', '礼物预算'], ['探病安排', '探视时段'], ['年节伴手', '特产份数'],
  ]},
  { id: 'f12-leave', familyPoint: '调休安排', sensitiveName: '魏主管', subjects: [
    ['年假余额', '系统申请'], ['调休抵扣', '加班时长'], ['请假交接', '代理人填法'], ['探亲路程', '往返车票'], ['病假凭证', '诊断证明'],
  ]},
  { id: 'f13-property', familyPoint: '物业沟通', sensitiveName: '秦主任', subjects: [
    ['装修备案', '施工保证金'], ['电梯检修', '停梯告示'], ['车位续租', '年费档位'], ['楼道堆物', '整改通知'], ['门禁卡补办', '房本核验'],
  ]},
  { id: 'f14-phone', familyPoint: '手机故障', sensitiveName: '曹技师', subjects: [
    ['电池鼓包', '换电报价'], ['屏幕划痕', '贴膜更换'], ['充电口松动', '尾插清理'], ['系统卡顿', '备份重置'], ['听筒无声', '降噪排线'],
  ]},
  { id: 'f15-weather', familyPoint: '降温添衣', sensitiveName: '尹姐', subjects: [
    ['寒潮预警', '秋裤翻找'], ['围巾手套', '玄关收纳'], ['室内干燥', '湿度读数'], ['窗缝漏风', '密封条尺寸'], ['热茶取暖', '姜茶煮法'],
  ]},
  { id: 'f16-movie', familyPoint: '周末片子', sensitiveName: '汤哥', subjects: [
    ['慢片字幕', '观看进度'], ['纪录片片单', '时长排序'], ['音响接线', 'HDMI 接口'], ['观影零食', '低卡搭配'], ['片源会员', '设备登录'],
  ]},
  { id: 'f17-gym', familyPoint: '健身打卡', sensitiveName: '方教练', subjects: [
    ['跑步机配速', '热身时长'], ['力量器械', '动作组数'], ['拉伸放松', '泡沫轴用法'], ['游泳馆次卡', '更衣室柜号'], ['蛋白补给', '冲泡比例'],
  ]},
  { id: 'f18-library', familyPoint: '借书还书', sensitiveName: '罗馆员', subjects: [
    ['借阅上限', '续借次数'], ['逾期费用', '滞纳金计算'], ['馆际调书', '到架通知'], ['自习座位', '预约时段'], ['书证挂失', '押金退还'],
  ]},
  { id: 'f19-coffee', familyPoint: '咖啡点单', sensitiveName: '苏店员', subjects: [
    ['美式浓度', '加冰规格'], ['燕麦奶替换', '差价档位'], ['豆子烘焙', '风味描述'], ['自带杯减', '杯盖尺寸'], ['积分兑换', '券包过期'],
  ]},
  { id: 'f20-haircut', familyPoint: '理发修剪', sensitiveName: '莫师傅', subjects: [
    ['刘海长度', '打薄层次'], ['染发补色', '色板比对'], ['排队叫号', '等位时长'], ['会员储值', '扣款明细'], ['剃须修面', '热毛巾敷'],
  ]},
];

/** 通用用户话头模板：{a}=专属点 A，{b}=专属点 B，{n}=敏感称呼。 */
const GENERIC_TEMPLATES: readonly string[] = [
  '{a}那事我一直挂着，你帮我理一下头绪',
  '我想问清楚{a}的安排，{b}那边怎么配合',
  '之前提过的{a}，后来{b}有没有新消息',
  '{a}跟{b}是不是同一类问题，别给我搞混了',
  '帮我记着{a}这个情况，{b}先按兵不动',
  '下次说到{a}的时候，提醒我{b}还没办',
];

/** 高危专项话头：每个标签一条，保证五类素材在封存分区内各有≥2 个事件承载。 */
const HIGH_RISK_TEMPLATES: Record<HighRiskLabel, string> = {
  strong: '我把话放这儿，{a}这件事绝对不能再拖，{b}必须本周搞定',
  promise: '我答应过{n}，{a}这周一定给准信，{b}也一并承诺下来',
  date: '记好了，{a}定在一月十八号上午九点，{b}的截止日是同月二十号',
  verbatim: '逐字记住这句：{a}报价三百二十八块五，{b}工费另算，一个字都别改',
  negation: '千万别先动{b}，{a}没确认之前不要回复任何人',
};

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function fill(template: string, a: string, b: string, name: string): string {
  return template.replaceAll('{a}', a).replaceAll('{b}', b).replaceAll('{n}', name);
}

/**
 * 生成完整世界蓝本（确定性：无随机、无 IO）。
 * 族序即目录序：前 16 族封存，后 4 族调参；事件在族内按 0..4 排列。
 */
export function buildWorldPlan(seed: number = WORLD_SEED): WorldPlan {
  const events: PlannedEvent[] = [];
  let sealedIndex = 0;
  FAMILY_CATALOG.forEach((family, familyIndex) => {
    const partition: CorpusPartition = familyIndex < SEALED_FAMILY_COUNT ? 'sealed' : 'tuning';
    family.subjects.forEach(([pointA, pointB], within) => {
      const globalIndex = events.length;
      const eventId = partition === 'sealed'
        ? `syn-sealed-${pad3(sealedIndex + 1)}`
        : `syn-tuning-${pad3(globalIndex - SEALED_EVENT_COUNT + 1)}`;
      if (partition === 'sealed') {
        sealedIndex += 1;
      }
      // 时间轴：block 占连续 10 天、每天一个事件、统一 10 点档。
      // block 起点按 10 天递进（不是 7 天），杜绝下一 block 的 day0 早于上一 block day9 的回拨，
      // 全轴严格单调且跨事件间隔以天计，必然越过切分器 30 分钟静默阈值。
      const week = Math.floor(globalIndex / 10);
      const slot = globalIndex % 10;
      const dayOffset = week * 10 + slot;
      const startedAtMs = WORLD_BASE_EPOCH_MS + dayOffset * 24 * 60 * 60 * 1000 + 10 * 60 * 60 * 1000;
      const turns: PlannedTurn[] = GENERIC_TEMPLATES.map((rawTemplate, i) => ({
        speaker: 'user' as const,
        offsetMinutes: i * 12,
        rawText: fill(rawTemplate, pointA, pointB, family.sensitiveName),
      }));
      // 前 10 个封存事件每 2 个承载一类高危标签，各配一条专项话头。
      const highRiskLabels: HighRiskLabel[] = [];
      if (partition === 'sealed' && globalIndex < HIGH_RISK_LABELS.length * 2) {
        const label = HIGH_RISK_LABELS[Math.floor(globalIndex / 2)]!;
        highRiskLabels.push(label);
        turns.push({ speaker: 'user', offsetMinutes: turns.length * 12, rawText: fill(HIGH_RISK_TEMPLATES[label], pointA, pointB, family.sensitiveName) });
      }
      const endedAtMs = startedAtMs + (turns.length - 1) * 12 * 60 * 1000;
      events.push({
        eventId,
        partition,
        familyId: family.id,
        channel: 'dsh',
        startedAtMs,
        endedMs: endedAtMs,
        keyPoints: [family.familyPoint, pointA, pointB],
        summary: `关于${pointA}的客观摘要，涉及${pointB}，含待办与事实，不含情绪判断。`,
        turns,
        highRiskLabels,
        sensitiveTerms: [family.sensitiveName],
      });
    });
  });
  return { schema: WORLD_SCHEMA, seed, baseEpochMs: WORLD_BASE_EPOCH_MS, referenceNowMs: WORLD_REFERENCE_NOW_MS, events };
}

/** 仅封存分区事件（D2 封存集出题范围）。 */
export function sealedEvents(plan: WorldPlan): readonly PlannedEvent[] {
  return plan.events.filter((event) => event.partition === 'sealed');
}

/** 仅调参分区事件（S7 标定专用，id 与封存集物理隔离）。 */
export function tuningEvents(plan: WorldPlan): readonly PlannedEvent[] {
  return plan.events.filter((event) => event.partition === 'tuning');
}
