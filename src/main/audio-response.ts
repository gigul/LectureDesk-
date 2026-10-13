import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

/** Serve immutable WAVs with explicit lengths and byte ranges for Chromium metadata and seeking. */
export async function audioResponse(filename: string, range: string | null, head = false): Promise<Response> {
  const size = (await stat(filename)).size;
  const headers = new Headers({ 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' });
  let start = 0,
    end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const unsatisfiable = () =>
      new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
      });
    if (!match || (!match[1] && !match[2]) || !size) return unsatisfiable();
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      const count = Number(match[2]);
      if (!Number.isSafeInteger(count) || count <= 0) return unsatisfiable();
      start = Math.max(0, size - count);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start)
      return unsatisfiable();
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  headers.set('Content-Length', String(Math.max(0, end - start + 1)));
  const body =
    head || !size
      ? null
      : (Readable.toWeb(createReadStream(filename, { start, end })) as unknown as BodyInit);
  return new Response(body, { status: range ? 206 : 200, headers });
}
