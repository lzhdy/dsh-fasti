/**
 * #114/S1 影子观测只读读取器（audit 离线侧，Q4「四态各 ≥200 条、只取同口径段」的数据来源）。
 *
 * 为什么必须有它：拆除绕门旧路后，运行期只有写入（N16 窄写），全仓再无读取主体——
 * candidateCount / countScope 就成了只写不读的死字段，Q4 同口径统计没有主体。本模块只做读与分段。
 *
 * 口径纪律（附录 E.4.2）：
 *  - 新行（七字段，含 countScope）原样读出：candidateCount 是**门过滤前全集**，可直接参与全集统计；
 *  - 历史行（只有旧计数字段、无 countScope）在**读取时**补 countScope='legacy-limited'，
 *    candidateCount 置 null——旧计数是 fasti.search(text, limit) 截断后的条数，与全集不同源，
 *    同名字下混用会污染统计；null 刻意区别于真实的 0 候选；
 *  - 归一后的对象不含旧字段名；本模块**零回写**，原 JSONL 逐字节不变（append-only 由写侧单方持有）。
 *
 * 边界：离线只读纯函数，不进实时链路、不起定时器、无守护进程（K13）；只允许 read 系文件原语，
 * 目录经 shadowDirFromIndex 内部推导，入参不接受任何路径改写。
 *
 * 无环纪律：只依赖 core/errors、types 纯类型与 shadow-write 的常量/路径函数，不 import store/builder/bm25/api。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { IntegrityError } from '../../core/errors.ts';
import type { CountScope, GatedStatus, GateReasonCode } from '../types.ts';
import {
  GATED_STATUS_VALUES,
  GATE_REASON_VALUES,
  SHADOW_LOG_FILE,
  shadowDirFromIndex,
} from '../shadow-write.ts';

/** 全量口径枚举（与 types.CountScope 逐字对应）：读取侧是唯一需要同时认两段的角色。 */
const COUNT_SCOPES: readonly CountScope[] = ['gated-full', 'legacy-limited'];

/**
 * 历史行兼容字段名（本文件唯一一处旧名登记；标注为兼容分支，供静态门核对）。
 * 只在解析历史行时按键取值一次，对外归一结果绝不携带该键。
 */
const COMPAT_OLD_COUNT_KEY = 'legacyCount';

/** 归一后的读取行：candidateCount 为 null 表示「该行来自截断旧口径，不可重建为全集计数」。 */
export interface ShadowObservationReadRow {
  readonly termHash: string;
  readonly gatedStatus: GatedStatus;
  readonly candidateCount: number | null;
  readonly countScope: CountScope;
  readonly acceptedCount: number;
  readonly rejectedReasonCodes: readonly GateReasonCode[];
  readonly observedMs: number;
}

/** 按 countScope 分段（两段恒在键集内，空段为空数组；两段禁止加总，Q4 只取 gated-full）。 */
export type ShadowGroups = Record<CountScope, readonly ShadowObservationReadRow[]>;

/** 观测日志绝对路径（由 indexDir 内部推导，与写侧同一归属点）。 */
export function shadowObservationLogPath(indexDir: string): string {
  return path.join(shadowDirFromIndex(indexDir), SHADOW_LOG_FILE);
}

/**
 * 读取全部影子观测行。文件缺失返回空数组（影子期尚未运行不是错误，且不创建目录）；
 * 任一坏行 fail-loud 抛 IntegrityError——观测是审计证据，静默丢弃等于伪造样本量。
 */
export function readShadowObservations(indexDir: string): readonly ShadowObservationReadRow[] {
  const logFile = shadowObservationLogPath(indexDir);
  if (!existsSync(logFile)) {
    return [];
  }
  const text = readFileSync(logFile, 'utf8');
  const rows: ShadowObservationReadRow[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    rows.push(parseShadowRow(line, index + 1));
  }
  return rows;
}

/** 按 countScope 分组（纯内存操作，不触碰文件）。 */
export function groupShadowByCountScope(rows: readonly ShadowObservationReadRow[]): ShadowGroups {
  const groups: Record<CountScope, ShadowObservationReadRow[]> = { 'gated-full': [], 'legacy-limited': [] };
  for (const row of rows) {
    groups[row.countScope].push(row);
  }
  return groups;
}

