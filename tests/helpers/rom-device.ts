import { createHash } from 'node:crypto';
import type { RomTransport } from '../../packages/server/src/nativeUploader/protocol.js';

/** Independent wire-level fake ROM. No reuse of production encoding/decoding.
 * Models protocol/state, not actual SPI or ESP32 silicon. */
export class FakeRomTransport implements RomTransport {
  private listeners = new Set<(data: Uint8Array) => void>();
  private errors = new Set<(error: Error) => void>();
  readonly flash = Buffer.alloc(4194304, 0xa5);
  readonly calls: { opcode: number; payload: Buffer; checksum: number }[] = [];
  readonly registers = new Map<number, number>([
    [0x40001000, 0x00f01d83],
    [0x3ff5a000, 0],
    [0x3ff5a018, 0],
    [0x3ff40014, 347],
    [0x3ff5a004, 0x12345678],
    [0x3ff5a008, 0xabcd],
  ]);
  flashId = 0x1660c4;
  corruptDigest = false;
  dropOpcode?: number;
  failOpcode?: number;
  badLengthOpcode?: number;
  fragment = false;
  busySpi = false;
  private writeOffset = 0;
  private nextSequence = 0;
  private blocks = 0;
  onData(fn: (bytes: Uint8Array) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onError(fn: (error: Error) => void) {
    this.errors.add(fn);
    return () => this.errors.delete(fn);
  }
  disconnect() {
    this.errors.forEach((fn) => fn(new Error('Test disconnect')));
  }
  emitRaw(bytes: Uint8Array) {
    this.listeners.forEach((fn) => fn(bytes));
  }
  response(opcode: number, value = 0, payload = Buffer.alloc(0), status = 0) {
    const packet = Buffer.alloc(payload.length + 12);
    packet[0] = 1;
    packet[1] = opcode;
    packet.writeUInt16LE(payload.length + 4, 2);
    packet.writeUInt32LE(value >>> 0, 4);
    payload.copy(packet, 8);
    packet[8 + payload.length] = status;
    packet[9 + payload.length] = status ? 7 : 0;
    if (this.badLengthOpcode === opcode) packet.writeUInt16LE(500, 2);
    const encoded = [192];
    for (const byte of packet) {
      if (byte === 192) encoded.push(219, 220);
      else if (byte === 219) encoded.push(219, 221);
      else encoded.push(byte);
    }
    encoded.push(192);
    if (this.fragment) encoded.forEach((b) => this.emitRaw(Uint8Array.of(b)));
    else this.emitRaw(Uint8Array.from(encoded));
  }
  async write(bytes: Uint8Array): Promise<void> {
    if (bytes[0] !== 192 || bytes.at(-1) !== 192) throw new Error('Missing SLIP delimiters');
    const unpacked: number[] = [];
    for (let i = 1; i < bytes.length - 1; i++) {
      if (bytes[i] === 219) {
        const escaped = bytes[++i];
        if (escaped !== 220 && escaped !== 221) throw new Error('Bad request escaping');
        unpacked.push(escaped === 220 ? 192 : 219);
      } else unpacked.push(bytes[i]!);
    }
    const request = Buffer.from(unpacked);
    if (request.length < 8 || request[0] !== 0 || request.readUInt16LE(2) !== request.length - 8)
      throw new Error('Bad request header');
    const opcode = request[1]!,
      payload = request.subarray(8),
      checksum = request.readUInt32LE(4);
    this.calls.push({ opcode, payload, checksum });
    if (opcode === this.dropOpcode) return;
    if (opcode === this.failOpcode) {
      this.response(opcode, 0, Buffer.alloc(0), 1);
      return;
    }
    const word = (i: number) => payload.readUInt32LE(i * 4);
    switch (opcode) {
      case 8:
        if (payload.toString('hex') !== '07071220' + '55'.repeat(32))
          throw new Error('Bad sync request');
        for (let i = 0; i < 8; i++) this.response(8, 0x20120707);
        return;
      case 10:
        this.response(opcode, this.registers.get(word(0)) ?? 0);
        return;
      case 9:
        if (word(2) !== 0xffffffff || word(3) !== 0) throw new Error('Bad register write');
        this.registers.set(word(0), word(1));
        if (word(0) === 0x3ff42000 && word(1) === 0x40000) {
          if (
            this.registers.get(0x3ff42024) !== 0x7000009f ||
            this.registers.get(0x3ff4202c) !== 23 ||
            this.registers.get(0x3ff4201c) !== 0x90000000
          )
            throw new Error('Incorrect JEDEC transaction configuration');
          this.registers.set(0x3ff42080, this.flashId);
          if (!this.busySpi) this.registers.set(word(0), 0);
        }
        break;
      case 13:
        if (payload.length !== 8 || word(0) || word(1)) throw new Error('Bad SPI attach');
        break;
      case 11:
        if (
          payload.length !== 24 ||
          word(1) !== 4194304 ||
          word(2) !== 65536 ||
          word(3) !== 4096 ||
          word(4) !== 256
        )
          throw new Error('Bad SPI parameters');
        break;
      case 14: {
        if (word(1) > 64 || word(0) + word(1) > this.flash.length)
          throw new Error('Bad ROM read range');
        const data = Buffer.alloc(64);
        this.flash.copy(data, 0, word(0), word(0) + word(1));
        this.response(opcode, 0, data);
        return;
      }
      case 19: {
        const digest = this.corruptDigest
          ? '0'.repeat(32)
          : createHash('md5')
              .update(this.flash.subarray(word(0), word(0) + word(1)))
              .digest('hex');
        this.response(opcode, 0, Buffer.from(digest));
        return;
      }
      case 2:
        if (payload.length !== 16 || word(2) !== 1024 || word(0) % 4096 || word(3) % 4096)
          throw new Error('Bad erase/write parameters');
        this.writeOffset = word(3);
        this.blocks = word(1);
        this.nextSequence = 0;
        this.flash.fill(255, this.writeOffset, this.writeOffset + word(0));
        break;
      case 3: {
        const data = payload.subarray(16);
        if (
          data.length !== 1024 ||
          word(0) !== 1024 ||
          word(1) !== this.nextSequence ||
          word(1) >= this.blocks
        )
          throw new Error('Bad block sequence');
        let computed = 239;
        for (const byte of data) computed ^= byte;
        if (computed !== checksum) throw new Error('Bad data checksum');
        data.copy(this.flash, this.writeOffset + word(1) * 1024);
        this.nextSequence++;
        break;
      }
      default:
        throw new Error(`Unexpected or stub-only opcode: ${opcode}`);
    }
    this.response(opcode);
  }
}
