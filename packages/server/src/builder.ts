import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  boards,
  compile,
  type BoardId,
  type Firmware,
  type Artifact,
  type Diagnostic,
} from '@esplang/compiler';
export class BuildError extends Error {
  constructor(
    message: string,
    public diagnostics: Diagnostic[] = [],
  ) {
    super(message);
  }
}
interface ProcessOptions {
  signal?: AbortSignal;
  log: (chunk: string) => void;
  timeout?: number;
}
export async function runCli(args: string[], options: ProcessOptions): Promise<string> {
  if (options.signal?.aborted) throw new BuildError('Build cancelled');
  return new Promise((resolve, reject) => {
    const localCli = fileURLToPath(
      new URL(
        `../../../.tools/arduino-cli${process.platform === 'win32' ? '.exe' : ''}`,
        import.meta.url,
      ),
    );
    const localConfig = fileURLToPath(new URL('../../../.tools/arduino-cli.yaml', import.meta.url));
    const command = process.env.ARDUINO_CLI ?? (existsSync(localCli) ? localCli : 'arduino-cli');
    const config =
      process.env.ARDUINO_CONFIG ??
      (existsSync(localConfig) && !process.env.ARDUINO_CLI ? localConfig : undefined);
    const child = spawn(command, config ? ['--config-file', config, ...args] : args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let output = '';
    let stopReason: BuildError | undefined;
    const terminate = (reason: BuildError): void => {
      if (stopReason) return;
      stopReason = reason;
      if (!child.pid) {
        child.kill();
        return;
      }
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          shell: false,
        });
        killer.once('error', () => child.kill());
        killer.once('close', (code) => {
          if (code !== 0) child.kill();
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill();
        }
      }
    };
    const timer = setTimeout(
      () => terminate(new BuildError('Arduino CLI timed out')),
      options.timeout ?? 240000,
    );
    const abort = (): void => terminate(new BuildError('Build cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    const consume = (data: Buffer): void => {
      const text = data.toString('utf8');
      if (output.length + text.length > 4_000_000) {
        terminate(new BuildError('Compiler exceeded the 4 MB log limit'));
        return;
      }
      output += text;
      options.log(text);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', (e) => {
      cleanup();
      reject(
        new BuildError(
          `Cannot run Arduino CLI: ${e.message}. Install Arduino CLI and esp32:esp32@3.3.2; see README.`,
        ),
      );
    });
    child.once('close', (code) => {
      cleanup();
      if (stopReason) reject(stopReason);
      else if (code === 0) resolve(output);
      else
        reject(
          new BuildError(
            `Arduino CLI exited with code ${code ?? 'terminated'}${output.trim() ? `\n${output.slice(-3000)}` : ''}`,
          ),
        );
    });
  });
}
export function parseProperties(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([\w.\-]+)=(.*)$/.exec(line);
    if (match) values[match[1]!] = match[2]!.trim();
  }
  return values;
}
export function validateImages(artifacts: Artifact[]): void {
  const sorted = [...artifacts].sort((a, b) => a.address - b.address);
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]!;
    if (
      current.address % 4096 !== 0 ||
      current.size < 1 ||
      current.address + current.size > 4 * 1024 * 1024
    )
      throw new BuildError('Invalid firmware image bounds');
    const next = sorted[i + 1];
    if (next && current.address + Math.ceil(current.size / 4096) * 4096 > next.address)
      throw new BuildError('Firmware images overlap flash sectors');
  }
}
export async function buildFirmware(
  source: string,
  boardId: BoardId,
  log: (chunk: string) => void,
  signal?: AbortSignal,
  serialRoute: 'uart' | 'usb' = 'uart',
): Promise<Firmware> {
  const result = compile(source, boardId);
  if (!result.cpp) throw new BuildError('EspLang compilation failed', result.diagnostics);
  const board = boards[boardId];
  if (serialRoute === 'usb' && boardId === 'esp32')
    throw new BuildError('The original ESP32 has no native USB serial output; select UART');
  const fqbn = board.fqbn + (serialRoute === 'usb' ? ':CDCOnBoot=cdc' : '');
  const temporaryBase = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(temporaryBase, 'esplang-'));
  try {
    const sketch = path.join(root, 'esplang'),
      output = path.join(root, 'output');
    await mkdir(sketch);
    await mkdir(output);
    await writeFile(path.join(sketch, 'esplang.ino'), '// EspLang entry points are in main.cpp\n');
    await writeFile(path.join(sketch, 'main.cpp'), result.cpp);
    const base = [
      'compile',
      '--fqbn',
      fqbn,
      '--build-path',
      output,
      '--build-property',
      'build.partitions=default',
      '--build-property',
      'build.flash_size=4MB',
    ];
    log(`Checking ${board.label} build properties…\n`);
    const properties = parseProperties(
      await runCli([...base, '--show-properties=expanded', sketch], {
        log: () => {},
        signal,
        timeout: 30000,
      }),
    );
    const coreVersion = properties['version'];
    if (coreVersion && !coreVersion.startsWith('3.'))
      throw new BuildError('Arduino-ESP32 3.x is required');
    const bootAddress = Number(properties['build.bootloader_addr']);
    if (!Number.isFinite(bootAddress) || bootAddress !== board.bootOffset)
      throw new BuildError('Toolchain bootloader address differs from the selected board profile');
    log('Compiling generated C++ with Arduino CLI…\n');
    await runCli([...base, '--warnings', 'default', sketch], {
      log,
      signal,
    });
    signal?.throwIfAborted();
    const platform = properties['runtime.platform.path'];
    if (!platform) throw new BuildError('Arduino CLI did not return the platform location');
    const files = [
      {
        name: 'bootloader.bin',
        file: path.join(output, 'esplang.ino.bootloader.bin'),
        address: bootAddress,
      },
      {
        name: 'partitions.bin',
        file: path.join(output, 'esplang.ino.partitions.bin'),
        address: 0x8000,
      },
      {
        name: 'boot_app0.bin',
        file: path.join(platform, 'tools', 'partitions', 'boot_app0.bin'),
        address: 0xe000,
      },
      { name: 'firmware.bin', file: path.join(output, 'esplang.ino.bin'), address: 0x10000 },
    ];
    const artifacts: Artifact[] = [];
    for (const f of files) {
      const info = await stat(f.file);
      if (info.size > 4 * 1024 * 1024) throw new BuildError('Firmware artifact exceeds 4 MB');
      const data = await readFile(f.file);
      artifacts.push({
        name: f.name,
        address: f.address,
        data: data.toString('base64'),
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
    }
    validateImages(artifacts);
    const partitions = Buffer.from(artifacts[1]!.data, 'base64');
    let appSize = 0;
    for (let i = 0; i + 32 <= partitions.length; i += 32) {
      if (partitions.readUInt16LE(i) !== 0x50aa) break;
      if (partitions[i + 2] === 0 && partitions.readUInt32LE(i + 4) === 0x10000)
        appSize = partitions.readUInt32LE(i + 8);
    }
    if (!appSize || artifacts[3]!.size > appSize)
      throw new BuildError('Application does not fit the expected partition table');
    log('Build complete. Images packed and checked.\n');
    return {
      board: boardId,
      fqbn,
      serialRoute,
      artifacts,
      cpp: result.cpp,
      diagnostics: result.diagnostics,
    };
  } finally {
    if (
      path.dirname(path.resolve(root)) !== temporaryBase ||
      !path.basename(root).startsWith('esplang-')
    ) {
      throw new BuildError('Refusing cleanup outside the temporary build directory');
    }
    await rm(root, { recursive: true, force: true });
  }
}