/** 白名单：新行七字段 + 历史行旧计数字段（其余键一律视为走私/损坏）。 */
const KNOWN_ROW_KEYS: readonly string[] = [
  'termHash',
  'gatedStatus',
  'candidateCount',
  'countScope',
  'acceptedCount',
  'rejectedReasonCodes',
  'observedMs',
  COMPAT_OLD_COUNT_KEY,
];

function fail(lineNo: number, message: string): never {
  throw new IntegrityError(`影子观测第 ${lineNo} 行不合契约：${message}`);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function requireStringField(raw: Record<string, unknown>, key: string, lineNo: number): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(lineNo, `${key} 必须是非空字符串`);
  }
  return value;
}

/** 解析并校验单行，归一为读取行；任何结构歧义都 fail-loud。 */
function parseShadowRow(line: string, lineNo: number): ShadowObservationReadRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail(lineNo, '不是合法 JSON（写入中断或外部篡改）');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(lineNo, '行必须是 JSON 对象');
  }
  const raw = parsed as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!KNOWN_ROW_KEYS.includes(key)) {
      fail(lineNo, `含契约外键 ${key}`);
    }
  }

  const termHash = requireStringField(raw, 'termHash', lineNo);

  const gatedStatus = raw['gatedStatus'];
  if (typeof gatedStatus !== 'string' || !GATED_STATUS_VALUES.includes(gatedStatus as GatedStatus)) {
    fail(lineNo, `gatedStatus 非受控枚举：${String(gatedStatus)}`);
  }

  const acceptedCount = raw['acceptedCount'];
  if (!isNonNegativeInteger(acceptedCount)) {
    fail(lineNo, 'acceptedCount 必须是非负整数');
  }

  const codes = raw['rejectedReasonCodes'];
  if (!Array.isArray(codes)) {
    fail(lineNo, 'rejectedReasonCodes 必须是数组');
  }
  for (const code of codes) {
    if (typeof code !== 'string' || !GATE_REASON_VALUES.includes(code as GateReasonCode)) {
      fail(lineNo, `rejectedReasonCodes 含非受控原因码：${String(code)}`);
    }
  }

  const observedMs = raw['observedMs'];
  if (typeof observedMs !== 'number' || !Number.isFinite(observedMs) || observedMs < 0) {
    fail(lineNo, 'observedMs 必须是非负有限数');
  }

  const hasScope = Object.hasOwn(raw, 'countScope');
  const hasOldCount = Object.hasOwn(raw, COMPAT_OLD_COUNT_KEY);
  if (hasScope && hasOldCount) {
    fail(lineNo, '同时含新旧计数字段，口径歧义（禁止把截断值与全集值混在同一行）');
  }

  let countScope: CountScope;
  let candidateCount: number | null;
  if (hasScope) {
    const scope = raw['countScope'];
    if (typeof scope !== 'string' || !COUNT_SCOPES.includes(scope as CountScope)) {
      fail(lineNo, `countScope 非受控枚举：${String(scope)}`);
    }
    countScope = scope as CountScope;
    const count = raw['candidateCount'];
    if (countScope === 'gated-full') {
      if (!isNonNegativeInteger(count)) {
        fail(lineNo, 'gated-full 行必须有非负整数 candidateCount');
      }
      candidateCount = count;
    } else {
      // legacy-limited 段按定义不可重建全集计数：只接受 null，数值一律视为口径污染。
      if (count !== null) {
        fail(lineNo, 'legacy-limited 行 candidateCount 必须为 null（旧截断值不得冒充全集计数）');
      }
      candidateCount = null;
    }
  } else if (hasOldCount) {
    // 历史行兼容：仅此处登记旧字段，读时补 legacy-limited 并把计数作废为 null。
    const oldCount = raw[COMPAT_OLD_COUNT_KEY];
    if (!isNonNegativeInteger(oldCount)) {
      fail(lineNo, '历史行旧计数必须是非负整数');
    }
    countScope = 'legacy-limited';
    candidateCount = null;
  } else {
    fail(lineNo, '既无 countScope 也无历史计数字段，无法判定口径');
  }

  return {
    termHash,
    gatedStatus: gatedStatus as GatedStatus,
    candidateCount,
    countScope,
    acceptedCount,
    rejectedReasonCodes: [...codes] as readonly GateReasonCode[],
    observedMs,
  };
}
