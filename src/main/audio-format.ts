export const SAMPLE_RATE = 24000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;
export const SEGMENT_SECONDS = 10;
export function wavHeader(bytes: number): Buffer {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes % 2 || bytes > 0xffffffff - 36)
    throw new Error('Invalid PCM size');
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(bytes + 36, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(BYTES_PER_SECOND, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(bytes, 40);
  return b;
}
