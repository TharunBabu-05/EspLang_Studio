import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compileNative } from '../packages/compiler/src/native/compiler.js';
import {
  RomProtocol,
  SlipDecoder,
  slipEncode,
  words,
  xorChecksum,
} from '../packages/server/src/nativeUploader/protocol.js';
import { Esp32Rom, type FlashDevice } from '../packages/server/src/nativeUploader/esp32.js';
import { validateNativeImage } from '../packages/server/src/nativeUploader/image.js';
import {
  createBackup,
  loadRecovery,
  restoreWithBackup,
  writeNativeWithBackup,
} from '../packages/server/src/nativeUploader/recovery.js';
import { parseOptions } from '../packages/server/src/nativeUploader/cli.js';
import { FakeRomTransport } from './helpers/rom-device.js';

const connections: RomProtocol[] = [];
const folders: string[] = [];
const tempRoot = path.resolve(os.tmpdir());
async function folder() {
  const result = await mkdtemp(path.join(tempRoot, 'esplang-uploader-test-'));
  folders.push(result);
  return result;
}
function setup(signal?: AbortSignal) {
  const transport = new FakeRomTransport();
  const protocol = new RomProtocol(transport, signal);
  connections.push(protocol);
  return { transport, protocol, device: new Esp32Rom(protocol) };
}
const nativeImage = () =>
  Buffer.from(
    compileNative(
      'setup { pinMode(2, OUTPUT); } loop { digitalWrite(2, HIGH); delay(1); digitalWrite(2, LOW); }',
    ).build!.image,
  );
afterEach(async () => {
  connections.splice(0).forEach((p) => p.dispose());
  vi.useRealTimers();
  for (const directory of folders.splice(0)) {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== tempRoot ||
      !path.basename(resolved).startsWith('esplang-uploader-test-')
    )
      throw new Error('Refusing unexpected cleanup path');
    await rm(resolved, { recursive: true, force: true });
  }
});

