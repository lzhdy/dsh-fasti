/**
 * P6 v5 · 封存夹具装配机 v2（预注册 v5 §8.2 N3，G3/G4/G6）。
 *
 * 与 v1 `assemble-sealed-fixtures.ts` 的分工：v1 封箱后一字不动（v1 卷可复现性零回归），
 * v2 卷另立本文件，接 `buildWorldV2()` 蓝本、六层配额、六件套（多出 clarify）。
 *
 * 机械翻译口径：
 *  - gold-l0：eventId 与 discriminatorNeighborEventIds → 合成根系统事件 ULID；
 *  - decoy：pairEventIds/goldEventId → card_id，`decoyKind` 三分类原样透传（R2 按类分算）；
 *  - clarify：pairEventIds → pairCardIds，`detailWord`/`expectedBehavior`/`query` 原样保留；
 *  - abstain：noise 的 goldEventId → card_id，unanswerable 保持 null；
 *  - gold-l1/holdout 仍为空 companion（本路线无 L1/L2 人工标注）。
 *
 * 纪律：纯函数不做文件 IO；装配后强制走加载器白名单、G3 零别名、G4①/G4②/G4③ 逐条，
 * 并硬拒「调参事件混入终判卷」；封存目录/操作人/时刻全由 CLI 注入，不读墙钟、无硬编码路径。
 * 本文件不碰生产门档、不判 PASSED、不写解封日志。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { IntegrityError } from '../../src/core/errors.ts';
import { ensureDir, writeFileAtomic } from '../../src/core/fsx.ts';
import { sha256Hex } from '../../src/memory/content-hash.ts';
import { buildWorldV2 } from '../../src/memory/audit/corpus/world-plan-v2.ts';
import type { WorldPlanV2 } from '../../src/memory/audit/corpus/world-plan-v2.ts';
import { validateFixtureFile } from '../../src/memory/audit/fixtures.ts';
import type { GoldL0Item, DecoyItem, ClarifyItem, AbstainItem, ConstructionLayer, DecoyKind } from '../../src/memory/audit/fixtures.ts';
import { assertAZeroAliases, assertP6GoldItem } from '../../src/memory/audit/fixture-guard.ts';
import type { GuardCardRef } from '../../src/memory/audit/fixture-guard.ts';
import { sealFixtures, verifySeal } from '../../src/memory/audit/sealing.ts';
import { ensureFreshDir } from './build-synthetic-world.ts';
import { buildSynthIdMap } from './assemble-sealed-fixtures.ts';
import { CURRENT_RULES_VERSION } from '../../src/memory/types.ts';
import { DEFAULT_RNG_SEED } from '../../src/memory/audit/metrics.ts';

/** v2 卷版本形态（预注册 v5 §8.2 N1/N3）。 */
export const PROBES_V2_VERSION = 'fasti-p6-probes/v2';

/** 预注册 v5 §5.2 封存终判集六层配额（seal-manifest 声明值，题数真值以哈希夹具为准）。 */
export const SEAL_LAYER_QUOTAS_V2: Readonly<Record<string, number>> = Object.freeze({
  S0: 150,
  S1: 150,
  S2: 50,
  S3: 50,
  S4: 50,
  S5: 100,
});

type HighRiskLabel = 'strong' | 'promise' | 'date' | 'verbatim' | 'negation';

interface SynthIdEntry {
  readonly synId: string;
  readonly systemEventId: string;
  readonly cardId: string;
  readonly cues: readonly string[];
  readonly aliases: GuardCardRef['aliases'];
}

interface AuthoredL0Item {
  eventId: string;
  channel: string;
  queries: readonly string[];
  aliases: ReadonlyArray<{ term: string; source: 'miss'; sensitive: 0 | 1 }>;
  sensitiveTerms: readonly string[];
  discriminatorNeighborEventIds: readonly string[];
  expectedSlots: ReadonlyArray<'guaranteed' | 'recency' | 'identity' | 'relevance' | 'obligation'>;
  constructionLayer?: ConstructionLayer;
  sourceLocation?: { source: 'raw-turn' | 'summary'; anchor: string };
  highRiskLabel?: HighRiskLabel;
  sourceCharShare?: number;
  arbitration?: { adjudicator: string; decision: string };
}

