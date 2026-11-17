/**
 * #124 生产路径 mini-bench（段4 验收取数，charter §6）。
 *
 * 数据来源：tests/memory/iso-write-line.real-run.log.txt 的 8 个真实桥段
 * （真模型 SCNet-Max 产出的 cues）＋ 16 条真人问法，逐字照抄，不重造、
 * 不在本脚本里改写任何一句。8 卡全部经生产路径 writeCards + syncFts 写入内存库。
 *
 * 四项取数（charter §6 验收口径）：
 *  1. 整句直打召回：预期仍 0/16（收益只在短词，本次几何不改变长句图情）；
 *  2. 短词直打召回：本次改造的真实收益面（改造前结构性 0）；
 *  3. 门后错卡率：门放行集合里非正确卡的条数，红线＝0；
 *  4. FTS 体积：mem_card_fts.cue_text 的字符总量 / 原始 cue 串总量，上限 1.95×。
 *
 * 生产码零改动；临时内存库；不落盘、不碰真根。
 * 运行：node tests/memory/bigram-mini-bench.ts
 */

import { DatabaseSync } from 'node:sqlite';

import { computeContentHash } from '../../src/memory/builder.ts';
import { searchCardsExplained } from '../../src/memory/bm25.ts';
import { applyGate } from '../../src/memory/gate.ts';
import { normalizeLexicalText } from '../../src/memory/gate.ts';
import { MEMORY_SCHEMA } from '../../src/memory/schema.ts';
import { writeCards } from '../../src/memory/store.ts';
import { syncFts } from '../../src/memory/fts.ts';
import type { MemoryCard } from '../../src/memory/types.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const DEBUG = process.env['BENCH_DEBUG'] === '1';

/** 8 个真实桥段（真模型 cue 逐字照抄）。 */
const BRIDGES: Array<{ id: string; cues: string[] }> = [
  { id: 'b1', cues: ['上周去重庆出差', '酒店发票抬头开成公司老名字', '询问发票能否重开'] },
  { id: 'b2', cues: ['12 人', '每人 1.5 平方米', '询问会议室所需面积'] },
  {
    id: 'b3',
    cues: ['线上记忆服务使用 sqlite 时频繁出现 database is locked', '用户询问该问题是否由并发写入过多导致'],
  },
  { id: 'b4', cues: ['计划约张蒙在下周三下午过 q4 技术方案', '询问如何排期'] },
  { id: 'b5', cues: ['用户不喜冰饮', '点奶茶时要求常温'] },
  { id: 'b6', cues: ['荷花数量每天翻倍', '第 30 天长满整个池子', '询问长到一半是在第几天'] },
  { id: 'b7', cues: ['提问内容:async 函数未使用 await 的潜在问题'] },
  { id: 'b8', cues: ['目的地:成都', '行程时长:三天', '时间:国庆期间'] },
];

/** 16 条真人问法（日志逐字照抄），附正确桥段 id。 */
const SENTENCES: Array<{ q: string; expected: string }> = [
  { q: '我那个重庆酒店的发票抬头写错了怎么办', expected: 'b1' },
  { q: '上次说的发票重开', expected: 'b1' },
  { q: '12 个人开会要多大房间', expected: 'b2' },
  { q: '那个会议室算出来多少平', expected: 'b2' },
  { q: 'sqlite 锁库那个问题怎么解决的', expected: 'b3' },
  { q: '记忆服务老是 locked', expected: 'b3' },
  { q: '跟张蒙约的 Q4 方案评审排到什么时候了', expected: 'b4' },
  { q: '下周那个技术方案会', expected: 'b4' },
  { q: '我奶茶要常温还是冰的', expected: 'b5' },
  { q: '点奶茶有什么讲究', expected: 'b5' },
  { q: '荷花那个题答案是多少', expected: 'b6' },
  { q: '第几天长满一半', expected: 'b6' },
  { q: '那个没 await 的地方后来怎么改了', expected: 'b7' },
  { q: 'async 没 await 那段', expected: 'b7' },
  { q: '国庆成都那趟怎么安排的', expected: 'b8' },
  { q: '带老人去成都的行程', expected: 'b8' },
];

/** 短词问法（2–4 字，人真实会打的口语短词），附正确桥段。 */
const SHORT_WORDS: Array<{ q: string; expected: string }> = [
  { q: '发票', expected: 'b1' },
  { q: '重庆', expected: 'b1' },
  { q: '会议室', expected: 'b2' },
  { q: '平方米', expected: 'b2' },
  { q: '锁库', expected: 'b3' },
  { q: '技术方案', expected: 'b4' },
  { q: '张蒙', expected: 'b4' },
  { q: '奶茶', expected: 'b5' },
  { q: '常温', expected: 'b5' },
  { q: '荷花', expected: 'b6' },
  { q: 'await', expected: 'b7' },
  { q: '成都', expected: 'b8' },
  { q: '国庆', expected: 'b8' },
];

