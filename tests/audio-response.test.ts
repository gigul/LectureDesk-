import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { audioResponse } from '../src/main/audio-response';
import { wavHeader } from '../src/main/audio-format';
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lecturedesk-audio-http-'));
  directories.push(directory);
  const bytes = Buffer.concat([wavHeader(4800), Buffer.alloc(4800, 17)]);
  const filename = join(directory, 'segment.wav');
  await writeFile(filename, bytes);
  return { filename, bytes };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
describe('seekable audio transport', () => {
  it('sends complete WAV metadata with a finite content length', async () => {
    const { filename, bytes } = await fixture();
    const response = await audioResponse(filename, null);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
  it.each([
    ['bytes=44-143', 44, 143],
    ['bytes=4800-', 4800, 4843],
    ['bytes=-100', 4744, 4843],
    ['bytes=4800-99999', 4800, 4843],
  ])('honors seek request %s', async (range, start, end) => {
    const { filename, bytes } = await fixture();
    const response = await audioResponse(filename, range as string);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${bytes.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(Number(start), Number(end) + 1));
  });
  it('rejects malformed and out-of-bounds ranges without returning unrelated data', async () => {
    const { filename } = await fixture();
    for (const range of [
      'bytes=9999-',
      'bytes=44-12',
      'bytes=-0',
      'bytes=-',
      'bytes=1-2,4-5',
      'bytes=9007199254740993-',
    ]) {
      const response = await audioResponse(filename, range);
      expect(response.status).toBe(416);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
  });
  it('answers HEAD without opening a body stream', async () => {
    const { filename, bytes } = await fixture();
    const response = await audioResponse(filename, null, true);
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(response.body).toBe(null);
  });
});
