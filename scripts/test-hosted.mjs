import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import https from 'node:https';
import assert from 'node:assert/strict';

// This smoke test is exclusively for compose.test.yml and its local test CA.
const exec = promisify(execFile);
const origin = 'https://studio.localhost';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = '.verification/hosted';
await mkdir(evidence, { recursive: true });
function health() {
  return new Promise((resolve, reject) => {
    const request = https.get(
      'https://127.0.0.1/api/health',
      { headers: { host: 'studio.localhost' }, rejectUnauthorized: false, timeout: 5000 },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Health timeout')));
  });
}
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    if ((await health()).toolchain) {
      ready = true;
      break;
    }
  } catch {}
  await pause(2000);
}
assert(ready, 'Hosted gateway and isolated runner must become ready');
const browser = await chromium.launch({
  headless: true,
  args: [
    '--host-resolver-rules=MAP studio.localhost 127.0.0.1',
    '--disable-quic',
    '--no-proxy-server',
  ],
  ...(process.platform === 'win32' ? { channel: 'chrome' } : {}),
});
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      break;
    } catch (error) {
      if (attempt >= 2 || !/ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET/.test(String(error)))
        throw error;
      await pause(500);
    }
  }
  await page.getByText('CLOUD WORKSPACE', { exact: true }).waitFor();
  await page.getByText('Build server ready', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Blink & read', exact: false }).click();
  await page.getByRole('button', { name: '▷ Build', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel build', exact: true }).waitFor();
  let id = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    const { stdout } = await exec('docker', ['ps', '-q', '--filter', 'label=esplang.pool=esplang']);
    id = stdout.trim().split('\n')[0] ?? '';
    if (id) break;
    await pause(200);
  }
  assert(id, 'A disposable worker must be running');
  const { stdout } = await exec('docker', ['inspect', id]);
  const container = JSON.parse(stdout)[0];
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.Config.User, '1000:1000');
  assert.equal(container.HostConfig.Memory, 2048 * 1024 * 1024);
  assert.equal(container.HostConfig.MemorySwap, container.HostConfig.Memory);
  assert.equal(container.HostConfig.PidsLimit, 128);
  assert(container.HostConfig.CapDrop.includes('ALL'));
  assert(container.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert(
    container.Mounts.every((mount) => mount.Type === 'tmpfs' && mount.Destination === '/tmp'),
    'Job must not receive host mounts',
  );
  assert(
    !container.Config.Env.some((value) => /WORKER_SECRET|SESSION_SECRET|BUILD_TOKEN/.test(value)),
  );
  await writeFile(
    `${evidence}/sandbox.json`,
    JSON.stringify(
      {
        network: 'none',
        readOnly: true,
        user: container.Config.User,
        memoryBytes: container.HostConfig.Memory,
        pidsLimit: 128,
        noHostMounts: true,
        noServiceSecrets: true,
      },
      null,
      2,
    ),
  );
  await page.getByLabel('Firmware downloads').waitFor({ timeout: 270000 });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '↓ Manifest', exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(`${evidence}/firmware.json`);
  const manifest = JSON.parse(await readFile(`${evidence}/firmware.json`, 'utf8'));
  assert.equal(manifest.board, 'esp32');
  assert.equal(manifest.artifacts.length, 4);
  for (const artifact of manifest.artifacts) {
    const data = Buffer.from(artifact.data, 'base64');
    assert.equal(data.length, artifact.size);
    assert.equal(createHash('sha256').update(data).digest('hex'), artifact.sha256);
  }
  await page.screenshot({ path: `${evidence}/studio.png`, fullPage: true });
  await pause(1000);
  const { stdout: remaining } = await exec('docker', [
    'ps',
    '-aq',
    '--filter',
    'label=esplang.pool=esplang',
  ]);
  assert.equal(remaining.trim(), '', 'Completed job containers must be removed');
  // Exercise real cancellation and container teardown after the successful build.
  await page.getByRole('button', { name: '▷ Build', exact: true }).click();
  for (let attempt = 0; attempt < 100; attempt++) {
    const { stdout: active } = await exec('docker', [
      'ps',
      '-q',
      '--filter',
      'label=esplang.pool=esplang',
    ]);
    if (active.trim()) break;
    if (attempt === 99) throw new Error('Cancellation test worker did not start');
    await pause(100);
  }
  await page.getByRole('button', { name: 'Cancel build', exact: true }).click();
  let cancelled = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const { stdout: active } = await exec('docker', [
      'ps',
      '-aq',
      '--filter',
      'label=esplang.pool=esplang',
    ]);
    if (!active.trim()) {
      cancelled = true;
      break;
    }
    await pause(200);
  }
  assert(cancelled, 'Cancelling a build must remove its job container');
  assert.deepEqual(errors, [], 'Hosted page must load without runtime or CSP errors');
  console.log(
    'Hosted HTTPS browser → queue → networkless sandbox → native firmware → verified downloads: passed',
  );
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true }).catch(() => {});
  console.error('Browser errors:', errors);
  console.error(
    'Visible build output:',
    await page
      .locator('.terminal')
      .textContent({ timeout: 1000 })
      .catch(() => 'unavailable'),
  );
  throw error;
} finally {
  await context.close();
  await browser.close();
}
