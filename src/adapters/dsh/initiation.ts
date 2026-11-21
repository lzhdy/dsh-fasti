/**
 * dsh 说话者（speaker）→ 内核身份（initiation）映射。
 *
 * H2-a 自内核门面 api/index.ts 下沉至此：宿主怎么命名一轮对话的说话者是
 * 宿主事实（dsh 原文层 RawTurn 的 speaker 字段：user/assistant/system/tool），
 * 中立内核只接收中性的 initiation，不再持有这张宿主角色表。
 *
 * 口径与阶段 3 迁移脚本 INITIATION_BY_SPEAKER、旧门面 initiationOf 逐字一致：
 *   user→user、assistant→her、system→system、tool→environment；
 *   未知值原样保留（开放枚举：不报错、不丢事件）。
 */

/**
 * 把 dsh 原文层 speaker 翻译为经历契约的 initiation。
 *
 * 纯函数、零 I/O、零宿主依赖；未知说话者原样透传，非空校验由门面统一负责。
 */
export function initiationOf(speaker: string): string {
  switch (speaker) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'her';
    case 'system':
      return 'system';
    case 'tool':
      return 'environment';
    default:
      return speaker;
  }
}
