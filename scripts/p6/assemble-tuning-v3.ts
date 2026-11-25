/**
 * 统一调参新卷 · v3 调参卷装配机（W2-5）。
 *
 * 与封存装配机（`assemble-sealed-fixtures*.ts`）的分工：
 *  - v1/v2 封存装配机一字不动（终判卷可复现性零回归）；
 *  - v3 调参卷另立本文件：四类文档（gold/decoy/abstain/clarify），接 `tuning-fixtures-v3` 校验器。
 *
 * 机械翻译口径（与封存侧一致：只换了 id 的命名空间，不动语义标注）：
 *  - gold：`goldEventIds` 的 syn 事件 id → 合成根**系统事件 id**；
 *  - decoy：`goldEventId` / `rivalEventIds` 同上；
 *  - abstain：`goldEventId` 为 null 时保持 null（绝不翻译成字符串），非空时翻译；
 *  - clarify：`pairEventIds` 同上。
 *
 * 三道门（顺序固定，前门不过不翻译）：
 *  1. 版本闸：`assertTuningV3SetVersion`（四份必须同属 fasti-p6-tuning/v3）；
 *  2. 前端严格校验：出题成品先过 `validateTuningV3File` —— 任何未登记键（含笔误如
 *     `goldEventIDs`）当场拒，不给「静默丢弃导致少字段」留窗口；
 *  3. 翻译 + 守卫：悬空引用拒；题面 `partitionTag` 与所引事件实际分区不一致拒。
 *
 * 纪律：本文件不判 PASSED、不切生产常量、不写封存/解封日志；落盘只写全新空目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { IntegrityError } from '../../src/core/errors.ts';
import { ensureFreshDir } from './build-synthetic-world.ts';
import { writeFileAtomic } from '../../src/core/fsx.ts';
import type { WorldPlanV3, CorpusPartitionV3 } from '../../src/memory/audit/corpus/world-plan-v3.ts';
import { buildWorldV3 } from '../../src/memory/audit/corpus/world-plan-v3.ts';
import {
  TUNING_V3_VERSION,
  assertTuningV3SetVersion,
  validateTuningV3File,
} from '../../src/memory/audit/tuning-fixtures-v3.ts';
import type {
  TuningAbstainDocV3,
  TuningClarifyDocV3,
  TuningDecoyDocV3,
  TuningGoldDocV3,
  TuningV3Layer,
} from '../../src/memory/audit/tuning-fixtures-v3.ts';

/**
 * 装配所需的 id 映射面：只吃两个字段，故与 `buildSynthIdMap` 的产出结构兼容
 * （后者多带的 cues/aliases 在此不可见，也就不可能被误用进调参卷）。
 */
export interface TuningIdEntry {
  readonly systemEventId: string;
  readonly cardId: string;
}

/** 出题成品：四份原样提交，层名与 tuning-fixtures-v3 一致。 */
export interface AuthoredInputV3 {
  readonly gold: { readonly probeSetVersion: string; readonly layer: 'tuning-gold'; readonly items: readonly unknown[] };
  readonly decoy: { readonly probeSetVersion: string; readonly layer: 'tuning-decoy'; readonly items: readonly unknown[] };
  readonly abstain: { readonly probeSetVersion: string; readonly layer: 'tuning-abstain'; readonly items: readonly unknown[] };
  readonly clarify: { readonly probeSetVersion: string; readonly layer: 'tuning-clarify'; readonly items: readonly unknown[] };
}

export interface AssembledTuningV3 {
  readonly gold: TuningGoldDocV3;
  readonly decoy: TuningDecoyDocV3;
  readonly abstain: TuningAbstainDocV3;
  readonly clarify: TuningClarifyDocV3;
}