function mkCard(id: string, cues: string[], occurredMs: number): MemoryCard {
  const anchorJson = `["exp-${id}"]`;
  const displayCuesJson = JSON.stringify(cues);
  const aliasesJson = '[]';
  return {
    cardId: `mc_${id}`,
    eventId: `evt_${id}`,
    anchorJson,
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator: `disc-${id}`,
    entityHintJson: null,
    occurredMs,
    endedMs: occurredMs + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, `disc-${id}`),
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
}

interface Metrics {
  candidateZero: number;
  acceptedZero: number;
  correctHit: number;
  wrongAccepted: number;
  total: number;
}

function runArm(
  db: DatabaseSync,
  arm: string,
  queries: Array<{ q: string; expected: string }>,
): Metrics {
  const m: Metrics = { candidateZero: 0, acceptedZero: 0, correctHit: 0, wrongAccepted: 0, total: queries.length };
  for (const item of queries) {
    const explained = searchCardsExplained(db, { text: item.q, atMs: T0 + 10 * DAY });
    const qNorm = normalizeLexicalText(item.q);
    const gated = applyGate({ qNorm, candidates: explained });
    // 门层按 cardId 取数（accepted 是 GatedRankedCard 带上 gateReasons，不含 serial 字段）。
    const acceptedCardIds = gated.accepted.map((row) => row.card.cardId);
    const expectedCardId = `mc_${item.expected}`;
    if (explained.length === 0) m.candidateZero += 1;
    if (acceptedCardIds.length === 0) m.acceptedZero += 1;
    if (acceptedCardIds.includes(expectedCardId)) m.correctHit += 1;
    // 门后错卡：放行集合里任何非正确卡，红线恒 0。
    m.wrongAccepted += acceptedCardIds.filter((cardId) => cardId !== expectedCardId).length;
    // 拒因直方图（诊断用，首版只打一次到 stderr）。
    if (DEBUG) {
      const reasons = gated.rejected.map((row) => row.gateReasons.join('+'));
      console.error(`  [${arm}] ${item.q} 候选=${explained.length} 过门=${acceptedCardIds.length} 拒因=${reasons.join('|')}`);
    }
  }
  return m;
}

function main(): void {
  const db = new DatabaseSync(':memory:');
  for (const statement of MEMORY_SCHEMA) {
    db.exec(statement);
  }
  const cards = BRIDGES.map((bridge, index) => mkCard(bridge.id, bridge.cues, T0 + index * DAY));
  writeCards(db, cards);
  syncFts(
    db,
    cards.map((card) => card.cardId),
  );

  const whole = runArm(db, '整句直打', SENTENCES);
  const short = runArm(db, '短词直打', SHORT_WORDS);

  // FTS 体积：cue_text 字符总量 vs 原始 cue 串（空格连接）字符总量。
  let ftsChars = 0;
  for (const row of db.prepare('SELECT cue_text FROM mem_card_fts').all() as Array<{ cue_text: string }>) {
    ftsChars += row.cue_text.length;
  }
  let rawChars = 0;
  for (const bridge of BRIDGES) {
    rawChars += bridge.cues.join(' ').length;
  }
  const ratio = ftsChars / rawChars;

  const line = (name: string, m: Metrics): string =>
    `${name.padEnd(12)} 候选归零 ${String(m.candidateZero).padStart(2)}/${m.total}  门层归零 ${String(
      m.acceptedZero,
    ).padStart(2)}/${m.total}  正确卡命中 ${m.correctHit}/${m.total}  门后错卡 ${m.wrongAccepted}`;

  console.log('════ #124 mini-bench（8 真实卡 / 16 真人整句 / 13 短词）════');
  console.log(line('真人整句直打', whole));
  console.log(line('短词直打', short));
  console.log(
    `FTS 体积   ${ftsChars} / ${rawChars} 字符 = ${ratio.toFixed(3)}×（上限 1.95×，${
      ratio <= 1.95 ? 'PASS' : 'FAIL'
    }）`,
  );
  console.log(line.length === 0 ? '' : `门后错卡红线：整句 ${whole.wrongAccepted} / 短词 ${short.wrongAccepted}（须 0）`);
  db.close();
}

main();
