/**
 * LoggerPort 切片测试（平台化 H1 切片 1）。
 *
 * 两件事：
 *  1. dsh 插头 createDshLogger 必须薄转发——四档各自调到底层 sink 的同名方法，
 *     format 与 printf 参数逐字原样透传，不格式化、不吞参、不串档；
 *  2. 端口必须能被非 dsh 实现满足（双实现准入）：内联一个收集型假 LoggerPort，
 *     证明接口不绑宿主、headless 未来可同形实现。
 *
 * 本测试不 import 任何 @deepseek-ai 包。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDshLogger, type DshLoggerSink } from '../../src/adapters/dsh/logger.ts';
import type { LoggerPort } from '../../src/ports/logger-port.ts';

/** 记录每次调用的档别与完整参数。 */
interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  args: unknown[];
}

/** 可控假 sink（同时满足 dsh 最小结构化面）。 */
function spySink(): { sink: DshLoggerSink; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const make = (level: LogCall['level']) => (format: string, ...args: unknown[]): void => {
    calls.push({ level, args: [format, ...args] });
  };
  return {
    calls,
    sink: { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') },
  };
}

test('createDshLogger：四档薄转发到同名 sink，printf 格式串与参数逐字原样透传', () => {
  const { sink, calls } = spySink();
  const logger = createDshLogger(sink);
  const error = new Error('boom');

  logger.debug('%s 跳过事件：%s', '[dsh-fasti]', '未知原因');
  logger.info('%s 适配器已装载：通道=%s', '[dsh-fasti]', 'dsh');
  logger.warn('%s 摘要未生成（%s，已试 %d 次）：%s', '[dsh-fasti]', 'perm', 3, error);
  logger.error('%s 摄入失败：%s', '[dsh-fasti]', String(error));

  assert.deepEqual(calls, [
    { level: 'debug', args: ['%s 跳过事件：%s', '[dsh-fasti]', '未知原因'] },
    { level: 'info', args: ['%s 适配器已装载：通道=%s', '[dsh-fasti]', 'dsh'] },
    { level: 'warn', args: ['%s 摘要未生成（%s，已试 %d 次）：%s', '[dsh-fasti]', 'perm', 3, error] },
    { level: 'error', args: ['%s 摄入失败：%s', '[dsh-fasti]', 'Error: boom'] },
  ]);
});

test('LoggerPort 可被非 dsh 的收集型实现满足（双实现准入，端口不绑宿主）', () => {
  // 一个不依赖任何宿主的内存 LoggerPort：headless/离线诊断的雏形。
  const collected: Array<{ level: keyof LoggerPort; message: string }> = [];
  const memoryLogger: LoggerPort = {
    debug: (format, ...args) => collected.push({ level: 'debug', message: [format, ...args].join('|') }),
    info: (format, ...args) => collected.push({ level: 'info', message: [format, ...args].join('|') }),
    warn: (format, ...args) => collected.push({ level: 'warn', message: [format, ...args].join('|') }),
    error: (format, ...args) => collected.push({ level: 'error', message: [format, ...args].join('|') }),
  };

  memoryLogger.warn('门未开 %s', 'deferred');
  assert.equal(collected.length, 1);
  assert.deepEqual(collected[0], { level: 'warn', message: '门未开 %s|deferred' });

  // 同一处消费代码只依赖 LoggerPort 类型，dsh 插头与内存插头可互换。
  const consumer = (logger: LoggerPort): void => logger.info('统一口径 %d', 42);
  assert.doesNotThrow(() => consumer(memoryLogger));
  assert.doesNotThrow(() => consumer(createDshLogger(spySink().sink)));
});
