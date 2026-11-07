import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import gifenc from 'gifenc';

const directory = fileURLToPath(new URL('../docs/assets/', import.meta.url));
await mkdir(directory, { recursive: true });
const previews = fileURLToPath(new URL('../.verification/readme-assets/', import.meta.url));
await mkdir(previews, { recursive: true });
const escape = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const ink = '#edf5fa',
  muted = '#a0b1c5',
  mint = '#89e8be',
  amber = '#f3c888',
  blue = '#91baff';
const text = (x, y, value, size = 18, fill = muted, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escape(value)}</text>`;
const box = (x, y, width, height, fill = '#152131', stroke = '#304255', radius = 14) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
const arrow = (x1, y1, x2, y2, color = mint) =>
  `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${color}" stroke-width="2" fill="none"/><path d="M${x2 - 5} ${y2 - 8}L${x2} ${y2}L${x2 + 5} ${y2 - 8}" stroke="${color}" stroke-width="2" fill="none"/>`;
const svg = (
  width,
  height,
  title,
  description,
  body,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
<title id="title">${escape(title)}</title><desc id="description">${escape(description)}</desc>
<defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#31485c" stroke-opacity=".22"/></pattern><radialGradient id="glow"><stop stop-color="#22664e" stop-opacity=".55"/><stop offset="1" stop-color="#101923" stop-opacity="0"/></radialGradient></defs>
<rect width="${width}" height="${height}" rx="20" fill="#0c1420"/><rect width="${width}" height="${height}" rx="20" fill="url(#grid)"/>
<g font-family="Segoe UI,Arial,sans-serif">${body}</g></svg>\n`;

const hero = svg(
  1280,
  480,
  'EspLang Native: our compiler, assembler and firmware builder',
  'EspLang source compiles to ESP32 firmware through our own Xtensa compiler, assembler, linker and ROM image builder. No C++ conversion is used in the native build. Targets original ESP32-WROOM-32.',
  `
  <ellipse cx="1030" cy="245" rx="330" ry="250" fill="url(#glow)"/>
  ${text(48, 49, 'ESPLANG / SOURCE TO SILICON', 13, mint, 'letter-spacing="3"')}
  ${text(48, 132, 'EspLang Studio', 70, ink, 'font-weight="700" letter-spacing="-2"')}
  ${text(50, 184, 'Our language. Our native toolchain.', 29, mint)}
  ${text(50, 224, 'Compile .esp directly into ESP32 .bin firmware.', 20)}
  ${box(50, 255, 705, 57, '#122b25', '#35664e')}
  ${text(70, 279, 'NATIVE COMPILATION / NO C++ CONVERSION', 11, mint, 'letter-spacing="1.4"')}
  ${text(70, 300, '.esp → our compiler → Xtensa assembly', 19, ink, 'font-family="Consolas,monospace"')}
  ${box(50, 325, 705, 57, '#122b25', '#35664e')}
  ${text(70, 349, 'OUR ASSEMBLER + LINKER + FIRMWARE BUILDER', 11, mint, 'letter-spacing="1.4"')}
  ${text(70, 370, 'Assembly → machine code → ROM image → .bin', 19, ink, 'font-family="Consolas,monospace"')}
  ${Array.from({ length: 8 }, (_, i) => `<path d="M873 ${136 + i * 24}h-20 M1133 ${136 + i * 24}h20" stroke="#7caba3" stroke-width="6"/>`).join('')}
  ${box(873, 112, 260, 238, '#203d3b', '#6daba0', 18)}
  ${box(892, 131, 222, 200, '#c4d8d6', '#dfebe5', 8)}
  ${text(915, 191, 'ESP32', 44, '#173c3b', 'font-weight="700"')}
  ${text(917, 227, 'XTENSA LX6', 18, '#28524d', 'letter-spacing="2"')}
  ${text(917, 272, 'OUR CODE', 17, '#173c3b', 'font-weight="700"')}
  ${text(917, 297, 'REAL HARDWARE', 17, '#173c3b', 'font-weight="700"')}
  ${text(1003, 380, 'Native v0.1 · experimental', 17, mint, 'text-anchor="middle"')}
  <path d="M48 409H1232" stroke="#304255"/>
  ${text(50, 444, 'OWN COMPILER + ASSEMBLER + BUILDER', 13, mint)}
  ${text(565, 444, 'ORIGINAL ESP32 / XTENSA LX6', 13, blue)}
  ${text(1230, 444, 'NATIVE LED BLINK REPORTED', 13, mint, 'text-anchor="end"')}
`,
);
await writeFile(path.join(directory, 'hero.svg'), hero);

const stage = (x, y, color, heading, title, detail) =>
  `${box(x, y, 564, 100, color === amber ? '#28241d' : '#122821', color === amber ? '#695337' : '#35664e')}
  ${text(x + 22, y + 25, heading, 11, color, 'letter-spacing="1.5"')}
  ${text(x + 22, y + 57, title, 23, ink, 'font-weight="600"')}
  ${text(x + 22, y + 83, detail, 16, muted)}`;
const architecture = svg(
  1280,
  1280,
  'EspLang architecture: shared frontend, two build pipelines',
  'The shared lexer, parser and semantic analyzer feed either our native Xtensa generator, assembler, linker and image packager, or our C++ generator and external Arduino tools. Native uploads have our experimental ROM uploader; browser uploads use esptool-js. Hosted Docker workers currently run Arduino builds.',
  `
  ${text(50, 44, 'ARCHITECTURE / OWNERSHIP AT EVERY STAGE', 13, mint, 'letter-spacing="2"')}
  ${text(50, 98, 'From language design to a blinking LED.', 38, ink, 'font-weight="650"')}
  ${text(50, 134, 'Mint: our compiler stages  ·  Amber: Arduino toolchain  ·  Blue: upload tools', 18)}
  ${box(50, 164, 1180, 144, '#10231f', '#35664e')}
  ${text(74, 193, 'SHARED FRONTEND / program.esp', 13, mint, 'letter-spacing="1.5"')}
  ${text(74, 235, '01  Lexer', 25, ink)}${text(74, 272, 'Characters → tokens + source locations', 16)}
  ${text(465, 235, '02  Parser + AST', 25, ink)}${text(465, 272, 'Tokens → structured program', 16)}
  ${text(863, 235, '03  Semantic checks', 25, ink)}${text(863, 272, 'Types · scopes · GPIO diagnostics', 16)}
  <path d="M640 308V330H332V344 M640 330H948V344" stroke="${mint}" fill="none" stroke-width="2"/>
  ${text(50, 373, 'NATIVE v0.1', 22, mint, 'font-weight="700"')}
  ${text(50, 400, 'Original ESP32 · CLI/API · supported subset', 17)}
  ${text(666, 373, 'ARDUINO WORKFLOW', 22, amber, 'font-weight="700"')}
  ${text(666, 400, 'ESP32 / S2 / S3 / C3 / C6 · browser IDE', 17)}
  ${stage(50, 424, mint, 'OUR NATIVE CODE + RUNTIME GENERATOR', 'Xtensa assembly → program.s', 'Startup · fixed registers · GPIO · cycle-counter delays')}
  ${stage(666, 424, mint, 'OUR C++ GENERATOR', 'Arduino source → main.cpp', 'Source mappings · runtime guards · hardware wrappers')}
  ${arrow(332, 528, 332, 550)}${arrow(948, 528, 948, 550, amber)}
  ${stage(50, 556, mint, 'OUR ASSEMBLER + SINGLE-SECTION LINKER', 'Assembly → machine instructions', 'Encode bytes · resolve labels · lay out code and literals')}
  ${stage(666, 556, amber, 'EXTERNAL ARDUINO / ESPRESSIF TOOLS', 'Arduino CLI → GCC + SDK libraries', 'C++ compilation · assembly · linking · image tools')}
  ${arrow(332, 660, 332, 682)}${arrow(948, 660, 948, 682, amber)}
  ${stage(50, 688, mint, 'OUR FIRMWARE IMAGE BUILDER', 'program.bin + program.map.json', 'ROM headers · IRAM/DRAM segments · XOR checksum')}
  ${stage(666, 688, amber, 'ARDUINO IMAGES / CHECKED BY OUR SERVER', 'Bootloader + partitions + application', 'Sparse images · bounds checks · SHA-256 manifest')}
  ${arrow(332, 792, 332, 814, blue)}${arrow(948, 792, 948, 814, blue)}
  ${box(50, 820, 564, 100, '#142237', '#375881')}
  ${text(72, 848, 'OUR ROM UPLOADER / EXPERIMENTAL', 11, blue, 'letter-spacing="1.5"')}
  ${text(72, 880, 'Our serial protocol → chip ROM', 23, ink)}
  ${text(72, 906, 'Backup → write → verify; serialport OS transport', 15)}
  ${box(666, 820, 564, 100, '#142237', '#375881')}
  ${text(688, 848, 'EXTERNAL USB LIBRARY / OUR IDE INTEGRATION', 11, blue, 'letter-spacing="1.2"')}
  ${text(688, 880, 'esptool-js + Web Serial → board', 23, ink)}
  ${text(688, 906, 'Chip checks · verified writes · serial monitoring', 16)}
  ${arrow(332, 924, 332, 946)}
  ${box(50, 952, 1180, 112, '#10231f', '#35664e')}
  ${text(74, 985, 'NATIVE HARDWARE MILESTONE', 12, mint, 'letter-spacing="1.5"')}
  ${text(74, 1020, 'ESP32-D0WD-V3: esptool upload + user-reported LED blink', 25, ink)}
  ${text(74, 1048, '1,536-byte image · 464 code/pool bytes · power-cycle persistence and measured timing pending', 16)}
  ${box(50, 1096, 1180, 132, '#152131', '#304255')}
  ${text(74, 1127, 'HOSTED ARDUINO BUILDS / DEPLOYMENT PREPARED', 12, blue, 'letter-spacing="1.5"')}
  ${text(74, 1162, 'HTTPS → signed session → bounded queue → disposable Docker worker', 24, ink)}
  ${text(74, 1190, 'Quotas · cancellation · CPU/RAM/time limits · no worker network · USB stays in the browser', 16)}
  ${text(74, 1213, 'Real Linux deployment test passed. Public production provisioning is still required.', 15, muted)}
  ${text(1230, 1260, 'See README for feature limits and evidence boundaries.', 13, muted, 'text-anchor="end"')}
`,
);
await writeFile(path.join(directory, 'architecture.svg'), architecture);
await sharp(Buffer.from(hero)).png().toFile(path.join(previews, 'hero.png'));
await sharp(Buffer.from(architecture)).png().toFile(path.join(previews, 'architecture.png'));

// Illustrated animation, not a screen recording or hardware capture.
const steps = [
  [
    'SOURCE',
    'Understand the program',
    'Our lexer, parser and semantic analyzer',
    'Read .esp syntax; check types and scopes.',
    'Input: examples/native-blink.esp',
  ],
  [
    'ASM',
    'Generate Xtensa assembly',
    'Our native code and runtime generator',
    'Emit startup, GPIO writes and delay loops.',
    'Output: program.s',
  ],
  [
    'BYTES',
    'Encode and link instructions',
    'Our assembler + single-section linker',
    'Resolve labels, literals and memory addresses.',
    'Output: 464 code / pool bytes',
  ],
  [
    'IMAGE',
    'Package the ROM image',
    'Our firmware image builder',
    'Add headers, segments, padding and checksum.',
    'Output: program.bin / 1,536 bytes',
  ],
  [
    'USB',
    'Upload the firmware',
    'Our experimental ROM uploader',
    'Identify → back up → write-flash at 0x1000.',
    'Hardware acceptance pending; CLI available.',
  ],
  [
    'RUN',
    'The board executes our code',
    'ESP32-D0WD-V3 / GPIO 2',
    'Earlier esptool upload: LED blink reported.',
    'Power-cycle and timing checks remain pending.',
  ],
];
const source = [
  'setup {',
  '  pinMode(2, OUTPUT);',
  '}',
  '',
  'loop {',
  '  digitalWrite(2, HIGH);',
  '  delay(500);',
  '  digitalWrite(2, LOW);',
  '  delay(500);',
  '}',
];
const { GIFEncoder, quantize, applyPalette } = gifenc;
const gif = GIFEncoder();
let frames = 0,
  durationMs = 0;
for (let step = 0; step < steps.length; step++) {
  const count = step === 5 ? 4 : 2;
  for (let phase = 0; phase < count; phase++) {
    const on = step === 5 && phase % 2 === 0;
    const [name, title, owner, detail, output] = steps[step];
    const frame = svg(
      960,
      500,
      'Illustrated native build pipeline',
      'An explanatory animation, not a live IDE or hardware recording.',
      `
      ${text(28, 31, 'ESPLANG NATIVE / ILLUSTRATED PIPELINE', 11, mint, 'letter-spacing="2"')}
      ${text(28, 77, 'Your source. Our machine-code backend.', 33, ink, 'font-weight="650"')}
      ${box(28, 110, 346, 296, '#101e2b', '#304255')}
      ${text(46, 136, 'native-blink.esp', 13, blue, 'font-family="Consolas,monospace"')}
      ${source.map((line, i) => text(46, 165 + i * 22, line, 16, line.includes('digitalWrite') && on ? mint : '#ccd9e6', 'font-family="Consolas,monospace" xml:space="preserve"')).join('')}
      ${box(394, 110, 538, 296, '#122821', '#35664e')}
      ${text(418, 145, `${String(step + 1).padStart(2, '0')} / ${name}`, 14, mint, 'letter-spacing="2"')}
      ${text(418, 194, title, 25, ink, 'font-weight="600"')}
      ${text(418, 232, owner, 17, mint)}
      ${text(418, 266, detail, 16, muted)}
      ${text(418, 307, output, 16, ink)}
      <circle cx="432" cy="361" r="10" fill="${on ? mint : '#29453b'}" stroke="${mint}"/>
      ${text(456, 367, step === 5 ? `GPIO 2 LED / illustration ${on ? 'ON' : 'OFF'}` : 'Native compiler + assembler + builder', 15, muted)}
      ${steps.map(([tag], i) => `${box(28 + i * 153, 426, 139, 34, i === step ? '#224e3a' : '#152131', i === step ? mint : '#304255', 7)}${text(97 + i * 153, 448, tag, 12, i === step ? mint : muted, 'text-anchor="middle" letter-spacing="1.5"')}`).join('')}
      ${text(28, 484, 'Concept animation · CLI backend today · not a hardware recording or native IDE preview', 12, muted)}
    `,
    );
    if (phase === 0)
      await sharp(Buffer.from(frame))
        .png()
        .toFile(path.join(previews, `native-${step}.png`));
    const pixels = await sharp(Buffer.from(frame)).ensureAlpha().raw().toBuffer();
    const rgba = new Uint8Array(pixels);
    const palette = quantize(rgba, 128);
    const index = applyPalette(rgba, palette);
    const delay = step === 5 ? 600 : 650;
    gif.writeFrame(index, 960, 500, { palette, delay, repeat: 0 });
    frames++;
    durationMs += delay;
  }
}
gif.finish();
await writeFile(path.join(directory, 'native-pipeline.gif'), gif.bytes());
await writeFile(
  path.join(directory, 'native-pipeline-metadata.json'),
  JSON.stringify(
    {
      width: 960,
      height: 500,
      frames,
      durationMs,
      kind: 'illustrated pipeline; not a recording',
      generator: 'scripts/generate-readme-assets.mjs',
    },
    null,
    2,
  ) + '\n',
);
console.log('Generated hero.svg, architecture.svg and native-pipeline.gif');
