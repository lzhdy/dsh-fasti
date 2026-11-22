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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Fasti } from '../../api/index.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';
import type { MemoryObservationFace } from '../../assembly/host-tool-runtime.ts';
import type { ChatHandler } from './chat.ts';
import type { ActivityBus } from './activity-bus.ts';

/** 请求体上限：1 MiB（本地单人使用足够，超大即拒，防内存滥用）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** Host 头允许值（去掉端口后精确匹配，绝不用通配）。 */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 长轮询挂等上限：无新脉冲时最多 hold 多久再空返（生产缺省 5s）。 */
const DEFAULT_PULSE_WAIT_MS = 5_000;

/** 观测列表分页硬上限（与门面/窄柄口径一致，双重保险）。 */
const OBSERVATION_PAGE_MAX = 100;

/** 静态资产后缀白名单与 MIME：不在表内一律 404，目录没有任何执行语义。 */
const STATIC_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
});

/** 启动参数。 */
export interface HttpServerOptions {
  /** 监听端口；`0` = 由系统分配（测试用）。 */
  readonly port?: number;
  /** 一次性鉴权 token（由组合根生成并注入同源页面）。 */
  readonly token: string;
  /** 默认通道 id：`GET /` 页面与 `POST /channels/:id/turns` 之外的便捷通道。 */
  readonly channel: string;
  /**
   * 对话处理器（对话第一刀）。缺省 `null` = 未配模型端点，`POST /chat` 显式回 503，
   * 不影响页面、写入与读回；具体模型客户端由组合根 serve.ts 注入，机制层不认识 headless。
   */
  readonly chat?: ChatHandler | null | undefined;
  /**
   * 进程内活动总线（#157 控制台脉冲）。缺省时 /api/pulse 退化为只回当前快照、不挂等。
   */
  readonly bus?: ActivityBus;
  /**
   * 记忆卡人类观测面（装配层打开；索引未就绪传 null，/api/cards* 显式 503 不伪装空数据）。
   */
  readonly observation?: MemoryObservationFace | null;
  /** 本次进程启动标识（启动屏用）；缺省随机生成，每次开服务变化。 */
  readonly bootId?: string;
  /** 前端静态资产目录（/app/* 托管根）；缺省时静态路由统一 404。 */
  readonly webRoot?: string;
  /** 长轮询挂等毫秒（测试注入短值用），缺省 5000。 */
  readonly pulseWaitMs?: number;
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
  readonly body?: string | Buffer;
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
  const bus = options.bus;
  const observation = options.observation ?? null;
  const bootId = options.bootId ?? randomBytes(8).toString('hex');
  const startedAt = Date.now();
  const webRoot = options.webRoot !== undefined ? path.resolve(options.webRoot) : null;
  const pulseWaitMs = options.pulseWaitMs ?? DEFAULT_PULSE_WAIT_MS;

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

      // ── /app 控制台静态资产（批 B：静态代码无秘密，免 Bearer 直开；Host 白名单/后缀/穿越门仍在）──
      // 浏览器地址栏与 <script src>/<link> 标签都无法自定义 Authorization 头，故前端公开资产不设
      // token 墙；一次性 token 仅由入口 HTML 的 nonce 内联引导注入内存，数据全在 /api，仍逐个 Bearer。
      // 跨源恶意页面读不到本响应体（无 CORS＋同源策略），拿不到 token，安全模型同 GET /。
      if (pathname === '/app' || pathname.startsWith('/app/')) {
        if (method !== 'GET') {
          send(errorReply(405, 'method-not-allowed', '仅支持 GET'));
          return;
        }
        if (webRoot === null) {
          send(errorReply(404, 'not-found', '路径不存在'));
          return;
        }
        const staticReply = await serveStaticAsset(webRoot, pathname, url, { token, bootId, channel });
        send(staticReply);
        return;
      }

