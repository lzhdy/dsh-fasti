/**
 * #240 挂件外观面（/ui/*）红测 —— 启动视频、壁纸、参数与引导两态。
 *
 * 三条主线：
 *  1. 只写挂件私有目录：/ui/* 落盘在传入的 uiRoot，绝不触达内核数据根；
 *  2. loopback 面安全：Host 白名单 + Bearer（媒体只读面除外）+ 后缀白名单 + 路径圈定 + 上传上限；
 *  3. 媒体可播：Range 206/416 正确，引导 splash 首屏 full、其后 mini。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Fasti } from '../../../src/api/index.ts';
import { startHttpServer } from '../../../src/adapters/node/http-server.ts';
import type { ChannelDescriptor } from '../../../src/contract/channel.ts';

const CHANNEL = 'webdemo';
const TOKEN = 'ui-token-0123456789';
const MAX_UPLOAD = 64 * 1024;

const descriptor: ChannelDescriptor = {
  id: CHANNEL,
  label: '网页演示通道',
  modalities: ['text'],
  capture: 'full',
  counterpart: 'user',
  adapter_version: 'web-0',
};

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** 原始 HTTP 请求（Buffer 收发，可设任意头；fetch 无法设 Host）。 */
function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: Buffer | string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function json(text: Buffer): Record<string, unknown> {
  return JSON.parse(text.toString('utf8')) as Record<string, unknown>;
}

/** 伪造 MP4：偏移 4 处为 'ftyp'，size 足以做 Range 断言。 */
function fakeMp4(bytes = 128): Buffer {
  const buf = Buffer.alloc(bytes, 0);
  buf.write('ftyp', 4, 'ascii');
  buf.write('isom', 8, 'ascii');
  return buf;
}

