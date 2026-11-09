/**
 * Experience 校验器（阶段 0 契约的一部分）。
 *
 * 两条纪律：
 *  1. 未知字段原样保留（定案稿 §10.4 C2）—— 校验器只检查已知字段，绝不裁剪对象；
 *  2. 写入路径拒绝保留字字段 —— 红线②「不得出现系统判定的『重要性』字段」、
 *     红线①「不得把聊天/对话写成前提」，在写入边界上拦住，不依赖下游自觉。
 *
 * 未知字段按模式分流（审计 N2）：
 *  - write：未知字段即契约违约 → 抛错（写入边界要拦住脏字段）；
 *  - read ：未知字段原样带过 —— 不报错、也不裁剪（读路径必须能读回未来版本
 *    写入的字段；否则一次升级就让旧数据读不出来）。
 *
 * 红线纪律：禁字段拦截（isForbiddenFieldName）**只**在 write 模式执行，
 * 本次放宽只针对「未知字段」这一项，不得弱化红线①/②。
 */

import { SchemaError } from '../core/errors.ts';
import {
  ACTION_FIELDS,
  CUE_MAX_LENGTH,
  OBSERVATION_FIELDS,
  OUTCOME_FIELDS,
  POINTER_FIELDS,
  SCENE_FIELDS,
  EXPERIENCE_FIELDS,
  isForbiddenFieldName,
} from './experience.ts';
import type { Action, Edge, Experience, Mark, MediaRef, Observation, Outcome, Pointer, Scene } from './experience.ts';

export type ParseMode = 'read' | 'write';

function fail(message: string): never {
  throw new SchemaError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, at: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(`${at} 必须是对象`);
  }
  return value;
}

function requireString(value: unknown, at: string): string {
  if (typeof value !== 'string') {
    fail(`${at} 必须是字符串`);
  }
  return value;
}

function optionalString(value: unknown, at: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, at);
}

