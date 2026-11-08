/**
 * 边的派生 —— edge id 与边行的**唯一**口径。
 *
 * 为什么必须只有一处（审计 M1）：
 * 增量写入、全量重建、L3 直读三条路径各自拼装 edge id 时，会得到不同的内部 id。
 * 于是同一条边在「重建前后」id 变化、L3 与 L1/L2 对同一条边给出不同 id ——
 * 违反定案稿 §7.2「投影确定性、幂等」与 types.ts「三档结果集必须一致」。
 *
 * 口径定义：
 *  - id = `edge_<sha256(src \0 predicate \0 dst) 前 32 hex>`
 *    · 只由边的三元组决定 → 与写入路径、时刻、进程无关 → 重建幂等；
 *    · 用不可见分隔符 \0 连接 → predicate/dst 里的下划线不会造成歧义
 *      （可读的 `edge_src_pred_dst` 拼接在 dst 含下划线时会撞车）。
 *  - 行内容 = §7.1 edge 表语义：valid=发生时刻、created=落源时刻、
 *    provenance 恒为 'experience.pointers'（摄入期结构关系折叠而来）。
 */

import { stableId } from '../core/hash.ts';
import { isoToMs } from '../core/time.ts';
import type { Edge, Experience } from '../contract/experience.ts';
import type { EdgeProjection } from './types.ts';

/** 边的来源标记 —— 摄入期结构关系（定案稿 §4.2 pointers 折叠）。 */
export const EDGE_PROVENANCE = 'experience.pointers';

/**
 * 边的确定性 id —— 只由 (src, predicate, dst) 决定。
 *
 * 三条写入路径共用此函数，故重建前后 id 恒定。
 */
export function edgeIdOf(src: string, predicate: string, dst: string): string {
  return stableId('edge', `${src}\u0000${predicate}\u0000${dst}`);
}

/**
 * 由一条经历与它的某个指针折叠出边行（审计口径 12：pointers → edge）。
 *
 * 三条路径共用此函数，故 L1/L2/L3 对同一条边的行内容逐字段一致。
 */
export function toEdgeRow(experience: Experience, pointer: Edge): EdgeProjection {
  return {
    id: edgeIdOf(experience.id, pointer.type, pointer.target),
    src: experience.id,
    predicate: pointer.type,
    dst: pointer.target,
    valid_ms: isoToMs(experience.occurred_at),
    invalid_ms: null,
    created_ms: isoToMs(experience.recorded_at),
    expired_ms: null,
    confidence: null,
    reason: pointer.note ?? null,
    provenance: EDGE_PROVENANCE,
  };
}
