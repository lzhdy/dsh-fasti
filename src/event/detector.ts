/**
 * B 类语义候选探测端口 —— 内核只认这个接口（技术基线 §5.2 B 类 / D-2）。
 *
 * 纪律：
 *  - **本文件只定义接口与一个假实现，不含任何检测逻辑** —— B 类信号要读原文做语义
 *    判断，必须调 LLM，而 LLM 只在适配器层、只在后台；内核侧只能有「端口」不能有
 *    「检测器」（定案稿 §5.2 B 类：ES-Mem 用互信息突变 + LLM 复核，我们只取候选）。
 *  - 探测结果**只标候选、绝不自动切**：候选打在当前 open 事件上，闭合与否留给她
 *    在复盘时判断。
 *  - 第一期默认不接探测器 → `boundary_candidates` 恒为空数组（§5.3）。
 */

import type { BoundaryCandidate } from '../contract/event.ts';
import type { Experience } from '../contract/experience.ts';

/** 探测输入 —— 一次探测能拿到的全部事实。 */
export interface SemanticCandidateInput {
  /** 当前这条记录本经历（指针与上下文）。 */
  readonly experience: Experience;
  /** 通道 id。 */
  readonly channel: string;
  /** 打点位置：候选边界所在的记录本条目 id。 */
  readonly atPointerId: string;
  /** 打点时刻（ISO）—— 探测器据此填候选的 `marked_at`。 */
  readonly markedAt: string;
}

/**
 * 语义候选探测器 —— 纯函数：输入 → 候选列表。
 *
 * 候选的 `kind` 是开放枚举（如「话题跳转」）；`at_pointer_id` / `marked_at` 应与输入
 * 给的位置与时刻一致（探测器自己填，便于它一次产出多个候选）。
 */
export type SemanticCandidateDetector = (
  input: SemanticCandidateInput,
) => readonly BoundaryCandidate[];

/**
 * 假实现 —— 恒无候选。
 *
 * 用途有二：① 第一期的默认（不接探测器 = 没有语义候选）；② 测试注入时用它证明
 * 「没有探测器就不会凭空产生候选」。
 */
export const noSemanticCandidates: SemanticCandidateDetector = () => [];
