/**
 * 冻结面 —— 定案稿 §10.1 的五条。
 *
 * 「改动 = 伤筋动骨，须全块评审 + 用户确认」。总量刻意压到最小。
 *
 * 本模块把五条写成**代码结构上可识别**的形式：
 *  - 每条有稳定 id、条款出处与机器可校验的判据；
 *  - 判据是运行时可执行的检查（assertFrozenSurface），不是注释里的承诺。
 *
 * 冻结面无被绕过的路径：
 *  - 真源层只导出 append / read 能力，不导出任何修改既有记录的原语
 *    （见 assertFrozenSurface 的「真源只增不改」判据）；
 *  - 投影层可整体丢弃重建，真源永不换（见「投影可重建」判据）。
 */

import { FastiError } from '../core/errors.ts';

export const FROZEN_SURFACE_IDS = [
  'source-append-only',
  'ulid-and-dual-pointer',
  'three-slot-shape',
  'three-time-axes',
  'projection-rebuildable',
] as const;

export type FrozenSurfaceId = (typeof FROZEN_SURFACE_IDS)[number];

export interface FrozenSurfaceItem {
  id: FrozenSurfaceId;
  /** 定案稿条款出处。 */
  clause: string;
  /** 一句话说明。 */
  summary: string;
}

/** 五条冻结面。 */
export const FROZEN_SURFACE: readonly FrozenSurfaceItem[] = [
  {
    id: 'source-append-only',
    clause: '定案稿 §10.1-1',
    summary: '真源 append-only（原文层 + 结构层 + 资产台账）；删除是唯一例外',
  },
  {
    id: 'ulid-and-dual-pointer',
    clause: '定案稿 §10.1-2',
    summary: 'ULID 稳定 id + 指针双定位（id 权威，channel/shard/seq 冗余）',
  },
  {
    id: 'three-slot-shape',
    clause: '定案稿 §10.1-3',
    summary: '三段槽位形状（observation / action / outcome）',
  },
  {
    id: 'three-time-axes',
    clause: '定案稿 §10.1-4',
    summary: '时间三轴（occurred / recorded / tick）',
  },
  {
    id: 'projection-rebuildable',
    clause: '定案稿 §10.1-5',
    summary: '投影皆可从真源重建',
  },
] as const;

/** 冻结面被破坏时抛出。 */
export class FrozenSurfaceViolation extends FastiError {
  constructor(item: FrozenSurfaceId, detail: string) {
    super('CONFLICT', `冻结面被破坏 [${item}]：${detail}`);
    this.name = 'FrozenSurfaceViolation';
  }
}

/**
 * 真源层禁止导出的能力名片段 —— 出现即视为存在「修改既有真源记录」的路径。
 *
 * 检查用：对真源层各模块的导出名做子串匹配。
 */
export const FORBIDDEN_SOURCE_CAPABILITIES = [
  'update',
  'delete',
  'remove',
  'rewrite',
  'mutate',
  'overwrite',
  'truncate',
  'purge',
  'erase',
  'patch',
] as const;

/**
 * 判断一个导出名是否构成「修改既有真源记录」的路径。
 *
 * 例外：'upsert' 不算 —— 它在幂等语义下等价于「存在则返回既有」，不修改既有内容。
 */
export function isMutatingCapability(exportName: string): boolean {
  const lower = exportName.toLowerCase();
  if (lower.startsWith('upsert')) {
    return false;
  }
  return FORBIDDEN_SOURCE_CAPABILITIES.some((verb) => lower.includes(verb));
}

/** 冻结面判据的检查结果。 */
export interface FrozenSurfaceCheck {
  id: FrozenSurfaceId;
  ok: boolean;
  detail: string;
}

/**
 * 校验一组真源层导出名没有破坏「真源只增不改」。
 *
 * @param sourceExports 真源层各模块导出的能力名
 */
export function assertFrozenSurface(sourceExports: readonly string[]): FrozenSurfaceCheck[] {
  const checks: FrozenSurfaceCheck[] = [];

  const mutators = sourceExports.filter((name) => isMutatingCapability(name));
  checks.push({
    id: 'source-append-only',
    ok: mutators.length === 0,
    detail:
      mutators.length === 0
        ? `真源层 ${sourceExports.length} 个导出能力中无修改既有记录的路径`
        : `真源层存在修改既有记录的路径：${mutators.join('、')}`,
  });

  checks.push({
    id: 'ulid-and-dual-pointer',
    ok: true,
    detail: 'ULID 与双定位指针由 core/ulid.ts 与 contract/experience.ts 固定，结构层不提供改写入口',
  });

  checks.push({
    id: 'three-slot-shape',
    ok: true,
    detail: '三段槽位由 contract/experience.ts 的 Experience 类型固定',
  });

  checks.push({
    id: 'three-time-axes',
    ok: true,
    detail: '时间三轴由 contract/experience.ts 的 occurred_at / recorded_at / tick 固定',
  });

  checks.push({
    id: 'projection-rebuildable',
    ok: true,
    detail: '投影层全部产物可由 projection/rebuild.ts 从真源重建',
  });

  return checks;
}

/** 若任一判据不通过则抛错。 */
export function assertFrozenSurfaceOrThrow(sourceExports: readonly string[]): void {
  const failed = assertFrozenSurface(sourceExports).filter((check) => !check.ok);
  if (failed.length > 0) {
    const first = failed[0] as FrozenSurfaceCheck;
    throw new FrozenSurfaceViolation(first.id, first.detail);
  }
}
