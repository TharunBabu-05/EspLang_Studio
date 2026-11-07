import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compileNative } from '../packages/compiler/src/native/compiler.js';

const args = process.argv.slice(2);
if (args.includes('--help') || !args.length) {
  console.log(
    'Usage: npm run build:native -- <program.esp> [output-directory]\nTarget: original ESP32-WROOM-32. Experimental; hardware validation is pending.',
  );
  process.exit(args.includes('--help') ? 0 : 1);
}
if (args.length > 2 || args.some((arg) => arg.startsWith('--'))) {
  console.error('Expected a source file and an optional output directory; use --help.');
  process.exit(1);
}
try {
  const source = await readFile(args[0]!, 'utf8');
  const result = compileNative(source);
  for (const d of result.diagnostics)
    console.error(
      `${args[0]}:${d.span.start.line}:${d.span.start.column} ${d.severity}: ${d.message}`,
    );
  if (!result.build) process.exit(1);
  const build = result.build;
  const output = path.resolve(
    args[1] ?? path.join('.builds', 'native', path.basename(args[0]!, path.extname(args[0]!))),
  );
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'program.s'), build.assembly);
  await writeFile(path.join(output, 'program.bin'), build.image);
  await writeFile(path.join(output, 'program.code.bin'), build.machineCode);
  await writeFile(
    path.join(output, 'program.map.json'),
    JSON.stringify(
      {
        format: 'esplang-native-v0.1',
        target: build.target,
        experimental: true,
        hardwareVerified: false,
        entryPoint: build.entryPoint,
        flashOffset: build.flashOffset,
        memory: build.memory,
        symbols: build.symbols,
        variables: build.variables,
        instructions: build.instructions,
        imageBytes: build.image.length,
        sha256: createHash('sha256').update(build.image).digest('hex'),
        assumptions: [
          'ESP32-WROOM-32, 40 MHz crystal, 4 MiB flash',
          'Cold boot through ROM, DIO at 40 MHz',
          'Secure boot and flash encryption disabled',
          'Single core, no interrupt handlers, GPIO 2 output only',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Native build: ${build.machineCode.length} code/pool bytes; ${build.image.length} image bytes.\nOutput: ${output}\nExperimental ROM boot image at flash offset 0x1000. Hardware execution is not yet verified.\nThis command builds files only; it does not flash your board.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
