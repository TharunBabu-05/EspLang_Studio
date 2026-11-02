import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { isBoardId } from '@esplang/compiler';
import { integer } from './config.js';
import { recoverContainers, runContainer, sandboxReady } from './containerRunner.js';

const secret = process.env.WORKER_SECRET ?? '';
if (secret.length < 32) throw new Error('WORKER_SECRET must contain at least 32 characters');
const options = {
  image: process.env.WORKER_IMAGE ?? 'esplang-worker:local',
  pool: process.env.WORKER_POOL ?? 'esplang',
  memoryMb: integer('WORKER_MEMORY_MB', 2048, 512, 8192),
  cpus: integer('WORKER_CPUS', 1, 1, 8),
  tmpfsMb: integer('WORKER_TMPFS_MB', 1024, 256, 4096),
  timeoutMs: integer('BUILD_TIMEOUT_MS', 240000, 1000, 900000),
};
if (!/^[a-zA-Z0-9_.-]+$/.test(options.pool)) throw new Error('Invalid WORKER_POOL');
const concurrency = integer('BUILD_CONCURRENCY', 2, 1, 8);
await recoverContainers(options.pool);
await sandboxReady(options.image);
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const candidate = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    res.sendStatus(401);
    return;
  }
  next();
});
app.use(express.json({ limit: '128kb' }));
app.get('/health', async (_req, res) => {
  try {
    await sandboxReady(options.image);
    res.json({ ready: true });
  } catch {
    res.status(503).json({ ready: false });
  }
});
const controllers = new Map<string, AbortController>();
app.post('/cancel', (req, res) => {
  const id: unknown = req.body?.id;
  if (typeof id !== 'string' || !controllers.has(id)) {
    res.sendStatus(404);
    return;
  }
  controllers.get(id)!.abort(new Error('Build cancelled'));
  res.sendStatus(202);
});
app.post('/build', async (req, res) => {
  const input = req.body as {
    id?: unknown;
    source?: unknown;
    board?: unknown;
    serialRoute?: unknown;
  } | null;
  if (
    !input ||
    typeof input.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(input.id) ||
    controllers.has(input.id) ||
    typeof input.source !== 'string' ||
    input.source.length > 100000 ||
    typeof input.board !== 'string' ||
    !isBoardId(input.board) ||
    (input.serialRoute !== 'uart' && input.serialRoute !== 'usb')
  ) {
    res.sendStatus(400);
    return;
  }
  if (controllers.size >= concurrency) {
    res.sendStatus(503);
    return;
  }
  const controller = new AbortController();
  controllers.set(input.id, controller);
  res.on('close', () => controller.abort());
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  res.flushHeaders();
  const write = (line: string) => {
    if (res.destroyed || res.writableLength > 8_000_000) {
      controller.abort();
      return;
    }
    res.write(`${line}\n`);
  };
  let terminal = false;
  let terminalLine = '';
  try {
    await runContainer(
      { source: input.source, board: input.board, serialRoute: input.serialRoute },
      options,
      controller.signal,
      (line) => {
        const event = JSON.parse(line) as { type: string };
        // Hold the terminal event until the container has exited and been removed.
        if (event.type === 'result' || event.type === 'error') {
          terminal = true;
          terminalLine = line;
        } else write(line);
      },
    );
  } catch (error) {
    if (!terminal || JSON.parse(terminalLine).type !== 'error')
      terminalLine = JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Isolated build failed',
      });
  } finally {
    if (!res.destroyed && terminalLine) write(terminalLine);
    controllers.delete(input.id);
    res.end();
  }
});
const server = app.listen(integer('RUNNER_PORT', 3002, 1, 65535), '0.0.0.0', () =>
  console.log('Isolated build runner ready'),
);
function shutdown() {
  controllers.forEach((controller) => controller.abort());
  server.close();
  setTimeout(() => process.exit(0), 20000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
