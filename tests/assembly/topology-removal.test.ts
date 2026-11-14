/**
 * #114 拓扑拆除红测（附录 E.4/E.6）——本文件只依赖 node 内置与**现存**模块，
 * 因此今天就能运行：拆除未完成时每条新拓扑断言都应如实报红，完工后转绿。
 *
 * 覆盖：
 *  1. 六个生产文件零 Legacy 符号（含注释，不允许换个名字残留）；
 *  2. runbook 旧口径 grep 零命中（6 行旧表述同批改写）；
 *  3. 结构墙：独立文件 assembly/source-lookup.ts 存在且不 import api/* 与 node:fs；
 *     memory-tools.ts 的 import 图既不碰 source-lookup 也不碰 api/*；
 *  4. 装配目录静态门：api/* 禁入，含投毒探针反证；
 *  5. shadow 行为新拓扑：observing 空信封（无 source、cards 恒 []、serialMap 恒空 Map）、
 *     影子事实恰七字段且 candidateCount 取门过滤前全集、countScope='gated-full'；
 *  6. observing 不得进入受控门状态枚举（shadow 写面 fail-closed 守卫）；
 *  7. off 仍靠不注册保持零变化（守卫项，今天即应绿）。
 *
 * 纪律：只读源码文本与内存假对象，临时根/注入时钟，不触真实数据根。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createMemoryTools } from '../../src/assembly/memory-tools.ts';
import type {
  ExplainedRankedCard,
  MemoryCard,
  MissObservationInput,
} from '../../src/memory/types.ts';
import type {
  RuntimeAddMissAliasInput,
  RuntimeMemoryHandle,
  RuntimeSearchQuery,
} from '../../src/memory/runtime.ts';
import type {
  MemoryGateMode,
  ShadowFact,
  ShadowSink,
} from '../../src/assembly/memory-tools.ts';
import { IntegrityError } from '../../src/core/errors.ts';
import { validateShadowInput } from '../../src/memory/shadow-write.ts';
import { wireMemoryTools } from '../../src/adapters/dsh/memory-tool-bridge.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.parse('2026-11-10T08:00:00.000Z');
const fixedNow = (): number => NOW;

const DEMOLITION_FILES = [
  'src/assembly/memory-tools.ts',
  'src/assembly/host-tool-runtime.ts',
  'src/adapters/dsh/memory-tool-bridge.ts',
  'src/adapters/dsh/plugin.ts',
  'src/memory/audit/four-state.ts',
  'src/memory/shadow-write.ts',
] as const;

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function listTsRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsRecursive(full));
    else if (entry.name.endsWith('.ts')) {
      out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    }
  }
  return out;
}

// ── 1. 符号清零 ──────────────────────────────────────────────────────────────

test('拓扑：六个生产文件拆除后不得残留任何 legacy 符号（标识符/字符串/注释）', () => {
  const hits: string[] = [];
  for (const relPath of DEMOLITION_FILES) {
    const text = read(relPath);
    for (const [index, line] of text.split('\n').entries()) {
      if (/legacy/i.test(line)) hits.push(`${relPath}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, [], '仍存在 legacy 残留，拆除未收口');
});

test('拓扑（S2 收口）：六个拆除文件内旧双形态符号零出现，豁免只给影子读取器', () => {
  const scanned = DEMOLITION_FILES.map(read).join('\n');
  for (const token of ["'legacy'", "'gate'", 'legacy-ok', 'source:', 'legacyCount']) {
    assert.ok(!scanned.includes(token), `旧双形态符号未清零：${token}`);
  }
});

test('兼容豁免（S1/S2）：全 src 仅 audit/shadow-read.ts 可出现 legacyCount 字面量，且限 1 处兼容分支、零写原语', () => {
  const readerRel = 'src/memory/audit/shadow-read.ts';
  const readerAbs = path.join(REPO_ROOT, readerRel);
  assert.ok(fs.existsSync(readerAbs), '影子观测读取器尚未创建（Q4 同口径分段的数据来源）');
  const readerText = read(readerRel);

  // 豁免字面量：至多 1 处，且必须位于显式标注的旧行兼容分支。
  const occurrences = readerText.split('\n').filter((line) => line.includes('legacyCount'));
  assert.ok(occurrences.length <= 1, `兼容字面量至多 1 处，实有 ${occurrences.length} 处`);
  if (occurrences.length === 1) {
    assert.ok(/compat|旧行|历史/i.test(occurrences[0]!), 'legacyCount 只能出现在旧行兼容分支并显式标注');
  }

  // 只读纪律：读取器不得持有任何写/建目录原语，兼容分支不可能回写 JSONL。
  for (const writePrim of ['appendFileSync', 'writeFileSync', 'mkdirSync', 'rmSync', 'truncate']) {
    assert.ok(!readerText.includes(writePrim), `读取器出现写原语 ${writePrim}，违反 append-only`);
  }

  // 全 src 其余任何文件不得再出现 legacyCount 字面量。
  const srcDir = path.join(REPO_ROOT, 'src');
  const allTs = listTsRecursive(srcDir);
  for (const rel of allTs) {
    if (rel === readerRel) continue;
    assert.ok(!read(rel).includes('legacyCount'), `${rel} 不得引用旧字段名，兼容口径只属于读取器`);
  }
});

test('runbook（S3 修正）：排除 55/56"旧路径"文件路径语义后，旧召回路口径 grep 零命中', () => {
  const runbook = read('docs/memory-runtime-q3-runbook.md');
  // 55/56 行的"旧路径"指文件路径而非旧召回路，显式剔除后再判。
  const scanned = runbook
    .split('\n')
    .filter((line) => !/旧路径/.test(line))
    .join('\n');
  for (const token of [
    'legacyCount',
    'legacy-ok',
    "source==='legacy'",
    'legacy 主返回',
    'legacy主返回',
  ]) {
    assert.ok(!scanned.includes(token), `runbook 仍含旧口径：${token}`);
  }
  assert.ok(!/旧路(?!径)/.test(scanned), 'runbook 仍残留旧召回路表述（"旧路径"已豁免）');
});

// ── 2. 结构墙：source-lookup 独立文件 + import 图隔离 ─────────────────────────

test('结构墙：assembly/source-lookup.ts 作为独立文件存在，且不 import api/*、node:fs 与 node:sqlite', () => {
  const relPath = 'src/assembly/source-lookup.ts';
  assert.ok(fs.existsSync(path.join(REPO_ROOT, relPath)), 'source-lookup.ts 尚未创建');
  const text = read(relPath);
  assert.ok(!/from\s+['"][^'"]*\/api\//.test(text), '端口文件不得 import 门面 api/*');
  assert.ok(!/from\s+['"]node:fs['"]/.test(text), '端口文件不得直开 node:fs');
  assert.ok(!/from\s+['"]node:sqlite['"]/.test(text), '端口文件不得自开 node:sqlite 连接');
  assert.ok(!/\bnew\s+DatabaseSync\b/.test(text), '端口文件不得 new DatabaseSync');
});

test('结构墙：memory-tools.ts 的 import 图不碰 source-lookup 与 api/*（消费隔离在独立文件）', () => {
  const text = read('src/assembly/memory-tools.ts');
  assert.ok(!/source-lookup/.test(text), 'memory-tools 不得 import 端口消费模块');
  assert.ok(!/from\s+['"][^'"]*\/api\//.test(text), '内核不得 import 门面');
});

test('静态门：src/assembly 全目录禁 import api/*，投毒探针必须被本地规则标红', () => {
  const assemblyDir = path.join(REPO_ROOT, 'src/assembly');
  const files = fs.readdirSync(assemblyDir).filter((name) => name.endsWith('.ts'));
  const violatesApiWall = (text: string): boolean =>
    /(?:import|export)[\s\S]*?from\s+['"][^'"]*\/api\//.test(text) ||
    /import\(\s*['"][^'"]*\/api\//.test(text);
  for (const name of files) {
    assert.ok(!violatesApiWall(read(path.join('src/assembly', name))), `${name} 越界 import 门面`);
  }
  // 变异反证：把探针换成门面导入，规则必须报红。
  const probe = "import { Fasti } from '../../api/index.ts';\n";
  assert.ok(violatesApiWall(probe), 'api/* 静态门探针失效（暗道可被绕过）');
});

test('唯一入口（S5）：装配层顶层导出面白名单——除登记例外外禁止任何导出直接返回候选/信封/门结果类型', () => {
  // 命中"顶层导出函数/常量 whose 显式返回类型引用候选形状"的形态；createMemoryTools 返回的
  // MemoryTools 工具集是模型侧唯一合法候选出口（经 gatedSearch 方法闭包），不在顶层返回类型上具名。
  // 四类形态全封：DTO 卡、对外信封、门结果、门内排序卡数组（防 searchLite 换类型绕墙）。
  const CANDIDATE_TYPES = 'GatedCardView|GatedSearchView|GatedSearchOutcome|GatedRankedCard';
  const candidateReturningExport = (text: string): string[] => {
    const re = new RegExp(
      `export\\s+(?:async\\s+)?(?:function|const)\\s+(\\w+)[^;{]*?\\)\\s*:\\s*[^;{]*\\b(?:${CANDIDATE_TYPES})\\b`,
      'g',
    );
    return [...text.matchAll(re)].map((match) => match[1] as string);
  };
  // 唯一登记例外：gatedSearch 闭包内部依赖的门结果装配函数；若它被改名/删除，本测试必须报红，
  // 不允许白名单里挂着找不到的幽灵例外。
  const ALLOWLIST = new Set(['src/assembly/index.ts:runGatedSearch']);

  const assemblyDir = path.join(REPO_ROOT, 'src/assembly');
  const seenAllowlisted = new Set<string>();
  for (const name of fs.readdirSync(assemblyDir).filter((file) => file.endsWith('.ts'))) {
    const rel = path.join('src/assembly', name);
    for (const symbol of candidateReturningExport(read(rel))) {
      const key = `${rel}:${symbol}`;
      assert.ok(ALLOWLIST.has(key), `未登记的候选返回导出，唯一入口被绕过：${key}`);
      seenAllowlisted.add(key);
    }
  }
  assert.deepEqual([...seenAllowlisted].sort(), [...ALLOWLIST].sort(), '白名单例外与实际导出必须一一对应');

  // 变异探针：换 DTO、换 outcome、换门内卡数组，三种旁路都必须被规则当场捕获。
  const probes: Array<[string, string]> = [
    ['export function searchLite(): GatedCardView[] {\n  return [];\n}\n', 'searchLite'],
    ['export async function searchLite2(): Promise<GatedSearchOutcome> {\n}\n', 'searchLite2'],
    ['export function searchLite3(): GatedRankedCard[] {\n  return [];\n}\n', 'searchLite3'],
  ];
  for (const [probe, expected] of probes) {
    assert.deepEqual(candidateReturningExport(probe), [expected], `唯一入口白名单探针失效：${expected}`);
  }
});

// ── 3. shadow 新拓扑行为（当前实现应报红）─────────────────────────────────────

let seq = 0;
function mkExplained(cardId: string, matchKinds: ExplainedRankedCard['matchKinds']): ExplainedRankedCard {
  seq += 1;
  const n = seq;
  const card: MemoryCard = {
    cardId,
    eventId: `evt_${n}`,
    anchorJson: JSON.stringify([`exp_${n}`]),
    channel: 'dsh',
    cardType: 'event',
    selection: 'selected',
    weight: 0,
    displayCuesJson: JSON.stringify([]),
    aliasesJson: JSON.stringify([]),
    discriminator: '',
    entityHintJson: null,
    occurredMs: NOW - 1000,
    endedMs: NOW,
    validMs: NOW - 2000,
    invalidMs: null,
    createdMs: NOW - 2000,
    expiredMs: null,
    status: 'active',
    contentHash: `hash_${n}`,
    hitCount: 0,
    lastHitMs: null,
    schemaVersion: 1,
  };
  return { card, scoreParts: { bm25: 0, recency: 0 }, matchedTerms: [], matchKinds };
}

function makeHandle(explained: ExplainedRankedCard[]): RuntimeMemoryHandle {
  return {
    async searchExplained(_query: RuntimeSearchQuery): Promise<ExplainedRankedCard[]> {
      return explained;
    },
    getCardsByAnchor(): MemoryCard[] {
      return [];
    },
    addMissAlias(input: RuntimeAddMissAliasInput) {
      return { ok: true as const, changed: true, cardId: input.cardId, termNorm: input.term,
        aliasesJson: '[]', contentHash: 'h' };
    },
    recordMiss(_input: MissObservationInput): void {},
    recordShadowObservation() {
      return { ok: false as const, reason: 'test-uses-injected-sink' };
    },
    async close(): Promise<void> {},
  };
}

function makeSink(): { records: ShadowFact[]; sink: ShadowSink } {
  const records: ShadowFact[] = [];
  return { records, sink: { record: (fact) => records.push(fact) } };
}

function build(mode: MemoryGateMode, handle: RuntimeMemoryHandle | null) {
  const sinkBox = makeSink();
  const tools = createMemoryTools({
    mode,
    now: fixedNow,
    handle,
    sink: sinkBox.sink,
    missChannel: 'dsh',
  });
  return { tools, sinkBox };
}

test('shadow：对外 observing 空信封——无 source 键、cards 恒 []、serialMap 恒空 Map', async () => {
  const handle = makeHandle([
    mkExplained('mc_weak', ['like-fallback']),
    mkExplained('mc_strong', ['exact-alias']),
  ]);
  const { tools, sinkBox } = build('shadow', handle);

  const view = await tools.gatedSearch({ text: 'cat', limit: 2 });

  // 经宽化信封做结构断言，避免当前旧类型把新形状收窄成 never；断言语义只认客观键集。
  const envelope = view as unknown as Record<string, unknown>;
  assert.equal(view.status, 'observing');
  assert.ok(!('source' in envelope), '信封不得再带 source 双形态键');
  assert.deepEqual(envelope.cards, []);
  assert.deepEqual(envelope.serialMap, new Map());
  assert.equal(sinkBox.records.length, 1, 'shadow 仍须跑门并写一条观测');
});

test('shadow（S4 因果对照）：limit 只作用于 accepted、不作用于 candidateCount', async () => {
  // 两张候选都走 exact-alias 强通道（gate.ts 无条件过门），排除"门裁决先拒掉一张"的混淆，
  // 让 accepted 的差异只能由 limit 解释。
  const fixture = [
    mkExplained('mc_pass_a', ['exact-alias']),
    mkExplained('mc_pass_b', ['exact-alias']),
  ];

  // 无 limit：两张全过门，accepted=2、candidateCount=2。
  const unlimited = build('shadow', makeHandle(fixture));
  await unlimited.tools.gatedSearch({ text: 'cat' });
  const unlimitedFact = unlimited.sinkBox.records[0];
  assert.ok(unlimitedFact);
  assert.equal(unlimitedFact.candidateCount, 2, '无 limit 时门过滤前全集为 2');
  assert.equal(unlimitedFact.acceptedCount, 2, '无 limit 时两张强通道卡全部过门');
  assert.equal(unlimitedFact.countScope, 'gated-full');

  // 同一夹具 limit=1：全集计数仍为 2，仅 accepted 截成 1——证死截断发生在门后而非检索前。
  const limited = build('shadow', makeHandle(fixture));
  await limited.tools.gatedSearch({ text: 'cat', limit: 1 });
  const limitedFact = limited.sinkBox.records[0];
  assert.ok(limitedFact);
  assert.equal(limitedFact.candidateCount, 2, 'candidateCount 是门过滤前全集，不受 limit=1 截断');
  assert.equal(limitedFact.acceptedCount, 1, 'limit=1 只截断 accepted');
});

test('shadow：窄柄未就绪（handle=null）回 observing 空信封，不写观测、不抛错', async () => {
  const { tools, sinkBox } = build('shadow', null);
  const view = await tools.gatedSearch({ text: '猫' });
  assert.equal(view.status, 'observing');
  assert.deepEqual(view.cards, []);
  assert.deepEqual(view.serialMap, new Map());
  assert.equal(sinkBox.records.length, 0);
});

test('守卫：observing 不是受控门状态，写入影子落点必须被 fail-closed 拒绝', () => {
  assert.throws(
    () =>
      validateShadowInput({
        termNorm: 'cat',
        // @ts-expect-error 红测刻意验证 observing 不得混入 GatedStatus 联合
        gatedStatus: 'observing',
        candidateCount: 0,
        countScope: 'gated-full',
        acceptedCount: 0,
        rejectedReasonCodes: [],
        observedMs: NOW,
      }),
    IntegrityError,
  );
});

test('守卫（对称）：countScope 非受控枚举同样必须被 fail-closed 拒绝', () => {
  // 经 unknown 收窄喂入：红相字段尚未存在、绿相枚举受控，两个阶段都稳定验证运行时白名单。
  const badInput = {
    termNorm: 'cat',
    gatedStatus: 'hit',
    candidateCount: 1,
    countScope: 'wild-west',
    acceptedCount: 1,
    rejectedReasonCodes: [],
    observedMs: NOW,
  } as unknown as Parameters<typeof validateShadowInput>[0];
  assert.throws(() => validateShadowInput(badInput), IntegrityError);
});

test('守卫（今天即绿）：off 态不注册任何工具，靠不注册保持零变化', () => {
  const wiring = wireMemoryTools({
    registry: { register: () => () => undefined },
    mode: 'off',
    indexDir: '/tmp/unused',
    channel: 'dsh',
  });
  assert.equal(wiring.registered, false);
});

// ── #115 红相：通道二接线的常量位置与通道字面量隔离（L5 边界冻结）──────────────

test('#115 T1：两道防爆闸常量冻结在 L5 source-lookup 边界，bridge 不得埋数值字面量', () => {
  const lookupSrc = read('src/assembly/source-lookup.ts');
  assert.ok(
    /export\s+const\s+MAX_RAW_TURNS_PER_LOOKUP\s*=\s*20\b/.test(lookupSrc),
    '条数闸常量必须显式导出并冻结为 20，语义独立于任何摄入保险丝',
  );
  assert.ok(
    /export\s+const\s+MAX_RAW_LOOKUP_CHARS\s*=\s*50000\b/.test(lookupSrc),
    '字符闸新立常量 50000（注释须写明数值对齐保险丝、语义独立），禁止直接引用 fuseRawChars 符号',
  );
  assert.ok(!/fuseRawChars/.test(lookupSrc), '查找侧不得引用事件摄入保险丝符号，两个语义不能耦合');
  // 字面量禁令：禁了符号不等于禁了数值——某处写死 50000 会让两个闸在改常量时分叉。
  const bare = lookupSrc
    .split('\n')
    .filter((line) => /\b50000\b/.test(line))
    .filter((line) => !/MAX_RAW_LOOKUP_CHARS\s*=\s*50000/.test(line));
  assert.deepEqual(bare, [], 'source-lookup 内除常量定义外不得出现裸 50000，必须引用 MAX_RAW_LOOKUP_CHARS');

  const bridgeSrc = read('src/adapters/dsh/memory-tool-bridge.ts');
  assert.ok(!/\b50000\b/.test(bridgeSrc), 'bridge 不得内嵌字符上限数值，唯一真值在 L5 常量');
  assert.ok(!/\b20\b/.test(bridgeSrc), 'bridge 不得内嵌条数上限数值');
});

test('#115 T2：通道默认值只准留在 L6 plugin 一处，assembly 与 bridge 零通道字面量', () => {
  for (const rel of [
    'src/assembly/memory-tools.ts',
    'src/assembly/host-tool-runtime.ts',
    'src/adapters/dsh/memory-tool-bridge.ts',
  ]) {
    const text = read(rel);
    assert.ok(!/['"]dsh['"]/.test(text), `${rel} 不得出现通道字面量，miss/回查通道一律经注入透传`);
  }
  const pluginSrc = read('src/adapters/dsh/plugin.ts');
  assert.ok(/config\.channel\s*\?\?\s*['"]dsh['"]/.test(pluginSrc), "缺省通道 'dsh' 只允许存在于 L6 plugin 配置解析一处");
});
