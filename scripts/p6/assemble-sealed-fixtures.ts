/**
 * P6 D 批 D3 · 封存夹具装配机（v4 §8/§9 序9，G3/G4/G6）。
 *
 * 把独立出题人交付的「合成事件 id 中间格式」装配成审计加载器可直接消费的最终夹具：
 *  - gold-l0：eventId 与 discriminatorNeighborEventIds 机械翻译为合成根系统事件 ULID；
 *  - decoy：pairEventIds/goldEventId 翻译为 mem_card.card_id；
 *  - abstain：noise 的 goldEventId 翻译为 card_id，unanswerable 保持 null；
 *  - gold-l1/holdout 为空 companion（本路线无 L1/L2 人工标注）。
 *
 * 纪律：
 *  - 纯函数 assemble/assert 不做文件 IO，红测可直接调用；CLI 只负责读参、落盘与封存；
 *  - 装配后强制走真实加载器形状校验与 G3 零别名、G4 逐条守卫，任一不过即抛错、不产出封存目录；
 *  - 封存目录、操作人、封存时刻全部由 CLI 参数注入，本文件不出现任何硬编码绝对路径、不读墙钟；
 *  - 不触碰生产门档、不判 PASSED/NOT-PASSED、不写解封日志。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { DatabaseSync } from 'node:sqlite';

import { IntegrityError } from '../../src/core/errors.ts';
import { ensureDir, writeFileAtomic } from '../../src/core/fsx.ts';
import { sha256Hex } from '../../src/memory/content-hash.ts';
import { buildWorldPlan, WORLD_SEED } from '../../src/memory/audit/corpus/world-plan.ts';
import type { WorldPlan } from '../../src/memory/audit/corpus/world-plan.ts';
import { validateFixtureFile } from '../../src/memory/audit/fixtures.ts';
import type { GoldL0Item, DecoyItem, AbstainItem } from '../../src/memory/audit/fixtures.ts';
import { assertAZeroAliases, assertP6GoldItem } from '../../src/memory/audit/fixture-guard.ts';
import type { GuardCardRef } from '../../src/memory/audit/fixture-guard.ts';
import { sealFixtures, verifySeal } from '../../src/memory/audit/sealing.ts';
import { ensureFreshDir } from './build-synthetic-world.ts';
import { CURRENT_RULES_VERSION } from '../../src/memory/types.ts';
import { DEFAULT_RNG_SEED } from '../../src/memory/audit/metrics.ts';

/** v4 §4.2 封存终判集五层配额（seal-manifest 声明值，题数真值以哈希夹具为准）。 */
export const SEAL_LAYER_QUOTAS: Readonly<Record<string, number>> = Object.freeze({
  S0: 100,
  S1: 100,
  S2: 50,
  S3: 50,
  S4: 50,
});

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
  constructionLayer?: 'S0' | 'S1' | 'S2' | 'S3' | 'S4';
  sourceLocation?: { source: 'raw-turn' | 'summary'; anchor: string };
  highRiskLabel?: 'strong' | 'promise' | 'date' | 'verbatim' | 'negation';
  sourceCharShare?: number;
  arbitration?: { adjudicator: string; decision: string };
}

interface AuthoredGoldDoc {
  probeSetVersion: string;
  layer: 'l0';
  items: readonly AuthoredL0Item[];
}

interface AuthoredDecoyDoc {
  probeSetVersion: string;
  layer: 'decoy';
  items: ReadonlyArray<{
    pairEventIds: readonly string[];
    goldEventId: string;
    discriminatorQuery: string;
    highRiskLabel?: 'strong' | 'promise' | 'date' | 'verbatim' | 'negation';
  }>;
}

interface AuthoredAbstainDoc {
  probeSetVersion: string;
  layer: 'abstain';
  items: ReadonlyArray<{
    query: string;
    goldEventId: string | null;
    kind: 'unanswerable' | 'noise';
  }>;
}

export interface AuthoredInput {
  readonly gold: AuthoredGoldDoc;
  readonly decoy: AuthoredDecoyDoc;
  readonly abstain: AuthoredAbstainDoc;
}

