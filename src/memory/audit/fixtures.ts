/**
 * 记忆层离线审计 —— 金标夹具加载与版本校验（方案 §4.10/§6.1，裁决 I3/I7）。
 *
 * 纪律：
 *  - 夹具只含 id 与标注，**绝不含有正文副本**（summary/body/raw_text/key_points 等一律拒收）；
 *  - 白名单字段校验：条目出现允许集之外的键即抛 IntegrityError（与 miss.ts 白名单同构）；
 *  - probeSetVersion 须匹配 /^v\d+(\.\d+)*$/；坏夹具抛 core 基类（Integrity/NotFound/Corrupted）；
 *  - 纯离线、无网络；模块顶层仅字面量常量、零求值；不 import 门面/store。
 *
 * C5 仅合成临时根夹具（id 指向合成数据）；真实 L0/L1/holdout 人工标注与真实 id 属 C6（I3）。
 */

import path from 'node:path';

import { IntegrityError } from '../../core/errors.ts';
import { parseJsonStrict, readFileStrict } from '../../core/fsx.ts';

/** 非空版本字符串（I7 冻结正则）。 */
export const PROBE_SET_VERSION_PATTERN = /^v\d+(\.\d+)*$/;

export type FixtureLayer = 'l0' | 'l1' | 'l2' | 'decoy' | 'abstain';

const SLOT_NAMES = ['guaranteed', 'recency', 'identity', 'relevance', 'obligation'] as const;
const INITIATIONS = ['her', 'user', 'environment'] as const;
const ALIAS_SOURCES = ['miss'] as const;
const HIGH_RISK_LABELS = ['strong', 'promise', 'date', 'verbatim', 'negation'] as const;

const L0_KEYS = [
  'eventId',
  'channel',
  'queries',
  'aliases',
  'sensitiveTerms',
  'discriminatorNeighborEventIds',
  'expectedSlots',
] as const;
const L1_KEYS = ['questionExperienceId', 'targetEventId', 'initiation', 'coldStart'] as const;
const DECOY_KEYS = ['pairCardIds', 'discriminatorQuery', 'goldCardId', 'highRiskLabel'] as const;
/** 弃权/噪声探针（§5.7）：只含问句与目标标注，goldCardId=null 表示库里无金标（期望弃权）。 */
const ABSTAIN_KEYS = ['query', 'goldCardId', 'kind'] as const;
const ABSTAIN_KINDS = ['unanswerable', 'noise'] as const;

/** L0 种子金标条目（§6.1：标准检索词/别名/敏感标记/判别近邻/窗口槽位）。 */
export interface GoldL0Item {
  eventId: string;
  channel: string;
  queries: readonly string[];
  aliases: ReadonlyArray<{ term: string; source: 'miss'; sensitive: 0 | 1 }>;
  sensitiveTerms: readonly string[];
  discriminatorNeighborEventIds: readonly string[];
  expectedSlots: ReadonlyArray<'guaranteed' | 'recency' | 'identity' | 'relevance' | 'obligation'>;
}

/** L1 回放金标条目（提问轮 → 目标事件；引发方分层 + 冷启动）。 */
export interface GoldL1Item {
  questionExperienceId: string;
  targetEventId: string;
  initiation: 'her' | 'user' | 'environment';
  coldStart: boolean;
}

/** DRM 诱饵条目（近邻对 + 判别提问 + 金标卡 + 可选高危标签）。 */
export interface DecoyItem {
  pairCardIds: readonly string[];
  discriminatorQuery: string;
  goldCardId: string;
  highRiskLabel?: 'strong' | 'promise' | 'date' | 'verbatim' | 'negation';
}

/**
 * 弃权/噪声探针条目（§5.7）。
 * - `unanswerable`：库中无目标，期望弃权/空；
 * - `noise`：一真卡混多张宽泛诱饵，期望真卡命中、诱饵弃权（噪声库）；
 * `goldCardId === null` 表示无金标（hasGold=false）；有值时该条既有金标语义。
 */
export interface AbstainItem {
  query: string;
  goldCardId: string | null;
  kind: 'unanswerable' | 'noise';
}

/** 加载后的夹具全集（四文件版本须一致）。 */
export interface LoadedFixtures {
  probeSetVersion: string;
  l0: readonly GoldL0Item[];
  l1: readonly GoldL1Item[];
  l2: readonly GoldL1Item[];
  decoy: readonly DecoyItem[];
}

