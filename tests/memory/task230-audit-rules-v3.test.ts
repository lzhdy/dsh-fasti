/**
 * #230 终判 harness：rules-v3 具名回放通道红测（CV3-14/15/16）。
 *
 * 【封存状态 · 2026-11-26 主控拍板，正本 §11.13.21】rules-v3 上线线终止，本文件随通道
 * 整体休眠保留：11 测继续随 verify 运行，钉住休眠件契约不腐坏；复工先读 §11.13.21。
 *
 * 背景（蓝图 218 §10.2）：终判权只在封存卷 probes-v2，harness 原先 `--rules-version`
 * 只改信封标注（run-memory-audit.ts:917/932 modelTag），门实现恒取生产常量
 * `applyGate`（gate.ts:419 硬读 CURRENT_RULES_VERSION）——v2 终判当时靠「仓外副本翻常量」
 * 绕开。v3 不能再翻常量（分派壳挂 case 属 S5 施工闸、且 applyGate 签名无法注入三张冻结表），
 * 故必须开**具名**回放通道：审计侧按 rulesVersion 选具名门，生产分派壳一字不动。
 *
 * 本文件只钉契约，不跑真实封存卷：
 *  - CV3-14 版本登记与参数解析（--null-model）；
 *  - CV3-15 版本→门实现的纯映射（未知版本 fail-closed，v3 缺表 fail-loud）；
 *  - CV3-16 静态守卫（源码零裸 applyGate 调用、三具名门齐、help 文案同步）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  KNOWN_RULES_VERSIONS,
  parseOptions,
  requireNullModelDirForV3,
  resolveRulesGateMode,
} from '../../scripts/run-memory-audit.ts';

const BASE = ['--data-root', '/tmp/root-x', '--out', '/tmp/out-x'];
const HARNESS_PATH = path.join(import.meta.dirname, '..', '..', 'scripts', 'run-memory-audit.ts');
const HARNESS_SRC = fs.readFileSync(HARNESS_PATH, 'utf8');

// ── CV3-14 版本登记与参数解析 ────────────────────────────────────────────

test('CV3-14a rules-v3 已登记进审计信封白名单（三版本齐）', () => {
  assert.equal(KNOWN_RULES_VERSIONS.size, 3);
  for (const version of ['rules-v1', 'rules-v2', 'rules-v3']) {
    assert.equal(KNOWN_RULES_VERSIONS.has(version), true, `未登记：${version}`);
  }
});

test('CV3-14b --null-model 显式取值被原样解析', () => {
  const options = parseOptions([...BASE, '--null-model', '/tables/null-model']);
  assert.equal(options.nullModelDir, '/tables/null-model');
});

test('CV3-14c --null-model 缺省为 undefined（v1/v2 路径不要求表）', () => {
  assert.equal(parseOptions(BASE).nullModelDir, undefined);
});

test('CV3-14d --null-model 缺值一律拒收（不静默吞成 undefined）', () => {
  assert.throws(() => parseOptions([...BASE, '--null-model']), /--null-model/);
});

// ── CV3-15 版本→门实现纯映射 ─────────────────────────────────────────────

test('CV3-15a 三版本各自映射到对应具名门', () => {
  assert.equal(resolveRulesGateMode('rules-v1'), 'v1');
  assert.equal(resolveRulesGateMode('rules-v2'), 'v2');
  assert.equal(resolveRulesGateMode('rules-v3'), 'v3');
});

test('CV3-15b 未知版本 fail-closed（不回落生产常量门）', () => {
  for (const bogus of ['rules-v0', 'rules-v4', '', 'RULES-V3']) {
    assert.throws(() => resolveRulesGateMode(bogus), /未知规则版本/);
  }
});

// ── CV3-16 静态守卫 ─────────────────────────────────────────────────────

test('CV3-16a 源码零裸 applyGate 调用（六处全经具名分派）', () => {
  const bareCalls = HARNESS_SRC.match(/applyGate\(/g) ?? [];
  assert.equal(bareCalls.length, 0, `仍有 ${bareCalls.length} 处裸 applyGate( 调用，会绕过版本分派`);
});

test('CV3-16b 三具名门均被显式引用（v3 不得缺席）', () => {
  for (const name of ['applyGateV1(', 'applyGateV2(', 'applyGateV3(']) {
    assert.match(HARNESS_SRC, new RegExp(name.replace('(', '\\(')), `源码缺 ${name} 引用`);
  }
});

test('CV3-16c help 文案与登记版本同步（含 rules-v3 与 --null-model）', () => {
  assert.match(HARNESS_SRC, /--rules-version <v>\s*受测规则版本（rules-v1\/rules-v2\/rules-v3）/);
  assert.match(HARNESS_SRC, /--null-model <目录>/);
});

test('CV3-16d v3 通道带表装载守卫标识（缺表即 fail-loud 的落点存在）', () => {
  assert.match(HARNESS_SRC, /loadVerifiedNullModel/);
  assert.match(HARNESS_SRC, /拒绝以缺表状态跑 rules-v3/);
});

test('CV3-16e 缺表守卫行为：v3 无表拒跑，v1/v2 忽略该参数', () => {
  assert.throws(
    () => requireNullModelDirForV3('v3', undefined),
    /拒绝以缺表状态跑 rules-v3/,
  );
  assert.equal(requireNullModelDirForV3('v1', undefined), undefined);
  assert.equal(requireNullModelDirForV3('v2', undefined), undefined);
  assert.equal(requireNullModelDirForV3('v3', '/tables'), '/tables');
});

