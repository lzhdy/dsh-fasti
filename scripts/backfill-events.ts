/**
 * 阶段 5 历史回填脚本 —— 把没有事件覆盖的历史记录补切成事件段（任务卡 T18）。
 *
 * 依据：docs/b-block-event-layer-design.md §7.4「允许补齐，不允许重建」与 §16.2、
 *      docs/stage5-b-block-event-layer-task.md 阶段 6 T18、
 *      docs/stage5-bblock-tech-baseline.md §5.3（必须复用切分器判定逻辑，不另写一套）。
 *
 * 四条不可违背的属性：
 *  1. **只补齐，不重建** —— 已被事件覆盖的记录一律跳过；既有事件的边界与版本**一个字节都不碰**
 *     （既有分片文件在回填前后必须保持前缀关系，回填自证会校验这一点）。
 *  2. **默认试运行** —— 不传 `--apply` 只报告将要发生什么，**不写任何东西**
 *     （切分在系统临时目录的沙箱事件日志里跑，沙箱用完即删）。
 *  3. **记录本只读** —— `experiences/` 只读取，绝不写入、绝不删除、绝不批量重建；
 *     回填只在**事件层**补齐缺失的事件段（与「孤儿补切只告警不自动补切」同一条纪律）。
 *  4. **复用切分器** —— 事件怎么切由 `EventSegmenter` 决定，本脚本不另写一套切分逻辑。
 *
 * 运行（Node ≥ 22，类型剥离直跑，无需构建）：
 *   node scripts/backfill-events.ts --data-root <临时根>              # 试运行（默认）
 *   node scripts/backfill-events.ts --data-root <临时根> --apply      # 真写
 *   node scripts/backfill-events.ts --data-root <临时根> --json       # 机器可读报告
 *   node scripts/backfill-events.ts --data-root <临时根> --backfill-counts  # 附带历史计数补齐
 *
 * v1.4（C11）：
 *  - 两个上限（7000 / 50000）只作用于**新切出**的事件 —— 既有事件不重切、不重算；
 *  - 报告增补两计数器预演值与各 `closed_reason` 命中统计；
 *  - 历史 `char_count` / 两计数器 / action / outcome 的离线补齐是**显式可选**能力
 *    （`--backfill-counts`），**默认关闭**；开启后只喂给沙箱里的切分器，真源一个字节都不改；
 *  - 默认仍是试运行；**是否对真实根执行 `--apply` 由用户另行批准**（实现方不得自行执行）。
 *
 * 关于「初始很碎」（定案稿 §16.2）：
 *   历史记录按「静默 ≥30 分钟即闭合」切分，跨天的相邻记录必然各自成段 → 单条事件与孤立记录很多。
 *   **这是设计使然，不是 bug** —— 比起一开始就硬凑出错误的大事件，
 *   先忠实切分、再逐步归并更符合「诚实优先、宁缺勿凑」。本脚本的输出会如实报出这些数字。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { EventSegmenter, ORPHAN_MARK_KIND, isPendingMergeOf } from '../src/event/segmenter.ts';
import { typeToolTurn } from '../src/event/tool-typing.ts';
import { resolveEventParams } from '../src/event/params.ts';
import type { EventParams } from '../src/event/params.ts';
import { EventLog } from '../src/source/event-log.ts';
import { ExperienceLog } from '../src/source/experience-log.ts';
import { RawLog } from '../src/source/raw-log.ts';
import { layoutOf, resolveDataRoot } from '../src/source/paths.ts';
import { msToIso } from '../src/core/time.ts';
import type { Experience, Outcome } from '../src/contract/experience.ts';

// ── 参数 ──────────────────────────────────────────────────────────────────

export interface BackfillOptions {
  /** 数据根（缺省走 resolveDataRoot：显式配置 > $DSH_HOME/fasti > ~/.dsh/fasti）。 */
  dataRoot?: string | undefined;
  /** 是否真写。缺省 = false = 试运行（只报告，不写任何东西）。 */
  apply?: boolean | undefined;
  /** 事件层参数覆盖（缺省用默认参数）。 */
  params?: Partial<EventParams> | undefined;
  /**
   * 历史 `char_count` / 两计数器 / action / outcome 的离线补齐（v1.4 · C11）。
   *
   * **默认关闭**（显式可选能力 —— 定案稿 §16.1 的加法窗口只允许「新事件用新阈值」，
   * 历史补齐是**另一件事**，必须由人显式打开）。
   *
   * 开启后：读原文层按 `observation.text.id` 取回 raw_text → 算 `char_count`
   * （全量码点）→ 按载荷形状补 action/outcome → 供沙箱切分时累计两个计数器。
   *
   * **不改真源**：只影响沙箱里的切分输入；历史经历本身**不回写**
   * （真源 append-only，且「不在线回算历史计数」是纪律）。
   */
  backfillCounts?: boolean | undefined;
}

