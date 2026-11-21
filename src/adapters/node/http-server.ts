/**
 * node 本地 HTTP 服务（平台化 #72 宿主无关启动器·第一刀机制层）。
 *
 * 定位：把**已打开的内核门面**以同源 HTTP 接口暴露给本机浏览器页面，供人工验证
 * 「内核脱离 dsh 宿主、在同进程独立服务一个网页」。全部用 node 内置 `http`，
 * 零第三方依赖、零宿主作用域包、零兄弟适配器引用（静态守卫会硬扫）。
 *
 * 三条安全纪律（loopback 服务的真实风险是"你浏览器开着的任意恶意网页偷打本机"）：
 *  1. **只绑 127.0.0.1**（host 不可配），外网根本连不上；
 *  2. **Host 头硬白名单**（localhost／127.0.0.1／[::1]）——这是防 DNS-rebinding 的核心：
 *     攻击者域名解析到 127.0.0.1 时，浏览器仍会带 `Host: attacker.com`，一律 403；
 *     只查 Origin 或只绑 loopback 都不够；
 *  3. **一次性随机 token**（每次启动生成、不落盘）：写入与读记忆必须 `Authorization: Bearer`，
 *     恶意页面跨源读不到响应体便拿不到 token，绕不过。
 *
 * 不做（挂第二刀）：跨源 CORS／PNA 预检、外网监听与 TLS、多通道管理、on 门六工具、跨进程写者锁。
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import type { Fasti } from '../../api/index.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';

/** 请求体上限：1 MiB（本地单人使用足够，超大即拒，防内存滥用）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** Host 头允许值（去掉端口后精确匹配，绝不用通配）。 */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 启动参数。 */
export interface HttpServerOptions {
  /** 监听端口；`0` = 由系统分配（测试用）。 */
  readonly port?: number;
  /** 一次性鉴权 token（由组合根生成并注入同源页面）。 */
  readonly token: string;
  /** 默认通道 id：`GET /` 页面与 `POST /channels/:id/turns` 之外的便捷通道。 */
  readonly channel: string;
  /** 诊断日志。缺省 no-op（内核零依赖，日志是调用方的事）。 */
  readonly logger?: LoggerPort;
}

/** 运行句柄。 */
export interface HttpServerHandle {
  /** 实际监听地址（`http://127.0.0.1:<port>`）。 */
  readonly url: string;
  /** 实际端口（参数为 0 时由系统分配）。 */
  readonly port: number;
  /** 关闭监听，等待在途连接结束。 */
  close(): Promise<void>;
}

interface Reply {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** 统一的错误信封，不泄露内部细节与堆栈。 */
function errorReply(status: number, code: string, message: string): Reply {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error: { code, message } }),
  };
}

function jsonReply(status: number, payload: unknown): Reply {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  };
}

/** 常量时间比较 token，避免时序侧信道。 */
function tokenMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) {
    return false;
  }
  const prefix = 'Bearer ';
  if (!given.startsWith(prefix)) {
    return false;
  }
  const value = Buffer.from(given.slice(prefix.length), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (value.length !== want.length) {
    return false;
  }
  return timingSafeEqual(value, want);
}

/** 取 Host 头去掉端口部分的 host 名（IPv6 保留方括号）。 */
function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader === '') {
    return undefined;
  }
  if (hostHeader.startsWith('[')) {
    // [::1]:8731 → [::1]
    const close = hostHeader.indexOf(']');
    return close === -1 ? undefined : hostHeader.slice(0, close + 1);
  }
  const colon = hostHeader.indexOf(':');
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

/**
 * 读取请求体，超限即停止收集并标记超限。
 *
 * 关键：超限**不立刻 destroy**——那样连 413 响应都发不出去，客户端只会看到
 * "socket hang up"。正确做法是停止累积、继续把客户端剩余字节读空（不占内存），
 * 待其写完后再回 413。为防止恶意客户端无限灌数据，设 4 倍硬上限，超过才断连。
 */
