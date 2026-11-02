import { test, expect, type WebSocketRoute } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { toolchain: true, mode: 'hosted', limits: { buildsPerHour: 10 } } }),
  );
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { token: 'test-session', mode: 'hosted' } }),
  );
});

test('hosted editor explains cloud builds and can cancel queued work', async ({ page }) => {
  let cancelled = false;
  await page.routeWebSocket('**/api/build', (socket) => {
    socket.onMessage(() =>
      socket.send(JSON.stringify({ type: 'status', state: 'queued', position: 2 })),
    );
    socket.onClose(() => {
      cancelled = true;
      socket.close();
    });
  });
  await page.goto('/');
  await expect(page.getByText('CLOUD WORKSPACE', { exact: true })).toBeVisible();
  await expect(page.locator('.top-links')).toContainText('Build server ready');
  await expect(page.getByText('Cloud builds · direct browser USB', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '▷ Build', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Queued · position 2');
  await page.getByRole('button', { name: 'Cancel build', exact: true }).click();
  await expect.poll(() => cancelled).toBe(true);
  await expect(page.getByRole('button', { name: '▷ Build', exact: true })).toBeEnabled();
  await expect(page.locator('.notice[role="alert"]')).toHaveCount(0);
});

test('queue progress and retry guidance are shown without losing source', async ({ page }) => {
  let connection: WebSocketRoute | undefined;
  await page.routeWebSocket('**/api/build', (socket) => {
    connection = socket;
    socket.onMessage(() =>
      socket.send(JSON.stringify({ type: 'status', state: 'queued', position: 1 })),
    );
  });
  await page.goto('/');
  await page.getByRole('button', { name: '▷ Build', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Queued · position 1');
  connection!.send(JSON.stringify({ type: 'status', state: 'building' }));
  await expect(page.getByRole('status')).toContainText('Building firmware');
  connection!.send(
    JSON.stringify({ type: 'error', message: 'Usage limit reached.', retryAfter: 60 }),
  );
  connection!.close();
  await expect(page.locator('.notice[role="alert"]')).toContainText('Retry in 60 seconds.');
  await expect(page.locator('.view-lines')).toContainText('pinMode');
  await expect(page.getByRole('button', { name: '▷ Build', exact: true })).toBeEnabled();
});

test('a completed hosted build exposes firmware downloads', async ({ page }) => {
  const firmware = {
    board: 'esp32',
    serialRoute: 'uart',
    fqbn: 'test-profile',
    cpp: '// Test fixture',
    diagnostics: [],
    artifacts: [{ name: 'firmware.bin', address: 65536, data: 'dGVzdA==', size: 4, sha256: '' }],
  };
  await page.routeWebSocket('**/api/build', (socket) => {
    socket.onMessage(() => {
      socket.send(JSON.stringify({ type: 'result', firmware }));
      socket.close();
    });
  });
  await page.goto('/');
  await expect(page.locator('.top-links')).toContainText('Build server ready');
  await page.getByRole('button', { name: '▷ Build', exact: true }).click();
  await expect(page.getByLabel('Firmware downloads')).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '↓ Manifest', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('firmware.json');
});
