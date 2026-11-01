import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { FlashOptions } from 'esptool-js';
import type { Firmware } from '../packages/compiler/src/index.js';
const fake = vi.hoisted(() => ({
  chip: 'ESP32',
  capacity: '4MB' as string | undefined,
  main: vi.fn(async () => 'ESP32'),
  write: vi.fn(async (_options: FlashOptions) => {}),
  after: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
}));
vi.mock('esptool-js', () => ({
  Transport: class {
    disconnect = fake.disconnect;
  },
  ESPLoader: class {
    chip = { CHIP_NAME: fake.chip };
    main = fake.main;
    writeFlash = fake.write;
    after = fake.after;
    detectFlashSize = async () => fake.capacity;
  },
}));
import { flashFirmware } from '../packages/web/src/espFlasher.js';
const firmware = (): Firmware => ({
  board: 'esp32',
  fqbn: 'esp32:esp32:esp32',
  cpp: '',
  diagnostics: [],
  artifacts: [
    {
      name: 'test.bin',
      address: 0x10000,
      data: Buffer.from('test').toString('base64'),
      size: 4,
      sha256: createHash('sha256').update('test').digest('hex'),
    },
  ],
});
describe('USB flash lifecycle (mock transport)', () => {
  beforeEach(() => {
    fake.chip = 'ESP32';
    fake.capacity = '4MB';
    vi.clearAllMocks();
    fake.main.mockResolvedValue('ESP32');
    fake.write.mockResolvedValue();
  });
  afterEach(() => vi.restoreAllMocks());
  it('uses sparse compressed writes, real MD5 calculation, and hard reset', async () => {
    const progress = vi.fn();
    await flashFirmware({} as SerialPort, firmware(), vi.fn(), progress);
    const options = fake.write.mock.calls[0]![0];
    expect(options.compress).toBe(true);
    expect(options.eraseAll).toBe(false);
    expect(options.fileArray[0]!.address).toBe(0x10000);
    expect(options.calculateMD5Hash!(new TextEncoder().encode('test'))).toBe(
      '098f6bcd4621d373cade4e832627b4f6',
    );
    expect(fake.after).toHaveBeenCalledWith('hard_reset');
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenLastCalledWith(100);
  });
  it('refuses a mismatched chip before any flash write', async () => {
    fake.chip = 'ESP32-C3';
    await expect(flashFirmware({} as SerialPort, firmware(), vi.fn(), vi.fn())).rejects.toThrow(
      /firmware targets/,
    );
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.disconnect).toHaveBeenCalledOnce();
  });
  it('refuses insufficient or undetectable flash capacity', async () => {
    for (const capacity of ['2MB', undefined]) {
      fake.capacity = capacity;
      await expect(flashFirmware({} as SerialPort, firmware(), vi.fn(), vi.fn())).rejects.toThrow(
        /at least 4 MB/,
      );
    }
    expect(fake.write).not.toHaveBeenCalled();
  });
  it('rejects corrupted artifacts before writing', async () => {
    const data = firmware();
    data.artifacts[0]!.sha256 = '0'.repeat(64);
    await expect(flashFirmware({} as SerialPort, data, vi.fn(), vi.fn())).rejects.toThrow(
      /Integrity/,
    );
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.disconnect).toHaveBeenCalledOnce();
  });
  it('always releases USB after a loader or flash failure', async () => {
    fake.main.mockRejectedValueOnce(new Error('No sync'));
    await expect(flashFirmware({} as SerialPort, firmware(), vi.fn(), vi.fn())).rejects.toThrow(
      'No sync',
    );
    expect(fake.disconnect).toHaveBeenCalledOnce();
    fake.write.mockRejectedValueOnce(new Error('MD5 mismatch'));
    await expect(flashFirmware({} as SerialPort, firmware(), vi.fn(), vi.fn())).rejects.toThrow(
      'MD5 mismatch',
    );
    expect(fake.after).not.toHaveBeenCalled();
    expect(fake.disconnect).toHaveBeenCalledTimes(2);
  });
});