/** 补切出来的一段事件（报告用）。 */
export interface BackfillSegment {
  /** 事件 id。 */
  id: string;
  /** 事件所属通道。 */
  channel: string;
  /** 事件时间范围（世界轴）。 */
  started_at: string;
  ended_at: string;
  /** 覆盖的记录数。 */
  records: number;
  /** 闭合原因（null = 未被 A 类机械信号闭合）。 */
  closed_reason: string | null;
  /** 是否单记录事件（「初始很碎」的量化）。 */
  single_record: boolean;
  /** 是否待归并（单记录 + 静默闭合 → 7 天后会被标「孤立记录」）。 */
  pending_merge: boolean;
  /**
   * 有效对话字数预演值（v1.4 · C11）—— 该段累计的非工具轮字符数。
   *
   * `null` = 未统计（历史记录没有 `char_count`，且未开启补齐）。
   */
  effective_chars: number | null;
  /**
   * 原文全量字符预演值（v1.4 · C11）—— 该段累计的全量字符数（含工具 JSON）。
   *
   * `null` = 未统计（同上）。
   */
  raw_chars: number | null;
}

/** 回填报告 —— 诚实优先：数字都来自真源实测，不估算、不美化。 */
export interface BackfillReport {
  mode: 'dry-run' | 'apply';
  data_root: string;
  scanned: {
    /** 记录本条数。 */
    experiences: number;
    /** 已被事件覆盖的记录数 → 跳过（不碰既有事件）。 */
    covered: number;
    /** 没有任何事件覆盖的记录数 → 本次补齐的对象。 */
    uncovered: number;
  };
  created: {
    /** 新建事件数（补了几段）。 */
    events: number;
    /** 新写入的事件版本行数。 */
    version_rows: number;
    /** 新事件覆盖的记录数。 */
    records: number;
    /** 按通道分布。 */
    by_channel: Record<string, number>;
    /** 单记录事件数 —— 「初始很碎」的量化。 */
    single_record_events: number;
    /** 待归并候选（单记录 + 静默闭合）—— 7 天观察窗到期即被标「孤立记录」。 */
    pending_merge: number;
    /** 已带「孤立记录」标注的事件数（回填刚做完通常是 0，观察窗从 assembled_at 起算）。 */
    orphan_marked: number;
  };
  existing: {
    /** 回填前既有事件数（当前态）。 */
    events: number;
    /** 回填前既有版本行数。 */
    version_rows: number;
    /** 既有事件是否字节级未变（既有分片文件在回填后仍以回填前的文本为前缀）。 */
    untouched: boolean;
  };
  /**
   * 两个上限的预演统计（v1.4 · C11）。
   *
   * 只统计**新切出**的事件（既有事件不重切、不重算 —— 新阈值只作用于新事件）。
   * `max_*` 是命中数（真实数据应当为 0 —— 定案稿 §5.2 实测零误触发）。
   */
  caps: {
    /** 有效对话字数上限命中数（reason='max-dialogue-chars'）。 */
    max_dialogue_chars: number;
    /** 硬保险丝命中数（reason='max-chars'）。 */
    max_chars: number;
    /** 各段有效对话字数最大值（null = 全部未统计）。 */
    max_effective_chars: number | null;
    /** 各段 raw 全量字符最大值（null = 全部未统计）。 */
    max_raw_chars: number | null;
  };
  /**
   * 各 `closed_reason` 命中统计（v1.4 · C11）—— 新切出事件的闭合原因分布。
   *
   * key 为闭合原因，'open' 表示未被机械闭合；值是命中段数。
   */
  reason_stats: Record<string, number>;
  /** 逐段明细。 */
  segments: BackfillSegment[];
  warnings: string[];
}

