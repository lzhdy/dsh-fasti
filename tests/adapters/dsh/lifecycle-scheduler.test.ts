/**
 * dsh 生命周期/调度插头的薄封装测试（平台化 H1 切片 2）。
 *
 * 不依赖真实 cordis Context：用同形假 effect sink 验证 LifecyclePort 的接线契约；
 * SchedulerPort 因为本来就包宿主全局 setTimeout，这里用短时长真实时钟做一支烟测，
 * 确认到点触发与 cancel 拦截、以及对已触发句柄重复 cancel 幂等不抛。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDshLifecycle, type DshEffectSink } from '../../../src/adapters/dsh/lifecycle.ts';
import { createDshScheduler } from '../../../src/adapters/dsh/scheduler.ts';

test('createDshLifecycle：onDispose 经 ctx.effect 同步登记，label 透传，effect 体返回同一个 cleanup', () => {
  const calls: Array<{ execute: () => unknown; label?: string }> = [];
  const sink: DshEffectSink = {
    effect(execute, label) {
      calls.push({ execute, label });
      return undefined;
    },
  };
  const lifecycle = createDshLifecycle(sink);

  const cleanup = (): void => {};
  lifecycle.onDispose(cleanup, 'dsh-fasti-closure-worker');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.label, 'dsh-fasti-closure-worker', '诊断 label 原样透传给 ctx.effect');
  assert.equal(calls[0]?.execute(), cleanup, 'effect 体同步返回的就是登记的 cleanup 本身');

  // label 可缺省。
  lifecycle.onDispose(cleanup);
  assert.equal(calls[1]?.label, undefined);
});

test('createDshScheduler：到点执行一次；cancel 后不再执行；重复 cancel 幂等不抛', async () => {
  const scheduler = createDshScheduler();

  let ranOnce = false;
  const first = scheduler.schedule(() => {
    ranOnce = true;
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(ranOnce, true, '延迟到点后回调执行');

  let cancelledRan = false;
  const second = scheduler.schedule(() => {
    cancelledRan = true;
  }, 15);
  second.cancel();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(cancelledRan, false, '已 cancel 的任务到点也不触发');

  assert.doesNotThrow(() => {
    first.cancel();
    second.cancel();
  }, '对已触发/已取消句柄再次 cancel 幂等无副作用');
});
