import { describe, expect, it, vi } from 'vitest';
import { SerialMonitor } from '../packages/web/src/serialMonitor.js';
function fakePort() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const writes: string[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      writes.push(new TextDecoder().decode(bytes));
    },
  });
  const open = vi.fn(async () => {}),
    setSignals = vi.fn(async () => {});
  const close = vi.fn(async () => {
    expect(readable.locked).toBe(false);
    expect(writable.locked).toBe(false);
  });
  const port = { readable, writable, open, setSignals, close } as unknown as SerialPort;
  return { port, controller, writes, open, setSignals, close };
}
describe('serial monitor stream ownership', () => {
  it('decodes split UTF-8, sends ordered writes, and releases all locks on close', async () => {
    const hardware = fakePort(),
      monitor = new SerialMonitor(),
      received: string[] = [];
    await monitor.open(
      hardware.port,
      115200,
      (text) => received.push(text),
      (error) => {
        throw error;
      },
    );
    const bytes = new TextEncoder().encode('€\n');
    hardware.controller.enqueue(bytes.slice(0, 1));
    hardware.controller.enqueue(bytes.slice(1));
    await expect.poll(() => received.join('')).toBe('€\n');
    await Promise.all([monitor.write('one\n'), monitor.write('two\n')]);
    expect(hardware.writes).toEqual(['one\n', 'two\n']);
    await monitor.close();
    expect(monitor.connected).toBe(false);
    expect(hardware.close).toHaveBeenCalledOnce();
    await expect(monitor.write('closed')).rejects.toThrow(/disconnected/);
  });
  it('serializes concurrent open and close requests', async () => {
    const a = fakePort(),
      b = fakePort(),
      monitor = new SerialMonitor();
    await Promise.all([
      monitor.open(a.port, 115200, vi.fn(), vi.fn()),
      monitor.open(b.port, 921600, vi.fn(), vi.fn()),
      monitor.close(),
    ]);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(monitor.connected).toBe(false);
  });
  it('keeps an errored port available for orderly close before reconnecting', async () => {
    const hardware = fakePort(),
      monitor = new SerialMonitor(),
      error = vi.fn();
    await monitor.open(hardware.port, 115200, vi.fn(), error);
    hardware.controller.error(new Error('Device removed'));
    await expect.poll(() => error.mock.calls.length).toBe(1);
    expect(monitor.connected).toBe(false);
    await monitor.close();
    expect(hardware.close).toHaveBeenCalledOnce();
  });
  it('handles end of stream and signal setup failure without leaking a port', async () => {
    const hardware = fakePort(),
      monitor = new SerialMonitor(),
      error = vi.fn();
    await monitor.open(hardware.port, 115200, vi.fn(), error);
    hardware.controller.close();
    await expect.poll(() => error.mock.calls.length).toBe(1);
    await monitor.close();
    const other = fakePort();
    other.setSignals.mockRejectedValueOnce(new Error('Signals unavailable'));
    await expect(monitor.open(other.port, 115200, vi.fn(), vi.fn())).rejects.toThrow(
      'Signals unavailable',
    );
    expect(other.close).toHaveBeenCalledOnce();
  });
});
