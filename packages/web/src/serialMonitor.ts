export class SerialMonitor {
  private port?: SerialPort;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private reading?: Promise<void>;
  private active = false;
  private operations: Promise<void> = Promise.resolve();

  get connected(): boolean {
    return this.active;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operations.catch(() => {}).then(operation);
    this.operations = next;
    return next;
  }

  open(
    port: SerialPort,
    baudRate: number,
    onData: (data: string) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.closePort();
      await port.open({ baudRate });
      this.port = port;
      try {
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      } catch (error) {
        this.port = undefined;
        await port.close().catch(() => {});
        throw error;
      }
      this.active = true;
      this.reading = this.read(port, onData, onError);
    });
  }

  private async read(
    port: SerialPort,
    onData: (data: string) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    const decoder = new TextDecoder();
    try {
      while (this.port === port && this.active && port.readable) {
        const reader = port.readable.getReader();
        this.reader = reader;
        try {
          while (this.active && this.port === port) {
            const { value, done } = await reader.read();
            if (done) {
              if (this.active && this.port === port) {
                this.active = false;
                onError(new Error('Serial receive stream closed'));
              }
              return;
            }
            if (value) onData(decoder.decode(value, { stream: true }));
          }
        } finally {
          reader.releaseLock();
          this.reader = undefined;
        }
      }
    } catch (error) {
      if (this.active && this.port === port) {
        this.active = false;
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      const tail = decoder.decode();
      if (tail) onData(tail);
    }
  }

  write(text: string): Promise<void> {
    return this.enqueue(async () => {
      const port = this.port;
      if (!this.active || !port?.writable) throw new Error('Serial monitor is disconnected');
      const writer = port.writable.getWriter();
      try {
        await writer.write(new TextEncoder().encode(text));
      } finally {
        writer.releaseLock();
      }
    });
  }

  close(): Promise<void> {
    return this.enqueue(() => this.closePort());
  }

  private async closePort(): Promise<void> {
    const port = this.port;
    this.active = false;
    if (this.reader) await this.reader.cancel().catch(() => {});
    await this.reading;
    this.reading = undefined;
    this.port = undefined;
    if (port) await port.close();
  }
}