interface AuthoredDecoyItem {
  pairEventIds: readonly string[];
  goldEventId: string;
  discriminatorQuery: string;
  highRiskLabel?: HighRiskLabel;
  decoyKind: DecoyKind;
}

interface AuthoredClarifyItem {
  pairEventIds: readonly string[];
  detailWord: string;
  expectedBehavior: 'clarify';
  query: string;
}

interface AuthoredAbstainItem {
  query: string;
  goldEventId: string | null;
  kind: 'unanswerable' | 'noise';
}

export interface AuthoredInputV2 {
  readonly gold: { probeSetVersion: string; layer: 'l0'; items: readonly AuthoredL0Item[] };
  readonly decoy: { probeSetVersion: string; layer: 'decoy'; items: readonly AuthoredDecoyItem[] };
  readonly clarify: { probeSetVersion: string; layer: 'clarify'; items: readonly AuthoredClarifyItem[] };
  readonly abstain: { probeSetVersion: string; layer: 'abstain'; items: readonly AuthoredAbstainItem[] };
}

export interface AssembledFixturesV2 {
  readonly goldL0: { probeSetVersion: string; layer: 'l0'; items: GoldL0Item[] };
  readonly goldL1: { probeSetVersion: string; layer: 'l1'; items: [] };
  readonly holdout: { probeSetVersion: string; layer: 'l2'; items: [] };
  readonly decoy: { probeSetVersion: string; layer: 'decoy'; items: DecoyItem[] };
  readonly clarify: { probeSetVersion: string; layer: 'clarify'; items: ClarifyItem[] };
  readonly abstain: { probeSetVersion: string; layer: 'abstain'; items: AbstainItem[] };
}

function requireEntry(idMap: ReadonlyMap<string, SynthIdEntry>, synId: string, where: string): SynthIdEntry {
  const entry = idMap.get(synId);
  if (entry === undefined) {
    throw new IntegrityError(`N3 装配：${where} 的合成事件 id「${synId}」在合成根找不到对应卡片（悬空引用，拒绝装配）`);
  }
  return entry;
}