function optionalNumber(value: unknown, at: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${at} 必须是有限数字`);
  }
  return value;
}

// ── G05 区块：未知字段的 write/read 双模 ──
function assertKnownFields(
  obj: Record<string, unknown>,
  known: readonly string[],
  at: string,
  mode: ParseMode,
): void {
  // read 模式宽容：未知字段多半是未来版本写进来的，不是脏数据（审计 N2）。
  if (mode !== 'write') {
    return;
  }
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      fail(`${at} 含有未知字段 ${key}`);
    }
  }
}

/**
 * read 模式：把输入里未被消费的键原样拷进结果 —— 不裁剪。
 *
 * 判据用「结果对象已有的键」：已知字段都已归一进结果，
 * 结果里没有的键即未知字段，原样带过（定案稿 §10.4 C2）。
 *
 * write 模式维持既有行为（未知字段照旧丢弃）—— 本次只放宽 read 侧。
 */
function carryUnknownFields(
  obj: Record<string, unknown>,
  target: object,
  mode: ParseMode,
): void {
  if (mode !== 'read') {
    return;
  }
  const sink = target as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && !(key in sink)) {
      sink[key] = value;
    }
  }
}

/** 校验指针（Pointer.seq 从 0 起算；区间为闭区间）。 */
export function parsePointer(raw: unknown, at = 'pointer', mode: ParseMode = 'read'): Pointer {
  const obj = requireObject(raw, at);
  assertKnownFields(obj, POINTER_FIELDS, at, mode);

  const pointer: Pointer = {};
  const id = optionalString(obj['id'], `${at}.id`);
  if (id !== undefined) {
    pointer.id = id;
  }
  const channel = optionalString(obj['channel'], `${at}.channel`);
  if (channel !== undefined) {
    pointer.channel = channel;
  }
  const shard = optionalString(obj['shard'], `${at}.shard`);
  if (shard !== undefined) {
    pointer.shard = shard;
  }

  const seq = obj['seq'];
  if (seq !== undefined) {
    if (typeof seq === 'number') {
      if (!Number.isInteger(seq) || seq < 0) {
        fail(`${at}.seq 单个行号必须是非负整数`);
      }
      pointer.seq = seq;
    } else if (Array.isArray(seq)) {
      if (seq.length !== 2) {
        fail(`${at}.seq 区间必须恰好两个元素`);
      }
      const [from, to] = seq as [unknown, unknown];
      if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) {
        fail(`${at}.seq 区间起点必须是非负整数`);
      }
      if (typeof to !== 'number' || !Number.isInteger(to) || to < 0) {
        fail(`${at}.seq 区间终点必须是非负整数`);
      }
      if (from > to) {
        fail(`${at}.seq 区间起点不得大于终点`);
      }
      pointer.seq = [from, to];
    } else {
      fail(`${at}.seq 必须是数字或 [from, to] 数组`);
    }
  }

  carryUnknownFields(obj, pointer, mode);

  return pointer;
}

/** 校验媒体引用。 */
export function parseMediaRef(raw: unknown, at = 'media', mode: ParseMode = 'read'): MediaRef {
  const obj = requireObject(raw, at);
  const ref: MediaRef = {
    ref_id: requireString(obj['ref_id'], `${at}.ref_id`),
    kind: requireString(obj['kind'], `${at}.kind`),
    mime: requireString(obj['mime'], `${at}.mime`),
    origin: {
      channel: '',
      host_ref: '',
      captured_at: '',
    },
  };

  const bytes = optionalNumber(obj['bytes'], `${at}.bytes`);
  if (bytes !== undefined) {
    ref.bytes = bytes;
  }
  const sha256 = optionalString(obj['sha256'], `${at}.sha256`);
  if (sha256 !== undefined) {
    ref.sha256 = sha256;
  }

  const origin = requireObject(obj['origin'], `${at}.origin`);
  ref.origin = {
    channel: requireString(origin['channel'], `${at}.origin.channel`),
    host_ref: requireString(origin['host_ref'], `${at}.origin.host_ref`),
    captured_at: requireString(origin['captured_at'], `${at}.origin.captured_at`),
  };
  // read 模式：origin 容器里的未知键也原样带过（不裁剪）。
  carryUnknownFields(origin, ref.origin, mode);

  // 「有字节时必填 sha256」——完整性校验的前提（定案稿 §4.2）。
  if (ref.bytes !== undefined && ref.sha256 === undefined) {
    fail(`${at} 有 bytes 时必须提供 sha256`);
  }

  // read 模式：媒体元素上的未知字段原样带过 —— 媒体能力挂记录本，
  // 未来版本加的字段不该让旧读取器报错、更不该被悄悄丢掉。
  carryUnknownFields(obj, ref, mode);

  return ref;
}

/** 校验规则层标记：只贴标签，不否决。 */
export function parseMark(raw: unknown, at = 'mark', mode: ParseMode = 'read'): Mark {
  const obj = requireObject(raw, at);
  const by = requireString(obj['by'], `${at}.by`);
  if (by !== 'rule-layer') {
    fail(`${at}.by 必须是 'rule-layer'`);
  }
  const mark: Mark = {
    type: requireString(obj['type'], `${at}.type`),
    by: 'rule-layer',
  };
  const note = optionalString(obj['note'], `${at}.note`);
  if (note !== undefined) {
    mark.note = note;
  }
  carryUnknownFields(obj, mark, mode);
  return mark;
}

/** 校验摄入期结构关系。 */
export function parseEdge(raw: unknown, at = 'edge', mode: ParseMode = 'read'): Edge {
  const obj = requireObject(raw, at);
  const edge: Edge = {
    type: requireString(obj['type'], `${at}.type`),
    target: requireString(obj['target'], `${at}.target`),
  };
  const note = optionalString(obj['note'], `${at}.note`);
  if (note !== undefined) {
    edge.note = note;
  }
  carryUnknownFields(obj, edge, mode);
  return edge;
}

/** 校验场景。 */
export function parseScene(raw: unknown, at = 'scene', mode: ParseMode = 'read'): Scene {
  const obj = requireObject(raw, at);
  assertKnownFields(obj, SCENE_FIELDS, at, mode);

  const scene: Scene = {
    channel: requireString(obj['channel'], `${at}.channel`),
    ref: requireString(obj['ref'], `${at}.ref`),
  };

  const detail = obj['detail'];
  if (detail !== undefined) {
    const detailObj = requireObject(detail, `${at}.detail`);
    const out: Record<string, string> = {};
    // detail 本身就是开放字典（通道自定义键值）：其内层键**不是**未知字段，
    // 全部原样保留，不做字段名判定。
    for (const [key, value] of Object.entries(detailObj)) {
      out[key] = requireString(value, `${at}.detail.${key}`);
    }
    scene.detail = out;
  }

  carryUnknownFields(obj, scene, mode);

  return scene;
}

/** 校验观察槽位。 */
export function parseObservation(raw: unknown, at = 'observation', mode: ParseMode = 'read'): Observation {
  const obj = requireObject(raw, at);
  assertKnownFields(obj, OBSERVATION_FIELDS, at, mode);

  const observation: Observation = {};

  if (obj['text'] !== undefined) {
    observation.text = parsePointer(obj['text'], `${at}.text`, mode);
  }

  const media = obj['media'];
  if (media !== undefined) {
    if (!Array.isArray(media)) {
      fail(`${at}.media 必须是数组`);
    }
    observation.media = media.map((item, index) => parseMediaRef(item, `${at}.media[${index}]`, mode));
  }

  const cue = optionalString(obj['cue'], `${at}.cue`);
  if (cue !== undefined) {
    // 硬上限 200 字符（定案稿 §4.2）：长内容应走指针，而不是把 cue 撑大。
    if (cue.length > CUE_MAX_LENGTH) {
      fail(`${at}.cue 超过硬上限 ${CUE_MAX_LENGTH} 字符`);
    }
    observation.cue = cue;
  }

  carryUnknownFields(obj, observation, mode);

  return observation;
}

/** 校验动作槽位。 */
export function parseAction(raw: unknown, at = 'action', mode: ParseMode = 'read'): Action {
  const obj = requireObject(raw, at);
  assertKnownFields(obj, ACTION_FIELDS, at, mode);

  const action: Action = { type: requireString(obj['type'], `${at}.type`) };
  const tool = optionalString(obj['tool'], `${at}.tool`);
  if (tool !== undefined) {
    action.tool = tool;
  }

  const args = obj['args'];
  if (args !== undefined) {
    action.args = typeof args === 'string' ? args : parsePointer(args, `${at}.args`, mode);
  }

  const thought = obj['thought'];
  if (thought !== undefined) {
    action.thought = typeof thought === 'string' ? thought : parsePointer(thought, `${at}.thought`, mode);
  }

  carryUnknownFields(obj, action, mode);

  return action;
}

/** 校验结果槽位。 */
export function parseOutcome(raw: unknown, at = 'outcome', mode: ParseMode = 'read'): Outcome {
  const obj = requireObject(raw, at);
  assertKnownFields(obj, OUTCOME_FIELDS, at, mode);

  const outcome: Outcome = {};

  const text = obj['text'];
  if (text !== undefined) {
    outcome.text = typeof text === 'string' ? text : parsePointer(text, `${at}.text`, mode);
  }

  const status = optionalString(obj['status'], `${at}.status`);
  if (status !== undefined) {
    outcome.status = status;
  }

  const errorType = optionalString(obj['error_type'], `${at}.error_type`);
  if (errorType !== undefined) {
    outcome.error_type = errorType;
  }

  const duration = optionalNumber(obj['duration_ms'], `${at}.duration_ms`);
  if (duration !== undefined) {
    outcome.duration_ms = duration;
  }

  const tokens = obj['tokens'];
  if (tokens !== undefined) {
    const tokenObj = requireObject(tokens, `${at}.tokens`);
    const out: { input?: number; output?: number } = {};
    const input = optionalNumber(tokenObj['input'], `${at}.tokens.input`);
    if (input !== undefined) {
      out.input = input;
    }
    const output = optionalNumber(tokenObj['output'], `${at}.tokens.output`);
    if (output !== undefined) {
      out.output = output;
    }
    carryUnknownFields(tokenObj, out, mode);
    outcome.tokens = out;
  }

  carryUnknownFields(obj, outcome, mode);

  return outcome;
}

/**
 * 校验一条经历。
 *
 * @param mode 'read'  —— 读取路径：未知字段原样保留（含嵌套层），不报错、不裁剪
 *                        （保留字名只当普通未知字段）
 * @param mode 'write' —— 写入路径：拒绝未知字段，并额外拒绝「重要性」类与「聊天前提」类字段名
 */
export function parseExperience(raw: unknown, mode: ParseMode = 'read'): Experience {
  const obj = requireObject(raw, 'experience');

  if (mode === 'write') {
    for (const key of Object.keys(obj)) {
      if (isForbiddenFieldName(key)) {
        fail(`experience 含有被禁止的字段名 ${key}（红线①/②：不得预设重要性、不得把聊天写成前提）`);
      }
    }
  }

  const experience: Experience = {
    id: requireString(obj['id'], 'experience.id'),
    schema_version: (() => {
      const value = obj['schema_version'];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        fail('experience.schema_version 必须是正整数');
      }
      return value;
    })(),
    kind: requireString(obj['kind'], 'experience.kind'),
    scene: parseScene(obj['scene'], 'experience.scene', mode),
    initiation: requireString(obj['initiation'], 'experience.initiation'),
    observation: parseObservation(obj['observation'], 'experience.observation', mode),
    occurred_at: requireString(obj['occurred_at'], 'experience.occurred_at'),
    recorded_at: requireString(obj['recorded_at'], 'experience.recorded_at'),
    tick: (() => {
      const value = obj['tick'];
      // 写入路径：tick 由 A 分配（摄入序号），调用方无需提供 → 缺省占位 0，随后被覆盖。
      // 读取路径：tick 必填，缺失即数据损坏 → 抛错。
      if (value === undefined && mode === 'write') {
        return 0;
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        fail('experience.tick 必须是非负整数');
      }
      return value;
    })(),
  };

  if (obj['agent_meta'] !== undefined) {
    const meta = requireObject(obj['agent_meta'], 'experience.agent_meta');
    const out: { model?: string; persona_version?: string } = {};
    const model = optionalString(meta['model'], 'experience.agent_meta.model');
    if (model !== undefined) {
      out.model = model;
    }
    const personaVersion = optionalString(meta['persona_version'], 'experience.agent_meta.persona_version');
    if (personaVersion !== undefined) {
      out.persona_version = personaVersion;
    }
    experience.agent_meta = out;
    carryUnknownFields(meta, out, mode);
  }

  if (obj['action'] !== undefined) {
    experience.action = parseAction(obj['action'], 'experience.action', mode);
  }

  if (obj['outcome'] !== undefined) {
    experience.outcome = parseOutcome(obj['outcome'], 'experience.outcome', mode);
  }

  const marks = obj['marks'];
  if (marks !== undefined) {
    if (!Array.isArray(marks)) {
      fail('experience.marks 必须是数组');
    }
    experience.marks = marks.map((item, index) => parseMark(item, `experience.marks[${index}]`, mode));
  }

  const pointers = obj['pointers'];
  if (pointers !== undefined) {
    if (!Array.isArray(pointers)) {
      fail('experience.pointers 必须是数组');
    }
    experience.pointers = pointers.map((item, index) => parseEdge(item, `experience.pointers[${index}]`, mode));
  }

  // 未知字段原样保留（定案稿 §10.4 C2）：把输入对象上未被上面消费的键拷回。
  const consumed = new Set<string>([
    'id',
    'schema_version',
    'kind',
    'scene',
    'initiation',
    'agent_meta',
    'observation',
    'action',
    'outcome',
    'occurred_at',
    'recorded_at',
    'tick',
    'marks',
    'pointers',
  ]);
  for (const [key, value] of Object.entries(obj)) {
    if (!consumed.has(key)) {
      (experience as unknown as Record<string, unknown>)[key] = value;
    }
  }

  return experience;
}

/** 已知顶层字段名（供测试与审计对照）。 */
export { EXPERIENCE_FIELDS };
