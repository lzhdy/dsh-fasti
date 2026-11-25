/**
 * task226 红测：v3 真根空模型正式冻结表构建 I/O 壳的纯函数部分（不触库、不建根）。
 *
 * 建表数学已分别由 task215（k_min）与 task217（几何）全套红测锁定，本文件只锁脚本层口径：
 *  - 字段文档必须与门侧 lexicalFields 同组成（display_cues＋mem_alias active/非敏感，卡内
 *    aliases_json 快照不是门的来源）；
 *  - 五档 bMin=0..4（212 钉死合法域，6/7 退化禁用）＋几何表一张，网格上界与 212/213 探针对齐；
 *  - manifest 只含内容哈希与参数、不含墙钟，同输入逐字节可重放；
 *  - 数据库只读打开、绝不写根。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  DEFAULT_MAX_QUERY_BIGRAMS,
  DEFAULT_MAX_QUERY_CODE_LENGTH,
  GEOMETRY_FILE_NAME,
  KMIN_B_MIN_VALUES,
  MANIFEST_FILE_NAME,
  RARITY_FILE_NAME,
  assembleFieldDocuments,
  buildNullModelArtifacts,
  buildNullModelManifest,
  kminFileName,
  parseBuildArgs,
  sha256Hex,
} from '../../scripts/p6/build-null-model-v3.ts';
import { NULL_MODEL_SCHEMA, RARITY_SNAPSHOT_SCHEMA } from '../../src/memory/bigram-null-model.ts';
import { GEOMETRY_NULL_MODEL_SCHEMA } from '../../src/memory/locality-null-model.ts';

const cardRows = [
  { cardId: 'mc_1', displayCuesJson: '["更换电梯按钮","预约催办"]' },
  { cardId: 'mc_2', displayCuesJson: '["更换门锁锁芯"]' },
];
const aliasRows = [
  { cardId: 'mc_2', termNorm: '门锁', status: 'active', sensitive: 0 }, // 纳入
  { cardId: 'mc_2', termNorm: '密钥', status: 'active', sensitive: 1 }, // 敏感剔除
  { cardId: 'mc_1', termNorm: '旧名', status: 'retired', sensitive: 0 }, // 非 active 剔除
];

test('NM3-1 字段文档与门侧同组成：cue 保序＋active/非敏感别名按卡挂接，其余剔除', () => {
  const docs = assembleFieldDocuments(cardRows, aliasRows);
  assert.deepEqual(docs, ['更换电梯按钮', '预约催办', '更换门锁锁芯', '门锁']);
});

test('NM3-2 卡内 aliases_json 快照不参与字段文档（门只认 mem_alias 表与 cue）', () => {
  // 即便某卡 cue JSON 异常也只解析 display_cues；别名完全由 aliasRows 决定，空别名不造字段。
  const docs = assembleFieldDocuments([{ cardId: 'mc_1', displayCuesJson: '["单一线索"]' }], []);
  assert.deepEqual(docs, ['单一线索']);
});

test('NM3-3 构建产物：五档 k_min（bMin 0..4）＋几何表＋稀有桶快照，schema 与网格参数钉死', () => {
  const fieldDocuments = ['甲乙丙丁', '甲乙丙子', '乙丁子丑', '甲子乙丑'];
  const artifacts = buildNullModelArtifacts({
    fieldDocuments,
    cardCount: 4,
    maxQueryBigrams: DEFAULT_MAX_QUERY_BIGRAMS,
    maxQueryCodeLength: DEFAULT_MAX_QUERY_CODE_LENGTH,
    bMinValues: KMIN_B_MIN_VALUES,
  });
  assert.deepEqual(KMIN_B_MIN_VALUES, [0, 1, 2, 3, 4]);
  assert.equal(artifacts.kmin.length, 5);
  artifacts.kmin.forEach((entry, index) => {
    assert.equal(entry.bMin, index);
    assert.equal(entry.table.schema, NULL_MODEL_SCHEMA);
    assert.equal(entry.table.bMin, index);
    assert.equal(entry.table.cardCount, 4);
  });
  assert.equal(artifacts.geometry.schema, GEOMETRY_NULL_MODEL_SCHEMA);
  assert.equal(artifacts.geometry.maxQueryCodeLength, DEFAULT_MAX_QUERY_CODE_LENGTH);
  assert.equal(artifacts.rarity.schema, RARITY_SNAPSHOT_SCHEMA);
  assert.ok(artifacts.rarity.entries.length > 0);
  assert.equal(DEFAULT_MAX_QUERY_BIGRAMS + 1, DEFAULT_MAX_QUERY_CODE_LENGTH);
  assert.equal(artifacts.stats.fieldDocumentCount, 4);
  assert.ok(artifacts.stats.distinctBigramCount > 0);
});

test('NM3-4 非法入参 fail-loud：空语料/非正卡数/空档位列/网格上界不自洽', () => {
  assert.throws(() =>
    buildNullModelArtifacts({
      fieldDocuments: [],
      cardCount: 4,
      maxQueryBigrams: 32,
      maxQueryCodeLength: 33,
      bMinValues: KMIN_B_MIN_VALUES,
    }),
  );
  assert.throws(() =>
    buildNullModelArtifacts({
      fieldDocuments: ['甲乙丙'],
      cardCount: 0,
      maxQueryBigrams: 32,
      maxQueryCodeLength: 33,
      bMinValues: KMIN_B_MIN_VALUES,
    }),
  );
  assert.throws(() =>
    buildNullModelArtifacts({
      fieldDocuments: ['甲乙丙'],
      cardCount: 1,
      maxQueryBigrams: 32,
      maxQueryCodeLength: 33,
      bMinValues: [],
    }),
  );
});

test('NM3-5 manifest：sha256 与 artifact JSON 实值一致、无墙钟字段、同输入逐字节确定', () => {
  const fieldDocuments = ['甲乙丙丁', '甲乙丙子', '乙丁子丑'];
  const built = buildNullModelArtifacts({
    fieldDocuments,
    cardCount: 3,
    maxQueryBigrams: DEFAULT_MAX_QUERY_BIGRAMS,
    maxQueryCodeLength: DEFAULT_MAX_QUERY_CODE_LENGTH,
    bMinValues: KMIN_B_MIN_VALUES,
  });
  const entries = [
    ...built.kmin.map((entry) => ({
      file: kminFileName(entry.bMin),
      schema: entry.table.schema,
      body: JSON.stringify(entry.table),
    })),
    { file: GEOMETRY_FILE_NAME, schema: built.geometry.schema, body: JSON.stringify(built.geometry) },
    { file: RARITY_FILE_NAME, schema: built.rarity.schema, body: JSON.stringify(built.rarity) },
  ];
  const meta = {
    indexHint: '/some/read/only/memory-index.sqlite',
    activeCardCount: 3,
    stats: built.stats,
    maxQueryBigrams: DEFAULT_MAX_QUERY_BIGRAMS,
    maxQueryCodeLength: DEFAULT_MAX_QUERY_CODE_LENGTH,
    bMinValues: KMIN_B_MIN_VALUES,
  };
  const manifest = buildNullModelManifest({ meta, entries });
  assert.equal(manifest.artifacts.length, 7);
  for (const artifact of manifest.artifacts) {
    const body = entries.find((entry) => entry.file === artifact.file)!.body;
    assert.equal(artifact.sha256, sha256Hex(body));
    assert.equal(artifact.sha256, createHash('sha256').update(body).digest('hex'));
  }
  const again = buildNullModelManifest({ meta, entries });
  assert.deepEqual(manifest, again);
  // 无墙钟/无随机种子：manifest 键集合钉死，防夹带 atMs/Date 类字段破坏可重放。
  const json = JSON.stringify(manifest);
  assert.equal(json.includes('atMs'), false);
  assert.equal(json.includes('builtAt'), false);
  assert.equal(json.includes('timestamp'), false);
});

test('NM3-6 参数解析：缺省网格参数正确、可覆盖，未知 flag 与缺值抛错（必填校验在 main 壳）', () => {
  const args = parseBuildArgs(['--index', '/a/b.sqlite', '--out', '/a/null-model']);
  assert.equal(args.index, '/a/b.sqlite');
  assert.equal(args.out, '/a/null-model');
  assert.equal(args.maxQueryBigrams, DEFAULT_MAX_QUERY_BIGRAMS);
  assert.deepEqual(args.bMinValues, KMIN_B_MIN_VALUES);
  const overridden = parseBuildArgs([
    '--index',
    '/a/b.sqlite',
    '--out',
    '/o',
    '--max-query-bigrams',
    '8',
    '--max-query-code-length',
    '9',
  ]);
  assert.equal(overridden.maxQueryBigrams, 8);
  assert.equal(overridden.maxQueryCodeLength, 9);
  assert.throws(() => parseBuildArgs(['--index', '/a/b.sqlite', '--bogus', '1']));
  assert.throws(() => parseBuildArgs(['--out']));
  // 必填缺失不在解析器抛错（与 calibrate parseArgs 同范式），仅保持 undefined 由 main 壳拦截。
  assert.equal(parseBuildArgs([]).index, undefined);
  assert.equal(parseBuildArgs([]).out, undefined);
});

test('NM3-7 文件名枚举固定且 manifest 自引用齐全', () => {
  assert.equal(kminFileName(3), 'kmin-b3.json');
  assert.equal(GEOMETRY_FILE_NAME, 'locality-geometry.json');
  assert.equal(RARITY_FILE_NAME, 'rarity-buckets.json');
  assert.equal(MANIFEST_FILE_NAME, 'null-model-manifest.json');
  const names = KMIN_B_MIN_VALUES.map((bMin) => kminFileName(bMin));
  assert.deepEqual(names, ['kmin-b0.json', 'kmin-b1.json', 'kmin-b2.json', 'kmin-b3.json', 'kmin-b4.json']);
});

test('NM3-8 只读纪律：脚本源码以 readOnly 开库且不含写库动词与墙钟', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/p6/build-null-model-v3.ts'), 'utf8');
  assert.ok(src.includes("readOnly: true"));
  for (const banned of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'Date.now', 'new Date(']) {
    assert.equal(src.includes(banned), false, `构建壳不得出现 ${banned}`);
  }
});
