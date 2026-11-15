/**
 * #42 · B0-G4 红测：M6 探针 P-10、观测行契约（§3.3）、audit 三率骨架（§2.7）。
 *
 * 说明：
 *  - P-09（REALTIME_DIRS 恒定集合）按要求追加在 tests/memory/schema.test.ts 末尾；
 *  - 本文件不重复造 extractImportRecords（既有 P-05 动态 import() 回归位已覆盖）；
 *  - 不写 P-04（主控裁决：既有 api→assembly 引用为基线事实，待裁决）；
 *  - R-10（离线持锁 → `writer-lock-held`）随 B2 批次落红测，B2 内红→绿；本轮不落，避免跨批常红。
 *  - 本文件只写测试，绝不改 src/。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MEMORY_TOOL_NAMES } from '../../src/adapters/dsh/memory-tool-bridge.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ═══════════════════════════════════════════════════════════════════════════
// P-10：宿主工具表内容快照 —— 第六法之外不得私增 build/apply/drain/derive 语义工具。
// ═══════════════════════════════════════════════════════════════════════════

const BASELINE_TOOL_NAMES = [
  'fasti_memory_add_alias',
  'fasti_memory_cards_by_anchor',
  'fasti_memory_experience_summary',
  'fasti_memory_raw_text',
  'fasti_memory_resolve_pointer',
  'fasti_memory_search',
];

test('P-10：工具表快照恰为基线六法，无第七法', () => {
  const names = Object.values(MEMORY_TOOL_NAMES).sort();
  assert.deepEqual(names, [...BASELINE_TOOL_NAMES].sort());
});

test('P-10：工具名不得携带 drain/projection/build/apply/derive 语义，不注册 drainProjection', () => {
  const names = Object.values(MEMORY_TOOL_NAMES);
  const forbidden = /drain|projection|build|apply|derive/i;
  for (const name of names) {
    assert.ok(!forbidden.test(name), `工具名 ${name} 命中 build/apply/drain/derive/projection 语义`);
  }
  assert.ok(!(names as string[]).includes('drainProjection'), '第七法 drainProjection 不得出现在宿主工具表');

  const bridgeText = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'adapters', 'dsh', 'memory-tool-bridge.ts'),
    'utf8',
  );
  assert.ok(!/drainProjection/.test(bridgeText), 'bridge 源码不得注册 drainProjection 工具');
});

// ═══════════════════════════════════════════════════════════════════════════
// §3.3 观测行契约（drain-observations.jsonl）
// 行形状：{ id, event_id, version_token, reason_code, snapshot_hash, at_ms }
// 版本身份复合键 versionToken = `${event_id}#v${version}`（主控裁决：EventRecord 无
// 逐版本 ULID，不再使用 version_ulid 字段）；reason_code 受控码表；
// id = 内容键 `sha256(event_id|version_token|reason_code)` 切片；同三元组不倍增。
// ═══════════════════════════════════════════════════════════════════════════

const CONTROLLED_REASON_CODES = [
  'anchor-form-invalid',
  'anchor-not-found',
  'empty-anchors',
  'judgment-unapplicable',
  'drain-permanent-tx',
] as const;

interface ObservationRow {
  id: string;
  event_id: string;
  version_token: string;
  reason_code: string;
  snapshot_hash: string;
  at_ms: number;
}

interface ObservationsModule {
  readonly OBSERVATION_REASON_CODES: readonly string[];
  observationId: (eventId: string, versionToken: string, reasonCode: string) => string;
  validateObservation: (row: unknown) => ObservationRow;
  mergeObservations: (
    existing: readonly ObservationRow[],
    incoming: readonly ObservationRow[],
  ) => ObservationRow[];
}

const OBS_URL = new URL('../../src/memory/observations.ts', import.meta.url);

async function loadObservations(): Promise<ObservationsModule> {
  const mod = (await import(OBS_URL.href)) as Partial<ObservationsModule>;
  assert.equal(
    typeof mod.observationId,
    'function',
    'observations.ts 须导出 observationId（§3.5 内容键派生 id）',
  );
  assert.equal(
    typeof mod.validateObservation,
    'function',
    'observations.ts 须导出 validateObservation（行形状/码表校验）',
  );
  assert.equal(
    typeof mod.mergeObservations,
    'function',
    'observations.ts 须导出 mergeObservations（三元组幂等去重）',
  );
  return mod as ObservationsModule;
}

const OBS_EVENT = 'evt-obs-1';
/** 版本身份复合键：`event_id#v${version}`（主控裁决口径，替代旧 version_ulid）。 */
const OBS_VERSION_TOKEN = `${OBS_EVENT}#v1`;
const OBS_REASON = 'anchor-form-invalid';

function expectedObservationId(eventId: string, versionToken: string, reasonCode: string): string {
  return createHash('sha256').update(`${eventId}|${versionToken}|${reasonCode}`).digest('hex').slice(0, 32);
}

test('§3.3 reason_code 受控码表恰为正本五条', async () => {
  const observations = await loadObservations();
  assert.deepEqual([...observations.OBSERVATION_REASON_CODES].sort(), [...CONTROLLED_REASON_CODES].sort());
});

