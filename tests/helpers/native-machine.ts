import type { NativeBuild } from '../../packages/compiler/src/native/compiler.js';

/** Test-only decoder of the emitted ISA subset. This is not an ESP32 emulator:
 * peripherals are a write log, ROM boot is not executed, and CCOUNT is synthetic.
 * Decode actual bytes (never generator instruction strings) to test semantics.
 */
export function runNativeImage(
  build: NativeBuild,
  options: { iterations?: number; steps?: number } = {},
) {
  const memory = new Map<number, number>();
  const image = new DataView(build.image.buffer, build.image.byteOffset, build.image.byteLength);
  if (image.getUint8(0) !== 0xe9) throw new Error('Bad image magic');
  let at = 24;
  for (let i = 0; i < image.getUint8(1); i++) {
    const address = image.getUint32(at, true),
      size = image.getUint32(at + 4, true);
    for (let j = 0; j < size; j++) memory.set(address + j, image.getUint8(at + 8 + j));
    at += size + 8;
  }
  const read = (address: number) =>
    ((memory.get(address) ?? 0) |
      ((memory.get(address + 1) ?? 0) << 8) |
      ((memory.get(address + 2) ?? 0) << 16) |
      ((memory.get(address + 3) ?? 0) << 24)) >>>
    0;
  const writes: { address: number; value: number; ticks: number }[] = [];
  let ticks = 0,
    loops = 0;
  const write = (address: number, value: number) => {
    for (let i = 0; i < 4; i++) memory.set(address + i, (value >>> (i * 8)) & 255);
    writes.push({ address, value: value >>> 0, ticks });
  };
  const signed = (n: number, bits: number) => (n << (32 - bits)) >> (32 - bits);
  const a = new Uint32Array(16);
  let pc = image.getUint32(4, true);
  for (let steps = 0; steps < (options.steps ?? 100000); steps++) {
    if (pc === build.symbols.loop_start && loops++ >= (options.iterations ?? 1))
      return { read, writes, ticks, a };
    if (!memory.has(pc) || !memory.has(pc + 2))
      throw new Error(`Execution left loaded code at ${pc.toString(16)}`);
    const w = memory.get(pc)! | (memory.get(pc + 1)! << 8) | (memory.get(pc + 2)! << 16);
    const t = (w >>> 4) & 15,
      s = (w >>> 8) & 15,
      r = (w >>> 12) & 15;
    const instructionPc = pc;
    pc += 3;
    if ((w & 15) === 1) {
      a[t] = read(Math.floor((instructionPc + 3) / 4) * 4 + ((w >>> 8) - 65536) * 4);
      continue;
    }
    if ((w & 15) === 2) {
      const immediate = w >>> 16;
      if (r === 10) a[t] = signed((s << 8) | immediate, 12);
      else if (r === 12) a[t] = a[s]! + signed(immediate, 8);
      else if (r === 2) a[t] = read(a[s]! + immediate * 4);
      else if (r === 6) write(a[s]! + immediate * 4, a[t]!);
      else throw new Error('Unknown RRI instruction');
      continue;
    }
    if ((w & 63) === 6) {
      pc = instructionPc + 4 + signed(w >>> 6, 18);
      continue;
    }
    if ((w & 255) === 0x16 || (w & 255) === 0x56) {
      const condition = (w & 255) === 0x16 ? a[s] === 0 : a[s] !== 0;
      if (condition) pc = instructionPc + 4 + signed(w >>> 12, 12);
      continue;
    }
    if ((w & 15) === 7) {
      const left = a[s]!,
        right = a[t]!;
      const condition = (
        {
          1: left === right,
          9: left !== right,
          2: (left | 0) < (right | 0),
          10: (left | 0) >= (right | 0),
          3: left < right,
          11: left >= right,
        } as Record<number, boolean>
      )[r];
      if (condition === undefined) throw new Error('Unknown branch');
      if (condition) pc = instructionPc + 4 + signed(w >>> 16, 8);
      continue;
    }
    if ([0x0020c0, 0x002000, 0x0020f0].includes(w)) continue;
    if ((w & 0xfff00f) === 0x006000) {
      a[t] = 0;
      continue;
    } // RSIL.
    if ((w & 0xffff0f) === 0x03ea00) {
      ticks += 10000;
      a[t] = 0xffff0000 + ticks;
      continue;
    }
    if ((w & 15) === 0) {
      const operation = w >>> 16;
      if (operation === 0x80) a[r] = a[s]! + a[t]!;
      else if (operation === 0xc0) a[r] = a[s]! - a[t]!;
      else if (operation === 0x10) a[r] = a[s]! & a[t]!;
      else if (operation === 0x20) a[r] = a[s]! | a[t]!;
      else if (operation === 0x30) a[r] = a[s]! ^ a[t]!;
      else if (operation === 0x82) a[r] = Math.imul(a[s]!, a[t]!);
      else throw new Error(`Unknown instruction ${w.toString(16)}`);
      continue;
    }
    throw new Error(`Unknown instruction ${w.toString(16)}`);
  }
  throw new Error('Native instruction budget exhausted');
}