/** 内部视图：校验器保证形状后再按字段取值，避免大段 unknown 断言散落。 */
interface GoldItem {
  probeId: string;
  bucket: string;
  partitionTag: CorpusPartitionV3;
  goldEventIds: readonly string[];
  queries: readonly string[];
  negativeSignature?: number;
  highRiskLabel?: string;
  constructionLayer?: string;
  edit?: unknown;
  hitFieldSpec?: unknown;
}
interface DecoyItem {
  probeId: string;
  bucket: string;
  partitionTag: CorpusPartitionV3;
  goldEventId: string;
  rivalEventIds: readonly string[];
  density: number;
  discriminatorQuery: string;
  negativeSignature?: number;
  highRiskLabel?: string;
}
interface AbstainItem {
  probeId: string;
  bucket: string;
  partitionTag: CorpusPartitionV3;
  query: string;
  hardness: 'hard' | 'soft';
  goldEventId: string | null;
  negativeSignature?: number;
  highRiskLabel?: string;
}
interface ClarifyItem {
  probeId: string;
  bucket: string;
  partitionTag: CorpusPartitionV3;
  pairEventIds: readonly string[];
  query: string;
  detailWord?: string;
  expectedBehavior: 'clarify';
  negativeSignature?: number;
  highRiskLabel?: string;
}

function requireId(idMap: ReadonlyMap<string, TuningIdEntry>, synId: string, where: string): string {
  const entry = idMap.get(synId);
  if (entry === undefined) {
    throw new IntegrityError(`调参装配：${where} 引用的合成事件 id「${synId}」在合成根找不到对应卡片（悬空引用，拒绝装配）`);
  }
  return entry.systemEventId;
}

/** 可选标注：有则原样带上，无则不出现该键（不写 undefined，避免序列化出 null）。 */
function withOptional<T extends Record<string, unknown>>(
  base: T,
  extras: ReadonlyArray<[string, unknown]>,
): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of extras) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * 纯装配：不读文件系统、不触库。只做「校验 → 翻译 → 再校验」。
 * 强类型返回值按四类文档给出，调用方无需再断言。
 */
