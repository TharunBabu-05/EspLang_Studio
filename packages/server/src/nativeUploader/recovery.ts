import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Esp32Identity, FlashDevice } from './esp32.js';
import { validateNativeImage } from './image.js';

export interface RecoveryManifest {
  format: 'esplang-recovery-v1';
  status: 'complete';
  target: Esp32Identity;
  offset: number;
  length: number;
  sha256: string;
  file: 'flash.bin';
  createdAt: string;
  reason: 'manual-backup' | 'before-native-write' | 'before-restore';
}
export type Progress = (stage: string, done: number, total: number) => void;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function persist(
  file: string,
  bytes: Uint8Array | string,
  flag: 'wx' | 'w' = 'wx',
): Promise<void> {
  const handle = await open(file, flag, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function range(offset: number, length: number): void {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length <= 0 ||
    offset % 4096 ||
    length % 4096 ||
    offset + length > 4194304
  )
    throw new Error('Recovery range must be whole sectors within the 4 MiB device');
}
export async function createBackup(
  device: FlashDevice,
  directory: string,
  offset = 0,
  length = 4194304,
  reason: RecoveryManifest['reason'] = 'manual-backup',
  progress?: Progress,
): Promise<{ manifestPath: string; manifest: RecoveryManifest }> {
  range(offset, length);
  const identity = await device.identify();
  await mkdir(directory, { recursive: true });
  const folder = await mkdtemp(path.join(path.resolve(directory), 'esp32-'));
  const partial = path.join(folder, 'flash.bin.partial');
  await persist(partial, new Uint8Array());
  // readFlash verifies the returned bytes against the chip's ROM-computed MD5.
  const bytes = await device.readFlash(offset, length, (done, total) =>
    progress?.('backup', done, total),
  );
  if (bytes.length !== length)
    throw new Error('Backup is incomplete; no recovery manifest was written');
  await persist(partial, bytes, 'w');
  const sha256 = hash(bytes);
  if (hash(await readFile(partial)) !== sha256)
    throw new Error('Saved backup failed disk verification');
  await rename(partial, path.join(folder, 'flash.bin'));
  const manifest: RecoveryManifest = {
    format: 'esplang-recovery-v1',
    status: 'complete',
    target: identity,
    offset,
    length,
    sha256,
    file: 'flash.bin',
    createdAt: new Date().toISOString(),
    reason,
  };
  const manifestPath = path.join(folder, 'recovery.json');
  await persist(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifestPath, manifest };
}
export async function loadRecovery(
  manifestPath: string,
): Promise<{ manifest: RecoveryManifest; bytes: Buffer }> {
  if ((await stat(manifestPath)).size > 16384) throw new Error('Recovery manifest is too large');
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<RecoveryManifest>;
  if (
    raw.format !== 'esplang-recovery-v1' ||
    raw.status !== 'complete' ||
    raw.file !== 'flash.bin' ||
    raw.target?.chip !== 'esp32' ||
    raw.target.flashBytes !== 4194304 ||
    !/^[a-f0-9]{64}$/.test(raw.target.deviceId) ||
    typeof raw.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.sha256)
  )
    throw new Error('Expected a completed EspLang recovery manifest');
  range(raw.offset!, raw.length!);
  const bin = path.join(path.dirname(path.resolve(manifestPath)), 'flash.bin');
  if ((await stat(bin)).size !== raw.length)
    throw new Error('Backup file size does not match its manifest');
  const bytes = await readFile(bin);
  if (hash(bytes) !== raw.sha256) throw new Error('Backup SHA-256 mismatch; refusing restoration');
  return { manifest: raw as RecoveryManifest, bytes };
}
export async function writeNativeWithBackup(
  device: FlashDevice,
  input: Uint8Array,
  directory: string,
  progress?: Progress,
  backupReady?: (manifestPath: string) => void,
): Promise<string> {
  const image = validateNativeImage(input); // Validate before touching a device.
  const backup = await createBackup(
    device,
    directory,
    image.offset,
    image.eraseSize,
    'before-native-write',
    progress,
  );
  backupReady?.(backup.manifestPath); // Make recovery path visible BEFORE the first erase.
  try {
    await device.writeFlash(image.offset, image.image, (done, total) =>
      progress?.('write', done, total),
    );
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\nVerified recovery manifest: ${backup.manifestPath}`,
    );
  }
  return backup.manifestPath;
}
export async function restoreWithBackup(
  device: FlashDevice,
  manifestPath: string,
  directory: string,
  progress?: Progress,
  backupReady?: (manifestPath: string) => void,
): Promise<string> {
  const recovery = await loadRecovery(manifestPath);
  const identity = await device.identify();
  if (
    identity.deviceId !== recovery.manifest.target.deviceId ||
    identity.flashId !== recovery.manifest.target.flashId
  )
    throw new Error('Recovery backup belongs to a different board or flash chip');
  const before = await createBackup(
    device,
    directory,
    recovery.manifest.offset,
    recovery.manifest.length,
    'before-restore',
    progress,
  );
  backupReady?.(before.manifestPath);
  try {
    await device.writeFlash(recovery.manifest.offset, recovery.bytes, (done, total) =>
      progress?.('restore', done, total),
    );
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\nPre-restore recovery manifest: ${before.manifestPath}`,
    );
  }
  return before.manifestPath;
}