// ── 存储实例 ──────────────────────────────────────────────────────────────

/**
 * 取得某目录的事件日志实例。
 *
 * 事件层是**单写者**：`EventLog.open(dir)` 是官方的显式复用出口
 * （同一目录已有活实例就返回它，没有才新建并登记）—— 本模块不再自己维护一张登记表。
 *
 * 复用后必须 `reindex()`：内存索引与 seq 计数是**实例内**缓存，
 * 上一轮写进去的行不会自动出现在索引里（见 src/source/event-log.ts 的索引漂移防线）。
 */
function eventLogOf(dir: string): EventLog {
  const log = EventLog.open(dir);
  log.reindex();
  return log;
}

/** 取得某目录的记录本日志实例（只读用）。 */
function experienceLogOf(dir: string): ExperienceLog {
  const cached = openedExperienceLogs.get(dir);
  if (cached !== undefined) {
    return cached;
  }
  const log = new ExperienceLog(dir);
  log.reindex();
  openedExperienceLogs.set(dir, log);
  return log;
}

/** 进程内已打开的记录本日志实例（按目录登记 —— 记录本只读，无需 dispose）。 */
const openedExperienceLogs = new Map<string, ExperienceLog>();

/** 分片文件的原始文本（回填前快照 —— 用于证明既有事件未被改写）。 */
function snapshotShards(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.jsonl')) {
      out.set(name, fs.readFileSync(path.join(dir, name), 'utf8'));
    }
  }
  return out;
}

/** 既有分片是否字节级未变（append-only ⇒ 回填后的文本必须以回填前的文本为前缀）。 */
function shardsUnchanged(before: Map<string, string>, after: Map<string, string>): boolean {
  for (const [name, text] of before) {
    const now = after.get(name);
    if (now === undefined || !now.startsWith(text)) {
      return false;
    }
  }
  return true;
}

// ── 核心：回填 ────────────────────────────────────────────────────────────

/**
 * 执行一次历史回填。
 *
 * @param options 数据根 / 是否真写 / 参数覆盖
 */
