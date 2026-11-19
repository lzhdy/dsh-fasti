/**
 * #126 rules-v2 全链路防守夹具（R-04）：searchCardsExplainedV2 宽召回 → applyGateV2 严格裁决，
 * 用仓库内小型合成世界固化阶段 0 e5 的三类攻击结论（封存 350 题不进仓库，这里只留最小同构夹具）：
 *  ① 簇内近邻调包：共享 bigram 的两张卡，证据完整者唯一过门、绝不黏错；
 *  ② 库外题材/剥实词噪声：零硬提交（wrong-commit=0），该弃权必弃权；
 *  ③ 仅 bigram 重合、无线索字段完整包含：宽召回可以捞，门必须拒。
 * 纪律：临时根、atMs 注入、无 Date.now()、只读真实数据根零接触。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { searchCardsExplainedV2 } from '../../src/memory/bm25.ts';
import { computeContentHash } from '../../src/memory/builder.ts';
import { applyGateV2, normalizeLexicalText } from '../../src/memory/gate.ts';
import {
  MEMORY_INDEX_FILE,
  openMemoryWrite,
} from '../../src/memory/store.ts';
import type {
  AliasRow,
  MemoryCard,
  RevisionRecord,
} from '../../src/memory/types.ts';
import { DatabaseSync } from 'node:sqlite';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const AT = T0 + 30 * DAY;

interface Spec {
  cardId: string;
  cues: string[];
}

const CORPUS: Spec[] = [
  { cardId: 'mc_date_coffee', cues: ['周三晚上咖啡馆约会'] },
  { cardId: 'mc_cat_coffee', cues: ['咖啡馆老板聊养猫'] },
  { cardId: 'mc_gym', cues: ['健身房私教课训练'] },
  { cardId: 'mc_library', cues: ['图书馆靠窗自习'] },
];

function mkCard(spec: Spec): { card: MemoryCard; aliasRows: AliasRow[] } {
  const anchorJson = JSON.stringify([`exp-${spec.cardId}`]);
  const displayCuesJson = JSON.stringify(spec.cues);
  const aliasesJson = JSON.stringify([]);
  const card: MemoryCard = {
    cardId: spec.cardId,
    eventId: `evt-${spec.cardId}`,
    anchorJson,
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson,
    aliasesJson,
    discriminator: `disc-${spec.cardId}`,
    entityHintJson: null,
    occurredMs: T0,
    endedMs: T0 + DAY,
    validMs: T0,
    invalidMs: null,
    createdMs: T0,
    expiredMs: null,
    status: 'active',
    contentHash: computeContentHash(anchorJson, displayCuesJson, aliasesJson, `disc-${spec.cardId}`),
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  return { card, aliasRows: [] };
}

async function seed(): Promise<{ root: string; file: string }> {
  const root = makeTempRoot('v2-pipeline-');
  const indexDir = path.join(root, 'projection', 'memory-index');
  const cards = CORPUS.map((spec) => mkCard(spec).card);
  const handle = openMemoryWrite({ indexDir });
  try {
    const revision: RevisionRecord = {
      revision: 1,
      slug: 'build',
      at_ms: T0,
      schema_version: 3,
      truth_fingerprint: 'fp-v2-pipeline',
      prior_revision: null,
      card_count: cards.length,
      alias_count: 0,
      row_hash_sum: 'rh-v2-pipeline',
      shadow_diff: { added: cards.length, removed: 0, changed: 0 },
      reason: 'test fixture',
      operator: 'offline-cli',
    };
    handle.transactionApply({ cards, aliases: [] }, revision, []);
  } finally {
    await handle.close();
  }
  return { root, file: path.join(indexDir, MEMORY_INDEX_FILE) };
}

function ask(db: DatabaseSync, text: string) {
  const candidates = searchCardsExplainedV2(db, { text, atMs: AT, limit: undefined });
  return applyGateV2({ qNorm: normalizeLexicalText(text), candidates });
}

test('R-04① 簇内近邻调包：共享 bigram 的两卡，证据完整者唯一过门、绝不黏错', async () => {
  const { root, file } = await seed();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const dateAsk = ask(db, '周三晚上咖啡馆约会我迟到了');
    assert.equal(dateAsk.status, 'hit');
    assert.deepEqual(dateAsk.accepted.map((c) => c.card.cardId), ['mc_date_coffee']);

    const catAsk = ask(db, '咖啡馆老板聊养猫这件事很有意思');
    assert.equal(catAsk.status, 'hit');
    assert.deepEqual(catAsk.accepted.map((c) => c.card.cardId), ['mc_cat_coffee']);
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

test('R-04② 库外题材与剥实词噪声：零硬提交，全部弃权且不指错卡', async () => {
  const { root, file } = await seed();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const probes = [
      '量子纠缠实验该怎么复现', // 库外题材，词面无字段完整包含
      '那个这个怎么样来着啊', // 剥光实义词的外壳噪声
      '今天天气好像还可以', // 日常库外句
    ];
    for (const text of probes) {
      const outcome = ask(db, text);
      assert.notEqual(outcome.status, 'hit', `库外/噪声句不得硬提交：${text}`);
      assert.equal(outcome.accepted.length, 0);
    }
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});

test('R-04③ 仅 bigram 重合无线索完整包含：宽召回捞得到但门拒（wrong-commit=0）', async () => {
  const { root, file } = await seed();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // “喝咖啡的馆子”与线索共享“咖啡/啡馆”bigram，但没有任何线索字段完整出现于问句。
    const candidates = searchCardsExplainedV2(db, { text: '喝咖啡的馆子', atMs: AT, limit: undefined });
    assert.ok(candidates.length > 0, 'OR 宽召回确实捞回了共享 bigram 的卡');
    const outcome = applyGateV2({ qNorm: normalizeLexicalText('喝咖啡的馆子'), candidates });
    assert.equal(outcome.status, 'abstain');
    assert.equal(outcome.accepted.length, 0);
    assert.ok(outcome.rejected.every((c) => c.gateReasons.includes('no-containment')));
  } finally {
    db.close();
    cleanupTempRoot(root);
  }
});
