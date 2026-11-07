import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ ports: [] as any[], stallOpen: false, failDrain: false }));
vi.mock('serialport', () => ({
  SerialPort: class extends EventEmitter {
    isOpen = false;
    sets: unknown[] = [];
    writes: Buffer[] = [];
    flushed = false;
    openCallback?: (error?: Error) => void;
    constructor(readonly options: unknown) {
      super();
      state.ports.push(this);
    }
    open(cb: (error?: Error) => void) {
      this.openCallback = cb;
      if (!state.stallOpen) this.finishOpen();
    }
    finishOpen() {
      this.isOpen = true;
      this.emit('open');
      this.openCallback?.();
    }
    write(bytes: Buffer, cb: () => void) {
      this.writes.push(bytes);
      cb();
    }
    drain(cb: (error?: Error) => void) {
      cb(state.failDrain ? new Error('Driver drain failed') : undefined);
    }
    set(flags: unknown, cb: () => void) {
      this.sets.push(flags);
      cb();
    }
    flush(cb: () => void) {
      this.flushed = true;
      cb();
    }
    close(cb: () => void) {
      this.isOpen = false;
      this.emit('close');
      cb();
    }
  },
}));
import { NativeSerialTransport } from '../packages/server/src/nativeUploader/serial.js';

afterEach(() => {
  vi.useRealTimers();
  state.ports = [];
  state.stallOpen = false;
  state.failDrain = false;
});
describe('native uploader OS serial lifecycle', () => {
  it('sets explicit modem flags and flushes after the reset sequence', async () => {
    const transport = await NativeSerialTransport.open('TEST');
    const port = state.ports[0];
    expect(port.options).toMatchObject({
      path: 'TEST',
      baudRate: 115200,
      autoOpen: false,
      lock: true,
      rtscts: false,
    });
    await transport.enterRom();
    // Omitted flags default to true in serialport: do not make partial set calls.
    expect(port.sets).toEqual([
      { dtr: false, rts: true },
      { dtr: true, rts: false },
      { dtr: false, rts: false },
    ]);
    expect(port.flushed).toBe(true);
    const errors = vi.fn();
    transport.onError(errors);
    await transport.close();
    expect(errors).not.toHaveBeenCalled();
  });
  it('forwards bytes, unsubscribes listeners and stops writes after disconnect', async () => {
    const transport = await NativeSerialTransport.open('TEST');
    const port = state.ports[0],
      data = vi.fn();
    const detach = transport.onData(data);
    port.emit('data', Buffer.from([192, 219]));
    detach();
    port.emit('data', Buffer.from([0]));
    expect(data).toHaveBeenCalledExactlyOnceWith(Buffer.from([192, 219]));
    await transport.write(Uint8Array.of(192));
    expect(port.writes).toEqual([Buffer.from([192])]);
    port.emit('close');
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow(/disconnected/);
    expect(port.writes).toHaveLength(1);
    await transport.close();
  });
  it('latches callback errors and still closes the failed connection', async () => {
    const transport = await NativeSerialTransport.open('TEST');
    state.failDrain = true;
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow(/drain failed/);
    state.failDrain = false;
    await expect(transport.write(Uint8Array.of(2))).rejects.toThrow(/drain failed/);
    expect(state.ports[0].writes).toHaveLength(1);
    await transport.close();
    expect(state.ports[0].isOpen).toBe(false);
  });
  it('closes a handle even when the driver finishes opening after the timeout', async () => {
    vi.useFakeTimers();
    state.stallOpen = true;
    const opening = NativeSerialTransport.open('TEST');
    const checked = expect(opening).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5000);
    await checked;
    state.ports[0].finishOpen();
    expect(state.ports[0].isOpen).toBe(false);
  });
  it('cancels boot entry before further line changes', async () => {
    const transport = await NativeSerialTransport.open('TEST');
    const abort = new AbortController();
    const entering = transport.enterRom(abort.signal);
    abort.abort();
    await expect(entering).rejects.toThrow();
    expect(state.ports[0].sets).toHaveLength(1);
    expect(state.ports[0].flushed).toBe(false);
    await transport.close();
  });
});