test('§3.5 观测行 id：内容键 sha256 切片，同键同 id、异键异 id（固定向量钉死）', async () => {
  const observations = await loadObservations();
  const id = observations.observationId(OBS_EVENT, OBS_VERSION_TOKEN, OBS_REASON);
  // 固定向量：sha256("evt-obs-1|evt-obs-1#v1|anchor-form-invalid") 前 32 位。
  assert.equal(id, '9570ec16144cb24eff451092794438c6');
  assert.equal(id, expectedObservationId(OBS_EVENT, OBS_VERSION_TOKEN, OBS_REASON));
  assert.equal(id, observations.observationId(OBS_EVENT, OBS_VERSION_TOKEN, OBS_REASON), '同键确定性');

  const other = observations.observationId('evt-obs-2', OBS_VERSION_TOKEN, OBS_REASON);
  assert.notEqual(other, id);
  assert.notEqual(observations.observationId(OBS_EVENT, `${OBS_EVENT}#v2`, OBS_REASON), id);
  assert.notEqual(observations.observationId(OBS_EVENT, OBS_VERSION_TOKEN, 'empty-anchors'), id);
});

function sampleRow(overrides: Partial<ObservationRow> = {}): ObservationRow {
  return {
    id: expectedObservationId(OBS_EVENT, OBS_VERSION_TOKEN, OBS_REASON),
    event_id: OBS_EVENT,
    version_token: OBS_VERSION_TOKEN,
    reason_code: OBS_REASON,
    snapshot_hash: 'deadbeef',
    at_ms: 1_772_000_000_000,
    ...overrides,
  };
}

test('§3.3 行形状：合法行通过；缺字段/未知码表/错类型拒绝', async () => {
  const observations = await loadObservations();
  assert.deepEqual(observations.validateObservation(sampleRow()), sampleRow());

  const badShapes: unknown[] = [
    {},
    sampleRow({ event_id: '' }),
    sampleRow({ reason_code: 'web_search' }),
    { ...sampleRow(), version_token: 123 } as unknown as ObservationRow,
    { ...sampleRow(), at_ms: 'not-a-number' } as unknown as ObservationRow,
    sampleRow({ snapshot_hash: '' }),
  ];
  for (const bad of badShapes) {
    assert.throws(() => observations.validateObservation(bad), '非法观测行必须拒绝');
  }
});

test('§3.3 幂等：同 (event_id, version_token, reason_code) 重复写不倍增', async () => {
  const observations = await loadObservations();
  const first = sampleRow();
  const duplicate = sampleRow({ snapshot_hash: 'cafebabe' });
  const merged = observations.mergeObservations([first], [duplicate]);
  assert.equal(merged.length, 1, '三元组重复只留一条');
  const otherReason = sampleRow({
    reason_code: 'empty-anchors',
    id: expectedObservationId(OBS_EVENT, OBS_VERSION_TOKEN, 'empty-anchors'),
  });
  const withOther = observations.mergeObservations([first], [duplicate, otherReason]);
  assert.equal(withOther.length, 2, '不同 reason_code 视为不同观测');
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.7 audit 三率骨架：读观测行 + 真源事件版本数，产出 dangling/empty/malformed
// 可复算报告；离线 dry-run 纯函数，不接运行期、不落告警设施。
// ═══════════════════════════════════════════════════════════════════════════

interface AuditRates {
  readonly counts: { dangling: number; empty: number; malformed: number; other: number };
  readonly rates: { danglingRate: number; emptyRate: number; malformedRate: number };
  readonly totalEventVersions: number;
}

interface AuditModule {
  computeRates: (observations: readonly ObservationRow[], totalEventVersions: number) => AuditRates;
}

const AUDIT_URL = new URL('../../src/memory/audit/rates.ts', import.meta.url);

async function loadAudit(): Promise<AuditModule> {
  const mod = (await import(AUDIT_URL.href)) as Partial<AuditModule>;
  assert.equal(typeof mod.computeRates, 'function', 'audit/rates.ts 须导出 computeRates（§2.7 三率）');
  return mod as AuditModule;
}

test('§2.7 三率：dangling=anchor-not-found / empty=empty-anchors / malformed=anchor-form-invalid，可复算', async () => {
  const audit = await loadAudit();
  const rows: ObservationRow[] = [
    sampleRow({ reason_code: 'anchor-form-invalid' }),
    sampleRow({ reason_code: 'anchor-form-invalid', id: 'mal-2' }),
    sampleRow({ reason_code: 'anchor-not-found', id: 'dang-1' }),
    sampleRow({ reason_code: 'empty-anchors', id: 'empty-1' }),
    sampleRow({ reason_code: 'judgment-unapplicable', id: 'other-1' }),
    sampleRow({ reason_code: 'drain-permanent-tx', id: 'other-2' }),
  ];
  const report = audit.computeRates(rows, 10);
  assert.deepEqual(report.counts, { dangling: 1, empty: 1, malformed: 2, other: 2 });
  assert.equal(report.rates.malformedRate, 2 / 10);
  assert.equal(report.rates.danglingRate, 1 / 10);
  assert.equal(report.rates.emptyRate, 1 / 10);
  assert.equal(report.totalEventVersions, 10);
});

test('§2.7 三率：真源版本数为 0 时比率为 0，不除零、不伪造', async () => {
  const audit = await loadAudit();
  const report = audit.computeRates([sampleRow()], 0);
  assert.equal(report.rates.danglingRate, 0);
  assert.equal(report.rates.emptyRate, 0);
  assert.equal(report.rates.malformedRate, 0);
  assert.equal(report.counts.malformed, 1);
});
