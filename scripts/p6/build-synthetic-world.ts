/**
 * P6 D 批 D1 · 合成世界生成脚本（v4 §9 序8/§10，C5 合成根路径）。
 *
 * 用法：
 *   npx tsx scripts/p6/build-synthetic-world.ts --out <合成数据根> --blind-out <盲包目录> [--seed n]
 *
 * 纪律：
 *  - 只写 --out/--blind-out 指定的新目录（已存在且非空即拒，防覆盖污染）；不碰任何真实根；
 *  - raw-turns 经 Fasti.ingestRawTurn 真摄入，事件闭合同 append-only JSONL（merged 留痕），
 *    卡由 key_points 经 deriveCuesFromKeyPoints 真派生、决策行盖 rules-v2（G7 离线口径，生产面零 flag）；
 *  - 全程确定性：时间戳取自世界蓝本，validMs/参照时刻固定，不读墙钟、无随机。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Fasti } from '../../src/api/index.ts';
import { dshChannelDescriptor } from '../../src/adapters/dsh/channel-descriptor.ts';
import { initiationOf } from '../../src/adapters/dsh/initiation.ts';
import type { EventRecord } from '../../src/contract/event.ts';
import { appendJsonl } from '../../src/core/jsonl.ts';
import { shardKeyOf } from '../../src/core/time.ts';
import { ulid } from '../../src/core/ulid.ts';
import { ensureDir, writeFileAtomic } from '../../src/core/fsx.ts';
import { layoutOf } from '../../src/source/paths.ts';
import {
  computeContentHash,
  computeRowHashSum,
  computeTruthFingerprint,
  deriveCardId,
  normalizeDisplayCues,
} from '../../src/memory/builder.ts';
import { deriveCuesFromKeyPoints } from '../../src/memory/cue-derive.ts';
import { openMemoryWrite } from '../../src/memory/store.ts';
import type { AliasRow, DecisionRecord, MemoryCard, RevisionRecord } from '../../src/memory/types.ts';
import { buildWorldPlan, WORLD_REFERENCE_NOW_MS } from '../../src/memory/audit/corpus/world-plan.ts';
import { SEED_V2, buildWorldV2 } from '../../src/memory/audit/corpus/world-plan-v2.ts';
import { assertBlindPackageSafe, buildBlindPackage } from '../../src/memory/audit/corpus/blind-package.ts';
import {
  assertBlindPackageV2Shape,
  buildBlindPackageV2,
  buildWorldManifestV2,
} from '../../src/memory/audit/corpus/blind-package-v2.ts';

interface CliArgs {
  out: string | undefined;
  blindOut: string | undefined;
  seed: number | undefined;
  /** #179：'v1'（默认，100 事件，行为与改造前逐字节一致）| 'v2'（500 事件）。 */
  world: 'v1' | 'v2';
  /** 仅对 --out 生效：目录带合成根标记时允许清空重建（无标记一律拒绝，防误删真实根）。 */
  forceRebuild: boolean;
}

/** 无取值开关：解析时不吃下一个 token。 */
const BOOLEAN_FLAGS: readonly string[] = ['--force-rebuild'];

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { out: undefined, blindOut: undefined, seed: undefined, world: 'v1', forceRebuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (BOOLEAN_FLAGS.includes(flag)) {
      if (flag === '--force-rebuild') args.forceRebuild = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`参数 ${flag} 缺少取值`);
    }
    i += 1;
    if (flag === '--out') {
      args.out = path.resolve(value);
    } else if (flag === '--blind-out') {
      args.blindOut = path.resolve(value);
    } else if (flag === '--seed') {
      args.seed = Number(value);
    } else if (flag === '--world') {
      if (value !== 'v1' && value !== 'v2') throw new Error(`--world 只接受 v1|v2，收到 ${value}`);
      args.world = value;
    } else {
      throw new Error(`未知参数 ${flag}`);
    }
  }
  if (args.seed !== undefined && (!Number.isInteger(args.seed) || args.seed <= 0)) {
    throw new Error('--seed 须为正整数');
  }
  // v2 蓝本的 seed 冻结在预注册里（改 seed 即改蓝图、N1h 结论脱节），不允许覆盖。
  if (args.world === 'v2' && args.seed !== undefined && args.seed !== SEED_V2) {
    throw new Error(`--world v2 的 seed 已冻结为 ${SEED_V2}，不接受 --seed ${args.seed}`);
  }
  return args;
}

