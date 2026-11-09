/**
 * 「已删除」与「从未存在」的语义预留（B1-③ / 阶段 0 · G08）。
 *
 * 本期不实现删除工具（删除属后续任务），只把两态的**机器可判**接口占位：
 *  - DeletedError（code='DELETED'）—— 曾经存在过、后来被删；
 *  - NotFoundError（code='NOT_FOUND'）—— 从来没有过。
 *
 * 判定一律靠错误类型 / 错误码，不靠 message 文案匹配。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fasti, fallbackErrorOf } from '../../src/api/index.ts';
import {
  DeletedError,
  NotFoundError,
  OutOfRangeError,
  SchemaError,
  missingTargetState,
} from '../../src/core/errors.ts';
import { cleanupTempRoot, makeTempRoot } from '../helpers.ts';

test('G08：「已删除」与「从未存在」是不同的错误类型与错误码', () => {
  const deleted = new DeletedError('目标已被删除');
  const missing = new NotFoundError('目标不存在');

  assert.equal(deleted.code, 'DELETED');
  assert.equal(missing.code, 'NOT_FOUND');
  assert.equal(deleted instanceof DeletedError, true);
  assert.equal(missing instanceof DeletedError, false, '两者不得互相冒充');
  assert.equal(deleted instanceof NotFoundError, false);
  assert.equal(missing instanceof NotFoundError, true);
});

test('G08：missingTargetState 机器可判地区分两态（不依赖 message 文案）', () => {
  assert.equal(missingTargetState(new DeletedError('任意文案一')), 'deleted');
  assert.equal(missingTargetState(new DeletedError('任意文案二')), 'deleted');
  assert.equal(missingTargetState(new NotFoundError('任意文案')), 'never_existed');
  assert.equal(missingTargetState(new SchemaError('其它错误')), undefined);
  assert.equal(missingTargetState(new Error('普通错误')), undefined);
});

test('G08：已删除不回退到下一个通道；从未存在 / 越界才回退', () => {
  assert.equal(fallbackErrorOf(new DeletedError('已删')), undefined);
  assert.ok(fallbackErrorOf(new NotFoundError('从未存在')) instanceof NotFoundError);
  assert.ok(fallbackErrorOf(new OutOfRangeError('越界')) instanceof OutOfRangeError);
  assert.equal(fallbackErrorOf(new SchemaError('其它')), undefined);
});

test('G08：resolvePointer 对不存在的目标抛 NotFoundError（从未存在这一态）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await assert.rejects(
      () => fasti.resolvePointer({ id: 'raw-missing', channel: 'dsh' }),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError, '必须是 NotFoundError（从未存在）');
        assert.equal((error as NotFoundError).code, 'NOT_FOUND');
        assert.equal(missingTargetState(error), 'never_existed');
        return true;
      },
    );
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
