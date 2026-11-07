/** Repository-owned little-endian Xtensa LX6 assembler and single-section linker.
 * No relaxation, external tools, ELF loader, or implicit instruction substitution.
 * Encoding reference: https://github.com/espressif/xtensa-isa-doc
 */
export class AssemblyError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(`Assembly line ${line}: ${message}`);
  }
}
export interface LinkedAssembly {
  bytes: Uint8Array;
  base: number;
  symbols: Record<string, number>;
  instructions: { address: number; line: number; text: string }[];
}
const arity: Record<string, number> = {
  movi: 2,
  l32r: 2,
  l32i: 3,
  s32i: 3,
  addi: 3,
  add: 3,
  sub: 3,
  and: 3,
  or: 3,
  xor: 3,
  mull: 3,
  beq: 3,
  bne: 3,
  blt: 3,
  bge: 3,
  bltu: 3,
  bgeu: 3,
  beqz: 2,
  bnez: 2,
  j: 1,
  rsr: 2,
  wsr: 2,
  rsil: 2,
  memw: 0,
  isync: 0,
  nop: 0,
};
const labelPattern = /^[A-Za-z_.$][\w.$]*$/;
export function assembleXtensa(source: string, base = 0x40080000): LinkedAssembly {
  if (!Number.isInteger(base) || base < 0 || base > 0xffff0000 || base % 4)
    throw new AssemblyError('Base must be an aligned 32-bit address with space for 64 KiB', 1);
  const symbols: Record<string, number> = Object.create(null) as Record<string, number>;
  const rows: { op: string; args: string[]; offset: number; line: number; text: string }[] = [];
  let size = 0;
  const integer = (s: string, line: number): number => {
    if (!/^-?(?:0x[\da-f]+|\d+)$/i.test(s)) throw new AssemblyError(`Invalid integer '${s}'`, line);
    const n = s.startsWith('-') ? -Number(s.slice(1)) : Number(s);
    if (!Number.isSafeInteger(n)) throw new AssemblyError('Integer is not exact', line);
    return n;
  };
  for (const [i, original] of source.split(/\r?\n/).entries()) {
    let text = original.split('#')[0]!.trim();
    if (!text) continue;
    const label = /^([A-Za-z_.$][\w.$]*):/.exec(text);
    if (label) {
      if (Object.hasOwn(symbols, label[1]!)) throw new AssemblyError('Duplicate label', i + 1);
      symbols[label[1]!] = base + size;
      text = text.slice(label[0].length).trim();
      if (!text) continue;
    }
    const match = /^(\S+)(?:\s+(.*))?$/.exec(text)!;
    const op = match[1]!;
    const args = match[2] ? match[2].split(',').map((s) => s.trim()) : [];
    if (op === '.balign') {
      if (args.length !== 1 || integer(args[0]!, i + 1) !== 4)
        throw new AssemblyError('Only .balign 4 is supported', i + 1);
      size = Math.ceil(size / 4) * 4;
    } else {
      if (op !== '.word' && !Object.hasOwn(arity, op))
        throw new AssemblyError(`Unsupported instruction '${op}'`, i + 1);
      if (args.length !== (op === '.word' ? 1 : arity[op]))
        throw new AssemblyError(`Wrong operand count for ${op}`, i + 1);
      if (op === '.word' && size % 4) throw new AssemblyError('.word must be aligned', i + 1);
      rows.push({ op, args, offset: size, line: i + 1, text });
      size += op === '.word' ? 4 : 3;
    }
    if (size > 65536) throw new AssemblyError('Assembly exceeds 64 KiB', i + 1);
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const instructionAddresses = new Set(
    rows.filter((r) => r.op !== '.word').map((r) => base + r.offset),
  );
  const wordAddresses = new Set(rows.filter((r) => r.op === '.word').map((r) => base + r.offset));
  for (const row of rows) {
    const { op, args, line, offset } = row;
    const range = (n: number, min: number, max: number): number => {
      if (n < min || n > max) throw new AssemblyError(`Operand ${n} outside ${min}..${max}`, line);
      return n;
    };
    const reg = (i: number): number => {
      if (!/^a(?:[0-9]|1[0-5])$/.test(args[i]!))
        throw new AssemblyError(`Invalid register '${args[i]}'`, line);
      return Number(args[i]!.slice(1));
    };
    const imm = (i: number, min: number, max: number): number =>
      range(integer(args[i]!, line), min, max);
    const symbol = (i: number): number => {
      if (!labelPattern.test(args[i]!) || !Object.hasOwn(symbols, args[i]!))
        throw new AssemblyError(`Undefined label '${args[i]}'`, line);
      return symbols[args[i]!]!;
    };
    const displacement = (i: number, bits: number): number => {
      const target = symbol(i);
      if (!instructionAddresses.has(target))
        throw new AssemblyError('Branch target is not an instruction', line);
      return (
        range(target - (base + offset + 4), -(2 ** (bits - 1)), 2 ** (bits - 1) - 1) &
        (2 ** bits - 1)
      );
    };
    let word: number;
    if (op === '.word') {
      const value = Object.hasOwn(symbols, args[0]!) ? symbol(0) : imm(0, -0x80000000, 0xffffffff);
      view.setUint32(offset, value >>> 0, true);
      continue;
    }
    switch (op) {
      case 'movi': {
        const n = imm(1, -2048, 2047) & 0xfff;
        word = 0xa002 | (reg(0) << 4) | ((n >>> 8) << 8) | ((n & 255) << 16);
        break;
      }
      case 'l32r': {
        const target = symbol(1);
        if (!wordAddresses.has(target))
          throw new AssemblyError('L32R target must be a .word', line);
        const distance = target - Math.floor((base + offset + 3) / 4) * 4;
        range(distance, -262144, -4);
        if (distance % 4) throw new AssemblyError('Unaligned L32R target', line);
        word = 1 | (reg(0) << 4) | (((distance / 4) & 65535) << 8);
        break;
      }
      case 'l32i':
      case 's32i': {
        const n = imm(2, 0, 1020);
        if (n % 4) throw new AssemblyError('Word access requires a multiple of four', line);
        word = (op === 'l32i' ? 0x2002 : 0x6002) | (reg(0) << 4) | (reg(1) << 8) | ((n / 4) << 16);
        break;
      }
      case 'addi':
        word = 0xc002 | (reg(0) << 4) | (reg(1) << 8) | ((imm(2, -128, 127) & 255) << 16);
        break;
      case 'add':
      case 'sub':
      case 'and':
      case 'or':
      case 'xor':
      case 'mull': {
        const opcode = {
          add: 0x800000,
          sub: 0xc00000,
          and: 0x100000,
          or: 0x200000,
          xor: 0x300000,
          mull: 0x820000,
        }[op];
        word = opcode | (reg(0) << 12) | (reg(1) << 8) | (reg(2) << 4);
        break;
      }
      case 'beq':
      case 'bne':
      case 'blt':
      case 'bge':
      case 'bltu':
      case 'bgeu': {
        const opcode = { beq: 1, bne: 9, blt: 2, bge: 10, bltu: 3, bgeu: 11 }[op];
        word = 7 | (opcode << 12) | (reg(0) << 8) | (reg(1) << 4) | (displacement(2, 8) << 16);
        break;
      }
      case 'beqz':
      case 'bnez':
        word = (op === 'beqz' ? 0x16 : 0x56) | (reg(0) << 8) | (displacement(1, 12) << 12);
        break;
      case 'j':
        word = 6 | (displacement(0, 18) << 6);
        break;
      case 'rsr':
      case 'wsr': {
        const sr = args[1] === 'ccount' ? 234 : args[1] === 'ps' ? 230 : imm(1, 0, 255);
        word = (op === 'rsr' ? 0x030000 : 0x130000) | (sr << 8) | (reg(0) << 4);
        break;
      }
      case 'rsil':
        word = 0x006000 | (reg(0) << 4) | (imm(1, 0, 15) << 8);
        break;
      case 'memw':
        word = 0x0020c0;
        break;
      case 'isync':
        word = 0x002000;
        break;
      case 'nop':
        word = 0x0020f0;
        break;
      default:
        throw new AssemblyError(`Unsupported instruction '${op}'`, line);
    }
    bytes[offset] = word & 255;
    bytes[offset + 1] = (word >>> 8) & 255;
    bytes[offset + 2] = (word >>> 16) & 255;
  }
  return {
    bytes,
    base,
    symbols,
    instructions: rows
      .filter((r) => r.op !== '.word')
      .map((r) => ({ address: base + r.offset, line: r.line, text: r.text })),
  };
}