describe('own SLIP framing and ROM protocol', () => {
  it('encodes exact escapes and accepts every possible byte across fragmented frames', () => {
    expect(slipEncode(Uint8Array.of(0, 192, 219, 255)).toString('hex')).toBe('c000dbdcdbddffc0');
    const data = Uint8Array.from({ length: 256 }, (_, i) => i),
      frames: Buffer[] = [];
    const decoder = new SlipDecoder((frame) => frames.push(frame));
    decoder.push(Uint8Array.of(65, 66)); // Boot noise before first delimiter.
    for (const byte of slipEncode(data)) decoder.push(Uint8Array.of(byte));
    expect(frames).toEqual([Buffer.from(data)]);
    expect(words(0x12345678).toString('hex')).toBe('78563412');
    expect(xorChecksum(Uint8Array.of(1, 2, 3, 4))).toBe(0xeb);
  });
  it('rejects broken escapes and oversized packets', () => {
    expect(() => new SlipDecoder(() => {}).push(Uint8Array.of(192, 219, 1))).toThrow(/escape/);
    expect(() => new SlipDecoder(() => {}).push(Uint8Array.of(192, 219, 192))).toThrow(/escape/);
    expect(() => new SlipDecoder(() => {}, 2).push(Uint8Array.of(192, 1, 2, 3))).toThrow(/limit/);
    expect(() => words(-1)).toThrow();
  });
  it('synchronizes and consumes extra SYNC replies before fragmented identity reads', async () => {
    const { transport, protocol, device } = setup();
    transport.fragment = true;
    await protocol.sync();
    expect((await device.identify()).chip).toBe('esp32');
    expect(transport.calls[0]!.payload.toString('hex')).toBe('07071220' + '55'.repeat(32));
  });
  it('repeats only SYNC while the ROM detects baud, then stops on the first reply', async () => {
    vi.useFakeTimers();
    const { transport, protocol } = setup();
    const write = transport.write.bind(transport);
    let sent = 0;
    transport.write = async (bytes) => {
      if (++sent >= 4) await write(bytes);
    };
    const syncing = protocol.sync();
    await vi.advanceTimersByTimeAsync(300);
    await syncing;
    expect(sent).toBe(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toBe(4);
  });
  it('bounds SYNC attempts and cancels all retry timers on timeout or abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { transport, protocol } = setup(controller.signal);
    transport.dropOpcode = 8;
    const syncing = expect(protocol.sync()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5000);
    await syncing;
    expect(transport.calls).toHaveLength(40);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.calls).toHaveLength(40);
    const second = setup(controller.signal);
    second.transport.dropOpcode = 8;
    const cancelled = expect(second.protocol.sync()).rejects.toThrow(/cancelled/);
    await vi.advanceTimersByTimeAsync(200);
    controller.abort();
    await cancelled;
    const count = second.transport.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(second.transport.calls).toHaveLength(count);
  });
  it.each(['length', 'error', 'opcode'] as const)(
    'rejects %s failures and poisons the session',
    async (kind) => {
      const { transport, protocol } = setup();
      if (kind === 'length') transport.badLengthOpcode = 10;
      if (kind === 'error') transport.failOpcode = 10;
      if (kind === 'opcode')
        transport.write = async () => {
          transport.response(9);
        };
      await expect(protocol.command(10, words(0x40001000))).rejects.toThrow();
      const count = transport.calls.length;
      await expect(protocol.command(10, words(0x40001000))).rejects.toThrow();
      expect(transport.calls).toHaveLength(count);
    },
  );
  it('times out without retrying writes or accepting late replies', async () => {
    const { transport, protocol } = setup();
    transport.dropOpcode = 3;
    await expect(protocol.command(3, words(0), 0, 0, 15)).rejects.toThrow(/timed out/);
    transport.response(3);
    await expect(protocol.command(3)).rejects.toThrow(/timed out/);
    expect(transport.calls).toHaveLength(1);
  });
  it('rejects concurrent commands and cancellation, releasing pending waits', async () => {
    const controller = new AbortController();
    const { transport, protocol } = setup(controller.signal);
    transport.dropOpcode = 14;
    const pending = protocol.command(14, words(0, 64), 64);
    await expect(protocol.command(14, words(64, 64), 64)).rejects.toThrow(/Concurrent/);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
  });
  it('fails promptly when the port disconnects', async () => {
    const { transport, protocol } = setup();
    transport.dropOpcode = 14;
    const pending = protocol.command(14, words(0, 64), 64);
    transport.disconnect();
    await expect(pending).rejects.toThrow(/disconnect/);
  });
});

