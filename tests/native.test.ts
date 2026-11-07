import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleXtensa } from '../packages/compiler/src/native/assembler.js';
import { compileNative, type NativeBuild } from '../packages/compiler/src/native/compiler.js';
import { NATIVE_LAYOUT, packageEsp32Image } from '../packages/compiler/src/native/image.js';
import { runNativeImage } from './helpers/native-machine.js';

function build(source: string): NativeBuild {
  const result = compileNative(source);
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(result.build).toBeDefined();
  return result.build!;
}
const hex = (source: string) => Buffer.from(assembleXtensa(source).bytes).toString('hex');

describe('repository-owned Xtensa assembler', () => {
  it('matches the complete independently assembled ISA fixture', () => {
    const source = readFileSync(
      new URL('./fixtures/xtensa-native-vectors.s', import.meta.url),
      'utf8',
    );
    const expected = readFileSync(
      new URL('./fixtures/xtensa-native-vectors.hex', import.meta.url),
      'utf8',
    ).trim();
    expect(hex(source)).toBe(expected);
  });
  // Fixed instruction vectors, independently checked with Espressif GNU as.
  it.each([
    ['movi a2, 1', '22a001'],
    ['movi a6, 500', '62a1f4'],
    ['movi a15, -2048', 'f2a800'],
    ['movi a2, -1', '22afff'],
    ['addi a6, a6, -1', '62c6ff'],
    ['l32i a2, a3, 0', '222300'],
    ['s32i a2, a3, 0', '226300'],
    ['l32i a15, a0, 1020', 'f220ff'],
    ['add a2, a2, a3', '302280'],
    ['sub a8, a8, a7', '7088c0'],
    ['and a2, a2, a4', '402210'],
    ['or a3, a2, a2', '203220'],
    ['xor a2, a2, a3', '302230'],
    ['mull a2, a2, a3', '302282'],
    ['rsil a2, 15', '206f00'],
    ['rsr a7, ccount', '70ea03'],
    ['wsr a2, ps', '20e613'],
    ['memw', 'c02000'],
    ['isync', '002000'],
    ['again: j again', '06ffff'],
  ])('encodes %s', (source, expected) => expect(hex(source)).toBe(expected));

  it('resolves literals across all PC alignments and fixes backward branches', () => {
    const result = assembleXtensa(
      'value: .word 0x12345678\nstart: l32r a2, value\nl32r a3, value\nl32r a4, value\nl32r a5, value\nbeq a2, a3, start\nbne a2, a3, start\nblt a2, a3, start\nbge a2, a3, start\nbltu a2, a3, start\nbgeu a2, a3, start\nbeqz a2, start\nbnez a2, start\nj start',
    );
    expect(Buffer.from(result.bytes).toString('hex')).toBe(
      '7856341221ffff31feff41fdff51fcff3712f03792ed3722ea37a2e73732e437b2e116e2fd56b2fd06f6ff',
    );
    expect(result.symbols.start).toBe(0x40080004);
  });
  it.each([
    'movi a16, 0',
    'movi a2, 2048',
    'addi a2, a3, -129',
    'l32i a2, a3, 2',
    's32i a2, a3, 1024',
    'rsil a2, 16',
    'thing: nop\nthing: nop',
    'j absent',
    'x: .word 0\nj x',
    'l32r a2, later\n.balign 4\nlater: .word 0',
    'movi a2, NaN',
    'call8 absent',
    '.word 4294967296',
    'nop\n.word 0',
  ])('rejects invalid assembly: %s', (source) => expect(() => assembleXtensa(source)).toThrow());
  it('rejects short branches that cannot reach their destination', () => {
    expect(() => assembleXtensa(`beq a2, a3, end\n${'nop\n'.repeat(100)}end: nop`)).toThrow(
      /outside/,
    );
  });
});

