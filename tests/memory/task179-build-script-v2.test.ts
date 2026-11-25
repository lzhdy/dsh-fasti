/**
 * task179 红测 W3：建根脚本的两处新增行为（纯函数级，绝不真建根）。
 *
 *  - `--world v2` 接线：默认仍是 v1（改造前行为零变化）；v2 的 seed 冻结、不许覆盖；
 *  - 根标记加固（缺口 8）：带标记 + 显式 `--force-rebuild` 才肯清空，无标记一律拒绝——
 *    这是「可重跑」与「绝不误删真实根」的分界线，必须被测试钉死。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  SYNTHETIC_ROOT_MARKER,
  ensureFreshDir,
  parseArgs,
  writeRootMarker,
} from '../../scripts/p6/build-synthetic-world.ts';
import { SEED_V2 } from '../../src/memory/audit/corpus/world-plan-v2.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-179-'));

test('S1 默认 --world v1、不带 forceRebuild：参数语义与改造前一致', () => {
  const args = parseArgs(['--out', '/tmp/a', '--blind-out', '/tmp/b']);
  assert.equal(args.world, 'v1');
  assert.equal(args.forceRebuild, false);
  assert.equal(args.seed, undefined);
  assert.equal(args.out, '/tmp/a');
  assert.equal(args.blindOut, '/tmp/b');
  assert.equal(parseArgs(['--out', '/tmp/a', '--blind-out', '/tmp/b', '--seed', '7']).seed, 7);
});

test('S2 v2 的 seed 冻结：给对通过、给错必抛、--world 取值有限', () => {
  assert.equal(
    parseArgs(['--out', '/tmp/a', '--blind-out', '/tmp/b', '--world', 'v2', '--seed', String(SEED_V2)]).world,
    'v2',
  );
  assert.throws(() => parseArgs(['--out', '/tmp/a', '--blind-out', '/tmp/b', '--world', 'v2', '--seed', '7']), /seed 已冻结/);
  // W2-3（task208）把 v3 接进 CLI 后，本行随之调整：v3 合法，未知值 v4 才拒（详见 task208-world-v3-build.test.ts）。
  assert.throws(() => parseArgs(['--out', '/tmp/a', '--blind-out', '/tmp/b', '--world', 'v4']), /只接受 v1\|v2\|v3/);
});

test('S3 无取值开关不吃下一个 token', () => {
  const args = parseArgs(['--force-rebuild', '--out', '/tmp/a', '--blind-out', '/tmp/b']);
  assert.equal(args.forceRebuild, true);
  assert.equal(args.out, '/tmp/a', '--force-rebuild 不得吞掉 --out');
  assert.equal(args.blindOut, '/tmp/b');
});

test('S4 无标记的非空目录：即使 --force-rebuild 也拒绝（防误删真实根）', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'real-data.jsonl'), '{}');
  assert.throws(() => ensureFreshDir(dir, '--out', { allowRebuild: true }), /拒绝覆盖/);
  assert.equal(fs.existsSync(path.join(dir, 'real-data.jsonl')), true, '真实数据不得被删');
});

test('S5 带标记 + --force-rebuild：清空后重建为空目录', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, SYNTHETIC_ROOT_MARKER), '{}');
  fs.writeFileSync(path.join(dir, 'leftover.db'), 'x');
  ensureFreshDir(dir, '--out', { allowRebuild: true });
  assert.deepEqual(fs.readdirSync(dir), [], '旧合成根内容应被清空');
});

test('S6 带标记但未给 --force-rebuild：拒绝，并提示可加开关', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, SYNTHETIC_ROOT_MARKER), '{}');
  assert.throws(() => ensureFreshDir(dir, '--out'), /--force-rebuild/);
  assert.equal(fs.existsSync(path.join(dir, SYNTHETIC_ROOT_MARKER)), true);
});

test('S7 空目录与不存在目录都直接放行；标记文件内容可识别世界版本', () => {
  const empty = tmp();
  ensureFreshDir(empty, '--out');
  const fresh = path.join(tmp(), 'nested', 'root');
  ensureFreshDir(fresh, '--out');
  assert.equal(fs.existsSync(fresh), true);

  writeRootMarker(fresh, 'fasti-p6-world/v2', SEED_V2, 'v2');
  const marker = JSON.parse(fs.readFileSync(path.join(fresh, SYNTHETIC_ROOT_MARKER), 'utf8')) as Record<string, unknown>;
  assert.equal(marker.schema, 'fasti-p6-world/v2');
  assert.equal(marker.seed, SEED_V2);
  assert.equal(marker.world, 'v2');
});
