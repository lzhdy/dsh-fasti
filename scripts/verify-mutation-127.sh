#!/usr/bin/env bash
# ⚠️ 历史归档（#131 起）：本脚本是 #127 完工时的六变异快照。其 M-B/M-D 依赖的 gate 时间删卡
#    分支已在 #131 摘除，对当前 HEAD 运行会在注入步骤报“旧串出现 0 次”而安全中止。当前有效
#    反证请跑 scripts/verify-mutation-131.sh；本文件反证逻辑一字不动、仅加本归档说明，留档追溯。
# #127 阶段 1.5 批 4 时间槽六条核心变异反证矩阵（《最终推荐与实施细则》第五节批 4）。
#
# 纪律（同 verify-mutation-44.sh）：
#  - 每个变异：备份目标文件 → 精确注入 1 处（旧串须恰好 1 次）→ 跑指定红测（期望红）
#    → 备份整体回拷 → sha256 逐字校验 → 回绿复跑；
#  - 全程不触真实根、不做 git 写；只在工作树内临时改一处源码。
#
# 用法：bash scripts/verify-mutation-127.sh [日志路径]
# 退出码：0 = 六变异全被捕获且还原无损；1 = 存在未捕获或还原不一致。

set -u

MAIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MAIN" || exit 1

LOG="${1:-$MAIN/mutation-proof-127.log}"
: > "$LOG"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0

log() { printf '%s\n' "$*" | tee -a "$LOG"; }

# mutate <名字> <相对路径> <旧串> <新串> <跑测试命令...>
mutate() {
  local name="$1" file="$2" old="$3" new="$4"
  shift 4
  local abs="$MAIN/$file"
  local backup="$WORK/$(echo "$file" | tr '/' '_')_$(date +%s%N)"
  cp "$abs" "$backup"
  local orig_sha
  orig_sha="$(sha256sum "$abs" | awk '{print $1}')"

  if ! python3 - "$abs" "$old" "$new" <<'PY' >> "$LOG" 2>&1
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path, encoding='utf-8').read()
count = src.count(old)
if count != 1:
    print(f"注入失败：旧串出现 {count} 次（须恰好 1 次）：{old[:80]!r}")
    sys.exit(2)
open(path, 'w', encoding='utf-8').write(src.replace(old, new, 1))
print(f"注入成功：{old[:60]!r} -> {new[:60]!r}")
PY
  then
    cp "$backup" "$abs"
    log "[$name] 注入步骤失败，已还原"
    FAILED=1
    return
  fi

  local test_exit=0
  "$@" >> "$LOG" 2>&1 || test_exit=$?

  cp "$backup" "$abs"
  local restored_sha
  restored_sha="$(sha256sum "$abs" | awk '{print $1}')"
  if [ "$restored_sha" != "$orig_sha" ]; then
    log "[$name] 还原校验失败：$orig_sha != $restored_sha"
    FAILED=1
    return
  fi

  local green_exit=0
  "$@" >> "$LOG" 2>&1 || green_exit=$?

  if [ "$test_exit" -ne 0 ] && [ "$green_exit" -eq 0 ]; then
    log "[$name] PASS 变异被捕获（变体退出码=$test_exit）且还原后回绿（shasum=$orig_sha）"
  elif [ "$test_exit" -eq 0 ]; then
    log "[$name] FAIL 变异未被任何断言捕获（变体仍退出码 0）"
    FAILED=1
  else
    log "[$name] FAIL 还原后未回绿（退出码=$green_exit）"
    FAILED=1
  fi
}

log "# #127 时间槽变异反证矩阵 $(date -Iseconds)（repo HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo n/a)）"
log ""

# ── M-A 删 G 类短路：CONTENT_SUSPECT 不再降级，叙事句被当成过滤窗 ──────────
mutate "M-A 删G类短路" src/memory/time-resolve.ts \
  "  if (ir.role === 'CONTENT' || ir.flags.includes('CONTENT_SUSPECT')) return 'CONTENT_TIME_SUSPECTED';" \
  "  if (false) return 'CONTENT_TIME_SUSPECTED';" \
  node --test tests/memory/time-resolve.test.ts

# ── M-B G 类强转硬裁决：UNCERTAIN 被当成确定冲突否决（违反宁空勿错）──────
mutate "M-B 不确定强转time-conflict" src/memory/gate.ts \
  "    return { admit: true, tag: 'time-uncertain-ignored' };" \
  "    return { admit: false, tag: 'time-conflict' };" \
  node --test tests/memory/gate-time-slot.test.ts

# ── M-C 非法日历日期 clamp：2 月 30 被私改成月末而非拒绝 ─────────────────
mutate "M-C 非法日期clamp" src/memory/time-resolve.ts \
  "      if (date.day < 1 || date.day > daysInMonth(date.year, date.month)) return null;
      return civilToDayIndex(date.year, date.month, date.day);" \
  "      if (false) return null;
      return civilToDayIndex(date.year, date.month, Math.min(date.day, daysInMonth(date.year, date.month)));" \
  node --test tests/memory/time-resolve.test.ts

# ── M-D 候选直取首项：OR 并集退化为只看第一个窗 ─────────────────────────
mutate "M-D 候选只取首项" src/memory/time-resolve.ts \
  "  const windowList = constraint.kind === 'WINDOW' ? [constraint.window] : constraint.windows;" \
  "  const windowList = constraint.kind === 'WINDOW' ? [constraint.window] : constraint.windows.slice(0, 1);" \
  node --test tests/memory/gate-time-slot.test.ts

# ── M-E 证明门橡皮图章：政策维被盖成 EXPLICIT 且不带版本留痕 ─────────────
mutate "M-E 证明门恒真" src/memory/time-resolve.ts \
  "  const yearState: ClosureState = explicit ? 'EXPLICIT' : 'POLICY';" \
  "  const yearState: ClosureState = 'EXPLICIT';" \
  node --test tests/memory/time-resolve.test.ts

# ── M-F Anchor 偷读系统时钟：注入锚点被 Date.now 覆盖（T9 静态门确定性抓红）──
mutate "M-F Anchor读系统时钟" src/memory/time-resolve.ts \
  "export function resolveTimeConstraint(text: string, anchor: TimeAnchor): TimeConstraint {
  const provenance = {" \
  "export function resolveTimeConstraint(text: string, anchor: TimeAnchor): TimeConstraint {
  anchor = { ...anchor, epochMs: Date.now() };
  const provenance = {" \
  node --test tests/memory/time-static-ban.test.ts

log ""
if [ "$FAILED" -eq 0 ]; then
  log "结论：6 项变异全部被捕获，且全部逐字节还原后回绿。日志：$LOG"
else
  log "结论：存在未捕获或还原不一致项，见上。日志：$LOG"
fi
exit "$FAILED"