function readBody(req: http.IncomingMessage): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        if (size > MAX_BODY_BYTES * 4) {
          // 持续超限数倍：判定为滥用，断连止损。
          settled = true;
          resolve({ text: '', tooLarge: true });
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ text: tooLarge ? '' : Buffer.concat(chunks).toString('utf8'), tooLarge });
    });
    req.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

/**
 * 启动本地 HTTP 服务。
 *
 * 同步建 server、异步 bind；返回时端口已就绪，可直接发请求。
 */
export async function startHttpServer(fasti: Fasti, options: HttpServerOptions): Promise<HttpServerHandle> {
  const { token, channel } = options;
  const logger = options.logger;

  const server = http.createServer((req, res) => {
    const send = (reply: Reply): void => {
      res.writeHead(reply.status, reply.headers ?? {});
      res.end(reply.body ?? '');
    };

    void (async () => {
      // ── 第一道：Host 白名单（防 DNS-rebinding，先于任何路由与鉴权）──
      const hostname = hostnameOf(req.headers.host);
      if (hostname === undefined || !ALLOWED_HOSTS.has(hostname)) {
        send(errorReply(403, 'forbidden-host', 'Host 头不被允许'));
        return;
      }

      const url = new URL(req.url ?? '/', `http://${hostname}`);
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      // ── GET /health：存活检查，免 token ──
      if (pathname === '/health') {
        if (method !== 'GET') {
          send(errorReply(405, 'method-not-allowed', '仅支持 GET'));
          return;
        }
        send(jsonReply(200, { ok: true }));
        return;
      }

      // ── GET /：同源演示页（注入 token），免 token，页面自己带凭证调 API ──
      if (pathname === '/') {
        if (method !== 'GET') {
          send(errorReply(405, 'method-not-allowed', '仅支持 GET'));
          return;
        }
        send({
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: renderPage(token, channel),
        });
        return;
      }

      // 路由已识别（用于错方法时区分 405 与 404）。
      const turnsMatch = /^\/channels\/([^/]+)\/turns$/u.exec(pathname);
      const isExperiences = pathname === '/experiences';

      if (turnsMatch === null && !isExperiences) {
        send(errorReply(404, 'not-found', '路径不存在'));
        return;
      }
      if ((turnsMatch !== null && method !== 'POST') || (isExperiences && method !== 'GET')) {
        send(errorReply(405, 'method-not-allowed', isExperiences ? '仅支持 GET' : '仅支持 POST'));
        return;
      }

      // ── 第二道：token 鉴权（写入与读回都要）──
      if (!tokenMatches(req.headers.authorization, token)) {
        send(errorReply(401, 'unauthorized', '缺少或错误的访问凭证'));
        return;
      }

      // ── 读回经历 ──
      if (isExperiences) {
        const wanted = url.searchParams.get('channel') ?? channel;
        try {
          const rows = await fasti.query({ channel: wanted });
          send(
            jsonReply(200, {
              ok: true,
              count: rows.length,
              experiences: rows.map((experience) => ({
                id: experience.id,
                channel: experience.scene.channel,
                initiation: experience.initiation,
                occurred_at: experience.occurred_at,
              })),
            }),
          );
        } catch (error) {
          logger?.error('读回经历失败：%s', error instanceof Error ? error.message : String(error));
          send(errorReply(500, 'internal', '读回失败'));
        }
        return;
      }

      // ── 写入一条原文（通道 id 来自路径）──
      if (turnsMatch === null) {
        // 走到这里必然是 turns 路由；此处仅为类型收窄。
        send(errorReply(404, 'not-found', '路径不存在'));
        return;
      }
      const channelFromPath = decodeURIComponent(turnsMatch[1] ?? '');
      const body = await readBody(req);
      if (body.tooLarge) {
        send(errorReply(413, 'payload-too-large', '请求体超过 1 MiB 上限'));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        send(errorReply(400, 'bad-json', '请求体不是合法 JSON'));
        return;
      }
      const input = parsed as Record<string, unknown> | null;
      if (typeof input !== 'object' || input === null) {
        send(errorReply(400, 'bad-request', '请求体必须是 JSON 对象'));
        return;
      }
      for (const field of ['event_id', 'speaker', 'initiation', 'raw_text'] as const) {
        const value = input[field];
        if (typeof value !== 'string' || value === '') {
          send(errorReply(400, 'bad-request', `字段 ${field} 必填且为非空字符串`));
          return;
        }
      }

      try {
        const experience = await fasti.ingestRawTurn(channelFromPath, {
          event_id: String(input['event_id']),
          speaker: String(input['speaker']),
          initiation: String(input['initiation']),
          raw_text: String(input['raw_text']),
          session_id: typeof input['session_id'] === 'string' ? input['session_id'] : undefined,
          turn_id: typeof input['turn_id'] === 'string' ? input['turn_id'] : undefined,
          asserted_at: typeof input['asserted_at'] === 'string' ? input['asserted_at'] : undefined,
          occurred_at: typeof input['occurred_at'] === 'string' ? input['occurred_at'] : undefined,
        });
        send(
          jsonReply(201, {
            ok: true,
            id: experience.id,
            channel: experience.scene.channel,
            initiation: experience.initiation,
          }),
        );
      } catch (error) {
        // 未注册通道是内核 fail-closed 的确定行为 → 404；其余按服务端错误。
        const name = error instanceof Error ? error.name : '';
        const message = error instanceof Error ? error.message : String(error);
        if (name === 'NotFoundError' || message.includes('通道未注册')) {
          send(errorReply(404, 'channel-not-found', '目标通道未注册，拒绝写入'));
          return;
        }
        logger?.error('写入失败：%s', message);
        send(errorReply(500, 'internal', '写入失败'));
      }
    })().catch((error: unknown) => {
      logger?.error('请求处理异常：%s', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: { code: 'internal', message: '处理失败' } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8731, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 8731);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
            return;
          }
          resolve();
        });
        // 断开空闲 keep-alive 连接，否则 close 要等它们超时。
        server.closeIdleConnections();
      });
    },
  };
}

