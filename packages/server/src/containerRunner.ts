import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { BuildInput } from './hosting.js';

const exec = promisify(execFile);
export interface SandboxOptions {
  image: string;
  pool: string;
  memoryMb: number;
  cpus: number;
  tmpfsMb: number;
  timeoutMs: number;
}
export function containerArguments(name: string, options: SandboxOptions): string[] {
  return [
    'create',
    '--interactive',
    '--name',
    name,
    '--label',
    `esplang.pool=${options.pool}`,
    '--network',
    'none',
    '--env',
    `ESPLANG_WORKER_TIMEOUT_MS=${options.timeoutMs}`,
    '--read-only',
    '--user',
    '1000:1000',
    '--init',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--memory',
    `${options.memoryMb}m`,
    '--memory-swap',
    `${options.memoryMb}m`,
    '--cpus',
    String(options.cpus),
    '--pids-limit',
    '128',
    '--ulimit',
    'nofile=1024:1024',
    '--tmpfs',
    `/tmp:rw,exec,nosuid,nodev,size=${options.tmpfsMb}m,mode=1777`,
    '--log-driver',
    'none',
    '--stop-timeout',
    '1',
    options.image,
  ];
}
async function remove(name: string): Promise<void> {
  await exec('docker', ['rm', '--force', name], { timeout: 15000, maxBuffer: 65536 });
}
export async function recoverContainers(pool: string): Promise<void> {
  const { stdout } = await exec('docker', ['ps', '-aq', '--filter', `label=esplang.pool=${pool}`], {
    timeout: 10000,
  });
  for (const id of stdout.trim().split(/\s+/).filter(Boolean)) {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Unexpected Docker container ID');
    await remove(id);
  }
}
export async function sandboxReady(image: string): Promise<void> {
  const { stdout } = await exec('docker', ['info', '--format', '{{.OSType}}'], { timeout: 10000 });
  if (stdout.trim() !== 'linux') throw new Error('Linux Docker containers are required');
  await exec('docker', ['image', 'inspect', image], { timeout: 10000, maxBuffer: 2_000_000 });
}

export async function runContainer(
  input: BuildInput,
  options: SandboxOptions,
  signal: AbortSignal,
  emit: (line: string) => void,
): Promise<void> {
  const name = `esplang-job-${randomUUID()}`;
  try {
    // Finish creation before observing cancellation: every created container is
    // subsequently removed, even if a client disconnects during docker create.
    await exec('docker', containerArguments(name, options), { timeout: 30000, maxBuffer: 65536 });
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['start', '--attach', '--interactive', name], {
        shell: false,
        windowsHide: true,
      });
      let buffer = '',
        stderr = '',
        bytes = 0,
        failure: Error | undefined;
      let removing: Promise<void> | undefined;
      const terminate = (error: Error) => {
        failure ??= error;
        removing ??= remove(name).catch(() => {
          child.kill();
        });
      };
      const abort = () =>
        terminate(signal.reason instanceof Error ? signal.reason : new Error('Build cancelled'));
      const timer = setTimeout(
        () => terminate(new Error('Isolated build exceeded its time limit')),
        options.timeoutMs,
      );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        bytes += Buffer.byteLength(text);
        if (bytes > 12_000_000) {
          terminate(new Error('Worker output exceeded its size limit'));
          return;
        }
        buffer += text;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line) {
            try {
              JSON.parse(line);
              emit(line);
            } catch {
              terminate(new Error('Isolated worker returned invalid output'));
            }
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', (code) => {
        cleanup();
        void (removing ?? Promise.resolve()).then(() => {
          if (failure) reject(failure);
          else if (code !== 0 || buffer.trim())
            reject(new Error(`Isolated build failed${stderr ? `: ${stderr}` : ''}`));
          else resolve();
        });
      });
    });
  } finally {
    // Idempotent cleanup, including failed creation. Cancellation may already
    // have removed the container.
    try {
      await remove(name);
    } catch {
      const { stdout } = await exec('docker', ['ps', '-aq', '--filter', `name=^/${name}$`], {
        timeout: 10000,
      });
      if (stdout.trim()) throw new Error('Cannot remove isolated build container');
    }
  }
}
