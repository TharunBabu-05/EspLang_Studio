import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Firmware, ServerEvent } from '../packages/compiler/src/index.js';
import { createStudioServer } from '../packages/server/src/server.js';

let studio: ReturnType<typeof createStudioServer> | undefined;
const origin = 'https://studio.example.com';
const headers = { host: 'studio.example.com', origin };
const firmware: Firmware = {
  board: 'esp32',
  serialRoute: 'uart',
  fqbn: 'test',
  artifacts: [],
  cpp: 'generated',
  diagnostics: [],
};
// Send an explicit virtual Host as the deployment reverse proxy does. Node's
// browser-compatible fetch deliberately manages Host itself.
function fetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: init.method, headers: init.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () =>
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            headers: response.headers as Record<string, string>,
          }),
        ),
      );
    });
    outgoing.on('error', reject);
    outgoing.end(init.body);
  });
}
beforeEach(() => {
  vi.stubEnv('BUILD_MODE', 'hosted');
  vi.stubEnv('PUBLIC_ORIGIN', origin);
  vi.stubEnv('WORKER_URL', 'http://worker.invalid');
  vi.stubEnv('WORKER_SECRET', 'w'.repeat(64));
  vi.stubEnv('SESSION_SECRET', 's'.repeat(64));
  vi.stubEnv('TRUST_PROXY_CIDRS', '127.0.0.1/32');
  vi.stubEnv('BUILDS_PER_HOUR', '1');
});
afterEach(async () => {
  if (studio) {
    const closed = once(studio.server, 'close');
    studio.close();
    await closed;
    studio = undefined;
  }
  vi.unstubAllEnvs();
});
async function start() {
  const execute = vi.fn(async () => firmware);
  studio = createStudioServer({ execute, ready: async () => true });
  studio.server.listen(0, '127.0.0.1');
  await once(studio.server, 'listening');
  return { base: `http://127.0.0.1:${(studio.server.address() as AddressInfo).port}`, execute };
}
async function session(base: string, ip = '192.0.2.1') {
  const response = await fetch(`${base}/api/session`, {
    headers: { ...headers, 'x-forwarded-for': ip },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return ((await response.json()) as { token: string }).token;
}
async function build(base: string, token: string, ip = '192.0.2.1') {
  return new Promise<ServerEvent[]>((resolve, reject) => {
    const events: ServerEvent[] = [];
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/build`, {
      origin,
      headers: { host: headers.host, 'x-forwarded-for': ip },
    });
    socket.on('open', () =>
      socket.send(JSON.stringify({ token, source: 'setup {} loop {}', board: 'esp32' })),
    );
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    socket.on('close', () => resolve(events));
    socket.on('error', reject);
  });
}

it('serves hosted state, checks origin/host, and accepts authenticated builds', async () => {
  const { base, execute } = await start();
  const health = await fetch(`${base}/api/health`, { headers });
  expect(await health.json()).toMatchObject({
    mode: 'hosted',
    toolchain: true,
    queue: { active: 0 },
  });
  expect(health.headers.get('permissions-policy')).toBe('serial=(self)');
  expect((await fetch(`${base}/api/session`)).status).toBe(403);
  expect(
    (
      await fetch(`${base}/api/session`, {
        headers: { host: headers.host, origin: 'https://evil.invalid' },
      })
    ).status,
  ).toBe(403);
  const events = await build(base, await session(base));
  expect(events[0]).toEqual({ type: 'status', state: 'building' });
  expect(events.at(-1)).toEqual({ type: 'result', firmware });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('binds build tokens to the client and keeps quota across fresh tokens', async () => {
  const { base, execute } = await start();
  const token = await session(base);
  expect((await build(base, token, '192.0.2.2')).at(-1)).toMatchObject({
    type: 'error',
    message: expect.stringContaining('session'),
  });
  expect(execute).not.toHaveBeenCalled();
  await build(base, token);
  const events = await build(base, await session(base));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: 'error',
    message: expect.stringContaining('Usage limit'),
    retryAfter: expect.any(Number),
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('rejects a WebSocket handshake with an unauthorized Host header', async () => {
  const { base } = await start();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/build`, {
      origin,
      headers: { host: 'evil.invalid' },
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
      socket.terminate();
    });
    socket.on('open', () => {
      socket.terminate();
      reject(new Error('Unexpected successful handshake'));
    });
    socket.on('error', () => {});
  });
  expect(status).toBe(403);
});

it('returns safe JSON for malformed requests and unknown APIs', async () => {
  const { base } = await start();
  const response = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{ broken',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Invalid request' });
  expect((await fetch(`${base}/api/missing`, { headers })).status).toBe(404);
});