/** 纯装配：不读文件系统、不触库，只做形状不变的机械翻译（四份授权文件 → 六件套）。 */
export function assembleSealedFixturesV2(
  authored: AuthoredInputV2,
  idMap: ReadonlyMap<string, SynthIdEntry>,
): AssembledFixturesV2 {
  const version = authored.gold.probeSetVersion;
  for (const [label, doc] of [
    ['gold-l0', authored.gold],
    ['decoy', authored.decoy],
    ['clarify', authored.clarify],
    ['abstain', authored.abstain],
  ] as const) {
    if (doc.probeSetVersion !== version) {
      throw new IntegrityError(`N3 装配：${label}.probeSetVersion=${doc.probeSetVersion} 与 gold-l0=${version} 不一致`);
    }
  }

  const goldItems: GoldL0Item[] = authored.gold.items.map((item) => ({
    ...item,
    eventId: requireEntry(idMap, item.eventId, 'gold-l0').systemEventId,
    discriminatorNeighborEventIds: item.discriminatorNeighborEventIds.map(
      (synId) => requireEntry(idMap, synId, 'gold-l0 近邻').systemEventId,
    ),
  }));

  const decoyItems: DecoyItem[] = authored.decoy.items.map((item) => {
    const pairCardIds = item.pairEventIds.map((synId) => requireEntry(idMap, synId, 'decoy 配对').cardId);
    const goldCardId = requireEntry(idMap, item.goldEventId, 'decoy 金标').cardId;
    const base = { pairCardIds, discriminatorQuery: item.discriminatorQuery, goldCardId, decoyKind: item.decoyKind };
    return item.highRiskLabel === undefined ? base : { ...base, highRiskLabel: item.highRiskLabel };
  });

  const clarifyItems: ClarifyItem[] = authored.clarify.items.map((item) => ({
    pairCardIds: item.pairEventIds.map((synId) => requireEntry(idMap, synId, 'clarify 配对').cardId),
    detailWord: item.detailWord,
    expectedBehavior: item.expectedBehavior,
    query: item.query,
  }));

  const abstainItems: AbstainItem[] = authored.abstain.items.map((item) => {
    if (item.kind === 'unanswerable') {
      if (item.goldEventId !== null) {
        throw new IntegrityError(`N3 装配：unanswerable 探针「${item.query}」goldEventId 必须为 null`);
      }
      return { query: item.query, goldCardId: null, kind: item.kind } as const;
    }
    return {
      query: item.query,
      goldCardId: requireEntry(idMap, item.goldEventId!, 'abstain noise 金标').cardId,
      kind: item.kind,
    } as const;
  });

  return {
    goldL0: { probeSetVersion: version, layer: 'l0', items: goldItems },
    goldL1: { probeSetVersion: version, layer: 'l1', items: [] },
    holdout: { probeSetVersion: version, layer: 'l2', items: [] },
    decoy: { probeSetVersion: version, layer: 'decoy', items: decoyItems },
    clarify: { probeSetVersion: version, layer: 'clarify', items: clarifyItems },
    abstain: { probeSetVersion: version, layer: 'abstain', items: abstainItems },
  };
}

