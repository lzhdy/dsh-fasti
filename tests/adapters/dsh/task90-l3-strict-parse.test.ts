/**
 * #90 批 B2 · 适配器 strict 解析红测（正本 `docs/task90-l3-final-spec.md`
 * §2 / §4 / 验收⑬⑭）。
 *
 * seam 边界（主控裁定）：**适配器不知道 N**。`parseAnchorSerialsField(raw)` 只做
 * 结构性 strict：字段存在且为数组、每元素 `typeof number && Number.isSafeInteger`；
 * 非数组 / 非整数 / 非安全整数 / 混类型 / 字符串 / null 整份 reject，禁 `Number()`
 * 宽容转换，`3.0` 按值接受为 3。**1..N 范围与重复判定在 closure 侧
 * `resolveAnchorSerials`**（serial-table.ts 已实现，见 task90-serial-table 套件）。
 *
 * 候选线同理：`parseBoundaryCandidateSerials(raw)` 结构性逐条丢畸形、产出 number[]；
 * 1..N 未知序号的 fail-soft 由 closure 的 `resolveCandidateSerials` 做。
 *
 * 对照保留：
 *  - `key_points` 路径仍是 `stringArray` 静默 filter（非证据链字段，纪律不变）；
 *  - `boundary_candidates` 候选畸形逐条丢弃的 fail-soft 语义不变（展示附带字段）。
 *
 * 被测 strict 解析函数 seam 尚未落地，相关用例预期红（函数缺失 / 语义不符）；
 * 对照组走既有适配器行为，保持绿。只动 tests/。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDshLLMPort } from '../../../src/adapters/dsh/llm.ts';
import type { DshModelRoute } from '../../../src/adapters/dsh/llm.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// ── seam（适配器结构性 strict 字段解析；写者落地时可微调位置，函数名以正本为准）────────

interface StrictParseModule {
  /**
   * 结构性 strict：字段必须为数组，每元素 `typeof number && Number.isSafeInteger`；
   * 任一不符整份拒绝、不 filter、不半截、不 coerce。通过返回 number[]；违约抛可识别
   * 错误（closure 侧再做 1..N 范围 / 重复判定，转 EventSerialReferenceError）。
   */
  parseAnchorSerialsField?: (value: unknown) => number[];
  /** 候选结构性逐条丢畸形，产出 number[]；不做范围判定。 */
  parseBoundaryCandidateSerials?: (
    value: unknown,
  ) => { readonly serials: readonly number[]; readonly dropped: number };
}

// 静态引用适配器模块；seam 函数缺失时在调用点红，不连坐类型检查（沿用 #42 惯例）。
import * as adapterModule from '../../../src/adapters/dsh/llm.ts';
const seam = adapterModule as unknown as StrictParseModule;

// ── 既有假路由（记录请求，按预设返回正文）───────────────────────────────────────

class FakeRoute implements DshModelRoute {
  readonly calls: Array<{ system: string; user: string; model?: string }> = [];
  reply = '{"summary":"她打开了一个网页。","key_points":[],"anchor_serials":[]}';

  async complete(req: { system: string; user: string; model?: string }): Promise<string> {
    this.calls.push(req);
    return this.reply;
  }
}

const REQUEST = {
  system: '你是事件摘要器。',
  user: '事件时间范围：2026-11-08T10:00:00.000Z ~ 2026-11-08T10:05:00.000Z\n1. 原文',
  maxChars: 600,
};

// ═══════════════════════════════════════════════════════════════════════════════
// A. 结构性接受行（§4 表上半；范围 / 重复不在适配器层）
// ═══════════════════════════════════════════════════════════════════════════════

const STRUCT_ACCEPT: ReadonlyArray<{ label: string; value: unknown; expected: readonly number[] }> = [
  { label: '3.0 按值接受为 3（按值不按词法）', value: [3.0], expected: [3] },
  { label: '合法顺序 [1,2]（范围判定归 closure）', value: [1, 2], expected: [1, 2] },
  { label: '空数组 [] 形状合法', value: [], expected: [] },
];

