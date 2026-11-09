/**
 * 事件日志 —— events/YYYY-MM.jsonl（技术基线 §3）。
 *
 * 关键口径：
 *  - append-only、不可变：每次状态/版本推进**追加一行**，同 id 共享，version 从 1 递增；
 *  - **幂等键是 (id, version)**：同 id 同 version 重复追加视为重试 → 返回既有行、
 *    不重复写、不报错；同 id 不同 version → 正常追加；
 *  - 当前态 = 同 id 的**最大 version**（按版本号判定，不按落盘先后）；
 *  - 退役态（merged / split）留痕不删行；
 *  - 分片键取 assembled_at 所在月（与 ExperienceLog 取 recorded_at 同构）；
 *  - 坏行必须抛 CorruptedError，不静默跳过、不返回空；
 *  - **本模块不提供任何删除能力**（冻结面第 1 条：真源只增不改）。
 *
 * **索引漂移防线（第一层 · 存储层自愈，主理人 2026-11-09 裁定）**：
 * 内存索引与 nextSeq 都是**实例内**缓存，两个实例指向同一 events/ 目录时互不知情 ——
 * 轻则查不到别人写的行，重则**静默读到别人的行**（她修正过的事件被读成别的内容，最坏故障）。
 * 故本模块自带两道防线，**宁可抛错，不可静默**：
 *  1. **写前校验**：追加前比对该分片的字节数是否仍等于本实例上次写完时的字节数
 *     （O(1) 一次 stat，不像数行那样每次写都 O(n)）—— 不符即抛 ConflictError，**不写坏真源**；
 *  2. **读侧兜底**：按索引落点读到的行必须仍是它自己（id + version 对得上）—— 不符即抛
 *     CorruptedError，把「静默读错」变成响亮失败。
 *
 * 第二层是**单写者纪律**（同一目录单实例，一律注入不得自行 new）—— 由门面侧落地。
 *
 * 方法名避开冻结面禁词（update / delete / remove / rewrite / mutate / overwrite /
 * truncate / purge / erase / patch）—— 事件层属真源层，「修正」是追加新版本行，
 * 不是改写既有行。
 */

import fs from 'node:fs';
import path from 'node:path';

import { ConflictError, CorruptedError, NotFoundError } from '../core/errors.ts';
import { writeFileAtomic } from '../core/fsx.ts';
import { appendJsonl, countJsonlLines, readJsonlFile } from '../core/jsonl.ts';
import { shardKeyOf } from '../core/time.ts';
import { parseEvent } from '../contract/event.ts';
import type { EventRecord, EventStatus } from '../contract/event.ts';
import { readManifest } from './raw-log.ts';
import type { Manifest } from './raw-log.ts';

const MANIFEST_FILE = 'manifest.json';