/** 六层配额核对（只做加法对账：各层条目数须与冻结配额逐层相等）。 */
export function assertLayerQuotasV2(files: AssembledFixturesV2): void {
  const counts = new Map<string, number>();
  for (const item of files.goldL0.items) {
    const layer = item.constructionLayer;
    if (layer === undefined) {
      throw new IntegrityError('N3 配额：gold-l0 存在无 constructionLayer 的条目，无法按层对账');
    }
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  for (const [layer, expected] of Object.entries(SEAL_LAYER_QUOTAS_V2)) {
    const actual = counts.get(layer) ?? 0;
    if (actual !== expected) {
      throw new IntegrityError(`N3 配额：${layer} 实际 ${actual} 条，与冻结配额 ${expected} 条不符`);
    }
  }
  for (const layer of counts.keys()) {
    if (!(layer in SEAL_LAYER_QUOTAS_V2)) {
      throw new IntegrityError(`N3 配额：出现未登记构造层 ${layer}`);
    }
  }
}

/**
 * 真实守卫：加载器字段白名单/枚举 → G3 零别名 → G4①/G4②/G4③ 逐条，
 * 且硬拒调参事件混入终判卷（本卷只准封存分区事件）。
 */
export function assertAssembledGuardsV2(
  files: AssembledFixturesV2,
  idMap: ReadonlyMap<string, SynthIdEntry>,
  plan: WorldPlanV2 = buildWorldV2(),
): void {
  validateFixtureFile(files.goldL0, 'l0', 'gold-l0.json');
  validateFixtureFile(files.goldL1, 'l1', 'gold-l1.json');
  validateFixtureFile(files.holdout, 'l2', 'holdout.json');
  validateFixtureFile(files.decoy, 'decoy', 'decoy.json');
  validateFixtureFile(files.clarify, 'clarify', 'clarify.json');
  validateFixtureFile(files.abstain, 'abstain', 'abstain.json');

  const l0Items = files.goldL0.items as Parameters<typeof assertAZeroAliases>[0];
  assertAZeroAliases(l0Items);

  const guardCards = new Map<string, GuardCardRef>();
  const keyPointsBySystem = new Map<string, readonly string[]>();
  const sealedSystemIds = new Set<string>();
  const tuningSystemIds = new Set<string>();
  for (const event of plan.events) {
    const entry = idMap.get(event.eventId);
    if (entry === undefined) {
      throw new IntegrityError(`N3 装配：蓝本事件 ${event.eventId} 在合成根缺卡，世界与夹具不同源`);
    }
    (event.partition === 'sealed' ? sealedSystemIds : tuningSystemIds).add(entry.systemEventId);
    guardCards.set(entry.systemEventId, {
      eventId: entry.systemEventId,
      cues: entry.cues,
      aliases: entry.aliases,
    });
    keyPointsBySystem.set(entry.systemEventId, event.keyPoints);
  }

  const rejectTuning = (systemId: string | null, where: string): void => {
    if (systemId !== null && tuningSystemIds.has(systemId)) {
      throw new IntegrityError(`N3 装配：${where} 引用的是调参分区事件 ${systemId}，终判卷只准封存事件`);
    }
  };

  for (const item of l0Items) {
    rejectTuning(item.eventId, 'gold-l0');
    for (const neighbor of item.discriminatorNeighborEventIds) rejectTuning(neighbor, 'gold-l0 近邻');
    assertP6GoldItem(item, guardCards.get(item.eventId), keyPointsBySystem.get(item.eventId) ?? []);
  }
  for (const item of files.decoy.items) {
    rejectTuning(item.goldCardId, 'decoy 金标');
    for (const cardId of item.pairCardIds) {
      if (tuningSystemIds.has(cardId)) {
        throw new IntegrityError(`N3 装配：decoy 配对卡 ${cardId} 属调参分区，终判卷只准封存事件`);
      }
    }
  }
  for (const item of files.clarify.items) {
    for (const cardId of item.pairCardIds) {
      if (tuningSystemIds.has(cardId)) {
        throw new IntegrityError(`N3 装配：clarify 配对卡 ${cardId} 属调参分区，终判卷只准封存事件`);
      }
    }
  }
  for (const item of files.abstain.items) {
    rejectTuning(item.goldCardId, 'abstain noise 金标');
  }
  // 封存侧必须非空，否则「调参/封存」判定形同虚设。
  if (sealedSystemIds.size === 0) {
    throw new IntegrityError('N3 装配：蓝本封存分区为空，拒绝装配');
  }
}

/** 落盘六件套到全新空目录（已存在且非空即拒，杜绝新旧夹具混杂）。 */
export function writeAssembledFixturesV2(outDir: string, files: AssembledFixturesV2): void {
  ensureFreshDir(outDir, '--out');
  const docs: Array<[string, unknown]> = [
    ['gold-l0.json', files.goldL0],
    ['gold-l1.json', files.goldL1],
    ['holdout.json', files.holdout],
    ['decoy.json', files.decoy],
    ['clarify.json', files.clarify],
    ['abstain.json', files.abstain],
  ];
  for (const [name, doc] of docs) {
    writeFileAtomic(path.join(outDir, name), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

interface CliArgs {
  authored: string | undefined;
  worldRoot: string | undefined;
  out: string | undefined;
  sealDir: string | undefined;
  sealedBy: string | undefined;
  sealedAtMs: number | undefined;
  tarball: string | undefined;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    authored: undefined,
    worldRoot: undefined,
    out: undefined,
    sealDir: undefined,
    sealedBy: undefined,
    sealedAtMs: undefined,
    tarball: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`参数 ${flag} 缺少取值`);
    i += 1;
    if (flag === '--authored') args.authored = value;
    else if (flag === '--world-root') args.worldRoot = value;
    else if (flag === '--out') args.out = value;
    else if (flag === '--seal-dir') args.sealDir = value;
    else if (flag === '--sealed-by') args.sealedBy = value;
    else if (flag === '--sealed-at-ms') args.sealedAtMs = Number(value);
    else if (flag === '--tarball') args.tarball = value;
    else throw new Error(`未知参数 ${flag}`);
  }
  return args;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.authored || !args.worldRoot || !args.out) {
    process.stderr.write(
      '用法：assemble-sealed-fixtures-v2.ts --authored <出题成品 sealed 目录> --world-root <v2 合成根> --out <装配输出目录>\n' +
        '      [--seal-dir <封存目录> --sealed-by <操作人> --sealed-at-ms <epoch毫秒>] [--tarball <tar.gz 路径>]\n',
    );
    process.exitCode = 2;
    return;
  }
  if (args.sealDir !== undefined && (!args.sealedBy || args.sealedAtMs === undefined)) {
    throw new Error('封存必须同时提供 --sealed-by 与 --sealed-at-ms（不读墙钟、身份不留空）');
  }
  if (args.sealedAtMs !== undefined && !Number.isInteger(args.sealedAtMs)) {
    throw new Error('--sealed-at-ms 须为整数毫秒');
  }

  const authored: AuthoredInputV2 = {
    gold: readJson(path.join(args.authored, 'gold-l0.json')),
    decoy: readJson(path.join(args.authored, 'decoy-authored.json')),
    clarify: readJson(path.join(args.authored, 'clarify-authored.json')),
    abstain: readJson(path.join(args.authored, 'abstain-authored.json')),
  };
  if (authored.gold.probeSetVersion !== PROBES_V2_VERSION) {
    throw new IntegrityError(
      `N3 装配：输入卷版本 ${authored.gold.probeSetVersion} 非 ${PROBES_V2_VERSION}（v1 卷请走 assemble-sealed-fixtures.ts）`,
    );
  }

  const plan = buildWorldV2();
  const idMap = buildSynthIdMap(path.resolve(args.worldRoot));
  const files = assembleSealedFixturesV2(authored, idMap);
  assertAssembledGuardsV2(files, idMap, plan);
  assertLayerQuotasV2(files);

  const outDir = path.resolve(args.out);
  writeAssembledFixturesV2(outDir, files);
  process.stdout.write(
    `装配完成并通过全部守卫：${outDir}（六件套，l0=${files.goldL0.items.length}、` +
      `decoy=${files.decoy.items.length}、clarify=${files.clarify.items.length}、abstain=${files.abstain.items.length}）\n`,
  );

  if (args.sealDir !== undefined) {
    const manifest = sealFixtures({
      sourceDir: outDir,
      sealDir: path.resolve(args.sealDir),
      probeSetVersion: authored.gold.probeSetVersion,
      rulesVersion: CURRENT_RULES_VERSION,
      rngSeed: DEFAULT_RNG_SEED,
      sealedAtMs: args.sealedAtMs!,
      sealedBy: args.sealedBy!,
      layerQuotas: SEAL_LAYER_QUOTAS_V2,
      decoyPairCount: files.decoy.items.length,
    });
    const verification = verifySeal(path.resolve(args.sealDir));
    if (!verification.ok) {
      throw new IntegrityError(`封存后自检失败：${verification.errors.join('；')}`);
    }
    process.stdout.write(`已封存：${path.resolve(args.sealDir)}（${manifest.files.length} 个夹具，G6 自检通过）\n`);

    if (args.tarball !== undefined) {
      const sealDir = path.resolve(args.sealDir);
      const tarball = path.resolve(args.tarball);
      ensureDir(path.dirname(tarball));
      const result = spawnSync('tar', ['-czf', tarball, '-C', path.dirname(sealDir), path.basename(sealDir)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      if (result.status !== 0) {
        throw new Error(`tarball 打包失败：${result.stderr.toString()}`);
      }
      const digest = sha256Hex(fs.readFileSync(tarball));
      process.stdout.write(`tarball：${tarball}（sha256=${digest}）\n`);
    }
  } else {
    process.stdout.write('未提供 --seal-dir，仅装配不封存（不产生任何封存读取/解封记录）。\n');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
