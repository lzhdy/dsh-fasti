/**
 * 终判 harness 时间锚点（--now-ms）红测。
 *
 * 背景（187 号立项遗漏的第七条）：v2 合成世界的参考时钟是冻结常量
 * （§world-plan.ts:31，2027-05-21 一类），而 harness 原先恒取 `Date.now()`；
 * 卡片的 valid_ms 以该参考时钟为基准，真实墙钟早于它时 `listEffective` 返回空集，
 * 金标全部被判「悬空」。故终判必须能把时钟显式钉住并在信封里留痕。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions } from '../../scripts/run-memory-audit.ts';

const BASE = ['--data-root', '/tmp/root-x', '--out', '/tmp/out-x'];

test('--now-ms 缺省为 undefined（由 main 回落墙钟）', () => {
  const options = parseOptions(BASE);
  assert.equal(options.nowMs, undefined);
});

test('--now-ms 显式取值被原样解析为整数毫秒', () => {
  const options = parseOptions([...BASE, '--now-ms', '1810890000000']);
  assert.equal(options.nowMs, 1810890000000);
});

test('--now-ms 非整数一律拒收（不给静默四舍五入）', () => {
  assert.throws(() => parseOptions([...BASE, '--now-ms', 'abc']), /--now-ms/);
  assert.throws(() => parseOptions([...BASE, '--now-ms', '1810890000000.5']), /--now-ms/);
  assert.throws(() => parseOptions([...BASE, '--now-ms', '-1']), /--now-ms/);
});