/** 1×1 透明 PNG 真字节。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('#240 挂件外观面（/ui/*）', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-ui-data-'));
  const uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-ui-root-'));
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-ui-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="app.js"></script></body></html>');
  fs.writeFileSync(path.join(webRoot, 'app.js'), 'export const ok = true;\n');

  const fasti = await Fasti.open({ dataRoot, llmPort: null });
  await fasti.registerChannel(descriptor);
  const handle = await startHttpServer(fasti, {
    port: 0,
    token: TOKEN,
    channel: CHANNEL,
    webRoot,
    uiRoot,
    maxUploadBytes: MAX_UPLOAD,
  });
  const { port } = handle;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const jsonAuth = { ...auth, 'Content-Type': 'application/json' };

  try {
    await t.test('无 token 读写设置一律 401；媒体只读面免 token 但不存在即 404', async () => {
      assert.equal((await rawRequest(port, { path: '/ui/state' })).status, 401);
      assert.equal((await rawRequest(port, { method: 'PUT', path: '/ui/state', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
      assert.equal((await rawRequest(port, { path: '/ui/media/splash-full.mp4' })).status, 404);
      assert.equal((await rawRequest(port, { path: '/ui/media/w/w-none.png' })).status, 404);
    });

    await t.test('GET /ui/state 回默认值：中性参数、两槽位默认开、零壁纸', async () => {
      const res = await rawRequest(port, { path: '/ui/state', headers: auth });
      assert.equal(res.status, 200);
      const state = json(res.body) as {
        settings: { wallpaper: Record<string, unknown>; splash: Record<string, unknown> };
        splashFiles: Record<string, unknown>;
        wallpapers: unknown[];
      };
      assert.equal(state.settings.wallpaper['brightness'], 100);
      assert.equal(state.settings.wallpaper['active'], null);
      assert.equal(state.settings.wallpaper['fit'], 'cover');
      assert.equal(state.settings.splash['full'], true);
      assert.equal(state.settings.splash['mini'], true);
      assert.equal(state.settings.splash['sound'], true);
      assert.deepEqual(state.splashFiles, { full: null, mini: null });
      assert.deepEqual(state.wallpapers, []);
    });

    await t.test('PUT /ui/state 逐字段 clamp、坏值回默认、未知字段丢弃', async () => {
      const res = await rawRequest(port, {
        method: 'PUT',
        path: '/ui/state',
        headers: jsonAuth,
        body: JSON.stringify({
          wallpaper: {
            brightness: 9999,
            hue: -999,
            fit: 'weird',
            scrimColor: 'red',
            ghost: 'nope',
          },
        }),
      });
      assert.equal(res.status, 200);
      const w = (json(res.body) as { settings: { wallpaper: Record<string, unknown> } }).settings.wallpaper;
      assert.equal(w['brightness'], 160);
      assert.equal(w['hue'], -180);
      assert.equal(w['fit'], 'cover');
      assert.equal(w['scrimColor'], '#05070d');
      assert.equal(w['ghost'], undefined);

      // 落盘确认：重开前先看磁盘（重启后仍在，见末项）
      const onDisk = JSON.parse(fs.readFileSync(path.join(uiRoot, 'settings.json'), 'utf8')) as {
        wallpaper: { brightness: number };
      };
      assert.equal(onDisk.wallpaper.brightness, 160);
    });

    await t.test('PUT /ui/state 坏 JSON 回 400 且不破坏已有设置', async () => {
      const res = await rawRequest(port, { method: 'PUT', path: '/ui/state', headers: jsonAuth, body: '{oops' });
      assert.equal(res.status, 400);
      const state = await rawRequest(port, { path: '/ui/state', headers: auth });
      const w = (json(state.body) as { settings: { wallpaper: { brightness: number } } }).settings.wallpaper;
      assert.equal(w.brightness, 160);
    });

    await t.test('上传启动视频：按魔数定名、槽位互斥；图片塞视频槽位 → 400', async () => {
      const res = await rawRequest(port, {
        method: 'POST',
        path: '/ui/splash/full',
        headers: auth,
        body: fakeMp4(),
      });
      assert.equal(res.status, 200);
      const state = json(res.body) as { splashFiles: { full: string | null } };
      assert.equal(state.splashFiles.full, 'splash-full.mp4');
      assert.ok(fs.existsSync(path.join(uiRoot, 'media', 'splash-full.mp4')));

      const wrong = await rawRequest(port, { method: 'POST', path: '/ui/splash/mini', headers: auth, body: TINY_PNG });
      assert.equal(wrong.status, 400);
      assert.equal((json(wrong.body) as { error: { code: string } }).error.code, 'media-kind-mismatch');
      assert.equal(fs.existsSync(path.join(uiRoot, 'media', 'splash-mini.png')), false);
    });

    await t.test('媒体 Range：206 分片 + 416 越界 + 200 整份', async () => {
      const size = fakeMp4().byteLength;
      const partial = await rawRequest(port, {
        path: '/ui/media/splash-full.mp4',
        headers: { Range: 'bytes=0-3' },
      });
      assert.equal(partial.status, 206);
      assert.equal(partial.headers['content-range'], `bytes 0-3/${size}`);
      assert.equal(partial.body.byteLength, 4);
      assert.ok(partial.body.equals(fakeMp4().subarray(0, 4)), '分片必须是对应原字节');

      const beyond = await rawRequest(port, {
        path: '/ui/media/splash-full.mp4',
        headers: { Range: 'bytes=9999-10000' },
      });
      assert.equal(beyond.status, 416);
      assert.equal(beyond.headers['content-range'], `bytes */${size}`);

      const whole = await rawRequest(port, { path: '/ui/media/splash-full.mp4' });
      assert.equal(whole.status, 200);
      assert.equal(whole.headers['accept-ranges'], 'bytes');
      assert.equal(whole.body.byteLength, size);
    });

    await t.test('上传壁纸：PNG 落 w-<hash>.png，可选中、可删除并自动清 active', async () => {
      const up = await rawRequest(port, { method: 'POST', path: '/ui/wallpaper', headers: auth, body: TINY_PNG });
      assert.equal(up.status, 200);
      const state = json(up.body) as { wallpapers: string[] };
      assert.equal(state.wallpapers.length, 1);
      const name = state.wallpapers[0] as string;
      assert.match(name, /^w-[0-9a-f]{12}\.png$/u);

      const pick = await rawRequest(port, {
        method: 'PUT',
        path: '/ui/state',
        headers: jsonAuth,
        body: JSON.stringify({ wallpaper: { active: name } }),
      });
      assert.equal((json(pick.body) as { settings: { wallpaper: { active: string } } }).settings.wallpaper.active, name);

      const thumb = await rawRequest(port, { path: `/ui/media/w/${name}` });
      assert.equal(thumb.status, 200);
      assert.equal(thumb.headers['content-type'], 'image/png');

      const del = await rawRequest(port, { method: 'DELETE', path: `/ui/wallpaper/${name}`, headers: auth });
      assert.equal(del.status, 200);
      const after = json(del.body) as { wallpapers: string[]; settings: { wallpaper: { active: string | null } } };
      assert.deepEqual(after.wallpapers, []);
      assert.equal(after.settings.wallpaper.active, null);
    });

    await t.test('路径穿越与非白名单后缀一律 404', async () => {
      assert.equal((await rawRequest(port, { path: '/ui/media/w/..%2F..%2Fsettings.json' })).status, 404);
      assert.equal((await rawRequest(port, { path: '/ui/media/..%2Fsettings.json' })).status, 404);
      assert.equal((await rawRequest(port, { path: '/ui/media/splash-full.txt' })).status, 404);
    });

    await t.test('上传超限 413（声明长度即拒，不落盘）', async () => {
      const res = await rawRequest(port, {
        method: 'POST',
        path: '/ui/splash/mini',
        headers: { ...auth, 'Content-Length': String(MAX_UPLOAD + 1) },
      });
      assert.equal(res.status, 413);
      assert.equal(fs.existsSync(path.join(uiRoot, 'media', 'splash-mini.mp4')), false);
    });

    await t.test('引导 splash：本进程首个入口 HTML 为 full，其后一律 mini', async () => {
      const first = await rawRequest(port, { path: '/app/' });
      assert.equal(first.status, 200);
      const m1 = /window\.__FASTI_BOOTSTRAP__=(\{.*?\});/u.exec(first.body.toString('utf8'));
      assert.ok(m1, '入口 HTML 必须注入引导');
      const boot1 = JSON.parse((m1[1] as string).replace(/\\u003c/gu, '<').replace(/\\u003e/gu, '>').replace(/\\u0026/gu, '&')) as {
        token: string; bootId: string; channel: string; splash: string;
      };
      assert.equal(boot1.token, TOKEN);
      assert.equal(boot1.splash, 'full');
      assert.match(String(first.headers['content-security-policy'] ?? ''), /media-src 'self'/u);
      assert.match(String(first.headers['content-security-policy'] ?? ''), /img-src 'self' data: blob:/u);

      const second = await rawRequest(port, { path: '/app/' });
      const m2 = /window\.__FASTI_BOOTSTRAP__=(\{.*?\});/u.exec(second.body.toString('utf8'));
      const boot2 = JSON.parse((m2?.[1] as string)) as { splash: string };
      assert.equal(boot2.splash, 'mini');
    });

    await t.test('挂件层零内核写：ui-store 无写入口，http-server 仅保留既有 1 处（挂账不动）', () => {
      const dir = path.resolve('src/adapters/node');
      const uiStore = fs.readFileSync(path.join(dir, 'ui-store.ts'), 'utf8');
      assert.equal(uiStore.includes('ingestRawTurn'), false, 'ui-store 不得调用内核写入口');
      // 既有 POST /channels/:id/turns 是 node 身体自己的耳朵，本期只挂账不动（#240 未新增任何写内核路径）。
      const httpServer = fs.readFileSync(path.join(dir, 'http-server.ts'), 'utf8');
      const occurrences = httpServer.split('ingestRawTurn').length - 1;
      assert.equal(occurrences, 1, '挂件层写内核入口数量必须保持既有 1 处，不得新增');
    });
  } finally {
    await handle.close();
    await fasti.close();
    for (const root of [dataRoot, uiRoot, webRoot]) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
});