describe('native compiler and runtime', () => {
  it('builds a deterministic ROM image and decodes GPIO writes and wrapped-cycle delays', () => {
    const source = readFileSync(new URL('../examples/native-blink.esp', import.meta.url), 'utf8');
    const output = build(source);
    expect(build(source).image).toEqual(output.image);
    expect(output.flashOffset).toBe(0x1000);
    expect(output.machineCode.length).toBe(464);
    const execution = runNativeImage(output);
    const toggles = execution.writes.filter((w) => [0x3ff44008, 0x3ff4400c].includes(w.address));
    expect(toggles.map(({ address, value }) => [address, value])).toEqual([
      [0x3ff44008, 4],
      [0x3ff4400c, 4],
    ]);
    expect(toggles[1]!.ticks - toggles[0]!.ticks).toBeGreaterThanOrEqual(500 * 40000);
    expect(execution.read(0x3ff49040)).toBe(0x2800);
    expect(execution.read(0x3ff44538)).toBe(0x500);
    expect(execution.read(0x3ff44024)).toBe(4);
    expect(execution.a[1]).toBe(NATIVE_LAYOUT.stackTop);
  });
  it('executes scoping, signed arithmetic, comparison, boolean logic, loops and return', () => {
    const output = build(`
      int total = 0;
      setup {
        int low = -2147483648;
        int high = 2147483647;
        int wrapped = high + 1;
        bool ok = wrapped == low && low < high && high > low && low <= low && high >= high && low != high;
        if (ok && !false) { total = 7 * 6 - 2; } else { total = -999; }
        for (int i = 0; i < 3; i = i + 1) { total = total + i; }
        int j = 2;
        while (j > 0) { total = total + 1; j = j - 1; }
        { int total = 900; total = total + 1; }
        bool yes = false || true;
        if (yes) { total = total + 1; }
        return;
        total = 999;
      }
      loop { total = total + 1; return; total = 1000; }
    `);
    const execution = runNativeImage(output, { iterations: 2 });
    expect(execution.read(output.variables.find((v) => v.name === 'total')!.address)).toBe(48);
  });
  it('uses long jump trampolines for large conditional bodies', () => {
    const output = build(
      `int x = 0; setup { if (false) { ${'x = x + 1;'.repeat(150)} } } loop { x = x + 1; }`,
    );
    expect(runNativeImage(output).read(output.variables[0]!.address)).toBe(1);
  });
  it.each([
    ['setup {} loop { serialPrint(1); }', 'serialPrint'],
    ['setup {} loop { int x = digitalRead(2); }', 'digitalRead'],
    ['setup {} loop { float x = 1.5; }', 'float'],
    ['setup {} loop { string x = "hi"; }', 'string'],
    ['setup {} loop { int x = 4 / 2; }', "'/'"],
    ['setup {} loop { int x = 4 % 2; }', "'%'"],
    ['setup {} loop { delay(60001); }', '60000'],
    ['setup { int t = 1; delay(t); } loop {}', 'constant duration'],
    ['setup { pinMode(4, OUTPUT); } loop {}', 'GPIO 2'],
    ['setup { pinMode(2, INPUT); } loop {}', 'OUTPUT'],
    ['setup { int x = 1; digitalWrite(2, x); } loop {}', 'constant HIGH'],
    ['setup {} loop { int x = unknown; }', 'Unknown variable'],
  ])('reports unsupported/invalid source with a location', (source, expected) => {
    const result = compileNative(source);
    expect(result.build).toBeUndefined();
    expect(
      result.diagnostics.some(
        (d) => d.severity === 'error' && d.message.includes(expected) && d.span.start.line > 0,
      ),
    ).toBe(true);
  });
  it('rejects other chips and excessive source/storage', () => {
    expect(compileNative('setup {} loop {}', 'esp32c3').build).toBeUndefined();
    expect(compileNative(' '.repeat(64001)).build).toBeUndefined();
    const result = compileNative(
      `setup { ${Array.from({ length: 257 }, (_, i) => `int x${i} = 0;`).join(' ')} } loop {}`,
    );
    expect(result.diagnostics.at(-1)?.message).toContain('256');
  });
});

describe('ESP32 ROM image writer', () => {
  it('writes exact headers, segments, zero padding and checksum', () => {
    const image = packageEsp32Image(0x40080000, [
      { address: 0x40080000, data: Uint8Array.of(1, 2, 3, 4) },
    ]);
    expect(Buffer.from(image).toString('hex')).toBe(
      [
        'e901022000000840', // Header: one segment, entry 0x40080000.
        'ee0000000000000000ffff0000000000', // Extended header: chip 0, no hash.
        '0000084004000000', // Segment: address 0x40080000, four bytes.
        '01020304',
        '0000000000000000000000',
        'eb', // Data, padding, XOR checksum.
      ].join(''),
    );
  });
  it('independently verifies all native image segment bytes and the checksum', () => {
    const output = build('setup {} loop {}');
    const view = new DataView(output.image.buffer);
    expect(output.image.length % 16).toBe(0);
    expect(view.getUint32(4, true)).toBe(output.entryPoint);
    expect(view.getUint16(12, true)).toBe(0);
    let cursor = 24,
      checksum = 0xef;
    for (let i = 0; i < output.image[1]!; i++) {
      const n = view.getUint32(cursor + 4, true);
      for (const byte of output.image.slice(cursor + 8, cursor + 8 + n)) checksum ^= byte;
      cursor += n + 8;
    }
    expect(output.image.at(-1)).toBe(checksum);
    expect(output.image.slice(cursor, -1).every((b) => b === 0)).toBe(true);
  });
  it('rejects overlapping, unaligned, oversized and non-executable layouts', () => {
    const data = new Uint8Array(4);
    expect(() => packageEsp32Image(0, [{ address: 0x40080000, data }])).toThrow(/Entry/);
    expect(() => packageEsp32Image(0x40080000, [{ address: 0x40080001, data }])).toThrow(/aligned/);
    expect(() =>
      packageEsp32Image(0x40080000, [{ address: 0x40080000, data: new Uint8Array(3) }]),
    ).toThrow(/aligned/);
    expect(() =>
      packageEsp32Image(0x40080000, [{ address: 0x40080000, data: new Uint8Array(32772) }]),
    ).toThrow(/outside/);
    expect(() =>
      packageEsp32Image(0x40080000, [
        { address: 0x40080000, data },
        { address: 0x40080000, data },
      ]),
    ).toThrow(/overlap/);
  });
});