function fail(label: string, index: number, reason: string): never {
  throw new IntegrityError(`夹具 ${label} 条目 ${index + 1}：${reason}`);
}

function asRecord(value: unknown, label: string, index: number): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(label, index, '条目须为对象');
  }
  return value as Record<string, unknown>;
}

function checkKeys(item: Record<string, unknown>, allowed: readonly string[], label: string, index: number): void {
  for (const key of Object.keys(item)) {
    if (!allowed.includes(key)) {
      fail(label, index, `非法字段 ${key}（只允许 id 与标注，拒收正文/多余字段）`);
    }
  }
}

function reqString(item: Record<string, unknown>, key: string, label: string, index: number): string {
  const value = item[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail(label, index, `${key} 须为非空字符串`);
  }
  return value;
}

function reqStringArray(item: Record<string, unknown>, key: string, label: string, index: number): string[] {
  const value = item[key];
  if (!Array.isArray(value)) {
    fail(label, index, `${key} 须为数组`);
  }
  return value.map((element, i) => {
    if (typeof element !== 'string' || element.length === 0) {
      fail(label, index, `${key}[${i}] 须为非空字符串`);
    }
    return element;
  });
}

function reqEnum<T extends string>(value: unknown, allowed: readonly T[], key: string, label: string, index: number): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(label, index, `${key} 须为枚举 {${allowed.join(',')}} 之一`);
  }
  return value as T;
}

function validateL0Item(raw: unknown, label: string, index: number): void {
  const item = asRecord(raw, label, index);
  checkKeys(item, L0_KEYS, label, index);
  reqString(item, 'eventId', label, index);
  reqString(item, 'channel', label, index);
  reqStringArray(item, 'queries', label, index);
  reqStringArray(item, 'sensitiveTerms', label, index);
  reqStringArray(item, 'discriminatorNeighborEventIds', label, index);
  const aliases = item['aliases'];
  if (!Array.isArray(aliases)) {
    fail(label, index, 'aliases 须为数组');
  }
  aliases.forEach((alias, i) => {
    const record = asRecord(alias, label, index);
    checkKeys(record, ['term', 'source', 'sensitive'], label, index);
    reqString(record, 'term', label, index);
    reqEnum(record['source'], ALIAS_SOURCES, `aliases[${i}].source`, label, index);
    if (record['sensitive'] !== 0 && record['sensitive'] !== 1) {
      fail(label, index, `aliases[${i}].sensitive 须为 0 或 1`);
    }
  });
  const slots = item['expectedSlots'];
  if (!Array.isArray(slots)) {
    fail(label, index, 'expectedSlots 须为数组');
  }
  slots.forEach((slot, i) => reqEnum(slot, SLOT_NAMES, `expectedSlots[${i}]`, label, index));
}

function validateL1Item(raw: unknown, label: string, index: number): void {
  const item = asRecord(raw, label, index);
  checkKeys(item, L1_KEYS, label, index);
  reqString(item, 'questionExperienceId', label, index);
  reqString(item, 'targetEventId', label, index);
  reqEnum(item['initiation'], INITIATIONS, 'initiation', label, index);
  if (typeof item['coldStart'] !== 'boolean') {
    fail(label, index, 'coldStart 须为布尔');
  }
}

function validateDecoyItem(raw: unknown, label: string, index: number): void {
  const item = asRecord(raw, label, index);
  checkKeys(item, DECOY_KEYS, label, index);
  const pairs = reqStringArray(item, 'pairCardIds', label, index);
  if (pairs.length < 2) {
    fail(label, index, 'pairCardIds 须至少含两张卡');
  }
  reqString(item, 'discriminatorQuery', label, index);
  reqString(item, 'goldCardId', label, index);
  if (item['highRiskLabel'] !== undefined) {
    reqEnum(item['highRiskLabel'], HIGH_RISK_LABELS, 'highRiskLabel', label, index);
  }
}

function validateAbstainItem(raw: unknown, label: string, index: number): void {
  const item = asRecord(raw, label, index);
  checkKeys(item, ABSTAIN_KEYS, label, index);
  reqString(item, 'query', label, index);
  reqEnum(item['kind'], ABSTAIN_KINDS, 'kind', label, index);
  const gold = item['goldCardId'];
  if (gold !== null && (typeof gold !== 'string' || gold.length === 0)) {
    fail(label, index, 'goldCardId 须为 null 或非空字符串');
  }
}

