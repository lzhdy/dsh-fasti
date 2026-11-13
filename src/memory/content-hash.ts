/**
 * 记忆层确定性哈希共享低层（N1 无环抽取，自 builder.ts 原样搬入）。
 *
 * 无环纪律：本模块只依赖 node 内置 crypto 与字符串/数组全局，**不 import 任何 memory 内模块**
 * （不依赖 store/builder/bm25），供 builder、store 别名窄写等共同引用，杜绝 `…→builder→store→…`
 * 环。tests/memory/layer-imports.test.ts 对该约束做静态断言与投毒自证。
 *
 * 本模块为纯移动：公式、命名、返回值与抽取前逐字一致，落点变更不得改变任何哈希输出（零漂移）。
 */

import { createHash } from 'node:crypto';

/** 统一 sha256 hex 口径（H11）。 */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 确定性卡 id：'mc_'+sha256(规范化串).slice(0,32)；锚点排序后规范化 → 序无关。 */
export function deriveCardId(eventId: string, anchorIds: readonly string[]): string {
  const canonical = JSON.stringify([eventId, [...anchorIds].sort()]);
  return `mc_${sha256Hex(canonical).slice(0, 32)}`;
}

/** 内容哈希：锚点+线索字段规范化后的 sha256（幂等与账本核对用）。 */
export function computeContentHash(
  anchorJson: string,
  displayCuesJson: string,
  aliasesJson: string,
  discriminator: string,
): string {
  return sha256Hex(JSON.stringify([anchorJson, displayCuesJson, aliasesJson, discriminator]));
}
