/**
 * dsh 适配器自带的通道描述符模板（平台化步骤2：宿主知识内聚到适配器）。
 *
 * 内核本体不再预置任何具体宿主通道：空白启动的 channels.json 是空注册表。
 * 只有当 dsh 插件被**显式挂载**时，才由本工厂生成描述符、经门面 registerChannel
 * 登记进注册表。id 取实际挂载通道（配置可覆盖，缺省 'dsh'），其余字段是 dsh
 * 适配器对自身采集形态的声明。
 *
 * 同 id 等价重复登记由注册表幂等吸收；不等价则抛 ConflictError，绝不覆盖用户
 * 手动改过的注册表内容（开放面纪律）。
 */

import type { ChannelDescriptor } from '../../contract/channel.ts';

/** 按挂载通道 id 生成 dsh 适配器的通道描述符。 */
export function dshChannelDescriptor(channel: string): ChannelDescriptor {
  return {
    id: channel,
    label: 'DSH 对话',
    modalities: ['text', 'image', 'file', 'event'],
    capture: 'full',
    counterpart: 'user',
    adapter_version: '0.1.0',
  };
}