/**
 * 合成根标记文件名。建根成功后写入 --out 根；`--force-rebuild` 只肯清空带此标记的目录，
 * 从而「可重跑」与「绝不误删真实根」两者兼得（#179 缺口 8）。
 */
export const SYNTHETIC_ROOT_MARKER = '.fasti-synthetic-root.json';

function ensureFreshDir(dir: string, label: string, opts?: { readonly allowRebuild?: boolean }): void {
  if (!fs.existsSync(dir)) {
    ensureDir(dir);
    return;
  }
  if (fs.readdirSync(dir).length === 0) return;
  const markerPath = path.join(dir, SYNTHETIC_ROOT_MARKER);
  const marked = fs.existsSync(markerPath);
  if (opts?.allowRebuild === true && marked) {
    fs.rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    return;
  }
  throw new Error(
    `${label} 目录已存在且非空，拒绝覆盖：${dir}` +
      (marked ? '（检测到合成根标记，若确需重建请加 --force-rebuild）' : '（无合成根标记，绝不自动清空）'),
  );
}

/**
 * 两版蓝本的公共可见面：建根只吃这些字段，故 v1（100 事件）与 v2（500 事件）共用同一套
 * 摄入/闭合/建卡逻辑，互不引入对方类型（v2 多出的 `hasRef` 仅存于蓝本，不参与建根）。
 */
export interface BuildableTurn {
  readonly speaker: 'user';
  readonly offsetMinutes: number;
  readonly rawText: string;
}

export interface BuildableEvent {
  readonly eventId: string;
  readonly partition: 'sealed' | 'tuning';
  readonly startedAtMs: number;
  readonly endedMs: number;
  readonly keyPoints: readonly string[];
  readonly summary: string;
  readonly turns: readonly BuildableTurn[];
}

