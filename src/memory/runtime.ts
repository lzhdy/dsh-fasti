/**
 * 运行期窄柄工厂与窄类型（第二层 v0.3 §5.2，N1/N4/N11/N13/N17、Q3）。
 *
 * 纪律：
 *  - 本模块是装配层唯一允许实例化的记忆入口（WP3 白名单枚举 openMemoryRuntime 与本文件窄类型）；
 *  - 返回值必须是**只挂六个窄方法的新对象字面量**、闭包委托后端，禁止把完整柄 as 断言后外泄——
 *    字符串拼接键/运行时反射因此也只能看见窄方法（N13-i 纵深防御）；
 *  - 窄类型不 extends 读/写柄，全量方法在类型与对象两个层面都不可达；
 *  - 本模块不 import node:sqlite/node:fs，不自开连接；sqlite 连接生命周期与降级策略封装在 store 后端，
 *    影子 JSONL 写面（N16）封装在 shadow-write，二者物理隔离；
 *  - 卡写 sensitive 在包装层固定 1（N4/N14），入参类型不含 sensitive，危险选项不可表达；
 *  - 检索委托写死 limit:undefined（N11），入参类型 RuntimeSearchQuery 无 limit 键。
 */

import { UnavailableError } from '../core/errors.ts';
import type { ApplyMissAliasOutcome } from './alias-write.ts';
import { openShadowObservationSink } from './shadow-write.ts';
import type { RecordShadowOutcome, ShadowObservationInput } from './shadow-write.ts';
import { openMemoryRuntimeBackend } from './store.ts';
import type { StorePaths } from './store.ts';
import type { ExplainedRankedCard, MemoryCard, MissObservationInput } from './types.ts';

/** 窄柄检索入参：无 limit 键，装配层无法表达预截断（N11 防线①）。 */
export interface RuntimeSearchQuery {
  readonly text: string;
  readonly atMs: number;
}

/** 窄柄卡写入参：无 sensitive 键，sensitive 由窄柄内部固定 1（N4/N14，不可表达）。 */
export interface RuntimeAddMissAliasInput {
  readonly term: string;
  readonly cardId: string;
  readonly atMs: number;
}

/** 运行期窄柄契约：装配层唯一可持有的记忆访问形状，恰六方法（N16 影子写为第六窄能力）。 */
export interface RuntimeMemoryHandle {
  searchExplained(query: RuntimeSearchQuery): Promise<ExplainedRankedCard[]>;
  getCardsByAnchor(experienceId: string): MemoryCard[];
  /** 唯一卡写：补 source='miss' 检索别名，sensitive 内部固定 1；降级只读时抛 UnavailableError。 */
  addMissAlias(input: RuntimeAddMissAliasInput): ApplyMissAliasOutcome;
  /** 观测写（非卡写）：漏召登记落 mem_miss；降级只读时抛 UnavailableError。 */
  recordMiss(input: MissObservationInput): void;
  /**
   * N16 影子观测写（非卡写，仅 shadow 态由装配调用）：落 projection/memory-shadow 追加 JSONL，
   * term_hash 内部计算、原文不落盘、写失败隔离为 ok:false。与 sqlite 物理隔离，**只读降级时仍可用**，
   * 入参无任何路径形参（落点在 shadow-write 工厂内部固定）。
   */
  recordShadowObservation(input: ShadowObservationInput): RecordShadowOutcome;
  close(): Promise<void>;
}

/**
 * 打开运行期窄柄。库不存在透传 NotFoundError（Q3 只开不建）；写单例被离线任务占用时后端降级只读，
 * 读方法照常、写方法抛 UnavailableError，不与离线构建抢锁。
 */
export function openMemoryRuntime(paths: StorePaths): RuntimeMemoryHandle {
  const backend = openMemoryRuntimeBackend(paths);
  // N16 影子写面独立于 sqlite 后端：构造期不建目录、不占写单例，只读降级下仍可写。
  const shadowSink = openShadowObservationSink(paths.indexDir);

  const requireWriter = (): NonNullable<typeof backend.writer> => {
    if (backend.writer === null) {
      throw new UnavailableError('记忆索引正被离线任务占用，运行期窄柄已降级只读，写操作暂不可用');
    }
    return backend.writer;
  };

  // 显式包装对象：仅枚举六个窄方法，后端完整柄不离开本闭包。
  return {
    async searchExplained(query: RuntimeSearchQuery): Promise<ExplainedRankedCard[]> {
      // N11 防线②：重新构造委托入参并写死 limit:undefined，不透传 query 对象任何其他字段。
      return backend.reader.searchExplained({ text: query.text, atMs: query.atMs, limit: undefined });
    },

    getCardsByAnchor(experienceId: string): MemoryCard[] {
      return backend.reader.getCardsByAnchor(experienceId);
    },

    addMissAlias(input: RuntimeAddMissAliasInput): ApplyMissAliasOutcome {
      return requireWriter().addMissAlias({
        term: input.term,
        cardId: input.cardId,
        sensitive: 1,
        atMs: input.atMs,
      });
    },

    recordMiss(input: MissObservationInput): void {
      requireWriter().recordMiss(input);
    },

    recordShadowObservation(input: ShadowObservationInput): RecordShadowOutcome {
      // 刻意不经过 requireWriter：影子 JSONL 与 sqlite 是两个物理面，降级只读不影响旁路观测。
      return shadowSink.record(input);
    },

    async close(): Promise<void> {
      await backend.reader.close();
    },
  };
}
