import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { RecordingService, type RecordingHooks } from '../src/main/recording';
import { wavHeader, BYTES_PER_SECOND } from '../src/main/audio-format';
const folders: string[] = [];
const stores: Store[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lecturedesk-record-test-'));
  folders.push(root);
  const store = new Store(root);
  stores.push(store);
  store.saveSettings({ liveTranscription: false });
  const lecture = store.lectureCreate({ title: 'Real persistence test' });
  const hooks: RecordingHooks = {
    append: () => {},
    commit: () => {},
    end: () => {},
    emit: () => {},
    wake: () => {},
  };
  return { root, store, lecture, hooks, service: new RecordingService(store, hooks) };
}
function ab(buffer: Buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
describe('durable audio capture', () => {
  it('writes exact PCM across independent segments without gaps or duplicates', () => {
    const { store, lecture, service } = fixture();
    service.start(lecture.id, 'both');
    const batch = Buffer.alloc(BYTES_PER_SECOND * 2);
    for (let i = 0; i < batch.length; i++) batch[i] = i % 251;
    for (let i = 0; i < 11; i++) service.chunk(lecture.id, i, ab(batch));
    service.stop(lecture.id);
    const detail = store.lectureGet(lecture.id);
    expect(detail.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 10],
      [10, 20],
      [20, 22],
    ]);
    const pcm = Buffer.concat(detail.segments.map((s) => readFileSync(s.path).subarray(44)));
    expect(pcm).toEqual(Buffer.concat(Array.from({ length: 11 }, () => batch)));
    expect(detail.lecture.duration).toBe(22);
    for (const s of detail.segments)
      expect(readFileSync(s.path).subarray(0, 44)).toEqual(wavHeader(statSync(s.path).size - 44));
  });
  it('flushes pause tails, resumes without reordering, acknowledges duplicate IPC', () => {
    const { store, lecture, service } = fixture();
    service.start(lecture.id, 'microphone');
    const batch = ab(Buffer.alloc(BYTES_PER_SECOND / 4, 13));
    service.chunk(lecture.id, 0, batch);
    expect(service.chunk(lecture.id, 0, batch).duplicate).toBe(true);
    service.pause(lecture.id);
    expect(() => service.chunk(lecture.id, 1, batch)).toThrow('paused');
    service.resume(lecture.id);
    service.chunk(lecture.id, 1, batch);
    service.stop(lecture.id);
    const d = store.lectureGet(lecture.id);
    expect(d.lecture.duration).toBe(0.5);
    expect(d.segments.map((s) => s.sequence)).toEqual([0, 1]);
    expect(d.gaps).toHaveLength(1);
  });
  it('recovers durable unfinished batches and persists work without network', () => {
    const { store, lecture, service } = fixture();
    service.start(lecture.id, 'system');
    service.chunk(lecture.id, 0, ab(Buffer.alloc(BYTES_PER_SECOND * 2, 9)));
    service.interrupt('Simulated process crash');
    expect(store.lectureGet(lecture.id).lecture.status).toBe('interrupted');
    service.recover(lecture.id);
    const detail = store.lectureGet(lecture.id);
    expect(detail.lecture.status).toBe('ready');
    expect(detail.lecture.duration).toBe(2);
    expect(detail.segments).toHaveLength(1);
    expect(detail.segments[0].status).toBe('queued');
    expect(store.tasks()[0].payload.segmentId).toBe(detail.segments[0].id);
    service.recover(lecture.id);
    expect(store.lectureGet(lecture.id).segments).toHaveLength(1);
    expect(store.tasks()).toHaveLength(1);
    expect(readdirSync(join(store.root, 'audio', lecture.id)).some((n) => n.endsWith('.part'))).toBe(false);
  });
  it('refuses overwriting existing audio and marks missing batches honestly', () => {
    const { store, lecture, service } = fixture();
    service.start(lecture.id, 'microphone');
    expect(() => service.chunk(lecture.id, 2, ab(Buffer.alloc(480)))).toThrow('out of order');
    expect(store.lectureGet(lecture.id).gaps[0].reason).toContain('Missing');
    service.chunk(lecture.id, 0, ab(Buffer.alloc(480)));
    service.stop(lecture.id);
    expect(() => service.start(lecture.id, 'microphone')).toThrow('preserve');
  });
  it('recovers an orphan WAV first and retains conflicting PCM without overwriting it', () => {
    const { store, lecture, service } = fixture();
    const original = Buffer.alloc(BYTES_PER_SECOND / 4, 17);
    service.start(lecture.id, 'microphone');
    service.chunk(lecture.id, 0, ab(original));
    service.stop(lecture.id);
    const segment = store.lectureGet(lecture.id).segments[0];
    const wavBefore = readFileSync(segment.path);
    // Simulate a crash after the atomic WAV rename, before the SQLite segment commit.
    store.db.prepare('DELETE FROM segments WHERE id=?').run(segment.id);
    const partial = segment.path.replace(/\.wav$/, '.pcm.part');
    const conflicting = Buffer.alloc(BYTES_PER_SECOND / 4, 29);
    writeFileSync(partial, conflicting);
    service.recover(lecture.id);
    const detail = store.lectureGet(lecture.id);
    expect(detail.segments).toHaveLength(1);
    expect(readFileSync(detail.segments[0].path)).toEqual(wavBefore);
    expect(readFileSync(partial + '.conflict')).toEqual(conflicting);
    expect(existsSync(partial)).toBe(false);
    expect(detail.gaps.some((gap) => gap.reason.includes('duplicate partial'))).toBe(true);
  });
  it('preserves corrupt recovered originals and refuses starting an interrupted lecture', () => {
    const { store, lecture, service } = fixture();
    service.start(lecture.id, 'microphone');
    service.chunk(lecture.id, 0, ab(Buffer.alloc(BYTES_PER_SECOND / 4, 17)));
    service.interrupt('Simulated crash');
    expect(() => service.start(lecture.id, 'microphone')).toThrow('recover');
    const directory = join(store.root, 'audio', lecture.id);
    const corrupt = join(directory, '000001-250.wav');
    const bytes = Buffer.alloc(100, 29);
    writeFileSync(corrupt, bytes);
    expect(() => service.recover(lecture.id)).toThrow('corrupt');
    expect(readFileSync(corrupt)).toEqual(bytes);
    expect(store.lectureGet(lecture.id).lecture.status).toBe('interrupted');
  });
  it('keeps recovery visible when the final database write fails', () => {
    const { store, lecture, service, hooks } = fixture();
    const wake = vi.spyOn(hooks, 'wake');
    service.start(lecture.id, 'microphone');
    service.chunk(lecture.id, 0, ab(Buffer.alloc(BYTES_PER_SECOND / 4, 17)));
    const save = store.lectureSave.bind(store);
    vi.spyOn(store, 'lectureSave').mockImplementation((input) => {
      if (input.status === 'ready') throw new Error('Database volume is full');
      return save(input);
    });
    expect(() => service.stop(lecture.id)).toThrow('Database volume is full');
    expect(service.active).toBe(null);
    expect(wake).toHaveBeenLastCalledWith(false);
    expect(store.lectureGet(lecture.id).lecture.status).toBe('interrupted');
    expect(store.snapshot().recoverable.map((item) => item.id)).toContain(lecture.id);
    expect(readFileSync(store.lectureGet(lecture.id).segments[0].path).length).toBeGreaterThan(44);
  });
  it('releases devices and wake lock even if all interruption database writes fail', () => {
    const { store, lecture, service, hooks } = fixture();
    const wake = vi.spyOn(hooks, 'wake');
    const emit = vi.spyOn(hooks, 'emit');
    service.start(lecture.id, 'microphone');
    service.chunk(lecture.id, 0, ab(Buffer.alloc(BYTES_PER_SECOND / 4, 17)));
    vi.spyOn(store, 'gap').mockImplementation(() => {
      throw new Error('Database volume is full');
    });
    vi.spyOn(store, 'lectureSave').mockImplementation(() => {
      throw new Error('Database volume is full');
    });
    vi.spyOn(hooks, 'end').mockImplementation(() => {
      throw new Error('Database volume is full');
    });
    expect(() => service.interrupt('Audio device disconnected')).not.toThrow();
    expect(service.active).toBe(null);
    expect(wake).toHaveBeenLastCalledWith(false);
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'recording-gap',
        message: expect.stringContaining('Database update failed'),
      }),
    );
    expect(
      readdirSync(join(store.root, 'audio', lecture.id)).some((file) => file.endsWith('.pcm.part')),
    ).toBe(true);
  });
  it('keeps memory bounded during an accelerated 10-minute persistence run', () => {
    const { store, lecture, service } = fixture();
    service.start(lecture.id, 'microphone');
    const batch = ab(Buffer.alloc(BYTES_PER_SECOND * 2));
    const start = process.memoryUsage().rss;
    for (let i = 0; i < 300; i++) service.chunk(lecture.id, i, batch);
    service.stop(lecture.id);
    expect(store.lectureGet(lecture.id).segments).toHaveLength(60);
    expect(process.memoryUsage().rss - start).toBeLessThan(128 * 1024 * 1024);
  }, 60000);
  it.skipIf(process.env.LECTUREDESK_LONG_TEST !== '1')(
    'accelerated four-hour disk simulation (not physical four-hour recording)',
    () => {
      const { store, lecture, service } = fixture();
      service.start(lecture.id, 'microphone');
      const batch = ab(Buffer.alloc(BYTES_PER_SECOND * 2));
      const start = process.memoryUsage().rss;
      for (let i = 0; i < 7200; i++) service.chunk(lecture.id, i, batch);
      service.stop(lecture.id);
      const detail = store.lectureGet(lecture.id);
      expect(detail.lecture.duration).toBe(14400);
      expect(detail.segments).toHaveLength(1440);
      expect(detail.segments.reduce((n, s) => n + statSync(s.path).size - 44, 0)).toBe(
        BYTES_PER_SECOND * 14400,
      );
      expect(process.memoryUsage().rss - start).toBeLessThan(192 * 1024 * 1024);
      console.log(
        JSON.stringify({
          test: 'four-hour accelerated disk simulation',
          segments: 1440,
          pcmBytes: BYTES_PER_SECOND * 14400,
          rssGrowthBytes: process.memoryUsage().rss - start,
        }),
      );
    },
    180000,
  );
});
