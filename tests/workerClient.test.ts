import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { remoteExecutor } from '../packages/server/src/workerClient.js';
import type { Firmware, ServerEvent } from '../packages/compiler/src/index.js';

let server: Server;
afterEach(async () => {
  if (server) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
async function base() {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const input = { board: 'esp32' as const, serialRoute: 'uart' as const, source: 'setup {} loop {}' };
const firmware: Firmware = {
  board: 'esp32',
  serialRoute: 'uart',
  fqbn: 'test',
  cpp: '',
  artifacts: [],
  diagnostics: [],
};
it('handles fragmented NDJSON and streams logs before returning firmware', async () => {
  server = createServer((_req, res) => {
    const body = `${JSON.stringify({ type: 'log', message: 'héllo' })}\n${JSON.stringify({ type: 'result', firmware })}\n`;
    const bytes = Buffer.from(body);
    res.write(bytes.subarray(0, 28));
    setTimeout(() => res.end(bytes.subarray(28)), 5);
  });
  const events: ServerEvent[] = [];
  const result = await remoteExecutor(await base(), 'secret')(
    input,
    (event) => events.push(event),
    new AbortController().signal,
  );
  expect(result).toEqual(firmware);
  expect(events).toEqual([{ type: 'log', message: 'héllo' }]);
});
it('waits for worker cancellation and cleanup instead of releasing its slot immediately', async () => {
  let finish!: () => void;
  let cancelled!: () => void;
  const didCancel = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  server = createServer((req, res) => {
    req.resume();
    if (req.url === '/cancel') {
      cancelled();
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.flushHeaders();
    finish = () => res.end(`${JSON.stringify({ type: 'error', message: 'Build cancelled' })}\n`);
  });
  const controller = new AbortController();
  let settled = false;
  const pending = remoteExecutor(await base(), 'secret')(
    input,
    () => controller.abort(),
    controller.signal,
  ).finally(() => {
    settled = true;
  });
  const assertion = expect(pending).rejects.toThrow('cancelled');
  // The worker sends no logs in this test; cancel after its response is open.
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await didCancel;
  expect(settled).toBe(false);
  finish();
  await assertion;
});
it('rejects truncated worker responses', async () => {
  server = createServer((_req, res) => res.end('{"type":"result"'));
  await expect(
    remoteExecutor(await base(), 'secret')(input, () => {}, new AbortController().signal),
  ).rejects.toThrow('complete');
});
