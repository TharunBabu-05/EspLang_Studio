import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'docs', 'assets');
await mkdir(directory, { recursive: true });
const escape = (text) =>
  String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const label = (x, y, text, size = 18, color = '#a1aec3', extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${escape(text)}</text>`;
const panel = (x, y, w, h, fill = '#141d2a', stroke = '#2a3a4d', radius = 16) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
const arrow = (x1, y1, x2, y2, color = '#8ce8be') =>
  `<path d="M${x1} ${y1} L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2" marker-end="url(#arrow)"/>`;
const shell = (
  height,
  title,
  description,
  body,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${height}" viewBox="0 0 1280 ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escape(title)}</title><desc id="description">${escape(description)}</desc>
  <defs>
    <radialGradient id="glow"><stop stop-color="#20483f" stop-opacity=".65"/><stop offset="1" stop-color="#101722" stop-opacity="0"/></radialGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#253448" stroke-opacity=".3"/></pattern>
    <linearGradient id="metal" x2="1" y2="1"><stop stop-color="#c5d4d9"/><stop offset="1" stop-color="#647f8c"/></linearGradient>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="none" stroke="#8ce8be" stroke-width="1.5"/></marker>
  </defs>
  <rect width="1280" height="${height}" rx="24" fill="#0e1520"/><rect width="1280" height="${height}" rx="24" fill="url(#grid)"/>
  <g font-family="Segoe UI,Arial,sans-serif">${body}</g>
</svg>\n`;

let pins = '';
for (let i = 0; i < 9; i++) {
  const position = 822 + i * 23;
  pins += `<path d="M${position} 118v-22 M${position} 332v22 M798 ${142 + i * 22}h-22 M1026 ${142 + i * 22}h22" stroke="#668e91" stroke-width="7"/>`;
}
const hero = shell(
  460,
  'EspLang Studio — from source to silicon',
  'A custom ESP32 language compiler, local web IDE, and USB flashing workspace. EspLang source is compiled to C++ and built into firmware with Espressif tools.',
  `
  <ellipse cx="960" cy="210" rx="340" ry="240" fill="url(#glow)"/>
  ${panel(48, 42, 50, 50, '#8ce8be', '#8ce8be', 12)}${label(59, 77, 'e_', 34, '#153b2d', 'font-family="Consolas,monospace" font-weight="700"')}
  ${label(116, 63, 'A LANGUAGE FOR THE THINGS YOU BUILD', 13, '#8ce8be', 'letter-spacing="3"')}
  ${label(116, 86, 'CUSTOM COMPILER  /  LOCAL WEB IDE  /  DIRECT USB', 11, '#788ba4', 'letter-spacing="1.9"')}
  ${label(48, 173, 'EspLang Studio', 76, '#eff7fa', 'font-weight="700" letter-spacing="-3"')}
  ${label(52, 221, 'From source to silicon.', 35, '#8ce8be', 'font-weight="500"')}
  ${label(52, 260, 'Write hardware. See the whole pipeline.', 21, '#a1aec3')}
  ${panel(52, 294, 588, 48, '#141f2b', '#31463f', 9)}
  ${label(71, 325, '.esp    →    C++    →    .bin    →    ESP32', 21, '#d1f3e4', 'font-family="Consolas,monospace"')}
  ${pins}${panel(798, 118, 228, 214, '#1d2d36', '#739598', 14)}${panel(817, 137, 190, 176, 'url(#metal)', '#c3d3d5', 7)}
  ${label(842, 182, 'ESP', 46, '#1f3540', 'font-weight="700"')}${label(842, 237, '32', 60, '#1f3540', 'font-weight="700"')}
  ${label(842, 277, 'YOUR CODE. REAL HARDWARE.', 9, '#2a4650', 'letter-spacing="1.2"')}
  ${panel(1038, 167, 196, 72, '#152a27', '#3d6555', 11)}${label(1056, 192, 'ESP32 · S2 · S3', 16, '#d3f1e5')}${label(1056, 216, 'C3 · C6', 16, '#8ce8be')}
  <path d="M52 378H1228" stroke="#2c3a4e"/>
  ${label(52, 414, 'HANDWRITTEN COMPILER', 12, '#8198ae', 'letter-spacing="1.8"')}
  ${label(441, 414, '5 CHIP FAMILIES', 12, '#8198ae', 'letter-spacing="1.8"')}
  ${label(766, 414, 'BROWSER USB + SERIAL', 12, '#8198ae', 'letter-spacing="1.8"')}
  ${label(1130, 414, 'v1.0.0', 13, '#8ce8be', 'font-family="Consolas,monospace"')}
`,
);
await writeFile(path.join(directory, 'hero.svg'), hero);

const stages = [
  ['01', 'LEXER', 'Characters → tokens', 'lexer.ts'],
  ['02', 'PARSER + AST', 'Tokens → program tree', 'parser.ts · ast.ts'],
  ['03', 'SEMANTIC CHECKS', 'Types, scopes, GPIO rules', 'analyzer.ts · boards.ts'],
  ['04', 'C++ GENERATOR', 'Validated AST → main.cpp', 'codegen.ts'],
];
let stageCards = '';
stages.forEach(([number, title, detail, file], i) => {
  const x = 72 + i * 292;
  stageCards += panel(x, 359, 258, 117, '#162932', '#355346', 12);
  stageCards += label(x + 16, 387, number, 13, '#8ce8be', 'font-family="Consolas,monospace"');
  stageCards += label(x + 46, 387, title, 14, '#edf7f0', 'font-weight="700"');
  stageCards += label(x + 16, 419, detail, 16, '#b5c6cf');
  stageCards += label(x + 16, 449, file, 13, '#7a9a9b', 'font-family="Consolas,monospace"');
  if (i < 3) stageCards += arrow(x + 262, 416, x + 284, 416);
});
const architecture = shell(
  1030,
  'EspLang Studio architecture and compiler pipeline',
  'The browser and Node server share our TypeScript compiler. Arduino CLI and the existing Espressif Xtensa or RISC-V toolchain compile generated C++ into sparse images. esptool-js writes the images directly from the browser to the board; serial data returns to the monitor.',
  `
  ${label(50, 48, 'ARCHITECTURE / LOCAL WORKSPACE', 13, '#8ce8be', 'letter-spacing="2.8"')}
  ${label(50, 101, 'One program. Every stage visible.', 40, '#eff7fa', 'font-weight="650" letter-spacing="-1"')}
  ${label(50, 135, 'Custom language stages in mint. Reused native toolchain in amber.', 18, '#8fa3b9')}
  ${panel(50, 168, 1180, 114)}
  ${label(72, 197, 'BROWSER / REACT + MONACO', 13, '#90b7e6', 'letter-spacing="1.5"')}
  ${label(72, 231, 'program.esp', 26, '#f1f7fa', 'font-family="Consolas,monospace"')}
  ${label(72, 259, 'Edit · autocomplete · inline diagnostics', 16)}
  ${label(550, 224, 'Instant analysis runs in the browser.', 20, '#cfdfec')}
  ${label(550, 252, 'Build requests and live logs use WebSockets.', 16)}
  ${arrow(640, 285, 640, 315)}
  ${panel(50, 319, 1180, 183, '#10231f', '#355b4b')}
  ${label(72, 343, 'OUR TYPESCRIPT COMPILER / SHARED BY BROWSER + SERVER', 13, '#8ce8be', 'letter-spacing="1.3"')}
  ${stageCards}
  <path d="M640 505V524H254V542" fill="none" stroke="#8ce8be" stroke-width="2" marker-end="url(#arrow)"/>${label(660, 530, 'Generated C++', 14, '#8ce8be')}
  ${panel(50, 548, 408, 151)}
  ${label(72, 578, 'OUR NODE BUILD SERVER', 13, '#90b7e6', 'letter-spacing="1.3"')}
  ${label(72, 614, 'Express + child_process', 24, '#edf5fa')}
  ${label(72, 644, 'Revalidate source · select board · spawn CLI', 15)}
  ${label(72, 674, 'builder.ts · server.ts', 14, '#809cb8', 'font-family="Consolas,monospace"')}
  ${arrow(463, 624, 509, 624)}
  ${panel(516, 548, 714, 151, '#292317', '#79633b')}
  ${label(539, 578, 'REUSED OPEN-SOURCE NATIVE TOOLCHAIN', 13, '#edc485', 'letter-spacing="1.3"')}
  ${label(539, 614, 'Arduino CLI → GCC → image tools', 25, '#fff0d4')}
  ${label(539, 644, 'Arduino-ESP32 / ESP-IDF libraries · Xtensa or RISC-V', 17, '#c6b99e')}
  ${label(539, 674, 'Compilation, assembly, linking, bootloader + flash images', 15, '#a99b81')}
  ${arrow(640, 703, 640, 738)}
  ${panel(50, 744, 1180, 115)}
  ${label(72, 773, 'CHECKED SPARSE FIRMWARE IMAGES / RETURNED TO THE BROWSER', 13, '#90b7e6', 'letter-spacing="1.2"')}
  ${label(72, 808, 'bootloader.bin    partitions.bin    boot_app0.bin    firmware.bin', 22, '#dcece8', 'font-family="Consolas,monospace"')}
  ${label(72, 838, 'Board-specific offsets · partition-size checks · sector checks · SHA-256 integrity', 16)}
  ${arrow(640, 863, 640, 899)}
  ${panel(50, 905, 1180, 88, '#142922', '#416a55')}
  ${label(72, 940, 'esptool-js + Web Serial → ESP32 board', 27, '#d8f6e6', 'font-weight="600"')}
  ${label(72, 972, 'Browser-to-USB writes · compressed images · MD5 verification · reset · bidirectional serial', 17, '#a5c9b6')}
  ${label(1220, 1020, 'ESP32  /  S2  /  S3  /  C3  /  C6', 12, '#6d8c9c', 'text-anchor="end" letter-spacing="1.5"')}
`,
);
await writeFile(path.join(directory, 'architecture.svg'), architecture);
console.log('Generated docs/assets/hero.svg and architecture.svg');