export function assembleTuningV3(
  authored: AuthoredInputV3,
  idMap: ReadonlyMap<string, TuningIdEntry>,
): AssembledTuningV3 {
  // 门 1：版本闸（四份同版、且必须是 v3）。
  assertTuningV3SetVersion([authored.gold, authored.decoy, authored.abstain, authored.clarify]);
  if (authored.gold.probeSetVersion !== TUNING_V3_VERSION) {
    throw new IntegrityError(
      `调参装配：输入卷版本 ${authored.gold.probeSetVersion} 非 ${TUNING_V3_VERSION}（历史卷请走各自装配机）`,
    );
  }

  // 门 2：前端严格白名单（逐类过一遍，笔误键当场拒）。
  const layers: ReadonlyArray<[TuningV3Layer, { readonly layer: TuningV3Layer; readonly items: readonly unknown[] }]> = [
    ['tuning-gold', authored.gold],
    ['tuning-decoy', authored.decoy],
    ['tuning-abstain', authored.abstain],
    ['tuning-clarify', authored.clarify],
  ];
  for (const [layer, doc] of layers) validateTuningV3File(doc, layer);

  const version = authored.gold.probeSetVersion;

  const goldItems = (authored.gold.items as readonly GoldItem[]).map((item) =>
    withOptional<Record<string, unknown>>(
      {
        probeId: item.probeId,
        bucket: item.bucket,
        partitionTag: item.partitionTag,
        goldEventIds: item.goldEventIds.map((synId) => requireId(idMap, synId, `gold ${item.probeId}`)),
        queries: [...item.queries],
      },
      [
        ['negativeSignature', item.negativeSignature],
        ['highRiskLabel', item.highRiskLabel],
        ['constructionLayer', item.constructionLayer],
        ['edit', item.edit],
        ['hitFieldSpec', item.hitFieldSpec],
      ],
    ) as unknown as GoldItem,
  ) as unknown as TuningGoldDocV3['items'];

  const decoyItems = (authored.decoy.items as readonly DecoyItem[]).map((item) =>
    withOptional<Record<string, unknown>>(
      {
        probeId: item.probeId,
        bucket: item.bucket,
        partitionTag: item.partitionTag,
        goldEventId: requireId(idMap, item.goldEventId, `decoy ${item.probeId} 金标`),
        rivalEventIds: item.rivalEventIds.map((synId) => requireId(idMap, synId, `decoy ${item.probeId} 对手`)),
        density: item.density,
        discriminatorQuery: item.discriminatorQuery,
      },
      [
        ['negativeSignature', item.negativeSignature],
        ['highRiskLabel', item.highRiskLabel],
      ],
    ) as unknown as DecoyItem,
  ) as unknown as TuningDecoyDocV3['items'];

  const abstainItems = (authored.abstain.items as readonly AbstainItem[]).map((item) =>
    withOptional<Record<string, unknown>>(
      {
        probeId: item.probeId,
        bucket: item.bucket,
        partitionTag: item.partitionTag,
        query: item.query,
        hardness: item.hardness,
        // null 就是 null：绝不把「库里没有」翻译成某个 id。
        goldEventId: item.goldEventId === null ? null : requireId(idMap, item.goldEventId, `abstain ${item.probeId}`),
      },
      [
        ['negativeSignature', item.negativeSignature],
        ['highRiskLabel', item.highRiskLabel],
      ],
    ) as unknown as AbstainItem,
  ) as unknown as TuningAbstainDocV3['items'];

  const clarifyItems = (authored.clarify.items as readonly ClarifyItem[]).map((item) =>
    withOptional<Record<string, unknown>>(
      {
        probeId: item.probeId,
        bucket: item.bucket,
        partitionTag: item.partitionTag,
        pairEventIds: item.pairEventIds.map((synId) => requireId(idMap, synId, `clarify ${item.probeId}`)),
        query: item.query,
        expectedBehavior: 'clarify' as const,
      },
      [
        ['detailWord', item.detailWord],
        ['negativeSignature', item.negativeSignature],
        ['highRiskLabel', item.highRiskLabel],
      ],
    ) as unknown as ClarifyItem,
  ) as unknown as TuningClarifyDocV3['items'];

  return {
    gold: { probeSetVersion: version, layer: 'tuning-gold', items: goldItems },
    decoy: { probeSetVersion: version, layer: 'tuning-decoy', items: decoyItems },
    abstain: { probeSetVersion: version, layer: 'tuning-abstain', items: abstainItems },
    clarify: { probeSetVersion: version, layer: 'tuning-clarify', items: clarifyItems },
  };
}

/**
 * 门 3：守卫。逐类再校验一遍（防装配期写错键），并核对
 * 「题面分区标签 == 所引事件的真实分区」——A 题引用 B 事件即拒，杜绝 A/B 互串。
 */
