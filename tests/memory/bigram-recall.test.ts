/**
 * #124 bigram 端到端召回红测（charter §9 红测 3/4/5 的真实库走柄验证）。
 *
 * 与 bm25.test 的函数级用例互补：本文件全部经 openMemoryWrite 建临时库、
 * openMemoryRead 走只读柄 search（含几何窗口校验＋原文复核全链路）。
 *
 * 覆盖：
 *  - 红测3：2 字最短可召回；3/4 字专名相邻 phrase 命中，共享单个 bigram 的含字异卡不误撞；
 *  - 红测4：词首非 ASCII 归一化脱落在真实链路由原文复核拒收（不只函数级）；
 *  - 红测5：空格分隔的孤立单字发 unigram，多段查询经 phrase 相邻命中；纯单字仍走 LIKE 冻结语义。
 * 纪律：临时根、真实数据根零接触、atMs 注入、断言按 cardId 集合比对。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { emitUnits, ftsPhraseOf } from '../../src/memory/bigram.ts';
import { computeContentHash } from '../../src/memory/builder.ts';
import { MEMORY_INDEX_FILE, openMemoryRead, openMemoryWrite } from '../../src/memory/store.ts';
import type {
  AliasRow,
  MemoryCard,
  RevisionRecord,
} from '../../src/memory/types.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const AT = T0 + 30 * DAY;

function mkCard(cardId: string, cues: string[], occurredMs = T0): MemoryCard {
  const anchorJson = `["exp-${cardId}"]`;
  const displayCuesJson = JSON.stringify(cues);
  const aliasesJson = '[]';
  return {
    cardId,
    eventId: `evt-${cardId}`,
    anchorJson,
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator: `disc-${cardId}`,
    entityHintJson: null,
    occurredMs,
    endedMs: occurredMs + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, `disc-${cardId}`),
    hitCount: 0,
    lastHitMs: null,
    // 卡行契约版本冻结为 1（与库级 schema_version=3 区分，#124 charter §3.2）。
    schemaVersion: 1,
  };
}

async function buildIndex(cards: MemoryCard[]): Promise<{ root: string; indexDir: string }> {
  const root = makeTempRoot('bigram-recall-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const handle = openMemoryWrite({ indexDir });
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 3,
      truth_fingerprint: 'fp-bigram-recall',
      prior_revision: null,
      card_count: cards.length,
      alias_count: 0,
      row_hash_sum: 'rh-bigram-recall',
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    handle.transactionApply({ cards, aliases: [] as AliasRow[] }, revision, []);
  } finally {
    await handle.close();
  }
  return { root, indexDir };
}

async function hitIds(indexDir: string, text: string): Promise<string[]> {
  const read = openMemoryRead({ indexDir });
  try {
    const ranked = await read.search({ text, atMs: AT });
    return ranked.map((entry) => entry.card.cardId);
  } finally {
    await read.close();
  }
}

test('红测3：2 字最短召回，3 字查询不撞共享单 bigram 的含字异卡，4 字专名正常命中', async () => {
  const cards = [
    mkCard('c_ha', ['哈尔滨冰雪节']),
    mkCard('c_er', ['尔滨花园']), // 与哈尔滨共享 bigram「尔滨」，但不含「哈尔」
    mkCard('c_tp', ['通货膨胀控制']),
  ];
  const { root, indexDir } = await buildIndex(cards);
  try {
    // 2 字最短：两卡都含 bigram「尔滨」，正确超集召回。
    assert.deepEqual((await hitIds(indexDir, '尔滨')).sort(), ['c_er', 'c_ha']);
    // 3 字相邻 phrase：只有哈尔滨卡同时含「哈尔」「尔滨」相邻序列。
    assert.deepEqual(await hitIds(indexDir, '哈尔滨'), ['c_ha']);
    // 4 字专名整体可召回。
    assert.deepEqual(await hitIds(indexDir, '通货膨胀'), ['c_tp']);
    // 任意长度都不是只保留 2 字：3/4 字查询本身正常工作。
    assert.deepEqual(await hitIds(indexDir, '哈尔滨冰雪节'), ['c_ha']);
  } finally {
    cleanupTempRoot(root);
  }
});

test('红测4：真实柄全链路下词首非 ASCII 脱落的物理超集由原文复核拒收', async () => {
  const cards = [mkCard('c_apfel', ['ÄPFEL 果园'])];
  const { root, indexDir } = await buildIndex(cards);
  try {
    // emitUnits('äpfel') 脱落词首 → ['pfel']，FTS 物理超集命中；原文复核侧 Ä 不做大小写折叠，
    // 'Äpfel 果园' 不含 'äpfel' → 拒收（与 bm25.test 函数级用例同一事实的端到端走柄验证）。
    assert.deepEqual(await hitIds(indexDir, 'äpfel'), []);
    // 原样大写输入经 asciiLower 后与 cue 归一化结果一致，正常命中。
    assert.deepEqual(await hitIds(indexDir, 'ÄPFEL'), ['c_apfel']);
  } finally {
    cleanupTempRoot(root);
  }
});

test('红测5：孤立单字发 unigram，多段查询 phrase 相邻命中；纯单字维持 LIKE 冻结语义', async () => {
  const cards = [
    mkCard('c_iso', ['冰 美式咖啡']),
    // 两个被空格分隔的孤立单字：该卡唯一的 FTS 单元就是两个 unigram，变异删 unigram 后必不可达。
    mkCard('c_uni', ['冰 茶']),
  ];
  const { root, indexDir } = await buildIndex(cards);
  try {
    // 孤立「冰」unigram＋latin/CJK 段「美式咖啡」bigram 在列中相邻，多段查询可命中。
    assert.deepEqual(await hitIds(indexDir, '冰 美式'), ['c_iso']);
    // 2 字词正常命中。
    assert.deepEqual(await hitIds(indexDir, '美式'), ['c_iso']);
    // 纯 unigram 卡：两个孤立单字的 phrase 相邻命中，端到端钉死 unigram 发射不可删（变异②）。
    assert.deepEqual(await hitIds(indexDir, '冰 茶'), ['c_uni']);
    // 纯单字、无活跃非敏感别名 → LIKE 回退不可达（冻结语义，零功能面回归）。
    assert.deepEqual(await hitIds(indexDir, '冰'), []);
  } finally {
    cleanupTempRoot(root);
  }
});

test('红测3 物理守护：phrase 引号承担 token 相邻约束，去包裹退化为 AND 会吸入非相邻卡（变异⑤）', async () => {
  const cards = [
    mkCard('c_exact', ['哈尔滨']), // 单元「哈尔」「尔滨」相邻
    mkCard('c_gap', ['哈尔的尔滨']), // 含同两个单元但中间隔「尔的」「的尔」，不相邻
  ];
  const { root, indexDir } = await buildIndex(cards);
  try {
    const db = new DatabaseSync(path.join(indexDir, MEMORY_INDEX_FILE), { readOnly: true });
    try {
      const units = emitUnits('哈尔滨');
      const match = (expr: string): string[] =>
        (
          db
            .prepare('SELECT card_id FROM mem_card_fts WHERE mem_card_fts MATCH ?')
            .all(expr) as Array<{ card_id: string }>
        ).map((row) => row.card_id);
      // 生产形态：phrase 要求两单元相邻，非相邻卡物理零行。
      assert.deepEqual(match(ftsPhraseOf(units)), ['c_exact']);
      // 对照：去掉引号退化为隐式 AND，两卡都被吸入——证明相邻约束确实只由 phrase 包裹提供。
      assert.deepEqual(match(units.join(' ')).sort(), ['c_exact', 'c_gap']);
    } finally {
      db.close();
    }
  } finally {
    cleanupTempRoot(root);
  }
});
