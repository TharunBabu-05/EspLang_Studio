import { chromium } from '@playwright/test';
import sharp from 'sharp';
import gifenc from 'gifenc';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const root = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(root, 'docs', 'assets');
await mkdir(assets, { recursive: true });
const base = process.env.README_DEMO_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : process.platform === 'win32'
      ? { channel: 'chrome' }
      : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const frames = [];
const xml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let dimensions;

async function capture(step, caption, duration = 1200) {
  const shot = await page.screenshot({ fullPage: true, animations: 'disabled' });
  const resized = await sharp(shot).resize({ width: 1280 }).png().toBuffer();
  const size = await sharp(resized).metadata();
  const height = size.height;
  if (!height) throw new Error('Screenshot has no height');
  dimensions ??= { width: 1280, height: height + 78 };
  const strip = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="78"><rect width="1280" height="78" fill="#13251f"/><rect width="5" height="78" fill="#8ce8be"/><text x="25" y="28" fill="#8ce8be" font-family="Segoe UI,Arial,sans-serif" font-size="12" letter-spacing="2">${xml(step)}</text><text x="25" y="55" fill="#e0eee7" font-family="Segoe UI,Arial,sans-serif" font-size="18">${xml(caption)}</text><text x="1250" y="29" text-anchor="end" fill="#719b89" font-family="Consolas,monospace" font-size="12">ESPLANG STUDIO / UI TOUR</text></svg>`,
  );
  const screenshot = await sharp(resized)
    .resize({ width: 1280, height: dimensions.height - 78, fit: 'contain', background: '#0c0f15' })
    .extend({ bottom: 78, background: '#13251f' })
    .composite([{ input: strip, top: dimensions.height - 78, left: 0 }])
    .ensureAlpha()
    .raw()
    .toBuffer();
  frames.push({ rgba: new Uint8Array(screenshot), duration });
}

async function replaceSource(source) {
  await page.locator('.monaco-editor textarea').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await pasteSource(source);
  await pause(420);
  const saved = await page.evaluate(() => localStorage.getItem('esplang-source'));
  if (saved?.trim() !== source.trim())
    throw new Error('Editor paste did not match the requested demo source');
}

async function pasteSource(source) {
  // A paste event preserves indentation and avoids typing-only brace completion.
  // It supplies its own data without reading or overwriting the system clipboard.
  await page.locator('.monaco-editor textarea').evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, source);
}

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.monaco-editor .view-lines').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Blink & read', exact: false }).click();
  await pause(700);
  await page.screenshot({
    path: path.join(assets, 'ide-overview.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await capture(
    '01 / WRITE ESPLANG',
    'A real editor, a small language, and hardware primitives.',
    1800,
  );

  const source =
    'setup {\n  pinMode(4, OUTPUT);\n  serialPrint("Hello from EspLang");\n}\n\nloop {\n  digitalWrite(4, HIGH);\n  delay(250);\n  digitalWrite(4, LOW);\n  delay(250);\n}\n';
  await page.locator('.monaco-editor textarea').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  for (const chunk of source.match(/[\s\S]{1,45}/g) ?? [source]) {
    await pasteSource(chunk);
    await pause(90);
    await capture(
      '01 / WRITE ESPLANG',
      'Types, setup / loop blocks, and familiar hardware operations.',
      150,
    );
  }
  // Replace once to ensure the final program is independent of typing chunk boundaries.
  await replaceSource(source);
  await capture('01 / WRITE ESPLANG', 'Source checks and C++ generation happen as you edit.', 1300);

  await replaceSource('setup {\n  pinMode(34, OUTPUT);\n}\n\nloop {\n  delay(1000);\n}\n');
  await page.getByRole('button', { name: /^Problems/ }).click();
  await page
    .locator('.problems')
    .getByText(/GPIO 34 is input-only/)
    .waitFor();
  await capture(
    '02 / CATCH HARDWARE ERRORS',
    'GPIO 34 is input-only on ESP32. The checker blocks the invalid build.',
    2300,
  );

  await replaceSource(source);
  await page.getByRole('button', { name: 'Build output', exact: true }).click();
  await capture(
    '02 / FIX AND RECHECK',
    'Choose a valid output pin. Diagnostics update automatically.',
    1100,
  );
  await page.locator('.editor-tabs').getByRole('button', { name: 'main.cpp', exact: true }).click();
  await pause(350);
  await capture(
    '03 / INSPECT GENERATED C++',
    'The handwritten compiler emits Arduino-ESP32-compatible C++.',
    1600,
  );
  await page.locator('.monaco-editor textarea').focus();
  await page.keyboard.press('ControlOrMeta+End');
  await pause(250);
  await capture(
    '03 / INSPECT GENERATED C++',
    'See setup(), loop(), and source-line mappings before the native build.',
    1800,
  );

  await page
    .locator('.editor-tabs')
    .getByRole('button', { name: 'E program.esp', exact: true })
    .click();
  await page.getByRole('button', { name: 'PWM fade', exact: false }).click();
  await pause(450);
  await capture(
    '04 / EXPLORE EXAMPLES',
    'PWM, control flow, functions, and networking examples are included.',
    1600,
  );
  await page.getByRole('button', { name: 'Functions', exact: false }).click();
  await page.getByLabel('Board profile', { exact: true }).selectOption('esp32s3');
  await page.getByLabel('Serial output', { exact: true }).selectOption('usb');
  await pause(450);
  await capture(
    '04 / SELECT YOUR TARGET',
    'Five board families, with UART bridge or native USB console routing.',
    1800,
  );
  await page.getByRole('button', { name: 'Serial monitor', exact: false }).click();
  await capture(
    '05 / CONNECT YOUR HARDWARE',
    'Open your own USB port to flash firmware and read serial output.',
    2000,
  );
  await page.getByLabel('Board profile', { exact: true }).selectOption('esp32');
  await page.getByRole('button', { name: 'Blink & read', exact: false }).click();
  await page.getByRole('button', { name: 'Build output', exact: true }).click();
  await pause(400);
  await capture(
    'READY FOR YOUR NEXT BUILD',
    'Write → check → build locally → flash with browser permission.',
    2300,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await pause(250);
  await page.screenshot({
    path: path.join(assets, 'ide-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });

  const gif = GIFEncoder();
  for (const [index, frame] of frames.entries()) {
    const palette = quantize(frame.rgba, 128);
    gif.writeFrame(applyPalette(frame.rgba, palette), dimensions.width, dimensions.height, {
      palette,
      delay: frame.duration,
      repeat: 0,
    });
    if (index % 5 === 0) console.log(`Encoding frame ${index + 1}/${frames.length}`);
  }
  gif.finish();
  const file = gif.bytes();
  await writeFile(path.join(assets, 'studio-demo.gif'), file);
  await writeFile(
    path.join(assets, 'demo-metadata.json'),
    JSON.stringify(
      {
        width: dimensions.width,
        height: dimensions.height,
        frames: frames.length,
        durationMs: frames.reduce((sum, frame) => sum + frame.duration, 0),
        bytes: file.length,
        capture:
          'Isolated browser context; bundled examples only; no physical USB session recorded.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Saved ${frames.length} frames, ${(file.length / 1024 / 1024).toFixed(2)} MB to docs/assets/studio-demo.gif`,
  );
} catch (error) {
  await mkdir(path.join(root, '.verification'), { recursive: true });
  await page.screenshot({
    path: path.join(root, '.verification', 'readme-demo-error.png'),
    fullPage: true,
  });
  console.error(
    'Problems:',
    await page
      .locator('.problems')
      .textContent()
      .catch(() => 'not open'),
  );
  console.error(
    'Editor:',
    (
      await page
        .locator('.view-lines')
        .textContent()
        .catch(() => '')
    ).slice(0, 1200),
  );
  throw error;
} finally {
  await context.close();
  await browser.close();
}