export function backfillEvents(options: BackfillOptions = {}): BackfillReport {
  const root = resolveDataRoot({ dataRoot: options.dataRoot });
  const layout = layoutOf(root);
  const apply = options.apply === true;
  const warnings: string[] = [];

  if (!fs.existsSync(layout.experiences)) {
    throw new Error(`数据根不存在或没有记录本目录：${layout.experiences}`);
  }

  // ── 1. 读记录本（只读）──
  const experienceLog = experienceLogOf(layout.experiences);
  const items = experienceLog.readAllWithLocations();

  // ── 2. 读事件真源（只读）→ 已覆盖集合 ──
  //
  // 「已覆盖」取**所有版本行**的指针并集，而不只是当前态：
  // 被改边界（revise）移出过的记录也算「被事件碰过」——
  // 再给它切一个新事件等于对已修正的事件说反话（§7.4「她修正过的事件必须原样保留」）。
  const eventLog = eventLogOf(layout.events);
  const existingRows = eventLog.readAllVersions();
  const covered = new Set<string>();
  for (const row of existingRows) {
    for (const pointer of row.pointers) {
      covered.add(pointer.id);
    }
  }

  const uncovered = items.filter((item) => !covered.has(item.experience.id));

  const report: BackfillReport = {
    mode: apply ? 'apply' : 'dry-run',
    data_root: root,
    scanned: {
      experiences: items.length,
      covered: items.length - uncovered.length,
      uncovered: uncovered.length,
    },
    created: {
      events: 0,
      version_rows: 0,
      records: 0,
      by_channel: {},
      single_record_events: 0,
      pending_merge: 0,
      orphan_marked: 0,
    },
    existing: {
      events: eventLog.count(),
      version_rows: existingRows.length,
      untouched: true,
    },
    caps: {
      max_dialogue_chars: 0,
      max_chars: 0,
      max_effective_chars: null,
      max_raw_chars: null,
    },
    reason_stats: {},
    segments: [],
    warnings,
  };

  if (uncovered.length === 0) {
    warnings.push('没有待补齐的记录 —— 全部记录都已被事件覆盖，无需回填。');
    return report;
  }

  // ── 3. 在沙箱里切分（复用切分器；沙箱在系统临时目录，与数据根无关）──
  //
  // 为什么先切沙箱再落真源：① 试运行模式必须零写入；② 先切完再整体落盘，
  // 真源里不会出现「切了一半」的半成品事件段。
  const shardBefore = snapshotShards(layout.events);
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-backfill-'));
  // 沙箱是一次性的临时目录（每次 mkdtemp 都是新目录，不撞单写者登记表）——
  // 用完必须 dispose()，否则 Windows 上文件句柄占着、临时目录删不掉。
  const sandbox = new EventLog(path.join(sandboxRoot, 'events'));
  try {
    const byId = new Map<string, Experience>();
    for (const item of items) {
      byId.set(item.experience.id, item.experience);
    }

    // 回填是一个**批次**：批次有明确终点，故 assembled_at / created_at 统一取回填时刻
    //（assembled_at 的口径是「被切成事件的时刻」—— 回填就是此刻切的，不是历史时刻）。
    const nowMs = Date.now();
    const nowText = msToIso(nowMs);

    const segmenter = new EventSegmenter({
      log: sandbox,
      readExperience: (id) => byId.get(id),
      params: resolveEventParams(options.params),
      now: () => nowMs,
    });

    // 按世界轴（occurred_at）排序喂入 —— 静默判据用的是世界轴，
    // 跨通道的历史记录也要按真实时间交错，场景切换才切得对（同刻按落点定序，结果确定）。
    const ordered = [...uncovered].sort((a, b) => {
      const ta = Date.parse(a.experience.occurred_at);
      const tb = Date.parse(b.experience.occurred_at);
      if (ta !== tb) {
        return ta - tb;
      }
      if (a.location.shard !== b.location.shard) {
        return a.location.shard < b.location.shard ? -1 : 1;
      }
      return a.location.seq - b.location.seq;
    });

    // v1.4 · C11：历史计数补齐（显式可选，默认关闭）。
    //
    // 开启时先把原文读进内存（event_id → raw_text），再逐条补 `char_count`
    // 与类型化产物 —— **只喂给沙箱里的切分器**，真源记录一个字都不改。
    const rawTexts =
      options.backfillCounts === true
        ? readRawTextsOf(root, [...new Set(uncovered.map((item) => item.experience.scene.channel))])
        : new Map<string, string>();

    for (const item of ordered) {
      const experience =
        options.backfillCounts === true
          ? backfillCountsOf(item.experience, rawTexts).experience
          : item.experience;
      segmenter.run({
        experience,
        location: item.location,
        channel: experience.scene.channel,
        tick: experience.tick,
      });
    }

    // 批次收尾：把切分器留下的 open 段闭合。
    //
    // 理由有二：① 回填是批处理，批次有终点，最后一段之后没有更多记录 —— 语义上就是「静默」；
    // ②「同一通道至多一个 open 事件」是 restore() 的硬约束 —— 留 open 会与实时摄入
    //    留下的 open 段撞车（restore 直接抛 CorruptedError，整个门面起不来）。
    //
    // 闭合原因取 'silence'：单记录 + 静默闭合即「待归并」，与 §5.5 的既有口径一致
    //（7 天观察窗到期后由启动清道夫补标「孤立记录」，等她手动归并）。
    for (const event of sandbox.readAll()) {
      if (event.status !== 'open') {
        continue;
      }
      sandbox.appendVersion({
        ...event,
        version: event.version + 1,
        status: 'closed',
        closed_reason: 'silence',
        created_at: nowText,
      });
    }

    const sandboxEvents = sandbox.readAll();
    const sandboxRows = sandbox.readAllVersions();

    // ── 4. 统计 ──
    for (const event of sandboxEvents) {
      report.created.events += 1;
      report.created.records += event.pointers.length;
      report.created.by_channel[event.channel] =
        (report.created.by_channel[event.channel] ?? 0) + 1;
      if (event.pointers.length === 1) {
        report.created.single_record_events += 1;
      }
      if (isPendingMergeOf(event)) {
        report.created.pending_merge += 1;
      }
      if (event.boundary_candidates.some((item) => item.kind === ORPHAN_MARK_KIND)) {
        report.created.orphan_marked += 1;
      }

      // ── v1.4 · C11：两计数器预演值 + 各 closed_reason 命中统计 ──
      const effectiveChars = event.effective_chars;
      const rawChars = event.raw_chars;
      if (effectiveChars !== null) {
        report.caps.max_effective_chars = Math.max(
          report.caps.max_effective_chars ?? 0,
          effectiveChars,
        );
      }
      if (rawChars !== null) {
        report.caps.max_raw_chars = Math.max(report.caps.max_raw_chars ?? 0, rawChars);
      }
      if (event.closed_reason === 'max-dialogue-chars') {
        report.caps.max_dialogue_chars += 1;
      }
      if (event.closed_reason === 'max-chars') {
        report.caps.max_chars += 1;
      }
      const reasonKey = event.closed_reason ?? 'open';
      report.reason_stats[reasonKey] = (report.reason_stats[reasonKey] ?? 0) + 1;

      report.segments.push({
        id: event.id,
        channel: event.channel,
        started_at: event.time_range.started_at,
        ended_at: event.time_range.ended_at,
        records: event.pointers.length,
        closed_reason: event.closed_reason,
        single_record: event.pointers.length === 1,
        pending_merge: isPendingMergeOf(event),
        effective_chars: effectiveChars,
        raw_chars: rawChars,
      });
    }
    report.created.version_rows = sandboxRows.length;

    // ── 5. 真写（仅 --apply）──
    //
    // 落盘的是**切分器产出的完整版本链**（每个版本都是一行，与实时摄入同形），
    // 而不是「重新造一份」—— 这样事件层看不出补齐段与实时段的区别。
    if (apply) {
      for (const event of sandboxEvents) {
        for (const version of sandbox.versionsOf(event.id)) {
          eventLog.appendVersion(version);
        }
      }
    }
  } finally {
    sandbox.dispose();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }

  // ── 6. 自证：既有事件字节级未变 ──
  const shardAfter = snapshotShards(layout.events);
  report.existing.untouched = shardsUnchanged(shardBefore, shardAfter);
  if (!report.existing.untouched) {
    warnings.push('既有事件分片在回填后不是回填前文本的前缀 —— 既有事件被改写了，请立即检查。');
  }

  return report;
}

