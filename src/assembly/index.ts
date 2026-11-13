/**
 * 装配层（第二层提案 v0.3 §6）：实时链路与记忆子系统之间唯一允许的窄接线目录。
 *
 * 静态纪律（由 tests/memory/schema.test.ts 的 M6 白名单门强制，投毒自证兜底）：
 *  1. 对 src/memory 的**值依赖**仅可命名引用白名单符号：
 *     runtime.openMemoryRuntime；gate.applyGate/normalizeLexicalText；
 *     serial.buildSerialMap/resolveSerials/isSerialRefusable。import type 编译擦除、不受此限。
 *  2. 不 import node:fs/node:sqlite，也不 new DatabaseSync：本层不持有任何文件句柄/数据库连接，
 *     所有 IO 都经注入的窄柄发生（N1，宿主唯一经 openMemoryRuntime 取得句柄）。
 *  3. 不在门裁决前对候选数组 .slice/.splice（N11 防线③）；top-k 只原样下传给 applyGate，
 *     由门在“过滤完成后”截断，绝不用弱尾凑数。
 *  4. 依赖单向：src/memory 不得反向 import 本目录（memory-to-assembly 探针标红）。
 *
 * 本模块只放纯编排：拿到调用方注入的窄柄与查询，取未截断全集后交布尔门裁决。
 * 句柄生命周期（打开/关闭/effect 绑定）属 WP4 宿主协议，不在本模块自开。
 */

import { applyGate, normalizeLexicalText } from '../memory/gate.ts';
import type { GatedSearchOutcome } from '../memory/types.ts';
import type { RuntimeMemoryHandle, RuntimeSearchQuery } from '../memory/runtime.ts';

/**
 * 门控召回编排（纯函数式，不持有 IO）：
 * 窄柄 searchExplained 返回 limit=undefined 的完整排序全集 → 规范化查询词 → applyGate 逐卡裁决，
 * limit 仅在门内过滤完成后生效。装配层不重建/截断候选，杜绝门前进片。
 *
 * @param handle 调用方（宿主）注入的记忆窄柄；本函数不打开也不关闭它。
 * @param query  无 limit 键的窄查询（RuntimeSearchQuery），任何额外字段在窄柄边界即被丢弃。
 * @param limit  动态 top-k；缺省时保留全部过门卡。
 */
export async function runGatedSearch(
  handle: RuntimeMemoryHandle,
  query: RuntimeSearchQuery,
  limit?: number,
): Promise<GatedSearchOutcome> {
  const qNorm = normalizeLexicalText(query.text);
  const candidates = await handle.searchExplained(query);
  return applyGate({ qNorm, candidates, limit });
}
