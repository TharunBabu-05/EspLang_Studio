import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProperties, validateImages, runCli } from '../packages/server/src/builder.js';
import type { Artifact } from '../packages/compiler/src/index.js';
const image = (address: number, size: number): Artifact => ({
  name: 'test.bin',
  address,
  size,
  data: '',
  sha256: '',
});
describe('native process runner', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('streams both output channels and rejects nonzero exits', async () => {
    vi.stubEnv('ARDUINO_CLI', process.execPath);
    const log = vi.fn();
    const output = await runCli(
      ['-e', 'process.stdout.write("out"); process.stderr.write("err");'],
      { log },
    );
    expect(output).toContain('out');
    expect(output).toContain('err');
    expect(log).toHaveBeenCalled();
    await expect(runCli(['-e', 'process.exit(2);'], { log })).rejects.toThrow('exited with code 2');
  });
  it('terminates on cancellation and timeout', async () => {
    vi.stubEnv('ARDUINO_CLI', process.execPath);
    const controller = new AbortController();
    const pending = runCli(['-e', 'setInterval(() => {}, 1000);'], {
      log: () => {},
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toThrow('Build cancelled');
    controller.abort();
    await assertion;
    await expect(
      runCli(['-e', 'setInterval(() => {}, 1000);'], { log: () => {}, timeout: 100 }),
    ).rejects.toThrow('timed out');
  });
  it('cancels compiler descendants before releasing the build', async () => {
    vi.stubEnv('ARDUINO_CLI', process.execPath);
    const controller = new AbortController();
    const script = `const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e', 'console.log("child ready"); setInterval(() => {}, 1000)'], {stdio:'inherit'}); setInterval(() => {}, 1000);`;
    await expect(
      runCli(['-e', script], {
        signal: controller.signal,
        log: (text) => {
          if (text.includes('child ready')) controller.abort();
        },
      }),
    ).rejects.toThrow('Build cancelled');
  });
});
describe('image packaging', () => {
  it('reads expanded Arduino CLI properties with Windows paths', () => {
    expect(
      parseProperties(
        'runtime.platform.path=C:\\Arduino\\esp32\r\nbuild.bootloader_addr=0x1000\r\nnoise',
      ),
    ).toEqual({ 'runtime.platform.path': 'C:\\Arduino\\esp32', 'build.bootloader_addr': '0x1000' });
  });
  it('accepts sparse flash segments', () => {
    expect(() =>
      validateImages([
        image(0x1000, 25000),
        image(0x8000, 3072),
        image(0xe000, 8192),
        image(0x10000, 900000),
      ]),
    ).not.toThrow();
  });
  it('rejects overlapping sectors and invalid image bounds', () => {
    expect(() => validateImages([image(0, 4097), image(0x1000, 1)])).toThrow(/overlap/);
    expect(() => validateImages([image(3, 100)])).toThrow(/bounds/);
    expect(() => validateImages([image(0, 0)])).toThrow(/bounds/);
    expect(() => validateImages([image(0x3ff000, 8192)])).toThrow(/bounds/);
  });
});