// ── v1.4 · C11：历史计数补齐（显式可选，默认关闭）────────────────────────

/**
 * 补齐后的经历副本 —— 含 `char_count` 与类型化产物。
 *
 * **原记录一律不改**：真源 append-only，且「不在线回算历史计数」是纪律。
 * 补齐只存在于沙箱里，用来让新切出的事件带上正确的两个计数器。
 */
interface CountedExperience {
  readonly experience: Experience;
  readonly charCount: number | null;
  readonly toolTurn: boolean;
}

/**
 * 历史计数补齐（显式可选能力，**默认关闭**）。
 *
 * 做三件事，逐条对应任务书 C11：
 *  1. 按 `observation.text` 指针回原文层取 `raw_text`；
 *  2. 算 `char_count` = 全量码点长度（`Array.from(...).length`）；
 *  3. 按载荷形状补 `action`/`outcome`（阶段 0 类型化的离线等价物）。
 *
 * 读不到原文 → `char_count = null`、不加 action/outcome（**不猜不编**，
 * 失败降级表第 1 行）；**不回写真源**。
 *
 * @returns 补齐后的经历副本（原样返回 = 未补齐）
 */
function backfillCountsOf(
  experience: Experience,
  rawTexts: ReadonlyMap<string, string>,
): CountedExperience {
  const pointer = experience.observation.text;
  if (pointer?.id === undefined) {
    return { experience, charCount: null, toolTurn: false };
  }
  const rawText = rawTexts.get(pointer.id);
  if (rawText === undefined) {
    return { experience, charCount: null, toolTurn: false };
  }

  const charCount = Array.from(rawText).length;
  const typing = typeToolTurn(rawText);
  const enriched: Experience = { ...experience, char_count: charCount };

  if (typing.kind === 'call-step') {
    enriched.action = {
      type: 'tool-call',
      tool: typing.tool,
      args: { ...pointer },
      call_id: typing.callId,
    };
    return { experience: enriched, charCount, toolTurn: true };
  }

  if (typing.kind === 'result') {
    const outcome: Outcome = { text: { ...pointer }, status: typing.status };
    if (typing.callId !== undefined) {
      outcome.call_id = typing.callId;
    }
    if (typing.errorType !== undefined) {
      outcome.error_type = typing.errorType;
    }
    if (typing.durationMs !== undefined) {
      outcome.duration_ms = typing.durationMs;
    }
    enriched.outcome = outcome;
    return { experience: enriched, charCount, toolTurn: true };
  }

  return { experience: enriched, charCount, toolTurn: false };
}

