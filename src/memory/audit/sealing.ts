/**
 * P6 封存/解封工程（v4 §8、§9 序 9，G6）。
 *
 * 设计要点：
 *  - 封存目录独立于 dataRoot、独立于施工侧工作区；目录内只有夹具副本、清单与只追加解封日志；
 *  - 清单逐文件记 sha256/字节数，并固化 probeSetVersion、规则版本、RNG 种子、五层配额、诱饵对数；
 *  - verifySeal 重算全部哈希，任一字节不符/文件缺失即 G6 不通过（终判结果无效）；
 *  - 解封不是旗标而是留痕动作：每次读取 appendUnsealRecord 写一行（时间由调用方注入，本模块不读时钟）。
 *
 * 本模块做文件 IO 但不 import store/门面，保持审计侧依赖方向单向。
 */

import fs from 'node:fs';
import path from 'node:path';

import { IntegrityError, NotFoundError } from '../../core/errors.ts';
import { ensureDir, writeFileAtomic } from '../../core/fsx.ts';
import { sha256Hex } from '../content-hash.ts';

export const SEAL_MANIFEST_FILE = 'seal-manifest.json';
export const UNSEAL_LOG_FILE = 'unseal-log.jsonl';
const SEAL_SCHEMA = 'fasti-p6-seal/v1';

export interface SealFileRecord {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface SealManifest {
  readonly schema: typeof SEAL_SCHEMA;
  readonly probeSetVersion: string;
  readonly rulesVersion: string;
  readonly rngSeed: number;
  readonly sealedAtMs: number;
  readonly sealedBy: string;
  /** 五层配额（S0..S4 声明值；实际题数以夹具文件为准，哈希保证其不可被偷改）。 */
  readonly layerQuotas: Readonly<Record<string, number>>;
  readonly decoyPairCount: number;
  readonly files: readonly SealFileRecord[];
}

export interface SealParams {
  readonly sourceDir: string;
  readonly sealDir: string;
  readonly probeSetVersion: string;
  readonly rulesVersion: string;
  readonly rngSeed: number;
  readonly sealedAtMs: number;
  readonly sealedBy: string;
  readonly layerQuotas: Readonly<Record<string, number>>;
  readonly decoyPairCount: number;
}

export interface SealVerification {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly manifest: SealManifest;
}

/** 解封留痕字段（对齐 tests/fixtures/memory/README.md 模板：时间/操作人/版本/模式/折数/备注）。 */
export interface UnsealEntry {
  readonly atMs: number;
  readonly operator: string;
  readonly reason: string;
  readonly mode: 'holdout' | 'loeo';
  readonly folds: number | null;
  readonly note?: string;
}

/** 封存：拷贝源目录全部 .json 夹具并落清单（目标目录先清空，杜绝新旧文件混杂）。 */
export function sealFixtures(params: SealParams): SealManifest {
  if (!fs.existsSync(params.sourceDir) || !fs.statSync(params.sourceDir).isDirectory()) {
    throw new NotFoundError(`封存源目录不存在：${params.sourceDir}`);
  }
  const names = fs
    .readdirSync(params.sourceDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (names.length === 0) {
    throw new IntegrityError(`封存源目录无 .json 夹具：${params.sourceDir}`);
  }
  ensureDir(params.sealDir);
  for (const existing of fs.readdirSync(params.sealDir)) {
    fs.rmSync(path.join(params.sealDir, existing), { recursive: true, force: true });
  }
  const files: SealFileRecord[] = [];
  for (const name of names) {
    const raw = fs.readFileSync(path.join(params.sourceDir, name));
    files.push({ name, sha256: sha256Hex(raw), bytes: raw.length });
    fs.writeFileSync(path.join(params.sealDir, name), raw);
  }
  const manifest: SealManifest = {
    schema: SEAL_SCHEMA,
    probeSetVersion: params.probeSetVersion,
    rulesVersion: params.rulesVersion,
    rngSeed: params.rngSeed,
    sealedAtMs: params.sealedAtMs,
    sealedBy: params.sealedBy,
    layerQuotas: { ...params.layerQuotas },
    decoyPairCount: params.decoyPairCount,
    files,
  };
  writeFileAtomic(path.join(params.sealDir, SEAL_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function loadManifest(sealDir: string): SealManifest {
  const manifestPath = path.join(sealDir, SEAL_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw new NotFoundError(`封存清单不存在：${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SealManifest;
  if (manifest.schema !== SEAL_SCHEMA) {
    throw new IntegrityError(`封存清单 schema 不符：期望 ${SEAL_SCHEMA}，实得 ${String(manifest.schema)}`);
  }
  return manifest;
}

/** 核验封存：重算每个夹具哈希；缺失/不符逐条列入 errors，调用方据此 fail-closed。 */
export function verifySeal(sealDir: string): SealVerification {
  const manifest = loadManifest(sealDir);
  const errors: string[] = [];
  for (const record of manifest.files) {
    const filePath = path.join(sealDir, record.name);
    if (!fs.existsSync(filePath)) {
      errors.push(`封存夹具缺失：${record.name}`);
      continue;
    }
    const raw = fs.readFileSync(filePath);
    const actual = sha256Hex(raw);
    if (raw.length !== record.bytes) {
      errors.push(`封存夹具字节数不符：${record.name}（期望 ${record.bytes}，实得 ${raw.length}）`);
    }
    if (actual !== record.sha256) {
      errors.push(`封存夹具哈希不符：${record.name}（G6 失效）`);
    }
  }
  return { ok: errors.length === 0, errors, manifest };
}

/** 解封留痕：只追加一行 JSON，永不覆盖历史。 */
export function appendUnsealRecord(sealDir: string, entry: UnsealEntry): void {
  const verification = verifySeal(sealDir);
  if (!verification.ok) {
    throw new IntegrityError(`封存核验失败，禁止解封：${verification.errors.join('；')}`);
  }
  fs.appendFileSync(path.join(sealDir, UNSEAL_LOG_FILE), `${JSON.stringify(entry)}\n`);
}

/** 读回全部解封留痕（文件不存在视为空历史）。 */
export function readUnsealLog(sealDir: string): UnsealEntry[] {
  const logPath = path.join(sealDir, UNSEAL_LOG_FILE);
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as UnsealEntry);
}
