/**
 * 终判 top1 逐题对齐（192 号文书 H2 修复）。
 *
 * 旧实现以 eventId 为键在 Map 里存每题 top1，但预注册 v5 §5.3 允许同一事件跨构造层供题
 * （每事件每层 ≤4 条），questionRef=eventId 必然撞键、后写覆盖先写，层探针因此读到别的
 * 题面的 top1（192 号实证 L_S4 wc=10 即 S4∩S5 同事件顶包污染）。
 *
 * 本模块只做纯数组对齐：搜索结果按 `questions` 的索引逐题回填，键是位置不是事件 id，
 * 同事件不同层各拿各的观测；长度不齐一律 fail-loud。不触库、不读时钟、无随机。
 */
import type { GoldQuestion, GoldQuestionResult } from './gold.ts';
import type { LayerProbeV2 } from './judgment-v2.ts';

/** 单题 top1 观测：是否提交（至少 1 张卡）与顶卡是否金标。 */
export interface Top1Record {
  readonly committed: boolean;
  readonly top1IsGold: boolean;
}

/** 单题搜索回调（同步/异步均可，测试可注入假实现）。 */
export type Top1SearchFn = (question: GoldQuestion, index: number) => Top1Record | Promise<Top1Record>;

/** 按 questions 顺序逐题收集 top1，返回等长、同序记录数组。 */
export async function collectTop1Records(
  questions: readonly GoldQuestion[],
  search: Top1SearchFn,
): Promise<Top1Record[]> {
  const records: Top1Record[] = new Array(questions.length);
  for (let i = 0; i < questions.length; i += 1) {
    records[i] = await search(questions[i]!, i);
  }
  return records;
}

/**
 * 由 R1 回放结果＋逐题 top1 记录组装 v2 层探针；无构造层题（l1/l2）跳过。
 *
 * @param gold        replayGold 的等长结果数组（R1 hit/rank 的唯一来源）
 * @param questions   buildGoldQuestions 的等长题目数组
 * @param top1        collectTop1Records 的等长 top1 记录（门后或粗召回口径由调用方决定）
 */
export function buildLayerProbesV2(
  gold: readonly GoldQuestionResult[],
  questions: readonly GoldQuestion[],
  top1: readonly Top1Record[],
): LayerProbeV2[] {
  if (gold.length !== questions.length || top1.length !== questions.length) {
    throw new Error(`v2 层探针对齐失败：gold=${gold.length} questions=${questions.length} top1=${top1.length} 必须等长`);
  }
  const probes: LayerProbeV2[] = [];
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i]!;
    if (question.constructionLayer === undefined) continue;
    const observation = top1[i]!;
    probes.push({
      layer: question.constructionLayer,
      eventId: question.targetEventId,
      hit: gold[i]!.hit,
      highRisk: question.highRisk ?? false,
      committed: observation.committed,
      top1IsGold: observation.top1IsGold,
    });
  }
  return probes;
}
