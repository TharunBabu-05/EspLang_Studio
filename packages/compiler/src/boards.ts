export type BoardId = 'esp32' | 'esp32s2' | 'esp32s3' | 'esp32c3' | 'esp32c6';
export interface Board {
  id: BoardId;
  label: string;
  fqbn: string;
  bootOffset: number;
  pins: number[];
  inputOnly: number[];
  reserved: number[];
  caution: number[];
}
const range = (a: number, b: number): number[] =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);
export const boards: Record<BoardId, Board> = {
  esp32: {
    id: 'esp32',
    label: 'ESP32 Dev Module',
    fqbn: 'esp32:esp32:esp32',
    bootOffset: 0x1000,
    pins: [...range(0, 19), ...range(21, 23), ...range(25, 27), ...range(32, 39)],
    inputOnly: range(34, 39),
    reserved: range(6, 11),
    caution: [0, 1, 2, 3, 5, 12, 15, 16, 17],
  },
  esp32s2: {
    id: 'esp32s2',
    label: 'ESP32-S2 Dev Module',
    fqbn: 'esp32:esp32:esp32s2',
    bootOffset: 0x1000,
    pins: [...range(0, 21), ...range(26, 46)],
    inputOnly: [46],
    reserved: range(26, 32),
    caution: [0, 19, 20, ...range(33, 37), 45, 46],
  },
  esp32s3: {
    id: 'esp32s3',
    label: 'ESP32-S3 Dev Module',
    fqbn: 'esp32:esp32:esp32s3',
    bootOffset: 0,
    pins: [...range(0, 21), ...range(26, 48)],
    inputOnly: [],
    reserved: range(26, 32),
    caution: [0, 3, 19, 20, ...range(33, 37), 43, 44, 45, 46],
  },
  esp32c3: {
    id: 'esp32c3',
    label: 'ESP32-C3 Dev Module',
    fqbn: 'esp32:esp32:esp32c3',
    bootOffset: 0,
    pins: range(0, 21),
    inputOnly: [],
    reserved: range(12, 17),
    caution: [2, 8, 9, 18, 19, 20, 21],
  },
  esp32c6: {
    id: 'esp32c6',
    label: 'ESP32-C6 Dev Module',
    fqbn: 'esp32:esp32:esp32c6',
    bootOffset: 0,
    pins: range(0, 30),
    inputOnly: [],
    reserved: range(24, 30),
    caution: [4, 5, 8, 9, 12, 13, 15, 16, 17],
  },
};
export const isBoardId = (id: string): id is BoardId => Object.hasOwn(boards, id);
