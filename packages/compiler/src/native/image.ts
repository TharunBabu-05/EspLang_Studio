/** ROM-loadable ESP32 image writer. No esptool, bootloader blob or partition table.
 * https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/firmware-image-format.html
 */
export const NATIVE_LAYOUT = Object.freeze({
  code: 0x40080000,
  codeLimit: 0x40088000,
  data: 0x3ffb0000,
  dataSize: 1024,
  stackBottom: 0x3ffb7000,
  stackTop: 0x3ffb8000,
  flashOffset: 0x1000,
});
export interface ImageSegment {
  address: number;
  data: Uint8Array;
}
export function packageEsp32Image(entry: number, segments: ImageSegment[]): Uint8Array {
  if (!Number.isInteger(entry) || !segments.length || segments.length > 16)
    throw new Error('Invalid image entry point or segment count');
  let entryFound = false;
  for (const [i, s] of segments.entries()) {
    const end = s.address + s.data.length;
    if (!Number.isInteger(s.address) || s.address % 4 || !s.data.length || s.data.length % 4)
      throw new Error('Image segments require aligned addresses and nonempty aligned data');
    const code = s.address >= NATIVE_LAYOUT.code && end <= NATIVE_LAYOUT.codeLimit;
    const data =
      s.address >= NATIVE_LAYOUT.data && end <= NATIVE_LAYOUT.data + NATIVE_LAYOUT.dataSize;
    if (!code && !data) throw new Error('Segment lies outside the native memory layout');
    if (code && entry >= s.address && entry < end) entryFound = true;
    for (const other of segments.slice(0, i))
      if (s.address < other.address + other.data.length && other.address < end)
        throw new Error('Image segments overlap');
  }
  if (!entryFound) throw new Error('Entry point is outside executable memory');
  const bodySize = 24 + segments.reduce((n, s) => n + 8 + s.data.length, 0);
  const image = new Uint8Array(Math.ceil((bodySize + 1) / 16) * 16);
  const view = new DataView(image.buffer);
  image.set([0xe9, segments.length, 2, 0x20]); // DIO, 4 MiB flash, 40 MHz.
  view.setUint32(4, entry, true);
  image[8] = 0xee; // No custom WP pin.
  // Chip ID 0 = original ESP32. No SHA-256 append and no secure-boot signature.
  view.setUint16(17, 0xffff, true); // Maximum chip revision, unspecified.
  let cursor = 24,
    checksum = 0xef;
  for (const s of segments) {
    view.setUint32(cursor, s.address, true);
    view.setUint32(cursor + 4, s.data.length, true);
    image.set(s.data, cursor + 8);
    for (const byte of s.data) checksum ^= byte;
    cursor += 8 + s.data.length;
  }
  image[image.length - 1] = checksum;
  return image;
}
