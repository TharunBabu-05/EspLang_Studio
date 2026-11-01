import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { compile, isBoardId, type ServerEvent } from '@esplang/compiler';
import { buildFirmware, BuildError, runCli } from './builder.js';
const app = express();
app.disable('x-powered-by');
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
const allowedOrigins = new Set(
  (
    process.env.ALLOWED_ORIGINS ??
    `http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:${port},http://localhost:${port}`
  ).split(','),
);
const token = process.env.BUILD_TOKEN ?? randomBytes(32).toString('hex');
const authenticated = (candidate: unknown): boolean => {
  if (typeof candidate !== 'string') return false;
  const actual = Buffer.from(candidate),
    expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: 'Origin is not allowed' });
    return;
  }
  const requestHost = (req.headers.host ?? '').split(':')[0];
  if (!['localhost', '127.0.0.1', host].includes(requestHost!)) {
    res.status(403).json({ error: 'Host is not allowed' });
    return;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '128kb' }));
app.get('/api/session', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token });
});
app.get('/api/health', async (_req, res) => {
  try {
    const version = await runCli(['version'], { log: () => {}, timeout: 5000 });
    const cores = await runCli(['core', 'list'], { log: () => {}, timeout: 10000 });
    const toolchain = /^esp32:esp32\s+3\./m.test(cores);
    res.json({
      ok: true,
      toolchain,
      version: version.trim(),
      message: toolchain ? 'Ready' : 'Install esp32:esp32@3.3.2 with npm run setup:toolchain',
    });
  } catch {
    res.json({ ok: true, toolchain: false, message: 'Arduino CLI not installed or unavailable' });
  }
});
app.post('/api/analyze', (req, res) => {
  const body: unknown = req.body;
  if (
    !body ||
    typeof body !== 'object' ||
    !('source' in body) ||
    typeof body.source !== 'string' ||
    body.source.length > 100000 ||
    !('board' in body) ||
    typeof body.board !== 'string' ||
    !isBoardId(body.board)
  ) {
    res.status(400).json({ error: 'Expected source (up to 100 KB) and a supported board' });
    return;
  }
  const { diagnostics, cpp } = compile(body.source, body.board);
  res.json({ diagnostics, cpp });
});
const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webRoot)) {
  app.use(express.static(webRoot));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(webRoot, 'index.html')));
}
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/api/build' || !req.headers.origin || !allowedOrigins.has(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
let busy = false;
wss.on('connection', (ws) => {
  let started = false;
  const controller = new AbortController();
  const send = (event: ServerEvent): void => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 8_000_000) {
        controller.abort();
        ws.close(1013, 'Client too slow');
      } else ws.send(JSON.stringify(event));
    }
  };
  const timer = setTimeout(() => ws.close(1008, 'Request timeout'), 10000);
  ws.on('close', () => {
    clearTimeout(timer);
    controller.abort();
  });
  ws.on('error', () => controller.abort());
  ws.on('message', async (raw) => {
    if (started) return;
    let request: unknown;
    try {
      request = JSON.parse(raw.toString());
    } catch {
      send({ type: 'error', message: 'Invalid JSON request' });
      ws.close(1008);
      return;
    }
    if (
      !request ||
      typeof request !== 'object' ||
      !('token' in request) ||
      !authenticated(request.token) ||
      !('source' in request) ||
      typeof request.source !== 'string' ||
      request.source.length > 100000 ||
      !('board' in request) ||
      typeof request.board !== 'string' ||
      !isBoardId(request.board) ||
      ('serialRoute' in request && request.serialRoute !== 'uart' && request.serialRoute !== 'usb')
    ) {
      send({ type: 'error', message: 'Invalid or unauthorized build request' });
      ws.close(1008);
      return;
    }
    clearTimeout(timer);
    started = true;
    if (busy) {
      send({ type: 'error', message: 'A build is already running. Try again shortly.' });
      ws.close();
      return;
    }
    busy = true;
    try {
      send({
        type: 'result',
        firmware: await buildFirmware(
          request.source,
          request.board,
          (message) => send({ type: 'log', message }),
          controller.signal,
          'serialRoute' in request && request.serialRoute === 'usb' ? 'usb' : 'uart',
        ),
      });
    } catch (e) {
      send({
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
        diagnostics: e instanceof BuildError ? e.diagnostics : undefined,
      });
    } finally {
      busy = false;
      ws.close();
    }
  });
});
server.listen(port, host, () => console.log(`EspLang server: http://${host}:${port}`));
function shutdown(): void {
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));
  server.close();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
