/**
 * 时间原语 —— 真实时钟、时间三轴的毫秒换算、分片键。
 *
 * 口径：
 *  - 真源存 ISO 8601 字符串（occurred_at / recorded_at），系统维护，永不回改；
 *  - 投影层时间列统一毫秒（定案稿 §5「毫秒口径」，与 BLA d 校准一致）；
 *  - 分片键取摄入月（ingested_at / recorded_at 所在的 YYYY-MM），迟到条目自然落入当前月；
 *  - 本地日期口径沿用旧项目 `localDateString`（旧行为契约 1.4：以本地日期为「会话日」边界）。
 */

/** 本地日期串 YYYY-MM-DD（旧项目 localDateString 口径）。 */
export function localDateString(ms: number): string {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 本地月份分片键 YYYY-MM（摄入月）。 */
export function localMonthKey(ms: number): string {
  return localDateString(ms).slice(0, 7);
}

/** 当前时刻的 ISO 8601 字符串（系统轴，摄入时刻）。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO 8601 → 毫秒。非法输入抛错（不返回 0、不伪造时间）。 */
export function isoToMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new TypeError(`非法 ISO 8601 时间：${iso}`);
  }
  return ms;
}

/** 毫秒 → ISO 8601 字符串。 */
export function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 分片键：取摄入月。
 * @param ingestedIso 原文行的 ingested_at / 经历的 recorded_at
 */
export function shardKeyOf(ingestedIso: string): string {
  return localMonthKey(isoToMs(ingestedIso));
}

/** 校验 YYYY-MM 分片键形状。 */
export function isMonthKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value);
}
