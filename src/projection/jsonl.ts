/**
 * L2 投影引擎 —— JSONL 索引（node:sqlite 不可用时的降级路径）。
 *
 * 定案稿 §7.4：L2 = JSONL 索引（复用 KVStore 形态），自建倒排 + 时间/通道索引；
 * 无 FTS5，检索走词法（与现有 recall 同能力）。
 *
 * 审计口径：L2 索引布局的最小要求是**时间索引、通道索引、词法倒排**三类。
 * 文件布局（实现者自定，评审确认无遗漏）：
 *   projection/l2/experience.jsonl   —— 经历投影行（顺序即确定性顺序）
 *   projection/l2/edge.jsonl         —— 边投影行
 *   projection/l2/document.jsonl     —— 全文文档（id → 文本）
 *   projection/l2/index/time.jsonl   —— 时间索引（occurred_ms → id 列表）
 *   projection/l2/index/channel.jsonl—— 通道索引（channel → id 列表）
 *   projection/l2/index/term.jsonl   —— 词法倒排（term → id 列表）
 *
 * 注意：index/ 三类文件是**写后供外部检视/离线诊断的落盘件，运行时并不读回** ——
 * open 时内存倒排与时间/通道桶一律从 experience.jsonl + document.jsonl 重建，
 * 因此索引文件滞后或缺失不影响检索正确性（重建即重写）。
 *
 * 检索语义与 L1/L3 一致：ASCII 大小写不敏感子串匹配（用户拍板 Q1）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { appendJsonl, readJsonlFile, toJsonLine } from '../core/jsonl.ts';
import { ensureDir, writeFileAtomic } from '../core/fsx.ts';
import { asciiLower, makeSnippet, matchesSubstring } from './types.ts';
import {
  decodeEventRow,
  encodeEventRow,
  foldCurrentEventRows,
  matchesEventQuery,
  sortEventRows,
} from './event-row.ts';
import { toEdgeProjection, toExperienceProjection } from './sqlite.ts';
import type {
  EdgeProjection,
  EventProjection,
  EventQuery,
  ExperienceProjection,
  ProjectionEdgeQuery,
  ProjectionEngine,
  ProjectionQuery,
  ProjectionSearchHit,
} from './types.ts';

/**
 * 倒排索引的最小词长。
 *
 * 采用**字符三元组（trigram）**建索引，与 L1 的 FTS5 trigram 同构 ——
 * 这是三档检索语义一致的必要条件：整词索引会漏掉「词内子串」查询
 * （如 "brows" 之于 "browser"），而 trigram 索引给出的是真子串命中的**超集**，
 * 再由精确判定收口，于是三档结果集完全一致。
 */
export const MIN_INDEX_TERM_LENGTH = 3;

/**
 * D1 压实触发阈值（开机按需誊清）：某数据账已解析行数 ≥ COMPACT_MIN_ROWS
 * 且 ≥ 现存行数 × COMPACT_RATIO 时，载入完成后整体原子重写为当前态。
 * 初值凭经验设定，观测数据上来再调（对齐拍板记录 7 的观测精神）。
 */
export const COMPACT_MIN_ROWS = 64;
export const COMPACT_RATIO = 2;

/**
 * 把文本切成字符三元组（滑动窗口，长度 3）。
 *
 * 与 SQLite FTS5 trigram 分词器同构：大小写不敏感、逐字符切分（含空白与标点）。
 */
export function trigrams(text: string): string[] {
  const lower = asciiLower(text);
  const out: string[] = [];
  for (let i = 0; i + MIN_INDEX_TERM_LENGTH <= lower.length; i += 1) {
    out.push(lower.slice(i, i + MIN_INDEX_TERM_LENGTH));
  }
  return out;
}

/** 保留：按「ASCII 词 + CJK 单字」切分（供诊断与索引展示使用）。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let buffer = '';

  const flush = (): void => {
    if (buffer !== '') {
      tokens.push(buffer);
      buffer = '';
    }
  };

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isAsciiWord = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (isAsciiWord) {
      buffer += char;
    } else {
      flush();
      // CJK 逐字切分，保证中文单字可检索。
      if (code >= 0x4e00 && code <= 0x9fff) {
        tokens.push(char);
      }
    }
  }
  flush();

  return tokens;
}

/** L2 引擎。 */
export class JsonlProjection implements ProjectionEngine {
  readonly level = 'L2' as const;
  private readonly dir: string;

