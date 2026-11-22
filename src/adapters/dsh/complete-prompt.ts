/**
 * dsh 宿主 complete system prompt 段注册元数据（#154）。
 *
 * 背景：宿主 dsh-system-prompt 服务把身份句与各工具包注册的使用纪律装配成
 * system prompt 下发；注册带 `complete: true` 的 section 后，宿主 assemble 时
 * sections 仅保留本段（工具 schemas 与 runtime contexts 不受影响，已读宿主
 * 源码坐实）。甄别结论：宿主 2727 字内 12 段工具纪律均未写进工具 schema，而工具
 * 包是第三方代码、插件无改写其 schema 的官方挂载点，故工具纪律一律不迁入。
 *
 * #154 收口后本文件**不持有任何提示词文本**：DSH_COMPLETE_PROMPT 就是契约层
 * SHARED_SYSTEM_PROMPT 的同一引用，与 node 裸连 /chat 共用唯一母本，改文本只动
 * src/contract/system-prompts.ts 一处，两个通道同时生效。无身份句、无人格、
 * 无工具操作细则（禁回流断言在测试里锁定）。
 */

import { SHARED_SYSTEM_PROMPT } from '../../contract/system-prompts.ts';


/** 宿主 systemPrompt.section 注册名；fasti 前缀避免与宿主段重名。 */
export const DSH_COMPLETE_SECTION_NAME = 'fasti:complete-prompt';

/**
 * complete 模式下全机仅此一段，order 不参与实际排序；
 * 宿主 section() 校验 order 必须是有限数，给 0 满足契约。
 */
export const DSH_COMPLETE_SECTION_ORDER = 0;

/** 跨通道共享母本的同一引用（契约层单点定义，这里不得复制字面）。 */
export const DSH_COMPLETE_PROMPT = SHARED_SYSTEM_PROMPT;