      // ── /api 观测族（#157；全 GET 只读，先鉴权后分发；六工具不 HTTP 化）──
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (method !== 'GET') {
          send(errorReply(405, 'method-not-allowed', '观测 API 仅支持 GET'));
          return;
        }
        if (!tokenMatches(req.headers.authorization, token)) {
          send(errorReply(401, 'unauthorized', '缺少或错误的访问凭证'));
          return;
        }
        const apiReply = await handleObservationApi({
          req,
          res,
          url,
          pathname,
          fasti,
          bus,
          observation,
          boot: { bootId, startedAt },
          pulseWaitMs,
          defaultChannel: channel,
        });
        if (apiReply !== null) {
          send(apiReply);
        }
        return;
      }

      // 路由已识别（用于错方法时区分 405 与 404）。
      const turnsMatch = /^\/channels\/([^/]+)\/turns$/u.exec(pathname);
      const isExperiences = pathname === '/experiences';
      const isChat = pathname === '/chat';

      if (turnsMatch === null && !isExperiences && !isChat) {
        send(errorReply(404, 'not-found', '路径不存在'));
        return;
      }
      const allowedMethod = isExperiences ? 'GET' : 'POST';
      if (method !== allowedMethod) {
        send(errorReply(405, 'method-not-allowed', `仅支持 ${allowedMethod}`));
        return;
      }

      // ── 第二道：token 鉴权（写入、读回与聊天都要）──
      if (!tokenMatches(req.headers.authorization, token)) {
        send(errorReply(401, 'unauthorized', '缺少或错误的访问凭证'));
        return;
      }

      // ── 对话：POST /chat（未配模型显式 503，不伪装成可用）──
      if (isChat) {
        if (options.chat == null) {
          send(errorReply(503, 'chat-unavailable', '未配置模型端点，对话能力不可用'));
          return;
        }
        const chatBody = await readBody(req);
        if (chatBody.tooLarge) {
          send(errorReply(413, 'payload-too-large', '请求体超过 1 MiB 上限'));
          return;
        }
        let chatParsed: unknown;
        try {
          chatParsed = JSON.parse(chatBody.text);
        } catch {
          send(errorReply(400, 'bad-json', '请求体不是合法 JSON'));
          return;
        }
        const chatInput = chatParsed as Record<string, unknown> | null;
        if (typeof chatInput !== 'object' || chatInput === null) {
          send(errorReply(400, 'bad-request', '请求体必须是 JSON 对象'));
          return;
        }
        const text = chatInput['text'];
        if (typeof text !== 'string' || text.trim() === '') {
          send(errorReply(400, 'bad-request', '字段 text 必填且为非空字符串'));
          return;
        }
        const sessionId = typeof chatInput['session_id'] === 'string' ? chatInput['session_id'] : undefined;
        try {
          const result = await options.chat({ text, ...(sessionId === undefined ? {} : { sessionId }) });
          send(jsonReply(200, { ok: true, reply: result.reply, model: result.model }));
        } catch (error) {
          const name = error instanceof Error ? error.name : '';
          const message = error instanceof Error ? error.message : String(error);
          if (name === 'NotFoundError' || message.includes('通道未注册')) {
            send(errorReply(404, 'channel-not-found', '目标通道未注册，拒绝对话'));
            return;
          }
          if (name === 'UnavailableError') {
            // 不回显上游细节/鉴权信息，只给稳定错误码。
            send(errorReply(502, 'model-unavailable', '模型端暂时不可用，你的消息已留存'));
            return;
          }
          logger?.error('对话处理失败：%s', message);
          send(errorReply(500, 'internal', '对话处理失败'));
        }
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
        // 兜底：本机只读服务、关停即断。仍在途的长轮询连接不算 idle，
        // 等一拍再强清，给上层 bus.dispose 触发的正常响应收尾留出微任务窗口；
        // 客户端长轮询本就自带断线自愈，不在此做优雅排空。
        setImmediate(() => {
          server.closeAllConnections();
        });
      });
    },
  };
}

// ── #157 观测 API 与静态托管（全只读、零第三方依赖）；批 B 追加 bootstrap nonce 引导 ──────

/** 注入入口 HTML 的引导信息形状（对前端冻结，见 docs/task158-frontend-handoff-brief.md 3.2）。 */
interface BootstrapInfo {
  readonly token: string;
  readonly bootId: string;
  readonly channel: string;
}

/**
 * 静态响应安全头：强 CSP 锁死资源来源，配合白名单后缀杜绝任意文件投放。
 * 非 HTML 资产用严格版（script-src 仅 'self'）；入口 HTML 额外放行**本次响应专属**的单个
 * nonce——这是全站唯一允许的内联脚本，只承载 bootstrap；style 与内联事件仍一律不放行。
 */
