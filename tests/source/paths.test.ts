/**
 * 数据根解析测试（审计第四节阶段 0 验收项：
 * 「数据根按拍板方案解析，三级路径优先级可验证」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { defaultDataRoot, layoutOf, rawDirOf, resolveDataRoot } from '../../src/source/paths.ts';

test('第一优先级：显式配置', () => {
  const root = resolveDataRoot({
    dataRoot: '/tmp/explicit-root',
    env: { DSH_HOME: '/tmp/dsh-home' },
    homeDir: '/tmp/home',
  });
  assert.equal(root, path.resolve('/tmp/explicit-root'));
});

test('第二优先级：$DSH_HOME/fasti（DSH_HOME 是 ~/.dsh 的替代基址）', () => {
  const root = resolveDataRoot({
    env: { DSH_HOME: '/tmp/dsh-home' },
    homeDir: '/tmp/home',
  });
  assert.equal(root, path.resolve('/tmp/dsh-home', 'fasti'));
});

test('第三优先级：默认 ~/.dsh/fasti', () => {
  const root = resolveDataRoot({ env: {}, homeDir: '/tmp/home' });
  assert.equal(root, path.resolve('/tmp/home', '.dsh', 'fasti'));
});

test('三级优先级严格有序：显式 > DSH_HOME > 默认', () => {
  const explicit = resolveDataRoot({ dataRoot: '/a', env: { DSH_HOME: '/b' }, homeDir: '/c' });
  const fromEnv = resolveDataRoot({ env: { DSH_HOME: '/b' }, homeDir: '/c' });
  const fromDefault = resolveDataRoot({ env: {}, homeDir: '/c' });

  assert.notEqual(explicit, fromEnv);
  assert.notEqual(fromEnv, fromDefault);
  assert.notEqual(explicit, fromDefault);
});

test('空字符串的显式配置与空 DSH_HOME 视为未设置', () => {
  assert.equal(
    resolveDataRoot({ dataRoot: '', env: { DSH_HOME: '' }, homeDir: '/c' }),
    path.resolve('/c', '.dsh', 'fasti'),
  );
});

test('默认根与 defaultDataRoot 一致', () => {
  assert.equal(
    resolveDataRoot({ env: { DSH_HOME: '/x' }, homeDir: '/h' }),
    defaultDataRoot({ DSH_HOME: '/x' }, '/h'),
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

test('原文层物理布局：dsh → raw-turns/，其余 → raw/<channel>/（用户拍板 Q3）', () => {
  const layout = layoutOf('/data');
  assert.equal(rawDirOf(layout, 'dsh'), path.join('/data', 'raw-turns'));
  assert.equal(rawDirOf(layout, 'qq'), path.join('/data', 'raw', 'qq'));
  assert.equal(rawDirOf(layout, 'browser'), path.join('/data', 'raw', 'browser'));
});