describe('original ESP32 ROM operations', () => {
  it('identifies JEDEC flash and restores all touched SPI transaction registers', async () => {
    const { transport, device } = setup();
    const addresses = [0x3ff4201c, 0x3ff42024, 0x3ff4202c, 0x3ff42080];
    addresses.forEach((address, i) => transport.registers.set(address, i + 100));
    const identity = await device.identify();
    expect(identity).toMatchObject({
      chip: 'esp32',
      flashId: '1660c4',
      flashBytes: 4194304,
      crystalMHz: 40,
      secureBoot: false,
    });
    expect(identity.deviceId).toMatch(/^[a-f0-9]{64}$/);
    addresses.forEach((address, i) => expect(transport.registers.get(address)).toBe(i + 100));
    expect(transport.calls.some((c) => c.opcode === 2)).toBe(false);
  });
  it.each([
    [0x40001000, 1, 'original ESP32'],
    [0x3ff5a000, 0x100000, 'Protected'],
    [0x3ff5a018, 0x10, 'Protected'],
    [0x3ff5a018, 0x20, 'Protected'],
    [0x3ff40014, 226, '40 MHz'],
  ])('rejects incompatible hardware before any flash write', async (address, value, message) => {
    const { transport, device } = setup();
    transport.registers.set(address, value);
    await expect(device.identify()).rejects.toThrow(message);
    expect(transport.calls.some((c) => [2, 3, 13].includes(c.opcode))).toBe(false);
  });
  it('rejects unexpected flash capacity and stuck SPI transactions', async () => {
    const first = setup();
    first.transport.flashId = 0x1760c4;
    await expect(first.device.identify()).rejects.toThrow(/4 MiB/);
    const second = setup();
    second.transport.busySpi = true;
    await expect(second.device.identify()).rejects.toThrow(/timed out/);
  });
  it('reads a short last block and checks the whole read against the ROM digest', async () => {
    const { device, transport } = setup();
    await device.identify();
    transport.flash[4096] = 192;
    transport.flash[4097] = 219;
    expect(await device.readFlash(4096, 100)).toEqual(transport.flash.subarray(4096, 4196));
    expect(
      transport.calls.filter((c) => c.opcode === 14).map((c) => c.payload.readUInt32LE(4)),
    ).toEqual([64, 36]);
    transport.corruptDigest = true;
    await expect(device.readFlash(4096, 64)).rejects.toThrow(/digest mismatch/);
  });
  it('writes exact packets, pads with FF, preserves adjacent sectors and verifies the ROM hash', async () => {
    const { device, transport } = setup();
    await device.identify();
    const image = nativeImage();
    await device.writeFlash(4096, image);
    expect(transport.flash.subarray(4096, 4096 + image.length)).toEqual(image);
    expect(transport.flash[4095]).toBe(0xa5);
    expect(transport.flash[8192]).toBe(0xa5);
    expect(transport.flash[4096 + image.length]).toBe(255);
    expect(
      transport.calls.filter((c) => c.opcode === 3).map((c) => c.payload.readUInt32LE(4)),
    ).toEqual([0, 1]);
    expect(transport.calls.at(-1)?.opcode).toBe(19);
    transport.corruptDigest = true;
    await expect(device.writeFlash(4096, image)).rejects.toThrow(/hash does not match/);
  });
  it('refuses out-of-range and unaligned writes before erasing', async () => {
    const { device, transport } = setup();
    await expect(device.readFlash(0, 64)).rejects.toThrow(/Identify/);
    await device.identify();
    await expect(device.writeFlash(1, nativeImage())).rejects.toThrow(/sector/);
    await expect(device.writeFlash(4194304, nativeImage())).rejects.toThrow(/range/);
    expect(transport.calls.some((c) => c.opcode === 2)).toBe(false);
  });
});

