import { readFile, writeFile } from 'node:fs/promises';
import { compile, isBoardId } from '../packages/compiler/src/index.js';
const [input, output = 'main.cpp', board = 'esp32'] = process.argv.slice(2);
if (!input || !isBoardId(board)) {
  console.error(
    'Usage: npx tsx scripts/compile.ts input.esp [main.cpp] [esp32|esp32s2|esp32s3|esp32c3|esp32c6]',
  );
  process.exit(1);
}
const result = compile(await readFile(input, 'utf8'), board);
for (const d of result.diagnostics)
  console.error(
    `${input}:${d.span.start.line}:${d.span.start.column}: ${d.severity}: ${d.message}`,
  );
if (!result.cpp) process.exit(1);
await writeFile(output, result.cpp);
console.log(`Generated ${output}`);
