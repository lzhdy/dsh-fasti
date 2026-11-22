/**
 * #157 网页控制台观测 API 红测（先红后绿）。
 *
 * 覆盖：①loopback 鉴权在 /api 延续（无 token 401、伪 Host 403）；/app 静态面免凭证，
 * token 经入口 HTML 的 nonce 引导脚本注入内存，数据墙 /api 不拆；
 * ②七个只读 JSON 端点 status/pulse/raw/experiences/events/cards/projection 的形状与分页；
 * ③pulse 长轮询：无事件超时干净返回、新事件即时到达；
 * ④静态托管：免凭证直开、白名单后缀、CSP 强头（入口 nonce／其余严格）、路径穿越拒绝、
 * 未知文件 404，以及入口 HTML 的 bootstrap nonce 注入契约；
 * ⑤观测面只读：/api 下没有任何写路由（POST → 405）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { Fasti } from '../../../src/api/index.ts';
import type { ChannelDescriptor } from '../../../src/contract/channel.ts';
import { ActivityBus } from '../../../src/adapters/node/activity-bus.ts';
import { createObservationStage } from '../../../src/adapters/node/observe-stage.ts';
import { startHttpServer } from '../../../src/adapters/node/http-server.ts';
import type { MemoryObservationFace } from '../../../src/assembly/host-tool-runtime.ts';
import type { ObservationCardView } from '../../../src/memory/observation.ts';
import { cleanupTempRoot, makeTempRoot } from '../../helpers.ts';

const TOKEN = 'test-token-observation-api';
const CHANNEL = 'obsapi';
const descriptor: ChannelDescriptor = {
  id: CHANNEL,
  label: '观测 API 通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'obsapi-0',
};

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function fakeObservation(cards: ObservationCardView[]): MemoryObservationFace {
  return {
    listCardsForObservation: (opts) => {
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;
      return cards.slice(offset, offset + limit);
    },
    getCardForObservation: (id) => cards.find((card) => card.cardId === id) ?? null,
    getObservationCounts: () => ({
      cards: cards.length,
      activeCards: cards.length,
      invalidCards: 0,
      supersededCards: 0,
      aliases: 0,
      sensitiveAliases: 0,
      misses: 0,
    }),
  };
}

const SAMPLE_CARD: ObservationCardView = {
  cardId: 'mc_obs_1',
  eventId: 'evt-mc-1',
  anchorIds: ['01ANCHOR0001'],
  channel: CHANNEL,
  cardType: 'event',
  selection: 'selected',
  weight: 0.5,
  displayCues: ['线索'],
  aliases: [],
  discriminator: '消歧',
  occurredMs: 1_700_000_000_000,
  endedMs: 1_700_000_100_000,
  validMs: 1_700_000_000_000,
  invalidMs: null,
  createdMs: 1_700_000_000_000,
  expiredMs: null,
  status: 'active',
  contentHash: 'hash',
  hitCount: 0,
  lastHitMs: null,
  schemaVersion: 1,
};

test('观测 API：鉴权延续 + 七端点形状 + 长轮询 + 静态托管安全', async (t) => {
  const root = makeTempRoot();
  const webRoot = path.join(root, 'web');
  fs.mkdirSync(webRoot, { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
  fs.mkdirSync(path.join(webRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'assets', 'app.css'), 'body{}');
  fs.writeFileSync(path.join(webRoot, 'secret.txt'), 'not-on-the-allowlist');

  const bus = new ActivityBus({ unrefTimers: false });
  const fasti = await Fasti.open({ dataRoot: root });
  const handle = await startHttpServer(fasti, {
    port: 0,
    token: TOKEN,
    channel: CHANNEL,
    bus,
    observation: fakeObservation([SAMPLE_CARD]),
    bootId: 'boot-test-001',
    webRoot,
    pulseWaitMs: 80,
  });
  const { port } = handle;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  try {
    fasti.registerIngestStage(createObservationStage(bus));
    await fasti.registerChannel(descriptor);
    for (let i = 0; i < 3; i += 1) {
      await fasti.ingestRawTurn(CHANNEL, {
        event_id: `evt-api-${i}`,
        speaker: 'user',
        initiation: 'user',
        raw_text: `观测 API 第 ${i} 句`,
      });
    }

    await t.test('安全：/api 无 token 401、伪 Host 403、写方法 405', async () => {
      assert.equal((await rawRequest(port, { path: '/api/status' })).status, 401);
      assert.equal(
        (await rawRequest(port, { path: '/api/status', headers: { ...auth, Host: 'evil.example' } }))
          .status,
        403,
      );
      assert.equal(
        (await rawRequest(port, { method: 'POST', path: '/api/status', headers: auth })).status,
        405,
        '/api 全族只读，不允许任何写方法',
      );
    });

    await t.test('GET /api/status：boot 标识＋引擎/检查点/计数一次取齐', async () => {
      const res = await rawRequest(port, { path: '/api/status', headers: auth });
      assert.equal(res.status, 200);
      const payload = JSON.parse(res.body) as Record<string, unknown>;
      assert.equal(payload['bootId'], 'boot-test-001');
      assert.equal(typeof payload['startedAt'], 'number');
      assert.ok(['L1', 'L2', 'L3'].includes(String((payload['engine'] as Record<string, unknown>)?.['level'])));
      const counts = payload['counts'] as Record<string, unknown>;
      assert.equal(counts['experiences'], 3);
      assert.equal(
        (counts['rawTurns'] as Array<{ channel: string; count: number }>).find(
          (row) => row.channel === CHANNEL,
        )?.count,
        3,
      );
      const memory = payload['memory'] as Record<string, unknown>;
      assert.equal(memory['cards'], 1, '记忆观测计数经装配面透出');
    });

    await t.test('GET /api/raw：完整原文分页，非法分页参数 400', async () => {
      const page = await rawRequest(port, { path: '/api/raw?limit=1&offset=1', headers: auth });
      assert.equal(page.status, 200);
      const payload = JSON.parse(page.body) as { total: number; turns: unknown[] };
      assert.equal(payload.total, 3);
      assert.equal(payload.turns.length, 1);
      const bad = await rawRequest(port, { path: '/api/raw?limit=999', headers: auth });
      assert.equal(bad.status, 400);
    });

    await t.test('GET /api/experiences：列表与详情；未知 id 404', async () => {
      const list = await rawRequest(port, { path: '/api/experiences?limit=2', headers: auth });
      assert.equal(list.status, 200);
      const listed = JSON.parse(list.body) as { total: number; experiences: Array<{ id: string }> };
      assert.equal(listed.total, 3);
      assert.equal(listed.experiences.length, 2);
      const detail = await rawRequest(port, {
        path: `/api/experiences/${listed.experiences[0]?.id ?? ''}`,
        headers: auth,
      });
      assert.equal(detail.status, 200);
      assert.ok(detail.body.includes('"tick"'));
      const missing = await rawRequest(port, {
        path: '/api/experiences/no-such-id-000',
        headers: auth,
      });
      assert.equal(missing.status, 404);
    });

    await t.test('GET /api/events：列表与详情（含全部版本）', async () => {
      const list = await rawRequest(port, { path: '/api/events', headers: auth });
      assert.equal(list.status, 200);
      const events = JSON.parse(list.body) as { events: Array<{ id: string }> };
      assert.ok(events.events.length >= 1);
      const detail = await rawRequest(port, {
        path: `/api/events/${events.events[0]?.id ?? ''}`,
        headers: auth,
      });
      assert.equal(detail.status, 200);
      const detailPayload = JSON.parse(detail.body) as { versions: unknown[] };
      assert.ok(Array.isArray(detailPayload.versions));
    });

    await t.test('GET /api/cards：观测面列表/详情；面缺失时 503', async () => {
      const list = await rawRequest(port, { path: '/api/cards', headers: auth });
      assert.equal(list.status, 200);
      const payload = JSON.parse(list.body) as { cards: ObservationCardView[] };
      assert.equal(payload.cards[0]?.cardId, 'mc_obs_1');
      const one = await rawRequest(port, { path: '/api/cards/mc_obs_1', headers: auth });
      assert.equal(one.status, 200);
      assert.equal((await rawRequest(port, { path: '/api/cards/nope', headers: auth })).status, 404);
    });

    await t.test('GET /api/projection：引擎/检查点/对账/边观测包', async () => {
      const res = await rawRequest(port, { path: '/api/projection', headers: auth });
      assert.equal(res.status, 200);
      const payload = JSON.parse(res.body) as Record<string, unknown>;
      assert.ok('engine' in payload);
      assert.ok('checkpoint' in payload);
      assert.ok('reconciliation' in payload);
      assert.ok(Array.isArray(payload['edges']));
    });

    await t.test('GET /api/pulse：无新事件超时空返，摄入后即时到达', async () => {
      const idle = await rawRequest(port, { path: '/api/pulse?after=999', headers: auth });
      assert.equal(idle.status, 200);
      const idlePayload = JSON.parse(idle.body) as { activities: unknown[]; seq: number };
      assert.deepEqual(idlePayload.activities, [], '等待窗口内无事件，空数组返回');
      assert.equal(idlePayload.seq, bus.currentSeq());

      const pending = rawRequest(port, { path: '/api/pulse?after=0', headers: auth });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await fasti.ingestRawTurn(CHANNEL, {
        event_id: 'evt-api-pulse',
        speaker: 'user',
        initiation: 'user',
        raw_text: '触发脉冲的一句',
      });
      const hit = await pending;
      assert.equal(hit.status, 200);
      const hitPayload = JSON.parse(hit.body) as {
        activities: Array<{ kind: string }>;
      };
      assert.ok(hitPayload.activities.some((a) => a.kind === 'ingest.turn'));
    });

    await t.test('静态托管：免凭证直开＋白名单后缀＋CSP；穿越与非白名单拒绝', async () => {
      // 静态前端代码无秘密：不带任何凭证也能直开（地址栏与 <script>/<link> 标签无法附 Authorization）。
      const page = await rawRequest(port, { path: '/app/index.html' });
      assert.equal(page.status, 200);
      assert.match(String(page.headers['content-type'] ?? ''), /text\/html/);
      const csp = String(page.headers['content-security-policy'] ?? '');
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);

      const css = await rawRequest(port, { path: '/app/assets/app.css' });
      assert.equal(css.status, 200);
      assert.match(String(css.headers['content-type'] ?? ''), /text\/css/);
      assert.equal(css.body, 'body{}', '非 HTML 资产字节原样返回，不被注入改写');
      const cssCsp = String(css.headers['content-security-policy'] ?? '');
      assert.match(cssCsp, /script-src 'self'/);
      assert.doesNotMatch(cssCsp, /nonce-/u, '非入口资产 CSP 不放行任何 nonce 内联');

      assert.equal((await rawRequest(port, { path: '/app/secret.txt' })).status, 404);
      assert.equal(
        (await rawRequest(port, { path: '/app/../package.json' })).status,
        404,
        '路径越界一律 404，不泄露存在性',
      );
      assert.equal(
        (await rawRequest(port, { path: '/app/..%2f..%2fpackage.json' })).status,
        404,
        '编码穿越同样拦截',
      );
      assert.equal((await rawRequest(port, { path: '/app/missing.svg' })).status, 404);
    });

    await t.test('bootstrap：入口 HTML 注入一次性凭证，nonce 与 CSP 严格对应', async () => {
      const page = await rawRequest(port, { path: '/app/index.html' });
      assert.match(page.body, /window\.__FASTI_BOOTSTRAP__\s*=/u);
      assert.ok(page.body.includes(TOKEN), '注入本次一次性 token');
      assert.ok(page.body.includes('boot-test-001'));
      assert.ok(page.body.includes(CHANNEL));

      // 内联脚本标签的 nonce 必须与该响应 CSP 放行的 nonce 精确同一个值。
      const tagNonce = /<script nonce="([^"]+)">/u.exec(page.body)?.[1];
      assert.ok(typeof tagNonce === 'string' && tagNonce.length > 0, '入口含带 nonce 的内联引导脚本');
      const csp = String(page.headers['content-security-policy'] ?? '');
      assert.ok(csp.includes(`'nonce-${tagNonce}'`), 'CSP 只精确放行本响应的脚本 nonce');
      assert.match(csp, /script-src 'self'/u, 'script-src 在 nonce 之外仍保留 self');

      // 目录形式 /app/ 同样回到注入后的入口文档。
      const dirEntry = await rawRequest(port, { path: '/app/' });
      assert.equal(dirEntry.status, 200);
      assert.match(dirEntry.body, /window\.__FASTI_BOOTSTRAP__/u);

      // 静态墙拆开但数据墙不拆：/api 无 token 依旧 401。
      assert.equal((await rawRequest(port, { path: '/api/status' })).status, 401);
    });
  } finally {
    await handle.close();
    bus.dispose();
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('观测 API：记忆索引未就绪（observation=null）时卡片端点 503 而不是假空', async () => {
  const root = makeTempRoot();
  const fasti = await Fasti.open({ dataRoot: root });
  const handle = await startHttpServer(fasti, {
    port: 0,
    token: TOKEN,
    channel: CHANNEL,
    bus: new ActivityBus({ unrefTimers: false }),
    observation: null,
    bootId: 'boot-test-002',
    pulseWaitMs: 50,
  });
  try {
    const res = await rawRequest(handle.port, { path: '/api/cards', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 503);
  } finally {
    await handle.close();
    await fasti.close();
    cleanupTempRoot(root);
  }
});

test('bootstrap：恶意 channel 经 Unicode 转义无法突破内联脚本，且值可无损还原', async () => {
  const evilChannel = '</script><img src=x onerror=alert(1)>';
  const root = makeTempRoot();
  const webRoot = path.join(root, 'web');
  fs.mkdirSync(webRoot, { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  const fasti = await Fasti.open({ dataRoot: root });
  const handle = await startHttpServer(fasti, {
    port: 0,
    token: TOKEN,
    channel: evilChannel,
    bus: new ActivityBus({ unrefTimers: false }),
    observation: null,
    bootId: 'boot-test-003',
    webRoot,
    pulseWaitMs: 50,
  });
  try {
    const page = await rawRequest(handle.port, { path: '/app/index.html' });
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, /<img/iu, '尖括号被转义，恶意标签无法在脚本外成形');
    const closeTags = page.body.match(/<\/script>/gu) ?? [];
    assert.equal(closeTags.length, 1, '只允许引导脚本自身的一个闭合标签，channel 内的闭合被转义');
    assert.match(page.body, /\\u003c/u, '危险尖括号以 unicode 转义形态留在 JSON 字符串内');

    const match = /window\.__FASTI_BOOTSTRAP__=(\{.*\});<\/script>/u.exec(page.body);
    assert.ok(match !== null, '引导脚本结构完整可定位');
    const boot = JSON.parse(match?.[1] ?? '{}') as { token: string; channel: string };
    assert.equal(boot.token, TOKEN);
    assert.equal(boot.channel, evilChannel, '前端 JSON.parse 后 channel 原值无损还原');
  } finally {
    await handle.close();
    await fasti.close();
    cleanupTempRoot(root);
  }
});