export interface AssembledFixtures {
  readonly goldL0: { probeSetVersion: string; layer: 'l0'; items: GoldL0Item[] };
  readonly goldL1: { probeSetVersion: string; layer: 'l1'; items: [] };
  readonly holdout: { probeSetVersion: string; layer: 'l2'; items: [] };
  readonly decoy: { probeSetVersion: string; layer: 'decoy'; items: DecoyItem[] };
  readonly abstain: { probeSetVersion: string; layer: 'abstain'; items: AbstainItem[] };
}

/**
 * 从合成根投影库读取 syn 事件 id → 系统事件 ULID/cardId 的 1:1 桥接表。
 * 桥接键为 mem_card.discriminator（D1 建卡时写入 `disc-<synId>`），重复或非 active 即拒。
 */
export function buildSynthIdMap(worldRoot: string): Map<string, SynthIdEntry> {
  const dbPath = path.join(worldRoot, 'projection', 'memory-index', 'memory-index.sqlite');
  if (!fs.existsSync(dbPath)) {
    throw new IntegrityError(`D3 装配：合成根投影库不存在：${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare('select card_id, event_id, discriminator, display_cues_json, aliases_json, status from mem_card')
      .all() as Array<{
        card_id: string;
        event_id: string;
        discriminator: string;
        display_cues_json: string;
        aliases_json: string;
        status: string;
      }>;
    const map = new Map<string, SynthIdEntry>();
    for (const row of rows) {
      if (row.status !== 'active') {
        throw new IntegrityError(`D3 装配：卡片 ${row.card_id} 状态非 active（${row.status}），拒绝映射`);
      }
      const prefix = 'disc-';
      if (!row.discriminator.startsWith(prefix)) {
        throw new IntegrityError(`D3 装配：卡片 ${row.card_id} discriminator 非合成桥接键：${row.discriminator}`);
      }
      const synId = row.discriminator.slice(prefix.length);
      if (map.has(synId)) {
        throw new IntegrityError(`D3 装配：合成 id ${synId} 映射不唯一`);
      }
      map.set(synId, {
        synId,
        systemEventId: row.event_id,
        cardId: row.card_id,
        cues: JSON.parse(row.display_cues_json) as string[],
        aliases: JSON.parse(row.aliases_json) as GuardCardRef['aliases'],
      });
    }
    return map;
  } finally {
    db.close();
  }
}

function requireEntry(idMap: ReadonlyMap<string, SynthIdEntry>, synId: string, where: string): SynthIdEntry {
  const entry = idMap.get(synId);
  if (entry === undefined) {
    throw new IntegrityError(`D3 装配：${where} 的合成事件 id「${synId}」在合成根找不到对应卡片（悬空引用，拒绝装配）`);
  }
  return entry;
}

/** 纯装配：不读文件系统、不触库，只做形状不变的机械翻译。 */
export function assembleSealedFixtures(authored: AuthoredInput, idMap: ReadonlyMap<string, SynthIdEntry>): AssembledFixtures {
  const version = authored.gold.probeSetVersion;

  const goldItems = authored.gold.items.map((item) => ({
    ...item,
    eventId: requireEntry(idMap, item.eventId, 'gold-l0').systemEventId,
    discriminatorNeighborEventIds: item.discriminatorNeighborEventIds.map((synId) =>
      requireEntry(idMap, synId, 'gold-l0 近邻').systemEventId,
    ),
  }));

  const decoyItems: DecoyItem[] = authored.decoy.items.map((item) => {
    const pairCardIds = item.pairEventIds.map((synId) => requireEntry(idMap, synId, 'decoy 配对').cardId);
    const goldCardId = requireEntry(idMap, item.goldEventId, 'decoy 金标').cardId;
    return item.highRiskLabel === undefined
      ? { pairCardIds, discriminatorQuery: item.discriminatorQuery, goldCardId }
      : { pairCardIds, discriminatorQuery: item.discriminatorQuery, goldCardId, highRiskLabel: item.highRiskLabel };
  });

  const abstainItems = authored.abstain.items.map((item) => {
    if (item.kind === 'unanswerable') {
      if (item.goldEventId !== null) {
        throw new IntegrityError(`D3 装配：unanswerable 探针「${item.query}」goldEventId 必须为 null`);
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
    abstain: { probeSetVersion: version, layer: 'abstain', items: abstainItems },
  };
}

/**
 * 真实守卫：加载器字段白名单/枚举 → G3 零别名 → G4①/G4②/G4③ 逐条。
 * key_points 取自确定性蓝本（与 D1 建根摄入同源），按系统事件 ULID 对位。
 */
export function assertAssembledGuards(
  files: AssembledFixtures,
  idMap: ReadonlyMap<string, SynthIdEntry>,
  plan: WorldPlan = buildWorldPlan(WORLD_SEED),
): void {
  validateFixtureFile(files.goldL0, 'l0', 'gold-l0.json');
  validateFixtureFile(files.goldL1, 'l1', 'gold-l1.json');
  validateFixtureFile(files.holdout, 'l2', 'holdout.json');
  validateFixtureFile(files.decoy, 'decoy', 'decoy.json');
  validateFixtureFile(files.abstain, 'abstain', 'abstain.json');

  const l0Items = files.goldL0.items as Parameters<typeof assertAZeroAliases>[0];
  assertAZeroAliases(l0Items);

  const guardCards = new Map<string, GuardCardRef>();
  const keyPointsBySystem = new Map<string, readonly string[]>();
  for (const event of plan.events) {
    const entry = idMap.get(event.eventId);
    if (entry === undefined) {
      throw new IntegrityError(`D3 装配：蓝本事件 ${event.eventId} 在合成根缺卡，世界与夹具不同源`);
    }
    guardCards.set(entry.systemEventId, {
      eventId: entry.systemEventId,
      cues: entry.cues,
      aliases: entry.aliases,
    });
    keyPointsBySystem.set(entry.systemEventId, event.keyPoints);
  }

  for (const item of l0Items) {
    assertP6GoldItem(item, guardCards.get(item.eventId), keyPointsBySystem.get(item.eventId) ?? []);
  }
}

/** 落盘五件套到全新空目录（已存在且非空即拒，杜绝新旧夹具混杂）。 */
export function writeAssembledFixtures(outDir: string, files: AssembledFixtures): void {
  ensureFreshDir(outDir, '--out');
  const docs: Array<[string, unknown]> = [
    ['gold-l0.json', files.goldL0],
    ['gold-l1.json', files.goldL1],
    ['holdout.json', files.holdout],
    ['decoy.json', files.decoy],
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
  seed: number | undefined;
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
    seed: undefined,
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
    else if (flag === '--seed') args.seed = Number(value);
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
      '用法：assemble-sealed-fixtures.ts --authored <出题成品 sealed 目录> --world-root <合成根> --out <装配输出目录>\n' +
        '      [--seal-dir <封存目录> --sealed-by <操作人> --sealed-at-ms <epoch毫秒>] [--tarball <tar.gz 路径>] [--seed n]\n',
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

  const authored: AuthoredInput = {
    gold: readJson(path.join(args.authored, 'gold-l0.json')),
    decoy: readJson(path.join(args.authored, 'decoy-authored.json')),
    abstain: readJson(path.join(args.authored, 'abstain-authored.json')),
  };
  const plan = buildWorldPlan(args.seed ?? WORLD_SEED);
  const idMap = buildSynthIdMap(path.resolve(args.worldRoot));
  const files = assembleSealedFixtures(authored, idMap);
  assertAssembledGuards(files, idMap, plan);

  const outDir = path.resolve(args.out);
  writeAssembledFixtures(outDir, files);
  process.stdout.write(`装配完成并通过全部守卫：${outDir}（五件套，l0=${files.goldL0.items.length}）\n`);

  if (args.sealDir !== undefined) {
    const manifest = sealFixtures({
      sourceDir: outDir,
      sealDir: path.resolve(args.sealDir),
      probeSetVersion: authored.gold.probeSetVersion,
      rulesVersion: CURRENT_RULES_VERSION,
      rngSeed: DEFAULT_RNG_SEED,
      sealedAtMs: args.sealedAtMs!,
      sealedBy: args.sealedBy!,
      layerQuotas: SEAL_LAYER_QUOTAS,
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
      const result = spawnSync(
        'tar',
        ['-czf', tarball, '-C', path.dirname(sealDir), path.basename(sealDir)],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
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
