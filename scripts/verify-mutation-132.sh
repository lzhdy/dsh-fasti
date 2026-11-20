#!/usr/bin/env bash
# #132 时间结构识别扩面——六条核心变异反证矩阵（红测先行先红后绿的后半截）。
#
# 反证目标（每条变异都必须被断言捕获，且逐字节还原后回绿）：
#  - M-A 删方位词留痕：开放方位 flag 不再降级，无界说法被当成可产窗/静默 —— 抓"周日之后"归位
#  - M-B 月年偷偷 clamp：冻结粒度按月折算 30 天造窗 —— 抓"上两个月/上月"禁折算
#  - M-C 指代冒充日期：指代词被当相对日推算 —— 抓"上次/刚才/那会儿"日历永不解
#  - M-D 端点 off-by-one：前 N 天含今天（把 D0 挪进窗）—— 抓半开端点对称口径
#  - M-E 周滚动借 WEEK 粒度：后两周记 WEEK 传义整周 —— 抓"滚动不对齐周一、粒度 DAY"
#  - M-F 跨度证伪：RELATIVE_SPAN 绕过证明门直接用 makeWindow 前的裸毫秒 —— 抓 POLICY 六维归零
#
# 纪律（同 verify-mutation-44/127/131）：
#  - 每个变异：备份目标 → 精确注入 1 处（旧串须恰好 1 次）→ 跑指定红测（期望红）
#    → 备份整体回拷 → sha256 逐字校验 → 回绿复跑；
#  - 全程不触真实根、不做 git 写；只在工作树内临时改一处源码。
#
# 用法：bash scripts/verify-mutation-132.sh [日志路径]
# 退出码：0 = 六变异全被捕获且还原无损；1 = 存在未捕获或还原不一致。

set -u

MAIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MAIN" || exit 1

LOG="${1:-$MAIN/mutation-proof-132.log}"
: > "$LOG"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0

log() { printf '%s\n' "$*" | tee -a "$LOG"; }

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

log "# #132 时间结构识别扩面变异反证矩阵 $(date -Iseconds)（repo HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo n/a)）"
log ""

# ── M-A 删方位词留痕：开放方位不再降级，无界说法静默成 NONE/被当窗 ──────────────────
mutate "M-A 删开放方位留痕" src/memory/time-resolve.ts \
  "  if (ir.flags.includes('OPEN_DIRECTIONAL')) return 'OPEN_DIRECTIONAL_UNBOUNDED';" \
  "  if (false) return 'OPEN_DIRECTIONAL_UNBOUNDED';" \
  node --test tests/memory/time-relative-span.test.ts

# ── M-B 月年偷偷 clamp：冻结粒度按月折 30 天造窗（宁空勿错被破，clamp 出假窗）──────────
mutate "M-B 月年clamp30天" src/memory/time-resolve.ts \
  "  if (ir.flags.includes('GRAIN_NOT_SUPPORTED')) return 'GRAIN_NOT_SUPPORTED';" \
  "  if (false) return 'GRAIN_NOT_SUPPORTED';" \
  node --test tests/memory/time-relative-span.test.ts

# ── M-C 指代冒充日期：指代词不再走指代通道，被静默放过（日历永不解被动摇）─────────────
mutate "M-C 指代冒充日期" src/memory/time-resolve.ts \
  "  if (ir.flags.includes('DEICTIC_REFERENCE')) return 'DEICTIC_REFERENCE';" \
  "  if (false) return 'DEICTIC_REFERENCE';" \
  node --test tests/memory/time-relative-span.test.ts

# ── M-D 端点 off-by-one：前 N 天把今天挪进窗（不含今天→含今天，对称口径被破）───────────
mutate "M-D 端点off-by-one" src/memory/time-resolve.ts \
  "    case 'BACK':
      return { startDay: anchorDayIndex - nu, endDay: anchorDayIndex };" \
  "    case 'BACK':
      return { startDay: anchorDayIndex - nu, endDay: anchorDayIndex + 1 };" \
  node --test tests/memory/time-relative-span.test.ts

# ── M-E 周滚动借 WEEK 粒度传义：滚动两周被记成 WEEK 整周（不对齐周一、粒度 DAY 被破）────
mutate "M-E 周滚动借WEEK" src/memory/time-resolve.ts \
  "        window: makeWindow(dayStartMsOf(bounds.startDay), dayStartMsOf(bounds.endDay), 'DAY', spanProof)," \
  "        window: makeWindow(dayStartMsOf(bounds.startDay), dayStartMsOf(bounds.endDay), ir.date.unit === 'WEEK' ? 'WEEK' : 'DAY', spanProof)," \
  node --test tests/memory/time-relative-span.test.ts

# ── M-F 跨度证伪：证明门维数被删成空，窗仍被造出（闭合证明橡皮图章被破）────────────────
mutate "M-F 跨度证伪空证明" src/memory/time-resolve.ts \
  "function proveClosedness(ir: TimeIR, anchor: TimeAnchor): ClosednessProof {" \
  "function proveClosedness(ir: TimeIR, anchor: TimeAnchor): ClosednessProof {
  if (ir.date !== null && ir.date.kind === 'RELATIVE_SPAN') return Object.freeze({ dimensions: Object.freeze([]) });" \
  node --test tests/memory/time-relative-span.test.ts

log ""
if [ "$FAILED" -eq 0 ]; then
  log "结论：6 项变异全部被捕获，且全部逐字节还原后回绿。日志：$LOG"
else
  log "结论：存在未捕获或还原不一致项，见上。日志：$LOG"
fi
exit "$FAILED"