/** 极简同源页面：token 由服务端注入，页面用相对路径调 API（同源，无预检）。 */
function renderPage(token: string, channel: string): string {
  const safeToken = token.replace(/[<>&"']/gu, '');
  const safeChannel = channel.replace(/[<>&"']/gu, '');
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>FasTI 本地演示</title>
<style>
  body { font: 14px/1.6 system-ui, sans-serif; margin: 2rem; max-width: 42rem; }
  textarea { width: 100%; height: 5rem; font: inherit; }
  button { font: inherit; padding: .3rem .9rem; }
  pre { background: #f4f4f4; padding: .8rem; overflow: auto; }
</style>
<h1>FasTI 本地演示</h1>
<p>通道：<code>${safeChannel}</code>　此页面与接口同源，token 由服务端注入。</p>
<textarea id="text" placeholder="写一句话，下面点写入"></textarea>
<p><button id="write">写入</button> <button id="read">读回</button></p>
<pre id="out">（等待操作）</pre>
<script>
  const token = ${JSON.stringify(safeToken)};
  const channel = ${JSON.stringify(safeChannel)};
  const out = document.getElementById('out');
  const auth = { Authorization: 'Bearer ' + token };
  const show = (v) => { out.textContent = JSON.stringify(v, null, 2); };
  document.getElementById('write').onclick = async () => {
    const raw = document.getElementById('text').value.trim();
    if (!raw) { show({ error: '先写一句话' }); return; }
    const res = await fetch('/channels/' + channel + '/turns', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: 'web-' + Date.now().toString(36),
        speaker: 'user', initiation: 'user', raw_text: raw,
      }),
    });
    show(await res.json());
  };
  document.getElementById('read').onclick = async () => {
    const res = await fetch('/experiences?channel=' + channel, { headers: auth });
    show(await res.json());
  };
</script>
</html>
`;
}