  /** id → 经历投影。 */
  private readonly experiences = new Map<string, ExperienceProjection>();
  /** id → 边投影。 */
  private readonly edges = new Map<string, EdgeProjection>();
  /** id → 全文文本。 */
  private readonly documents = new Map<string, string>();
  /** id → 事件投影（当前态）。 */
  private readonly events = new Map<string, EventProjection>();
  /** 词 → 文档 id 集合（倒排）。 */
  private readonly inverted = new Map<string, Set<string>>();
  /** 通道 → 文档 id 集合。 */
  private readonly byChannel = new Map<string, Set<string>>();
  /** 时间桶（occurred_ms 按天）→ 文档 id 集合。 */
  private readonly byTimeBucket = new Map<number, Set<string>>();
  /** 载入期计数：每本数据账本次 open 解析到的行数（残行不计入）。 */
  private readonly parsedRows = new Map<string, number>();
  /** 尾净状态缓存（L3-补1·单写者纪律：本引擎是四本账的唯一写者，追加后尾必净）。 */
  private readonly tailClean = new Map<string, boolean>();

  constructor(dir: string) {
    this.dir = dir;
  }

  async open(): Promise<void> {
    this.experiences.clear();
    this.edges.clear();
    this.documents.clear();
    this.events.clear();
    this.inverted.clear();
    this.byChannel.clear();
    this.byTimeBucket.clear();
    this.parsedRows.clear();
    this.tailClean.clear();

    ensureDir(this.dir);
    ensureDir(path.join(this.dir, 'index'));

    for (const row of readJsonlFile<ExperienceProjection>(this.file('experience.jsonl'), { tolerant: true })) {
      this.parsedRows.set('experience.jsonl', (this.parsedRows.get('experience.jsonl') ?? 0) + 1);
      this.experiences.set(row.id, toExperienceProjection(row));
    }
    for (const row of readJsonlFile<EdgeProjection>(this.file('edge.jsonl'), { tolerant: true })) {
      this.parsedRows.set('edge.jsonl', (this.parsedRows.get('edge.jsonl') ?? 0) + 1);
      this.edges.set(row.id, toEdgeProjection(row));
    }
    for (const row of readJsonlFile<{ id: string; text: string }>(this.file('document.jsonl'), { tolerant: true })) {
      this.parsedRows.set('document.jsonl', (this.parsedRows.get('document.jsonl') ?? 0) + 1);
      this.documents.set(row.id, row.text);
      this.indexText(row.id, row.text);
    }
    // 事件行：文件里可能残留同 id 的旧版本行 → 载入时按最大 version 折叠。
    // （物理行数按折叠前的解析行数计——压实触发对账用。）
    const eventRows = readJsonlFile<unknown>(this.file('event.jsonl'), { tolerant: true }).map((raw) =>
      decodeEventRow(raw),
    );
    this.parsedRows.set('event.jsonl', eventRows.length);
    for (const row of foldCurrentEventRows(eventRows)) {
      this.events.set(row.id, row);
    }

    // D1：开机按需誊清——此刻刚载入完、尚未对外服务，是全天唯一无并发追加的安全窗口。
    this.compactIfNeeded();
  }

  async close(): Promise<void> {
    // JSONL 引擎无外部资源。
  }

  async upsertExperience(row: ExperienceProjection): Promise<void> {
    this.experiences.set(row.id, row);
    this.appendRow('experience.jsonl', row);
    this.indexChannel(row);
  }

  async upsertEdge(row: EdgeProjection): Promise<void> {
    this.edges.set(row.id, row);
    this.appendRow('edge.jsonl', row);
  }

  async upsertDocument(id: string, text: string): Promise<void> {
    this.documents.set(id, text);
    this.appendRow('document.jsonl', { id, text });
    this.indexText(id, text);
    this.flushIndexes();
  }

