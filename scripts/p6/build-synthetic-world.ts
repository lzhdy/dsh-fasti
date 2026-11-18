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
import type { WorldPlan } from '../../src/memory/audit/corpus/world-plan.ts';
import { assertBlindPackageSafe, buildBlindPackage } from '../../src/memory/audit/corpus/blind-package.ts';

interface CliArgs {
  out: string | undefined;
  blindOut: string | undefined;
  seed: number | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { out: undefined, blindOut: undefined, seed: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`参数 ${flag} 缺少取值`);
    }
    i += 1;
    if (flag === '--out') {
      args.out = value;
    } else if (flag === '--blind-out') {
      args.blindOut = value;
    } else if (flag === '--seed') {
      args.seed = Number(value);
    } else {
      throw new Error(`未知参数 ${flag}`);
    }
  }
  if (args.seed !== undefined && (!Number.isInteger(args.seed) || args.seed <= 0)) {
    throw new Error('--seed 须为正整数');
  }
  return args;
}

function ensureFreshDir(dir: string, label: string): void {
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      throw new Error(`${label} 目录已存在且非空，拒绝覆盖：${dir}`);
    }
  } else {
    ensureDir(dir);
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function ingestWorld(plan: WorldPlan, outRoot: string): Promise<Map<string, string[]>> {
  const fasti = await Fasti.open({ dataRoot: outRoot });
  // 计划事件 id → 摄入产出的经历 id（保序）。
  const anchorsByEvent = new Map<string, string[]>();
  try {
    for (const event of plan.events) {
      const anchorIds: string[] = [];
      for (let j = 0; j < event.turns.length; j += 1) {
        const turn = event.turns[j]!;
        const atMs = event.startedAtMs + turn.offsetMinutes * 60 * 1000;
        const experience = await fasti.ingestRawTurn('dsh', {
          event_id: `${event.eventId}:t${String(j + 1).padStart(2, '0')}`,
          session_id: event.eventId,
          speaker: turn.speaker,
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
  plan: WorldPlan,
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
async function seedDerivedCards(plan: WorldPlan, outRoot: string, closedAnchors: Map<string, string[]>): Promise<void> {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out || !args.blindOut) {
    process.stderr.write('用法：build-synthetic-world.ts --out <数据根> --blind-out <盲包目录> [--seed n]\n');
    process.exitCode = 2;
    return;
  }
  ensureFreshDir(path.resolve(args.out), '--out');
  ensureFreshDir(path.resolve(args.blindOut), '--blind-out');
  const plan = buildWorldPlan(args.seed);
  const closedAnchors = await ingestWorld(plan, path.resolve(args.out));
  await seedDerivedCards(plan, path.resolve(args.out), closedAnchors);

  const blind = buildBlindPackage(plan);
  assertBlindPackageSafe(blind);
  writeFileAtomic(path.join(path.resolve(args.blindOut), 'blind-package.json'), `${JSON.stringify(blind, null, 2)}\n`);
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
  writeFileAtomic(path.join(path.resolve(args.blindOut), 'world-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`合成世界已生成：${manifest.totalEvents} 事件（封存 ${manifest.sealedEvents}／调参 ${manifest.tuningEvents}）、${manifest.totalEvents} 张真派生卡\n`);
}

// 当前文件经 tsx 直接执行时才运行（被测试 import 时不触发）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}

export { buildWorldPlan, ingestWorld, seedDerivedCards, ensureFreshDir, WORLD_REFERENCE_NOW_MS };
