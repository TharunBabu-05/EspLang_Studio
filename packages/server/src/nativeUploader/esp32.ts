import { createHash } from 'node:crypto';
import { ROM, RomProtocol, words, xorChecksum } from './protocol.js';

export interface Esp32Identity {
  chip: 'esp32';
  deviceId: string;
  flashId: string;
  flashBytes: number;
  crystalMHz: number;
  secureBoot: boolean;
  flashCryptCount: number;
}
export interface FlashDevice {
  identify(): Promise<Esp32Identity>;
  readFlash(
    offset: number,
    length: number,
    progress?: (done: number, total: number) => void,
  ): Promise<Buffer>;
  writeFlash(
    offset: number,
    bytes: Uint8Array,
    progress?: (done: number, total: number) => void,
  ): Promise<void>;
}
export class Esp32Rom implements FlashDevice {
  private identity?: Esp32Identity;
  constructor(private readonly protocol: RomProtocol) {}
  private async readReg(address: number): Promise<number> {
    return (await this.protocol.command(ROM.readReg, words(address))).value;
  }
  private async writeReg(address: number, value: number): Promise<void> {
    await this.protocol.command(ROM.writeReg, words(address, value >>> 0, 0xffffffff, 0));
  }
  async identify(): Promise<Esp32Identity> {
    this.identity = undefined;
    if ((await this.readReg(0x40001000)) !== 0x00f01d83)
      throw new Error('Uploader supports only the original ESP32; connected chip does not match');
    const encryption = ((await this.readReg(0x3ff5a000)) >>> 20) & 0x7f;
    const secureBoot = Boolean((await this.readReg(0x3ff5a018)) & 0x30);
    if (encryption || secureBoot)
      throw new Error(
        'Protected or previously encrypted device: this uploader does not support secure boot or flash-encryption configurations',
      );
    const clockDivider = (await this.readReg(0x3ff40014)) & 0xfffff;
    const estimateMHz = (clockDivider * 115200) / 1e6;
    if (Math.abs(estimateMHz - 40) > 1)
      throw new Error(
        `Native target requires a 40 MHz crystal (estimated ${estimateMHz.toFixed(2)} MHz)`,
      );
    // Hash device identity for binding recovery manifests; never expose raw MAC.
    const deviceId = createHash('sha256')
      .update(words(await this.readReg(0x3ff5a004), (await this.readReg(0x3ff5a008)) & 0xffff))
      .digest('hex');
    await this.protocol.command(ROM.spiAttach, words(0, 0));
    // SPI1 user transaction: 8-bit JEDEC RDID (0x9f), 24 bits returned on MISO.
    // Restore the touched controller state before further ROM flash operations.
    const registers = [0x3ff4201c, 0x3ff42024, 0x3ff4202c, 0x3ff42080];
    const saved: number[] = [];
    for (const register of registers) saved.push(await this.readReg(register));
    let jedec = 0;
    try {
      await this.writeReg(registers[0]!, 0x90000000);
      await this.writeReg(registers[1]!, 0x7000009f);
      await this.writeReg(registers[2]!, 23);
      await this.writeReg(registers[3]!, 0);
      await this.writeReg(0x3ff42000, 1 << 18);
      let ready = false;
      for (let i = 0; i < 20; i++) {
        if (!((await this.readReg(0x3ff42000)) & (1 << 18))) {
          ready = true;
          break;
        }
      }
      if (!ready) throw new Error('SPI flash ID transaction timed out');
      jedec = (await this.readReg(0x3ff42080)) & 0xffffff;
    } finally {
      for (let i = 0; i < registers.length; i++) await this.writeReg(registers[i]!, saved[i]!);
    }
    const capacity = jedec >>> 16;
    if (!jedec || jedec === 0xffffff || capacity !== 22)
      throw new Error(
        `Native uploader requires 4 MiB JEDEC flash (received 0x${jedec.toString(16)})`,
      );
    await this.protocol.command(ROM.spiParams, words(0, 4194304, 65536, 4096, 256, 0xffff));
    this.identity = {
      chip: 'esp32',
      deviceId,
      flashId: jedec.toString(16).padStart(6, '0'),
      flashBytes: 4194304,
      crystalMHz: 40,
      secureBoot,
      flashCryptCount: encryption,
    };
    return { ...this.identity };
  }
  private checkRange(offset: number, length: number): void {
    if (!this.identity) throw new Error('Identify and validate the board before accessing flash');
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length <= 0 ||
      offset + length > this.identity.flashBytes
    )
      throw new Error('Flash range exceeds the validated device');
  }
  private async md5(offset: number, length: number): Promise<string> {
    const { data } = await this.protocol.command(
      ROM.md5,
      words(offset, length, 0, 0),
      32,
      0,
      30000,
    );
    const digest = data.toString('ascii');
    if (!/^[a-f0-9]{32}$/i.test(digest)) throw new Error('Malformed ROM flash digest');
    return digest.toLowerCase();
  }
  async readFlash(
    offset: number,
    length: number,
    progress?: (done: number, total: number) => void,
  ): Promise<Buffer> {
    this.checkRange(offset, length);
    const bytes = Buffer.alloc(length);
    for (let done = 0; done < length;) {
      const take = Math.min(64, length - done);
      const { data } = await this.protocol.command(ROM.readFlash, words(offset + done, take), 64);
      data.copy(bytes, done, 0, take);
      done += take;
      if (done % 4096 === 0 || done === length) progress?.(done, length);
    }
    const digest = createHash('md5').update(bytes).digest('hex');
    if ((await this.md5(offset, length)) !== digest)
      throw new Error('Flash backup digest mismatch; backup is not verified');
    return bytes;
  }
  async writeFlash(
    offset: number,
    input: Uint8Array,
    progress?: (done: number, total: number) => void,
  ): Promise<void> {
    const bytes = Buffer.from(input);
    const blocks = Math.ceil(bytes.length / 1024),
      eraseSize = Math.ceil(bytes.length / 4096) * 4096;
    this.checkRange(offset, eraseSize);
    if (offset % 4096) throw new Error('Flash writes must start on a sector boundary');
    await this.protocol.command(
      ROM.flashBegin,
      words(eraseSize, blocks, 1024, offset),
      0,
      0,
      30000,
    );
    for (let sequence = 0; sequence < blocks; sequence++) {
      const data = Buffer.alloc(1024, 0xff);
      bytes.copy(data, 0, sequence * 1024, (sequence + 1) * 1024);
      await this.protocol.command(
        ROM.flashData,
        Buffer.concat([words(1024, sequence, 0, 0), data]),
        0,
        xorChecksum(data),
        5000,
      );
      progress?.(Math.min((sequence + 1) * 1024, bytes.length), bytes.length);
    }
    // Stay in ROM until validation succeeds; the caller performs hardware reset.
    if ((await this.md5(offset, bytes.length)) !== createHash('md5').update(bytes).digest('hex'))
      throw new Error(
        'Written firmware hash does not match; leave the device in ROM and restore its verified backup',
      );
  }
}
