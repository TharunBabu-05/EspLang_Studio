import { SerialPort } from 'serialport';
/** Main-process adapter for Electron. Expose only explicit methods over a context-isolated preload bridge. */
export class NodeSerialAdapter {
  private port?: SerialPort;
  static list(): ReturnType<typeof SerialPort.list> {
    return SerialPort.list();
  }
  async open(
    path: string,
    baudRate: 115200 | 921600,
    onData: (data: string) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    await this.close();
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    this.port = port;
    const decoder = new TextDecoder();
    port.on('data', (chunk: Buffer) => onData(decoder.decode(chunk, { stream: true })));
    port.on('error', onError);
    await new Promise<void>((resolve, reject) =>
      port.open((error) => (error ? reject(error) : resolve())),
    );
  }
  async write(text: string): Promise<void> {
    const port = this.port;
    if (!port?.isOpen) throw new Error('Serial port is closed');
    await new Promise<void>((resolve, reject) =>
      port.write(text, (error) =>
        error ? reject(error) : port.drain((error) => (error ? reject(error) : resolve())),
      ),
    );
  }
  async close(): Promise<void> {
    const port = this.port;
    this.port = undefined;
    if (port?.isOpen)
      await new Promise<void>((resolve, reject) =>
        port.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
