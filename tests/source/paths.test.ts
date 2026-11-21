/**
 * 数据根解析与原文目录布局测试（平台化 H2-b 去宿主化后）。
 *
 * 正本 §2.6【2026-11-17 修正案】：默认根与环境变量去宿主化，旧 DSH_HOME 保留只读兼容；
 * 内核不内置任何具体宿主通道，遗留扁平原文目录（raw-turns/）改由装配方显式声明。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { defaultDataRoot, layoutOf, rawDirOf, resolveDataRoot } from '../../src/source/paths.ts';

test('第一优先级：显式 dataRoot 压过一切环境变量', () => {
  const root = resolveDataRoot({
    dataRoot: '/tmp/explicit-root',
    env: { FASTI_HOME: '/tmp/fh', DSH_HOME: '/tmp/dh' },
    homeDir: '/tmp/home',
  });
  assert.equal(root, path.resolve('/tmp/explicit-root'));
});

test('第二优先级：FASTI_HOME 直接就是数据根（不再下拼子目录）', () => {
  const root = resolveDataRoot({ env: { FASTI_HOME: '/tmp/fasti-home' }, homeDir: '/tmp/home' });
  assert.equal(root, path.resolve('/tmp/fasti-home'));
});

test('第三优先级：旧 DSH_HOME 历史兼容，仍按旧语义下拼 fasti', () => {
  const root = resolveDataRoot({ env: { DSH_HOME: '/tmp/dsh-home' }, homeDir: '/tmp/home' });
  assert.equal(root, path.resolve('/tmp/dsh-home', 'fasti'));
});

test('FASTI_HOME 与 DSH_HOME 同时存在时，中性的 FASTI_HOME 优先', () => {
  const root = resolveDataRoot({
    env: { FASTI_HOME: '/tmp/fh', DSH_HOME: '/tmp/dh' },
    homeDir: '/tmp/home',
  });
  assert.equal(root, path.resolve('/tmp/fh'));
});

test('第四优先级（兜底）：家目录下的 .fasti', () => {
  const root = resolveDataRoot({ env: {}, homeDir: '/tmp/home' });
  assert.equal(root, path.resolve('/tmp/home', '.fasti'));
});

test('四级优先级严格有序：显式 > FASTI_HOME > DSH_HOME > 默认根', () => {
  const explicit = resolveDataRoot({ dataRoot: '/a', env: { FASTI_HOME: '/b', DSH_HOME: '/c' }, homeDir: '/h' });
  const fromFastiHome = resolveDataRoot({ env: { FASTI_HOME: '/b', DSH_HOME: '/c' }, homeDir: '/h' });
  const fromDshHome = resolveDataRoot({ env: { DSH_HOME: '/c' }, homeDir: '/h' });
  const fromDefault = resolveDataRoot({ env: {}, homeDir: '/h' });

  assert.notEqual(explicit, fromFastiHome);
  assert.notEqual(fromFastiHome, fromDshHome);
  assert.notEqual(fromDshHome, fromDefault);
  assert.equal(fromDefault, path.resolve('/h', '.fasti'));
});

test('空字符串的显式配置与空环境变量一律视为未设置，最终落默认根', () => {
  assert.equal(
    resolveDataRoot({ dataRoot: '', env: { FASTI_HOME: '', DSH_HOME: '' }, homeDir: '/c' }),
    path.resolve('/c', '.fasti'),
  );
});

test('默认根与 defaultDataRoot 一致', () => {
  assert.equal(
    resolveDataRoot({ env: { FASTI_HOME: '/x' }, homeDir: '/h' }),
    defaultDataRoot({ FASTI_HOME: '/x' }, '/h'),
  );
});

test('目录布局：原文层 / 结构层 / 注册表 / 投影 / 运行态', () => {
  const layout = layoutOf('/data');
  assert.equal(layout.rawTurns, path.join('/data', 'raw-turns'));
  assert.equal(layout.raw, path.join('/data', 'raw'));
  assert.equal(layout.experiences, path.join('/data', 'experiences'));
  assert.equal(layout.channelsFile, path.join('/data', 'channels.json'));
  assert.equal(layout.projection, path.join('/data', 'projection'));
  assert.equal(layout.state, path.join('/data', 'state'));
});

test('内核默认不认识任何宿主通道：无显式声明时一律走 raw/<channel>/，即便通道 id 叫 dsh', () => {
  const layout = layoutOf('/data');
  assert.equal(rawDirOf(layout, 'dsh'), path.join('/data', 'raw', 'dsh'));
  assert.equal(rawDirOf(layout, 'qq'), path.join('/data', 'raw', 'qq'));
  assert.equal(rawDirOf(layout, 'browser'), path.join('/data', 'raw', 'browser'));
});

test('仅被显式列入遗留扁平通道集合者，才落 raw-turns/（知识由装配方提供，内核不内置通道名）', () => {
  const layout = layoutOf('/data');
  // dsh 适配器挂载时会把自己的通道名声明进来；函数本身对通道名中性。
  assert.equal(rawDirOf(layout, 'dsh', ['dsh']), path.join('/data', 'raw-turns'));
  // 同一集合下未被声明的其它通道仍走分区布局。
  assert.equal(rawDirOf(layout, 'qq', ['dsh']), path.join('/data', 'raw', 'qq'));
  // 任意通道 id 都可被声明为遗留扁平通道（不写死任何宿主名）。
  assert.equal(rawDirOf(layout, 'legacy-x', ['legacy-x']), path.join('/data', 'raw-turns'));
  // 空集合等价于默认：全部分区。
  assert.equal(rawDirOf(layout, 'dsh', []), path.join('/data', 'raw', 'dsh'));
});