for (const fixture of STRUCT_ACCEPT) {
  test(`strict 解析：${fixture.label} → number[]`, () => {
    assert.ok(seam.parseAnchorSerialsField !== undefined, 'seam：parseAnchorSerialsField 尚未导出');
    const parsed = seam.parseAnchorSerialsField!(fixture.value);
    assert.deepEqual(parsed, [...fixture.expected]);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// B. 结构性拒收行：整份拒绝，不洗成 []，不逐条过滤，不 Number() 转换
//    （负数 / 0 / N+1 / 重复 等范围与去重判定在 closure 侧 resolveAnchorSerials）
// ═══════════════════════════════════════════════════════════════════════════════

const STRUCT_REJECT: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: '非整数 3.5', value: [3.5] },
  { label: '字符串 "3"（禁 Number() 宽容转换）', value: ['3'] },
  { label: '字段缺失（undefined）', value: undefined },
  { label: 'null 非数组', value: null },
  { label: '非数组对象', value: {} },
  { label: '混类型 [1,"x"] 整份拒绝', value: [1, 'x'] },
  { label: '超大整数（非安全整数）', value: [Number.MAX_SAFE_INTEGER + 1] },
  { label: 'ULID 形态字符串整份拒绝（非 number 即违约）', value: ['01J0000000000000000000000A'] },
];

for (const fixture of STRUCT_REJECT) {
  test(`strict 解析：${fixture.label} → 抛可识别错误，绝不静默洗成 []`, () => {
    assert.ok(seam.parseAnchorSerialsField !== undefined, 'seam：parseAnchorSerialsField 尚未导出');
    let threw: unknown;
    try {
      seam.parseAnchorSerialsField!(fixture.value);
    } catch (error) {
      threw = error;
    }
    assert.ok(threw instanceof Error, '违约项必须抛错，不得返回 [] 半截结果');
    assert.notEqual(threw.name, 'Error', '错误须有可识别类名（供 closure  instanceof 捕获）');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// C. 对照保留：key_points 仍 stringArray 静默 filter（非证据链字段，纪律不变）
// ═══════════════════════════════════════════════════════════════════════════════

test('对照：key_points 路径非字符串条目仍被静默 filter，不抛错', async () => {
  const route = new FakeRoute();
  route.reply = JSON.stringify({
    summary: '摘要',
    key_points: ['要点一', 2, null, '要点二'],
    anchor_serials: [],
  });
  const port = createDshLLMPort(route);

  const response = await port.summarize(REQUEST);
  assert.deepEqual(response.keyPoints, ['要点一', '要点二']);
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. 对照保留：boundary_candidates 畸形条目逐条丢弃，摘要照常落盘（fail-soft）
// ═══════════════════════════════════════════════════════════════════════════════

test('对照：候选缺字段 / 非对象逐条丢弃，不影响摘要返回', async () => {
  const route = new FakeRoute();
  route.reply = JSON.stringify({
    summary: '摘要照常落盘',
    key_points: [],
    anchor_serials: [],
    boundary_candidates: [
      { kind: '话题跳转', at_pointer_serial: 1, marked_at: '2026-11-08T10:01:00.000Z' },
      null,
      { kind: '话题跳转', marked_at: '缺 at_pointer_serial' },
      { kind: '话题跳转', at_pointer_serial: 2, marked_at: '2026-11-08T10:02:00.000Z' },
    ],
  });
  const port = createDshLLMPort(route);

  const response = await port.summarize(REQUEST);
  assert.equal(response.summary, '摘要照常落盘');
  assert.equal(response.boundary_candidates?.length ?? 0, 2, '结构合法条目入候选；成员归属归内核筛');
});

test('候选序号结构性 fail-soft：结构畸形逐条丢弃；1..N 越界归内核 resolveCandidateSerials', () => {
  assert.ok(seam.parseBoundaryCandidateSerials !== undefined, 'seam：parseBoundaryCandidateSerials 尚未导出');
  // 适配器只做结构性校验：99 是安全整数 → 保留；'x' 非整数 → 结构丢弃。
  // 越界 99 的成员归属丢弃由内核 resolveCandidateSerials 统一计数（两段式）。
  const mixed = seam.parseBoundaryCandidateSerials!([1, 99, 'x', 2]);
  assert.deepEqual(mixed.serials, [1, 99, 2]);
  assert.equal(mixed.dropped, 1, '适配器层只计结构畸形 1 条');
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. 验收⑭：anchors 路径不得再存活 stringArray 旧反模式（key_points 保留是允许的）
// ═══════════════════════════════════════════════════════════════════════════════

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.split('//')[0] ?? '')
    .join('\n');
}

test('静态门：anchors 路径不再调用 stringArray；key_points 路径保留 stringArray', () => {
  // H3 起线协议解析收敛到宿主无关的 event/llm-wire-parse.ts（dsh/llm.ts 仅 re-export），
  // 静态门随被守实现迁移到新文件，断言强度（anchors 禁洗、key_points 保留 filter）不变。
  const file = path.join(REPO_ROOT, 'src', 'event', 'llm-wire-parse.ts');
  const code = stripComments(fs.readFileSync(file, 'utf8'));

  // 逐行区分两个路径：stringArray 的调用点只允许出现在 key_points 侧。
  const lines = code.split('\n');
  const anchorWashLines: string[] = [];
  let keyPointsUsesStringArray = false;
  lines.forEach((line, index) => {
    if (!line.includes('stringArray')) {
      return;
    }
    if (/key_?points/i.test(lines.slice(Math.max(0, index - 2), index + 1).join('\n'))) {
      keyPointsUsesStringArray = true;
      return;
    }
    anchorWashLines.push(`${index + 1}: ${line.trim()}`);
  });

  assert.deepEqual(anchorWashLines, [], 'anchors 路径的 stringArray 旧反模式必须清除');
  assert.equal(keyPointsUsesStringArray, true, 'key_points 路径纪律不变，仍保留 stringArray filter');
});