export interface BuildablePlan {
  readonly referenceNowMs: number;
  readonly events: readonly BuildableEvent[];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function ingestWorld(plan: BuildablePlan, outRoot: string): Promise<Map<string, string[]>> {
  const fasti = await Fasti.open({ dataRoot: outRoot });
  // 计划事件 id → 摄入产出的经历 id（保序）。
  const anchorsByEvent = new Map<string, string[]>();
  try {
    // 平台化步骤2：内核不再自动预置通道；本脚本构建的是 dsh 世界，摄入前显式登记 dsh。
    await fasti.registerChannel(dshChannelDescriptor('dsh'));
    for (const event of plan.events) {
      const anchorIds: string[] = [];
      for (let j = 0; j < event.turns.length; j += 1) {
        const turn = event.turns[j]!;
        const atMs = event.startedAtMs + turn.offsetMinutes * 60 * 1000;
        const experience = await fasti.ingestRawTurn('dsh', {
          event_id: `${event.eventId}:t${String(j + 1).padStart(2, '0')}`,
          session_id: event.eventId,
          speaker: turn.speaker,
          initiation: initiationOf(turn.speaker),
          raw_text: turn.rawText,
          asserted_at: iso(atMs),
          occurred_at: iso(atMs),
        });
        anchorIds.push(experience.id);
      }
      anchorsByEvent.set(event.eventId, anchorIds);
    }
    const openEvents = await fasti.queryEvents();
    return finalizeEvents(plan, anchorsByEvent, openEvents as EventRecord[], outRoot);
  } finally {
    await fasti.close();
  }
}

/**
 * 追加闭合版本：蓝本的跨事件间隔以天计（>切分器 30 分钟静默阈值），每个计划事件的全部话头
 * 已被实时切分器归入唯一一个系统事件。这里逐组断言该不变量，再给该系统事件追加一行
 * closed+ready 版本（挂蓝本 summary/key_points 与全组 anchors），不制造任何 merged 退役行。
 * 返回系统事件 id → 全组锚点。
 */
function finalizeEvents(
  plan: BuildablePlan,
  anchorsByEvent: Map<string, string[]>,
  openEvents: EventRecord[],
  outRoot: string,
): Map<string, string[]> {
  const byAnchor = new Map<string, EventRecord>();
  for (const event of openEvents) {
    for (const pointer of event.pointers) {
      byAnchor.set(pointer.id, event);
    }
  }
  const closedAnchors = new Map<string, string[]>();
  for (const planned of plan.events) {
    const anchorIds = [...new Set(anchorsByEvent.get(planned.eventId)!)].sort();
    const groupEvents = new Set(anchorIds.map((anchorId) => byAnchor.get(anchorId)!));
    if (groupEvents.size !== 1) {
      throw new Error(
        `计划事件 ${planned.eventId} 的 ${anchorIds.length} 条话头被切分器拆进了 ${groupEvents.size} 个系统事件，时间轴不变量被破坏`,
      );
    }
    const systemEvent = [...groupEvents][0]!;
    const assembledAt = iso(planned.startedAtMs);
    const readyRecord: EventRecord = {
      ...systemEvent,
      version: systemEvent.version + 1,
      status: 'closed',
      closed_reason: 'silence',
      time_range: { started_at: iso(planned.startedAtMs), ended_at: iso(planned.endedMs) },
      assembled_at: assembledAt,
      summary: planned.summary,
      key_points: [...planned.keyPoints],
      anchors: anchorIds,
      summary_quality: 'ready',
      created_at: assembledAt,
    };
    appendJsonl(path.join(layoutOf(outRoot).events, `${shardKeyOf(assembledAt)}.jsonl`), readyRecord);
    closedAnchors.set(systemEvent.id, anchorIds);
  }
  return closedAnchors;
}

/** G7：closed+ready 事件由 key_points 真派生建卡（rules-v2 离线盖章，零别名、零手写 cue）。 */
async function seedDerivedCards(plan: BuildablePlan, outRoot: string, closedAnchors: Map<string, string[]>): Promise<void> {
  const entries: Array<{ card: MemoryCard }> = [];
  let index = 0;
  for (const [survivorId, anchors] of closedAnchors) {
    const planned = plan.events[index]!;
    const anchorJson = JSON.stringify(anchors);
    const derivedCues = normalizeDisplayCues(
      deriveCuesFromKeyPoints({ keyPoints: planned.keyPoints, summary: planned.summary }).cues,
    );
    const displayCuesJson = JSON.stringify(derivedCues);
    const aliasesJson = JSON.stringify([]);
    const discriminator = `disc-${planned.eventId}`;
    const card: MemoryCard = {
      cardId: deriveCardId(survivorId, anchors),
      eventId: survivorId,
      anchorJson,
      channel: 'dsh',
      cardType: 'event',
      selection: 'selected',
      weight: 0,
      displayCuesJson,
      aliasesJson,
      discriminator,
      entityHintJson: null,
      occurredMs: planned.startedAtMs,
      endedMs: planned.endedMs,
      validMs: plan.referenceNowMs - 24 * 60 * 60 * 1000,
      invalidMs: null,
      createdMs: plan.referenceNowMs - 24 * 60 * 60 * 1000,
      expiredMs: null,
      status: 'active',
      contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, discriminator),
      hitCount: 0,
      lastHitMs: null,
      schemaVersion: 1,
    };
    entries.push({ card });
    index += 1;
  }
  const indexDir = path.join(outRoot, 'projection', 'memory-index');
  const handle = openMemoryWrite({ indexDir });
  try {
    const cards = entries.map((entry) => entry.card);
    const aliases: AliasRow[] = [];
    const atMs = plan.referenceNowMs - 24 * 60 * 60 * 1000;
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: atMs,
      schema_version: 3,
      truth_fingerprint: computeTruthFingerprint(outRoot).aggregate,
      prior_revision: null,
      card_count: cards.length,
      alias_count: 0,
      row_hash_sum: computeRowHashSum(cards),
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'P6 D1 synthetic world seed',
      operator: 'offline-cli',
    };
    const decisions: DecisionRecord[] = cards.map((card) => ({
      decision_id: ulid(),
      at_ms: atMs,
      action: 'create-card',
      card_id: card.cardId,
      event_id: card.eventId,
      anchor_json: card.anchorJson,
      content_hash: card.contentHash,
      // G7：合成根由离线构造方显式按 rules-v2 真派生；生产调用面永远不传该版本。
      model_tag: 'rules-v2',
      reason: 'fixture: P6 D1 synthetic',
      created_by: 'her',
    }));
    handle.transactionApply({ cards, aliases }, revision, decisions);
  } finally {
    await handle.close();
  }
}