  async query(query: ProjectionQuery): Promise<ExperienceProjection[]> {
    const rows = [...this.experiences.values()];

    const filtered = rows.filter((row) => {
      if (query.kind !== undefined && row.kind !== query.kind) {
        return false;
      }
      if (query.channel !== undefined && row.channel !== query.channel) {
        return false;
      }
      if (query.scene_ref !== undefined && row.scene_ref !== query.scene_ref) {
        return false;
      }
      if (query.initiation !== undefined && row.initiation !== query.initiation) {
        return false;
      }
      if (query.status !== undefined && row.status !== query.status) {
        return false;
      }
      if (query.occurred_from_ms !== undefined && row.occurred_ms < query.occurred_from_ms) {
        return false;
      }
      if (query.occurred_to_ms !== undefined && row.occurred_ms > query.occurred_to_ms) {
        return false;
      }
      return true;
    });

    filtered.sort((a, b) => a.occurred_ms - b.occurred_ms || a.tick - b.tick);
    return query.limit !== undefined ? filtered.slice(0, query.limit) : filtered;
  }

  async search(keyword: string, limit?: number): Promise<ProjectionSearchHit[]> {
    if (keyword === '') {
      return [];
    }

    const candidates = this.candidates(keyword);
    const hits: ProjectionSearchHit[] = [];

    for (const id of candidates) {
      const text = this.documents.get(id);
      if (text === undefined) {
        continue;
      }
      if (!matchesSubstring(text, keyword)) {
        continue;
      }
      // 已知降级态（D3 注释化拍板，随 D2 而来）：documents 载入正常而 experiences 末行
      // 因尾行容忍被丢时，该文档的 kind/channel 查不到对应经历行 → 如实给空串返回命中。
      // 不是 bug：命中本身有效。自愈＝写前残行切除（L3-补1：下次该 id upsert 即补行愈合），
      // 整体重建为兜底。不得改为抛错或隐藏命中。
      const row = this.experiences.get(id);
      hits.push({
        id,
        kind: row?.kind ?? '',
        channel: row?.channel ?? '',
        snippet: makeSnippet(text, keyword),
      });
      if (limit !== undefined && hits.length >= limit) {
        break;
      }
    }

    return hits;
  }

