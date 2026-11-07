import { SerialPort } from 'serialport';
import { setTimeout as delay } from 'node:timers/promises';
import type { RomTransport } from './protocol.js';

/** SerialPort is used only for OS serial bytes and modem lines, not ESP commands. */
export class NativeSerialTransport implements RomTransport {
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private failure?: Error;
  private intentionalClose = false;
  private constructor(private readonly port: SerialPort) {
    port.on('data', (bytes: Buffer) => this.dataListeners.forEach((fn) => fn(bytes)));
    port.on('error', (error) => this.failed(error));
    port.on('close', () => {
      if (!this.intentionalClose) this.failed(new Error('Serial device disconnected'));
    });
  }
  private failed(error: Error): void {
    this.failure ??= error;
    this.errorListeners.forEach((fn) => fn(error));
  }
  static async open(path: string): Promise<NativeSerialTransport> {
    const port = new SerialPort({
      path,
      baudRate: 115200,
      autoOpen: false,
      lock: true,
      rtscts: false,
    });
    const transport = new NativeSerialTransport(port);
    // A driver may complete open after our deadline. Close that late handle too.
    port.on('open', () => {
      if (transport.intentionalClose) void transport.close();
    });
    try {
      await transport.operation((cb) => port.open(cb));
    } catch (error) {
      await transport.close();
      throw error;
    }
    return transport;
  }
  static async list() {
    return (await SerialPort.list()).map(({ path, manufacturer, vendorId, productId }) => ({
      path,
      manufacturer,
      vendorId,
      productId,
    }));
  }
  private async operation(
    start: (cb: (error: Error | null | undefined) => void) => void,
  ): Promise<void> {
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => finish(error);
      const timer = setTimeout(() => finish(new Error('Serial I/O timed out')), 5000);
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.errorListeners.delete(fail);
        if (error) {
          this.failed(error);
          reject(error);
        } else resolve();
      };
      this.errorListeners.add(fail);
      try {
        start(finish);
      } catch (e) {
        finish(e as Error);
      }
    });
  }
  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.errorListeners.delete(listener);
  }
  async write(bytes: Uint8Array): Promise<void> {
    await this.operation((cb) => this.port.write(Buffer.from(bytes), cb));
    await this.operation((cb) => this.port.drain(cb));
  }
  private async lines(dtr: boolean, rts: boolean): Promise<void> {
    // Always specify both: serialport fills omitted flags with true.
    await this.operation((cb) => this.port.set({ dtr, rts }, cb));
  }
  async enterRom(signal?: AbortSignal): Promise<void> {
    // CP210x/CH340 dev-board auto-reset wiring: DTR drives GPIO0, RTS drives EN.
    await this.lines(false, true);
    await delay(100, undefined, { signal });
    // Switch directly: a separate both-asserted state can release EN too early
    // on boards with transistor auto-reset wiring. Manual BOOT remains available.
    await this.lines(true, false);
    await delay(100, undefined, { signal });
    await this.lines(false, false);
    await delay(100, undefined, { signal });
    await this.operation((cb) => this.port.flush(cb));
  }
  async reset(signal?: AbortSignal): Promise<void> {
    await this.lines(false, true);
    await delay(100, undefined, { signal });
    await this.lines(false, false);
  }
  async close(): Promise<void> {
    this.intentionalClose = true;
    if (this.port.isOpen) {
      // Closing must still work after an I/O failure.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500);
        this.port.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
