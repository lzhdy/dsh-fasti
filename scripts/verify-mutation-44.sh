#!/usr/bin/env bash
# #44 第一层 变异反证矩阵（提案 §8.5 十项；#54）
#
# 纪律：
#  - 每个变异：备份目标文件 → 精确注入 1 处 → 跑指定测试（期望红）→ 逐字节还原 → sha256 校验 → 回绿复跑；
#  - 还原用备份副本整体回拷（不靠反向替换），并以 sha256 与原值逐字比对；
#  - 全程不触真实根、不做 git 写；只在工作树内临时改一处源码/测试。
#
# 用法：bash scripts/verify-mutation-44.sh [日志路径]
# 退出码：0 = 全部变异均被捕获且还原无损；1 = 存在未被捕获或还原不一致。

set -u

MAIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MAIN" || exit 1

LOG="${1:-$MAIN/mutation-proof-44.log}"
: > "$LOG"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0

log() { printf '%s\n' "$*" | tee -a "$LOG"; }

# mutate <名字> <相对路径> <python 替换旧串文件> <新串> <跑测试命令...>
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

  # 逐字节还原并校验
  cp "$backup" "$abs"
  local restored_sha
  restored_sha="$(sha256sum "$abs" | awk '{print $1}')"
  if [ "$restored_sha" != "$orig_sha" ]; then
    log "[$name] 还原校验失败：$orig_sha != $restored_sha"
    FAILED=1
    return
  fi

  # 回绿确认：还原后复跑同一组测试
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

log "# #44 变异反证矩阵 $(date -Iseconds)（repo HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo n/a)）"
log ""

# ── M1 门退化：弱通道不再拒（旧「命中即返回」）────────────────────────────
mutate "M1 门退化(全部接受)" src/memory/gate.ts \
  "    if (decision.accept) {" "    if (decision.accept || true) {" \
  node --test tests/memory/gate.test.ts tests/memory/gate-smoke.test.ts

# ── M2 门全拒：强通道也被拒（过度加严）──────────────────────────────────
mutate "M2 门全拒(强制弃权)" src/memory/gate.ts \
  "    if (decision.accept) {" "    if (decision.accept && false) {" \
  node --test tests/memory/gate.test.ts

# ── M3 ASCII 词边界失效（git 误吃 github）──────────────────────────────
mutate "M3 关闭ASCII边界" src/memory/gate.ts \
  "  if ([...qNorm].some((ch) => (ch.codePointAt(0) ?? 0) > 127)) {" "  if (true) {" \
  node --test tests/memory/gate.test.ts tests/memory/gate-smoke.test.ts

# ── M4 敏感别名进 FTS ───────────────────────────────────────────────────
mutate "M4 敏感词进FTS" src/memory/fts.ts \
  "    .filter((alias) => alias.status === 'active' && alias.sensitive === 0)" \
  "    .filter((alias) => alias.status === 'active')" \
  node --test tests/memory/bm25.test.ts

# ── M5 合入时丢弃既有别名（clobber）────────────────────────────────────
mutate "M5 clobber既有别名" src/memory/alias-write.ts \
  "  const merged = [...objects, added];" "  const merged = [added];" \
  node --test tests/memory/alias-write.test.ts

# ── M6 sensitive 1→0 降级 ──────────────────────────────────────────────
mutate "M6 sensitive降级" src/memory/alias-write.ts \
  "    source: 'miss',
    sensitive: input.sensitive," \
  "    source: 'miss',
    sensitive: 0," \
  node --test tests/memory/alias-write.test.ts

# ── M7 每卡上限失效（第 6 条不再拒）─────────────────────────────────────
mutate "M7 上限失效" src/memory/alias-write.ts \
  "export const MAX_MISS_ALIASES_PER_CARD = 5;" "export const MAX_MISS_ALIASES_PER_CARD = 999;" \
  node --test tests/memory/alias-write.test.ts

# ── M8 source 不再是 'miss' ─────────────────────────────────────────────
mutate "M8 source非miss" src/memory/alias-write.ts \
  "    source: 'miss',
    sensitive: input.sensitive,
    status: 'active'," \
  "    source: 'user' as unknown as 'miss',
    sensitive: input.sensitive,
    status: 'active'," \
  node --test tests/memory/alias-write.test.ts

# ── M9 窄写写错列（等价「写 display_cues」）─────────────────────────────
mutate "M9 写错列(碰display_cues)" src/memory/alias-write.ts \
  "  'UPDATE mem_card SET aliases_json = ?, content_hash = ? WHERE card_id = ?';" \
  "  'UPDATE mem_card SET display_cues_json = ?, content_hash = ? WHERE card_id = ?';" \
  node --test tests/memory/alias-write.test.ts

# ── M10 运行期读柄获得写方法（类型层）──────────────────────────────────
mutate "M10 读柄加写方法" src/memory/store.ts \
  "  search(query: SearchQuery): Promise<RankedCard[]>;" \
  "  search(query: SearchQuery): Promise<RankedCard[]>;
  writeAliases(): void;" \
  npm run typecheck

# ── M11 烟测出现写库调用（只读自证应红）────────────────────────────────
mutate "M11 烟测写库" tests/memory/gate-smoke.test.ts \
  "import { normalizeQuery, searchCardsExplained } from '../../src/memory/bm25.ts';" \
  "import { normalizeQuery, searchCardsExplained } from '../../src/memory/bm25.ts';
import { applyMissAlias } from '../../src/memory/alias-write.ts';
void applyMissAlias;" \
  node --test tests/memory/gate-smoke.test.ts

# ── M12 旧 r2 口径反转（N6 回归：错误率误成准确率）──────────────────────
mutate "M12 旧r2口径反转" src/memory/audit/four-state.ts \
  "      if (cls !== 'correct-commit') {
        legacyError += 1;
      }" \
  "      if (cls === 'correct-commit') {
        legacyError += 1;
      }" \
  node --test tests/memory/four-state.test.ts tests/memory/gate-smoke.test.ts

log ""
if [ "$FAILED" -eq 0 ]; then
  log "结论：12 项变异全部被捕获，且全部逐字节还原后回绿。日志：$LOG"
else
  log "结论：存在未捕获或还原不一致项，见上。日志：$LOG"
fi
exit "$FAILED"