/**
 * 纯校验一份夹具文件（表驱动可单测）：版本正则 / layer 相符 / items 数组 / 逐条白名单形状。
 * 任何正文字段或多余键即拒收（I7）；坏形状抛 IntegrityError 带文件标签与条目号。
 */
export function validateFixtureFile(raw: unknown, expectedLayer: FixtureLayer, fileLabel: string): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IntegrityError(`夹具 ${fileLabel}：须为 JSON 对象`);
  }
  const obj = raw as Record<string, unknown>;
  const version = obj['probeSetVersion'];
  if (typeof version !== 'string' || !PROBE_SET_VERSION_PATTERN.test(version)) {
    throw new IntegrityError(`夹具 ${fileLabel}：probeSetVersion 须匹配 /^v\\d+(\\.\\d+)*$/`);
  }
  if (obj['layer'] !== expectedLayer) {
    throw new IntegrityError(`夹具 ${fileLabel}：layer 须为 ${expectedLayer}`);
  }
  const items = obj['items'];
  if (!Array.isArray(items)) {
    throw new IntegrityError(`夹具 ${fileLabel}：items 须为数组`);
  }
  items.forEach((item, index) => {
    if (expectedLayer === 'l0') {
      validateL0Item(item, fileLabel, index);
    } else if (expectedLayer === 'decoy') {
      validateDecoyItem(item, fileLabel, index);
    } else if (expectedLayer === 'abstain') {
      validateAbstainItem(item, fileLabel, index);
    } else {
      validateL1Item(item, fileLabel, index);
    }
  });
}

function loadOne(fixturesDir: string, fileName: string, layer: FixtureLayer): { version: string; items: readonly unknown[] } {
  const raw = parseJsonStrict<unknown>(readFileStrict(path.join(fixturesDir, fileName)), fileName);
  validateFixtureFile(raw, layer, fileName);
  const obj = raw as Record<string, unknown>;
  return { version: obj['probeSetVersion'] as string, items: obj['items'] as readonly unknown[] };
}

/**
 * 只读加载合成四文件（gold-l0/gold-l1/holdout/decoy.json）。
 * 缺文件抛 NotFoundError、JSON 坏抛 CorruptedError（core 基类）；跨文件版本不一致抛 IntegrityError。
 */
export function loadFixtures(fixturesDir: string): LoadedFixtures {
  const l0 = loadOne(fixturesDir, 'gold-l0.json', 'l0');
  const l1 = loadOne(fixturesDir, 'gold-l1.json', 'l1');
  const l2 = loadOne(fixturesDir, 'holdout.json', 'l2');
  const decoy = loadOne(fixturesDir, 'decoy.json', 'decoy');
  const version = l0.version;
  if (l1.version !== version || l2.version !== version || decoy.version !== version) {
    throw new IntegrityError('夹具四文件 probeSetVersion 不一致（须同版本）');
  }
  return {
    probeSetVersion: version,
    l0: l0.items as readonly GoldL0Item[],
    l1: l1.items as readonly GoldL1Item[],
    l2: l2.items as readonly GoldL1Item[],
    decoy: decoy.items as readonly DecoyItem[],
  };
}

/** 弃权/噪声探针夹具全集（与四文件相互独立，不并入 loadFixtures 契约）。 */
export interface LoadedAbstainFixtures {
  probeSetVersion: string;
  items: readonly AbstainItem[];
}

/** 探针是否有金标目标（goldCardId 非 null）。 */
export function abstainHasGold(item: AbstainItem): boolean {
  return item.goldCardId !== null;
}

/**
 * 只读加载 abstain.json（缺文件抛 NotFoundError、坏 JSON 抛 CorruptedError、坏形状抛 IntegrityError）。
 * 独立于 loadFixtures，既有四文件契约零变化；文件不存在由调用方决定是否容忍。
 */
export function loadAbstainFixtures(fixturesDir: string, fileName = 'abstain.json'): LoadedAbstainFixtures {
  const loaded = loadOne(fixturesDir, fileName, 'abstain');
  return { probeSetVersion: loaded.version, items: loaded.items as readonly AbstainItem[] };
}