/** 建根成功后才落标记：让 `--force-rebuild` 的授权范围严格限于「已成功建成的合成根」。 */
function writeRootMarker(outRoot: string, schema: string, seed: number, world: 'v1' | 'v2'): void {
  writeFileAtomic(
    path.join(outRoot, SYNTHETIC_ROOT_MARKER),
    `${JSON.stringify({ schema, seed, world, note: '本目录由 build-synthetic-world.ts 生成，可安全删除或 --force-rebuild 重建' }, null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out || !args.blindOut) {
    process.stderr.write('用法：build-synthetic-world.ts --out <数据根> --blind-out <盲包目录> [--seed n]\n');
    process.exitCode = 2;
    return;
  }
  const outRoot = args.out;
  const blindRoot = args.blindOut;
  ensureFreshDir(outRoot, '--out', { allowRebuild: args.forceRebuild });
  ensureFreshDir(blindRoot, '--blind-out');

  if (args.world === 'v2') {
    const plan = buildWorldV2();
    const closedAnchors = await ingestWorld(plan, outRoot);
    await seedDerivedCards(plan, outRoot, closedAnchors);
    writeRootMarker(outRoot, plan.schema, plan.seed, 'v2');

    const manifest = buildWorldManifestV2(plan);
    const blind = buildBlindPackageV2(plan);
    // 双道门：先用白名单投影（答案侧字段物理不存在），再跑递归违禁键扫描（防未来改投影时手滑）。
    assertBlindPackageSafe(blind);
    const shapeErrors = assertBlindPackageV2Shape(blind, manifest);
    if (shapeErrors.length > 0) {
      throw new Error(`v2 盲包/清单契约不自洽：\n${shapeErrors.join('\n')}`);
    }
    writeFileAtomic(path.join(blindRoot, 'blind-package.json'), `${JSON.stringify(blind, null, 2)}\n`);
    writeFileAtomic(path.join(blindRoot, 'world-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `合成世界 v2 已生成：${manifest.totalEvents} 事件（封存 ${manifest.sealedEvents}／调参 ${manifest.tuningEvents}）、` +
        `${manifest.totalEvents} 张真派生卡、复用词 ${manifest.reusedDetailWords.length} 个、高危盘点 ${manifest.highRiskInventory.length} 条\n`,
    );
    return;
  }

  const plan = buildWorldPlan(args.seed);
  const closedAnchors = await ingestWorld(plan, outRoot);
  await seedDerivedCards(plan, outRoot, closedAnchors);
  writeRootMarker(outRoot, plan.schema, plan.seed, 'v1');

  const blind = buildBlindPackage(plan);
  assertBlindPackageSafe(blind);
  writeFileAtomic(path.join(blindRoot, 'blind-package.json'), `${JSON.stringify(blind, null, 2)}\n`);
  const manifest = {
    schema: plan.schema,
    seed: plan.seed,
    referenceNowMs: plan.referenceNowMs,
    totalEvents: plan.events.length,
    sealedEvents: plan.events.filter((event) => event.partition === 'sealed').length,
    tuningEvents: plan.events.filter((event) => event.partition === 'tuning').length,
    highRiskInventory: plan.events.flatMap((event) =>
      event.highRiskLabels.map((label) => ({ eventId: event.eventId, label })),
    ),
  };
  writeFileAtomic(path.join(blindRoot, 'world-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`合成世界已生成：${manifest.totalEvents} 事件（封存 ${manifest.sealedEvents}／调参 ${manifest.tuningEvents}）、${manifest.totalEvents} 张真派生卡\n`);
}

// 当前文件经 tsx 直接执行时才运行（被测试 import 时不触发）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}

export { buildWorldPlan, ingestWorld, seedDerivedCards, ensureFreshDir, parseArgs, writeRootMarker, WORLD_REFERENCE_NOW_MS };
