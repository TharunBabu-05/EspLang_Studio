/** EspLang's ROM protocol implementation; no esptool imports or uploaded stub.
 * Wire contract: Espressif esptool documentation, advanced-topics/serial-protocol.
 */
export interface RomTransport {
  write(bytes: Uint8Array): Promise<void>;
  onData(listener: (bytes: Uint8Array) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}
export const ROM = Object.freeze({
  flashBegin: 0x02,
  flashData: 0x03,
  sync: 0x08,
  writeReg: 0x09,
  readReg: 0x0a,
  spiParams: 0x0b,
  spiAttach: 0x0d,
  readFlash: 0x0e,
  md5: 0x13,
});
export function words(...values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((n, i) => {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff)
      throw new Error('Invalid unsigned protocol word');
    result.writeUInt32LE(n, i * 4);
  });
  return result;
}
export function xorChecksum(bytes: Uint8Array): number {
  return bytes.reduce((sum, b) => sum ^ b, 0xef);
}
export function slipEncode(bytes: Uint8Array): Buffer {
  const output = [0xc0];
  for (const byte of bytes) {
    if (byte === 0xc0) output.push(0xdb, 0xdc);
    else if (byte === 0xdb) output.push(0xdb, 0xdd);
    else output.push(byte);
  }
  output.push(0xc0);
  return Buffer.from(output);
}
export class SlipDecoder {
  private started = false;
  private escaped = false;
  private bytes: number[] = [];
  constructor(
    private readonly frame: (data: Buffer) => void,
    private readonly maxBytes = 2048,
  ) {}
  push(data: Uint8Array): void {
    for (const byte of data) {
      if (byte === 0xc0) {
        if (this.escaped) throw new Error('Truncated SLIP escape');
        const frame = this.bytes;
        this.bytes = [];
        this.started = true;
        if (frame.length) this.frame(Buffer.from(frame));
      } else if (this.started) {
        if (this.escaped) {
          this.escaped = false;
          if (byte !== 0xdc && byte !== 0xdd) throw new Error('Invalid SLIP escape');
          this.bytes.push(byte === 0xdc ? 0xc0 : 0xdb);
        } else if (byte === 0xdb) this.escaped = true;
        else this.bytes.push(byte);
        if (this.bytes.length > this.maxBytes) throw new Error('ROM response exceeds frame limit');
      }
    }
  }
}
export interface RomReply {
  value: number;
  data: Buffer;
}
type Pending = {
  opcode: number;
  expected: number;
  resolve: (reply: RomReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  syncRetry?: ReturnType<typeof setInterval>;
};
export class RomProtocol {
  private pending?: Pending;
  private failure?: Error;
  private readonly detach: (() => void)[];
  constructor(
    private readonly transport: RomTransport,
    private readonly signal?: AbortSignal,
  ) {
    const decoder = new SlipDecoder((data) => this.receive(data));
    this.detach = [
      transport.onData((data) => {
        try {
          decoder.push(data);
        } catch (e) {
          this.stop(e as Error);
        }
      }),
      transport.onError((error) => this.stop(error)),
    ];
    const abort = () =>
      this.stop(new Error('Upload operation cancelled; reconnect before another command'));
    signal?.addEventListener('abort', abort, { once: true });
    this.detach.push(() => signal?.removeEventListener('abort', abort));
    if (signal?.aborted) abort();
  }
  private receive(frame: Buffer): void {
    if (this.failure) return;
    const p = this.pending;
    // SYNC produces several replies. Ignore only those surplus replies.
    if (frame.length >= 2 && frame[0] === 1 && frame[1] === ROM.sync && p?.opcode !== ROM.sync)
      return;
    if (!p) return;
    if (frame.length < 12 || frame[0] !== 1 || frame.readUInt16LE(2) !== frame.length - 8) {
      this.stop(new Error('Malformed ROM response (device may have reset)'));
      return;
    }
    if (frame[1] !== p.opcode) {
      this.stop(new Error('Unexpected ROM response opcode'));
      return;
    }
    const body = frame.subarray(8);
    const statusOffset = body.length === 4 ? 0 : p.expected;
    if (body.length < statusOffset + 4) {
      this.stop(new Error('Truncated ROM status'));
      return;
    }
    if (body[statusOffset] !== 0) {
      this.stop(
        new Error(
          `ROM command 0x${p.opcode.toString(16)} failed: status ${body[statusOffset]}, error 0x${body[statusOffset + 1]!.toString(16)}`,
        ),
      );
      return;
    }
    if (body.length !== p.expected + 4) {
      this.stop(new Error('Unexpected ROM payload length'));
      return;
    }
    this.pending = undefined;
    clearTimeout(p.timer);
    clearInterval(p.syncRetry);
    p.resolve({ value: frame.readUInt32LE(4), data: Buffer.from(body.subarray(0, p.expected)) });
  }
  private stop(error: Error): void {
    this.failure ??= error;
    const p = this.pending;
    this.pending = undefined;
    if (p) {
      clearTimeout(p.timer);
      clearInterval(p.syncRetry);
      p.reject(error);
    }
  }
  command(
    opcode: number,
    payload: Uint8Array = Buffer.alloc(0),
    expected = 0,
    checksum = 0,
    timeoutMs = 3000,
  ): Promise<RomReply> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('Concurrent ROM commands are not allowed'));
    if (this.signal?.aborted) return Promise.reject(new Error('Upload operation cancelled'));
    if (payload.length > 1040 || expected < 0 || expected > 64)
      return Promise.reject(new Error('Invalid ROM command size'));
    const header = Buffer.alloc(8);
    header[1] = opcode;
    header.writeUInt16LE(payload.length, 2);
    header.writeUInt32LE(checksum, 4);
    const packet = slipEncode(Buffer.concat([header, Buffer.from(payload)]));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.stop(
            new Error(
              `ROM command 0x${opcode.toString(16)} timed out; check BOOT/EN and reconnect`,
            ),
          ),
        timeoutMs,
      );
      const pending: Pending = { opcode, expected, resolve, reject, timer };
      this.pending = pending;
      let sending = false;
      let attempts = 0;
      const transmit = () => {
        if (this.pending !== pending || sending || attempts >= 40) return;
        sending = true;
        attempts++;
        void this.transport
          .write(packet)
          .catch((error: Error) => this.stop(error))
          .finally(() => {
            sending = false;
          });
      };
      // The ROM may consume initial SYNC bytes while detecting UART baud rate.
      // Only this idempotent handshake is repeated; flash commands never retry.
      if (opcode === ROM.sync) pending.syncRetry = setInterval(transmit, 100);
      transmit();
    });
  }
  async sync(): Promise<void> {
    const payload = Buffer.concat([Buffer.from([7, 7, 0x12, 0x20]), Buffer.alloc(32, 0x55)]);
    await this.command(ROM.sync, payload, 0, 0, 5000);
  }
  dispose(): void {
    this.stop(new Error('ROM connection closed'));
    this.detach.forEach((detach) => detach());
  }
}