describe('native image and recovery workflow', () => {
  it('validates canonical native images and rejects mutations, raw code and foreign images', () => {
    const image = nativeImage();
    expect(validateNativeImage(image).offset).toBe(4096);
    for (const offset of [0, 1, 2, 3, 4, 12, 23, 28, image.length - 1]) {
      const corrupt = Buffer.from(image);
      corrupt[offset] ^= 1;
      expect(() => validateNativeImage(corrupt)).toThrow();
    }
    expect(() => validateNativeImage(Buffer.from([1, 2, 3]))).toThrow();
    expect(() => validateNativeImage(Buffer.concat([image, Buffer.alloc(16)]))).toThrow();
  });
  it('finishes and verifies recovery on disk before issuing the first erase', async () => {
    const { device, transport } = setup();
    const output = await folder();
    let announced = false;
    const manifestPath = await writeNativeWithBackup(
      device,
      nativeImage(),
      output,
      undefined,
      (saved) => {
        expect(saved).toContain('recovery.json');
        expect(transport.calls.some((c) => c.opcode === 2)).toBe(false);
        announced = true;
      },
    );
    expect(announced).toBe(true);
    const backup = await loadRecovery(manifestPath);
    expect(backup.manifest).toMatchObject({
      offset: 4096,
      length: 4096,
      reason: 'before-native-write',
      status: 'complete',
    });
    expect(backup.bytes).toEqual(Buffer.alloc(4096, 0xa5));
    expect(backup.manifest.sha256).toBe(createHash('sha256').update(backup.bytes).digest('hex'));
  });
  it('never erases when the backup fails; leaves no completed recovery manifest', async () => {
    const { device, transport } = setup();
    transport.corruptDigest = true;
    const output = await folder();
    await expect(writeNativeWithBackup(device, nativeImage(), output)).rejects.toThrow(/digest/);
    expect(transport.calls.some((c) => c.opcode === 2)).toBe(false);
    const entries = await readdir(output);
    expect(entries).toHaveLength(1);
    expect(await readdir(path.join(output, entries[0]!))).toEqual(['flash.bin.partial']);
  });
  it('reports a verified recovery path after failed write', async () => {
    const { device, transport } = setup();
    transport.failOpcode = 3;
    await expect(writeNativeWithBackup(device, nativeImage(), await folder())).rejects.toThrow(
      /Verified recovery manifest:/,
    );
  });
  it('restores exact saved sectors after checking identity and backing up the current content', async () => {
    const { device, transport } = setup();
    const output = await folder();
    const backup = await createBackup(device, output, 4096, 4096);
    transport.flash.fill(0x42, 4096, 8192);
    const before = await restoreWithBackup(device, backup.manifestPath, output);
    expect(transport.flash.subarray(4096, 8192)).toEqual(Buffer.alloc(4096, 0xa5));
    expect((await loadRecovery(before)).bytes).toEqual(Buffer.alloc(4096, 0x42));
    const saved = JSON.parse(await readFile(backup.manifestPath, 'utf8'));
    saved.target.deviceId = '0'.repeat(64);
    await writeFile(backup.manifestPath, JSON.stringify(saved));
    const count = transport.calls.filter((c) => c.opcode === 2).length;
    await expect(restoreWithBackup(device, backup.manifestPath, output)).rejects.toThrow(
      /different board/,
    );
    expect(transport.calls.filter((c) => c.opcode === 2)).toHaveLength(count);
  });
  it('rejects corrupt recovery files and noncanonical paths', async () => {
    const { device } = setup();
    const backup = await createBackup(device, await folder(), 4096, 4096);
    const bin = path.join(path.dirname(backup.manifestPath), 'flash.bin');
    await writeFile(bin, Buffer.alloc(4096));
    await expect(loadRecovery(backup.manifestPath)).rejects.toThrow(/SHA-256/);
    const manifest = JSON.parse(await readFile(backup.manifestPath, 'utf8'));
    manifest.file = '../secret';
    await writeFile(backup.manifestPath, JSON.stringify(manifest));
    await expect(loadRecovery(backup.manifestPath)).rejects.toThrow(/completed/);
  });
  it('rejects invalid native input without contacting a device', async () => {
    let contacted = false;
    const device = {
      identify: async () => {
        contacted = true;
        throw new Error('contacted');
      },
    } as unknown as FlashDevice;
    await expect(writeNativeWithBackup(device, Buffer.alloc(0), await folder())).rejects.toThrow(
      /Expected/,
    );
    expect(contacted).toBe(false);
  });
});

describe('native uploader CLI contract', () => {
  it('parses explicit port, defaults, range and manual boot', () => {
    expect(
      parseOptions([
        'read-flash',
        '--port',
        'COM13',
        '--offset',
        '0x1000',
        '--length',
        '4096',
        '--manual-boot',
      ]),
    ).toMatchObject({ port: 'COM13', offset: 4096, length: 4096, manualBoot: true });
    expect(
      parseOptions(['write-flash', '--port', 'COM13', '--image', 'test.bin', '--confirm-write'])
        .confirmWrite,
    ).toBe(true);
  });
  it.each([
    ['write-flash', '--port', 'COM13', '--image', 'test.bin'],
    ['flash-id'],
    ['ports', '--port', 'COM13'],
    ['read-flash', '--port', 'COM13', '--length', 'NaN'],
    ['read-flash', '--port', 'COM13', '--offset', '1'],
    ['read-flash', '--port', 'COM13', '--length', '0'],
    ['write-flash', '--port', 'COM13', '--confirm-write'],
    ['flash-id', '--port', 'COM13', '--port', 'COM14'],
    ['flash-id', '--port', '--manual-boot'],
    ['erase-flash'],
  ])('rejects incomplete or inappropriate options %j', (...args) =>
    expect(() => parseOptions(args)).toThrow(),
  );
});
