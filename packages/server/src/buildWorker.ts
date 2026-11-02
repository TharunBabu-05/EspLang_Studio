import { isBoardId, type ServerEvent } from '@esplang/compiler';
import { buildFirmware, BuildError } from './builder.js';
import { integer } from './config.js';

const controller = new AbortController();
const deadline = setTimeout(
  () => {
    controller.abort(new Error('Isolated build exceeded its time limit'));
    setTimeout(() => process.exit(1), 5000).unref();
  },
  integer('ESPLANG_WORKER_TIMEOUT_MS', 240000, 1000, 900000),
);
process.on('SIGTERM', () => controller.abort());
const emit = (event: ServerEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);
try {
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('Build input is too large');
  }
  const input = JSON.parse(raw) as { source: string; board: string; serialRoute: 'uart' | 'usb' };
  if (
    typeof input.source !== 'string' ||
    input.source.length > 100000 ||
    !isBoardId(input.board) ||
    !['uart', 'usb'].includes(input.serialRoute)
  )
    throw new Error('Invalid isolated build input');
  const firmware = await buildFirmware(
    input.source,
    input.board,
    (message) => emit({ type: 'log', message }),
    controller.signal,
    input.serialRoute,
    1,
  );
  emit({ type: 'result', firmware });
} catch (error) {
  emit({
    type: 'error',
    message: error instanceof Error ? error.message : 'Build failed',
    diagnostics: error instanceof BuildError ? error.diagnostics : undefined,
  });
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
