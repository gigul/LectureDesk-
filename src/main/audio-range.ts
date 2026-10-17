import { open } from 'node:fs/promises';
import type { Segment } from '../shared/types';
import { BYTES_PER_SECOND, wavHeader } from './audio-format';
import { FRAME_BYTES, frameLevels } from './audio-analysis';

/**
 * Lecture audio as one continuous PCM timeline: byte positions are lecture seconds × 48000 (24 kHz
 * mono PCM16), independent of how the audio is split into WAV files on disk.
 */
export const bytesAt = (seconds: number) => Math.round(seconds * (BYTES_PER_SECOND / 2)) * 2;
export const secondsAt = (bytes: number) => bytes / BYTES_PER_SECOND;
export function byteSpan(segment: Pick<Segment, 'start' | 'end'>) {
  return { startByte: bytesAt(segment.start), endByte: bytesAt(segment.end) };
}
/** End of the saved audio timeline (segments that still have a file). */
export function audioEnd(segments: Segment[]) {
  return Math.max(0, ...segments.filter((s) => s.path).map((s) => byteSpan(s).endByte));
}

/** Locates the PCM data chunk of a WAV file (44 bytes for recordings; variable for FFmpeg output). */
export async function wavDataOffset(file: string): Promise<{ offset: number; bytes: number }> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const header = Buffer.alloc(Math.min(size, 64 * 1024));
    await handle.read(header, 0, header.length, 0);
    if (header.length < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE')
      throw new Error('Not a WAV file');
    let cursor = 12;
    while (cursor + 8 <= header.length) {
      const length = header.readUInt32LE(cursor + 4);
      if (header.toString('ascii', cursor, cursor + 4) === 'data')
        return { offset: cursor + 8, bytes: Math.max(0, Math.min(length, size - cursor - 8)) };
      cursor += 8 + length + (length % 2);
    }
    throw new Error('WAV data chunk not found');
  } finally {
    await handle.close();
  }
}

/**
 * Reads [startByte, endByte) of the lecture timeline from the segment files. Bytes that no segment
 * covers are zero (silence); an unreadable segment file is an error, never silently skipped.
 */
export async function readRange(
  segments: Segment[],
  startByte: number,
  endByte: number,
  cache = new Map<string, { offset: number; bytes: number }>(),
): Promise<Buffer> {
  const result = Buffer.alloc(Math.max(0, endByte - startByte));
  for (const segment of segments) {
    if (!segment.path) continue;
    const span = byteSpan(segment);
    const from = Math.max(startByte, span.startByte),
      to = Math.min(endByte, span.endByte);
    if (to <= from) continue;
    let info = cache.get(segment.path);
    try {
      if (!info) {
        info = await wavDataOffset(segment.path);
        cache.set(segment.path, info);
      }
      const position = from - span.startByte;
      const length = Math.min(to - from, info.bytes - position);
      if (length <= 0) continue;
      const handle = await open(segment.path, 'r');
      try {
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(
            result,
            from - startByte + read,
            length - read,
            info.offset + position + read,
          );
          if (!bytesRead) break;
          read += bytesRead;
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw new Error(
        `Saved audio could not be read (${error instanceof Error ? error.message : 'unknown error'}).`,
      );
    }
  }
  return result;
}

/** Frame levels of [startByte, endByte), streamed in ~1 MB blocks so long lectures stay bounded. */
export async function scanLevels(segments: Segment[], startByte: number, endByte: number): Promise<Float32Array> {
  const total = Math.max(0, endByte - startByte);
  const levels = new Float32Array(Math.ceil(total / FRAME_BYTES));
  const block = FRAME_BYTES * 1092;
  const cache = new Map<string, { offset: number; bytes: number }>();
  for (let offset = 0; offset < total; offset += block) {
    const pcm = await readRange(segments, startByte + offset, startByte + Math.min(total, offset + block), cache);
    levels.set(frameLevels(pcm), offset / FRAME_BYTES);
  }
  return levels;
}

export const pcmWav = (pcm: Buffer) => Buffer.concat([wavHeader(pcm.length - (pcm.length % 2)), pcm.subarray(0, pcm.length - (pcm.length % 2))]);
