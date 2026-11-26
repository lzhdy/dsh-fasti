/**
 * #248 浏览器代开启动器红测（B 方案：node 启动器代开 Chromium 系浏览器）。
 *
 * 纪律：
 *  - 纯函数（候选清单/参数构造/可执行文件解析）走真实临时目录，不真起浏览器；
 *  - 真正 spawn 一律注入假 spawn，断言入参与两种生命周期姿态（app 绑定 / fullscreen 放飞）；
 *  - 零 shell、数组参数，失败只降级不抛穿。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildBrowserArgs,
  browserCandidates,
  launchBrowser,
  resolveExecutable,
  spawnBrowser,
  type BrowserChildLike,
  type BrowserSpawnFn,
} from '../../../src/adapters/node/browser-launcher.ts';

const ENTRY_URL = 'http://127.0.0.1:8731/app/';

function makeFakeBin(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-fakebin-'));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

test('buildBrowserArgs：app 模式以 --app=<url> 起无边框应用窗，且裸 url 不重复出现', () => {
  const args = buildBrowserArgs('app', ENTRY_URL);
  assert.ok(args.includes(`--app=${ENTRY_URL}`));
  assert.ok(!args.some((a) => a === ENTRY_URL));
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--no-default-browser-check'));
  assert.ok(!args.includes('--start-fullscreen'));
});

test('buildBrowserArgs：fullscreen 模式带 --start-fullscreen 与裸 url，不含 --app', () => {
  const args = buildBrowserArgs('fullscreen', ENTRY_URL);
  assert.ok(args.includes('--start-fullscreen'));
  assert.ok(args.includes(ENTRY_URL));
  assert.ok(!args.some((a) => a.startsWith('--app=')));
  assert.ok(args.includes('--no-first-run'));
});

test('browserCandidates：三平台候选各自包含代表性可执行名/路径', () => {
  const linux = browserCandidates('linux', {});
  assert.ok(linux.includes('google-chrome'));
  assert.ok(linux.includes('chromium'));
  assert.ok(linux.includes('microsoft-edge'));

  const darwin = browserCandidates('darwin', {});
  assert.ok(darwin.some((p) => p.includes('/Applications/') && p.includes('Google Chrome')));
  assert.ok(darwin.some((p) => p.includes('MacOS')));

  const win = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' });
  assert.ok(win.some((p) => p.includes('Program Files') && /chrome\.exe$/i.test(p)));
  assert.ok(win.some((p) => /msedge\.exe$/i.test(p)));
});

test('resolveExecutable：PATH 中的裸名可被解析为绝对路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-path-'));
  const exe = path.join(dir, 'chromium');
  fs.writeFileSync(exe, 'x');
  fs.chmodSync(exe, 0o755);
  const resolved = await resolveExecutable(['chromium', 'not-here'], { PATH: dir }, 'linux');
  assert.equal(resolved, exe);
});

test('resolveExecutable：win32 裸名按 PATHEXT 自动补 .exe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-winpath-'));
  fs.writeFileSync(path.join(dir, 'chrome.exe'), 'x');
  const resolved = await resolveExecutable(
    ['chrome'],
    { PATH: dir, PATHEXT: '.EXE;.CMD' },
    'win32',
  );
  assert.equal(resolved, path.join(dir, 'chrome.exe'));
});

test('resolveExecutable：显式存在的绝对路径直接命中、全部找不到回 null', async () => {
  const abs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fasti-abs-')), 'browser-bin');
  fs.writeFileSync(abs, 'x');
  fs.chmodSync(abs, 0o755);
  assert.equal(await resolveExecutable([abs], {}, 'linux'), abs);
  assert.equal(await resolveExecutable(['definitely-missing-xyz'], { PATH: '/nonexistent' }, 'linux'), null);
});

interface FakeChild extends BrowserChildLike {
  killed: boolean;
  unrefCount: number;
  errorCb?: (err: Error) => void;
}

function makeSpawnRecorder(): { spawn: BrowserSpawnFn; calls: Array<{ file: string; args: string[]; options: unknown }>; child: FakeChild } {
  const calls: Array<{ file: string; args: string[]; options: unknown }> = [];
  const child: FakeChild = {
    killed: false,
    unrefCount: 0,
    kill() {
      this.killed = true;
      return true;
    },
    unref() {
      this.unrefCount += 1;
      return this;
    },
    on(event, cb) {
      if (event === 'error') {
        this.errorCb = cb as (err: Error) => void;
      }
      return this;
    },
  };
  const spawn: BrowserSpawnFn = (file, args, options) => {
    calls.push({ file, args, options });
    return child;
  };
  return { spawn, calls, child };
}

test('spawnBrowser：app 模式绑定进程树（不 detached、不 unref），fullscreen 放飞（detached+unref）', async () => {
  const app = makeSpawnRecorder();
  await spawnBrowser('/usr/bin/chromium', buildBrowserArgs('app', ENTRY_URL), 'app', app.spawn);
  assert.equal(app.calls.length, 1);
  assert.equal((app.calls[0]!.options as { detached?: boolean }).detached, false);
  assert.equal(app.child.unrefCount, 0);

  const fs2 = makeSpawnRecorder();
  await spawnBrowser('/usr/bin/chromium', buildBrowserArgs('fullscreen', ENTRY_URL), 'fullscreen', fs2.spawn);
  assert.equal((fs2.calls[0]!.options as { detached?: boolean }).detached, true);
  assert.equal(fs2.child.unrefCount, 1);
});

test('spawnBrowser：子进程 emit error 时返回 ok:false 且不抛穿', async () => {
  const rec = makeSpawnRecorder();
  const promise = spawnBrowser('/usr/bin/chromium', ['--app=x'], 'app', rec.spawn);
  rec.child.errorCb?.(new Error('spawn ENOENT'));
  const result = await promise;
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /spawn/i);
});

test('launchBrowser：经假 PATH 找到浏览器并以正确模式拉起，返回可执行路径与参数', async () => {
  const binDir = makeFakeBin(['chromium']);
  const rec = makeSpawnRecorder();
  const result = await launchBrowser(
    { url: ENTRY_URL, openMode: 'app' },
    { env: { PATH: binDir }, platform: 'linux', spawn: rec.spawn },
  );
  assert.equal(result.ok, true);
  assert.equal(result.executable, path.join(binDir, 'chromium'));
  assert.ok(result.args?.includes(`--app=${ENTRY_URL}`));
  assert.equal(rec.calls.length, 1);
});

test('launchBrowser：找不到任何浏览器时 ok:false 且绝不调用 spawn', async () => {
  const rec = makeSpawnRecorder();
  const result = await launchBrowser(
    { url: ENTRY_URL, openMode: 'app' },
    { env: { PATH: '/nonexistent-empty' }, platform: 'linux', spawn: rec.spawn },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'browser-not-found');
  assert.equal(rec.calls.length, 0);
});

test('launchBrowser：executablePath 显式指定时跳过候选探测', async () => {
  const rec = makeSpawnRecorder();
  const result = await launchBrowser(
    { url: ENTRY_URL, openMode: 'fullscreen', executablePath: '/custom/path/chrome' },
    { env: { PATH: '' }, platform: 'linux', spawn: rec.spawn },
  );
  assert.equal(result.ok, true);
  assert.equal(result.executable, '/custom/path/chrome');
  assert.equal(rec.calls[0]?.file, '/custom/path/chrome');
});