export function assertTuningV3Guards(
  files: AssembledTuningV3,
  idMap: ReadonlyMap<string, TuningIdEntry>,
  plan: WorldPlanV3 = buildWorldV3(),
): void {
  validateTuningV3File(files.gold, 'tuning-gold');
  validateTuningV3File(files.decoy, 'tuning-decoy');
  validateTuningV3File(files.abstain, 'tuning-abstain');
  validateTuningV3File(files.clarify, 'tuning-clarify');

  // 系统事件 id → 真实分区（由蓝本 + 映射表反推，不信任题面自述）。
  const partitionOfSystem = new Map<string, CorpusPartitionV3>();
  for (const event of plan.events) {
    const entry = idMap.get(event.eventId);
    if (entry === undefined) {
      throw new IntegrityError(`调参装配：蓝本事件 ${event.eventId} 在合成根缺卡，世界与夹具不同源`);
    }
    partitionOfSystem.set(entry.systemEventId, event.partition);
  }

  const check = (systemId: string, declared: CorpusPartitionV3, where: string): void => {
    const actual = partitionOfSystem.get(systemId);
    if (actual === undefined) {
      throw new IntegrityError(`调参装配：${where} 的系统事件 ${systemId} 不在本蓝本内（跨卷或悬空）`);
    }
    if (actual !== declared) {
      throw new IntegrityError(
        `调参装配：${where} 标称分区 ${declared}，但所引事件实际属 ${actual}（分区互串，拒绝装配）`,
      );
    }
  };

  for (const item of files.gold.items as unknown as readonly GoldItem[]) {
    for (const id of item.goldEventIds) check(id, item.partitionTag, `gold ${item.probeId}`);
  }
  for (const item of files.decoy.items as unknown as readonly DecoyItem[]) {
    check(item.goldEventId, item.partitionTag, `decoy ${item.probeId} 金标`);
    for (const id of item.rivalEventIds) check(id, item.partitionTag, `decoy ${item.probeId} 对手`);
  }
  for (const item of files.abstain.items as unknown as readonly AbstainItem[]) {
    if (item.goldEventId !== null) check(item.goldEventId, item.partitionTag, `abstain ${item.probeId}`);
  }
  for (const item of files.clarify.items as unknown as readonly ClarifyItem[]) {
    for (const id of item.pairEventIds) check(id, item.partitionTag, `clarify ${item.probeId}`);
  }
}

/** 落盘四件套到全新空目录（已存在且非空即拒，杜绝新旧夹具混杂）。 */
export function writeAssembledTuningV3(outDir: string, files: AssembledTuningV3): void {
  ensureFreshDir(outDir, '--out');
  const docs: ReadonlyArray<[string, unknown]> = [
    ['tuning-gold.json', files.gold],
    ['tuning-decoy.json', files.decoy],
    ['tuning-abstain.json', files.abstain],
    ['tuning-clarify.json', files.clarify],
  ];
  for (const [name, doc] of docs) {
    writeFileAtomic(path.join(outDir, name), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

interface CliArgs {
  authored: string | undefined;
  worldRoot: string | undefined;
  out: string | undefined;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { authored: undefined, worldRoot: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`参数 ${flag} 缺少取值`);
    i += 1;
    if (flag === '--authored') args.authored = value;
    else if (flag === '--world-root') args.worldRoot = value;
    else if (flag === '--out') args.out = value;
    else throw new Error(`未知参数 ${flag}`);
  }
  return args;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.authored || !args.worldRoot || !args.out) {
    process.stderr.write(
      '用法：assemble-tuning-v3.ts --authored <出题成品调参目录> --world-root <v3 合成根> --out <装配输出目录>\n',
    );
    process.exitCode = 2;
    return;
  }
  const authored = {
    gold: readJson(path.join(args.authored, 'tuning-gold.json')),
    decoy: readJson(path.join(args.authored, 'tuning-decoy.json')),
    abstain: readJson(path.join(args.authored, 'tuning-abstain.json')),
    clarify: readJson(path.join(args.authored, 'tuning-clarify.json')),
  } as unknown as AuthoredInputV3;

  // 映射器复用既有的 D3 合成根映射（按卡片 discriminator `disc-<synId>` 建表）。
  const { buildSynthIdMap } = await import('./assemble-sealed-fixtures.ts');
  const idMap = buildSynthIdMap(path.resolve(args.worldRoot));

  const files = assembleTuningV3(authored, idMap);
  assertTuningV3Guards(files, idMap, buildWorldV3());
  writeAssembledTuningV3(path.resolve(args.out), files);
  process.stdout.write(
    `调参卷装配完成并通过全部守卫：${path.resolve(args.out)}（gold=${files.gold.items.length}、` +
      `decoy=${files.decoy.items.length}、abstain=${files.abstain.items.length}、clarify=${files.clarify.items.length}）\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
