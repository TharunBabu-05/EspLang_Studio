import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { RomProtocol } from './protocol.js';
import { Esp32Rom } from './esp32.js';
import { NativeSerialTransport } from './serial.js';
import {
  createBackup,
  loadRecovery,
  restoreWithBackup,
  writeNativeWithBackup,
  type Progress,
} from './recovery.js';
import { validateNativeImage } from './image.js';

export const HELP = `EspLang ROM uploader v0.1 (experimental, original ESP32 only)
No esptool, esptool-js, Python, Arduino CLI, or uploaded flasher stub is used.
Host dependencies: Node.js + serialport for OS serial bytes and DTR/RTS.

npm run native:usb -- ports
npm run native:usb -- flash-id --port COM13
npm run native:usb -- read-flash --port COM13 [--offset 0 --length 0x400000]
npm run native:usb -- write-flash --port COM13 --image .builds/native/native-blink/program.bin --confirm-write
npm run native:usb -- restore-flash --port COM13 --backup .builds/backups/esp32-.../recovery.json --confirm-write

Options: --backup-dir PATH (default .builds/backups); --manual-boot; --help.
ROM reads use 64-byte packets at 115200 baud; a full 4 MiB backup is slow.
Native writes first save and verify every affected sector. No erase occurs if backup fails.
Only completed recovery.json manifests can be restored, to the same board.
Commands reset the device into ROM. Close all serial monitors first.
--manual-boot opens the port, then prompts for BOOT/EN in an interactive terminal.
Successful commands request a firmware reset; failures do not intentionally reset.
On failure, re-enter ROM before recovery (port-close line behavior is driver-dependent).
Hardware: identification verified with manual BOOT on ESP32; reads/writes/restores pending.
`;
export interface CliOptions {
  command: 'ports' | 'flash-id' | 'read-flash' | 'write-flash' | 'restore-flash';
  port?: string;
  image?: string;
  backup?: string;
  backupDir: string;
  offset: number;
  length: number;
  confirmWrite: boolean;
  manualBoot: boolean;
}
export function parseOptions(args: string[]): CliOptions {
  const [command, ...rest] = args;
  if (!['ports', 'flash-id', 'read-flash', 'write-flash', 'restore-flash'].includes(command ?? ''))
    throw new Error('Unknown command; use --help');
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (
      ![
        '--port',
        '--image',
        '--backup',
        '--backup-dir',
        '--offset',
        '--length',
        '--confirm-write',
        '--manual-boot',
      ].includes(key) ||
      Object.hasOwn(options, key)
    )
      throw new Error(`Unknown or repeated option: ${key}`);
    if (key === '--confirm-write' || key === '--manual-boot') options[key] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key] = value;
    }
  }
  const allowed =
    command === 'ports'
      ? []
      : [
          '--port',
          '--manual-boot',
          ...(command === 'flash-id' ? [] : ['--backup-dir']),
          ...(command === 'read-flash' ? ['--offset', '--length'] : []),
          ...(command === 'write-flash' ? ['--image', '--confirm-write'] : []),
          ...(command === 'restore-flash' ? ['--backup', '--confirm-write'] : []),
        ];
  for (const key of Object.keys(options))
    if (!allowed.includes(key)) throw new Error(`${key} does not apply to ${command}`);
  if (command !== 'ports' && !options['--port'])
    throw new Error('Select an explicit --port; no automatic device selection');
  if (command === 'write-flash' && !options['--image']) throw new Error('Select --image');
  if (command === 'restore-flash' && !options['--backup'])
    throw new Error('Select --backup recovery.json');
  if (['write-flash', 'restore-flash'].includes(command!) && !options['--confirm-write'])
    throw new Error('Writing flash requires --confirm-write');
  const integer = (key: string, fallback: number): number => {
    const s = options[key];
    if (s === undefined) return fallback;
    if (typeof s !== 'string' || !/^(0x[\da-f]+|\d+)$/i.test(s) || !Number.isSafeInteger(Number(s)))
      throw new Error(`Invalid ${key}`);
    return Number(s);
  };
  const offset = integer('--offset', 0),
    length = integer('--length', 4194304);
  if (offset % 4096 || length % 4096 || length <= 0 || offset + length > 4194304)
    throw new Error('Backup range must contain whole sectors within 4 MiB');
  return {
    command: command as CliOptions['command'],
    port: options['--port'] as string | undefined,
    image: options['--image'] as string | undefined,
    backup: options['--backup'] as string | undefined,
    backupDir: (options['--backup-dir'] as string | undefined) ?? '.builds/backups',
    offset,
    length,
    confirmWrite: options['--confirm-write'] === true,
    manualBoot: options['--manual-boot'] === true,
  };
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!args.length || (args.length === 1 && args[0] === '--help')) {
    console.log(HELP);
    return;
  }
  const options = parseOptions(args);
  if (options.manualBoot && !process.stdin.isTTY)
    throw new Error('--manual-boot requires an interactive terminal for the BOOT/EN prompt');
  if (options.command === 'ports') {
    console.log(JSON.stringify(await NativeSerialTransport.list(), null, 2));
    return;
  }
  let image: Buffer | undefined;
  if (options.image) {
    if ((await stat(options.image)).size > 34816) throw new Error('Native image is too large');
    image = await readFile(options.image);
    validateNativeImage(image);
  }
  if (options.backup) await loadRecovery(options.backup);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let transport: NativeSerialTransport | undefined, protocol: RomProtocol | undefined;
  let completed = false;
  try {
    console.log(`Opening ${options.port} at 115200 baud. EspLang ROM uploader; no stub.`);
    transport = await NativeSerialTransport.open(options.port!);
    if (!options.manualBoot) await transport.enterRom(controller.signal);
    else {
      // Opening the port can reset a board. Ask for the button sequence AFTER open.
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await terminal.question(
          'Port is open. Hold BOOT, tap EN/RESET, release BOOT, then press Enter: ',
          { signal: controller.signal },
        );
      } finally {
        terminal.close();
      }
    }
    protocol = new RomProtocol(transport, controller.signal);
    await protocol.sync();
    const device = new Esp32Rom(protocol);
    let last = '';
    const progress: Progress = (stage, done, total) => {
      const message = `${stage}: ${Math.floor((done / total) * 100)}% (${done}/${total} bytes)`;
      const bucket = `${stage}:${Math.floor((done / total) * 100)}`;
      if (bucket !== last) {
        console.log(message);
        last = bucket;
      }
    };
    const saved = (manifest: string) =>
      console.log(`Verified recovery manifest saved BEFORE erase: ${manifest}`);
    if (options.command === 'flash-id') {
      const { deviceId: _deviceId, ...publicIdentity } = await device.identify();
      console.log(JSON.stringify(publicIdentity, null, 2));
    } else if (options.command === 'read-flash') {
      console.log('Reading with the ROM; full backups can take many minutes. Do not press RESET.');
      const backup = await createBackup(
        device,
        options.backupDir,
        options.offset,
        options.length,
        'manual-backup',
        progress,
      );
      console.log(`Backup verified against ROM MD5 and disk SHA-256: ${backup.manifestPath}`);
    } else if (options.command === 'write-flash') {
      await writeNativeWithBackup(device, image!, options.backupDir, progress, saved);
      console.log('Native firmware written at 0x1000; ROM MD5 matches the image.');
    } else {
      await restoreWithBackup(device, options.backup!, options.backupDir, progress, saved);
      console.log('Recovery region restored; ROM MD5 matches the backup.');
    }
    completed = true;
    await transport.reset(controller.signal);
    console.log(
      'Reset complete. Observe the board; transfer success does not prove application behavior.',
    );
  } finally {
    protocol?.dispose();
    await transport?.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (!completed && transport)
      console.error(
        'Operation incomplete. No automatic reset into firmware; do not use partial backup files.',
      );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
