/**
 * #157 读出链观测挂点红测：chat 处理器的 onToolActivity 回调（先红后绿）。
 *
 * 六工具进程内不开放 HTTP 面，但她要在控制台看到模型每一次调工具的事实：
 * 处理器在 execute 外包一层只读观测，成功/失败信封都上报工具名与成败，
 * 回调是可选项、缺省行为零变化，且不带检索词/正文等内容，只报元数据。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fasti } from '../../../src/api/index.ts';
import type { ChannelDescriptor } from '../../../src/contract/channel.ts';
import { createChatHandler } from '../../../src/adapters/node/chat.ts';
import type { ChatAgentClient, ChatToolCall, ChatToolHost } from '../../../src/adapters/node/chat.ts';
import { cleanupTempRoot, makeTempRoot } from '../../helpers.ts';

const CHANNEL = 'chatact';
const descriptor: ChannelDescriptor = {
  id: CHANNEL,
  label: '聊天活动通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'chatact-0',
};

function fakeClient(calls: readonly ChatToolCall[], envelope: string): ChatAgentClient {
  return {
    modelName: 'fake-model',
    async run({ execute }) {
      for (const call of calls) {
        await execute(call);
      }
      return { content: '收口回复', model: 'fake-model' };
    },
  };
}

function fakeToolHost(envelope: string): ChatToolHost {
  return {
    tools: [],
    createSession: () => ({
      execute: async () => envelope,
    }),
  };
}

test('onToolActivity：每次工具调用上报工具名与成败，且不改变聊天主流程', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  const activities: Array<{ tool: string; ok: boolean; callId: string }> = [];
  try {
    await fasti.registerChannel(descriptor);

    const okChat = createChatHandler({
      fasti,
      channel: CHANNEL,
      client: fakeClient(
        [{ id: 'call-1', name: 'fasti_memory_search', argumentsText: '{}' }],
        JSON.stringify({ ok: true, cards: [] }),
      ),
      toolHost: fakeToolHost(JSON.stringify({ ok: true, cards: [] })),
      onToolActivity: (activity) => activities.push(activity),
    });
    const okReply = await okChat({ text: '先成功调一次工具' });
    assert.equal(okReply.reply, '收口回复');
    assert.deepEqual(activities, [{ tool: 'fasti_memory_search', ok: true, callId: 'call-1' }]);

    const failChat = createChatHandler({
      fasti,
      channel: CHANNEL,
      client: fakeClient(
        [{ id: 'call-2', name: 'fasti_memory_raw_text', argumentsText: '{}' }],
        JSON.stringify({ error: { code: 'serial-stale', message: '失效' } }),
      ),
      toolHost: fakeToolHost(JSON.stringify({ error: { code: 'serial-stale', message: '失效' } })),
      onToolActivity: (activity) => activities.push(activity),
    });
    await failChat({ text: '再失败一次工具' });
    assert.equal(activities[1]?.ok, false);
    assert.equal(activities[1]?.tool, 'fasti_memory_raw_text');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('onToolActivity 缺省时聊天行为与之前完全一致（纯加法可选回调）', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  try {
    await fasti.registerChannel(descriptor);
    const chat = createChatHandler({
      fasti,
      channel: CHANNEL,
      client: fakeClient([], JSON.stringify({ ok: true })),
      toolHost: fakeToolHost(JSON.stringify({ ok: true })),
    });
    const reply = await chat({ text: '没有回调也正常' });
    assert.equal(reply.reply, '收口回复');
  } finally {
    await fasti.close();
    cleanupTempRoot(root);
  }
});
