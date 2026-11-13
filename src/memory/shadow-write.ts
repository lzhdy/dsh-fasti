/**
 * N16 影子观测窄写原语（第二层 v0.3 §8.2，裁决 2026-11-13 §2 硬条件 a）。
 *
 * 这是经评审入白名单的 memory 侧**第六个**窄能力，与 sqlite 索引物理隔离：
 *  - 写面固定在 `<dataRoot>/projection/memory-shadow/shadow-observations.jsonl`，
 *    影子目录由工厂按 indexDir 内部推导，**观测入参不含任何目录/路径形参**，无法退化为通用文件写；
 *  - 入参运行时白名单（六字段），额外键/杜撰状态与原因码当场 IntegrityError（与 miss.ts 同一 fail-closed 纪律）；
 *  - term_hash 在本模块内部 sha256 计算，termNorm 与原始查询文本**永不落盘**；
 *  - append-only：只有 appendFileSync，没有更新/删除/truncate 路径；同输入确定性逐行一致（无随机 id）；
 *  - 构造期只算路径不建目录（off 零副作用），首次 record 才 mkdir；写失败封装为 ok:false 不重抛，
 *    影子是旁路，绝不阻断主检索链；
 *  - 不依赖 sqlite 写柄：运行期窄柄降级只读时，影子写面仍可用（两个物理面互不抢锁）。
 *
 * 无环纪律：仅依赖 core/errors、core/hash 与 types 纯类型、node 内置，不 import store/builder/bm25。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { IntegrityError } from '../core/errors.ts';
import { sha256Hex } from '../core/hash.ts';
import type { GatedStatus, GateReasonCode } from './types.ts';

/** 影子写面目录/文件具名常量（与 memory-index 平级，独立物理面）。 */
export const SHADOW_DIRNAME = 'memory-shadow';
export const SHADOW_LOG_FILE = 'shadow-observations.jsonl';

/**
 * 影子观测写入参（内存态）。termNorm 仅用于内部计算 term_hash，不落盘；
 * 注意没有任何 dir/path/file 形参——写位置是工厂冻结的内部细节。
 */
export interface ShadowObservationInput {
  readonly termNorm: string;
  readonly gatedStatus: GatedStatus;
  readonly legacyCount: number;
  readonly acceptedCount: number;
  readonly rejectedReasonCodes: readonly GateReasonCode[];
  readonly observedMs: number;
}

/** 实际落盘行：termNorm 已消失，只剩不可逆 term_hash 与客观计数/原因码。 */
export interface ShadowObservationRow {
  readonly termHash: string;
  readonly gatedStatus: GatedStatus;
  readonly legacyCount: number;
  readonly acceptedCount: number;
  readonly rejectedReasonCodes: readonly GateReasonCode[];
  readonly observedMs: number;
}

/** 影子写结果：失败隔离契约，record 永不抛错。 */
export type RecordShadowOutcome =
  | { readonly ok: true; readonly row: ShadowObservationRow }
  | { readonly ok: false; readonly reason: string };

/** 入参白名单六字段（运行时键集超出即拒，杜绝路径形参/原文走私）。 */
const SHADOW_INPUT_KEYS: readonly string[] = [
  'termNorm',
  'gatedStatus',
  'legacyCount',
  'acceptedCount',
  'rejectedReasonCodes',
  'observedMs',
];

/** 受控状态枚举（与 types.GatedStatus 联合逐字对应，运行时 fail-closed 校验）。 */
const GATED_STATUS_VALUES: readonly GatedStatus[] = ['hit', 'abstain', 'no-match'];

/** 受控原因码枚举（与 types.GateReasonCode 联合逐字对应；新增门原因码必须先在此登记，否则影子拒绝写）。 */
const GATE_REASON_VALUES: readonly GateReasonCode[] = [
  'empty-query',
  'zero-lexical-hit',
  'all-rejected',
  'exact-alias-pass',
  'fts-word-boundary-pass',
  'ascii-no-word-boundary',
  'like-only-weak-match',
  'missing-cue-text',
];

/**
 * 运行时严格白名单 + 字段校验（纯函数，与 miss.validateMissInput 同构）。
 * Object.keys 出现六字段外的键（含任何路径形参、rawQuery/text）即抛 IntegrityError。
 */
export function validateShadowInput(input: ShadowObservationInput): void {
  if (input === null || typeof input !== 'object') {
    throw new IntegrityError('影子观测入参必须是对象');
  }
  for (const key of Object.keys(input)) {
    if (!SHADOW_INPUT_KEYS.includes(key)) {
      throw new IntegrityError(`影子观测入参含白名单外键：${key}（影子写面封闭，禁止路径形参/原始查询）`);
    }
  }
  if (typeof input.termNorm !== 'string' || input.termNorm.trim().length === 0) {
    throw new IntegrityError('影子观测 termNorm 必须是非空字符串');
  }
  if (!GATED_STATUS_VALUES.includes(input.gatedStatus)) {
    throw new IntegrityError(`影子观测 gatedStatus 非受控枚举：${String(input.gatedStatus)}`);
  }
  for (const field of ['legacyCount', 'acceptedCount'] as const) {
    const value = input[field];
    if (!Number.isInteger(value) || value < 0) {
      throw new IntegrityError(`影子观测 ${field} 必须是非负整数`);
    }
  }
  if (
    !Array.isArray(input.rejectedReasonCodes) ||
    input.rejectedReasonCodes.some((code) => !GATE_REASON_VALUES.includes(code))
  ) {
    throw new IntegrityError('影子观测 rejectedReasonCodes 必须是受控门原因码数组（杜撰码拒绝写入）');
  }
  if (typeof input.observedMs !== 'number' || !Number.isFinite(input.observedMs) || input.observedMs < 0) {
    throw new IntegrityError('影子观测 observedMs 必须是非负有限数（注入时钟）');
  }
}

/**
 * 由索引目录内部固定推导影子目录：`<projection>/memory-index` 的同级 `<projection>/memory-shadow`。
 * 单一归属点，调用方无法经观测入参改写落点。
 */
export function shadowDirFromIndex(indexDir: string): string {
  const projectionDir = path.dirname(path.resolve(indexDir));
  return path.join(projectionDir, SHADOW_DIRNAME);
}

export interface ShadowObservationSink {
  record(input: ShadowObservationInput): RecordShadowOutcome;
}

/**
 * 打开影子观测落点。构造期只计算路径、不触碰文件系统（off 态因此零目录副作用）；
 * 首次 record 才 mkdir + append。落点与 sqlite 无关，故不经过写柄单例、不受只读降级影响。
 */
export function openShadowObservationSink(indexDir: string): ShadowObservationSink {
  const shadowDir = shadowDirFromIndex(indexDir);
  const logFile = path.join(shadowDir, SHADOW_LOG_FILE);

  return {
    record(input: ShadowObservationInput): RecordShadowOutcome {
      try {
        validateShadowInput(input);
        const row: ShadowObservationRow = {
          termHash: sha256Hex(input.termNorm),
          gatedStatus: input.gatedStatus,
          legacyCount: input.legacyCount,
          acceptedCount: input.acceptedCount,
          rejectedReasonCodes: [...input.rejectedReasonCodes],
          observedMs: input.observedMs,
        };
        mkdirSync(shadowDir, { recursive: true });
        appendFileSync(logFile, `${JSON.stringify(row)}\n`, { encoding: 'utf8' });
        return { ok: true, row };
      } catch (error) {
        // 失败隔离：影子写永不冒泡阻断主检索；只回客观原因，不丢弃/伪造其他观测。
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
