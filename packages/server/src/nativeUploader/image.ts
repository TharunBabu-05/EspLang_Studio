import { createHash } from 'node:crypto';
import {
  NATIVE_LAYOUT,
  packageEsp32Image,
  type ImageSegment,
} from '../../../compiler/src/native/image.js';

export function validateNativeImage(input: Uint8Array): {
  image: Buffer;
  offset: number;
  eraseSize: number;
  sha256: string;
} {
  const image = Buffer.from(input);
  if (
    image.length < 48 ||
    image.length > 34816 ||
    image.length % 16 ||
    image[0] !== 0xe9 ||
    image[1] !== 2
  )
    throw new Error(
      'Expected an EspLang native v0.1 ESP32 ROM image, not raw code or an Arduino application',
    );
  const segments: ImageSegment[] = [];
  let cursor = 24;
  for (let i = 0; i < 2; i++) {
    if (cursor + 8 > image.length) throw new Error('Truncated native image segment');
    const address = image.readUInt32LE(cursor),
      length = image.readUInt32LE(cursor + 4);
    if (!length || cursor + 8 + length > image.length)
      throw new Error('Native image segment length is invalid');
    segments.push({ address, data: image.subarray(cursor + 8, cursor + 8 + length) });
    cursor += 8 + length;
  }
  if (
    segments[0]!.address !== NATIVE_LAYOUT.code ||
    segments[1]!.address !== NATIVE_LAYOUT.data ||
    segments[1]!.data.length !== NATIVE_LAYOUT.dataSize ||
    segments[1]!.data.some((b) => b !== 0)
  )
    throw new Error('Native image does not match the supported RAM layout');
  const entry = image.readUInt32LE(4);
  const entryOffset = entry - NATIVE_LAYOUT.code;
  // v0.1 places an aligned literal pool before the fixed RSIL/ISYNC prologue.
  if (
    entryOffset < 0 ||
    entryOffset % 4 ||
    entryOffset + 6 > segments[0]!.data.length ||
    !Buffer.from(segments[0]!.data.subarray(entryOffset, entryOffset + 6)).equals(
      Buffer.from('206f00002000', 'hex'),
    )
  )
    throw new Error('Native image entry does not point to its supported startup sequence');
  const canonical = packageEsp32Image(image.readUInt32LE(4), segments);
  if (!image.equals(Buffer.from(canonical)))
    throw new Error('Native image header, checksum, padding or target settings are invalid');
  return {
    image,
    offset: NATIVE_LAYOUT.flashOffset,
    eraseSize: Math.ceil(image.length / 4096) * 4096,
    sha256: createHash('sha256').update(image).digest('hex'),
  };
}