/**
 * 读原文层 → 建立 `event_id → raw_text` 映射（补齐用）。
 *
 * 逐通道读；读不到的通道跳过（**不编造原文**）。
 */
function readRawTextsOf(root: string, channels: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const layout = layoutOf(root);
  for (const channel of channels) {
    const dir = channel === 'dsh' ? layout.rawTurns : path.join(layout.raw, channel);
    if (!fs.existsSync(dir)) {
      continue;
    }
    const log = new RawLog(channel, dir);
    try {
      for (const turn of log.readAll()) {
        out.set(turn.event_id, turn.raw_text);
      }
    } catch {
      // 原文层读不了 → 该通道不补齐（不猜、不编）。
    }
  }
  return out;
}

// ── 报告输出 ──────────────────────────────────────────────────────────────
/** 人读的报告。 */
export function formatReport(report: BackfillReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('  B 块第一期 · 历史回填运行报告（T18）');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push(`模式        ：${report.mode === 'dry-run' ? '试运行（未写入任何文件）' : '真写'}`);
  lines.push(`数据根      ：${report.data_root}`);
  lines.push('');
  lines.push('── 扫描 ────────────────────────────────────────────────────────');
  lines.push(`记录本经历总数      ：${report.scanned.experiences}`);
  lines.push(`已被事件覆盖（跳过）：${report.scanned.covered}`);
  lines.push(`无覆盖（待补齐）    ：${report.scanned.uncovered}`);
  lines.push('');
  lines.push('── 补齐 ────────────────────────────────────────────────────────');
  lines.push(`补了事件段          ：${report.created.events}`);
  lines.push(`写入版本行数        ：${report.created.version_rows}`);
  lines.push(`覆盖记录数          ：${report.created.records}`);
  const channels = Object.entries(report.created.by_channel);
  lines.push(
    `按通道分布          ：${channels.length === 0 ? '（无）' : channels.map(([id, n]) => `${id}=${n}`).join('、')}`,
  );
  lines.push(`单记录事件数        ：${report.created.single_record_events}`);
  lines.push(`待归并（孤立候选）  ：${report.created.pending_merge}`);
  lines.push(`已标孤立记录        ：${report.created.orphan_marked}`);
  lines.push('');
  lines.push('── v1.4 两个上限预演（只作用于新切出的事件）──────────────────');
  lines.push(`有效对话字数上限命中：${report.caps.max_dialogue_chars}（reason=max-dialogue-chars）`);
  lines.push(`硬保险丝命中        ：${report.caps.max_chars}（reason=max-chars）`);
  lines.push(
    `最大有效对话字数    ：${report.caps.max_effective_chars ?? '（未统计：未开启历史计数补齐）'}`,
  );
  lines.push(
    `最大 raw 全量字符   ：${report.caps.max_raw_chars ?? '（未统计：未开启历史计数补齐）'}`,
  );
  const reasons = Object.entries(report.reason_stats);
  lines.push(
    `闭合原因分布        ：${reasons.length === 0 ? '（无）' : reasons.map(([reason, n]) => `${reason}=${n}`).join('、')}`,
  );
  lines.push('');
  lines.push('── 既有事件 ────────────────────────────────────────────────────');
  lines.push(`既有事件数（未触碰）：${report.existing.events}`);
  lines.push(`既有版本行数        ：${report.existing.version_rows}`);
  lines.push(`既有事件字节级未变  ：${report.existing.untouched ? '是' : '否（异常！）'}`);
  lines.push('');
  lines.push('── 预期说明（定案稿 §16.2）────────────────────────────────────');
  lines.push('「初始很碎、单条事件多、孤立记录多」是**设计使然，不是缺陷**：');
  lines.push('历史记录按「静默 ≥30 分钟即闭合」切分，跨天的相邻记录必然各自成段。');
  lines.push('比起一开始就硬凑出错误的大事件，先忠实切分、再逐步归并更符合「诚实优先、宁缺勿凑」。');
  lines.push('「已标孤立记录」在回填刚完成时通常是 0 —— 观察窗从 assembled_at（回填时刻）起算。');
  lines.push('');
  if (report.warnings.length > 0) {
    lines.push('── 告警 ────────────────────────────────────────────────────────');
    for (const warning of report.warnings) {
      lines.push(`  · ${warning}`);
    }
    lines.push('');
  }
  lines.push('══════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────

interface CliOptions extends BackfillOptions {
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dataRoot: undefined,
    apply: false,
    params: undefined,
    backfillCounts: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--data-root': {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error('参数 --data-root 缺少取值');
        }
        i += 1;
        options.dataRoot = value;
        break;
      }
      case '--apply':
        options.apply = true;
        break;
      case '--backfill-counts':
        // v1.4 · C11：历史计数补齐是**显式可选**能力，默认关闭。
        options.backfillCounts = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数 ${arg}\n${usage()}`);
    }
  }
  return options;
}

function usage(): string {
  return [
    '用法：node scripts/backfill-events.ts [选项]',
    '',
    '  --data-root <目录>  数据根（默认 resolveDataRoot：显式配置 > $DSH_HOME/fasti > ~/.dsh/fasti）',
    '  --apply             真写（缺省是试运行：只报告，不写任何东西）',
    '  --backfill-counts   历史 char_count / 两计数器 / action / outcome 的离线补齐',
    '                     （**默认关闭**；开启后只影响新切出的事件，真源记录一个字节都不改）',
    '  --json              输出 JSON 报告（机器可读）',
    '  --help              本帮助',
    '',
    '纪律：只补齐不重建 —— 已被事件覆盖的记录一律跳过，既有事件的边界与版本一个字节都不碰。',
    '',
    '两个上限（7000 / 50000）只作用于**新切出**的事件 —— 既有事件不重切、不重算。',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`错误：${(error as Error).message}\n`);
    process.exit(1);
    return;
  }

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  let report: BackfillReport;
  try {
    report = backfillEvents(options);
  } catch (error) {
    process.stderr.write(`错误：${(error as Error).message}\n`);
    process.exit(1);
    return;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }

  // 既有事件被改写 = 违反「只补齐不重建」的硬纪律 → 响亮失败，不静默通过。
  if (!report.existing.untouched) {
    process.stderr.write('既有事件被改写 —— 违反「只补齐不重建」，请立即检查事件真源。\n');
    process.exit(1);
  }
}

// 仅在被直接执行时跑 CLI（被测试 import 时不自动执行）。
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
