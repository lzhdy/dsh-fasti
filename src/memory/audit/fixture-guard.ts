/**
 * P6 机械防自证加载守卫（v4 §6，一票否决 G3/G4）。
 *
 * 定位：编排层。`fixtures.ts` 纯校验器刻意不 import store、拿不到卡内 cue/key_points，
 * 故本模块独立成件——目标卡与事件要点由调用方（CLI/离线构造脚本）以只读引用注入，
 * 本模块不触库、不读文件系统、无时钟无随机。
 *
 * 覆盖：
 *  - G3 别名纪律：A 路线夹具零别名硬拒；B 路线 miss 别名必须 sensitive=1；
 *  - G4① 连续子串硬拒：S2–S4 查询不得是目标卡 cue/别名归一化后的连续子串；
 *  - G4② key_points 重合硬规则（S7 阈值未标定期间的回退口径，v4 §6.2）：查询归一化串
 *    包含任一要点归一化后的 ≥3 码点连续片段即剔；
 *  - G4③ 撰写源定位必填（P6 构造层条目），S1 占比 ≤0.25；
 *  - 指纹原语：夹具原文 sha256 与封存声明哈希一致性（封存工程在 §9 序 9 接入）。
 */

import { IntegrityError } from '../../core/errors.ts';
import { sha256Hex } from '../content-hash.ts';
import { normalizeLexicalText } from '../gate.ts';
import type { ConstructionLayer, GoldL0Item } from './fixtures.ts';

/** 守卫所需的目标卡词面（由调用方从只读柄投影，避免本模块 import store）。 */
export interface GuardCardRef {
  readonly eventId: string;
  readonly cues: readonly string[];
  readonly aliases: ReadonlyArray<{ readonly term: string; readonly source: string; readonly sensitive: 0 | 1 }>;
}

/** S1 片段占原话码点冻结上限（v4 §3：≤25%）。 */
export const S1_MAX_CHAR_SHARE = 0.25;
/** key_points 重合硬规则的连续片段码点下限（v4 §6.2）。 */
export const KEY_POINT_FRAGMENT_CODEPOINTS = 3;
/** 适用 G4① 连续子串硬规则的构造层（换述层禁止抄目标卡词面；S5 指代句天然含事件细节，不适用）。 */
const PARAPHRASE_LAYERS: ReadonlySet<ConstructionLayer> = new Set(['S2', 'S3', 'S4']);
/** 适用 G4② key_points 重合硬规则的构造层（v5 §8.2 N3：S5 一并纳入）。 */
const KEYPOINT_GUARD_LAYERS: ReadonlySet<ConstructionLayer> = new Set(['S2', 'S3', 'S4', 'S5']);

function reject(reason: string): never {
  throw new IntegrityError(`P6 夹具防自证硬拒：${reason}`);
}

/** G3-A：A 路线评测夹具零别名注入，任一条目带 aliases 即整份拒收。 */
export function assertAZeroAliases(items: readonly GoldL0Item[]): void {
  items.forEach((item, index) => {
    if (item.aliases.length > 0) {
      reject(`条目 ${index + 1}（eventId=${item.eventId}）A 路线夹具禁止注入任何别名（G3）`);
    }
  });
}

/** G3-B：B 路线评测夹具的 miss 别名必须 sensitive=1（生产恒 1，E-12）。 */
export function assertMissAliasesSensitive(items: readonly GoldL0Item[]): void {
  items.forEach((item, index) => {
    item.aliases.forEach((alias, aliasIndex) => {
      if (alias.source === 'miss' && alias.sensitive !== 1) {
        reject(
          `条目 ${index + 1} aliases[${aliasIndex}] miss 别名「${alias.term}」sensitive 必须为 1（G3/E-12，生产不存在 sensitive=0 召回面）`,
        );
      }
    });
  });
}

/**
 * G4①：S2–S4 查询不得是目标卡任一 cue/别名归一化后的连续子串。
 * 命中即拒（整份夹具拒收由调用方按条目传播）。
 */
export function isCueOrAliasSubstring(query: string, card: GuardCardRef): boolean {
  const qNorm = normalizeLexicalText(query);
  if (qNorm === '') {
    return false;
  }
  const surfaces = [...card.cues, ...card.aliases.map((alias) => alias.term)];
  return surfaces.some((surface) => {
    const sNorm = normalizeLexicalText(surface);
    return sNorm !== '' && sNorm.includes(qNorm);
  });
}

