import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { compile, isBoardId, type ServerEvent } from '@esplang/compiler';
import { buildFirmware, BuildError, runCli } from './builder.js';
import { hostingConfig, integer } from './config.js';
import {
  AdmissionError,
  BuildQueue,
  Sessions,
  UsageLimiter,
  clientAddress,
  proxyNetworks,
  type BuildExecutor,
} from './hosting.js';
import { remoteExecutor } from './workerClient.js';

export function createStudioServer(
  overrides: { execute?: BuildExecutor; ready?: () => Promise<boolean> } = {},
) {
  const config = hostingConfig();
  const port = integer('PORT', 3001, 1, 65535);
  const host = process.env.HOST ?? '127.0.0.1';
  const secret =
    process.env.SESSION_SECRET ?? (config.hosted ? '' : randomBytes(32).toString('hex'));
  const sessions = new Sessions(secret);
  const localToken = process.env.BUILD_TOKEN ?? randomBytes(32).toString('hex');
  const limits = new UsageLimiter();
  const trusted = proxyNetworks(process.env.TRUST_PROXY_CIDRS);
  const origins = new Set(
    config.hosted
      ? [config.origin!]
      : (
          process.env.ALLOWED_ORIGINS ??
          `http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:${port},http://localhost:${port}`
        )
          .split(',')
          .map((s) => s.trim()),
  );
  const hosts = new Set(
    config.hosted
      ? [new URL(config.origin!).host]
      : [
          `localhost:${port}`,
          `127.0.0.1:${port}`,
          `${host}:${port}`,
          'localhost',
          '127.0.0.1',
          host,
        ],
  );
  if (!config.hosted) for (const origin of origins) hosts.add(new URL(origin).host);
  const execute: BuildExecutor =
    overrides.execute ??
    (config.hosted
      ? remoteExecutor(config.worker!, config.workerSecret, config.buildMs)
      : async (input, emit, signal) =>
          buildFirmware(
            input.source,
            input.board,
            (message) => emit({ type: 'log', message }),
            signal,
            input.serialRoute,
          ));
  const queue = new BuildQueue(execute, config);
  const ownerOf = (req: Parameters<typeof clientAddress>[0]) =>
    sessions.owner(clientAddress(req, trusted));
  const validHost = (req: Parameters<typeof clientAddress>[0]) => hosts.has(req.headers.host ?? '');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!validHost(req) || (req.headers.origin && !origins.has(req.headers.origin))) {
      res.status(403).json({ error: 'Host or origin is not allowed' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'serial=(self)');
    res.setHeader('X-Frame-Options', 'DENY');
    if (config.hosted)
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
    if (config.hosted && req.path.startsWith('/api/')) {
      try {
        limits.take(`http:${ownerOf(req)}`, 120, 60_000);
      } catch (error) {
        const limit = error as AdmissionError;
        res.setHeader('Retry-After', limit.retryAfter);
        res.status(429).json({ error: limit.message, retryAfter: limit.retryAfter });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.get('/api/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      config.hosted
        ? {
            ...sessions.issue(ownerOf(req)),
            mode: 'hosted',
            limits: { buildsPerHour: config.buildsPerHour, buildSeconds: config.buildMs / 1000 },
          }
        : { token: localToken, mode: 'local' },
    );
  });
  let health: { expires: number; pending: Promise<boolean> } | undefined;
  const ready =
    overrides.ready ??
    (async () => {
      if (config.hosted) {
        const response = await fetch(new URL('/health', config.worker), {
          headers: { authorization: `Bearer ${config.workerSecret}` },
          signal: AbortSignal.timeout(5000),
        });
        return response.ok && ((await response.json()) as { ready?: boolean }).ready === true;
      }
      const cores = await runCli(['core', 'list'], { log: () => {}, timeout: 10000 });
      return /^esp32:esp32\s+3\./m.test(cores);
    });
  app.get('/api/health', async (_req, res) => {
    if (!health || health.expires < Date.now())
      health = { expires: Date.now() + 10000, pending: ready().catch(() => false) };
    const toolchain = await health.pending;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      mode: config.hosted ? 'hosted' : 'local',
      toolchain,
      queue: queue.status,
      limits: { buildsPerHour: config.buildsPerHour, buildSeconds: config.buildMs / 1000 },
      message: toolchain
        ? 'Ready'
        : config.hosted
          ? 'Build workers are unavailable'
          : 'Install the ESP32 toolchain with npm run setup:toolchain',
    });
  });
  app.post('/api/analyze', (req, res) => {
    const body = req.body as { source?: unknown; board?: unknown } | null;
    if (
      !body ||
      typeof body.source !== 'string' ||
      body.source.length > 100000 ||
      typeof body.board !== 'string' ||
      !isBoardId(body.board)
    ) {
      res.status(400).json({ error: 'Expected source (up to 100 KB) and a supported board' });
      return;
    }
    try {
      const { diagnostics, cpp } = compile(body.source, body.board);
      res.json({ diagnostics, cpp });
    } catch {
      res.status(400).json({ error: 'Source is too complex or invalid' });
    }
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown API endpoint' });
  });
  const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webRoot)) {
    app.use(express.static(webRoot));
    app.get('/{*path}', (_req, res) => res.sendFile(`${webRoot}/index.html`));
  }
  app.use(
    (
      error: { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(error.status === 413 ? 413 : 400)
        .json({ error: error.status === 413 ? 'Request is too large' : 'Invalid request' });
    },
  );
  const server = createServer(app);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  const connections = new Map<string, number>();
  server.on('upgrade', (req, socket, head) => {
    if (
      req.url !== '/api/build' ||
      !validHost(req) ||
      !req.headers.origin ||
      !origins.has(req.headers.origin)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const owner = ownerOf(req);
    try {
      if (wss.clients.size >= config.maxConnections || (connections.get(owner) ?? 0) >= 3)
        throw new AdmissionError('Too many build connections');
      if (config.hosted) limits.take(`socket:${owner}`, 30, 60_000);
    } catch {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections.set(owner, (connections.get(owner) ?? 0) + 1);
      ws.once('close', () => {
        const count = (connections.get(owner) ?? 1) - 1;
        if (count) connections.set(owner, count);
        else connections.delete(owner);
      });
      wss.emit('connection', ws, req);
    });
  });
  wss.on('connection', (ws, req) => {
    const controller = new AbortController();
    const owner = ownerOf(req);
    let started = false,
      alive = true;
    const send = (event: ServerEvent) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 8_000_000) {
        controller.abort();
        ws.close(1013, 'Client too slow');
      } else ws.send(JSON.stringify(event));
    };
    const timer = setTimeout(() => ws.close(1008, 'Request timeout'), 10000);
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30000);
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('close', () => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      controller.abort();
    });
    ws.on('error', () => controller.abort());
    ws.on('message', async (raw) => {
      if (started) return;
      started = true;
      clearTimeout(timer);
      try {
        let request: {
          token?: unknown;
          source?: unknown;
          board?: unknown;
          serialRoute?: unknown;
        } | null;
        try {
          request = JSON.parse(raw.toString()) as typeof request;
        } catch {
          throw new AdmissionError('Invalid JSON request');
        }
        const candidate = Buffer.from(typeof request?.token === 'string' ? request.token : '');
        const expected = Buffer.from(localToken);
        const authenticated = config.hosted
          ? sessions.verify(request?.token, owner)
          : candidate.length === expected.length && timingSafeEqual(candidate, expected);
        if (
          !request ||
          !authenticated ||
          typeof request.source !== 'string' ||
          request.source.length > 100000 ||
          typeof request.board !== 'string' ||
          !isBoardId(request.board) ||
          (request.serialRoute !== undefined &&
            request.serialRoute !== 'uart' &&
            request.serialRoute !== 'usb')
        )
          throw new AdmissionError('Invalid or expired build session. Please build again.');
        const firmware = await queue.submit(
          owner,
          {
            source: request.source,
            board: request.board,
            serialRoute: request.serialRoute ?? 'uart',
          },
          send,
          controller.signal,
          () => {
            if (config.hosted) limits.take(`build:${owner}`, config.buildsPerHour, 3600000);
          },
        );
        send({ type: 'result', firmware });
      } catch (error) {
        send({
          type: 'error',
          message: error instanceof Error ? error.message : 'Build failed',
          diagnostics: error instanceof BuildError ? error.diagnostics : undefined,
          retryAfter: error instanceof AdmissionError ? error.retryAfter : undefined,
        });
      } finally {
        ws.close();
      }
    });
  });
  function close() {
    queue.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
    server.closeIdleConnections();
  }
  return { server, close, queue, config, host, port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const studio = createStudioServer();
  studio.server.listen(studio.port, studio.host, () =>
    console.log(
      `EspLang ${studio.config.hosted ? 'hosted' : 'local'} server: http://${studio.host}:${studio.port}`,
    ),
  );
  const shutdown = () => {
    studio.close();
    setTimeout(() => process.exit(0), 20000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