/** 分片文件的字节数（文件不存在按 0 计）。 */
function fileSizeOf(file: string): number {
  return fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

/** 事件行的落点。 */
export interface EventLocation {
  shard: string;
  seq: number;
}

/** append 的结果。 */
export interface AppendEventOutcome {
  record: EventRecord;
  location: EventLocation;
  /** 是否为新写入（false = 幂等命中既有行）。 */
  created: boolean;
}

/** 一个版本行在真源里的落点。 */
interface EventVersionSlot {
  version: number;
  location: EventLocation;
}

/**
 * 进程级实例登记表 —— 键 = 规范化后的绝对目录。
 *
 * 纪律（单写者）：同一进程内，指向同一个 `events/` 目录**只能有一个活实例**。
 * 原因：seq 计数与内存索引都是**实例内**缓存 —— 两个实例各写各的，会落出两个
 * 相同的 `(shard, seq)`，读回时张冠李戴（静默读到别人的事件行）。
 *
 * 因此第二次 `new EventLog(同一目录)` 直接抛错，不做静默复用 ——
 * 静默复用会把「两个持有者」变成隐式共享，掩盖问题。
 */
const LIVE_LOGS = new Map<string, EventLog>();

/**
 * 事件日志 —— 记事本（二级真源）的唯一写入口。
 *
 * 只提供 append / read 能力；不提供任何修改既有行的路径（冻结面第 1 条）。
 */
export class EventLog {
  private readonly dir: string;
  /** id → 各版本的落点（按追加顺序）。 */
  private readonly index = new Map<string, EventVersionSlot[]>();
  /** 每个分片的下一个 seq。 */
  private readonly nextSeq = new Map<string, number>();
  /**
   * 每个分片「本实例上次写完时」的字节数 —— 漂移探测的基准。
   *
   * 判据是**字节数**而不是行数：stat 是 O(1)，而每次 append 数一遍行是 O(n) ——
   * 事件量上去后每次写都全量数行不可接受。
   */
  private readonly expectedBytes = new Map<string, number>();

  /** 规范化后的目录键（登记表用）。 */
  private readonly key: string;

  /** 是否仍登记在进程级表里（dispose 后置否）。 */
  private registered = true;

  /**
   * 「记录 → 当前态事件」归属索引（记录唯一归属的 O(1) 判定口）。
   *
   * 为什么放在本模块而不是各调用方：归属是**真源行的派生**，只有写行的人
   * 知道它变了。让调用方各自 `readAll()` 扫一遍（修正器原来就这么干）既是
   * O(n) 重复劳动，也必然出现「有人漏扫 → 归属判错 → 同一记录被两个事件引用」。
   *
   * `ownersEpoch` 记住这份索引按哪一代折叠；任何一次成功追加都让代数 +1，
   * 下次查询时按需重折一次（人工修正是低频操作，一次折叠完全够用）。
   */
  private readonly owners = new Map<string, string>();
  private ownersEpoch = -1;

  /** 当前态代数 —— 每次成功追加 / 重建索引都会变。 */
  private epoch = 0;

  constructor(dir: string) {
    this.dir = dir;
    this.key = path.resolve(dir);

    // 单写者：同一目录已有活实例 → 抛错（让「两个持有者」在构造时就被挡住）。
    const existing = LIVE_LOGS.get(this.key);
    if (existing !== undefined && existing.registered) {
      throw new ConflictError(
        `事件日志目录已有活实例（单写者纪律：同一目录只能有一个写者）：${this.key}。` +
          '请复用该实例（EventLog.open(dir)），或先 dispose() 再新建。',
      );
    }
    LIVE_LOGS.set(this.key, this);
  }

  /**
   * 显式复用出口 —— 取本目录的活实例；没有就新建一个并登记。
   *
   * 与构造器的区别是**显式**的：调用方明确知道自己在拿共享实例
   * （而不是「不小心 new 出了第二个」）。
   */
  static open(dir: string): EventLog {
    const key = path.resolve(dir);
    const existing = LIVE_LOGS.get(key);
    if (existing !== undefined && existing.registered) {
      return existing;
    }
    return new EventLog(dir);
  }

  /**
   * 释放本实例（从登记表移除）—— 之后可再次 `new` / `open` 同一目录。
   *
   * 释放时机：单写者队列 drain() 之后、或进程退出；测试里用 try/finally 释放，
   * 免得临时目录删不掉（Windows 上文件句柄占用）。
   *
   * 登记项必须真的删掉：留个「已释放」标记会让 `LIVE_LOGS` 只增不减
   * （长期运行的宿主里，关掉的每个数据根都会占一项，且永远回收不了）。
   */
  dispose(): void {
    if (!this.registered) {
      return;
    }
    this.registered = false;
    LIVE_LOGS.delete(this.key);
  }

  /**
   * 追加一个版本行。
   *
   * 幂等键：(id, version)。同 id 同 version 重复追加视为重试 → 返回既有行、
   * 不重复写、不报错；同 id 不同 version → 正常追加（版本推进）。
   */
  appendVersion(record: EventRecord): AppendEventOutcome {
    // 写入边界：禁字段名 / 未知字段 / 枚举越界 / 摘要上限在落盘前拦住。
    const parsed = parseEvent(record, 'write');

    const slots = this.index.get(parsed.id);
    if (slots !== undefined) {
      const hit = slots.find((slot) => slot.version === parsed.version);
      if (hit !== undefined) {
        return {
          record: this.readAt(hit.location, { id: parsed.id, version: hit.version }),
          location: hit.location,
          created: false,
        };
      }
    }

    const shard = shardKeyOf(parsed.assembled_at);
    const seq = this.seqOf(shard);
    // 写前校验：seq 必须仍与真源一致 —— 别的实例写过这个分片就抛错，宁可不写，也不写坏。
    this.assertNoForeignWrite(shard);
    const location: EventLocation = { shard, seq };

    appendJsonl(this.shardFile(shard), parsed);
    this.nextSeq.set(shard, seq + 1);
    // 记下写完后的字节数 —— 下次写前拿它当基准比对。
    this.expectedBytes.set(shard, fileSizeOf(this.shardFile(shard)));
    if (slots === undefined) {
      this.index.set(parsed.id, [{ version: parsed.version, location }]);
    } else {
      slots.push({ version: parsed.version, location });
    }
    this.registerShard(shard);
    // 当前态可能变了 → 归属索引的代数 +1（下次 ownerOf 按需重折）。
    this.epoch += 1;

    return { record: parsed, location, created: true };
  }

  /** 按 id 取当前态（同 id 最大 version）；不存在抛 NotFoundError。 */
  currentOf(id: string): EventRecord {
    const latest = this.latestSlotOf(id);
    if (latest === undefined) {
      throw new NotFoundError(`事件不存在：${id}`);
    }
    return this.readAt(latest.location, { id, version: latest.version });
  }

  /** 按 id 读全部版本，按 version 升序；未知 id 返回空数组（没有版本历史）。 */
  versionsOf(id: string): EventRecord[] {
    const slots = this.index.get(id);
    if (slots === undefined) {
      return [];
    }
    return slots
      .slice()
      .sort((a, b) => a.version - b.version)
      .map((slot) => this.readAt(slot.location, { id, version: slot.version }));
  }

  /** 按状态列当前态（只列每个 id 的当前态，不是历史行）。 */
  listByStatus(status: EventStatus): EventRecord[] {
    return this.readAll().filter((record) => record.status === status);
  }

  /**
   * 这条记录当前归哪个事件（`undefined` = 不归任何当前态事件）。
   *
   * 口径（设计稿 v1.1 §7.1.1「记录唯一归属」）：
   *  - 只看**当前态**；退役态（merged / split）不算归属 —— 它们的指针已由
   *    合并目标 / 拆分出的子事件承接，再算一遍会让「移入」永远被拒（假冲突）；
   *  - 只读、不判重：真出现「同一记录被两个当前态事件引用」，本方法返回先出现的那个；
   *    真正该拦的地方是写入侧（`reviseBoundary` 移入前查这里）。
   */
  ownerOf(experienceId: string): string | undefined {
    if (this.ownersEpoch !== this.epoch) {
      this.rebuildOwners();
    }
    return this.owners.get(experienceId);
  }

  /** 全部事件的当前态，按 (shard, seq) 升序 = 写入顺序。 */
  readAll(): EventRecord[] {
    return this.currentRows().map((item) => item.record);
  }

  /** 全部版本行（含历史），按 (shard, seq) 升序。 */
  readAllVersions(): EventRecord[] {
    const out: EventRecord[] = [];
    for (const shard of this.shards()) {
      const rows = readJsonlFile<unknown>(this.shardFile(shard));
      rows.forEach((row) => out.push(this.parseRow(row, shard)));
    }
    return out;
  }

  /** 事件总数（当前态计数，非历史行数）。 */
  count(): number {
    return this.currentRows().length;
  }

  /** 已登记的分片列表。 */
  shards(): string[] {
    return readManifest(this.dir).months.slice().sort();
  }

  /** 某分片的文件路径。 */
  shardFile(shard: string): string {
    return path.join(this.dir, `${shard}.jsonl`);
  }

  /**
   * 从真源重建内存索引与 seq 计数。
   *
   * 进程重启后必须调用，否则幂等键与 seq 不准。
   */
  reindex(): void {
    this.index.clear();
    this.nextSeq.clear();
    this.expectedBytes.clear();
    this.epoch += 1;
    for (const shard of this.shards()) {
      const rows = readJsonlFile<unknown>(this.shardFile(shard));
      rows.forEach((row, seq) => {
        const record = this.parseRow(row, shard);
        const location: EventLocation = { shard, seq };
        const slots = this.index.get(record.id);
        if (slots === undefined) {
          this.index.set(record.id, [{ version: record.version, location }]);
        } else {
          slots.push({ version: record.version, location });
        }
      });
      this.nextSeq.set(shard, rows.length);
      // 重建基准：重建后这个分片的字节数就是「我已知的状态」。
      this.expectedBytes.set(shard, fileSizeOf(this.shardFile(shard)));
    }
  }

  /** 当前态集合：同 id 取最大 version，按当前态所在 (shard, seq) 升序。 */
  private currentRows(): Array<{ record: EventRecord; location: EventLocation }> {
    const latest = new Map<string, { version: number; record: EventRecord; location: EventLocation }>();
    for (const shard of this.shards()) {
      const rows = readJsonlFile<unknown>(this.shardFile(shard));
      rows.forEach((row, seq) => {
        const record = this.parseRow(row, shard);
        const prev = latest.get(record.id);
        if (prev === undefined || record.version > prev.version) {
          latest.set(record.id, { version: record.version, record, location: { shard, seq } });
        }
      });
    }
    return [...latest.values()].sort((a, b) => {
      if (a.location.shard === b.location.shard) {
        return a.location.seq - b.location.seq;
      }
      return a.location.shard < b.location.shard ? -1 : 1;
    });
  }

  /**
   * 重折归属索引（按需调用，不随每次读触发）。
   *
   * 只装当前态里**未退役**的事件：merged / split 的事件已把指针交给
   * 合并目标 / 子事件，再算一遍会造成假冲突（记录永远「属于别人」）。
   */
  private rebuildOwners(): void {
    this.owners.clear();
    for (const { record } of this.currentRows()) {
      if (record.status === 'merged' || record.status === 'split') {
        continue;
      }
      for (const pointer of record.pointers) {
        // 先到先得：正常不该重复；真撞上也不在这里抛 ——
        // 读路径不制造故障，写入侧的归属检查才是那道闸。
        if (!this.owners.has(pointer.id)) {
          this.owners.set(pointer.id, record.id);
        }
      }
    }
    this.ownersEpoch = this.epoch;
  }

  /** 同 id 的最大版本槽位。 */
  private latestSlotOf(id: string): EventVersionSlot | undefined {
    const slots = this.index.get(id);
    if (slots === undefined || slots.length === 0) {
      return undefined;
    }
    return slots.reduce((a, b) => (b.version > a.version ? b : a));
  }

  /**
   * 读指定落点的一行。
   *
   * `expect` 是索引对该落点的预期 —— 读到的行必须仍是它自己（id + version 对得上）。
   * 对不上说明**索引漂移**（真源被绕过 EventLog 改写、或有别的写入方插队）：
   * 抛 CorruptedError，**绝不静默返回别人的行**（她修正过的事件被读成别的内容 = 最坏故障）。
   */
  private readAt(location: EventLocation, expect?: { id: string; version: number }): EventRecord {
    const rows = readJsonlFile<unknown>(this.shardFile(location.shard));
    const row = rows[location.seq];
    if (row === undefined) {
      throw new NotFoundError(`事件落点失效：${location.shard}#${location.seq}`);
    }
    const record = this.parseRow(row, location.shard);
    if (expect !== undefined && (record.id !== expect.id || record.version !== expect.version)) {
      throw new CorruptedError(
        `事件落点漂移：期望 ${expect.id}#v${expect.version}，实际 ${record.id}#v${record.version}（${location.shard}#${location.seq}）`,
      );
    }
    return record;
  }

  /**
   * 解析一行真源数据。
   *
   * schema 不合法 = 存储损坏（不是调用方的契约违约）→ 抛 CorruptedError，
   * 不静默跳过、不返回空。
   */
  private parseRow(raw: unknown, shard: string): EventRecord {
    try {
      return parseEvent(raw, 'read');
    } catch (error) {
      throw new CorruptedError(`事件行损坏（${shard}）：${(error as Error).message}`, { cause: error });
    }
  }

  /** 某分片下一个可用的 seq。 */
  private seqOf(shard: string): number {
    const cached = this.nextSeq.get(shard);
    if (cached !== undefined) {
      return cached;
    }
    const file = this.shardFile(shard);
    // 先记字节数再数行：两次读之间若有别的实例写入 → 字节数会变 → 判定漂移。
    const sizeBefore = fileSizeOf(file);
    const count = countJsonlLines(file);
    if (fileSizeOf(file) !== sizeBefore) {
      throw new ConflictError(`事件分片在取号期间被写入（索引漂移）：${shard}`);
    }
    this.nextSeq.set(shard, count);
    this.expectedBytes.set(shard, sizeBefore);
    return count;
  }

  /**
   * 写前校验：这个分片是不是被**别的实例**写过了。
   *
   * 判据是「当前字节数是否仍等于本实例上次写完时的字节数」——
   * O(1) 一次 stat；任何外来写入（另一个实例、旁路脚本）都会让它变化。
   * 变了就抛 ConflictError：宁可响亮失败，也不把行写到别人的落点上。
   */
  private assertNoForeignWrite(shard: string): void {
    const expected = this.expectedBytes.get(shard);
    if (expected === undefined) {
      return;
    }
    const actual = fileSizeOf(this.shardFile(shard));
    if (actual !== expected) {
      throw new ConflictError(
        `事件分片被其它写入方改动（索引已漂移）：${shard}（本实例上次写完时 ${expected} 字节，现在 ${actual} 字节）。请 reindex() 重建索引后再写。`,
      );
    }
  }

  /** 登记分片到 manifest（events/manifest.json，与 experiences 同格式）。 */
  private registerShard(shard: string): void {
    const manifest: Manifest = readManifest(this.dir);
    if (!manifest.months.includes(shard)) {
      manifest.months.push(shard);
      manifest.months.sort();
      writeFileAtomic(path.join(this.dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
}
