/**
 * #117 3.2 第 3 件：mem_miss 进程内哨兵（零 IO、零定时器、零守护）。
 *
 * 目的：drain 裁剪是"日级一次"的宽节拍，若有旁路写入把行数推过硬顶而不等下一轮，
 * 需要一条**不依赖轮询**的就地告警，避免"悄悄涨到爆"。
 *
 * 纪律（裁定 R4 哨兵条款）：
 *  - 只在打开时播种一次 COUNT(*)，之后由写入侧递增——不做任何定时查询；
 *  - 阈值 = ceil(hardCapK × 0.7)；**每个进程只告警一次**（跨阈值即报，防刷屏）；
 *  - 告警只通报不阻断：调用方拿到回调后自行落日志，本模块不抛错、不改写入行为。
 */

/** 告警阈值比例（硬顶的 70%）。 */
export const MISS_SENTINEL_WARN_RATIO = 0.7;

export interface MissSentinelWarning {
  /** 触发时刻的估算行数（打开时播种 + 其后递增，可能略滞后于真实值）。 */
  readonly rowCount: number;
  /** 告警阈值（= ceil(hardCapK × ratio)）。 */
  readonly warnAt: number;
  readonly hardCapK: number;
}

export interface MissSentinelSnapshot {
  readonly rowCount: number;
  readonly warnAt: number;
  readonly hardCapK: number;
  readonly warned: boolean;
}

export interface MissSentinelOptions {
  readonly hardCapK: number;
  readonly warnRatio?: number;
  readonly onWarn?: (warning: MissSentinelWarning) => void;
}

export interface MissSentinel {
  /** 打开时播种（也用于裁剪/搬迁后的重校准）。 */
  reseed(rowCount: number): void;
  /** 每成功写入一行调用一次。 */
  onAppend(): void;
  snapshot(): MissSentinelSnapshot;
}

function assertNonNegativeInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`哨兵 ${field} 必须是非负整数（收到 ${String(value)}）`);
  }
}

export function createMissSentinel(options: MissSentinelOptions): MissSentinel {
  if (!Number.isInteger(options.hardCapK) || options.hardCapK < 1) {
    throw new Error(`哨兵 hardCapK 必须是正整数（收到 ${String(options.hardCapK)}）`);
  }
  const warnRatio = options.warnRatio ?? MISS_SENTINEL_WARN_RATIO;
  if (!(warnRatio > 0 && warnRatio <= 1)) {
    throw new Error(`哨兵 warnRatio 必须落在 (0,1]（收到 ${String(warnRatio)}）`);
  }

  const hardCapK = options.hardCapK;
  const warnAt = Math.max(1, Math.ceil(hardCapK * warnRatio));
  let rowCount = 0;
  let warned = false;

  return {
    reseed(next: number): void {
      assertNonNegativeInt(next, 'rowCount');
      rowCount = next;
    },
    onAppend(): void {
      rowCount += 1;
      if (warned || rowCount < warnAt) {
        return;
      }
      warned = true;
      // 回调异常不得污染写入路径（哨兵只是旁路观测）。
      try {
        options.onWarn?.({ rowCount, warnAt, hardCapK });
      } catch {
        // 静默：告警失败不能反过来让 recordMiss 失败。
      }
    },
    snapshot(): MissSentinelSnapshot {
      return { rowCount, warnAt, hardCapK, warned };
    },
  };
}

/** 统一告警文案（大白话、可操作，避免"内部代号"式日志）。 */
export function missSentinelMessage(warning: MissSentinelWarning): string {
  return (
    `漏召台账行数已达硬顶的 ${Math.round((warning.warnAt / warning.hardCapK) * 100)}%` +
    `（估算 ${warning.rowCount} 行 / 上限 ${warning.hardCapK} 行）。` +
    '裁剪是日级节拍，若持续增长说明写入快于维护或留存在跑空；' +
    '窗口内行数超上限时最早的漏召观测会被裁掉（裁剪动作在 decisions.jsonl 留聚合台账）。'
  );
}
