import { WebSocket } from 'ws';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ServerEvent } from '../packages/compiler/src/index.js';
const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173';
const health = (await fetch(`${base}/api/health`).then((r) => r.json())) as {
  ok: boolean;
  toolchain: boolean;
};
assert.equal(health.ok, true);
console.log('Health:', health);
assert.equal((await fetch(base)).status, 200);
const invalid = await fetch(`${base}/api/analyze`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ board: 'unsupported', source: '' }),
});
assert.equal(invalid.status, 400);
const hostile = await fetch(`${base}/api/session`, {
  headers: { origin: 'https://example.invalid' },
});
assert.equal(hostile.status, 403);
const analysis = (await fetch(`${base}/api/analyze`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ board: 'esp32', source: 'setup {} loop { pinMode(34, OUTPUT); }' }),
}).then((r) => r.json())) as { diagnostics: { severity: string }[] };
assert(analysis.diagnostics.some((d) => d.severity === 'error'));
console.log('HTTP, origin checks, request validation, diagnostics: passed');
async function expectWebSocketError(payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/build`, { origin: base });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('WebSocket error response timed out'));
    }, 5000);
    socket.on('open', () => socket.send(payload));
    socket.on('message', (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as ServerEvent;
        if (event.type === 'status') return;
        assert.equal(event.type, 'error');
        clearTimeout(timer);
        socket.close();
        resolve();
      } catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
await expectWebSocketError('invalid json');
await expectWebSocketError(
  JSON.stringify({ token: 'é'.repeat(64), board: 'esp32', source: 'setup {} loop {}' }),
);
const session = (await fetch(`${base}/api/session`).then((response) => response.json())) as {
  token: string;
};
await expectWebSocketError(
  JSON.stringify({
    token: session.token,
    board: 'esp32',
    source: 'setup {} loop { pinMode(34, OUTPUT); }',
  }),
);
assert.equal((await fetch(`${base}/api/health`)).status, 200);
console.log('WebSocket malformed JSON, invalid token bytes, and compiler error delivery: passed');
if (process.argv.includes('--build')) {
  assert(health.toolchain, 'Arduino CLI must be installed');
  const { token } = (await fetch(`${base}/api/session`).then((r) => r.json())) as { token: string };
  const source = await readFile(process.env.SMOKE_SOURCE ?? 'examples/blink.esp', 'utf8');
  const target = process.env.SMOKE_BOARD ?? 'esp32';
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/build`, { origin: base });
    let received = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Build smoke test timed out'));
    }, 300000);
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          token,
          source,
          board: target,
          serialRoute: process.env.SMOKE_SERIAL_ROUTE ?? 'uart',
        }),
      ),
    );
    ws.on('message', async (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as ServerEvent;
        if (event.type === 'log') process.stdout.write(event.message);
        else if (event.type === 'status')
          console.log('Build status:', event.state, event.position ?? '');
        else if (event.type === 'error') {
          clearTimeout(timer);
          ws.close();
          reject(new Error(event.message));
        } else {
          received = true;
          assert.equal(event.firmware.board, target);
          assert.equal(event.firmware.artifacts.length, 4);
          const directory = process.env.SMOKE_OUTPUT ?? `.verification/${target}`;
          await mkdir(directory, { recursive: true });
          for (const artifact of event.firmware.artifacts) {
            const data = Buffer.from(artifact.data, 'base64');
            assert.equal(data.length, artifact.size);
            assert.equal(createHash('sha256').update(data).digest('hex'), artifact.sha256);
            await writeFile(`${directory}/${artifact.name}`, data);
            console.log(
              `${artifact.name}: ${data.length} bytes at 0x${artifact.address.toString(16)}`,
            );
          }
          await writeFile(`${directory}/main.cpp`, event.firmware.cpp);
          await writeFile(`${directory}/firmware.json`, JSON.stringify(event.firmware, null, 2));
          clearTimeout(timer);
          ws.close();
          console.log('WebSocket logs, native compilation, sparse images and checksums: passed');
          resolve();
        }
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on('close', () => {
      if (!received) {
        clearTimeout(timer);
        reject(new Error('Connection closed before firmware result'));
      }
    });
  });
}
