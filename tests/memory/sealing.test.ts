/**
 * 封存/解封工程红测（v4 §8/§9 序9，G6）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sealFixtures,
  verifySeal,
  appendUnsealRecord,
  readUnsealLog,
  SEAL_MANIFEST_FILE,
} from '../../src/memory/audit/sealing.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFixture(dir: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
}

const quotas = { S0: 100, S1: 100, S2: 50, S3: 50, S4: 50 };

function sealSample(sourceDir: string, sealDir: string) {
  return sealFixtures({
    sourceDir,
    sealDir,
    probeSetVersion: 'v1',
    rulesVersion: 'rules-v1',
    rngSeed: 20261111,
    sealedAtMs: 1_700_000_000_000,
    sealedBy: 'test-constructor',
    layerQuotas: quotas,
    decoyPairCount: 0,
  });
}

test('封存后核验通过：清单字段齐备且夹具逐字节拷贝', () => {
  const src = tempDir('seal-src-');
  const seal = tempDir('seal-dst-');
  writeFixture(src, 'gold-l0.json', { probeSetVersion: 'v1', items: [] });
  writeFixture(src, 'decoy.json', { probeSetVersion: 'v1', items: [] });
  const manifest = sealSample(src, seal);
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.rngSeed, 20261111);
  assert.deepEqual(manifest.layerQuotas, quotas);
  const verification = verifySeal(seal);
  assert.equal(verification.ok, true);
  assert.deepEqual(
    fs.readFileSync(path.join(seal, 'gold-l0.json')),
    fs.readFileSync(path.join(src, 'gold-l0.json')),
  );
});

test('G6：篡改封存夹具一个字节 → 核验失败；解封被拒', () => {
  const src = tempDir('seal-src-');
  const seal = tempDir('seal-dst-');
  writeFixture(src, 'gold-l0.json', { probeSetVersion: 'v1', items: [] });
  sealSample(src, seal);
  fs.appendFileSync(path.join(seal, 'gold-l0.json'), ' ');
  const verification = verifySeal(seal);
  assert.equal(verification.ok, false);
  assert.match(verification.errors.join(','), /哈希不符/);
  assert.throws(
    () => appendUnsealRecord(seal, { atMs: 1, operator: 'x', reason: 'r', mode: 'loeo', folds: 3 }),
    /封存核验失败/,
  );
});

test('G6：清单缺失或夹具被偷删 → 核验失败', () => {
  const src = tempDir('seal-src-');
  const seal = tempDir('seal-dst-');
  writeFixture(src, 'gold-l0.json', { probeSetVersion: 'v1', items: [] });
  sealSample(src, seal);
  fs.rmSync(path.join(seal, SEAL_MANIFEST_FILE));
  assert.throws(() => verifySeal(seal), /封存清单不存在/);

  const seal2 = tempDir('seal-dst-');
  sealSample(src, seal2);
  fs.rmSync(path.join(seal2, 'gold-l0.json'));
  assert.equal(verifySeal(seal2).ok, false);
});

test('解封留痕只追加：两次解封两行，字段与 README 模板对齐', () => {
  const src = tempDir('seal-src-');
  const seal = tempDir('seal-dst-');
  writeFixture(src, 'gold-l0.json', { probeSetVersion: 'v1', items: [] });
  sealSample(src, seal);
  assert.deepEqual(readUnsealLog(seal), []);
  appendUnsealRecord(seal, { atMs: 100, operator: 'alice', reason: '首跑', mode: 'loeo', folds: 3 });
  appendUnsealRecord(seal, { atMs: 200, operator: 'bob', reason: '复核', mode: 'holdout', folds: null, note: '外部见证' });
  const log = readUnsealLog(seal);
  assert.equal(log.length, 2);
  assert.equal(log[0]!.operator, 'alice');
  assert.equal(log[1]!.mode, 'holdout');
  assert.equal(log[1]!.note, '外部见证');
});
