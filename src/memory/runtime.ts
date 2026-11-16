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
import { buildSkippedDrainReport, classifyDrainSkip, runDrainRound } from './drain.ts';
import type { DecisionVersionContext } from './decision.ts';
import type { DrainRoundReport, DrainSkipContext } from './drain.ts';
import { openShadowObservationSink } from './shadow-write.ts';
import { MISS_RETENTION_TMP_POLICY } from './miss-retention.ts';
import { missSentinelMessage } from './miss-sentinel.ts';
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
  /** 决策版本上下文（可选；缺省由写柄按遗留路径临时构造，drain 编排接入后由事件版本注入）。 */
  readonly versionContext?: DecisionVersionContext | undefined;
}

/** 运行期窄柄契约：装配层唯一可持有的记忆访问形状；N16 影子写为第六窄能力，第七法为整轮 drain pull。 */
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
  /**
   * 第七法：整轮 drain pull（预算化）。短路（持锁/关停/未接线/预算耗尽）零写入；
   * 正常轮经 derive→plan→apply 编排链产出 §3.2 轮报告。本方法永不进宿主工具表。
   */
  drainProjection(budgetMs: number): Promise<DrainRoundReport>;
  close(): Promise<void>;
}

/**
 * 打开运行期窄柄。库不存在透传 NotFoundError（Q3 只开不建）；写单例被离线任务占用时后端降级只读，
 * 读方法照常、写方法抛 UnavailableError，不与离线构建抢锁。
 */
export function openMemoryRuntime(
  paths: StorePaths,
  options?: { readonly onMissRetentionWarning?: (message: string) => void },
): RuntimeMemoryHandle {
  const backend = openMemoryRuntimeBackend(paths, {
    missSentinel: {
      hardCapK: MISS_RETENTION_TMP_POLICY.hardCapK,
      ...(options?.onMissRetentionWarning === undefined
        ? {}
        : { onWarn: (warning) => options.onMissRetentionWarning!(missSentinelMessage(warning)) }),
    },
  });
  // N16 影子写面独立于 sqlite 后端：构造期不建目录、不占写单例，只读降级下仍可写。
  const shadowSink = openShadowObservationSink(paths.indexDir);
  // 关停态：close() 后置位，第七法据此判 `closed` 短路（不触碰已关闭的读连接）。
  let closed = false;
  // F-C 连续失败计数（进程内、不落持久队列；成功轮由编排层归零）。
  let consecutiveFailures = 0;

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
        ...(input.versionContext === undefined ? {} : { versionContext: input.versionContext }),
      });
    },

    recordMiss(input: MissObservationInput): void {
      requireWriter().recordMiss(input);
    },

    recordShadowObservation(input: ShadowObservationInput): RecordShadowOutcome {
      // 刻意不经过 requireWriter：影子 JSONL 与 sqlite 是两个物理面，降级只读不影响旁路观测。
      return shadowSink.record(input);
    },

    async drainProjection(budgetMs: number): Promise<DrainRoundReport> {
      const startedMs = Date.now();
      const context: DrainSkipContext = {
        closed,
        writable: backend.writer !== null,
        // memory 窄柄层恒按已接线处理：dataRoot 缺省时真源折叠集为空 → 真实空轮；
        // not-wired 短路由门面端口层在未注入端口时判定（正本 §3.1 api 行）。
        sourceWired: true,
        budgetExhausted: !Number.isFinite(budgetMs) || budgetMs <= 0,
      };
      const skipped = classifyDrainSkip(context);
      if (skipped !== null) {
        // 短路：事务未开始、派生集不推进，卡/台账/观测/miss 行与目录树全不变。
        return buildSkippedDrainReport(skipped, Date.now() - startedMs);
      }
      const report = runDrainRound({
        indexDir: paths.indexDir,
        dataRoot: paths.dataRoot ?? null,
        closed,
        reader: backend.reader,
        writer: backend.writer,
        budgetMs,
        consecutiveFailures,
        // #117 3.2：drain 主触发留存维护，策略取段一临时值（asOfMs 每轮注入真实时钟）。
        missRetention: {
          ...MISS_RETENTION_TMP_POLICY,
          asOfMs: Date.now(),
        },
      });
      consecutiveFailures = report.consecutiveFailures;
      return report;
    },

    async close(): Promise<void> {
      closed = true;
      await backend.reader.close();
    },
  };
}