  async queryEdges(query: ProjectionEdgeQuery): Promise<EdgeProjection[]> {
    const rows = [...this.edges.values()].filter((row) => {
      if (query.src !== undefined && row.src !== query.src) {
        return false;
      }
      if (query.predicate !== undefined && row.predicate !== query.predicate) {
        return false;
      }
      if (query.dst !== undefined && row.dst !== query.dst) {
        return false;
      }
      if (query.as_of_ms !== undefined) {
        const valid = row.valid_ms === null || row.valid_ms <= query.as_of_ms;
        const notInvalid = row.invalid_ms === null || row.invalid_ms > query.as_of_ms;
        // ── G06 区块：as-of 的时间轴修正（created_ms <= T）──
        // as-of 还要看「这一行在 T 时刻是否已经存在」：回填行（created_ms 晚于 T）
        // 不能被当成「早前就已相信」。created_ms 为 null → 无法证明它在 T 时刻
        // 存在 → 不返回（L1/L2/L3 三档口径一致）。
        const created: number | null = row.created_ms;
        const existed = created !== null && created <= query.as_of_ms;
        if (!valid || !notInvalid || !existed) {
          return false;
        }
      }
      return true;
    });

    rows.sort((a, b) => a.created_ms - b.created_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }

  async allExperiences(): Promise<ExperienceProjection[]> {
    const rows = [...this.experiences.values()];
    rows.sort((a, b) => a.occurred_ms - b.occurred_ms || a.tick - b.tick);
    return rows;
  }

  async allEdges(): Promise<EdgeProjection[]> {
    return this.queryEdges({});
  }

  async allDocuments(): Promise<Map<string, string>> {
    return new Map(this.documents);
  }

  // ── T13 区块：事件投影 ──

  /**
   * 幂等写入一条事件投影。
   *
   * **版本保护**：只在 `incoming.version > existing.version` 时覆盖 ——
   * 旧版本不得覆盖新版本（与 L1 的 `WHERE excluded.version > event.version` 同规则）。
   */
  async upsertEvent(row: EventProjection): Promise<void> {
    const existing = this.events.get(row.id);
    if (existing !== undefined && existing.version >= row.version) {
      return;
    }
    this.events.set(row.id, row);
    this.appendRow('event.jsonl', encodeEventRow(row));
  }

  /** 事件查询（过滤与排序走共享实现 → 与 L1/L3 同语义）。 */
  async queryEvents(query: EventQuery): Promise<EventProjection[]> {
    const matched = sortEventRows(
      [...this.events.values()].filter((row) => matchesEventQuery(row, query)),
    );
    return query.limit !== undefined ? matched.slice(0, query.limit) : matched;
  }

  async allEvents(): Promise<EventProjection[]> {
    return sortEventRows([...this.events.values()]);
  }

  async clear(): Promise<void> {
    this.experiences.clear();
    this.edges.clear();
    this.documents.clear();
    this.events.clear();
    this.inverted.clear();
    this.byChannel.clear();
    this.byTimeBucket.clear();
    for (const name of ['experience.jsonl', 'edge.jsonl', 'document.jsonl', 'event.jsonl']) {
      writeFileAtomic(this.file(name), '');
    }
    for (const name of ['time.jsonl', 'channel.jsonl', 'term.jsonl']) {
      writeFileAtomic(path.join(this.dir, 'index', name), '');
    }
  }

  /**
   * JSONL 追加无法回滚，故这里只保证「失败不中断写入链」；
   * 半截状态由「需重建」标记兜底 —— 重建会先 clear 再整体折叠。
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /**
   * 候选集：先用倒排索引缩小范围，再用精确判定收口。
   *
   * 查询长度 < 3 时无法构造三元组 → 全量候选（L1 此处同样走 LIKE 全扫描），
   * 三档语义因此一致。
   */
  private candidates(keyword: string): string[] {
    const terms = trigrams(keyword);

    if (terms.length === 0) {
      return [...this.documents.keys()];
    }

    let intersection: Set<string> | null = null;
    for (const term of terms) {
      const posting = this.inverted.get(term);
      if (posting === undefined) {
        return [];
      }
      if (intersection === null) {
        intersection = new Set(posting);
      } else {
        const current: Set<string> = intersection;
        intersection = new Set([...current].filter((id: string) => posting.has(id)));
      }
      if (intersection.size === 0) {
        return [];
      }
    }

    return [...(intersection ?? [])].sort();
  }

  private indexText(id: string, text: string): void {
    for (const term of trigrams(text)) {
      let posting = this.inverted.get(term);
      if (posting === undefined) {
        posting = new Set<string>();
        this.inverted.set(term, posting);
      }
      posting.add(id);
    }
    this.indexChannelById(id);
  }

  private indexChannelById(id: string): void {
    const row = this.experiences.get(id);
    if (row === undefined) {
      return;
    }
    this.indexChannel(row);
    this.indexTime(row);
  }

  private indexChannel(row: ExperienceProjection): void {
    let posting = this.byChannel.get(row.channel);
    if (posting === undefined) {
      posting = new Set<string>();
      this.byChannel.set(row.channel, posting);
    }
    posting.add(row.id);
  }

  private indexTime(row: ExperienceProjection): void {
    const bucket = timeBucket(row.occurred_ms);
    let posting = this.byTimeBucket.get(bucket);
    if (posting === undefined) {
      posting = new Set<string>();
      this.byTimeBucket.set(bucket, posting);
    }
    posting.add(row.id);
  }

  /**
   * L3-补1（D2 配套·写前残行切除）：追加前确保账本以 '\n' 收尾，残行截到最后一个换行
   * 之后（全文无换行截到 0）再 appendJsonl。否则新行会与残行拼进同一行——重开时整行被
   * 尾行容忍丢弃（新写入凭空消失），或残行沦为中间坏行令下一次 open 抛 CorruptedError。
   * 残行从未成为有效数据，切除零信息损失。读取侧 tolerant 一字不动（残行可能撑到 open
   * 都没等到追加，双保险）。
   */
  private appendRow(name: string, row: unknown): void {
    this.repairTornTail(name);
    appendJsonl(this.file(name), row);
    this.tailClean.set(name, true);
  }

  /** L3-补1：快路径 O(1) 末字节探测；不净才读回切除（单写者纪律下缓存尾净状态）。 */
  private repairTornTail(name: string): void {
    if (this.tailClean.get(name) === true) {
      return;
    }
    const file = this.file(name);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size === 0) {
      this.tailClean.set(name, true);
      return;
    }
    const fd = fs.openSync(file, 'r');
    let lastByte = 0;
    try {
      const buffer = Buffer.allocUnsafe(1);
      fs.readSync(fd, buffer, 0, 1, size - 1);
      lastByte = buffer[0] ?? 0;
    } finally {
      fs.closeSync(fd);
    }
    if (lastByte === 0x0a) {
      this.tailClean.set(name, true);
      return;
    }
    // 残行切除：截到最后一个换行之后；全文无换行截到 0。
    const text = fs.readFileSync(file, 'utf8');
    const keepBytes = Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1), 'utf8');
    fs.truncateSync(file, keepBytes);
    this.tailClean.set(name, true);
  }

  /** D1：逐账对账，触发即整体原子重写为当前态；只写四本数据账，不碰 index/（flushIndexes 自管）。 */
  private compactIfNeeded(): void {
    this.compactFile(
      'experience.jsonl',
      this.experiences.size,
      [...this.experiences.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    this.compactFile('edge.jsonl', this.edges.size, [...this.edges.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
    this.compactFile(
      'document.jsonl',
      this.documents.size,
      [...this.documents.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, text]) => ({ id, text })),
    );
    this.compactFile(
      'event.jsonl',
      this.events.size,
      [...this.events.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((row) => encodeEventRow(row)),
    );
  }

  /**
   * 触发条件：账本物理行数 ≥ COMPACT_MIN_ROWS 且 ≥ 现存行数 × COMPACT_RATIO。
   * 重写行序按 id 排序（确定性，重开重压收敛到同一文件内容）；行格式经 toJsonLine
   * 与 appendJsonl 逐字节同构；空账写空串（与 flushIndexes 空态先例一致）。
   * 每文件独立原子重写：崩在半路，任何已完成子集折叠出的逻辑状态与全量完成相同。
   */
  private compactFile(name: string, liveRows: number, rows: readonly unknown[]): void {
    // 物理行数以本次载入的解析行数为准（残行不计入，重写后自然消失）。
    const parsedRows = this.parsedRows.get(name) ?? 0;
    if (parsedRows < COMPACT_MIN_ROWS || parsedRows < liveRows * COMPACT_RATIO) {
      return;
    }
    const body = rows.length === 0 ? '' : `${rows.map((row) => toJsonLine(row)).join('\n')}\n`;
    writeFileAtomic(this.file(name), body);
  }

  /** 把三类索引落盘（审计口径：时间索引、通道索引、词法倒排）。 */
  private flushIndexes(): void {
    const timeLines: string[] = [];
    for (const [bucket, ids] of [...this.byTimeBucket.entries()].sort((a, b) => a[0] - b[0])) {
      timeLines.push(JSON.stringify({ bucket, ids: [...ids].sort() }));
    }
    writeFileAtomic(path.join(this.dir, 'index', 'time.jsonl'), timeLines.length > 0 ? `${timeLines.join('\n')}\n` : '');

    const channelLines: string[] = [];
    for (const [channel, ids] of [...this.byChannel.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      channelLines.push(JSON.stringify({ channel, ids: [...ids].sort() }));
    }
    writeFileAtomic(
      path.join(this.dir, 'index', 'channel.jsonl'),
      channelLines.length > 0 ? `${channelLines.join('\n')}\n` : '',
    );

    const termLines: string[] = [];
    for (const [term, ids] of [...this.inverted.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      termLines.push(JSON.stringify({ term, ids: [...ids].sort() }));
    }
    writeFileAtomic(
      path.join(this.dir, 'index', 'term.jsonl'),
      termLines.length > 0 ? `${termLines.join('\n')}\n` : '',
    );
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }
}

/** 时间桶：按天（毫秒 ÷ 一天）。 */
export function timeBucket(ms: number): number {
  return Math.floor(ms / 86_400_000);
}
