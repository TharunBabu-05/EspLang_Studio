import { ESPLoader, Transport, type LoaderOptions, type IEspLoaderTerminal } from 'esptool-js';
import CryptoJS from 'crypto-js';
import { boards, type Firmware } from '@esplang/compiler';
export const serialSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'serial' in navigator && window.isSecureContext;
export async function requestEspPort(): Promise<SerialPort> {
  if (!serialSupported()) throw new Error('USB requires Chrome or Edge on localhost or HTTPS');
  return navigator.serial.requestPort({
    filters: [0x10c4, 0x1a86, 0x0403, 0x303a].map((usbVendorId) => ({ usbVendorId })),
  });
}
export async function flashFirmware(
  port: SerialPort,
  firmware: Firmware,
  log: (text: string) => void,
  progress: (value: number) => void,
): Promise<string> {
  const transport = new Transport(port, false);
  const terminal: IEspLoaderTerminal = {
    clean: () => {},
    write: log,
    writeLine: (text) => log(`${text}\n`),
  };
  const options: LoaderOptions = { transport, baudrate: 921600, terminal, debugLogging: false };
  const loader = new ESPLoader(options);
  try {
    const detected = await loader.main();
    const chip = loader.chip?.CHIP_NAME ?? detected;
    if (chip.replace(/[^a-z0-9]/gi, '').toLowerCase() !== firmware.board)
      throw new Error(
        `Connected ${chip}; firmware targets ${boards[firmware.board].label}. Select the matching board and rebuild.`,
      );
    const capacity = await loader.detectFlashSize();
    const capacityInMb = Number(capacity?.match(/^(\d+)MB$/)?.[1] ?? 0);
    if (capacityInMb < 4) {
      throw new Error('This board profile requires at least 4 MB of detected flash memory');
    }
    const files: { data: Uint8Array; address: number }[] = [];
    for (const artifact of firmware.artifacts) {
      const bytes = Uint8Array.from(atob(artifact.data), (c) => c.charCodeAt(0));
      if (bytes.length !== artifact.size) throw new Error(`Incorrect size for ${artifact.name}`);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      if (hash !== artifact.sha256) throw new Error(`Integrity check failed for ${artifact.name}`);
      files.push({ data: bytes, address: artifact.address });
    }
    const completed = files.map(() => 0);
    const totalSize = files.reduce((sum, file) => sum + file.data.length, 0);
    await loader.writeFlash({
      fileArray: files,
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      calculateMD5Hash: (image) => CryptoJS.MD5(CryptoJS.lib.WordArray.create(image)).toString(),
      reportProgress: (index, written, total) => {
        completed[index] = Math.min(1, total ? written / total : 0) * files[index]!.data.length;
        progress((completed.reduce((a, b) => a + b, 0) / totalSize) * 100);
      },
    });
    await loader.after('hard_reset');
    progress(100);
    return chip;
  } finally {
    await transport.disconnect();
  }
}
