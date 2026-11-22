// pager.js —— 分页控件（上一页/下一页 + 页码/偏移显示）
// 两种模式：
//  - total 模式：端点回显 total，可计算页数；
//  - 无 total 模式（如 /api/cards）：以“是否满页”推断可能有下一页。

import { el } from './dom.js';
import { fmtNum } from './format.js';

export class Pager {
  /**
   * @param {object} opts
   * @param {(offset:number)=>void} opts.onChange 偏移变化回调
   * @param {string} [opts.noTotalHint] 无 total 时的提示文案
   */
  constructor({ limit = 25, onChange, noTotalHint = '数据源未回显总数，以满页推断是否有下一页' } = {}) {
    this.limit = limit;
    this.offset = 0;
    this.total = null;       // number | null
    this.loaded = 0;         // 当前页返回条数
    this.noOffsetMode = false; // 端点不支持 offset（事件端点兜底）
    this.onChange = onChange;
    this.noTotalHint = noTotalHint;
    this.root = el('div', { class: 'pager' });
    this.info = el('span', { class: 'pager-info' });
    this.btnPrev = el('button', { class: 'btn', type: 'button', text: '上一页' });
    this.btnNext = el('button', { class: 'btn', type: 'button', text: '下一页' });
    this.btnPrev.addEventListener('click', () => this.go(this.offset - this.limit));
    this.btnNext.addEventListener('click', () => this.go(this.offset + this.limit));
    this.root.append(this.btnPrev, this.info, this.btnNext);
    this.render();
  }

  reset() {
    this.offset = 0;
    this.render();
  }

  /** 端点不支持 offset 时降级：只显示总量说明 */
  setNoOffsetMode(total) {
    this.noOffsetMode = true;
    this.total = total;
    this.offset = 0;
    this.render();
  }

  /** 每次列表加载完成后回填 */
  update({ offset, loaded, total }) {
    this.offset = offset;
    this.loaded = loaded;
    if (total !== undefined) this.total = total;
    this.render();
  }

  go(nextOffset) {
    if (this.noOffsetMode) return;
    nextOffset = Math.max(0, Math.floor(nextOffset));
    if (this.total !== null) nextOffset = Math.min(nextOffset, Math.max(0, this.total - 1));
    if (nextOffset === this.offset) return;
    this.onChange(nextOffset);
  }

  render() {
    const { offset, limit, loaded, total } = this;
    this.btnPrev.disabled = this.noOffsetMode || offset <= 0;
    if (this.noOffsetMode) {
      const t = total ?? loaded;
      this.info.textContent = t
        ? `共 ${fmtNum(t)} 条 · 该端点仅支持返回最近 ${fmtNum(limit)} 条（不支持 offset 分页）`
        : '—';
      this.btnNext.disabled = true;
      return;
    }
    this.btnNext.disabled = total !== null
      ? offset + limit >= total
      : loaded < limit; // 未满页 ⇒ 认为没有下一页

    if (total !== null) {
      const pages = Math.max(1, Math.ceil(total / limit));
      const page = Math.floor(offset / limit) + 1;
      const from = total === 0 ? 0 : offset + 1;
      const to = Math.min(offset + loaded, total);
      this.info.textContent = loaded
        ? `第 ${page}/${pages} 页 · ${fmtNum(from)}–${fmtNum(to)} 条 / 共 ${fmtNum(total)} 条`
        : `第 ${page}/${pages} 页 · 共 ${fmtNum(total)} 条`;
    } else {
      this.info.textContent = loaded
        ? `偏移 ${fmtNum(offset)} · 已加载 ${fmtNum(offset + 1)}–${fmtNum(offset + loaded)} 条 · ${this.noTotalHint}`
        : `偏移 ${fmtNum(offset)} · ${this.noTotalHint}`;
    }
  }
}