function staticSecurityHeaders(nonce?: string): Record<string, string> {
  const scriptSrc = nonce === undefined ? "'self'" : `'self' 'nonce-${nonce}'`;
  return {
    'Content-Security-Policy':
      `default-src 'none'; script-src ${scriptSrc}; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

/**
 * 生成唯一内联引导脚本。序列化后对 `<`、`>`、`&` 与 Unicode 行分隔符做转义，
 * 杜绝 channel 等外部配置借 `</script>` 突破（token/bootId 自身为 base64url/hex 安全字符集）。
 */
function renderBootstrapScript(boot: BootstrapInfo, nonce: string): string {
  const payload = JSON.stringify({
    token: boot.token,
    bootId: boot.bootId,
    channel: boot.channel,
  })
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
  return `<script nonce="${nonce}">window.__FASTI_BOOTSTRAP__=${payload};</script>`;
}

/** 把引导脚本插入 HTML：优先 `</head>` 前，其次 `<body>` 开标签后，都没有则整体前置。 */
function injectBootstrap(html: string, scriptTag: string): string {
  const headClose = /<\/head>/iu.exec(html);
  if (headClose !== null) {
    return html.slice(0, headClose.index) + scriptTag + html.slice(headClose.index);
  }
  const bodyOpen = /<body[^>]*>/iu.exec(html);
  if (bodyOpen !== null) {
    const insertAt = bodyOpen.index + bodyOpen[0].length;
    return html.slice(0, insertAt) + scriptTag + html.slice(insertAt);
  }
  return scriptTag + html;
}

/**
 * 托管 /app/* 静态资产。路径先解码再 normalize 并强制圈定在 webRoot 内，
 * 任何越界（含 %2f 编码穿越）、后缀不在白名单、文件不存在一律 404，不区分存在性。
 * HTML 入口额外注入 nonce 引导并放宽该响应的 script-src；其余资产字节原样返回、CSP 不放宽。
 */
async function serveStaticAsset(
  webRoot: string,
  pathname: string,
  url: URL,
  boot: BootstrapInfo,
): Promise<Reply> {
  // URL 已拦掉明文 ../（会被规范化出 /app 前缀）；这里主要防 %2f 等编码形态。
  let rel = decodeURIComponent(pathname.slice('/app/'.length));
  if (rel === '' || rel.endsWith('/')) {
    rel = path.join(rel, 'index.html');
  }
  const resolved = path.normalize(path.resolve(webRoot, rel));
  if (resolved !== webRoot && !resolved.startsWith(webRoot + path.sep)) {
    return errorReply(404, 'not-found', '路径不存在');
  }
  const ext = path.extname(resolved).toLowerCase();
  const mime = STATIC_MIME[ext];
  if (mime === undefined) {
    return errorReply(404, 'not-found', '路径不存在');
  }
  let data: Buffer;
  try {
    data = await readFile(resolved);
  } catch {
    return errorReply(404, 'not-found', '路径不存在');
  }
  if (ext !== '.html') {
    return {
      status: 200,
      headers: { 'Content-Type': mime, 'Content-Length': String(data.byteLength), ...staticSecurityHeaders() },
      body: data,
    };
  }
  // 入口 HTML：每响应独立 nonce，注入唯一内联 bootstrap；普通内联脚本在 head 即执行，
  // 早于默认 defer 的 ESM 模块，外部 app.js 读取时 window.__FASTI_BOOTSTRAP__ 必然就绪。
  const nonce = randomBytes(16).toString('base64url');
  const injected = Buffer.from(injectBootstrap(data.toString('utf8'), renderBootstrapScript(boot, nonce)), 'utf8');
  return {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(injected.byteLength),
      ...staticSecurityHeaders(nonce),
    },
    body: injected,
  };
}

interface ObservationApiDeps {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly url: URL;
  readonly pathname: string;
  readonly fasti: Fasti;
  readonly bus: ActivityBus | undefined;
  readonly observation: MemoryObservationFace | null;
  readonly boot: { readonly bootId: string; readonly startedAt: number };
  readonly pulseWaitMs: number;
  readonly defaultChannel: string;
}

/** 解析分页参数：非法返回 null 由调用方回 400；缺省回退 fallback。 */
function integerParam(url: URL, key: string, fallback: number, max: number): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    return null;
  }
  return value;
}

/** 观测 API 总分发：只认 GET 只读端点，错误映射为稳定 HTTP 码，不回显内部细节。 */
async function handleObservationApi(deps: ObservationApiDeps): Promise<Reply | null> {
  const { url, pathname, fasti, bus, observation, boot, req, res, defaultChannel } = deps;
  const channel = url.searchParams.get('channel') ?? defaultChannel;

  try {
    if (pathname === '/api/status') {
      const snapshot = await fasti.inspectRuntime();
      return jsonReply(200, {
        ok: true,
        bootId: boot.bootId,
        startedAt: boot.startedAt,
        channel,
        ...snapshot,
        memory: observation?.getObservationCounts() ?? null,
      });
    }

    if (pathname === '/api/pulse') {
      const afterRaw = url.searchParams.get('after');
      let after: number;
      if (afterRaw === null) {
        after = bus?.currentSeq() ?? 0;
      } else {
        const parsed = Number(afterRaw);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return errorReply(400, 'bad-request', 'after 必须是非负整数序号');
        }
        after = parsed;
      }

      let activities = bus?.since(after) ?? [];
      if (activities.length === 0 && bus !== undefined) {
        let connectionOpen = true;
        const onClose = (): void => {
          connectionOpen = false;
        };
        req.once('close', onClose);
        await bus.waitForNext(deps.pulseWaitMs);
        req.off('close', onClose);
        if (!connectionOpen || res.writableEnded) {
          return null; // 客户端已断开：不写已关闭的 socket，连接句柄由 waitForNext 定时器自清理。
        }
        activities = bus.since(after);
      }
      const snapshot = await fasti.inspectRuntime();
      return jsonReply(200, {
        ok: true,
        seq: bus?.currentSeq() ?? 0,
        activities,
        snapshot,
        memory: observation?.getObservationCounts() ?? null,
      });
    }

    if (pathname === '/api/raw') {
      const limit = integerParam(url, 'limit', 50, OBSERVATION_PAGE_MAX);
      const offset = integerParam(url, 'offset', 0, 10_000);
      if (limit === null || offset === null || limit < 1) {
        return errorReply(400, 'bad-request', 'limit 须为 1–100 整数、offset 须为非负整数');
      }
      const page = await fasti.inspectRawTurns(channel, { limit, offset });
      return jsonReply(200, { ok: true, ...page });
    }

    if (pathname === '/api/experiences') {
      const limit = integerParam(url, 'limit', 50, OBSERVATION_PAGE_MAX);
      const offset = integerParam(url, 'offset', 0, 10_000);
      if (limit === null || offset === null || limit < 1) {
        return errorReply(400, 'bad-request', 'limit 须为 1–100 整数、offset 须为非负整数');
      }
      const all = await fasti.query({ channel });
      return jsonReply(200, {
        ok: true,
        total: all.length,
        limit,
        offset,
        experiences: all.slice(offset, offset + limit),
      });
    }

    const experienceMatch = /^\/api\/experiences\/([^/]+)$/u.exec(pathname);
    if (experienceMatch !== null) {
      const id = decodeURIComponent(experienceMatch[1] ?? '');
      const experience = await fasti.inspectExperience(id);
      if (experience === null) {
        return errorReply(404, 'not-found', '经历不存在');
      }
      return jsonReply(200, { ok: true, experience });
    }

    if (pathname === '/api/events') {
      const limit = integerParam(url, 'limit', 50, OBSERVATION_PAGE_MAX);
      if (limit === null || limit < 1) {
        return errorReply(400, 'bad-request', 'limit 须为 1–100 整数');
      }
      const events = await fasti.queryEventViews();
      return jsonReply(200, { ok: true, total: events.length, events: events.slice(0, limit) });
    }

    const eventMatch = /^\/api\/events\/([^/]+)$/u.exec(pathname);
    if (eventMatch !== null) {
      const id = decodeURIComponent(eventMatch[1] ?? '');
      const event = await fasti.getEventView(id);
      const versions = await fasti.listEventVersions(id);
      return jsonReply(200, { ok: true, event, versions });
    }

    if (pathname === '/api/cards') {
      if (observation === null) {
        return errorReply(503, 'memory-unavailable', '记忆索引未就绪，卡片观测暂不可用');
      }
      const limit = integerParam(url, 'limit', 50, OBSERVATION_PAGE_MAX);
      const offset = integerParam(url, 'offset', 0, 10_000);
      if (limit === null || offset === null || limit < 1) {
        return errorReply(400, 'bad-request', 'limit 须为 1–100 整数、offset 须为非负整数');
      }
      const cards = observation.listCardsForObservation({ limit, offset });
      return jsonReply(200, { ok: true, cards });
    }

    const cardMatch = /^\/api\/cards\/([^/]+)$/u.exec(pathname);
    if (cardMatch !== null) {
      if (observation === null) {
        return errorReply(503, 'memory-unavailable', '记忆索引未就绪，卡片观测暂不可用');
      }
      const id = decodeURIComponent(cardMatch[1] ?? '');
      const card = observation.getCardForObservation(id);
      if (card === null) {
        return errorReply(404, 'not-found', '卡片不存在');
      }
      return jsonReply(200, { ok: true, card });
    }

    if (pathname === '/api/projection') {
      const snapshot = await fasti.inspectRuntime();
      const edges = await fasti.queryEdges({});
      return jsonReply(200, {
        ok: true,
        engine: snapshot.engine,
        eventLayer: snapshot.eventLayer,
        checkpoint: snapshot.checkpoint,
        reconciliation: snapshot.reconciliation,
        edges: edges.slice(0, OBSERVATION_PAGE_MAX),
      });
    }

    return errorReply(404, 'not-found', '观测端点不存在');
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') {
      return errorReply(404, 'not-found', '目标不存在');
    }
    if (error instanceof Error && error.name === 'SchemaError') {
      return errorReply(400, 'bad-request', '查询参数形状非法');
    }
    throw error; // 交外层兜底 500，不向浏览器泄露内部类名/堆栈。
  }
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
  textarea, input[type=text] { width: 100%; font: inherit; box-sizing: border-box; }
  textarea { height: 5rem; }
  button { font: inherit; padding: .3rem .9rem; }
  pre { background: #f4f4f4; padding: .8rem; overflow: auto; }
  .chat { margin-top: 2rem; border-top: 1px solid #ccc; padding-top: 1rem; }
  #chat-log { min-height: 3rem; margin-bottom: .8rem; }
  .msg { margin: .4rem 0; }
  .msg .who { color: #666; margin-right: .4rem; }
  .msg.assistant .bubble { background: #eef3ff; }
  .bubble { display: inline-block; padding: .4rem .7rem; border-radius: .5rem; background: #f4f4f4; white-space: pre-wrap; }
</style>
<h1>FasTI 本地演示</h1>
<p>通道：<code>${safeChannel}</code>　此页面与接口同源，token 由服务端注入。</p>
<textarea id="text" placeholder="写一句话，下面点写入"></textarea>
<p><button id="write">写入</button> <button id="read">读回</button></p>
<pre id="out">（等待操作）</pre>
<div class="chat">
  <h2>和本机模型对话</h2>
  <div id="chat-log"></div>
  <input type="text" id="chat-input" placeholder="输入一句话，回车发送">
  <p><button id="chat-send">发送</button></p>
</div>
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
  const chatLog = document.getElementById('chat-log');
  const chatInput = document.getElementById('chat-input');
  const addMsg = (who, text) => {
    const row = document.createElement('div');
    row.className = 'msg ' + who;
    const label = document.createElement('span');
    label.className = 'who';
    label.textContent = who === 'user' ? '我' : '助手';
    const bubble = document.createElement('span');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.append(label, bubble);
    chatLog.append(row);
  };
  const sendChat = async () => {
    const text = chatInput.value.trim();
    if (!text) return;
    addMsg('user', text);
    chatInput.value = '';
    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const payload = await res.json();
      addMsg(res.ok ? 'assistant' : 'user', res.ok ? payload.reply : ('（错误 ' + payload.error.code + '）'));
    } catch (error) {
      addMsg('user', '（网络错误：' + String(error) + '）');
    }
  };
  document.getElementById('chat-send').onclick = sendChat;
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendChat();
  });
</script>
</html>
`;
}