/** 取字符串的全部指定长度码点滑窗（数组形态，避免代理对误切）。 */
function codepointWindows(text: string, size: number): string[] {
  const points = Array.from(text);
  if (points.length < size) {
    return [];
  }
  const windows: string[] = [];
  for (let i = 0; i + size <= points.length; i += 1) {
    windows.push(points.slice(i, i + size).join(''));
  }
  return windows;
}

/**
 * G4② 回退硬规则：查询归一化串包含任一 key_point 归一化后的 ≥3 码点连续片段即判重合。
 * S7 比例阈值标定前使用本规则，不依赖任何可调参数（v4 §6.2/M6）。
 */
export function sharesKeyPointFragment(query: string, keyPoints: readonly string[]): boolean {
  const qNorm = normalizeLexicalText(query);
  if (qNorm === '') {
    return false;
  }
  return keyPoints.some((point) => {
    const pNorm = normalizeLexicalText(point);
    if (Array.from(pNorm).length < KEY_POINT_FRAGMENT_CODEPOINTS) {
      return false;
    }
    return codepointWindows(pNorm, KEY_POINT_FRAGMENT_CODEPOINTS).some((fragment) => qNorm.includes(fragment));
  });
}

/**
 * G4③：P6 构造层条目必须带撰写源定位；S1 另须带 ≤0.25 的原话码点占比。
 */
export function assertProvenanceFields(item: GoldL0Item): void {
  if (item.constructionLayer === undefined) {
    return;
  }
  if (item.sourceLocation === undefined) {
    reject(`eventId=${item.eventId}（${item.constructionLayer}）缺撰写源定位 sourceLocation（G4③）`);
  }
  if (item.constructionLayer === 'S1') {
    if (typeof item.sourceCharShare !== 'number' || Number.isNaN(item.sourceCharShare)) {
      reject(`eventId=${item.eventId}（S1）缺 sourceCharShare 原话码点占比`);
    } else if (item.sourceCharShare > S1_MAX_CHAR_SHARE) {
      reject(`eventId=${item.eventId}（S1）sourceCharShare=${item.sourceCharShare} 超过冻结上限 ${S1_MAX_CHAR_SHARE}`);
    }
  }
}

/**
 * 单条 P6 金标条目守卫（按条目调用，失败即抛 IntegrityError）。
 * @param item 金标条目（须带 constructionLayer；无层标的旧骨架条目跳过 G4）
 * @param card 目标卡引用；找不到目标卡直接拒收（悬空金标不允许静默放过）
 * @param keyPoints 目标事件 key_points（G4② 比对对象，禁止拿 cue/summary 替代）
 */
export function assertP6GoldItem(
  item: GoldL0Item,
  card: GuardCardRef | undefined,
  keyPoints: readonly string[],
): void {
  if (item.constructionLayer === undefined) {
    return;
  }
  assertProvenanceFields(item);
  if (card === undefined) {
    reject(`eventId=${item.eventId}（${item.constructionLayer}）在临时根找不到目标卡，金标悬空`);
  }
  if (!KEYPOINT_GUARD_LAYERS.has(item.constructionLayer)) {
    return;
  }
  const paraphrase = PARAPHRASE_LAYERS.has(item.constructionLayer);
  for (const [queryIndex, query] of item.queries.entries()) {
    if (paraphrase && isCueOrAliasSubstring(query, card)) {
      reject(
        `${item.constructionLayer} 查询[${queryIndex}]「${query}」是目标卡 cue/别名的连续子串（G4①，换述层禁止抄词面）`,
      );
    }
    if (sharesKeyPointFragment(query, keyPoints)) {
      reject(
        `${item.constructionLayer} 查询[${queryIndex}]「${query}」与 key_points 存在 ≥${KEY_POINT_FRAGMENT_CODEPOINTS} 码点连续重合（G4② 回退硬规则）`,
      );
    }
  }
}

/** 指纹原语：夹具原文 sha256 与封存声明哈希不一致即拒（封存清单见 v4 §8）。 */
export function assertFixtureFingerprint(rawText: string, declaredSha256: string): void {
  const actual = sha256Hex(rawText);
  if (actual !== declaredSha256) {
    reject(`夹具指纹不符（期望 ${declaredSha256}，实算 ${actual}），封存完整性 G6 不通过`);
  }
}
